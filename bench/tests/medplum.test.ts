// Arms Ws and Wm against Medplum: stack pins, loader helpers and reconciliation, AccessPolicy, launch configuration and
// record redaction. Fixtures are hand-written, synthetic and minimal; no dataset file is read.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { LaunchContext } from '../lib/types.js';
import { parseLossless } from '../lib/json.js';
import { MEDPLUM_COMPOSE_FILE, MEDPLUM_COMPOSE_PROJECT, MEDPLUM_IMAGES, MEDPLUM_PORT, MEDPLUM_SETTINGS, MEDPLUM_VOLUME, medplumUrl } from '../infra/medplum.js';
import { batchBundle, chunkIndices, normaliseReason, reconcileCounts, rejectionSummary, tallyBatchResponse } from '../data/medplum-lib.js';
import { READ_INTERACTIONS, SHARED_TYPES, bundleRefs, patientScopedPolicy } from '../data/medplum-policy.js';
import { ARMS, INSTALL_DIRS, SCRIPTED_ARMS } from '../servers/arms.js';
import { makeAdapter } from '../servers/adapters.js';
import { PARSERS } from '../servers/parsers.js';
import { clientFor, medplumProxyBase, setMedplumTokenForTest, tokenFresh, type MedplumClients } from '../servers/medplum.js';
import { backendOf, redactCommand } from '../run/scripted.js';
import { ARM_LABELS, DEVIATIONS, WS_DEVIATION_NOT_RUN, WS_DEVIATION_RUN, deviationsFor } from '../run/report.js';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P1 = U(1), P2 = U(2);

test('Medplum compose file: the pinned digests, loopback-only port 18195, own project and volume, recorded non-defaults', () => {
  const y = readFileSync(MEDPLUM_COMPOSE_FILE, 'utf8');
  assert.match(y, new RegExp(`^name: ${MEDPLUM_COMPOSE_PROJECT}$`, 'm'));
  for (const ref of Object.values(MEDPLUM_IMAGES)) assert.ok(y.includes(`image: ${ref}`), ref);
  assert.equal((y.match(/image: /g) ?? []).length, 3);
  assert.equal((y.match(/pull_policy: never/g) ?? []).length, 3);
  const ports = [...y.matchAll(/^\s+- "([^"]+:\d+:\d+)"$/gm)].map(m => m[1]);
  assert.deepEqual(ports, [`127.0.0.1:${MEDPLUM_PORT}:8103`]);
  assert.ok(![18103, 18190, 18080, 18091, 8080].includes(MEDPLUM_PORT));
  assert.ok(y.includes(`name: ${MEDPLUM_VOLUME}`));
  for (const [k, v] of Object.entries(MEDPLUM_SETTINGS)) assert.match(y, new RegExp(`${k}: "?${v.replace(/[/.]/g, '\\$&')}"?$`, 'm'), k);
  assert.throws(() => medplumUrl('http://example.invalid/fhir/R4/Patient'));
});

test('chunks respect the entry and byte limits; an oversized line is its own chunk', () => {
  assert.deepEqual(chunkIndices([10, 10, 10, 10, 10], 2, 1000), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(chunkIndices([10, 50, 10, 10], 10, 40), [[0], [1], [2, 3]]);
  assert.deepEqual(chunkIndices([], 5, 5), []);
});

test('batch bundle: PUT at the file id, meta.project added, other meta and number lexemes kept, non-UUID ids refused', () => {
  const lines = [
    `{"resourceType":"Patient","id":"${P1}","meta":{"profile":["urn:example:p"]}}`,
    `{"resourceType":"Observation","id":"${U(3)}","status":"final","code":{"text":"x"},"subject":{"reference":"Patient/${P1}"},"valueQuantity":{"value":7.0}}`,
  ];
  const { body, sent } = batchBundle('proj-1', lines);
  assert.deepEqual(sent, [{ type: 'Patient', id: P1 }, { type: 'Observation', id: U(3) }]);
  assert.ok(body.includes('"value":7.0'), 'lexeme kept');
  const b = parseLossless(body) as { type: string; entry: { request: { method: string; url: string }; resource: { meta: Record<string, unknown> } }[] };
  assert.equal(b.type, 'batch');
  assert.deepEqual(b.entry.map(e => e.request), [{ method: 'PUT', url: `Patient/${P1}` }, { method: 'PUT', url: `Observation/${U(3)}` }]);
  assert.deepEqual(b.entry[0]!.resource.meta, { profile: ['urn:example:p'], project: 'proj-1' });
  assert.deepEqual(b.entry[1]!.resource.meta, { project: 'proj-1' });
  assert.throws(() => batchBundle('proj-1', ['{"resourceType":"Patient","id":"pat-1"}']), /UUID/);
});

test('batch response tally: every entry gets a verdict, reasons come from the OperationOutcome, changed ids are caught', () => {
  const sent = [{ type: 'Patient', id: P1 }, { type: 'Observation', id: U(3) }, { type: 'Observation', id: U(4) }, { type: 'Observation', id: U(5) }, { type: 'Observation', id: U(6) }];
  const response = parseLossless(JSON.stringify({ resourceType: 'Bundle', type: 'batch-response', entry: [
    { response: { status: '200', location: `Patient/${P1}/_history/v1` } },
    { response: { status: '201 Created', location: `Observation/${U(3)}/_history/v1` } },
    { response: { status: '400', outcome: { resourceType: 'OperationOutcome', issue: [
      { severity: 'error', code: 'structure', details: { text: 'Missing required property' }, expression: ['Observation.code'] },
      { severity: 'warning', code: 'informational', details: { text: 'ignored' } }] } } },
    { response: { status: '200', location: `Observation/${U(99)}/_history/v1` } },
  ] }));
  const t = tallyBatchResponse(sent, response);
  assert.equal(t.accepted, 3);
  assert.deepEqual(t.id_changed, [{ type: 'Observation', id: U(5) }]);
  assert.equal(t.rejected.length, 2);
  assert.deepEqual(t.rejected[0], { type: 'Observation', id: U(4), status: 400, reason: 'structure: Missing required property @ Observation.code', issues: ['structure: Missing required property @ Observation.code'] });
  assert.deepEqual(t.rejected[1], { type: 'Observation', id: U(6), status: 0, reason: 'no response entry', issues: [] });
  assert.equal(tallyBatchResponse(sent.slice(0, 1), null).rejected.length, 1);
});

test('reasons group by type with ids and indices normalised', () => {
  assert.equal(normaliseReason(`invariant: Constraint x not met @ Claim.item[3].x (${U(7)})`), 'invariant: Constraint x not met @ Claim.item[*].x (<id>)');
  const s = rejectionSummary([
    { type: 'Claim', id: U(1), status: 400, reason: 'a', issues: [] }, { type: 'Claim', id: U(2), status: 400, reason: 'a', issues: [] },
    { type: 'Claim', id: U(3), status: 400, reason: 'b', issues: [] }, { type: 'Device', id: U(4), status: 400, reason: 'a', issues: [] },
  ]);
  assert.deepEqual(s, [{ type: 'Claim', reason: 'a', count: 2 }, { type: 'Claim', reason: 'b', count: 1 }, { type: 'Device', reason: 'a', count: 1 }]);
});

test('count reconciliation: source = sent = accepted + rejected, served = accepted, per type', () => {
  const source = { Patient: 3, Observation: 10, Claim: 4 };
  const tally = { Patient: { sent: 3, accepted: 3, rejected: 0 }, Observation: { sent: 10, accepted: 9, rejected: 1 }, Claim: { sent: 4, accepted: 4, rejected: 0 } };
  const ok = reconcileCounts(source, tally, { Patient: 3, Observation: 9, Claim: 4 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.rows.find(r => r.type === 'Observation'), { type: 'Observation', source: 10, sent: 10, accepted: 9, rejected: 1, served: 9, ok: true, problems: [] });
  const bad = reconcileCounts(source, { ...tally, Claim: { sent: 3, accepted: 2, rejected: 0 } }, { Patient: 3, Observation: 10, Claim: null, Device: 1 });
  assert.equal(bad.ok, false);
  const p = Object.fromEntries(bad.rows.map(r => [r.type, r.problems]));
  assert.deepEqual(p.Observation, ['served 10 != accepted 9']);
  assert.deepEqual(p.Claim, ['sent 3 != source 4', 'accepted 2 + rejected 0 != sent 3', 'served count unavailable']);
  assert.deepEqual(p.Device, ['not in the source', 'served 1 != accepted 0']);
});

test('AccessPolicy: one compartment criterion per patient type, read interactions only, shared types read-only, nothing else', () => {
  const pol = patientScopedPolicy(P1, ['Observation', 'Encounter', 'Medication'], 'proj-1') as { meta: unknown; resource: { resourceType: string; criteria?: string; interaction: string[] }[] };
  assert.deepEqual(pol.meta, { project: 'proj-1' });
  const scoped = pol.resource.filter(r => r.criteria);
  assert.deepEqual(scoped.map(r => r.resourceType), ['Encounter', 'Observation', 'Patient']);
  for (const r of scoped) assert.equal(r.criteria, `${r.resourceType}?_compartment=Patient/${P1}`);
  assert.deepEqual(pol.resource.filter(r => !r.criteria).map(r => r.resourceType), [...SHARED_TYPES]);
  for (const r of pol.resource) assert.deepEqual(r.interaction, [...READ_INTERACTIONS]);
  assert.ok(!JSON.stringify(pol).match(/"(create|update|delete)"/));
  assert.deepEqual(bundleRefs({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Patient', id: P1 } }, {}] }), [`Patient/${P1}`]);
  assert.deepEqual(bundleRefs({ resourceType: 'OperationOutcome', id: 'x' }), []);
});

const ctx = (arm: 'W' | 'Ws' | 'Wm', patientId = P1): LaunchContext => ({
  arm, dataset: 'synthea-dev', patientId, slot: 7, cell: 'default', fhirBaseUrl: arm === 'W' ? 'http://127.0.0.1:18217/fhir' : medplumProxyBase(7),
  runDir: '/nonexistent/run', runTmp: '/nonexistent/tmp',
});

test('Ws and Wm: W\'s install and launch with authorization on and the static token; W unchanged', () => {
  assert.equal(medplumProxyBase(7), 'http://127.0.0.1:18247/fhir/R4');
  setMedplumTokenForTest('Ws', 'synthea-dev', P1, 'tok-scoped-p1');
  setMedplumTokenForTest('Wm', 'synthea-dev', P2, 'tok-system');
  const w = ARMS.W.command!(ctx('W'));
  const ws = ARMS.Ws.command!(ctx('Ws'));
  const wm = ARMS.Wm.command!(ctx('Wm', P2));
  for (const c of [ws, wm]) {
    assert.equal(c.command, w.command);
    assert.deepEqual(c.args, w.args);
    assert.equal(c.env.FHIR_SERVER_BASE_URL, 'http://127.0.0.1:18247/fhir/R4');
    assert.equal('FHIR_SERVER_DISABLE_AUTHORIZATION' in c.env, false);
    assert.deepEqual(Object.keys(c.env).sort(), ['FHIR_SERVER_ACCESS_TOKEN', 'FHIR_SERVER_BASE_URL', 'HOME', 'LANG', 'PATH', 'TMPDIR']);
    assert.equal(c.env.PATH, w.env.PATH);
  }
  assert.equal(ws.env.FHIR_SERVER_ACCESS_TOKEN, 'tok-scoped-p1');
  assert.equal(wm.env.FHIR_SERVER_ACCESS_TOKEN, 'tok-system');
  assert.equal(w.env.FHIR_SERVER_DISABLE_AUTHORIZATION, 'true');
  assert.equal(w.env.FHIR_SERVER_ACCESS_TOKEN, undefined);
  assert.throws(() => ARMS.Ws.command!(ctx('Ws', P2)), /no Medplum token/); // no token for that patient
  assert.deepEqual(ARMS.Ws.pin, ARMS.W.pin);
  assert.equal(ARMS.Ws.installDir, INSTALL_DIRS.W);
  for (const a of ['Ws', 'Wm'] as const) {
    assert.ok(SCRIPTED_ARMS.includes(a));
    assert.equal(PARSERS[a], PARSERS.W);
    assert.deepEqual(makeAdapter(a, [{ name: 'search', inputSchema: {} }], { cell: 'default', patientId: P1 }).search('Observation', [['patient', `Patient/${P1}`]], 200),
      makeAdapter('W', [{ name: 'search', inputSchema: {} }], { cell: 'default', patientId: P1 }).search('Observation', [['patient', `Patient/${P1}`]], 200));
  }
});

test('Ws uses the run patient\'s scoped client only; Wm the system-level client', () => {
  const c: MedplumClients = { schema: 'fbbench.medplum-clients/1', dataset: 'synthea-dev', project_id: 'proj-1', chosen_patient: P1,
    system: { client_id: 'sys', secret: 's0' }, scoped: { [P1]: { client_id: 'c1', secret: 's1', access_policy_id: 'ap1' } } };
  assert.equal(clientFor('Ws', c, P1).client_id, 'c1');
  assert.throws(() => clientFor('Ws', c, P2), /no patient-scoped/);
  assert.equal(clientFor('Wm', c, P2).client_id, 'sys');
  assert.throws(() => clientFor('W', c, P1));
  const now = 1_000_000_000;
  assert.equal(tokenFresh({ access_token: 'x', expires_in: 3600, obtained_at: now }, now + 2000 * 1000), true);
  assert.equal(tokenFresh({ access_token: 'x', expires_in: 3600, obtained_at: now }, now + 3000 * 1000), false);
  assert.equal(tokenFresh(undefined, now), false);
});

test('run records never carry the token; Medplum arms run in their own invocation', () => {
  const cmd = { command: '/x', args: [], env: { PATH: '/bin', FHIR_SERVER_ACCESS_TOKEN: 'secret-token-value' }, cwd: '/r', files: {} };
  const r = redactCommand(cmd);
  assert.match(r.env.FHIR_SERVER_ACCESS_TOKEN!, /^<redacted sha256:[0-9a-f]{12}>$/);
  assert.ok(!JSON.stringify(r).includes('secret-token-value'));
  assert.equal(cmd.env.FHIR_SERVER_ACCESS_TOKEN, 'secret-token-value', 'input not mutated');
  assert.deepEqual(redactCommand({ ...cmd, env: { PATH: '/bin' } }).env, { PATH: '/bin' });
  assert.equal(backendOf(['Ws', 'Wm']), 'medplum');
  assert.equal(backendOf(['FB0', 'W']), 'hapi');
  assert.throws(() => backendOf(['W', 'Ws']), /separate invocation/);
});

test('report labels for Ws and Wm; the Ws deviation text follows whether Ws ran', () => {
  assert.equal(`Ws: ${ARM_LABELS.Ws}`, 'Ws: WSO2 against Medplum with a patient-scoped AccessPolicy (backend-enforced)');
  assert.equal(`Wm: ${ARM_LABELS.Wm}`, 'Wm: WSO2 against Medplum with a system-level client');
  assert.ok(DEVIATIONS.includes(WS_DEVIATION_NOT_RUN));
  assert.deepEqual(deviationsFor(new Set(['W'])), DEVIATIONS);
  const d = deviationsFor(new Set(['W', 'Ws', 'Wm']));
  assert.ok(d.includes(WS_DEVIATION_RUN) && !d.includes(WS_DEVIATION_NOT_RUN));
});
