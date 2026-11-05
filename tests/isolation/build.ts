import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { API } from 'typescript/unstable/sync';
import { dependencyDigests, treeDigest } from './digests.js';
const STAMP = join('dist', '.b2-build-stamp');
const OUTPUT = join('dist', '.b2-build-output');
const LOCK = join('dist', '.b2-build.lock');
const CLI = join('dist', 'packages', 'server', 'src', 'cli.js');
const BUILD_STEPS = ['scripts/stage-runtime-assets.mjs', 'scripts/generate-release-metadata.mjs', 'scripts/check-dist-identity.mjs'];
export const STALE_LOCK_MS = 180000;
const execFileAsync = promisify(execFile);
function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') yield* sources(path); }
    else yield path;
  }
}
/** Every src asset (including imported JSON), examples, the parsed tsconfig chain, compiler and installed inputs.
 * The stamp detects stale/inconsistent builds; it is not an authentication mechanism against an artifact writer. */
export function sourceStamp(root = '.'): string {
  const configs = new Map<string, string>();
  const api = new API({ cwd: resolve(root), fs: { readFile(path) {
    try { const text = readFileSync(path, 'utf8'); configs.set(relative(resolve(root), path), text); return text; } catch { return null; }
  } } });
  let parsed: ReturnType<API['parseConfigFile']>;
  try { parsed = api.parseConfigFile(resolve(root, 'tsconfig.build.json')); } finally { api.close(); }
  const files = [...sources(join(root, 'packages'))].filter(p => /\/src\//.test(p));
  if (existsSync(join(root, 'examples'))) files.push(...sources(join(root, 'examples')));
  files.push(...BUILD_STEPS.map(path => join(root, path)).filter(path => existsSync(path)));
  // Compiler-selected declarations outside src are also build inputs.
  files.push(...parsed.fileNames);
  const entries = new Map(configs);
  for (const file of [...new Set(files.map(f => resolve(f)))].sort()) entries.set(relative(resolve(root), file), readFileSync(file, 'utf8'));
  entries.set('package.json', readFileSync(join(root, 'package.json'), 'utf8'));
  return createHash('sha256').update(JSON.stringify([...entries].sort(([a], [b]) => a.localeCompare(b)))).update(JSON.stringify(dependencyDigests(root))).digest('hex');
}
export const distDigest = (root = '.') => existsSync(join(root, 'dist')) ? treeDigest(join(root, 'dist'), p => p === '.b2-build-stamp' || p === '.b2-build-output' || p === '.b2-build.lock' || p.startsWith('.b2-build.lock/')) : 'unavailable';
export function builtMatchesSource(root = '.'): boolean {
  return existsSync(join(root, CLI)) && existsSync(join(root, STAMP)) && existsSync(join(root, OUTPUT))
    && readFileSync(join(root, STAMP), 'utf8').trim() === sourceStamp(root)
    && readFileSync(join(root, OUTPUT), 'utf8').trim() === distDigest(root);
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const lockIsStale = (path: string = LOCK, now: number = Date.now()) => { const stat = statSync(path, { throwIfNoEntry: false }); return stat !== undefined && now - stat.mtimeMs > STALE_LOCK_MS; };
export async function ensureBuilt(): Promise<{ built: boolean; stamp: string }> {
  if (process.env.B2_SKIP_BUILD === '1') return { built: false, stamp: 'skipped' };
  const stamp = sourceStamp();
  const fresh = () => builtMatchesSource();
  if (fresh()) return { built: false, stamp };
  mkdirSync('dist', { recursive: true });
  for (;;) {
    try { mkdirSync(LOCK); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (lockIsStale()) { rmSync(LOCK, { recursive: true, force: true }); continue; }
      await sleep(200);
      if (fresh()) return { built: false, stamp };
    }
  }
  const heartbeat = setInterval(() => { try { const now = new Date(); utimesSync(LOCK, now, now); } catch { /* owner removed lock */ } }, 30000);
  try {
    if (fresh()) return { built: false, stamp };
    // Remove old emitted files under the lock so deleted sources cannot leave runnable stale modules.
    for (const name of readdirSync('dist')) if (name !== '.b2-build.lock') rmSync(join('dist', name), { recursive: true, force: true });
    await execFileAsync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { maxBuffer: 64 * 1024 * 1024 });
    for (const script of BUILD_STEPS) await execFileAsync(process.execPath, [script], { maxBuffer: 64 * 1024 * 1024 });
    if (sourceStamp() !== stamp) throw new Error('build inputs changed during compilation');
    writeFileSync(OUTPUT, `${distDigest()}\n`); writeFileSync(STAMP, `${stamp}\n`);
    return { built: true, stamp };
  } finally { clearInterval(heartbeat); rmSync(LOCK, { recursive: true, force: true }); }
}
