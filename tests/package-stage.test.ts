import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { before, after } from 'node:test';
import { gzipSync } from 'node:zlib';
import { validateExpectedInventory, type ExpectedInventory } from '../scripts/package-inventory.js';
import { assertProductionFile, assertProductionLock, GATEWAY_MODULES, HELPER_ASSETS, ROOT, RUNTIME_FILES, sha256, servingBoundary,
  assertHttpDispatch, stagedManifest, verifyCheckedBuild, verifyStagedDirectory, withoutSourceMap } from '../scripts/stage-package.js';
import { lockTree, verifyInstalledTree, verifyPackage, verifyPackageBytes } from '../scripts/verify-package.js';

let scratch: string;
let modules: Map<string, string>;
before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'fireboat-stage-test-'));
  const compiled = join(scratch, 'compiled');
  const result = spawnSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', join(ROOT, 'tsconfig.build.json'), '--outDir', compiled], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  modules = new Map(await Promise.all(GATEWAY_MODULES.map(async p => [p, await readFile(join(compiled, p), 'utf8')] as const)));
});
after(async () => { await rm(scratch, { recursive: true, force: true }); });

test('package stage: source eval maps declarations and research are forbidden before copying', () => {
  for (const path of ['dist/packages/evals/src/runner.js', 'dist/examples/demo.js', 'dist/packages/core/src/index.ts',
    'dist/packages/core/src/index.d.ts', 'dist/packages/core/src/index.js.map', 'research/notes.txt', '.env',
    'quickstart/dist/packages/server/src/main.js', 'quickstart/dist/packages/evals/src/runner.js', 'quickstart/node_modules/zod/package.json'])
    assert.throws(() => assertProductionFile(path), { code: 'STAGE_FORBIDDEN' }, path);
  for (const path of ['dist/packages/server/src/cli.js', ...RUNTIME_FILES.map(p => `dist/${p}`),
    'quickstart/dist/packages/evals/src/evidence-oracle.js', ...HELPER_ASSETS.map(p => `quickstart/${p}`)]) assertProductionFile(path);
});

test('package stage: gateway shrinkwrap rejects client tsx and every development edge', async () => {
  const lock = JSON.parse(await readFile(join(ROOT, 'packaging/npm-shrinkwrap.json'), 'utf8'));
  assertProductionLock(lock);
  for (const mutate of [
    (l: any) => { l.packages['node_modules/@modelcontextprotocol/client'] = { version: '2.3.1' }; },
    (l: any) => { l.packages['node_modules/tsx'] = { version: '4.23.15' }; },
    (l: any) => { l.packages['node_modules/zod'].dev = false; },
    (l: any) => { l.packages[''].devDependencies = { tsx: '4.23.15' }; },
    (l: any) => { l.packages['node_modules/zod'].dependencies = { tsx: '4.23.15' }; },
    (l: any) => { l.packages['node_modules/zod'].hasInstallScript = true; },
    (l: any) => { l.packages['node_modules/zod'].integrity = ''; },
    (l: any) => { l.dependencies = { tsx: { version: '4.23.15' } }; },
  ]) { const changed = structuredClone(lock); mutate(changed); assert.throws(() => assertProductionLock(changed), { code: 'LOCK_NOT_PRODUCTION' }); }
  const helper = JSON.parse(await readFile(join(ROOT, 'examples/quickstart/package-lock.json'), 'utf8'));
  assert.equal(helper.packages[''].dependencies['@modelcontextprotocol/client'], '2.3.1');
  assert.equal(lockTree(lock).dependencies['@modelcontextprotocol/server'].dependencies['@modelcontextprotocol/core'].version, '2.3.1');
});

test('package stage: serving import graph excludes helper eval client and latent loaders', () => {
  servingBoundary(modules, ['@modelcontextprotocol/server', 'zod']);
  for (const added of [
    "import '../../../examples/quickstart/seed-http.js';", "import '../../evals/src/runner.js';",
    "import { Client } from '@modelcontextprotocol/client';", "const later = () => import('./main.js');",
    "import { request } from 'node:http';", "import { createRequire } from 'node:module';",
  ]) {
    const changed = new Map(modules); changed.set('packages/server/src/main.js', modules.get('packages/server/src/main.js')! + '\n' + added);
    assert.throws(() => servingBoundary(changed, ['@modelcontextprotocol/server', 'zod']), { code: 'SERVING_BOUNDARY' }, added);
  }
});

test('package stage: dispatch sites forbid clinical writes and isolate token POST and helper PUT paths', async () => {
  const transport = modules.get('packages/core/src/transport.js')!, auth = modules.get('packages/auth/src/client-credentials.js')!;
  const helper = await readFile(join(scratch, 'compiled/examples/quickstart/seed-http.js'), 'utf8');
  for (const name of (await readdir(join(scratch, 'compiled/examples/quickstart'))).filter(p => p.endsWith('.js')))
    assertHttpDispatch(`examples/quickstart/${name}`, await readFile(join(scratch, 'compiled/examples/quickstart', name), 'utf8'));
  assertHttpDispatch('packages/core/src/transport.js', transport);
  assertHttpDispatch('packages/auth/src/client-credentials.js', auth);
  assertHttpDispatch('examples/quickstart/seed-http.js', helper);
  // FHIR capability metadata names are not dispatches.
  assertHttpDispatch('metadata.js', "export const interactions = ['create', 'update', 'delete', 'patch'];");
  for (const [path, code] of [
    ['packages/core/src/transport.js', transport.replace("init.method ?? 'GET'", "init.method ?? 'PUT'")],
    ['packages/core/src/transport.js', transport.replace("controlledFetch(url, { redirect:", "controlledFetch(url, { method: 'POST', redirect:")],
    ['packages/core/src/index.js', "const later = () => fetch('http://127.0.0.1/Patient', { method: 'DELETE' });"],
    ['packages/auth/src/client-credentials.js', auth.replace('this.fetchFn(this.tokenUrl,', 'this.fetchFn(this.sourceOrigin,')],
    ['packages/auth/src/client-credentials.js', auth.replace("method: 'POST'", "method: 'PUT'")],
    ['examples/quickstart/seed-http.js', helper.replace("send('PUT', request.target", "send('POST', request.target")],
    ['examples/quickstart/seed-http.js', helper.replace("send('PUT', request.target", "send('PUT', 'Patient/arbitrary'")],
    ['examples/quickstart/seed-http.js', helper.replace('port: 18080', 'port: 18091')],
    ['examples/quickstart/seed-http.js', helper.replace('if (!listedPut(request, manifest))', 'if (false)')],
  ] as const) assert.throws(() => assertHttpDispatch(path, code), { code: 'HTTP_DISPATCH' });
});

test('package stage: exact directory refuses extra missing modified mode and link substitutions', async () => {
  const directory = join(scratch, 'directory'); await mkdir(directory);
  const files = [
    { path: 'package.json', body: Buffer.from('{"name":"@fireboat/gateway","version":"0.2.0-alpha.1","bin":{"fireboat":"dist/packages/server/src/cli.js"}}'), mode: 0o644 },
    { path: 'dist/packages/server/src/cli.js', body: Buffer.from('#!/usr/bin/env node\n'), mode: 0o755 },
  ];
  const expected = validateExpectedInventory({ schema: 1, identity: JSON.parse(files[0]!.body.toString()), files: files.map(({ path, body, mode }) => ({ path, size: body.length, mode, sha256: sha256(body) })) });
  for (const f of files) { await mkdir(dirname(join(directory, f.path)), { recursive: true }); await writeFile(join(directory, f.path), f.body, { mode: f.mode }); }
  await verifyStagedDirectory(directory, expected);
  await writeFile(join(directory, 'dist/extra.js.map'), 'x');
  await assert.rejects(verifyStagedDirectory(directory, expected), { code: 'STAGE_FORBIDDEN' }); await rm(join(directory, 'dist/extra.js.map'));
  await chmod(join(directory, files[1]!.path), 0o644);
  await assert.rejects(verifyStagedDirectory(directory, expected), { code: 'STAGE_CHANGED' }); await chmod(join(directory, files[1]!.path), 0o755);
  await writeFile(join(directory, 'package.json'), 'changed');
  await assert.rejects(verifyStagedDirectory(directory, expected), { code: 'STAGE_CHANGED' }); await writeFile(join(directory, 'package.json'), files[0]!.body);
  await rm(join(directory, files[1]!.path));
  // Leave no empty directory to obscure the missing-file check.
  await rm(join(directory, 'dist'), { recursive: true });
  await assert.rejects(verifyStagedDirectory(directory, expected), { code: 'STAGE_INVENTORY' });
  await mkdir(join(directory, 'dist')); await symlink('/private/tmp', join(directory, 'dist/link'));
  await assert.rejects(verifyStagedDirectory(directory, expected), { code: 'STAGE_FORBIDDEN' });
});

test('package stage: staged manifest retains private identity and removes lifecycle and dev edges', () => {
  const value = stagedManifest({ name: '@fireboat/gateway', version: '0.2.0-alpha.1', private: true, dependencies: { zod: '4.6.7' },
    devDependencies: { tsx: '4.23.15' }, scripts: { prepare: 'unreviewed' }, files: ['b', 'a'] }, ['b', 'a']);
  assert.equal(value.private, true); assert.equal(value.scripts, undefined); assert.equal(value.devDependencies, undefined);
  assert.deepEqual(value.files, ['a', 'b']); assert.deepEqual(value.dependencies, { zod: '4.6.7' });
  assert.equal(withoutSourceMap(Buffer.from('code();\n//# sourceMappingURL=x.js.map')).toString(), 'code();\n');
});

test('package stage: substituted compiled code and stale source fail the checked-build binding', async () => {
  const root = join(scratch, 'binding'); await mkdir(join(root, 'dist'), { recursive: true });
  await symlink(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  await writeFile(join(root, 'input.ts'), 'export const value: number = 1;\n');
  await writeFile(join(root, 'tsconfig.build.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'esnext', types: [], rootDir: '.', outDir: 'dist' }, files: ['input.ts'] }));
  const build = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.build.json')], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const clean = await readFile(join(root, 'dist/input.js'));
  await verifyCheckedBuild(root, join(scratch, 'binding-clean'), ['input.js']);
  await writeFile(join(root, 'dist/input.js'), 'export const value = 2;\n');
  await assert.rejects(verifyCheckedBuild(root, join(scratch, 'binding-substitute'), ['input.js']), { code: 'STAGE_STALE_BUILD' });
  await writeFile(join(root, 'dist/input.js'), clean); await writeFile(join(root, 'input.ts'), 'export const value: number = 3;\n');
  await assert.rejects(verifyCheckedBuild(root, join(scratch, 'binding-stale'), ['input.js']), { code: 'STAGE_STALE_BUILD' });
});

type Entry = { path: string; body: Buffer; mode: number; type?: string };
const identity = { name: '@fireboat/gateway', version: '0.2.0-alpha.1', bin: { fireboat: 'dist/packages/server/src/cli.js' } };
const entries = (): Entry[] => [
  { path: 'package.json', body: Buffer.from(JSON.stringify(identity)), mode: 0o644 },
  { path: identity.bin.fireboat, body: Buffer.from('#!/usr/bin/env node\n'), mode: 0o755 },
  { path: 'docs/LIMITS.md', body: Buffer.from('Synthetic only\n'), mode: 0o644 },
];
function archive(rows: Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const row of rows) {
    const h = Buffer.alloc(512), octal = (at: number, length: number, value: number) => h.write(`${value.toString(8).padStart(length - 1, '0')}\0`, at, length);
    h.write(`package/${row.path}`, 0, 100); octal(100, 8, row.mode); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, row.body.length); octal(136, 12, 0);
    h.write(row.type ?? '0', 156); h.write('ustar\0', 257); h.write('00', 263); h.fill(32, 148, 156);
    h.write(`${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(h, row.body, Buffer.alloc((512 - row.body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function packet(rows = entries()) {
  const tar = archive(rows), files = rows.map(({ path, body, mode }) => ({ path, size: body.length, mode }));
  return { tar, npm: [{ name: identity.name, version: identity.version, id: `${identity.name}@${identity.version}`, files, bundled: [],
    shasum: createHash('sha1').update(tar).digest('hex'), integrity: `sha512-${createHash('sha512').update(tar).digest('base64')}`, size: tar.length,
    unpackedSize: rows.reduce((a, b) => a + b.body.length, 0), entryCount: rows.length }],
    expected: { schema: 1, identity, files: entries().map(({ path, body, mode }) => ({ path, size: body.length, mode, sha256: sha256(body) })) } as ExpectedInventory };
}

test('package stage: npm JSON and tar independently reject extra missing body mode type and digest drift', () => {
  const clean = packet(); assert.equal(verifyPackageBytes(clean.expected, clean.npm, clean.tar).files.length, 3);
  const extra = { path: 'docs/extra.md', body: Buffer.from('x'), mode: 0o644 };
  for (const changed of [[...entries(), extra], entries().slice(0, 2)]) {
    const p = packet(changed), code = changed.length === 4 ? 'PACK_UNEXPECTED' : 'PACK_MISSING';
    assert.throws(() => verifyPackageBytes(clean.expected, clean.npm, p.tar), { code });
    assert.throws(() => verifyPackageBytes(clean.expected, p.npm, clean.tar), { code });
  }
  for (const field of ['body', 'mode', 'type'] as const) {
    const rows = entries();
    if (field === 'body') rows[2]!.body = Buffer.from('Substitute!!!!\n');
    if (field === 'mode') rows[2]!.mode = 0o755;
    if (field === 'type') rows[2]!.type = '2';
    const p = packet(rows);
    assert.throws(() => verifyPackageBytes(clean.expected, p.npm, p.tar), { code: field === 'type' ? 'TAR_ENTRY_UNSAFE' : 'PACK_FILE_MISMATCH' });
  }
  const bad = structuredClone(clean.npm); bad[0]!.integrity = 'sha512-wrong';
  assert.throws(() => verifyPackageBytes(clean.expected, bad, clean.tar), { code: 'PACK_DIGEST_MISMATCH' });
});

test('package stage: safe extraction occurs only after all checks and refuses an existing destination', async () => {
  const p = packet(), directory = join(scratch, 'packet'); await mkdir(directory);
  const input = { tar: join(directory, 'candidate.tgz'), packJson: join(directory, 'pack.json'), expected: join(directory, 'expected.json'), extract: join(directory, 'extracted') };
  await writeFile(input.tar, p.tar); await writeFile(input.packJson, JSON.stringify(p.npm)); await writeFile(input.expected, JSON.stringify(p.expected));
  const bad = structuredClone(p.npm); bad[0]!.shasum = 'wrong'; await writeFile(input.packJson, JSON.stringify(bad));
  await assert.rejects(verifyPackage(input), { code: 'PACK_DIGEST_MISMATCH' });
  await assert.rejects(readFile(join(input.extract, 'package.json')), { code: 'ENOENT' });
  await writeFile(input.packJson, JSON.stringify(p.npm));
  await verifyPackage(input); assert.deepEqual(await readFile(join(input.extract, 'package.json')), entries()[0]!.body);
  await assert.rejects(verifyPackage(input), { code: 'EEXIST' });
});

test('package stage: installed tree cannot borrow approval integrity when observed install metadata is missing', async () => {
  const install = join(scratch, 'installed'); await mkdir(join(install, 'node_modules'), { recursive: true });
  await writeFile(join(install, 'node_modules/.package-lock.json'), '{"packages":{}}');
  await assert.rejects(verifyInstalledTree(install, { dependencies: { [identity.name]: { version: identity.version } } }, 'gateway'), { code: 'TREE_PROBLEM' });
});
