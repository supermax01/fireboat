import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { FhirGateway, toMcpToolResult, type GatewayConfig, type GatewayEnvelope } from '../packages/core/src/index.js';
import { authorized, sanitize } from '../packages/core/src/privacy.js';
import { ResultStore } from '../packages/core/src/store.js';
import { FhirTransport } from '../packages/core/src/transport.js';
import type { FhirResource } from '../packages/core/src/contracts.js';
import { schemaPage } from '../packages/core/src/schema.js';

const a = 'synthetic-patient-a';
const b = 'synthetic-patient-b';
/** Every numeric value in a JSON-shaped value. Exact-value leak checks use this instead of
 *  digit substrings, which collide with UUIDs, elapsed_ms and byte counts in the envelope. */
function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number') out.push(value);
  else if (Array.isArray(value)) for (const item of value) numbersIn(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) numbersIn(item, out);
  return out;
}
const observation = (id: string, patient = a, extra: Record<string, unknown> = {}) => ({ resourceType: 'Observation', id, meta: { versionId: '1' }, status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, subject: { reference: `Patient/${patient}` }, effectiveDateTime: '2026-01-02T10:00:00Z', valueQuantity: { value: 7.1, unit: '%', system: 'http://unitsofmeasure.org', code: '%' }, ...extra });
// Optional knobs for guard tests: `metadata` is merged over the default CapabilityStatement, `contentType` applies to
// every non-metadata response, `bundleType` replaces `searchset`, `includes` are appended as `search.mode=include`
// entries, and `self` rewrites the self link.
type Options = { records?: Record<string, unknown>[]; next?: string; selfOmit?: string; rawRead?: string; read?: Record<string, unknown>; total?: number; metadata?: Record<string, unknown>; contentType?: string; bundleType?: string; includes?: Record<string, unknown>[]; self?: (url: URL) => string };
const capabilityResources = (searchParams: string[], types = ['Patient', 'Observation', 'Medication', 'DocumentReference', 'Group']) => [{ mode: 'server', resource: types.map(type => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: searchParams.map(name => ({ name })) })) }];
async function fixture(options: Options = {}) {
  const requests: URL[] = [];
  let baseUrl = '';
  const metadata = { resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: capabilityResources(['patient', 'subject', 'code', 'date', 'name']), ...options.metadata };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, baseUrl);
    requests.push(url);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname.endsWith('/metadata')) { res.end(JSON.stringify(metadata)); return; }
    if (options.contentType) res.setHeader('content-type', options.contentType);
    if (url.pathname.endsWith('/Observation') || url.pathname.endsWith('/DocumentReference') || (url.pathname === '/fhir' && url.searchParams.has('_getpages'))) {
      const self = new URL(url);
      if (options.selfOmit) self.searchParams.delete(options.selfOmit);
      res.end(JSON.stringify({ resourceType: 'Bundle', type: options.bundleType ?? 'searchset', total: options.total ?? (options.records?.length ?? 2), link: [{ relation: 'self', url: options.self ? options.self(self) : self.href }, ...(options.next ? [{ relation: 'next', url: options.next }] : [])], entry: [...(options.records ?? [observation('obs-a'), observation('obs-a2')]).map(resource => ({ resource, search: { mode: 'match' } })), ...(options.includes ?? []).map(resource => ({ resource, search: { mode: 'include' } }))] })); return;
    }
    if (url.pathname.endsWith('/missing')) { res.statusCode = 404; res.end('{}'); return; }
    if (options.rawRead) { res.end(options.rawRead); return; }
    const type = url.pathname.split('/').at(-2)!;
    const id = url.pathname.split('/').at(-1)!;
    res.end(JSON.stringify(options.read ?? (type === 'Patient' ? { resourceType: 'Patient', id } : observation(id, id === 'obs-b' ? b : a))));
  };
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/fhir/`;
  return { baseUrl, requests, gateway: (limits?: GatewayConfig['limits']) => new FhirGateway({ mode: 'synthetic', source: { alias: 'fixture', baseUrl }, patientId: a, limits }), close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
const resources = (result: GatewayEnvelope) => result.data.resources as Record<string, unknown>[];

test('exact-ID read preserves critical facts and provenance', async t => {
  const f = await fixture(); t.after(f.close);
  const result = await f.gateway().execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' });
  assert.equal(result.error, undefined);
  assert.deepEqual(resources(result)[0]?.valueQuantity, observation('obs-a').valueQuantity);
  assert.equal(result.provenance?.[0]?.resource_index, 0);
  assert.equal((resources(result)[0]?.meta as { versionId?: string })?.versionId, '1');
  assert.ok(Buffer.byteLength(JSON.stringify(toMcpToolResult(result))) < result.budget.byte_limit);
});

test('search preserves repeated filters and injects the trusted patient restriction', async t => {
  const f = await fixture(); t.after(f.close);
  const result = await f.gateway().execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'date', value: 'ge2026-01-01' }, { name: 'date', value: 'lt2027-01-01' }, { name: 'code', value: 'http://loinc.org|4548-4' }] });
  assert.equal(result.error, undefined);
  const request = f.requests.at(-1)!;
  assert.deepEqual(request.searchParams.getAll('date'), ['ge2026-01-01', 'lt2027-01-01']);
  assert.equal(request.searchParams.get('patient'), `Patient/${a}`);
  assert.equal(request.searchParams.get('code'), 'http://loinc.org|4548-4');
  assert.equal(result.coverage.sort, undefined);
});

test('conflicting context and patient selectors cannot widen the workload', async t => {
  const f = await fixture(); t.after(f.close);
  const gateway = f.gateway();
  assert.equal((await gateway.execute('fhir_search', { resource_type: 'Observation', context_handle: 'forged' })).error?.code, 'CONTEXT_REQUIRED');
  assert.equal(f.requests.length, 0);
  assert.equal((await gateway.execute('fhir_search', { resource_type: 'Observation', context_handle: '' })).error?.code, 'INVALID_ARGUMENTS');
  assert.equal((await gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'patient', value: b }] })).error?.code, 'POLICY_DENIED');
  assert.equal((await gateway.execute('fhir_read', { resource_type: 'Patient', id: b })).error?.code, 'NOT_FOUND');
});

test('wrong-patient resource reads are indistinguishable from missing reads', async t => {
  const f = await fixture(); t.after(f.close);
  const gateway = f.gateway();
  const denied = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-b' });
  const missing = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'missing' });
  assert.deepEqual(denied.error, missing.error);
  assert.deepEqual(denied.data, {});
  assert.ok(!JSON.stringify(gateway.auditEvents).includes(b));
});

test('suppressed entries never leak their content or upstream totals', async t => {
  const f = await fixture({ total: 777, records: [observation('obs-a'), observation('obs-b', b, { note: [{ text: 'BETA_SECRET' }] })] }); t.after(f.close);
  const result = await f.gateway().execute('fhir_search', { resource_type: 'Observation', output: { format: 'fhir' } });
  assert.equal(result.error, undefined);
  assert.equal(resources(result).length, 1);
  assert.equal(result.pagination?.returned_matches, 1);
  // V-3: the upstream total is never read; the published total is the gateway-delivered count, whose presence
  // and value do not depend on suppression (still never the upstream 777).
  assert.equal(result.pagination?.total?.value, 1);
  assert.ok(!numbersIn(result).includes(777), 'the upstream total must not appear as any numeric value');
  assert.ok(!JSON.stringify(result).includes('BETA_SECRET'));
});

test('foreign continuations and redirects do not get fetched', async t => {
  const f = await fixture({ next: 'http://169.254.169.254/latest/meta-data/' }); t.after(f.close);
  // J-23: page 1 was validated and sanitized, so it is delivered as non-continuable partial evidence; the
  // foreign link itself is never fetched and the outcome is never presented as exhaustion.
  const result = await f.gateway().execute('fhir_search', { resource_type: 'Observation' });
  assert.equal(result.error, undefined);
  assert.equal(resources(result).length, 2);
  assert.equal(result.pagination?.has_more, null);
  assert.equal(result.pagination?.next_cursor, undefined);
  assert.equal(result.coverage.state, 'partial');
  assert.ok(result.coverage.reasons.includes('NON_CONTINUABLE_UPSTREAM_LINK'));
  assert.equal(f.requests.length, 2);
});

test('missing effective patient filter fails instead of returning a broadened search', async t => {
  const f = await fixture({ selfOmit: 'patient' }); t.after(f.close);
  const result = await f.gateway().execute('fhir_search', { resource_type: 'Observation' });
  assert.equal(result.error?.code, 'UNVERIFIED_QUERY');
  assert.deepEqual(result.data, {});
});

test('oversized upstream page drains completely with stable replay and no skipped records', async t => {
  const records = Array.from({ length: 14 }, (_, i) => observation(`obs-${i}`, a, { code: { text: 'x'.repeat(4200) } }));
  const f = await fixture({ records }); t.after(f.close);
  const gateway = f.gateway();
  let result = await gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 100 });
  const ids: unknown[] = [];
  let pages = 0;
  while (true) {
    assert.equal(result.error, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify({ ...toMcpToolResult(result), resultType: 'complete' })) <= result.budget.byte_limit);
    ids.push(...resources(result).map(r => r.id)); pages++;
    const cursor = result.pagination?.next_cursor;
    if (!cursor) break;
    const next = await gateway.execute('fhir_page', { cursor });
    const replay = await gateway.execute('fhir_page', { cursor });
    assert.deepEqual(resources(next), resources(replay));
    result = next;
    assert.ok(pages < 20);
  }
  assert.ok(pages > 1);
  assert.deepEqual(ids, records.map(r => r.id));
  assert.equal(f.requests.length, 2);
});

test('payload bytes and attachment capability links remain withheld in raw and retained projections', async t => {
  const secret = 'U0VDUkVUX0RPQ1VNRU5UX0JZVEVT';
  const doc = { resourceType: 'DocumentReference', id: 'doc-a', status: 'current', subject: { reference: `Patient/${a}` }, content: [{ attachment: { contentType: 'application/pdf', data: secret, url: 'https://files.invalid/doc?token=secret', size: 21 } }], extension: [{ url: 'http://example.org/attachment', valueAttachment: { contentType: 'text/plain', data: secret } }] };
  const f = await fixture({ read: doc }); t.after(f.close);
  const gateway = f.gateway();
  const result = await gateway.execute('fhir_read', { resource_type: 'DocumentReference', id: 'doc-a', output: { format: 'fhir' } });
  assert.equal(result.error, undefined);
  assert.ok(result.transform.withheld_payloads.length >= 3);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes('token=secret'));
  const projected = await gateway.execute('fhir_result', { handle: result.result!.handle, action: 'project', fields: ['content', 'extension'], output: { format: 'fhir' } });
  assert.equal(projected.error, undefined);
  assert.ok(!JSON.stringify(projected).includes(secret));
});

test('single oversized resource returns a usable retained manifest', async t => {
  const f = await fixture({ read: observation('obs-big', a, { note: [{ text: 'x'.repeat(50000) }] }) }); t.after(f.close);
  const gateway = f.gateway();
  const result = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-big', output: { format: 'fhir' } });
  assert.equal(result.error, undefined);
  assert.equal(resources(result).length, 0);
  assert.ok(result.result?.handle);
  const small = await gateway.execute('fhir_result', { handle: result.result!.handle, action: 'project', fields: ['valueQuantity', 'effectiveDateTime'] });
  assert.equal(small.error, undefined);
  assert.equal(resources(small)[0]?.id, 'obs-big');
});

test('nested cross-patient resources cannot escape through a contained record', async t => {
  const f = await fixture({ read: observation('obs-a', a, { contained: [{ resourceType: 'Patient', id: b }] }) }); t.after(f.close);
  const result = await f.gateway().execute('fhir_read', { resource_type: 'Observation', id: 'obs-a', output: { format: 'fhir' } });
  assert.equal(result.error?.code, 'NOT_FOUND');
});

test('withholding an implicit-rules URI cannot erase the need for a structural view', async t => {
  const f = await fixture({ read: observation('obs-modifier', a, { implicitRules: 'rules/local?key=MODIFIER_SECRET', versionSpecificClinicalContext: { meaning: 'must remain visible' } }) }); t.after(f.close);
  const result = await f.gateway().execute('fhir_read', { resource_type: 'Observation', id: 'obs-modifier' });
  assert.equal(result.error, undefined);
  assert.ok(result.warnings.some(warning => warning.code === 'UNINTERPRETED_MODIFIER'));
  assert.deepEqual(resources(result)[0]?.versionSpecificClinicalContext, { meaning: 'must remain visible' });
  assert.ok(!JSON.stringify(result).includes('MODIFIER_SECRET'));
});

test('ambiguous classes, unsupported interactions, and unknown parameters are explicit errors', async t => {
  const f = await fixture(); t.after(f.close);
  const gateway = f.gateway();
  assert.equal((await gateway.execute('fhir_read', { resource_type: 'Group', id: 'group-a' })).error?.code, 'POLICY_DENIED');
  assert.equal((await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-a', interaction: 'history' })).error?.code, 'INVALID_ARGUMENTS');
  assert.equal((await gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: '_include', value: '*' }] })).error?.code, 'UNSUPPORTED_SEARCH');
});

test('upstream and retention limits fail without publishing an unusable cursor', async t => {
  const f = await fixture({ read: observation('obs-a', a, { note: [{ text: 'x'.repeat(20000) }] }) }); t.after(f.close);
  // J-15: an oversized direct-read body cannot establish linkage, so it is publicly indistinguishable from
  // absence; the precise UPSTREAM_LIMIT cause survives only in the metadata-only audit.
  const limitedGateway = f.gateway({ upstreamBytes: 10000 });
  assert.equal((await limitedGateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' })).error?.code, 'NOT_FOUND');
  assert.equal(limitedGateway.auditEvents.at(-1)?.cause, 'UPSTREAM_LIMIT:200');
  const result = await f.gateway({ retentionBytes: 256 }).execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' });
  // J-7: res_ handles are best-effort — no handle is published and the outcome is explicit.
  assert.equal(result.result, undefined);
  assert.ok(result.warnings.some(warning => warning.code === 'RESULT_NOT_RETAINED'));
  assert.equal(result.pagination?.next_cursor, undefined);
});

test('expired handles and handles from a different gateway return no retained data', async t => {
  const f = await fixture(); t.after(f.close);
  const clock = Date.now();
  const mocked = t.mock.method(Date, 'now', () => clock);
  const gateway = f.gateway({ ttlMs: 100 });
  const result = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' });
  assert.equal(result.error, undefined);
  assert.equal((await f.gateway().execute('fhir_result', { handle: result.result!.handle })).error?.code, 'RESULT_EXPIRED');
  mocked.mock.mockImplementation(() => clock + 101);
  assert.equal((await gateway.execute('fhir_result', { handle: result.result!.handle })).error?.code, 'RESULT_EXPIRED');
});

test('source numeric lexemes are preserved losslessly instead of rejected or rounded (J-6)', async t => {
  const f = await fixture({ rawRead: `{"resourceType":"Observation","id":"obs-a","subject":{"reference":"Patient/${a}"},"valueQuantity":{"value":9007199254740993}}` }); t.after(f.close);
  const gateway = f.gateway();
  const result = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' });
  assert.equal(result.error, undefined);
  const wire = gateway.toToolResult(result);
  assert.ok(wire.content[0]!.text.includes('"value":9007199254740993'), wire.content[0]!.text);
  assert.ok(JSON.stringify(wire.structuredContent).includes('"value":9007199254740993'));
  assert.ok(!wire.content[0]!.text.includes('9007199254740992'), 'the rounded JS value must never be emitted');
});

test('production sources and traversal IDs are refused', async t => {
  assert.throws(() => new FhirGateway({ mode: 'synthetic', source: { alias: 'unsafe', baseUrl: 'https://production.example/fhir' }, patientId: a }), /literal loopback/);
  const f = await fixture(); t.after(f.close);
  assert.equal((await f.gateway().execute('fhir_read', { resource_type: 'Observation', id: '..' })).error?.code, 'NOT_FOUND');
});

test('page continuation cannot extend original retention expiry', async t => {
  const f = await fixture({ records: Array.from({ length: 12 }, (_, i) => observation(`obs-${i}`, a, { code: { text: 'x'.repeat(4200) } })) }); t.after(f.close);
  const clock = Date.now();
  const mocked = t.mock.method(Date, 'now', () => clock);
  const gateway = f.gateway({ ttlMs: 100 });
  const first = await gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 100 });
  assert.equal(first.error, undefined);
  mocked.mock.mockImplementation(() => clock + 50);
  const second = await gateway.execute('fhir_page', { cursor: first.pagination!.next_cursor! });
  assert.equal(second.error, undefined);
  assert.ok(second.pagination?.next_cursor);
  mocked.mock.mockImplementation(() => clock + 101);
  assert.equal((await gateway.execute('fhir_page', { cursor: second.pagination.next_cursor })).error?.code, 'RESULT_EXPIRED');
});

test('retained projections preserve source retrieval time', async t => {
  const f = await fixture(); t.after(f.close);
  const gateway = f.gateway();
  const first = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' });
  const second = await gateway.execute('fhir_result', { handle: first.result!.handle, action: 'project', fields: ['id'] });
  assert.equal(second.error, undefined);
  assert.equal(second.provenance?.[0]?.retrieved_at, first.provenance?.[0]?.retrieved_at);
});

test('FHIR payload aliases and signed URI aliases are withheld in every format and retained projection', async t => {
  const secret = 'SYNTHETIC_PAYLOAD_SECRET';
  const signed = 'https://files.invalid/record?%61ccess_token=SYNTHETIC_LINK_SECRET';
  const records: FhirResource[] = [
    { resourceType: 'Patient', id: a, photo: [{ data: secret }] },
    observation('obs-sampled', a, { valueSampledData: { origin: { value: 0 }, period: 100, dimensions: 1, data: secret } }),
    observation('obs-links', a, { valueUrl: signed, extension: [{ url: 'http://example.org/uri', valueUri: signed }, { url: 'http://example.org/credential', valueCanonical: 'https://user:SYNTHETIC_LINK_SECRET@files.invalid/record' }] }),
  ];
  for (const record of records) {
    const f = await fixture({ read: record }); t.after(f.close);
    const gateway = f.gateway();
    for (const format of ['compact', 'fhir'] as const) {
      const read = await gateway.execute('fhir_read', { resource_type: record.resourceType, id: record.id, output: { format } });
      assert.equal(read.error, undefined);
      assert.ok(read.transform.withheld_payloads.length > 0);
      const projected = await gateway.execute('fhir_result', { handle: read.result!.handle, action: 'project', fields: ['photo', 'valueSampledData', 'valueUrl', 'extension'], output: { format } });
      assert.equal(projected.error, undefined);
      for (const result of [read, projected]) {
        assert.ok(!JSON.stringify(result).includes(secret));
        assert.ok(!JSON.stringify(result).includes('SYNTHETIC_LINK_SECRET'));
      }
    }
  }
});

test('opaque query and fragment links are withheld regardless of credential spelling or URL form', async t => {
  const secret = 'SYNTHETIC_LINK_SECRET_R2';
  const urls = [
    ...['key', 'auth_token', 'password', 'secret', '%2561ccess_token', 'unexpected_credential_name'].map(key => `https://files.invalid/doc?${key}=${secret}`),
    `https://files.invalid/doc#access_token=${secret}`,
    `https://files.invalid/doc#${secret}`,
    `//files.invalid/doc?token=${secret}`,
    `docs/x?token=${secret}`,
    `docs/x#access_token=${secret}`,
    `?token=${secret}`,
    `#access_token=${secret}`,
    `https://[malformed/?token=${secret}`,
  ];
  const observationFixture = await fixture({ read: observation('obs-links-r2', a, { meta: { profile: ['http://example.org/safe-profile', `profiles/local?key=${secret}`, `https://example.org/profile?key=${secret}`] }, extension: urls.map((value, i) => ({ url: `http://example.org/link-${i}`, [i % 2 ? 'valueUri' : 'valueUrl']: value })) }) }); t.after(observationFixture.close);
  const photoFixture = await fixture({ read: { resourceType: 'Patient', id: a, photo: [{ url: `docs/photo?key=${secret}` }] } }); t.after(photoFixture.close);
  for (const [f, type, id] of [[observationFixture, 'Observation', 'obs-links-r2'], [photoFixture, 'Patient', a]] as const) {
    const gateway = f.gateway();
    for (const format of ['compact', 'fhir'] as const) {
      const read = await gateway.execute('fhir_read', { resource_type: type, id, output: { format } });
      assert.equal(read.error, undefined);
      assert.equal(read.transform.withheld_payloads.length, type === 'Patient' ? 1 : urls.length + 2);
      if (type === 'Observation') assert.deepEqual(resources(read)[0]?.meta, { profile: ['http://example.org/safe-profile', null, null] });
      const projected = await gateway.execute('fhir_result', { handle: read.result!.handle, action: 'project', fields: ['extension', 'photo', 'meta'], output: { format } });
      assert.equal(projected.error, undefined);
      assert.ok(!JSON.stringify([read, projected]).includes(secret));
    }
  }
});

test('query-free FHIR canonicals, relative references, and contained references remain usable', () => {
  const resource = observation('obs-link-controls', a, {
    extension: [{ url: 'http://example.org/canonical', valueCanonical: 'http://loinc.org/vs/LL123|1.0' }, { url: 'http://example.org/uuid', valueUri: 'urn:uuid:00000000-0000-0000-0000-000000000001' }],
    hasMember: [{ reference: '#local-observation' }],
  });
  const result = sanitize(resource);
  assert.deepEqual(result.resource, resource);
  assert.deepEqual(result.manifests, []);
});

test('a hundred small records include provenance and drain within the default output budget', async t => {
  const records = Array.from({ length: 100 }, (_, i) => observation(`obs-${i}`));
  const f = await fixture({ records }); t.after(f.close);
  const gateway = f.gateway();
  let result = await gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 100 });
  const ids: unknown[] = [];
  let pages = 0;
  while (true) {
    assert.equal(result.error, undefined);
    assert.equal(result.provenance?.length, resources(result).length);
    assert.ok(Buffer.byteLength(JSON.stringify({ ...toMcpToolResult(result), resultType: 'complete' })) <= result.budget.byte_limit);
    ids.push(...resources(result).map(record => record.id));
    pages++;
    if (!result.pagination?.next_cursor) break;
    assert.ok(pages < 20);
    result = await gateway.execute('fhir_page', { cursor: result.pagination.next_cursor });
  }
  assert.ok(pages > 1);
  assert.deepEqual(ids, records.map(record => record.id));
  assert.equal(f.requests.length, 2);
});

test('a failed cursor/result reservation leaves no orphan handle', async t => {
  const store = new ResultStore<{ id: string }>(4096, 1, 10000);
  assert.throws(() => store.putBatch([{ prefix: 'cur', value: { id: 'page' } }, { prefix: 'res', value: { id: 'result' } }]), /quota/);
  const saved = store.put('res', { id: 'after-failure' });
  assert.equal(store.get(saved.handle).value.id, 'after-failure');

  const f = await fixture({ records: Array.from({ length: 100 }, (_, i) => observation(`obs-${i}`)) }); t.after(f.close);
  const gateway = f.gateway({ maxHandles: 1 });
  const failed = await gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 100 });
  // J-7: the live cursor wins the single handle; the best-effort res_ handle is dropped explicitly.
  assert.equal(failed.error, undefined);
  assert.ok(failed.pagination?.next_cursor?.startsWith('cur_'));
  assert.equal(failed.result, undefined);
  assert.ok(failed.warnings.some(warning => warning.code === 'RESULT_NOT_RETAINED'));
  assert.equal((await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' })).error, undefined);
});

test('output rejection leaves quota available for a subsequent bounded read', async t => {
  const f = await fixture(); t.after(f.close);
  const gateway = f.gateway({ maxHandles: 1 });
  const result = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'x'.repeat(1800) }], output: { max_bytes: 4096 } });
  assert.equal(result.error?.code, 'OUTPUT_LIMIT');
  assert.equal((await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' })).error, undefined);
});

test('continuations cannot rewrite filters, introduce filters, or switch resource endpoints', async t => {
  const options: Options = {};
  const f = await fixture(options); t.after(f.close);
  const gateway = f.gateway();
  const search = () => gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }] });
  await gateway.execute('fhir_capabilities', { topic: 'server' }); // warm discovery so each search is exactly one upstream request
  // J-9/J-23: each non-conforming link is rejected before any fetch, and the validated first page is
  // delivered as non-continuable partial evidence instead of being discarded.
  for (const next of [
    new URL(`Observation?code=OTHER&patient=Patient/${a}&_count=20&_offset=1`, f.baseUrl).href,
    new URL('Observation?name=UNREQUESTED&_offset=1', f.baseUrl).href,
    new URL('Patient?_offset=1', f.baseUrl).href,
  ]) {
    options.next = next;
    const before = f.requests.length;
    const result = await search();
    assert.equal(result.error, undefined, next);
    assert.equal(result.pagination?.has_more, null, next);
    assert.equal(result.pagination?.next_cursor, undefined, next);
    assert.ok(result.coverage.reasons.includes('NON_CONTINUABLE_UPSTREAM_LINK'), next);
    assert.equal(f.requests.length, before + 1, 'only the search itself went upstream; the bad link was never fetched');
    assert.ok(!f.requests.some(url => url.href === next));
  }
});

test('opaque HAPI-style root continuations preserve requested constraints and downgrade execution evidence', async t => {
  const options: Options = { records: [observation('obs-first')] };
  const f = await fixture(options); t.after(f.close);
  options.next = new URL(`/fhir?_getpages=opaque&_getpagesoffset=1&_count=1&_bundletype=searchset`, f.baseUrl).href;
  const gateway = f.gateway();
  const first = await gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 1, params: [{ name: 'code', value: 'http://loinc.org|4548-4' }] });
  assert.equal(first.error, undefined);
  // J-35: a self link never establishes executed_constraints; only the gateway-enforced patient confinement is claimed.
  assert.deepEqual(first.coverage.constraints?.filter(c => c.execution !== "unknown").map(({ name, value }) => ({ name, value })), [{ name: 'patient', value: `Patient/${a}` }]);
  delete options.next;
  options.records = [observation('obs-second')];
  const next = await gateway.execute('fhir_page', { cursor: first.pagination!.next_cursor! });
  assert.equal(next.error, undefined);
  assert.equal(resources(next)[0]?.id, 'obs-second');
  assert.equal(next.coverage.query_evidence, 'unverified_continuation');
  assert.deepEqual((next.coverage.constraints ?? first.coverage.constraints)?.filter(c => c.execution !== "unknown").map(({ name, value }) => ({ name, value })), [{ name: 'patient', value: `Patient/${a}` }], 'gateway confinement is enforced on continuation pages too; upstream filter execution stays unverified');
  assert.deepEqual((next.coverage.constraints ?? first.coverage.constraints)?.map(({ name, value }) => ({ name, value })), first.coverage.constraints?.map(({ name, value }) => ({ name, value })));
  assert.ok(next.warnings.some(warning => warning.code === 'CONTINUATION_QUERY_UNVERIFIED'));
  assert.equal(f.requests.at(-1)?.pathname, '/fhir');
});

test('nested-resource authorization stays bounded and refuses excessive depth', () => {
  const nested = (depth: number): FhirResource => {
    let resource: FhirResource = { resourceType: 'Medication', id: 'leaf' };
    for (let i = 0; i < depth; i++) resource = { resourceType: 'Medication', contained: [resource] };
    return resource;
  };
  assert.equal(authorized(nested(30), a, new URL('http://127.0.0.1/fhir/')), true);
  assert.equal(authorized(nested(100), a, new URL('http://127.0.0.1/fhir/')), false);
  // CPU time, not wall time: parallel suite copies inflate wall time without adding work here.
  const start = process.cpuUsage();
  authorized(nested(30), a, new URL('http://127.0.0.1/fhir/'));
  authorized(nested(100), a, new URL('http://127.0.0.1/fhir/'));
  const used = process.cpuUsage(start);
  assert.ok((used.user + used.system) / 1000 < 500, 'Nested resource traversal must not grow exponentially');
});

test('dotted field selection preserves arrays and reports unresolved and compact-omitted fields', async t => {
  const f = await fixture({ read: { resourceType: 'Patient', id: a, name: [{ family: 'Synthetic', given: ['Alpha'] }, { family: 'Example', given: ['Second'] }], identifier: [{ system: 'http://example.org', value: 'synthetic-1' }] } }); t.after(f.close);
  const gateway = f.gateway();
  const compact = await gateway.execute('fhir_read', { resource_type: 'Patient', id: a, output: { format: 'compact' } });
  assert.equal(compact.error, undefined);
  assert.ok((compact.transform.omitted_fields as string[]).includes('/identifier'));
  const selected = await gateway.execute('fhir_result', { handle: compact.result!.handle, action: 'project', fields: ['name.family', 'missing.path'] });
  assert.equal(selected.error, undefined);
  assert.deepEqual(resources(selected)[0]?.name, [{ family: 'Synthetic' }, { family: 'Example' }]);
  assert.deepEqual(selected.transform.unresolved_fields, ['missing.path']);
  assert.ok(selected.warnings.some(warning => warning.code === 'UNRESOLVED_FIELDS'));
  const obs = await fixture(); t.after(obs.close);
  const coding = await obs.gateway().execute('fhir_read', { resource_type: 'Observation', id: 'obs-a', output: { fields: ['code.coding.code'] } });
  assert.equal(coding.error, undefined);
  assert.deepEqual(resources(coding)[0]?.code, { coding: [{ code: '4548-4' }] });
});

test('warning OperationOutcome entries cannot silently certify query success', async t => {
  const f = await fixture({ records: [observation('obs-a'), { resourceType: 'OperationOutcome', issue: [{ severity: 'warning', code: 'not-supported', diagnostics: 'SECRET_UPSTREAM_DIAGNOSTICS' }] }] }); t.after(f.close);
  // J-35: classified by code, not severity alone. A filter-related warning downgrades the claimed execution
  // to a labelled limitation (upstream diagnostics are never echoed); it does not certify the query.
  const result = await f.gateway().execute('fhir_search', { resource_type: 'Observation' });
  assert.equal(result.error, undefined);
  assert.deepEqual(resources(result).map(resource => resource.id), ['obs-a']);
  assert.deepEqual(result.coverage.constraints?.filter(c => c.execution !== "unknown").map(({ name, value }) => ({ name, value })), [{ name: 'patient', value: `Patient/${a}` }], 'only gateway confinement is enforced');
  assert.ok(result.coverage.constraints?.every(c => c.execution === 'gateway_enforced'));
  assert.ok(result.warnings.some(warning => warning.code === 'FILTER_EXECUTION_UNVERIFIED'));
  assert.ok(!JSON.stringify(result).includes('SECRET_UPSTREAM_DIAGNOSTICS'));
});

test('schema paging at the minimum budget always advances instead of emitting a nonadvancing offset', async t => {
  const f = await fixture(); t.after(f.close);
  const gateway = f.gateway();
  // V-26 positive control: at the raised schema minimum (4096) the first elements fit and advance the offset.
  // (At the old 2048 minimum every element failed, so this test could not discriminate anything.)
  const control = await gateway.execute('fhir_capabilities', { topic: 'schema', resource_type: 'Observation', offset: 0, limit: 2, output: { max_bytes: 8192 } });
  assert.equal(control.error, undefined, JSON.stringify(control.error));
  assert.equal(control.data.next_offset, 2);
  // Walking the whole definition at the minimum: every page either advances the offset or is the last page —
  // never a next_offset that repeats the request offset (which would page forever), and never a silent gap.
  const total = schemaPage('Observation', '', 0, 1).total_elements;
  const seen: string[] = [];
  let offset = 0;
  for (let guard = 0; guard < total + 2; guard++) {
    const result = await gateway.execute('fhir_capabilities', { topic: 'schema', resource_type: 'Observation', offset, limit: 50, output: { max_bytes: 8192 } });
    assert.equal(result.error, undefined, `offset ${offset}: ${JSON.stringify(result.error)}`);
    const elements = result.data.elements as { path: string }[];
    assert.ok(elements.length > 0, `offset ${offset} returned no elements`);
    seen.push(...elements.map(element => element.path));
    const next = result.data.next_offset as number | undefined;
    if (next === undefined) { offset += elements.length; break; }
    assert.equal(next, offset + elements.length, 'next_offset must advance by exactly the returned count');
    offset = next;
  }
  assert.equal(offset, total);
  assert.deepEqual(seen, schemaPage('Observation', '', 0, total).elements.map(element => element.path));
});

test('compact and selected views preserve primitive extension metadata with its value', async t => {
  const companion = { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'masked' }] };
  const f = await fixture({ read: { resourceType: 'Patient', id: a, birthDate: null, _birthDate: companion } }); t.after(f.close);
  for (const output of [{ format: 'compact' }, { format: 'fhir', fields: ['birthDate'] }]) {
    const result = await f.gateway().execute('fhir_read', { resource_type: 'Patient', id: a, output });
    assert.equal(result.error, undefined);
    assert.deepEqual(resources(result)[0]?._birthDate, companion);
    assert.equal(resources(result)[0]?.birthDate, null);
  }
});

// J-18 (C-14, C-45): discriminating confinement/egress guard tests. Each test names the guard it kills; deleting that
// guard line in packages/core makes the test fail, and each carries a positive control so a blanket refusal cannot pass.
const searchPaths = (requests: URL[]) => requests.filter(url => !url.pathname.endsWith('/metadata')).map(url => url.pathname);

test('guard: a non-subject reference to another patient makes a resource unreadable and suppressed from search', async t => {
  const options: Options = {};
  const f = await fixture(options); t.after(f.close);
  const gateway = f.gateway();
  options.read = observation('obs-performer-a', a, { performer: [{ reference: `Patient/${a}` }] });
  assert.equal((await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-performer-a' })).error, undefined, 'positive control: a same-patient performer is readable');
  for (const reference of [`Patient/${b}`, new URL(`Patient/${b}`, f.baseUrl).href]) {
    const foreign = observation('obs-performer-b', a, { performer: [{ reference, display: 'FOREIGN_PERFORMER_SECRET' }] });
    options.read = foreign;
    const read = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-performer-b', output: { format: 'fhir' } });
    assert.equal(read.error?.code, 'NOT_FOUND');
    assert.deepEqual(read.data, {});
    options.records = [observation('obs-a'), foreign];
    const search = await gateway.execute('fhir_search', { resource_type: 'Observation', output: { format: 'fhir' } });
    assert.equal(search.error, undefined);
    assert.deepEqual(resources(search).map(resource => resource.id), ['obs-a']);
    // J-17: the authorization caveat is a standing patient-bound property, identical with and without
    // suppression on the page, and no warning appears only when something was suppressed.
    assert.equal(search.coverage.authorization_limited, true);
    options.records = [observation('obs-a')];
    const clean = await gateway.execute('fhir_search', { resource_type: 'Observation', output: { format: 'fhir' } });
    assert.equal(clean.coverage.authorization_limited, search.coverage.authorization_limited);
    assert.deepEqual(clean.warnings.map(warning => warning.code), search.warnings.map(warning => warning.code));
    assert.ok(!JSON.stringify([read, search]).includes('FOREIGN_PERFORMER_SECRET'));
    assert.ok(!JSON.stringify([read, search]).includes(b));
  }
});

test('guard: an absolute subject on a foreign origin does not establish patient linkage', async t => {
  const options: Options = {};
  const f = await fixture(options); t.after(f.close);
  const gateway = f.gateway();
  const sameOrigin = new URL(`Patient/${a}`, f.baseUrl);
  options.read = observation('obs-origin', a, { subject: { reference: sameOrigin.href } });
  assert.equal((await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-origin' })).error, undefined, 'positive control: same-origin absolute subject is linked');
  const otherPort = new URL(sameOrigin); otherPort.port = String(Number(sameOrigin.port) + 1);
  for (const reference of [`http://evil.invalid${sameOrigin.pathname}`, otherPort.href, `https://127.0.0.1:${sameOrigin.port}${sameOrigin.pathname}`]) {
    const foreign = observation('obs-origin', a, { subject: { reference } });
    options.read = foreign;
    const read = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-origin' });
    assert.equal(read.error?.code, 'NOT_FOUND', reference);
    options.records = [observation('obs-a'), { ...foreign, id: 'obs-foreign-origin' }];
    const search = await gateway.execute('fhir_search', { resource_type: 'Observation' });
    assert.deepEqual(resources(search).map(resource => resource.id), ['obs-a']);
    assert.equal(search.coverage.authorization_limited, true);
  }
});

test('guard: a subject selector for another patient is refused against a subject-only source before any search request', async t => {
  const f = await fixture({ metadata: { rest: capabilityResources(['subject', 'code']) } }); t.after(f.close);
  const gateway = f.gateway();
  for (const value of [b, `Patient/${b}`]) {
    const result = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'subject', value }] });
    assert.equal(result.error?.code, 'POLICY_DENIED');
    assert.deepEqual(result.data, {});
  }
  assert.deepEqual(searchPaths(f.requests), []);
  const allowed = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'subject', value: `Patient/${a}` }] });
  assert.equal(allowed.error, undefined, 'positive control: the trusted subject selector is accepted');
  // S1: the gateway-built confinement pair is appended even though the caller supplied subject.
  assert.deepEqual(f.requests.at(-1)!.searchParams.getAll('subject'), [`Patient/${a}`, `Patient/${a}`]);
});

test('guard: a Patient _id selector for another patient is refused before any Patient search request', async t => {
  const f = await fixture(); t.after(f.close);
  const gateway = f.gateway();
  for (const value of [b, `${a},${b}`]) {
    const result = await gateway.execute('fhir_search', { resource_type: 'Patient', params: [{ name: '_id', value }] });
    assert.equal(result.error?.code, 'POLICY_DENIED');
  }
  const read = await gateway.execute('fhir_read', { resource_type: 'Patient', id: b });
  assert.equal(read.error?.code, 'NOT_FOUND');
  assert.deepEqual(searchPaths(f.requests), [], 'no Patient search or foreign Patient read reaches the source');
  // Positive control: an unfiltered Patient search goes upstream confined to the trusted patient id.
  await gateway.execute('fhir_search', { resource_type: 'Patient' });
  assert.equal(f.requests.at(-1)!.pathname, '/fhir/Patient');
  assert.deepEqual(f.requests.at(-1)!.searchParams.getAll('_id'), [a]);
});

test('guard: a subject-only source receives the injected trusted subject; a source without any patient predicate is refused', async t => {
  const f = await fixture({ metadata: { rest: capabilityResources(['subject', 'code']) } }); t.after(f.close);
  const result = await f.gateway().execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }] });
  assert.equal(result.error, undefined);
  const request = f.requests.at(-1)!;
  assert.deepEqual(request.searchParams.getAll('subject'), [`Patient/${a}`]);
  assert.equal(request.searchParams.has('patient'), false);
  assert.deepEqual(result.coverage.constraints?.map(({ name, value }) => ({ name, value })), [{ name: 'code', value: 'http://loinc.org|4548-4' }, { name: 'subject', value: `Patient/${a}` }, ]);
  const none = await fixture({ metadata: { rest: capabilityResources(['code']) } }); t.after(none.close);
  assert.equal((await none.gateway().execute('fhir_search', { resource_type: 'Observation' })).error?.code, 'UNSUPPORTED_CONFINEMENT');
  assert.deepEqual(searchPaths(none.requests), []);
});

test('guard: only an R4 4.0.x CapabilityStatement enables data access', async t => {
  for (const metadata of [{ fhirVersion: '4.3.0' }, { fhirVersion: '5.0.0' }, { fhirVersion: '3.0.2' }, { resourceType: 'OperationOutcome' }]) {
    const f = await fixture({ metadata }); t.after(f.close);
    const gateway = f.gateway();
    for (const [tool, input] of [['fhir_capabilities', { topic: 'server' }], ['fhir_search', { resource_type: 'Observation' }], ['fhir_read', { resource_type: 'Observation', id: 'obs-a' }]] as const) {
      const result = await gateway.execute(tool, input);
      assert.equal(result.error?.code, 'UNSUPPORTED_FHIR_VERSION', JSON.stringify(metadata));
      assert.deepEqual(result.data, {});
    }
    assert.deepEqual(searchPaths(f.requests), []);
  }
  const control = await fixture({ metadata: { fhirVersion: '4.0.1' } }); t.after(control.close);
  assert.equal((await control.gateway().execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' })).error, undefined, 'positive control: R4 4.0.1');
});

test('guard: valid FHIR JSON served under a non-JSON content type is refused', async t => {
  for (const contentType of ['text/html; charset=utf-8', 'text/plain', 'application/fhir+xml', 'application/json-patch+json']) {
    const f = await fixture({ contentType, records: [observation('obs-a')] }); t.after(f.close);
    const gateway = f.gateway();
    // J-15: a direct read that cannot be decoded cannot establish linkage, so publicly it is NOT_FOUND;
    // the content-type refusal itself is proven by the search code and the audit cause.
    const read = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' });
    assert.equal(read.error?.code, 'NOT_FOUND', contentType);
    assert.deepEqual(read.data, {});
    assert.equal(gateway.auditEvents.at(-1)?.cause, 'UNSUPPORTED_CONTENT:200', contentType);
    assert.equal((await gateway.execute('fhir_search', { resource_type: 'Observation' })).error?.code, 'UNSUPPORTED_CONTENT');
  }
  const control = await fixture({ contentType: 'application/json; charset=utf-8' }); t.after(control.close);
  assert.equal((await control.gateway().execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' })).error, undefined, 'positive control: application/json');
});

test('guard: a non-searchset Bundle (history, collection) is not accepted as search evidence', async t => {
  for (const bundleType of ['history', 'collection', 'transaction-response']) {
    const f = await fixture({ bundleType }); t.after(f.close);
    const result = await f.gateway().execute('fhir_search', { resource_type: 'Observation' });
    assert.equal(result.error?.code, 'INVALID_RESPONSE', bundleType);
    assert.deepEqual(result.data, {});
  }
});

test('guard: include-mode entries are never delivered as matches, even for the same patient and type', async t => {
  const f = await fixture({ includes: [observation('obs-included-same-patient', a, { note: [{ text: 'INCLUDE_ONLY_MARKER' }] }), { resourceType: 'Patient', id: a }] }); t.after(f.close);
  const result = await f.gateway().execute('fhir_search', { resource_type: 'Observation', output: { format: 'fhir' } });
  assert.equal(result.error, undefined);
  assert.deepEqual(resources(result).map(resource => resource.id), ['obs-a', 'obs-a2']);
  assert.equal(result.pagination?.returned_matches, 2);
  assert.equal(result.pagination?.returned_includes, 0);
  assert.ok(!JSON.stringify(result).includes('obs-included-same-patient'));
  assert.ok(!JSON.stringify(result).includes('INCLUDE_ONLY_MARKER'));
});

test('guard: a source alias other than the configured one is refused before any upstream request', async t => {
  const f = await fixture(); t.after(f.close);
  const gateway = f.gateway();
  for (const [tool, input] of [['fhir_capabilities', { topic: 'server' }], ['fhir_search', { resource_type: 'Observation' }], ['fhir_read', { resource_type: 'Observation', id: 'obs-a' }]] as const) {
    for (const source of ['other-source', 'FIXTURE', '']) {
      const result = await gateway.execute(tool, { ...input, source });
      assert.equal(result.error?.code, source === '' ? 'INVALID_ARGUMENTS' : 'POLICY_DENIED', `${tool} source=${source}`);
      assert.deepEqual(result.data, {});
    }
  }
  assert.equal(f.requests.length, 0);
  assert.equal((await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-a', source: 'fixture' })).error, undefined, 'positive control: the configured alias');
});

test('guard: encoded slash, backslash and dot path segments are refused by URL validation and in self links', async t => {
  const transport = new FhirTransport('http://127.0.0.1:8080/fhir', 1024, 1000);
  for (const path of ['Observation%2f..%2fPatient', 'Observation%2F..%2FPatient', 'Observation%5c..%5cPatient', 'Observation%5C..', 'Observation%2e%2e%2fadmin', 'Observation/obs%2Ea']) {
    assert.throws(() => transport.validate(`http://127.0.0.1:8080/fhir/${path}`), (error: unknown) => (error as { code?: string }).code === 'UNSAFE_URL', path);
  }
  assert.equal(transport.validate('http://127.0.0.1:8080/fhir/Observation/obs-a?code=a%2Fb').pathname, '/fhir/Observation/obs-a', 'positive control: encoded query values remain valid');
  const f = await fixture({ self: url => { url.pathname = '/fhir/Observation%2f..%2fPatient'; return url.href; } }); t.after(f.close);
  const result = await f.gateway().execute('fhir_search', { resource_type: 'Observation' });
  assert.equal(result.error?.code, 'UNSAFE_URL');
  assert.deepEqual(result.data, {});
});
