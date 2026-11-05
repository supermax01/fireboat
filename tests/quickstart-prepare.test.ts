import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, stat, rm, mkdir } from 'node:fs/promises';
import { createServer, request as realRequest } from 'node:http';
import type { IncomingMessage, request as httpRequest, RequestOptions } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { stringifyFhir } from '../packages/core/src/decimal.js';
import { HAPI_IMAGE, HELPER_BACKEND } from '../examples/quickstart/backend.js';
import { createDockerAdapter, DOCKER_LIMITS } from '../examples/quickstart/docker.js';
import type { DockerAdapter, DockerExecutor, DockerRun } from '../examples/quickstart/docker.js';
import { ownershipLabels } from '../examples/quickstart/instance.js';
import type { InstanceEvidence, InstanceReceipt } from '../examples/quickstart/instance.js';
import { fault, pinsSha256, QUICKSTART_TARGET, seedTypes, sha256, validateSeedManifest } from '../examples/quickstart/manifest.js';
import type { QuickstartFaultCode } from '../examples/quickstart/manifest.js';
import { prepare, READINESS } from '../examples/quickstart/prepare.js';
import type { HelperAssets } from '../examples/quickstart/prepare.js';
import { atomicPrivateWrite, jsonBytes, lockRun, readRunReceipt } from '../examples/quickstart/run-state.js';
import { createSeedHttpClient, seedPortOccupied } from '../examples/quickstart/seed-http.js';
import { parseResource, requireReferenceClosure } from '../examples/quickstart/setup-oracle.js';
import { downRun } from '../examples/quickstart/down.js';
import { runQuickstart } from '../examples/quickstart/main.js';
import { fakeHttp } from './quickstart/fake-http.js';

function fixture() {
  const bodies = [
    '{"resourceType":"Organization","id":"org","active":true}',
    '{"resourceType":"Patient","id":"patient","managingOrganization":{"reference":"Organization/org"}}',
    '{"resourceType":"Observation","id":"lab","status":"corrected","subject":{"reference":"Patient/patient"},"valueQuantity":{"value":7.00,"unit":"%","comparator":"<"}}'
  ];
  const compose = Buffer.from('synthetic compose\n');
  const manifest = validateSeedManifest({ schema: 1, target: QUICKSTART_TARGET, pinsSha256: pinsSha256(), composeSha256: sha256(compose),
    artifacts: { generatorSha256: sha256('generator'), configSha256: sha256('config'), rawExportsSha256: sha256('raw'), transformSha256: sha256('transform') },
    backend: HELPER_BACKEND, resources: bodies.map(body => {
      const r = JSON.parse(body); return { type: r.resourceType, id: r.id, bytes: Buffer.byteLength(body), sha256: sha256(body), origin: 'edge' };
    }) });
  const assets: HelperAssets = { manifest: jsonBytes(manifest), compose, resources: Buffer.from(`${bodies.join('\n')}\n`) };
  return { assets, manifest, bodies };
}
type FakeOptions = {
  inspect?: (e: InstanceEvidence, index: number) => InstanceEvidence;
  up?: () => Promise<void>; metadata?: string; initialCount?: (type: string) => number;
  stored?: (target: string, body: string) => string | undefined;
  countDelta?: number; version?: string; failPut?: number; unavailable?: boolean;
  /** Emulates HAPI's reuse of a cached identical search unless the request sends `cache-control: no-cache`. */
  searchCache?: boolean;
};
function fakes(f: ReturnType<typeof fixture>, options: FakeOptions = {}) {
  let run: DockerRun, inspections = 0, ups = 0, writes = 0, metadataCalls = 0;
  const stored = new Map<string, string>(), searches = new Map<string, string>(), actions: string[] = [];
  const evidence = (): InstanceEvidence => {
    const instance: InstanceReceipt = { schema: 1, runId: run.runId, project: run.project, service: 'hapi', containerId: 'b'.repeat(64),
      creationNonce: run.creationNonce, createdAt: '2026-01-01T00:00:00.000Z', composeSha256: run.composeSha256, volumes: [] };
    return { ...instance, labels: ownershipLabels(instance), publishedPorts: [{ hostIp: '127.0.0.1', hostPort: 18080, containerPort: 8080,
      protocol: 'tcp', containerId: instance.containerId }], backend: f.manifest.backend };
  };
  const inspect = async () => { inspections++; return options.inspect?.(evidence(), inspections) ?? evidence(); };
  const docker: DockerAdapter = {
    async up(value) { run = value; ups++; await options.up?.(); return 'b'.repeat(64); }, inspect,
    cleanup() { return { inspect, async execute(action) { actions.push(action.kind); } }; }
  };
  const http = fakeHttp((req, res) => {
    const route = req.url!.slice('/fhir/'.length);
    if (route === 'metadata') {
      metadataCalls++;
      if (options.unavailable) { res.statusCode = 503; res.end('{}'); }
      else res.end(options.metadata ?? '{"resourceType":"CapabilityStatement","fhirVersion":"4.0.1","software":{"name":"HAPI FHIR Server","version":"8.12.0"}}');
    } else if (route.endsWith('?_summary=count')) {
      const type = route.split('?')[0]!, headers = (http.requests.at(-1)!.options.headers ?? {}) as Record<string, unknown>;
      const cached = options.searchCache ? searches.get(route) : undefined;
      if (cached !== undefined && headers['cache-control'] !== 'no-cache') { res.end(cached); return; }
      const count = stored.size ? [...stored.keys()].filter(k => k.startsWith(`${type}/`)).length + (options.countDelta ?? 0) : options.initialCount?.(type) ?? 0;
      // Like HAPI, a no-cache search still stores its result for later identical searches.
      const bundle = JSON.stringify({ resourceType: 'Bundle', type: 'searchset', total: count });
      searches.set(route, bundle); res.end(bundle);
    } else if (req.method === 'PUT') {
      writes++;
      if (options.failPut === writes) { res.statusCode = 500; res.end('{}'); return; }
      const body = parseResource(http.requests.at(-1)!.body);
      body.meta = { ...(body.meta as object ?? {}), versionId: options.version ?? '17', lastUpdated: '2026-01-01T00:00:00.123Z', source: '#synthetic' };
      stored.set(route, stringifyFhir(body)); res.statusCode = 201; res.end('{}');
    } else {
      const body = options.stored ? options.stored(route, stored.get(route)!) : stored.get(route);
      if (body === undefined) { res.statusCode = 404; res.end('{}'); }
      else res.end(body);
    }
  });
  // The listener probe is injected everywhere: unit tests never touch 127.0.0.1:18080.
  return { docker, http, actions, options: { docker, client: () => createSeedHttpClient(f.manifest, QUICKSTART_TARGET,
    { environment: {}, request: http.request }), wait: async () => {}, probe: async () => false },
    get writes() { return writes; }, get ups() { return ups; }, get inspections() { return inspections; }, get metadataCalls() { return metadataCalls; } };
}
async function scratch(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'fireboat-prepare-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('quickstart prepare: complete packet binds approved bodies receipt manifest observed versions and exact lexemes', async t => {
  const root = await scratch(t), directory = join(root, 'run'), f = fixture(), fake = fakes(f);
  const result = await prepare({ ...f.assets, runDirectory: directory }, fake.options);
  assert.equal(result.resources, 3); assert.equal(result.types, 3); assert.equal(fake.writes, 3);
  assert.equal(fake.inspections, 3);
  const receipt = await readRunReceipt(directory), attempt = await readFile(join(directory, 'attempt.json'));
  const raw = await readFile(join(directory, 'setup-packet.json')), packet = JSON.parse(raw.toString());
  assert.equal(receipt.phase, 'complete'); assert.equal(receipt.packetSha256, result.packetSha256);
  assert.equal(sha256(raw), result.packetSha256); assert.equal(packet.manifestSha256, sha256(f.assets.manifest));
  assert.equal(packet.receiptSha256, sha256(attempt)); assert.equal(receipt.attemptSha256, sha256(attempt));
  assert.equal(packet.instanceSha256, sha256(jsonBytes(receipt.instance)));
  assert.equal(packet.runId, receipt.runId); assert.equal(packet.creationNonce, receipt.creationNonce);
  assert(packet.resources.every((r: { versionId: string }) => r.versionId === '17'));
  assert.deepEqual(packet.resources[2].numbers, [{ pointer: '/valueQuantity/value', lexeme: '7.00' }]);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const file of await readdir(directory)) assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600, file);
  assert.equal((await readdir(directory)).filter(f => f.endsWith('.tmp') || f === 'writer.lock').length, 0);
  const puts = fake.http.requests.filter(r => r.method === 'PUT');
  assert.deepEqual(puts.map(r => r.body.toString()), f.bodies);
  assert.deepEqual(puts.map(r => r.path), f.manifest.resources.map(r => `/fhir/${r.type}/${r.id}`));
  const before = fake.http.requests.findIndex(r => r.method === 'PUT');
  assert.deepEqual(fake.http.requests.slice(1, before).map(r => r.path), seedTypes(f.manifest).map(type => `/fhir/${type}?_summary=count`));
});

test('quickstart prepare: oracle counts bypass HAPI search-result reuse of the pre-seed zero counts', async t => {
  const root = await scratch(t), f = fixture(), fake = fakes(f, { searchCache: true });
  const result = await prepare({ ...f.assets, runDirectory: join(root, 'run') }, fake.options);
  assert.equal(result.resources, 3); assert.equal((await readRunReceipt(join(root, 'run'))).phase, 'complete');
  const counts = fake.http.requests.filter(r => r.path.endsWith('?_summary=count'));
  assert.equal(counts.length, seedTypes(f.manifest).length * 2);
  assert(counts.every(r => (r.options.headers as Record<string, unknown>)['cache-control'] === 'no-cache'));
  // Control (the live 2026-10-25 failure): the same server answering from its cache fails the exact post-seed counts.
  const control = fakes(f, { searchCache: true });
  const cacheable = ((options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    const headers = { ...(options.headers as Record<string, string | number>) }; delete headers['cache-control'];
    return control.http.request({ ...options, headers }, callback);
  }) as unknown as typeof httpRequest;
  await assert.rejects(prepare({ ...f.assets, runDirectory: join(root, 'control') }, { ...control.options,
    client: () => createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: {}, request: cacheable }) }), { code: 'SETUP_ORACLE_FAILED' });
  assert.equal(control.writes, 3); assert.equal((await readRunReceipt(join(root, 'control'))).phase, 'failed');
});

test('quickstart prepare: failed partial and complete attempts cannot be reseeded even when a replacement target is empty', async t => {
  const root = await scratch(t), f = fixture();
  for (const [name, option] of [['failed', { metadata: '{}' }], ['partial', { failPut: 2 }], ['complete', {}]] as const) {
    const directory = join(root, name), first = fakes(f, option);
    if (name === 'complete') await prepare({ ...f.assets, runDirectory: directory }, first.options);
    else await assert.rejects(prepare({ ...f.assets, runDirectory: directory }, first.options));
    const replacement = fakes(f);
    await assert.rejects(prepare({ ...f.assets, runDirectory: directory }, replacement.options), { code: 'SEED_ALREADY_ATTEMPTED' });
    assert.equal(replacement.writes, 0); assert.equal(replacement.ups, 0);
  }
});

test('quickstart prepare: concurrent writer refuses while the first attempt retains its exclusive lock', async t => {
  const root = await scratch(t), directory = join(root, 'run'), f = fixture();
  let started!: () => void, resume!: () => void;
  const entered = new Promise<void>(r => { started = r; }), held = new Promise<void>(r => { resume = r; });
  const first = fakes(f, { up: async () => { started(); await held; } });
  const running = prepare({ ...f.assets, runDirectory: directory }, first.options);
  await entered;
  const second = fakes(f);
  try {
    await assert.rejects(prepare({ ...f.assets, runDirectory: directory }, second.options), { code: 'RUN_LOCKED' });
    assert.equal(second.writes, 0); assert.equal(second.ups, 0);
  } finally { resume(); await running; }
});

test('quickstart prepare: exclusive lock itself rejects a second lock without modifying its owner', async t => {
  const directory = await scratch(t), release = await lockRun(directory);
  try { await assert.rejects(lockRun(directory), { code: 'RUN_LOCKED' }); assert.equal((await stat(join(directory, 'writer.lock'))).mode & 0o777, 0o600); }
  finally { await release(); }
});

test('quickstart prepare: foreign provenance backend metadata every nonempty type and unreadiness perform zero PUTs', async t => {
  const root = await scratch(t), f = fixture();
  const cases: FakeOptions[] = [
    { inspect: e => ({ ...e, labels: {} }) }, { inspect: e => ({ ...e, creationNonce: 'e'.repeat(64) }) },
    { inspect: e => ({ ...e, publishedPorts: [{ ...e.publishedPorts[0]!, hostPort: 18091 }] }) },
    { inspect: e => ({ ...e, backend: { ...e.backend, imageConfigDigest: `sha256:${'e'.repeat(64)}` } }) },
    ...['name', 'version'].map(key => ({ metadata: JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1',
      software: { name: 'HAPI FHIR Server', version: '8.12.0', [key]: 'foreign' } }) })),
    { metadata: '{"resourceType":"CapabilityStatement","fhirVersion":"5.0.0","software":{"name":"HAPI FHIR Server","version":"8.12.0"}}' },
    ...seedTypes(f.manifest).map(type => ({ initialCount: (t: string) => t === type ? 1 : 0 })), { unavailable: true }
  ];
  for (const [i, option] of cases.entries()) {
    const fake = fakes(f, option), directory = join(root, `run-${i}`);
    await assert.rejects(prepare({ ...f.assets, runDirectory: directory }, fake.options));
    assert.equal(fake.writes, 0); assert.equal((await readRunReceipt(directory)).phase, 'failed');
    if (option.unavailable) assert.equal(fake.metadataCalls, READINESS.attempts);
  }
});

test('quickstart prepare: changed compose body membership and unresolved approved references refuse before Docker or writes', async t => {
  const root = await scratch(t), f = fixture();
  const altered = f.bodies.map(b => b.replace('Patient/patient', 'Patient/missing'));
  const manifest = { ...f.manifest, resources: f.manifest.resources.map((r, i) => ({ ...r, bytes: Buffer.byteLength(altered[i]!), sha256: sha256(altered[i]!) })) };
  const cases = [ { ...f.assets, compose: Buffer.from('changed') }, { ...f.assets, resources: Buffer.from(f.assets.resources).subarray(1) },
    { ...f.assets, resources: Buffer.from(`${Buffer.from(f.assets.resources).toString()}{}\n`) },
    { ...f.assets, manifest: jsonBytes(manifest), resources: Buffer.from(`${altered.join('\n')}\n`) } ];
  for (const [i, assets] of cases.entries()) {
    const fake = fakes(f);
    await assert.rejects(prepare({ ...assets, runDirectory: join(root, `run-${i}`) }, fake.options));
    assert.equal(fake.writes, 0); assert.equal(fake.ups, 0);
  }
});

test('quickstart prepare: fresh inspection immediately before first write refuses instance substitution', async t => {
  const root = await scratch(t), f = fixture(), fake = fakes(f, { inspect: (e, i) => i === 2 ? { ...e, containerId: 'e'.repeat(64) } : e });
  const directory = join(root, 'run');
  await assert.rejects(prepare({ ...f.assets, runDirectory: directory }, fake.options), { code: 'INSTANCE_FOREIGN' });
  assert.equal(fake.inspections, 2); assert.equal(fake.writes, 0); assert.equal((await readRunReceipt(directory)).phase, 'failed');
});

test('quickstart prepare: setup oracle refuses rounded lexemes changed status identity reference unexpected meta and extra or missing resources', async t => {
  const root = await scratch(t), f = fixture();
  const options: FakeOptions[] = [
    { stored: (_target, body) => body.replace('7.00', '7') },
    { stored: (_target, body) => body.replace('corrected', 'final') },
    { stored: (_target, body) => body.replace('"id":"lab"', '"id":"extra"') },
    { stored: (_target, body) => body.replace('Patient/patient', 'Patient/foreign') },
    { stored: (_target, body) => body.replace('"meta":{', '"meta":{"unexpected":true,') },
    { stored: (target, body) => target === 'Observation/lab' ? undefined : body },
    { countDelta: 1 }, { countDelta: -1 }, { version: '' }
  ];
  for (const [i, option] of options.entries()) {
    const fake = fakes(f, option), directory = join(root, `run-${i}`);
    await assert.rejects(prepare({ ...f.assets, runDirectory: directory }, fake.options));
    assert.equal(fake.writes, f.manifest.resources.length);
    assert.equal((await readRunReceipt(directory)).phase, 'failed');
    assert(!(await readdir(directory)).includes('setup-packet.json'));
  }
});

test('quickstart prepare: reference closure refuses unresolved nonstring contained and foreign routes', () => {
  for (const reference of ['Patient/absent', '#contained', 'http://127.0.0.1:18080/fhir/Patient/patient', 'urn:uuid:unknown', 3])
    assert.throws(() => requireReferenceClosure({ subject: { reference } }, new Set(['Patient/patient'])), { code: 'SETUP_ORACLE_FAILED' });
  requireReferenceClosure({ subject: { reference: 'Patient/patient' } }, new Set(['Patient/patient']));
});

test('quickstart prepare: packet failure and final receipt failure cannot publish a complete attempt', async t => {
  const root = await scratch(t), f = fixture();
  for (const failure of ['packet', 'receipt']) {
    const fake = fakes(f), directory = join(root, failure);
    await assert.rejects(prepare({ ...f.assets, runDirectory: directory }, { ...fake.options,
      write: async (path, bytes) => {
        if ((failure === 'packet' && basename(path) === 'setup-packet.json') ||
          (failure === 'receipt' && basename(path) === 'receipt.json' && JSON.parse(Buffer.from(bytes).toString()).phase === 'complete')) throw fault('RUN_IO');
        await atomicPrivateWrite(path, bytes);
      } }), { code: 'RUN_IO' });
    assert.equal((await readRunReceipt(directory)).phase, 'failed');
    assert(!(await readdir(directory)).includes('setup-packet.json'));
    const second = fakes(f);
    await assert.rejects(prepare({ ...f.assets, runDirectory: directory }, second.options), { code: 'SEED_ALREADY_ATTEMPTED' });
    assert.equal(second.writes, 0);
  }
});

test('quickstart prepare: atomic private writes expose whole files and remove temporary files on rename failure', async t => {
  const directory = await scratch(t), path = join(directory, 'receipt.json');
  const old = jsonBytes({ phase: 'seeding' }), next = jsonBytes({ phase: 'complete', packetSha256: 'a'.repeat(64), padding: 'x'.repeat(100_000) });
  await atomicPrivateWrite(path, old);
  let done = false;
  const writing = atomicPrivateWrite(path, next).finally(() => { done = true; });
  while (!done) {
    const observed = await readFile(path);
    assert(observed.equals(old) || observed.equals(next)); JSON.parse(observed.toString());
  }
  await writing;
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await mkdir(join(directory, 'blocked'));
  await assert.rejects(atomicPrivateWrite(join(directory, 'blocked'), next), { code: 'RUN_IO' });
  assert.deepEqual((await readdir(directory)).sort(), ['blocked', 'receipt.json']);
});

test('quickstart prepare: down uses only saved instance and explicit volume option then retires the receipt', async t => {
  const root = await scratch(t), f = fixture();
  for (const volumes of [false, true]) {
    const directory = join(root, String(volumes)), fake = fakes(f);
    await prepare({ ...f.assets, runDirectory: directory }, fake.options);
    const result = await downRun(f.assets.manifest, directory, volumes, fake.docker);
    assert.equal(result.actions, 3); assert.deepEqual(fake.actions, ['stop-container', 'remove-container', 'remove-network']);
    assert.equal((await readRunReceipt(directory)).phase, 'down');
    const again = fakes(f);
    await assert.rejects(prepare({ ...f.assets, runDirectory: directory }, again.options), { code: 'SEED_ALREADY_ATTEMPTED' });
    assert.equal(again.writes, 0);
  }
});

test('quickstart prepare: startup failure retains its container id and down recovers only that receipt-named identity', async t => {
  const root = await scratch(t), directory = join(root, 'run'), f = fixture(), fake = fakes(f);
  const docker: DockerAdapter = { ...fake.docker, async up(run, record) {
    const id = await fake.docker.up(run); await record!(id); throw fault('DOCKER_FAILED');
  } };
  await assert.rejects(prepare({ ...f.assets, runDirectory: directory }, { ...fake.options, docker }), { code: 'DOCKER_FAILED' });
  const receipt = await readRunReceipt(directory);
  assert.equal(receipt.phase, 'failed'); assert.equal(receipt.containerId, 'b'.repeat(64)); assert.equal(receipt.instance, null);
  assert.equal(fake.writes, 0);
  await downRun(f.assets.manifest, directory, true, docker);
  assert.deepEqual(fake.actions, ['stop-container', 'remove-container', 'remove-network']);
});

test('quickstart prepare: closed receipt private mode and original manifest binding are required for down', async t => {
  const root = await scratch(t), directory = join(root, 'run'), f = fixture(), fake = fakes(f);
  await prepare({ ...f.assets, runDirectory: directory }, fake.options);
  await assert.rejects(downRun(Buffer.concat([Buffer.from(f.assets.manifest), Buffer.from(' ')]), directory, true, fake.docker), { code: 'CLEANUP_FOREIGN' });
  assert.equal(fake.actions.length, 0);
  const path = join(directory, 'receipt.json'), bytes = await readFile(path), value = JSON.parse(bytes.toString());
  await atomicPrivateWrite(path, jsonBytes({ ...value, arbitrary: 'private canary' }));
  await assert.rejects(readRunReceipt(directory), { code: 'RUN_INVALID' });
  await atomicPrivateWrite(path, bytes); await chmod(path, 0o644);
  await assert.rejects(readRunReceipt(directory), { code: 'RUN_INVALID' });
});

test('quickstart helper CLI: only implemented commands safe one-line summaries and fixed fault codes', async t => {
  const root = await scratch(t), f = fixture(), hash = 'a'.repeat(64);
  const success = await runQuickstart(['prepare', '--run-dir', join(root, 'run')], { assets: async () => f.assets,
    prepare: async () => ({ resources: 3, types: 3, manifestSha256: hash, receiptSha256: hash, packetSha256: hash }) });
  assert.equal(success.exitCode, 0); assert.match(success.line, /^PREPARE_OK resources=3 types=3 manifest=[a-f0-9]{64} receipt=[a-f0-9]{64} packet=[a-f0-9]{64}$/);
  for (const argv of [['verify'], ['up'], ['prepare', '--url', 'http://evil.invalid'], ['down', '--run-dir', 'relative'], ['down', '--run-dir', root, '--volumes', '--volumes']])
    assert.deepEqual(await runQuickstart(argv), { line: 'CLI_USAGE', exitCode: 2 });
  const failure = await runQuickstart(['prepare', '--run-dir', root], { assets: async () => { throw new Error('secret /path patient-id Docker output'); } });
  assert.deepEqual(failure, { line: 'HELPER_FAILED', exitCode: 1 });
  let explicit: boolean | undefined;
  const cleanup = await runQuickstart(['down', '--run-dir', root, '--volumes'], { assets: async () => f.assets,
    down: async (_manifest, _directory, volumes) => { explicit = volumes; return { actions: 2, receiptSha256: hash }; } });
  assert.equal(explicit, true); assert.deepEqual(cleanup, { line: `DOWN_OK actions=2 receipt=${hash}`, exitCode: 0 });
  const destination = join(root, 'forms.json');
  const args = ['configs', '--node', '/abs/node', '--cli', '/abs/cli', '--config', '/abs/config', '--out', destination];
  const configs = await runQuickstart(args);
  assert.equal(configs.exitCode, 0); assert.match(configs.line, /^CONFIGS_OK forms=4 sha256=[a-f0-9]{64}$/);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  assert.deepEqual(await runQuickstart(args), { line: 'LAUNCH_INVALID', exitCode: 1 });
});

/** A real loopback HTTP server that is NOT the Docker-reported container: HAPI 8.12.0 / 4.0.1 with empty seeded types. */
async function unrelatedHapi(t: TestContext) {
  const seen: string[] = [], stored = new Map<string, string>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      const route = req.url!.slice('/fhir/'.length);
      if (route === 'metadata') res.end('{"resourceType":"CapabilityStatement","fhirVersion":"4.0.1","software":{"name":"HAPI FHIR Server","version":"8.12.0"}}');
      else if (route.endsWith('?_summary=count')) {
        const type = route.split('?')[0]!;
        res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', total: [...stored.keys()].filter(k => k.startsWith(`${type}/`)).length }));
      } else if (req.method === 'PUT') {
        const body = parseResource(Buffer.concat(chunks));
        body.meta = { versionId: '1', lastUpdated: '2026-01-01T00:00:00.123Z', source: '#unrelated' };
        stored.set(route, stringifyFhir(body)); res.statusCode = 201; res.end('{}');
      } else {
        const body = stored.get(route);
        if (body === undefined) { res.statusCode = 404; res.end('{}'); } else res.end(body);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as AddressInfo).port;
  // Route the helper's fixed 127.0.0.1:18080 requests to this listener, as if it were the one listening on this host.
  const request = ((options: RequestOptions, callback: (res: IncomingMessage) => void) => realRequest({ ...options, port }, callback)) as unknown as typeof httpRequest;
  return { port, seen, request };
}
async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

test('quickstart prepare: listener probe counts only a refused loopback connection as free', async t => {
  const unrelated = await unrelatedHapi(t);
  assert.equal(await seedPortOccupied(unrelated.port), true);
  assert.equal(await seedPortOccupied(await closedLoopbackPort()), false);
  assert.equal(unrelated.seen.length, 0, 'a TCP probe sends no HTTP request');
});

test('quickstart prepare: distinct Docker-owned and local HTTP instances refuse with zero requests to the unrelated listener', async t => {
  const root = await scratch(t), f = fixture(), unrelated = await unrelatedHapi(t);
  const client = () => createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: {}, request: unrelated.request });
  // Docker (the fake) reports a valid owned container, but this host's seed target is the unrelated listener.
  const refused = fakes(f), directory = join(root, 'refused');
  await assert.rejects(prepare({ ...f.assets, runDirectory: directory }, { ...refused.options, client, probe: () => seedPortOccupied(unrelated.port) }),
    { code: 'PORT_IN_USE' });
  assert.equal(refused.ups, 0); assert.equal(unrelated.seen.length, 0, 'zero requests reach the unrelated listener');
  const receipt = await readRunReceipt(directory);
  assert.equal(receipt.phase, 'failed'); assert.equal(receipt.containerId, null);
  // Hazard control: without the listener refusal every check passes and the unrelated server receives every PUT.
  const control = fakes(f);
  await prepare({ ...f.assets, runDirectory: join(root, 'control') }, { ...control.options, client, probe: async () => seedPortOccupied(await closedLoopbackPort()) });
  assert.equal(unrelated.seen.filter(line => line.startsWith('PUT ')).length, f.manifest.resources.length);
});

/** A stateful local daemon behind the real adapter: Compose creates the project network and container from the run's compose.env. */
function fakeDaemon(options: { host?: string; upFault?: QuickstartFaultCode; upOutput?: string } = {}) {
  const calls: string[][] = [];
  const containers = new Map<string, { project: string; labels: Record<string, string>; running: boolean; network: string }>();
  const networks = new Map<string, { project: string; endpoints: Set<string> }>();
  let serial = 0;
  const id = (kind: string) => sha256(`${kind}-${++serial}`);
  const ports = { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] };
  const one = (value: unknown) => ({ stdout: JSON.stringify([value]), stderr: '' });
  const lines = (ids: string[]) => ({ stdout: ids.map(i => `${i}\n`).join(''), stderr: '' });
  const index = { Id: HELPER_BACKEND.imageIndexDigest, RepoDigests: [HAPI_IMAGE], Descriptor: { digest: HELPER_BACKEND.imageIndexDigest } };
  const child = { Id: HELPER_BACKEND.imageManifestDigest, Descriptor: { digest: HELPER_BACKEND.imageManifestDigest },
    Os: 'linux', Architecture: 'arm64', Config: { WorkingDir: '/app', User: '65532:65532' } };
  const execute: DockerExecutor = async (_file, argv) => {
    calls.push([...argv]);
    const [head, verb] = argv;
    if (head === 'context') return one({ Name: 'synthetic', Endpoints: { docker: { Host: options.host ?? 'unix:///synthetic/docker.sock' } } });
    if (head === 'compose') {
      const project = argv[argv.indexOf('--project-name') + 1]!;
      if (argv.includes('ps')) return lines([...containers].filter(([, c]) => c.project === project).map(([k]) => k));
      const env = Object.fromEntries((await readFile(argv[argv.indexOf('--env-file') + 1]!, 'utf8')).trim().split('\n').map(line => line.split('=')));
      let network = [...networks].find(([, n]) => n.project === project)?.[0];
      if (!network) { network = id('network'); networks.set(network, { project, endpoints: new Set() }); }
      const container = id('container'), running = options.upFault === undefined;
      containers.set(container, { project, network, running, labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': 'hapi',
        'io.fireboat.quickstart.run': env.FIREBOAT_QS_RUN, 'io.fireboat.quickstart.creation': env.FIREBOAT_QS_CREATION, 'io.fireboat.quickstart.compose': env.FIREBOAT_QS_COMPOSE } });
      if (running) networks.get(network)!.endpoints.add(container);
      if (options.upFault) throw fault(options.upFault); // created, then the CLI's deadline/output bound fails
      return { stdout: options.upOutput ?? '', stderr: '' };
    }
    if (head === 'image') return one(argv.includes('--platform') ? child : index);
    const target = argv.at(-1)!;
    if (head === 'container') {
      const c = containers.get(target);
      if (!c) throw new Error('No such container');
      if (verb === 'inspect') return one({ Id: target, Created: '2026-01-01T00:00:00.123456789Z', Image: HELPER_BACKEND.imageIndexDigest,
        ImageManifestDescriptor: { digest: HELPER_BACKEND.imageManifestDigest }, State: { Running: c.running }, Mounts: [],
        Config: { Image: HAPI_IMAGE, Labels: c.labels, Env: ['SPRING_DATASOURCE_URL=jdbc:h2:mem:test_mem', 'SPRING_DATASOURCE_DRIVERCLASSNAME=org.h2.Driver',
          'SPRING_DATASOURCE_USERNAME=sa', 'HIBERNATE_DIALECT=ca.uhn.fhir.jpa.model.dialect.HapiFhirH2Dialect'] },
        HostConfig: { Binds: null, Privileged: false, PublishAllPorts: false, NetworkMode: `${c.project}_default`, RestartPolicy: { Name: 'no' },
          LogConfig: { Type: 'none' }, PortBindings: ports },
        NetworkSettings: { Ports: c.running ? ports : {}, Networks: { [`${c.project}_default`]: { NetworkID: c.running ? c.network : '' } } } });
      if (verb === 'stop') { c.running = false; networks.get(c.network)?.endpoints.delete(target); }
      if (verb === 'rm') { if (c.running) throw new Error('running'); containers.delete(target); }
      return { stdout: '', stderr: '' };
    }
    if (head === 'network') {
      if (verb === 'ls') {
        const project = /label=com\.docker\.compose\.project=(\S+)/.exec(argv.join(' '))![1];
        return lines([...networks].filter(([, n]) => n.project === project).map(([k]) => k));
      }
      const n = networks.get(target);
      if (!n) throw new Error('No such network');
      if (verb === 'inspect') return one({ Name: `${n.project}_default`, Id: target, Driver: 'bridge', Scope: 'local',
        Labels: { 'com.docker.compose.project': n.project, 'com.docker.compose.network': 'default', 'com.docker.compose.version': '5.6.1' },
        Containers: Object.fromEntries([...n.endpoints].map(e => [e, { Name: 'hapi' }])) });
      if (verb === 'rm') { if (n.endpoints.size) throw new Error('active endpoints'); networks.delete(target); }
      return { stdout: '', stderr: '' };
    }
    throw new Error('unexpected docker command');
  };
  return { execute, calls, containers, networks };
}

test('quickstart prepare: repeated prepare and down with the real adapter leave no container or Compose network behind', async t => {
  const root = await scratch(t), f = fixture(), daemon = fakeDaemon();
  const adapter = await createDockerAdapter({ binary: process.execPath, environment: { PATH: '/usr/bin' }, execute: daemon.execute });
  for (const name of ['run-001', 'run-002', 'run-003']) {
    const fake = fakes(f), directory = join(root, name);
    await prepare({ ...f.assets, runDirectory: directory }, { ...fake.options, docker: adapter });
    assert.equal(daemon.networks.size, 1); assert.equal(daemon.containers.size, 1);
    const result = await downRun(f.assets.manifest, directory, false, adapter);
    assert.equal(result.actions, 3); assert.equal((await readRunReceipt(directory)).phase, 'down');
    assert.equal(daemon.containers.size, 0, name); assert.equal(daemon.networks.size, 0, name);
  }
  assert.equal(daemon.calls.filter(c => c[0] === 'network' && c[1] === 'rm').length, 3);
  assert.equal(daemon.calls.some(c => c.includes('prune')), false);
});

test('quickstart prepare: create-then-timeout and create-then-output-limit keep the exact container ID and down removes only it', async t => {
  const root = await scratch(t), f = fixture();
  for (const [code, option] of [['DOCKER_TIMEOUT', { upFault: 'DOCKER_TIMEOUT' }], ['DOCKER_LIMIT', { upFault: 'DOCKER_LIMIT' }],
    ['DOCKER_LIMIT', { upOutput: 'x'.repeat(DOCKER_LIMITS.bytes + 1) }]] as const) {
    const daemon = fakeDaemon(option), fake = fakes(f), directory = join(root, `${code}-${Object.keys(option)[0]}`);
    const adapter = await createDockerAdapter({ binary: process.execPath, environment: { PATH: '/usr/bin' }, execute: daemon.execute });
    await assert.rejects(prepare({ ...f.assets, runDirectory: directory }, { ...fake.options, docker: adapter }), { code });
    const receipt = await readRunReceipt(directory), [created] = [...daemon.containers.keys()];
    assert.equal(receipt.phase, 'failed'); assert.equal(receipt.containerId, created); assert.equal(fake.http.requests.length, 0);
    await downRun(f.assets.manifest, directory, false, adapter);
    assert.equal(daemon.containers.size, 0); assert.equal(daemon.networks.size, 0);
    assert.deepEqual(daemon.calls.filter(c => c[0] === 'container' && ['stop', 'rm'].includes(c[1]!)).map(c => c.at(-1)), [created, created]);
  }
});

test('quickstart prepare: a remote saved Docker context refuses before Compose with zero seed requests', async t => {
  const root = await scratch(t), f = fixture();
  for (const host of ['ssh://synthetic@remote.invalid', 'tcp://192.0.2.1:2376']) {
    const daemon = fakeDaemon({ host }), fake = fakes(f), directory = join(root, host.split(':')[0]!);
    const adapter = await createDockerAdapter({ binary: process.execPath, environment: { PATH: '/usr/bin', DOCKER_CONTEXT: 'saved' }, execute: daemon.execute });
    await assert.rejects(prepare({ ...f.assets, runDirectory: directory }, { ...fake.options, docker: adapter }), { code: 'DOCKER_ENDPOINT_REFUSED' });
    assert.deepEqual(daemon.calls, [['context', 'inspect']]); assert.equal(fake.http.requests.length, 0);
    assert.equal((await readRunReceipt(directory)).containerId, null);
  }
});
