#!/usr/bin/env node
// DEFERRED execution. Does not prepare/start/recreate/stop HAPI. Requires the
// installed helper's completed prepare receipt and verifies live ownership first.
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { assertImageConfig, bytesOf, checkRef, fail, regularFile, sha256, verifyInstallation } from './inventory.mjs';
import { docker, flags, runArgs } from './commands.mjs';
import { judgeShutdowns, openImageSession } from './session.mjs';

const here = dirname(fileURLToPath(import.meta.url)), json = async path => JSON.parse(await readFile(path, 'utf8'));
const equal = isDeepStrictEqual;
/**
 * The ordinary upstream timeout is set well beyond the measured windows, so only forwarded cancellation can close the
 * hanging upstream socket in time: the same request first stays open, uncancelled, for controlHoldMs (the control),
 * then must close within deadlineMs of the abort.
 */
export const CANCELLATION = Object.freeze({ upstreamTimeoutMs: 30_000, controlHoldMs: 4_000, deadlineMs: 4_000, requestTimeoutMs: 25_000 });
export function cancellationConfig(value) {
  return { ...value, limits: { ...value.limits, timeoutMs: CANCELLATION.upstreamTimeoutMs } };
}
export function judgeCancellation({ control, closed, abortedAt, timing = CANCELLATION }) {
  const window = timing.controlHoldMs + timing.deadlineMs;
  if (!(timing.upstreamTimeoutMs >= 3 * window && timing.requestTimeoutMs > window && timing.deadlineMs <= timing.controlHoldMs)) fail('OCI_CANCELLATION_TIMING');
  if (!control || control.hanging !== 1 || control.hangClosed !== 0 || !(control.heldMs >= timing.controlHoldMs)) fail('OCI_CANCELLATION_CONTROL');
  const latency = closed?.observedAt - abortedAt;
  if (!closed || closed.hangClosed !== 1 || !Number.isFinite(latency) || latency < 0 || latency > timing.deadlineMs) fail('OCI_CANCELLATION');
  return { cancelled: true, responsive: true, upstreamSocketClosed: true, closeLatencyMs: latency, deadlineMs: timing.deadlineMs,
    uncancelledControlOpenMs: control.heldMs, upstreamTimeoutMs: timing.upstreamTimeoutMs };
}
export function removableContainer(inspection, owner, name) {
  if (!/^[a-f0-9]{16}$/.test(owner) || !name.startsWith(`fireboat-s10-${owner}-`) ||
    inspection.Name !== `/${name}` || inspection.Config?.Labels?.['io.fireboat.s10.run'] !== owner ||
    !/^[a-f0-9]{64}$/.test(inspection.Id)) fail('OCI_CLEANUP_FOREIGN');
  return inspection.Id;
}
export function assertContainer(inspection, image, network) {
  const host = inspection.HostConfig;
  if (inspection.Config?.Image !== image || inspection.Config.User !== '1000:1000' || !host || host.NetworkMode !== network ||
    host.ReadonlyRootfs !== true || host.Privileged !== false || host.PublishAllPorts !== false || host.CapAdd?.length ||
    !equal(host.CapDrop, ['ALL']) || !host.SecurityOpt?.includes('no-new-privileges:true') ||
    Object.keys(host.PortBindings ?? {}).length || Object.keys(inspection.Config.ExposedPorts ?? {}).length ||
    inspection.Mounts?.some(m => m.RW !== false || m.Type !== 'bind') || host.LogConfig?.Type !== 'none') fail('OCI_CONTAINER_HARDENING');
}
class OwnedContainers {
  constructor(owner) { this.owner = owner; this.names = new Set(); this.cleaned = 0; this.next = 0; }
  reserve(role) {
    const name = `fireboat-s10-${this.owner}-${role}-${++this.next}`;
    this.names.add(name); return name;
  }
  async inspect(name) {
    const result = await docker(['container', 'inspect', name], { allowFailure: true });
    if (result.code === 1 && result.stdout.trim() === '[]' && /No such (?:object|container)/i.test(result.stderr)) return undefined;
    if (result.code !== 0) fail('OCI_CLEANUP_INSPECT');
    const list = JSON.parse(result.stdout);
    if (list.length !== 1) fail('OCI_CLEANUP_INSPECT');
    removableContainer(list[0], this.owner, name); return list[0];
  }
  async finish(name, requireGone = false) {
    if (!this.names.has(name)) fail('OCI_CLEANUP_FOREIGN');
    const current = await this.inspect(name);
    if (current) await docker(['container', 'rm', '--force', removableContainer(current, this.owner, name)]);
    this.names.delete(name); this.cleaned++;
    if (current && requireGone) fail('OCI_STDIO_SHUTDOWN');
  }
  async cleanup() {
    const errors = [];
    for (const name of [...this.names]) try { await this.finish(name); } catch (error) { errors.push(error); }
    if (errors.length) fail('OCI_CLEANUP_FAILED');
  }
}

export async function runGates({ build: buildInput, packet: packetInput, helper: helperInput, gateway: gatewayInput, preparedRun: runInput, out }) {
  if (process.versions.node !== '24.22.0') fail('OCI_NODE_VERSION');
  const [build, packet, helper, gateway, preparedRun] = await Promise.all([buildInput, packetInput, helperInput, gatewayInput, runInput].map(path => realpath(path)));
  for (const input of [build, packet, helper, gateway, preparedRun, here]) {
    if (!relative(input, out).startsWith('..') || !relative(out, input).startsWith('..')) fail('OCI_DESTINATION');
  }
  const handoffBytes = await regularFile(build, 's10-handoff.json'), handoff = JSON.parse(handoffBytes), upstream = await regularFile(packet, 's10-handoff.json');
  if (handoff.schema !== 'fireboat-s10-handoff/1' || handoff.oci?.upstreamHandoffSha256 !== sha256(upstream) ||
    !equal(handoff.binding, JSON.parse(upstream).binding)) fail('OCI_PACKET_BINDING');
  const inventory = JSON.parse(await checkRef(build, handoff.oci.inventory)), image = handoff.oci.localId;
  if (inventory.image.localId !== image) fail('OCI_IMAGE_BINDING');
  for (const row of inventory.recipes) await checkRef(here, row);
  const helperPayload = JSON.parse(await checkRef(packet, handoff.installedFiles.quickstart));
  await verifyInstallation(helper, helperPayload, JSON.parse(await checkRef(packet, handoff.installedTrees.quickstart.document)), 'quickstart');
  const gatewayPayload = await verifyInstallation(gateway, JSON.parse(await checkRef(packet, handoff.installedFiles.gateway)),
    JSON.parse(await checkRef(packet, handoff.installedTrees.gateway.document)), 'gateway');
  if (!equal(gatewayPayload, JSON.parse(await checkRef(build, inventory.application)))) fail('OCI_IMAGE_BINDING');
  const inspectedImage = JSON.parse((await docker(['image', 'inspect', image])).stdout)[0]; assertImageConfig(inspectedImage.Config);
  if (!equal(inspectedImage.RootFS.Layers, inventory.image.layers.map(layer => layer.diffId))) fail('OCI_IMAGE_BINDING');
  const module = name => import(pathToFileURL(join(helper, `dist/examples/quickstart/${name}.js`)).href);
  const [{ loadHelperAssets }, { validateHelperAssets }, { readRunReceipt }, { createDockerAdapter }, { ownedInstance }, { verify }] =
    await Promise.all(['main', 'prepare', 'run-state', 'docker', 'instance', 'verify'].map(module));
  const assets = await loadHelperAssets(), { manifest, manifestSha256 } = validateHelperAssets(assets), receipt = await readRunReceipt(preparedRun);
  if (receipt.phase !== 'complete' || receipt.manifestSha256 !== manifestSha256 || !receipt.instance) fail('OCI_HELPER_RUN');
  const adapter = await createDockerAdapter(), evidence = await adapter.inspect(receipt.instance.containerId, manifest);
  if (!ownedInstance(evidence, receipt.instance, manifest)) fail('OCI_HELPER_OWNERSHIP');
  const network = `container:${receipt.instance.containerId}`;
  // Only now create output and our own containers. HAPI stays helper-owned.
  await mkdir(out, { mode: 0o700 });
  const owner = randomBytes(8).toString('hex'), owned = new OwnedContainers(owner), gates = inventory.gates.map(row => ({ ...row }));
  const report = { schema: 'fireboat-s10-gates/1', status: 'unverified', image, manifestDigest: inventory.image.manifestDigest,
    configDigest: inventory.image.configDigest, handoffSha256: sha256(handoffBytes), upstreamHandoffSha256: sha256(upstream),
    binding: handoff.binding, platform: 'linux/arm64', collector: { os: process.platform, arch: process.arch, node: process.versions.node },
    helperReceiptSha256: sha256(await regularFile(preparedRun, 'receipt.json')), gates, supplyChain: inventory.supplyChain,
    otherCells: [{ platform: 'linux/amd64', status: 'unverified' }, { platform: 'native-linux-host', status: 'unverified' }],
    observation: 'Clean sessions use the image entrypoint; observed sessions bridge the installed helper fd-3 observer over a separate attached stderr channel. MCP stdout bytes are unchanged.',
    hapiLifecycle: 'owned and cleaned only by the installed helper; excluded from S10 runner cleanup' };
  const put = (name, value) => writeFile(join(out, name), bytesOf(value), { flag: 'wx', mode: 0o600 });
  const step = async (gate, action) => {
    const row = gates.find(g => g.gate === gate); if (!row) fail('OCI_GATE_NAME');
    try { const result = await action(); row.status = 'passed'; if (result !== undefined) row.evidence = result; return result; }
    catch (error) { row.status = 'failed'; throw error; }
  };
  const ownArgs = (role, mounts = []) => {
    const name = owned.reserve(role);
    return { name, args: [...runArgs(image, network, mounts), '--name', name, '--label', `io.fireboat.s10.run=${owner}`] };
  };
  const config = join(out, 'container.config.json');
  await writeFile(config, await checkRef(packet, handoff.configuration.container), { flag: 'wx', mode: 0o600 });
  const observer = join(out, 'request-observer.mjs');
  await writeFile(observer, await regularFile(helper, 'dist/examples/quickstart/request-observer.js'), { flag: 'wx', mode: 0o444 });
  await chmod(observer, 0o444);
  // Helper snapshots remain private 0600. Mount a byte-identical 0444 copy under
  // our private 0700 output directory so UID 1000 can read the single file.
  let snapshot = 0;
  const mountedConfig = async path => {
    const target = join(out, `mount-${++snapshot}.config.json`);
    await writeFile(target, await readFile(path), { flag: 'wx', mode: 0o444 }); await chmod(target, 0o444); return target;
  };
  const doctor = async launch => {
    const path = typeof launch === 'string' ? launch : launch.config;
    const { name, args } = ownArgs('doctor', [[await mountedConfig(path), '/run/fireboat/config.json']]);
    try { const result = await docker([...args, '-i', image, '--doctor', '--config', '/run/fireboat/config.json'], { allowFailure: true });
      return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr }; }
    finally { await owned.finish(name, true); }
  };
  const configFor = async (name, baseUrl, adjust = value => value) => {
    const value = await json(config); value.source.baseUrl = baseUrl;
    const path = join(out, `${name}.config.json`); await put(`${name}.config.json`, adjust(value)); return path;
  };
  // Exit status of every opened session, recorded when it is closed; the startup-shutdown gate judges all of them.
  const shutdowns = new Map(); let opened = 0;
  const session = async launch => {
    const name = owned.reserve('session');
    const connection = await openImageSession({ helper, observer, recipe: here, image, network, owner, name,
      finish: name => owned.finish(name, true), config: await mountedConfig(launch.config), era: launch.era, observe: launch.observe });
    opened++;
    const close = async () => { const status = await connection.close(); if (!shutdowns.has(name)) shutdowns.set(name, status); return status; };
    try { assertContainer(await owned.inspect(name), image, network); return { ...connection, close }; }
    catch (error) { await close(); throw error; }
  };
  try {
    await step('helper-namespace', async () => {
      const { name, args } = ownArgs('namespace', [[here, '/s10/recipe']]);
      try {
        const result = await docker([...args, '--entrypoint', '/usr/local/bin/node', image, '/s10/recipe/probe.mjs']);
        const checked = JSON.parse(result.stdout);
        if (!/^net:\[\d+\]$/.test(checked.namespace)) fail('OCI_NAMESPACE');
        report.hardening = checked; return { status: 'live-helper-ownership-verified', networkMode: 'container:helper-owned-hapi' };
      } finally { await owned.finish(name, true); }
    });
    await step('attached-stdio-doctor', async () => {
      const result = await doctor(config);
      if (result.exitCode !== 0 || result.stderr || !result.stdout.startsWith('doctor: ready\n')) fail('OCI_DOCTOR');
      await put('doctor.json', { ...result, stderr: '' }); return { status: 'ready', outputSha256: sha256(result.stdout) };
    });
    await step('negative-egress', async () => {
      for (const [name, url] of [['external', 'http://192.0.2.1:8080/fhir'], ['hostname', 'http://localhost:8080/fhir']]) {
        const result = await doctor(await configFor(name, url));
        if (result.exitCode !== 2 || result.stdout || !/^fireboat: CONFIG_INVALID\n$/.test(result.stderr)) fail('OCI_EGRESS_NEGATIVE');
      }
      return { rejectedBeforeTransport: 2, scope: 'gateway literal-loopback policy; no OS egress-firewall claim' };
    });
    const fixture = ownArgs('fixture', [[here, '/s10/recipe']]);
    await docker([...fixture.args, '--detach', '--entrypoint', '/usr/local/bin/node', image, '/s10/recipe/fixture.mjs']);
    const fixtureControl = async command => {
      const result = await docker(['exec', fixture.name, '/usr/local/bin/node', '/s10/recipe/fixture.mjs', command], { allowFailure: true });
      if (result.code !== 0) fail('OCI_FIXTURE'); return JSON.parse(result.stdout);
    };
    const poll = async (predicate, end = Date.now() + 15_000) => {
      do { try { const state = await fixtureControl('status'); if (predicate(state)) return { ...state, observedAt: Date.now() }; } catch { /* bounded readiness only */ }
        await delay(200); } while (Date.now() < end);
      fail('OCI_FIXTURE_TIMEOUT');
    };
    const fixtureState = await poll(() => true);
    const fixtureInspection = await owned.inspect(fixture.name); assertContainer(fixtureInspection, image, network);
    if (fixtureState.namespace !== report.hardening.namespace) fail('OCI_NAMESPACE');
    await step('proxy', async () => {
      const proxyEnv = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].flatMap(k => ['--env', `${k}=http://127.0.0.1:19082`]);
      proxyEnv.push('--env', 'NODE_USE_ENV_PROXY=1', '--env', 'NO_PROXY=', '--env', 'no_proxy=');
      const control = ownArgs('proxy-control');
      try {
        const code = "import {get} from 'node:http';const r=get('http://127.0.0.1:19081/control',{timeout:2000},s=>{s.resume();s.on('end',()=>{if(s.statusCode!==418)process.exitCode=1})});r.on('error',()=>{process.exitCode=1});r.on('timeout',()=>r.destroy())";
        await docker([...control.args, ...proxyEnv, '--entrypoint', '/usr/local/bin/node', image, '--input-type=module', '-e', code]);
      } finally { await owned.finish(control.name, true); }
      const positive = await fixtureControl('status');
      if (positive.proxy < 1 || positive.trap !== 0) fail('OCI_PROXY_CONTROL');
      await fixtureControl('reset');
      const actual = ownArgs('proxy', [[await mountedConfig(config), '/run/fireboat/config.json']]);
      try {
        const result = await docker([...actual.args, '-i', ...proxyEnv, image, '--doctor', '--config', '/run/fireboat/config.json']);
        if (!result.stdout.startsWith('doctor: ready\n') || result.stderr) fail('OCI_PROXY_GATEWAY');
      } finally { await owned.finish(actual.name, true); }
      const after = await fixtureControl('status');
      if (after.proxy !== 0 || after.trap !== 0) fail('OCI_PROXY_ESCAPE');
      return { positiveControlProxyRequests: positive.proxy, gatewayProxyRequests: after.proxy };
    });
    await step('redirect', async () => {
      await fixtureControl('reset');
      const result = await doctor(await configFor('redirect', 'http://127.0.0.1:19080/redirect/fhir'));
      const state = await fixtureControl('status');
      if (result.exitCode !== 1 || state.redirects < 1 || state.trap !== 0 || state.proxy !== 0) fail('OCI_REDIRECT');
      return { rejected: state.redirects, followed: state.trap };
    });
    await step('cancellation', async () => {
      await fixtureControl('reset');
      const cancelConfig = await configFor('cancel', 'http://127.0.0.1:19080/hang/fhir', cancellationConfig);
      const connection = await session({ config: cancelConfig, era: 'modern', observe: true });
      try {
        let control;
        const result = await connection.cancel(async () => {
          await poll(s => s.hanging === 1);
          // Uncancelled control: the same upstream request must stay open for the whole hold.
          const heldFrom = Date.now(); await delay(CANCELLATION.controlHoldMs);
          control = { ...(await fixtureControl('status')), heldMs: Date.now() - heldFrom };
        }, CANCELLATION.requestTimeoutMs);
        let closed;
        try { closed = await poll(s => s.hangClosed === 1, result.abortedAt + CANCELLATION.deadlineMs); } catch { closed = undefined; }
        return judgeCancellation({ control, closed, abortedAt: result.abortedAt });
      } finally { await connection.close(); }
    });
    await step('tasks-18-both-eras', async () => {
      const cli = join(gateway, 'node_modules/@fireboat/gateway/dist/packages/server/src/cli.js');
      const tasks = await verify({ runDirectory: preparedRun, node: process.execPath, cli, config, assets },
        { openSession: session, doctor, target: 'http://127.0.0.1:8080/fhir' });
      if (tasks.runs.length !== 18 || tasks.passed !== 18 || tasks.failed !== 0 || tasks.controls.length !== 2 || tasks.controls.some(c => c.status !== 'pass') ||
        new Set(tasks.runs.map(r => `${r.era}:${r.task}:${r.arm}`)).size !== 18) fail('OCI_TASKS');
      await put('tasks.json', tasks);
      return { runs: 18, passed: 18, independentTasks: 3, eras: ['modern', 'legacy'], evidenceSha256: tasks.evidenceSha256,
        limitations: [...new Set(tasks.runs.flatMap(r => r.limitations))].sort() };
    });
    await step('startup-shutdown', async () => judgeShutdowns([...shutdowns.values()], opened));
    await owned.cleanup();
    await step('owned-cleanup', async () => {
      if (owned.names.size !== 0 || !owned.cleaned) fail('OCI_CLEANUP_FAILED');
      // HAPI ownership and running state must still be intact after our cleanup.
      if (!ownedInstance(await adapter.inspect(receipt.instance.containerId, manifest), receipt.instance, manifest)) fail('OCI_HELPER_OWNERSHIP');
      return { containers: owned.cleaned, helperHapi: 'still-running; cleanup remains with helper' };
    });
    report.status = 'runtime-gates-passed; supply-chain-and-other-cells-unverified';
  } catch (error) {
    report.status = 'failed'; report.fault = /^[A-Z_]+$/.test(error?.code ?? error?.message ?? '') ? (error.code ?? error.message) : 'OCI_GATES_FAILED';
    throw error;
  } finally {
    try { await owned.cleanup(); }
    catch { report.status = 'failed'; report.cleanup = 'failed'; process.exitCode = 1; }
    await put('gates.json', report);
  }
  if (report.status === 'failed') fail('OCI_GATES_FAILED');
  console.log(`OCI_GATES_OK runs=18 image=${image} report=${sha256(bytesOf(report))} supply_chain=unverified`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = flags(process.argv.slice(2), ['--build', '--packet', '--helper-install', '--gateway-install', '--prepared-run', '--out']);
    await runGates({ build: args['--build'], packet: args['--packet'], helper: args['--helper-install'], gateway: args['--gateway-install'],
      preparedRun: args['--prepared-run'], out: args['--out'] });
  } catch (error) { console.error(`OCI_GATES_FAILED ${/^[A-Z_]+$/.test(error?.code ?? error?.message ?? '') ? (error.code ?? error.message) : 'OCI_FAILED'}`); process.exitCode = 1; }
}
