// Seven added patient-linked types (MedicationAdministration, MedicationDispense, Specimen, CarePlan,
// CareTeam and ImagingStudy, linked by `subject`; Device, linked by `patient`). Synthetic, hand-written records only.
// Each type reuses the existing confinement, the honest-coverage judge and narrow redaction. Device
// production identifiers, its network address and contact, and ImagingStudy DICOM UIDs are withheld with labels,
// and search predicates or sort keys over those fields are refused before anything is sent.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { FhirGateway, type GatewayEnvelope } from '../packages/core/src/index.js';
import { PATIENT_RECORD_MASKS, authorizeRecord, authorized, patientLinkForType, resourceClass, sanitize, sanitizeForDelivery } from '../packages/core/src/privacy.js';
import { maskedPatientPredicate, resolveSearchParameters, validateSearchAdmission } from '../packages/core/src/search-parameters.js';
import { resolveElement, resourceTypeContext } from '../packages/core/src/schema.js';
import { classifiedTypes, supportForType } from '../packages/core/src/support.js';
import type { FhirResource } from '../packages/core/src/contracts.js';
import catalog from '../packages/core/src/generated/r4-search-parameters.json' with { type: 'json' };

type R = Record<string, any>;
const A = 'pat-a';
const B = 'pat-b';
const BASE = new URL('http://127.0.0.1:8080/fhir/');
const NEW_TYPES = ['MedicationAdministration', 'MedicationDispense', 'Specimen', 'CarePlan', 'CareTeam', 'ImagingStudy', 'Device'] as const;
type NewType = typeof NEW_TYPES[number];
const coded = (code: string) => ({ coding: [{ system: 'urn:synthetic:code', code }] });
const patient = (id: string) => ({ reference: `Patient/${id}` });
/** An identifier-only clinician reference in an unconfigured, non-person system. */
const unverified = () => ({ identifier: { system: 'urn:synthetic:clinician-registry', value: 'clin-7' }, display: 'Synthetic Clinician Seven' });

interface TypeSpec {
  link: 'subject' | 'patient';
  base: R;
  /** Put a reference into the type's decoy element. */
  decoy: (ref: R) => R;
  /** The decoy element's pointer after sanitizing. */
  pointer: string;
  /** Whether the decoy element is a clinical-actor slot whose declared targets include Patient (narrow redaction applies). */
  actorSlot: boolean;
}
const SPECS: Record<NewType, TypeSpec> = {
  MedicationAdministration: { link: 'subject', base: { status: 'completed', medicationCodeableConcept: coded('med-1'), effectiveDateTime: '2025-03-01' },
    decoy: ref => ({ performer: [{ actor: ref }] }), pointer: '/performer/0/actor', actorSlot: true },
  MedicationDispense: { link: 'subject', base: { status: 'completed', medicationCodeableConcept: coded('med-1') },
    decoy: ref => ({ receiver: [ref] }), pointer: '/receiver/0', actorSlot: true },
  // Specimen.collection.collector targets only Practitioner and PractitionerRole: not patient-capable.
  Specimen: { link: 'subject', base: { status: 'available', type: coded('blood') },
    decoy: ref => ({ collection: { collector: ref } }), pointer: '/collection/collector', actorSlot: false },
  CarePlan: { link: 'subject', base: { status: 'active', intent: 'plan' },
    decoy: ref => ({ author: ref }), pointer: '/author', actorSlot: true },
  CareTeam: { link: 'subject', base: { status: 'active', name: 'Synthetic care team' },
    decoy: ref => ({ participant: [{ member: ref }] }), pointer: '/participant/0/member', actorSlot: true },
  ImagingStudy: { link: 'subject', base: { status: 'available' },
    decoy: ref => ({ series: [{ modality: { system: 'urn:synthetic:modality', code: 'CT' }, performer: [{ actor: ref }] }] }), pointer: '/series/0/performer/0/actor', actorSlot: true },
  // Device.owner targets only Organization: not patient-capable.
  Device: { link: 'patient', base: { status: 'active', modelNumber: 'synthetic-model-1' },
    decoy: ref => ({ owner: ref }), pointer: '/owner', actorSlot: false },
};
const record = (type: NewType, id: string, linkRef: R | undefined, extra: R = {}): FhirResource =>
  ({ resourceType: type, id, ...SPECS[type].base, ...(linkRef ? { [SPECS[type].link]: linkRef } : {}), ...extra }) as FhirResource;

// ---------------------------------------------------------------------------------------------------------------
// Unit: classification, linkage and the record decision for every new type.
// ---------------------------------------------------------------------------------------------------------------

test('C classification: the seven types are patient-linked with their reviewed links and support rows', () => {
  for (const type of NEW_TYPES) {
    assert.equal(resourceClass(type), 'patient', type);
    assert.equal(patientLinkForType(type), SPECS[type].link, type);
    const row = supportForType(type);
    assert.equal(row.policy_class, 'patient', type);
    assert.equal(row.patient_link, SPECS[type].link, type);
    assert.equal(row.compact_recipe, null, `${type}: no reviewed compact recipe`);
    assert.equal(row.instance_policy, `Bound-patient ${SPECS[type].link} linkage required.`, type);
    assert.ok(classifiedTypes().includes(type), type);
    // The link element is a Reference that can target Patient, so the confinement and the record check agree.
    const element = resolveElement(resourceTypeContext(type), SPECS[type].link);
    assert.ok(element.targets?.includes('http://hl7.org/fhir/StructureDefinition/Patient'), type);
  }
  // Goal stays unclassified.
  assert.equal(resourceClass('Goal'), 'ambiguous');
  assert.equal(supportForType('Goal').policy_class, 'denied');
});

test('C record decision: primary link, explicit other-patient decoys, unverifiable decoys and own-withheld controls, per type', () => {
  for (const type of NEW_TYPES) {
    const spec = SPECS[type];
    const decide = (resource: FhirResource) => authorizeRecord(resource, A, BASE);
    assert.deepEqual(decide(record(type, 'r1', patient(A), spec.decoy(patient(B)))), { kind: 'silent' }, `${type}: own record naming another patient is dropped silently`);
    assert.deepEqual(decide(record(type, 'r2', patient(B), spec.decoy(patient(A)))), { kind: 'silent' }, `${type}: another patient's record is dropped silently`);
    assert.deepEqual(decide(record(type, 'r3', patient(A), spec.decoy(patient(A)))), { kind: 'deliver', withhold: [] }, `${type}: both links bound`);
    assert.deepEqual(decide(record(type, 'r4', { identifier: { system: 'urn:synthetic:other-registry', value: 'x-1' } })), { kind: 'silent' }, `${type}: identifier-only primary link is never bound`);
    assert.deepEqual(decide(record(type, 'r5', undefined)), { kind: 'silent' }, `${type}: a missing primary link is never bound`);
    assert.deepEqual(decide(record(type, 'r6', patient(B))), { kind: 'silent' }, `${type}: foreign primary`);
    const withDecoy = record(type, 'r7', patient(A), spec.decoy(unverified()));
    if (spec.actorSlot) {
      assert.deepEqual(decide(withDecoy), { kind: 'deliver', withhold: [spec.pointer] }, `${type}: unverifiable clinical-actor reference is redacted`);
      const delivered = sanitizeForDelivery(withDecoy, A, BASE);
      assert.ok('sanitized' in delivered, type);
      if ('sanitized' in delivered) {
        assert.ok(delivered.sanitized.manifests.some(entry => entry.path === spec.pointer && entry.reason === 'UNVERIFIED_REFERENCE_WITHHELD'), type);
        assert.ok(!JSON.stringify(delivered.sanitized.resource).includes('Synthetic Clinician Seven'), `${type}: the display goes with the node`);
        assert.ok(!JSON.stringify(delivered.sanitized.resource).includes('clin-7'), `${type}: the identifier goes with the node`);
      }
    } else {
      // Not patient-capable: an identifier-only reference cannot name a patient there and is delivered whole.
      assert.deepEqual(decide(withDecoy), { kind: 'deliver', withhold: [] }, `${type}: not patient-capable, delivered whole`);
      assert.ok(JSON.stringify(sanitize(withDecoy).resource).includes('clin-7'), type);
    }
    // Own-withheld control: an unverifiable reference in an extension (no declared targets) is a defect on the patient's own record.
    const ownDefect = record(type, 'r8', patient(A), { extension: [{ url: 'urn:synthetic:ext', valueReference: { identifier: { system: 'urn:synthetic:x', value: '1' } } }] });
    assert.deepEqual(decide(ownDefect), { kind: 'own_withheld' }, `${type}: own record withheld with the coverage signal`);
    assert.deepEqual(decide({ ...ownDefect, [spec.link]: patient(B) } as FhirResource), { kind: 'silent' }, `${type}: the same defect on another patient's record stays silent`);
  }
});

test('C contained: a contained record of a new type needs its own bound link (CLS-19 rule)', () => {
  const observation = (contained: R): FhirResource => ({ resourceType: 'Observation', id: 'o1', status: 'final', code: coded('lab-1'), subject: patient(A),
    specimen: { reference: '#sp1' }, contained: [contained] }) as FhirResource;
  const specimen = (subject?: R) => ({ resourceType: 'Specimen', id: 'sp1', type: coded('blood'), ...(subject ? { subject } : {}) });
  assert.deepEqual(authorizeRecord(observation(specimen(patient(A))), A, BASE), { kind: 'deliver', withhold: [] }, 'bound contained Specimen is deliverable');
  assert.equal(authorized(observation(specimen(patient(A))), A, BASE), true);
  assert.deepEqual(authorizeRecord(observation(specimen()), A, BASE), { kind: 'own_withheld' }, 'an unlinked contained Specimen withholds the own record with the signal');
  assert.deepEqual(authorizeRecord(observation(specimen(patient(B))), A, BASE), { kind: 'silent' }, 'a contained Specimen of another patient is silent');
  // A contained Device is masked like a standalone one.
  const withDevice = observation({ resourceType: 'Device', id: 'sp1', patient: patient(A), serialNumber: 'SYN-SERIAL-CONTAINED' });
  const delivered = sanitizeForDelivery(withDevice, A, BASE);
  assert.ok('sanitized' in delivered);
  if ('sanitized' in delivered) {
    assert.ok(delivered.sanitized.manifests.some(entry => entry.path === '/contained/0/serialNumber' && entry.reason === 'DEVICE_PRODUCTION_IDENTIFIER_WITHHELD'));
    assert.ok(!JSON.stringify(delivered.sanitized.resource).includes('SYN-SERIAL-CONTAINED'));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Unit: Device and ImagingStudy masks.
// ---------------------------------------------------------------------------------------------------------------

const DEVICE: FhirResource = {
  resourceType: 'Device', id: 'dev-a', status: 'active', patient: patient(A), modelNumber: 'synthetic-model-1', manufacturer: 'Synthetic Devices',
  deviceName: [{ name: 'Synthetic infusion pump', type: 'user-friendly-name' }], type: coded('pump'),
  identifier: [{ system: 'urn:synthetic:device-asset', value: 'SYN-ASSET-1' }],
  udiCarrier: [{ deviceIdentifier: 'SYN-DI-0001', issuer: 'urn:synthetic:issuer', jurisdiction: 'urn:synthetic:jurisdiction', carrierHRF: 'SYN-HRF-(21)SERIAL' }],
  serialNumber: 'SYN-SERIAL-1', _serialNumber: { extension: [{ url: 'urn:synthetic:ext', valueString: 'SYN-SERIAL-EXT' }] },
  lotNumber: 'SYN-LOT-1', distinctIdentifier: 'SYN-DIN-1', manufactureDate: '2024-01-02', expirationDate: '2030-01-02',
  url: 'http://192.0.2.10/synthetic-device', contact: [{ system: 'phone', value: '+1-555-0100' }],
} as FhirResource;
const STUDY: FhirResource = {
  resourceType: 'ImagingStudy', id: 'img-a', status: 'available', subject: patient(A), numberOfSeries: 1,
  identifier: [{ system: 'urn:dicom:uid', value: 'urn:oid:2.25.1111' }],
  series: [{ uid: '2.25.2222', modality: { system: 'http://dicom.nema.org/resources/ontology/DCM', code: 'CT' }, bodySite: { system: 'urn:synthetic:site', code: 'chest' },
    instance: [{ uid: '2.25.3333', sopClass: { system: 'urn:ietf:rfc:3986', code: 'urn:oid:1.2.840.10008.5.1.4.1.1.2' }, number: 1 }] }],
} as FhirResource;

test('C masks: Device production identifiers, network address and contact are withheld with labels; model data stays', () => {
  const { resource, manifests } = sanitize(DEVICE);
  const reasonAt = (path: string) => manifests.filter(entry => entry.path === path).map(entry => entry.reason);
  for (const path of ['/identifier', '/udiCarrier/0/carrierHRF', '/serialNumber', '/_serialNumber', '/lotNumber', '/distinctIdentifier', '/manufactureDate', '/expirationDate']) {
    assert.deepEqual(reasonAt(path), ['DEVICE_PRODUCTION_IDENTIFIER_WITHHELD'], path);
  }
  assert.deepEqual(reasonAt('/url'), ['DEVICE_NETWORK_ADDRESS_WITHHELD']);
  assert.deepEqual(reasonAt('/contact'), ['DEVICE_CONTACT_WITHHELD']);
  const text = JSON.stringify(resource);
  for (const canary of ['SYN-ASSET-1', 'SYN-HRF', 'SYN-SERIAL', 'SYN-LOT-1', 'SYN-DIN-1', '2024-01-02', '2030-01-02', '192.0.2.10', '555-0100']) assert.ok(!text.includes(canary), canary);
  assert.equal((resource.udiCarrier as R[])[0]!.deviceIdentifier, 'SYN-DI-0001', 'the model-level device identifier stays');
  assert.equal((resource.udiCarrier as R[])[0]!.issuer, 'urn:synthetic:issuer');
  assert.equal(resource.modelNumber, 'synthetic-model-1');
  assert.equal(resource.manufacturer, 'Synthetic Devices');
  assert.deepEqual(resource.deviceName, [{ name: 'Synthetic infusion pump', type: 'user-friendly-name' }]);
  // carrierAIDC is base64Binary and keeps its payload label.
  const aidc = sanitize({ resourceType: 'Device', id: 'd2', patient: patient(A), udiCarrier: [{ deviceIdentifier: 'SYN-DI', carrierAIDC: 'U1lOLUFJREM=' }] } as FhirResource);
  assert.deepEqual(aidc.manifests.filter(entry => entry.path === '/udiCarrier/0/carrierAIDC').map(entry => entry.reason), ['V1_PAYLOAD_WITHHELD']);
});

test('C masks: ImagingStudy DICOM UIDs are withheld with labels; modality, body site and SOP class stay', () => {
  const { resource, manifests } = sanitize(STUDY);
  for (const path of ['/identifier', '/series/0/uid', '/series/0/instance/0/uid']) {
    assert.deepEqual(manifests.filter(entry => entry.path === path).map(entry => entry.reason), ['DICOM_UID_WITHHELD'], path);
  }
  const text = JSON.stringify(resource);
  for (const canary of ['2.25.1111', '2.25.2222', '2.25.3333']) assert.ok(!text.includes(canary), canary);
  const series = (resource.series as R[])[0]!;
  assert.equal(series.modality.code, 'CT');
  assert.equal(series.bodySite.code, 'chest');
  assert.equal(series.instance[0].sopClass.code, 'urn:oid:1.2.840.10008.5.1.4.1.1.2');
});

test('C masks: every masked field is a real R4 element of its type', () => {
  for (const field of PATIENT_RECORD_MASKS.keys()) {
    const [type, ...path] = field.split('.');
    let context = resourceTypeContext(type!);
    let element;
    for (const key of path) { element = resolveElement(context, key); context = element.context!; }
    assert.ok(element?.types.length, field);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Unit: predicates over masked fields, derived from the pinned R4 expressions.
// ---------------------------------------------------------------------------------------------------------------

const declarations = (type: string) => [
  { name: '_id', type: 'token', source_description_present: false },
  ...catalog.definitions.filter(d => d.base.includes(type)).map(d => ({ name: d.code, type: d.type, source_description_present: false })),
];

test('C masked predicates: exactly the pinned parameters that reach a withheld field are refused, across all patient-linked types', () => {
  const flagged: string[] = [];
  for (const type of classifiedTypes().filter(candidate => resourceClass(candidate) === 'patient')) {
    const resolved = resolveSearchParameters({ resourceType: type, declared: declarations(type), advertised: true });
    for (const [name, entry] of resolved.byName) if (maskedPatientPredicate(type, entry)) flagged.push(`${type}.${name}`);
  }
  // If a pinned parameter starts to reach a masked path, or a mask is added, this list must be checked again.
  assert.deepEqual(flagged.sort(), ['Device.din', 'Device.identifier', 'Device.udi-carrier', 'Device.url', 'ImagingStudy.identifier', 'ImagingStudy.instance', 'ImagingStudy.series'].sort());
});

test('C masked predicates: a path equal to, inside or above a masked field, or an extension on a masked type, is refused; siblings are not', () => {
  const entry = (pinnedExpression: string) => ({ pinnedExpression }) as unknown as Parameters<typeof maskedPatientPredicate>[1];
  assert.equal(maskedPatientPredicate('Device', entry('Device.serialNumber')), true, 'equal');
  assert.equal(maskedPatientPredicate('Device', entry('Device.identifier.value')), true, 'inside');
  assert.equal(maskedPatientPredicate('Device', entry('Device.udiCarrier')), true, 'above');
  assert.equal(maskedPatientPredicate('ImagingStudy', entry('ImagingStudy.series')), true, 'above a nested mask');
  assert.equal(maskedPatientPredicate('Device', entry("Device.extension('urn:synthetic:ext')")), true, 'extension on a masked type');
  assert.equal(maskedPatientPredicate('Device', entry('Device.udiCarrier.deviceIdentifier')), false, 'sibling of a masked field');
  assert.equal(maskedPatientPredicate('ImagingStudy', entry('ImagingStudy.series.instance.sopClass')), false, 'sibling of a nested mask');
  assert.equal(maskedPatientPredicate('Observation', entry("Observation.extension('urn:synthetic:ext')")), false, 'a type without masks');
  assert.equal(maskedPatientPredicate('Device', entry('Observation.identifier')), false, 'another type\'s path');
});

test('C masked predicates: admission refuses them as filters and as sort keys; neighbouring parameters stay admitted', () => {
  const admit = (type: string, pairs: { name: string; value: string }[], sort: string[] = []) => validateSearchAdmission({
    resourceType: type, pairs, resolved: resolveSearchParameters({ resourceType: type, declared: declarations(type), advertised: true }), patientId: A, confinementName: 'patient', sort,
  });
  const refused = (fn: () => void, label: string) => assert.throws(fn, (error: any) => error.code === 'POLICY_DENIED', label);
  for (const [type, name] of [['Device', 'identifier'], ['Device', 'udi-carrier'], ['Device', 'url'], ['Device', 'din'], ['ImagingStudy', 'identifier'], ['ImagingStudy', 'series'], ['ImagingStudy', 'instance']] as const) {
    refused(() => admit(type, [{ name, value: 'x' }]), `${type} ${name}`);
  }
  refused(() => admit('Device', [], ['identifier']), 'sort key over a masked field');
  refused(() => admit('ImagingStudy', [], ['-series']), 'descending sort key over a masked field');
  for (const [type, name] of [['Device', 'udi-di'], ['Device', 'device-name'], ['Device', 'model'], ['Device', 'status'], ['ImagingStudy', 'modality'], ['ImagingStudy', 'dicom-class'], ['ImagingStudy', 'bodysite'], ['ImagingStudy', 'started']] as const) {
    assert.doesNotThrow(() => admit(type, [{ name, value: 'x' }]), `${type} ${name}`);
  }
  assert.doesNotThrow(() => admit('Device', [], ['status']));
  // Identifier predicates on the other new types reach no withheld field (accession and order identifiers are delivered).
  for (const type of ['MedicationAdministration', 'MedicationDispense', 'Specimen', 'CarePlan', 'CareTeam']) assert.doesNotThrow(() => admit(type, [{ name: 'identifier', value: 'urn:synthetic:acc|1' }]), type);
});

// ---------------------------------------------------------------------------------------------------------------
// Gateway: a synthetic source advertising the new types.
// ---------------------------------------------------------------------------------------------------------------

function dataset(): R[] {
  const records: R[] = [{ resourceType: 'Patient', id: A, active: true }];
  for (const type of NEW_TYPES) {
    records.push(record(type, `${type.toLowerCase()}-a`, patient(A)));
    records.push(record(type, `${type.toLowerCase()}-b`, patient(B)));
  }
  // Narrow redaction on CareTeam: an identifier-only member is redacted and the team is delivered.
  records.push(record('CareTeam', 'careteam-a2', patient(A), SPECS.CareTeam.decoy(unverified())));
  // Honest coverage on CarePlan: an own record with a defect is withheld with the signal.
  records.push(record('CarePlan', 'careplan-withheld', patient(A), { contained: [{ resourceType: 'Basic', id: 'b1', code: coded('x') }] }));
  // Masked records.
  records.push({ ...DEVICE, id: 'device-masked' }, { ...STUDY, id: 'imagingstudy-masked' });
  // Specimen targets for the specimen= search.
  records.push({ resourceType: 'Observation', id: 'obs-sp-a', status: 'final', code: coded('lab-1'), subject: patient(A), specimen: { reference: 'Specimen/specimen-a' } });
  records.push({ resourceType: 'Observation', id: 'obs-sp-b', status: 'final', code: coded('lab-1'), subject: patient(B), specimen: { reference: 'Specimen/specimen-b' } });
  return records;
}
const LINK_FIELD: Record<string, string> = { patient: 'patient', subject: 'subject', specimen: 'specimen' };
const refsOf = (resource: R, field: string): string[] => {
  const value = field === 'patient' ? resource.patient ?? resource.subject : resource[field];
  return (Array.isArray(value) ? value : value ? [value] : []).map((item: R) => item?.reference).filter((ref: unknown): ref is string => typeof ref === 'string');
};
const ADVERTISED = ['Patient', 'Observation', ...NEW_TYPES];

async function startSource(t: TestContext, options: { leaky?: boolean } = {}) {
  const db = dataset();
  const requests: URL[] = [];
  let base = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url!, base);
    requests.push(url);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname === '/fhir/metadata') {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', status: 'active', kind: 'instance', fhirVersion: '4.0.1', format: ['json'], software: { name: 'added types source' },
        rest: [{ mode: 'server', resource: ADVERTISED.map(type => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: declarations(type) })) }] }));
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
      if (['_count', '_sort'].includes(name)) continue;
      if (options.leaky && (name === 'patient' || name === 'subject')) continue;
      const alternatives = value.split(',');
      if (name === '_id') { selected = selected.filter(r => alternatives.includes(r.id)); continue; }
      const field = LINK_FIELD[name];
      if (field) selected = selected.filter(r => refsOf(r, field).some(ref => alternatives.includes(ref)));
    }
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }],
      entry: selected.map(resource => ({ resource, search: { mode: 'match' } })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/fhir/`;
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { base, requests, clinical: () => requests.filter(url => !url.pathname.endsWith('/metadata')) };
}
const output = { format: 'fhir', max_bytes: 24576 } as const;
async function gatewayFor(t: TestContext, options: { leaky?: boolean } = {}) {
  const source = await startSource(t, options);
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'added-types', baseUrl: source.base }, patientId: A, contextId: 'added-types-context' });
  t.after(() => gateway.close());
  const search = (resource_type: string, params: { name: string; value: string }[] = [], out: R = output) => gateway.execute('fhir_search', { resource_type, params, output: out });
  const read = (resource_type: string, id: string) => gateway.execute('fhir_read', { resource_type, id, interaction: 'read', output });
  return { ...source, gateway, search, read };
}
const ids = (envelope: GatewayEnvelope) => ((envelope.data as { resources?: R[] }).resources ?? []).map(r => r.id).sort();
const resources = (envelope: GatewayEnvelope) => (envelope.data as { resources?: R[] }).resources ?? [];

test('C gateway: every new type is searched with the bound patient pair and returns only own records, even from a leaky source', async t => {
  const f = await gatewayFor(t, { leaky: true });
  for (const type of NEW_TYPES) {
    const before = f.clinical().length;
    const found = await f.search(type);
    assert.equal(found.error, undefined, `${type}: ${JSON.stringify(found.error)}`);
    assert.equal(f.clinical().length, before + 1, type);
    const sent = f.clinical().at(-1)!;
    assert.equal(sent.pathname, `/fhir/${type}`, type);
    assert.equal(sent.searchParams.get('patient'), `Patient/${A}`, `${type}: confinement pair`);
    const own = ids(found);
    assert.ok(own.includes(`${type.toLowerCase()}-a`), type);
    assert.ok(!own.some(id => id.endsWith('-b')), `${type}: another patient's record never delivered`);
    assert.equal(found.coverage.reasons?.includes('RECORDS_WITHHELD_BY_POLICY') ?? false, type === 'CarePlan', `${type}: only the defective own CarePlan signals`);
    // A read of another patient's record is the uniform NOT_FOUND.
    assert.equal((await f.read(type, `${type.toLowerCase()}-b`)).error?.code, 'NOT_FOUND', type);
    assert.equal((await f.read(type, `${type.toLowerCase()}-a`)).error, undefined, type);
  }
});

test('C gateway: the support topic lists each advertised new type as executable', async t => {
  const f = await gatewayFor(t);
  for (const type of NEW_TYPES) {
    const support = await f.gateway.execute('fhir_capabilities', { topic: 'support', resource_type: type });
    assert.equal(support.error, undefined, type);
    const row = (support.data as { rows: R[] }).rows[0]!;
    assert.equal(row.resource_type, type);
    assert.equal(row.policy_class, 'patient', type);
    assert.deepEqual(row.executable_interactions, ['read', 'search-type'], type);
  }
  // 32 rows page in two support pages at the 25-row maximum.
  const first = await f.gateway.execute('fhir_capabilities', { topic: 'support', limit: 25, output: { max_bytes: 131072 } });
  const firstRows = (first.data as { rows: R[]; next_cursor?: string }).rows;
  const cursor = (first.data as { next_cursor?: string }).next_cursor;
  assert.ok(cursor, 'a second page follows');
  const second = await f.gateway.execute('fhir_capabilities', { topic: 'support', cursor, limit: 25, output: { max_bytes: 131072 } });
  assert.deepEqual([...firstRows, ...(second.data as { rows: R[] }).rows].map(row => row.resource_type), classifiedTypes());
});

test('C gateway: compact output falls back to the sanitized view with COMPACT_RECIPE_UNAVAILABLE', async t => {
  const f = await gatewayFor(t);
  for (const type of NEW_TYPES) {
    const compact = await f.search(type, [], { format: 'compact', max_bytes: 24576 });
    assert.equal(compact.error, undefined, type);
    assert.ok(compact.warnings.some(warning => warning.code === 'COMPACT_RECIPE_UNAVAILABLE'), type);
    assert.deepEqual(compact.transform.recipe_ids, [], type);
  }
});

test('C gateway: Device and ImagingStudy masks reach the wire with labels; A2 redacts an unverifiable CareTeam member', async t => {
  const f = await gatewayFor(t);
  const device = await f.read('Device', 'device-masked');
  assert.equal(device.error, undefined);
  const deviceText = JSON.stringify(device.data);
  for (const canary of ['SYN-ASSET-1', 'SYN-HRF', 'SYN-SERIAL', 'SYN-LOT-1', 'SYN-DIN-1', '192.0.2.10', '555-0100']) assert.ok(!deviceText.includes(canary), canary);
  for (const [path, reason] of [['/serialNumber', 'DEVICE_PRODUCTION_IDENTIFIER_WITHHELD'], ['/url', 'DEVICE_NETWORK_ADDRESS_WITHHELD'], ['/contact', 'DEVICE_CONTACT_WITHHELD']]) {
    assert.ok(device.transform.withheld_payloads.some(entry => entry.path === path && entry.reason === reason), path);
  }
  const study = await f.read('ImagingStudy', 'imagingstudy-masked');
  assert.equal(study.error, undefined);
  assert.ok(!JSON.stringify(study.data).includes('2.25.'), 'no DICOM UID reaches the agent');
  assert.ok(study.transform.withheld_payloads.some(entry => entry.path === '/series/0/instance/0/uid' && entry.reason === 'DICOM_UID_WITHHELD'));
  const teams = await f.search('CareTeam');
  assert.ok(ids(teams).includes('careteam-a2'));
  assert.equal(teams.coverage.reasons?.includes('RECORDS_WITHHELD_BY_POLICY') ?? false, false, 'redaction is not withholding a record');
  assert.ok(teams.transform.withheld_payloads.some(entry => entry.path === '/participant/0/member' && entry.reason === 'UNVERIFIED_REFERENCE_WITHHELD'));
  assert.ok(!JSON.stringify(teams.data).includes('Synthetic Clinician Seven'));
});

test('C gateway: masked predicates and sort keys are refused before anything is sent', async t => {
  const f = await gatewayFor(t);
  await f.search('Device');
  const before = f.clinical().length;
  for (const [type, params] of [
    ['Device', [{ name: 'identifier', value: 'urn:synthetic:device-asset|SYN-ASSET-1' }]],
    ['Device', [{ name: 'udi-carrier', value: 'SYN-HRF' }]],
    ['Device', [{ name: '_sort', value: 'identifier' }]],
    ['ImagingStudy', [{ name: 'series', value: '2.25.2222' }]],
    ['ImagingStudy', [{ name: 'instance', value: '2.25.3333' }]],
    ['ImagingStudy', [{ name: 'identifier', value: 'urn:dicom:uid|urn:oid:2.25.1111' }]],
  ] as const) {
    const refused = await f.search(type, [...params]);
    assert.equal(refused.error?.code, 'POLICY_DENIED', `${type} ${JSON.stringify(params)}`);
  }
  assert.equal(f.clinical().length, before, 'zero requests for masked predicates');
  const allowed = await f.search('ImagingStudy', [{ name: 'modality', value: 'CT' }]);
  assert.equal(allowed.error, undefined);
});

test('C gateway: specimen= on Observation is admitted only for the patient\'s own Specimen, checked by a confined search first', async t => {
  // A target not yet delivered is first checked with the confined search Specimen?_id=<id>&patient=Patient/<bound>; it is never read directly.
  const f = await gatewayFor(t);
  const before = f.clinical().length;
  const scoped = await f.search('Observation', [{ name: 'specimen', value: 'Specimen/specimen-a' }]);
  assert.equal(scoped.error, undefined, JSON.stringify(scoped.error));
  assert.deepEqual(ids(scoped), ['obs-sp-a']);
  const sent = f.clinical().slice(before);
  assert.deepEqual(sent.map(url => [url.pathname, [...url.searchParams]]), [
    ['/fhir/Specimen', [['_id', 'specimen-a'], ['patient', `Patient/${A}`], ['_count', '1']]],
    ['/fhir/Observation', [['specimen', 'Specimen/specimen-a'], ['patient', `Patient/${A}`], ['_count', '20']]],
  ]);
  const count = f.clinical().length;
  assert.equal((await f.search('Observation', [{ name: 'specimen', value: 'Specimen/specimen-b' }])).error?.code, 'POLICY_DENIED', 'another patient\'s Specimen is never trusted');
  assert.deepEqual(f.clinical().slice(count).map(url => url.pathname), ['/fhir/Specimen'], 'only the confined check is sent');
});

test('C gateway: a delivered own Device never becomes a patient-link selector (Observation.subject can target Device)', async t => {
  const f = await gatewayFor(t);
  assert.ok(ids(await f.search('Device')).includes('device-a'));
  const before = f.clinical().length;
  for (const name of ['subject', 'patient']) {
    const refused = await f.search('Observation', [{ name, value: 'Device/device-a' }]);
    assert.equal(refused.error?.code, 'POLICY_DENIED', `${name}=Device/<own> is refused`);
  }
  assert.equal(f.clinical().length, before, 'nothing is sent');
  // The `device` parameter is not a patient link: a delivered own Device is admitted there and the search is still confined.
  const byDevice = await f.search('Observation', [{ name: 'device', value: 'Device/device-a' }]);
  assert.equal(byDevice.error, undefined, JSON.stringify(byDevice.error));
  assert.equal(f.clinical().at(-1)!.searchParams.get('patient'), `Patient/${A}`);
});

// ---------------------------------------------------------------------------------------------------------------
// Real MCP SDK over stdio, both protocol eras.
// ---------------------------------------------------------------------------------------------------------------

for (const era of ['modern', 'legacy'] as const) test(`C stdio ${era}: CareTeam is confined, redacted and listed as supported`, async t => {
  const source = await startSource(t, { leaky: true });
  const dir = await mkdtemp(join(tmpdir(), 'w1c-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ mode: 'synthetic', source: { alias: 'added-types', baseUrl: source.base }, patientId: A }));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'packages/server/src/cli.ts', '--config', config],
    env: { ...getDefaultEnvironment(), TMPDIR: tmpdir() }, stderr: 'pipe' });
  const client = new Client({ name: 'added-types', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  await client.connect(transport);
  t.after(() => client.close());
  const call = async (name: string, args: R) => (await client.callTool({ name, arguments: args })).structuredContent as GatewayEnvelope;
  const support = await call('fhir_capabilities', { topic: 'support', resource_type: 'CareTeam' });
  assert.deepEqual((support.data as { rows: R[] }).rows[0]!.executable_interactions, ['read', 'search-type']);
  const teams = await call('fhir_search', { resource_type: 'CareTeam', params: [], output });
  assert.equal(teams.error, undefined, JSON.stringify(teams.error));
  assert.deepEqual(ids(teams), ['careteam-a', 'careteam-a2']);
  assert.equal(source.clinical().at(-1)!.searchParams.get('patient'), `Patient/${A}`);
  assert.ok(teams.transform.withheld_payloads.some(entry => entry.path === '/participant/0/member' && entry.reason === 'UNVERIFIED_REFERENCE_WITHHELD'));
  assert.ok(!JSON.stringify(teams).includes('Synthetic Clinician Seven'));
  assert.ok(!JSON.stringify(teams).includes(B), 'nothing about the other patient reaches the agent');
  assert.equal(resources(teams).every(resource => resource.subject?.reference === `Patient/${A}`), true);
  assert.equal((await call('fhir_read', { resource_type: 'CareTeam', id: 'careteam-b', output })).error?.code, 'NOT_FOUND');
});
