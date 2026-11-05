// Built-ins only. No Docker daemon, network, extraction or execution on import.
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';

export const BASE = 'node@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4';
export const BASE_CHILD = 'sha256:d08986ea245c466d3dfa608f4a840313148e01a1014d4c324212781fae7fe1d1';
export const PLATFORM = 'linux/arm64';
export const CLI = '/opt/fireboat/node_modules/@fireboat/gateway/dist/packages/server/src/cli.js';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const bytesOf = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export const fail = code => { throw Object.assign(new Error(code), { code }); };
const equal = isDeepStrictEqual;
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
export const relativePath = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 &&
  !isAbsolute(value) && !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..');

/** Refuse links at every component, not just the final regular file. */
export async function regularFile(root, path) {
  if (!relativePath(path)) fail('OCI_PATH');
  let current = root;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (i === parts.length - 1 ? !info.isFile() : !info.isDirectory())) fail('OCI_PATH');
  }
  return readFile(current);
}
export async function checkRef(root, ref) {
  if (!ref || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || !/^[a-f0-9]{64}$/.test(ref.sha256)) fail('OCI_REFERENCE');
  const body = await regularFile(root, ref.path);
  if (body.length !== ref.bytes || sha256(body) !== ref.sha256) fail('OCI_REFERENCE_CHANGED');
  return body;
}

/** Docker's local OCI save tar only: no links, PAX, duplicate names or extraction. */
export function archiveFiles(tar) {
  const files = new Map(), names = new Set();
  const field = bytes => bytes.toString('utf8').replace(/\0.*$/s, '');
  const octal = bytes => {
    const value = field(bytes).trim();
    if (!/^[0-7]+$/.test(value)) fail('OCI_TAR');
    const number = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(number)) fail('OCI_TAR');
    return number;
  };
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every(byte => byte === 0)) fail('OCI_TAR');
      return files;
    }
    const sum = header.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
    if (sum !== octal(header.subarray(148, 156))) fail('OCI_TAR');
    const prefix = field(header.subarray(345, 500)), name = (prefix ? `${prefix}/` : '') + field(header.subarray(0, 100));
    const type = header[156], directory = type === 53, path = directory ? name.replace(/\/$/, '') : name;
    if (!relativePath(path) || names.has(path) || ![0, 48, 53].includes(type)) fail('OCI_TAR');
    names.add(path);
    const size = octal(header.subarray(124, 136)), start = offset + 512;
    if (start + size > tar.length || directory && size !== 0) fail('OCI_TAR');
    if (!directory) files.set(path, tar.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  fail('OCI_TAR');
}

/** Verify selected platform blobs against immutable descriptors AND uncompressed diff IDs.
 * An incomplete save of other platforms never supplies evidence for those cells. */
export function imageInventory(files, options = {}) {
  const parse = body => { try { return JSON.parse(body.toString('utf8')); } catch { fail('OCI_JSON'); } };
  const get = path => files.get(path) ?? fail('OCI_BLOB_MISSING');
  if (parse(get('oci-layout')).imageLayoutVersion !== '1.0.0') fail('OCI_LAYOUT');
  const blob = descriptor => {
    if (!descriptor || !digest(descriptor.digest) || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0) fail('OCI_DESCRIPTOR');
    const body = get(`blobs/sha256/${descriptor.digest.slice(7)}`);
    if (body.length !== descriptor.size || `sha256:${sha256(body)}` !== descriptor.digest) fail('OCI_BLOB_DIGEST');
    return body;
  };
  const exported = parse(get('index.json'));
  if (exported.schemaVersion !== 2 || exported.manifests?.length !== 1) fail('OCI_LAYOUT');
  let descriptor = exported.manifests[0], indexDigest = null, child;
  let manifest = parse(blob(descriptor));
  if (manifest.manifests) {
    indexDigest = descriptor.digest;
    const selected = manifest.manifests.filter(row => row.platform?.os === 'linux' && row.platform?.architecture === 'arm64');
    if (selected.length !== 1) fail('OCI_PLATFORM');
    descriptor = selected[0]; manifest = parse(blob(descriptor));
  }
  child = descriptor.digest;
  if (options.indexDigest && indexDigest !== options.indexDigest || options.childDigest && child !== options.childDigest) fail('OCI_PIN');
  const configBytes = blob(manifest.config), config = parse(configBytes);
  if (manifest.schemaVersion !== 2 || config.os !== 'linux' || config.architecture !== 'arm64' ||
    config.rootfs?.type !== 'layers' || !Array.isArray(manifest.layers) ||
    !equal(config.rootfs.diff_ids?.length, manifest.layers.length)) fail('OCI_PLATFORM');
  const layers = manifest.layers.map((layer, i) => {
    const body = blob(layer);
    let uncompressed;
    if (['application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.docker.image.rootfs.diff.tar.gzip'].includes(layer.mediaType))
      uncompressed = gunzipSync(body, { maxOutputLength: 512 * 1024 * 1024 });
    else if (['application/vnd.oci.image.layer.v1.tar', 'application/vnd.docker.image.rootfs.diff.tar'].includes(layer.mediaType)) uncompressed = body;
    else fail('OCI_LAYER_TYPE');
    const diffId = `sha256:${sha256(uncompressed)}`;
    if (diffId !== config.rootfs.diff_ids[i]) fail('OCI_DIFF_ID');
    return { digest: layer.digest, bytes: layer.size, mediaType: layer.mediaType, diffId, uncompressedBytes: uncompressed.length };
  });
  return { platform: PLATFORM, indexDigest, manifestDigest: child, configDigest: manifest.config.digest,
    configBytes: configBytes.length, layers, config: config.config, runtime: { os: config.os, arch: config.architecture },
    layoutIndexSha256: sha256(get('index.json')) };
}

export function assertImageConfig(config) {
  if (config.User !== '1000:1000' || !equal(config.Entrypoint, ['/usr/local/bin/fireboat']) ||
    config.Cmd != null && !equal(config.Cmd, []) || config.WorkingDir !== '/opt/fireboat' ||
    Object.keys(config.ExposedPorts ?? {}).length || Object.keys(config.Volumes ?? {}).length ||
    Object.keys(config.Labels ?? {}).some(k => /secret|token|credential/i.test(k))) fail('OCI_IMAGE_CONFIG');
  const allowed = new Set(['PATH', 'NODE_VERSION', 'YARN_VERSION', 'NODE_ENV']);
  if (!Array.isArray(config.Env) || config.Env.some(e => !allowed.has(e.split('=')[0])) ||
    !config.Env.includes('NODE_VERSION=24.22.0') || !config.Env.includes('NODE_ENV=production')) fail('OCI_IMAGE_ENV');
}

export async function fileInventory(root, packageOwned = false) {
  const rows = [];
  async function walk(path) {
    for (const name of (await readdir(join(root, path))).sort()) {
      if (packageOwned && path === '' && name === 'node_modules') continue;
      const child = path ? `${path}/${name}` : name, info = await lstat(join(root, child));
      if (info.isSymbolicLink()) fail('OCI_INSTALLED_LINK');
      if (info.isDirectory()) await walk(child);
      else if (info.isFile()) rows.push({ path: child, size: info.size, mode: info.mode & 0o777,
        sha256: sha256(await regularFile(root, child)) });
      else fail('OCI_INSTALLED_SPECIAL');
    }
  }
  await walk(''); return rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Package-owned files in the externally accepted installed inventory. No .bin links or harness. */
export async function verifyInstallation(root, document, canonical, component) {
  if (document.schema !== 1 || document.component !== component || canonical.optional?.length !== 0) fail('OCI_INSTALLED_TREE');
  const nodes = new Map();
  const visit = node => {
    if (node.optional || !/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(node.name)) fail('OCI_INSTALLED_TREE');
    if (nodes.has(node.name) && !equal(nodes.get(node.name), node)) fail('OCI_INSTALLED_TREE');
    nodes.set(node.name, node); node.dependencies.forEach(visit);
  };
  visit(canonical.tree);
  if (!equal(document.packages.map(p => p.name).sort(), [...nodes.keys()].sort())) fail('OCI_INSTALLED_TREE');
  const payload = [];
  for (const pkg of document.packages) {
    const prefix = component === 'quickstart' && pkg.name === canonical.tree.name ? '' : `node_modules/${pkg.name}`;
    await regularFile(root, prefix ? `${prefix}/package.json` : 'package.json');
    const directory = join(root, prefix);
    if (prefix) {
      const nested = await lstat(join(directory, 'node_modules')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (nested) fail('OCI_INSTALLED_TREE');
    }
    const actual = await fileInventory(directory, true);
    if (!equal(actual, pkg.files)) fail('OCI_INSTALLED_BYTES');
    const metadata = JSON.parse((await regularFile(directory, 'package.json')).toString('utf8')), node = nodes.get(pkg.name);
    if (metadata.name !== node.name || metadata.version !== node.version || metadata.os || metadata.cpu || metadata.libc ||
      metadata.gypfile || pkg.files.some(row => /\.(?:node|so|dylib|dll)$/.test(row.path)) ||
      ['preinstall', 'install', 'postinstall'].some(key => metadata.scripts?.[key])) fail('OCI_NONPORTABLE_TREE');
    for (const row of pkg.files) payload.push({ ...row, path: prefix ? `${prefix}/${row.path}` : row.path });
  }
  // Exact installed package membership, permitting only npm's shims/hidden lock.
  const entries = await readdir(join(root, 'node_modules'), { withFileTypes: true }), names = [];
  for (const entry of entries) {
    if (['.bin', '.package-lock.json'].includes(entry.name)) continue;
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const child of await readdir(join(root, 'node_modules', entry.name))) names.push(`${entry.name}/${child}`);
    } else names.push(entry.name);
  }
  const expectedNames = [...nodes.keys()].filter(name => component !== 'quickstart' || name !== canonical.tree.name).sort();
  if (!equal(names.sort(), expectedNames)) fail('OCI_INSTALLED_TREE');
  return payload.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
