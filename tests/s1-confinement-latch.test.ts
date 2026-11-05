import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { FhirGateway, type GatewayEnvelope } from '../packages/core/src/index.js';

// S1 (M3b integration, W0 latch): the trusted confinement pair is ALWAYS appended to a
// patient-bound clinical search, even when the caller already supplied that name. Every
// pre-existing M3a guard stays in front of it: the exact patient/subject/_id checks,
// foreignPatientSelector (privacy.ts) and per-record authorized().
//
// Which existing guard refuses each 34-alternative case below (recorded 2026-10-19, pre-Q):
// - subject / patient: the exact check in FhirGateway.search (the whole value must equal the
//   bound id or Patient/<bound>) refuses first; foreignPatientSelector would also match.
// - code / date: foreignPatientSelector refuses, because one comma alternative parses as a
//   foreign Patient reference and its comma split is unbounded (privacy.ts:216).
// There is no alternative-count guard on this path yet; that arrives with Q's typed syntax
// validation at S3. The 33-alternative bound-only control pins the boundary Q uses: 33
// alternatives are admitted and still checked one by one (see the 33-with-foreign refusal).

const a = 'synthetic-patient-a';
const b = 'synthetic-patient-b';
const observation = (id: string) => ({ resourceType: 'Observation', id, meta: { versionId: '1' }, status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, subject: { reference: `Patient/${a}` }, effectiveDateTime: '2026-01-02T10:00:00Z', valueQuantity: { value: 7.1, unit: '%', system: 'http://unitsofmeasure.org', code: '%' } });

function metadata(searchParams: { name: string; type: string }[]) {
  return {
    resourceType: 'CapabilityStatement', fhirVersion: '4.0.1',
    rest: [{ mode: 'server', resource: ['Patient', 'Observation'].map(type => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: searchParams })) }],
  };
}
const FULL_PARAMS = [
  { name: 'patient', type: 'reference' }, { name: 'subject', type: 'reference' }, { name: 'performer', type: 'reference' },
  { name: 'link', type: 'reference' }, { name: 'code', type: 'token' }, { name: 'date', type: 'date' },
];
const SUBJECT_ONLY_PARAMS = FULL_PARAMS.filter(param => param.name !== 'patient');

async function fixture(searchParams = FULL_PARAMS) {
  const requests: URL[] = [];
  let baseUrl = '';
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, baseUrl);
    requests.push(url);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname.endsWith('/metadata')) { res.end(JSON.stringify(metadata(searchParams))); return; }
    const segments = url.pathname.split('/').filter(Boolean);
    const type = segments[1];
    const records = type === 'Patient' ? [{ resourceType: 'Patient', id: a, meta: { versionId: '1' } }] : [observation('obs-a')];
    // The self link echoes the exact request URL, duplicate occurrences included.
    res.end(JSON.stringify({
      resourceType: 'Bundle', type: 'searchset', total: records.length,
      link: [{ relation: 'self', url: url.href }],
      entry: records.map(resource => ({ resource, search: { mode: 'match' } })),
    }));
  };
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/fhir/`;
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 's1-fixture', baseUrl }, patientId: a });
  return {
    baseUrl, requests, gateway,
    clinical: () => requests.filter(url => !url.pathname.endsWith('/metadata')),
    lastClinical: () => requests.filter(url => !url.pathname.endsWith('/metadata')).at(-1)!,
    warm: async () => { assert.equal((await gateway.execute('fhir_capabilities', { topic: 'server' })).error, undefined); },
    close: () => new Promise<void>((resolve, reject) => { gateway.close(); server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }),
  };
}
type Pair = { name: string; value: string };
const resources = (result: GatewayEnvelope) => result.data.resources as Record<string, unknown>[];
const fillers = (count: number, make: (i: number) => string) => Array.from({ length: count }, (_, i) => make(i));

test('S1: a same-named caller pair still gets the trusted pair appended after it, before _count', async t => {
  const f = await fixture(); t.after(f.close);
  await f.warm();
  // Caller supplies patient (the selected alias) in its full reference form.
  const full = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'patient', value: `Patient/${a}` }, { name: 'code', value: 'http://loinc.org|4548-4' }] });
  assert.equal(full.error, undefined);
  assert.deepEqual(resources(full).map(resource => resource.id), ['obs-a']);
  assert.deepEqual(f.lastClinical().searchParams.getAll('patient'), [`Patient/${a}`, `Patient/${a}`], 'caller pair first, gateway pair second');
  assert.deepEqual([...f.lastClinical().searchParams.keys()], ['patient', 'code', 'patient', '_count'], 'appended pair lands after caller pairs and before _count');
  assert.deepEqual(full.coverage.constraints?.map(({ name, value }) => ({ name, value })), [
    { name: 'patient', value: `Patient/${a}` }, { name: 'code', value: 'http://loinc.org|4548-4' },
    { name: 'patient', value: `Patient/${a}` },
  ]);
  // Caller supplies the bare bound id: the appended pair is the gateway-built reference form.
  const bare = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'patient', value: a }] });
  assert.equal(bare.error, undefined);
  assert.deepEqual(f.lastClinical().searchParams.getAll('patient'), [a, `Patient/${a}`]);
  // Caller supplies the other alias (subject) while the source-selected alias is patient.
  const otherAlias = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'subject', value: `Patient/${a}` }] });
  assert.equal(otherAlias.error, undefined);
  assert.deepEqual(f.lastClinical().searchParams.getAll('subject'), [`Patient/${a}`]);
  assert.deepEqual(f.lastClinical().searchParams.getAll('patient'), [`Patient/${a}`], 'confinement is appended under the selected alias');
  assert.deepEqual([...f.lastClinical().searchParams.keys()], ['subject', 'patient', '_count']);
  // Control: no caller pair, exactly one appended pair (unchanged M3a shape).
  const plain = await f.gateway.execute('fhir_search', { resource_type: 'Observation' });
  assert.equal(plain.error, undefined);
  assert.deepEqual(f.lastClinical().searchParams.getAll('patient'), [`Patient/${a}`]);
});

test('S1: a subject-only source gets the trusted subject appended even when the caller supplied subject', async t => {
  const f = await fixture(SUBJECT_ONLY_PARAMS); t.after(f.close);
  await f.warm();
  const result = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'subject', value: `Patient/${a}` }] });
  assert.equal(result.error, undefined);
  assert.deepEqual(f.lastClinical().searchParams.getAll('subject'), [`Patient/${a}`, `Patient/${a}`]);
  assert.equal(f.lastClinical().searchParams.has('patient'), false);
});

test('S1: a caller Patient _id pair still gets the trusted _id appended', async t => {
  const f = await fixture(); t.after(f.close);
  await f.warm();
  const result = await f.gateway.execute('fhir_search', { resource_type: 'Patient', params: [{ name: '_id', value: a }] });
  assert.equal(result.error, undefined);
  assert.deepEqual(resources(result).map(resource => resource.id), [a]);
  assert.deepEqual(f.lastClinical().searchParams.getAll('_id'), [a, a]);
  assert.deepEqual([...f.lastClinical().searchParams.keys()], ['_id', '_id', '_count']);
  // Control: no caller _id, exactly one appended _id.
  const plain = await f.gateway.execute('fhir_search', { resource_type: 'Patient' });
  assert.equal(plain.error, undefined);
  assert.deepEqual(f.lastClinical().searchParams.getAll('_id'), [a]);
});

test('S1: 34-alternative selectors hiding a foreign patient are refused with zero clinical fetches', async t => {
  const f = await fixture(); t.after(f.close);
  await f.warm();
  assert.equal(f.requests.filter(url => url.pathname.endsWith('/metadata')).length, 1, 'metadata counted separately: one discovery fetch');
  const foreignLast = (make: (i: number) => string) => [...fillers(33, make), `Patient/${b}`].join(',');
  const cases: [string, Pair[]][] = [
    ['subject', [{ name: 'subject', value: foreignLast(i => `filler-${i}`) }]],
    ['patient', [{ name: 'patient', value: foreignLast(i => `filler-${i}`) }]],
    ['code', [{ name: 'code', value: foreignLast(i => `http://example.test/codes|filler-${i}`) }]],
    ['date', [{ name: 'date', value: foreignLast(i => `ge${1990 + i}-01-01`) }]],
    // Exactly 33 alternatives are still checked one by one: a foreign one is refused.
    ['code-33-with-foreign', [{ name: 'code', value: [...fillers(32, i => `http://example.test/codes|filler-${i}`), `Patient/${b}`].join(',') }]],
  ];
  for (const [name, params] of cases) {
    assert.equal(params[0]!.value.split(',').length, name === 'code-33-with-foreign' ? 33 : 34, name);
    assert.ok(params[0]!.value.length <= 2048, `${name}: value is schema-legal, so the selector guard is what refuses`);
    const before = f.requests.length;
    const result = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params });
    assert.equal(result.error?.code, params[0]!.value.split(',').length > 33 ? 'INVALID_ARGUMENTS' : 'POLICY_DENIED', name);
    assert.deepEqual(result.data, {}, name);
    assert.equal(f.requests.length, before, `${name}: zero clinical fetches (and no new metadata)`);
  }
  // Positive control: 33 bound-only alternatives on code are admitted, fetched once, and
  // reach the source intact with the confinement pair appended exactly once.
  const boundOnly = ['http://loinc.org|4548-4', ...fillers(32, i => `http://example.test/codes|filler-${i}`)].join(',');
  const before = f.clinical().length;
  const ok = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: boundOnly }] });
  assert.equal(ok.error, undefined, '33-alternative bound-only control must be admitted');
  assert.equal(f.clinical().length, before + 1);
  assert.equal(f.lastClinical().searchParams.get('code'), boundOnly);
  assert.deepEqual(f.lastClinical().searchParams.getAll('patient'), [`Patient/${a}`]);
});

test('S1: foreign, conditional and Patient.link selector forms are refused with zero clinical fetches', async t => {
  const f = await fixture(); t.after(f.close);
  await f.warm();
  const cases: [string, string, Pair[]][] = [
    ['subject foreign relative', 'Observation', [{ name: 'subject', value: `Patient/${b}` }]],
    ['subject foreign same-source absolute', 'Observation', [{ name: 'subject', value: new URL(`Patient/${b}`, f.baseUrl).href }]],
    ['subject bound id on a foreign host', 'Observation', [{ name: 'subject', value: `http://evil.example/fhir/Patient/${a}` }]],
    ['subject conditional', 'Observation', [{ name: 'subject', value: 'Patient?identifier=synthetic-mrn-b' }]],
    ['patient comma-OR smuggling a foreign patient', 'Observation', [{ name: 'patient', value: `Patient/${a},Patient/${b}` }]],
    ['performer bound id on a foreign host', 'Observation', [{ name: 'performer', value: `http://evil.example/fhir/Patient/${a}` }]],
    ['performer bare foreign id', 'Observation', [{ name: 'performer', value: b }]],
    ['performer conditional', 'Observation', [{ name: 'performer', value: 'Patient?identifier=synthetic-mrn-b' }]],
    ['Patient link foreign relative', 'Patient', [{ name: 'link', value: `Patient/${b}` }]],
    ['Patient link bare foreign id', 'Patient', [{ name: 'link', value: b }]],
    ['Patient link bound id on a foreign host', 'Patient', [{ name: 'link', value: `http://evil.example/fhir/Patient/${a}` }]],
    ['Patient link conditional', 'Patient', [{ name: 'link', value: 'Patient?identifier=synthetic-mrn-b' }]],
  ];
  for (const [name, resourceType, params] of cases) {
    const before = f.requests.length;
    const result = await f.gateway.execute('fhir_search', { resource_type: resourceType, params });
    assert.equal(result.error?.code, params[0]!.value.split(',').length > 33 ? 'INVALID_ARGUMENTS' : 'POLICY_DENIED', name);
    assert.deepEqual(result.data, {}, name);
    assert.equal(f.requests.length, before, `${name}: zero clinical fetches`);
  }
  // S3: polymorphic Patient.link requires the explicit bound Patient form.
  const bareLink = await f.gateway.execute('fhir_search', { resource_type: 'Patient', params: [{ name: 'link', value: a }] });
  assert.equal(bareLink.error?.code, 'POLICY_DENIED');
  for (const value of [`Patient/${a}`]) {
    const result = await f.gateway.execute('fhir_search', { resource_type: 'Patient', params: [{ name: 'link', value }] });
    assert.equal(result.error, undefined, `link=${value}`);
    assert.deepEqual(f.lastClinical().searchParams.getAll('link'), [value]);
    assert.deepEqual(f.lastClinical().searchParams.getAll('_id'), [a], 'trusted _id appended alongside the caller link pair');
  }
});
