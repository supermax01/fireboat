// S5.8b item 4: the official judge must select and bind the suite that kills a guard.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import test from 'node:test';

type Edit = { file: string; find: string; replace: string };
type Mutant = Edit & { id: string; edits?: Edit[]; suites?: string[]; prepare?: string };
const gate = await import(new URL('../scripts/mutation-guards.mjs', import.meta.url).href) as {
  MUTANTS: Mutant[];
  mutationEdits: (mutant: Mutant) => Edit[];
  mutationSuites: (mutant: Mutant) => string[];
  mutationPreparation: (mutant: Mutant) => { file: string; argv: string[] } | null;
  applyMutationEdits: (mutant: Mutant, sources: Map<string, string>) => { changed: Map<string, string>; failures: { count: number }[] };
  suiteTimeoutCap: (suite: string, baselineMs: number) => number;
  measureSuiteBaselines: (suites: string[], run: (suite: string, timeout: number) => Promise<{ ok: boolean; timedOut: boolean; durationMs: number; out?: string }>, log?: (line: string) => void) => Promise<Record<string, { baselineMs: number; capMs: number }>>;
  reproducedKill: (first: { outcome?: string; signature: string[]; timedOut: boolean; suite: string }, second: { outcome: string; signature: string[]; timedOut: boolean; suite: string }) => { killed: boolean; reproduced: string[]; reproducedTimeout: boolean; kill_kind: string | null };
  testSuiteArgs: (files: string[], concurrency: number, pattern?: string) => string[];
  anchorHash: (mutant: Mutant) => string;
  ANCHOR_TEST_FILE: string;
  testFiles: (dir: string, suite: string, baseline?: boolean) => Promise<string[]>;
  runSuite: (dir: string, timeout: number, pattern?: string, suite?: string, baseline?: boolean) => Promise<{ ok: boolean; failed: string[]; out: string; testsRun: number; suite: string }>;
  attempt: (dir: string, mutant: Mutant, runs: unknown[], caps?: Record<string, number>) => Promise<{ outcome: string; signature: string[]; timedOut: boolean; suite: string }>;
  focusedAttempt: (dir: string, first: { signature: string[]; suite: string }, runs: unknown[], caps: Record<string, number>, run: (dir: string, cap: number, pattern: string, suite: string) => Promise<{ ok: boolean; testsRun: number; failed: string[]; timedOut: boolean; durationMs: number }>) => Promise<{ outcome: string; signature: string[]; timedOut: boolean; suite: string }>;
  judge: (dir: string, mutant: Mutant, pristine: Map<string, string>) => Promise<{ status: string; kill_kind?: string; detail: string; failingTests: string[]; compilation: { typecheck?: boolean; build?: boolean }; suiteRuns: { suite: string; focused: boolean; testsRun: number; failed: string[] }[] }>;
  failingTests: (tap: string) => string[];
};
const probe: Mutant = { id: 'suite-probe', file: 'packages/core/src/index.ts', find: 'guard', replace: 'omitted' };

test('mutation judge: unit is mandatory and isolation declarations are explicit and hash-bound', () => {
  assert.deepEqual(gate.mutationSuites(probe), ['unit']);
  const isolated = { ...probe, suites: ['unit', 'isolation'] };
  assert.deepEqual(gate.mutationSuites(isolated), ['unit', 'isolation']);
  assert.notEqual(gate.anchorHash(probe), gate.anchorHash(isolated));
  for (const suites of [[], ['isolation'], ['unit', 'unit'], ['unit', 'arbitrary-command']]) {
    assert.throws(() => gate.mutationSuites({ ...probe, suites }), /invalid suites/);
  }
  for (const id of ['CUR-discovery-to-clinical-accepted', 'CUR-clinical-to-discovery-accepted', 'PTH-03-egress']) {
    const mutant = gate.MUTANTS.find(entry => entry.id === id);
    assert.ok(mutant, id);
    assert.deepEqual(gate.mutationSuites(mutant), ['unit', 'isolation'], id);
  }
});

test('mutation judge: isolation selection includes the actual B2 case runner', async () => {
  const [unit, isolation] = await Promise.all([gate.testFiles(resolve('.'), 'unit'), gate.testFiles(resolve('.'), 'isolation')]);
  assert.ok(unit.includes('tests/mutation-gate-sharding.test.ts'));
  assert.ok(!unit.some(file => file.startsWith('tests/isolation/')));
  assert.ok(isolation.includes('tests/isolation/isolation.test.ts'));
  assert.ok(isolation.includes('tests/isolation/oracles.test.ts'));
  assert.ok(isolation.every(file => file.startsWith('tests/isolation/')));
});

test('mutation judge: every compound edit and preparation is bound, with no arbitrary preparation', () => {
  const edits = [probe, { file: probe.file, find: 'independent overlay', replace: '' }];
  const compound = { ...probe, edits };
  assert.deepEqual(gate.mutationEdits(compound), edits.map(({ file, find, replace }) => ({ file, find, replace })));
  assert.notEqual(gate.anchorHash(compound), gate.anchorHash({ ...compound, edits: [probe] }));
  assert.notEqual(gate.anchorHash(probe), gate.anchorHash({ ...probe, prepare: 'contract' }));
  assert.throws(() => gate.anchorHash({ ...probe, prepare: 'arbitrary-command' }), /invalid preparation/);
  for (const file of ['../outside.ts', '/outside.ts', ...['node_modules', '.git', 'dist', '.local', 'mutation-results', 'artifacts'].flatMap(dir => [dir, dir.toUpperCase(), dir.replace(/[a-z]/, char => char.toUpperCase())]).flatMap(dir => [dir, `${dir}/outside.ts`, `./${dir}/outside.ts`, `${dir}\\outside.ts`])]) {
    assert.throws(() => gate.mutationEdits({ ...probe, file }), /invalid edits/);
    assert.throws(() => gate.mutationEdits({ ...probe, edits: [probe, { ...probe, file }] }), /invalid edits/);
  }
});

test('mutation judge: existing TODO and SKIP failures never masquerade as reproduced kills', () => {
  assert.deepEqual(gate.failingTests('not ok 1 - pending # TODO\nnot ok 2 - ignored # SKIP\nnot ok 3 - actual discriminator\n'), ['actual discriminator']);
});

test('mutation judge: excludes exactly the maintenance anchor test from mutants and includes it in baseline', async () => {
  const baseline = await gate.testFiles(resolve('.'), 'unit', true);
  const mutated = await gate.testFiles(resolve('.'), 'unit');
  assert.ok(baseline.includes(gate.ANCHOR_TEST_FILE));
  assert.deepEqual(baseline.filter(file => !mutated.includes(file)), [gate.ANCHOR_TEST_FILE]);
  assert.deepEqual(mutated, baseline.filter(file => file !== gate.ANCHOR_TEST_FILE));
  assert.deepEqual(await gate.testFiles(resolve('.'), 'isolation', true), await gate.testFiles(resolve('.'), 'isolation'));
});

test('mutation judge: a mutant failing only the anchor maintenance test survives the judging pass', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mutation-anchor-exclusion-'));
  try {
    await mkdir(join(dir, 'tests'));
    await mkdir(join(dir, 'packages/evals/src'), { recursive: true });
    await symlink(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
    await writeFile(join(dir, gate.ANCHOR_TEST_FILE), "import test from 'node:test'; import assert from 'node:assert/strict'; test('anchor-only failure', () => assert.fail('mutated anchor is gone'));\n");
    await writeFile(join(dir, 'tests/ordinary.test.ts'), "import test from 'node:test'; test('ordinary assertion passes', () => {});\n");
    await writeFile(join(dir, 'packages/evals/src/cli.ts'), '// Synthetic eval pass in either era.\n');
    const baseline = await gate.runSuite(dir, 10_000, undefined, 'unit', true);
    assert.equal(baseline.ok, false, baseline.out);
    assert.deepEqual(baseline.failed, ['anchor-only failure']);
    const runs: unknown[] = [];
    const result = await gate.attempt(dir, probe, runs);
    assert.equal(result.outcome, 'passed', JSON.stringify(result));
    assert.equal(runs.length, 3); // Unit plus both measured eval eras.
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mutation judge: suite caps use each baseline, the 30s floor and 900s ceiling', async () => {
  for (const [baseline, cap] of [[0, 30_000], [5_000, 30_000], [5_001, 30_006], [20_000, 120_000], [200_000, 900_000], [450_000, 900_000]]) {
    assert.equal(gate.suiteTimeoutCap('unit', baseline!), cap);
  }
  const times: Record<string, number> = { unit: 10_000, isolation: 20_000, 'evals:modern': 600, 'evals:legacy': 9_000 };
  const measured = await gate.measureSuiteBaselines(Object.keys(times), async (suite, timeout) => {
    assert.equal(timeout, 240_000);
    return { ok: true, timedOut: false, durationMs: times[suite]! };
  }, () => {});
  assert.deepEqual(measured, {
    unit: { baselineMs: 10_000, capMs: 60_000 }, isolation: { baselineMs: 20_000, capMs: 120_000 },
    'evals:modern': { baselineMs: 600, capMs: 30_000 }, 'evals:legacy': { baselineMs: 9_000, capMs: 54_000 },
  });
});

test('mutation judge: unsafe caps and timed-out baselines fail closed before judging', async () => {
  assert.throws(() => gate.suiteTimeoutCap('isolation', 450_001), /isolation baseline 450001ms.*cap 900000ms.*lower --workers or --test-concurrency/);
  for (const value of [-1, NaN, Infinity]) assert.throws(() => gate.suiteTimeoutCap('unit', value), /invalid unit baseline/);
  for (const suite of ['unit', 'isolation', 'evals:modern', 'evals:legacy']) {
    for (const bad of [{ ok: false, timedOut: true, durationMs: 240_000 }, { ok: true, timedOut: false, durationMs: 240_001 }]) {
      let calls = 0, judged = false;
      await assert.rejects(async () => {
        await gate.measureSuiteBaselines([suite], async () => { calls++; return bad; }, () => {});
        judged = true;
      }, new RegExp(`${suite} baseline .* baseline cap 240000ms; lower --workers or --test-concurrency`));
      assert.equal(judged, false);
      assert.equal(calls, 1, 'a timed-out baseline cannot become usable through a retry');
    }
  }
});

test('mutation judge: named and timeout reproduction retain the existing kill rule', () => {
  const pass = { outcome: 'passed', signature: [], timedOut: false, suite: 'unit' };
  const failed = (signature: string[], timedOut = false, suite = 'unit') => ({ outcome: 'failed', signature, timedOut, suite });
  assert.deepEqual(gate.reproducedKill(failed(['same']), failed(['same'])), { killed: true, reproduced: ['same'], reproducedTimeout: false, kill_kind: 'named' });
  assert.equal(gate.reproducedKill(failed(['evals:modern']), failed(['evals:modern'])).kill_kind, 'named');
  assert.equal(gate.reproducedKill(failed(['same'], true), failed(['same'], true)).kill_kind, 'named');
  assert.deepEqual(gate.reproducedKill(failed([], true), failed([], true)), { killed: true, reproduced: [], reproducedTimeout: true, kill_kind: 'timeout' });
  for (const [first, second] of [['unit', 'isolation'], ['unit', 'evals:modern'], ['evals:modern', 'evals:legacy']]) {
    assert.equal(gate.reproducedKill(failed([], true, first), failed([], true, second)).killed, false, `${first} vs ${second}`);
  }
  for (const suite of ['unit', 'isolation', 'evals:modern', 'evals:legacy']) {
    assert.equal(gate.reproducedKill(failed([], true, suite), failed([], true, suite)).kill_kind, 'timeout');
    assert.equal(gate.reproducedKill(failed(['same'], true, suite), failed(['same'], true, suite)).kill_kind, 'named');
  }
  assert.equal(gate.reproducedKill(failed([], true, 'unknown'), failed([], true, 'unknown')).killed, false);
  for (const [first, second] of [[failed(['a']), failed(['b'])], [failed([], true), failed([])], [failed(['same']), pass], [failed(['file.test.ts']), failed(['file.test.ts'])]]) {
    assert.equal(gate.reproducedKill(first!, second!).killed, false);
  }
});

test('mutation anchors: compound edits observe previous edits and report all sequential failures', () => {
  const file = probe.file;
  const chain = { ...probe, edits: [{ file, find: 'first', replace: 'second' }, { file, find: 'second', replace: 'third' }] };
  const pristine = new Map([[file, 'first']]);
  assert.deepEqual(gate.applyMutationEdits(chain, pristine), { changed: new Map([[file, 'third']]), failures: [] });
  assert.equal(pristine.get(file), 'first');
  assert.equal(gate.applyMutationEdits(chain, new Map([[file, 'first|second']])).failures[0]!.count, 2);
  const erased = { ...probe, edits: [{ file, find: 'first second', replace: 'first' }, { file, find: 'second', replace: '' }, { file, find: 'missing', replace: '' }] };
  assert.deepEqual(gate.applyMutationEdits(erased, new Map([[file, 'first second']])).failures.map(x => x.count), [0, 0]);
  assert.equal(gate.applyMutationEdits({ ...probe, replace: probe.find }, new Map([[file, probe.find]])).failures.length, 1);
});

test('mutation anchors: copied-contract preparation is fixed and placeholders are rejected', () => {
  assert.equal(gate.mutationPreparation(probe), null);
  assert.deepEqual(gate.mutationPreparation({ ...probe, prepare: 'contract' }), {
    file: 'docs/contracts/m3b-tools.json', argv: ['--import', 'tsx', 'scripts/emit-m3b-contract.mjs'],
  });
  assert.throws(() => gate.mutationPreparation({ ...probe, prepare: 'arbitrary-command' }), /invalid preparation/);
  for (const replace of ['<empty>', ' <EMPTY>\n']) {
    assert.throws(() => gate.mutationEdits({ ...probe, replace }), /replacement placeholder/);
    assert.throws(() => gate.mutationEdits({ ...probe, edits: [probe, { ...probe, replace }] }), /replacement placeholder/);
  }
  assert.equal(gate.mutationEdits({ ...probe, replace: '' })[0]!.replace, '');
});

test('mutation judge: the admission discriminator is first for every local and CI concurrency', async () => {
  for (const baseline of [true, false]) {
    const files = await gate.testFiles(resolve('.'), 'unit', baseline);
    assert.deepEqual(files, [...files].sort());
    assert.equal(files[0], 'tests/00-mutation-admission.test.ts');
    for (const concurrency of [1, 2, 3, 4, 6, 12, Math.max(1, Math.floor(availableParallelism() / 2))]) {
      for (const pattern of [undefined, 'named discriminator']) {
        const argv = gate.testSuiteArgs(files, concurrency, pattern);
        assert.ok(argv.includes(`--test-concurrency=${concurrency}`));
        assert.deepEqual(argv.slice(argv.indexOf(files[0]!)), files);
      }
    }
  }
});

test('mutation judge: an eval deadline is timeout evidence, never a fabricated named-era failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mutation-eval-timeout-'));
  try {
    await mkdir(join(dir, 'tests'));
    await mkdir(join(dir, 'packages/evals/src'), { recursive: true });
    await symlink(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
    await writeFile(join(dir, 'tests/ordinary.test.ts'), "import test from 'node:test'; test('ordinary assertion passes', () => {});\n");
    await writeFile(join(dir, 'packages/evals/src/cli.ts'), 'setInterval(() => {}, 1000);\n');
    const runs: { suite: string; failed: string[]; timedOut: boolean }[] = [];
    const result = await gate.attempt(dir, probe, runs, { unit: 10_000, 'evals:modern': 200, 'evals:legacy': 30_000 });
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(result.signature, []);
    assert.equal(result.timedOut, true);
    assert.equal(result.suite, 'evals:modern');
    assert.equal(runs.at(-1)!.suite, 'evals:modern');
    assert.deepEqual(runs.at(-1)!.failed, []);
    assert.equal(runs.at(-1)!.timedOut, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mutation anchors: dollar substitution tokens in replacements are literal bytes', () => {
  const replacement = "$&$$|$`|$'";
  const result = gate.applyMutationEdits({ ...probe, find: 'guard', replace: replacement }, new Map([[probe.file, 'before guard after']]));
  assert.deepEqual(result.failures, []);
  assert.equal(result.changed.get(probe.file), `before ${replacement} after`);
});

test('mutation judge: a legacy-only eval failure retains the legacy suite and signature', async () => {
  const dir = await judgeFixture();
  try {
    await writeFile(join(dir, 'packages/evals/src/cli.ts'), "if (process.argv.some((arg, i, argv) => arg === '--era' && argv[i + 1] === 'legacy')) process.exitCode = 1;\n");
    const runs: { suite: string; failed: string[]; timedOut: boolean }[] = [];
    const result = await gate.attempt(dir, probe, runs);
    assert.deepEqual(result, { outcome: 'failed', signature: ['evals:legacy'], timedOut: false, suite: 'evals:legacy' });
    assert.deepEqual(runs.map(run => [run.suite, run.failed, run.timedOut]), [
      ['unit', [], false], ['evals:modern', [], false], ['evals:legacy', ['evals:legacy'], false],
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('mutation judge: a focused isolation rerun uses its unequal isolation cap', async () => {
  const runs: unknown[] = [];
  let calls = 0;
  const first = { signature: ['isolation:synthetic (target)'], suite: 'isolation' };
  const result = await gate.focusedAttempt('synthetic-dir', first, runs, { unit: 101, isolation: 12345 }, async (dir, cap, pattern, suite) => {
    calls++;
    assert.equal(dir, 'synthetic-dir');
    assert.equal(cap, 12345);
    assert.equal(suite, 'isolation');
    assert.ok(new RegExp(pattern).test('synthetic (target)'));
    assert.ok(!new RegExp(pattern).test('isolation:synthetic (target)'));
    return { ok: false, testsRun: 1, failed: first.signature, timedOut: false, durationMs: 12 };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { outcome: 'failed', signature: first.signature, timedOut: false, suite: 'isolation' });
  assert.deepEqual(runs, [{ suite: 'isolation', focused: true, durationMs: 12, testsRun: 1, failed: first.signature, timedOut: false }]);
});

async function judgeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mutation-judge-behavior-'));
  await mkdir(join(dir, 'tests/isolation'), { recursive: true });
  await mkdir(join(dir, 'packages/evals/src'), { recursive: true });
  await symlink(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
  await writeFile(join(dir, 'probe.ts'), 'const value: number = 1;\n');
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, skipLibCheck: true, types: [] }, files: ['probe.ts'] }));
  await writeFile(join(dir, 'tsconfig.build.json'), JSON.stringify({ extends: './tsconfig.json', compilerOptions: { noEmit: false, outDir: 'dist' } }));
  await writeFile(join(dir, 'tests/ordinary.test.ts'), "import test from 'node:test'; test('ordinary passes', () => {});\n");
  await writeFile(join(dir, 'tests/isolation/x.test.ts'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('synthetic isolation target', () => assert.fail('isolation assertion')); test('isolation control', () => {});\n");
  await writeFile(join(dir, 'packages/evals/src/cli.ts'), '// Synthetic eval pass.\n');
  return dir;
}

test('mutation judge: isolation declarations execute isolation and focused reproduction targets that suite', async () => {
  const dir = await judgeFixture();
  try {
    const isolated = { ...probe, file: 'probe.ts', find: '= 1', replace: '= 2', suites: ['unit', 'isolation'] };
    const runs: { suite: string }[] = [];
    const first = await gate.attempt(dir, isolated, runs);
    assert.deepEqual(runs.map(run => run.suite), ['unit', 'isolation']);
    assert.deepEqual(first, { outcome: 'failed', signature: ['isolation:synthetic isolation target'], timedOut: false, suite: 'isolation' });
    const judged = await gate.judge(dir, isolated, new Map([['probe.ts', 'const value: number = 1;\n']]));
    assert.equal(judged.status, 'killed', judged.detail);
    assert.equal(judged.kill_kind, 'named');
    assert.deepEqual(judged.failingTests, ['isolation:synthetic isolation target']);
    assert.deepEqual(judged.suiteRuns.map(run => [run.suite, run.focused, run.testsRun]), [['unit', false, 1], ['isolation', false, 2], ['isolation', true, 1]]);
    const ordinaryRuns: { suite: string }[] = [];
    const unitOnly = await gate.attempt(dir, { ...isolated, suites: ['unit'] }, ordinaryRuns);
    assert.equal(unitOnly.outcome, 'passed');
    assert.equal(unitOnly.suite, 'evals:legacy');
    assert.deepEqual(ordinaryRuns.map(run => run.suite), ['unit', 'evals:modern', 'evals:legacy']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('mutation judge: compilation and preparation failures are inconclusive and never kills', async () => {
  const dir = await judgeFixture();
  try {
    const source = 'const value: number = 1;\n';
    const compile = await gate.judge(dir, { ...probe, file: 'probe.ts', find: '= 1', replace: "= 'not a number'" }, new Map([['probe.ts', source]]));
    assert.equal(compile.status, 'inconclusive');
    assert.equal(compile.kill_kind, undefined);
    assert.match(compile.detail, /typecheck failed/);
    assert.deepEqual(compile.failingTests, []);
    assert.deepEqual(compile.suiteRuns, []);
    assert.equal(await readFile(join(dir, 'probe.ts'), 'utf8'), source);
    const buildConfig = await readFile(join(dir, 'tsconfig.build.json'), 'utf8');
    await writeFile(join(dir, 'build-only-error.ts'), "const buildOnly: number = 'not a number';\n");
    await writeFile(join(dir, 'tsconfig.build.json'), JSON.stringify({ extends: './tsconfig.json', compilerOptions: { noEmit: false, outDir: 'dist' }, files: ['probe.ts', 'build-only-error.ts'] }));
    const build = await gate.judge(dir, { ...probe, file: 'probe.ts', find: '= 1', replace: '= 2' }, new Map([['probe.ts', source]]));
    assert.equal(build.status, 'inconclusive');
    assert.equal(build.kill_kind, undefined);
    assert.match(build.detail, /mutant build failed/);
    assert.deepEqual(build.compilation, { typecheck: true, build: false });
    assert.deepEqual(build.failingTests, []);
    assert.deepEqual(build.suiteRuns, []);
    assert.equal(await readFile(join(dir, 'probe.ts'), 'utf8'), source);
    await writeFile(join(dir, 'tsconfig.build.json'), buildConfig);
    await mkdir(join(dir, 'scripts'));
    await mkdir(join(dir, 'docs/contracts'), { recursive: true });
    const artifact = '{"original":true}\n';
    await writeFile(join(dir, 'docs/contracts/m3b-tools.json'), artifact);
    await writeFile(join(dir, 'scripts/emit-m3b-contract.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('docs/contracts/m3b-tools.json', 'changed'); throw new Error('synthetic preparation failure');\n");
    const preparation = await gate.judge(dir, { ...probe, file: 'probe.ts', find: '= 1', replace: '= 2', prepare: 'contract' }, new Map([['probe.ts', source], ['docs/contracts/m3b-tools.json', artifact]]));
    assert.equal(preparation.status, 'inconclusive');
    assert.equal(preparation.kill_kind, undefined);
    assert.match(preparation.detail, /preparation failed/);
    assert.deepEqual(preparation.failingTests, []);
    assert.deepEqual(preparation.suiteRuns, []);
    assert.equal(await readFile(join(dir, 'probe.ts'), 'utf8'), source);
    assert.equal(await readFile(join(dir, 'docs/contracts/m3b-tools.json'), 'utf8'), artifact);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
