/**
 * Cursor eviction. When the clinical handle or byte quota is full, the gateway evicts
 * the oldest `res_` handle first and then the oldest cursor (by sequence number) instead of refusing the call. It
 * never evicts a handle the current request already reserved or a cursor with an in-flight page load, and an
 * evicted cursor gives exactly the refusal of an expired one. RETENTION_LIMIT remains for a request that can never
 * fit and for a quota held entirely by protected handles. All fixtures are synthetic.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { FhirGateway, type GatewayConfig, type GatewayEnvelope } from '../packages/core/src/index.js';
import { ResultStore } from '../packages/core/src/store.js';
import { GatewayFault } from '../packages/core/src/transport.js';
import { createMcpServer } from '../packages/server/src/index.js';

const A = 'synthetic-patient-a';
const observation = (id: string) => ({
  resourceType: 'Observation', id, meta: { versionId: '1' }, status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] },
  subject: { reference: `Patient/${A}` }, effectiveDateTime: '2026-01-02T10:00:00Z',
  valueQuantity: { value: 7.1, unit: '%', system: 'http://unitsofmeasure.org', code: '%' },
});
const ids = (env: GatewayEnvelope): string[] => ((env.data as { resources?: { id?: string }[] }).resources ?? []).map(r => r.id!).filter(Boolean);
const storeOf = (gw: FhirGateway) => (gw as unknown as { store: ResultStore<unknown> }).store;
const pageLoadsOf = (gw: FhirGateway) => (gw as unknown as { pageLoads: Map<string, unknown> }).pageLoads;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(cond: () => boolean, label: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) { if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`); await sleep(5); }
}
const expired = (e: unknown) => e instanceof GatewayFault && e.code === 'RESULT_EXPIRED' && e.message === 'Result is unavailable or expired; repeat the original query.';
/** The clinical store exactly as the gateway configures it. */
function clinicalStore<T>(byteLimit: number, maxHandles: number, protectedHandles?: (handle: string) => boolean, ttlMs = 60_000, now: () => number = Date.now) {
  return new ResultStore<T>(byteLimit, maxHandles, ttlMs, now, { evictableKinds: ['res', 'cur'], ...(protectedHandles ? { protectedHandles } : {}) });
}

interface Held { res: ServerResponse; url: URL }
async function fixture(total = 40) {
  let baseUrl = '';
  const state = { total, holdFromOffset: Number.POSITIVE_INFINITY, held: [] as Held[], searches: 0 };
  const send = (res: ServerResponse, url: URL) => {
    const offset = Number(url.searchParams.get('_offset') ?? 0);
    const count = Number(url.searchParams.get('_count') ?? 20);
    const records = Array.from({ length: Math.max(0, Math.min(count, state.total - offset)) }, (_, k) => observation(`obs-${offset + k}`));
    const next = new URL(url.href); next.searchParams.set('_offset', String(offset + count));
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', total: state.total,
      link: [{ relation: 'self', url: url.href }, ...(offset + count < state.total ? [{ relation: 'next', url: next.href }] : [])],
      entry: records.map(resource => ({ resource, search: { mode: 'match' } })) }));
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, baseUrl);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname.endsWith('/metadata')) {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: ['Patient', 'Observation'].map(type => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: ['patient', 'subject', 'code'].map(name => ({ name })) })) }] }));
      return;
    }
    if (url.pathname.endsWith('/Observation')) {
      state.searches++;
      if (Number(url.searchParams.get('_offset') ?? 0) >= state.holdFromOffset) { state.held.push({ res, url }); return; }
      send(res, url);
      return;
    }
    res.end(JSON.stringify(observation(url.pathname.split('/').at(-1)!)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address()!; const port = typeof address === 'object' ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/fhir/`;
  return {
    state, baseUrl,
    config: (limits?: GatewayConfig['limits']): GatewayConfig => ({ mode: 'synthetic', source: { alias: 'fixture', baseUrl }, patientId: A, ...(limits ? { limits } : {}) }),
    gateway: (limits?: GatewayConfig['limits']) => new FhirGateway({ mode: 'synthetic', source: { alias: 'fixture', baseUrl }, patientId: A, ...(limits ? { limits } : {}) }),
    release: () => { for (const held of state.held.splice(0)) if (!held.res.writableEnded && !held.res.destroyed) send(held.res, held.url); },
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

// ---- Store rules ----

test('cursor eviction: res_ handles are evicted before any cursor, then the oldest cursor by sequence number', () => {
  const store = clinicalStore<{ v: string }>(100_000, 3);
  const c1 = store.put('cur', { v: 'cursor-1' });
  const c2 = store.put('cur', { v: 'cursor-2' });
  const r1 = store.put('res', { v: 'result-newer-than-cursors' });
  const c3 = store.put('cur', { v: 'cursor-3' });
  assert.throws(() => store.get(r1.handle), expired, 'the res_ goes first although both cursors are older');
  assert.equal(store.get(c1.handle).value.v, 'cursor-1');
  const c4 = store.put('cur', { v: 'cursor-4' });
  assert.throws(() => store.get(c1.handle), expired, 'with no res_ left, the oldest cursor is evicted');
  for (const [handle, v] of [[c2.handle, 'cursor-2'], [c3.handle, 'cursor-3'], [c4.handle, 'cursor-4']] as const) assert.equal(store.get(handle).value.v, v);
  store.close();
});

test('cursor eviction: byte pressure also evicts res_ first, then the oldest cursor', () => {
  const store = clinicalStore<{ v: string }>(1000, 100);
  const c1 = store.put('cur', { v: 'a'.repeat(300) });
  const c2 = store.put('cur', { v: 'b'.repeat(300) });
  const r1 = store.put('res', { v: 'c'.repeat(300) });
  store.put('cur', { v: 'd'.repeat(300) });
  assert.throws(() => store.get(r1.handle), expired);
  assert.ok(store.get(c1.handle) && store.get(c2.handle));
  store.put('cur', { v: 'e'.repeat(300) });
  assert.throws(() => store.get(c1.handle), expired);
  assert.ok(store.get(c2.handle));
  store.close();
});

test('cursor eviction: a handle reserved by the current request (except) is never evicted', () => {
  const store = clinicalStore<{ v: string }>(100_000, 2);
  const old = store.put('cur', { v: 'old-cursor' });
  const head = store.put('cur', { v: 'issued-with-this-result' });
  const result = store.putBatch([{ prefix: 'res', value: { v: 'result' } }], [old.handle]);
  assert.throws(() => store.get(head.handle), expired, 'the unreserved cursor goes');
  assert.equal(store.get(old.handle).value.v, 'old-cursor', 'the reserved cursor stays although it is older');
  assert.ok(store.get(result[0]!.handle));
  // Nothing evictable but the reserved handles: the result is refused (retryable), and nothing is evicted.
  const single = clinicalStore<{ v: string }>(100_000, 1);
  const cursor = single.put('cur', { v: 'only' });
  assert.throws(() => single.putBatch([{ prefix: 'res', value: { v: 'r' } }], [cursor.handle]), (e: unknown) => e instanceof GatewayFault && e.code === 'RETENTION_LIMIT' && e.retryable === true);
  assert.equal(single.get(cursor.handle).value.v, 'only');
  store.close(); single.close();
});

test('cursor eviction: a protected (in-flight) cursor is never evicted; a full protected quota stays a retryable RETENTION_LIMIT', () => {
  const pinned = new Set<string>();
  const store = clinicalStore<{ v: string }>(100_000, 2, handle => pinned.has(handle));
  const inFlight = store.put('cur', { v: 'loading' });
  pinned.add(inFlight.handle);
  const other = store.put('cur', { v: 'idle' });
  const next = store.put('cur', { v: 'next' });
  assert.equal(store.get(inFlight.handle).value.v, 'loading', 'the older in-flight cursor is skipped');
  assert.throws(() => store.get(other.handle), expired, 'the oldest unprotected cursor goes instead');
  pinned.add(next.handle);
  assert.throws(() => store.put('cur', { v: 'refused' }),
    (e: unknown) => e instanceof GatewayFault && e.code === 'RETENTION_LIMIT' && e.retryable === true && /expires at \d{4}-\d{2}-\d{2}T/.test(e.message));
  assert.equal(store.size, 2);
  // update(): fitting a loaded page never evicts a protected cursor either.
  const bytes = clinicalStore<{ v: string }>(1000, 10, handle => pinned.has(handle));
  const loading = bytes.put('cur', { v: 'a'.repeat(400) }); pinned.add(loading.handle);
  const target = bytes.put('cur', { v: 'b' });
  assert.throws(() => bytes.update(target.handle, { v: 'c'.repeat(700) }), (e: unknown) => e instanceof GatewayFault && e.code === 'RETENTION_LIMIT' && e.retryable === true);
  assert.equal(bytes.get(loading.handle).value.v.length, 400);
  assert.equal(bytes.get(target.handle).value.v, 'b', 'a refused update leaves the handle as it was');
  store.close(); bytes.close();
});

test('cursor eviction: an evicted cursor and an expired cursor give the identical store fault', () => {
  let now = 1_000_000;
  const store = clinicalStore<{ v: string }>(100_000, 1, undefined, 1000, () => now);
  const evicted = store.put('cur', { v: 'first' });
  const survivor = store.put('cur', { v: 'second' });
  const faultOf = (handle: string) => { try { store.get(handle); } catch (e) { return e as GatewayFault; } assert.fail('expected a fault'); };
  const a = faultOf(evicted.handle);
  now += 5000;
  const b = faultOf(survivor.handle);
  assert.deepEqual([a.code, a.message, a.retryable, a.name], [b.code, b.message, b.retryable, b.name]);
  assert.ok(expired(a));
  store.close();
});

test('cursor eviction: a request that can never fit stays a non-retryable RETENTION_LIMIT and evicts nothing', () => {
  const store = clinicalStore<{ v: string }>(256, 2);
  const kept = store.put('cur', { v: 'kept' });
  const unretainable = (e: unknown) => e instanceof GatewayFault && e.code === 'RETENTION_LIMIT' && e.retryable === false && !/expires at/.test(e.message);
  assert.throws(() => store.put('cur', { v: 'x'.repeat(300) }), unretainable);
  assert.throws(() => store.putBatch([{ prefix: 'cur', value: { v: '1' } }, { prefix: 'cur', value: { v: '2' } }, { prefix: 'res', value: { v: '3' } }]), unretainable, 'more handles than maxHandles');
  assert.throws(() => store.update(kept.handle, { v: 'y'.repeat(300) }), unretainable);
  assert.equal(store.get(kept.handle).value.v, 'kept');
  assert.equal(store.size, 1);
  store.close();
});

// ---- Gateway rules ----

test('cursor eviction gateway: res_ handles are evicted before cursors', async t => {
  const f = await fixture(); t.after(f.close);
  const gw = f.gateway({ maxHandles: 4 });
  t.after(() => gw.close());
  const first = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 10 });
  const second = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 10, params: [{ name: 'code', value: 'http://loinc.org|4548-4' }] });
  assert.ok(first.result?.handle && first.pagination?.next_cursor && second.result?.handle && second.pagination?.next_cursor);
  assert.equal(storeOf(gw).size, 4);
  const third = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 5 });
  assert.equal(third.error, undefined);
  assert.ok(third.pagination?.next_cursor && third.result?.handle);
  assert.equal((await gw.execute('fhir_result', { handle: first.result.handle })).error?.code, 'RESULT_EXPIRED', 'the oldest res_ went');
  assert.equal((await gw.execute('fhir_result', { handle: second.result.handle })).error?.code, 'RESULT_EXPIRED', 'the next res_ went');
  const page = await gw.execute('fhir_page', { cursor: first.pagination.next_cursor });
  assert.equal(page.error, undefined, `the oldest cursor survives while res_ remain: ${JSON.stringify(page.error)}`);
  assert.deepEqual(ids(page), Array.from({ length: 10 }, (_, i) => `obs-${10 + i}`));
});

test('cursor eviction gateway: the current chain head is never evicted while draining', async t => {
  const f = await fixture(100); t.after(f.close);
  for (const maxHandles of [2, 3]) {
    const gw = f.gateway({ maxHandles });
    let env = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 10 });
    const seen = [...ids(env)];
    let calls = 1;
    while (env.pagination?.next_cursor) {
      // Interleaved reads add res_ handles that compete for the quota; they go first, never the head.
      assert.equal((await gw.execute('fhir_read', { resource_type: 'Observation', id: `r-${calls}` })).error, undefined);
      env = await gw.execute('fhir_page', { cursor: env.pagination.next_cursor });
      assert.equal(env.error, undefined, `maxHandles=${maxHandles} page ${calls}: ${JSON.stringify(env.error)}`);
      seen.push(...ids(env)); calls++;
      assert.ok(calls < 40, 'drain guard');
    }
    assert.deepEqual(seen, Array.from({ length: 100 }, (_, i) => `obs-${i}`), `maxHandles=${maxHandles}`);
    assert.ok(storeOf(gw).size <= maxHandles);
    gw.close();
  }
  // With a single handle the served cursor and its successor cannot both be held: the page is refused (retryable)
  // and the served cursor is kept, never traded for a successor that would leave nothing to replay.
  const single = f.gateway({ maxHandles: 1 });
  const first = await single.execute('fhir_search', { resource_type: 'Observation', page_size: 10 });
  const refused = await single.execute('fhir_page', { cursor: first.pagination!.next_cursor! });
  assert.equal(refused.error?.code, 'RETENTION_LIMIT');
  assert.equal(refused.error?.retryable, true);
  assert.ok(storeOf(single).get(first.pagination!.next_cursor!));
  single.close();
});

test('cursor eviction gateway: a served cursor survives minting its successor and replays at once', async t => {
  const f = await fixture(60); t.after(f.close);
  const gw = f.gateway({ maxHandles: 3 });
  t.after(() => gw.close());
  const first = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 20 });
  const second = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 20, params: [{ name: 'code', value: 'http://loinc.org|4548-4' }] });
  const oldest = first.pagination!.next_cursor!;
  assert.ok(second.pagination?.next_cursor);
  assert.equal(storeOf(gw).size, 3, 'the store is full and the input cursor is the oldest cursor');
  const page = await gw.execute('fhir_page', { cursor: oldest });
  assert.equal(page.error, undefined, JSON.stringify(page.error));
  assert.ok(page.pagination?.next_cursor, 'the page minted a successor while the store was full');
  const replay = await gw.execute('fhir_page', { cursor: oldest });
  assert.equal(replay.error, undefined, `immediate replay of the served cursor: ${JSON.stringify(replay.error)}`);
  assert.deepEqual(ids(replay), ids(page));
  assert.equal(replay.budget.upstream_calls, 0);
  assert.equal((await gw.execute('fhir_page', { cursor: second.pagination!.next_cursor! })).error?.code, 'RESULT_EXPIRED', 'another cursor went instead');
});

test('cursor eviction gateway: two concurrent pages on the oldest cursor both render, and it replays afterwards', async t => {
  const f = await fixture(60); t.after(f.close);
  const gw = f.gateway({ maxHandles: 3 });
  t.after(() => gw.close());
  const first = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 20 });
  await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 20, params: [{ name: 'code', value: 'http://loinc.org|4548-4' }] });
  const oldest = first.pagination!.next_cursor!;
  assert.equal(storeOf(gw).size, 3);
  f.state.holdFromOffset = 20;
  const pending = [gw.execute('fhir_page', { cursor: oldest }), gw.execute('fhir_page', { cursor: oldest })];
  await waitFor(() => (pageLoadsOf(gw).get(oldest) as { waiters?: number } | undefined)?.waiters === 2 && f.state.held.length === 1, 'both calls share one page load');
  f.state.holdFromOffset = Number.POSITIVE_INFINITY;
  f.release();
  const [a, b] = await Promise.all(pending);
  assert.equal(a!.error, undefined, `first concurrent page: ${JSON.stringify(a!.error)}`);
  assert.equal(b!.error, undefined, `second concurrent page: ${JSON.stringify(b!.error)}`);
  const expected = Array.from({ length: 20 }, (_, i) => `obs-${20 + i}`);
  assert.deepEqual(ids(a!), expected); assert.deepEqual(ids(b!), expected);
  const replay = await gw.execute('fhir_page', { cursor: oldest });
  assert.equal(replay.error, undefined, `replay after both rendered: ${JSON.stringify(replay.error)}`);
  assert.deepEqual(ids(replay), expected);
});

test('cursor eviction gateway: concurrent calls count the served cursor, so one leaving early does not unprotect it for the other', async t => {
  const f = await fixture(60); t.after(f.close);
  const gw = f.gateway({ maxHandles: 3, timeoutMs: 5000 });
  t.after(() => gw.close());
  const first = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 20 });
  await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 20, params: [{ name: 'code', value: 'http://loinc.org|4548-4' }] });
  const oldest = first.pagination!.next_cursor!;
  assert.equal(storeOf(gw).size, 3);
  f.state.holdFromOffset = 20;
  const leaving = new AbortController();
  const early = gw.execute('fhir_page', { cursor: oldest }, { signal: leaving.signal });
  const staying = gw.execute('fhir_page', { cursor: oldest });
  await waitFor(() => (pageLoadsOf(gw).get(oldest) as { waiters?: number } | undefined)?.waiters === 2 && f.state.held.length === 1, 'both calls share one page load');
  leaving.abort();
  assert.equal((await early).error?.code, 'REQUEST_CANCELLED');
  assert.ok(pageLoadsOf(gw).has(oldest), 'the remaining caller keeps the shared load alive');
  f.state.holdFromOffset = Number.POSITIVE_INFINITY;
  f.release();
  const page = await staying;
  assert.equal(page.error, undefined, JSON.stringify(page.error));
  assert.deepEqual(ids(page), Array.from({ length: 20 }, (_, i) => `obs-${20 + i}`));
  const replay = await gw.execute('fhir_page', { cursor: oldest });
  assert.equal(replay.error, undefined, `the remaining call kept the cursor protected through its render: ${JSON.stringify(replay.error)}`);
  assert.deepEqual(ids(replay), ids(page));
});

test('cursor eviction gateway: a cursor with an in-flight page load is not evicted', async t => {
  const f = await fixture(40); t.after(f.close);
  const gw = f.gateway({ maxHandles: 3 });
  t.after(() => gw.close());
  const first = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 20 });
  const cursor = first.pagination!.next_cursor!;
  f.state.holdFromOffset = 20;
  const pending = gw.execute('fhir_page', { cursor });
  await waitFor(() => f.state.held.length === 1 && pageLoadsOf(gw).has(cursor), 'page load in flight');
  // Each search adds a cursor and a res_; with three handles the in-flight cursor is the oldest cursor every time.
  for (let i = 0; i < 4; i++) {
    const env = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 5 + i });
    assert.equal(env.error, undefined, `search ${i}: ${JSON.stringify(env.error)}`);
    assert.ok(env.pagination?.next_cursor);
  }
  assert.ok(storeOf(gw).size <= 3);
  f.release();
  const page = await pending;
  assert.equal(page.error, undefined, `the in-flight cursor must survive: ${JSON.stringify(page.error)}`);
  assert.deepEqual(ids(page), Array.from({ length: 20 }, (_, i) => `obs-${20 + i}`));
});

test('cursor eviction gateway: an evicted cursor gives a tool result byte-identical to an expired one (real SDK)', async t => {
  const f = await fixture(40); t.after(f.close);
  // A generous TTL keeps the eviction phase far from expiry even on a loaded machine (the mutation gate runs suites in parallel).
  const ttlMs = 6000;
  const gateway = new FhirGateway({ ...f.config({ maxHandles: 2, ttlMs }), contextId: 'ctx_eviction_identity' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(({ era }) => createMcpServer(gateway, { era }), { transport: serverSide });
  const client = new Client({ name: 'cursor-eviction-probe', version: '0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } } as never);
  await client.connect(clientSide);
  t.after(async () => { await client.close().catch(() => undefined); await handle.close().catch(() => undefined); gateway.close(); });
  type Result = { structuredContent?: GatewayEnvelope; content?: { text?: string }[]; isError?: boolean };
  const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as Result;
  const one = (await call('fhir_search', { resource_type: 'Observation', page_size: 10 })).structuredContent!;
  const firstExpiry = Date.parse(storeOf(gateway).get(one.pagination!.next_cursor!).expires_at);
  const two = (await call('fhir_search', { resource_type: 'Observation', page_size: 10, params: [{ name: 'code', value: 'http://loinc.org|4548-4' }] })).structuredContent!;
  const evictedCursor = one.pagination!.next_cursor!, expiringCursor = two.pagination!.next_cursor!;
  const evicted = await call('fhir_page', { cursor: evictedCursor });
  assert.ok(Date.now() < firstExpiry, 'the first cursor was evicted before its own expiry, not expired');
  assert.equal(evicted.structuredContent?.error?.code, 'RESULT_EXPIRED');
  await sleep(ttlMs + 200);
  const expiredResult = await call('fhir_page', { cursor: expiringCursor });
  assert.equal(expiredResult.structuredContent?.error?.code, 'RESULT_EXPIRED');
  // Only the per-call request id and elapsed time may differ.
  const normalize = (r: Result) => JSON.stringify(r).replace(/(\\?"request_id\\?":\\?")[0-9a-f-]{36}/g, '$1<request>').replace(/(\\?"elapsed_ms\\?":)\d+/g, '$1<ms>');
  assert.equal(normalize(evicted), normalize(expiredResult));
  assert.ok(normalize(evicted).includes('<request>') && !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(normalize(evicted)), 'only the request ids were normalized');
  assert.equal(JSON.stringify(evicted).length, JSON.stringify(expiredResult).length, 'same byte length');
});

test('cursor eviction gateway: recent replay still returns the same page with no extra upstream work (CUR-04, CUR-13)', async t => {
  const f = await fixture(40); t.after(f.close);
  const gw = f.gateway();
  t.after(() => gw.close());
  // Fill the default 128-handle quota well past the point where cursors must be evicted.
  for (let i = 0; i < 160; i++) assert.equal((await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 1 + (i % 7) })).error, undefined, `fill ${i}`);
  assert.equal(storeOf(gw).size, 128);
  const head = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 10 });
  const chain = [head.pagination!.next_cursor!];
  const original: { ids: string[]; next?: string; expires: unknown }[] = [];
  for (let k = 0; k < 3; k++) {
    const env = await gw.execute('fhir_page', { cursor: chain[k]! });
    assert.equal(env.error, undefined, JSON.stringify(env.error));
    original.push({ ids: ids(env), next: env.pagination?.next_cursor, expires: storeOf(gw).get(chain[k]!).expires_at });
    chain.push(env.pagination!.next_cursor!);
  }
  const searches = f.state.searches;
  for (let k = 0; k < 3; k++) {
    const replay = await gw.execute('fhir_page', { cursor: chain[k]! });
    assert.equal(replay.error, undefined, `replay ${k}: ${JSON.stringify(replay.error)}`);
    assert.deepEqual(ids(replay), original[k]!.ids, `replay ${k} returns the same page`);
    assert.equal(replay.budget.upstream_calls, 0, `replay ${k} does no upstream work`);
    assert.equal(storeOf(gw).get(chain[k]!).expires_at, original[k]!.expires, `replay ${k} does not renew the expiry`);
  }
  assert.equal(f.state.searches, searches, 'no upstream search during replay');
});

test('cursor eviction gateway: a request that can never fit still gives a non-retryable RETENTION_LIMIT', async t => {
  const f = await fixture(60); t.after(f.close);
  const gw = f.gateway({ retentionBytes: 256 });
  t.after(() => gw.close());
  const env = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 10 });
  assert.equal(env.error?.code, 'RETENTION_LIMIT');
  assert.equal(env.error?.retryable, false);
  assert.equal(storeOf(gw).size, 0);
});

test('cursor eviction stdio: 300 cursor-issuing calls in one session never get RETENTION_LIMIT under default limits', async t => {
  const f = await fixture(40); t.after(f.close);
  const dir = await mkdtemp(join(tmpdir(), 'curev-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(f.config()), { encoding: 'utf8', mode: 0o600 });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'packages/server/src/cli.ts', '--config', configPath],
    env: { ...getDefaultEnvironment(), TMPDIR: tmpdir() }, stderr: 'pipe' });
  const client = new Client({ name: 'cursor-eviction-session', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } } as never);
  await client.connect(transport);
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args }) as { structuredContent?: GatewayEnvelope }).structuredContent!;
  const codes = new Map<string, number>();
  const cursors: string[] = [];
  for (let i = 0; i < 150; i++) {
    // A fresh search, then one page of its chain: two cursor-issuing calls per round.
    const search = await call('fhir_search', { resource_type: 'Observation', page_size: 2 + (i % 5) });
    const page = search.pagination?.next_cursor ? await call('fhir_page', { cursor: search.pagination.next_cursor }) : search;
    for (const env of [search, page]) {
      if (env.error) codes.set(env.error.code, (codes.get(env.error.code) ?? 0) + 1);
      else { assert.ok(env.pagination?.next_cursor?.startsWith('cur_'), `round ${i}: every call issues a cursor`); cursors.push(env.pagination!.next_cursor!); }
    }
  }
  assert.deepEqual([...codes], [], 'no call in the session is refused');
  assert.equal(cursors.length, 300);
  assert.equal((await call('fhir_page', { cursor: cursors[0]! })).error?.code, 'RESULT_EXPIRED', 'the oldest cursor was evicted, giving the expired refusal');
  const latest = await call('fhir_page', { cursor: cursors.at(-1)! });
  assert.equal(latest.error, undefined, `the newest cursor is live: ${JSON.stringify(latest.error)}`);
});
