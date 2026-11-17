// Small process and manifest helpers for infra and data entry points (every entry point writes a manifest).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { benchTreeDigest } from '../lib/hash.js';
import { CODE_BENCH, CODE_REPO, results } from '../lib/paths.js';
import { parseLossless, stringifyLossless } from '../lib/json.js';

export interface RunResult { code: number; stdout: string; stderr: string }

/** Runs a command without a shell. Never throws on a non-zero exit; callers check `code`. */
export function run(cmd: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise(resolve => {
    execFile(cmd, args, { env: opts.env ?? process.env, cwd: opts.cwd, timeout: opts.timeoutMs ?? 600_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
  });
}

export async function mustRun(cmd: string, args: readonly string[], opts: Parameters<typeof run>[2] = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export const sha256Text = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

/** Worktree HEAD, dirty flag and the bench/ tree digest (bench/ is untracked, so HEAD alone never identifies the code). */
export async function gitInfo(): Promise<{ bench_commit: string; bench_dirty: boolean; bench_tree_sha256: string; bench_tree_files: number }> {
  const head = (await mustRun('git', ['-C', CODE_REPO, 'rev-parse', 'HEAD'])).trim();
  const status = await mustRun('git', ['-C', CODE_REPO, 'status', '--porcelain']);
  return { bench_commit: head, bench_dirty: status.trim().length > 0, ...benchTreeDigest(CODE_BENCH) };
}

export const manifestPath = (name: string) => join(results.manifests, `${name}.json`);

/** Writes manifests/<name>.json atomically with the common fields (argv, git, node version, time). */
export async function writeManifest(name: string, body: Record<string, unknown>): Promise<string> {
  const path = manifestPath(name);
  const record = {
    schema: `fbbench.manifest.${name.replace(/-(mimic|synthea-dev|synthea-holdout)$/, '')}/1`,
    written_at: new Date().toISOString(),
    argv: process.argv.slice(1),
    node: process.version,
    ...(await gitInfo()),
    ...body,
  };
  await writeJsonAtomic(path, record);
  return path;
}

export async function readManifest(name: string): Promise<Record<string, unknown> | null> {
  try {
    return parseLossless(await readFile(manifestPath(name), 'utf8')) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeJsonAtomic(path: string, value: unknown, pretty = true): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const text = pretty ? JSON.stringify(value, null, 2) : stringifyLossless(value); // LosslessNumber keeps its lexeme in both
  await writeFile(tmp, text + '\n', 'utf8');
  await rename(tmp, path);
}

export const log = (msg: string) => process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
