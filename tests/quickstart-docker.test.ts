import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { HAPI_IMAGE, HAPI_PLATFORM, HELPER_BACKEND } from '../examples/quickstart/backend.js';
import { composeNetworkId, createDockerAdapter, DOCKER_LIMITS, dockerEnvironment, isLocalDockerEndpoint, ownedNetworkId, parseImageEvidence, parseInstanceEvidence, parseOwnedVolume,
  resolveDockerBinary } from '../examples/quickstart/docker.js';
import type { DockerExecutor, DockerOptions, DockerRun } from '../examples/quickstart/docker.js';
import { ownershipLabels } from '../examples/quickstart/instance.js';
import type { InstanceReceipt } from '../examples/quickstart/instance.js';
import { fault, pinsSha256, QUICKSTART_TARGET, sha256, validateSeedManifest } from '../examples/quickstart/manifest.js';
import { down } from '../examples/quickstart/down.js';

function fixture() {
  const run: DockerRun = { runId: 'a'.repeat(16), project: `fireboat-qs-${'a'.repeat(16)}`, creationNonce: 'c'.repeat(64),
    composeSha256: sha256('compose'), directory: '/synthetic path/run' };
  const id = 'b'.repeat(64), body = '{"resourceType":"Patient","id":"patient"}';
  const manifest = validateSeedManifest({ schema: 1, target: QUICKSTART_TARGET, pinsSha256: pinsSha256(), composeSha256: run.composeSha256,
    artifacts: { generatorSha256: sha256('g'), configSha256: sha256('c'), rawExportsSha256: sha256('r'), transformSha256: sha256('t') },
    backend: HELPER_BACKEND, resources: [{ type: 'Patient', id: 'patient', bytes: body.length, sha256: sha256(body), origin: 'edge' }] });
  const receipt: InstanceReceipt = { ...run, schema: 1, service: 'hapi', containerId: id, createdAt: '2026-01-01T00:00:00.123Z', volumes: [] };
  // Do not include DockerRun.directory in the closed receipt.
  delete (receipt as unknown as Record<string, unknown>).directory;
  const index = { Id: HELPER_BACKEND.imageIndexDigest, RepoDigests: [HAPI_IMAGE], Descriptor: { digest: HELPER_BACKEND.imageIndexDigest } };
  const child = { Id: HELPER_BACKEND.imageManifestDigest, Descriptor: { digest: HELPER_BACKEND.imageManifestDigest },
    Os: 'linux', Architecture: 'arm64', Config: { WorkingDir: '/app', User: '65532:65532' } };
  const ports = { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] };
  const container = { Id: id, Created: '2026-01-01T00:00:00.123456789Z', Image: HELPER_BACKEND.imageIndexDigest,
    ImageManifestDescriptor: { digest: HELPER_BACKEND.imageManifestDigest }, State: { Running: true }, Mounts: [],
    Config: { Image: HAPI_IMAGE, Labels: ownershipLabels(receipt), Env: [
      'SPRING_DATASOURCE_URL=jdbc:h2:mem:test_mem', 'SPRING_DATASOURCE_DRIVERCLASSNAME=org.h2.Driver', 'SPRING_DATASOURCE_USERNAME=sa',
      'HIBERNATE_DIALECT=ca.uhn.fhir.jpa.model.dialect.HapiFhirH2Dialect' ] },
    HostConfig: { Binds: null, Privileged: false, PublishAllPorts: false, NetworkMode: `${run.project}_default`, RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'none' }, PortBindings: ports }, NetworkSettings: { Ports: ports } };
  const json = (v: unknown) => JSON.stringify([v]);
  const networkId = 'd'.repeat(64);
  const network = { Name: `${run.project}_default`, Id: networkId, Driver: 'bridge', Scope: 'local', Containers: {},
    Labels: { 'com.docker.compose.project': run.project, 'com.docker.compose.network': 'default', 'com.docker.compose.version': '5.6.1' } };
  const context = (host: string) => json({ Name: 'synthetic', Endpoints: { docker: { Host: host, SkipTLSVerify: false } } });
  const local = context('unix:///synthetic path/docker.sock');
  return { run, id, manifest, receipt, index, child, container, json, networkId, network, context, local };
}

test('quickstart Docker: exact argv uses cached image compose no shell and a closed environment', async () => {
  const f = fixture(), calls: { file: string; argv: readonly string[]; options: DockerOptions }[] = [];
  const environment = { PATH: '/usr/bin', HOME: '/synthetic home', DOCKER_HOST: 'unix:///socket', DOCKER_CONTEXT: 'local', DOCKER_CONFIG: '/synthetic config',
    NODE_OPTIONS: '--require /private/canary', COMPOSE_FILE: '/private/foreign.yaml', HTTP_PROXY: 'http://canary', SECRET: 'canary' };
  let stopped = false;
  const execute: DockerExecutor = async (file, argv, options) => {
    calls.push({ file, argv, options });
    if (argv[0] === 'context') return { stdout: f.local, stderr: '' };
    if (argv[0] === 'network') return { stdout: argv[1] === 'ls' ? `${f.networkId}\n` : argv[1] === 'inspect' ? f.json(f.network) : '', stderr: '' };
    if (argv[0] === 'image') return { stdout: f.json(argv.includes('--platform') ? f.child : f.index), stderr: '' };
    if (argv[0] === 'container' && argv[1] === 'inspect') return { stdout: f.json(stopped ? { ...f.container, State: { Running: false }, NetworkSettings: { Ports: {} } } : f.container), stderr: '' };
    if (argv[0] === 'container' && argv[1] === 'stop') stopped = true;
    return { stdout: argv.includes('ps') ? `${f.id}\n` : '', stderr: '' };
  };
  const adapter = await createDockerAdapter({ binary: process.execPath, environment, execute });
  assert.equal(await adapter.up(f.run), f.id);
  assert.deepEqual(calls[0]!.argv, ['context', 'inspect']);
  assert.deepEqual(calls[1]!.argv, ['compose', '--project-directory', f.run.directory, '--env-file', join(f.run.directory, 'compose.env'),
    '-f', join(f.run.directory, 'compose.yaml'), '--project-name', f.run.project, 'up', '--detach', '--pull', 'never', '--no-build', '--no-deps', 'hapi']);
  assert.deepEqual(calls[2]!.argv, [...calls[1]!.argv.slice(0, 9), 'ps', '--all', '--quiet', 'hapi']);
  const evidence = await adapter.inspect(f.id, f.manifest);
  assert.equal(evidence.containerId, f.id); assert.equal(evidence.createdAt, f.receipt.createdAt);
  assert.deepEqual(evidence.backend, HELPER_BACKEND);
  const result = await down(f.manifest, f.receipt, adapter.cleanup(f.receipt, f.manifest), true);
  assert.equal(result.actions, 3);
  assert.deepEqual(calls.filter(c => ['stop', 'rm'].includes(c.argv[1]!)).map(c => c.argv), [
    ['container', 'stop', '--time', '10', f.id], ['container', 'rm', f.id], ['network', 'rm', f.networkId] ]);
  assert.deepEqual(calls.find(c => c.argv[0] === 'network')!.argv, ['network', 'ls', '--no-trunc', '--quiet',
    '--filter', `label=com.docker.compose.project=${f.run.project}`, '--filter', 'label=com.docker.compose.network=default']);
  assert(calls.every(c => c.file === process.execPath && c.options.shell === false && c.options.maxBuffer === DOCKER_LIMITS.bytes &&
    c.options.timeout === DOCKER_LIMITS.deadlineMs && c.options.killSignal === 'SIGKILL'));
  for (const call of calls) assert.deepEqual(call.options.env, { PATH: environment.PATH, HOME: environment.HOME, DOCKER_HOST: environment.DOCKER_HOST,
    DOCKER_CONTEXT: environment.DOCKER_CONTEXT, DOCKER_CONFIG: environment.DOCKER_CONFIG });
  assert.deepEqual(dockerEnvironment({ SECRET: 'canary' }), {});
});

test('quickstart Docker: binary is resolved once to an absolute executable without a shell lookup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fireboat-docker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await symlink(process.execPath, join(directory, 'docker'));
  const found = await resolveDockerBinary({ PATH: `.:relative:${directory}` }); assert.equal(found, process.execPath);
  const calls: string[] = [], adapter = await createDockerAdapter({ environment: { PATH: directory }, execute: async (file, argv) => {
    calls.push(file); return { stdout: argv[0] === 'context' ? fixture().local : '', stderr: '' };
  } });
  await rm(join(directory, 'docker'));
  await assert.rejects(adapter.up(fixture().run), { code: 'DOCKER_EVIDENCE_INVALID' });
  assert.deepEqual(calls, [process.execPath, process.execPath, process.execPath]);
  await assert.rejects(createDockerAdapter({ binary: 'docker', execute: async () => ({ stdout: '', stderr: '' }) }), { code: 'DOCKER_MISSING' });
});

test('quickstart Docker: compose start failure still records the exact created container for owned cleanup', async () => {
  const f = fixture(), recorded: string[] = [];
  const adapter = await createDockerAdapter({ binary: process.execPath, execute: async (_file, args) => {
    if (args[0] === 'context') return { stdout: f.local, stderr: '' };
    if (args.includes('up')) throw new Error('synthetic compose start failure');
    return { stdout: `${f.id}\n`, stderr: '' };
  } });
  await assert.rejects(adapter.up(f.run, async id => { recorded.push(id); }), { code: 'DOCKER_FAILED' });
  assert.deepEqual(recorded, [f.id]);
});

test('quickstart Docker: compose deadline and output-limit failures after dispatch also record the exact created container', async t => {
  const f = fixture();
  const cases: [string, () => Promise<Readonly<{ stdout: string; stderr: string }>>][] = [
    ['DOCKER_TIMEOUT', async () => { throw fault('DOCKER_TIMEOUT'); }], // execFile killed at its deadline
    ['DOCKER_LIMIT', async () => { throw fault('DOCKER_LIMIT'); }], // execFile maxBuffer exceeded
    ['DOCKER_LIMIT', async () => ({ stdout: 'x'.repeat(DOCKER_LIMITS.bytes + 1), stderr: '' })] // returned output over the bound
  ];
  for (const [code, up] of cases) {
    const recorded: string[] = [], seen: string[] = [];
    const adapter = await createDockerAdapter({ binary: process.execPath, execute: async (_file, args) => {
      seen.push(args.includes('up') ? 'up' : args.includes('ps') ? 'ps' : args[0]!);
      if (args[0] === 'context') return { stdout: f.local, stderr: '' };
      if (args.includes('up')) return up();
      return { stdout: `${f.id}\n`, stderr: '' };
    } });
    await assert.rejects(adapter.up(f.run, async id => { recorded.push(id); }), { code });
    assert.deepEqual(recorded, [f.id], code); assert.deepEqual(seen, ['context', 'up', 'ps']);
  }
  // The helper's own race deadline on a hung compose up, then a responsive discovery.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const recorded: string[] = [];
  const hung = await createDockerAdapter({ binary: process.execPath, execute: async (_file, args) =>
    args[0] === 'context' ? { stdout: f.local, stderr: '' } : args.includes('up') ? new Promise(() => {}) : { stdout: `${f.id}\n`, stderr: '' } });
  const pending = hung.up(f.run, async id => { recorded.push(id); }), check = assert.rejects(pending, { code: 'DOCKER_TIMEOUT' });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(DOCKER_LIMITS.deadlineMs); await check;
  assert.deepEqual(recorded, [f.id]);
});

test('quickstart Docker: a failed discovery after a post-dispatch fault keeps the original fault and records nothing', async () => {
  const f = fixture(), recorded: string[] = [];
  const adapter = await createDockerAdapter({ binary: process.execPath, execute: async (_file, args) => {
    if (args[0] === 'context') return { stdout: f.local, stderr: '' };
    if (args.includes('up')) throw fault('DOCKER_TIMEOUT');
    throw new Error('daemon unavailable');
  } });
  await assert.rejects(adapter.up(f.run, async id => { recorded.push(id); }), { code: 'DOCKER_TIMEOUT' });
  assert.equal(recorded.length, 0);
  // A missing binary is not post-dispatch: no discovery is attempted.
  const calls: string[] = [];
  const missing = await createDockerAdapter({ binary: process.execPath, execute: async (_file, args) => {
    calls.push(args[0]!); if (args[0] === 'context') return { stdout: f.local, stderr: '' }; throw fault('DOCKER_MISSING');
  } });
  await assert.rejects(missing.up(f.run, async id => { recorded.push(id); }), { code: 'DOCKER_MISSING' });
  assert.deepEqual(calls, ['context', 'compose']); assert.equal(recorded.length, 0);
});

test('quickstart Docker: remote DOCKER_HOST and remote saved or selected contexts refuse before any compose command', async () => {
  const f = fixture();
  for (const host of ['tcp://192.0.2.1:2376', 'ssh://synthetic@remote.invalid', 'tcp://127.0.0.1:2375', 'npipe:////./pipe/docker_engine', 'unix://relative.sock']) {
    let calls = 0;
    await assert.rejects(createDockerAdapter({ binary: process.execPath, environment: { PATH: '/usr/bin', DOCKER_HOST: host },
      execute: async () => { calls++; return { stdout: '', stderr: '' }; } }), { code: 'DOCKER_ENDPOINT_REFUSED' });
    assert.equal(calls, 0, host);
  }
  for (const host of ['unix:///var/run/docker.sock', 'unix:///synthetic home/.colima/default/docker.sock']) assert.equal(isLocalDockerEndpoint(host), true);
  // The effective endpoint (DOCKER_CONTEXT or the saved current context) is resolved by the same CLI before provisioning.
  const remote = [f.context('ssh://synthetic@remote.invalid'), f.context('tcp://192.0.2.1:2376'), f.json({ Name: 'remote', Endpoints: {} }),
    f.json({ Name: 'remote', Endpoints: { docker: { Host: 'unix://' } } })];
  for (const text of remote) {
    const calls: string[][] = [], recorded: string[] = [];
    const adapter = await createDockerAdapter({ binary: process.execPath, environment: { PATH: '/usr/bin', DOCKER_CONTEXT: 'remote' },
      execute: async (_file, argv) => { calls.push([...argv]); return { stdout: argv[0] === 'context' ? text : `${f.id}\n`, stderr: '' }; } });
    await assert.rejects(adapter.up(f.run, async id => { recorded.push(id); }), (error: { code?: string }) =>
      ['DOCKER_ENDPOINT_REFUSED', 'DOCKER_EVIDENCE_INVALID'].includes(error.code ?? ''));
    assert.deepEqual(calls, [['context', 'inspect']]); assert.deepEqual(recorded, []);
  }
  for (const text of ['not json', '[]', f.json({ Name: 'remote' })]) {
    const adapter = await createDockerAdapter({ binary: process.execPath, execute: async () => ({ stdout: text, stderr: '' }) });
    await assert.rejects(adapter.up(f.run), { code: 'DOCKER_EVIDENCE_INVALID' });
  }
});

test('quickstart Docker: network cleanup removes only this run project network by exact inspected ID with no endpoints', async () => {
  const f = fixture();
  const network = (edit: Record<string, unknown>) => ({ ...f.network, ...edit });
  const attempt = async (listed: string, inspected: unknown, options: { container?: unknown; project?: string } = {}) => {
    const calls: string[][] = [];
    const adapter = await createDockerAdapter({ binary: process.execPath, execute: async (_file, argv) => {
      calls.push([...argv]);
      if (argv[0] === 'image') return { stdout: f.json(argv.includes('--platform') ? f.child : f.index), stderr: '' };
      if (argv[0] === 'container') return { stdout: f.json(options.container ?? f.container), stderr: '' };
      if (argv[1] === 'ls') return { stdout: listed, stderr: '' };
      if (argv[1] === 'inspect') return { stdout: f.json(inspected), stderr: '' };
      return { stdout: '', stderr: '' };
    } });
    const executor = adapter.cleanup(f.receipt, f.manifest);
    await executor.inspect();
    const result = executor.execute({ kind: 'remove-network', project: options.project ?? f.run.project });
    return { result, calls, removed: () => calls.filter(c => c[0] === 'network' && c[1] === 'rm') };
  };
  const ok = await attempt(`${f.networkId}\n`, f.network); await ok.result;
  assert.deepEqual(ok.removed(), [['network', 'rm', f.networkId]]);
  const absent = await attempt('', f.network); await absent.result;
  assert.deepEqual(absent.removed(), []); assert.equal(absent.calls.some(c => c[1] === 'inspect' && c[0] === 'network'), false);
  const recordedOn = (id: string) => ({ ...f.container, NetworkSettings: { ...f.container.NetworkSettings, Networks: { [`${f.run.project}_default`]: { NetworkID: id } } } });
  const bound = await attempt(`${f.networkId}\n`, f.network, { container: recordedOn(f.networkId) }); await bound.result;
  assert.deepEqual(bound.removed(), [['network', 'rm', f.networkId]]);
  const foreign: [string, unknown, { container?: unknown; project?: string }?][] = [
    [`${f.networkId}\n`, network({ Labels: { ...f.network.Labels, 'com.docker.compose.project': 'root-project' } })],
    [`${f.networkId}\n`, network({ Labels: { ...f.network.Labels, 'com.docker.compose.network': 'shared' } })],
    [`${f.networkId}\n`, network({ Name: 'bridge' })], [`${f.networkId}\n`, network({ Driver: 'overlay' })],
    [`${f.networkId}\n`, network({ Containers: { ['e'.repeat(64)]: { Name: 'foreign-endpoint' } } })],
    [`${f.networkId}\n`, network({ Id: 'e'.repeat(64) })],
    [`${f.networkId}\n${'e'.repeat(64)}\n`, f.network], ['not-a-network-id\n', f.network],
    [`${f.networkId}\n`, f.network, { container: recordedOn('e'.repeat(64)) }],
    [`${f.networkId}\n`, f.network, { project: `fireboat-qs-${'e'.repeat(16)}` }]
  ];
  for (const [listed, inspected, options] of foreign) {
    const run = await attempt(listed, inspected, options);
    await assert.rejects(run.result, (error: { code?: string }) => ['CLEANUP_FOREIGN', 'DOCKER_EVIDENCE_INVALID'].includes(error.code ?? ''));
    assert.deepEqual(run.removed(), []);
  }
  assert.equal(composeNetworkId(f.json(f.container), f.run.project), undefined);
  assert.throws(() => composeNetworkId(f.json(recordedOn('mutable-name')), f.run.project), { code: 'DOCKER_EVIDENCE_INVALID' });
  assert.equal(ownedNetworkId(f.json(f.network), f.run), f.networkId);
});

test('quickstart Docker: identity replacement between cleanup actions prevents the removal', async () => {
  const f = fixture(); let inspections = 0;
  const removed: string[][] = [];
  const adapter = await createDockerAdapter({ binary: process.execPath, execute: async (_file, argv) => {
    if (argv[0] === 'image') return { stdout: f.json(argv.includes('--platform') ? f.child : f.index), stderr: '' };
    if (argv[1] === 'inspect') {
      inspections++;
      const container = inspections < 3 ? f.container : { ...f.container,
        Config: { ...f.container.Config, Labels: { ...f.container.Config.Labels, 'io.fireboat.quickstart.creation': 'e'.repeat(64) } } };
      return { stdout: f.json(container), stderr: '' };
    }
    removed.push([...argv]); return { stdout: '', stderr: '' };
  } });
  await assert.rejects(down(f.manifest, f.receipt, adapter.cleanup(f.receipt, f.manifest), true), { code: 'CLEANUP_FAILED' });
  assert.deepEqual(removed, [['container', 'stop', '--time', '10', f.id]]);
});

test('quickstart Docker: malformed image chain provenance mount storage or loopback publication refuses', () => {
  const f = fixture();
  parseImageEvidence(f.json(f.index), f.json(f.child), f.manifest);
  for (const child of [{ ...f.child, Id: `sha256:${'e'.repeat(64)}` }, { ...f.child, Architecture: 'amd64' },
    { ...f.child, Descriptor: { digest: HELPER_BACKEND.imageIndexDigest } }])
    assert.throws(() => parseImageEvidence(f.json(f.index), f.json(child), f.manifest), { code: 'DOCKER_EVIDENCE_INVALID' });
  for (const value of [
    { ...f.container, Config: { ...f.container.Config, Labels: {} } },
    { ...f.container, Config: { ...f.container.Config, Image: 'hapiproject/hapi:latest' } },
    { ...f.container, ImageManifestDescriptor: { digest: HELPER_BACKEND.imageIndexDigest } },
    { ...f.container, Mounts: [{ Type: 'bind', Source: '/foreign', Destination: '/data' }] },
    { ...f.container, Config: { ...f.container.Config, Env: [] } },
    { ...f.container, NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '18080' }] } } },
    { ...f.container, HostConfig: { ...f.container.HostConfig, PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18091' }] } } },
    { ...f.container, State: { Running: false } }
  ]) assert.throws(() => parseInstanceEvidence(f.json(value), f.manifest), { code: 'DOCKER_EVIDENCE_INVALID' });
  for (const text of ['not json', '[]', '[{},{}]']) assert.throws(() => parseInstanceEvidence(text, f.manifest), { code: 'DOCKER_EVIDENCE_INVALID' });
});

test('quickstart Docker: output deadline and process faults are bounded fixed codes without Docker text', async t => {
  const f = fixture();
  const oversized = await createDockerAdapter({ binary: process.execPath, execute: async () => ({ stdout: 'x'.repeat(DOCKER_LIMITS.bytes + 1), stderr: '' }) });
  await assert.rejects(oversized.up(f.run), { code: 'DOCKER_LIMIT', message: 'DOCKER_LIMIT' });
  const failed = await createDockerAdapter({ binary: process.execPath, execute: async () => { throw new Error('Docker /private/path credential patient-id'); } });
  await assert.rejects(failed.up(f.run), { code: 'DOCKER_FAILED', message: 'DOCKER_FAILED' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timed = await createDockerAdapter({ binary: process.execPath, execute: async () => new Promise(() => {}) });
  const pending = timed.up(f.run), check = assert.rejects(pending, { code: 'DOCKER_TIMEOUT', message: 'DOCKER_TIMEOUT' });
  t.mock.timers.tick(DOCKER_LIMITS.deadlineMs); await check;
});

test('quickstart Docker: volume identities bind creation labels and fresh inspection before explicit removal', async () => {
  const f = fixture(), volume = { Name: `${f.run.project}-data`, CreatedAt: f.receipt.createdAt, Labels: ownershipLabels(f.receipt),
    Driver: 'local', Scope: 'local', Options: null, Mountpoint: '/var/lib/docker/volumes/synthetic/_data' };
  const owned = parseOwnedVolume(f.json(volume), f.run);
  assert.equal(owned.createdAt, f.receipt.createdAt); assert.match(owned.identitySha256, /^[a-f0-9]{64}$/);
  for (const edit of [{ Labels: {} }, { Name: 'root-owned' }, { Driver: 'remote' }])
    assert.throws(() => parseOwnedVolume(f.json({ ...volume, ...edit }), f.run), { code: 'DOCKER_EVIDENCE_INVALID' });
  const calls: readonly string[][] = [], mutable = calls as string[][];
  let current = volume;
  const adapter = await createDockerAdapter({ binary: process.execPath, execute: async (_file, argv) => {
    mutable.push([...argv]); return { stdout: argv[1] === 'inspect' ? f.json(current) : '', stderr: '' };
  } });
  const executor = adapter.cleanup({ ...f.receipt, volumes: [owned] }, f.manifest);
  current = { ...volume, CreatedAt: '2026-01-02T00:00:00.123Z' };
  await assert.rejects(executor.execute({ kind: 'remove-volume', name: owned.name, identitySha256: owned.identitySha256 }), { code: 'CLEANUP_FOREIGN' });
  assert.equal(calls.filter(c => c[1] === 'rm').length, 0);
  current = volume;
  await executor.execute({ kind: 'remove-volume', name: owned.name, identitySha256: owned.identitySha256 });
  assert.deepEqual(calls.at(-1), ['volume', 'rm', owned.name]);
});
