import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { assertInstallStages, assertNoLinks, assertOnboarding, allThreeTasksPassed, collectGuards, installComponent, installedEnvironment, installedInputs, installPlan, installState, INSTALL_STEPS,
  PACKAGE_ARMS, PACKAGE_ERAS, PACKAGE_GUARDS, PACKAGE_TASKS, type CommandExecutor, type GuardResult, type InstalledInputs } from '../scripts/package-quickstart.js';
import { createTiming } from '../examples/quickstart/timing.js';
import { snapshotTar, verifyInstalledGateway } from '../scripts/verify-package.js';
import { evaluateStepCheck } from '../packages/evals/src/evidence-oracle.js';
import { packageTasks, type SeedFacts } from '../packages/evals/src/package-tasks.js';

const report = () => ({ schema: 'fireboat-quickstart-verify/1', doctor: 'ready', instrumentation: 'request-observer', passed: 18, failed: 0,
  runs: PACKAGE_ERAS.flatMap(era => PACKAGE_TASKS.flatMap(task => PACKAGE_ARMS.map(arm => ({ era, task, arm, status: 'pass', failing: [] as string[], checks: { passed: 1, failed: 0, incomparable: 0 } })))),
  controls: PACKAGE_ERAS.map(era => ({ era, status: 'pass', cleanSha256: 'a'.repeat(64), observedSha256: 'a'.repeat(64) })) });
const guards = (): GuardResult[] => PACKAGE_GUARDS.map(id => ({ id, status: 'pass' }));
const inputs: InstalledInputs = { tar: '/scratch/gateway.tgz', packJson: '/scratch/gateway.tgz.pack.json', helperLock: '/release/helper.lock', runDirectory: '/prepared/run',
  scratch: '/scratch/fresh', timing: '/release/fireboat-timing.mjs', npm: '/toolchain/npm-cli.js', cache: '/cache' };

test('package quickstart: passing negative guards cannot certify a failed status-sensitive onboarding task', () => {
  assertOnboarding(report(), guards());
  const bad = report(); bad.runs.find(r => r.task === 'package-status-sensitive')!.status = 'fail';
  assert.equal(allThreeTasksPassed(bad), false);
  assert.throws(() => assertOnboarding(bad, guards()), { code: 'ONBOARDING_FAILED' });
  assert.throws(() => assertOnboarding(null, guards()), { code: 'ONBOARDING_FAILED' });
});

test('package quickstart: all three tasks require every unique era and arm, accurate counts and matching clean controls', () => {
  for (const change of [
    (r: ReturnType<typeof report>) => { r.runs.pop(); },
    (r: ReturnType<typeof report>) => { r.runs[1] = { ...r.runs[0]! }; },
    (r: ReturnType<typeof report>) => { r.runs[0]!.arm = 'invented' as any; },
    (r: ReturnType<typeof report>) => { r.runs[0]!.failing = ['labs-exact-membership']; },
    (r: ReturnType<typeof report>) => { r.runs[0]!.checks.failed = 1; },
    (r: ReturnType<typeof report>) => { r.runs[0]!.checks.passed = 0; },
    (r: ReturnType<typeof report>) => { r.passed = 17; },
    (r: ReturnType<typeof report>) => { r.failed = 1; },
    (r: ReturnType<typeof report>) => { r.controls.pop(); },
    (r: ReturnType<typeof report>) => { r.controls[1] = { ...r.controls[0]! }; },
    (r: ReturnType<typeof report>) => { r.controls[0]!.observedSha256 = 'b'.repeat(64); },
    (r: ReturnType<typeof report>) => { r.controls[0]!.status = 'fail'; },
  ]) { const changed = report(); change(changed); assert.equal(allThreeTasksPassed(changed), false); }
  for (const changed of [[], [...guards(), guards()[0]!], guards().slice(1), guards().map(g => g.id === 'seam' ? { ...g, status: 'fail' as const } : g)])
    assert.throws(() => assertOnboarding(report(), changed), { code: 'PACKAGE_GUARDS_FAILED' });
});

test('package quickstart: drain membership guard rejects dropped, duplicated and substituted page members', () => {
  // Use the actual task's check and shared oracle, with two scripted pages and otherwise plausible continuation evidence.
  const task = packageTasks({ labIds: ['lab-a', 'lab-b'], hba1c: [], document: {}, corrected: {}, enteredInError: {} } as unknown as SeedFacts, 'stub')[2]!;
  const check = task.checks.find(c => c.id === 'labs-exact-membership')!;
  const page = (ids: string[], more: boolean) => ({ step: 0, envelope: { schema_version: '0.3', data: { resources: ids.map(id => ({ resourceType: 'Observation', id })) },
    provenance: ids.map((_, resource_index) => ({ resource_index })), coverage: { state: more ? 'partial' : 'unknown', scope: 'page', query_evidence: 'unverified_continuation' },
    pagination: { returned_matches: ids.length, next_cursor: more ? 'cur_plausible' : undefined } } as any });
  const judge = (a: string[], b: string[]) => evaluateStepCheck(check, 'fhir', [page(a, true), page(b, false)], { stepCount: task.steps.length, requests: [], resourceType: 'Observation' });
  assert.equal(judge(['lab-a'], ['lab-b']).status, 'pass');
  for (const second of [[], ['lab-a'], ['lab-b', 'lab-b'], ['other']]) assert.equal(judge(['lab-a'], second).status, 'fail');
});

test('package quickstart: integration inputs fail when absent, relative or incomplete and never become a skip', () => {
  const env = { FIREBOAT_PACKAGE_TAR: inputs.tar, FIREBOAT_PACKAGE_HELPER_LOCK: inputs.helperLock, FIREBOAT_PACKAGE_RUN_DIR: inputs.runDirectory,
    FIREBOAT_PACKAGE_SCRATCH: inputs.scratch, FIREBOAT_PACKAGE_TIMING: inputs.timing, npm_execpath: inputs.npm, FIREBOAT_PACKAGE_CACHE: inputs.cache };
  assert.deepEqual(installedInputs(env), inputs);
  assert.throws(() => installedInputs({}), { code: 'PACKAGE_INPUT_REQUIRED' });
  for (const key of Object.keys(env)) for (const value of key === 'FIREBOAT_PACKAGE_CACHE' ? ['relative'] : [undefined, 'relative'])
    assert.throws(() => installedInputs({ ...env, [key]: value }), { code: 'PACKAGE_INPUT_REQUIRED' });
});

test('package quickstart: scripted orchestration attempts all stages, keeps guard failures separate and gates the final onboarding result', async () => {
  const state = installState(inputs, '/toolchain/node'), plan = installPlan(state, '/scratch/worker.mjs'), seen: string[] = [];
  assert.deepEqual(plan.map(c => c.stage), [...INSTALL_STEPS]);
  assert.ok(plan.every(c => c.file === state.node && c.args[0] === '/scratch/worker.mjs' && !c.args.includes('tsx')));
  const timer = createTiming(), results: { stage: string; status: string }[] = [];
  for (const command of plan) {
    const ok = await timer.run(command, async c => { seen.push(c.stage); if (c.stage === 'startup') throw new Error('scripted failure'); return { code: 0 }; });
    results.push({ stage: command.stage, status: ok ? 'pass' : 'fail' });
  }
  assert.deepEqual(seen, [...INSTALL_STEPS]);
  assert.deepEqual(results.filter(r => r.status === 'fail'), [{ stage: 'startup', status: 'fail' }]);
  assert.throws(() => assertInstallStages(timer.packet(), results), { code: 'PACKAGE_STAGES_FAILED' });
  const goodClock = createTiming();
  for (const command of plan) await goodClock.run(command, async () => ({ code: 0 }));
  const goodRows = plan.map(c => ({ stage: c.stage, status: 'pass' }));
  assertInstallStages(goodClock.packet(), goodRows);
  assert.throws(() => assertInstallStages(goodClock.packet(), goodRows.slice(1)), { code: 'PACKAGE_STAGES_FAILED' });
  assert.throws(() => assertInstallStages({ ...goodClock.packet(), events: goodClock.packet().events.slice(2) }, goodRows), { code: 'PACKAGE_STAGES_FAILED' });
  const visited: string[] = [];
  const observed = await collectGuards(async id => { visited.push(id); if (id === 'lifecycle') throw new Error('scripted failure'); });
  assert.deepEqual(visited, [...PACKAGE_GUARDS]);
  assert.equal(observed.filter(g => g.status === 'fail').length, 1);
  assert.throws(() => assertOnboarding(report(), observed), { code: 'PACKAGE_GUARDS_FAILED' });
  assertOnboarding(report(), await collectGuards(async () => {}));
  const env = installedEnvironment(state);
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'TMPDIR']);
  assert.ok(!('NODE_PATH' in env) && !('NODE_OPTIONS' in env));
  assert.ok(!state.cwd.startsWith(state.gateway) && !state.cwd.startsWith(state.helper));
});

test('package quickstart: real files are admitted and symlinked installed contents refuse without launching any child', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'package-quickstart-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'dist')); await writeFile(join(dir, 'dist/cli.js'), '');
  await assertNoLinks(dir);
  await symlink(join(dir, 'dist/cli.js'), join(dir, 'fallback'));
  await assert.rejects(assertNoLinks(dir), { code: 'PACKAGE_LINK' });
});

test('package quickstart: fresh independent install directories bind the helper lock and use only offline npm argv with a scripted executor', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'package-install-plan-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const state = installState({ ...inputs, scratch: dir, helperLock: join(dir, 'reviewed-lock.json') }, '/toolchain/node');
  await mkdir(join(state.extracted, 'quickstart'), { recursive: true });
  await writeFile(state.helperLock, '{}'); await writeFile(join(state.extracted, 'quickstart/package-lock.json'), '{}');
  await writeFile(join(state.extracted, 'quickstart/package.json'), '{"name":"scripted-helper"}');
  const calls: (readonly string[])[] = [];
  const execute: CommandExecutor = async (file, args, options) => {
    assert.equal(file, state.node); assert.equal(options.cwd, state.cwd);
    assert.equal(options.env.NODE_PATH, undefined); assert.equal(options.env.NODE_OPTIONS, undefined);
    calls.push(args);
    return { code: 0, stdout: args.includes('ls') ? '{"name":"scripted-tree"}' : '', stderr: '', bounded: true };
  };
  await installComponent(state, 'gateway', execute); await installComponent(state, 'helper', execute);
  assert.equal(calls.length, 4);
  for (const args of calls.filter(a => !a.includes('ls'))) for (const flag of ['--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--bin-links=false']) assert.ok(args.includes(flag), flag);
  assert.ok(calls[0]!.includes(state.tar) && calls[0]!.includes('install') && calls[2]!.includes('ci'));
  await assert.rejects(installComponent(state, 'gateway', execute)); await assert.rejects(installComponent(state, 'helper', execute));
  assert.equal(calls.length, 4, 'reuse refuses before executing another install');
  await writeFile(state.helperLock, '{"changed":true}');
  await assert.rejects(installComponent({ ...state, helper: join(dir, 'different-helper') }, 'helper', execute), { code: 'PACKAGE_HELPER_LOCK' });
  assert.equal(calls.length, 4);
});

test('package quickstart: a tar replaced after verification cannot be attributed; the installed gateway must equal the verified inventory and bytes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'package-installed-gateway-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const identity = { name: '@fireboat/gateway', version: '0.2.0-alpha.1', bin: { fireboat: 'dist/packages/server/src/cli.js' } };
  const files = [{ path: 'package.json', body: Buffer.from(JSON.stringify(identity)), mode: 0o644 },
    { path: 'dist/packages/server/src/cli.js', body: Buffer.from('#!/usr/bin/env node\n'), mode: 0o755 }];
  const expected = { schema: 1, identity, files: files.map(({ path, body, mode }) => ({ path, size: body.length, mode, sha256: createHash('sha256').update(body).digest('hex') })) };
  const sri = (bytes: Buffer) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  // The operator path holds the verified tar, then a same-identity replacement is written there before installation.
  const operator = join(dir, 'candidate.tgz'), verified = Buffer.from('synthetic verified tar bytes'), replacement = Buffer.from('synthetic replacement tar bytes');
  await writeFile(operator, verified);
  const snapshot = join(dir, 'verified.tgz'), tar = await snapshotTar(operator, snapshot);
  await writeFile(operator, replacement);
  assert.ok(tar.equals(verified) && (await readFile(snapshot)).equals(verified)); assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
  await assert.rejects(snapshotTar(operator, snapshot)); // exclusive: never overwrites an existing snapshot
  const install = join(dir, 'gateway'), pkg = join(install, 'node_modules/@fireboat/gateway');
  for (const f of files) { await mkdir(dirname(join(pkg, f.path)), { recursive: true }); await writeFile(join(pkg, f.path), f.body); await chmod(join(pkg, f.path), f.mode); }
  const lock = (row: Record<string, unknown>) => writeFile(join(install, 'node_modules/.package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@fireboat/gateway': { version: identity.version, resolved: 'file:../verified.tgz', ...row } } }));
  await lock({ integrity: sri(verified) });
  await verifyInstalledGateway(install, expected, tar);
  // Negative control: npm installed the replacement (its SRI is recorded), so the verified tar's evidence cannot name it.
  await lock({ integrity: sri(replacement) });
  await assert.rejects(verifyInstalledGateway(install, expected, tar), { code: 'INSTALLED_TAR_MISMATCH' });
  for (const row of [{ integrity: sri(verified), link: true }, { integrity: sri(verified), dev: true }, { integrity: sri(verified), version: '0.0.0' }]) {
    await lock(row); await assert.rejects(verifyInstalledGateway(install, expected, tar), { code: 'INSTALLED_TAR_MISMATCH' });
  }
  await lock({ integrity: sri(verified) });
  // One changed installed byte or mode, or an extra file, refuses even with the right hidden-lock SRI.
  const cli = join(pkg, files[1]!.path);
  await writeFile(cli, '#!/usr/bin/env node\n//');
  await assert.rejects(verifyInstalledGateway(install, expected, tar), { code: 'STAGE_CHANGED' });
  await writeFile(cli, files[1]!.body); await chmod(cli, 0o644);
  await assert.rejects(verifyInstalledGateway(install, expected, tar), { code: 'STAGE_CHANGED' });
  await chmod(cli, 0o755); await writeFile(join(pkg, 'dist/extra.js'), 'x');
  await assert.rejects(verifyInstalledGateway(install, expected, tar), (e: { code?: string }) => ['STAGE_INVENTORY', 'STAGE_FORBIDDEN'].includes(e.code ?? ''));
  await rm(join(pkg, 'dist/extra.js'));
  await verifyInstalledGateway(install, expected, tar);
});

test('package quickstart: the installed gate installs its private snapshot and checks the installed gateway before success', async () => {
  const source = await readFile(new URL('./package/installed-quickstart.test.ts', import.meta.url), 'utf8');
  assert.match(source, /tar = await snapshotTar\(inputs\.tar, snapshot\)/);
  assert.match(source, /installState\(\{ \.\.\.inputs, tar: snapshot, scratch \}/);
  assert.match(source, /verifyPackage\(\{ tar: snapshot,/);
  assert.equal((source.match(/inputs\.tar/g) ?? []).length, 1, 'the operator tar path is read exactly once');
  const check = source.indexOf('await verifyInstalledGateway(state.gateway, expected, tar)'), success = source.indexOf('PACKAGE_INSTALLED_OK');
  assert.ok(check > source.indexOf('assertOnboarding(tasks, guards)') && check < success, 'installed files are compared after every stage and before success');
});
