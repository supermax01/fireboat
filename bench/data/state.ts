// Resumable loader state: RESULTS/load-state/<dataset>/ (progress.jsonl, export/). Tied to the plan, scope and volume.
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { completeLines, repairPartialTail } from '../lib/jsonl.js';
import { RESULTS, results, type LoadDatasetId as DatasetId } from '../lib/paths.js';
import { mustRun, sha256File } from '../infra/manifest.js';
import { pgVolume } from '../infra/pins.js';

export type Scope = 'full' | 'dev';

export const stateDir = (d: DatasetId) => join(RESULTS, 'load-state', d);
export const progressPath = (d: DatasetId) => join(stateDir(d), 'progress.jsonl');
export const exportDir = (d: DatasetId) => join(stateDir(d), 'export');

export interface StateHeader {
  schema: 'fbbench.load-state/1';
  dataset: DatasetId;
  scope: Scope;
  plan_sha256: string;
  converted_manifest_sha256: string;
  volume: string;
  volume_created_at: string;
  created_at: string;
}

export interface BatchDone { schema: 'fbbench.load-batch/1'; key: string; level: number; type: string; entries: number; ms: number; attempts: number; finished_at: string }
export interface ChunkDone {
  schema: 'fbbench.load-chunk/1'; phase: 'load' | 'export' | 'checks'; started_at: string; ended_at: string; ms: number;
  batches: number; resources: number; complete: boolean;
}
type ProgressRecord = StateHeader | BatchDone | ChunkDone;

export async function currentIdentity(d: DatasetId, scope: Scope): Promise<Omit<StateHeader, 'schema' | 'created_at'>> {
  const volume = pgVolume(d);
  const created = (await mustRun('docker', ['volume', 'inspect', volume, '--format', '{{.CreatedAt}}'])).trim();
  return {
    dataset: d,
    scope,
    plan_sha256: await sha256File(join(results.converted(d), 'load-plan.json')),
    converted_manifest_sha256: await sha256File(join(results.converted(d), 'manifest.json')),
    volume,
    volume_created_at: created,
  };
}

/** Opens the state, creating it if absent. A state for another plan, scope or volume is refused unless force (then archived). */
export async function openState(d: DatasetId, scope: Scope, force: boolean): Promise<{ header: StateHeader; records: ProgressRecord[] }> {
  const ident = await currentIdentity(d, scope);
  const path = progressPath(d);
  if (existsSync(path)) {
    repairPartialTail(path); // a batch whose record was cut off is simply loaded again (PUT is idempotent)
    const records = completeLines(readFileSync(path, 'utf8')).map(l => JSON.parse(l) as ProgressRecord); // our own records
    const header = records[0] as StateHeader;
    const same = header?.schema === 'fbbench.load-state/1' && (Object.keys(ident) as (keyof typeof ident)[]).every(k => header[k] === ident[k]);
    if (same) return { header, records };
    if (!force) {
      throw new Error(`load state ${path} belongs to another plan, scope or volume (have ${JSON.stringify(header)}, now ${JSON.stringify(ident)}); pass --force to start over`);
    }
    await rename(stateDir(d), `${stateDir(d)}.superseded-${Date.now()}`);
  }
  const header: StateHeader = { schema: 'fbbench.load-state/1', ...ident, created_at: new Date().toISOString() };
  await mkdir(stateDir(d), { recursive: true });
  await appendFile(path, JSON.stringify(header) + '\n');
  return { header, records: [header] };
}

export async function appendProgress(d: DatasetId, record: BatchDone | ChunkDone): Promise<void> {
  repairPartialTail(progressPath(d));
  await appendFile(progressPath(d), JSON.stringify(record) + '\n');
}

export async function readProgress(d: DatasetId): Promise<ProgressRecord[]> {
  repairPartialTail(progressPath(d));
  return completeLines(await readFile(progressPath(d), 'utf8')).map(l => JSON.parse(l) as ProgressRecord);
}
