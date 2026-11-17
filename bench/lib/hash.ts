// Canonical hash rule for every selection. No random-number library is used anywhere in the bench.
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const HASH_TAG = 'fbbench/1.1';

/** Development seed: a fixed value, not a random draw. Records carry seed.kind = "dev". */
export const DEV_SEED_HEX = '0'.repeat(64);

export type SeedPurpose =
  | 'saq' | 'gst' | 'sps' | 'scripted' | 'synthea-holdout' | 'order' | 'slot' | 'bootstrap' | 'anchor' | 'sensitivity';

const WELL_FORMED = /^(?:[^\ud800-\udfff]|[\ud800-\udbff][\udc00-\udfff])*$/;

/** RFC 8785 JCS of an array of strings equals ECMAScript JSON.stringify for well-formed strings. */
export function jcsStringArray(items: readonly string[]): string {
  for (const s of items) if (typeof s !== 'string' || !WELL_FORMED.test(s)) throw new Error('JCS input must be well-formed strings');
  return JSON.stringify(items);
}

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** sha256(JCS(["fbbench/1.1", purpose, seed_hex, template_id, candidate_key])). Sort candidates ascending by this. */
export function rankHash(purpose: SeedPurpose, seedHex: string, templateId: string, candidateKey: string): string {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error('seed must be 64 lowercase hex');
  return sha256Hex(jcsStringArray([HASH_TAG, purpose, seedHex, templateId, candidateKey]));
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Sorted relative paths of the regular files under dir, skipping directories named in `skipDirs` at any depth. */
export function listFiles(dir: string, skipDirs: ReadonlySet<string> = new Set()): string[] {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = join(d, e.name);
    if (e.isDirectory()) return skipDirs.has(e.name) ? [] : walk(p);
    return e.isFile() ? [p] : [];
  });
  return walk(dir).map(p => relative(dir, p)).sort();
}

/** sha256 over the sorted "sha256  relative-path" listing of every regular file under dir (same rule as servers/install.ts treeDigest). */
export function treeDigestSync(dir: string, skipDirs: ReadonlySet<string> = new Set()): { files: number; sha256: string } {
  const lines = listFiles(dir, skipDirs).map(p => `${sha256Hex(readFileSync(join(dir, p)))}  ${p}`);
  return { files: lines.length, sha256: sha256Hex(lines.join('\n') + '\n') };
}

/**
 * Digest of the bench code that produced a result. bench/ is untracked in this worktree, so the git HEAD alone never
 * identifies it; every manifest records this beside bench_commit.
 */
export function benchTreeDigest(benchDir: string): { bench_tree_sha256: string; bench_tree_files: number } {
  const d = treeDigestSync(benchDir, new Set(['node_modules', '.git']));
  return { bench_tree_sha256: d.sha256, bench_tree_files: d.files };
}
