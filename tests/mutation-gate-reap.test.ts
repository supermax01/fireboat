import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

type Run = { ok: boolean; timedOut: boolean; durationMs: number; out: string };
const gate = await import(new URL('../scripts/mutation-guards.mjs', import.meta.url).href) as {
  runEval: (dir: string, suite: string, timeoutMs: number) => Promise<Run>;
  runSuite: (dir: string, timeoutMs: number, pattern?: string, suite?: string, baseline?: boolean) => Promise<Run & { failed: string[]; testsRun: number }>;
  failingTests: (tap: string) => string[];
};

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mutation-reap-'));
  await mkdir(join(dir, 'tests'));
  await mkdir(join(dir, 'packages/evals/src'), { recursive: true });
  await mkdir(join(dir, 'unrelated'));
  await writeFile(join(dir, 'unrelated/keep.txt'), 'outside the suite temp directory');
  await symlink(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

// Leave files behind deliberately: only the judge can clean up an interrupted suite.
const tempProbe = `
  import assert from 'node:assert/strict';
  import { mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { dirname, join } from 'node:path';
  const temp = tmpdir();
  assert.equal(realpathSync(dirname(temp)), process.cwd(), 'temp must be inside the judge copy');
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) assert.equal(process.env[name], temp);
  writeFileSync('suite.tmp', temp);
  const payload = mkdtempSync(join(temp, 'synthetic-suite-'));
  writeFileSync(join(payload, 'payload.txt'), 'working temp directory');
  assert.equal(readFileSync(join(payload, 'payload.txt'), 'utf8'), 'working temp directory');
  symlinkSync(join(process.cwd(), 'unrelated'), join(payload, 'outside'), 'dir');
`;

async function removedTemp(dir: string): Promise<string> {
  const temp = await readFile(join(dir, 'suite.tmp'), 'utf8');
  assert.equal(dirname(temp), dir, 'the temp directory belongs to this copy');
  await assert.rejects(readdir(temp), { code: 'ENOENT' }, 'suite temp files must be gone before the run returns');
  assert.equal(await readFile(join(dir, 'unrelated/keep.txt'), 'utf8'), 'outside the suite temp directory');
  return temp;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function dead(pid: number): Promise<boolean> {
  const end = Date.now() + 1_000;
  while (alive(pid) && Date.now() < end) await delay(20);
  return !alive(pid);
}

async function readPid(dir: string, name: string): Promise<number | undefined> {
  try {
    const pid = Number(await readFile(join(dir, name), 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    return pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function cleanup(dir: string): Promise<void> {
  // These PIDs come only from this test's freshly created synthetic suite.
  for (const name of ['descendant.pid', 'suite.pid']) {
    const pid = await readPid(dir, name);
    if (pid !== undefined && alive(pid)) {
      process.kill(pid, 'SIGKILL');
      assert.ok(await dead(pid), `fixture process ${pid} was not reaped`);
    }
  }
  await rm(dir, { recursive: true, force: true });
}

for (const { pipes, detached } of [
  { pipes: 'inherit', detached: false },
  { pipes: 'ignore', detached: false },
  { pipes: 'inherit', detached: true },
] as const) {
  const name = detached ? 'bounds draining a pipe held outside the suite group without signalling that group'
    : `timeout reaps a SIGTERM-resistant descendant with ${pipes} pipes`;
  test(`mutation judge: ${name}`, { skip: process.platform === 'win32', timeout: 15_000 }, async t => {
    const dir = await fixture();
    try {
      const descendant = `
        const { existsSync, readFileSync, writeFileSync } = require('node:fs');
        const { tmpdir } = require('node:os');
        const { join } = require('node:path');
        writeFileSync('descendant.tmp', tmpdir());
        const payload = join(tmpdir(), 'descendant.txt');
        writeFileSync(payload, 'descendant temp file');
        process.on('SIGTERM', () => {
          // Cleanup must wait until descendants have been reaped: up to SIGKILL,
          // the latest observation must still find the temp file.
          writeFileSync(payload, readFileSync(payload, 'utf8') + ' still available at SIGTERM');
          writeFileSync('descendant.term', String(Date.now()));
          setInterval(() => writeFileSync('descendant.late', String(existsSync(payload))), 50);
        });
        setInterval(() => {}, 1000);
        setTimeout(() => process.exit(0), 12000);
        process.send('ready');
      `;
      await writeFile(join(dir, 'packages/evals/src/cli.ts'), `
        ${tempProbe}
        import { spawn } from 'node:child_process';
        writeFileSync('suite.pid', String(process.pid));
        process.on('SIGTERM', () => {
          writeFileSync('suite.term', String(Date.now()));
          process.exit(143);
        });
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
          detached: ${detached},
          stdio: ['ignore', '${pipes}', '${pipes}', 'ipc'],
        });
        writeFileSync('descendant.pid', String(child.pid));
        child.once('message', () => {
          child.disconnect();
          process.stdout.write('TAP version 13\\nnot ok 1 - available before timeout\\n');
          process.stderr.write('available stderr before timeout\\n');
        });
        setTimeout(() => process.exit(2), 12000);
      `);
      const capMs = 2_000;
      const started = Date.now();
      const result = await gate.runEval(dir, 'evals:modern', capMs);
      const elapsedMs = Date.now() - started;
      assert.equal(result.ok, false, result.out);
      assert.equal(result.timedOut, true, result.out);
      assert.ok(elapsedMs < capMs + 3_000, `timeout cleanup took ${elapsedMs}ms`);
      assert.ok(result.durationMs >= capMs);
      assert.match(result.out, /available stderr before timeout/);
      assert.deepEqual(gate.failingTests(result.out), ['available before timeout']);
      const suite = await readPid(dir, 'suite.pid');
      const child = await readPid(dir, 'descendant.pid');
      assert.ok(suite !== undefined && child !== undefined, result.out);
      assert.ok(await dead(suite), 'the suite parent must exit');
      if (detached) {
        assert.equal(alive(child), true, 'a process outside the launched group must stay alive');
        await assert.rejects(readFile(join(dir, 'descendant.term')), { code: 'ENOENT' });
        assert.ok(elapsedMs >= capMs + 1_200, 'the held pipe must exercise the bounded final drain');
      } else {
        assert.ok(await dead(child), 'SIGKILL must reap the descendant even after the suite parent closes');
        const termAt = Number(await readFile(join(dir, 'descendant.term'), 'utf8'));
        assert.ok(termAt >= started && termAt <= started + elapsedMs, 'SIGTERM must reach the descendant before SIGKILL');
        assert.equal(await readFile(join(dir, 'descendant.late'), 'utf8'), 'true', 'temp removal must not start before the descendant is killed');
      }
      const suiteTermAt = Number(await readFile(join(dir, 'suite.term'), 'utf8'));
      assert.ok(suiteTermAt >= started && suiteTermAt <= started + elapsedMs);
      const temp = await removedTemp(dir);
      assert.equal(await readFile(join(dir, 'descendant.tmp'), 'utf8'), temp, 'descendants inherit the confined temp directory');
      t.diagnostic(JSON.stringify({ pipes, detached, elapsedMs, durationMs: result.durationMs, descendantDead: !alive(child), tapPreserved: true }));
    } finally { await cleanup(dir); }
  });
}

for (const fails of [false, true]) {
  test(`mutation judge: ordinary ${fails ? 'assertion failure' : 'passing exit'} retains its result without a timeout`, async () => {
    const dir = await fixture();
    try {
      await writeFile(join(dir, 'tests/control.test.ts'), `
        ${tempProbe}
        import test from 'node:test';
        test('ordinary control', () => assert.equal(${fails}, false));
      `);
      const temps = new Set<string>();
      for (const { baseline, pattern } of [
        { baseline: true, pattern: undefined },
        { baseline: false, pattern: undefined },
        { baseline: false, pattern: '^ordinary control$' },
      ]) {
        const result = await gate.runSuite(dir, 10_000, pattern, 'unit', baseline);
        assert.equal(result.ok, !fails, result.out);
        assert.equal(result.timedOut, false, result.out);
        assert.equal(result.testsRun, 1, result.out);
        assert.deepEqual(result.failed, fails ? ['ordinary control'] : []);
        const temp = await removedTemp(dir);
        assert.equal(temps.has(temp), false, 'baseline, mutant and focused rerun need fresh temp directories');
        temps.add(temp);
      }
    } finally { await cleanup(dir); }
  });
}

test('mutation judge: a timed-out unit suite leaves no temp files when its after hook cannot run', { timeout: 10_000 }, async () => {
  const dir = await fixture();
  try {
    await writeFile(join(dir, 'tests/timeout.test.ts'), `
      ${tempProbe}
      import test, { after } from 'node:test';
      after(() => writeFileSync('after.ran', 'suite cleanup ran'));
      test('interrupted temp fixture', async () => {
        await new Promise(() => setInterval(() => {}, 1000));
      });
    `);
    const result = await gate.runSuite(dir, 2_000);
    assert.equal(result.ok, false, result.out);
    assert.equal(result.timedOut, true, result.out);
    await removedTemp(dir);
    await assert.rejects(readFile(join(dir, 'after.ran')), { code: 'ENOENT' });
  } finally { await cleanup(dir); }
});

test('mutation judge: temp cleanup restores owner access to directories a suite left read-only', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const dir = await fixture();
  try {
    await writeFile(join(dir, 'tests/locked.test.ts'), `
      ${tempProbe}
      import { chmodSync, mkdirSync } from 'node:fs';
      import test from 'node:test';
      test('leaves a read-only temp directory', () => {
        const locked = join(temp, 'locked');
        mkdirSync(join(locked, 'inner'), { recursive: true });
        writeFileSync(join(locked, 'inner', 'file.txt'), 'read-only parent');
        chmodSync(join(locked, 'inner'), 0o500);
        chmodSync(locked, 0o500);
      });
    `);
    const outsideMode = (await stat(join(dir, 'unrelated'))).mode & 0o777;
    const result = await gate.runSuite(dir, 10_000);
    assert.equal(result.ok, true, result.out);
    assert.equal(result.testsRun, 1, result.out);
    await removedTemp(dir);
    assert.equal((await stat(join(dir, 'unrelated'))).mode & 0o777, outsideMode, 'restoring access must not follow the symlink out of the temp directory');
  } finally { await cleanup(dir); }
});

test('mutation judge: a temp directory that cannot be removed never replaces the suite result', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const dir = await fixture();
  try {
    await writeFile(join(dir, 'tests/pinned.test.ts'), `
      ${tempProbe}
      import { chmodSync } from 'node:fs';
      import test from 'node:test';
      test('pins its temp directory in place', () => chmodSync(process.cwd(), 0o500));
    `);
    const result = await gate.runSuite(dir, 10_000);
    assert.equal(result.ok, true, result.out);
    assert.equal(result.testsRun, 1, result.out);
    await chmod(dir, 0o700);
    const temp = await readFile(join(dir, 'suite.tmp'), 'utf8');
    assert.ok(Array.isArray(await readdir(temp)), 'the unremovable temp directory is left for the copy cleanup');
  } finally {
    await chmod(dir, 0o700).catch(() => undefined);
    await cleanup(dir);
  }
});
