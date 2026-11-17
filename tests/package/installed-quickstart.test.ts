import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertInstallStages, assertOnboarding, executeCommand, installedEnvironment, installedInputs, installPlan, installState, INSTALL_STEPS } from '../../scripts/package-quickstart.js';
import { snapshotTar, verifyInstalledGateway, verifyInstalledTree, verifyPackage } from '../../scripts/verify-package.js';

// This file is deliberately outside tests/*.test.ts. It never skips when prerequisites are absent.
test('installed quickstart: fresh locked installs, independent guards and all 18 task-arm runs', { timeout: 600_000 }, async () => {
  const inputs = installedInputs(process.env), root = fileURLToPath(new URL('../../', import.meta.url));
  const outside = relative(await realpath(root), inputs.scratch);
  assert.ok(outside.split(sep)[0] === '..' || isAbsolute(outside), 'scratch must be outside the checkout');
  await mkdir(inputs.scratch, { mode: 0o700 }); // Exclusive: never reuse or erase an installation.
  const scratch = await realpath(inputs.scratch);
  // Read the operator's tar and inventory once into private copies. Verification, the gateway install and the final
  // installed-file comparison all use exactly these bytes; a later change at the operator path cannot be attributed.
  const snapshot = join(scratch, 'verified.tgz'), tar = await snapshotTar(inputs.tar, snapshot);
  const expected = JSON.parse(await readFile(process.env.FIREBOAT_PACKAGE_EXPECTED ?? join(root, 'packaging/npm-files.json'), 'utf8'));
  const expectedPath = join(scratch, 'expected-inventory.json');
  await writeFile(expectedPath, JSON.stringify(expected), { flag: 'wx', mode: 0o600 });
  const state = installState({ ...inputs, tar: snapshot, scratch }, await realpath(process.execPath));
  await mkdir(state.cwd, { mode: 0o700 });
  const artifact = await verifyPackage({ tar: snapshot, packJson: inputs.packJson, expected: expectedPath, extract: state.extracted });
  assert.equal(artifact.tarSha256, createHash('sha256').update(tar).digest('hex'), 'verified bytes are the private snapshot');
  await writeFile(join(state.scratch, 'state.json'), JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  // Emit just this built-in-only harness. No checkout source, tsx, symlink or loader participates in installed launches.
  const worker = join(state.scratch, 'package-worker.mjs');
  await writeFile(worker, stripTypeScriptTypes(await readFile(new URL('../../scripts/package-quickstart.ts', import.meta.url), 'utf8')), { flag: 'wx', mode: 0o600 });
  const plan = join(state.scratch, 'timing-plan.json'), timing = join(state.scratch, 'timing.json');
  await writeFile(plan, JSON.stringify(installPlan(state, worker)), { flag: 'wx', mode: 0o600 });
  const result = await executeCommand(state.node, [state.timing, '--plan', plan, '--out', timing], { cwd: state.cwd, env: installedEnvironment(state), timeout: 540_000 });
  const stages = await Promise.all(INSTALL_STEPS.map(async stage => JSON.parse(await readFile(join(state.scratch, `${stage}.json`), 'utf8'))));
  const clock = JSON.parse(await readFile(timing, 'utf8'));
  assertInstallStages(clock, stages);
  assert.equal(result.bounded, true); assert.equal(result.code, 0); assert.equal(result.stderr, '');
  const tasks = JSON.parse(await readFile(join(state.scratch, 'task-report.json'), 'utf8'));
  const guards = JSON.parse(await readFile(join(state.scratch, 'guards.json'), 'utf8'));
  assertOnboarding(tasks, guards);
  const trees = await Promise.all((['gateway', 'quickstart'] as const).map(async component => verifyInstalledTree(component === 'gateway' ? state.gateway : state.helper,
    JSON.parse(await readFile(join(state.scratch, component === 'gateway' ? 'gateway-tree.json' : 'helper-tree.json'), 'utf8')), component)));
  // After every stage (the asset guard mutates and restores installed files): the installed gateway is exactly the
  // verified inventory, npm installed it from exactly the snapshot bytes, and the snapshot itself is unchanged.
  await verifyInstalledGateway(state.gateway, expected, tar);
  assert.ok((await readFile(snapshot)).equals(tar), 'private tar snapshot unchanged');
  const packet = { schema: 'fireboat-package-quickstart/1', artifact, tasks, guards, trees, timing: clock,
    installedGateway: { inventorySha256: artifact.inventorySha256, tarSha256: artifact.tarSha256, checked: 'files-modes-hashes-and-hidden-lock-sri' },
    cell: { platform: process.platform, arch: process.arch, node: process.versions.node, status: 'verified' },
    unverified: ['other-runtime-platform-cells', 'cold-acquisition', 'prior-hapi-startup-seeding', 'hapi-cleanup', 'unaided-human-timing'],
    timingScope: 'cached-install-and-scripted-verification; startup/cleanup stages cover harness gateway children, not the supplied HAPI' };
  await writeFile(join(state.scratch, 'installed-report.json'), `${JSON.stringify(packet)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`PACKAGE_INSTALLED_OK runs=18 guards=${guards.length} tar=${artifact.tarSha256}`);
});
