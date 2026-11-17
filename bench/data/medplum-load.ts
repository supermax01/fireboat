// bench:medplum:load -- --dataset synthea-dev [--chunk 100] [--concurrency 2]
// Loads converted/<dataset>/ into the bench Medplum (bench:medplum:up) with preserved client ids (data/medplum-lib.ts),
// in the load plan's dependency order, as FHIR batch Bundles of PUT Type/id. Counts sent, accepted and rejected per type,
// keeps every rejection with its OperationOutcome text (rejections.jsonl), never skips silently, then reconciles the
// per-type counts Medplum serves for the project against the source and writes manifests/medplum-load-<dataset>.json.
// Resumable: chunks already in progress.jsonl are not resent. Synthea development data only (no MIMIC).
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { datasetArg } from '../lib/cli.js';
import { appendJsonl, readJsonl } from '../lib/jsonl.js';
import { stringifyLossless } from '../lib/json.js';
import { results, type DatasetId } from '../lib/paths.js';
import { log, writeJsonAtomic, writeManifest } from '../infra/manifest.js';
import {
  MEDPLUM_BOOTSTRAP, MEDPLUM_DATASETS, MEDPLUM_EXPECTED_VERSION, MEDPLUM_FHIR_BASE, MEDPLUM_FHIR_PATH, clientCredentialsToken, medplumHealth, medplumRequest,
} from '../infra/medplum.js';
import {
  batchBundle, chunkIndices, medplumDir, reconcileCounts, rejectionSummary, tallyBatchResponse, type BatchTally, type Rejection, type SentEntry, type TypeTally,
} from './medplum-lib.js';

const { values } = parseArgs({ options: { dataset: { type: 'string' }, chunk: { type: 'string' }, concurrency: { type: 'string' } }, strict: true });
const dataset = datasetArg(values.dataset);
if (!(MEDPLUM_DATASETS as readonly string[]).includes(dataset)) throw new Error(`only ${MEDPLUM_DATASETS.join(', ')} may be loaded into Medplum`);
const CHUNK = Number(values.chunk ?? '100');
const CONCURRENCY = Number(values.concurrency ?? '2');
const MAX_CHUNK_BYTES = 4 * 1024 * 1024; // below MEDPLUM_MAX_JSON_SIZE (8mb) with room for the batch envelope

const health = await medplumHealth();
if (health?.ok !== true || !String(health.version).startsWith(MEDPLUM_EXPECTED_VERSION)) throw new Error(`Medplum is not healthy at ${MEDPLUM_FHIR_BASE}: run bench:medplum:up`);

// ---- super-admin token, refreshed well before its one-hour lifetime ends ----
let tok = await clientCredentialsToken(MEDPLUM_BOOTSTRAP.clientId, MEDPLUM_BOOTSTRAP.clientSecret);
async function adminToken(): Promise<string> {
  if (Date.now() - tok.obtained_at > (tok.expires_in - 600) * 1000) tok = await clientCredentialsToken(MEDPLUM_BOOTSTRAP.clientId, MEDPLUM_BOOTSTRAP.clientSecret);
  return tok.access_token;
}

const dir = medplumDir(dataset);
mkdirSync(dir, { recursive: true });
const projectPath = join(dir, 'project.json');
const progressPath = join(dir, 'progress.jsonl');
const rejectionsPath = join(dir, 'rejections.jsonl');

// ---- project (one per dataset; strict validation on, as Medplum's own project init sets it) ----
async function ensureProject(): Promise<string> {
  if (existsSync(projectPath)) {
    const p = JSON.parse(await readFile(projectPath, 'utf8')) as { project_id: string };
    const r = await medplumRequest(`${MEDPLUM_FHIR_PATH}/Project/${p.project_id}`, await adminToken());
    if (r.status === 200) return p.project_id;
    throw new Error(`project ${p.project_id} in ${projectPath} is not readable (HTTP ${r.status}); a fresh volume needs a fresh state directory`);
  }
  const r = await medplumRequest(`${MEDPLUM_FHIR_PATH}/Project`, await adminToken(), { method: 'POST', body: JSON.stringify({ resourceType: 'Project', name: `fbbench ${dataset}`, strictMode: true }) });
  const id = r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? (r.body as Record<string, unknown>).id : null;
  if (r.status !== 201 || typeof id !== 'string') throw new Error(`project create failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
  await writeJsonAtomic(projectPath, { schema: 'fbbench.medplum-project/1', dataset, project_id: id, created_at: new Date().toISOString(), name: `fbbench ${dataset}`, strict_mode: true });
  return id;
}
const projectId = await ensureProject();
log(`Medplum project ${projectId} (${dataset})`);

// ---- units in load-plan order: level, then type ----
const conv = results.converted(dataset);
const manifest = JSON.parse(await readFile(join(conv, 'manifest.json'), 'utf8')) as { types: Record<string, { count: number }> };
const plan = JSON.parse(await readFile(join(conv, 'load-plan.json'), 'utf8')) as { max_level: number; levels: Record<string, string> };

interface ProgressRec { schema: 'fbbench.medplum-progress/1'; type: string; level: number; chunk: number; lines: number[]; sent: number; accepted: number; rejected: number; id_changed: number; mode: 'batch' | 'single'; ms: number }
/** Our own state files, plain JSON per line (read through readJsonl so a partial tail is moved aside first). */
async function readState<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  if (!existsSync(path)) return out;
  for await (const r of readJsonl(path)) out.push(JSON.parse(stringifyLossless(r)) as T);
  return out;
}
const progress = await readState<ProgressRec>(progressPath);
const done = new Set(progress.map(p => `${p.type}|${p.level}|${p.chunk}`));

async function postBatch(lines: string[]): Promise<{ tally: BatchTally; sent: SentEntry[] }> {
  const { body, sent } = batchBundle(projectId, lines);
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await medplumRequest(MEDPLUM_FHIR_PATH, await adminToken(), { method: 'POST', body, timeoutMs: 600_000 });
      if (r.status === 200) return { tally: tallyBatchResponse(sent, r.body), sent };
      last = `HTTP ${r.status}: ${r.text.slice(0, 300)}`;
      if (r.status >= 400 && r.status < 500) break; // the whole batch was refused; retry entry by entry below
    } catch (e) { last = (e as Error).message; }
    await new Promise(res => setTimeout(res, 2000 * attempt));
  }
  throw new Error(last);
}

let totalSent = 0;
const t0 = Date.now();
for (let level = 0; level <= plan.max_level; level++) {
  for (const type of Object.keys(plan.levels).sort()) {
    const lv = plan.levels[type]!;
    if (!lv.includes(String(level))) continue;
    const all = (await readFile(join(conv, `${type}.ndjson`), 'utf8')).split('\n').filter(Boolean);
    if (all.length !== lv.length) throw new Error(`${type}: ${all.length} lines but load-plan has ${lv.length}`);
    const idx = all.map((_, i) => i).filter(i => lv[i] === String(level));
    const chunks = chunkIndices(idx.map(i => Buffer.byteLength(all[i]!)), CHUNK, MAX_CHUNK_BYTES).map(c => c.map(k => idx[k]!));
    const todo = chunks.map((lines, chunk) => ({ lines, chunk })).filter(c => !done.has(`${type}|${level}|${c.chunk}`));
    log(`${type} level ${level}: ${idx.length} resources in ${chunks.length} chunks, ${todo.length} to send`);
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const { lines, chunk } = todo[next++]!;
        const started = Date.now();
        const texts = lines.map(i => all[i]!);
        let tally: BatchTally;
        let mode: ProgressRec['mode'] = 'batch';
        try {
          tally = (await postBatch(texts)).tally;
        } catch (e) {
          // The batch as a whole failed: send each entry as its own one-entry batch so every resource gets a verdict.
          log(`${type} level ${level} chunk ${chunk}: batch failed (${(e as Error).message.slice(0, 200)}); sending entries one by one`);
          mode = 'single';
          tally = { accepted: 0, rejected: [], id_changed: [] };
          for (const t of texts) {
            try {
              const r = await postBatch([t]);
              tally.accepted += r.tally.accepted; tally.rejected.push(...r.tally.rejected); tally.id_changed.push(...r.tally.id_changed);
            } catch (e2) {
              const s = batchBundle(projectId, [t]).sent[0]!;
              tally.rejected.push({ type: s.type, id: s.id, status: 0, reason: `request failed: ${(e2 as Error).message.slice(0, 200)}`, issues: [] });
            }
          }
        }
        if (tally.rejected.length) await appendJsonl(rejectionsPath, tally.rejected.map(r => ({ schema: 'fbbench.medplum-rejection/1', ...r })));
        if (tally.id_changed.length) await appendJsonl(rejectionsPath, tally.id_changed.map(s => ({ schema: 'fbbench.medplum-id-changed/1', ...s })));
        const rec: ProgressRec = { schema: 'fbbench.medplum-progress/1', type, level, chunk, lines, sent: lines.length, accepted: tally.accepted, rejected: tally.rejected.length, id_changed: tally.id_changed.length, mode, ms: Date.now() - started };
        await appendJsonl(progressPath, [rec]);
        progress.push(rec);
        totalSent += lines.length;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
    log(`${type} level ${level}: done (${totalSent} sent this invocation, ${Math.round((Date.now() - t0) / 1000)} s)`);
  }
}

// ---- reconciliation: counts the project serves, per type ----
const tally: Record<string, TypeTally> = {};
const seen = new Set<string>();
for (const p of [...progress].reverse()) { // last record per chunk
  const k = `${p.type}|${p.level}|${p.chunk}`;
  if (seen.has(k)) continue;
  seen.add(k);
  const t = (tally[p.type] ??= { sent: 0, accepted: 0, rejected: 0 });
  t.sent += p.sent; t.accepted += p.accepted; t.rejected += p.rejected;
}
const served: Record<string, number | null> = {};
for (const type of Object.keys(manifest.types)) {
  const r = await medplumRequest(`${MEDPLUM_FHIR_PATH}/${type}?_project=${projectId}&_summary=count&_total=accurate`, await adminToken());
  const total = r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? (r.body as Record<string, unknown>).total : undefined;
  served[type] = r.status === 200 && total !== undefined ? Number(String(total)) : null;
}
const source = Object.fromEntries(Object.entries(manifest.types).map(([t, v]) => [t, v.count]));
const rec = reconcileCounts(source, tally, served);
const listed = await readState<Rejection & { schema: string }>(rejectionsPath);
const rejections = dedupeLast(listed.filter(r => r.schema === 'fbbench.medplum-rejection/1'));
const idChanged = listed.filter(r => r.schema === 'fbbench.medplum-id-changed/1').length;
const summary = rejectionSummary(rejections);
// Every counted rejection must be listed with its reason, and no accepted entry may have changed its id.
const rejectedCounted = Object.values(tally).reduce((a, t) => a + t.rejected, 0);
if (rejections.length !== rejectedCounted) { rec.ok = false; process.stderr.write(`rejections listed ${rejections.length} != rejections counted ${rejectedCounted}\n`); }
if (idChanged > 0) rec.ok = false;
await writeJsonAtomic(join(dir, 'reconcile.json'), { schema: 'fbbench.medplum-reconcile/1', dataset, project_id: projectId, checked_at: new Date().toISOString(), ...rec, rejection_summary: summary, id_changed: idChanged });
await writeManifest(`medplum-load-${dataset}`, {
  dataset, medplum_fhir_base: MEDPLUM_FHIR_BASE, medplum_version: health.version, project_id_file: projectPath,
  id_strategy: 'client ids preserved: PUT Type/<file id> as the bootstrap super-admin client with meta.project set (Medplum lets only a super admin set ids); no id map',
  chunk_entries: CHUNK, chunk_max_bytes: MAX_CHUNK_BYTES, concurrency: CONCURRENCY, order: 'load-plan levels, then type name',
  converted_manifest: join(conv, 'manifest.json'), reconcile_ok: rec.ok, reconcile: rec.rows, rejection_summary: summary, id_changed: idChanged,
  state: { progress: progressPath, rejections: rejectionsPath, reconcile: join(dir, 'reconcile.json') },
  wall_s: Math.round((Date.now() - t0) / 1000),
});
for (const r of rec.rows) process.stdout.write(`${r.type}: source ${r.source} sent ${r.sent} accepted ${r.accepted} rejected ${r.rejected} served ${r.served}${r.ok ? '' : `  ${r.problems.join('; ')}`}\n`);
for (const s of summary) process.stdout.write(`rejected ${s.count} ${s.type}: ${s.reason}\n`);
if (!rec.ok) process.exitCode = 1;

/** A resource rejected in an earlier attempt and accepted on resume appears once per attempt; keep the last per resource. */
function dedupeLast(rs: Rejection[]): Rejection[] {
  const m = new Map<string, Rejection>();
  for (const r of rs) m.set(`${r.type}/${r.id}`, r);
  return [...m.values()];
}

export type { DatasetId };
