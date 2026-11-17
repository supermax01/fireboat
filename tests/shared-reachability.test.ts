// Shared-directory reachability. Practitioner, Organization and Location are delivered only when
// reachable: named by a literal same-source reference in a record already delivered in this context for the bound patient,
// read from that record exactly as delivered (after withholding, redaction and output.fields selection, contained resources
// included). An unreachable read is the uniform NOT_FOUND with no request; a directory search is `_id` alone on reachable ids,
// and anything else is one POLICY_DENIED before sending. Synthetic, hand-written records only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { FhirGateway, type GatewayEnvelope } from '../packages/core/src/index.js';
import { DIRECTORY_TYPES, deliveredDirectoryReferences, isDirectoryType, sanitize } from '../packages/core/src/privacy.js';
import { assertDirectorySearchAdmitted, resolveSearchParameters, validateSearchAdmission } from '../packages/core/src/search-parameters.js';
import { VerifiedTargetLedger } from '../packages/core/src/store.js';
import { DIRECTORY_REACHABILITY_LIMITATION } from '../packages/core/src/support.js';
import catalog from '../packages/core/src/generated/r4-search-parameters.json' with { type: 'json' };

type R = Record<string, any>;
type Pair = { name: string; value: string };
const A = 'pat-a', B = 'pat-b';
const base = new URL('http://127.0.0.1:4321/fhir/');
const rxnorm = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const facility = { physicalType: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/location-physical-type', code: 'bu' }] } };
const practitioner = (id: string): R => ({ resourceType: 'Practitioner', id, active: true, name: [{ family: `Synthetic ${id}` }] });
const organization = (id: string, extra: R = {}): R => ({ resourceType: 'Organization', id, active: true, name: `Synthetic ${id}`, ...extra });
const location = (id: string, extra: R = {}): R => ({ resourceType: 'Location', id, status: 'active', name: `Synthetic ${id}`, ...facility, ...extra });
const encounter = (id: string, patient: string, extra: R = {}): R => ({ resourceType: 'Encounter', id, status: 'finished',
  class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }, subject: { reference: `Patient/${patient}` }, ...extra });
const observation = (id: string, patient: string, extra: R = {}): R => ({ resourceType: 'Observation', id, status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '1111-1' }] }, subject: { reference: `Patient/${patient}` }, ...extra });

// ---------------------------------------------------------------------------------------------------------------
// Unit: the two pure halves of the rule.
// ---------------------------------------------------------------------------------------------------------------

const keys = (resource: R) => deliveredDirectoryReferences(resource as never, base).map(key => `${key.type}/${key.id}`).sort();

test('reachability: an own record grants its literal same-source directory references, contained resources included', () => {
  assert.deepEqual([...DIRECTORY_TYPES].sort(), ['Location', 'Organization', 'Practitioner']);
  assert.equal(isDirectoryType('Medication'), false);
  const own = encounter('enc-a', A, {
    participant: [{ individual: { reference: 'Practitioner/p-1' } }, { individual: { reference: `${base.href}Practitioner/p-abs` } }, { individual: { reference: 'Practitioner/p-v/_history/2' } }],
    serviceProvider: { reference: 'Organization/o-1' }, location: [{ location: { reference: 'Location/l-1' } }],
    extension: [{ url: 'urn:synthetic:site', valueReference: { reference: 'Organization/o-ext' } }],
    contained: [{ resourceType: 'Medication', id: 'm-1', code: { coding: [{ system: rxnorm, code: '1' }] }, manufacturer: { reference: 'Organization/o-mfr' } }],
  });
  assert.deepEqual(keys(own), ['Location/l-1', 'Organization/o-1', 'Organization/o-ext', 'Organization/o-mfr', 'Practitioner/p-1', 'Practitioner/p-abs', 'Practitioner/p-v']);
  // The bound Patient's own record grants too (Patient is patient-linked).
  assert.deepEqual(keys({ resourceType: 'Patient', id: A, generalPractitioner: [{ reference: 'Practitioner/p-gp' }], managingOrganization: { reference: 'Organization/o-m' } }), ['Organization/o-m', 'Practitioner/p-gp']);
});

test('reachability: display-only, identifier-only, local, logical and foreign references grant nothing', () => {
  const own = encounter('enc-a', A, { participant: [
    { individual: { display: 'Synthetic display-only clinician' } },
    { individual: { identifier: { system: 'urn:synthetic:staff', value: 'p-ident' } } },
    { individual: { type: 'Practitioner', identifier: { system: 'urn:synthetic:staff', value: 'p-typed' } } },
    { individual: { reference: '#p-local' } },
    { individual: { reference: 'Practitioner?identifier=urn:synthetic:staff|p-cond' } },
    { individual: { reference: 'urn:uuid:5b1f2c3d-0000-4000-8000-000000000001' } },
    { individual: { reference: 'http://other.example.invalid/fhir/Practitioner/p-foreign-source' } },
    { individual: { reference: 'Practitioner/p-mismatch', type: 'Organization' } },
    { individual: { reference: 'PractitionerRole/pr-1' } },
    { individual: { reference: 'Practitioner/..' } },
  ] });
  assert.deepEqual(keys(own), []);
});

test('reachability: no chains; a shared root or a contained directory record grants nothing', () => {
  // A delivered directory record's own references never extend reachability.
  assert.deepEqual(keys(location('l-1', { managingOrganization: { reference: 'Organization/o-parent' }, partOf: { reference: 'Location/l-parent' } })), []);
  assert.deepEqual(keys(organization('o-1', { partOf: { reference: 'Organization/o-parent' } })), []);
  // A shared catalog root (Medication searched source-wide) is not a record for the bound patient.
  assert.deepEqual(keys({ resourceType: 'Medication', id: 'm-1', manufacturer: { reference: 'Organization/o-mfr' } }), []);
  // A contained directory record inside an own record: the reference to it is local, and its own references never count.
  assert.deepEqual(keys(encounter('enc-a', A, { location: [{ location: { reference: '#c-loc' } }],
    contained: [location('c-loc', { managingOrganization: { reference: 'Organization/o-chain' } })] })), []);
});

test('reachability: a reference withheld by sanitize is absent from the delivered record and grants nothing', () => {
  // Device extensions are withheld at every depth (UNREVIEWED_EXTENSION_WITHHELD); Device.owner is delivered.
  const device = { resourceType: 'Device', id: 'dev-a', patient: { reference: `Patient/${A}` }, owner: { reference: 'Organization/o-owner' },
    extension: [{ url: 'urn:synthetic:site', valueReference: { reference: 'Organization/o-ext' } }] };
  const delivered = sanitize(device as never);
  assert.ok(delivered.manifests.some(item => item.reason === 'UNREVIEWED_EXTENSION_WITHHELD'));
  assert.deepEqual(keys(delivered.resource), ['Organization/o-owner']);
});

const declarations = (type: string) => [
  { name: '_id', type: 'token', source_description_present: false },
  ...catalog.definitions.filter(d => d.base.includes(type)).map(d => ({ name: d.code, type: d.type, source_description_present: false })),
];
const reachableIds = new Set(['Practitioner/p-1', 'Practitioner/p-2', 'Organization/o-1', 'Location/l-1']);
const reachable = (type: string, id: string) => reachableIds.has(`${type}/${id}`);

test('directory admission: `_id` alone on reachable ids is admitted; everything else is one POLICY_DENIED', () => {
  const resolvedFor = (type: string) => resolveSearchParameters({ resourceType: type, declared: declarations(type), advertised: true });
  const admit = (type: string, pairs: Pair[], sort: string[] = []) =>
    validateSearchAdmission({ resourceType: type, pairs, resolved: resolvedFor(type), patientId: A, sort, reachable });
  for (const [type, id] of [['Practitioner', 'p-1'], ['Practitioner', 'p-1,p-2'], ['Organization', 'o-1'], ['Location', 'l-1']] as const) assert.doesNotThrow(() => admit(type, [{ name: '_id', value: id }]), `${type} ${id}`);
  const refused: [string, Pair[], string[]?][] = [
    // No `_id` at all.
    ['Practitioner', []], ['Organization', []], ['Location', []],
    ['Practitioner', [{ name: '_lastUpdated', value: 'gt2000-01-01' }]],
    ['Practitioner', [{ name: 'name', value: 'Synthetic' }]], ['Organization', [{ name: 'name', value: 'Synthetic' }]],
    ['Location', [{ name: 'address', value: '42' }]], ['Practitioner', [{ name: 'identifier', value: 'urn:synthetic:staff|p-1' }]],
    // An unreachable id, alone or beside a reachable one, in any position.
    ['Practitioner', [{ name: '_id', value: 'p-free' }]], ['Practitioner', [{ name: '_id', value: 'p-1,p-free' }]], ['Practitioner', [{ name: '_id', value: 'p-free,p-1' }]],
    ['Organization', [{ name: '_id', value: 'p-1' }]],
    // Another predicate or a sort beside `_id`, even on reachable ids.
    ['Practitioner', [{ name: '_id', value: 'p-1' }, { name: '_lastUpdated', value: 'gt2000-01-01' }]],
    ['Practitioner', [{ name: '_id', value: 'p-1' }, { name: '_id', value: 'p-2' }]],
    ['Location', [{ name: '_id', value: 'l-1' }, { name: 'address', value: '42' }]],
    ['Practitioner', [{ name: '_id', value: 'p-1' }], ['_lastUpdated']],
  ];
  for (const [type, pairs, sort] of refused) assert.throws(() => admit(type, pairs, sort), { code: 'POLICY_DENIED' }, `${type} ${JSON.stringify(pairs)} ${JSON.stringify(sort)}`);
  // Without trusted evidence nothing is reachable.
  assert.throws(() => validateSearchAdmission({ resourceType: 'Practitioner', pairs: [{ name: '_id', value: 'p-1' }], resolved: resolvedFor('Practitioner'), patientId: A }), { code: 'POLICY_DENIED' });
  // Catalog types are unaffected.
  assert.doesNotThrow(() => assertDirectorySearchAdmitted({ resourceType: 'Medication', pairs: [] }));
  assert.doesNotThrow(() => admit('Medication', [{ name: 'code', value: `${rxnorm}|1` }]));
});

test('reachability ledger: one structure with own-record keys; separate kinds, one bound, one reset', () => {
  const ledger = new VerifiedTargetLedger(3);
  ledger.add('Encounter', 'e1');
  ledger.addReachable('Practitioner', 'p-1');
  assert.equal(ledger.reachable('Practitioner', 'p-1'), true);
  assert.equal(ledger.has('Practitioner', 'p-1'), false, 'a reachable key is not own-record evidence');
  assert.equal(ledger.reachable('Encounter', 'e1'), false, 'an own-record key is not reachability');
  ledger.clear();
  assert.equal(ledger.reachable('Practitioner', 'p-1'), false, 'one reset clears reachability too');
  assert.equal(ledger.size, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// Gateway: an inline loopback source with honest search semantics (optionally ignoring filters).
// ---------------------------------------------------------------------------------------------------------------

function dataset(): R[] {
  return [
    { resourceType: 'Patient', id: A, active: true }, { resourceType: 'Patient', id: B, active: true },
    encounter('enc-a', A, {
      participant: [{ individual: { reference: 'Practitioner/p-own' } }, { individual: { display: 'Synthetic display-only clinician' } },
        { individual: { identifier: { system: 'urn:synthetic:staff', value: 'p-ident' } } }],
      serviceProvider: { reference: 'Organization/o-own' },
      location: [{ location: { reference: 'Location/l-own' } }, { location: { reference: '#c-loc' } }],
      contained: [location('c-loc', { managingOrganization: { reference: 'Organization/o-chain-contained' } })],
    }),
    encounter('enc-b', B, { participant: [{ individual: { reference: 'Practitioner/p-foreign' } }], serviceProvider: { reference: 'Organization/o-foreign' } }),
    // Silently dropped: it names another patient as a performer (other-patient evidence), so its Practitioner grants nothing.
    observation('obs-drop', A, { performer: [{ reference: 'Practitioner/p-drop' }, { reference: `Patient/${B}` }] }),
    observation('obs-fields', A, { performer: [{ reference: 'Practitioner/p-fields' }] }),
    { resourceType: 'Device', id: 'dev-a', status: 'active', patient: { reference: `Patient/${A}` }, owner: { reference: 'Organization/o-dev-owner' },
      extension: [{ url: 'urn:synthetic:site', valueReference: { reference: 'Organization/o-ext' } }] },
    { resourceType: 'MedicationRequest', id: 'mr-a', status: 'active', intent: 'order', subject: { reference: `Patient/${A}` }, medicationReference: { reference: '#med-c' },
      contained: [{ resourceType: 'Medication', id: 'med-c', code: { coding: [{ system: rxnorm, code: '1000001' }] }, manufacturer: { reference: 'Organization/o-mfr' } }] },
    { resourceType: 'Medication', id: 'med-root', code: { coding: [{ system: rxnorm, code: '1000002' }] }, manufacturer: { reference: 'Organization/o-med-root' } },
    ...['p-own', 'p-ident', 'p-foreign', 'p-drop', 'p-fields', 'p-free'].map(practitioner),
    ...['o-own', 'o-foreign', 'o-ext', 'o-dev-owner', 'o-mfr', 'o-med-root', 'o-parent', 'o-chain-contained', 'o-free'].map(id => organization(id)),
    location('l-own', { managingOrganization: { reference: 'Organization/o-parent' }, partOf: { reference: 'Location/l-parent' } }), location('l-parent'), location('l-free'),
  ];
}
const FIELDS: Record<string, string> = { patient: 'subject', subject: 'subject' };
const TYPES = ['Patient', 'Encounter', 'Observation', 'Device', 'MedicationRequest', 'Medication', 'Practitioner', 'Organization', 'Location'];
interface SourceOptions { records?: R[]; leaky?: boolean }
async function startSource(t: TestContext, options: SourceOptions = {}) {
  const db = options.records ?? dataset();
  const requests: URL[] = [];
  const state = { software: 'reachability synthetic source' };
  let baseUrl = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url!, baseUrl);
    requests.push(url);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname === '/fhir/metadata') {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', status: 'active', kind: 'instance', fhirVersion: '4.0.1', format: ['json'], software: { name: state.software },
        rest: [{ mode: 'server', resource: TYPES.map(type => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: declarations(type) })) }] }));
      return;
    }
    const parts = url.pathname.replace(/^\/fhir\//, '').split('/');
    if (parts.length === 2) {
      const found = db.find(r => r.resourceType === parts[0] && r.id === parts[1]);
      if (!found) { res.statusCode = 404; res.end(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] })); return; }
      res.end(JSON.stringify(found)); return;
    }
    let selected = db.filter(r => r.resourceType === parts[0]);
    for (const [name, value] of url.searchParams) {
      if (['_count', '_sort'].includes(name) || options.leaky) continue;
      const alternatives = value.split(',');
      if (name === '_id') { selected = selected.filter(r => alternatives.includes(r.id)); continue; }
      const field = FIELDS[name];
      if (field) selected = selected.filter(r => alternatives.includes(r[field]?.reference) || alternatives.includes(r.patient?.reference));
    }
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }], entry: selected.map(resource => ({ resource, search: { mode: 'match' } })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/fhir/`;
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const clinical = () => requests.filter(url => !url.pathname.endsWith('/metadata'));
  return { base: baseUrl, requests, state, db, clinical, sentSince: (before: number) => clinical().slice(before).map(url => `${url.pathname}?${url.searchParams}`) };
}
const output = { format: 'fhir', max_bytes: 24576 } as const;
async function gatewayFor(t: TestContext, options: SourceOptions = {}, extra: R = {}) {
  const source = await startSource(t, options);
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'reach', baseUrl: source.base }, patientId: A, contextId: 'reach-context', ...extra });
  t.after(() => gateway.close());
  const search = (resource_type: string, params: Pair[], out: R = output) => gateway.execute('fhir_search', { resource_type, params, output: out });
  const read = (resource_type: string, id: string, out: R = output) => gateway.execute('fhir_read', { resource_type, id, interaction: 'read', output: out });
  // Warm metadata so that "nothing sent" below is total, not only clinical.
  assert.equal((await gateway.execute('fhir_capabilities', { topic: 'server' })).error, undefined);
  return { ...source, gateway, search, read };
}
const ids = (envelope: GatewayEnvelope) => ((envelope.data as { resources?: R[] }).resources ?? []).map(r => r.id);
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, child) => {
  if (['request_id', 'elapsed_ms', 'bytes_returned', 'wire_bytes', 'retrieved_at', 'expires_at', 'handle', 'cursor', 'next_cursor', 'captured_at'].includes(key)) return '<generated>';
  if (typeof child === 'string' && key === 'text') { try { return normalize(JSON.parse(child)); } catch { return child; } }
  return child;
}));
type Gateway = Awaited<ReturnType<typeof gatewayFor>>;
/** An unreachable read: the uniform NOT_FOUND, no upstream request of any kind, and no upstream call counted. */
async function unreachableRead(f: Gateway, type: string, id: string, label = `${type}/${id}`) {
  const before = f.requests.length;
  const result = await f.read(type, id);
  assert.equal(result.error?.code, 'NOT_FOUND', label);
  assert.equal(f.requests.length, before, `${label}: nothing is sent`);
  assert.equal(result.budget.upstream_calls, 0, label);
  return result;
}
async function reachableRead(f: Gateway, type: string, id: string) {
  const before = f.clinical().length;
  const result = await f.read(type, id);
  assert.equal(result.error, undefined, `${type}/${id}: ${JSON.stringify(result.error)}`);
  assert.deepEqual(ids(result), [id]);
  assert.deepEqual(f.sentSince(before), [`/fhir/${type}/${id}?`]);
  return result;
}

test('reachability gateway: gained only from delivered literal references, including inside contained resources', async t => {
  const f = await gatewayFor(t);
  for (const [type, id] of [['Practitioner', 'p-own'], ['Organization', 'o-own'], ['Location', 'l-own'], ['Organization', 'o-mfr'], ['Organization', 'o-dev-owner']] as const) await unreachableRead(f, type, id, `${type}/${id} before delivery`);
  assert.equal((await f.read('Encounter', 'enc-a')).error, undefined);
  for (const [type, id] of [['Practitioner', 'p-own'], ['Organization', 'o-own'], ['Location', 'l-own']] as const) await reachableRead(f, type, id);
  // The manufacturer of a Medication contained in an own MedicationRequest.
  assert.deepEqual(ids(await f.search('MedicationRequest', [])), ['mr-a']);
  await reachableRead(f, 'Organization', 'o-mfr');
  assert.equal((await f.read('Device', 'dev-a')).error, undefined);
  await reachableRead(f, 'Organization', 'o-dev-owner');
  // A reachable id that does not exist costs exactly one read and is the same NOT_FOUND.
  const records = dataset().filter(r => !(r.resourceType === 'Practitioner' && r.id === 'p-own'));
  const g = await gatewayFor(t, { records });
  assert.equal((await g.read('Encounter', 'enc-a')).error, undefined);
  const before = g.clinical().length;
  assert.equal((await g.read('Practitioner', 'p-own')).error?.code, 'NOT_FOUND');
  assert.deepEqual(g.sentSince(before), ['/fhir/Practitioner/p-own?']);
});

test('reachability gateway: not gained from a withheld, display-only or identifier-only reference, or from a fields-excluded one', async t => {
  const f = await gatewayFor(t);
  const device = await f.read('Device', 'dev-a');
  assert.ok(device.transform.withheld_payloads.some(item => item.reason === 'UNREVIEWED_EXTENSION_WITHHELD'), 'the extension reference is withheld with a label');
  await unreachableRead(f, 'Organization', 'o-ext', 'a reference withheld by policy');
  const enc = await f.read('Encounter', 'enc-a');
  assert.ok(JSON.stringify(enc.data).includes('Synthetic display-only clinician') && JSON.stringify(enc.data).includes('p-ident'), 'display-only and identifier-only references are delivered as such');
  await unreachableRead(f, 'Practitioner', 'p-ident', 'an identifier-only reference');
  // A reference left out by output.fields was not delivered, so it grants nothing; the full record then does.
  const narrow = await f.read('Observation', 'obs-fields', { ...output, fields: ['status'] });
  assert.equal(narrow.error, undefined);
  assert.equal(JSON.stringify(narrow.data).includes('p-fields'), false);
  await unreachableRead(f, 'Practitioner', 'p-fields', 'a reference excluded by output.fields');
  assert.equal((await f.read('Observation', 'obs-fields')).error, undefined);
  await reachableRead(f, 'Practitioner', 'p-fields');
});

test('reachability gateway: a silently dropped own record grants nothing', async t => {
  const f = await gatewayFor(t);
  const page = await f.search('Observation', []);
  assert.equal(page.error, undefined);
  assert.deepEqual(ids(page), ['obs-fields'], 'obs-drop names another patient and is dropped');
  assert.equal(page.coverage.reasons.includes('RECORDS_WITHHELD_BY_POLICY'), false, 'dropped silently, with no signal');
  assert.equal((await f.read('Observation', 'obs-drop')).error?.code, 'NOT_FOUND');
  await unreachableRead(f, 'Practitioner', 'p-drop', 'the Practitioner of a silently dropped own record');
  const before = f.requests.length;
  assert.equal((await f.search('Practitioner', [{ name: '_id', value: 'p-drop' }])).error?.code, 'POLICY_DENIED');
  assert.equal(f.requests.length, before);
});

test('reachability gateway: no chains, from a delivered directory record or from a contained one', async t => {
  const f = await gatewayFor(t);
  assert.equal((await f.read('Encounter', 'enc-a')).error, undefined);
  const parent = await reachableRead(f, 'Location', 'l-own');
  assert.ok(JSON.stringify(parent.data).includes('Organization/o-parent') && JSON.stringify(parent.data).includes('Location/l-parent'), 'the delivered Location names its parents');
  await unreachableRead(f, 'Organization', 'o-parent', 'Location.managingOrganization');
  await unreachableRead(f, 'Location', 'l-parent', 'Location.partOf');
  assert.ok(JSON.stringify((await f.read('Encounter', 'enc-a')).data).includes('Organization/o-chain-contained'), 'the contained Location is delivered with the encounter');
  await unreachableRead(f, 'Organization', 'o-chain-contained', 'a contained Location\'s managingOrganization');
  // A shared catalog root delivered by a source-wide search grants nothing either.
  assert.deepEqual(ids(await f.search('Medication', [{ name: '_id', value: 'med-root' }])), ['med-root']);
  await unreachableRead(f, 'Organization', 'o-med-root', 'a source-wide Medication\'s manufacturer');
});

test('reachability gateway: an envelope that fails at its audit, the last step before commit, grants nothing', async t => {
  const f = await gatewayFor(t);
  // The next audit write throws once, after every delivery check has passed; the error path's own audit then succeeds.
  let failNext = true;
  const events = f.gateway.auditEvents as unknown as { push: (...items: unknown[]) => number };
  const push = events.push;
  events.push = function (this: unknown[], ...items: unknown[]) {
    if (failNext) { failNext = false; throw new Error('synthetic audit failure'); }
    return push.apply(this, items);
  };
  const failed = await f.read('Encounter', 'enc-a');
  assert.equal(failed.error?.code, 'INTERNAL_ERROR', 'the envelope is not delivered');
  assert.equal(failNext, false, 'the audit failure happened');
  await unreachableRead(f, 'Practitioner', 'p-own', 'a reference in an envelope that failed before commit');
  await unreachableRead(f, 'Organization', 'o-own', 'a reference in an envelope that failed before commit');
  // The same read, delivered, grants as usual.
  assert.equal((await f.read('Encounter', 'enc-a')).error, undefined);
  await reachableRead(f, 'Practitioner', 'p-own');
});

test('reachability gateway: unreachable reads are byte-identical whether the record exists or not, with zero upstream requests', async t => {
  const f = await gatewayFor(t);
  assert.equal((await f.read('Encounter', 'enc-a')).error, undefined);
  for (const [type, existing] of [['Practitioner', 'p-free'], ['Organization', 'o-free'], ['Location', 'l-free']] as const) {
    const present = await unreachableRead(f, type, existing);
    const missing = await unreachableRead(f, type, `${existing}-missing`);
    // Only the requested id differs between the two calls; the envelopes never carry it.
    assert.deepEqual(normalize(f.gateway.toToolResult(present)), normalize(f.gateway.toToolResult(missing)), type);
    assert.equal(JSON.stringify(f.gateway.toToolResult(present)).includes(existing), false);
  }
});

test('reachability gateway: a non-`_id` directory search, or one with an unreachable id, is refused uniformly with zero requests', async t => {
  const f = await gatewayFor(t);
  assert.equal((await f.read('Encounter', 'enc-a')).error, undefined);
  const refusals: unknown[] = [];
  for (const [type, own, free] of [['Practitioner', 'p-own', 'p-free'], ['Organization', 'o-own', 'o-free'], ['Location', 'l-own', 'l-free']] as const) {
    for (const params of [[], [{ name: '_lastUpdated', value: 'gt2000-01-01' }], [{ name: 'name', value: 'Synthetic' }], [{ name: 'identifier', value: 'urn:synthetic:staff|x' }],
      [{ name: '_id', value: free }], [{ name: '_id', value: `${free}-missing` }], [{ name: '_id', value: `${own},${free}` }],
      [{ name: '_id', value: own }, { name: '_lastUpdated', value: 'gt2000-01-01' }], [{ name: '_id', value: own }, { name: '_id', value: own }],
      [{ name: '_id', value: own }, { name: '_sort', value: '_lastUpdated' }]]) {
      const before = f.requests.length;
      const result = await f.search(type, params);
      assert.equal(result.error?.code, 'POLICY_DENIED', `${type} ${JSON.stringify(params)}`);
      assert.equal(f.requests.length, before, `${type} ${JSON.stringify(params)}: nothing is sent`);
      assert.equal(result.budget.upstream_calls, 0);
      refusals.push(normalize(f.gateway.toToolResult(result)));
    }
  }
  for (const other of refusals.slice(1)) assert.deepEqual(other, refusals[0], 'one envelope, whatever the type, predicate or unreachable id');
  // The same query on a reachable id goes out once, unconfined, with exactly the caller's `_id`.
  const before = f.clinical().length;
  const own = await f.search('Practitioner', [{ name: '_id', value: 'p-own' }]);
  assert.equal(own.error, undefined); assert.deepEqual(ids(own), ['p-own']);
  assert.deepEqual(f.sentSince(before), ['/fhir/Practitioner?_id=p-own&_count=20']);
});

test('reachability gateway: a reachable `_id` search and read work, and an `_id` list needs every id reachable', async t => {
  const f = await gatewayFor(t);
  assert.equal((await f.search('Encounter', [])).error, undefined);
  assert.equal((await f.read('Device', 'dev-a')).error, undefined);
  const both = await f.search('Organization', [{ name: '_id', value: 'o-own,o-dev-owner' }]);
  assert.equal(both.error, undefined, JSON.stringify(both.error));
  assert.deepEqual(ids(both).sort(), ['o-dev-owner', 'o-own']);
  assert.equal(both.coverage.constraints?.some(entry => entry.name === 'patient' || entry.name === 'subject'), false, 'directory searches carry no patient pair');
  await reachableRead(f, 'Organization', 'o-own');
  const retained = await f.gateway.execute('fhir_result', { handle: both.result!.handle, action: 'project', output });
  assert.deepEqual(ids(retained).sort(), ['o-dev-owner', 'o-own'], 'a retained result replays what was delivered');
});

test('reachability gateway: a source that ignores `_id` still delivers only reachable directory records, with no signal', async t => {
  const runFor = async (extra: R[]) => {
    const f = await gatewayFor(t, { leaky: true, records: [...dataset(), ...extra] });
    assert.equal((await f.read('Encounter', 'enc-a')).error, undefined);
    const result = await f.search('Practitioner', [{ name: '_id', value: 'p-own' }]);
    assert.equal(result.error, undefined);
    return result;
  };
  const plain = await runFor([]);
  assert.deepEqual(ids(plain), ['p-own'], 'every unreachable Practitioner the source returned is dropped');
  assert.equal(plain.coverage.reasons.includes('SHARED_RECORDS_WITHHELD_BY_POLICY'), false);
  // An unreachable record the shared policy would withhold makes no difference either.
  const withheld = await runFor([{ ...practitioner('p-extension'), extension: [{ url: 'urn:synthetic:x', valueString: 'x' }] }]);
  const strip = (envelope: GatewayEnvelope) => normalize({ ...envelope, request_id: '', budget: { ...envelope.budget, elapsed_ms: 0 } });
  assert.deepEqual(strip(withheld), strip(plain));
});

test('reachability gateway: the bound fails closed', async t => {
  // 21 own encounters name 2,100 distinct Practitioners: more than the 2,048-entry ledger holds with their own-record keys.
  const bulk = Array.from({ length: 21 }, (_, i) => encounter(`bulk-${i}`, A, { participant: Array.from({ length: 100 }, (_, j) => ({ individual: { reference: `Practitioner/b-${i}-${j}` } })) }));
  const f = await gatewayFor(t, { records: [{ resourceType: 'Patient', id: A, active: true }, ...bulk] });
  for (const record of bulk) assert.equal((await f.read('Encounter', record.id, { format: 'fhir', max_bytes: 65536 })).error, undefined, record.id);
  let refused = 0, admitted = 0;
  for (let i = 0; i < bulk.length; i++) {
    const result = await f.search('Practitioner', [{ name: '_id', value: Array.from({ length: 100 }, (_, j) => `b-${i}-${j}`).join(',') }]);
    if (result.error) { assert.equal(result.error.code, 'POLICY_DENIED'); refused++; } else admitted++;
  }
  // Which keys leave is not pinned here; only that the set never grows past its bound, and that what left is unreachable.
  assert.ok(refused >= 1, 'at least one delivered reference was evicted and is unreachable again');
  assert.ok(admitted >= 1, 'the bound keeps most of what was delivered');
});

test('reachability gateway: reset on a state boundary and per context', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await gatewayFor(t, {}, { discovery: { metadataTtlMs: 60_000 } });
  assert.equal((await f.read('Encounter', 'enc-a')).error, undefined);
  await reachableRead(f, 'Practitioner', 'p-own');
  // Another context on the same source starts with nothing reachable.
  const other = new FhirGateway({ mode: 'synthetic', source: { alias: 'reach', baseUrl: f.base }, patientId: A, contextId: 'reach-other-context' });
  t.after(() => other.close());
  assert.equal((await other.execute('fhir_read', { resource_type: 'Practitioner', id: 'p-own', output })).error?.code, 'NOT_FOUND');
  // The source identity changes; the next call refreshes metadata after the TTL and clears the ledger with retained results.
  f.state.software = 'reachability synthetic source, changed';
  now += 61_000;
  const before = f.clinical().length;
  const cleared = await f.read('Practitioner', 'p-own');
  assert.equal(cleared.error?.code, 'NOT_FOUND');
  assert.equal(f.clinical().length, before, 'after the reset the read is refused before any clinical request');
  const refusedSearch = await f.search('Practitioner', [{ name: '_id', value: 'p-own' }]);
  assert.equal(refusedSearch.error?.code, 'POLICY_DENIED');
  assert.equal(f.clinical().length, before);
  assert.equal((await f.read('Encounter', 'enc-a')).error, undefined);
  await reachableRead(f, 'Practitioner', 'p-own');
});

test('reachability twins: outcomes never depend on another patient\'s data', async t => {
  // World X: another patient's encounter names p-twin and o-twin. World Y: it names nothing. The source ignores the patient
  // pair, so it returns the other patient's encounter in both worlds and the gateway drops it silently.
  const world = async (named: boolean) => {
    const records = [...dataset(), practitioner('p-twin'), organization('o-twin'),
      encounter('enc-b2', B, named ? { participant: [{ individual: { reference: 'Practitioner/p-twin' } }], serviceProvider: { reference: 'Organization/o-twin' } } : {})];
    const f = await gatewayFor(t, { records, leaky: true });
    const encounters = await f.search('Encounter', []);
    const results = [encounters];
    for (const [type, id] of [['Practitioner', 'p-twin'], ['Organization', 'o-twin']] as const) {
      results.push(await unreachableRead(f, type, id));
      const before = f.requests.length;
      results.push(await f.search(type, [{ name: '_id', value: id }]));
      assert.equal(f.requests.length, before);
    }
    return results.map(result => normalize(f.gateway.toToolResult(result)));
  };
  const named = await world(true), unnamed = await world(false);
  assert.deepEqual(named, unnamed, 'every public output is the same whatever the other patient\'s records name');
  assert.equal(JSON.stringify(named).includes(B), false);
});

test('reachability capabilities: the support output tells an agent the rule', async t => {
  const f = await gatewayFor(t);
  for (const type of ['Practitioner', 'Organization', 'Location']) {
    const support = await f.gateway.execute('fhir_capabilities', { topic: 'support', resource_type: type });
    assert.equal(support.error, undefined);
    const rows = (support.data as { rows: R[] }).rows;
    assert.ok(rows[0]!.limitations.includes(DIRECTORY_REACHABILITY_LIMITATION), type);
    const resource = await f.gateway.execute('fhir_capabilities', { topic: 'resource', resource_type: type });
    assert.ok((resource.data as { limitations: string[] }).limitations.includes(DIRECTORY_REACHABILITY_LIMITATION), `${type}: resource topic`);
  }
  const medication = await f.gateway.execute('fhir_capabilities', { topic: 'support', resource_type: 'Medication' });
  assert.equal((medication.data as { rows: R[] }).rows[0]!.limitations.includes(DIRECTORY_REACHABILITY_LIMITATION), false);
});

// ---------------------------------------------------------------------------------------------------------------
// Real MCP SDK stdio, both protocol eras.
// ---------------------------------------------------------------------------------------------------------------

for (const era of ['modern', 'legacy'] as const) test(`reachability stdio ${era}: directory records only by reachable id; refusals send nothing`, async t => {
  const source = await startSource(t);
  const dir = await mkdtemp(join(tmpdir(), 'reach-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ mode: 'synthetic', source: { alias: 'reach', baseUrl: source.base }, patientId: A }));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'packages/server/src/cli.ts', '--config', config],
    env: { ...getDefaultEnvironment(), TMPDIR: tmpdir() }, stderr: 'pipe' });
  const client = new Client({ name: 'reachability', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  await client.connect(transport);
  t.after(() => client.close());
  const raw = (name: string, args: R) => client.callTool({ name, arguments: { ...args, output } }) as Promise<{ structuredContent?: GatewayEnvelope; content?: { text?: string }[] }>;
  const call = async (name: string, args: R) => (await raw(name, args)).structuredContent!;
  assert.equal((await call('fhir_capabilities', { topic: 'server' })).error, undefined);
  const refused = async (name: string, args: R, code: string) => {
    const before = source.requests.length;
    const result = await raw(name, args);
    assert.equal(result.structuredContent!.error?.code, code, `${name} ${JSON.stringify(args)}`);
    assert.equal(source.requests.length, before, 'nothing is sent');
    return result;
  };
  const present = await refused('fhir_read', { resource_type: 'Practitioner', id: 'p-free' }, 'NOT_FOUND');
  const missing = await refused('fhir_read', { resource_type: 'Practitioner', id: 'p-missing' }, 'NOT_FOUND');
  assert.deepEqual(normalize(present), normalize(missing), 'existing and missing unreachable reads are identical on the wire');
  await refused('fhir_read', { resource_type: 'Practitioner', id: 'p-own' }, 'NOT_FOUND');
  await refused('fhir_search', { resource_type: 'Practitioner', params: [] }, 'POLICY_DENIED');
  await refused('fhir_search', { resource_type: 'Location', params: [{ name: 'address', value: '42' }] }, 'POLICY_DENIED');
  assert.equal((await call('fhir_read', { resource_type: 'Encounter', id: 'enc-a' })).error, undefined);
  const read = await call('fhir_read', { resource_type: 'Practitioner', id: 'p-own' });
  assert.equal(read.error, undefined, JSON.stringify(read.error)); assert.deepEqual(ids(read), ['p-own']);
  const before = source.clinical().length;
  const lookup = await call('fhir_search', { resource_type: 'Location', params: [{ name: '_id', value: 'l-own' }] });
  assert.equal(lookup.error, undefined); assert.deepEqual(ids(lookup), ['l-own']);
  assert.deepEqual(source.sentSince(before), ['/fhir/Location?_id=l-own&_count=20']);
  await refused('fhir_search', { resource_type: 'Location', params: [{ name: '_id', value: 'l-own,l-free' }] }, 'POLICY_DENIED');
  await refused('fhir_search', { resource_type: 'Location', params: [{ name: '_id', value: 'l-own' }, { name: 'address', value: '42' }] }, 'POLICY_DENIED');
  await refused('fhir_read', { resource_type: 'Organization', id: 'o-parent' }, 'NOT_FOUND');
});
