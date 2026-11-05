#!/usr/bin/env node
// Local only: consumes the S9 packet + its offline-installed production bytes.
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { verifyPackageBytes } from '../../scripts/verify-package.ts';
import { BASE, BASE_CHILD, PLATFORM, archiveFiles, assertImageConfig, bytesOf, checkRef, fail, imageInventory,
  regularFile, sha256, verifyInstallation } from './inventory.mjs';
import { buildArgs, docker, flags, runArgs } from './commands.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const ref = (path, body) => ({ path, bytes: body.length, sha256: sha256(body) });
export const DEFERRED_GATES = ['helper-namespace', 'negative-egress', 'proxy', 'redirect', 'attached-stdio-doctor',
  'tasks-18-both-eras', 'startup-shutdown', 'cancellation', 'owned-cleanup'];
export const SUPPLY_CHAIN = ['full-image-sbom', 'base-vulnerability-scan', 'signature', 'provenance', 'registry-manifest'];

export async function verifiedPacket(packet) {
  const manifest = await json(join(packet, 'release-manifest.json'));
  if (manifest.schema !== 'fireboat-release-manifest/1' || !Array.isArray(manifest.files)) fail('OCI_PACKET');
  for (const row of manifest.files) await checkRef(packet, row);
  const handoffBytes = await regularFile(packet, 's10-handoff.json'), handoff = JSON.parse(handoffBytes);
  if (handoff.schema !== 'fireboat-s10-handoff/1' || !isDeepStrictEqual(handoff.binding, manifest.binding) || handoff.artifact.rebuild !== false ||
    handoff.node.indexDigest !== BASE.slice(5) || !handoff.node.platforms.some(p => p.platform === PLATFORM && p.childDigest === BASE_CHILD)) fail('OCI_PACKET_BINDING');
  const tar = await checkRef(packet, handoff.artifact);
  const verified = verifyPackageBytes(await json(join(packet, 'npm-files.json')), await json(join(packet, 'npm-pack.json')), tar);
  if (verified.tarSha256 !== handoff.binding.tarSha256) fail('OCI_PACKET_BINDING');
  for (const row of [...handoff.inventories, ...handoff.locks, ...Object.values(handoff.configuration).filter(v => v?.sha256),
    ...Object.values(handoff.installedTrees).map(v => v.document), ...Object.values(handoff.installedFiles)]) await checkRef(packet, row);
  return { handoff, handoffBytes, tarFiles: verified.files };
}

export async function buildImage({ packet: packetInput, gateway: gatewayInput, out: outputInput }) {
  if (process.versions.node !== '24.22.0') fail('OCI_NODE_VERSION');
  const packet = await realpath(packetInput), gateway = await realpath(gatewayInput), output = resolve(outputInput);
  // No output inside any input or an ancestor of one; exclusive mkdir prevents reuse.
  for (const input of [packet, gateway, here]) {
    if (!relative(input, output).startsWith('..') || !relative(output, input).startsWith('..')) fail('OCI_DESTINATION');
  }
  const { handoff, handoffBytes, tarFiles } = await verifiedPacket(packet);
  const installed = await json(join(packet, handoff.installedFiles.gateway.path));
  const canonical = await json(join(packet, handoff.installedTrees.gateway.document.path));
  const payload = await verifyInstallation(gateway, installed, canonical, 'gateway');
  const main = installed.packages.find(p => p.name === '@fireboat/gateway');
  if (!main || !isDeepStrictEqual(main.files, tarFiles.map(({ body, ...row }) => row)
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) fail('OCI_TAR_INSTALL');
  const lock = await json(join(packet, 'npm-shrinkwrap.json'));
  if (Object.values(lock.packages).some(p => p.os || p.cpu || p.libc || p.optional || p.hasInstallScript)) fail('OCI_NONPORTABLE_TREE');
  await mkdir(output, { mode: 0o700 });
  const put = async (path, value) => { const body = Buffer.isBuffer(value) ? value : bytesOf(value);
    await writeFile(join(output, path), body, { flag: 'wx', mode: 0o600 }); return ref(path, body); };
  const context = join(output, 'context'); await mkdir(context, { mode: 0o700 });
  await writeFile(join(context, 'Dockerfile'), await readFile(join(here, 'Dockerfile')), { flag: 'wx', mode: 0o600 });
  for (const row of payload) {
    const body = await regularFile(gateway, row.path);
    if (body.length !== row.size || sha256(body) !== row.sha256) fail('OCI_INSTALLED_CHANGED');
    const target = join(context, 'runtime', row.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, body, { flag: 'wx', mode: row.mode }); await chmod(target, row.mode);
  }
  const app = await put('image-files.json', payload);
  // The containing evidence directory stays 0700 on the host. A bind-mounted
  // regular file needs read permission for container UID 1000 as well.
  await chmod(join(output, 'image-files.json'), 0o444);
  // Local save only: no manifest inspect/buildx resolver, registry or pull.
  await docker(['image', 'inspect', BASE]);
  await docker(['image', 'save', '--output', join(output, 'node-base.tar'), BASE], { timeout: 120_000 });
  const base = imageInventory(archiveFiles(await readFile(join(output, 'node-base.tar'))), { indexDigest: BASE.slice(5), childDigest: BASE_CHILD });
  const built = await docker(buildArgs(context, output), { timeout: 120_000 });
  await put('build.log', Buffer.from(built.stdout + built.stderr));
  const localId = (await readFile(join(output, 'image-id'), 'utf8')).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(localId)) fail('OCI_IMAGE_ID');
  const inspected = JSON.parse((await docker(['image', 'inspect', localId])).stdout)[0];
  assertImageConfig(inspected.Config);
  await docker(['image', 'save', '--output', join(output, 'image.tar'), localId], { timeout: 120_000 });
  const image = imageInventory(archiveFiles(await readFile(join(output, 'image.tar')))); assertImageConfig(image.config);
  if (!isDeepStrictEqual(image.layers.slice(0, base.layers.length), base.layers)) fail('OCI_BASE_LAYERS');
  const version = await docker([...runArgs(localId, 'none'), localId, '--version']);
  if (version.code !== 0 || version.stderr || !/^fireboat 0\.2\.0-alpha\.1 schema=0\.3 node=24\.22\.0 runtime=(?:recorded|unverified)\n$/.test(version.stdout)) fail('OCI_VERSION_SMOKE');
  const mounts = [[join(here, 'probe.mjs'), '/s10/probe.mjs'], [join(output, 'image-files.json'), '/s10/image-files.json']];
  const hardening = await docker([...runArgs(localId, 'none', mounts), '--entrypoint', '/usr/local/bin/node', localId, '/s10/probe.mjs']);
  const files = await docker([...runArgs(localId, 'none', mounts), '--entrypoint', '/usr/local/bin/node', localId, '/s10/probe.mjs', 'files']);
  const smoke = { status: 'passed', network: 'none', version: version.stdout.trim(), hardening: JSON.parse(hardening.stdout), files: JSON.parse(files.stdout) };
  const compose = await put('compose.yaml', await readFile(join(here, 'compose.yaml')));
  await put('s10-container.config.json', await checkRef(packet, handoff.configuration.container));
  const recipes = [];
  for (const name of ['Dockerfile', 'compose.yaml', 'build.mjs', 'inventory.mjs', 'commands.mjs', 'probe.mjs', 'run-gates.mjs', 'session.mjs', 'bridge.mjs', 'fixture.mjs'])
    recipes.push(ref(name, await readFile(join(here, name))));
  const inventory = { schema: 'fireboat-oci-inventory/1', platform: PLATFORM, base, image: { localId, ...image }, application: app,
    upstreamHandoff: ref('s10-handoff.json', handoffBytes), recipes, smoke,
    portability: { sourceCell: installed.platform, imageCell: { os: 'linux', arch: 'arm64' },
      basis: 'byte-identical JavaScript-only production packages; platform selectors/native binaries/install hooks rejected',
      completeLinuxTaskCell: 'unverified' },
    gates: DEFERRED_GATES.map(gate => ({ gate, status: 'unverified' })),
    supplyChain: SUPPLY_CHAIN.map(gate => ({ gate, status: 'unverified' })) };
  const inventoryRef = await put('inventory.json', inventory);
  // Preserve the complete upstream binding. New S10 observations have a separate
  // binding; mutating its metadata-only Node fields would stale every S9 report.
  const result = structuredClone(handoff);
  result.node.status = 'local-arm64-inventory-and-version-verified; other-cells-unverified';
  Object.assign(result.node.platforms.find(p => p.platform === PLATFORM), {
    configDigest: base.configDigest, layers: base.layers, execution: 'version-smoke-verified; full-S10-unverified' });
  result.node.missing = ['linux/amd64 acquisition/inventory/execution', 'native full S10 execution evidence'];
  result.topology.containerCompose = { ...compose, status: 'recipe-present; execution-unverified' };
  result.topology.status = 'recipe-present; namespace-and-task-execution-unverified';
  result.oci = { inventory: inventoryRef, localId, manifestDigest: image.manifestDigest, configDigest: image.configDigest,
    upstreamHandoffSha256: sha256(handoffBytes), artifactBindingSha256: sha256(bytesOf(handoff.binding)),
    smoke, gates: inventory.gates, supplyChain: inventory.supplyChain, publishAuthorized: false };
  result.missing = handoff.missing.filter(v => !['Node config descriptors/layer inventory', 'approved acquisition and local digest verification',
    'S10 compose recipe/hash and native hardening/egress/attached-stdio checks',
    'S10 OCI layout digest, image SBOM, base scan, signature and provenance verification'].includes(v));
  result.missing.push('linux/amd64 Node inventory/execution unverified', ...DEFERRED_GATES.map(g => `S10:${g}:unverified`), ...SUPPLY_CHAIN.map(g => `S10:${g}:unverified`));
  await put('s10-handoff.json', result);
  console.log(`OCI_BUILD_OK platform=${PLATFORM} local=${localId} manifest=${image.manifestDigest} config=${image.configDigest} files=${payload.length}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = flags(process.argv.slice(2), ['--packet', '--gateway-install', '--out']);
    await buildImage({ packet: args['--packet'], gateway: args['--gateway-install'], out: args['--out'] });
  } catch (error) { console.error(`OCI_BUILD_FAILED ${/^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'OCI_FAILED'}`); process.exitCode = 1; }
}
