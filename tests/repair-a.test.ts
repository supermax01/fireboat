import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { FhirGateway, type GatewayConfig, type GatewayEnvelope } from '../packages/core/src/index.js';
import { ResultStore } from '../packages/core/src/store.js';
import { GatewayFault } from '../packages/core/src/transport.js';

// Repair A (M3a): state, retention, auth-generation and concurrency regressions (V-1, V-2, V-5, V-15, V-25, V-27, V-35).
const a = 'synthetic-patient-a';
const observation = (id: string, pad = 0) => ({
  resourceType: 'Observation', id, meta: { versionId: '1' }, status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] },
  subject: { reference: `Patient/${a}` }, effectiveDateTime: '2026-01-02T10:00:00Z',
  valueQuantity: { value: 7.1, unit: '%', system: 'http://unitsofmeasure.org', code: '%' },
  ...(pad > 0 ? { note: [{ text: 'x'.repeat(pad) }] } : {}),
});
const storeOf = (gw: FhirGateway) => (gw as unknown as { store: ResultStore<unknown> }).store;
/** Waiters currently attached to the shared page flight for `cursor` (V-5 join evidence). */
const flightWaiters = (gw: FhirGateway, cursor: string) =>
  (gw as unknown as { pageLoads: Map<string, { waiters: number }> }).pageLoads.get(cursor)?.waiters ?? 0;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(cond: () => boolean, label: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) { if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`); await sleep(5); }
}
const resourcesOf = (env: GatewayEnvelope): { id?: string }[] => (env.data as { resources?: { id?: string }[] }).resources ?? [];
const idsOf = (env: GatewayEnvelope): string[] => resourcesOf(env).map(r => r.id!).filter(Boolean);

interface HeldPage { res: ServerResponse; url: URL }
interface HeldRead { res: ServerResponse; id: string }
async function fixture() {
  let baseUrl = '';
  const state = {
    total: 40, pad: (_i: number) => 0, readPad: (_id: string) => 0,
    holdFromOffset: Number.POSITIVE_INFINITY, heldPages: [] as HeldPage[], pageRequests: 0, pageSocketsClosed: 0,
    holdReads: false, heldReads: [] as HeldRead[], readOrder: [] as string[], readSocketsClosed: 0,
  };
  const sendBundle = (res: ServerResponse, url: URL) => {
    const offset = Number(url.searchParams.get('_offset') ?? 0);
    const count = Number(url.searchParams.get('_count') ?? 20);
    const records = Array.from({ length: Math.max(0, Math.min(count, state.total - offset)) }, (_, k) => observation(`obs-${offset + k}`, state.pad(offset + k)));
    const next = new URL(url.href); next.searchParams.set('_offset', String(offset + count));
    res.end(JSON.stringify({
      resourceType: 'Bundle', type: 'searchset', total: state.total,
      link: [{ relation: 'self', url: url.href }, ...(offset + count < state.total ? [{ relation: 'next', url: next.href }] : [])],
      entry: records.map(resource => ({ resource, search: { mode: 'match' } })),
    }));
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, baseUrl);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname.endsWith('/metadata')) {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: ['Patient', 'Observation'].map(type => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: ['patient', 'subject', 'code'].map(name => ({ name })) })) }] }));
      return;
    }
    if (url.pathname.endsWith('/Observation')) {
      const offset = Number(url.searchParams.get('_offset') ?? 0);
      if (offset > 0) state.pageRequests++;
      if (offset >= state.holdFromOffset) {
        res.on('close', () => { if (!res.writableEnded) state.pageSocketsClosed++; });
        state.heldPages.push({ res, url });
        return;
      }
      sendBundle(res, url);
      return;
    }
    const id = url.pathname.split('/').at(-1)!;
    state.readOrder.push(id);
    if (state.holdReads) {
      res.on('close', () => { if (!res.writableEnded) state.readSocketsClosed++; });
      state.heldReads.push({ res, id });
      return;
    }
    res.end(JSON.stringify(observation(id, state.readPad(id))));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address()!; const port = typeof address === 'object' ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/fhir/`;
  return {
    state, baseUrl,
    gateway: (limits?: GatewayConfig['limits']) => new FhirGateway({ mode: 'synthetic', source: { alias: 'fixture', baseUrl }, patientId: a, limits }),
    releaseHeldPages: () => { for (const held of state.heldPages.splice(0)) if (!held.res.writableEnded && !held.res.destroyed) sendBundle(held.res, held.url); },
    releaseHeldReads: () => { for (const held of state.heldReads.splice(0)) if (!held.res.writableEnded && !held.res.destroyed) held.res.end(JSON.stringify(observation(held.id))); },
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
async function drainSearch(gw: FhirGateway, first: GatewayEnvelope, maxCalls = 400): Promise<string[]> {
  const ids = [...idsOf(first)];
  let env = first;
  let calls = 1;
  while (env.pagination?.next_cursor) {
    assert.ok(calls < maxCalls, 'drain exceeded call guard');
    env = await gw.execute('fhir_page', { cursor: env.pagination.next_cursor, output: { format: 'fhir' } });
    calls++;
    assert.equal(env.error, undefined, `drain call ${calls} failed: ${JSON.stringify(env.error)} after ${ids.length} ids`);
    ids.push(...idsOf(env));
  }
  return ids;
}

// ---- ResultStore: overlay charging, eviction, unsatisfiable, idle timer (V-1, V-2, V-27, V-15) ----
test('V-1 store overlay: per-handle view state is neither hashed nor charged as a second page copy', () => {
  const store = new ResultStore<{ records: string; offset: number }>(10_000, 10, 60_000);
  const page = { records: 'x'.repeat(2000), offset: 0 };
  const cur = store.putBatch([{ prefix: 'cur', value: page, overlay: { offset: 37 } }])[0]!;
  const bytesAfterCur = store.usedBytes();
  const res = store.putBatch([{ prefix: 'res', value: page, overlay: { offset: 0 } }])[0]!;
  assert.equal(store.usedBytes(), bytesAfterCur, 'a second handle on the same page must not charge the page again');
  assert.equal(store.get(cur.handle).value.offset, 37);
  assert.equal(store.get(res.handle).value.offset, 0);
  assert.equal(store.get(cur.handle).value.records.length, 2000);
  store.close();
});

test('V-2 store putBatch evicts the oldest res_ (never a cur_) before refusing a cursor', () => {
  const store = new ResultStore<{ v: string }>(10_000, 3, 60_000);
  const r1 = store.put('res', { v: 'oldest' });
  const r2 = store.put('res', { v: 'newer' });
  const cur0 = store.put('cur', { v: 'live-cursor' });
  const cur1 = store.put('cur', { v: 'next-cursor' });
  assert.throws(() => store.get(r1.handle), (e: unknown) => e instanceof GatewayFault && e.code === 'RESULT_EXPIRED', 'oldest res_ is evicted');
  assert.equal(store.get(r2.handle).value.v, 'newer', 'newer res_ is kept (eviction order is oldest-first)');
  assert.equal(store.get(cur0.handle).value.v, 'live-cursor');
  assert.equal(store.get(cur1.handle).value.v, 'next-cursor');
  store.close();
});

test('V-2 store update evicts res_ handles to fit a loaded page instead of refusing', () => {
  const store = new ResultStore<{ v: string }>(1200, 10, 60_000);
  const res = store.put('res', { v: 'r'.repeat(700) });
  const cur = store.put('cur', { v: 'c'.repeat(100) });
  store.update(cur.handle, { v: 'p'.repeat(600) });
  assert.equal(store.get(cur.handle).value.v.length, 600);
  assert.throws(() => store.get(res.handle), (e: unknown) => e instanceof GatewayFault && e.code === 'RESULT_EXPIRED');
  store.close();
});

test('V-27 RETENTION_LIMIT is non-retryable without a fabricated expiry when the request can never fit', () => {
  const store = new ResultStore<{ v: string }>(256, 10, 60_000);
  assert.throws(
    () => store.put('cur', { v: 'x'.repeat(300) }),
    (e: unknown) => e instanceof GatewayFault && e.code === 'RETENTION_LIMIT' && e.retryable === false && !/expires at/.test(e.message),
  );
  const cur = store.put('cur', { v: 'ok' });
  assert.throws(
    () => store.update(cur.handle, { v: 'y'.repeat(300) }),
    (e: unknown) => e instanceof GatewayFault && e.code === 'RETENTION_LIMIT' && e.retryable === false && !/expires at/.test(e.message),
  );
  store.close();
});

test('V-15 idle purge runs on the real timer without any intervening store call', async () => {
  const store = new ResultStore<{ v: string }>(10_000, 10, 40);
  store.put('res', { v: 'gone-soon' });
  await sleep(180);
  assert.equal(store.size, 0, 'the idle timer must purge expired handles on its own');
  assert.equal(store.usedBytes(), 0);
  store.close();
});

test('V-15 evictOldestRes removes the oldest res_, not the newest', () => {
  const store = new ResultStore<{ v: string }>(10_000, 10, 60_000);
  const r1 = store.put('res', { v: 'first' });
  const r2 = store.put('res', { v: 'second' });
  assert.equal(store.evictOldestRes(), true);
  assert.throws(() => store.get(r1.handle), (e: unknown) => e instanceof GatewayFault && e.code === 'RESULT_EXPIRED');
  assert.equal(store.get(r2.handle).value.v, 'second');
  store.close();
});

// ---- Gateway drains with DEFAULT limits (V-1, V-2) ----
test('V-1 gateway: a >=600KB fhir page drains 100% at <=~2x retained bytes and the query repeats', async t => {
  const f = await fixture(); t.after(f.close);
  f.state.total = 100;
  f.state.pad = () => 6000;
  const pageBytes = Buffer.byteLength(JSON.stringify(Array.from({ length: 100 }, (_, i) => observation(`obs-${i}`, 6000))));
  assert.ok(pageBytes >= 600_000, `fixture page is ${pageBytes}B`);
  const gw = f.gateway();
  const first = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 100, output: { format: 'fhir' } });
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  const ids = await drainSearch(gw, first);
  assert.deepEqual(ids, Array.from({ length: 100 }, (_, i) => `obs-${i}`));
  const used = storeOf(gw).usedBytes();
  assert.ok(used <= 2 * pageBytes, `retained ${used}B exceeds ~2x the ${pageBytes}B page`);
  const again = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 100, output: { format: 'fhir' } });
  assert.equal(again.error, undefined, `repeated query failed: ${JSON.stringify(again.error)}`);
  assert.ok(idsOf(again).length > 0);
  gw.close();
});

test('V-2 gateway: 75 upstream pages of 20 drain completely with default limits', async t => {
  const f = await fixture(); t.after(f.close);
  f.state.total = 1500;
  const gw = f.gateway();
  const first = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 20 });
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  const ids = await drainSearch(gw, first);
  assert.deepEqual(ids, Array.from({ length: 1500 }, (_, i) => `obs-${i}`));
  gw.close();
});

test('V-2 gateway: after 128 reads a paged search still returns a cur_ (res_ evicted, cursor kept)', async t => {
  const f = await fixture(); t.after(f.close);
  f.state.total = 40;
  const gw = f.gateway();
  for (let i = 0; i < 128; i++) {
    const env = await gw.execute('fhir_read', { resource_type: 'Observation', id: `read-${i}` });
    assert.equal(env.error, undefined, `read ${i}: ${JSON.stringify(env.error)}`);
  }
  const search = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 20 });
  assert.equal(search.error, undefined, `search after 128 reads: ${JSON.stringify(search.error)}`);
  assert.ok(search.pagination?.next_cursor?.startsWith('cur_'), JSON.stringify(search.pagination));
  const page2 = await gw.execute('fhir_page', { cursor: search.pagination!.next_cursor! });
  assert.equal(page2.error, undefined, JSON.stringify(page2.error));
  assert.ok(idsOf(page2).length > 0);
  gw.close();
});

test('V-2 gateway: loading a page while retained bytes are full of res_ evicts res_ and succeeds', async t => {
  const f = await fixture(); t.after(f.close);
  f.state.total = 40;
  f.state.pad = i => (i >= 20 ? 30_000 : 0);
  f.state.readPad = id => (id.startsWith('big-') ? 100_000 : 0);
  const gw = f.gateway();
  const search = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 20 });
  assert.equal(search.error, undefined, JSON.stringify(search.error));
  const cursor = search.pagination!.next_cursor!;
  assert.ok(cursor.startsWith('cur_'));
  for (let i = 0; i < 140 && storeOf(gw).usedBytes() < 9_850_000; i++) {
    const env = await gw.execute('fhir_read', { resource_type: 'Observation', id: `big-${i}` });
    assert.equal(env.error, undefined, `big read ${i}: ${JSON.stringify(env.error)}`);
  }
  assert.ok(storeOf(gw).usedBytes() > 9_850_000, `store should be byte-full, used=${storeOf(gw).usedBytes()}`);
  const page = await gw.execute('fhir_page', { cursor });
  assert.equal(page.error, undefined, `page load under byte pressure: ${JSON.stringify(page.error)}`);
  gw.close();
});

// ---- Shared fhir_page flight (V-5) ----
async function heldCursor(t: { after: (fn: () => unknown) => void }) {
  const f = await fixture(); t.after(f.close);
  f.state.total = 40;
  const gw = f.gateway();
  const search = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 20 });
  assert.equal(search.error, undefined, JSON.stringify(search.error));
  const cursor = search.pagination!.next_cursor!;
  f.state.holdFromOffset = 20;
  return { f, gw, cursor };
}

test('V-5 page flight: aborting the creator does not cancel a joined waiter; one upstream request', async t => {
  const { f, gw, cursor } = await heldCursor(t);
  const ctrlA = new AbortController();
  const pageA = gw.execute('fhir_page', { cursor }, { signal: ctrlA.signal });
  await waitFor(() => f.state.pageRequests === 1, 'page 2 requested');
  const pageB = gw.execute('fhir_page', { cursor });
  await waitFor(() => flightWaiters(gw, cursor) === 2, 'joined waiter attached to the flight');
  ctrlA.abort();
  const a = await pageA;
  assert.equal(a.error?.code, 'REQUEST_CANCELLED', JSON.stringify(a.error));
  f.releaseHeldPages();
  const b = await pageB;
  assert.equal(b.error, undefined, `joined waiter must survive creator abort: ${JSON.stringify(b.error)}`);
  assert.ok(idsOf(b).includes('obs-20'), JSON.stringify(idsOf(b)));
  assert.equal(f.state.pageRequests, 1, 'exactly one upstream continuation');
  gw.close();
});

test('V-5 page flight: a short-deadline creator does not impose its deadline on a joined waiter', async t => {
  const { f, gw, cursor } = await heldCursor(t);
  // "Short" means the creator expires while the held load is still running; 2 s keeps that
  // ordering deterministic even when CPU saturation delays the waiter's join by >120 ms.
  const pageA = gw.execute('fhir_page', { cursor }, { deadlineMs: 2_000 });
  await waitFor(() => f.state.pageRequests === 1, 'page 2 requested');
  const pageB = gw.execute('fhir_page', { cursor });
  await waitFor(() => flightWaiters(gw, cursor) === 2, 'joined waiter attached to the flight');
  const a = await pageA;
  assert.equal(a.error?.code, 'UPSTREAM_TIMEOUT', JSON.stringify(a.error));
  f.releaseHeldPages();
  const b = await pageB;
  assert.equal(b.error, undefined, `joined waiter must survive creator deadline: ${JSON.stringify(b.error)}`);
  assert.ok(idsOf(b).includes('obs-20'));
  assert.equal(f.state.pageRequests, 1);
  gw.close();
});

test('V-5 page flight: a joined waiter abort settles promptly while the load continues for the creator', async t => {
  const { f, gw, cursor } = await heldCursor(t);
  const pageA = gw.execute('fhir_page', { cursor });
  await waitFor(() => f.state.pageRequests === 1, 'page 2 requested');
  const ctrlB = new AbortController();
  const pageB = gw.execute('fhir_page', { cursor }, { signal: ctrlB.signal });
  await waitFor(() => flightWaiters(gw, cursor) === 2, 'joined waiter attached to the flight');
  const started = Date.now();
  ctrlB.abort();
  const b = await pageB;
  assert.ok(Date.now() - started < 600, `joined abort settled after ${Date.now() - started}ms while upstream still held`);
  assert.equal(b.error?.code, 'REQUEST_CANCELLED', JSON.stringify(b.error));
  f.releaseHeldPages();
  const a = await pageA;
  assert.equal(a.error, undefined, JSON.stringify(a.error));
  assert.equal(f.state.pageRequests, 1);
  gw.close();
});

test('V-5 page flight: a sole waiter abort closes the upstream socket and retains no loaded page', async t => {
  const { f, gw, cursor } = await heldCursor(t);
  const sizeBefore = storeOf(gw).size;
  const ctrl = new AbortController();
  const page = gw.execute('fhir_page', { cursor }, { signal: ctrl.signal });
  await waitFor(() => f.state.pageRequests === 1, 'page 2 requested');
  ctrl.abort();
  const env = await page;
  assert.equal(env.error?.code, 'REQUEST_CANCELLED', JSON.stringify(env.error));
  await waitFor(() => f.state.pageSocketsClosed >= 1, 'upstream socket closed after sole-waiter abort');
  assert.equal(storeOf(gw).size, sizeBefore, 'no new handles retained');
  f.state.holdFromOffset = Number.POSITIVE_INFINITY;
  const retry = await gw.execute('fhir_page', { cursor });
  assert.equal(retry.error, undefined, JSON.stringify(retry.error));
  assert.equal(f.state.pageRequests, 2, 'the aborted flight retained nothing, so the retry fetches again');
  gw.close();
});

// ---- Post-render growth: worst-case packing and rollback (V-25) ----
test('V-25 retentionBytes=256 read sweep succeeds wherever the default gateway succeeds, within budget', async t => {
  const f = await fixture(); t.after(f.close);
  const open = f.gateway();
  const tight = f.gateway({ retentionBytes: 256 });
  let compared = 0;
  for (let maxBytes = 3450; maxBytes <= 4400; maxBytes += 7) {
    const input = { resource_type: 'Observation', id: 'obs-a', output: { format: 'fhir' as const, max_bytes: maxBytes } };
    const expected = await open.execute('fhir_read', input);
    const actual = await tight.execute('fhir_read', input);
    if (actual.error === undefined) assert.ok(actual.budget.bytes_returned <= maxBytes, `bytes ${actual.budget.bytes_returned} > ${maxBytes}`);
    // Compare only where the default delivered the resource inline; the oversized-manifest shape legitimately
    // depends on a retained handle, so a quota that can retain nothing cannot offer it.
    if (expected.error === undefined && resourcesOf(expected).length > 0) {
      compared++;
      assert.equal(actual.error, undefined, `max_bytes=${maxBytes}: default succeeded, constrained gave ${JSON.stringify(actual.error)}`);
      assert.ok(actual.warnings.some(w => w.code === 'RESULT_NOT_RETAINED'), `max_bytes=${maxBytes}: missing RESULT_NOT_RETAINED`);
      assert.ok(actual.budget.bytes_returned <= maxBytes, `max_bytes=${maxBytes}: bytes ${actual.budget.bytes_returned}`);
    }
  }
  assert.ok(compared > 20, `sweep compared only ${compared} successful budgets`);
  open.close(); tight.close();
});

test('V-25 maxHandles=1 search sweep leaves no orphaned handle after any error envelope', async t => {
  const f = await fixture(); t.after(f.close);
  f.state.total = 60;
  // Padded records move the OUTPUT_LIMIT boundary band above the V-26 schema minimum (4096).
  f.state.pad = () => 1500;
  let errors = 0;
  for (let maxBytes = 4096; maxBytes <= 20000; maxBytes += 173) {
    const gw = f.gateway({ maxHandles: 1 });
    const env = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 60, output: { max_bytes: maxBytes } });
    if (env.error) {
      errors++;
      assert.equal(storeOf(gw).size, 0, `max_bytes=${maxBytes}: error ${env.error.code} left ${storeOf(gw).size} orphan handle(s)`);
    } else {
      assert.ok(env.budget.bytes_returned <= maxBytes, `max_bytes=${maxBytes}: bytes ${env.budget.bytes_returned}`);
    }
    gw.close();
  }
  // Since V-26 raised the minimum to 4096 and worst-case packing (V-25) fits every budget at or above it, the
  // sweep itself may see no error envelope; exercise the orphan path deterministically with an unretainable page.
  const gw = f.gateway({ maxHandles: 1, retentionBytes: 256 });
  const env = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 60, output: { max_bytes: 8192 } });
  assert.ok(env.error, 'an unretainable page must fail explicitly');
  errors++;
  assert.equal(storeOf(gw).size, 0, `error ${env.error?.code} left ${storeOf(gw).size} orphan handle(s)`);
  gw.close();
  assert.ok(errors > 0, 'sweep should exercise error envelopes');
});

// ---- Admission queue and slot release (V-15 / J-22 mutants) ----
test('V-15 cancelled in-flight reads close upstream sockets, free their slots and audit nothing as allowed', async t => {
  const f = await fixture(); t.after(f.close);
  const gw = f.gateway({ timeoutMs: 5000 });
  await gw.execute('fhir_capabilities', { topic: 'context' }); // warm discovery so aborts land in the read itself
  const allowedBefore = gw.auditEvents.filter(e => e.outcome === 'allowed').length;
  f.state.holdReads = true;
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const started = Date.now();
  const pending = controllers.map((ctrl, i) => gw.execute('fhir_read', { resource_type: 'Observation', id: `held-${i}` }, { signal: ctrl.signal }));
  await waitFor(() => f.state.heldReads.length === 4, 'four upstream reads held');
  controllers.forEach(ctrl => ctrl.abort());
  const settled = await Promise.all(pending);
  assert.ok(Date.now() - started < 1500, `cancellations settled after ${Date.now() - started}ms`);
  assert.ok(settled.every(env => env.error?.code === 'REQUEST_CANCELLED'), JSON.stringify(settled.map(e => e.error)));
  await waitFor(() => f.state.readSocketsClosed === 4, 'all four upstream sockets closed');
  assert.equal(gw.auditEvents.filter(e => e.outcome === 'allowed').length, allowedBefore, 'no cancelled read audited as allowed');
  f.state.holdReads = false;
  const fifth = await gw.execute('fhir_read', { resource_type: 'Observation', id: 'after-cancel' }, { deadlineMs: 800 });
  assert.equal(fifth.error, undefined, `fifth read must reuse a freed slot: ${JSON.stringify(fifth.error)}`);
  gw.close();
});

test('V-15 admission is FIFO and an aborted queued waiter never reaches the upstream', async t => {
  const f = await fixture(); t.after(f.close);
  const gw = f.gateway({ timeoutMs: 5000 });
  await gw.execute('fhir_capabilities', { topic: 'context' });
  f.state.holdReads = true;
  f.state.readOrder.length = 0;
  const blockers = Array.from({ length: 4 }, (_, i) => gw.execute('fhir_read', { resource_type: 'Observation', id: `block-${i}` }));
  await waitFor(() => f.state.heldReads.length === 4, 'four blockers held');
  const queued1 = gw.execute('fhir_read', { resource_type: 'Observation', id: 'queued-1' });
  const ctrlQ = new AbortController();
  const queuedAborted = gw.execute('fhir_read', { resource_type: 'Observation', id: 'queued-aborted' }, { signal: ctrlQ.signal });
  const queued2 = gw.execute('fhir_read', { resource_type: 'Observation', id: 'queued-2' });
  await sleep(30);
  ctrlQ.abort();
  const aborted = await queuedAborted;
  assert.equal(aborted.error?.code, 'REQUEST_CANCELLED', JSON.stringify(aborted.error));
  // Free exactly one slot: the first queued waiter (not the last) must take it.
  const [first] = f.state.heldReads.splice(0, 1);
  first!.res.end(JSON.stringify(observation(first!.id)));
  await waitFor(() => f.state.readOrder.includes('queued-1') || f.state.readOrder.includes('queued-2'), 'a queued waiter admitted');
  assert.ok(f.state.readOrder.includes('queued-1'), `FIFO order violated: ${JSON.stringify(f.state.readOrder)}`);
  assert.ok(!f.state.readOrder.includes('queued-2'), `LIFO admission detected: ${JSON.stringify(f.state.readOrder)}`);
  f.state.holdReads = false;
  f.releaseHeldReads();
  const done = await Promise.all([queued1, queued2, ...blockers]);
  assert.ok(done.every(env => env.error === undefined), JSON.stringify(done.map(e => e.error)));
  assert.ok(!f.state.readOrder.includes('queued-aborted'), 'aborted queued waiter reached the upstream');
  gw.close();
});

test('V-15 a cancellation landing during retention is not delivered, audited allowed, or left stored', async t => {
  const f = await fixture(); t.after(f.close);
  const gw = f.gateway();
  await gw.execute('fhir_capabilities', { topic: 'context' }); // warm discovery so the trip lands in the read's retention
  const store = storeOf(gw);
  const allowedBefore = gw.auditEvents.filter(e => e.outcome === 'allowed').length;
  const sizeBefore = store.size;
  const ctrl = new AbortController();
  const original = store.putBatch.bind(store);
  let tripped = false;
  store.putBatch = ((entries: Parameters<typeof original>[0]) => {
    const out = original(entries);
    if (!tripped) { tripped = true; ctrl.abort(); } // cancellation arrives after the handle is stored, before delivery
    return out;
  }) as typeof store.putBatch;
  const env = await gw.execute('fhir_read', { resource_type: 'Observation', id: 'obs-cancel-retain' }, { signal: ctrl.signal });
  assert.equal(tripped, true, 'retention was reached');
  assert.equal(env.error?.code, 'REQUEST_CANCELLED', JSON.stringify(env.error));
  assert.deepEqual(env.data, {});
  assert.equal(env.result, undefined);
  assert.equal(gw.auditEvents.filter(e => e.outcome === 'allowed').length, allowedBefore, 'cancelled request audited nothing as allowed');
  assert.equal(store.size, sizeBefore, 'the reserved handle was rolled back, not orphaned');
  gw.close();
});

// ---- Render performance (V-35) ----
test('V-35 rendering a 100-record page at 128KB is not quadratic (timing)', async t => {
  const f = await fixture(); t.after(f.close);
  f.state.total = 100;
  f.state.pad = () => 300;
  const gw = f.gateway();
  const input = { resource_type: 'Observation', page_size: 100, output: { format: 'fhir' as const, max_bytes: 131072 } };
  await gw.execute('fhir_search', input); // warmup: metadata flight and JIT are not the measured cost
  // CPU time, not wall time: parallel suite copies inflate wall time without adding work here.
  const cpuStart = process.cpuUsage();
  const env = await gw.execute('fhir_search', input);
  const used = process.cpuUsage(cpuStart);
  const elapsed = (used.user + used.system) / 1000;
  assert.equal(env.error, undefined, JSON.stringify(env.error));
  assert.ok(resourcesOf(env).length >= 60, `only ${resourcesOf(env).length} records packed`);
  assert.ok(env.budget.bytes_returned <= 131072, `bytes ${env.budget.bytes_returned}`);
  assert.ok(elapsed < 200, `rendering took ${elapsed.toFixed(1)}ms of CPU (quadratic packing regression)`);
  gw.close();
});
