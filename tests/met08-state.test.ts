import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { FhirGateway } from '../packages/core/src/index.js';
import { declaredFromCapability } from '../packages/core/src/search-parameters.js';

const segments = ['MET08ForeignPatient91', 'PrivateMarker72', 'HiddenToken53'];
const customName = `vendor-${segments.join('-')}`;
const pinned = [
  { name: 'patient', type: 'reference' }, { name: 'code', type: 'token' },
  { name: '_id', type: 'token' }, { name: '_lastUpdated', type: 'date' }, { name: '_sort', type: 'special' },
];

/** Independent structural scan: keys, Map/Set entries, backing blobs and overlays.
 * No gateway fields are excluded. Getters and function closures are not invoked.
 */
function stringsIn(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  if (Buffer.isBuffer(value)) return [value.toString('utf8')];
  if (value instanceof Map) return [...value].flatMap(([key, child]) => [...stringsIn(key, seen), ...stringsIn(child, seen)]);
  if (value instanceof Set) return [...value].flatMap(child => stringsIn(child, seen));
  return Reflect.ownKeys(value).flatMap(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return [String(key), ...('value' in descriptor ? stringsIn(descriptor.value, seen) : [])];
  });
}

test('MET-08: custom declaration names never survive in any reachable gateway state', async t => {
  let names = [customName, 'birthdate']; // birthdate is pinned for Patient, not Observation.
  let clinicalCalls = 0;
  let baseUrl = '';
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/fhir+json');
    if (req.url === '/fhir/metadata') {
      res.end(JSON.stringify({
        resourceType: 'CapabilityStatement', fhirVersion: '4.0.1',
        rest: [{ mode: 'server', resource: [{
          type: 'Observation', interaction: [{ code: 'search-type' }],
          searchParam: [...pinned, ...names.map(name => ({ name, type: 'token' }))],
        }] }],
      }));
      return;
    }
    clinicalCalls++;
    res.end(JSON.stringify({
      resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: new URL(req.url!, baseUrl).href }],
      entry: Array.from({ length: 9 }, (_, i) => ({ resource: {
        resourceType: 'Observation', id: `met08-${i}`, status: 'final',
        code: { coding: [{ system: 'http://loinc.org', code: '1111-1' }] },
        subject: { reference: 'Patient/synthetic-a' },
      }, search: { mode: 'match' } })),
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}/fhir/`;
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'met08', baseUrl }, patientId: 'synthetic-a' });
  t.after(async () => {
    gateway.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const state = gateway as unknown as {
    capabilities: Map<string, { declared: { name: string }[]; resolvedParameters: Map<string, { byName: Map<string, unknown> }> }>;
    metadataExpiresAt: number;
    store: { size: number };
  };
  const assertClean = () => {
    const strings = stringsIn(gateway);
    for (const segment of segments) assert.ok(!strings.some(s => s.toLowerCase().includes(segment.toLowerCase())), 'no canary segment in reachable state (including keys)');
    assert.ok(strings.includes('code'), 'positive control: pinned name remains cached');
    assert.ok(!state.capabilities.get('Observation')!.declared.some(p => p.name === 'birthdate'), 'resource-specific pinned applicability');
  };
  const discover = () => gateway.execute('fhir_capabilities', { topic: 'resource', resource_type: 'Observation' });
  const first = await discover();
  assert.equal(first.error, undefined);
  assertClean();
  assert.equal((state.capabilities.get('Observation') as any).withheldNameCount, 2, 'two custom names are withheld; unlisted _sort is absent from the public list');
  assert.deepEqual(state.capabilities.get('Observation')!.declared.map(p => p.name), pinned.map(p => p.name));
  const output = { format: 'fhir', max_bytes: 8192 } as const;
  const search = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|1111-1' }], page_size: 1, output });
  assert.equal(search.error, undefined);
  assert.ok(search.result && search.pagination?.next_cursor, 'positive control: result and frozen continuation retained');
  assert.ok(state.store.size >= 2);
  assert.ok(state.capabilities.get('Observation')!.resolvedParameters.get('generic-r4')!.byName.has('code'));
  assertClean();
  const before = clinicalCalls;
  for (const name of [customName, 'birthdate']) {
    const denied = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name, value: 'ordinary' }], output });
    assert.equal(denied.error?.code, 'SEARCH_PARAMETER_UNRESOLVED');
  }
  assert.equal(clinicalCalls, before, 'custom names still refused before clinical HTTP');
  assert.ok(gateway.auditEvents.length >= 4, 'scan includes an exercised audit trail');
  assertClean();
  const retained = await gateway.execute('fhir_result', { handle: search.result.handle, output });
  const continued = await gateway.execute('fhir_page', { cursor: search.pagination.next_cursor, output });
  assert.equal(retained.error, undefined);
  assert.equal(continued.error, undefined);
  for (const value of [first, search, retained, continued]) for (const segment of segments) assert.ok(!stringsIn(value).some(s => s.includes(segment)), 'retained replay and public outputs remain clean');
  assertClean();

  // S2: declaration order and exact duplicates are cosmetic; replacement,
  // addition and removal of withheld names must invalidate retained handles.
  names = ['birthdate', customName, customName];
  state.metadataExpiresAt = 0;
  assert.equal((await discover()).source.capability_revision, first.source.capability_revision);
  assert.equal((await gateway.execute('fhir_result', { handle: search.result.handle, output })).error, undefined);
  let revision = first.source.capability_revision;
  for (const changed of [[`${customName}-replacement`, 'birthdate'], [`${customName}-replacement`], [`${customName}-replacement`, 'another-custom']]) {
    const held = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [], output });
    assert.equal(held.error, undefined);
    assert.ok(held.result);
    names = changed;
    state.metadataExpiresAt = 0;
    const refreshed = await discover();
    assert.equal(refreshed.error, undefined);
    assert.notEqual(refreshed.source.capability_revision, revision, 'withheld name set change remains material to S2');
    assert.equal((await gateway.execute('fhir_result', { handle: held.result.handle, output })).error?.code, 'RESULT_EXPIRED');
    revision = refreshed.source.capability_revision;
    assertClean();
  }
});

test('MET-08: declaration parser drops custom names before any caller can cache them', () => {
  const raw = [...pinned, { name: customName, type: 'token' }];
  for (const parsed of [declaredFromCapability(raw), declaredFromCapability(raw, 'Observation')]) {
    assert.deepEqual(parsed.map(p => p.name), pinned.map(p => p.name));
    for (const segment of segments) assert.ok(!stringsIn(parsed).some(s => s.includes(segment)));
  }
});
