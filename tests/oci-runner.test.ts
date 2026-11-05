import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { FhirGateway, type GatewayConfig } from '../packages/core/src/index.js';

const runner = await import(new URL('../packaging/oci/run-gates.mjs', import.meta.url).href);
const build = await import(new URL('../packaging/oci/build.mjs', import.meta.url).href);
const session = await import(new URL('../packaging/oci/session.mjs', import.meta.url).href);

test('OCI gates: cleanup requires this run label, generated name and exact observed container ID', () => {
  const owner = 'a'.repeat(16), name = `fireboat-s10-${owner}-session-1`, id = 'b'.repeat(64);
  const valid = { Name: `/${name}`, Id: id, Config: { Labels: { 'io.fireboat.s10.run': owner } } };
  assert.equal(runner.removableContainer(valid, owner, name), id);
  for (const bad of [{ ...valid, Name: '/hapi' }, { ...valid, Config: { Labels: {} } },
    { ...valid, Config: { Labels: { 'io.fireboat.s10.run': 'foreign' } } }, { ...valid, Id: 'mutable-name' }])
    assert.throws(() => runner.removableContainer(bad, owner, name), { code: 'OCI_CLEANUP_FOREIGN' });
  assert.throws(() => runner.removableContainer(valid, owner, 'foreign'), { code: 'OCI_CLEANUP_FOREIGN' });
});

test('OCI gates: live inspections reject weaker hardening, changed namespace, port or writable mount', () => {
  const image = `sha256:${'a'.repeat(64)}`, network = `container:${'b'.repeat(64)}`;
  const valid = { Config: { Image: image, User: '1000:1000' }, Mounts: [{ Type: 'bind', RW: false }],
    HostConfig: { NetworkMode: network, ReadonlyRootfs: true, Privileged: false, PublishAllPorts: false,
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], PortBindings: {}, LogConfig: { Type: 'none' } } };
  runner.assertContainer(valid, image, network);
  for (const delta of [{ NetworkMode: 'bridge' }, { ReadonlyRootfs: false }, { Privileged: true }, { PublishAllPorts: true },
    { CapDrop: [] }, { CapAdd: ['NET_ADMIN'] }, { SecurityOpt: [] }, { PortBindings: { '8080/tcp': [] } }, { LogConfig: { Type: 'json-file' } }])
    assert.throws(() => runner.assertContainer({ ...valid, HostConfig: { ...valid.HostConfig, ...delta } }, image, network), { code: 'OCI_CONTAINER_HARDENING' });
  for (const delta of [{ User: '0:0' }, { Image: 'mutable:tag' }, { ExposedPorts: { '8080/tcp': {} } }])
    assert.throws(() => runner.assertContainer({ ...valid, Config: { ...valid.Config, ...delta } }, image, network), { code: 'OCI_CONTAINER_HARDENING' });
  assert.throws(() => runner.assertContainer({ ...valid, Mounts: [{ Type: 'bind', RW: true }] }, image, network), { code: 'OCI_CONTAINER_HARDENING' });
});

test('OCI gates: unexecuted runtime/supply-chain gates stay unverified and include every required family', () => {
  assert.deepEqual(build.DEFERRED_GATES, ['helper-namespace', 'negative-egress', 'proxy', 'redirect', 'attached-stdio-doctor',
    'tasks-18-both-eras', 'startup-shutdown', 'cancellation', 'owned-cleanup']);
  assert.deepEqual(build.SUPPLY_CHAIN, ['full-image-sbom', 'base-vulnerability-scan', 'signature', 'provenance', 'registry-manifest']);
});

test('OCI gates: installed helper oracle runs both-era image sessions; no source rebuild, HAPI provisioning or broad cleanup', async () => {
  const source = await readFile(new URL('../packaging/oci/run-gates.mjs', import.meta.url), 'utf8');
  assert.match(source, /ownedInstance\(evidence, receipt\.instance, manifest\)/);
  assert.match(source, /await verify\(\{ runDirectory: preparedRun/);
  assert.match(source, /openSession: session, doctor, target: 'http:\/\/127\.0\.0\.1:8080\/fhir'/);
  assert.match(source, /tasks\.runs\.length !== 18 \|\| tasks\.passed !== 18 \|\| tasks\.failed !== 0/);
  assert.match(source, /status: 'unverified'/);
  assert.equal(/docker\(\[\s*['"](?:pull|push|build|compose|system|network|volume)['"]/.test(source), false);
  assert.equal(/\b(?:npm (?:ci|install)|npx|tsc|tsx)\b/.test(source), false);
  assert.equal(/\b(?:prune|killall|pkill)\b/.test(source), false);
});

test('OCI gates: cancellation must beat a far longer ordinary upstream timeout and follow an uncancelled control that stayed open', async () => {
  const { CANCELLATION: timing, cancellationConfig, judgeCancellation } = runner;
  assert.ok(timing.upstreamTimeoutMs >= 3 * (timing.controlHoldMs + timing.deadlineMs) && timing.requestTimeoutMs > timing.controlHoldMs + timing.deadlineMs);
  // The derived config raises only the ordinary timeout, to the schema maximum, and the gateway's own validator accepts it.
  const base = JSON.parse(await readFile(new URL('../examples/quickstart/config.json', import.meta.url), 'utf8'));
  const derived = cancellationConfig({ ...base, source: { ...base.source, baseUrl: 'http://127.0.0.1:19080/hang/fhir' } });
  assert.deepEqual(derived.limits, { ...base.limits, timeoutMs: 30_000 }); assert.equal(base.limits?.timeoutMs, undefined);
  new FhirGateway(derived as GatewayConfig).close();
  const control = { hanging: 1, hangClosed: 0, heldMs: timing.controlHoldMs + 5 };
  const passed = judgeCancellation({ control, abortedAt: 1_000, closed: { hangClosed: 1, observedAt: 1_300 } });
  assert.equal(passed.closeLatencyMs, 300); assert.equal(passed.upstreamTimeoutMs, 30_000);
  // Regression controls: the abort is not forwarded, so the socket closes only at an ordinary timeout, or never in the window.
  for (const closed of [{ hangClosed: 1, observedAt: 1_000 + 10_000 }, { hangClosed: 1, observedAt: 1_000 + timing.deadlineMs + 1 }, { hangClosed: 0, observedAt: 1_300 }, undefined])
    assert.throws(() => judgeCancellation({ control, abortedAt: 1_000, closed }), { code: 'OCI_CANCELLATION' });
  // The uncancelled control must have stayed open for the whole hold.
  for (const bad of [{ ...control, hangClosed: 1 }, { ...control, hanging: 0 }, { ...control, heldMs: timing.controlHoldMs - 1 }, undefined])
    assert.throws(() => judgeCancellation({ control: bad, abortedAt: 1_000, closed: { hangClosed: 1, observedAt: 1_300 } }), { code: 'OCI_CANCELLATION_CONTROL' });
  // An ordinary timeout inside or near the measured window (such as the default 10 s) cannot establish cancellation.
  for (const upstreamTimeoutMs of [10_000, 15_000])
    assert.throws(() => judgeCancellation({ control, abortedAt: 1_000, closed: { hangClosed: 1, observedAt: 1_300 }, timing: { ...timing, upstreamTimeoutMs } }),
      { code: 'OCI_CANCELLATION_TIMING' });
  const source = await readFile(new URL('../packaging/oci/run-gates.mjs', import.meta.url), 'utf8');
  assert.match(source, /configFor\('cancel', 'http:\/\/127\.0\.0\.1:19080\/hang\/fhir', cancellationConfig\)/);
  assert.match(source, /return judgeCancellation\(\{ control, closed, abortedAt: result\.abortedAt \}\)/);
  assert.match(source, /poll\(s => s\.hangClosed === 1, result\.abortedAt \+ CANCELLATION\.deadlineMs\)/);
});

function fakeChild(onEnd: (child: EventEmitter) => void) {
  const child = Object.assign(new EventEmitter(), { signals: [] as string[], stdout: { destroy() {} }, stderr: { destroy() {} } });
  return Object.assign(child, { kill: (signal: string) => { child.signals.push(signal); }, stdin: { end: () => onEnd(child) } });
}
test('OCI gates: shutdown acceptance needs exit code 0 without a signal after EOF; crash, signal and hang fail while cleanup still runs', async () => {
  for (const role of ['clean', 'instrumented']) {
    for (const [scenario, code, signal] of [['exit-0', 0, null], ['crash-on-eof', 1, null], ['signal', null, 'SIGKILL'], ['container-signal', 137, null], ['hang', undefined, undefined]] as const) {
      const finished: string[] = [], name = `fireboat-s10-${'a'.repeat(16)}-session-${role}`;
      const child = fakeChild(c => { if (scenario !== 'hang') setImmediate(() => c.emit('close', code, signal)); });
      const status = await session.shutdownChild({ child, exited: session.exitStatus(child), name, deadlineMs: 50,
        finish: async (owned: string) => { finished.push(owned); } });
      assert.deepEqual(finished, [name], `${role}/${scenario}: owned cleanup is independent of acceptance`);
      if (scenario === 'exit-0') assert.equal(session.judgeShutdowns([status], 1).sessions, 1);
      else assert.throws(() => session.judgeShutdowns([status], 1), { code: 'OCI_STDIO_SHUTDOWN' }, `${role}/${scenario}`);
    }
  }
  const ok = { code: 0, signal: null, timedOut: false };
  assert.throws(() => session.judgeShutdowns([], 0), { code: 'OCI_STDIO_SHUTDOWN' });
  assert.throws(() => session.judgeShutdowns([ok], 2), { code: 'OCI_STDIO_SHUTDOWN' }, 'an opened session that was never closed');
  assert.equal(session.judgeShutdowns([ok, ok], 2).sessions, 2);
  const source = await readFile(new URL('../packaging/oci/run-gates.mjs', import.meta.url), 'utf8');
  assert.match(source, /step\('startup-shutdown', async \(\) => judgeShutdowns\(\[\.\.\.shutdowns\.values\(\)\], opened\)\)/);
  assert.match(source, /const status = await connection\.close\(\); if \(!shutdowns\.has\(name\)\) shutdowns\.set\(name, status\)/);
});
