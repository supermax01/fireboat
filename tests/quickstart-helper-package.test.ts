import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BoundaryFault, checkHelperBoundary, HELPER_ENTRIES, helperBoundary } from '../scripts/quickstart/check-helper-boundary.js';
import { observedGraph } from '../scripts/quickstart/module-graph.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = async (path: string): Promise<any> => JSON.parse(await readFile(join(root, path), 'utf8'));
const SDK = '@modelcontextprotocol/client';

test('quickstart helper package: private manifest pins exactly the SDK client and its lock repeats the root lock resolution', async () => {
  const [helper, gateway, lock, rootLock] = await Promise.all([json('examples/quickstart/package.json'), json('package.json'),
    json('examples/quickstart/package-lock.json'), json('package-lock.json')]);
  assert.deepEqual(Object.keys(helper).sort(), ['bin', 'dependencies', 'description', 'engines', 'license', 'name', 'private', 'type', 'version']);
  assert.equal(helper.name, 'fireboat-quickstart'); assert.equal(helper.private, true); assert.equal(helper.type, 'module');
  assert.equal(helper.version, gateway.version); assert.equal(helper.license, gateway.license); assert.deepEqual(helper.engines, gateway.engines);
  assert.deepEqual(helper.bin, { 'fireboat-quickstart': 'dist/examples/quickstart/main.js' });
  assert.deepEqual(helper.dependencies, { [SDK]: '2.3.1' }); assert.equal(gateway.devDependencies[SDK], '2.3.1');
  assert.equal(gateway.dependencies[SDK], undefined, 'the gateway production tree never gains the SDK client');
  assert.equal(lock.lockfileVersion, 3); assert.equal(lock.name, helper.name); assert.equal(lock.version, helper.version);
  const { description: _description, private: _private, type: _type, ...identity } = helper;
  assert.deepEqual(lock.packages[''], identity);
  const entries = Object.entries(lock.packages as Record<string, Record<string, unknown>>).filter(([path]) => path !== '');
  for (const [path, entry] of entries) {
    const { dev: _dev, ...tested } = rootLock.packages[path];
    assert.deepEqual(entry, tested, `${path} is the root lock's tested entry`);
    assert.match(String(entry.resolved), /^https:\/\/registry\.npmjs\.org\//); assert.match(String(entry.integrity), /^sha512-/);
    assert.equal(entry.hasInstallScript, undefined); assert.equal(entry.optional, undefined);
  }
  // Flat (hoisted) closure: every entry is reachable from the SDK and every edge lands on an entry.
  const reachable = new Set<string>(), pending = Object.keys(helper.dependencies);
  while (pending.length) {
    const name = pending.pop()!, path = `node_modules/${name}`;
    assert.ok(lock.packages[path], `${path} is locked`);
    if (reachable.has(path)) continue;
    reachable.add(path); pending.push(...Object.keys(lock.packages[path].dependencies ?? {}));
  }
  assert.deepEqual([...reachable].sort(), entries.map(([path]) => path).sort());
  assert.equal(entries.length, 13);
});

const MODULES: Record<string, string> = {
  'examples/quickstart/main.js': "#!/usr/bin/env node\nimport { a } from './client.js';\nimport pins from './pins.json' with { type: 'json' };\nimport { b } from '../../packages/evals/src/evidence-oracle.js';\n",
  'examples/quickstart/client.js': "import { spawn } from 'node:child_process';\nimport { Client } from '@modelcontextprotocol/client';\nexport const a = 1; const flag = '--import';\n",
  'packages/evals/src/evidence-oracle.js': "import { createHash } from 'node:crypto';\nimport { M3B_CHECK_KINDS } from './check-contracts.js';\nexport const b = 2;\n",
  'packages/evals/src/check-contracts.js': 'export const M3B_CHECK_KINDS = [];\n',
  'examples/quickstart/request-observer.js': "import { channel } from 'node:diagnostics_channel';\nimport { Socket } from 'node:net';\n",
  'examples/quickstart/timing.js': "import { spawn } from 'node:child_process';\nimport { readFile } from 'node:fs/promises';\n",
};
/** The boundary of these modules as Node resolves them, written beside stub packages so every bare import resolves. */
const boundaryOf = async (changes: Record<string, string> = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'qs-graph-'));
  try {
    const write = async (path: string, text: string) => { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), text); };
    for (const [path, code] of Object.entries({ ...MODULES, ...changes })) await write(path, code);
    await write('examples/quickstart/pins.json', '{}'); await write('package.json', '{"type":"module"}');
    for (const name of [SDK, '@modelcontextprotocol/server', 'zod']) {
      await write(`node_modules/${name}/package.json`, JSON.stringify({ name, type: 'module', exports: './index.js' }));
      await write(`node_modules/${name}/index.js`, 'export const Client = 1, McpServer = 1, z = 1;\n');
    }
    return await helperBoundary(observedGraph(directory, Object.keys(HELPER_ENTRIES)), path => readFile(join(directory, path), 'utf8'), [SDK]);
  } finally { await rm(directory, { recursive: true, force: true }); }
};
const refuses = (changes: Record<string, string>) => assert.rejects(boundaryOf(changes), (e: unknown) => e instanceof BoundaryFault && e.code === 'HELPER_BOUNDARY');

test('quickstart helper boundary: the bin reaches its modules, reviewed pure shared modules and the SDK only', async () => {
  assert.deepEqual(await boundaryOf(), {
    modules: ['examples/quickstart/client.js', 'examples/quickstart/main.js', 'examples/quickstart/pins.json', 'examples/quickstart/request-observer.js',
      'examples/quickstart/timing.js', 'packages/evals/src/check-contracts.js', 'packages/evals/src/evidence-oracle.js'],
    packages: [SDK],
  });
  const main = MODULES['examples/quickstart/main.js']!, client = MODULES['examples/quickstart/client.js']!;
  await refuses({ 'examples/quickstart/main.js': `${main}import { main } from '../../packages/server/src/main.js';\n` });
  await refuses({ 'examples/quickstart/main.js': `${main}import { runEval } from '../../packages/evals/src/runner.js';\n` });
  await refuses({ 'examples/quickstart/main.js': `${main}export * from '../../packages/core/src/index.js';\n` });
  await refuses({ 'examples/quickstart/main.js': `${main}import {\n  serve,\n  listen\n} from '../../packages/server/src/http.js';\n` });
  await refuses({ 'examples/quickstart/main.js': `${main}import './nested/extra.js';\n` });
  await refuses({ 'examples/quickstart/main.js': `${main}import { x } from '../../../outside.js';\n` });
  await refuses({ 'examples/quickstart/client.js': `${client}import { z } from 'zod';\n` });
  await refuses({ 'examples/quickstart/client.js': `${client}import { McpServer } from '@modelcontextprotocol/server';\n` });
  await refuses({ 'examples/quickstart/client.js': `${client}import { readFile } from 'fs';\n` });
  await refuses({ 'examples/quickstart/client.js': `${client}const later = await import('./client.js');\n` });
  await refuses({ 'packages/evals/src/evidence-oracle.js': `${MODULES['packages/evals/src/evidence-oracle.js']}import { Client } from '${SDK}';\n` });
  await refuses({ 'packages/evals/src/evidence-oracle.js': `${MODULES['packages/evals/src/evidence-oracle.js']}import { h } from '../../../examples/quickstart/client.js';\n` });
  await refuses({ 'examples/quickstart/request-observer.js': `${MODULES['examples/quickstart/request-observer.js']}import { fault } from './manifest.js';\n` });
  await refuses({ 'examples/quickstart/request-observer.js': `${MODULES['examples/quickstart/request-observer.js']}import { M3B_CHECK_KINDS } from '../../packages/evals/src/check-contracts.js';\n` });
  await refuses({ 'examples/quickstart/timing.js': `${MODULES['examples/quickstart/timing.js']}import { Client } from '${SDK}';\n` });
  // Spellings a text scan misreads are what Node resolves: a quote inside a comment, and comments around a dynamic load.
  await refuses({ 'examples/quickstart/request-observer.js': `${MODULES['examples/quickstart/request-observer.js']}import /* 'comment' */ { Client } from '${SDK}';\n` });
  await refuses({ 'packages/evals/src/evidence-oracle.js': `${MODULES['packages/evals/src/evidence-oracle.js']}import /* 'comment' */ { Client } from '${SDK}';\n` });
  await refuses({ 'examples/quickstart/client.js': `${client}export const later = () => import /* x */ ('./client.js');\n` });
  await assert.rejects(boundaryOf({ 'examples/quickstart/main.js': main.replace("import { a } from './client.js';", "import { a } from './missing.js';") }),
    (e: unknown) => e instanceof BoundaryFault && e.code === 'HELPER_LOAD', 'an allowed module that does not resolve');
});

test('quickstart helper boundary: the nested layout runs the bin with only the locked packages visible', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qs-helper-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const write = async (path: string, text: string) => { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), text); };
  await write('examples/quickstart/package.json', JSON.stringify({ type: 'module', bin: { 'fireboat-quickstart': 'dist/examples/quickstart/main.js' }, dependencies: {} }));
  await write('examples/quickstart/package-lock.json', JSON.stringify({ packages: { '': {} } }));
  for (const path of ['examples/quickstart/request-observer.js', 'examples/quickstart/timing.js']) await write(`dist/${path}`, '');
  await write('dist/examples/quickstart/main.js', "process.stderr.write('CLI_USAGE\\n'); process.exitCode = 2;\n");
  assert.equal(await checkHelperBoundary(directory), 'modules=3 packages= locked=0');
  await write('dist/examples/quickstart/main.js', "process.stderr.write('CLI_USAGE\\n'); process.exitCode = 2;\nexport const later = () => process.getBuiltinModule('module')['create' + 'Require'](import.meta.url)('../../packages/server/src/main.js');\n");
  await assert.rejects(checkHelperBoundary(directory), (e: unknown) => e instanceof BoundaryFault && e.code === 'HELPER_BOUNDARY', 'the complete checker refuses an unexecuted loader before its isolated no-command launch');
  await write('dist/examples/quickstart/main.js', "process.stdout.write('ran');\n");
  await assert.rejects(checkHelperBoundary(directory), (e: unknown) => e instanceof BoundaryFault && e.code === 'HELPER_LOAD');
  await write('examples/quickstart/package-lock.json', JSON.stringify({ packages: { '': {}, 'node_modules/stale': { version: '2.0.0' } } }));
  await write('node_modules/stale/package.json', JSON.stringify({ version: '1.0.0' }));
  await write('dist/examples/quickstart/main.js', "process.stderr.write('CLI_USAGE\\n'); process.exitCode = 2;\n");
  await assert.rejects(checkHelperBoundary(directory), (e: unknown) => e instanceof BoundaryFault && e.code === 'HELPER_LOAD' && e.detail.includes('stale'));
});

test('quickstart helper entry points run when started through a symlink such as an npm bin shim', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qs-shim-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await symlink(join(root, 'examples/quickstart/main.ts'), join(directory, 'fireboat-quickstart'));
  await symlink(join(root, 'examples/quickstart/timing.ts'), join(directory, 'fireboat-timing.ts'));
  const bin = spawnSync(process.execPath, ['--import', 'tsx', join(directory, 'fireboat-quickstart')], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(bin.status, 2); assert.equal(bin.stderr, 'CLI_USAGE\n');
  const timer = spawnSync(process.execPath, [join(directory, 'fireboat-timing.ts')], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(timer.status, 2); assert.equal(timer.stderr, 'TIMING_COMMAND_INVALID\n');
});

test('quickstart helper boundary: named builtin, aliased, computed and latent loading/evaluation forms refuse separately from the observed graph', async () => {
  const client = MODULES['examples/quickstart/client.js']!;
  for (const code of [
    "export const later = process.getBuiltinModule('node:fs').readFileSync;",
    "export const later = () => process.getBuiltinModule('module')['create' + 'Require'](import.meta.url)('../../packages/server/src/main.js');",
    "const p = process; const later = p['get' + 'BuiltinModule'];",
    "const p = process, name = 'getBuiltinModule'; const later = p[name];",
    "const { getBuiltinModule: later } = process;", "const { binding: later } = process;", "const { dlopen: later } = process;",
    "const later = require;", "const later = requ\\u0069re;", "const later = eval;", "const later = Function;",
    "const later = process.binding;", "const later = process.dlopen;",
    "const later = import.meta.resolve;", "const later = import.meta['resolve'];",
    "const later = import.meta?.resolve;", "const later = import.meta?.['resolve'];", "const meta = import.meta; const later = meta.resolve;",
    "export const later = object => object['create' + 'Require'];",
    "const key = 'get' + 'BuiltinModule'; export const later = object => object[key];",
    "export const later = object => object[`getBuiltin${'Module'}`];",
    "export const later = object => object[('get') + ('BuiltinModule')];",
    "const template = `data ${JSON.stringify({ a: `nested ${1}` })}`; export const later = () => process.getBuiltinModule('node:fs');",
    "const pattern = /`/; export const later = () => process.getBuiltinModule('node:fs');",
    "export const later = () => import /* latent */ ('node:fs');",
    ...['node:module', 'node:vm', 'node:worker_threads'].map(name => `import * as later from '${name}';`),
  ]) await refuses({ 'examples/quickstart/client.js': `${client}\n${code}` });
  const kernel = MODULES['packages/evals/src/evidence-oracle.js']!;
  await refuses({ 'packages/evals/src/evidence-oracle.js': `${kernel}\nexport const reviewRuntimeFs = process.getBuiltinModule('node:fs').readFileSync;` });
});


test('quickstart helper boundary: parser context permits ordinary bindings, regexes and templates and catches an appended builtin witness', async () => {
  const { DYNAMIC } = await import('../scripts/quickstart/check-helper-boundary.js');
  assert.equal(DYNAMIC.test("const template = `hello ${JSON.stringify({ n: `nested ${1}` })}`; const pattern = /`|eval/; const binding = 'safe'; function f(x, binding) { return binding; }"), false);
  const kernel = await readFile(join(root, 'packages/evals/src/evidence-oracle.ts'), 'utf8');
  const { stripTypeScriptTypes } = await import('node:module');
  assert.equal(DYNAMIC.test('const invalid = ;'), true, 'parse failures refuse');
  assert.equal(DYNAMIC.test(stripTypeScriptTypes(kernel) + "\nexport const reviewRuntimeFs = process.getBuiltinModule('node:fs').readFileSync;\n"), true, 'the original appended witness after all real kernel templates');
});
