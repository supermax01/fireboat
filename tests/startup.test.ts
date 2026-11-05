import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readReleaseMetadata, RUNTIME_ASSETS, runtimeCell, sourceReleaseMetadata, validReleaseMetadata, versionLine } from '../packages/server/src/release.js';
import { sourceStamp } from './isolation/build.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const release = readReleaseMetadata();
let directory: string, cli: string, manifest: string;
// Each test process owns its compiled fixture. Nothing rebuilds or mutates the checkout's dist.
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'startup-PRIVATE-CANARY-'));
  cli = join(directory, release.bin); manifest = join(dirname(cli), 'generated/release.json');
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json', '--outDir', join(directory, 'dist')], { cwd: root, stdio: 'pipe' });
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'packages/core/src/contracts.ts', 'packages/core/src/catalog.ts',
    'scripts/stage-runtime-assets.mjs', 'scripts/generate-release-metadata.mjs', 'scripts/check-dist-identity.mjs', ...Object.values(RUNTIME_ASSETS)];
  for (const file of files) {
    const target = join(directory, file); await mkdir(dirname(target), { recursive: true }); await cp(join(root, file), target);
  }
  execFileSync(process.execPath, ['scripts/stage-runtime-assets.mjs'], { cwd: directory });
  execFileSync(process.execPath, ['scripts/generate-release-metadata.mjs'], { cwd: directory });
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const run = (args: string[], preload?: string) => spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), cli, ...args], { cwd: tmpdir(), encoding: 'utf8', timeout: 15000 });
function refuses(result: ReturnType<typeof run>, expected: string): void {
  assert.equal(result.status, 2); assert.equal(result.stdout, '');
  assert.equal(result.stderr, `fireboat: ${expected}\n`);
  assert.doesNotMatch(result.stderr, /PRIVATE-CANARY|https?:|\/private|\/Users|\bat .*\(/);
}

test('startup: build manifest and exact compiled version match source identity', async () => {
  const emitted = JSON.parse(await readFile(manifest, 'utf8'));
  assert.deepEqual(emitted, release); assert.equal(validReleaseMetadata(emitted), true);
  assert.deepEqual(Object.keys(emitted.assets).sort(), Object.keys(RUNTIME_ASSETS).sort());
  assert.ok(!('tarballSha256' in emitted) && !('releaseSha256' in emitted));
  const result = run(['--version']);
  assert.equal(result.status, 0); assert.equal(result.stderr, ''); assert.equal(result.stdout, `${versionLine(release)}\n`);
  const checked = spawnSync(process.execPath, ['scripts/check-dist-identity.mjs'], { cwd: directory, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});

test('startup: every missing or altered runtime asset refuses before main with empty stdout', async () => {
  for (const [label, path] of Object.entries(RUNTIME_ASSETS)) {
    const target = join(directory, 'dist', path), original = await readFile(target);
    try {
      await rm(target);
      for (const args of [[], ['--doctor']]) refuses(run(args), `ASSET_MISSING ${label}`);
      // Valid JSON with changed bytes must fail too, before any JSON import or configuration read.
      await writeFile(target, `${original.toString()}\n`);
      refuses(run(['--doctor', '--config', '/private/PRIVATE-CANARY']), `ASSET_INVALID ${label}`);
    } finally { await writeFile(target, original); }
  }
});

test('startup: missing, malformed and open release metadata refuse with fixed labels', async () => {
  const original = await readFile(manifest);
  try {
    await rm(manifest); refuses(run(['--doctor']), 'ASSET_MISSING release');
    for (const value of ['{ PRIVATE-CANARY', JSON.stringify({ ...release, raw: 'https://PRIVATE-CANARY' }), JSON.stringify({ ...release, bin: '/private/PRIVATE-CANARY' })]) {
      await writeFile(manifest, value); refuses(run(['--doctor']), 'ASSET_INVALID release');
    }
  } finally { await writeFile(manifest, original); }
});

test('startup: runtime floor and each lossless primitive fail closed; help and version stay available', async () => {
  const preload = join(directory, 'runtime-PRIVATE-CANARY.cjs');
  const changes = [
    "Object.defineProperty(process.versions, 'node', { value: '23.99.0' });",
    "Object.defineProperty(process.versions, 'node', { value: '24.0.0-pre' });",
    'JSON.rawJSON = undefined;', 'JSON.isRawJSON = undefined;',
    "const parse = JSON.parse; JSON.parse = (text, reviver) => parse(text, reviver && function (key, value) { return reviver.call(this, key, value); });",
    'JSON.rawJSON = () => ({}); JSON.isRawJSON = () => true;',
  ];
  for (const change of changes) {
    await writeFile(preload, change);
    for (const args of [[], ['--doctor']]) refuses(run(args, preload), 'RUNTIME_UNSUPPORTED');
    assert.equal(run(['--help'], preload).status, 0);
    const version = run(['--version'], preload);
    assert.equal(version.status, 0); assert.equal(version.stderr, '');
    assert.match(version.stdout, /^fireboat 0\.2\.0-alpha\.1 schema=0\.3 node=/);
  }
  // The retained floor admits 24.0.0 when the actual lossless features work.
  await writeFile(preload, "Object.defineProperty(process.versions, 'node', { value: '24.0.0' });");
  refuses(run(['--doctor'], preload), 'CONFIG_INVALID');
  assert.match(run(['--version'], preload).stdout, /node=24\.0\.0 runtime=unverified\n$/);
});

test('startup: a main import failure is contained with no stack or stdout', async () => {
  const target = join(dirname(cli), 'main.js'), original = await readFile(target);
  try {
    await writeFile(target, "throw new Error('https://PRIVATE-CANARY/patient-secret');\n");
    refuses(run(['--doctor']), 'STARTUP_FAILED');
    assert.equal(run(['--help']).status, 0); assert.equal(run(['--version']).status, 0);
  } finally { await writeFile(target, original); }
});

test('release: recorded cells require exact Node, platform and architecture', () => {
  const cell = release.runtime.recordedCells[0]!;
  assert.equal(runtimeCell(release, cell), 'recorded');
  for (const changed of [{ ...cell, node: '24.22.1' }, { ...cell, platform: 'linux' }, { ...cell, arch: 'x64' }]) {
    assert.equal(runtimeCell(release, changed), 'unverified');
    assert.match(versionLine(release, changed), /runtime=unverified$/);
  }
});

test('release: manifest refuses unknown fields, unsafe paths, pin ranges and malformed cells', () => {
  const cases = [
    { ...release, name: 'https://PRIVATE-CANARY' }, { ...release, name: release.name + '\n' },
    { ...release, version: '0.2.0 PRIVATE-CANARY' }, { ...release, schema: '0.2' }, { ...release, catalog: 'm3b-catalog/2' },
    { ...release, bin: 'extra/' + release.bin }, { ...release, raw: 'PRIVATE-CANARY' },
    { ...release, assets: { ...release.assets, extra: { path: '/private/PRIVATE-CANARY', sha256: 'a'.repeat(64) } } },
    { ...release, assets: { ...release.assets, 'r4-index': { path: '/private/PRIVATE-CANARY', sha256: 'a'.repeat(64) } } },
    { ...release, assets: { ...release.assets, 'r4-index': { ...release.assets['r4-index'], sha256: 'A'.repeat(64) } } },
    { ...release, productionDependencies: { ...release.productionDependencies, zod: '^4.6.7' } },
    { ...release, runtime: { ...release.runtime, floor: '24.21.0' } },
    { ...release, runtime: { ...release.runtime, recordedCells: [{ node: '24.22.0', platform: 'darwin', arch: 'arm64', error: 'PRIVATE-CANARY' }] } },
    { ...release, runtime: { ...release.runtime, recordedCells: [{ node: 'v24.22.0', platform: 'darwin', arch: 'arm64' }] } },
    { ...release, runtime: { ...release.runtime, recordedCells: [{ node: '24.22.0', platform: 'PRIVATE-CANARY', arch: 'arm64' }] } },
  ];
  for (const value of cases) assert.equal(validReleaseMetadata(value), false);
});

test('release checker: identical version suffix cannot hide identity, lock, bin or asset drift', async () => {
  const checker = await import(new URL('../scripts/check-dist-identity.mjs', import.meta.url).href) as { assertReleaseIdentity(expected: unknown, actual: unknown): void };
  checker.assertReleaseIdentity(release, structuredClone(release));
  for (const value of [{ ...release, name: 'other-name' }, { ...release, version: 'prefix-' + release.version }, { ...release, schema: '0.2' },
    { ...release, bin: 'prefix/' + release.bin }, { ...release, productionDependencies: { zod: '4.6.6' } },
    { ...release, assets: { ...release.assets, 'support-matrix': { ...release.assets['support-matrix'], sha256: 'a'.repeat(64) } } }]) {
    assert.throws(() => checker.assertReleaseIdentity(release, value), /RELEASE_IDENTITY_MISMATCH/);
  }
  for (const [file, change] of [
    [manifest, (value: any) => ({ ...value, name: 'other-name' })],
    [join(directory, 'package-lock.json'), (value: any) => ({ ...value, version: '0.2.0-alpha.2' })],
    [join(directory, 'dist/package.json'), (value: any) => ({ ...value, bin: { 'fireboat': 'prefix/' + release.bin } })],
  ] as const) {
    const original = await readFile(file);
    try {
      await writeFile(file, JSON.stringify(change(JSON.parse(original.toString()))));
      const result = spawnSync(process.execPath, ['scripts/check-dist-identity.mjs'], { cwd: directory, encoding: 'utf8' });
      assert.equal(result.status, 1); assert.equal(result.stderr, 'check-dist-identity: RELEASE_IDENTITY_MISMATCH\n');
    } finally { await writeFile(file, original); }
  }
});

test('release generator: determinism and source scalar validation', async () => {
  const original = await readFile(manifest);
  execFileSync(process.execPath, ['scripts/generate-release-metadata.mjs'], { cwd: directory });
  assert.deepEqual(await readFile(manifest), original);
  const path = join(directory, 'packages/core/src/contracts.ts'), text = await readFile(path, 'utf8');
  try {
    await writeFile(path, `${text}\nexport const M3B_SCHEMA_VERSION = '0.3';\n`);
    assert.throws(() => sourceReleaseMetadata(pathToFileURL(`${directory}/`)), { code: 'ASSET_INVALID', label: 'release' });
  } finally { await writeFile(path, text); }
});

test('startup: isolation build stamp binds every packaging generator', async () => {
  const stamp = sourceStamp(directory);
  for (const file of ['scripts/stage-runtime-assets.mjs', 'scripts/generate-release-metadata.mjs', 'scripts/check-dist-identity.mjs']) {
    const target = join(directory, file), text = await readFile(target, 'utf8');
    try {
      await writeFile(target, `${text}\n// changed build input\n`);
      assert.notEqual(sourceStamp(directory), stamp);
    } finally { await writeFile(target, text); }
  }
  assert.equal(sourceStamp(directory), stamp);
});
