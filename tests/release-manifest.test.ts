import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalDependencyTree } from '../scripts/package-tree.js';
import { ROOT, sha256 } from '../scripts/stage-package.js';

const release = await import(new URL('../scripts/release-manifest.mjs', import.meta.url).href);
const sri = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const context = { platform: { os: 'fixture', arch: 'fixture' }, optional: [] };
const binding = () => ({
  schema: 'fireboat-artifact-binding/1', revision: 'a'.repeat(40), sourceInputsSha256: sha256('source'),
  runtime: { node: '24.22.0', npm: '11.19.1', os: 'fixture', arch: 'fixture' },
  tarSha256: sha256('tar'), tarIntegrity: sri, packJsonSha256: sha256('pack JSON'), inventorySha256: sha256('inventory'), inventoryDocumentSha256: sha256('inventory document'),
  shrinkwrapSha256: sha256('shrinkwrap'), helperLockSha256: sha256('helper lock'), helperFilesSha256: sha256('helper files'),
  helperInventoryDocumentSha256: sha256('helper inventory'), gatewayTreeSha256: sha256('gateway tree'), helperTreeSha256: sha256('helper tree'),
  gatewayInstalledFilesSha256: sha256('gateway files'), helperInstalledFilesSha256: sha256('helper installed files'), licensesSha256: sha256('licenses'),
  assets: [{ path: 'quickstart/resources.ndjson', sha256: sha256('seed'), bytes: 7, mode: 0o644 }],
  compose: { path: 'quickstart/compose.quickstart.yaml', sha256: sha256('compose'), bytes: 9 },
  hostConfigSha256: sha256('host config'), containerConfigSha256: sha256('container config'),
  node: { indexDigest: `sha256:${sha256('node')}`, status: 'metadata-only' },
  hapi: { childDigest: `sha256:${sha256('hapi')}`, platform: 'linux/arm64' },
});
async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fireboat-release-fixture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'check.log'), 'synthetic fixture verification: pass\n');
  const evidence = [{ path: 'check.log', sha256: sha256(await readFile(join(root, 'check.log'))) }];
  return { root, evidence };
}
function sbomFixture(harness = false) {
  const leaf = { name: 'synthetic-leaf', version: '1.0.0', integrity: sri, dependencies: {} };
  const canonical = canonicalDependencyTree({ name: '@fireboat/gateway', version: '0.2.0-alpha.1',
    dependencies: { 'synthetic-leaf': leaf } }, context);
  const component = (node: any) => ({ 'bom-ref': `${node.name}@${node.version}`, type: 'library', name: node.name, version: node.version,
    scope: 'required', purl: `pkg:npm/${node.name.replace('@', '%40')}@${node.version}`, properties: [],
    licenses: [{ license: { id: 'MIT' } }], ...(node.integrity ? { hashes: [{ alg: 'SHA-512', content: Buffer.from(node.integrity.slice(7), 'base64').toString('hex') }] } : {}) });
  const root = component(canonical.tree), child = component(canonical.tree.dependencies[0]);
  Object.assign(root, { externalReferences: harness ? [{ type: 'distribution', url: 'file:/fixture/one/gateway.tgz' }] : [] });
  const consumer = { ...component({ name: 'synthetic-consumer', version: '1.0.0' }) };
  const raw: any = { $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json', bomFormat: 'CycloneDX', specVersion: '1.5',
    serialNumber: 'urn:uuid:fixture', version: 1,
    metadata: { timestamp: '2026-10-24T00:00:00Z', lifecycles: [{ phase: 'build' }], tools: [{ name: 'cli', vendor: 'npm', version: '11.19.1' }], component: harness ? consumer : root },
    components: harness ? [root, child] : [child],
    dependencies: [{ ref: root['bom-ref'], dependsOn: [child['bom-ref']] }, { ref: child['bom-ref'], dependsOn: [] },
      ...(harness ? [{ ref: consumer['bom-ref'], dependsOn: [root['bom-ref']] }] : [])] };
  return { canonical, raw };
}

test('release manifest: current complete binding accepts evidence and missing gates remain missing', async t => {
  const f = await fixture(t), inputs = binding();
  const gates = await release.bindReports(inputs, [{ gate: 'local-check', status: 'passed', binding: structuredClone(inputs), evidence: f.evidence }], f.root);
  assert.equal(gates.find((g: any) => g.gate === 'local-check').status, 'passed');
  assert.equal(gates.filter((g: any) => g.status === 'missing').length, release.GATES.length - 1);
  assert.ok(gates.some((g: any) => g.gate === 's12-release-ci' && g.status === 'missing'));
  assert.equal((await release.bindReports(inputs, [], f.root)).every((g: any) => g.status === 'missing'), true);
});

test('release manifest: stale tar shrinkwrap helper compose config source and runtime evidence refuses', async t => {
  const f = await fixture(t), inputs = binding();
  for (const key of Object.keys(inputs)) {
    const other: any = structuredClone(inputs);
    if (typeof other[key] === 'string') other[key] = `${other[key]}-old`;
    else if (key === 'assets') other.assets[0].sha256 = sha256('old seed');
    else if (typeof other[key] === 'object') other[key].changed = true;
    else other[key]++;
    await assert.rejects(release.bindReports(inputs, [{ gate: 'local-check', status: 'passed', binding: other, evidence: f.evidence }], f.root), { code: 'EVIDENCE_STALE' }, key);
  }
  const partial: any = structuredClone(inputs); delete partial.helperFilesSha256;
  for (const stale of [partial, { ...inputs, unexpected: 'extra binding field' }, null])
    await assert.rejects(release.bindReports(inputs, [{ gate: 'g-human', status: 'failed', binding: stale, evidence: f.evidence }], f.root), { code: 'EVIDENCE_STALE' });
});

test('release manifest: changed evidence is refused and a failed bound report stays failed', async t => {
  const f = await fixture(t), inputs = binding();
  const report = { gate: 'local-check', status: 'failed', binding: inputs, evidence: f.evidence };
  assert.equal((await release.bindReports(inputs, [report], f.root)).find((g: any) => g.gate === 'local-check').status, 'failed');
  await writeFile(join(f.root, 'check.log'), 'different bytes\n');
  await assert.rejects(release.bindReports(inputs, [report], f.root), { code: 'EVIDENCE_CHANGED' });
});

test('release manifest: reports are closed and nonempty with unique known gates', async t => {
  const f = await fixture(t), inputs = binding();
  const valid = { gate: 'local-check', status: 'passed', binding: inputs, evidence: f.evidence };
  for (const reports of [null, {}, [valid, valid], [{ ...valid, gate: 'historical-pass' }], [{ ...valid, status: 'skip' }],
    [{ ...valid, evidence: [] }], [{ ...valid, token: 'canary' }], [{ ...valid, evidence: [{ ...f.evidence[0], body: 'canary' }] }],
    [{ ...valid, evidence: [{ path: 'check.log', sha256: 'bad' }] }]])
    await assert.rejects(release.bindReports(inputs, reports, f.root), { code: 'REPORT_INVALID' });
});

test('release manifest: evidence traversal absolute paths and interior links cannot certify a gate', async t => {
  const f = await fixture(t), inputs = binding();
  const bind = (path: string) => release.bindReports(inputs, [{ gate: 'local-check', status: 'passed', binding: inputs,
    evidence: [{ path, sha256: f.evidence[0]!.sha256 }] }], f.root);
  for (const path of ['../check.log', '/check.log', 'dir\\check.log', './check.log']) await assert.rejects(bind(path), { code: 'REPORT_INVALID' });
  await symlink(join(f.root, 'check.log'), join(f.root, 'linked.log'));
  await assert.rejects(bind('linked.log'), { code: 'RELEASE_PATH' });
  await mkdir(join(f.root, 'real')); await writeFile(join(f.root, 'real/check.log'), await readFile(join(f.root, 'check.log')));
  await symlink(join(f.root, 'real'), join(f.root, 'linked'));
  await assert.rejects(bind('linked/check.log'), { code: 'RELEASE_PATH' });
});

test('release manifest: actual-tree CycloneDX keeps exact graph licenses and SRI with stable normalization', () => {
  for (const harness of [false, true]) {
    const { canonical, raw } = sbomFixture(harness), normalized = release.normalizeInstalledSbom(raw, canonical);
    assert.equal(normalized.bomFormat, 'CycloneDX'); assert.equal(normalized.specVersion, '1.5');
    assert.equal(normalized.metadata.component.name, '@fireboat/gateway');
    assert.equal(normalized.components.length, 1); assert.equal(normalized.dependencies.length, 2);
    assert.equal(normalized.components[0].licenses[0].license.id, 'MIT');
    assert.equal(normalized.components[0].hashes[0].content, Buffer.from(sri.slice(7), 'base64').toString('hex'));
    assert.equal(Object.hasOwn(normalized, 'serialNumber'), false); assert.equal(Object.hasOwn(normalized.metadata, 'timestamp'), false);
    raw.serialNumber = 'different UUID'; raw.metadata.timestamp = 'different timestamp';
    if (harness) {
      assert.equal(normalized.metadata.component.externalReferences[0].url, 'gateway.tgz');
      raw.components[0].externalReferences[0].url = 'file:/a-different-install-location/tar.tgz';
    }
    assert.deepEqual(release.normalizeInstalledSbom(raw, canonical), normalized);
    assert.equal(JSON.stringify(normalized).includes('synthetic-consumer'), false);
  }
});

test('release manifest: lock-only SBOM wrong generator and extra missing invalid production components refuse', () => {
  const { canonical, raw } = sbomFixture();
  const cases: [string, (r: any) => void, string][] = [
    ['lock-only', r => { r.metadata.lifecycles[0].phase = 'pre-build'; }, 'SBOM_FORMAT'],
    ['generator', r => { r.metadata.tools[0].version = '999.0.0'; }, 'SBOM_FORMAT'],
    ['format', r => { r.bomFormat = 'SPDX'; }, 'SBOM_FORMAT'],
    ['version', r => { r.specVersion = '1.4'; }, 'SBOM_FORMAT'],
    ['missing', r => { r.components = []; }, 'SBOM_TREE'],
    ['extra', r => { r.components.push({ ...r.components[0], 'bom-ref': 'extra@1.0.0', name: 'extra' }); }, 'SBOM_TREE'],
    ['changed version', r => { r.components[0].version = '9.0.0'; }, 'SBOM_TREE'],
    ['duplicate', r => { r.components.push(r.components[0]); }, 'SBOM_TREE'],
    ['development', r => { r.components[0].properties = [{ name: 'cdx:npm:package:development', value: 'true' }]; }, 'SBOM_TREE'],
    ['extraneous', r => { r.components[0].properties = [{ name: 'cdx:npm:package:extraneous', value: 'true' }]; }, 'SBOM_TREE'],
    ['optional', r => { r.components[0].scope = 'optional'; }, 'SBOM_TREE'],
    ['missing hash', r => { delete r.components[0].hashes; }, 'SBOM_INTEGRITY'],
    ['changed hash', r => { r.components[0].hashes[0].content = '00'.repeat(64); }, 'SBOM_INTEGRITY'],
    ['missing edge', r => { r.dependencies[0].dependsOn = []; }, 'SBOM_TREE'],
    ['foreign edge', r => { r.dependencies[1].dependsOn = ['foreign@1.0.0']; }, 'SBOM_TREE'],
    ['duplicate edge', r => { r.dependencies[0].dependsOn.push(r.dependencies[0].dependsOn[0]); }, 'SBOM_TREE'],
    ['duplicate graph row', r => { r.dependencies.push(r.dependencies[0]); }, 'SBOM_TREE'],
  ];
  for (const [name, mutate, code] of cases) {
    const changed = structuredClone(raw); mutate(changed);
    assert.throws(() => release.normalizeInstalledSbom(changed, canonical), { code }, name);
  }
});

test('release manifest: a consumer harness may depend only on the exact gateway root', () => {
  const { canonical, raw } = sbomFixture(true);
  raw.dependencies.at(-1).dependsOn = [];
  assert.throws(() => release.normalizeInstalledSbom(raw, canonical), { code: 'SBOM_TREE' });
});

test('release manifest: npm project-root basename normalizes only with matching package purl and bom-ref', () => {
  const { canonical, raw } = sbomFixture();
  const expected = release.normalizeInstalledSbom(raw, canonical);
  raw.metadata.component.name = 'a-relocated-install-directory';
  assert.deepEqual(release.normalizeInstalledSbom(raw, canonical), expected);
  raw.metadata.component.purl = 'pkg:npm/foreign@1.0.0';
  assert.throws(() => release.normalizeInstalledSbom(raw, canonical), { code: 'SBOM_TREE' });
});

test('release manifest: installed byte inventory is relocatable and detects body mode and link changes', async t => {
  const f = await fixture(t), nested = join(f.root, 'nested'); await mkdir(nested);
  await writeFile(join(nested, 'file.js'), 'export const fixture = 1;\n');
  const first = await release.installedFiles(f.root);
  const other = await mkdtemp(join(tmpdir(), 'fireboat-release-relocated-')); t.after(() => rm(other, { recursive: true, force: true }));
  await mkdir(join(other, 'nested')); await writeFile(join(other, 'nested/file.js'), 'export const fixture = 1;\n');
  await writeFile(join(other, 'check.log'), await readFile(join(f.root, 'check.log')));
  assert.deepEqual(await release.installedFiles(other), first);
  await chmod(join(nested, 'file.js'), 0o755); assert.notDeepEqual(await release.installedFiles(f.root), first);
  await chmod(join(nested, 'file.js'), 0o644); await writeFile(join(nested, 'file.js'), 'changed\n');
  assert.notDeepEqual(await release.installedFiles(f.root), first);
  await symlink(join(f.root, 'check.log'), join(nested, 'linked'));
  await assert.rejects(release.installedFiles(f.root), { code: 'INSTALLED_LINK' });
  await symlink(other, join(f.root, 'root-link'));
  await assert.rejects(release.installedFiles(join(f.root, 'root-link')), { code: 'INSTALLED_LINK' });
  await symlink(other, join(other, 'node_modules'));
  await assert.rejects(release.installedFiles(other), { code: 'INSTALLED_LINK' });
});

test('release manifest: upstream production packages retain their own declarations maps and test files in byte hashes', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'tests'));
  for (const path of ['index.d.ts', 'index.js.map', 'tests/package test.js']) await writeFile(join(f.root, path), 'package-owned fixture\n');
  const files = await release.installedFiles(f.root);
  assert.deepEqual(files.map((row: any) => row.path), ['check.log', 'index.d.ts', 'index.js.map', 'tests/package test.js']);
});

test('release manifest: installed license inventory refuses newly added or removed upstream NOTICE texts', () => {
  const license = { path: 'LICENSE', size: 7, sha256: sha256('license') };
  const dependency = { texts: [{ source: 'LICENSE', kind: 'license', bytes: 7, sha256: license.sha256 }] };
  release.verifyInstalledLicenseFiles(dependency, [license, { path: 'index.js', size: 1, sha256: sha256('code') }]);
  const notice = { path: 'nested/NOTICE.md', size: 6, sha256: sha256('notice') };
  assert.throws(() => release.verifyInstalledLicenseFiles(dependency, [license, notice]), { code: 'LICENSE_TEXTS_CHANGED' });
  const withNotice = { texts: [...dependency.texts, { source: notice.path, kind: 'notice', bytes: notice.size, sha256: notice.sha256 }] };
  release.verifyInstalledLicenseFiles(withNotice, [license, notice]);
  assert.throws(() => release.verifyInstalledLicenseFiles(withNotice, [license]), { code: 'LICENSE_TEXTS_CHANGED' });
  assert.throws(() => release.verifyInstalledLicenseFiles(dependency, [{ ...license, sha256: sha256('changed') }]), { code: 'LICENSE_TEXTS_CHANGED' });
});

test('release manifest: observed installed gateway SRI must identify the exact accepted tar bytes', () => {
  const hidden = { packages: { 'node_modules/@fireboat/gateway': { version: '0.2.0-alpha.1', integrity: sri } } };
  release.verifyInstalledTarOrigin(hidden, '@fireboat/gateway', '0.2.0-alpha.1', sri);
  for (const change of [{ integrity: `sha512-${Buffer.alloc(64, 8).toString('base64')}` }, { version: '0.2.0-alpha.2' }, { link: true }, { dev: true }]) {
    const other = structuredClone(hidden); Object.assign(other.packages['node_modules/@fireboat/gateway'], change);
    assert.throws(() => release.verifyInstalledTarOrigin(other, '@fireboat/gateway', '0.2.0-alpha.1', sri), { code: 'INSTALLED_TAR_MISMATCH' });
  }
  assert.throws(() => release.verifyInstalledTarOrigin({}, '@fireboat/gateway', '0.2.0-alpha.1', sri), { code: 'INSTALLED_TAR_MISMATCH' });
});

test('release manifest: Node index and children come from dated repository evidence with missing configs explicit', async () => {
  const design = await readFile(join(ROOT, 'proposals/m3b-s8s9-design.md'), 'utf8');
  const pins = release.nodeRuntimePins(design);
  assert.equal(pins.status, 'metadata-only'); assert.equal(pins.platforms.length, 2);
  for (const pin of pins.platforms) {
    assert.match(pin.childDigest, /^sha256:[a-f0-9]{64}$/); assert.ok(design.includes(pin.childDigest));
    assert.equal(pin.configDigest, null); assert.equal(pin.layers, null); assert.equal(pin.execution, 'unverified');
  }
  assert.equal(pins.platforms[0].platform, 'linux/arm64'); assert.equal(pins.platforms[1].platform, 'linux/amd64');
  assert.ok(design.includes(pins.indexDigest));
  assert.equal(release.nodeRuntimePins('missing evidence').indexDigest, null);
  assert.equal(release.nodeRuntimePins(design + '\n' + design).status, 'missing');
});

test('release manifest: S10 config derives only the loopback port from the same approved tuple', () => {
  const host = { mode: 'synthetic', source: { alias: 'fixture', baseUrl: 'http://127.0.0.1:18080/fhir' }, patientId: 'synthetic-fixture', extraPolicy: { limit: 5 } };
  const configs = release.s10Configurations(host), container = JSON.parse(configs.container);
  assert.deepEqual(JSON.parse(configs.host), host);
  assert.equal(container.source.baseUrl, 'http://127.0.0.1:8080/fhir');
  container.source.baseUrl = host.source.baseUrl; assert.deepEqual(container, host);
  assert.equal(host.source.baseUrl, 'http://127.0.0.1:18080/fhir');
  for (const baseUrl of ['http://localhost:18080/fhir', 'http://127.0.0.1:18091/fhir', 'https://foreign.invalid/fhir'])
    assert.throws(() => release.s10Configurations({ ...host, source: { ...host.source, baseUrl } }), { code: 'S10_CONFIG' });
});

test('release manifest: npm reader uses fixed argument vectors offline and clears runtime injection', async t => {
  const f = await fixture(t), cli = join(f.root, 'fake-npm.mjs');
  await writeFile(cli, "console.log(JSON.stringify({args:process.argv.slice(2), cwd:process.cwd(), options:process.env.NODE_OPTIONS, path:process.env.NODE_PATH, offline:process.env.npm_config_offline, lockOnly:process.env.npm_config_package_lock_only}));\n");
  const result = JSON.parse(release.npmRead(cli, f.root, ['sbom', '--omit=dev', '--sbom-format=cyclonedx', '--package-lock-only=false']));
  assert.deepEqual(result.args, ['sbom', '--omit=dev', '--sbom-format=cyclonedx', '--package-lock-only=false', '--offline', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.equal(result.cwd, f.root); assert.equal(result.options, ''); assert.equal(result.path, ''); assert.equal(result.offline, 'true'); assert.equal(result.lockOnly, 'false');
  await writeFile(cli, 'process.exitCode = 9;\n');
  assert.throws(() => release.npmRead(cli, f.root, ['ls']), { code: 'NPM_READ_FAILED' });
  assert.throws(() => release.npmRead('npm', f.root, ['ls']), { code: 'NPM_CLI' });
});

test('release manifest: missing installed inputs cannot produce a release packet', async () => {
  await assert.rejects(release.releaseManifest({}), { code: 'RELEASE_USAGE' });
});

test('release manifest: packet output is external or in release artifacts and protects stage and installs including linked parents', async t => {
  const f = await fixture(t), protectedRoot = join(f.root, 'protected'); await mkdir(protectedRoot);
  assert.equal(await release.releaseDestination(join(f.root, 'new-packet'), [protectedRoot]), join(f.root, 'new-packet'));
  for (const path of [protectedRoot, join(protectedRoot, 'packet')])
    await assert.rejects(release.releaseDestination(path, [protectedRoot]), { code: 'RELEASE_DESTINATION' });
  await symlink(protectedRoot, join(f.root, 'alias'));
  await assert.rejects(release.releaseDestination(join(f.root, 'alias/packet'), [protectedRoot]), { code: 'RELEASE_DESTINATION' });
  await assert.rejects(release.releaseDestination('relative', [protectedRoot]), { code: 'RELEASE_DESTINATION' });
  await mkdir(join(f.root, 'artifacts'));
  assert.equal(await release.releaseDestination(join(f.root, 'artifacts/m3b-release'), [protectedRoot], f.root), join(f.root, 'artifacts/m3b-release'));
  await assert.rejects(release.releaseDestination(join(f.root, 'source-packet'), [protectedRoot], f.root), { code: 'RELEASE_DESTINATION' });
});

test('release manifest: publication design has only manual trigger and two inert interlocks', async () => {
  const workflow = await readFile(join(ROOT, '.github/workflows/release-npm.yml'), 'utf8');
  const executable = workflow.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
  const triggers = executable.split('\non:\n')[1]!.split('\npermissions:')[0]!;
  assert.equal((triggers.match(/^  [a-z_]+:/gm) ?? []).join(), '  workflow_dispatch:');
  assert.match(executable, /if: \$\{\{ false \}\}/); assert.match(executable, /exit 1/);
  assert.match(executable, /runs-on: ubuntu-24\.04/); assert.match(executable, /environment: npm-alpha/);
  assert.match(executable, /permissions:\n  contents: read/); assert.match(executable, /      id-token: write/);
  assert.equal(/npm publish|npm install|npm ci|NODE_AUTH_TOKEN|secrets\.|uses:/.test(executable), false);
  for (const input of ['candidate_commit', 'version', 'tar_sha256', 'packet_artifact_id', 'release_ci_run_id']) assert.ok(triggers.includes(`      ${input}:`));
  assert.match(workflow, /Node 24\.22\.0; assert npm 11\.19\.1/); assert.match(workflow, /--ignore-scripts --access public --tag alpha --provenance/);
});

test('release manifest: installed-artifact job is an inert linux/arm64 design that gates the publisher and CI claims no installed cell', async () => {
  const workflow = await readFile(join(ROOT, '.github/workflows/release-npm.yml'), 'utf8');
  const executable = workflow.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
  const jobs = executable.split('\njobs:\n')[1]!.split(/\n(?=  [a-z][a-z-]*:\n)/);
  assert.deepEqual(jobs.map(job => /^  ([a-z-]+):/.exec(job)?.[1]), ['installed-artifact-design', 'publish-design']);
  for (const job of jobs) { assert.match(job, /\n    if: \$\{\{ false \}\}\n/); assert.match(job, /\n          exit 1\n?/); }
  const [installed, publisher] = jobs as [string, string];
  assert.match(installed, /runs-on: ubuntu-24\.04-arm\n/); assert.match(installed, /permissions:\n      contents: read\n/);
  assert.equal(/id-token|environment:/.test(installed), false, 'no publish credentials in the installed job');
  assert.match(publisher, /\n    needs: installed-artifact-design\n/);
  for (const term of ['test:package-installed', 'PACKAGE_INSTALLED_OK naming tar_sha256', 'linux/amd64 and every other cell stay explicitly unverified', 'never skips'])
    assert.ok(workflow.includes(term), term);
  const ci = await readFile(join(ROOT, '.github/workflows/ci.yml'), 'utf8'), release = await readFile(join(ROOT, 'docs/RELEASE.md'), 'utf8');
  // Until CI itself runs the installed gate, the release procedure must not promise a Linux installed-package cell from it.
  if (!ci.includes('test:package-installed')) assert.match(release.replace(/\s+/g, ' '), /It does \*\*not\*\* supply a Linux installed-package cell/);
  assert.equal(/^\s*(?:push|pull_request|schedule|release|workflow_run):/m.test(ci) || /^\s*(?:push|pull_request|schedule|release|workflow_run):/m.test(executable), false);
});
