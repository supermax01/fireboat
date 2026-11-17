// bench:install -- [--arm FB,W] [--force] [--relock]   (default: DEFAULT_ARMS in servers/arms.ts)
// W, AH and H install from hashed locks kept in bench/servers/locks/ (--relock regenerates them; network: PyPI or npm only).
// Installs each arm from a clean clone or a hash-checked artifact under SERVERS_DIR and writes
// manifests/install-<arm>.json with the exact commands, versions and digests. Network: only the pinned artifacts.
// The fireboat arms are clean clones of this repository: FB, FBd, FBt, FBh and FBdh at the commit servers/arms.ts
// resolves (HEAD of this checkout, or FB_COMMIT), FB0 at its fixed commit. An unavailable arm is skipped with a message.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { COMMON_OPTIONS } from '../lib/cli.js';
import { benchTreeDigest, listFiles, sha256File, sha256Hex } from '../lib/hash.js';
import { BENCH, CODE_BENCH, CODE_REPO, REPO, results, tmpDir } from '../lib/paths.js';
import type { ArmId } from '../lib/types.js';
import { python312, python313, uvBin } from '../lib/toolchain.js';
import { ARMS, DEFAULT_ARMS, INSTALL_DIRS, NODE_BIN_DIR, availableArms } from './arms.js';

// Toolchain through mise, version-checked (lib/toolchain.ts); resolved when an installer runs.
const PYTHON_312 = () => python312();
const PYTHON_313 = () => python313();
/** Dependency resolution for W is limited to artifacts published before this instant (reproducible re-install). */
export const W_EXCLUDE_NEWER = '2026-11-13T00:00:00Z';
const MOMENTUM_REPO = 'https://github.com/the-momentum/fhir-mcp-server';

interface Step { cmd: string; args: string[]; cwd: string; status: number | null; ms: number }

function makeRunner(label: string) {
  const tmp = tmpDir(label);
  mkdirSync(tmp, { recursive: true });
  const env: Record<string, string> = {
    PATH: [NODE_BIN_DIR, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: process.env.HOME ?? '/tmp',
    LANG: 'C.UTF-8',
    TMPDIR: tmp,
    UV_PYTHON_DOWNLOADS: 'never',
    UV_NO_CONFIG: '1',
  };
  const steps: Step[] = [];
  const run = (cmd: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}): string => {
    const t0 = Date.now();
    const r = spawnSync(cmd, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    steps.push({ cmd, args, cwd, status: r.status, ms: Date.now() - t0 });
    if (r.status !== 0) {
      process.stderr.write(r.stdout ?? '');
      process.stderr.write(r.stderr ?? '');
      throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
    }
    return r.stdout;
  };
  return { run, steps, env, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

/** sha256 over the sorted "sha256  path" listing of every regular file under dir. */
export async function treeDigest(dir: string): Promise<{ files: number; sha256: string }> {
  const lines: string[] = [];
  for (const p of listFiles(dir)) lines.push(`${await sha256File(join(dir, p))}  ${p}`);
  return { files: lines.length, sha256: sha256Hex(lines.join('\n') + '\n') };
}

/** HEAD of the checkout that holds the running harness, its dirty flag, and the digest of the bench/ tree. */
export function benchGit(): { bench_commit: string; bench_dirty: boolean; bench_tree_sha256: string; bench_tree_files: number } {
  const head = spawnSync('git', ['-C', CODE_REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const dirty = spawnSync('git', ['-C', CODE_REPO, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim().length > 0;
  return { bench_commit: head, bench_dirty: dirty, ...benchTreeDigest(CODE_BENCH) };
}

/**
 * FBd, FBt, FBh and FBdh share FB's install dir and pin: for them this verifies FB's build (cloning it if absent) and
 * records install-<arm>.json. The install dir is named after the commit, so a new HEAD gets a fresh build.
 */
async function installFireboat(arm: 'FB0' | 'FB' | 'FBd' | 'FBt' | 'FBh' | 'FBdh', force: boolean) {
  const dir = INSTALL_DIRS[arm];
  const pin = ARMS[arm].pin;
  if (!pin?.commit) throw new Error(`arm ${arm} has no commit to build`);
  if (force && arm !== 'FB0' && arm !== 'FB') throw new Error(`${arm} shares FB's install; reinstall it with --arm FB --force`);
  const r = makeRunner(`install-${arm.toLowerCase()}`);
  if (force) rmSync(dir, { recursive: true, force: true });
  if (!existsSync(join(dir, 'dist/packages/server/src/cli.js'))) {
    rmSync(dir, { recursive: true, force: true });
    // Clean clone of this repository (objects copied, no hardlinks into the checkout), detached at the commit.
    r.run('git', ['clone', '--no-local', '--no-checkout', '--quiet', REPO, dir], REPO);
    r.run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', pin.commit!], dir);
    r.run('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], dir);
    r.run('npm', ['run', 'build'], dir);
  }
  const head = r.run('git', ['rev-parse', 'HEAD'], dir).trim();
  if (head !== pin.commit) throw new Error(`${arm} HEAD ${head} != ${pin.commit}`);
  const status = r.run('git', ['status', '--porcelain', '--untracked-files=no'], dir).trim();
  if (status) throw new Error(`${arm} tracked files differ from ${pin.commit}:\n${status}`);
  const dist = await treeDigest(join(dir, 'dist'));
  const out = {
    arm, pin, install_dir: dir, git_head: head, tracked_clean: true,
    node: r.run(join(NODE_BIN_DIR, 'node'), ['--version'], dir).trim(),
    npm: r.run('npm', ['--version'], dir).trim(),
    package_lock_sha256: await sha256File(join(dir, 'package-lock.json')),
    dist_sha256: dist.sha256, dist_files: dist.files,
    entry: join(dir, 'dist/packages/server/src/cli.js'),
    steps: r.steps,
  };
  r.cleanup();
  return out;
}

/** Hashed requirements for W (uv pip compile --generate-hashes), kept in bench/ and installed with --require-hashes. */
export const W_LOCK = join(BENCH, 'servers/locks/wso2-0.11.0.requirements.txt');
/** H's package.json and package-lock.json, kept in bench/ and installed with npm ci (every transitive package by integrity). */
export const H_LOCK_DIR = join(BENCH, 'servers/locks/fhirhydrant-0.17.3');

async function installW(force: boolean, relock: boolean) {
  const dir = INSTALL_DIRS.W;
  const pin = ARMS.W.pin!;
  const r = makeRunner('install-w');
  const UV = uvBin();
  const wheelName = 'fhir_mcp_server-0.11.0-py3-none-any.whl';
  const wheel = join(dir, wheelName);
  if (force) rmSync(dir, { recursive: true, force: true });
  if (!existsSync(wheel)) {
    mkdirSync(dir, { recursive: true });
    const meta = await (await fetch('https://pypi.org/pypi/fhir-mcp-server/0.11.0/json')).json() as {
      urls: { filename: string; url: string; digests: { sha256: string } }[];
    };
    const entry = meta.urls.find(u => u.filename === wheelName);
    if (!entry || entry.digests.sha256 !== pin.artifactSha256) throw new Error('W: PyPI wheel metadata does not match the pin');
    writeFileSync(wheel, Buffer.from(await (await fetch(entry.url)).arrayBuffer()));
  }
  const wheelSha = await sha256File(wheel);
  if (wheelSha !== pin.artifactSha256) throw new Error(`W wheel sha256 ${wheelSha} != pin`);
  if (relock || !existsSync(W_LOCK)) {
    // Resolution limited to artifacts published before W_EXCLUDE_NEWER; every artifact pinned by sha256.
    const input = join(r.env.TMPDIR!, 'requirements.in');
    writeFileSync(input, `fhir-mcp-server==${pin.version}\n`);
    mkdirSync(join(BENCH, 'servers/locks'), { recursive: true });
    r.run(UV, ['pip', 'compile', '--quiet', '--generate-hashes', '--no-header', '--no-annotate', '--exclude-newer', W_EXCLUDE_NEWER,
      '--python', PYTHON_312(), '--output-file', W_LOCK, input], dir);
  }
  const lockText = readFileSync(W_LOCK, 'utf8');
  if (!lockText.includes(`fhir-mcp-server==${pin.version}`) || !lockText.includes(`--hash=sha256:${pin.artifactSha256}`)) {
    throw new Error('W: hashed lock does not pin fhir-mcp-server to the pinned wheel sha256');
  }
  const py = join(dir, 'venv/bin/python');
  const lockSha = await sha256File(W_LOCK);
  const stamp = join(dir, 'installed-from-lock.sha256');
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== lockSha) {
    rmSync(join(dir, 'venv'), { recursive: true, force: true });
    r.run(UV, ['venv', '--quiet', '--python', PYTHON_312(), join(dir, 'venv')], dir);
    // --require-hashes: every artifact, the pinned wheel included, must match the lock (from PyPI or the local wheel).
    r.run(UV, ['pip', 'install', '--quiet', '--require-hashes', '--no-deps', '--python', py, '--find-links', dir, '-r', W_LOCK], dir);
    writeFileSync(join(dir, 'requirements.lock.txt'), r.run(UV, ['pip', 'freeze', '--python', py], dir));
    writeFileSync(stamp, lockSha + '\n');
  }
  const out = {
    arm: 'W', pin, install_dir: dir, wheel, wheel_sha256: wheelSha, exclude_newer: W_EXCLUDE_NEWER,
    lock: W_LOCK, lock_sha256: lockSha, install_rule: 'uv pip install --require-hashes --no-deps -r <lock>',
    python: r.run(py, ['--version'], dir).trim(), uv: r.run(UV, ['--version'], dir).trim(),
    freeze: readFileSync(join(dir, 'requirements.lock.txt'), 'utf8').trim().split('\n'),
    steps: r.steps,
  };
  r.cleanup();
  return out;
}

/** Hashed requirements for AH (uv pip compile --generate-hashes), kept in bench/ and installed with --require-hashes. */
export const AH_LOCK = join(BENCH, 'servers/locks/healthlake-mcp-0.0.21.requirements.txt');
/** AH's dependency resolution is limited to artifacts published before this instant (0.0.21 was uploaded 2026-11-09). */
export const AH_EXCLUDE_NEWER = '2026-11-14T00:00:00Z';
/**
 * The versions the server's own uv.lock pins at its release commit, used as constraints. The wheel declares only lower
 * bounds (mcp>=1.23.0) and 0.0.21 does not start with mcp 2.x ('Server' object has no attribute 'list_tools').
 */
export const AH_CONSTRAINTS = join(BENCH, 'servers/locks/healthlake-mcp-0.0.21.constraints.txt');
const AH_UPSTREAM_LOCK_URL = 'https://raw.githubusercontent.com/awslabs/mcp/6a2cd75824426dff2d798e252f07c59ae7890b12/src/healthlake-mcp-server/uv.lock';

/** Evaluates a uv.lock resolution marker for the bench's AH runtime (CPython 3.12 on macOS); only the forms uv.lock uses here. */
export function markerHolds(marker: string, env = { python: [3, 12], platform: 'darwin' }): boolean {
  return marker.split(' and ').every(term => {
    const py = /^python_full_version (<|>=|<=|>|==) '(\d+)\.(\d+)(?:\.\d+)?'$/.exec(term.trim());
    if (py) {
      const cmp = (env.python[0]! - Number(py[2])) || (env.python[1]! - Number(py[3]));
      return { '<': cmp < 0, '>=': cmp >= 0, '<=': cmp <= 0, '>': cmp > 0, '==': cmp === 0 }[py[1] as '<'];
    }
    const pl = /^sys_platform (==|!=) '([a-z0-9]+)'$/.exec(term.trim());
    if (pl) return pl[1] === '==' ? env.platform === pl[2] : env.platform !== pl[2];
    throw new Error(`unsupported uv.lock marker term: ${term}`);
  });
}

/**
 * name==version for every registry package of a uv.lock that applies to the bench's AH runtime: a package with
 * resolution markers counts only when one of them holds. The project itself is editable and skipped. Each name must
 * end up with exactly one version.
 */
export function uvLockConstraints(lock: string): string[] {
  const byName = new Map<string, string[]>();
  for (const block of lock.split(/\n\[\[package\]\]\n/).slice(1)) {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/m.exec(block)?.[1];
    if (!name || !version || !/^source = \{ registry = "https:\/\/pypi\.org\/simple" \}$/m.test(block)) continue;
    const markers = /^resolution-markers = \[\n([\s\S]*?)\n\]$/m.exec(block)?.[1];
    if (markers && ![...markers.matchAll(/"([^"]+)"/g)].some(m => markerHolds(m[1]!))) continue;
    byName.set(name, [...(byName.get(name) ?? []), version]);
  }
  for (const [n, v] of byName) if (v.length !== 1) throw new Error(`uv.lock: ${n} has ${v.length} applicable versions`);
  return [...byName].map(([n, v]) => `${n}==${v[0]}`).sort();
}

async function installAH(force: boolean, relock: boolean) {
  const dir = INSTALL_DIRS.AH;
  const pin = ARMS.AH.pin!;
  const r = makeRunner('install-ah');
  const UV = uvBin();
  if (force) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const meta = existsSync(join(dir, 'pypi.json')) ? null : await (await fetch(`https://pypi.org/pypi/awslabs.healthlake-mcp-server/${pin.version}/json`)).json() as {
    urls: { filename: string; url: string; packagetype: string; digests: { sha256: string } }[];
  };
  if (meta) writeFileSync(join(dir, 'pypi.json'), JSON.stringify(meta, null, 2) + '\n');
  const listed = (meta ?? JSON.parse(readFileSync(join(dir, 'pypi.json'), 'utf8')) as NonNullable<typeof meta>).urls.find(u => u.packagetype === 'bdist_wheel');
  if (!listed || listed.digests.sha256 !== pin.artifactSha256) throw new Error('AH: PyPI wheel metadata does not match the pin');
  const wheel = join(dir, listed.filename);
  if (!existsSync(wheel)) writeFileSync(wheel, Buffer.from(await (await fetch(listed.url)).arrayBuffer()));
  const wheelSha = await sha256File(wheel);
  if (wheelSha !== pin.artifactSha256) throw new Error(`AH wheel sha256 ${wheelSha} != pin`);
  if (relock || !existsSync(AH_CONSTRAINTS)) {
    const upstream = await (await fetch(AH_UPSTREAM_LOCK_URL)).text();
    const c = uvLockConstraints(upstream);
    if (!c.some(l => l.startsWith('mcp=='))) throw new Error('AH: upstream uv.lock has no mcp pin');
    mkdirSync(join(BENCH, 'servers/locks'), { recursive: true });
    writeFileSync(AH_CONSTRAINTS, `# From ${AH_UPSTREAM_LOCK_URL} (sha256 ${sha256Hex(upstream)})\n${c.join('\n')}\n`);
  }
  if (relock || !existsSync(AH_LOCK)) {
    const input = join(r.env.TMPDIR!, 'requirements.in');
    writeFileSync(input, `awslabs.healthlake-mcp-server==${pin.version}\n`);
    r.run(UV, ['pip', 'compile', '--quiet', '--generate-hashes', '--no-header', '--no-annotate', '--exclude-newer', AH_EXCLUDE_NEWER,
      '--constraint', AH_CONSTRAINTS, '--python', PYTHON_312(), '--output-file', AH_LOCK, input], dir);
  }
  const lockText = readFileSync(AH_LOCK, 'utf8');
  if (!/^awslabs[.-]healthlake-mcp-server==0\.0\.21\b/m.test(lockText) || !lockText.includes(`--hash=sha256:${pin.artifactSha256}`)) {
    throw new Error('AH: hashed lock does not pin awslabs.healthlake-mcp-server to the pinned wheel sha256');
  }
  const py = join(dir, 'venv/bin/python');
  const lockSha = await sha256File(AH_LOCK);
  const stamp = join(dir, 'installed-from-lock.sha256');
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== lockSha || !existsSync(join(dir, 'venv/bin/awslabs.healthlake-mcp-server'))) {
    rmSync(join(dir, 'venv'), { recursive: true, force: true });
    r.run(UV, ['venv', '--quiet', '--python', PYTHON_312(), join(dir, 'venv')], dir);
    r.run(UV, ['pip', 'install', '--quiet', '--require-hashes', '--no-deps', '--python', py, '--find-links', dir, '-r', AH_LOCK], dir);
    writeFileSync(join(dir, 'requirements.lock.txt'), r.run(UV, ['pip', 'freeze', '--python', py], dir));
    writeFileSync(stamp, lockSha + '\n');
  }
  const out = {
    arm: 'AH', pin, install_dir: dir, wheel, wheel_sha256: wheelSha, exclude_newer: AH_EXCLUDE_NEWER,
    lock: AH_LOCK, lock_sha256: lockSha, constraints: AH_CONSTRAINTS, constraints_sha256: await sha256File(AH_CONSTRAINTS), install_rule: 'uv pip install --require-hashes --no-deps -r <lock>', launch: 'awslabs.healthlake-mcp-server --readonly',
    python: r.run(py, ['--version'], dir).trim(), uv: r.run(UV, ['--version'], dir).trim(),
    freeze: readFileSync(join(dir, 'requirements.lock.txt'), 'utf8').trim().split('\n'),
    steps: r.steps,
  };
  r.cleanup();
  return out;
}

async function installM(force: boolean, _relock: boolean) {
  const UV = uvBin();
  const dir = INSTALL_DIRS.M;
  const pin = ARMS.M.pin!;
  const r = makeRunner('install-m');
  if (force) rmSync(dir, { recursive: true, force: true });
  if (!existsSync(join(dir, '.git'))) {
    r.run('git', ['clone', '--quiet', '--no-checkout', MOMENTUM_REPO, dir], REPO);
    r.run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', pin.commit!], dir);
  }
  const head = r.run('git', ['rev-parse', 'HEAD'], dir).trim();
  if (head !== pin.commit) throw new Error(`M HEAD ${head} != pin ${pin.commit}`);
  const tag = r.run('git', ['rev-parse', '0.1.0^{commit}'], dir).trim();
  if (!existsSync(join(dir, '.venv/bin/fastmcp'))) {
    // Never `make uv` (it downloads an embedding model). No dev dependencies.
    r.run(UV, ['sync', '--quiet', '--frozen', '--no-dev', '--python', PYTHON_313()], dir);
  }
  mkdirSync(INSTALL_DIRS.momentumHfHome, { recursive: true }); // fixed, empty: the RAG model is never fetched
  const status = r.run('git', ['status', '--porcelain', '--untracked-files=no'], dir).trim();
  if (status) throw new Error(`M tracked files differ from the pin:\n${status}`);
  const out = {
    arm: 'M', pin, install_dir: dir, git_head: head, tag_0_1_0: tag, tracked_clean: true,
    uv_lock_sha256: await sha256File(join(dir, 'uv.lock')),
    python: r.run(join(dir, '.venv/bin/python'), ['--version'], dir).trim(), uv: r.run(UV, ['--version'], dir).trim(),
    freeze: r.run(UV, ['pip', 'freeze', '--python', join(dir, '.venv/bin/python')], dir).trim().split('\n'),
    hf_home: INSTALL_DIRS.momentumHfHome, hf_home_files: readdirSync(INSTALL_DIRS.momentumHfHome).length,
    steps: r.steps,
  };
  r.cleanup();
  return out;
}

async function installH(force: boolean, relock: boolean) {
  const dir = INSTALL_DIRS.H;
  const pin = ARMS.H.pin!;
  const r = makeRunner('install-h');
  if (relock || !existsSync(join(H_LOCK_DIR, 'package-lock.json'))) {
    const tmp = join(r.env.TMPDIR!, 'relock-h');
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'package.json'), '{"private":true}\n');
    r.run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `fhirhydrant@${pin.version}`], tmp);
    mkdirSync(H_LOCK_DIR, { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) writeFileSync(join(H_LOCK_DIR, f), readFileSync(join(tmp, f)));
  }
  const lockSha = await sha256File(join(H_LOCK_DIR, 'package-lock.json'));
  const lock = JSON.parse(readFileSync(join(H_LOCK_DIR, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version?: string; integrity?: string; resolved?: string }>;
  };
  const entry = lock.packages['node_modules/fhirhydrant'];
  if (entry?.version !== pin.version || entry.integrity !== pin.npmIntegrity) throw new Error('H: lockfile integrity does not match the pin');
  const missing = Object.entries(lock.packages).filter(([k, v]) => k !== '' && !v.integrity).map(([k]) => k);
  if (missing.length) throw new Error(`H: lock entries without integrity: ${missing.slice(0, 5).join(', ')}`);
  if (force) rmSync(dir, { recursive: true, force: true });
  const stamp = join(dir, 'installed-from-lock.sha256');
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== lockSha || !existsSync(join(dir, 'node_modules/fhirhydrant/bin/server.js'))) {
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) writeFileSync(join(dir, f), readFileSync(join(H_LOCK_DIR, f)));
    // npm ci installs exactly the lock and checks every package's integrity; no install scripts run.
    r.run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
    writeFileSync(stamp, lockSha + '\n');
  }
  const installedSha = await sha256File(join(dir, 'package-lock.json'));
  if (installedSha !== lockSha) throw new Error(`H: installed package-lock.json ${installedSha} != bench lock ${lockSha}`);
  const out = {
    arm: 'H', pin, install_dir: dir, lock_version: entry.version, lock_integrity: entry.integrity,
    lock: join(H_LOCK_DIR, 'package-lock.json'), package_lock_sha256: lockSha, lock_packages: Object.keys(lock.packages).length - 1,
    install_rule: 'npm ci --ignore-scripts (bench lock copied into the install dir)',
    node: r.run(join(NODE_BIN_DIR, 'node'), ['--version'], dir).trim(), npm: r.run('npm', ['--version'], dir).trim(),
    steps: r.steps,
  };
  r.cleanup();
  return out;
}

const INSTALLERS: Partial<Record<ArmId, (force: boolean, relock: boolean) => Promise<Record<string, unknown>>>> = {
  FB0: force => installFireboat('FB0', force), FB: force => installFireboat('FB', force),
  FBd: force => installFireboat('FBd', force), FBt: force => installFireboat('FBt', force), W: installW, M: installM, H: installH,
  FBh: force => installFireboat('FBh', force), FBdh: force => installFireboat('FBdh', force), AH: installAH,
};

async function main() {
  const { values } = parseArgs({ options: { ...COMMON_OPTIONS, relock: { type: 'boolean' } }, strict: true });
  const arms = availableArms((values.arm ?? DEFAULT_ARMS.join(',')).split(',') as ArmId[]);
  mkdirSync(results.manifests, { recursive: true });
  let failed = false;
  for (const arm of arms) {
    const installer = INSTALLERS[arm];
    if (!installer) throw new Error(`no installer for arm ${arm}`);
    const started = new Date().toISOString();
    try {
      const out = await installer(values.force === true, values.relock === true);
      const manifest = { schema: 'fbbench.manifest.install/1', ...out, argv: process.argv.slice(2), started_at: started, finished_at: new Date().toISOString(), ...benchGit() };
      writeFileSync(join(results.manifests, `install-${arm}.json`), JSON.stringify(manifest, null, 2) + '\n');
      process.stdout.write(`install ${arm}: ok\n`);
    } catch (e) {
      failed = true;
      process.stderr.write(`install ${arm}: FAILED: ${(e as Error).message}\n`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) await main();
