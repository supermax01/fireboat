/**
 * Regression tests for fixes to the honest-coverage, narrow-redaction and new-type changes. All fixtures are hand-written
 * synthetic shapes.
 *
 * - Full-text search (`_content`, and any parameter with no reviewed pinned expression) is refused on patient-linked types
 *   before anything is sent, so it cannot confirm guesses about withheld values or make the RECORDS_WITHHELD_BY_POLICY signal
 *   depend on another patient's identity.
 * - The person-identifier rule that decides "withhold silently" instead of "redact and deliver" folds spellings conservatively.
 * - Device and ImagingStudy extensions, and the identifier and display of Device.parent, are withheld.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { FhirGateway, type GatewayEnvelope } from '../packages/core/src/index.js';
import type { FhirResource, GatewayConfig } from '../packages/core/src/contracts.js';
import { authorizeRecord, resourceClass, sanitize, sanitizeForDelivery } from '../packages/core/src/privacy.js';
import { resolveSearchParameters, unreviewedFullTextPredicate, validateSearchAdmission } from '../packages/core/src/search-parameters.js';
import { classifiedTypes } from '../packages/core/src/support.js';
import catalog from '../packages/core/src/generated/r4-search-parameters.json' with { type: 'json' };

type R = Record<string, any>;
const A = 'synthetic-pat-a', B = 'synthetic-pat-b';
const BASE = new URL('http://127.0.0.1:4321/fhir/');
const code = { coding: [{ system: 'http://loinc.org', code: '4548-4' }] };
const OTHER_MRN = 'SYNTHETIC-MRN-OTHER-4711', OTHER_NAME = 'Synthetic Other Person';
const SERIAL = 'SYNTHETIC-SN-SECRET-1', UID = '2.25.987654321';

// ---------------------------------------------------------------------------------------------------------------
// Unit: which parameters count as unreviewed full-text predicates.
// ---------------------------------------------------------------------------------------------------------------

/** Every pinned definition applicable to `type` (exact-type and Resource bases), declared as the source would. */
const declarations = (type: string) => catalog.definitions
  .filter(d => d.base.includes(type) || d.base.includes('Resource'))
  .map(d => ({ name: d.code, type: d.type, source_description_present: false }));

test('full-text refusal: across every patient-linked type, exactly `_content` is an unreviewed expressionless predicate', () => {
  const flagged: string[] = [];
  const patientTypes = classifiedTypes().filter(type => resourceClass(type) === 'patient');
  for (const type of patientTypes) {
    const resolved = resolveSearchParameters({ resourceType: type, declared: declarations(type), advertised: true });
    // `_sort` is the gateway ordering control, never a filter or a sort key itself.
    for (const [name, entry] of resolved.byName) if (entry.view.executable && !entry.control && unreviewedFullTextPredicate(type, entry)) flagged.push(`${type}.${name}`);
  }
  // If a new expressionless parameter becomes executable on a patient-linked type, it must be reviewed and listed here.
  assert.deepEqual(flagged.sort(), patientTypes.map(type => `${type}._content`).sort());
});

test('full-text refusal: admission refuses `_content` as a filter and as a sort key; the reviewed Patient exceptions stay admitted', () => {
  const admit = (type: string, pairs: { name: string; value: string }[], sort: string[] = []) => validateSearchAdmission({
    resourceType: type, pairs, resolved: resolveSearchParameters({ resourceType: type, declared: declarations(type), advertised: true }),
    patientId: A, confinementName: type === 'Patient' ? '_id' : type === 'Device' ? 'patient' : 'subject', sort,
  });
  const refused = (fn: () => void, label: string) => assert.throws(fn, (error: any) => error.code === 'POLICY_DENIED', label);
  for (const type of ['Observation', 'DocumentReference', 'Device', 'ImagingStudy', 'Patient', 'Encounter']) {
    refused(() => admit(type, [{ name: '_content', value: 'anything' }]), `${type} _content filter`);
    refused(() => admit(type, [], ['_content']), `${type} _content sort`);
    refused(() => admit(type, [], ['-_content']), `${type} descending _content sort`);
    // Neighbouring Resource-base parameters with a pinned expression stay admitted.
    assert.doesNotThrow(() => admit(type, [{ name: '_lastUpdated', value: 'ge2020-01-01' }]), `${type} _lastUpdated`);
  }
  assert.doesNotThrow(() => admit('Patient', [{ name: 'age', value: '30' }]), 'Patient age is reviewed');
  assert.doesNotThrow(() => admit('Patient', [{ name: 'birthOrderBoolean', value: 'true' }]), 'Patient birthOrderBoolean is reviewed');
});

// ---------------------------------------------------------------------------------------------------------------
// Gateway: a source that evaluates `_content` as a substring of the raw stored JSON (an oracle for guessing withheld values).
// ---------------------------------------------------------------------------------------------------------------

const TYPES = ['Observation', 'Device', 'ImagingStudy', 'DocumentReference'];
function dataset(): R[] {
  return [
    // Redacted and delivered: an own Observation whose identifier-only performer names someone in another hospital's MRN system.
    { resourceType: 'Observation', id: 'obs-a2', status: 'final', code, subject: { reference: `Patient/${A}` },
      performer: [{ identifier: { system: 'urn:synthetic:other-hospital-mrn', value: OTHER_MRN }, display: OTHER_NAME }] },
    // Withheld with the signal: an own Observation with an unrelated defect (a contained Basic) and an explicit reference to another patient.
    { resourceType: 'Observation', id: 'obs-a1', status: 'final', code, subject: { reference: `Patient/${A}` },
      performer: [{ reference: `Patient/${B}`, display: OTHER_NAME }], contained: [{ resourceType: 'Basic', id: 'b1', code }] },
    { resourceType: 'Device', id: 'dev-a', status: 'active', patient: { reference: `Patient/${A}` }, serialNumber: SERIAL },
    { resourceType: 'ImagingStudy', id: 'img-a', status: 'available', subject: { reference: `Patient/${A}` }, identifier: [{ system: 'urn:dicom:uid', value: `urn:oid:${UID}` }] },
    { resourceType: 'DocumentReference', id: 'doc-a', status: 'current', subject: { reference: `Patient/${A}` },
      content: [{ attachment: { contentType: 'text/plain', title: 'Synthetic note' } }], author: [{ identifier: { system: 'urn:synthetic:registry', value: OTHER_MRN }, display: OTHER_NAME }] },
  ];
}

async function startSource(t: TestContext) {
  const db = dataset();
  const requests: URL[] = [];
  let base = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url!, base);
    requests.push(url);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname === '/fhir/metadata') {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', status: 'active', kind: 'instance', fhirVersion: '4.0.1', format: ['json'],
        rest: [{ mode: 'server', resource: TYPES.map(type => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }],
          searchParam: [{ name: 'patient', type: 'reference' }, { name: 'subject', type: 'reference' }, { name: 'code', type: 'token' }, { name: 'status', type: 'token' }, { name: '_content', type: 'string' }] })) }] }));
      return;
    }
    const type = url.pathname.replace(/^\/fhir\//, '');
    const content = url.searchParams.get('_content');
    const selected = db.filter(r => r.resourceType === type && (content === null || JSON.stringify(r).includes(content)));
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }],
      entry: selected.map(resource => ({ resource, search: { mode: 'match' } })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/fhir/`;
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'review-fixes', baseUrl: base }, patientId: A });
  t.after(() => gateway.close());
  return { gateway, clinical: () => requests.filter(url => !url.pathname.endsWith('/metadata')).length };
}

/** The public envelope without per-call noise. Upstream calls are left out: the first call also fetches the capability statement. */
const publicView = (envelope: GatewayEnvelope) => ({ error: envelope.error, data: envelope.data, coverage: envelope.coverage, warnings: envelope.warnings, pagination: envelope.pagination });

test('full-text refusal (gateway): `_content` guesses about withheld values are refused identically, with nothing sent', async t => {
  const f = await startSource(t);
  const guesses: [string, string, string][] = [
    ['Observation', OTHER_MRN, 'SYNTHETIC-MRN-OTHER-0000'], // the identifier of a redacted reference
    ['Observation', OTHER_NAME, 'Synthetic Nobody'], // the display of a redacted reference
    ['Observation', B, 'synthetic-pat-c'], // withheld-signal twin: the id of another patient a withheld own record references
    ['DocumentReference', OTHER_MRN, 'SYNTHETIC-MRN-OTHER-0000'],
    ['Device', SERIAL, 'SYNTHETIC-SN-WRONG-2'], // a masked Device serial number
    ['ImagingStudy', UID, '2.25.111'], // a masked DICOM study UID
  ];
  for (const [type, right, wrong] of guesses) {
    const views = [];
    for (const value of [right, wrong]) {
      const envelope = await f.gateway.execute('fhir_search', { resource_type: type, params: [{ name: '_content', value }], output: { format: 'fhir' } });
      assert.equal(envelope.error?.code, 'POLICY_DENIED', `${type} ${value}`);
      views.push(publicView(envelope));
    }
    assert.deepEqual(views[0], views[1], `${type}: the right and the wrong guess are indistinguishable`);
    for (const sort of ['_content', '-_content']) {
      const sorted = await f.gateway.execute('fhir_search', { resource_type: type, params: [{ name: '_sort', value: sort }], output: { format: 'fhir' } });
      assert.equal(sorted.error?.code, 'POLICY_DENIED', `${type} sort ${sort}`);
    }
  }
  assert.equal(f.clinical(), 0, 'no refused search reached the source');
  // Control: the same source still answers an ordinary search; the redacted record is delivered, the withheld one signalled.
  const ordinary = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }], output: { format: 'fhir' } });
  assert.equal(ordinary.error, undefined);
  assert.deepEqual((ordinary.data.resources as R[]).map(r => r.id), ['obs-a2']);
  assert.ok(ordinary.coverage.reasons.includes('RECORDS_WITHHELD_BY_POLICY'));
  assert.equal(f.clinical(), 1);
});

// ---------------------------------------------------------------------------------------------------------------
// Unit: the person-identifier rule folds spellings, so evasive forms are withheld silently, never redacted and delivered.
// ---------------------------------------------------------------------------------------------------------------

const MRN = 'urn:synthetic:mrn';
const privacy: GatewayConfig['privacy'] = { patientIdentifierSystems: [MRN] };
const performerWith = (identifier: R): FhirResource => ({ resourceType: 'Observation', id: 'o1', status: 'final', code, subject: { reference: `Patient/${A}` },
  performer: [{ identifier, display: 'Synthetic display' }] }) as FhirResource;

test('person-identifier rule: case, URL and type-text variants are withheld silently; an unrelated registry is still redacted', () => {
  const silent: [string, R][] = [
    ['exact configured system', { system: MRN, value: 'x' }],
    ['upper-case scheme', { system: 'URN:synthetic:mrn', value: 'x' }],
    ['mixed-case body', { system: 'urn:Synthetic:MRN', value: 'x' }],
    ['US SSN system', { system: 'http://hl7.org/fhir/sid/us-ssn', value: 'x' }],
    ['US SSN OID', { system: 'urn:oid:2.16.840.1.113883.4.1', value: 'x' }],
    ['https v2-0203 type system', { system: 'urn:synthetic:registry', value: 'x', type: { coding: [{ system: 'https://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] } }],
    ['upper-case OID v2-0203 type system', { system: 'urn:synthetic:registry', value: 'x', type: { coding: [{ system: 'urn:OID:2.16.840.1.113883.18.108', code: 'MR' }] } }],
    ['older v2/0203 type system with trailing slash', { system: 'urn:synthetic:registry', value: 'x', type: { coding: [{ system: 'http://hl7.org/fhir/v2/0203/', code: 'MR' }] } }],
    ['lower-case type code', { system: 'urn:synthetic:registry', value: 'x', type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'mr' }] } }],
    ['type text only', { system: 'urn:synthetic:registry', value: 'x', type: { text: 'MRN' } }],
    ['type text, words', { system: 'urn:synthetic:registry', value: 'x', type: { text: 'Medical record number' } }],
  ];
  for (const [label, identifier] of silent) assert.equal(authorizeRecord(performerWith(identifier), A, BASE, privacy).kind, 'silent', label);
  const redacted: [string, R][] = [
    ['unrelated clinician registry', { system: 'urn:synthetic:clinician-registry', value: 'x' }],
    ['clinician type text', { system: 'urn:synthetic:clinician-registry', value: 'x', type: { text: 'Provider number' } }],
    ['non-person v2-0203 code', { system: 'urn:synthetic:clinician-registry', value: 'x', type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PRN' }] } }],
  ];
  for (const [label, identifier] of redacted) {
    const decision = authorizeRecord(performerWith(identifier), A, BASE, privacy);
    assert.deepEqual(decision, { kind: 'deliver', withhold: ['/performer/0'] }, label);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Unit: Device and ImagingStudy extensions, and Device.parent identifier and display.
// ---------------------------------------------------------------------------------------------------------------

test('Device masks: extensions at every depth and Device.parent identifier and display are withheld; the parent reference stays', () => {
  const device = {
    resourceType: 'Device', id: 'dev-x', status: 'active', patient: { reference: `Patient/${A}` }, modelNumber: 'synthetic-model-1',
    extension: [{ url: 'http://hl7.org/fhir/SearchParameter/device-extensions-Device-din', valueIdentifier: { value: 'SYNTHETIC-DIN-77' } },
      { url: 'urn:synthetic:serial-ext', valueString: 'SYNTHETIC-SERIAL-EXT' }],
    deviceName: [{ name: 'Synthetic pump', type: 'user-friendly-name', extension: [{ url: 'urn:synthetic:nested', valueString: 'SYNTHETIC-NESTED-EXT' }] }],
    _status: { extension: [{ url: 'urn:synthetic:primitive', valueString: 'SYNTHETIC-PRIMITIVE-EXT' }] },
    parent: { reference: 'Device/dev-parent', identifier: { value: 'SYNTHETIC-SN-PARENT-9' }, display: 'Parent pump SYNTHETIC-SN-PARENT-9' },
    modifierExtension: [{ url: 'urn:synthetic:modifier', valueBoolean: true }],
  } as unknown as FhirResource;
  const { resource, manifests } = sanitize(device);
  const reasonsAt = (path: string) => manifests.filter(entry => entry.path === path).map(entry => entry.reason);
  assert.deepEqual(reasonsAt('/extension'), ['UNREVIEWED_EXTENSION_WITHHELD']);
  assert.deepEqual(reasonsAt('/deviceName/0/extension'), ['UNREVIEWED_EXTENSION_WITHHELD']);
  assert.deepEqual(reasonsAt('/_status/extension'), ['UNREVIEWED_EXTENSION_WITHHELD']);
  assert.deepEqual(reasonsAt('/parent/identifier'), ['DEVICE_PRODUCTION_IDENTIFIER_WITHHELD']);
  assert.deepEqual(reasonsAt('/parent/display'), ['DEVICE_PRODUCTION_IDENTIFIER_WITHHELD']);
  const text = JSON.stringify(resource);
  for (const canary of ['SYNTHETIC-DIN-77', 'SYNTHETIC-SERIAL-EXT', 'SYNTHETIC-NESTED-EXT', 'SYNTHETIC-PRIMITIVE-EXT', 'SYNTHETIC-SN-PARENT-9']) assert.ok(!text.includes(canary), canary);
  assert.deepEqual((resource as R).parent, { reference: 'Device/dev-parent' });
  assert.equal((resource as R).deviceName[0].name, 'Synthetic pump');
  assert.equal((resource as R).modelNumber, 'synthetic-model-1');
  assert.deepEqual((resource as R).modifierExtension, [{ url: 'urn:synthetic:modifier', valueBoolean: true }], 'modifier extensions are not withheld here');

  const study = { resourceType: 'ImagingStudy', id: 'img-x', status: 'available', subject: { reference: `Patient/${A}` },
    extension: [{ url: 'urn:synthetic:uid-ext', valueString: 'SYNTHETIC-UID-EXT' }], numberOfSeries: 1 } as unknown as FhirResource;
  const cleanStudy = sanitize(study);
  assert.deepEqual(cleanStudy.manifests.filter(entry => entry.path === '/extension').map(entry => entry.reason), ['UNREVIEWED_EXTENSION_WITHHELD']);
  assert.ok(!JSON.stringify(cleanStudy.resource).includes('SYNTHETIC-UID-EXT'));

  // Control: other patient-linked types keep their extensions.
  const observation = { resourceType: 'Observation', id: 'o-x', status: 'final', code, subject: { reference: `Patient/${A}` },
    extension: [{ url: 'urn:synthetic:obs-ext', valueString: 'SYNTHETIC-OBS-EXT' }] } as unknown as FhirResource;
  assert.ok(JSON.stringify(sanitize(observation).resource).includes('SYNTHETIC-OBS-EXT'));
});

// ---------------------------------------------------------------------------------------------------------------
// Unit: the post-sanitize check on a redacted record uses the configured shared-record rule, not the default.
// ---------------------------------------------------------------------------------------------------------------

test('A3 with A2: a redacted own order with a contained listed Medication is delivered; without the list it is withheld with the signal', () => {
  const PRODUCT = 'urn:synthetic:review:product';
  const order = { resourceType: 'MedicationRequest', id: 'm1', status: 'active', intent: 'order', subject: { reference: `Patient/${A}` },
    requester: { identifier: { system: 'urn:synthetic:clinician-registry', value: 'clin-7' }, display: 'Synthetic Clinician Seven' },
    medicationReference: { reference: '#med1' },
    contained: [{ resourceType: 'Medication', id: 'med1', status: 'active', code: { coding: [{ system: 'urn:synthetic:drug', code: 'd1' }] }, identifier: [{ system: PRODUCT, value: 'SYNTHETIC-PRODUCT-1' }] }] } as unknown as FhirResource;
  const listed = { sharedIdentifierSystems: [PRODUCT] };
  assert.deepEqual(authorizeRecord(order, A, BASE, listed), { kind: 'deliver', withhold: ['/requester'] });
  const delivered = sanitizeForDelivery(order, A, BASE, listed);
  assert.ok('sanitized' in delivered, 'the redacted order passes the post-sanitize check under the configured rule');
  const text = JSON.stringify(delivered.sanitized.resource);
  assert.ok(text.includes('SYNTHETIC-PRODUCT-1') && !text.includes('clin-7'));
  assert.deepEqual(sanitizeForDelivery(order, A, BASE, {}), { refused: { kind: 'own_withheld' } });
});
