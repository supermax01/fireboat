#!/usr/bin/env node
// Offline external release packet. Never installs, rebuilds, serves, fetches, or publishes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { validateExpectedInventory } from './package-inventory.ts';
import { ROOT, sha256, snapshotInputs, verifyStagedDirectory } from './stage-package.ts';
import { verifyInstalledTree, verifyPackage } from './verify-package.ts';
import { validateNoticeInventory } from './release-licenses.mjs';

export class ReleaseFault extends Error {
  constructor(code) { super(code); this.name = 'ReleaseFault'; this.code = code; }
}
const fault = code => new ReleaseFault(code);
const bytesOf = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value, keys) => record(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
// Release evidence/source and upstream dependency-owned files are not the gateway
// tar allowlist: upstream packages legitimately contain maps, types and tests.
const safeRelativePath = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 &&
  !isAbsolute(value) && !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..');
const safeEvidencePath = value => safeRelativePath(value) && value.split('/').every(p =>
  !['.git', '.local'].includes(p) && !/^\.env(?:\.|$)/i.test(p) && !/^(?:credentials|secrets?)(?:\.|$)/i.test(p));
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const TOOLCHAIN = { node: '24.22.0', npm: '11.19.1' };
export const GATES = [
  'local-check', 'isolation', 'evals-both-eras', 'docs-contract-catalog', 'independent-review',
  'mutation-14-shard', 'b2-200', 'installed-tasks-both-eras', 'runtime-platform-cells',
  'installed-g-host', 'g-backend', 'g-human', 'audit-disposition', 'redistribution-review',
  's10-oci', 's11-measurement', 's12-release-ci',
];
export const OWNER_ACTS = [
  'Confirm control of @fireboat, exact package availability and the publishing principal.',
  'Confirm control of io.github.supermax01/fireboat (mcpName) before the final pack; separately approve any Registry entry.',
  'Approve repository rename, final public repository URL, visibility, and curated versus full reviewed history.',
  'Decide the Node engines floor; the candidate still declares >=24.',
  'Approve seed/terminology redistribution, dependency rights, copyright holder, required notices, maintenance and security contacts.',
  'Name the G-HUMAN reviewer and approve the exact core/claims file list and findings disposition.',
  'Approve private-candidate to publishable-stage transition, then new pack, hashes and affected S9/S10 verification.',
  'Choose the release CI billing/public-runner route and authorize the one manual verification run on the frozen candidate.',
  'Configure the protected npm-alpha environment, trusted publisher and public repository binding; settle first-publish OIDC bootstrap.',
  'Approve Node/other OCI acquisition and tested platforms before S10 execution; no implicit pulls.',
  'Decide landing procedure, first public step, final version and release review budget.',
  'Approve each concrete publication separately: source visibility, tag, npm alpha, OCI push, Registry entry and announcement.',
];
const HISTORY = [
  ['g-host', 'docs/evidence/g-host-claude-code-2026-10-23.md'],
  ['g-backend', 'docs/evidence/g-backend-hapi-qualification-2026-10-23.md'],
  ['seed-generation', 'docs/evidence/synthea-jdk-acquisition-2026-10-24.md'],
  ['seed-exploration', 'docs/evidence/quickstart-seed-exploration-2026-10-24.md'],
];

/** Refuse links in every relative path component, including evidence and installed texts. */
async function regularFile(root, path) {
  if (!safeRelativePath(path)) throw fault('RELEASE_PATH');
  let current = root;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (i === parts.length - 1 ? !info.isFile() : !info.isDirectory())) throw fault('RELEASE_PATH');
  }
  return readFile(current);
}
const ref = (path, body) => ({ path, bytes: body.byteLength, sha256: sha256(body) });
async function fileRef(root, path) { return ref(path, await regularFile(root, path)); }

/** Canonical package-owned bytes: no timestamps/absolute paths or nested installed packages. */
export async function installedFiles(root) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw fault('INSTALLED_LINK');
  const files = [];
  const walk = async path => {
    for (const name of (await readdir(join(root, path))).sort(order)) {
      const child = path ? `${path}/${name}` : name, info = await lstat(join(root, child));
      if (info.isSymbolicLink()) throw fault('INSTALLED_LINK');
      if (!path && name === 'node_modules' && info.isDirectory()) continue;
      if (info.isDirectory()) await walk(child);
      else if (info.isFile()) files.push({ path: child, size: info.size, mode: info.mode % 0o1000,
        sha256: sha256(await regularFile(root, child)) });
      else throw fault('INSTALLED_SPECIAL');
    }
  };
  await walk(''); return files.sort((a, b) => order(a.path, b.path));
}
async function verifyPayload(root, expected) {
  const actual = await installedFiles(root);
  if (!isDeepStrictEqual(actual, [...expected].sort((a, b) => order(a.path, b.path)))) throw fault('INSTALLED_PAYLOAD_CHANGED');
  return sha256(JSON.stringify(actual));
}

function graphNodes(canonical) {
  const result = new Map();
  const visit = node => {
    const key = `${node.name}@${node.version}`;
    const previous = result.get(key);
    if (previous && !isDeepStrictEqual(previous, node)) throw fault('SBOM_TREE');
    result.set(key, node); node.dependencies.forEach(visit);
  };
  visit(canonical.tree); return result;
}

/** npm's installed-tree CycloneDX 1.5, with volatile UUID/time removed and install harness excluded.
 * The complete component/edge/SRI set must equal the independently verified installed graph.
 */
export function normalizeInstalledSbom(raw, canonical) {
  if (raw?.bomFormat !== 'CycloneDX' || raw.specVersion !== '1.5' || raw.version !== 1 ||
    !Array.isArray(raw.components) || !Array.isArray(raw.dependencies) ||
    raw.metadata?.lifecycles?.length !== 1 || raw.metadata.lifecycles[0].phase !== 'build' ||
    !raw.metadata.tools?.some(t => t.name === 'cli' && t.vendor === 'npm' && t.version === TOOLCHAIN.npm)) throw fault('SBOM_FORMAT');
  const nodes = graphNodes(canonical), rootKey = `${canonical.tree.name}@${canonical.tree.version}`;
  const all = [raw.metadata.component, ...raw.components], components = new Map(), edges = new Map();
  for (const component of all) {
    if (!record(component) || components.has(component['bom-ref'])) throw fault('SBOM_TREE');
    components.set(component['bom-ref'], component);
  }
  for (const row of raw.dependencies) {
    if (!record(row) || edges.has(row.ref) || !Array.isArray(row.dependsOn) || new Set(row.dependsOn).size !== row.dependsOn.length) throw fault('SBOM_TREE');
    edges.set(row.ref, row.dependsOn);
  }
  // A gateway installed in an empty consumer project has precisely one extra harness root.
  const harness = raw.metadata.component['bom-ref'];
  const wanted = new Set([...nodes.keys(), harness]);
  if (components.size !== wanted.size || [...components.keys()].some(k => !wanted.has(k)) ||
    edges.size !== wanted.size || [...edges.keys()].some(k => !wanted.has(k)) ||
    (harness !== rootKey && !isDeepStrictEqual(edges.get(harness), [rootKey]))) throw fault('SBOM_TREE');
  for (const [key, node] of nodes) {
    const component = components.get(key);
    // npm uses the directory basename as node.name for a project root, while its
    // bom-ref and purl use packageName. Bind those identities before normalizing it.
    const projectRoot = key === rootKey && key === harness;
    if (!component || (!projectRoot && component.name !== node.name) ||
      (projectRoot && component.purl !== `pkg:npm/${node.name.replace(/^@/, '%40')}@${node.version}`) || component.version !== node.version || component.scope !== 'required' ||
      component.properties?.some(p => ['cdx:npm:package:development', 'cdx:npm:package:extraneous'].includes(p.name) && p.value === 'true')) throw fault('SBOM_TREE');
    if (node.integrity && !component.hashes?.some(h => h.alg === 'SHA-512' && h.content === Buffer.from(node.integrity.slice(7), 'base64').toString('hex'))) throw fault('SBOM_INTEGRITY');
    if (!isDeepStrictEqual([...(edges.get(key) ?? [])].sort(order), node.dependencies.map(n => `${n.name}@${n.version}`).sort(order))) throw fault('SBOM_TREE');
  }
  const { timestamp: _timestamp, ...metadata } = raw.metadata;
  const { serialNumber: _serial, ...bom } = raw;
  const root = { ...components.get(rootKey), name: canonical.tree.name };
  // npm records the local acceptance tar's absolute file: URL. The packet carries
  // those same bytes as gateway.tgz; never publish a workstation path in the BOM.
  root.externalReferences = (root.externalReferences ?? []).map(r => r.type === 'distribution' && r.url.startsWith('file:') ? { ...r, url: 'gateway.tgz' } : r);
  return { ...bom, metadata: { ...metadata, component: root },
    components: [...nodes.keys()].filter(k => k !== rootKey).sort(order).map(k => components.get(k)),
    dependencies: [...nodes.keys()].sort(order).map(key => ({ ref: key, dependsOn: [...edges.get(key)].sort(order) })) };
}

/** Exact binding, not a subset match. Missing/extra fields and every platform/input difference refuse. */
export function sameArtifactBinding(inputs, reports) {
  return Array.isArray(reports) && reports.every(report => isDeepStrictEqual(report.binding, inputs));
}
export async function bindReports(inputs, reports, evidenceRoot) {
  if (!Array.isArray(reports) || reports.length > GATES.length) throw fault('REPORT_INVALID');
  const seen = new Set();
  for (const report of reports) {
    if (!closed(report, ['gate', 'status', 'binding', 'evidence']) || !GATES.includes(report.gate) || seen.has(report.gate) ||
      !['passed', 'failed'].includes(report.status) || !Array.isArray(report.evidence) || !report.evidence.length || report.evidence.length > 64 ||
      report.evidence.some(r => !closed(r, ['path', 'sha256']) || !safeEvidencePath(r.path) || !digest(r.sha256))) throw fault('REPORT_INVALID');
    seen.add(report.gate);
  }
  if (!sameArtifactBinding(inputs, reports)) throw fault('EVIDENCE_STALE');
  const accepted = [];
  for (const report of reports) {
    const evidence = [];
    for (const row of report.evidence) {
      const body = await regularFile(evidenceRoot, row.path);
      if (sha256(body) !== row.sha256) throw fault('EVIDENCE_CHANGED');
      evidence.push(ref(row.path, body));
    }
    accepted.push({ gate: report.gate, status: report.status, evidence });
  }
  return GATES.map(gate => accepted.find(r => r.gate === gate) ?? { gate, status: 'missing', evidence: [] });
}

/** Pins are read from repository evidence. A changed/missing row never becomes a made-up digest. */
export function nodeRuntimePins(design) {
  const rows = design.split('\n').filter(line => line.startsWith('| Node `24.22.0-bookworm-slim` |'));
  const match = rows.length === 1 && /^\| Node `([^`]+)` \| `(sha256:[a-f0-9]{64})` \| `(sha256:[a-f0-9]{64})` \/ ([\d,]+) \| `(sha256:[a-f0-9]{64})` \/ ([\d,]+) \|$/.exec(rows[0]);
  if (!match) return { image: 'node:24.22.0-bookworm-slim', status: 'missing', indexDigest: null, platforms: [], missing: ['Node index/children evidence'] };
  return { image: `node:${match[1]}`, status: 'metadata-only', indexDigest: match[2],
    platforms: [['linux/arm64', match[3], match[4]], ['linux/amd64', match[5], match[6]]].map(([platform, childDigest, bytes]) =>
      ({ platform, childDigest, compressedBytes: Number(bytes.replaceAll(',', '')), configDigest: null, layers: null, execution: 'unverified' })),
    missing: ['Node config descriptors/layer inventory', 'approved acquisition and local digest verification', 'native S10 execution evidence'] };
}
export function s10Configurations(host) {
  if (!record(host) || host.mode !== 'synthetic' || host.source?.baseUrl !== 'http://127.0.0.1:18080/fhir') throw fault('S10_CONFIG');
  const container = structuredClone(host); container.source.baseUrl = 'http://127.0.0.1:8080/fhir';
  return { host: bytesOf(host), container: bytesOf(container) };
}

// Always explicit offline/ignore-scripts/actual-tree. No install or shell interpolation seam.
export function npmRead(npmCli, cwd, args) {
  if (!isAbsolute(npmCli)) throw fault('NPM_CLI');
  const result = spawnSync(process.execPath, [npmCli, ...args, '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', npm_config_offline: 'true', npm_config_ignore_scripts: 'true',
        npm_config_package_lock_only: 'false', npm_config_workspaces: 'false' } });
  if (result.status !== 0 || result.error) throw fault('NPM_READ_FAILED');
  return result.stdout;
}

export async function releaseDestination(path, protectedRoots, sourceRoot) {
  if (!isAbsolute(path)) throw fault('RELEASE_DESTINATION');
  const out = join(await realpath(dirname(path)), basename(path));
  for (const root of protectedRoots) {
    const canonical = await realpath(root);
    if (out === canonical || out.startsWith(`${canonical}/`)) throw fault('RELEASE_DESTINATION');
  }
  if (sourceRoot) {
    const root = await realpath(sourceRoot), artifacts = join(root, 'artifacts/m3b-release');
    if ((out === root || out.startsWith(`${root}/`)) && out !== artifacts && !out.startsWith(`${artifacts}/`)) throw fault('RELEASE_DESTINATION');
  }
  return out;
}

/** Completeness includes every observed package-owned license/NOTICE, not only approved filenames. */
export function verifyInstalledLicenseFiles(dependency, files) {
  const observed = files.filter(f => /^(?:licen[sc]e|copying|notice)(?:[._-].*)?$/i.test(basename(f.path)))
    .map(f => ({ source: f.path, kind: /^notice(?:[._-].*)?$/i.test(basename(f.path)) ? 'notice' : 'license', bytes: f.size, sha256: f.sha256 }));
  const wanted = dependency.texts.map(t => ({ source: t.source, kind: t.kind, bytes: t.bytes, sha256: t.sha256 }));
  if (!isDeepStrictEqual(observed.sort((a, b) => order(a.source, b.source)), wanted.sort((a, b) => order(a.source, b.source)))) throw fault('LICENSE_TEXTS_CHANGED');
}
export function verifyInstalledTarOrigin(hidden, name, version, integrity) {
  const row = hidden?.packages?.[`node_modules/${name}`];
  if (!row || row.version !== version || row.integrity !== integrity || row.link || row.dev) throw fault('INSTALLED_TAR_MISMATCH');
}

async function componentInventory(installation, component, canonical, inventory) {
  const directories = new Map(), files = [];
  if (component === 'gateway') directories.set(canonical.tree.name, join(installation, 'node_modules', canonical.tree.name));
  else directories.set(canonical.tree.name, installation);
  for (const node of graphNodes(canonical).values()) {
    if (!directories.has(node.name)) directories.set(node.name, join(installation, 'node_modules', node.name));
  }
  // Verify ancestry as well as package-owned children; a linked node_modules
  // directory must not make a checkout tree look like a separate installation.
  for (const [name, path] of directories) await regularFile(installation,
    path === installation ? 'package.json' : `node_modules/${name}/package.json`);
  const ownedFiles = new Map();
  for (const [name, path] of [...directories].sort(([a], [b]) => order(a, b))) {
    const rows = await installedFiles(path); ownedFiles.set(name, rows); files.push({ name, files: rows });
  }
  const licenses = inventory.dependencies.filter(d => d.components.includes(component));
  const expectedNames = [...graphNodes(canonical).values()].filter(n => n !== canonical.tree).map(n => n.name).sort(order);
  if (!isDeepStrictEqual(licenses.map(d => d.name).sort(order), expectedNames)) throw fault('LICENSE_TREE');
  for (const dependency of licenses) {
    const path = directories.get(dependency.name), pkg = await json(join(path, 'package.json'));
    const node = [...graphNodes(canonical).values()].find(n => n.name === dependency.name);
    if (dependency.version !== pkg.version || dependency.license !== pkg.license || dependency.integrity !== node.integrity) throw fault('LICENSE_TREE');
    verifyInstalledLicenseFiles(dependency, ownedFiles.get(dependency.name));
    for (const text of dependency.texts) {
      const body = await regularFile(path, text.source);
      if (sha256(body) !== text.sha256 || body.byteLength !== text.bytes) throw fault('LICENSE_TEXT_CHANGED');
    }
  }
  return { schema: 1, component, platform: canonical.platform, packages: files };
}

/** Mandatory real installed inputs. Output is always an incomplete private candidate packet, never a publish permit. */
export async function releaseManifest(options) {
  const root = resolve(options.root ?? ROOT);
  for (const key of ['stage', 'tar', 'packJson', 'gatewayInstall', 'helperInstall', 'out', 'npmCli'])
    if (typeof options[key] !== 'string' || !isAbsolute(options[key])) throw fault('RELEASE_USAGE');
  if (!/^[a-f0-9]{40}$/.test(options.revision ?? '') || process.versions.node !== TOOLCHAIN.node ||
    npmRead(options.npmCli, root, ['--version']).trim() !== TOOLCHAIN.npm) throw fault('RELEASE_TOOLCHAIN');
  const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 });
  if (head.status !== 0 || head.stdout.trim() !== options.revision) throw fault('RELEASE_REVISION');
  // Both installs and the stage are separate real directories; checkout resolution cannot masquerade as an install.
  const stage = await realpath(options.stage), gateway = await realpath(options.gatewayInstall), helper = await realpath(options.helperInstall);
  if ([stage, gateway, helper].some(p => p === root || p.startsWith(`${root}/`)) || new Set([stage, gateway, helper]).size !== 3) throw fault('RELEASE_INSTALLATION');
  const out = await releaseDestination(options.out, [stage, gateway, helper], root);
  const initialInputs = await snapshotInputs(root);
  const verified = await verifyPackage({ root, stage, tar: options.tar, packJson: options.packJson });
  const expected = validateExpectedInventory(await json(join(root, 'packaging/npm-files.json')));
  const helperExpected = validateExpectedInventory(await json(join(root, 'packaging/helper-files.json')));
  const installedGateway = join(gateway, 'node_modules', expected.identity.name);
  await verifyStagedDirectory(installedGateway, expected);
  await verifyPayload(helper, helperExpected.files);
  const pkg = await json(join(stage, 'package.json'));
  if (pkg.private !== true || pkg.mcpName !== 'io.github.supermax01/fireboat' || expected.files.some(f => f.path.endsWith('server.json'))) throw fault('RELEASE_IDENTITY');
  const inventory = validateNoticeInventory(await json(join(stage, 'licenses/inventory.json')));
  const design = await regularFile(root, 'proposals/m3b-s8s9-design.md');
  const node = nodeRuntimePins(design.toString('utf8'));
  const configs = s10Configurations(await json(join(stage, 'quickstart/examples/quickstart/config.json')));
  const output = new Map();
  const put = (path, body) => { output.set(path, Buffer.isBuffer(body) ? body : bytesOf(body)); return ref(path, output.get(path)); };
  put('gateway.tgz', await readFile(options.tar));
  if (sha256(output.get('gateway.tgz')) !== verified.tarSha256) throw fault('RELEASE_INPUT_CHANGED');
  const tarIntegrity = `sha512-${createHash('sha512').update(output.get('gateway.tgz')).digest('base64')}`;
  verifyInstalledTarOrigin(JSON.parse(await regularFile(gateway, 'node_modules/.package-lock.json')), pkg.name, pkg.version, tarIntegrity);
  put('npm-pack.json', await readFile(options.packJson));
  put('npm-files.json', await readFile(join(root, 'packaging/npm-files.json')));
  put('helper-files.json', await readFile(join(root, 'packaging/helper-files.json')));
  put('npm-shrinkwrap.json', await regularFile(stage, 'npm-shrinkwrap.json'));
  put('helper-package-lock.json', await regularFile(stage, 'quickstart/package-lock.json'));
  put('licenses.json', await regularFile(stage, 'licenses/inventory.json'));
  const source = [];
  for (const path of ['proposals/m3b-s8s9-design.md', 'proposals/release-plan.md', 'docs/M3B-STATUS.md', 'docs/RELEASE.md', '.github/workflows/release-npm.yml']) source.push(await fileRef(root, path));
  put('source-inputs.json', { schema: 1, revision: options.revision, stagedInputs: initialInputs, releaseDesign: source });
  put('s10-host.config.json', configs.host); put('s10-container.config.json', configs.container);
  const trees = {}, installed = {};
  for (const [component, directory] of [['gateway', gateway], ['quickstart', helper]]) {
    const ls = JSON.parse(npmRead(options.npmCli, directory, ['ls', '--omit=dev', '--all', '--long', '--json']));
    const tree = await verifyInstalledTree(directory, ls, component, root);
    const sbom = normalizeInstalledSbom(JSON.parse(npmRead(options.npmCli, directory, ['sbom', '--omit=dev', '--sbom-format=cyclonedx', '--package-lock-only=false'])), tree.canonical);
    const packageFiles = await componentInventory(directory, component, tree.canonical, inventory);
    trees[component] = { sha256: tree.sha256, document: put(`${component}-tree.json`, tree.canonical) };
    installed[component] = put(`${component}-installed-files.json`, packageFiles);
    put(`${component}.cdx.json`, sbom);
  }
  const assets = [];
  for (const row of expected.files.filter(f => /^(?:dist\/.*\.json|docs\/.*\.json|quickstart\/.*\.(?:json|yaml|ndjson|properties))$/.test(f.path)))
    assets.push({ ...ref(row.path, await regularFile(stage, row.path)), mode: row.mode });
  const compose = await fileRef(stage, 'quickstart/compose.quickstart.yaml');
  const backend = await json(join(stage, 'quickstart/examples/quickstart/backend-evidence.json'));
  const backendManifest = JSON.parse(backend.imageManifestJson);
  const backendConfig = backend.imageConfigJson;
  if (backendManifest.config.digest !== `sha256:${sha256(backendConfig)}`) throw fault('BACKEND_PIN');
  const hapi = { platform: backend.platform, indexDigest: backend.imageIndexDigest,
    childDigest: `sha256:${sha256(backend.imageManifestJson)}`, configDigest: backendManifest.config.digest,
    evidence: await fileRef(stage, 'quickstart/examples/quickstart/backend-evidence.json'), execution: 'historical-only' };
  const inputs = { schema: 'fireboat-artifact-binding/1', revision: options.revision,
    sourceInputsSha256: sha256(output.get('source-inputs.json')), runtime: { ...TOOLCHAIN, os: process.platform, arch: process.arch },
    tarSha256: verified.tarSha256, tarIntegrity,
    packJsonSha256: sha256(output.get('npm-pack.json')),
    inventorySha256: verified.inventorySha256, inventoryDocumentSha256: sha256(output.get('npm-files.json')),
    shrinkwrapSha256: sha256(output.get('npm-shrinkwrap.json')), helperLockSha256: sha256(output.get('helper-package-lock.json')),
    helperFilesSha256: sha256(JSON.stringify(helperExpected.files)), helperInventoryDocumentSha256: sha256(output.get('helper-files.json')),
    gatewayTreeSha256: trees.gateway.sha256, helperTreeSha256: trees.quickstart.sha256,
    gatewayInstalledFilesSha256: installed.gateway.sha256, helperInstalledFilesSha256: installed.quickstart.sha256,
    licensesSha256: sha256(output.get('licenses.json')), assets, compose,
    hostConfigSha256: sha256(configs.host), containerConfigSha256: sha256(configs.container), node, hapi };
  let reports = [];
  if (options.reports) {
    const envelope = await json(options.reports);
    if (!closed(envelope, ['schema', 'reports']) || envelope.schema !== 1) throw fault('REPORT_INVALID');
    reports = envelope.reports;
  }
  const gates = await bindReports(inputs, reports, options.reports ? dirname(options.reports) : root);
  for (const gate of gates) for (const evidence of gate.evidence) {
    const body = await regularFile(dirname(options.reports), evidence.path);
    if (sha256(body) !== evidence.sha256) throw fault('EVIDENCE_CHANGED');
    evidence.path = `evidence/${evidence.path}`;
    put(evidence.path, body);
  }
  const historicalEvidence = [];
  for (const [gate, path] of HISTORY) {
    try { historicalEvidence.push({ gate, status: 'historical-only', ...await fileRef(root, path) }); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; historicalEvidence.push({ gate, path, status: 'missing' }); }
  }
  const missing = [...gates.filter(g => g.status !== 'passed').map(g => `gate:${g.gate}:${g.status}`), ...node.missing,
    'publishable private-false tar and final repository binding', 'owner publication approvals',
    'S10 compose recipe/hash and native hardening/egress/attached-stdio checks',
    'S10 OCI layout digest, image SBOM, base scan, signature and provenance verification',
    'Linux installed dependency trees/task evidence; other runtime/platform cells are unverified'];
  const handoff = { schema: 'fireboat-s10-handoff/1', binding: inputs,
    artifact: { ...ref('gateway.tgz', output.get('gateway.tgz')), integrity: inputs.tarIntegrity, rebuild: false },
    inventories: [ref('npm-files.json', output.get('npm-files.json')), ref('helper-files.json', output.get('helper-files.json'))],
    locks: [ref('npm-shrinkwrap.json', output.get('npm-shrinkwrap.json')), ref('helper-package-lock.json', output.get('helper-package-lock.json'))],
    installedTrees: trees, installedFiles: installed, assets, node, hapi,
    configuration: { host: ref('s10-host.config.json', configs.host), container: ref('s10-container.config.json', configs.container),
      source: 'quickstart/examples/quickstart/config.json', derivation: 'Only source.baseUrl port 18080 becomes 8080; all other values identical.' },
    topology: { hostCompose: compose, containerCompose: { status: 'missing', sha256: null }, networkMode: 'service:hapi',
      mcpPorts: [], hapiPublish: '127.0.0.1:18080:8080', user: '1000:1000', readOnly: true, capDrop: ['ALL'], noNewPrivileges: true,
      status: 'requirements-only; unexecuted' }, missing };
  put('s10-handoff.json', handoff);
  const lines = ['# Release license inventory', '', 'Dependency declarations and verbatim texts; redistribution approval remains the owner’s.', '',
    ...inventory.dependencies.map(d => `- ${d.name}@${d.version}: ${d.license}; ${d.components.join(', ')}; ${d.texts.map(t => `${t.path} sha256=${t.sha256}`).join('; ')}`), '',
    `Seed: ${inventory.seed.resources} synthetic resources; sha256=${inventory.seed.sha256}; generator rights=${inventory.seed.generator.rightsReview}.`,
    ...inventory.seed.terminology.map(t => `- ${t.system}: ${t.codes} codes, ${t.displays} displays; ${t.rightsReview}`), ''];
  put('LICENSE-INVENTORY.md', Buffer.from(lines.join('\n')));
  const manifest = { schema: 'fireboat-release-manifest/1', status: 'private-candidate', publishAuthorized: false,
    identity: { name: pkg.name, version: pkg.version, mcpName: pkg.mcpName, private: pkg.private, repository: pkg.repository ?? null },
    binding: inputs, sbom: { format: 'CycloneDX', specVersion: '1.5', generator: `npm ${TOOLCHAIN.npm} installed actual tree; omit=dev`,
    normalization: 'Remove UUID/time and consumer harness; normalize project-root basename and local tar URL to packet identity; verify all production components, dependency edges and SHA-512 integrities.' },
    gates, historicalEvidence, ownerActs: OWNER_ACTS, missing,
    files: [...output].map(([path, body]) => ref(path, body)).sort((a, b) => order(a.path, b.path)) };
  // Recheck after npm observations; the receipt also rebinds the current checkout snapshot and stage bytes.
  if (!isDeepStrictEqual(initialInputs, await snapshotInputs(root))) throw fault('RELEASE_INPUT_CHANGED');
  for (const original of source) if (!isDeepStrictEqual(original, await fileRef(root, original.path))) throw fault('RELEASE_INPUT_CHANGED');
  await verifyPackage({ root, stage, tar: options.tar, packJson: options.packJson });
  if (sha256(await readFile(options.tar)) !== inputs.tarSha256 || sha256(await readFile(options.packJson)) !== inputs.packJsonSha256) throw fault('RELEASE_INPUT_CHANGED');
  await verifyStagedDirectory(installedGateway, expected);
  await verifyPayload(helper, helperExpected.files);
  verifyInstalledTarOrigin(JSON.parse(await regularFile(gateway, 'node_modules/.package-lock.json')), pkg.name, pkg.version, tarIntegrity);
  for (const [component, directory] of [['gateway', gateway], ['quickstart', helper]]) {
    const ls = JSON.parse(npmRead(options.npmCli, directory, ['ls', '--omit=dev', '--all', '--long', '--json']));
    const tree = await verifyInstalledTree(directory, ls, component, root);
    if (tree.sha256 !== trees[component].sha256 || sha256(bytesOf(await componentInventory(directory, component, tree.canonical, inventory))) !== installed[component].sha256) throw fault('RELEASE_INPUT_CHANGED');
  }
  await mkdir(out, { mode: 0o700 });
  try {
    for (const [path, body] of output) {
      await mkdir(dirname(join(out, path)), { recursive: true, mode: 0o700 });
      await writeFile(join(out, path), body, { flag: 'wx', mode: 0o600 });
    }
    await writeFile(join(out, 'release-manifest.json'), bytesOf(manifest), { flag: 'wx', mode: 0o600 });
  } catch (error) { await rm(out, { recursive: true, force: true }); throw error; }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    const flags = { '--stage': 'stage', '--tar': 'tar', '--pack-json': 'packJson', '--gateway-install': 'gatewayInstall',
      '--helper-install': 'helperInstall', '--out': 'out', '--npm-cli': 'npmCli', '--revision': 'revision', '--reports': 'reports' };
    while (args.length) {
      const key = flags[args.shift()], value = args.shift();
      if (!key || !value || Object.hasOwn(options, key)) throw fault('RELEASE_USAGE');
      options[key] = key === 'revision' ? value : resolve(value);
    }
    const manifest = await releaseManifest(options);
    console.log(`release-manifest: ${manifest.status} tar=${manifest.binding.tarSha256} sbom=CycloneDX-1.5 missing=${manifest.missing.length} publish=false`);
  } catch (error) {
    console.error(`release-manifest: ${/^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'RELEASE_FAILED'}`); process.exitCode = 1;
  }
}
