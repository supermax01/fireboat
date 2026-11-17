// bench:healthlake -- <plan|create|status|load|verify|proxy|teardown> [--dataset synthea-holdout] [flags]
// Rules: region us-east-2 only, AWS profile `fireboat`, every AWS call through the local AWS CLI,
// credentials never handled, printed or logged; synthetic holdout data only (never MIMIC); the data store is deleted the
// same day. Nothing here creates, loads into or deletes an AWS resource without its explicit flag:
//   plan                      resources, steps and the cost estimate; read-only AWS calls only (--offline: none)
//   create --yes-create       one FHIR R4 data store, SigV4 auth, no preload; waits until ACTIVE (--max-wait-minutes 45)
//   status                    describes every recorded resource and updates the manifest (read-only)
//   load --yes-load           REST batch PUT of converted/<dataset>/ with the file ids; resumable; reconciles counts
//   verify [--ids]            per-type counts served through the signing proxy against the source (and every id with --ids)
//   proxy [--slot 0]          the loopback signing proxy on 127.0.0.1:1827<slot>, until interrupted
//   teardown --yes-delete     deletes every resource the manifest records (--no-wait: do not wait for DELETED)
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { datasetArg } from '../lib/cli.js';
import { appendJsonl, readJsonl } from '../lib/jsonl.js';
import { parseLossless, stringifyLossless } from '../lib/json.js';
import { knownPatient, results, slotPorts, type DatasetId } from '../lib/paths.js';
import { log, sha256Text, writeJsonAtomic, writeManifest } from '../infra/manifest.js';
import { chunkIndices, reconcileCounts, rejectionSummary, tallyBatchResponse, type BatchTally, type Rejection, type TypeTally } from '../data/medplum-lib.js';
import { AWS_PROFILE, AWS_REGION, AwsSessionError, awsBin, awsCli, cliCredentialProvider, parseDatastoreEndpoint, type DatastoreEndpoint } from './aws.js';
import { estimateCost, formatEstimate, plannedRequests, type Tier } from './cost.js';
import { DEFAULT_CHUNK_ENTRIES, MAX_CHUNK_BYTES, VALIDATION_HEADER, VALIDATION_LEVEL, bundleTotalOf, overNoteLimit, putBatchBundle, retryable } from './load-lib.js';
import { startSigningProxy } from './proxy.js';
import { proxyGet, pageOf, servedCounts, servedIds } from './served.js';
import { datastoreRequest, makeSigner } from './sign.js';
import {
  HEALTHLAKE_DATASETS, activeDatastore, healthlakeDir, liveResources, note, readManifest, resourcesPath, saveManifest, teardownSteps,
  type CreatedResource, type DatastoreStatus, type ResourceManifest,
} from './state.js';

const SUB = process.argv[2] ?? '';
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    dataset: { type: 'string' }, slot: { type: 'string' }, hours: { type: 'string' }, tier: { type: 'string' },
    'yes-create': { type: 'boolean' }, 'yes-load': { type: 'boolean' }, 'yes-delete': { type: 'boolean' },
    'max-wait-minutes': { type: 'string' }, 'no-wait': { type: 'boolean' }, 'allow-existing': { type: 'boolean' },
    chunk: { type: 'string' }, concurrency: { type: 'string' }, ids: { type: 'boolean' }, offline: { type: 'boolean' },
  },
  strict: true,
});
const dataset: DatasetId = datasetArg(values.dataset ?? 'synthea-holdout');
if (!HEALTHLAKE_DATASETS.includes(dataset)) throw new Error(`only ${HEALTHLAKE_DATASETS.join(', ')} may be loaded into HealthLake (synthetic holdout; never MIMIC)`);
const slot = Number(values.slot ?? '0');
const NAME_PREFIX = 'fbbench-';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const conv = results.converted(dataset);

interface ConvertedManifest { total: number; types: Record<string, { count: number; bytes: number; sha256: string }> }
const converted = (): ConvertedManifest => JSON.parse(readFileSync(join(conv, 'manifest.json'), 'utf8')) as ConvertedManifest; // our own file

interface Described { DatastoreId: string; DatastoreArn: string; DatastoreName?: string; DatastoreStatus: DatastoreStatus; DatastoreEndpoint: string; CreatedAt?: string | number }
async function describe(id: string): Promise<Described | null> {
  try {
    const r = await awsCli(['healthlake', 'describe-fhir-datastore', '--datastore-id', id]) as { DatastoreProperties: Described };
    return r.DatastoreProperties;
  } catch (e) {
    if (e instanceof AwsSessionError) throw e;
    if (/ResourceNotFoundException|not found/i.test((e as Error).message)) return null;
    throw e;
  }
}
async function listStores(): Promise<Described[]> {
  const r = await awsCli(['healthlake', 'list-fhir-datastores']) as { DatastorePropertiesList: Described[] };
  return r.DatastorePropertiesList ?? [];
}

function applyDescribe(r: CreatedResource, d: Described | null): void {
  const now = new Date().toISOString();
  r.status_checked_at = now;
  if (!d) { r.status = r.delete_requested_at ? 'DELETED' : 'NOT_FOUND'; if (r.delete_requested_at && !r.deleted_at) r.deleted_at = now; return; }
  r.id = d.DatastoreId; r.arn = d.DatastoreArn; r.endpoint = d.DatastoreEndpoint;
  if (r.status !== d.DatastoreStatus) {
    if (d.DatastoreStatus === 'ACTIVE' && !r.active_at) r.active_at = now;
    if (d.DatastoreStatus === 'DELETED' && !r.deleted_at) r.deleted_at = now;
  }
  r.status = d.DatastoreStatus;
}

const hoursSince = (iso: string | null) => (iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : 0);

// ---- plan ---------------------------------------------------------------------------------------------------

async function plan() {
  const m = converted();
  const bytes = Object.values(m.types).reduce((a, t) => a + t.bytes, 0);
  const hours = Number(values.hours ?? '6');
  const tier = (values.tier ?? 'standard') as Tier;
  if (tier !== 'standard' && tier !== 'advanced') throw new Error('--tier must be standard or advanced');
  const questions = readFileSync(results.questions(dataset), 'utf8').split('\n').filter(Boolean).length;
  const probesPath = join(results.questions(dataset), '..', 'probes.jsonl');
  const probes = existsSync(probesPath) ? readFileSync(probesPath, 'utf8').split('\n').filter(Boolean).length : 0;
  const req = plannedRequests({ resources: m.total, types: Object.keys(m.types).length, units: questions + probes, arms: 3, passes: 2, httpPerRun: 4 });
  const out: string[] = [];
  out.push(`HealthLake plan for ${dataset} (region ${AWS_REGION}, profile ${AWS_PROFILE})`, '');
  out.push(`Source: ${conv}`, `  ${m.total} resources, ${(bytes / 1e6).toFixed(1)} MB in ${Object.keys(m.types).length} types:`);
  for (const [t, v] of Object.entries(m.types)) out.push(`    ${t.padEnd(26)} ${String(v.count).padStart(7)}  ${(v.bytes / 1e6).toFixed(2).padStart(7)} MB`);
  out.push('', 'Steps (only those marked $ create, load or delete; each needs its flag):',
    `  1   bench:healthlake -- plan                     read-only`,
    `  2 $ bench:healthlake -- create --yes-create      CreateFHIRDatastore R4, SigV4 (AWS_AUTH), no preload; wait for ACTIVE (community reports 10-30 min; not documented)`,
    `  3 $ bench:healthlake -- load --yes-load          ${Math.ceil(m.total / DEFAULT_CHUNK_ENTRIES)}+ batch Bundles of PUT Type/id, structure-only validation (estimate 15-40 min)`,
    `  4   bench:healthlake -- verify [--ids]           per-type counts (and ids) through the signing proxy`,
    `  5   bench:install -- --arm AH; bench:scripted -- --dataset ${dataset} --backend healthlake --arm FBh,FBdh,AH --pass 1|2 --set all`,
    `  6 $ bench:healthlake -- teardown --yes-delete    DeleteFHIRDatastore; waits for DELETED`, '');
  out.push(`Requests (estimate): load ${req.load} (per resource, upper bound), verify ${req.verify}, runs ${req.runs} (${questions + probes} units x 3 arms x 2 passes x ~4)`);
  out.push(`Cost for ${hours} data store hours:`, formatEstimate(estimateCost({ hours, storage_gb: bytes / 1e9, requests: req.total, tier })));
  out.push(`Cost if forgotten for 24 h: $${estimateCost({ hours: 24, storage_gb: bytes / 1e9, requests: req.total, tier }).total_upper.toFixed(2)}`, '');
  if (!values.offline) {
    out.push('AWS (read-only):');
    try {
      const creds = cliCredentialProvider();
      await creds();
      const exp = creds.status().expiresAt;
      out.push(`  session: ok${exp ? `, credentials valid until ${exp}` : ''} (via aws configure export-credentials; ${awsBin()})`);
      const stores = await listStores();
      const live = stores.filter(s => s.DatastoreStatus !== 'DELETED');
      out.push(`  data stores in ${AWS_REGION}: ${stores.length} (${live.length} not deleted${live.length ? `: ${live.map(s => `${s.DatastoreName ?? '?'} ${s.DatastoreStatus}`).join(', ')}` : ''})`);
    } catch (e) { out.push(`  ${(e as Error).message}`); }
    const man = readManifest(dataset);
    out.push(`  recorded by this tooling: ${man.resources.length} (${liveResources(man).length} not confirmed deleted) in ${resourcesPath(dataset)}`);
  }
  process.stdout.write(out.join('\n') + '\n');
}

// ---- create -------------------------------------------------------------------------------------------------

async function create() {
  const m = readManifest(dataset);
  const live = liveResources(m);
  if (live.length) throw new Error(`already recorded and not deleted: ${live.map(r => `${r.id ?? r.name} (${r.status})`).join(', ')}; use it, or run teardown --yes-delete first`);
  const existing = (await listStores()).filter(s => s.DatastoreStatus !== 'DELETED' && (s.DatastoreName ?? '').startsWith(NAME_PREFIX));
  if (existing.length && !values['allow-existing']) throw new Error(`fbbench data stores already exist in ${AWS_REGION}: ${existing.map(s => `${s.DatastoreName} ${s.DatastoreStatus}`).join(', ')} (--allow-existing to create another)`);
  const bytes = Object.values(converted().types).reduce((a, t) => a + t.bytes, 0);
  const est = estimateCost({ hours: Number(values.hours ?? '6'), storage_gb: bytes / 1e9, requests: converted().total, tier: 'standard' });
  process.stdout.write(`Estimated cost: $${est.total_expected.toFixed(2)} expected, $${est.total_upper.toFixed(2)} upper bound for ${est.input.hours} h ($${est.prices.datastore_hour_usd} per data store hour until deleted).\n`);
  if (!values['yes-create']) { process.stdout.write('Not created: pass --yes-create to create the data store.\n'); process.exitCode = 2; return; }

  const requestedAt = new Date().toISOString();
  const stamp = requestedAt.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const name = `${NAME_PREFIX}${dataset}-${stamp}`;
  const clientToken = sha256Text(`${name}|${requestedAt}`).slice(0, 32);
  const r: CreatedResource = {
    kind: 'healthlake-datastore', name, client_token: clientToken, id: null, arn: null, endpoint: null, status: 'REQUESTED',
    requested_at: requestedAt, created_at: null, active_at: null, delete_requested_at: null, deleted_at: null, status_checked_at: null,
  };
  m.resources.push(r);
  note(m, 'create-requested', name);
  await saveManifest(m); // before the call: teardown can find the store by name even if this process dies mid-call
  const out = await awsCli(['healthlake', 'create-fhir-datastore', '--datastore-type-version', 'R4', '--datastore-name', name,
    '--identity-provider-configuration', 'AuthorizationStrategy=AWS_AUTH', '--client-token', clientToken,
    '--tags', `Key=fbbench,Value=${dataset}`, `Key=fbbench-delete-by,Value=${requestedAt.slice(0, 10)}`]) as { DatastoreId: string; DatastoreArn: string; DatastoreStatus: DatastoreStatus; DatastoreEndpoint: string };
  r.id = out.DatastoreId; r.arn = out.DatastoreArn; r.endpoint = out.DatastoreEndpoint; r.status = out.DatastoreStatus; r.created_at = new Date().toISOString();
  parseDatastoreEndpoint(out.DatastoreEndpoint); // fails loudly if AWS returned an unexpected endpoint shape
  note(m, 'created', `${r.id} ${r.status}`);
  await saveManifest(m);
  log(`created ${name} (${r.id}), ${r.status}; billing runs until teardown --yes-delete`);
  await waitFor(m, r, s => s === 'ACTIVE' || s === 'CREATE_FAILED', Number(values['max-wait-minutes'] ?? '45'));
  if (r.status !== 'ACTIVE') { process.stderr.write(`data store ${r.id} is ${r.status}; run teardown --yes-delete\n`); process.exitCode = 1; return; }
  log(`ACTIVE after ${Math.round(hoursSince(r.created_at) * 60)} min: ${r.endpoint}`);
}

async function waitFor(m: ResourceManifest, r: CreatedResource, done: (s: DatastoreStatus) => boolean, maxMinutes: number) {
  const deadline = Date.now() + maxMinutes * 60_000;
  while (!done(r.status) && Date.now() < deadline) {
    await sleep(30_000);
    applyDescribe(r, r.id ? await describe(r.id) : null);
    await saveManifest(m);
    log(`  ${r.id}: ${r.status} (${Math.round(hoursSince(r.created_at ?? r.requested_at) * 60)} min since create)`);
  }
}

// ---- status -------------------------------------------------------------------------------------------------

async function status() {
  const m = readManifest(dataset);
  for (const r of m.resources) {
    if (r.status === 'DELETED' || r.status === 'NOT_FOUND') { process.stdout.write(`${r.name}: ${r.status}\n`); continue; }
    if (!r.id) {
      const found = (await listStores()).find(s => s.DatastoreName === r.name);
      applyDescribe(r, found ? await describe(found.DatastoreId) : null);
    } else applyDescribe(r, await describe(r.id));
    process.stdout.write(`${r.name}: ${r.id ?? '-'} ${r.status}${r.created_at ? `, ${hoursSince(r.created_at).toFixed(2)} h since create (~$${(hoursSince(r.created_at) * 0.27).toFixed(2)})` : ''}\n`);
  }
  await saveManifest(m);
  const untracked = (await listStores()).filter(s => s.DatastoreStatus !== 'DELETED' && (s.DatastoreName ?? '').startsWith(NAME_PREFIX) && !m.resources.some(r => r.id === s.DatastoreId));
  for (const s of untracked) process.stdout.write(`untracked fbbench data store: ${s.DatastoreName} ${s.DatastoreStatus} (not in ${resourcesPath(dataset)})\n`);
}

// ---- load ---------------------------------------------------------------------------------------------------

interface LoadProgress { schema: 'fbbench.healthlake-progress/1'; datastore_id: string; type: string; level: number; chunk: number; lines: number[]; sent: number; accepted: number; rejected: number; id_changed: number; mode: 'batch' | 'single'; ms: number; attempts: number }

async function readState<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  if (!existsSync(path)) return out;
  for await (const r of readJsonl(path)) out.push(JSON.parse(stringifyLossless(r)) as T);
  return out;
}

async function liveEndpoint(): Promise<{ ds: CreatedResource & { id: string; endpoint: string }; endpoint: DatastoreEndpoint; m: ResourceManifest }> {
  const m = readManifest(dataset);
  const ds = activeDatastore(m);
  const d = await describe(ds.id);
  applyDescribe(ds, d);
  await saveManifest(m);
  if (ds.status !== 'ACTIVE') throw new Error(`data store ${ds.id} is ${ds.status}`);
  return { ds, endpoint: parseDatastoreEndpoint(ds.endpoint), m };
}

async function load() {
  if (!values['yes-load']) { process.stdout.write(`Not loaded: pass --yes-load to write ${converted().total} resources into the data store.\n`); process.exitCode = 2; return; }
  const CHUNK = Number(values.chunk ?? String(DEFAULT_CHUNK_ENTRIES));
  const CONCURRENCY = Number(values.concurrency ?? '4');
  if (!(CHUNK >= 1 && CHUNK <= 500) || !(CONCURRENCY >= 1 && CONCURRENCY <= 16)) throw new Error('bad --chunk or --concurrency');
  const { ds, endpoint } = await liveEndpoint();
  const signer = makeSigner(cliCredentialProvider());
  const dir = join(healthlakeDir(dataset), 'load');
  mkdirSync(dir, { recursive: true });
  const progressPath = join(dir, 'progress.jsonl');
  const rejectionsPath = join(dir, 'rejections.jsonl');
  const progress = (await readState<LoadProgress>(progressPath)).filter(p => p.datastore_id === ds.id); // a new data store starts over
  const done = new Set(progress.map(p => `${p.type}|${p.level}|${p.chunk}`));
  const manifest = converted();
  const planFile = JSON.parse(await readFile(join(conv, 'load-plan.json'), 'utf8')) as { max_level: number; levels: Record<string, string> };

  // Pre-check: HealthLake caps DocumentReference note text at 10,000 characters on POST/PUT.
  const docs = existsSync(join(conv, 'DocumentReference.ndjson')) ? (await readFile(join(conv, 'DocumentReference.ndjson'), 'utf8')).split('\n').filter(Boolean) : [];
  const overLimit = docs.reduce((a, l) => a + overNoteLimit(l), 0);
  log(`DocumentReference attachments over the 10,000-character note limit: ${overLimit}`);

  async function postBatch(lines: string[]): Promise<{ tally: BatchTally; attempts: number }> {
    const { body, sent } = putBatchBundle(lines);
    let last = '';
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        const r = await datastoreRequest({ endpoint, signer }, { method: 'POST', rel: '', body, headers: { 'content-type': 'application/fhir+json', [VALIDATION_HEADER]: VALIDATION_LEVEL } });
        const text = r.body.toString('utf8');
        if (r.status === 200) return { tally: tallyBatchResponse(sent, parseLossless(text)), attempts: attempt };
        last = `HTTP ${r.status}: ${text.slice(0, 300)}`;
        if (!retryable(r.status)) break;
      } catch (e) {
        if (e instanceof AwsSessionError) throw e;
        last = (e as Error).message;
      }
      await sleep(2000 * attempt);
    }
    throw new Error(last);
  }

  const t0 = Date.now();
  let sentThisRun = 0;
  for (let level = 0; level <= planFile.max_level; level++) {
    for (const type of Object.keys(planFile.levels).sort()) {
      const lv = planFile.levels[type]!;
      const ch = level.toString(36);
      if (!lv.includes(ch)) continue;
      const all = (await readFile(join(conv, `${type}.ndjson`), 'utf8')).split('\n').filter(Boolean);
      if (all.length !== lv.length) throw new Error(`${type}: ${all.length} lines but load-plan has ${lv.length}`);
      const idx = all.map((_, i) => i).filter(i => lv[i] === ch);
      const chunks = chunkIndices(idx.map(i => Buffer.byteLength(all[i]!)), CHUNK, MAX_CHUNK_BYTES).map(c => c.map(k => idx[k]!));
      const todo = chunks.map((lines, chunk) => ({ lines, chunk })).filter(c => !done.has(`${type}|${level}|${c.chunk}`));
      log(`${type} level ${level}: ${idx.length} resources in ${chunks.length} batches, ${todo.length} to send`);
      let next = 0;
      let failure: Error | null = null;
      const worker = async () => {
        while (next < todo.length && !failure) {
          const { lines, chunk } = todo[next++]!;
          const started = Date.now();
          const texts = lines.map(i => all[i]!);
          let tally: BatchTally;
          let mode: LoadProgress['mode'] = 'batch';
          let attempts = 0;
          try {
            ({ tally, attempts } = await postBatch(texts));
          } catch (e) {
            if (e instanceof AwsSessionError) { failure = e; return; }
            log(`${type} level ${level} batch ${chunk}: failed (${(e as Error).message.slice(0, 200)}); sending entries one by one`);
            mode = 'single';
            tally = { accepted: 0, rejected: [], id_changed: [] };
            for (const t of texts) {
              try {
                const r = await postBatch([t]);
                attempts += r.attempts;
                tally.accepted += r.tally.accepted; tally.rejected.push(...r.tally.rejected); tally.id_changed.push(...r.tally.id_changed);
              } catch (e2) {
                if (e2 instanceof AwsSessionError) { failure = e2; return; }
                const s = putBatchBundle([t]).sent[0]!;
                tally.rejected.push({ type: s.type, id: s.id, status: 0, reason: `request failed: ${(e2 as Error).message.slice(0, 200)}`, issues: [] });
              }
            }
          }
          if (tally.rejected.length) await appendJsonl(rejectionsPath, tally.rejected.map(r => ({ schema: 'fbbench.healthlake-rejection/1', datastore_id: ds.id, ...r })));
          if (tally.id_changed.length) await appendJsonl(rejectionsPath, tally.id_changed.map(s => ({ schema: 'fbbench.healthlake-id-changed/1', datastore_id: ds.id, ...s })));
          const rec: LoadProgress = { schema: 'fbbench.healthlake-progress/1', datastore_id: ds.id, type, level, chunk, lines, sent: lines.length, accepted: tally.accepted, rejected: tally.rejected.length, id_changed: tally.id_changed.length, mode, ms: Date.now() - started, attempts };
          await appendJsonl(progressPath, [rec]);
          progress.push(rec);
          sentThisRun += lines.length;
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (failure) throw failure;
      log(`${type} level ${level}: done (${sentThisRun} sent this invocation, ${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  }

  // Reconcile: what the data store serves per type, through the same signer (not the proxy: the loader owns writes).
  const tally: Record<string, TypeTally> = {};
  const seen = new Set<string>();
  for (const p of [...progress].reverse()) {
    const k = `${p.type}|${p.level}|${p.chunk}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const t = (tally[p.type] ??= { sent: 0, accepted: 0, rejected: 0 });
    t.sent += p.sent; t.accepted += p.accepted; t.rejected += p.rejected;
  }
  const served: Record<string, number | null> = {};
  for (const type of Object.keys(manifest.types)) {
    const r = await datastoreRequest({ endpoint, signer }, { method: 'GET', rel: type, pairs: [['_total', 'accurate'], ['_count', '1'], ['_elements', 'id']] });
    served[type] = r.status === 200 ? bundleTotalOf(r.body.toString('utf8')) : null;
  }
  const source = Object.fromEntries(Object.entries(manifest.types).map(([t, v]) => [t, v.count]));
  const rec = reconcileCounts(source, tally, served);
  const listed = (await readState<Rejection & { schema: string; datastore_id: string }>(rejectionsPath)).filter(r => r.datastore_id === ds.id);
  const lastPer = new Map<string, Rejection>();
  for (const r of listed.filter(r => r.schema === 'fbbench.healthlake-rejection/1')) lastPer.set(`${r.type}/${r.id}`, r);
  const rejections = [...lastPer.values()];
  const idChanged = listed.filter(r => r.schema === 'fbbench.healthlake-id-changed/1').length;
  const summary = rejectionSummary(rejections);
  const rejectedCounted = Object.values(tally).reduce((a, t) => a + t.rejected, 0);
  if (rejections.length !== rejectedCounted || idChanged > 0) rec.ok = false;
  await writeJsonAtomic(join(dir, 'reconcile.json'), { schema: 'fbbench.healthlake-reconcile/1', dataset, datastore_id: ds.id, checked_at: new Date().toISOString(), ...rec, rejection_summary: summary, id_changed: idChanged });
  await writeManifest(`healthlake-load-${dataset}`, {
    dataset, datastore_id_sha256: sha256Text(ds.id), region: AWS_REGION, method: 'REST batch Bundles of PUT Type/<file id>, SigV4, x-amzn-healthlake-fhir-validation-level: structure-only',
    id_strategy: 'client ids preserved: PUT update-as-create at the file id; every response location checked against the id sent',
    chunk_entries: CHUNK, chunk_max_bytes: MAX_CHUNK_BYTES, concurrency: CONCURRENCY, order: 'load-plan levels, then type name',
    converted_manifest: join(conv, 'manifest.json'), converted_total: manifest.total, reconcile_ok: rec.ok, reconcile: rec.rows,
    rejection_summary: summary, id_changed: idChanged, document_reference_over_note_limit: overLimit,
    state: { progress: progressPath, rejections: rejectionsPath, reconcile: join(dir, 'reconcile.json') }, wall_s: Math.round((Date.now() - t0) / 1000),
  });
  for (const r of rec.rows) process.stdout.write(`${r.type}: source ${r.source} sent ${r.sent} accepted ${r.accepted} rejected ${r.rejected} served ${r.served}${r.ok ? '' : `  ${r.problems.join('; ')}`}\n`);
  for (const s of summary) process.stdout.write(`rejected ${s.count} ${s.type}: ${s.reason}\n`);
  if (!rec.ok) process.exitCode = 1;
}

// ---- verify -------------------------------------------------------------------------------------------------

async function verify() {
  const { ds, endpoint } = await liveEndpoint();
  const port = slotPorts(slot).signingProxy;
  const proxy = await startSigningProxy({ port, endpoint, signer: makeSigner(cliCredentialProvider()), logPath: join(healthlakeDir(dataset), `signing-proxy-verify-s${slot}.jsonl`), slot });
  const base = `http://127.0.0.1:${port}/fhir`;
  const problems: string[] = [];
  try {
    const manifest = converted();
    const recPath = join(healthlakeDir(dataset), 'load', 'reconcile.json');
    const rec = existsSync(recPath) ? JSON.parse(readFileSync(recPath, 'utf8')) as { datastore_id: string; rows: { type: string; accepted: number }[] } : null;
    const accepted = rec && rec.datastore_id === ds.id ? Object.fromEntries(rec.rows.map(r => [r.type, r.accepted])) : null;
    const counts = await servedCounts(base, Object.keys(manifest.types));
    const types: Record<string, { source: number; accepted: number | null; served: number | null }> = {};
    for (const [t, v] of Object.entries(manifest.types)) {
      const served = counts[t]!.served;
      types[t] = { source: v.count, accepted: accepted?.[t] ?? null, served };
      if (served !== v.count) problems.push(`${t}: served ${served} != source ${v.count}${counts[t]!.detail ? ` (${counts[t]!.detail.slice(0, 120)})` : ''}`);
    }
    // The proxy's rewriting, as a client sees it: entry origins and next links on the proxy base, and a next link that works.
    const patient = knownPatient(dataset);
    const read = await proxyGet(`${base}/Patient/${patient}`);
    if (read.status !== 200) problems.push(`read Patient (known patient): HTTP ${read.status}`);
    const first = await proxyGet(`${base}/Observation?patient=Patient/${patient}&_count=2`);
    const p1 = first.status === 200 ? pageOf(first.text) : null;
    if (!p1) problems.push(`Observation search: HTTP ${first.status}`);
    else {
      if (p1.fullUrls.some(u => !u.startsWith(`${base}/`))) problems.push('entry.fullUrl not rewritten to the proxy base');
      if (p1.links.some(u => /^https?:/.test(u) && !u.startsWith(`${base}/`))) problems.push('Bundle.link not rewritten to the proxy base');
      if (p1.next) {
        const second = await proxyGet(p1.next);
        if (second.status !== 200) problems.push(`following the rewritten next link: HTTP ${second.status}`);
      }
    }
    const lexeme = await lexemeCheck(base);
    if (lexeme && !lexeme.equal) problems.push(`decimal lexeme: source ${lexeme.source}, served ${lexeme.served} (${lexeme.ref})`);
    let ids: Record<string, { missing: number; extra: number; pages: number; error: string | null }> | null = null;
    if (values.ids) {
      ids = {};
      for (const t of Object.keys(manifest.types)) {
        const src = new Set((await readFile(join(conv, `${t}.ndjson`), 'utf8')).split('\n').filter(Boolean).map(l => (parseLossless(l) as { id: string }).id));
        const got = await servedIds(base, t);
        const gotSet = new Set(got.ids);
        const missing = [...src].filter(i => !gotSet.has(i)).length;
        const extra = [...gotSet].filter(i => !src.has(i)).length;
        ids[t] = { missing, extra, pages: got.pages, error: got.error };
        if (missing || extra || got.error) problems.push(`${t} ids: ${missing} missing, ${extra} extra${got.error ? `, ${got.error}` : ''}`);
        log(`  ids ${t}: ${got.ids.length} served in ${got.pages} pages, ${missing} missing, ${extra} extra`);
      }
    }
    const out = { schema: 'fbbench.healthlake-verify/1', dataset, datastore_id_sha256: sha256Text(ds.id), checked_at: new Date().toISOString(), ok: problems.length === 0, problems, types,
      next_link_followed: Boolean(p1?.next), lexeme, ids, proxy: proxy.stats() };
    await writeJsonAtomic(join(healthlakeDir(dataset), 'verify.json'), out);
    await writeManifest(`healthlake-verify-${dataset}`, out);
    for (const [t, v] of Object.entries(types)) process.stdout.write(`${t}: source ${v.source} served ${v.served}\n`);
    process.stdout.write(problems.length ? `PROBLEMS:\n  ${problems.join('\n  ')}\n` : 'verify: ok\n');
    if (problems.length) process.exitCode = 1;
  } finally {
    await proxy.close();
  }
}

/** The first Observation whose recorded valueQuantity.value has trailing fractional zeros: is the lexeme served unchanged? */
async function lexemeCheck(base: string): Promise<{ ref: string; source: string; served: string | null; equal: boolean } | null> {
  const text = await readFile(join(conv, 'Observation.ndjson'), 'utf8');
  for (const line of text.split('\n')) {
    const m = /"valueQuantity":\{"value":(-?[0-9]+\.[0-9]*0)[,}]/.exec(line);
    if (!m) continue;
    const id = (parseLossless(line) as { id: string }).id;
    const r = await proxyGet(`${base}/Observation/${id}`);
    const served = r.status === 200 ? /"valueQuantity"\s*:\s*\{[^}]*"value"\s*:\s*(-?[0-9.eE+-]+)/.exec(r.text)?.[1] ?? null : null;
    return { ref: `Observation/${id}`, source: m[1]!, served, equal: served === m[1] };
  }
  return null;
}

// ---- proxy --------------------------------------------------------------------------------------------------

async function proxyCmd() {
  const { endpoint } = await liveEndpoint();
  const port = slotPorts(slot).signingProxy;
  const logPath = join(healthlakeDir(dataset), `signing-proxy-s${slot}.jsonl`);
  const p = await startSigningProxy({ port, endpoint, signer: makeSigner(cliCredentialProvider()), logPath, slot });
  process.stdout.write(`signing proxy on http://127.0.0.1:${p.port}/fhir -> the ${dataset} data store (GET only); log ${logPath}; Ctrl-C to stop\n`);
  await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  await p.close();
  process.stdout.write(`stopped: ${JSON.stringify(p.stats())}\n`);
}

// ---- teardown -----------------------------------------------------------------------------------------------

async function teardown() {
  const m = readManifest(dataset);
  const steps = teardownSteps(m);
  if (!steps.length) process.stdout.write(`nothing recorded as live in ${resourcesPath(dataset)}\n`);
  for (const s of steps) process.stdout.write(`will delete: ${s.action === 'delete' ? `data store ${s.id}` : `data store named ${s.name} (looked up by name)`}\n`);
  if (!values['yes-delete']) { if (steps.length) { process.stdout.write('Not deleted: pass --yes-delete.\n'); process.exitCode = 2; } return; }
  for (const s of steps) {
    const r = m.resources.find(x => (s.action === 'delete' ? x.id === s.id : x.name === s.name) && x.status !== 'DELETED')!;
    let id = s.action === 'delete' ? s.id : null;
    if (!id) {
      const found = (await listStores()).find(d => d.DatastoreName === (s as { name: string }).name);
      if (!found) { r.status = 'NOT_FOUND'; r.status_checked_at = new Date().toISOString(); note(m, 'not-found', r.name); await saveManifest(m); continue; }
      id = found.DatastoreId; applyDescribe(r, found);
    }
    const d = await describe(id);
    if (d && d.DatastoreStatus !== 'DELETING' && d.DatastoreStatus !== 'DELETED') {
      await awsCli(['healthlake', 'delete-fhir-datastore', '--datastore-id', id]);
      r.delete_requested_at = new Date().toISOString();
      note(m, 'delete-requested', id);
    } else if (d) { r.delete_requested_at ??= new Date().toISOString(); }
    applyDescribe(r, await describe(id));
    await saveManifest(m);
    log(`${id}: ${r.status}`);
    if (!values['no-wait']) await waitFor(m, r, st => st === 'DELETED' || st === 'NOT_FOUND', Number(values['max-wait-minutes'] ?? '30'));
  }
  // Anything still not deleted, tracked or not.
  const left = liveResources(m).filter(r => r.status !== 'DELETING');
  const untracked = (await listStores()).filter(s => s.DatastoreStatus !== 'DELETED' && s.DatastoreStatus !== 'DELETING' && (s.DatastoreName ?? '').startsWith(NAME_PREFIX) && !m.resources.some(r => r.id === s.DatastoreId));
  for (const r of liveResources(m)) process.stdout.write(`${r.id ?? r.name}: ${r.status}\n`);
  for (const s of untracked) process.stdout.write(`untracked fbbench data store still present: ${s.DatastoreName} ${s.DatastoreStatus}\n`);
  await writeManifest(`healthlake-teardown-${dataset}`, { dataset, region: AWS_REGION, resources: m.resources.map(r => ({ kind: r.kind, name: r.name, status: r.status, requested_at: r.requested_at, deleted_at: r.deleted_at })), untracked: untracked.length });
  if (left.length || untracked.length) process.exitCode = 1;
}

const COMMANDS: Record<string, () => Promise<void>> = { plan, create, status, load, verify, proxy: proxyCmd, teardown };
const cmd = COMMANDS[SUB];
if (!cmd) { process.stderr.write(`usage: bench:healthlake -- <${Object.keys(COMMANDS).join('|')}> [flags] (see bench/healthlake/cli.ts)\n`); process.exit(2); }
try {
  await cmd();
} catch (e) {
  process.stderr.write(`${e instanceof AwsSessionError ? 'AWS session: ' : ''}${(e as Error).message}\n`);
  process.exit(1);
}
