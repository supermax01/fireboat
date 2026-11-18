// The mutation gate's targeted first pass: it may only kill, only on a reproduced
// named failure, and every mutant it does not kill goes down the unchanged full path.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

type Edit = { file: string; find: string; replace: string };
type Mutant = Edit & { id: string; edits?: Edit[]; suites?: string[] };
type Tier = { label: string; unit: string[]; isolation: string[]; evals: string[] };
type Plan = { tiers: Tier[] };
type FileRun = { ok: boolean; timedOut: boolean; durationMs: number; failed: string[]; testsRun: number; pinFailures: string[] };
type EraRun = { ok: boolean; timedOut: boolean; durationMs: number; nonBehavioural: boolean };
type RunOptions = { timeoutMs: number; namePattern?: string; suite: string; concurrency: number; expectedPins: unknown[] };
type SuiteRun = { suite: string; focused: boolean; targeted?: boolean; tier?: string; files?: string[]; testsRun: number | null; failed: string[] };
type Judged = { status: string; decidedBy: string; kill_kind?: string; failingTests: string[]; detail: string; suiteRuns: SuiteRun[] };
type Targeting = { plan: (mutant: Mutant) => Plan; estimate: (suite: string, file: string) => number };
type Binding = { commit: string; tree: string; inputsSha256: string; survivorsSha256: string; nodeVersion: string; platform: string; arch: string; runId: string | null; runAttempt: string | null };
type ReportResult = { id: string; verdict: string; failingTests: string[]; reproducedTimeout: boolean; kill_kind: string | null; decided_by?: string };
type Report = { results: ReportResult[] };

const gate = await import(new URL('../scripts/mutation-guards.mjs', import.meta.url).href) as {
  MUTANTS: Mutant[];
  NON_BEHAVIORAL_TESTS: Set<string>;
  DECIDERS: readonly string[];
  targetedAttempt: (dir: string, plan: Plan, runs: unknown[], options: {
    caps?: Record<string, number>; expectedPins?: unknown[]; estimate?: (suite: string, file: string) => number; concurrency?: number;
    runFiles?: (dir: string, files: string[], options: RunOptions) => Promise<FileRun>;
    runEra?: (dir: string, era: string, cap: number, pins: unknown[]) => Promise<EraRun>;
    declaringFiles?: (suite: string, names: string[], files: string[]) => string[] | undefined;
  }) => Promise<{ killed: boolean; reproduced?: string[]; suite?: string; tier?: string }>;
  targetedCap: (files: string[], estimate: (file: string) => number, suiteCap: number, concurrency: number) => number;
  judge: (dir: string, mutant: Mutant, pristine: Map<string, string>, targeting?: Targeting) => Promise<Judged>;
  testSuiteArgs: (files: string[], concurrency: number, pattern?: string, indexPath?: string) => string[];
  runTestFiles: (dir: string, files: string[], options: { timeoutMs: number; indexPath?: string }) => Promise<FileRun>;
  INDEX_REPORTER: string;
  createSlots: (total: number) => { total: number; free: number; acquire: (count: number) => Promise<void>; release: (count: number) => void };
  buildShardReport: (input: Record<string, unknown>) => Report;
  partitionMutants: (mutants: Mutant[], count: number) => Mutant[][];
  aggregateShardReports: (reports: unknown[], options: { mutants: Mutant[]; declared: Map<string, { justification: string }>; binding: Binding }) => { ok: boolean; errors: string[]; decisions: Record<string, number> };
  validateArgs: (argv: string[]) => void;
};
const targeting = await import(new URL('../scripts/mutation-targeting.mjs', import.meta.url).href) as {
  tapUnescape: (name: string) => string;
  canonicalTestName: (name: string) => string;
  parseIndexLines: (text: string, relativeFile: (file: string) => string | undefined) => { file: string; name: string; nesting: number; durationMs: number }[];
  buildTestIndex: (entries: Record<string, { file: string; name: string; nesting: number; durationMs: number }[]>, files: Record<string, string[]>) => { names: string[]; durationMs: Map<string, number> };
  registryComments: (source: string) => Map<string, string>;
  killingTestFragments: (comment: string) => string[];
  commentTestFiles: (comment: string) => string[];
  distinctiveTokens: (edits: Edit[]) => string[];
  readHintReports: (dir: string) => Promise<{ hints: Map<string, string[]>; files: string[]; errors: string[] }>;
  createTargeting: (input: Record<string, unknown>) => {
    plan: (mutant: Mutant) => Plan; learn: (mutant: Mutant, result: { status: string; failingTests: string[] }) => void; estimate: (suite: string, file: string) => number;
    declaringFiles: (suite: string, names: string[], files: string[]) => string[] | undefined;
  };
};

const probe: Mutant = { id: 'targeted-probe', file: 'probe.ts', find: '= 1', replace: '= 2' };
const unitTier = (files: string[], label = 'strong'): Plan => ({ tiers: [{ label, unit: files, isolation: [], evals: [] }] });
const fileRun = (failed: string[], extra: Partial<FileRun> = {}): FileRun => ({ ok: failed.length === 0, timedOut: false, durationMs: 5, failed, testsRun: Math.max(1, failed.length), pinFailures: [], ...extra });
/** Scripted runner: returns the queued results in order and records every call. */
function scripted(results: FileRun[]) {
  const calls: { files: string[]; options: RunOptions }[] = [];
  return { calls, run: async (_dir: string, files: string[], options: RunOptions) => { calls.push({ files, options }); const next = results.shift(); assert.ok(next, 'unexpected extra run'); return next; } };
}

test('targeted pass: never yields KILLED without a reproduced failure', async () => {
  for (const rerun of [fileRun([]), fileRun(['another test']), fileRun([], { ok: false, testsRun: 0 })]) {
    const runner = scripted([fileRun(['discriminator']), rerun]);
    const runs: SuiteRun[] = [];
    const outcome = await gate.targetedAttempt('dir', unitTier(['tests/a.test.ts']), runs, { runFiles: runner.run });
    assert.deepEqual(outcome, { killed: false });
    assert.equal(runner.calls.length, 2, 'a first failure is always judged a second time');
    assert.deepEqual(runner.calls[1]!.files, ['tests/a.test.ts']);
    assert.ok(runs.every(run => run.targeted === true));
  }
});

test('targeted pass: reproduce-twice is enforced and a reproduced named failure kills', async () => {
  const runner = scripted([fileRun(['discriminator', 'flaky neighbour']), fileRun(['discriminator'])]);
  const runs: SuiteRun[] = [];
  const outcome = await gate.targetedAttempt('dir', unitTier(['tests/a.test.ts', 'tests/b.test.ts']), runs, { runFiles: runner.run, concurrency: 3 });
  assert.deepEqual(outcome, { killed: true, reproduced: ['discriminator'], suite: 'unit', tier: 'strong' });
  const [first, second] = runner.calls;
  assert.equal(first!.options.namePattern, undefined);
  assert.equal(first!.options.concurrency, 2, 'a targeted run never uses more files at once than it has');
  assert.deepEqual(second!.files, first!.files);
  const pattern = new RegExp(second!.options.namePattern!);
  for (const name of ['discriminator', 'flaky neighbour']) assert.ok(pattern.test(name), name);
  assert.ok(!pattern.test('unrelated discriminator'));
  assert.deepEqual(runs.map(run => [run.focused, run.tier]), [[false, 'strong'], [true, 'strong']]);
});

test('targeted pass: timeouts, file-level, pin-only and unselected reruns are never credited', async () => {
  const pin = [...gate.NON_BEHAVIORAL_TESTS][0]!;
  const cases: { label: string; results: FileRun[]; calls: number }[] = [
    { label: 'first run timed out', results: [fileRun(['discriminator'], { timedOut: true })], calls: 1 },
    { label: 'file-level failure only', results: [fileRun(['tests/a.test.ts'])], calls: 1 },
    { label: 'pin-only failure', results: [fileRun([pin])], calls: 1 },
    { label: 'measured preflight pin', results: [fileRun(['containing test'], { pinFailures: ['containing test'] })], calls: 1 },
    { label: 'rerun selected nothing', results: [fileRun(['discriminator']), fileRun([], { ok: true, testsRun: 0 })], calls: 2 },
    { label: 'rerun timed out without names', results: [fileRun(['discriminator']), fileRun([], { ok: false, timedOut: true })], calls: 2 },
  ];
  for (const { label, results, calls } of cases) {
    const runner = scripted(results);
    assert.deepEqual(await gate.targetedAttempt('dir', unitTier(['tests/a.test.ts']), [], { runFiles: runner.run }), { killed: false }, label);
    assert.equal(runner.calls.length, calls, label);
  }
});

test('targeted pass: an eval era kill needs the same era to fail twice; timeouts and pin refusals never count', async () => {
  const eraRun = (ok: boolean, extra: Partial<EraRun> = {}): EraRun => ({ ok, timedOut: false, durationMs: 3, nonBehavioural: false, ...extra });
  const plan: Plan = { tiers: [{ label: 'lexical', unit: [], isolation: [], evals: ['evals:modern', 'evals:legacy'] }] };
  const play = async (results: EraRun[]) => {
    const calls: string[] = [];
    const outcome = await gate.targetedAttempt('dir', plan, [], { runEra: async (_dir, era) => { calls.push(era); const next = results.shift(); assert.ok(next); return next; } });
    return { outcome, calls };
  };
  assert.deepEqual(await play([eraRun(false), eraRun(false)]), { outcome: { killed: true, reproduced: ['evals:modern'], suite: 'evals:modern', tier: 'lexical' }, calls: ['evals:modern', 'evals:modern'] });
  assert.deepEqual((await play([eraRun(false), eraRun(true), eraRun(true)])).outcome, { killed: false });
  assert.deepEqual((await play([eraRun(false, { timedOut: true }), eraRun(false, { timedOut: true })])).calls, ['evals:modern', 'evals:legacy']);
  assert.deepEqual((await play([eraRun(false, { nonBehavioural: true }), eraRun(true)])).outcome, { killed: false });
  assert.deepEqual((await play([eraRun(false), eraRun(false, { timedOut: true }), eraRun(true)])).outcome, { killed: false });
});

test('targeted pass: a failure is rerun in the candidate files that declare it, or in all of them when one is unknown', async () => {
  const files = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'];
  const declared = (_suite: string, names: string[]) => (names.includes('unknown') ? undefined : ['tests/b.test.ts']);
  const narrowed = scripted([fileRun(['in b']), fileRun(['in b'])]);
  assert.deepEqual(await gate.targetedAttempt('dir', unitTier(files, 'sweep'), [], { runFiles: narrowed.run, declaringFiles: declared }), { killed: true, reproduced: ['in b'], suite: 'unit', tier: 'sweep' });
  assert.deepEqual(narrowed.calls.map(call => [call.files, call.options.concurrency]), [[files, 3], [['tests/b.test.ts'], 1]]);
  const whole = scripted([fileRun(['in b', 'unknown']), fileRun(['in b'])]);
  await gate.targetedAttempt('dir', unitTier(files), [], { runFiles: whole.run, declaringFiles: declared });
  assert.deepEqual(whole.calls[1]!.files, files);
  const elsewhere = scripted([fileRun(['in b']), fileRun([], { ok: true, testsRun: 0 })]);
  assert.deepEqual(await gate.targetedAttempt('dir', unitTier(files), [], { runFiles: elsewhere.run, declaringFiles: () => ['tests/c.test.ts'] }), { killed: false }, 'a wrong index can only lose a kill');
});

test('targeted pass: tiers run in order and a later tier runs only when the earlier did not kill', async () => {
  const plan: Plan = { tiers: [{ label: 'strong', unit: ['tests/a.test.ts'], isolation: [], evals: [] }, { label: 'learned', unit: ['tests/b.test.ts'], isolation: ['tests/isolation/c.test.ts'], evals: [] }] };
  const runner = scripted([fileRun([]), fileRun([]), fileRun(['isolation:case']), fileRun(['isolation:case'])]);
  const outcome = await gate.targetedAttempt('dir', plan, [], { runFiles: runner.run });
  assert.deepEqual(outcome, { killed: true, reproduced: ['isolation:case'], suite: 'isolation', tier: 'learned' });
  assert.deepEqual(runner.calls.map(call => [call.options.suite, call.files]), [
    ['unit', ['tests/a.test.ts']], ['unit', ['tests/b.test.ts']], ['isolation', ['tests/isolation/c.test.ts']], ['isolation', ['tests/isolation/c.test.ts']],
  ]);
  assert.ok(new RegExp(runner.calls[3]!.options.namePattern!).test('case'), 'isolation names lose their prefix in the rerun pattern');
});

test('targeted pass: caps scale with the candidates, keep a 60 s floor and never exceed the suite cap', () => {
  assert.equal(gate.targetedCap(['a'], () => 1_000, 600_000, 3), 60_000);
  assert.equal(gate.targetedCap(['a', 'b', 'c'], () => 30_000, 600_000, 3), 180_000);
  assert.equal(gate.targetedCap(['a', 'b'], file => (file === 'a' ? 90_000 : 1_000), 300_000, 2), 300_000);
});

async function judgeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mutation-targeted-'));
  await mkdir(join(dir, 'tests/isolation'), { recursive: true });
  await mkdir(join(dir, 'packages/evals/src'), { recursive: true });
  await symlink(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
  await writeFile(join(dir, 'probe.ts'), 'const value: number = 1;\n');
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, skipLibCheck: true, types: [] }, files: ['probe.ts'] }));
  await writeFile(join(dir, 'tsconfig.build.json'), JSON.stringify({ extends: './tsconfig.json', compilerOptions: { noEmit: false, outDir: 'dist' } }));
  await writeFile(join(dir, 'tests/passing.test.ts'), "import test from 'node:test'; test('candidate passes', () => {});\n");
  await writeFile(join(dir, 'packages/evals/src/cli.ts'), '// Synthetic eval pass.\n');
  return dir;
}
const failing = (name: string) => `import test from 'node:test'; import assert from 'node:assert/strict'; test(${JSON.stringify(name)}, () => assert.fail('discriminating assertion'));\n`;
// Fails only the first time it runs in a copy, like a load-sensitive flake.
const flaky = (name: string) => `import test from 'node:test'; import assert from 'node:assert/strict'; import { existsSync, writeFileSync } from 'node:fs';
test(${JSON.stringify(name)}, () => { if (!existsSync('flaky.marker')) { writeFileSync('flaky.marker', ''); assert.fail('first run only'); } });\n`;
const pristine = () => new Map([['probe.ts', 'const value: number = 1;\n']]);
const planned = (plan: Plan) => {
  const mutants: string[] = [];
  return { mutants, targeting: { plan: (mutant: Mutant) => { mutants.push(mutant.id); return plan; }, estimate: () => 1_000 } };
};

test('targeted judge: a reproduced candidate failure kills without running the full suite', async () => {
  const dir = await judgeFixture();
  try {
    await writeFile(join(dir, 'tests/killing.test.ts'), failing('targeted discriminator'));
    const { targeting: planner } = planned(unitTier(['tests/killing.test.ts']));
    const judged = await gate.judge(dir, probe, pristine(), planner);
    assert.equal(judged.status, 'killed', judged.detail);
    assert.equal(judged.decidedBy, 'targeted');
    assert.equal(judged.kill_kind, 'named');
    assert.deepEqual(judged.failingTests, ['targeted discriminator']);
    assert.deepEqual(judged.suiteRuns.map(run => [run.suite, run.targeted, run.focused, run.files]), [
      ['unit', true, false, ['tests/killing.test.ts']], ['unit', true, true, ['tests/killing.test.ts']],
    ]);
    assert.equal(await readFile(join(dir, 'probe.ts'), 'utf8'), 'const value: number = 1;\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('targeted judge: falls through to the full path when the candidates pass', async () => {
  const dir = await judgeFixture();
  try {
    await writeFile(join(dir, 'tests/killing.test.ts'), failing('full-suite discriminator'));
    const { targeting: planner } = planned(unitTier(['tests/passing.test.ts']));
    const judged = await gate.judge(dir, probe, pristine(), planner);
    assert.equal(judged.status, 'killed', judged.detail);
    assert.equal(judged.decidedBy, 'full');
    assert.deepEqual(judged.failingTests, ['full-suite discriminator']);
    assert.deepEqual(judged.suiteRuns.map(run => [run.suite, run.targeted === true, run.focused]), [
      ['unit', true, false], ['unit', false, false], ['unit', false, true],
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('targeted judge: never yields SURVIVED or a pass by itself; a flaky candidate falls through', async () => {
  const dir = await judgeFixture();
  try {
    await writeFile(join(dir, 'tests/flaky.test.ts'), flaky('flaky candidate'));
    const { targeting: planner } = planned(unitTier(['tests/flaky.test.ts', 'tests/passing.test.ts']));
    const judged = await gate.judge(dir, probe, pristine(), planner);
    assert.equal(judged.status, 'survived', judged.detail);
    assert.equal(judged.decidedBy, 'full', 'only the full path decides a survivor');
    assert.deepEqual(judged.suiteRuns.map(run => [run.suite, run.targeted === true, run.focused]), [
      ['unit', true, false], ['unit', true, true], ['unit', false, false], ['evals:modern', false, false], ['evals:legacy', false, false],
    ]);
    const survivor = await gate.judge(dir, probe, pristine(), planned(unitTier(['tests/passing.test.ts'])).targeting);
    assert.equal(survivor.status, 'survived');
    assert.equal(survivor.decidedBy, 'full');
    assert.deepEqual(survivor.suiteRuns.filter(run => !run.targeted).map(run => run.suite), ['unit', 'evals:modern', 'evals:legacy']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('targeted judge: compilation failures stay inconclusive and no candidate runs', async () => {
  const dir = await judgeFixture();
  try {
    await writeFile(join(dir, 'tests/killing.test.ts'), failing('would-be discriminator'));
    const { targeting: planner, mutants } = planned(unitTier(['tests/killing.test.ts']));
    const judged = await gate.judge(dir, { ...probe, replace: "= 'not a number'" }, pristine(), planner);
    assert.equal(judged.status, 'inconclusive');
    assert.equal(judged.decidedBy, 'precheck');
    assert.deepEqual(judged.suiteRuns, []);
    assert.deepEqual(mutants, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('targeted judge: without a planner every verdict comes from the full path', async () => {
  const dir = await judgeFixture();
  try {
    await writeFile(join(dir, 'tests/killing.test.ts'), failing('full-suite discriminator'));
    const judged = await gate.judge(dir, probe, pristine());
    assert.equal(judged.decidedBy, 'full');
    assert.ok(judged.suiteRuns.every(run => run.targeted !== true));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('test-title index: the reporter is added only with an index path and records declaring files', async () => {
  const files = ['tests/a.test.ts', 'tests/b.test.ts'];
  assert.deepEqual(gate.testSuiteArgs(files, 2), ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=2', ...files]);
  const indexed = gate.testSuiteArgs(files, 2, 'name', '/index.jsonl');
  assert.deepEqual(indexed.slice(indexed.indexOf(files[0]!)), files);
  assert.ok(indexed.includes(`--test-reporter=${gate.INDEX_REPORTER}`) && indexed.includes('--test-reporter-destination=/index.jsonl'));
  assert.ok(indexed.indexOf('--test-reporter-destination=stdout') < indexed.indexOf(`--test-reporter=${gate.INDEX_REPORTER}`), 'TAP stays on stdout');
  const dir = await judgeFixture();
  try {
    await writeFile(join(dir, 'tests/nested.test.ts'), "import test from 'node:test'; test.describe('outer # group', () => { test.it('inner case', () => {}); });\n");
    const indexPath = join(dir, 'index.jsonl');
    const run = await gate.runTestFiles(dir, ['tests/nested.test.ts', 'tests/passing.test.ts'], { timeoutMs: 60_000, indexPath });
    assert.equal(run.ok, true);
    const bases = [dir, await realpath(dir)];
    const entries = targeting.parseIndexLines(await readFile(indexPath, 'utf8'), file => bases.filter(base => file.startsWith(`${base}/`)).map(base => file.slice(base.length + 1))[0]);
    const index = targeting.buildTestIndex({ unit: entries }, { unit: ['tests/nested.test.ts', 'tests/passing.test.ts'] });
    assert.deepEqual([...index.names].sort(), ['candidate passes', 'inner case', 'outer # group']);
    assert.ok(index.durationMs.has('unit:tests/nested.test.ts'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('candidate names: TAP escapes are undone and registry comments are parsed per entry', () => {
  assert.equal(targeting.tapUnescape('hash \\# and back\\\\slash'), 'hash # and back\\slash');
  assert.equal(targeting.canonicalTestName('  a \\#  b\n'), 'a # b');
  const comments = targeting.registryComments([
    "  // Section header: witnesses in counting.test.ts.",
    "  // Drop a guard. Killing tests: first exact name; second name.",
    "  M('alpha', 'f.ts', 'x', 'y'),",
    "  M(\"beta\", 'f.ts', 'x', 'z'),",
    "  // stray comment",
    "  const unrelated = 1;",
    "  C('gamma', [{ file: 'f.ts', find: 'x', replace: 'w' }]),",
  ].join('\n'));
  assert.deepEqual([...comments], [['alpha', 'Section header: witnesses in counting.test.ts. Drop a guard. Killing tests: first exact name; second name.'], ['beta', ''], ['gamma', '']]);
  assert.deepEqual(targeting.killingTestFragments(comments.get('alpha')!), ['first exact name', 'second name']);
  assert.deepEqual(targeting.commentTestFiles(comments.get('alpha')!), ['counting.test.ts']);
  assert.deepEqual(targeting.killingTestFragments('no names here'), []);
  assert.deepEqual(targeting.distinctiveTokens([{ file: 'f', find: 'if (guardCheck(value, patientId)) return', replace: 'if (false) return' }]), ['guardCheck', 'value', 'patientId']);
});

function planner(options: { hints?: Map<string, string[]>; comments?: Map<string, string>; sources?: Map<string, string> } = {}) {
  const entries = {
    unit: [
      { file: 'tests/exact.test.ts', name: 'exact killing name', nesting: 0, durationMs: 100 },
      { file: 'tests/other.test.ts', name: 'a much longer test name that contains the fragment text', nesting: 0, durationMs: 100 },
      { file: 'tests/slow.test.ts', name: 'slow guard check', nesting: 0, durationMs: 60_000 },
      { file: 'tests/medium.test.ts', name: 'medium guard check', nesting: 0, durationMs: 30_000 },
    ],
    isolation: [{ file: 'tests/isolation/counting.test.ts', name: 'counting witness', nesting: 0, durationMs: 100 }],
  };
  const files = { unit: ['tests/exact.test.ts', 'tests/other.test.ts', 'tests/slow.test.ts', 'tests/medium.test.ts', 'tests/lexical.test.ts'], isolation: ['tests/isolation/counting.test.ts'] };
  const sources = options.sources ?? new Map([
    ['unit:tests/exact.test.ts', 'plain'], ['unit:tests/other.test.ts', 'plain'], ['unit:tests/slow.test.ts', 'rareGuardToken slowOnlyToken'], ['unit:tests/medium.test.ts', 'mediumOnlyToken'],
    ['unit:tests/lexical.test.ts', 'rareGuardToken // kills: annotated-id'], ['isolation:tests/isolation/counting.test.ts', 'plain'],
  ]);
  return targeting.createTargeting({
    index: targeting.buildTestIndex(entries, files), comments: options.comments ?? new Map(), hints: options.hints ?? new Map(), sources,
    edits: (mutant: Mutant) => mutant.edits ?? [{ file: mutant.file, find: mutant.find, replace: mutant.replace }],
    declaredSuites: (mutant: Mutant) => mutant.suites ?? ['unit'],
  });
}
const mutant = (id: string, extra: Partial<Mutant> = {}): Mutant => ({ id, file: 'packages/core/src/x.ts', find: 'plainCode()', replace: '', ...extra });

const early = (tiers: Tier[]) => tiers.filter(tier => tier.label !== 'sweep');

test('candidate plan: comments, hints and kills annotations are strong; isolation only for declared mutants', () => {
  const comments = new Map([['commented', 'Killing tests: exact killing name; the fragment text'], ['isolated', 'witnesses in counting.test.ts']]);
  const hints = new Map([['hinted', ['isolation:counting witness', 'evals:legacy']]]);
  const targets = planner({ comments, hints });
  const plan = { plan: (entry: Mutant) => ({ tiers: early(targets.plan(entry).tiers) }) };
  assert.deepEqual(plan.plan(mutant('commented')).tiers, [{ label: 'strong', unit: ['tests/exact.test.ts', 'tests/other.test.ts'], isolation: [], evals: [] }]);
  assert.deepEqual(plan.plan(mutant('annotated-id')).tiers[0], { label: 'strong', unit: ['tests/lexical.test.ts'], isolation: [], evals: [] });
  assert.deepEqual(plan.plan(mutant('hinted')).tiers, [{ label: 'strong', unit: [], isolation: [], evals: ['evals:legacy'] }], 'isolation hints need a declared isolation suite');
  assert.deepEqual(plan.plan(mutant('hinted', { suites: ['unit', 'isolation'] })).tiers[0]!.isolation, ['tests/isolation/counting.test.ts']);
  assert.deepEqual(plan.plan(mutant('isolated')).tiers, []);
  assert.deepEqual(plan.plan(mutant('isolated', { suites: ['unit', 'isolation'] })).tiers[0]!.isolation, ['tests/isolation/counting.test.ts']);
});

test('candidate plan: learned files follow the source file, eval edits try both eras, lexical ranking respects budgets', () => {
  const targets = planner();
  const plan = { learn: targets.learn, plan: (entry: Mutant) => ({ tiers: early(targets.plan(entry).tiers) }) };
  assert.deepEqual(plan.plan(mutant('cold')).tiers, []);
  plan.learn(mutant('earlier'), { status: 'killed', failingTests: ['exact killing name', 'unknown name'] });
  plan.learn(mutant('survivor'), { status: 'survived', failingTests: ['slow guard check'] });
  assert.deepEqual(plan.plan(mutant('later')).tiers, [{ label: 'learned', unit: ['tests/exact.test.ts'], isolation: [], evals: [] }]);
  assert.deepEqual(plan.plan(mutant('elsewhere', { file: 'packages/core/src/y.ts' })).tiers, []);
  assert.deepEqual(plan.plan(mutant('harness', { file: 'packages/evals/src/runner.ts' })).tiers, [{ label: 'lexical', unit: [], isolation: [], evals: ['evals:modern', 'evals:legacy'] }]);
  const lexical = plan.plan(mutant('lexical', { file: 'packages/core/src/z.ts', find: 'if (rareGuardToken) deny()', replace: 'if (false) deny()' })).tiers;
  assert.deepEqual(lexical, [{ label: 'lexical', unit: ['tests/lexical.test.ts'], isolation: [], evals: [] }], 'a file over the lexical time budget is skipped');
  const top = (token: string) => plan.plan(mutant(`top-${token}`, { file: 'packages/core/src/z.ts', find: `if (${token}) deny()`, replace: 'if (false) deny()' })).tiers;
  assert.deepEqual(top('mediumOnlyToken'), [{ label: 'lexical', unit: ['tests/medium.test.ts'], isolation: [], evals: [] }], 'the top-ranked file may exceed the per-file budget');
  assert.deepEqual(top('slowOnlyToken'), [], 'but never the top-file ceiling');
});

test('candidate plan: the sweep runs every untried unit file once, most likely first, in bounded batches', () => {
  const targets = planner();
  const sweep = (entry: Mutant) => targets.plan(entry).tiers.filter(tier => tier.label === 'sweep');
  const unitFiles = ['tests/exact.test.ts', 'tests/other.test.ts', 'tests/slow.test.ts', 'tests/medium.test.ts', 'tests/lexical.test.ts'];
  const cold = sweep(mutant('cold'));
  assert.deepEqual(cold.flatMap(tier => tier.unit).sort(), [...unitFiles].sort(), 'every unit file, exactly once');
  assert.ok(cold.every(tier => tier.isolation.length === 0 && tier.evals.length === 0), 'never isolation files or eval eras');
  assert.deepEqual(cold.map(tier => tier.unit), [['tests/exact.test.ts', 'tests/other.test.ts', 'tests/lexical.test.ts', 'tests/medium.test.ts'], ['tests/slow.test.ts']], 'fastest first; a file over the batch budget runs alone');
  targets.learn(mutant('earlier'), { status: 'killed', failingTests: ['medium guard check'] });
  assert.equal(sweep(mutant('elsewhere', { file: 'packages/core/src/y.ts' }))[0]!.unit[0], 'tests/medium.test.ts', 'a file that killed any mutant comes first');
  const tiers = targets.plan(mutant('same-file')).tiers;
  assert.deepEqual(tiers[0], { label: 'learned', unit: ['tests/medium.test.ts'], isolation: [], evals: [] });
  assert.ok(!tiers.slice(1).some(tier => tier.unit.includes('tests/medium.test.ts')), 'a file tried in an earlier tier is not swept again');
  assert.deepEqual(targets.declaringFiles('unit', ['medium guard check', 'exact killing name'], unitFiles), ['tests/exact.test.ts', 'tests/medium.test.ts']);
  assert.equal(targets.declaringFiles('unit', ['medium guard check', 'not indexed'], unitFiles), undefined);
  assert.equal(targets.declaringFiles('unit', ['medium guard check'], ['tests/exact.test.ts']), undefined, 'only files among the candidates');
  assert.deepEqual(targets.declaringFiles('isolation', ['isolation:counting witness'], ['tests/isolation/counting.test.ts']), ['tests/isolation/counting.test.ts']);
});

test('hint reports: only killed results with names are hints; unreadable reports are skipped, never fatal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mutation-hints-'));
  try {
    await writeFile(join(dir, 'a.json'), JSON.stringify({ results: [
      { id: 'one', verdict: 'killed', failingTests: ['named test'] }, { id: 'two', verdict: 'survived', failingTests: [] },
      { id: 'three', verdict: 'inconclusive', failingTests: ['flaky'] }, { id: 'four', verdict: 'killed', failingTests: [] },
    ] }));
    await writeFile(join(dir, 'b.json'), '{ not json');
    await writeFile(join(dir, 'notes.txt'), 'ignored');
    const read = await targeting.readHintReports(dir);
    assert.deepEqual([...read.hints], [['one', ['named test']]]);
    assert.deepEqual(read.files, ['a.json', 'b.json']);
    assert.deepEqual(read.errors, ['hint report b.json: not valid JSON']);
    assert.deepEqual((await targeting.readHintReports(join(dir, 'missing'))).errors.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const BINDING: Binding = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), inputsSha256: 'c'.repeat(64), survivorsSha256: 'd'.repeat(64), nodeVersion: 'v24.22.0', platform: 'linux', arch: 'x64', runId: null, runAttempt: null };
const synth = (count: number): Mutant[] => Array.from({ length: count }, (_, i) => ({ id: `mutant-${i}`, file: 'packages/core/src/example.ts', find: `find-${i}`, replace: `replace-${i}` }));
function reports(mutants: Mutant[], results: (id: string) => Record<string, unknown>): Report[] {
  return gate.partitionMutants(mutants, 2).map((shard, index) => gate.buildShardReport({
    shardIndex: index + 1, shardCount: 2, mutants, binding: BINDING, baseline: 'green', durationMs: 1,
    results: shard.map(entry => ({ id: entry.id, status: 'killed', anchorMatches: 1, failingTests: ['named'], kill_kind: 'named', reproducedTimeout: false, ...results(entry.id) })),
  }));
}

test('aggregate: the targeted pass can only decide reproduced named kills, and decisions are counted', () => {
  assert.deepEqual([...gate.DECIDERS], ['targeted', 'full', 'precheck']);
  const mutants = synth(4), options = { mutants, binding: BINDING, declared: new Map([['mutant-3', { justification: 'Reviewed synthetic justification for this survivor.' }]]) };
  const decided = (id: string) => ({ 'mutant-0': { decidedBy: 'targeted' }, 'mutant-1': { decidedBy: 'full' }, 'mutant-2': { decidedBy: 'targeted' },
    'mutant-3': { decidedBy: 'full', status: 'survived', failingTests: [], kill_kind: null } } as Record<string, Record<string, unknown>>)[id]!;
  const good = gate.aggregateShardReports(reports(mutants, decided), options);
  assert.equal(good.ok, true, good.errors.join('\n'));
  assert.deepEqual(good.decisions, { targeted: 2, full: 2, precheck: 0 });
  const defaults = reports(mutants, id => (id === 'mutant-3' ? { status: 'survived', failingTests: [], kill_kind: null } : {}));
  assert.ok(defaults.every(report => report.results.every(result => result.decided_by === 'full')), 'a result without a decider is a full-path result');
  const bad: [string, Record<string, unknown>, RegExp][] = [
    ['targeted survivor', { decidedBy: 'targeted', status: 'survived', failingTests: [], kill_kind: null }, /targeted pass can only decide/],
    ['targeted inconclusive', { decidedBy: 'targeted', status: 'inconclusive', kill_kind: null }, /targeted pass can only decide/],
    ['targeted timeout kill', { decidedBy: 'targeted', failingTests: [], kill_kind: 'timeout', reproducedTimeout: true }, /targeted pass can only decide/],
    ['unknown decider', { decidedBy: 'guess' }, /decided_by is missing or unknown/],
    ['precheck kill', { decidedBy: 'precheck' }, /decided_by disagrees/],
    ['full anchor error', { decidedBy: 'full', status: 'anchor-error', failingTests: [], kill_kind: null }, /decided_by disagrees/],
  ];
  for (const [label, patch, error] of bad) {
    const outcome = gate.aggregateShardReports(reports(mutants, id => (id === 'mutant-0' ? patch : decided(id))), options);
    assert.ok(outcome.errors.some(message => error.test(message)), `${label}: ${outcome.errors.join('\n')}`);
  }
  const missing = reports(mutants, decided);
  delete missing[0]!.results[0]!.decided_by;
  assert.ok(gate.aggregateShardReports(missing, options).errors.some(message => /decided_by is missing/.test(message)));
});

test('CLI: hint and targeting options are refused where they cannot apply', () => {
  // In-process, as main() runs validateArgs() first: a spawned gate could start real suite runs on a regression.
  for (const [argv, message] of [
    [['--hints'], /--hints requires a value/], [['--hints', 'x', '--no-targeted'], /--hints needs the targeted pass/],
    [['--aggregate', 'x', '--hints', 'y'], /apply to judging runs, not --aggregate/], [['--aggregate', 'x', '--no-targeted'], /apply to judging runs, not --aggregate/],
    [['--list', '--no-targeted'], /--list can only be combined with --scope/], [['--no-targeted', '--no-targeted'], /unknown or repeated option --no-targeted/],
  ] as const) {
    assert.throws(() => gate.validateArgs([...argv]), message, argv.join(' '));
  }
});

test('CPU slots: all worker copies together never run more test files than the slots, in request order', async () => {
  const slots = gate.createSlots(4);
  const order: string[] = [];
  let busy = 0, peak = 0;
  const job = async (label: string, count: number, release: Promise<void>) => {
    await slots.acquire(count);
    busy += count; peak = Math.max(peak, busy); order.push(label);
    await release;
    busy -= count; slots.release(count);
  };
  let openFirst!: () => void;
  const first = new Promise<void>(resolve => { openFirst = resolve; });
  const jobs = [job('full suite A', 3, first), job('full suite B', 3, Promise.resolve()), job('targeted C', 1, Promise.resolve())];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['full suite A'], 'a later small request waits behind an earlier large one');
  openFirst();
  await Promise.all(jobs);
  assert.deepEqual(order, ['full suite A', 'full suite B', 'targeted C']);
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.equal(slots.free, 4);
  for (const bad of [0, 5, 1.5]) await assert.rejects(slots.acquire(bad), /invalid slot request/);
  assert.throws(() => gate.createSlots(0), /invalid slot count/);
});
