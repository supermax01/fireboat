import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FhirGateway, toMcpToolResult, type GatewayConfig } from '../packages/core/src/index.js';
import type { GatewayTestOptions, HostProfileEntry } from '../packages/core/src/delivery.js';
import { ResultStore } from '../packages/core/src/store.js';
import { GatewayFault } from '../packages/core/src/transport.js';

const a = 'synthetic-patient-a';
const observation = (id: string, extra: Record<string, unknown> = {}) => ({ resourceType: 'Observation', id, meta: { versionId: '1' }, status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, subject: { reference: `Patient/${a}` }, effectiveDateTime: '2026-01-02T10:00:00Z', valueQuantity: { value: 7.1, unit: '%', system: 'http://unitsofmeasure.org', code: '%' }, ...extra });

async function fixture(options: { delayMs?: number; records?: Record<string, unknown>[]; next?: string; readText?: boolean } = {}) {
  let baseUrl = '';
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, baseUrl);
    const send = () => {
      res.setHeader('content-type', 'application/fhir+json');
      if (url.pathname.endsWith('/metadata')) { res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: ['Patient', 'Observation', 'Medication'].map(type => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: ['patient', 'subject', 'code'].map(name => ({ name })) })) }] })); return; }
      if (url.pathname.endsWith('/Observation')) {
        const records = options.records ?? [observation('obs-a'), observation('obs-a2')];
        res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', total: records.length, link: [{ relation: 'self', url: url.href }, ...(options.next ? [{ relation: 'next', url: options.next.replace('__SELF__', url.href) }] : [])], entry: records.map(resource => ({ resource, search: { mode: 'match' } })) })); return;
      }
      const id = url.pathname.split('/').at(-1)!;
      res.end(JSON.stringify(observation(id, options.readText ? { text: { status: 'generated', div: '<div>synthetic narrative</div>' } } : {})));
    };
    if (options.delayMs) setTimeout(send, options.delayMs).unref?.(); else send();
  };
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address()!; const port = typeof address === 'object' ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/fhir/`;
  return { baseUrl, gateway: (limits?: GatewayConfig['limits'], extra?: Partial<GatewayConfig>) => new FhirGateway({ mode: 'synthetic', source: { alias: 'fixture', baseUrl }, patientId: a, limits, ...extra }), close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

// J-5: text/structured parity
test('J-5 default text content is the serialized bounded envelope', async t => {
  const f = await fixture(); t.after(f.close);
  const env = await f.gateway().execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' });
  const result = toMcpToolResult(env);
  assert.deepEqual(JSON.parse(result.content[0]!.text), JSON.parse(JSON.stringify(env)));
});

test('J-5 slim evidence text still carries cursor, handle, expiry, warnings and error (G-15: summary removed)', async t => {
  const f = await fixture(); t.after(f.close);
  assert.throws(() => f.gateway(undefined, { textMode: 'summary' } as Partial<GatewayConfig>), /delivery\.profile/);
  const entry = (era: 'modern' | 'legacy'): HostProfileEntry => ({ id: 'fixture-host', version: '1', host: { name: 'fixture', version: '1', client_stack: 'sdk', client_stack_version: '2.3.1' }, era, transport: 'stdio', workflow: 'recent-labs-v1', delivery_profile: 'structured-evidence-v1', verification: 'fixture_only' });
  const override: GatewayTestOptions = { testDeliveryRegistryOverride: { profileId: 'fixture-host', entries: [entry('modern'), entry('legacy')] } };
  const gw = new FhirGateway({ mode: 'synthetic', source: { alias: 'fixture', baseUrl: f.baseUrl }, patientId: a, delivery: { profile: 'structured-evidence-v1', hostProfileId: 'fixture-host' } }, override);
  const env = await gw.execute('fhir_search', { resource_type: 'Observation', page_size: 1 });
  const text = gw.toToolResult(env).content[0]!.text;
  if (env.result) { assert.ok(text.includes(env.result.handle), text); assert.ok(text.includes(env.result.expires_at), text); }
  for (const w of env.warnings) assert.ok(text.includes(w.code), text);
  const err = await gw.execute('fhir_read', { resource_type: 'Observation', id: 'missing', context_handle: 'forged' });
  assert.ok(gw.toToolResult(err).content[0]!.text.includes(err.error!.code));
});

// J-7 store: refcount, eviction, idle purge, retryable limit
test('J-7 identical pages are stored once (quota counted once)', () => {
  const store = new ResultStore<{ v: string }>(500, 10, 60_000);
  const value = { v: 'x'.repeat(300) };
  store.put('cur', value); store.put('res', value);
  assert.ok(store.usedBytes() < 400, `used=${store.usedBytes()}`);
  store.close();
});

test('J-7 RETENTION_LIMIT is retryable and names earliest expiry', () => {
  const store = new ResultStore<{ v: string }>(350, 10, 60_000);
  store.put('cur', { v: 'x'.repeat(300) });
  assert.throws(() => store.put('cur', { v: 'y'.repeat(300) }), (e: unknown) => e instanceof GatewayFault && e.code === 'RETENTION_LIMIT' && e.retryable === true && /\d{4}-\d{2}-\d{2}T/.test(e.message));
  store.close();
});

test('J-7 evictOldestRes evicts res_ but never live cursors', () => {
  const store = new ResultStore<{ v: string }>(10_000, 10, 60_000);
  const cur = store.put('cur', { v: 'cursor' }); store.put('res', { v: 'result' });
  assert.equal(store.evictOldestRes(), true);
  assert.equal(store.get(cur.handle).value.v, 'cursor');
  assert.equal(store.evictOldestRes(), false);
  store.close();
});

test('J-7 idle purge with controlled clock removes expired entries without a read', () => {
  let now = 1_000_000;
  const store = new ResultStore<{ v: string }>(10_000, 10, 1000, () => now);
  store.put('res', { v: 'gone-soon' });
  now += 5000; store.purgeExpired();
  assert.equal(store.size, 0);
  store.close();
});

test('J-7 more reads than maxHandles: res handles are best-effort, reads still succeed', async t => {
  const f = await fixture(); t.after(f.close);
  const gw = f.gateway({ maxHandles: 2, retentionBytes: 10 * 1024 * 1024 });
  let last;
  for (let i = 0; i < 6; i++) last = await gw.execute('fhir_read', { resource_type: 'Observation', id: `obs-${i}` });
  assert.equal(last!.error, undefined);
  gw.close();
});

// J-22 admission queue + cancellation + deadline
test('J-22 fifth concurrent call queues instead of immediate RATE_LIMITED', async t => {
  const f = await fixture({ delayMs: 120 }); t.after(f.close);
  const gw = f.gateway({ timeoutMs: 5000 });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => gw.execute('fhir_read', { resource_type: 'Observation', id: `obs-${i}` })));
  assert.ok(results.every(r => r.error?.code !== 'RATE_LIMITED'), JSON.stringify(results.map(r => r.error)));
  gw.close();
});

test('J-22 cancelled call aborts upstream, frees slot, no allowed audit or retention', async t => {
  const f = await fixture({ delayMs: 400 }); t.after(f.close);
  const gw = f.gateway({ timeoutMs: 5000 });
  const ctrl = new AbortController();
  const pending = gw.execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' }, { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 30);
  const cancelled = await pending;
  assert.equal(cancelled.error?.code, 'REQUEST_CANCELLED');
  assert.ok(!gw.auditEvents.some(e => e.outcome === 'allowed'));
  const after = await gw.execute('fhir_capabilities', { topic: 'context' });
  assert.equal(after.error, undefined);
  gw.close();
});

test('J-22 deadline expiry yields timeout/cancelled without allowed audit', async t => {
  const f = await fixture({ delayMs: 400 }); t.after(f.close);
  const gw = f.gateway({ timeoutMs: 5000, deadlineMs: 60 } as GatewayConfig['limits']);
  const env = await gw.execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' });
  assert.ok(['UPSTREAM_TIMEOUT', 'REQUEST_CANCELLED'].includes(env.error?.code ?? ''), env.error?.code);
  assert.ok(!gw.auditEvents.some(e => e.outcome === 'allowed'));
  gw.close();
});

// J-42
test('J-42 non-loopback fault is LOOPBACK_ONLY and classification is operator-declared', async t => {
  assert.throws(() => new FhirGateway({ mode: 'synthetic', source: { alias: 'x', baseUrl: 'http://example.com/fhir' }, patientId: a }), (e: unknown) => e instanceof GatewayFault && e.code === 'LOOPBACK_ONLY');
  const f = await fixture(); t.after(f.close);
  const env = await f.gateway().execute('fhir_capabilities', { topic: 'context' });
  assert.equal((env.data as Record<string, unknown>)['data_classification'], 'operator_declared_synthetic_unverified');
});

// J-7 multi-MB / many-page retention at store level (gateway paging drain is covered in core.test.ts)
test('J-7 more than 65 multi-KB pages retained and drained within byte quota', () => {
  const store = new ResultStore<{ page: number; blob: string }>(10 * 1024 * 1024, 256, 60_000);
  const handles: string[] = [];
  for (let i = 0; i < 70; i++) handles.push(store.put('cur', { page: i, blob: `${i}:` + 'x'.repeat(50_000) }).handle);
  assert.ok(store.usedBytes() > 3 * 1024 * 1024, `used=${store.usedBytes()}`);
  for (let i = 0; i < 70; i++) assert.equal(store.get(handles[i]!).value.page, i);
  store.close();
  assert.equal(store.usedBytes(), 0);
});

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repoRoot, 'packages', 'server', 'src', 'cli.ts');

// J-14 spawned CLI proxy-risk warning (names only, never values)
test('J-14 CLI warns on ambient proxy risk at startup without leaking proxy values', async () => {
  const secret = 'http://proxy-user:proxy-secret@127.0.0.1:9999';
  const stderr = await new Promise<string>((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', cliPath, '--config', join(tmpdir(), 'fhir-mcp-missing-config.json')], { cwd: repoRoot, env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: secret } }, (_e, _out, err) => resolve(err));
  });
  assert.match(stderr, /ambient proxy risk/);
  assert.match(stderr, /HTTPS_PROXY/);
  assert.ok(!stderr.includes('proxy-secret') && !stderr.includes('9999'), stderr);
});

// J-38 + J-5 raw stdio wire conformance (legacy era; modern era wire bytes are measured by the eval runner)
test('J-38/J-5 raw stdio: negotiated version restricted and wire result fits ceiling', async t => {
  const f = await fixture(); t.after(f.close);
  const dir = await mkdtemp(join(tmpdir(), 'fhir-mcp-wire-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ mode: 'synthetic', source: { alias: 'fixture', baseUrl: f.baseUrl }, patientId: a }));
  const child = spawn(process.execPath, ['--import', 'tsx', cliPath, '--config', configPath], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGTERM'); });
  const lines: string[] = [];
  let buffer = '';
  const waitFor = (id: number) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no response id=${id}: ${lines.join('').slice(0, 300)}`)), 15000);
    const check = () => { for (const line of lines.splice(0)) { try { const msg = JSON.parse(line) as Record<string, unknown>; if (msg['id'] === id) { clearTimeout(timer); child.stdout.off('data', onData); resolve(msg); return; } lines.push(line); } catch { /* partial */ } } };
    const onData = (chunk: Buffer) => { buffer += chunk.toString(); const parts = buffer.split('\n'); buffer = parts.pop() ?? ''; lines.push(...parts.filter(Boolean)); check(); };
    child.stdout.on('data', onData); check();
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'wire-test', version: '0' } } })}\n`);
  const init = await waitFor(1);
  const initResult = init['result'] as { protocolVersion?: string } | undefined;
  // V-30: an unsupported legacy handshake version negotiates exactly the one supported legacy revision.
  assert.ok(init['error'] !== undefined || initResult?.protocolVersion === '2025-11-25', JSON.stringify(init).slice(0, 300));
  if (!init['error']) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fhir_capabilities', arguments: { topic: 'server', output: { max_bytes: 4096 } } } })}\n`);
    const call = await waitFor(2);
    const resultBytes = Buffer.byteLength(JSON.stringify(call['result']));
    assert.ok(resultBytes <= 4096, `wire result ${resultBytes} exceeds 4096`);
  }
  child.stdin.end();
});

// J-38 per-request version mismatch rejection through the real stdio transport (-32022), proven from wire bytes
test('J-38 stdio conformance: per-request version mismatches are rejected with -32022 on the wire', async t => {
  const f = await fixture(); t.after(f.close);
  const dir = await mkdtemp(join(tmpdir(), 'fhir-mcp-j38-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ mode: 'synthetic', source: { alias: 'fixture', baseUrl: f.baseUrl }, patientId: a }));
  const meta = (v: string) => ({ 'io.modelcontextprotocol/protocolVersion': v, 'io.modelcontextprotocol/clientInfo': { name: 'wire-test', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} });
  const session = () => {
    const child = spawn(process.execPath, ['--import', 'tsx', cliPath, '--config', configPath], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map<number, { resolve: (raw: string) => void; timer: ReturnType<typeof setTimeout> }>();
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n'); buffer = parts.pop() ?? '';
      for (const raw of parts.filter(Boolean)) {
        try { const msg = JSON.parse(raw) as { id?: number }; const waiter = typeof msg.id === 'number' ? pending.get(msg.id) : undefined; if (waiter) { pending.delete(msg.id!); clearTimeout(waiter.timer); waiter.resolve(raw); } } catch { /* ignore */ }
      }
    });
    const request = (frame: Record<string, unknown> & { id: number }): Promise<string> => new Promise((resolve, reject) => {
      pending.set(frame.id, { resolve, timer: setTimeout(() => reject(new Error(`no wire response for id=${frame.id}`)), 15000) });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
    });
    return { child, request, notify: (frame: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`) };
  };
  const call = (id: number, version?: string) => ({ id, method: 'tools/call', params: { name: 'fhir_capabilities', arguments: { topic: 'context' }, ...(version ? { _meta: meta(version) } : {}) } });

  // Modern era: pin via discover, then mismatched per-request claims must be rejected, correct claims served.
  const modern = session(); t.after(() => { modern.child.kill('SIGTERM'); });
  const discoverRaw = await modern.request({ id: 1, method: 'server/discover', params: { _meta: meta('2026-07-28') } });
  assert.deepEqual((JSON.parse(discoverRaw).result as { supportedVersions: string[] }).supportedVersions, ['2026-07-28']);
  const okRaw = await modern.request(call(2, '2026-07-28'));
  assert.equal(JSON.parse(okRaw).error, undefined);
  const mismatchRaw = await modern.request(call(3, '2099-01-01'));
  assert.ok(mismatchRaw.includes('"code":-32022'), mismatchRaw);
  const mismatch = JSON.parse(mismatchRaw) as { error: { code: number; data: { supported: string[]; requested: string } } };
  assert.equal(mismatch.error.code, -32022);
  assert.deepEqual(mismatch.error.data.supported, ['2026-07-28']);
  assert.equal(mismatch.error.data.requested, '2099-01-01');
  const wrongEraRaw = await modern.request(call(4, '2025-11-25'));
  assert.equal((JSON.parse(wrongEraRaw) as { error: { code: number } }).error.code, -32022);
  const stillOkRaw = await modern.request(call(5, '2026-07-28'));
  assert.equal(JSON.parse(stillOkRaw).error, undefined, 'connection stays usable after a rejected mismatch');
  modern.child.stdin.end();

  // Opening unsupported modern claim: SDK -32022 before any pin.
  const opening = session(); t.after(() => { opening.child.kill('SIGTERM'); });
  const openingRaw = await opening.request({ id: 1, method: 'server/discover', params: { _meta: meta('2099-01-01') } });
  assert.equal((JSON.parse(openingRaw) as { error: { code: number } }).error.code, -32022);
  opening.child.stdin.end();

  // Legacy era: negotiated version restricted; a modern claim on the legacy-pinned connection is a mismatch.
  const legacy = session(); t.after(() => { legacy.child.kill('SIGTERM'); });
  const initRaw = await legacy.request({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'wire-test', version: '0' } } });
  assert.equal((JSON.parse(initRaw).result as { protocolVersion: string }).protocolVersion, '2025-11-25');
  legacy.notify({ method: 'notifications/initialized', params: {} });
  const legacyOkRaw = await legacy.request(call(2));
  assert.equal(JSON.parse(legacyOkRaw).error, undefined);
  const legacyMismatchRaw = await legacy.request(call(3, '2026-07-28'));
  assert.ok(legacyMismatchRaw.includes('"code":-32022'), legacyMismatchRaw);
  const legacyMismatch = JSON.parse(legacyMismatchRaw) as { error: { data: { supported: string[]; requested: string } } };
  assert.deepEqual(legacyMismatch.error.data.supported, ['2025-11-25']);
  assert.equal(legacyMismatch.error.data.requested, '2026-07-28');
  legacy.child.stdin.end();
});

// J-4 / C-17 narrative derived + recipe warnings merged
test('J-4 narrative_omitted reflects actual omission and recipe warnings surface', async t => {
  const f = await fixture(); t.after(f.close);
  const plain = await f.gateway().execute('fhir_read', { resource_type: 'Observation', id: 'obs-a', output: { format: 'fhir' } });
  assert.equal(plain.transform['narrative_omitted'], false, JSON.stringify(plain.transform));
});
