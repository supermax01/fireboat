/**
 * Shared-record policy, `_id` list limits and reference-target checks. All fixtures are hand-written synthetic shapes.
 * - Shared profiles: `privacy.sharedProfiles` (empty by default) lets a shared record declare listed `meta.profile` canonicals;
 *   every other shared-instance check is unchanged.
 * - `_id` lists: up to 100 plain ids within 4,096 bytes; every other OR list keeps 33 alternatives and 2,048 bytes.
 * - Shared-record drops are signalled with SHARED_RECORDS_WITHHELD_BY_POLICY, except drops caused by evidence of another patient
 *   and person-shaped records (non-facility Locations, Organizations with contacts, person identifiers), which stay silent
 *   (twin-equal, and equal to a page without the record).
 * - A reference target not yet delivered is checked with the confined search `<Type>?_id=<id>&patient=Patient/<bound>`; foreign,
 *   missing, withheld and failing targets give byte-identical POLICY_DENIED envelopes and the original search is never sent.
 */
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { FhirGateway, WARNING_MESSAGES, type GatewayConfig, type GatewayEnvelope } from '../packages/core/src/index.js';
import { validateCrossField02 } from '../packages/core/src/contracts.js';
import { authorizeRecord, safeSharedProfile, sharedInstanceAllowed, sharedPolicyFrom, SHARED_INSTANCE_POLICY } from '../packages/core/src/privacy.js';
import { MAX_ID_ALTERNATIVES, MAX_ID_VALUE_BYTES, MAX_OR_ALTERNATIVES } from '../packages/core/src/query.js';
import catalog from '../packages/core/src/generated/r4-search-parameters.json' with { type: 'json' };

type R = Record<string, any>;
type Pair = { name: string; value: string };
const A = 'pat-a', B = 'pat-b';
const REASON = 'SHARED_RECORDS_WITHHELD_BY_POLICY';
const PROFILE = 'http://example.invalid/fhir/StructureDefinition/synthetic-medication';
const OTHER_PROFILE = 'http://example.invalid/fhir/StructureDefinition/synthetic-other';
const PRODUCT = 'urn:synthetic:owner:product';
const base = new URL('http://127.0.0.1:4321/fhir/');
const drug = { coding: [{ system: 'urn:synthetic:drug', code: 'synthetic-drug-1' }] };
const medication = (id: string, extra: R = {}): R => ({ resourceType: 'Medication', id, status: 'active', code: drug, ...extra });
const profiled = (id: string, profiles: unknown[] = [PROFILE], extra: R = {}) => medication(id, { meta: { profile: profiles }, ...extra });
const encounter = (id: string, patient: string, extra: R = {}): R => ({ resourceType: 'Encounter', id, status: 'finished',
  class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }, subject: { reference: `Patient/${patient}` }, ...extra });
const observation = (id: string, patient: string, extra: R = {}): R => ({ resourceType: 'Observation', id, status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '1111-1' }] }, subject: { reference: `Patient/${patient}` }, ...extra });
const uuid = (i: number) => `5b1f2c3d-0000-4000-8000-${String(i).padStart(12, '0')}`;
const config = (privacy?: GatewayConfig['privacy']): GatewayConfig => ({ mode: 'synthetic', source: { alias: 'owner', baseUrl: 'http://127.0.0.1:9/fhir/' }, patientId: A, ...(privacy ? { privacy } : {}) });
const ids = (envelope: GatewayEnvelope) => ((envelope.data as { resources?: R[] }).resources ?? []).map(r => r.id);
const hasWarning = (envelope: GatewayEnvelope, code: string) => envelope.warnings.some(warning => warning.code === code);
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, child) => {
  if (['request_id', 'elapsed_ms', 'bytes_returned', 'wire_bytes', 'retrieved_at', 'expires_at', 'handle', 'cursor', 'next_cursor'].includes(key)) return '<generated>';
  if (typeof child === 'string' && key === 'text') { try { return normalize(JSON.parse(child)); } catch { return child; } }
  return child;
}));
/** Public output that must not depend on suppressed other-patient evidence. */
const publicView = (envelope: GatewayEnvelope) => {
  const { next_cursor: _cursor, ...pagination } = envelope.pagination ?? {} as R;
  return { error: envelope.error, data: envelope.data.resources, coverage: envelope.coverage, warnings: envelope.warnings, transform: envelope.transform,
    pagination, calls: envelope.budget.upstream_calls, limit: envelope.budget.limit_reached };
};
const assertSharedSignal = (envelope: GatewayEnvelope, label: string) => {
  assert.equal(envelope.error, undefined, label);
  assert.equal(envelope.coverage.state, 'partial', label);
  assert.ok(envelope.coverage.reasons.includes(REASON), `${label}: reason`);
  assert.deepEqual(envelope.warnings.find(warning => warning.code === REASON), { code: REASON, message: WARNING_MESSAGES[REASON] }, `${label}: warning`);
  assert.notEqual(envelope.coverage.query_exhausted, true, `${label}: never exhausted`);
  assert.equal(envelope.pagination?.total?.value, undefined, `${label}: no published total`);
  assert.equal(hasWarning(envelope, 'NO_MATCHES'), false, `${label}: no NO_MATCHES`);
  assert.equal(envelope.coverage.reasons.includes('RECORDS_WITHHELD_BY_POLICY'), false, `${label}: not the own-record reason`);
};

// ---------------------------------------------------------------------------------------------------------------
// An inline loopback source with honest search semantics, plus per-test hooks for faults.
// ---------------------------------------------------------------------------------------------------------------

const declarations = (type: string) => [
  { name: '_id', type: 'token', source_description_present: false },
  ...catalog.definitions.filter(d => d.base.includes(type)).map(d => ({ name: d.code, type: d.type, source_description_present: false })),
];
const FIELDS: Record<string, string> = { patient: 'subject', subject: 'subject', encounter: 'encounter' };
const refsOf = (resource: R, field: string): string[] => {
  const value = resource[field];
  return (Array.isArray(value) ? value : value ? [value] : []).map((item: R) => item?.reference).filter((ref: unknown): ref is string => typeof ref === 'string');
};
interface SourceOptions {
  records?: R[];
  /** Interaction lists per type; default read and search-type for Patient, Observation, Encounter, Medication. */
  interactions?: Record<string, string[]>;
  /** Return true when the hook answered the request itself. */
  hook?: (url: URL, res: ServerResponse) => boolean;
}
function dataset(): R[] {
  return [
    { resourceType: 'Patient', id: A, active: true }, { resourceType: 'Patient', id: B, active: true },
    encounter('enc-a', A), encounter('enc-c', A), encounter('enc-b', B),
    encounter('enc-w', A, { contained: [{ resourceType: 'Basic', id: 'b1', code: { text: 'synthetic' } }] }),
    observation('obs-a1', A, { encounter: { reference: 'Encounter/enc-a' } }),
    observation('obs-a2', A, { encounter: { reference: 'Encounter/enc-c' } }),
    observation('obs-b1', B, { encounter: { reference: 'Encounter/enc-b' } }),
    medication('med-1'),
  ];
}
async function startSource(t: TestContext, options: SourceOptions = {}) {
  const db = options.records ?? dataset();
  const interactions = options.interactions ?? Object.fromEntries(['Patient', 'Observation', 'Encounter', 'Medication'].map(type => [type, ['read', 'search-type']]));
  const requests: URL[] = [];
  let base = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url!, base);
    requests.push(url);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname === '/fhir/metadata') {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', status: 'active', kind: 'instance', fhirVersion: '4.0.1', format: ['json'], software: { name: 'shared records source' },
        rest: [{ mode: 'server', resource: Object.entries(interactions).map(([type, codes]) => ({ type, interaction: codes.map(code => ({ code })), searchParam: declarations(type) })) }] }));
      return;
    }
    if (options.hook?.(url, res)) return;
    const parts = url.pathname.replace(/^\/fhir\//, '').split('/');
    if (parts.length === 2) {
      const found = db.find(r => r.resourceType === parts[0] && r.id === parts[1]);
      if (!found) { res.statusCode = 404; res.end(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] })); return; }
      res.end(JSON.stringify(found)); return;
    }
    let selected = db.filter(r => r.resourceType === parts[0]);
    for (const [name, value] of url.searchParams) {
      if (['_count', '_sort', '_offset'].includes(name)) continue;
      const alternatives = value.split(',');
      if (name === '_id') { selected = selected.filter(r => alternatives.includes(r.id)); continue; }
      const field = FIELDS[name];
      if (field) selected = selected.filter(r => refsOf(r, field).some(ref => alternatives.includes(ref)));
    }
    const offset = Number(url.searchParams.get('_offset') ?? 0), count = Number(url.searchParams.get('_count') ?? 20);
    const page = selected.slice(offset, offset + count);
    const next = new URL(url.href); next.searchParams.set('_offset', String(offset + page.length));
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset',
      link: [{ relation: 'self', url: url.href }, ...(offset + page.length < selected.length ? [{ relation: 'next', url: next.href }] : [])],
      entry: page.map(resource => ({ resource, search: { mode: 'match' } })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/fhir/`;
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const clinical = () => requests.filter(url => !url.pathname.endsWith('/metadata'));
  return { base, requests, db, clinical, sentSince: (before: number) => clinical().slice(before).map(url => `${url.pathname}?${url.searchParams}`) };
}
const output = { format: 'fhir', max_bytes: 24576 } as const;
async function gatewayFor(t: TestContext, options: SourceOptions = {}, extra: Partial<GatewayConfig> = {}) {
  const source = await startSource(t, options);
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'owner', baseUrl: source.base }, patientId: A, contextId: 'owner-decisions-context', ...extra });
  t.after(() => gateway.close());
  const search = (resource_type: string, params: Pair[] = [], page_size?: number) => gateway.execute('fhir_search', { resource_type, params, output, ...(page_size ? { page_size } : {}) });
  return { ...source, gateway, search };
}
const CHECK = (type: string, id: string) => `/fhir/${type}?_id=${id}&patient=Patient%2F${A}&_count=1`;
const SEARCH = (id: string) => `/fhir/Observation?encounter=Encounter%2F${id}&patient=Patient%2F${A}&_count=20`;

// ---------------------------------------------------------------------------------------------------------------
// Shared profile allow-list.
// ---------------------------------------------------------------------------------------------------------------

test('shared profiles config: listed canonicals are validated, bounded and never repeated', () => {
  new FhirGateway(config({ sharedProfiles: [PROFILE, 'https://example.invalid/fhir/StructureDefinition/x|1.0.0', 'urn:oid:2.16.840.1.113883.999.1', 'urn:uuid:5b1f2c3d-0000-4000-8000-000000000001'] })).close();
  new FhirGateway(config({ sharedProfiles: Array.from({ length: 32 }, (_, i) => `${PROFILE}-${i}`) })).close();
  new FhirGateway(config({ sharedProfiles: [] })).close();
  for (const [label, sharedProfiles] of [
    ['duplicate', [PROFILE, PROFILE]],
    ['33 entries', Array.from({ length: 33 }, (_, i) => `${PROFILE}-${i}`)],
    ['empty string', ['']],
    ['over 256 characters', [`${PROFILE}/${'x'.repeat(256)}`]],
    ['leading whitespace', [` ${PROFILE}`]],
    ['inner whitespace', ['http://example.invalid/a b']],
    ['control character', ['http://example.invalid/a\u0001b']],
    ['relative', ['StructureDefinition/synthetic']],
    ['not a URI', ['synthetic-profile']],
    ['ftp scheme', ['ftp://example.invalid/profile']],
    ['data scheme', ['data:text/plain,x']],
    ['upper-case scheme', ['HTTP://example.invalid/profile']],
    ['http without a host', ['http:///profile']],
    ['query', ['https://example.invalid/profile?x=1']],
    ['fragment', ['https://example.invalid/profile#x']],
    ['userinfo', ['https://u:p@example.invalid/profile']],
    ['urn with no namespace body', ['urn:oid:']],
    ['bare urn', ['urn:']],
    ['not a string', [42]],
  ] as const) assert.throws(() => new FhirGateway(config({ sharedProfiles: sharedProfiles as unknown as string[] })), { code: 'INVALID_CONFIG' }, label);
  for (const value of [PROFILE, 'urn:oid:1.2.3']) assert.equal(safeSharedProfile(value), true, value);
  for (const value of ['https://example.invalid/p?x', 'https://example.invalid/p#x', 'https://u@example.invalid/p', 'file:///p', 'http:///p']) assert.equal(safeSharedProfile(value), false, value);
});

test('shared profiles instance rule: every declared profile must be listed; every other check still applies', () => {
  assert.equal(SHARED_INSTANCE_POLICY.version, '2026-11-14.3');
  const listed = sharedPolicyFrom({ sharedProfiles: [PROFILE] });
  assert.equal(sharedInstanceAllowed(profiled('m1')), false, 'the default empty list keeps a profiled record unclassified');
  assert.equal(sharedInstanceAllowed(profiled('m1'), listed), true);
  assert.equal(sharedInstanceAllowed(profiled('m1', []), {}), true, 'an empty profile list declares nothing');
  assert.equal(sharedInstanceAllowed(medication('m1'), listed), true, 'no profile stays allowed');
  for (const [label, profiles] of [
    ['an unlisted profile', [OTHER_PROFILE]],
    ['listed and unlisted', [PROFILE, OTHER_PROFILE]],
    ['a versioned spelling of a listed profile', [`${PROFILE}|1.0`]],
    ['a different case', [PROFILE.toUpperCase()]],
    ['a non-string entry', [{ value: PROFILE }]],
    ['a null entry', [null]],
  ] as const) assert.equal(sharedInstanceAllowed(profiled('m1', [...profiles]), listed), false, label);
  assert.equal(sharedInstanceAllowed(medication('m1', { meta: { profile: PROFILE } }), listed), false, 'meta.profile must be an array');
  // Every other check is unchanged by a listed profile.
  for (const [label, record] of [
    ['meta.security', profiled('m1', [PROFILE], { meta: { profile: [PROFILE], security: [{ system: 'urn:synthetic:sec', code: 'R' }] } })],
    ['an extension', profiled('m1', [PROFILE], { extension: [{ url: 'urn:synthetic:x', valueString: 'x' }] })],
    ['a modifierExtension', profiled('m1', [PROFILE], { modifierExtension: [{ url: 'urn:synthetic:x', valueString: 'x' }] })],
    ['a field outside the allow-list', profiled('m1', [PROFILE], { batch: { lotNumber: 'L1' } })],
    ['an uncoded code', profiled('m1', [PROFILE], { code: { text: 'synthetic' } })],
    ['an unlisted identifier system', profiled('m1', [PROFILE], { identifier: [{ system: PRODUCT, value: 'P1' }] })],
  ] as const) assert.equal(sharedInstanceAllowed(record, listed), false, label);
  // Both lists together admit a profiled product with listed identifiers (the shape the two lists are for).
  const both = sharedPolicyFrom({ sharedProfiles: [PROFILE], sharedIdentifierSystems: [PRODUCT] });
  assert.equal(sharedInstanceAllowed(profiled('m1', [PROFILE], { identifier: [{ system: PRODUCT, value: 'P1' }] }), both), true);
  // The list applies to every shared type, not only Medication.
  const organization = { resourceType: 'Organization', id: 'org1', name: 'Synthetic Clinic', meta: { profile: [PROFILE] } };
  assert.equal(sharedInstanceAllowed(organization), false);
  assert.equal(sharedInstanceAllowed(organization, listed), true);
  // A contained profiled Medication inside the patient's own order follows the same configured rule.
  const order = { resourceType: 'MedicationRequest', id: 'm1', status: 'active', intent: 'order', subject: { reference: `Patient/${A}` },
    medicationReference: { reference: '#c1' }, contained: [profiled('c1')] };
  assert.equal(authorizeRecord(order, A, base, { sharedProfiles: [PROFILE] }).kind, 'deliver');
  assert.equal(authorizeRecord(order, A, base, {}).kind, 'own_withheld');
});

test('shared profiles gateway: a listed profile is delivered with its meta.profile; the default withholds it with the shared signal', async t => {
  const records = [...dataset(), profiled('med-p'), profiled('med-q', [OTHER_PROFILE])];
  const listedSource = await gatewayFor(t, { records }, { privacy: { sharedProfiles: [PROFILE] } });
  const listed = await listedSource.search('Medication');
  assert.deepEqual(ids(listed).sort(), ['med-1', 'med-p']);
  assert.deepEqual(((listed.data.resources as R[]).find(r => r.id === 'med-p')!).meta.profile, [PROFILE]);
  assertSharedSignal(listed, 'the unlisted profile is still withheld');
  const read = await listedSource.gateway.execute('fhir_read', { resource_type: 'Medication', id: 'med-p', output });
  assert.equal(read.error, undefined);
  assert.equal((await listedSource.gateway.execute('fhir_read', { resource_type: 'Medication', id: 'med-q', output })).error?.code, 'NOT_FOUND');
  const defaults = await gatewayFor(t, { records });
  const withheld = await defaults.search('Medication');
  assert.deepEqual(ids(withheld), ['med-1']);
  assertSharedSignal(withheld, 'default list');
  assert.equal((await defaults.gateway.execute('fhir_read', { resource_type: 'Medication', id: 'med-p', output })).error?.code, 'NOT_FOUND');
});

// ---------------------------------------------------------------------------------------------------------------
// Shared-record drops are signalled; other-patient evidence stays silent.
// ---------------------------------------------------------------------------------------------------------------

test('shared drops: a policy failure is shared_withheld; other-patient evidence stays silent in both twins', () => {
  const kind = (record: R) => authorizeRecord(record as never, A, base).kind;
  assert.equal(kind(medication('m1')), 'deliver');
  for (const [label, record] of [
    ['an unlisted identifier', medication('m1', { identifier: [{ system: PRODUCT, value: 'P1' }] })],
    ['an unlisted profile', profiled('m1')],
    ['a batch', medication('m1', { batch: { lotNumber: 'L1' } })],
    ['an extension', medication('m1', { extension: [{ url: 'urn:synthetic:x', valueString: 'x' }] })],
    ['meta.security', medication('m1', { meta: { security: [{ system: 'urn:synthetic:sec', code: 'R' }] } })],
    ['an unclassified contained resource', medication('m1', { contained: [{ resourceType: 'Basic', id: 'b1', code: { text: 'synthetic' } }] })],
    ['a contained Medication that fails the policy', medication('m1', { contained: [medication('c1', { batch: { lotNumber: 'L1' } })] })],
    ['an uncoded code', medication('m1', { code: { text: 'synthetic' } })],
  ] as const) assert.equal(kind(record), 'shared_withheld', label);
  // Twins: the verdict never depends on whose identity the other-patient evidence carries.
  const twins: [string, (id: string) => R, string, string][] = [
    ['contained Patient', id => medication('m1', { contained: [{ resourceType: 'Patient', id }] }), 'silent', 'silent'],
    // A bound Patient reference in a shared record is delivered (unchanged); another patient's is dropped silently.
    ['Patient reference in an ingredient', id => medication('m1', { ingredient: [{ itemReference: { reference: `Patient/${id}` } }] }), 'silent', 'deliver'],
    ['policy failure plus a contained Patient', id => medication('m1', { batch: { lotNumber: 'L1' }, contained: [{ resourceType: 'Patient', id }] }), 'shared_withheld', 'shared_withheld'],
    ['policy failure plus a Patient reference', id => medication('m1', { batch: { lotNumber: 'L1' }, ingredient: [{ itemReference: { reference: `Patient/${id}` } }] }), 'shared_withheld', 'shared_withheld'],
  ];
  for (const [label, build, foreign, bound] of twins) {
    assert.equal(kind(build(B)), foreign, `${label}: other patient`);
    assert.equal(kind(build(A)), bound, `${label}: bound patient`);
    assert.equal(kind(build(B)) === 'shared_withheld', kind(build(A)) === 'shared_withheld', `${label}: the signal does not depend on the identity`);
  }
  // An own patient-linked record keeps the own-record reason; another patient's record stays silent.
  assert.equal(kind(observation('o1', A, { contained: [{ resourceType: 'Basic', id: 'b1', code: { text: 'synthetic' } }] })), 'own_withheld');
  assert.equal(kind(observation('o1', B, { contained: [{ resourceType: 'Basic', id: 'b1', code: { text: 'synthetic' } }] })), 'silent');
});

test('shared drops gateway: partial with the reason and warning, no total, sticky across pages and retained results, audited by code only', async t => {
  const failing = medication('med-x', { batch: { lotNumber: 'SYNTHETIC-LOT' } });
  const f = await gatewayFor(t, { records: [...dataset(), failing] });
  const search = await f.search('Medication');
  assertSharedSignal(search, 'search');
  assert.deepEqual(ids(search), ['med-1']);
  for (const args of [{ action: 'inspect' }, { action: 'project', fields: ['status'] }, { action: 'page' }] as R[]) {
    const retained = await f.gateway.execute('fhir_result', { handle: search.result!.handle, ...args, output });
    assert.equal(retained.error, undefined, String(args.action));
    assert.ok(retained.coverage.reasons.includes(REASON), `fhir_result ${args.action}: reason`);
    assert.ok(hasWarning(retained, REASON), `fhir_result ${args.action}: warning`);
  }
  assert.ok(f.gateway.auditEvents.some(event => event.cause?.split(',').includes(REASON)));
  assert.equal(JSON.stringify(f.gateway.auditEvents).includes('med-x'), false);
  assert.equal(JSON.stringify(search).includes('SYNTHETIC-LOT'), false);
  for (const [label, order, page1] of [['dropped on page 1', [failing, medication('med-1')], true], ['dropped on page 2', [medication('med-1'), failing], false]] as const) {
    const paged = await gatewayFor(t, { records: [...order] });
    const first = await paged.search('Medication', [], 1);
    assert.equal(first.error, undefined, label);
    assert.equal(first.coverage.reasons.includes(REASON), page1, `${label}: page 1`);
    assert.equal(hasWarning(first, REASON), page1, `${label}: page 1 warning`);
    const second = await paged.gateway.execute('fhir_page', { cursor: first.pagination!.next_cursor!, output });
    assertSharedSignal(second, `${label}: page 2`);
  }
});

test('shared drops twins: a shared record carrying another patient\'s evidence leaves the public output equal to the clean page', async t => {
  const records: R[] = [];
  const f = await gatewayFor(t, { records });
  const run = async (page: R[]) => {
    records.splice(0, records.length, ...page);
    const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'owner', baseUrl: f.base }, patientId: A, contextId: 'owner-twins' });
    try { return await gateway.execute('fhir_search', { resource_type: 'Medication', params: [], output }); } finally { gateway.close(); }
  };
  const clean = await run([medication('med-1')]);
  assert.equal(clean.coverage.reasons.includes(REASON), false);
  for (const [label, decoy] of [
    ['contained Patient of another patient', medication('med-d', { contained: [{ resourceType: 'Patient', id: B }] })],
    ['contained Patient with the bound id', medication('med-d', { contained: [{ resourceType: 'Patient', id: A }] })],
    ['Patient reference to another patient', medication('med-d', { ingredient: [{ itemReference: { reference: `Patient/${B}` } }] })],
  ] as const) assert.deepEqual(publicView(await run([medication('med-1'), decoy])), publicView(clean), label);
  // A policy failure next to other-patient evidence is signalled whatever identity that evidence carries.
  const foreignTwin = await run([medication('med-1'), medication('med-d', { batch: { lotNumber: 'L1' }, contained: [{ resourceType: 'Patient', id: B }] })]);
  const boundTwin = await run([medication('med-1'), medication('med-d', { batch: { lotNumber: 'L1' }, contained: [{ resourceType: 'Patient', id: A }] })]);
  assertSharedSignal(foreignTwin, 'policy failure with a foreign contained Patient');
  assert.deepEqual(publicView(foreignTwin), publicView(boundTwin));
  assert.equal(JSON.stringify(foreignTwin).includes(B), false);
});

// Person-shaped shared records: the signal confirms that an admitted predicate matched a withheld
// record, so a record whose withheld content may describe a person stays silent, like a drop caused by another patient.
const ROLECODE = 'http://terminology.hl7.org/CodeSystem/v3-RoleCode';
const MRN = 'urn:synthetic:owner:mrn';
const SSN = 'http://hl7.org/fhir/sid/us-ssn';
const EXT = { extension: [{ url: 'urn:synthetic:x', valueString: 'x' }] };
const facility = (id = 'loc-f', extra: R = {}): R => ({ resourceType: 'Location', id, status: 'active', name: 'Synthetic General',
  type: [{ coding: [{ system: ROLECODE, code: 'HOSP' }] }], address: { line: ['1 Synthetic Way'], city: 'Faketown' }, ...extra });
const home = (id: string, line: string, extra: R = {}): R => ({ resourceType: 'Location', id, status: 'active', mode: 'instance',
  physicalType: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/location-physical-type', code: 'ho' }] }, address: { line: [line], city: 'Faketown' }, ...extra });
const practitioner = (id: string, extra: R = {}): R => ({ resourceType: 'Practitioner', id, active: true, name: [{ family: 'Synthetic', given: ['Syn'] }], ...extra });

test('shared drops: person-shaped records stay silent whatever their values; content-neutral failures are signalled', () => {
  const privacy = { patientIdentifierSystems: [MRN] };
  const decide = (record: R) => authorizeRecord(record as never, A, base, privacy);
  assert.equal(decide(facility()).kind, 'deliver');
  for (const [label, record] of [
    ['a residential Location', home('loc-h', '42 Synthetic Lane')],
    ['a residential Location with another address', home('loc-h', '7 Other Synthetic Road')],
    ['a residential Location that also has an extension', home('loc-h', '42 Synthetic Lane', EXT)],
    ['an untyped Location', { resourceType: 'Location', id: 'loc-u', status: 'active', address: { line: ['42 Synthetic Lane'] } }],
    ['a Location typed as a patient\'s residence', facility('loc-r', { type: [{ coding: [{ system: ROLECODE, code: 'PTRES' }] }] })],
    ['an Organization with a contact person', { resourceType: 'Organization', id: 'org-c', name: 'Synthetic Org', contact: [{ name: { text: 'Syn Person' } }] }],
    ['a Medication with a configured patient identifier', medication('m1', { identifier: [{ system: MRN, value: 'MRN-A' }] })],
    ['a Medication with another configured patient identifier value', medication('m1', { identifier: [{ system: MRN, value: 'MRN-B' }] })],
    ['a Medication with a person identifier system', medication('m1', { identifier: [{ system: SSN, value: '000-00-0001' }] })],
    ['a Medication with a person identifier type', medication('m1', { identifier: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] }, system: PRODUCT, value: 'P1' }] })],
    ['a Practitioner withheld for an extension that carries a person identifier', practitioner('pr-s', { identifier: [{ system: SSN, value: '000-00-0001' }], ...EXT })],
  ] as const) assert.deepEqual(decide(record), { kind: 'silent' }, label);
  for (const [label, record] of [
    ['a facility Location with an extension', facility('loc-x', EXT)],
    ['an Organization with an extension', { resourceType: 'Organization', id: 'org-x', name: 'Synthetic Org', ...EXT }],
    ['a Practitioner with an extension', practitioner('pr-x', EXT)],
    ['a Medication with an unlisted product identifier', medication('m1', { identifier: [{ system: PRODUCT, value: 'P1' }] })],
  ] as const) assert.deepEqual(decide(record), { kind: 'shared_withheld' }, label);
});

test('shared drops: unverifiable clinical-actor references inside a contained record are signalled; another patient\'s stays silent', () => {
  const med = (patient: string, performer: R) => medication('m1', { contained: [observation('o1', patient, { performer: [performer] })] });
  for (const [label, performer] of [
    ['an identifier-only performer', { identifier: { system: 'urn:synthetic:npi', value: '1' } }],
    ['a urn:uuid performer', { reference: 'urn:uuid:5b1f2c3d-0000-4000-8000-000000000001' }],
  ] as const) {
    // Shared roots are never redacted, so the bound patient's contained record withholds the Medication with the signal.
    assert.deepEqual(authorizeRecord(med(A, performer) as never, A, base), { kind: 'shared_withheld' }, `${label}: bound patient`);
    // Another patient's contained record is other-patient evidence: silent, and never audited as a self-check failure.
    assert.deepEqual(authorizeRecord(med(B, performer) as never, A, base), { kind: 'silent' }, `${label}: another patient`);
    assert.deepEqual(authorizeRecord(med('pat-c', performer) as never, A, base), authorizeRecord(med(B, performer) as never, A, base), `${label}: any other patient`);
  }
});

test('shared drops twins: a person-shaped record leaves the public output equal to a page without it, whatever its address or identifier', async t => {
  const records: R[] = [];
  const interactions = Object.fromEntries(['Patient', 'Observation', 'Medication', 'Location', 'Organization', 'Practitioner'].map(type => [type, ['read', 'search-type']]));
  const f = await gatewayFor(t, { records, interactions });
  // Shared-directory reachability: the `address` and no-predicate directory searches are refused before sending.
  // Person-shaped silent drops stay as defence in depth, so the same twins are pinned through reachable `_id` lookups:
  // an own Observation names every directory id in `refs`, and the source answers the `_id` list with whatever records
  // it holds.
  const run = async (type: string, params: Pair[], page: R[], refs: string[] = []) => {
    records.splice(0, records.length, observation('obs-ref', A, { focus: refs.map(reference => ({ reference })) }), ...page);
    const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'owner', baseUrl: f.base }, patientId: A, contextId: 'owner-person-twins', privacy: { patientIdentifierSystems: [MRN] } });
    try {
      if (refs.length) assert.equal((await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-ref', output })).error, undefined);
      return await gateway.execute('fhir_search', { resource_type: type, params, output });
    } finally { gateway.close(); }
  };
  const address = [{ name: 'address', value: '42' }];
  for (const [type, params] of [['Location', address], ['Organization', []], ['Location', [{ name: '_id', value: 'loc-f' }, ...address]]] as const) {
    const before = f.clinical().length;
    assert.equal((await run(type, [...params], [facility()], ['Location/loc-f'])).error?.code, 'POLICY_DENIED', `${type} ${JSON.stringify(params)}`);
    assert.equal(f.clinical().length, before + 1, 'only the own record is read; the directory search is never sent');
  }
  const locationRefs = ['Location/loc-f', 'Location/loc-h', 'Location/loc-x'];
  const both = [{ name: '_id', value: 'loc-f,loc-h' }];
  const clean = await run('Location', both, [facility()], locationRefs);
  assert.equal(clean.error, undefined, JSON.stringify(clean.error));
  assert.deepEqual(ids(clean), ['loc-f']);
  assert.equal(clean.coverage.reasons.includes(REASON), false);
  for (const line of ['42 Synthetic Lane', '42 Other Synthetic Road']) {
    const probed = await run('Location', both, [facility(), home('loc-h', line)], locationRefs);
    assert.deepEqual(publicView(probed), publicView(clean), line);
    assert.equal(JSON.stringify(probed).includes('Synthetic Lane') || JSON.stringify(probed).includes('Other Synthetic'), false, line);
  }
  // A withheld residential Location is indistinguishable from a missing id, as fhir_read's uniform NOT_FOUND is.
  const missing = await run('Location', [{ name: '_id', value: 'loc-h' }], [], locationRefs);
  assert.deepEqual(publicView(await run('Location', [{ name: '_id', value: 'loc-h' }], [home('loc-h', '42 Synthetic Lane')], locationRefs)), publicView(missing));
  const orgRefs = ['Organization/org-1', 'Organization/org-c'], orgIds = [{ name: '_id', value: 'org-1,org-c' }];
  const org = await run('Organization', orgIds, [{ resourceType: 'Organization', id: 'org-1', name: 'Synthetic Org' }], orgRefs);
  assert.deepEqual(ids(org), ['org-1']);
  assert.deepEqual(publicView(await run('Organization', orgIds, [{ resourceType: 'Organization', id: 'org-1', name: 'Synthetic Org' },
    { resourceType: 'Organization', id: 'org-c', name: 'Synthetic Org', contact: [{ name: { text: 'Syn Person' } }] }], orgRefs)), publicView(org));
  const meds = await run('Medication', [], [medication('med-1')]);
  for (const value of ['MRN-A', 'MRN-B']) assert.deepEqual(publicView(await run('Medication', [], [medication('med-1'), medication('med-m', { identifier: [{ system: MRN, value }] })])), publicView(meds), value);
  // Contrast: a reachable facility withheld for a content-neutral reason is signalled.
  assertSharedSignal(await run('Location', [{ name: '_id', value: 'loc-f,loc-x' }], [facility(), facility('loc-x', EXT)], locationRefs), 'facility with an extension');
});

test('shared drops strict gate: a completeness claim with the reason, or the reason without its warning, never leaves the gateway', async t => {
  const f = await gatewayFor(t);
  const read = JSON.parse(JSON.stringify(await f.gateway.execute('fhir_read', { resource_type: 'Medication', id: 'med-1', output })));
  assert.equal(read.coverage.state, 'complete_for_query');
  assert.deepEqual(validateCrossField02('fhir_read', read), { ok: true });
  const forged = structuredClone(read);
  forged.coverage.reasons.push(REASON);
  forged.warnings.push({ code: REASON, message: WARNING_MESSAGES[REASON] });
  assert.deepEqual(validateCrossField02('fhir_read', forged), { ok: false, reason: 'INVALID_CROSS_FIELDS' }, 'complete with the reason');
  const partial = structuredClone(read);
  partial.coverage.state = 'partial';
  partial.coverage.query_exhausted = null;
  const paired = structuredClone(partial);
  paired.coverage.reasons.push(REASON);
  paired.warnings.push({ code: REASON, message: WARNING_MESSAGES[REASON] });
  assert.deepEqual(validateCrossField02('fhir_read', paired), { ok: true });
  const reasonOnly = structuredClone(partial);
  reasonOnly.coverage.reasons.push(REASON);
  assert.deepEqual(validateCrossField02('fhir_read', reasonOnly), { ok: false, reason: 'INVALID_CROSS_FIELDS' }, 'reason without warning');
  const warningOnly = structuredClone(partial);
  warningOnly.warnings.push({ code: REASON, message: WARNING_MESSAGES[REASON] });
  assert.deepEqual(validateCrossField02('fhir_read', warningOnly), { ok: false, reason: 'INVALID_CROSS_FIELDS' }, 'warning without reason');
});

// ---------------------------------------------------------------------------------------------------------------
// `_id` lists.
// ---------------------------------------------------------------------------------------------------------------

test('_id lists gateway: 100 UUID ids are sent once and re-authorized; 101 ids, oversize values and patient lists never send', async t => {
  assert.deepEqual([MAX_ID_ALTERNATIVES, MAX_ID_VALUE_BYTES, MAX_OR_ALTERNATIVES], [100, 4096, 33]);
  const records = [...dataset(), ...Array.from({ length: 100 }, (_, i) => observation(uuid(i), i % 10 === 0 ? B : A))];
  const f = await gatewayFor(t, { records });
  const list = Array.from({ length: 100 }, (_, i) => uuid(i)).join(',');
  const before = f.clinical().length;
  const found = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: '_id', value: list }], page_size: 100, output: { format: 'fhir', max_bytes: 131072 } });
  assert.equal(found.error, undefined, JSON.stringify(found.error));
  assert.equal(f.clinical().length, before + 1);
  assert.deepEqual([...f.clinical().at(-1)!.searchParams], [['_id', list], ['patient', `Patient/${A}`], ['_count', '100']]);
  assert.equal(ids(found).length, 90, 'another patient\'s records are never delivered');
  assert.equal((found.coverage.constraints?.find(entry => entry.name === '_id') as R | undefined)?.value, list);
  for (const [label, type, pairs, code] of [
    ['101 ids', 'Observation', [{ name: '_id', value: `${list},${uuid(100)}` }], 'INVALID_ARGUMENTS'],
    ['over 4,096 bytes', 'Observation', [{ name: '_id', value: Array.from({ length: 64 }, (_, i) => `${i}`.padStart(64, 'x')).join(',') }], 'INVALID_ARGUMENTS'],
    ['a 2,049-byte code value', 'Observation', [{ name: 'code', value: 'x'.repeat(2049) }], 'INVALID_ARGUMENTS'],
    ['34 code alternatives', 'Observation', [{ name: 'code', value: Array.from({ length: 34 }, () => '1111-1').join(',') }], 'INVALID_ARGUMENTS'],
    ['34 bound patient alternatives', 'Observation', [{ name: 'patient', value: Array.from({ length: 34 }, () => `Patient/${A}`).join(',') }], 'INVALID_ARGUMENTS'],
    ['a Patient _id list', 'Patient', [{ name: '_id', value: `${A},${B}` }], 'POLICY_DENIED'],
  ] as const) {
    const count = f.clinical().length;
    assert.equal((await f.search(type, [...pairs])).error?.code, code, label);
    assert.equal(f.clinical().length, count, label);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Reference targets checked by a confined search.
// ---------------------------------------------------------------------------------------------------------------

const searchset = (res: ServerResponse, url: URL, resources: R[]) => res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset',
  link: [{ relation: 'self', url: url.href }], entry: resources.map(resource => ({ resource, search: { mode: 'match' } })) }));
const isCheck = (url: URL) => url.pathname === '/fhir/Encounter' && url.searchParams.has('_id');

test('reference targets: foreign, missing, withheld and failing targets give byte-identical refusals and never send the search', async t => {
  const reference = await gatewayFor(t);
  const missing = await reference.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-never' }]);
  assert.equal(missing.error?.code, 'POLICY_DENIED');
  assert.equal(missing.budget.upstream_calls, 2, 'the metadata call and the confined check');
  const expected = normalize(reference.gateway.toToolResult(missing));
  const cases: [string, string, SourceOptions][] = [
    ['foreign', 'enc-b', {}],
    ['missing', 'enc-zz', {}],
    ['own but withheld by policy', 'enc-w', {}],
    ['upstream 500', 'enc-a', { hook: (url, res) => { if (!isCheck(url)) return false; res.statusCode = 500; res.end('{}'); return true; } }],
    ['upstream 404 on search', 'enc-a', { hook: (url, res) => { if (!isCheck(url)) return false; res.statusCode = 404; res.end('{}'); return true; } }],
    ['malformed body', 'enc-a', { hook: (url, res) => { if (!isCheck(url)) return false; res.end('{"resourceType":"Bundle"'); return true; } }],
    ['not a searchset', 'enc-a', { hook: (url, res) => { if (!isCheck(url)) return false; res.end(JSON.stringify({ resourceType: 'OperationOutcome', issue: [] })); return true; } }],
    ['upstream 400', 'enc-a', { hook: (url, res) => { if (!isCheck(url)) return false; res.statusCode = 400; res.end(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid' }] })); return true; } }],
    ['upstream 429', 'enc-a', { hook: (url, res) => { if (!isCheck(url)) return false; res.statusCode = 429; res.end('{}'); return true; } }],
    ['missing, with an OperationOutcome warning on the check page', 'enc-zz', { hook: (url, res) => { if (!isCheck(url)) return false; res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }],
      entry: [{ resource: { resourceType: 'OperationOutcome', issue: [{ severity: 'warning', code: 'not-found' }] }, search: { mode: 'outcome' } }] })); return true; } }],
    ['missing, with an OperationOutcome information entry on the check page', 'enc-zz', { hook: (url, res) => { if (!isCheck(url)) return false; res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }],
      entry: [{ resource: { resourceType: 'OperationOutcome', issue: [{ severity: 'information', code: 'informational' }] }, search: { mode: 'outcome' } }] })); return true; } }],
    ['self link drops the patient pair', 'enc-a', { hook: (url, res) => {
      if (!isCheck(url)) return false;
      const self = new URL(url.href); self.searchParams.delete('patient');
      res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: self.href }], entry: [{ resource: encounter('enc-a', A), search: { mode: 'match' } }] })); return true;
    } }],
    ['source ignores _id and returns another own encounter', 'enc-b', { hook: (url, res) => { if (!isCheck(url)) return false; searchset(res, url, [encounter('enc-a', A)]); return true; } }],
    ['source ignores the patient pair', 'enc-b', { hook: (url, res) => { if (!isCheck(url)) return false; searchset(res, url, [encounter('enc-b', B)]); return true; } }],
    ['the target plus another own encounter', 'enc-a', { hook: (url, res) => { if (!isCheck(url)) return false; searchset(res, url, [encounter('enc-a', A), encounter('enc-c', A)]); return true; } }],
    ['the target id with another type', 'enc-a', { hook: (url, res) => { if (!isCheck(url)) return false; searchset(res, url, [observation('enc-a', A)]); return true; } }],
  ];
  for (const [label, id, options] of cases) {
    const f = await gatewayFor(t, options);
    const before = f.clinical().length;
    const refused = await f.search('Observation', [{ name: 'encounter', value: `Encounter/${id}` }]);
    assert.equal(refused.error?.code, 'POLICY_DENIED', label);
    assert.deepEqual(f.sentSince(before), [CHECK('Encounter', id)], `${label}: only the confined check is sent`);
    const wire = normalize(f.gateway.toToolResult(refused)) as R;
    // Twins share one context id but each gateway has its own; compare everything else byte for byte.
    assert.deepEqual(wire, expected, label);
    // The refused target is not trusted afterwards: a repeat sends the check again and never the search.
    const again = f.clinical().length;
    assert.equal((await f.search('Observation', [{ name: 'encounter', value: `Encounter/${id}` }])).error?.code, 'POLICY_DENIED', label);
    assert.deepEqual(f.sentSince(again), [CHECK('Encounter', id)], `${label}: repeat`);
  }
});

test('reference targets: only the requested record is trusted; other records on the check page are not', async t => {
  const f = await gatewayFor(t, { hook: (url, res) => {
    if (!isCheck(url) || url.searchParams.get('_id') !== 'enc-a') return false;
    searchset(res, url, [encounter('enc-a', A), encounter('enc-c', A)]); return true;
  } });
  assert.equal((await f.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-a' }])).error?.code, 'POLICY_DENIED');
  // enc-c was authorized on the refused check page but never delivered: it still needs its own check.
  const before = f.clinical().length;
  const scoped = await f.search('Observation', [{ name: 'encounter', value: 'Encounter/enc-c' }]);
  assert.equal(scoped.error, undefined, JSON.stringify(scoped.error));
  assert.deepEqual(ids(scoped), ['obs-a2']);
  assert.deepEqual(f.sentSince(before), [CHECK('Encounter', 'enc-c'), SEARCH('enc-c')]);
});

test('reference targets: a target confirmed before a refused one stays trusted; foreign and missing later targets refuse identically', async t => {
  const records = [...dataset(), encounter('e1', A)];
  const refusals: unknown[] = [];
  for (const later of ['enc-b', 'enc-zz']) {
    const f = await gatewayFor(t, { records });
    let before = f.clinical().length;
    const refused = await f.search('Observation', [{ name: 'encounter', value: `Encounter/e1,Encounter/${later}` }]);
    assert.equal(refused.error?.code, 'POLICY_DENIED', later);
    // Checks run in order and stop at the first refusal; the count is visible as upstream calls but never depends on whose record failed.
    assert.deepEqual(f.sentSince(before), [CHECK('Encounter', 'e1'), CHECK('Encounter', later)], later);
    assert.equal(refused.budget.upstream_calls, 3, `${later}: metadata and two checks`);
    refusals.push(normalize(f.gateway.toToolResult(refused)));
    before = f.clinical().length;
    const trusted = await f.search('Observation', [{ name: 'encounter', value: 'Encounter/e1' }]);
    assert.equal(trusted.error, undefined, JSON.stringify(trusted.error));
    assert.deepEqual(f.sentSince(before), [SEARCH('e1')], `${later}: the confirmed target needs no second check`);
  }
  assert.deepEqual(refusals[0], refusals[1]);
});

test('reference targets: OR lists, the cap of four and an unsearchable target type', async t => {
  const records = [...dataset(), ...['e1', 'e2', 'e3', 'e4', 'e5'].map(id => encounter(id, A))];
  const f = await gatewayFor(t, { records });
  // Four distinct unshown own targets: four checks, then the search.
  let before = f.clinical().length;
  const four = await f.search('Observation', [{ name: 'encounter', value: 'Encounter/e1,Encounter/e2' }, { name: 'encounter', value: 'Encounter/e3,Encounter/e4' }]);
  assert.equal(four.error, undefined, JSON.stringify(four.error));
  assert.deepEqual(f.sentSince(before).map(url => url.split('?')[0]), ['/fhir/Encounter', '/fhir/Encounter', '/fhir/Encounter', '/fhir/Encounter', '/fhir/Observation']);
  // Five distinct targets are refused before any request, checked or not.
  before = f.clinical().length;
  assert.equal((await f.search('Observation', [{ name: 'encounter', value: 'Encounter/e1,Encounter/e2,Encounter/e3,Encounter/e4,Encounter/e5' }])).error?.code, 'UNSUPPORTED_SEARCH');
  assert.equal(f.clinical().length, before);
  // A refused part of an OR list refuses the whole search; the trusted parts need no further check.
  before = f.clinical().length;
  assert.equal((await f.search('Observation', [{ name: 'encounter', value: 'Encounter/e1,Encounter/enc-b' }])).error?.code, 'POLICY_DENIED');
  assert.deepEqual(f.sentSince(before), [CHECK('Encounter', 'enc-b')]);
  // Any other refusal comes first and sends nothing, even with an unshown target.
  before = f.clinical().length;
  assert.equal((await f.search('Observation', [{ name: 'encounter', value: 'Encounter/e5' }, { name: 'code:text', value: 'x' }])).error?.code, 'UNSUPPORTED_MODIFIER');
  assert.equal((await f.search('Observation', [{ name: 'encounter', value: 'Encounter/e5' }, { name: 'subject', value: `Patient/${B}` }])).error?.code, 'POLICY_DENIED');
  assert.equal(f.clinical().length, before);
  // Encounter advertised for read only: the check cannot run, so the refusal is uniform and sends nothing (it depends only on the type).
  const readOnly = await gatewayFor(t, { interactions: { Patient: ['read', 'search-type'], Observation: ['read', 'search-type'], Encounter: ['read'] } });
  for (const id of ['enc-a', 'enc-b']) {
    const count = readOnly.clinical().length;
    assert.equal((await readOnly.search('Observation', [{ name: 'encounter', value: `Encounter/${id}` }])).error?.code, 'POLICY_DENIED', id);
    assert.equal(readOnly.clinical().length, count, id);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Real MCP SDK stdio, both protocol eras.
// ---------------------------------------------------------------------------------------------------------------

for (const era of ['modern', 'legacy'] as const) test(`shared records stdio ${era}: profiles, shared signal, 100-id lists and confined target checks`, async t => {
  const records = [...dataset(), profiled('med-p'), medication('med-x', { batch: { lotNumber: 'L1' } }), ...Array.from({ length: 100 }, (_, i) => observation(uuid(i), A)), facility(), home('loc-h', '42 Synthetic Lane'),
    observation('obs-ref', A, { focus: [{ reference: 'Location/loc-f' }, { reference: 'Location/loc-h' }] })];
  let failChecks = false;
  const interactions = Object.fromEntries(['Patient', 'Observation', 'Encounter', 'Medication', 'Location'].map(type => [type, ['read', 'search-type']]));
  const source = await startSource(t, { records, interactions, hook: (url, res) => { if (!failChecks || !isCheck(url)) return false; res.statusCode = 503; res.end('{}'); return true; } });
  const dir = await mkdtemp(join(tmpdir(), 'w1od-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ mode: 'synthetic', source: { alias: 'owner', baseUrl: source.base }, patientId: A, privacy: { sharedProfiles: [PROFILE] } }));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'packages/server/src/cli.ts', '--config', configPath],
    env: { ...getDefaultEnvironment(), TMPDIR: tmpdir() }, stderr: 'pipe' });
  const client = new Client({ name: 'shared-records', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  await client.connect(transport);
  t.after(() => client.close());
  const raw = (name: string, args: R) => client.callTool({ name, arguments: { ...args, output } }) as Promise<{ structuredContent?: GatewayEnvelope; content?: { text?: string }[] }>;
  const call = async (name: string, args: R) => (await raw(name, args)).structuredContent!;
  // Shared profiles and the shared signal.
  const meds = await call('fhir_search', { resource_type: 'Medication', params: [] });
  assert.deepEqual(ids(meds).sort(), ['med-1', 'med-p']);
  assertSharedSignal(meds, `${era} shared signal`);
  // The `address` search is refused before sending. A residential Location that an own record names is still dropped
  // silently from a reachable `_id` lookup.
  let sent = source.clinical().length;
  assert.equal((await call('fhir_search', { resource_type: 'Location', params: [{ name: 'address', value: '42' }] })).error?.code, 'POLICY_DENIED');
  assert.equal(source.clinical().length, sent);
  assert.equal((await call('fhir_read', { resource_type: 'Observation', id: 'obs-ref' })).error, undefined);
  const locations = await call('fhir_search', { resource_type: 'Location', params: [{ name: '_id', value: 'loc-f,loc-h' }] });
  assert.equal(locations.error, undefined, JSON.stringify(locations.error));
  assert.deepEqual(ids(locations), ['loc-f']);
  assert.equal(locations.coverage.reasons.includes(REASON), false, `${era} person-shaped record stays silent`);
  assert.equal(JSON.stringify(locations).includes('Synthetic Lane'), false);
  // 100 UUID ids in one `_id` list.
  const list = Array.from({ length: 100 }, (_, i) => uuid(i)).join(',');
  const byId = (await client.callTool({ name: 'fhir_search', arguments: { resource_type: 'Observation', params: [{ name: '_id', value: list }], page_size: 100, output: { format: 'fhir', max_bytes: 131072 } } })).structuredContent as GatewayEnvelope;
  assert.equal(byId.error, undefined, JSON.stringify(byId.error));
  assert.equal(ids(byId).length, 100);
  let before = source.clinical().length;
  assert.equal((await call('fhir_search', { resource_type: 'Observation', params: [{ name: '_id', value: `${list},${uuid(100)}` }] })).error?.code, 'INVALID_ARGUMENTS');
  assert.equal(source.clinical().length, before);
  // An own unshown target is checked by a confined search, then the search is sent.
  before = source.clinical().length;
  const scoped = await call('fhir_search', { resource_type: 'Observation', params: [{ name: 'encounter', value: 'Encounter/enc-a' }] });
  assert.equal(scoped.error, undefined, JSON.stringify(scoped.error));
  assert.deepEqual(ids(scoped), ['obs-a1']);
  assert.deepEqual(source.sentSince(before), [CHECK('Encounter', 'enc-a'), SEARCH('enc-a')]);
  // Foreign, missing and upstream-error targets: byte-identical tool results, and only the check is sent.
  const probe = async (id: string) => {
    const count = source.clinical().length;
    const result = await raw('fhir_search', { resource_type: 'Observation', params: [{ name: 'encounter', value: `Encounter/${id}` }] });
    assert.equal(result.structuredContent?.error?.code, 'POLICY_DENIED', id);
    assert.deepEqual(source.sentSince(count), [CHECK('Encounter', id)], id);
    return normalize({ structured: result.structuredContent, text: result.content?.[0]?.text });
  };
  const foreign = await probe('enc-b');
  assert.deepEqual(await probe('enc-zz'), foreign, 'missing equals foreign');
  failChecks = true;
  assert.deepEqual(await probe('enc-c'), foreign, 'an upstream error on the check equals foreign');
  assert.equal(JSON.stringify(foreign).includes(B), false);
});
