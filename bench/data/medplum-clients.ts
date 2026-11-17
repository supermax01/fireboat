// bench:medplum:clients -- --dataset synthea-dev
// Creates, in the loaded Medplum project (bench:medplum:load), the OAuth clients arms Ws and Wm use:
//   - one system-level ClientApplication (no AccessPolicy: the whole project), for Wm;
//   - per development patient P of the dataset's questions and probes, a ClientApplication whose ProjectMembership has
//     an AccessPolicy confining it to P's compartment with read interactions only (patientScopedPolicy), for Ws.
// The chosen patient (the first confinement probe's patient) gets the full check below; every scoped client gets the
// basic one. Medplum refuses SMART patient/ scopes with client credentials, so confinement is the AccessPolicy alone.
// Writes clients.json (client secrets of this disposable loopback stack, git-ignored) and manifests/medplum-clients-<d>.json.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { datasetArg } from '../lib/cli.js';
import { results, type DatasetId } from '../lib/paths.js';
import { log, writeJsonAtomic, writeManifest } from '../infra/manifest.js';
import { MEDPLUM_BOOTSTRAP, MEDPLUM_DATASETS, MEDPLUM_FHIR_PATH, clientCredentialsToken, medplumRequest } from '../infra/medplum.js';
import { medplumDir, type ReconcileRow } from './medplum-lib.js';
import { clientsPath, type MedplumClients } from '../servers/medplum.js';
import { patientScopedPolicy, SHARED_TYPES, bundleRefs } from './medplum-policy.js';

const { values } = parseArgs({ options: { dataset: { type: 'string' } }, strict: true });
const dataset: DatasetId = datasetArg(values.dataset);
if (!(MEDPLUM_DATASETS as readonly string[]).includes(dataset)) throw new Error(`Medplum holds only ${MEDPLUM_DATASETS.join(', ')}`);
const dir = medplumDir(dataset);
const project = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')) as { project_id: string };
const rec = JSON.parse(await readFile(join(dir, 'reconcile.json'), 'utf8')) as { project_id: string; ok: boolean; rows: ReconcileRow[] };
if (rec.project_id !== project.project_id) throw new Error('reconcile.json belongs to another project');
const pid = project.project_id;
const admin = (await clientCredentialsToken(MEDPLUM_BOOTSTRAP.clientId, MEDPLUM_BOOTSTRAP.clientSecret)).access_token;

// Patients of the dataset's questions and probes (plain JSON lines of our own generator; ids are strings).
const lines = async (p: string) => (existsSync(p) ? (await readFile(p, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l) as { patient_id: string; probe_set?: string }) : []);
const probes = await lines(join(results.questions(dataset), '..', 'probes.jsonl'));
const questions = await lines(results.questions(dataset));
const chosen = probes.find(p => p.probe_set === 'confinement')?.patient_id;
if (!chosen) throw new Error('no confinement probe for this dataset: run bench:questions first');
const patients = [...new Set([chosen, ...probes.map(p => p.patient_id), ...questions.map(q => q.patient_id)])];
const compartmentTypes = rec.rows.filter(r => r.accepted > 0 && !(SHARED_TYPES as readonly string[]).includes(r.type)).map(r => r.type);

const existing: MedplumClients | null = existsSync(clientsPath(dataset)) ? JSON.parse(await readFile(clientsPath(dataset), 'utf8')) as MedplumClients : null;
if (existing && existing.project_id !== pid) throw new Error(`${clientsPath(dataset)} belongs to project ${existing.project_id}, not ${pid}`);
const out: MedplumClients = existing ?? { schema: 'fbbench.medplum-clients/1', dataset, project_id: pid, chosen_patient: chosen, system: { client_id: '', secret: '' }, scoped: {} };
out.chosen_patient = chosen;

async function createClient(name: string, accessPolicyId: string | null): Promise<{ client_id: string; secret: string }> {
  const r = await medplumRequest(`/admin/projects/${pid}/client`, admin, { method: 'POST', contentType: 'application/json', body: JSON.stringify({ name, ...(accessPolicyId ? { accessPolicy: { reference: `AccessPolicy/${accessPolicyId}` } } : {}) }) });
  const b = r.body as Record<string, unknown> | null;
  if (r.status !== 201 || typeof b?.id !== 'string' || typeof b.secret !== 'string') throw new Error(`client create failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
  return { client_id: b.id, secret: b.secret };
}

if (!out.system.client_id) {
  out.system = await createClient('fbbench system-level client (arm Wm)', null);
  await writeJsonAtomic(clientsPath(dataset), out);
}
for (const p of patients) {
  if (out.scoped[p]) continue;
  const policy = patientScopedPolicy(p, compartmentTypes, pid);
  const r = await medplumRequest(`${MEDPLUM_FHIR_PATH}/AccessPolicy`, admin, { method: 'POST', body: JSON.stringify(policy) });
  const id = (r.body as Record<string, unknown> | null)?.id;
  if (r.status !== 201 || typeof id !== 'string') throw new Error(`AccessPolicy create failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
  const c = await createClient(`fbbench patient-scoped client (arm Ws), Patient/${p}`, id);
  out.scoped[p] = { ...c, access_policy_id: id };
  await writeJsonAtomic(clientsPath(dataset), out); // after each client, so a rerun resumes
}
log(`${Object.keys(out.scoped).length} patient-scoped clients and one system-level client in project ${pid}`);

// ---- checks (direct to Medplum, not through any MCP server) ----
const get = async (path: string, token: string) => medplumRequest(`${MEDPLUM_FHIR_PATH}/${path}`, token);
const sysTok = (await clientCredentialsToken(out.system.client_id, out.system.secret)).access_token;
const sysPatients = await get('Patient?_summary=count&_total=accurate', sysTok);
const patientTotal = Number(String((sysPatients.body as Record<string, unknown> | null)?.total ?? 'NaN'));
const checks: Record<string, unknown> = { system_client_patient_total: patientTotal };
const failures: string[] = [];
if (patientTotal !== (rec.rows.find(r => r.type === 'Patient')?.accepted ?? -1)) failures.push(`system client sees ${patientTotal} patients`);

const other = patients.find(p => p !== chosen)!;
let basicOk = 0;
for (const [p, c] of Object.entries(out.scoped)) {
  const t = (await clientCredentialsToken(c.client_id, c.secret)).access_token;
  const own = await get(`Patient/${p}`, t);
  const list = await get('Patient?_count=200', t);
  const refs = bundleRefs(list.body);
  if (own.status === 200 && refs.length === 1 && refs[0] === `Patient/${p}`) basicOk++;
  else failures.push(`scoped client of Patient/${p}: own read HTTP ${own.status}, Patient search returned ${refs.length} patients`);
}
checks.scoped_basic_ok = `${basicOk}/${Object.keys(out.scoped).length}`;

// Full check for the chosen patient: own data visible, another patient's data invisible, writes refused.
const ct = (await clientCredentialsToken(out.scoped[chosen]!.client_id, out.scoped[chosen]!.secret)).access_token;
const full: Record<string, string> = {};
const probe = async (label: string, path: string, method = 'GET', body?: unknown) => {
  const r = method === 'GET' ? await get(path, ct) : await medplumRequest(`${MEDPLUM_FHIR_PATH}/${path}`, ct, { method, body: JSON.stringify(body) });
  const refs = bundleRefs(r.body);
  const foreign = refs.filter(x => x === `Patient/${other}` || x.startsWith('Patient/') && x !== `Patient/${chosen}`).length;
  full[label] = `HTTP ${r.status}${refs.length || r.status === 200 ? `, ${refs.length} records${foreign ? `, ${foreign} foreign patients` : ''}` : ''}`;
  return r;
};
await probe('read own Patient', `Patient/${chosen}`);
await probe('read other Patient', `Patient/${other}`);
await probe('own Observations (patient param)', `Observation?patient=Patient/${chosen}&_count=200&_total=accurate`);
await probe('other Observations (patient param)', `Observation?patient=Patient/${other}&_count=200`);
await probe('Observations without patient', 'Observation?_count=200&_total=accurate');
await probe('other $everything', `Patient/${other}/$everything`);
await probe('Medication search (shared type)', 'Medication?_count=5');
await probe('write own Patient (PUT)', `Patient/${chosen}`, 'PUT', { resourceType: 'Patient', id: chosen, active: true });
checks.chosen_patient_full = full;
if (!full['read other Patient']!.startsWith('HTTP 404') && !full['read other Patient']!.startsWith('HTTP 403')) failures.push('chosen client can read another patient');
if (!full['write own Patient (PUT)']!.startsWith('HTTP 403')) failures.push('chosen client can write');

await writeManifest(`medplum-clients-${dataset}`, {
  dataset, project_id: pid, clients_file: clientsPath(dataset), scoped_clients: Object.keys(out.scoped).length,
  access_policy: { template: patientScopedPolicy('<patient id>', compartmentTypes, '<project id>'), compartment_types: compartmentTypes, shared_types: SHARED_TYPES },
  system_client: 'ClientApplication with a ProjectMembership and no AccessPolicy (every resource of the project)',
  token: 'OAuth client credentials at /oauth2/token; Medplum refuses patient/ scopes for client credentials (oauth/token.ts), so scope is the AccessPolicy',
  checks, failures,
});
for (const [k, v] of Object.entries(full)) process.stdout.write(`${k}: ${v}\n`);
process.stdout.write(`scoped basic checks ${checks.scoped_basic_ok}; system client patients ${patientTotal}; failures ${failures.length}\n`);
if (failures.length) { process.stderr.write(failures.join('\n') + '\n'); process.exitCode = 1; }
