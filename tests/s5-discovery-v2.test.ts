import { SERVER_IDENTITY } from '../packages/core/src/identity.js';
// S5.5 private candidate seam. The production factory/listing remain 0.1.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer } from '../packages/server/src/index.js';
import { FhirGateway } from '../packages/core/src/index.js';
import { permissiveInputSchema, toMcpToolResult02, toolEnvelopeV2Schemas, validateCrossField02, validateDeliverable02, type DeliveryContext, type GatewayEnvelope02, type ValidationContext02 } from '../packages/core/src/contracts.js';
import { createDiscoveryStore, readDiscoverySnapshot, freezeSupportSnapshot, advanceDiscoveryCursor, type DiscoverySnapshotValue } from '../packages/core/src/discovery.js';
import { RetentionLedger, ResultStore } from '../packages/core/src/store.js';
import { GatewayFault } from '../packages/core/src/transport.js';
import { stringifyFhir } from '../packages/core/src/decimal.js';

type Any = Record<string, any>;
interface Candidate {
  capabilitiesV2(raw: unknown, delivery?: DeliveryContext): Promise<GatewayEnvelope02>;
  credentials: { invalidate(): boolean };
  discoveryStore: ResultStore<DiscoverySnapshotValue>; store: ResultStore<any>;
  bytesV2(e: GatewayEnvelope02, d: DeliveryContext): void;
  rollbackDiscoveryV2(p: { clinical: string[]; discovery: string[] }): void;
  discoveryBindingV2(): any;
  metadataExpiresAt: number; capabilityRevision: string; stateGeneration: number; authEpoch: number;
  policyRevision: string; capabilities: Map<string, any>; invalidateState(): void;
}
const config = { mode: 'synthetic' as const, source: { alias: 'local', baseUrl: 'http://127.0.0.1:9/fhir' }, patientId: 'synthetic-s55', contextId: 'ctx_s55' };
const names = ['subject', 'date', 'code', 'category', 'status', 'value-quantity'];
function metadata(extra: Any = {}): Any {
  return { resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [
    { type: 'Patient', interaction: [{ code: 'read' }, { code: 'search-type' }] },
    { type: 'Observation', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: names.map(name => ({ name, type: name === 'subject' ? 'reference' : name === 'date' ? 'date' : name === 'value-quantity' ? 'quantity' : 'token', definition: `http://hl7.org/fhir/SearchParameter/Observation-${name}` })) },
    { type: 'Condition', interaction: [{ code: 'read' }, { code: 'search-type' }] },
    { type: 'Specimen', interaction: [{ code: 'read' }, { code: 'search-type' }] },
    { type: 'CapabilityStatement', interaction: [{ code: 'read' }, { code: 'search-type' }] },
  ] }], ...extra };
}
const data = (e: GatewayEnvelope02): Any => e.data as Any;
const unavailable = (e: any) => e.code === 'DISCOVERY_EXPIRED';
function freeze<T>(node: T): T {
  if (node && typeof node === 'object' && !Object.isFrozen(node)) { Object.values(node).forEach(freeze); Object.freeze(node); }
  return node;
}
async function fixture(options: Any = {}) {
  let mode = 'good', document = metadata(), tokenStatus = 200;
  let tokenStarted: (() => void) | undefined, releaseToken: (() => void) | undefined;
  const tokenSeen = new Promise<void>(r => { tokenStarted = r; });
  const work = { metadata: 0, auth: 0, clinical: 0 };
  let release: (() => void) | undefined, started: (() => void) | undefined;
  const seen = new Promise<void>(r => { started = r; });
  const http = createServer(async (req, res) => {
    if (req.url === '/token') {
      work.auth++; tokenStarted?.();
      if (options.holdFirstToken && work.auth === 1) await new Promise<void>(r => { releaseToken = r; });
      res.statusCode = tokenStatus; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(tokenStatus === 200 ? { access_token: 'synthetic-token', token_type: 'Bearer', expires_in: options.tokenExpiresIn ?? 3600 } : {})); return;
    }
    if (req.url === '/fhir/metadata') {
      work.metadata++; started?.();
      if (mode === 'wait') await new Promise<void>(r => { release = r; });
      res.setHeader('content-type', 'application/fhir+json');
      if (mode === 'fail') { res.statusCode = 503; res.end('{}'); } else res.end(JSON.stringify(document));
      return;
    }
    if (options.clinicalPages) {
      work.clinical++;
      const url = new URL(req.url!, `http://${req.headers.host}`), next = new URL(url);
      next.searchParams.set('_getpagesoffset', '1');
      res.setHeader('content-type', 'application/fhir+json');
      res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href },
        ...(!url.searchParams.has('_getpagesoffset') ? [{ relation: 'next', url: next.href }] : [])],
        entry: [{ search: { mode: 'match' }, resource: { resourceType: 'Observation', id: `synthetic-o${work.clinical}`,
          subject: { reference: 'Patient/synthetic-s55' }, status: 'final', code: { text: 'synthetic' } } }] })); return;
    }
    work.clinical++; res.setHeader('content-type', 'application/fhir+json'); res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: `http://${req.headers.host}${req.url}` }], entry: [] }));
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  const address = http.address() as { port: number }, baseUrl = `http://127.0.0.1:${address.port}/fhir`;
  const source = { alias: 'local', baseUrl, ...(options.auth ? { auth: { type: 'client_credentials' as const, tokenUrl: `http://127.0.0.1:${address.port}/token`, clientId: 'synthetic-client', clientSecretEnv: 'FIREBOAT_S55_TEST_SECRET' } } : {}) };
  if (options.auth) process.env.FIREBOAT_S55_TEST_SECRET = 'synthetic-only';
  const g = new FhirGateway({ ...config, source, discovery: options.discovery, limits: options.limits }), c = g as unknown as Candidate;
  if (typeof c.capabilitiesV2 !== 'function') {
    g.close(); await new Promise<void>(r => http.close(() => r()));
    assert.fail('private candidate handler exists');
  }
  return { g, c, work, seen, tokenSeen, releaseToken: () => releaseToken?.(), setTokenStatus: (status: number) => { tokenStatus = status; }, setMode: (s: string) => { mode = s; }, setDocument: (d: Any) => { document = d; }, release: () => release?.(),
    close: async () => { g.close(); await new Promise<void>((r, reject) => http.close(e => e ? reject(e) : r())); delete process.env.FIREBOAT_S55_TEST_SECRET; } };
}
async function positive(c: Candidate, topic = 'support') {
  const e = await c.capabilitiesV2({ topic, limit: 1, ...(topic === 'search_parameter' ? { resource_type: 'Observation' } : {}) });
  assert.match(data(e).next_cursor, /^cur_/); assert.equal(e.result, undefined);
  return data(e).next_cursor as string;
}
for (const era of ['modern', 'legacy'] as const) {
  test(`S55 ${era}: actual SDK six topics, exact complete result bytes and policy intersection`, async () => {
    const f = await fixture(); const { c } = f;
    const [a, b] = InMemoryTransport.createLinkedPair();
    let wire: Any = {};
    let lastCapture: ValidationContext02 | undefined; const toResult = f.g.toToolResult.bind(f.g);
    f.g.toToolResult = (e, o) => { lastCapture = (f.g as any).capturesV2.get(e); return toResult(e,o); };
    const send = b.send.bind(b); b.send = async (message, options) => { if ('result' in message) wire = message.result as Any; return send(message, options); };
    const server = serveStdio(() => createMcpServer(f.g, { era }), { transport: b });
    const client = new Client({ name: 's55-tests', version: '0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
    try {
      await client.connect(a);
      for (const topic of ['server', 'resource', 'context', 'schema', 'search_parameter', 'support']) {
        const args = { topic, ...(['resource', 'schema', 'search_parameter'].includes(topic) ? { resource_type: 'Observation' } : {}) };
        const result = await client.callTool({ name: 'fhir_capabilities', arguments: args });
        const env = result.structuredContent as unknown as GatewayEnvelope02;
        assert.equal(toolEnvelopeV2Schemas.fhir_capabilities.safeParse(env).success, true, topic);
        assert.equal(Buffer.byteLength(JSON.stringify(wire)), env.budget.bytes_returned, topic);
        assert.ok(env.budget.bytes_returned <= env.budget.byte_limit);
        assert.equal(result.isError, undefined); assert.equal(env.result, undefined);
        assert.ok(!env.warnings.some(w => w.code === 'TEST_ENVELOPE_CORRUPTOR_ACTIVE'));
        assert.equal(env.coverage.scope, 'metadata'); assert.equal(env.coverage.query_evidence, 'metadata_snapshot');
        const trusted = lastCapture!;
        const context = { metadata: trusted.metadata, era, binding: { sourceAlias: 'local', fhirVersion: '4.0.1', sourceRevision: c.capabilityRevision, policyRevision: 'synthetic-v2', contextHandle: 'ctx_s55' }, topic, resourceType: args.resource_type, patientId: config.patientId, path: '', formatSupplied: false };
        const capture = freeze({ ...context, effectiveByteLimit: 24576, deliveryProfile: 'full-text-v1',
          renderedText: wire.content[0].text, result: wire, serverIdentity: SERVER_IDENTITY }) as ValidationContext02;
        assert.deepEqual(validateCrossField02('fhir_capabilities', env, capture), { ok: true }, topic);
        assert.deepEqual(validateDeliverable02('fhir_capabilities', env, capture), { ok: true }, topic);
        if (topic === 'server' || topic === 'resource' || topic === 'context') {
          assert.equal(data(env).network_confinement, 'literal_loopback'); assert.equal(data(env).synthetic_only, undefined);
        }
        if (topic === 'support') {
          assert.deepEqual(data(env).rows.find((r: Any) => r.resource_type === 'Specimen')?.executable_interactions, undefined);
          assert.deepEqual(data(env).rows.find((r: Any) => r.resource_type === 'Condition').executable_interactions, ['read']);
          for (const r of data(env).rows) assert.ok(r.instance_policy.length <= 120);
        }
      }
      assert.deepEqual(f.work, { metadata: 1, auth: 0, clinical: 0 });
    } finally { await client.close(); await server.close(); await f.close(); }
  });
  for (const topic of ['support', 'search_parameter']) test(`S55 ${era} ${topic}: worst-elapsed-width complete-page fitting, no skipped rows, immutable replay and absolute expiry`, async () => {
    const f = await fixture(); const { c } = f;
    try {
      // R02 reserves the full elapsed width. The old support fixture at 4096
      // has insufficient room; the public minimum itself remains unchanged.
      const cap = topic === 'support' ? 4096 : 8192;
      const args = { topic, ...(topic === 'search_parameter' ? { resource_type: 'Observation' } : {}), limit: 50, output: { max_bytes: cap } };
      const delivery = { era, profile: 'full-text-v1' as const };
      const full = data(await c.capabilitiesV2({ ...args, output: { max_bytes: 131072 } }, delivery));
      let e = await c.capabilitiesV2(args, delivery); const retainedBytes = c.discoveryStore.usedBytes(); const key = topic === 'support' ? 'rows' : 'search_parameters';
      const actual: Any[] = [];
      while (true) {
        actual.push(...data(e)[key]); assert.ok(data(e)[key].length > 0); assert.ok(e.budget.bytes_returned <= cap); assert.equal(e.result, undefined);
        const cursor = data(e).next_cursor; if (!cursor) break;
        const snapshot = c.discoveryStore.get(cursor); assert.equal(snapshot.expires_at, data(e).expires_at);
        assert.equal(Object.isFrozen(snapshot.value.binding), true);
        const next = { topic, cursor, limit: 50, output: { max_bytes: cap } };
        e = await c.capabilitiesV2(next, delivery);
        const replay = await c.capabilitiesV2(next, delivery);
        assert.equal(c.discoveryStore.usedBytes(), retainedBytes, 'all offsets share one charged snapshot blob');
        assert.deepEqual({ ...data(e), next_cursor: undefined }, { ...data(replay), next_cursor: undefined });
        assert.equal(data(e).expires_at, full.expires_at);
      }
      assert.deepEqual(actual, full[key]); assert.deepEqual(f.work, { metadata: 1, auth: 0, clinical: 0 });
    } finally { await f.close(); }
  });
}
for (const topic of ['support', 'search_parameter']) test(`S55 ${topic}: CUR-09/10 candidate equivalents and wrong-topic/context have uniform unavailable controls`, async () => {
  const f = await fixture(); const { c } = f;
  try {
    const cursor = await positive(c, topic);
    const control = await c.capabilitiesV2({ topic, cursor, limit: 1 });
    assert.equal(control.error, undefined); assert.ok(Object.keys(data(control)).length > 0);
    const clinical = c.store.put('cur', { records: [], type: 'Observation', offset: 0, query: [], suppressed: false }).handle;
    // CUR-09: clinical authority cannot resolve a discovery cursor, either page or result.
    assert.throws(() => c.store.get(cursor), (e: any) => e.code === 'RESULT_EXPIRED');
    const clinicalPage = await f.g.execute('fhir_page', { cursor });
    assert.equal(clinicalPage.error?.code, 'RESULT_EXPIRED', 'real clinical page dispatch rejects discovery authority');
    await assert.rejects(async () => (c as any).resultV2((c as any).admitV2('fhir_result', { handle: cursor })), (e: any) => e.code === 'RESULT_EXPIRED');
    // CUR-10: discovery authority cannot resolve a clinical cursor.
    const faults: Any[] = [];
    for (const args of [{ topic, cursor: clinical }, { topic, cursor: 'cur_unknown' }, { topic, cursor, context_handle: 'ctx_other' }, { topic: topic === 'support' ? 'search_parameter' : 'support', cursor }]) {
      await assert.rejects(c.capabilitiesV2(args), (e: any) => { faults.push(e); return unavailable(e); });
    }
    assert.ok(faults.every(e => !String(e.message).includes(cursor)));
    assert.ok(faults.every(e => e.code === faults[0]!.code && e.message === faults[0]!.message && e.retryable === faults[0]!.retryable));
    assert.deepEqual(f.work, { metadata: 1, auth: 0, clinical: 0 });
  } finally { await f.close(); }
});
test('S55 namespace guard refuses even a metadata blob inserted under res_', async () => {
  const f = await fixture();
  try {
    const cursor = await positive(f.c), value = f.c.discoveryStore.get(cursor).value;
    const wrong = f.c.discoveryStore.put('res', value).handle;
    await assert.rejects(f.c.capabilitiesV2({ topic: 'support', cursor: wrong }), unavailable);
  } finally { await f.close(); }
});
test('S55 binding rejects source, revision, policy, auth and generation substitutions independently', async () => {
  const f = await fixture(); const { c } = f;
  try {
    for (const field of ['sourceAlias', 'contextHandle', 'policyRevision', 'authEpoch', 'sourceRevision']) {
      const cursor = await positive(c), stored = c.discoveryStore.get(cursor).value;
      const changed = { ...stored, binding: { ...stored.binding, [field]: field === 'authEpoch' ? 999 : 'changed' } };
      const other = c.discoveryStore.put('cur', changed).handle;
      await assert.rejects(c.capabilitiesV2({ topic: 'support', cursor: other }), unavailable);
    }
    const cursor = await positive(c); c.stateGeneration++;
    await assert.rejects(c.capabilitiesV2({ topic: 'support', cursor }), unavailable);
  } finally { await f.close(); }
});
for (const selector of [{ resource_type: 'Observation' }, { name: 'date' }, { query: 'date' }, { path: '' }, { offset: 0 }, { source: 'local' }]) test(`S55 continuation rejects own selector ${Object.keys(selector)[0]} before any upstream work`, async () => {
  const f = await fixture();
  try {
    const cursor = await positive(f.c), before = { ...f.work };
    await assert.rejects(f.c.capabilitiesV2({ topic: 'support', cursor, ...selector }), (e: any) => e.code === 'INVALID_ARGUMENTS');
    assert.deepEqual(f.work, before);
  } finally { await f.close(); }
});
test('S55 expiry never renews; caller mutations cannot alter frozen snapshots or later replay', async () => {
  const f = await fixture();
  try {
    await positive(f.c);
    let now = 1000;
    const store = createDiscoveryStore({ ledger: new RetentionLedger(100000), now: () => now, ttlMs: 1000 });
    const value: Any = { topic: 'support', binding: f.c.discoveryBindingV2(), revision: 'r', capturedAt: new Date(1000).toISOString(), expiresAt: new Date(1800).toISOString(), rows: [{ resource_type: 'Patient' }] };
    try {
      const first = (freezeSupportSnapshot as (...args: any[]) => { handle: string; expires_at: string })(store, value, Date.parse(value.expiresAt)); value.rows[0].resource_type = 'Specimen';
      assert.equal((store.get(first.handle).value as any).rows[0].resource_type, 'Patient');
      now = 1500; const next = advanceDiscoveryCursor(store, first.handle, value.binding, 'support', 1);
      assert.equal(first.expires_at, new Date(1800).toISOString()); assert.equal(next.expires_at, first.expires_at);
      now = 1800; assert.throws(() => readDiscoverySnapshot(store, next.handle, value.binding, 'support'), unavailable);
    } finally { store.close(); }
  } finally { await f.close(); }
});
test('S55 failed refresh installs nothing, evicts nothing and retains discovery and clinical local remainders', async () => {
  const f = await fixture(); const { c } = f;
  try {
    const cursor = await positive(c);
    const clinical = c.store.put('cur', { records: [], type: 'Observation', offset: 0, query: [], suppressed: false }).handle;
    const before = { caps: c.capabilities, revision: c.capabilityRevision, generation: c.stateGeneration, clinical: stringifyFhir(c.store.get(clinical)), discovery: stringifyFhir(c.discoveryStore.get(cursor)) };
    c.metadataExpiresAt = 0; f.setMode('fail');
    await assert.rejects(c.capabilitiesV2({ topic: 'support' }), (e: any) => e.code === 'UPSTREAM_ERROR');
    assert.equal(c.capabilities, before.caps); assert.equal(c.capabilityRevision, before.revision); assert.equal(c.stateGeneration, before.generation);
    assert.equal(stringifyFhir(c.store.get(clinical)), before.clinical); assert.equal(stringifyFhir(c.discoveryStore.get(cursor)), before.discovery);
    await c.capabilitiesV2({ topic: 'support', cursor, limit: 1 });
    assert.equal(c.store.get(clinical).value.offset, 0);
    assert.deepEqual(f.work, { metadata: 2, auth: 0, clinical: 0 });
  } finally { await f.close(); }
});
test('S55 successful source change invalidates old metadata; late generation refresh never installs', async () => {
  const f = await fixture(); const { c } = f;
  try {
    const cursor = await positive(c); c.metadataExpiresAt = 0;
    f.setDocument(metadata({ software: { name: 'synthetic-source-new' } }));
    await c.capabilitiesV2({ topic: 'support' });
    await assert.rejects(c.capabilitiesV2({ topic: 'support', cursor }), unavailable);
    c.invalidateState(); f.setMode('wait');
    const pending = c.capabilitiesV2({ topic: 'support' });
    // Wait for this request's server-side latch, without timers determining the race.
    while (f.work.metadata < 3) await new Promise<void>(r => setImmediate(r));
    c.invalidateState(); f.release();
    await assert.rejects(pending, (e: any) => e.code === 'CONNECTION_REQUIRED');
    assert.equal(c.capabilities, undefined); assert.equal(c.discoveryStore.size, 0);
    f.setMode('good'); await positive(c);
  } finally { await f.close(); }
});
test('S55 failed final fitting rolls back provisional metadata; explicit transaction rolls back both stores', async () => {
  const f = await fixture({ discovery: { maxHandles: 1 } }); const { c } = f;
  try {
    const original = await positive(c), before = c.discoveryStore.size;
    const bytes = c.bytesV2.bind(c); let passes = 0;
    c.bytesV2 = (e, d) => { bytes(e, d); if (++passes > 1) throw new Error('synthetic final-fit failure'); };
    await assert.rejects(c.capabilitiesV2({ topic: 'support', limit: 1 }), /synthetic final-fit failure/);
    assert.equal(c.discoveryStore.size, before); c.discoveryStore.get(original);
    c.bytesV2 = bytes;
    const clinical = c.store.put('res', { synthetic: true }).handle;
    const discovery = await positive(c);
    c.rollbackDiscoveryV2({ clinical: [clinical], discovery: [discovery] });
    assert.throws(() => c.store.get(clinical)); assert.throws(() => c.discoveryStore.get(discovery));
  } finally { await f.close(); }
});
test('S55 discovery subquota and shared ledger bound retained metadata without evicting clinical cursors', async () => {
  const f = await fixture({ discovery: { snapshotBytes: 16000, maxHandles: 1 } });
  try {
    const first = await positive(f.c), clinical = f.c.store.put('cur', { synthetic: 'clinical' }).handle;
    const second = await positive(f.c);
    assert.equal(f.c.discoveryStore.size, 1); assert.throws(() => f.c.discoveryStore.get(first));
    f.c.store.get(clinical);
    assert.throws(() => f.c.discoveryStore.put('cur', { ...f.c.discoveryStore.get(second).value, revision: 'x'.repeat(20000) }), (e: any) => e.code === 'RETENTION_LIMIT');
    f.c.store.get(clinical);
  } finally { await f.close(); }
});
test('S55 independent token, metadata and clinical counters: authenticated discovery does no clinical work', async () => {
  const f = await fixture({ auth: true });
  try {
    const first = await f.c.capabilitiesV2({ topic: 'support', limit: 1 });
    assert.equal(first.budget.upstream_calls, 2);
    const cursor = data(first).next_cursor; assert.deepEqual(f.work, { auth: 1, metadata: 1, clinical: 0 });
    const cached = await f.g.execute('fhir_capabilities', { topic: 'support', cursor, limit: 1 });
    assert.equal(cached.budget.upstream_calls, 0); assert.deepEqual(f.work, { auth: 1, metadata: 1, clinical: 0 });
    f.c.authEpoch++;
    await assert.rejects(f.c.capabilitiesV2({ topic: 'support', cursor }), unavailable);
  } finally { await f.close(); }
});
test('S55 filters use reviewed text only; unsupported conformance and unknown rows never imply clinical access', async () => {
  const f = await fixture();
  try {
    await positive(f.c);
    const exact = await f.c.capabilitiesV2({ topic: 'search_parameter', resource_type: 'Observation', name: 'date' });
    assert.deepEqual(data(exact).search_parameters.map((p: Any) => p.name), ['date']);
    const empty = await f.c.capabilitiesV2({ topic: 'search_parameter', resource_type: 'Observation', query: 'unreviewed-source-secret' });
    assert.equal(data(empty).total_parameters, 0);
    for (const resource_type of ['CapabilityStatement', 'Specimen', 'UnknownThing']) {
      const support = await f.c.capabilitiesV2({ topic: 'support', resource_type });
      assert.deepEqual(data(support).rows[0].executable_interactions, []);
    }
  } finally { await f.close(); }
});
test('S55 gateway TTL is absolute across replay and continuation, including cached-metadata expiry', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-19T00:00:00Z') });
  const f = await fixture({ discovery: { metadataTtlMs: 1000 } });
  try {
    const first = await positive(f.c), expiry = f.c.discoveryStore.get(first).expires_at;
    t.mock.timers.tick(900);
    const e = await f.c.capabilitiesV2({ topic: 'support', cursor: first, limit: 1 });
    assert.equal(data(e).expires_at, expiry);
    t.mock.timers.tick(100);
    await assert.rejects(f.c.capabilitiesV2({ topic: 'support', cursor: data(e).next_cursor }), unavailable);
    assert.equal(f.work.metadata, 1);
    await positive(f.c); assert.equal(f.work.metadata, 2);
  } finally { await f.close(); }
});
test('S55 separate gateway stores and policy replacement invalidate only their own authority', async () => {
  const a = await fixture(), b = await fixture();
  try {
    const first = await positive(a.c), second = await positive(b.c);
    await assert.rejects(b.c.capabilitiesV2({ topic: 'support', cursor: first }), unavailable);
    await assert.rejects(a.c.capabilitiesV2({ topic: 'support', cursor: second }), unavailable);
    a.c.policyRevision = 'changed-policy';
    await assert.rejects(a.c.capabilitiesV2({ topic: 'support', cursor: first }), unavailable);
    await b.c.capabilitiesV2({ topic: 'support', cursor: second, limit: 1 });
    assert.equal(a.work.clinical + b.work.clinical, 0);
  } finally { await a.close(); await b.close(); }
});
test('S55 W0 preparation: real gateway overflow-selector rejection has an independently observed authorized clinical control', async () => {
  const f = await fixture();
  try {
    await positive(f.c, 'search_parameter');
    const before = { ...f.work };
    const rejected = await f.g.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'subject', value: ['Patient/synthetic-other', ...Array.from({ length: 33 }, (_, i) => `x${i}`)].join(',') }] });
    assert.equal(rejected.error?.code, 'INVALID_ARGUMENTS'); assert.deepEqual(f.work, before);
    const control = await f.g.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'subject', value: `Patient/${config.patientId}` }] });
    assert.equal(control.error, undefined); assert.equal(f.work.clinical, 1); assert.equal(control.budget.upstream_calls, 1);
  } finally { await f.close(); }
});
test('S55 an indivisible metadata row refuses at the SDK floor without skipping or evicting prior state', async () => {
  const f = await fixture({ discovery: { maxHandles: 1 } });
  try {
    const previous = await positive(f.c);
    const args = { topic: 'search_parameter', resource_type: 'Observation', name: 'value-quantity' };
    const control = await f.c.capabilitiesV2({ ...args, output: { max_bytes: 131072 } });
    assert.equal(data(control).search_parameters.length, 1);
    await assert.rejects(f.c.capabilitiesV2({ ...args, output: { max_bytes: 4096 } }), (e: any) => e.code === 'OUTPUT_LIMIT');
    f.c.discoveryStore.get(previous); assert.equal(f.c.discoveryStore.size, 1); assert.equal(f.c.store.size, 0);
  } finally { await f.close(); }
});
for (const era of ['modern', 'legacy'] as const) test(`S55 ${era} auth observer: first HTTP fetch, cache hit and expired-token refresh count actual attempts only`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-19T00:00:00Z') });
  const f = await fixture({ auth: true, tokenExpiresIn: 60 });
  const delivery = { era, profile: 'full-text-v1' as const };
  try {
    const first = await f.g.execute('fhir_capabilities', { topic: 'context' }, delivery);
    assert.equal(first.error, undefined); assert.equal(first.budget.upstream_calls, 2);
    assert.deepEqual(f.work, { auth: 1, metadata: 1, clinical: 0 });
    const cached = await f.g.execute('fhir_capabilities', { topic: 'context' }, delivery);
    assert.equal(cached.budget.upstream_calls, 0); assert.deepEqual(f.work, { auth: 1, metadata: 1, clinical: 0 });
    t.mock.timers.tick(61000);
    const refresh = await f.g.execute('fhir_capabilities', { topic: 'context' }, delivery);
    assert.equal(refresh.error, undefined); assert.equal(refresh.budget.upstream_calls, 1);
    assert.deepEqual(f.work, { auth: 2, metadata: 1, clinical: 0 });
    const cachedAgain = await f.g.execute('fhir_capabilities', { topic: 'context' }, delivery);
    assert.equal(cachedAgain.budget.upstream_calls, 0); assert.deepEqual(f.work, { auth: 2, metadata: 1, clinical: 0 });
  } finally { await f.close(); }
});
for (const era of ['modern', 'legacy'] as const) test(`S55 ${era} auth observer: failed HTTP attempts count on fitted faults and never install a cached token`, async () => {
  const f = await fixture({ auth: true });
  const delivery = { era, profile: 'full-text-v1' as const };
  try {
    f.setTokenStatus(503);
    for (let attempts = 1; attempts <= 2; attempts++) {
      const failed = await f.g.execute('fhir_capabilities', { topic: 'context' }, delivery);
      assert.equal(failed.error?.code, 'TOKEN_ENDPOINT_ERROR'); assert.equal(failed.error?.retryable, true);
      assert.equal(failed.budget.upstream_calls, 1);
      assert.deepEqual(f.work, { auth: attempts, metadata: 0, clinical: 0 });
      assert.ok(failed.budget.bytes_returned <= failed.budget.byte_limit);
      assert.equal(f.c.capabilities, undefined); assert.equal(f.c.discoveryStore.size, 0); assert.equal(f.c.store.size, 0);
    }
    f.setTokenStatus(200);
    const good = await f.g.execute('fhir_capabilities', { topic: 'context' }, delivery);
    assert.equal(good.error, undefined); assert.equal(good.budget.upstream_calls, 2);
    assert.deepEqual(f.work, { auth: 3, metadata: 1, clinical: 0 });
    const cached = await f.g.execute('fhir_capabilities', { topic: 'context' }, delivery);
    assert.equal(cached.budget.upstream_calls, 0); assert.deepEqual(f.work, { auth: 3, metadata: 1, clinical: 0 });
  } finally { await f.close(); }
});
test('S55 auth observer: provider retry after supersession counts both actual HTTP attempts without changing retry policy', async () => {
  const f = await fixture({ auth: true, holdFirstToken: true });
  try {
    const pending = f.g.execute('fhir_capabilities', { topic: 'context' });
    await f.tokenSeen; f.c.credentials.invalidate(); f.releaseToken();
    const result = await pending;
    assert.equal(result.error, undefined); assert.equal(result.budget.upstream_calls, 3);
    assert.deepEqual(f.work, { auth: 2, metadata: 1, clinical: 0 });
    const cached = await f.g.execute('fhir_capabilities', { topic: 'context' });
    assert.equal(cached.budget.upstream_calls, 0); assert.deepEqual(f.work, { auth: 2, metadata: 1, clinical: 0 });
  } finally { await f.close(); }
});

// Fix-round regressions exercise the private candidate only; serving remains 0.1.
test('S55fix R01 metadata coverage uses the standing declaration reason and MORE_PAGES', async () => {
  const f = await fixture();
  try {
    for (const topic of ['server', 'context', 'resource', 'search_parameter', 'support']) {
      const e = await f.c.capabilitiesV2({ topic, ...(['resource', 'search_parameter'].includes(topic) ? { resource_type: 'Observation' } : {}), limit: 1 });
      assert.ok(e.coverage.reasons.includes('DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION'), topic);
      assert.ok(!e.coverage.reasons.includes('MORE_METADATA_ROWS'));
      if (data(e).next_cursor) assert.ok(e.coverage.reasons.includes(topic === 'server' ? 'CAPABILITY_SUMMARY_LIMIT' : 'MORE_PAGES'));
    }
  } finally { await f.close(); }
});
for (const era of ['modern', 'legacy'] as const) test(`S55fix R02 ${era} SDK faults pass the deliverable gate without warnings`, async () => {
  const f = await fixture(), [a,b] = InMemoryTransport.createLinkedPair();
  let wire: Any = {};
  const send = b.send.bind(b); b.send = async (m,o) => { if ('result' in m) wire = m.result as Any; return send(m,o); };
  const server = serveStdio(() => createMcpServer(f.g, { era }), { transport: b });
  const client = new Client({ name: 's55-fault-tests', version: '0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  try {
    await client.connect(a);
    for (const [args, code] of [
      [{ topic: 'support', cursor: 'cur_unknown' }, 'DISCOVERY_EXPIRED'],
      [{ topic: 'support', context_handle: 'ctx_other' }, 'CONTEXT_REQUIRED'],
      [{ topic: 'search_parameter', resource_type: 'Encounter' }, 'UNSUPPORTED_RESOURCE'],
      [{ topic: 'server', cursor: 'cur_unknown' }, 'DISCOVERY_EXPIRED'],
    ] as const) {
      const result = await client.callTool({ name: 'fhir_capabilities', arguments: args });
      const env = result.structuredContent as unknown as GatewayEnvelope02;
      assert.equal(env.error?.code, code); assert.deepEqual(env.warnings, []);
      assert.deepEqual(validateDeliverable02('fhir_capabilities', env, freeze({
        binding: { sourceAlias: 'local', fhirVersion: (f.c as any).fhirVersion, sourceRevision: f.c.capabilityRevision, policyRevision: 'synthetic-v2', contextHandle: 'ctx_s55' }, formatSupplied: false,
        era, effectiveByteLimit: 24576, deliveryProfile: 'full-text-v1', renderedText: wire.content[0].text,
        result: wire, serverIdentity: SERVER_IDENTITY,
      }) as ValidationContext02), { ok: true }, code);
    }
  } finally { await client.close(); await server.close(); await f.close(); }
});
for (const topic of ['server', 'context', 'support']) for (const auth of [false, true]) test(`S55fix R03 ${topic} microtask invalidation auth=${auth}`, async () => {
  const f = await fixture({ auth }); const c = f.c as any;
  try {
    await c.capabilitiesV2({ topic: 'context' });
    const revision = c.capabilityRevision, discover = c.discover.bind(c);
    c.discover = async (...args: any[]) => { await discover(...args); queueMicrotask(() => { if (auth) c.authEpoch++; c.invalidateState(); }); };
    const env = await f.g.execute('fhir_capabilities', { topic, limit: 1 });
    assert.equal(env.error?.code, 'CONNECTION_REQUIRED'); assert.equal(c.discoveryStore.size, 0);
    assert.deepEqual(env.data, {}); assert.equal(env.coverage.state, 'unknown');
    assert.equal(c.capabilities, undefined);
    // No stale successful revision can escape the call.
    assert.ok(env.error && !('snapshot_revision' in env.data), revision);
  } finally { await f.close(); }
});
test('S55fix R03 post-describe invalidation cannot serve a stale revision', async () => {
  const f = await fixture(), c = f.c as any;
  try {
    const describe = c.describeV2.bind(c);
    c.describeV2 = (...args: any[]) => { describe(...args); c.invalidateState(); };
    const env = await f.g.execute('fhir_capabilities', { topic: 'support', limit: 1 });
    assert.equal(env.error?.code, 'CONNECTION_REQUIRED'); assert.deepEqual(env.data, {}); assert.equal(c.discoveryStore.size, 0);
  } finally { await f.close(); }
});
test('S55fix R04 cancellation is checked before describe and first expired put is retryable', async () => {
  const f = await fixture(), c = f.c as any;
  try {
    await c.capabilitiesV2({ topic: 'context' });
    const discover = c.discover.bind(c), describe = c.describeV2.bind(c); let described = false;
    c.discover = async (...args: any[]) => { await discover(...args); queueMicrotask(() => c.invalidateState()); };
    c.describeV2 = (...args: any[]) => { described = true; return describe(...args); };
    await assert.rejects(c.capabilitiesV2({ topic: 'server' }), (e: any) => e.code === 'CONNECTION_REQUIRED');
    assert.equal(described, false);
    c.discover = discover;
    const put = c.discoveryStore.putBatch.bind(c.discoveryStore);
    c.discoveryStore.putBatch = () => { throw new GatewayFault('DISCOVERY_EXPIRED', 'Synthetic expired insertion.'); };
    const env = await f.g.execute('fhir_capabilities', { topic: 'support', limit: 1 });
    assert.equal(env.error?.code, 'CONNECTION_REQUIRED'); assert.equal(env.error?.retryable, true); assert.equal(c.discoveryStore.size, 0);
    c.discoveryStore.putBatch = put;
  } finally { await f.close(); }
});
test('S55fix R04 first calls refresh below the TTL floor; continuations never refresh', async () => {
  const f = await fixture({ discovery: { metadataTtlMs: 1000 } });
  try {
    const cursor = await positive(f.c); const expiry = data(await f.c.capabilitiesV2({ topic: 'support', cursor, limit: 1 })).expires_at;
    f.c.metadataExpiresAt = Date.now() + 100;
    await f.c.capabilitiesV2({ topic: 'support', cursor, limit: 1 }); assert.equal(f.work.metadata, 1);
    const e = await f.c.capabilitiesV2({ topic: 'support', limit: 1 });
    assert.equal(f.work.metadata, 2); assert.ok(Date.parse(data(e).expires_at) - Date.parse(data(e).captured_at) >= 500);
    assert.equal(data(await f.c.capabilitiesV2({ topic: 'support', cursor, limit: 1 })).expires_at, expiry);
  } finally { await f.close(); }
});
for (const operation of ['clear', 'close'] as const) test(`S55fix R05 restore cannot resurrect after ${operation}`, () => {
  const ledger = new RetentionLedger(10000), store = new ResultStore<Any>(10000, 10, 10000, Date.now, { ledger });
  try {
    const handle = store.put('cur', { synthetic: true }).handle, restore = store.reservationCheckpoint();
    store[operation](); restore(); assert.equal(store.size, 0); assert.equal(ledger.usedBytes(), 0);
    assert.throws(() => store.get(handle), (e: any) => e.code === 'RESULT_EXPIRED');
  } finally { store.close(); }
});
test('S55fix R06 mutating output cannot poison module metadata', async () => {
  const f = await fixture();
  try {
    const first = data(await f.c.capabilitiesV2({ topic: 'search_parameter', resource_type: 'Observation' }));
    const hash = first.definitions.source_sha256; first.definitions.source_sha256 = 'f'.repeat(64);
    const support = data(await f.c.capabilitiesV2({ topic: 'support', limit: 1 })); support.clinical_sections.push('synthetic-injection');
    assert.equal(data(await f.c.capabilitiesV2({ topic: 'search_parameter', resource_type: 'Observation' })).definitions.source_sha256, hash);
    assert.deepEqual(data(await f.c.capabilitiesV2({ topic: 'support', limit: 1 })).clinical_sections, []);
    const schema = data(await f.c.capabilitiesV2({ topic: 'schema', resource_type: 'Observation' }));
    const expected = structuredClone(schema); schema.schema.source_sha256 = 'f'.repeat(64); schema.elements[0].types.push('SyntheticPoison');
    assert.deepEqual(data(await f.c.capabilitiesV2({ topic: 'schema', resource_type: 'Observation' })), expected);
  } finally { await f.close(); }
});
test('S55fix R07 real clinical and discovery controls plus exact reserved cursor length', async () => {
  const f = await fixture({ clinicalPages: true });
  try {
    const lengths: number[] = [], bytes = f.c.bytesV2.bind(f.c);
    f.c.bytesV2 = (e,d) => { if (data(e).next_cursor) lengths.push(data(e).next_cursor.length); bytes(e,d); };
    const cursor = await positive(f.c);
    assert.ok(lengths.length >= 2); assert.ok(lengths.every(n => n === cursor.length));
    const control = await f.c.capabilitiesV2({ topic: 'support', cursor, limit: 1 });
    assert.equal(control.error, undefined); assert.equal(data(control).rows.length, 1);
    const search = await f.g.execute('fhir_search', { resource_type: 'Observation', page_size: 1 });
    assert.equal(search.error, undefined); assert.match(search.pagination!.next_cursor!, /^cur_/); assert.equal(f.work.clinical, 1);
    const page = await f.g.execute('fhir_page', { cursor: search.pagination!.next_cursor });
    assert.equal(page.error, undefined); assert.equal(f.work.clinical, 2); assert.equal((page.data as Any).resources.length, 1);
    const wrong = await f.g.execute('fhir_capabilities', { topic: 'support', cursor: search.pagination!.next_cursor });
    assert.equal(wrong.error?.code, 'DISCOVERY_EXPIRED'); assert.equal(f.work.clinical, 2);
  } finally { await f.close(); }
});
