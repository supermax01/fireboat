#!/usr/bin/env node
// Release staging has no install, fetch, lifecycle, or serving operation.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { API } from 'typescript/unstable/sync';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { SyntaxKind, type Node, type StringLiteral, type ImportDeclaration, type ExportDeclaration, type CallExpression } from 'typescript/unstable/ast';
import { safePackagePath, validateExpectedInventory, type ExpectedInventory, type FileInventory } from './package-inventory.js';
import { helperBoundary, HELPER_ENTRIES } from './quickstart/check-helper-boundary.js';
import { observedGraph } from './quickstart/module-graph.js';

export class StageFault extends Error {
  constructor(readonly code: string) { super(code); this.name = 'StageFault'; }
}
const fault = (code: string): StageFault => new StageFault(code);
export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8'));
const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const ROOT = fileURLToPath(new URL('../', import.meta.url));

export const GATEWAY_MODULES = [
  'packages/auth/src/client-credentials.js',
  ...['catalog', 'contracts', 'decimal', 'delivery', 'discovery', 'identity', 'index', 'privacy', 'projection',
    'query', 'repairs', 'schema', 'search-parameters', 'store', 'support', 'transport', 'withheld'].map(n => `packages/core/src/${n}.js`),
  ...['cli', 'doctor', 'index', 'main', 'release', 'startup'].map(n => `packages/server/src/${n}.js`),
].sort(order);
export const RUNTIME_FILES = [
  'packages/core/src/generated/r4-index.json', 'packages/core/src/generated/r4-search-parameters.json',
  ...['support-matrix', 'search-profiles', 'compact-profiles', 'host-profiles'].map(n => `packages/core/src/data/${n}.json`),
].sort(order);
export const DOCUMENTS = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md',
  'docs/QUICKSTART.md', 'docs/LIMITS.md', 'docs/IMPLEMENTATION.md', 'docs/SUPPORT-MATRIX.md', 'docs/support-matrix.json',
  'docs/COMPACT-PROFILES.md', 'docs/HOST-PROFILES.md', 'docs/QUERY-EVIDENCE.md', 'docs/QUERY-REPAIR.md', 'docs/contracts/m3b-tools.json'];
export const HELPER_ASSETS = [
  'compose.quickstart.yaml', 'examples/quickstart/seed-manifest.json', 'examples/quickstart/generator-pins.json',
  'examples/quickstart/backend-evidence.json', 'examples/quickstart/config.json', 'examples/quickstart/host-config.example.json',
  'packages/evals/fixtures/quickstart/resources.ndjson', 'packages/evals/fixtures/quickstart/seed-manifest.json',
  'packages/evals/fixtures/quickstart/generation.properties', 'packages/evals/fixtures/quickstart/edges.json',
];

/** Only the helper's narrow pure shared modules/seed live under an eval path. No gateway eval module is admitted. */
export function allowedProductionFile(path: string): boolean {
  if (!safePackagePath(path)) return false;
  if (path.startsWith('dist/')) return path === 'dist/package.json' ||
    GATEWAY_MODULES.some(p => path === `dist/${p}`) || RUNTIME_FILES.some(p => path === `dist/${p}`) ||
    path === 'dist/packages/server/src/generated/release.json';
  if (path.startsWith('quickstart/dist/')) return /^quickstart\/dist\/examples\/quickstart\/[a-z-]+\.(?:js|json)$/.test(path) ||
    ['decimal', 'check-contracts', 'evidence-oracle', 'package-tasks'].some(n => path === `quickstart/dist/packages/${n === 'decimal' ? 'core' : 'evals'}/src/${n}.js`);
  if (path.startsWith('quickstart/')) return ['package.json', 'package-lock.json', 'fireboat-timing.mjs', ...HELPER_ASSETS].some(p => path === `quickstart/${p}`);
  return ['package.json', 'npm-shrinkwrap.json', ...DOCUMENTS].includes(path) || /^licenses\/[A-Za-z0-9_./-]+$/.test(path);
}
export function assertProductionFile(path: string): void {
  if (!allowedProductionFile(path)) throw fault('STAGE_FORBIDDEN');
}

/** The approved gateway closure is flat and has three packages. Reject every dev/client/tooling/optional edge. */
export function productionOnlyLock(lock: any): boolean {
  if (!lock || lock.lockfileVersion !== 3 || !lock.packages || lock.name !== '@fireboat/gateway' || typeof lock.version !== 'string') return false;
  if (!isDeepStrictEqual(Object.keys(lock).sort(), ['name', 'version', 'lockfileVersion', 'requires', 'packages'].sort()) || lock.requires !== true) return false;
  const dependencies = { '@modelcontextprotocol/server': '2.3.1', zod: '4.6.7' };
  const expected = ['node_modules/@modelcontextprotocol/core', 'node_modules/@modelcontextprotocol/server', 'node_modules/zod'];
  if (!isDeepStrictEqual(Object.keys(lock.packages).sort(), ['', ...expected].sort()) || !isDeepStrictEqual(lock.packages[''].dependencies, dependencies)) return false;
  const pins: Record<string, string> = { '@modelcontextprotocol/core': '2.3.1', ...dependencies };
  for (const [path, entry] of Object.entries(lock.packages) as [string, any][]) {
    if (!entry || ['dev', 'devOptional', 'link', 'optional', 'hasInstallScript', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(k => Object.hasOwn(entry, k))) return false;
    if (!path) { if (entry.name !== lock.name || entry.version !== lock.version) return false; continue; }
    const name = path.slice('node_modules/'.length);
    if (entry.version !== pins[name] || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? '') ||
      entry.resolved !== `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${entry.version}.tgz`) return false;
    const edges = name === '@modelcontextprotocol/server' ? { '@modelcontextprotocol/core': '2.3.1', zod: '^4.2.0' } : name === '@modelcontextprotocol/core' ? { zod: '^4.2.0' } : undefined;
    if (!isDeepStrictEqual(entry.dependencies, edges)) return false;
  }
  return true;
}
export function assertProductionLock(lock: unknown): void {
  if (!productionOnlyLock(lock)) throw fault('LOCK_NOT_PRODUCTION');
}

// Parse compiled code rather than scanning FHIR interaction-name metadata for words such as "update".
// These are reviewed source-form boundaries, not a proof against arbitrary JavaScript obfuscation.
function parse<T>(code: string, inspect: (source: Node) => T): T {
  const config = '/stage/tsconfig.json', file = '/stage/code.js';
  const files: Record<string, string> = { [config]: JSON.stringify({ compilerOptions: { allowJs: true, noLib: true, noResolve: true, types: [], module: 'esnext', target: 'esnext' }, files: ['code.js'] }), [file]: code };
  const fs = createVirtualFileSystem(files); fs.readFile = p => files[p] ?? null;
  const api = new API({ fs });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const program = snapshot.getProject(config)?.program, source = program?.getSourceFile(file);
      if (!source || program!.getSyntacticDiagnostics(file).length) throw fault('SERVING_BOUNDARY');
      return inspect(source);
    } finally { snapshot.dispose(); }
  } finally { api.close(); }
}
const walk = (node: Node, visit: (node: Node) => void): void => { visit(node); node.forEachChild(n => walk(n, visit)); };
const textOf = (node: Node): string => node.getText().replace(/\s+/g, ' ').trim();
export function forbiddenServingLoad(code: string, bootstrap: boolean): boolean {
  return parse(code, source => {
    let forbidden = false;
    const names = new Set(['getBuiltinModule', 'createRequire', 'require', 'eval', 'Function', 'dlopen']);
    walk(source, n => {
      if ((n.kind === SyntaxKind.Identifier || n.kind === SyntaxKind.StringLiteral) && names.has((n as StringLiteral).text)) forbidden = true;
      if (n.kind === SyntaxKind.ImportDeclaration && ['node:module', 'node:vm', 'node:worker_threads'].includes(((n as ImportDeclaration).moduleSpecifier as StringLiteral).text)) forbidden = true;
      if (n.kind === SyntaxKind.CallExpression) {
        const call = n as CallExpression;
        if (call.expression.kind === SyntaxKind.ImportKeyword && (!bootstrap || textOf(n) !== "import('./main.js')")) forbidden = true;
        // FHIR's schema/snapshot .binding fields are data; process.binding is a loader.
        if (/(?:^|\.)binding$/.test(textOf(call.expression)) || /\[['"]binding['"]\]$/.test(textOf(call.expression))) forbidden = true;
      }
    });
    return forbidden;
  });
}
export function moduleImports(code: string): string[] {
  return parse(code, source => {
    const imports: string[] = [];
    walk(source, n => {
      let specifier: Node | undefined;
      if (n.kind === SyntaxKind.ImportDeclaration || n.kind === SyntaxKind.ExportDeclaration) specifier = (n as ImportDeclaration | ExportDeclaration).moduleSpecifier;
      if (n.kind === SyntaxKind.CallExpression && (n as CallExpression).expression.kind === SyntaxKind.ImportKeyword) specifier = (n as CallExpression).arguments[0];
      if (specifier) {
        if (specifier.kind !== SyntaxKind.StringLiteral) throw fault('SERVING_BOUNDARY');
        imports.push((specifier as StringLiteral).text);
      }
    });
    return imports;
  });
}

/** Every use of the transport primitives, every HTTP import, and every method property is pinned at its actual syntax site. */
export function httpDispatchSites(code: string): string[] {
  return parse(code, source => {
    const sites: string[] = [];
    const names = new Set(['httpRequest', 'httpsRequest', 'controlledFetch', 'fetchFn', 'send', 'listedPut', 'fetch', 'XMLHttpRequest', 'WebSocket']);
    walk(source, n => {
      if ((n.kind === SyntaxKind.Identifier || n.kind === SyntaxKind.StringLiteral) && names.has((n as StringLiteral).text)) {
        const parent = n.parent;
        sites.push(textOf(parent.kind === SyntaxKind.PropertyAccessExpression && parent.parent.kind === SyntaxKind.CallExpression ? parent.parent : parent));
      }
      if ([SyntaxKind.PropertyAssignment, SyntaxKind.ShorthandPropertyAssignment].includes(n.kind) &&
        /^(?:['"]?method['"]?)$/.test(textOf((n as any).name))) sites.push(textOf(n));
      if (n.kind === SyntaxKind.ImportDeclaration && /^node:(?:https?|http2|net|tls|dgram)$/.test(((n as ImportDeclaration).moduleSpecifier as StringLiteral).text)) sites.push(textOf(n));
    });
    return sites.sort(order);
  });
}

// Digests cover the parsed dispatch-site inventory, not whole files. Tests change the actual calls and options.
export const HTTP_DISPATCH: Readonly<Record<string, string>> = {
  'packages/auth/src/client-credentials.js': '8922d87a88775739a67ea039f991da74fd7dbd3f7a6bda147eb272b24121b8ca',
  'packages/core/src/transport.js': '49ea98b2972e0d4d127c5431eac660f225c9d0e5f78effc0b94cd6bdc7a7aaac',
  'packages/server/src/main.js': '6b6cd7e78ac11872e66b8a42e1d70df74c45bc77711f623c9b92913437434182',
  'examples/quickstart/client.js': '1b0f700399d67254fccf1c6204776d50c4f6e3349290fccd75556fa181cbc955',
  'examples/quickstart/request-observer.js': '72a0412cfe92e7bd52a36541331a46c78e9892bad134a9b9f110edd304dc40be',
  // The prior pinned sites plus exactly `import { connect } from 'node:net';` for the pre-provisioning 127.0.0.1:18080 probe (sends no bytes).
  'examples/quickstart/seed-http.js': '0c0fd27cf9765203342fdff9e8704d8c976933f1b7a496d448137586203571f5',
  'examples/quickstart/setup-oracle.js': '64169f837e258750495e9538c9a893efc88cc18393f536858e678c6ac5e1f80a',
};
export function assertHttpDispatch(path: string, code: string): void {
  const sites = httpDispatchSites(code), expected = HTTP_DISPATCH[path];
  if (sites.length ? sha256(JSON.stringify(sites)) !== expected : expected !== undefined) throw fault('HTTP_DISPATCH');
}

export function servingBoundary(modules: ReadonlyMap<string, string>, dependencies: readonly string[]): void {
  const seen = new Set<string>(), pending = ['packages/server/src/cli.js', 'packages/server/src/main.js'];
  while (pending.length) {
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    const code = modules.get(path);
    if (code === undefined || !GATEWAY_MODULES.includes(path)) throw fault('SERVING_BOUNDARY');
    seen.add(path);
    // Bootstrap's one fixed lazy import is needed for --version without loading serving code.
    if (forbiddenServingLoad(code, path === 'packages/server/src/cli.js')) throw fault('SERVING_BOUNDARY');
    for (const specifier of moduleImports(code)) {
      if (specifier.startsWith('node:')) {
        if (/^node:(?:https?|http2|net|tls|dgram)$/.test(specifier) && path !== 'packages/core/src/transport.js') throw fault('SERVING_BOUNDARY');
        continue;
      }
      if (specifier.startsWith('.')) {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        if (target.endsWith('.json')) {
          if (target !== 'package.json' && !RUNTIME_FILES.includes(target)) throw fault('SERVING_BOUNDARY');
        } else {
          if (!GATEWAY_MODULES.includes(target)) throw fault('SERVING_BOUNDARY');
          pending.push(target);
        }
      } else if (!dependencies.some(name => specifier === name || specifier.startsWith(`${name}/`))) throw fault('SERVING_BOUNDARY');
    }
    assertHttpDispatch(path, code);
  }
  if (!isDeepStrictEqual([...seen].sort(order), [...GATEWAY_MODULES].sort(order))) throw fault('SERVING_BOUNDARY');
}

export const withoutSourceMap = (bytes: Buffer): Buffer => Buffer.from(bytes.toString('utf8').replace(/\n\/\/# sourceMappingURL=[^\r\n]+(?:\r?\n)?$/, '\n'));
type StagedFile = { path: string; body: Buffer; mode: number };
const inventory = (identity: ExpectedInventory['identity'], files: readonly StagedFile[]): ExpectedInventory => validateExpectedInventory({ schema: 1, identity,
  files: files.map(({ path, body, mode }) => ({ path, size: body.byteLength, mode, sha256: sha256(body) })).sort((a, b) => order(a.path, b.path)) });
const rootIdentity = (pkg: any): ExpectedInventory['identity'] => ({ name: pkg.name, version: pkg.version, bin: pkg.bin });

/** Interior links, special files, and unapproved empty directories are refused as well as extra files. */
export async function listRegularFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(join(root, path));
    if (info.isDirectory()) {
      const names = (await readdir(join(root, path))).sort(order);
      if (path && !names.length) throw fault('STAGE_FORBIDDEN');
      for (const name of names) await visit(path ? `${path}/${name}` : name);
    } else if (info.isFile() && !info.isSymbolicLink()) found.push(path);
    else throw fault('STAGE_FORBIDDEN');
  };
  await visit(''); return found.sort(order);
}
export async function verifyStagedDirectory(root: string, expected: ExpectedInventory): Promise<void> {
  const paths = await listRegularFiles(root);
  for (const path of paths) assertProductionFile(path);
  if (!isDeepStrictEqual(paths, expected.files.map(f => f.path).sort(order))) throw fault('STAGE_INVENTORY');
  for (const file of expected.files) {
    const path = join(root, file.path), info = await lstat(path), body = await readFile(path);
    if (info.mode % 0o1000 !== file.mode || body.byteLength !== file.size || sha256(body) !== file.sha256) throw fault('STAGE_CHANGED');
  }
}

export async function snapshotInputs(root: string): Promise<readonly FileInventory[]> {
  const paths = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', ...DOCUMENTS, 'compose.quickstart.yaml'];
  for (const directory of ['packages', 'examples/quickstart', 'scripts', 'tests', 'packaging', 'licenses'])
    paths.push(...(await listRegularFiles(join(root, directory))).map(p => `${directory}/${p}`));
  return Promise.all([...new Set(paths)].sort(order).map(async path => {
    const body = await readFile(join(root, path)), info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink()) throw fault('STAGE_FORBIDDEN');
    return { path, size: body.byteLength, mode: info.mode % 0o1000, sha256: sha256(body) };
  }));
}

/** Pure manifest projection: candidate stays private and contains no development edges or lifecycle scripts. */
export function stagedManifest(pkg: any, paths: readonly string[]): any {
  const { scripts: _scripts, devDependencies: _dev, ...manifest } = pkg;
  if (pkg.private !== true) throw fault('STAGE_IDENTITY');
  return { ...manifest, files: [...paths].sort(order) };
}

/** Compiles without installing anything and compares the selected outputs with the already checked build. */
export async function verifyCheckedBuild(root: string, scratch: string, paths: readonly string[]): Promise<void> {
  const emitted = join(scratch, 'compiled');
  const compile = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.build.json'), '--outDir', emitted],
    { cwd: root, encoding: 'utf8', timeout: 120_000 });
  if (compile.status !== 0) throw fault('STAGE_COMPILE');
  for (const p of new Set(paths)) {
    if (!(await readFile(join(root, 'dist', p))).equals(await readFile(join(emitted, p)))) throw fault('STAGE_STALE_BUILD');
  }
}

export async function prepareFiles(root: string, scratch: string): Promise<{ files: StagedFile[]; helper: ExpectedInventory }> {
  const pkg = await readJson(join(root, 'package.json')), lock = await readJson(join(root, 'packaging/npm-shrinkwrap.json'));
  assertProductionLock(lock);
  if (!isDeepStrictEqual(rootIdentity(pkg), rootIdentity(lock.packages[''])) || !isDeepStrictEqual(pkg.dependencies, lock.packages[''].dependencies)) throw fault('STAGE_IDENTITY');
  const checker = await import(pathToFileURL(join(root, 'scripts/check-dist-identity.mjs')).href);
  await checker.checkDistIdentity(root);
  const dist = join(root, 'dist'), helperPkg = await readJson(join(root, 'examples/quickstart/package.json'));
  const boundary = await helperBoundary(observedGraph(dist, Object.keys(HELPER_ENTRIES)), p => readFile(join(dist, p), 'utf8'), Object.keys(helperPkg.dependencies));
  const helperAssets = await import(pathToFileURL(join(dist, 'examples/quickstart/prepare.js')).href);
  helperAssets.validateHelperAssets({ manifest: await readFile(join(root, 'examples/quickstart/seed-manifest.json')),
    compose: await readFile(join(root, 'compose.quickstart.yaml')), resources: await readFile(join(root, 'packages/evals/fixtures/quickstart/resources.ndjson')) });
  const modules = new Map(await Promise.all(GATEWAY_MODULES.map(async p => [p, await readFile(join(dist, p), 'utf8')] as const)));
  servingBoundary(modules, Object.keys(pkg.dependencies));
  for (const p of boundary.modules.filter(p => p.endsWith('.js'))) assertHttpDispatch(p, await readFile(join(dist, p), 'utf8'));

  // Re-emit into scratch and compare selected build outputs; stale dist/source substitutions cannot be staged.
  await verifyCheckedBuild(root, scratch, [...GATEWAY_MODULES, ...boundary.modules]);
  const files: StagedFile[] = [];
  const add = (path: string, body: Buffer, mode = 0o644): void => { assertProductionFile(path); files.push({ path, body, mode }); };
  const copy = async (source: string, target = source, mode = 0o644): Promise<void> => {
    const info = await lstat(join(root, source)); if (!info.isFile() || info.isSymbolicLink()) throw fault('STAGE_FORBIDDEN');
    const body = await readFile(join(root, source)); add(target, source.endsWith('.js') ? withoutSourceMap(body) : body, mode);
  };
  for (const p of GATEWAY_MODULES) await copy(`dist/${p}`, `dist/${p}`, p === 'packages/server/src/cli.js' ? 0o755 : 0o644);
  for (const p of [...RUNTIME_FILES, 'packages/server/src/generated/release.json']) await copy(`dist/${p}`);
  for (const p of DOCUMENTS) await copy(p);
  await copy('packaging/npm-shrinkwrap.json', 'npm-shrinkwrap.json');
  const licenses = await import(pathToFileURL(join(root, 'scripts/release-licenses.mjs')).href);
  await licenses.checkReleaseLicenses(root);
  for (const p of await listRegularFiles(join(root, 'licenses'))) await copy(`licenses/${p}`);
  await copy('examples/quickstart/package.json', 'quickstart/package.json');
  await copy('examples/quickstart/package-lock.json', 'quickstart/package-lock.json');
  for (const p of boundary.modules) await copy(`dist/${p}`, `quickstart/dist/${p}`, p === 'examples/quickstart/main.js' ? 0o755 : 0o644);
  for (const p of HELPER_ASSETS) await copy(p, `quickstart/${p}`);
  await copy('dist/examples/quickstart/timing.js', 'quickstart/fireboat-timing.mjs', 0o755);
  const paths = [...files.map(f => f.path), 'package.json', 'dist/package.json'].sort(order);
  if (!isDeepStrictEqual(pkg.files, paths)) throw fault('STAGE_FILES_ALLOWLIST');
  const manifest = jsonBytes(stagedManifest(pkg, paths));
  add('package.json', manifest); add('dist/package.json', manifest);
  if (new Set(files.map(f => f.path)).size !== files.length) throw fault('STAGE_INVENTORY');
  return { files, helper: inventory(rootIdentity(helperPkg), files.filter(f => f.path.startsWith('quickstart/')).map(f => ({ ...f, path: f.path.slice(11) }))) };
}

export async function stagePackage(out: string, options: { root?: string; approveInventory?: boolean } = {}): Promise<ExpectedInventory> {
  const root = resolve(options.root ?? ROOT);
  if (!isAbsolute(out) || resolve(out) === root || relative(root, resolve(out)).split(sep)[0] !== '..') throw fault('STAGE_DESTINATION');
  // Exclusive creation, never clearing a directory supplied by a caller.
  await mkdir(out, { mode: 0o700 });
  const scratch = await mkdtemp(join(dirname(out), '.fireboat-stage-'));
  try {
    const before = options.approveInventory ? undefined : await snapshotInputs(root);
    const { files, helper } = await prepareFiles(root, scratch), pkg = await readJson(join(root, 'package.json'));
    const expected = inventory(rootIdentity(pkg), files);
    if (options.approveInventory) {
      await writeFile(join(root, 'packaging/npm-files.json'), jsonBytes(expected));
      await writeFile(join(root, 'packaging/helper-files.json'), jsonBytes(helper));
    } else if (!isDeepStrictEqual(expected, validateExpectedInventory(await readJson(join(root, 'packaging/npm-files.json')))) ||
      !isDeepStrictEqual(helper, validateExpectedInventory(await readJson(join(root, 'packaging/helper-files.json'))))) throw fault('STAGE_INVENTORY');
    for (const file of files) {
      await mkdir(dirname(join(out, file.path)), { recursive: true });
      await writeFile(join(out, file.path), file.body, { flag: 'wx', mode: file.mode }); await chmod(join(out, file.path), file.mode);
    }
    await verifyStagedDirectory(out, expected);
    const inputs = await snapshotInputs(root);
    if (before && !isDeepStrictEqual(before, inputs)) throw fault('STAGE_INPUT_CHANGED');
    await writeFile(`${out}.stage.json`, jsonBytes({ schema: 1, root, inputs, inventorySha256: sha256(JSON.stringify(expected.files)) }), { flag: 'wx', mode: 0o600 });
    return expected;
  } catch (error) { await rm(out, { recursive: true, force: true }); throw error; }
  finally { await rm(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), approveInventory = args[0] === '--approve-inventory', out = args[approveInventory ? 1 : 0];
  try {
    if (!out || args.length !== (approveInventory ? 2 : 1)) throw fault('STAGE_USAGE');
    const expected = await stagePackage(out, { approveInventory });
    console.log(`stage-package: files=${expected.files.length} inventory=${sha256(JSON.stringify(expected.files))}`);
  } catch (error) { console.error(`stage-package: ${error instanceof StageFault ? error.code : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'STAGE_FAILED'}`); process.exitCode = 1; }
}
