import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const inv = await import(new URL('../packaging/oci/inventory.mjs', import.meta.url).href);
const digest = (body: Buffer) => `sha256:${inv.sha256(body)}`;
function layout() {
  const files = new Map<string, Buffer>();
  const add = (value: Buffer | object, mediaType: string) => {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const descriptor = { digest: digest(body), size: body.length, mediaType };
    files.set(`blobs/sha256/${descriptor.digest.slice(7)}`, body); return descriptor;
  };
  const raw = Buffer.from('synthetic layer archive'), layer = add(gzipSync(raw), 'application/vnd.oci.image.layer.v1.tar+gzip');
  const config = { os: 'linux', architecture: 'arm64', rootfs: { type: 'layers', diff_ids: [digest(raw)] }, config: { User: '1000:1000' } };
  const configRef = add(config, 'application/vnd.oci.image.config.v1+json');
  const manifest = add({ schemaVersion: 2, config: configRef, layers: [layer] }, 'application/vnd.oci.image.manifest.v1+json');
  const index = add({ schemaVersion: 2, manifests: [{ ...manifest, platform: { os: 'linux', architecture: 'arm64' } },
    { digest: `sha256:${'f'.repeat(64)}`, size: 999, platform: { os: 'linux', architecture: 'amd64' } }] }, 'application/vnd.oci.image.index.v1+json');
  files.set('index.json', Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [index] })));
  files.set('oci-layout', Buffer.from('{"imageLayoutVersion":"1.0.0"}'));
  return { files, configRef, config, manifest, index, layer, raw, add };
}
function tar(rows: { name: string; body?: string; type?: number }[]) {
  const chunks: Buffer[] = [];
  for (const row of rows) {
    const body = Buffer.from(row.body ?? ''), header = Buffer.alloc(512);
    header.write(row.name, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header[156] = row.type ?? 48; header.write('ustar\0', 257);
    const sum = header.reduce((a, b) => a + b, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

test('OCI inventory: actual selected blobs, config and compressed/uncompressed layers are independently bound', () => {
  const f = layout(), result = inv.imageInventory(f.files, { indexDigest: f.index.digest, childDigest: f.manifest.digest });
  assert.equal(result.configDigest, f.configRef.digest); assert.equal(result.manifestDigest, f.manifest.digest);
  assert.equal(result.indexDigest, f.index.digest); assert.equal(result.platform, 'linux/arm64');
  assert.deepEqual(result.layers, [{ digest: f.layer.digest, bytes: f.layer.size, mediaType: f.layer.mediaType,
    diffId: digest(f.raw), uncompressedBytes: f.raw.length }]);
  assert.equal(JSON.stringify(result).includes('amd64'), false, 'an unavailable child is not inventoried or claimed');
});

test('OCI inventory: wrong pin, wrong blob bytes, missing blob and false diff ID refuse', () => {
  const f = layout();
  assert.throws(() => inv.imageInventory(f.files, { childDigest: `sha256:${'e'.repeat(64)}` }), { code: 'OCI_PIN' });
  assert.throws(() => inv.imageInventory(f.files, { indexDigest: `sha256:${'e'.repeat(64)}` }), { code: 'OCI_PIN' });
  const corrupt = new Map(f.files); corrupt.set(`blobs/sha256/${f.layer.digest.slice(7)}`, Buffer.alloc(f.layer.size));
  assert.throws(() => inv.imageInventory(corrupt), { code: 'OCI_BLOB_DIGEST' });
  corrupt.delete(`blobs/sha256/${f.layer.digest.slice(7)}`);
  assert.throws(() => inv.imageInventory(corrupt), { code: 'OCI_BLOB_MISSING' });
  const configRef = f.add({ ...f.config, rootfs: { type: 'layers', diff_ids: [`sha256:${'c'.repeat(64)}`] } }, f.configRef.mediaType);
  const badManifest = f.add({ schemaVersion: 2, config: configRef, layers: [f.layer] }, f.manifest.mediaType);
  f.files.set('index.json', Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [badManifest] })));
  assert.throws(() => inv.imageInventory(f.files), { code: 'OCI_DIFF_ID' });
});

test('OCI inventory: platform comes from verified config, never a tag or collector architecture', () => {
  const f = layout();
  const config = f.add({ ...f.config, architecture: 'amd64' }, f.configRef.mediaType);
  const manifest = f.add({ schemaVersion: 2, config, layers: [f.layer] }, f.manifest.mediaType);
  f.files.set('index.json', Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [manifest] })));
  assert.throws(() => inv.imageInventory(f.files), { code: 'OCI_PLATFORM' });
});

test('OCI inventory: saved tar traversal, duplicate, symlink, checksum and truncated entries refuse', () => {
  assert.equal(inv.archiveFiles(tar([{ name: 'index.json', body: '{}' }])).get('index.json').toString(), '{}');
  for (const rows of [[{ name: '../escape' }], [{ name: '/absolute' }], [{ name: 'duplicate' }, { name: 'duplicate' }],
    [{ name: 'link', type: 50 }], [{ name: 'hardlink', type: 49 }], [{ name: 'pax', type: 120 }]])
    assert.throws(() => inv.archiveFiles(tar(rows)), { code: 'OCI_TAR' });
  const corrupt = tar([{ name: 'index.json', body: '{}' }]); corrupt[0] = 1;
  assert.throws(() => inv.archiveFiles(corrupt), { code: 'OCI_TAR' });
  assert.throws(() => inv.archiveFiles(tar([{ name: 'index.json', body: '{}' }]).subarray(0, 513)), { code: 'OCI_TAR' });
});

test('OCI inventory: final image config has numeric user, exact stdio bin and no port or cache/secrets env', () => {
  const valid = { User: '1000:1000', Entrypoint: ['/usr/local/bin/fireboat'], Cmd: [], WorkingDir: '/opt/fireboat',
    Env: ['PATH=/bin', 'NODE_VERSION=24.22.0', 'YARN_VERSION=1.22.22', 'NODE_ENV=production'] };
  inv.assertImageConfig(valid);
  for (const delta of [{ User: 'node' }, { User: '0:0' }, { ExposedPorts: { '8080/tcp': {} } }, { Volumes: { '/cache': {} } },
    { Entrypoint: ['node'] }, { Cmd: ['--serve'] }, { WorkingDir: '/source' }])
    assert.throws(() => inv.assertImageConfig({ ...valid, ...delta }), { code: 'OCI_IMAGE_CONFIG' });
  for (const env of [['PATH=/bin', 'NODE_VERSION=26.10.0', 'NODE_ENV=production'], [...valid.Env, 'TOKEN=synthetic-canary'], [...valid.Env, 'NODE_OPTIONS=--import /source']])
    assert.throws(() => inv.assertImageConfig({ ...valid, Env: env }), { code: 'OCI_IMAGE_ENV' });
});

async function installedFixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'fireboat-oci-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'node_modules/synthetic-leaf'); await mkdir(packageRoot, { recursive: true });
  const metadata = { name: 'synthetic-leaf', version: '1.0.0', dependencies: {} };
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(metadata));
  await writeFile(join(packageRoot, 'index.js'), 'export const synthetic = true;\n');
  const files = await inv.fileInventory(packageRoot);
  return { root, packageRoot, metadata, document: { schema: 1, component: 'gateway', packages: [{ name: metadata.name, files }] },
    canonical: { schema: 1, platform: { os: 'darwin', arch: 'arm64' }, optional: [], tree: { ...metadata, optional: false, dependencies: [] } } };
}

test('OCI inventory: copied installed files must equal accepted bytes and modes, with exact package membership', async t => {
  const f = await installedFixture(t);
  assert.equal((await inv.verifyInstallation(f.root, f.document, f.canonical, 'gateway')).length, 2);
  await writeFile(join(f.packageRoot, 'index.js'), 'changed');
  await assert.rejects(inv.verifyInstallation(f.root, f.document, f.canonical, 'gateway'), { code: 'OCI_INSTALLED_BYTES' });
  await writeFile(join(f.packageRoot, 'index.js'), 'export const synthetic = true;\n');
  await chmod(join(f.packageRoot, 'index.js'), 0o755);
  await assert.rejects(inv.verifyInstallation(f.root, f.document, f.canonical, 'gateway'), { code: 'OCI_INSTALLED_BYTES' });
  await chmod(join(f.packageRoot, 'index.js'), 0o644);
  await mkdir(join(f.root, 'node_modules/unapproved'));
  await assert.rejects(inv.verifyInstallation(f.root, f.document, f.canonical, 'gateway'), { code: 'OCI_INSTALLED_TREE' });
});

test('OCI inventory: links, nested dependency fallback and native/install-hook packages cannot supply copied bytes', async t => {
  const f = await installedFixture(t);
  await mkdir(join(f.packageRoot, 'node_modules'));
  await assert.rejects(inv.verifyInstallation(f.root, f.document, f.canonical, 'gateway'), { code: 'OCI_INSTALLED_TREE' });
  await rm(join(f.packageRoot, 'node_modules'), { recursive: true });
  await symlink(join(f.packageRoot, 'index.js'), join(f.packageRoot, 'linked.js'));
  await assert.rejects(inv.verifyInstallation(f.root, f.document, f.canonical, 'gateway'), { code: 'OCI_INSTALLED_LINK' });
  await rm(join(f.packageRoot, 'linked.js'));
  for (const delta of [{ cpu: ['arm64'] }, { os: ['darwin'] }, { scripts: { install: 'synthetic-install' } }, { gypfile: true }]) {
    await writeFile(join(f.packageRoot, 'package.json'), JSON.stringify({ ...f.metadata, ...delta }));
    f.document.packages[0]!.files = await inv.fileInventory(f.packageRoot);
    await assert.rejects(inv.verifyInstallation(f.root, f.document, f.canonical, 'gateway'), { code: 'OCI_NONPORTABLE_TREE' });
  }
});

test('OCI inventory: handoff references bind actual byte lengths/hashes and reject interior links', async t => {
  const f = await installedFixture(t), path = 'node_modules/synthetic-leaf/index.js', body = await readFile(join(f.root, path));
  const ref = { path, bytes: body.length, sha256: inv.sha256(body) };
  assert.deepEqual(await inv.checkRef(f.root, ref), body);
  await assert.rejects(inv.checkRef(f.root, { ...ref, sha256: 'a'.repeat(64) }), { code: 'OCI_REFERENCE_CHANGED' });
  await assert.rejects(inv.checkRef(f.root, { ...ref, bytes: body.length + 1 }), { code: 'OCI_REFERENCE_CHANGED' });
  await symlink(join(f.root, 'node_modules'), join(f.root, 'linked'));
  await assert.rejects(inv.checkRef(f.root, { ...ref, path: 'linked/synthetic-leaf/index.js' }), { code: 'OCI_PATH' });
});
