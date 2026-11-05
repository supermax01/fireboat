import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { FhirGateway, type GatewayEnvelope } from '../packages/core/src/index.js';
import { createMcpServer } from '../packages/server/src/index.js';

// Seeds: verifier's g4-fullurl.ts and g4-total.ts. All fixture records are synthetic.
const patient = 'synthetic-g4';
const foreignCanary = 'SYNTHETIC-FOREIGN-ORIGIN-CANARY';
const safeCanary = 'SYNTHETIC-LOCAL-CONTROL';
const obs = (id: unknown, valueString = safeCanary) => ({ resourceType: 'Observation', id, status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, subject: { reference: `Patient/${patient}` }, valueString });
type Entry = { fullUrl?: unknown; resource?: object };
const output = { format: 'fhir' as const, max_bytes: 60000 };
const resources = (result: GatewayEnvelope) => result.data.resources as { id?: string; valueString?: string }[];
const metadata = { resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [{ type: 'Observation', interaction: [{ code: 'search-type' }, { code: 'read' }], searchParam: [{ name: 'patient', type: 'reference' }, { name: 'code', type: 'token' }] }] }] };
async function fixture(t: TestContext, entries: (base: string, page: number) => Entry[], paged = false) {
  let base = ''; let clinical = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/fhir+json'); const url = new URL(req.url!, base);
    if (url.pathname.endsWith('/metadata')) { res.end(JSON.stringify(metadata)); return; }
    clinical++;
    if (url.pathname.endsWith('/Observation/direct')) { res.end(JSON.stringify(obs('bad/id', foreignCanary))); return; }
    const page = Number(url.searchParams.get('_offset') ?? '0');
    const next = new URL(url); next.searchParams.set('_offset', '1');
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', total: 98765, link: [{ relation: 'self', url: url.href }, ...(paged && page === 0 ? [{ relation: 'next', url: next.href }] : [])], entry: entries(base, page) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}/fhir/`;
  const gw = new FhirGateway({ mode: 'synthetic', source: { alias: 'g4-fixture', baseUrl: base }, patientId: patient });
  t.after(async () => { gw.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { gw, calls: () => clinical, search: () => gw.execute('fhir_search', { resource_type: 'Observation', output }), base };
}
const retained = async (gw: FhirGateway, result: GatewayEnvelope) => {
  assert.ok(result.result, 'safe control retained');
  const inspect = await gw.execute('fhir_result', { handle: result.result.handle, action: 'inspect' });
  const project = await gw.execute('fhir_result', { handle: result.result.handle, action: 'project', output });
  assert.equal(inspect.error, undefined); assert.equal(project.error, undefined);
  assert.ok(!JSON.stringify(project).includes(foreignCanary)); return inspect.data.resource_count;
};

for (const variant of ['foreign-base', 'same-origin-other-base', 'wrong-resource-path', 'urn:uuid', 'urn:oid', 'query-suffix', 'null'] as const) test(`G4 ${variant} fullUrl suppressed before delivery retention totals and provenance`, async t => {
  const f = await fixture(t, base => {
    const foreign = variant === 'foreign-base' ? 'https://other.example/fhir/Observation/twin'
      : variant === 'same-origin-other-base' ? `${new URL(base).origin}/other/Observation/twin`
        : variant === 'wrong-resource-path' ? `${base}Observation/different`
          : variant === 'urn:uuid' ? 'urn:uuid:7d3e1a2c-0000-4000-8000-000000007731' : variant === 'urn:oid' ? 'urn:oid:2.16.840.1.113883.19.5.99' : variant === 'query-suffix' ? `${base}Observation/twin?x=y` : null;
    return [{ fullUrl: foreign, resource: obs('twin', foreignCanary) }, { fullUrl: `${base}Observation/local`, resource: obs('local') }];
  });
  const result = await f.search(); assert.equal(result.error, undefined);
  assert.deepEqual(resources(result).map(r => r.id), ['local']);
  assert.ok(!JSON.stringify(result).includes(foreignCanary));
  assert.equal(result.pagination?.returned_matches, 1); assert.equal(result.pagination?.total?.value, undefined);
  assert.equal(result.provenance?.length, 1); assert.equal(result.provenance?.[0]?.resource_index, 0);
  assert.ok(result.coverage.reasons.includes('ENTRY_ORIGIN_MISMATCH')); assert.equal(result.coverage.state, 'partial');
  assert.ok(result.coverage.reasons.includes('ENTRY_ORIGIN_MISMATCH'));
  assert.equal(await retained(f.gw, result), 1);
  assert.ok(f.gw.auditEvents.some(event => event.cause === 'ENTRY_ORIGIN_MISMATCH'));
  assert.ok(!JSON.stringify(f.gw.auditEvents).includes(foreignCanary));
  assert.equal(f.calls(), 1, 'entry URLs are never resolved remotely');
});

test('G4 strict foreign/local near-twin and absent fullUrl control keep independent authorization', async t => {
  const f = await fixture(t, base => [
    { fullUrl: 'https://other.example/fhir/Observation/twin', resource: obs('twin') },
    { fullUrl: `${base}Observation/twin`, resource: obs('twin') },
    { resource: obs('absent') },
    { fullUrl: `${base}Observation/foreign-subject`, resource: { ...obs('foreign-subject', foreignCanary), subject: { reference: 'Patient/foreign' } } },
  ]);
  const result = await f.search(); assert.equal(result.error, undefined);
  assert.deepEqual(resources(result).map(r => r.id), ['twin', 'absent']);
  assert.equal(await retained(f.gw, result), 2); assert.equal(result.pagination?.total?.value, undefined);
  assert.equal(result.coverage.state, 'partial');
});

test('G4 entirely suppressed page has no retention provenance or executed-constraint claim', async t => {
  const f = await fixture(t, () => [{ fullUrl: 'https://other.example/fhir/Observation/twin', resource: obs('twin', foreignCanary) }]);
  const result = await f.search(); assert.equal(result.error, undefined);
  assert.deepEqual(resources(result), []); assert.equal(result.result, undefined);
  assert.equal(result.pagination?.total?.value, undefined); assert.equal(result.pagination?.returned_matches, 0);
  assert.deepEqual(result.provenance, []); assert.deepEqual(result.coverage.constraints?.filter(c => c.execution !== "unknown").map(({ name, value }) => ({ name, value })), [{ name: 'patient', value: `Patient/${patient}` }]);
  assert.ok(result.coverage.reasons.includes('ENTRY_ORIGIN_MISMATCH'));
});

test('G4 continuation suppression is checked on every upstream page and retained views', async t => {
  const f = await fixture(t, (base, page) => page ? [
    { fullUrl: 'https://other.example/fhir/Observation/twin', resource: obs('twin', foreignCanary) },
    { fullUrl: `${base}Observation/second`, resource: obs('second') },
  ] : [{ fullUrl: `${base}Observation/first`, resource: obs('first') }], true);
  const first = await f.search(); assert.equal(first.error, undefined);
  const second = await f.gw.execute('fhir_page', { cursor: first.pagination!.next_cursor!, output });
  assert.equal(second.error, undefined); assert.deepEqual(resources(second).map(r => r.id), ['second']);
  assert.equal(second.pagination?.returned_matches, 1); assert.equal(second.pagination?.total?.value, undefined);
  assert.equal(await retained(f.gw, second), 1); assert.equal(f.calls(), 2);
  assert.ok(second.coverage.reasons.includes('ENTRY_ORIGIN_MISMATCH'));
});

test('G4 uses transport scheme/default-port/trailing-base normalization without new URL rules', async () => {
  // No port-80 listener needed: the existing transport is exercised with a bounded recording stub.
  const gw = new FhirGateway({ mode: 'synthetic', source: { alias: 'normalization', baseUrl: 'HTTP://127.0.0.1:80/fhir///' }, patientId: patient });
  const transport = (gw as unknown as { transport: { get(url: URL): Promise<object> } }).transport;
  transport.get = async url => url.pathname.endsWith('/metadata') ? metadata : { resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }], entry: [
    { fullUrl: 'HTTP://127.0.0.1:80/fhir/Observation/local', resource: obs('local') },
    { fullUrl: 'http://127.0.0.1/fhir/Observation/other', resource: obs('other') },
    { fullUrl: 'http://127.0.0.1:80/foreign/Observation/bad', resource: obs('bad', foreignCanary) },
  ] };
  try {
    const result = await gw.execute('fhir_search', { resource_type: 'Observation', output });
    assert.equal(result.error, undefined); assert.deepEqual(resources(result).map(r => r.id), ['local', 'other']);
    assert.ok(result.coverage.reasons.includes('ENTRY_ORIGIN_MISMATCH'));
  } finally { gw.close(); }
});

for (const era of ['modern', 'legacy'] as const) test(`G4 actual SDK ${era} excludes foreign entries in search page and retained project`, async t => {
  const f = await fixture(t, (base, page) => [
    { fullUrl: `https://other.example/fhir/Observation/foreign-${page}`, resource: obs(`foreign-${page}`, foreignCanary) },
    { fullUrl: `${base}Observation/local-${page}`, resource: obs(`local-${page}`) },
  ], true);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(({ era: negotiatedEra }) => createMcpServer(f.gw, { era: negotiatedEra }), { transport: serverTransport });
  const client = new Client({ name: 'g4-synthetic-verifier', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } as never : undefined);
  await client.connect(clientTransport);
  try {
    const search = await client.callTool({ name: 'fhir_search', arguments: { resource_type: 'Observation', output } });
    const first = search.structuredContent as unknown as GatewayEnvelope;
    assert.equal(first.error, undefined); assert.ok(!JSON.stringify(search).includes(foreignCanary));
    assert.equal(first.pagination?.returned_matches, 1); assert.ok(first.coverage.reasons.includes('ENTRY_ORIGIN_MISMATCH'));
    const page = await client.callTool({ name: 'fhir_page', arguments: { cursor: first.pagination!.next_cursor!, output } });
    const second = page.structuredContent as unknown as GatewayEnvelope;
    assert.equal(second.error, undefined); assert.ok(!JSON.stringify(page).includes(foreignCanary));
    const result = await client.callTool({ name: 'fhir_result', arguments: { action: 'project', handle: second.result!.handle, output } });
    assert.ok(!JSON.stringify(result).includes(foreignCanary));
    assert.equal((result.structuredContent as unknown as GatewayEnvelope).pagination?.returned_matches, 1);
  } finally { await client.close(); await server.close(); }
});

for (const malformed of ['', 'bad/id', 'bad id', 'bad_id', 'x'.repeat(65), null, 7]) test(`P-15 malformed search id ${typeof malformed === 'string' ? malformed.length : typeof malformed} is a per-record refusal`, async t => {
  const f = await fixture(t, () => [{ resource: obs(malformed, foreignCanary) }, { resource: obs('valid-1.2') }, { resource: { ...obs('unused'), id: undefined } }]);
  const result = await f.search(); assert.equal(result.error, undefined, 'other safe records survive');
  assert.equal(resources(result).length, 2); assert.ok(!JSON.stringify(result).includes(foreignCanary));
  assert.ok(result.coverage.reasons.includes('INVALID_RESOURCE_ID')); assert.equal(result.coverage.state, 'partial');
  // Each malformed-id variant withholds an authorized match, so a delivered count is not a query total.
  assert.equal(result.pagination?.total?.value, undefined); assert.equal(await retained(f.gw, result), 2);
  assert.equal(result.provenance?.length, 2); assert.ok(!Object.hasOwn(result.provenance![1]!, 'id'), 'missing id is never invented');
  assert.ok(f.gw.auditEvents.some(event => event.cause === 'INVALID_RESOURCE_ID'));
});

test('P-15 malformed direct response stays uniform NOT_FOUND while search filters only the malformed record', async t => {
  const f = await fixture(t, () => [{ resource: obs('bad/id', foreignCanary) }, { resource: obs('safe') }]);
  const direct = await f.gw.execute('fhir_read', { resource_type: 'Observation', id: 'direct', output });
  assert.equal(direct.error?.code, 'NOT_FOUND'); assert.deepEqual(direct.data, {}); assert.equal(direct.result, undefined);
  const search = await f.search(); assert.equal(search.error, undefined); assert.deepEqual(resources(search).map(r => r.id), ['safe']);
  assert.ok(search.coverage.reasons.includes('INVALID_RESOURCE_ID'));
});


test('G4 present fullUrl without a resource is a labelled suppression with partial private coverage', async t => {
  const f = await fixture(t, base => [{ fullUrl: `${base}Observation/missing` }, { resource: obs('local') }]);
  const result = await f.search(); assert.equal(result.error, undefined);
  assert.deepEqual(resources(result).map(r => r.id), ['local']);
  assert.ok(result.coverage.reasons.includes('ENTRY_ORIGIN_MISMATCH')); assert.equal(result.coverage.state, 'partial');
  const state = (f.gw as unknown as { store: { get(key: string): { value: { queryOverlay: { refused?: boolean; refusalReasons?: string[] } } } } }).store.get(result.result!.handle).value;
  assert.equal(state.queryOverlay.refused, true);
  assert.ok(state.queryOverlay.refusalReasons?.includes('ENTRY_ORIGIN_MISMATCH'));
});

for (const fullUrl of ['urn:uuid:synthetic-outcome', 'https://other.example/fhir/OperationOutcome/synthetic']) {
  for (const incomplete of [false, true]) test(`S4-F1 ${incomplete ? 'incomplete' : 'error'} OO classified before origin: ${fullUrl}`, async t => {
    const f = await fixture(t, () => [{ resource: obs('safe') }, { fullUrl, resource: { resourceType: 'OperationOutcome', issue: [{ severity: incomplete ? 'warning' : 'error', code: incomplete ? 'incomplete' : 'exception' }] } }]);
    const result = await f.search();
    if (!incomplete) {
      assert.equal(result.error?.code, 'UNVERIFIED_QUERY'); assert.equal(result.result, undefined);
      assert.equal((f.gw as unknown as { store: { size: number } }).store.size, 0);
    } else {
      assert.equal(result.error, undefined); assert.deepEqual(resources(result).map(r => r.id), ['safe']);
      assert.ok(result.coverage.reasons.includes('SOURCE_REPORTED_INCOMPLETE'));
      assert.equal(result.pagination?.total?.value, undefined); assert.equal(result.pagination?.has_more, null);
      assert.ok(!result.coverage.reasons.includes('ENTRY_ORIGIN_MISMATCH'));
    }
  });
}

for (const reason of ['ENTRY_ORIGIN_MISMATCH', 'INVALID_RESOURCE_ID'] as const) test(`S4-F9 ${reason} stays partial across a clean continuation and retained views`, async t => {
  const f = await fixture(t, (base, page) => page ? [{ resource: obs('clean') }] : [
    { resource: obs('safe') }, reason === 'INVALID_RESOURCE_ID' ? { resource: obs('bad_id') } : { fullUrl: 'urn:uuid:synthetic-foreign', resource: obs('foreign') },
  ], true);
  const first = await f.search(); assert.equal(first.error, undefined); assert.ok(first.coverage.reasons.includes(reason));
  const second = await f.gw.execute('fhir_page', { cursor: first.pagination!.next_cursor!, output });
  assert.equal(second.error, undefined); assert.deepEqual(resources(second).map(r => r.id), ['clean']);
  assert.equal(second.coverage.state, 'partial'); assert.ok(second.coverage.reasons.includes(reason));
  for (const action of ['inspect', 'project']) {
    const retained = await f.gw.execute('fhir_result', { handle: second.result!.handle, action, output });
    assert.equal(retained.error, undefined); assert.ok(retained.coverage.reasons.includes(reason));
  }
});

for (const versionId of ['a/b', 'x'.repeat(65), '', 7, null, { synthetic: true }]) test(`S4-F5 invalid version ${JSON.stringify(versionId)} omitted before retention`, async t => {
  const f = await fixture(t, () => [{ resource: { ...obs('safe'), meta: { versionId, lastUpdated: '2025-01-01T00:00:00Z' } } }]);
  const result = await f.search(); assert.equal(result.error, undefined);
  const project = await f.gw.execute('fhir_result', { handle: result.result!.handle, action: 'project', output });
  for (const view of [result, project]) {
    assert.equal(view.error, undefined); assert.deepEqual(resources(view).map(r => r.id), ['safe']);
    assert.ok(!Object.hasOwn(view.provenance![0]!, 'version'));
    assert.ok(!Object.hasOwn((view.data.resources as { meta: object }[])[0]!.meta, 'versionId'));
    assert.ok(view.transform.omitted_fields.includes('/meta/versionId'));
    assert.equal(((resources(view)[0] as Record<string, unknown>)?.meta as Record<string, unknown>)?.versionId, undefined);
    assert.ok((view.transform.omitted_fields as string[]).includes('/meta/versionId'));
  }
  const stored = (f.gw as unknown as { store: { get(key: string): { value: { records: { resource: { meta: object } }[] } } } }).store.get(result.result!.handle).value;
  assert.ok(!Object.hasOwn(stored.records[0]!.resource.meta, 'versionId'));
  // Direct reads must share validation, rather than allowing a numeric version to poison the page.
  const transport = (f.gw as unknown as { transport: { get(url: URL): Promise<object> } }).transport;
  transport.get = async () => ({ ...obs('direct'), meta: { versionId } });
  const direct = await f.gw.execute('fhir_read', { resource_type: 'Observation', id: 'direct', output });
  assert.equal(direct.error, undefined); assert.ok(!Object.hasOwn(direct.provenance![0]!, 'version'));
  assert.ok(direct.transform.omitted_fields.includes('/meta/versionId')); assert.equal(((direct.data.resources as Record<string, unknown>[])[0]!.meta as Record<string, unknown>).versionId, undefined);
});
