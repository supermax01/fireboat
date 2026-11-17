// Reference-valued search parameters on patient-linked types (B1 in the test titles) and `_id` OR lists (B2).
// Synthetic, hand-written records only. B1 admits an explicit relative `Type/id` target of a patient-linked type
// only when the gateway has authorized that exact record as the bound patient's own record in this context and state
// generation. A target not yet delivered is first checked with the confined search
// `<Type>?_id=<id>&patient=Patient/<bound>` (a search the agent could run itself), never by reading it directly; foreign,
// missing, withheld and failing targets give one identical POLICY_DENIED, and the original search is never sent for them.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { FhirGateway, type GatewayEnvelope } from '../packages/core/src/index.js';
import { MAX_PATIENT_LINKED_TARGETS, resolveSearchParameters, validateSearchAdmission, validateSearchSyntax, type ResolvedSearchParameters } from '../packages/core/src/search-parameters.js';
import { VerifiedTargetLedger } from '../packages/core/src/store.js';
import catalog from '../packages/core/src/generated/r4-search-parameters.json' with { type: 'json' };

type R = Record<string, any>;
type Pair = { name: string; value: string };
const A = 'pat-a';
const declarations = (type: string) => [
  { name: '_id', type: 'token', source_description_present: false },
  ...catalog.definitions.filter(d => d.base.includes(type)).map(d => ({ name: d.code, type: d.type, source_description_present: false })),
];
const resolvedCache = new Map<string, ResolvedSearchParameters>();
const resolvedFor = (type: string) => {
  let resolved = resolvedCache.get(type);
  if (!resolved) { resolved = resolveSearchParameters({ resourceType: type, declared: declarations(type), advertised: true }); resolvedCache.set(type, resolved); }
  return resolved;
};

// ---------------------------------------------------------------------------------------------------------------
// Unit: pure admission matrix.
// ---------------------------------------------------------------------------------------------------------------

const verifiedKeys = new Set(['Encounter/enc-a', 'Encounter/enc-c', 'Encounter/e1', 'Encounter/e2', 'Encounter/e3', 'Encounter/e4', 'Encounter/e5',
  'Observation/obs-a1', 'ServiceRequest/sr-a', 'Procedure/proc-a', 'Claim/claim-a', 'EpisodeOfCare/eoc-a', 'Group/g-a', 'Patient/pat-b', 'Patient/pat-a']);
const verified = (type: string, id: string) => verifiedKeys.has(`${type}/${id}`);
const admit = (type: string, pairs: Pair[], check: (type: string, id: string) => boolean = verified, resolved = resolvedFor(type)) =>
  validateSearchAdmission({ resourceType: type, pairs, resolved, patientId: A, confinementName: 'patient', verifiedTarget: check });

test('B1 admission: verified own patient-linked targets listed in the pinned targets are admitted', () => {
  const admitted: [string, Pair[]][] = [
    ['Observation', [{ name: 'encounter', value: 'Encounter/enc-a' }]],
    ['Condition', [{ name: 'encounter', value: 'Encounter/enc-a' }]],
    ['Procedure', [{ name: 'encounter', value: 'Encounter/enc-a' }]],
    ['MedicationRequest', [{ name: 'encounter', value: 'Encounter/enc-a' }]],
    ['Observation', [{ name: 'derived-from', value: 'Observation/obs-a1' }]],
    ['Observation', [{ name: 'based-on', value: 'ServiceRequest/sr-a' }]],
    ['Observation', [{ name: 'part-of', value: 'Procedure/proc-a' }]],
    ['Encounter', [{ name: 'part-of', value: 'Encounter/enc-a' }]],
    ['ExplanationOfBenefit', [{ name: 'claim', value: 'Claim/claim-a' }]],
    // The pinned R4 focus target list names every resource type literally, Encounter included.
    ['Observation', [{ name: 'focus', value: 'Encounter/enc-a' }]],
    // OR lists of verified patient-linked targets: every part is checked and counted.
    ['Observation', [{ name: 'encounter', value: 'Encounter/enc-a,Encounter/enc-c' }]],
    ['Observation', [{ name: 'encounter', value: 'Encounter/enc-a,Encounter/enc-a' }]],
    // Exactly the cap of distinct targets across pairs.
    ['Observation', [{ name: 'encounter', value: 'Encounter/e1,Encounter/e2' }, { name: 'encounter', value: 'Encounter/e3' }, { name: 'focus', value: 'Encounter/e4' }]],
    // Unchanged: the bound patient and a single shared target.
    ['Observation', [{ name: 'performer', value: 'Patient/pat-a' }]],
    ['Observation', [{ name: 'performer', value: 'Practitioner/prac-1' }]],
  ];
  for (const [type, pairs] of admitted) assert.doesNotThrow(() => admit(type, pairs), `${type} ${JSON.stringify(pairs)}`);
  assert.equal(MAX_PATIENT_LINKED_TARGETS, 4);
});

test('B1 admission: every other reference form, and any OR list with a refused part, is refused before sending', () => {
  const refused: [string, Pair, string?][] = [
    // Not verified in this context (another patient's encounter, or one that does not exist): one uniform refusal.
    ['Observation', { name: 'encounter', value: 'Encounter/enc-b' }],
    ['Observation', { name: 'encounter', value: 'Encounter/enc-zz' }],
    // Patient is never a B1 target, even when the trusted check would say yes.
    ['Observation', { name: 'performer', value: 'Patient/pat-b' }],
    ['Observation', { name: 'focus', value: 'Patient/pat-b' }],
    // Bare, absolute, versioned, conditional, fragment, urn and escaped forms.
    ['Observation', { name: 'encounter', value: 'enc-a' }],
    ['Observation', { name: 'encounter', value: 'http://127.0.0.1:1/fhir/Encounter/enc-a' }],
    ['Observation', { name: 'encounter', value: 'Encounter/enc-a/_history/1' }],
    ['Observation', { name: 'encounter', value: 'Encounter?identifier=urn:synthetic|e-1' }],
    ['Observation', { name: 'encounter', value: 'Encounter/enc-a#x' }],
    ['Observation', { name: 'encounter', value: 'urn:uuid:5b1f2c3d-0000-4000-8000-000000000001' }],
    ['Observation', { name: 'encounter', value: 'Encounter/enc\\-a' }],
    ['Observation', { name: 'encounter', value: 'Encounter/..' }],
    ['Observation', { name: 'encounter', value: 'encounter/enc-a' }],
    // Unclassified or ambiguous target types, even when listed and "verified".
    ['Observation', { name: 'encounter', value: 'EpisodeOfCare/eoc-a' }],
    ['Encounter', { name: 'episode-of-care', value: 'EpisodeOfCare/eoc-a' }],
    ['Observation', { name: 'focus', value: 'Group/g-a' }],
    // A verified type that the parameter's pinned targets do not list.
    ['Observation', { name: 'based-on', value: 'Encounter/enc-a' }],
    ['Condition', { name: 'encounter', value: 'Observation/obs-a1' }],
    // OR lists with one refused part.
    ['Observation', { name: 'encounter', value: 'Encounter/enc-a,Encounter/enc-b' }],
    ['Observation', { name: 'encounter', value: 'Encounter/enc-b,Encounter/enc-a' }],
    ['Observation', { name: 'encounter', value: 'Encounter/enc-a,enc-c' }],
    ['Observation', { name: 'focus', value: 'Encounter/enc-a,Patient/pat-a' }],
    ['Observation', { name: 'performer', value: 'Practitioner/prac-1,Patient/pat-b' }],
    ['Observation', { name: 'performer', value: 'Practitioner/prac-1,CareTeam/ct-a' }],
    // Shared targets stay single-valued.
    ['Observation', { name: 'performer', value: 'Practitioner/prac-1,Practitioner/prac-2' }],
    // Patient-link parameters never take a non-Patient target.
    ['Observation', { name: 'subject', value: 'Encounter/enc-a' }],
    ['Observation', { name: 'patient', value: 'Encounter/enc-a' }],
  ];
  for (const [type, pair] of refused) {
    assert.throws(() => admit(type, [pair]), { code: 'POLICY_DENIED' }, `${type} ${pair.name}=${pair.value}`);
  }
  // Without trusted evidence (the default), nothing patient-linked is admitted.
  assert.throws(() => validateSearchAdmission({ resourceType: 'Observation', pairs: [{ name: 'encounter', value: 'Encounter/enc-a' }], resolved: resolvedFor('Observation'), patientId: A, confinementName: 'patient' }), { code: 'POLICY_DENIED' });
  // One more distinct target than the cap is refused before sending, even when every target is verified.
  assert.throws(() => admit('Observation', [{ name: 'encounter', value: 'Encounter/e1,Encounter/e2,Encounter/e3' }, { name: 'focus', value: 'Encounter/e4,Encounter/e5' }]), { code: 'UNSUPPORTED_SEARCH' });
  assert.throws(() => admit('Observation', [{ name: 'encounter', value: 'Encounter/e1,Encounter/e2,Encounter/e3,Encounter/e4,Encounter/e5' }]), { code: 'UNSUPPORTED_SEARCH' });
});

test('B1 admission: a patient-link parameter is excluded by name even if its targets listed a patient-linked type', () => {
  // The pinned R4 Observation.subject targets include Device; once Device is patient-linked, subject must still never
  // take a non-Patient target. Model that with a resolved table whose subject entry also lists Encounter.
  const base = resolvedFor('Observation');
  const subject = base.byName.get('subject')!;
  const widened = { ...base, byName: new Map([...base.byName, ['subject', { ...subject, targetsFull: [...subject.targetsFull, 'Encounter'] }]]) } as ResolvedSearchParameters;
  assert.throws(() => admit('Observation', [{ name: 'subject', value: 'Encounter/enc-a' }], verified, widened), { code: 'POLICY_DENIED' });
  const patient = base.byName.get('patient')!;
  const widenedPatient = { ...base, byName: new Map([...base.byName, ['patient', { ...patient, targetsFull: [...patient.targetsFull, 'Encounter'] }]]) } as ResolvedSearchParameters;
  assert.throws(() => validateSearchAdmission({ resourceType: 'Observation', pairs: [{ name: 'patient', value: 'Encounter/enc-a' }], resolved: widenedPatient, patientId: A, confinementName: 'patient', verifiedTarget: verified }), { code: 'POLICY_DENIED' });
});

test('B1 ledger: bounded, least recently used out, refreshed by a hit, cleared on demand', () => {
  const ledger = new VerifiedTargetLedger(3);
  ledger.add('Encounter', 'e1'); ledger.add('Encounter', 'e2'); ledger.add('Encounter', 'e3');
  assert.equal(ledger.has('Encounter', 'e1'), true);
  ledger.add('Encounter', 'e4');
  assert.equal(ledger.has('Encounter', 'e2'), false, 'the least recently used key leaves first');
  assert.deepEqual(['e1', 'e3', 'e4'].map(id => ledger.has('Encounter', id)), [true, true, true]);
  assert.equal(ledger.has('Observation', 'e1'), false, 'type is part of the key');
  assert.equal(ledger.size, 3);
  ledger.clear();
  assert.equal(ledger.has('Encounter', 'e1'), false);
});

test('B2 syntax: `_id` alternatives must be plain FHIR ids, at most 100 within 4,096 bytes, before any request', () => {
  // `_id` lists take at most 100 ids.
  const syntax = (type: string, value: string, name = '_id') => validateSearchSyntax({ resourceType: type, pairs: [{ name, value }], resolved: resolvedFor(type) });
  const uuids = (count: number) => Array.from({ length: count }, (_, i) => `5b1f2c3d-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',');
  for (const type of ['Observation', 'Medication', 'Encounter']) {
    for (const value of ['a', 'a,b,c', 'obs-a1,obs.a2,A-9', Array.from({ length: 33 }, (_, i) => `id-${i}`).join(','), Array.from({ length: 34 }, (_, i) => `id-${i}`).join(','),
      uuids(100), 'x'.repeat(64)]) {
      assert.doesNotThrow(() => syntax(type, value), `${type} ${value}`);
    }
    for (const value of ['', 'a|b', 'a,,b', ',a', 'a,', '..', '.', 'a,..', 'a\\,b', 'a\\|b', 'a b', 'Observation/a', 'x'.repeat(65), 'a,' + 'x'.repeat(65),
      uuids(101), Array.from({ length: 101 }, (_, i) => `i${i}`).join(','),
      // 64 ids of 64 characters: under 100 alternatives but over 4,096 bytes.
      Array.from({ length: 64 }, (_, i) => `${i}`.padStart(64, 'x')).join(',')]) {
      assert.throws(() => syntax(type, value), { code: 'INVALID_ARGUMENTS' }, `${type} ${value.slice(0, 80)}`);
    }
  }
  // Every other OR list keeps 33 alternatives and 2,048 bytes.
  assert.doesNotThrow(() => syntax('Observation', Array.from({ length: 33 }, () => '1111-1').join(','), 'code'));
  assert.throws(() => syntax('Observation', Array.from({ length: 34 }, () => '1111-1').join(','), 'code'), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => syntax('Observation', 'x'.repeat(2049), 'code'), { code: 'INVALID_ARGUMENTS' });
  assert.doesNotThrow(() => syntax('Observation', 'x'.repeat(2048), 'code'));
});

// ---------------------------------------------------------------------------------------------------------------
// Gateway: an inline loopback source with honest (or deliberately leaky) search semantics.
// ---------------------------------------------------------------------------------------------------------------

const coding = (code: string) => ({ coding: [{ system: 'http://loinc.org', code }] });
const encounter = (id: string, patient: string, extra: R = {}) => ({ resourceType: 'Encounter', id, status: 'finished',
  class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }, subject: { reference: `Patient/${patient}` }, ...extra });
const observation = (id: string, patient: string, extra: R = {}) => ({ resourceType: 'Observation', id, status: 'final', code: coding('1111-1'),
  subject: { reference: `Patient/${patient}` }, effectiveDateTime: '2025-01-01T10:00:00Z', ...extra });
function dataset(): R[] {
  return [
    { resourceType: 'Patient', id: 'pat-a', active: true },
    { resourceType: 'Patient', id: 'pat-b', active: true },
    encounter('enc-a', 'pat-a'), encounter('enc-c', 'pat-a'), encounter('enc-b', 'pat-b'),
    // An own encounter that is withheld by policy (an unclassified contained resource): never trusted evidence.
    encounter('enc-w', 'pat-a', { contained: [{ resourceType: 'Basic', id: 'b1', code: { text: 'synthetic' } }] }),
    observation('obs-a1', 'pat-a', { encounter: { reference: 'Encounter/enc-a' } }),
    observation('obs-a2', 'pat-a', { encounter: { reference: 'Encounter/enc-c' }, derivedFrom: [{ reference: 'Observation/obs-a1' }] }),
    observation('obs-a3', 'pat-a', { encounter: { reference: 'Encounter/enc-w' } }),
    observation('obs-b1', 'pat-b', { encounter: { reference: 'Encounter/enc-b' } }),
    // Another patient's record that points at the bound patient's encounter: a leaky source may return it.
    observation('obs-b9', 'pat-b', { encounter: { reference: 'Encounter/enc-a' } }),
    { resourceType: 'Medication', id: 'med-1', code: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '1000001' }] } },
    { resourceType: 'Medication', id: 'med-2', code: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '1000002' }] } },
  ];
}
const FIELDS: Record<string, string> = { patient: 'subject', subject: 'subject', encounter: 'encounter', 'derived-from': 'derivedFrom', 'part-of': 'partOf' };
const refsOf = (resource: R, field: string): string[] => {
  const value = resource[field];
  return (Array.isArray(value) ? value : value ? [value] : []).map((item: R) => item?.reference).filter((ref: unknown): ref is string => typeof ref === 'string');
};
const TYPES = ['Patient', 'Encounter', 'Observation', 'Medication'];

interface SourceOptions { leaky?: boolean; paginate?: boolean; records?: R[] }
async function startSource(t: TestContext, options: SourceOptions = {}) {
  const db = options.records ?? dataset();
  const requests: URL[] = [];
  const state = { software: 'reference-search synthetic source', holdNextRead: false, held: [] as (() => void)[] };
  let base = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url!, base);
    requests.push(url);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname === '/fhir/metadata') {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', status: 'active', kind: 'instance', fhirVersion: '4.0.1', format: ['json'],
        software: { name: state.software },
        rest: [{ mode: 'server', resource: TYPES.map(type => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: declarations(type) })) }] }));
      return;
    }
    const parts = url.pathname.replace(/^\/fhir\//, '').split('/');
    if (parts.length === 2) {
      const found = db.find(r => r.resourceType === parts[0] && r.id === parts[1]);
      if (!found) { res.statusCode = 404; res.end(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] })); return; }
      if (state.holdNextRead) { state.holdNextRead = false; state.held.push(() => res.end(JSON.stringify(found))); return; }
      res.end(JSON.stringify(found)); return;
    }
    const type = parts[0]!;
    let selected = db.filter(r => r.resourceType === type);
    for (const [name, value] of url.searchParams) {
      if (['_count', '_sort', '_offset'].includes(name)) continue;
      if (options.leaky && (name === 'patient' || name === 'subject')) continue;
      const alternatives = value.split(',');
      if (name === '_id') { selected = selected.filter(r => alternatives.includes(r.id)); continue; }
      const field = FIELDS[name];
      if (field) selected = selected.filter(r => refsOf(r, field).some(ref => alternatives.includes(ref)));
    }
    const offset = Number(url.searchParams.get('_offset') ?? 0);
    const count = Number(url.searchParams.get('_count') ?? 20);
    const page = options.paginate ? selected.slice(offset, offset + 1) : selected;
    const next = new URL(url.href); next.searchParams.set('_offset', String(offset + 1));
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset',
      link: [{ relation: 'self', url: url.href }, ...(options.paginate && offset + 1 < selected.length && count > 0 ? [{ relation: 'next', url: next.href }] : [])],
      entry: page.map(resource => ({ resource, search: { mode: 'match' } })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/fhir/`;
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { base, requests, state, clinical: () => requests.filter(url => !url.pathname.endsWith('/metadata')), searches: () => requests.filter(url => !url.pathname.endsWith('/metadata') && url.pathname.split('/').length === 3) };
}
const output = { format: 'fhir', max_bytes: 24576 } as const;
async function gatewayFor(t: TestContext, options: SourceOptions = {}, extra: R = {}) {
  const source = await startSource(t, options);
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'reference-search', baseUrl: source.base }, patientId: A, contextId: 'reference-search-context', ...extra });
  t.after(() => gateway.close());
  const search = (resource_type: string, params: Pair[], page_size?: number) => gateway.execute('fhir_search', { resource_type, params, output, ...(page_size ? { page_size } : {}) });
  const read = (resource_type: string, id: string) => gateway.execute('fhir_read', { resource_type, id, interaction: 'read', output });
  return { ...source, gateway, search, read };
}
const ids = (envelope: GatewayEnvelope) => ((envelope.data as { resources?: R[] }).resources ?? []).map(r => r.id);
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, child) => {
  if (['request_id', 'elapsed_ms', 'bytes_returned', 'wire_bytes', 'retrieved_at', 'expires_at', 'handle', 'cursor', 'next_cursor'].includes(key)) return '<generated>';
  if (typeof child === 'string' && key === 'text') { try { return normalize(JSON.parse(child)); } catch { return child; } }
  return child;
}));

const sentSince = (f: { clinical: () => URL[] }, before: number) => f.clinical().slice(before).map(url => `${url.pathname}?${url.searchParams}`);
const CHECK = (type: string, id: string) => `/fhir/${type}?_id=${id}&patient=Patient%2F${A}&_count=1`;

test('B1 gateway: a target not yet shown is checked by a confined search first; the original search follows only for an own record', async t => {
  const f = await gatewayFor(t);
  const scoped = await f.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-a' }]);
  assert.equal(scoped.error, undefined, JSON.stringify(scoped.error));
  assert.deepEqual(ids(scoped), ['obs-a1']);
  assert.deepEqual(sentSince(f, 0), [CHECK('Encounter', 'enc-a'), `/fhir/Observation?encounter=Encounter%2Fenc-a&patient=Patient%2F${A}&_count=20`]);
  assert.deepEqual(((scoped.data as { resources?: R[] }).resources ?? []).map(r => r.resourceType), ['Observation'], 'the confined check delivers nothing to the agent');
  // The confirmed target is now trusted: the next search sends no further check.
  const before = f.clinical().length;
  assert.equal((await f.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-a' }])).error, undefined);
  assert.deepEqual(sentSince(f, before), [`/fhir/Observation?encounter=Encounter%2Fenc-a&patient=Patient%2F${A}&_count=20`]);
});

test('B1 gateway: after an own encounter is delivered by search, an encounter-scoped search is confined and returns only own records', async t => {
  const f = await gatewayFor(t);
  const encounters = await f.search('Encounter', []);
  assert.equal(encounters.error, undefined);
  assert.deepEqual(ids(encounters).sort(), ['enc-a', 'enc-c']);
  const before = f.clinical().length;
  const scoped = await f.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-a' }]);
  assert.equal(scoped.error, undefined, JSON.stringify(scoped.error));
  assert.deepEqual(ids(scoped), ['obs-a1']);
  assert.equal(f.clinical().length, before + 1, 'exactly one search and no target read');
  const sent = f.clinical().at(-1)!;
  assert.equal(sent.pathname, '/fhir/Observation');
  assert.deepEqual([...sent.searchParams], [['encounter', 'Encounter/enc-a'], ['patient', `Patient/${A}`], ['_count', '20']]);
  // The B1 constraint is not gateway-enforced, so the result never claims a verified filter on it.
  const constraint = scoped.coverage.constraints?.find(entry => entry.name === 'encounter') as R | undefined;
  assert.ok(constraint, 'the encounter constraint is reported');
  assert.equal(constraint.execution, 'unknown');
  assert.notEqual(scoped.coverage.state, 'complete_for_query', 'an unproven reference filter is never reported complete');
  // An OR list of two delivered own encounters, and a derived-from target delivered by the first search.
  const both = await f.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-a,Encounter/enc-c' }]);
  assert.equal(both.error, undefined); assert.deepEqual(ids(both).sort(), ['obs-a1', 'obs-a2']);
  const derived = await f.search('Observation', [{ name: 'derived-from', value: 'Observation/obs-a1' }]);
  assert.equal(derived.error, undefined); assert.deepEqual(ids(derived), ['obs-a2']);
});

test('B1 gateway: an own encounter delivered by read is trusted; a foreign or missing read never is', async t => {
  const f = await gatewayFor(t);
  assert.equal((await f.read('Encounter', 'enc-a')).error, undefined);
  assert.equal((await f.read('Encounter', 'enc-b')).error?.code, 'NOT_FOUND');
  assert.equal((await f.read('Encounter', 'enc-zz')).error?.code, 'NOT_FOUND');
  const own = await f.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-a' }]);
  assert.equal(own.error, undefined); assert.deepEqual(ids(own), ['obs-a1']);
  const before = f.searches().length;
  const foreign = await f.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-b' }]);
  const missing = await f.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-zz' }]);
  assert.equal(foreign.error?.code, 'POLICY_DENIED');
  assert.deepEqual(normalize(f.gateway.toToolResult(foreign)), normalize(f.gateway.toToolResult(missing)), 'foreign and missing targets are publicly identical');
  // Each costs one confined check; the Observation search is never sent.
  assert.deepEqual(f.searches().slice(before).map(url => `${url.pathname}?${url.searchParams}`), [CHECK('Encounter', 'enc-b'), CHECK('Encounter', 'enc-zz')]);
});

test('B1 gateway (XRF-01 mirror with Encounter read advertised): foreign and missing targets give equal envelopes and never send the search', async t => {
  // The isolation backend does not advertise Encounter. Here Encounter read and search are advertised and the bound
  // patient's own encounter has been delivered. Each unconfirmed target costs exactly one confined check, and the
  // Observation search never reaches the source.
  for (const [value, unconfirmed] of [['Encounter/enc-b', 'enc-b'], ['Encounter/enc-zz', 'enc-zz'], ['Encounter/enc-a,Encounter/enc-b', 'enc-b'], ['Encounter/enc-a,Encounter/enc-zz', 'enc-zz']] as const) {
    const f = await gatewayFor(t);
    assert.deepEqual(ids(await f.search('Encounter', [])).sort(), ['enc-a', 'enc-c']);
    const before = f.clinical().length;
    const probe = await f.search('Observation', [{ name: 'encounter', value }]);
    assert.equal(probe.error?.code, 'POLICY_DENIED', value);
    assert.deepEqual(sentSince(f, before), [CHECK('Encounter', unconfirmed)], value);
    const reference = await gatewayFor(t);
    await reference.search('Encounter', []);
    const missing = await reference.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-never' }]);
    assert.deepEqual(normalize(f.gateway.toToolResult(probe)), normalize(reference.gateway.toToolResult(missing)), value);
  }
});

test('B1 gateway: an own record withheld by policy is not trusted evidence', async t => {
  const f = await gatewayFor(t);
  const encounters = await f.search('Encounter', []);
  assert.equal(encounters.coverage.reasons?.includes('RECORDS_WITHHELD_BY_POLICY'), true, 'enc-w is withheld with the signal');
  assert.equal(ids(encounters).includes('enc-w'), false);
  assert.equal((await f.read('Encounter', 'enc-w')).error?.code, 'NOT_FOUND');
  const before = f.clinical().length;
  assert.equal((await f.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-w' }])).error?.code, 'POLICY_DENIED');
  assert.deepEqual(sentSince(f, before), [CHECK('Encounter', 'enc-w')], 'the confined check finds it withheld; the search is never sent');
});

test('B1 gateway: a leaky source that ignores the patient pair still delivers only the bound patient\'s records', async t => {
  const f = await gatewayFor(t, { leaky: true });
  await f.read('Encounter', 'enc-a');
  const scoped = await f.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-a' }]);
  assert.equal(scoped.error, undefined);
  assert.deepEqual(ids(scoped), ['obs-a1'], 'obs-b9 (another patient, same encounter reference) is dropped');
  assert.equal(scoped.coverage.reasons?.includes('RECORDS_WITHHELD_BY_POLICY') ?? false, false, 'another patient\'s record is dropped silently');
  assert.equal(JSON.stringify(scoped).includes('obs-b9'), false);
  assert.equal(JSON.stringify(scoped).includes('pat-b'), false);
});

test('B1 gateway: continuation pages need no further evidence or reads', async t => {
  const records = [...dataset(), observation('obs-a4', 'pat-a', { encounter: { reference: 'Encounter/enc-a' } }), observation('obs-a5', 'pat-a', { encounter: { reference: 'Encounter/enc-a' } })];
  const f = await gatewayFor(t, { paginate: true, records });
  assert.equal((await f.read('Encounter', 'enc-a')).error, undefined);
  const first = await f.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-a' }], 1);
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  const seen = [...ids(first)];
  let cursor = first.pagination?.next_cursor;
  while (cursor) {
    const reads = f.clinical().filter(url => url.pathname.split('/').length === 4).length;
    const page = await f.gateway.execute('fhir_page', { cursor, output });
    assert.equal(page.error, undefined, JSON.stringify(page.error));
    assert.equal(f.clinical().filter(url => url.pathname.split('/').length === 4).length, reads, 'no target read on a continuation');
    seen.push(...ids(page));
    cursor = page.pagination?.next_cursor;
  }
  assert.deepEqual(seen.sort(), ['obs-a1', 'obs-a4', 'obs-a5']);
});

test('B1 gateway: trusted evidence is cleared at the state boundary that clears retained results', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await gatewayFor(t, {}, { discovery: { metadataTtlMs: 60_000 } });
  assert.equal((await f.read('Encounter', 'enc-a')).error, undefined);
  assert.equal((await f.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-a' }])).error, undefined);
  // The source identity changes; the next call refreshes metadata after the TTL and invalidates retained state.
  f.state.software = 'reference-search synthetic source, changed';
  now += 61_000;
  const before = f.clinical().length;
  const after = await f.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-a' }]);
  assert.equal(after.error, undefined, JSON.stringify(after.error));
  // The cleared target is confirmed again by a confined check before the search is sent.
  assert.deepEqual(sentSince(f, before), [CHECK('Encounter', 'enc-a'), `/fhir/Observation?encounter=Encounter%2Fenc-a&patient=Patient%2F${A}&_count=20`]);
});

test('B1 gateway: a read that straddles a state boundary records no trusted evidence', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await gatewayFor(t, {}, { discovery: { metadataTtlMs: 60_000 } });
  assert.equal((await f.gateway.execute('fhir_capabilities', { topic: 'server' })).error, undefined);
  f.state.holdNextRead = true;
  const pending = f.read('Encounter', 'enc-a');
  await new Promise<void>(resolve => { const poll = () => f.state.held.length ? resolve() : setTimeout(poll, 5); poll(); });
  // While the read is in flight, the source identity changes and a metadata refresh invalidates retained state.
  f.state.software = 'reference-search synthetic source, changed';
  now += 61_000;
  assert.equal((await f.gateway.execute('fhir_capabilities', { topic: 'server' })).error, undefined);
  f.state.held.shift()!();
  const stale = await pending;
  assert.equal(stale.error?.code, 'CONNECTION_REQUIRED', 'the stale read publishes nothing');
  const before = f.clinical().length;
  assert.equal((await f.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-a' }])).error, undefined);
  // The stale read recorded nothing, so the target is confirmed by a confined check before the search is sent.
  assert.deepEqual(sentSince(f, before), [CHECK('Encounter', 'enc-a'), `/fhir/Observation?encounter=Encounter%2Fenc-a&patient=Patient%2F${A}&_count=20`]);
});

test('B2 gateway: `_id` OR lists are sent once-encoded and re-authorized; malformed lists never send', async t => {
  const f = await gatewayFor(t);
  const own = await f.search('Observation', [{ name: '_id', value: 'obs-a1,obs-a2,obs-b1' }]);
  assert.equal(own.error, undefined);
  assert.deepEqual(ids(own).sort(), ['obs-a1', 'obs-a2']);
  const sent = f.clinical().at(-1)!;
  assert.deepEqual([...sent.searchParams], [['_id', 'obs-a1,obs-a2,obs-b1'], ['patient', `Patient/${A}`], ['_count', '20']]);
  assert.ok(sent.search.includes('_id=obs-a1%2Cobs-a2%2Cobs-b1'));
  const shared = await f.search('Medication', [{ name: '_id', value: 'med-1,med-2,med-9' }]);
  assert.equal(shared.error, undefined);
  assert.deepEqual(ids(shared).sort(), ['med-1', 'med-2']);
  assert.deepEqual([...f.clinical().at(-1)!.searchParams], [['_id', 'med-1,med-2,med-9'], ['_count', '20']]);
  // `_id` lists take up to 100 ids.
  const max = Array.from({ length: 100 }, (_, i) => `med-${i}`).join(',');
  assert.equal((await f.search('Medication', [{ name: '_id', value: max }])).error, undefined);
  for (const value of ['a|b', 'a,,b', '..', 'a\\,b', '', `${max},med-100`]) {
    const before = f.clinical().length;
    const result = await f.search('Medication', [{ name: '_id', value }]);
    assert.equal(result.error?.code, 'INVALID_ARGUMENTS', value);
    assert.equal(f.clinical().length, before, value);
  }
  const before = f.clinical().length;
  assert.equal((await f.search('Patient', [{ name: '_id', value: `${A},${A}` }])).error?.code, 'POLICY_DENIED');
  assert.equal((await f.search('Patient', [{ name: '_id', value: `${A},pat-b` }])).error?.code, 'POLICY_DENIED');
  assert.equal(f.clinical().length, before);
});

// ---------------------------------------------------------------------------------------------------------------
// Real MCP SDK stdio, both protocol eras.
// ---------------------------------------------------------------------------------------------------------------

for (const era of ['modern', 'legacy'] as const) test(`B1/B2 stdio ${era}: encounter-scoped search after delivery; foreign targets and bad _id lists never send`, async t => {
  const source = await startSource(t);
  const dir = await mkdtemp(join(tmpdir(), 'w1b1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ mode: 'synthetic', source: { alias: 'reference-search', baseUrl: source.base }, patientId: A }));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'packages/server/src/cli.ts', '--config', config],
    env: { ...getDefaultEnvironment(), TMPDIR: tmpdir() }, stderr: 'pipe' });
  const client = new Client({ name: 'reference-search', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  await client.connect(transport);
  t.after(() => client.close());
  const call = async (name: string, args: R) => (await client.callTool({ name, arguments: { ...args, output } })).structuredContent as GatewayEnvelope;
  // An own target not yet shown is confirmed by a confined check, then the search is sent.
  const before = source.clinical().length;
  const first = await call('fhir_search', { resource_type: 'Observation', params: [{ name: 'encounter', value: 'Encounter/enc-a' }] });
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  assert.deepEqual(sentSince(source, before), [CHECK('Encounter', 'enc-a'), `/fhir/Observation?encounter=Encounter%2Fenc-a&patient=Patient%2F${A}&_count=20`]);
  const encounters = await call('fhir_search', { resource_type: 'Encounter', params: [] });
  assert.deepEqual(ids(encounters).sort(), ['enc-a', 'enc-c']);
  const scoped = await call('fhir_search', { resource_type: 'Observation', params: [{ name: 'encounter', value: 'Encounter/enc-a' }] });
  assert.equal(scoped.error, undefined, JSON.stringify(scoped.error));
  assert.deepEqual(ids(scoped), ['obs-a1']);
  assert.deepEqual([...source.clinical().at(-1)!.searchParams], [['encounter', 'Encounter/enc-a'], ['patient', `Patient/${A}`], ['_count', '20']]);
  for (const [value, unconfirmed] of [['Encounter/enc-b', 'enc-b'], ['Encounter/enc-zz', 'enc-zz'], ['Encounter/enc-a,Encounter/enc-b', 'enc-b']] as const) {
    const count = source.clinical().length;
    assert.equal((await call('fhir_search', { resource_type: 'Observation', params: [{ name: 'encounter', value }] })).error?.code, 'POLICY_DENIED', value);
    assert.deepEqual(sentSince(source, count), [CHECK('Encounter', unconfirmed)], value);
  }
  const list = await call('fhir_search', { resource_type: 'Observation', params: [{ name: '_id', value: 'obs-a1,obs-b1' }] });
  assert.deepEqual(ids(list), ['obs-a1']);
  const count = source.clinical().length;
  assert.equal((await call('fhir_search', { resource_type: 'Observation', params: [{ name: '_id', value: 'obs-a1|x' }] })).error?.code, 'INVALID_ARGUMENTS');
  assert.equal(source.clinical().length, count);
});
