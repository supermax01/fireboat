// bench:load -- --dataset <d|synthea-holdout> [--scope full|dev] [--max-minutes 9] [--concurrency 4] [--force]
// Loads converted/<dataset>/ into HAPI. Three resumable phases, each run until done or until the time budget is spent:
//   load    PUT Type/id transactions of at most 500 entries to HAPI_BASE, level by level (data/plan.ts), cycle groups
//           kept whole; finished batches are recorded in load-state/<d>/progress.jsonl and skipped on rerun
//   export  page every resource back out of HAPI (data/checks.ts), one file per unit
//   checks  the post-load checks; writes manifests/load-<d>.json
// Exit 0: complete and every check passed. Exit 3: budget spent, run again. Exit 1: a check or batch failed.
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { COMMON_OPTIONS, loadDatasetArg } from '../lib/cli.js';
import { parseLossless } from '../lib/json.js';
import { HAPI_BASE, isSyntheaDataset, mimicDevPatients, results } from '../lib/paths.js';
import { readActiveDataset } from '../infra/active.js';
import { log } from '../infra/manifest.js';
import { pgVolume } from '../infra/pins.js';
import { isObj, patientLink, typeAndId } from './fhir.js';
import { FHIR_JSON, sleep } from './hapi.js';
import { appendProgress, openState, type BatchDone, type ChunkDone, type Scope } from './state.js';
import { runChecks, runExport } from './checks.js';

const { values } = parseArgs({
  options: { ...COMMON_OPTIONS, scope: { type: 'string' }, 'max-minutes': { type: 'string' }, concurrency: { type: 'string' } },
  strict: true,
});
const dataset = loadDatasetArg(values.dataset);
const scope = (values.scope ?? 'full') as Scope;
if (scope !== 'full' && scope !== 'dev') throw new Error('--scope must be full or dev');
const budgetMs = Number(values['max-minutes'] ?? '9') * 60_000;
const concurrency = Number(values.concurrency ?? '4');
if (!(budgetMs > 0) || !(concurrency >= 1 && concurrency <= 16)) throw new Error('bad --max-minutes or --concurrency');
const startedAt = new Date();
const deadline = startedAt.getTime() + budgetMs;
const MAX_BATCH = 500;

const active = await readActiveDataset();
if (active?.dataset !== dataset || active.volume !== pgVolume(dataset)) {
  throw new Error(`HAPI is not serving ${dataset} (active: ${JSON.stringify(active)}); run bench:infra:up -- --dataset ${dataset}`);
}

const convDir = results.converted(dataset);
interface Plan { max_level: number; levels: Record<string, string>; groups: Record<string, [number, number][]>; group_sizes: number[] }
const plan = JSON.parse(await readFile(join(convDir, 'load-plan.json'), 'utf8')) as Plan; // our own plan file, not FHIR data
const types = Object.keys(plan.levels).sort();
const { records } = await openState(dataset, scope, values.force === true);
const done = new Set(records.filter((r): r is BatchDone => r.schema === 'fbbench.load-batch/1').map(r => r.key));
const loadComplete = records.some(r => r.schema === 'fbbench.load-chunk/1' && r.phase === 'load' && r.complete);

/** dev scope: development patients and resources linked to no patient (shared). Synthea datasets are synthetic throughout. */
const inScope = (resource: Record<string, unknown>): boolean => {
  if (scope === 'full' || isSyntheaDataset(dataset)) return true;
  const link = patientLink(resource as never);
  return link === null || mimicDevPatients().includes(link.patientId);
};

interface Batch { key: string; level: number; type: string; entries: string[] }

function entryText(line: string, where: string): { text: string; keep: boolean } {
  const resource = parseLossless(line);
  if (!isObj(resource)) throw new Error(`${where}: not an object`);
  const { type, id } = typeAndId(resource, where);
  return { text: `{"resource":${line},"request":{"method":"PUT","url":${JSON.stringify(`${type}/${id}`)}}}`, keep: inScope(resource) };
}

async function* typeLines(type: string): AsyncGenerator<[number, string]> {
  const rl = createInterface({ input: createReadStream(join(convDir, `${type}.ndjson`), { encoding: 'utf8' }), crlfDelay: Infinity });
  let i = 0;
  for await (const line of rl) yield [i++, line];
}

async function* batchesForLevel(level: number): AsyncGenerator<Batch> {
  const ch = level.toString(36);
  // Cycle groups at this level first, each group whole inside one transaction.
  const grouped = new Map<string, Map<number, number>>();
  for (const type of types) {
    for (const [line, group] of plan.groups[type] ?? []) {
      if (plan.levels[type]![line] === ch) (grouped.get(type) ?? grouped.set(type, new Map()).get(type)!).set(line, group);
    }
  }
  if (grouped.size > 0) {
    const byGroup = new Map<number, string[]>();
    for (const [type, lines] of grouped) {
      for await (const [i, line] of typeLines(type)) {
        const g = lines.get(i);
        if (g === undefined) continue;
        const e = entryText(line, `${type}:${i}`);
        if (e.keep) (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(e.text);
      }
    }
    let batch: string[] = [];
    let n = 0;
    for (const g of [...byGroup.keys()].sort((a, b) => a - b)) {
      const members = byGroup.get(g)!;
      if (batch.length + members.length > MAX_BATCH) { yield { key: `L${level}:groups:${n++}`, level, type: 'groups', entries: batch }; batch = []; }
      batch.push(...members);
    }
    if (batch.length) yield { key: `L${level}:groups:${n++}`, level, type: 'groups', entries: batch };
  }
  for (const type of types) {
    if (!plan.levels[type]!.includes(ch)) continue;
    const skip = grouped.get(type);
    let batch: string[] = [];
    let n = 0;
    for await (const [i, line] of typeLines(type)) {
      if (plan.levels[type]![i] !== ch || skip?.has(i)) continue;
      const e = entryText(line, `${type}:${i}`);
      if (!e.keep) continue;
      batch.push(e.text);
      if (batch.length === MAX_BATCH) { yield { key: `L${level}:${type}:${n++}`, level, type, entries: batch }; batch = []; }
    }
    if (batch.length) yield { key: `L${level}:${type}:${n++}`, level, type, entries: batch };
  }
}

async function sendBatch(b: Batch): Promise<BatchDone> {
  const body = `{"resourceType":"Bundle","type":"transaction","entry":[${b.entries.join(',')}]}`;
  const t0 = performance.now();
  let last = '';
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(HAPI_BASE, {
        method: 'POST',
        headers: { 'content-type': FHIR_JSON, accept: FHIR_JSON, prefer: 'return=minimal' },
        body,
        signal: AbortSignal.timeout(900_000),
      });
      const text = await res.text();
      if (res.status === 200) {
        const bundle = parseLossless(text);
        const got = isObj(bundle) && Array.isArray(bundle.entry) ? bundle.entry : [];
        const bad = got.filter(e => !(isObj(e) && isObj(e.response) && /^20[01]\b/.test(String(e.response.status))));
        if (got.length !== b.entries.length || bad.length) throw new Error(`${b.key}: ${got.length} responses for ${b.entries.length} entries, ${bad.length} not 200/201`);
        return { schema: 'fbbench.load-batch/1', key: b.key, level: b.level, type: b.type, entries: b.entries.length, ms: Math.round(performance.now() - t0), attempts: attempt, finished_at: new Date().toISOString() };
      }
      last = `HTTP ${res.status}: ${text.slice(0, 600)}`;
      if (res.status < 500 && res.status !== 409 && res.status !== 429) break;
    } catch (e) {
      last = (e as Error).message;
    }
    log(`  ${b.key}: attempt ${attempt} failed: ${last.split('\n')[0]}`);
    await sleep(2000 * attempt);
  }
  throw new Error(`${b.key}: giving up: ${last}`);
}

async function loadPhase(): Promise<{ complete: boolean; batches: number; resources: number }> {
  let batches = 0;
  let resources = 0;
  let failure: Error | null = null;
  for (let level = 0; level <= plan.max_level; level++) {
    const inflight = new Set<Promise<void>>();
    for await (const b of batchesForLevel(level)) {
      if (done.has(b.key)) continue;
      if (failure || Date.now() > deadline) break;
      const p: Promise<void> = sendBatch(b)
        .then(async rec => {
          await appendProgress(dataset, rec);
          done.add(b.key);
          batches++;
          resources += rec.entries;
          if (batches % 20 === 0) log(`  level ${level}: ${batches} batches, ${resources} resources this chunk (last ${b.key}, ${rec.ms} ms)`);
        })
        .catch((e: Error) => { failure = e; })
        .finally(() => { inflight.delete(p); });
      inflight.add(p);
      if (inflight.size >= concurrency) await Promise.race(inflight);
    }
    await Promise.all(inflight);
    if (failure) throw failure;
    if (Date.now() > deadline) return { complete: false, batches, resources };
    log(`level ${level} done`);
  }
  return { complete: true, batches, resources };
}

async function chunk(phase: ChunkDone['phase'], fn: () => Promise<{ complete: boolean; batches: number; resources: number }>): Promise<boolean> {
  const t0 = new Date();
  const r = await fn();
  const t1 = new Date();
  await appendProgress(dataset, { schema: 'fbbench.load-chunk/1', phase, started_at: t0.toISOString(), ended_at: t1.toISOString(), ms: t1.getTime() - t0.getTime(), batches: r.batches, resources: r.resources, complete: r.complete });
  log(`${phase}: ${r.complete ? 'complete' : 'budget spent, run again'} (${r.batches} units, ${r.resources} resources, ${t1.getTime() - t0.getTime()} ms)`);
  return r.complete;
}

let ok = loadComplete || await chunk('load', loadPhase);
if (ok) ok = await chunk('export', () => runExport({ dataset, scope, deadline }));
if (!ok) process.exit(3);
const passed = await runChecks({ dataset, scope, concurrency: 8 });
process.exit(passed ? 0 : 1);

