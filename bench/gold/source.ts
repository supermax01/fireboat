// Iterates the patients of a dataset (MIMIC: development patients only) straight from the raw files, plus the manifest helpers.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { mimicDevPatients, REPO, results, type DatasetId } from '../lib/paths.js';
import { stringifyLossless } from '../lib/json.js';
import { readMimic, readSyntheaBundle, syntheaSource, type InputFile, type SharedData } from './reader.js';
import type { Ctx } from './rules.js';

export interface SourcePass { inputs: InputFile[]; notes: string[]; sharedAll: SharedData[] }

/**
 * Calls `fn` once per patient in a fixed order. MIMIC: the development patients, in the local config's order. Synthea (synthea-dev and
 * synthea-holdout): every bundle of the dataset, file name order; the holdout has no development-patient restriction.
 */
export async function forEachPatient(dataset: DatasetId, fn: (ctx: Ctx) => void | Promise<void>, only?: Set<string>): Promise<SourcePass> {
  if (dataset === 'mimic') {
    const m = await readMimic(mimicDevPatients());
    for (const id of mimicDevPatients()) if (!only || only.has(id)) await fn({ data: m.patients.get(id)!, shared: m.shared });
    return { inputs: m.inputs, notes: [], sharedAll: [m.shared] };
  }
  const { files, sums } = syntheaSource(dataset);
  const inputs: InputFile[] = [];
  const sharedAll: SharedData[] = [];
  let conditional = 0;
  for (const f of files) {
    const idFromName = /_([0-9a-f-]{36})\.json$/.exec(basename(f))?.[1];
    if (only && idFromName && !only.has(idFromName)) continue;
    const b = await readSyntheaBundle(f, sums, dataset);
    inputs.push(b.input);
    conditional += b.conditionalRefs;
    sharedAll.push(b.shared);
    if (!only || only.has(b.data.patientId)) await fn({ data: b.data, shared: b.shared });
  }
  return { inputs, notes: [`${conditional} conditional references left unresolved (shared Organization/Practitioner files not downloaded); no gold rule reads through them`], sharedAll };
}

export function gitInfo(): { bench_commit: string; bench_dirty: boolean } {
  const git = (...args: string[]) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();
  return { bench_commit: git('rev-parse', 'HEAD'), bench_dirty: git('status', '--porcelain').length > 0 };
}

export const sha256OfFile = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

export async function writeJsonlFile(path: string, records: readonly unknown[]): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map(r => stringifyLossless(r) + '\n').join(''), 'utf8');
  return sha256OfFile(path);
}

export async function writeManifest(name: string, manifest: Record<string, unknown>): Promise<string> {
  const path = join(results.manifests, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return path;
}

export const goldPaths = {
  probes: (d: DatasetId) => join(dirname(results.questions(d)), 'probes.jsonl'),
  pool: (d: DatasetId) => join(dirname(results.questions(d)), 'pool.jsonl'),
  probeGold: (d: DatasetId) => join(dirname(results.gold(d)), 'probe-gold.jsonl'),
  poolGold: (d: DatasetId) => join(dirname(results.gold(d)), 'pool-gold.ts.jsonl'),
  dev: (file: string) => join(dirname(results.manifests), 'dev', file),
};

export const toolVersions = () => ({ node: process.version });
