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
// J-44: same-patient decoys, each excluded by exactly one search predicate. A backend (or gateway) that drops or
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
  console.log(JSON.stringify({ target: 'local-hapi', ...duplicateEvidence, metadata_requests: trace.counts.metadata, auth_requests: trace.counts.auth, clinical_requests: trace.counts.clinical, fhir_version: caps.source.fhir_version, pages, authorized_observations: ids.length, single_predicate_decoys_excluded: decoys.length, wrong_patient_denied: true, inline_payload_withheld: true, duplicate_confinement_pair: true }));
} finally { trace.stop(); gateway.close(); }
