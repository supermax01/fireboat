#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { inspectNpmPack, inspectTar, validateExpectedInventory, verifyPackInventory, type ExpectedInventory, type TarFile } from './package-inventory.js';
import { canonicalDependencyTree, dependencyTreeHash, type TreeContext } from './package-tree.js';
import { assertProductionLock, ROOT, sha256, snapshotInputs, StageFault, verifyStagedDirectory } from './stage-package.js';

const fault = (code: string): StageFault => new StageFault(code);
const json = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8'));
const sorted = (rows: readonly string[]): string[] => [...rows].sort();
function membership(actual: readonly { path: string }[], expected: ExpectedInventory): void {
  const found = new Set(actual.map(f => f.path)), wanted = new Set(expected.files.map(f => f.path));
  if ([...found].some(p => !wanted.has(p))) throw fault('PACK_UNEXPECTED');
  if ([...wanted].some(p => !found.has(p))) throw fault('PACK_MISSING');
}

/** Both independently validated inventories and all approved bodies precede directory creation. */
export function verifyPackageBytes(expectedInput: unknown, npmPack: unknown, tar: Buffer): { files: readonly TarFile[]; inventorySha256: string; tarSha256: string } {
  const expected = validateExpectedInventory(expectedInput);
  const npmFiles = inspectNpmPack(npmPack, expected.identity), files = inspectTar(tar);
  membership(npmFiles, expected); membership(files, expected);
  const result = verifyPackInventory({ expected, npmPack, tar });
  const pack = (npmPack as any[])[0];
  if (pack.shasum !== createHash('sha1').update(tar).digest('hex') ||
    pack.integrity !== `sha512-${createHash('sha512').update(tar).digest('base64')}` ||
    pack.size !== tar.byteLength || pack.unpackedSize !== files.reduce((total, f) => total + f.size, 0) ||
    pack.entryCount !== files.length || pack.bundled?.length !== 0) throw fault('PACK_DIGEST_MISMATCH');
  const paths = new Set(files.map(f => f.path));
  for (const path of paths) {
    let parent = dirname(path);
    while (parent !== '.') { if (paths.has(parent)) throw fault('TAR_ENTRY_UNSAFE'); parent = dirname(parent); }
  }
  return { files, inventorySha256: result.sha256, tarSha256: sha256(tar) };
}

export async function verifyPackage(input: { tar: string; packJson: string; expected?: string; stage?: string; extract?: string; root?: string }) {
  const root = resolve(input.root ?? ROOT), expected = validateExpectedInventory(await json(input.expected ?? join(root, 'packaging/npm-files.json')));
  const tar = await readFile(input.tar), pack = await json(input.packJson);
  const result = verifyPackageBytes(expected, pack, tar);
  if (input.stage) {
    const receipt = await json(`${input.stage}.stage.json`);
    if (receipt.schema !== 1 || receipt.root !== root || receipt.inventorySha256 !== result.inventorySha256 ||
      !isDeepStrictEqual(receipt.inputs, await snapshotInputs(root))) throw fault('STAGE_INPUT_CHANGED');
    await verifyStagedDirectory(input.stage, expected);
  }
  if (input.extract) {
    if (!isAbsolute(input.extract)) throw fault('EXTRACT_DESTINATION');
    await mkdir(input.extract, { mode: 0o700 });
    try {
      for (const file of result.files) {
        const path = join(input.extract, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.body, { flag: 'wx', mode: file.mode }); await chmod(path, file.mode);
      }
      await verifyStagedDirectory(input.extract, expected);
    } catch (error) { await rm(input.extract, { recursive: true, force: true }); throw error; }
  }
  return { files: result.files.map(({ body: _body, ...file }) => file), inventorySha256: result.inventorySha256, tarSha256: result.tarSha256 };
}

/** Read the operator's tar exactly once into a new private file; every later step uses this snapshot, never the operator path. */
export async function snapshotTar(source: string, destination: string): Promise<Buffer> {
  const bytes = await readFile(source);
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 }); await chmod(destination, 0o600);
  if (!(await readFile(destination)).equals(bytes)) throw fault('TAR_SNAPSHOT_CHANGED');
  return bytes;
}

/**
 * The installed gateway package is exactly the verified inventory (paths, modes, sizes, hashes; no extra or linked
 * entries), and npm's hidden lock records the verified tar's SHA-512 as that package's install integrity.
 */
export async function verifyInstalledGateway(installation: string, expectedInput: unknown, tar: Uint8Array): Promise<void> {
  const expected = validateExpectedInventory(expectedInput), install = await realpath(installation);
  await verifyStagedDirectory(join(install, 'node_modules', expected.identity.name), expected);
  const hidden = await json(join(install, 'node_modules/.package-lock.json'));
  const row = hidden?.packages?.[`node_modules/${expected.identity.name}`];
  const integrity = `sha512-${createHash('sha512').update(tar).digest('base64')}`;
  if (!row || row.version !== expected.identity.version || row.integrity !== integrity || row.link || row.dev) throw fault('INSTALLED_TAR_MISMATCH');
}

/** The expected graph comes from the approved actual-resolution lock, with no development/optional selection. */
export function lockTree(lock: any): any {
  const entries = lock.packages;
  const node = (name: string, entry: any, active: ReadonlySet<string>): any => {
    if (!entry || active.has(name)) throw fault('TREE_INVALID');
    return { name, version: entry.version, ...(name === lock.name ? {} : { integrity: entry.integrity }), dependencies:
      Object.fromEntries(Object.keys(entry.dependencies ?? {}).sort().map(dep => [dep, node(dep, entries[`node_modules/${dep}`], new Set([...active, name]))])) };
  };
  return node(lock.name, entries[''], new Set());
}

/** npm's installed hidden lock supplies observed install SRI; it is never filled from the approved lock. */
export async function verifyInstalledTree(installation: string, npmLs: any, component: 'gateway' | 'quickstart', root = ROOT): Promise<{ sha256: string; canonical: unknown }> {
  const lock = await json(join(root, component === 'gateway' ? 'packaging/npm-shrinkwrap.json' : 'examples/quickstart/package-lock.json'));
  if (component === 'gateway') assertProductionLock(lock);
  const install = await realpath(installation), hidden = await json(join(install, 'node_modules/.package-lock.json'));
  const observed = component === 'gateway' ? npmLs.dependencies?.[lock.name] : npmLs;
  const packageRoot = component === 'gateway' ? join(install, 'node_modules', lock.name) : install;
  if (!observed || observed.name !== undefined && observed.name !== lock.name || npmLs.problems?.length) throw fault('TREE_PROBLEM');
  const installedRows = Object.keys(hidden.packages ?? {}).sort();
  const wantedRows = [...Object.keys(lock.packages).filter(p => p !== ''), ...(component === 'gateway' ? [`node_modules/${lock.name}`] : [])].sort();
  if (!isDeepStrictEqual(installedRows, wantedRows)) throw fault('TREE_PROBLEM');
  const resolveDependency = async (parent: string, name: string): Promise<string> => {
    for (let directory = parent; directory === install || directory.startsWith(`${install}${sep}`); directory = dirname(directory)) {
      const candidate = join(directory, 'node_modules', name);
      try {
        const info = await lstat(candidate);
        if (!info.isDirectory() || info.isSymbolicLink()) throw fault('TREE_PROBLEM');
        return candidate;
      } catch (error) { if (error instanceof StageFault) throw error; }
    }
    throw fault('TREE_PROBLEM');
  };
  const enrich = async (tree: any, path: string, name: string, active: ReadonlySet<string>): Promise<any> => {
    if (!tree || active.has(path) || ['missing', 'extraneous', 'invalid', 'link', 'dev', 'error'].some(k => tree[k]) || tree.problems?.length) throw fault('TREE_PROBLEM');
    const pkg = await json(join(path, 'package.json'));
    const locked = name === lock.name ? lock.packages[''] : lock.packages[`node_modules/${name}`];
    if (!locked || pkg.name !== name || pkg.version !== tree.version || pkg.version !== locked.version ||
      !isDeepStrictEqual(pkg.dependencies ?? {}, locked.dependencies ?? {}) || pkg.devDependencies && name === lock.name && component === 'gateway') throw fault('TREE_MISMATCH');
    if (!isDeepStrictEqual(sorted(Object.keys(tree.dependencies ?? {})), sorted(Object.keys(pkg.dependencies ?? {})))) throw fault('TREE_MISMATCH');
    const dependencies: Record<string, any> = {};
    for (const dep of Object.keys(pkg.dependencies ?? {}).sort()) dependencies[dep] = await enrich(tree.dependencies[dep], await resolveDependency(path, dep), dep, new Set([...active, path]));
    let integrity: string | undefined;
    if (name !== lock.name) {
      const row = hidden.packages[relative(install, path).split(sep).join('/')];
      if (!row || row.version !== pkg.version || row.integrity !== locked.integrity || row.dev || row.link || row.optional) throw fault('TREE_INTEGRITY_MISSING');
      integrity = row.integrity;
    }
    return { ...tree, name, dependencies, ...(integrity ? { integrity } : {}) };
  };
  const tree = await enrich(observed, packageRoot, lock.name, new Set());
  const context: TreeContext = { platform: { os: process.platform, arch: process.arch }, optional: [] };
  const canonical = canonicalDependencyTree(tree, context), approved = canonicalDependencyTree(lockTree(lock), context);
  if (!isDeepStrictEqual(canonical, approved)) throw fault('TREE_MISMATCH');
  return { sha256: dependencyTreeHash(tree, context), canonical };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), flags: Record<string, string> = {};
    if (args[0] && !args[0].startsWith('--')) flags['--tar'] = args.shift()!;
    while (args.length) {
      const key = args.shift()!, value = args.shift();
      if (!['--tar', '--pack-json', '--expected', '--stage', '--extract', '--installed', '--tree-json', '--component'].includes(key) || !value || flags[key]) throw fault('VERIFY_USAGE');
      flags[key] = value;
    }
    if (flags['--installed']) {
      if (!flags['--tree-json'] || !['gateway', 'quickstart'].includes(flags['--component'] ?? '')) throw fault('VERIFY_USAGE');
      const result = await verifyInstalledTree(flags['--installed'], await json(flags['--tree-json']), flags['--component'] as 'gateway' | 'quickstart');
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (!flags['--tar']) throw fault('VERIFY_USAGE');
      const result = await verifyPackage({ tar: flags['--tar'], packJson: flags['--pack-json'] ?? `${flags['--tar']}.pack.json`,
        expected: flags['--expected'], stage: flags['--stage'], extract: flags['--extract'] });
      console.log(`verify-package: files=${result.files.length} inventory=${result.inventorySha256} tar=${result.tarSha256}`);
    }
  } catch (error) { console.error(`verify-package: ${error instanceof StageFault ? error.code : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'VERIFY_FAILED'}`); process.exitCode = 1; }
}
