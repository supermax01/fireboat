// Inputs the agent track reads: questions, gold, the active HAPI dataset, and the patient of cited records.
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseNumbersAsStrings } from '../lib/json.js';
import { benchTreeDigest } from '../lib/hash.js';
import { ALL_DATASETS, BENCH, HAPI_BASE, mimicDevPatients, REPO, results, type DatasetId } from '../lib/paths.js';
import type { GoldRecord, QuestionRecord } from '../lib/types.js';

export function datasetOfQuestion(id: string): DatasetId {
  const d = id.slice(0, id.indexOf('.'));
  if (!(ALL_DATASETS as readonly string[]).includes(d)) throw new Error(`question id ${id} does not start with a dataset`);
  return d as DatasetId;
}

/** Loads JSONL records with numbers as strings (questions and gold hold no numbers the agent track computes on). */
function readStringJsonl<T>(path: string): T[] {
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  return readFileSync(path, 'utf8').split('\n').filter(l => l.length > 0).map(l => parseNumbersAsStrings(l) as T);
}

export function loadQuestion(id: string): QuestionRecord {
  const d = datasetOfQuestion(id);
  const q = readStringJsonl<QuestionRecord>(results.questions(d)).find(r => r.id === id);
  if (!q) throw new Error(`question ${id} not in ${results.questions(d)}`);
  assertDevelopmentPatient(q.dataset, q.patient_id);
  return q;
}

export function loadGold(questionId: string): GoldRecord {
  const d = datasetOfQuestion(questionId);
  const g = readStringJsonl<GoldRecord>(results.gold(d)).find(r => r.question_id === questionId);
  if (!g) throw new Error(`gold for ${questionId} not in ${results.gold(d)}`);
  return g;
}

/** The agent smoke test uses the development datasets only, and of MIMIC only the development patients (lib/paths.ts). */
export function assertDevelopmentPatient(dataset: DatasetId, patientId: string): void {
  if (dataset === 'mimic' && !mimicDevPatients().includes(patientId)) throw new Error(`MIMIC patient ${patientId} is not a development patient`);
  if (dataset !== 'mimic' && dataset !== 'synthea-dev') throw new Error(`dataset ${dataset as string} is not used by the agent smoke test`);
}

/** The running HAPI holds `dataset` (infra/active.ts), and the question's patient can be read. */
export async function checkActiveDataset(dataset: DatasetId, patientId: string): Promise<{ active: unknown; patient_status: number }> {
  const path = join(results.manifests, 'active-dataset.json');
  if (!existsSync(path)) throw new Error(`no ${path}: run bench:infra:up -- --dataset ${dataset}`);
  const active = parseNumbersAsStrings(readFileSync(path, 'utf8')) as { dataset?: string };
  if (active.dataset !== dataset) throw new Error(`HAPI holds ${active.dataset ?? '?'}, question needs ${dataset}`);
  const res = await fetch(`${HAPI_BASE}/Patient/${encodeURIComponent(patientId)}`, { headers: { accept: 'application/fhir+json' }, signal: AbortSignal.timeout(15000) });
  await res.arrayBuffer();
  if (res.status !== 200) throw new Error(`HAPI Patient/${patientId}: HTTP ${res.status}`);
  return { active, patient_status: res.status };
}

/** HAPI health and latency before and after every run. Never throws. */
export async function hapiHealth(): Promise<{ ok: boolean; status: number | null; ms: number; at: string }> {
  const at = new Date().toISOString();
  const t0 = performance.now();
  try {
    const res = await fetch(`${HAPI_BASE}/metadata?_summary=true`, { signal: AbortSignal.timeout(15000) });
    await res.arrayBuffer();
    return { ok: res.status === 200, status: res.status, ms: Math.round(performance.now() - t0), at };
  } catch {
    return { ok: false, status: null, ms: Math.round(performance.now() - t0), at };
  }
}

export function benchVersions(): { bench_commit: string; bench_dirty: boolean; bench_tree_sha256: string; bench_tree_files: number } {
  const git = (...args: string[]) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();
  return { bench_commit: git('rev-parse', 'HEAD'), bench_dirty: git('status', '--porcelain', '--', 'bench').length > 0, ...benchTreeDigest(BENCH) };
}

/**
 * Patient of each cited ref, read from converted/<dataset>/<Type>.ndjson (F6). null when the record is not found
 * or names no patient. Only lines containing the id are parsed.
 */
export async function patientsOfRefs(dataset: DatasetId, refs: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>(refs.map(r => [r, null]));
  const byType = new Map<string, Set<string>>();
  for (const r of refs) {
    const slash = r.indexOf('/');
    if (slash <= 0) continue;
    const [type, id] = [r.slice(0, slash), r.slice(slash + 1)];
    if (type === 'Patient') { out.set(r, id); continue; }
    if (!byType.has(type)) byType.set(type, new Set());
    byType.get(type)!.add(id);
  }
  for (const [type, ids] of byType) {
    const file = join(results.converted(dataset), `${type}.ndjson`);
    if (!existsSync(file)) continue;
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      for (const id of ids) {
        if (!line.includes(`"id":"${id}"`)) continue;
        const res = parseNumbersAsStrings(line) as { id?: string; subject?: { reference?: string }; patient?: { reference?: string } };
        if (res.id !== id) continue;
        const ref = res.subject?.reference ?? res.patient?.reference ?? null;
        out.set(`${type}/${id}`, ref?.startsWith('Patient/') ? ref.slice('Patient/'.length) : null);
      }
    }
  }
  return out;
}
