// Output rules for stratum question sets (the long-list and decimal strata, see bench/README.md): they go to their own
// directory under the git-ignored local folder and never over the shared questions, gold, probe, pool, dev or manifest
// files other campaigns depend on.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { LOCAL, RESULTS, results, type DatasetId } from '../lib/paths.js';
import { goldPaths } from './source.js';
import { STRATA, type StratumId } from './templates.js';

export function strataArg(value: string): StratumId[] {
  const list = value.split(',').map(s => s.trim()).filter(Boolean);
  for (const s of list) if (!(STRATA as readonly string[]).includes(s)) throw new Error(`--strata takes ${STRATA.join(', ')}`);
  if (list.length === 0 || new Set(list).size !== list.length) throw new Error('--strata needs distinct stratum names');
  return list as StratumId[];
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

/**
 * Throws unless `out` is a directory below the local folder or the results folder (lib/paths.ts LOCAL, RESULTS) that is
 * none of (and not inside) the shared result directories.
 */
export function assertSafeOut(dataset: DatasetId, out: string): string {
  const p = resolve(out);
  const below = (dir: string) => inside(p, dir) && p !== dir;
  if (!below(LOCAL) && !below(RESULTS)) throw new Error(`--out must be a directory under ${LOCAL} or ${RESULTS}`);
  const shared = [dirname(results.questions(dataset)), dirname(results.gold(dataset)), results.manifests, dirname(goldPaths.dev('x')), results.converted(dataset)];
  for (const d of shared) if (inside(p, d)) throw new Error(`--out must not be inside ${d}`);
  return p;
}

export async function writeJson(dir: string, name: string, value: unknown): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
  return path;
}
