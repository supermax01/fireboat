import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { FhirGateway } from '../packages/core/src/index.js';
import { isDeepStrictEqual } from 'node:util';
import { startQueryCapture, verifyDuplicateQueries } from './query-evidence-capture.js';

// This script seeds a controlled loopback test server. It is never a
// production-data import and is not exposed as an MCP mutation tool.
const base = new URL(process.env['HAPI_FHIR_BASE_URL'] ?? 'http://127.0.0.1:18080/fhir/');
assert.ok(['127.0.0.1', '[::1]'].includes(base.hostname) && ['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash, 'HAPI tests require a literal loopback synthetic endpoint');
base.pathname = base.pathname.replace(/\/+$/, '') + '/';
const patientA = 'synthetic-patient-a';
const patientB = 'synthetic-patient-b';

async function ready(): Promise<void> {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('metadata', base), { headers: { accept: 'application/fhir+json' }, signal: AbortSignal.timeout(3000) });
      if (response.ok && (await response.json() as { resourceType?: string }).resourceType === 'CapabilityStatement') return;
    } catch { /* Java/database startup is expected; retry within the fixed deadline. */ }
    await setTimeout(1500);
  }
  throw new Error('Local HAPI did not become ready within three minutes');
}

async function seed(resource: Record<string, unknown>): Promise<void> {
  const response = await fetch(new URL(`${resource.resourceType}/${resource.id}`, base), {
    method: 'PUT', headers: { 'content-type': 'application/fhir+json', accept: 'application/fhir+json' }, body: JSON.stringify(resource), signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `Synthetic seed failed: HTTP ${response.status}`);
  await response.body?.cancel();
}

await ready();
for (const id of [patientA, patientB]) await seed({ resourceType: 'Patient', id, active: true, name: [{ family: 'Synthetic', given: [id === patientA ? 'Alpha' : 'Beta'] }] });
for (let i = 1; i <= 4; i++) await seed({
  resourceType: 'Observation', id: `mcp-hapi-obs-${i}`, status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'Synthetic test HbA1c' }] },
  subject: { reference: `Patient/${i === 4 ? patientB : patientA}` }, effectiveDateTime: `2026-01-0${i}T10:00:00Z`,
  valueQuantity: { value: i === 4 ? 9.9 : 7.1, unit: '%', system: 'http://unitsofmeasure.org', code: '%' },
});
// Same-patient decoys, each excluded by exactly one search predicate. A backend (or gateway) that drops or
// mis-evaluates that predicate returns the decoy, so the filtered search below fails instead of passing vacuously.
const decoys = [
  { id: 'mcp-hapi-decoy-code', predicate: 'code=4548-4', code: '2345-7', date: '2026-01-02T12:00:00Z' },
  { id: 'mcp-hapi-decoy-before', predicate: 'date=ge2026-01-01', code: '4548-4', date: '2025-12-31T12:00:00Z' },
  { id: 'mcp-hapi-decoy-after', predicate: 'date=lt2026-02-01', code: '4548-4', date: '2026-02-01T12:00:00Z' },
];
for (const decoy of decoys) await seed({
  resourceType: 'Observation', id: decoy.id, status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: decoy.code, display: 'Synthetic predicate decoy' }] },
  subject: { reference: `Patient/${patientA}` }, effectiveDateTime: decoy.date,
  valueQuantity: { value: 6.5, unit: '%', system: 'http://unitsofmeasure.org', code: '%' },
});
const payload = Buffer.from('synthetic attachment test bytes').toString('base64');
await seed({ resourceType: 'DocumentReference', id: 'mcp-hapi-doc', status: 'current', subject: { reference: `Patient/${patientA}` }, content: [{ attachment: { contentType: 'text/plain', data: payload, title: 'Synthetic test attachment' } }] });

// The seven newer patient-linked types: one minimal record for each patient. Device links by `patient`, the others by
// `subject`. The bound patient's Device and ImagingStudy also carry distinctive values in every field the gateway
// withholds, so withholding is checked on what a real server returns, not only on hand-written unit fixtures.
type Fields = Record<string, unknown>;
const coded = (code: string) => ({ coding: [{ system: 'urn:synthetic:hapi-code', code, display: `Synthetic ${code}` }] });
interface Withheld { fields: Fields; canaries: string[]; labels: [string, string][]; kept: (resource: any) => boolean }
const newerTypes: { type: string; link: 'subject' | 'patient'; base: Fields; withheld?: Withheld }[] = [
  { type: 'MedicationAdministration', link: 'subject', base: { status: 'completed', medicationCodeableConcept: coded('med-1'), effectiveDateTime: '2026-01-05T09:00:00Z' } },
  { type: 'MedicationDispense', link: 'subject', base: { status: 'completed', medicationCodeableConcept: coded('med-1') } },
  { type: 'Specimen', link: 'subject', base: { status: 'available', type: coded('blood') } },
  { type: 'CarePlan', link: 'subject', base: { status: 'active', intent: 'plan' } },
  { type: 'CareTeam', link: 'subject', base: { status: 'active', name: 'Synthetic care team' } },
  { type: 'ImagingStudy', link: 'subject', base: { status: 'available' }, withheld: {
    fields: {
      numberOfSeries: 1, identifier: [{ system: 'urn:dicom:uid', value: 'urn:oid:2.25.7301001' }],
      series: [{ uid: '2.25.7301002', modality: { system: 'http://dicom.nema.org/resources/ontology/DCM', code: 'CT' },
        instance: [{ uid: '2.25.7301003', sopClass: { system: 'urn:ietf:rfc:3986', code: 'urn:oid:1.2.840.10008.5.1.4.1.1.2' }, number: 1 }] }],
      extension: [{ url: 'urn:synthetic:hapi-study-ext', valueString: 'SYNTHETIC-HAPI-STUDY-EXT-7302' }],
    },
    canaries: ['2.25.7301', 'SYNTHETIC-HAPI-STUDY-EXT-7302'],
    labels: [['/identifier', 'DICOM_UID_WITHHELD'], ['/series/0/uid', 'DICOM_UID_WITHHELD'], ['/series/0/instance/0/uid', 'DICOM_UID_WITHHELD'], ['/extension', 'UNREVIEWED_EXTENSION_WITHHELD']],
    // Positive control: the study itself arrived, with the fields that are not withheld.
    kept: study => study.series?.[0]?.modality?.code === 'CT' && study.series[0].instance?.[0]?.sopClass?.code === 'urn:oid:1.2.840.10008.5.1.4.1.1.2',
  } },
  { type: 'Device', link: 'patient', base: { status: 'active', modelNumber: 'synthetic-model-7301' }, withheld: {
    fields: {
      identifier: [{ system: 'urn:synthetic:hapi-device-asset', value: 'SYNTHETIC-HAPI-ASSET-7301' }],
      udiCarrier: [{ deviceIdentifier: 'SYNTHETIC-HAPI-MODEL-DI-7301', issuer: 'urn:synthetic:hapi-issuer', carrierHRF: 'SYNTHETIC-HAPI-HRF-7301' }],
      serialNumber: 'SYNTHETIC-HAPI-SERIAL-7301', lotNumber: 'SYNTHETIC-HAPI-LOT-7301', distinctIdentifier: 'SYNTHETIC-HAPI-DIN-7301',
      manufactureDate: '2019-03-17', expirationDate: '2031-09-23',
      url: 'http://192.0.2.73/synthetic-hapi-device', contact: [{ system: 'phone', value: '+1-555-0173' }],
      extension: [{ url: 'urn:synthetic:hapi-device-ext', valueString: 'SYNTHETIC-HAPI-DEVICE-EXT-7301' }],
    },
    canaries: ['SYNTHETIC-HAPI-ASSET-7301', 'SYNTHETIC-HAPI-HRF-7301', 'SYNTHETIC-HAPI-SERIAL-7301', 'SYNTHETIC-HAPI-LOT-7301', 'SYNTHETIC-HAPI-DIN-7301',
      '2019-03-17', '2031-09-23', '192.0.2.73', '555-0173', 'SYNTHETIC-HAPI-DEVICE-EXT-7301'],
    labels: [
      ...['/identifier', '/udiCarrier/0/carrierHRF', '/serialNumber', '/lotNumber', '/distinctIdentifier', '/manufactureDate', '/expirationDate']
        .map(path => [path, 'DEVICE_PRODUCTION_IDENTIFIER_WITHHELD'] as [string, string]),
      ['/url', 'DEVICE_NETWORK_ADDRESS_WITHHELD'], ['/contact', 'DEVICE_CONTACT_WITHHELD'], ['/extension', 'UNREVIEWED_EXTENSION_WITHHELD'],
    ],
    // Positive control: the model-level device data is delivered, so the device really came back from the server.
    kept: device => device.modelNumber === 'synthetic-model-7301' && device.udiCarrier?.[0]?.deviceIdentifier === 'SYNTHETIC-HAPI-MODEL-DI-7301',
  } },
];
const newerId = (type: string, patient: string) => `mcp-hapi-${type.toLowerCase()}-${patient === patientA ? 'a' : 'b'}`;
for (const spec of newerTypes) for (const patient of [patientA, patientB]) await seed({
  resourceType: spec.type, id: newerId(spec.type, patient), ...spec.base, [spec.link]: { reference: `Patient/${patient}` },
  ...(patient === patientA ? spec.withheld?.fields : {}),
});

const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'local-hapi', baseUrl: base.href }, patientId: patientA });
const trace = startQueryCapture(base);
try {
  const caps = await gateway.execute('fhir_capabilities', { topic: 'server' });
  assert.equal(caps.error, undefined);
  let result = await gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 1, params: [{ name: 'code', value: 'http://loinc.org|4548-4' }, { name: 'date', value: 'ge2026-01-01' }, { name: 'date', value: 'lt2026-02-01' }, { name: '_sort', value: 'date' }] });
  const ids: string[] = [];
  let pages = 0;
  while (true) {
    assert.equal(result.error?.code, undefined, 'ordinary search succeeds');
    const resources = result.data.resources as { id: string; subject: { reference: string } }[];
    for (const resource of resources) { assert.ok(resource.subject.reference === `Patient/${patientA}`, 'ordinary authorized linkage'); ids.push(resource.id); }
    pages++;
    const cursor = result.pagination?.next_cursor;
    if (!cursor) break;
    assert.ok(pages < 20, 'HAPI continuation must terminate');
    result = await gateway.execute('fhir_page', { cursor });
  }
  for (const decoy of decoys) {
    assert.ok(!ids.includes(decoy.id), 'single-predicate decoy excluded');
    // Positive control: the decoy exists and is linked to the trusted patient, so only the predicate excluded it.
    assert.equal((await gateway.execute('fhir_read', { resource_type: 'Observation', id: decoy.id })).error, undefined, 'single-predicate decoy seeded and readable');
  }
  assert.ok(isDeepStrictEqual(ids, ['mcp-hapi-obs-1', 'mcp-hapi-obs-2', 'mcp-hapi-obs-3']), 'ordinary authorized record sequence');
  assert.ok(pages >= 2);
  assert.equal((await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'mcp-hapi-obs-4' })).error?.code, 'NOT_FOUND');
  const doc = await gateway.execute('fhir_read', { resource_type: 'DocumentReference', id: 'mcp-hapi-doc', output: { format: 'fhir' } });
  assert.equal(doc.error, undefined);
  assert.ok(doc.transform.withheld_payloads.length > 0);
  assert.ok(!JSON.stringify(doc).includes(payload));
  const duplicateEvidence = await verifyDuplicateQueries(gateway, trace, patientA, ['mcp-hapi-obs-1', 'mcp-hapi-obs-2', 'mcp-hapi-obs-3'], false);
  // The request counts above describe the Observation and Patient checks only. Freeze them and stop the capture
  // before the newer-type checks, which use their own gateway, so those counts and the duplicate-query evidence
  // stay exactly what they were before these checks existed.
  const counts = { ...trace.counts };
  trace.stop();

  const typesGateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'local-hapi', baseUrl: base.href }, patientId: patientA });
  let searchesExact = 0; let readsDenied = 0; let withheldOutputs = 0;
  try {
    for (const spec of newerTypes) {
      const own = newerId(spec.type, patientA);
      const other = newerId(spec.type, patientB);
      // The fhir format always. Where there is withholding to check, also the omitted format (which resolves to fhir)
      // and compact, which these types have no reviewed recipe for and so fall back to the sanitized view.
      for (const output of spec.withheld ? [{ format: 'fhir' }, undefined, { format: 'compact' }] : [{ format: 'fhir' }]) {
        const shape = output ? { output } : {};
        const found = await typesGateway.execute('fhir_search', { resource_type: spec.type, params: [], ...shape });
        assert.equal(found.error, undefined, `${spec.type} search succeeds`);
        const resources = found.data.resources as Fields[];
        assert.ok(isDeepStrictEqual(resources.map(resource => resource.id), [own]), `${spec.type} search returns exactly the bound patient's record`);
        assert.ok(resources.every(resource => (resource[spec.link] as { reference?: string } | undefined)?.reference === `Patient/${patientA}`), `${spec.type} delivered record is linked to the bound patient`);
        assert.ok(!JSON.stringify(found).includes(other) && !JSON.stringify(found).includes(patientB), `${spec.type} search says nothing about the other patient`);
        if (output?.format === 'fhir') searchesExact++;
        const read = await typesGateway.execute('fhir_read', { resource_type: spec.type, id: own, ...shape });
        assert.equal(read.error, undefined, `${spec.type} read of the bound patient's record succeeds`);
        assert.ok(isDeepStrictEqual((read.data.resources as Fields[]).map(resource => resource.id), [own]), `${spec.type} read returns the bound patient's record`);
        if (!spec.withheld) continue;
        for (const result of [found, read]) {
          const text = JSON.stringify(result);
          for (const canary of spec.withheld.canaries) assert.ok(!text.includes(canary), `${spec.type} withheld value absent from the tool result`);
          for (const [path, reason] of spec.withheld.labels) {
            assert.ok(result.transform.withheld_payloads.some(entry => entry.path === path && entry.reason === reason), `${spec.type} ${path} labelled ${reason}`);
          }
          assert.ok(spec.withheld.kept((result.data.resources as Fields[])[0]), `${spec.type} fields that are not withheld are delivered`);
          assert.equal(result.transform.format, output?.format ?? 'fhir', `${spec.type} delivered in the expected format`);
          if (output?.format === 'compact') assert.ok(result.warnings.some(warning => warning.code === 'COMPACT_RECIPE_UNAVAILABLE'), `${spec.type} compact falls back to the sanitized view`);
          withheldOutputs++;
        }
      }
      // The other patient's record exists on the server (its seed succeeded), so only the gateway denies it.
      assert.equal((await typesGateway.execute('fhir_read', { resource_type: spec.type, id: other })).error?.code, 'NOT_FOUND', `${spec.type} other patient's read is NOT_FOUND`);
      readsDenied++;
    }
  } finally { typesGateway.close(); }
  const withheldFields = newerTypes.reduce((sum, spec) => sum + (spec.withheld?.labels.length ?? 0), 0);

  console.log(JSON.stringify({ target: 'local-hapi', ...duplicateEvidence, metadata_requests: counts.metadata, auth_requests: counts.auth, clinical_requests: counts.clinical, fhir_version: caps.source.fhir_version, pages, authorized_observations: ids.length, single_predicate_decoys_excluded: decoys.length, wrong_patient_denied: true, inline_payload_withheld: true, duplicate_confinement_pair: true, newer_types_checked: newerTypes.length, newer_types_searches_exact: searchesExact, newer_types_other_patient_reads_denied: readsDenied, withheld_fields_checked: withheldFields, withheld_outputs_checked: withheldOutputs }));
} finally { trace.stop(); gateway.close(); }
