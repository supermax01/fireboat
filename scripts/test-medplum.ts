import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { FhirGateway } from '../packages/core/src/index.js';
import { isDeepStrictEqual } from 'node:util';
import { startQueryCapture, verifyDuplicateQueries } from './query-evidence-capture.js';

// Disposable self-hosted test stack only. Bootstrap credentials below are
// intentionally public synthetic defaults, never a production registration.
const base = new URL(process.env['MEDPLUM_TEST_BASE_URL'] ?? 'http://127.0.0.1:18103/');
assert.ok(['127.0.0.1', '[::1]'].includes(base.hostname) && ['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'Medplum tests require the isolated literal-loopback stack');
const tokenUrl = new URL('oauth2/token', base);
const bootstrapId = '11111111-1111-4111-8111-111111111111';
const bootstrapSecret = 'synthetic_bootstrap_only_never_use_for_real_data';
const secretEnv = 'FHIR_MCP_MEDPLUM_TEST_CLIENT_SECRET';
type Resource = Record<string, unknown> & { resourceType: string; id: string };

async function jsonRequest(path: string, method = 'GET', token?: string, body?: unknown): Promise<Record<string, unknown>> {
  const url = new URL(path, base);
  assert.ok(url.origin === base.origin, 'setup request stays at the configured origin');
  const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { accept: 'application/fhir+json, application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/fhir+json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Synthetic Medplum setup request rejected (HTTP ${response.status})`); }
  try { return await response.json() as Record<string, unknown>; } catch { throw new Error('Synthetic Medplum returned invalid JSON'); }
}
async function ready(): Promise<void> {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('healthcheck', base), { redirect: 'error', signal: AbortSignal.timeout(3000) });
      const ok = response.ok; await response.body?.cancel(); if (ok) return;
    } catch { /* Bounded startup wait for migrations and base-definition seeding. */ }
    await setTimeout(1500);
  }
  throw new Error('Isolated Medplum stack did not become ready within four minutes');
}
async function token(clientId: string, clientSecret: string): Promise<string> {
  const response = await fetch(tokenUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Synthetic token request rejected (HTTP ${response.status})`); }
  let value: Record<string, unknown>;
  try { value = await response.json() as Record<string, unknown>; } catch { throw new Error('Synthetic token response is invalid'); }
  assert.equal(typeof value.access_token, 'string', 'Synthetic client must receive an access token');
  return value.access_token as string;
}

await ready();
const adminToken = await token(bootstrapId, bootstrapSecret);
const project = await jsonRequest('fhir/R4/Project', 'POST', adminToken, { resourceType: 'Project', name: 'FHIR MCP synthetic integration', strictMode: true }) as Resource;
assert.equal(typeof project.id, 'string');
const client = await jsonRequest(`admin/projects/${project.id}/client`, 'POST', adminToken, { name: 'Synthetic MCP retrieval client' }) as Resource;
assert.equal(typeof client.secret, 'string', 'Disposable project client must have a generated secret');
const projectToken = await token(client.id, client.secret as string);

async function seed(resource: Record<string, unknown>): Promise<Resource> {
  return await jsonRequest(`fhir/R4/${resource.resourceType}`, 'POST', adminToken, { ...resource, meta: { project: project.id } }) as Resource;
}
const patientA = await seed({ resourceType: 'Patient', active: true, name: [{ family: 'Synthetic', given: ['Alpha'] }] });
const patientB = await seed({ resourceType: 'Patient', active: true, name: [{ family: 'Synthetic', given: ['Beta'] }] });
const observationIds: string[] = [];
for (let i = 1; i <= 4; i++) {
  const observation = await seed({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, subject: { reference: `Patient/${i === 4 ? patientB.id : patientA.id}` }, effectiveDateTime: `2026-01-0${i}T10:00:00Z`, valueQuantity: { value: 7.1, unit: '%', system: 'http://unitsofmeasure.org', code: '%' } });
  observationIds.push(observation.id);
}
// J-44: same-patient decoys, each excluded by exactly one search predicate, so ignored or mis-evaluated filters fail.
const decoys: { id: string; predicate: string }[] = [];
for (const [predicate, code, date] of [['code=4548-4', '2345-7', '2026-01-02T12:00:00Z'], ['date=ge2026-01-01', '4548-4', '2025-12-31T12:00:00Z'], ['date=lt2026-02-01', '4548-4', '2026-02-01T12:00:00Z']] as const) {
  const decoy = await seed({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code }] }, subject: { reference: `Patient/${patientA.id}` }, effectiveDateTime: date, valueQuantity: { value: 6.5, unit: '%', system: 'http://unitsofmeasure.org', code: '%' } });
  decoys.push({ id: decoy.id, predicate });
}
const payload = Buffer.from('synthetic Medplum document test').toString('base64');
const document = await seed({ resourceType: 'DocumentReference', status: 'current', subject: { reference: `Patient/${patientA.id}` }, content: [{ attachment: { contentType: 'text/plain', data: payload, title: 'Synthetic fixture only' } }] });

// Verify actual authentication and ordinary project visibility independently
// of gateway behavior. Bootstrap tokens never enter the gateway.
const unauth = await fetch(new URL(`fhir/R4/Patient/${patientA.id}`, base), { redirect: 'error' });
assert.ok([401, 403].includes(unauth.status), 'Patient reads must require authentication'); await unauth.body?.cancel();
const accessible = await jsonRequest(`fhir/R4/Patient/${patientA.id}`, 'GET', projectToken);
assert.ok(accessible.id === patientA.id, 'independent project-scoped read succeeds');

const previous = process.env[secretEnv];
process.env[secretEnv] = client.secret as string;
const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'local-medplum', baseUrl: new URL('fhir/R4/', base).href, auth: { type: 'client_credentials', tokenUrl: tokenUrl.href, clientId: client.id, clientSecretEnv: secretEnv } }, patientId: patientA.id });
const trace = startQueryCapture(new URL('fhir/R4/', base), tokenUrl);
try {
  const caps = await gateway.execute('fhir_capabilities', { topic: 'server' });
  assert.equal(caps.error, undefined);
  let result = await gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 1, params: [{ name: 'code', value: 'http://loinc.org|4548-4' }, { name: 'date', value: 'ge2026-01-01' }, { name: 'date', value: 'lt2026-02-01' }, { name: '_sort', value: 'date' }] });
  const ids: string[] = [];
  let pages = 0;
  while (true) {
    assert.equal(result.error, undefined, result.error?.code);
    for (const resource of result.data.resources as Resource[]) { assert.ok((resource.subject as { reference: string }).reference === `Patient/${patientA.id}`, 'ordinary authorized linkage'); ids.push(resource.id); }
    assert.ok(!JSON.stringify(result).includes(client.secret as string));
    assert.ok(!JSON.stringify(result).includes(projectToken));
    pages++;
    if (!result.pagination?.next_cursor) break;
    assert.ok(pages < 20);
    result = await gateway.execute('fhir_page', { cursor: result.pagination.next_cursor });
  }
  for (const decoy of decoys) {
    assert.ok(!ids.includes(decoy.id), `predicate decoy must be excluded by ${decoy.predicate}`);
    // Positive control: the decoy exists and is linked to the trusted patient, so only the predicate excluded it.
    assert.equal((await gateway.execute('fhir_read', { resource_type: 'Observation', id: decoy.id })).error, undefined, `predicate decoy for ${decoy.predicate} must be seeded and readable`);
  }
  assert.ok(isDeepStrictEqual(ids, observationIds.slice(0, 3)), 'ordinary authorized record sequence');
  assert.ok(pages >= 2);
  assert.equal((await gateway.execute('fhir_read', { resource_type: 'Observation', id: observationIds[3] })).error?.code, 'NOT_FOUND');
  const doc = await gateway.execute('fhir_read', { resource_type: 'DocumentReference', id: document.id, output: { format: 'fhir' } });
  assert.equal(doc.error, undefined);
  assert.ok(doc.transform.withheld_payloads.length > 0);
  assert.ok(!JSON.stringify(doc).includes(payload));
  const duplicateEvidence = await verifyDuplicateQueries(gateway, trace, patientA.id, observationIds.slice(0, 3), true);
  console.log(JSON.stringify({ target: 'local-medplum', ...duplicateEvidence, metadata_requests: trace.counts.metadata, auth_requests: trace.counts.auth, clinical_requests: trace.counts.clinical, fhir_version: caps.source.fhir_version, authenticated: true, unauthenticated_read_denied: true, project_scoped_client: true, pages, authorized_observations: ids.length, single_predicate_decoys_excluded: decoys.length, wrong_patient_denied: true, attachment_payload_or_link_withheld: true }));
} finally {
  trace.stop(); gateway.close();
  if (previous === undefined) delete process.env[secretEnv]; else process.env[secretEnv] = previous;
}
