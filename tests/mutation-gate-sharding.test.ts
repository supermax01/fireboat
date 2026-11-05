// S0 mutation-gate sharding: fast unit tests over the pure partition and
// aggregate helpers in scripts/mutation-guards.mjs. Synthetic mutant lists
// and stubbed verdicts only; the real gate never runs here.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

type Mutant = { id: string; file: string; find: string; replace: string };
type Verdict = 'killed' | 'survived' | 'inconclusive' | 'anchor-error';
type Binding = { commit: string; tree: string; inputsSha256: string; survivorsSha256: string; nodeVersion: string; platform: string; arch: string; runId: string | null; runAttempt: string | null };
type JudgeResult = { id: string; status: Verdict; anchorMatches: number; failingTests: string[]; kill_kind?: string | null; detail: string };
type ShardReportResult = { id: string; verdict: Verdict; failingTests: string[]; anchorHash: string | null; anchorMatches: number; suites: string[]; reproducedTimeout: boolean; kill_kind: string | null; detail: string };
type ShardReport = {
  schema: string; shardId: string; shardIndex: number; shardCount: number;
  mutantListHash: string; mutantCount: number; mutantIds: string[]; scheduledIds: string[]; binding: Binding; mode: string; baseline: string; durationMs: number;
  results: ShardReportResult[];
};
type AggregateOutcome = {
  ok: boolean; errors: string[]; timeoutKills: string[];
  summary: { killed: number; survived: number; inconclusive: number; anchorErrors: number; declaredSurvivors: number; total: number };
};
type GateModule = {
  MUTANTS: Mutant[];
  SHARD_REPORT_SCHEMA: string;
  timeoutKillSummary: (ids: string[]) => string;
  anchorHash: (mutant: Mutant) => string;
  mutantListHash: (mutants: Mutant[]) => string;
  parseShardSpec: (spec: string) => { shardIndex: number; shardCount: number };
  shardForIndex: (index: number, shardCount: number) => number;
  candidateBinding: (checkout: string) => Promise<Binding>;
  partitionMutants: (mutants: Mutant[], shardCount: number) => Mutant[][];
  mutantsForShard: (mutants: Mutant[], shardIndex: number, shardCount: number) => Mutant[];
  shardReportFileName: (shardIndex: number, shardCount: number) => string;
  validateReportPath: (path: string, checkout?: string) => string;
  buildShardReport: (input: {
    shardIndex: number; shardCount: number; mutants: Mutant[]; binding: Binding; baseline: string;
    results: JudgeResult[]; durationMs: number;
  }) => ShardReport;
  aggregateShardReports: (reports: unknown[], options: {
    mutants: Mutant[];
    declared: Map<string, { justification: string }> | { id: string; justification: string }[];
    expectedShardCount?: number; binding: Binding;
  }) => AggregateOutcome;
  readShardReports: (dir: string) => Promise<{ reports: ShardReport[]; errors: string[]; files: string[] }>;
};

const gate = (await import(new URL('../scripts/mutation-guards.mjs', import.meta.url).href)) as GateModule;

const BINDING: Binding = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), inputsSha256: 'c'.repeat(64), survivorsSha256: 'd'.repeat(64), nodeVersion: 'v24.22.0', platform: 'linux', arch: 'x64', runId: null, runAttempt: null };

const synth = (id: string): Mutant => ({ id, file: 'packages/core/src/example.ts', find: `find-${id}`, replace: `replace-${id}` });
const synthList = (count: number): Mutant[] => Array.from({ length: count }, (_, i) => synth(`mutant-${String(i).padStart(2, '0')}`));
const declaredFor = (ids: string[]) => new Map(ids.map(id => [id, { justification: 'Reviewed synthetic justification for this survivor.' }]));

/** Stubbed shard reports: every mutant killed except the named survivors; overrides patch single verdicts. */
function stubReports(mutants: Mutant[], shardCount: number, survivors: string[] = [], overrides: Record<string, Verdict> = {}): ShardReport[] {
  return gate.partitionMutants(mutants, shardCount).map((shardMutants, index) => gate.buildShardReport({
    shardIndex: index + 1,
    shardCount,
    mutants,
    baseline: 'green',
    binding: { ...BINDING },
    durationMs: 1000,
    results: shardMutants.map((mutant): JudgeResult => {
      const status = overrides[mutant.id] ?? (survivors.includes(mutant.id) ? 'survived' : 'killed');
      return {
        id: mutant.id,
        status,
        anchorMatches: 1,
        failingTests: status === 'killed' ? ['stub killing test'] : [],
        kill_kind: status === 'killed' ? 'named' : null,
        detail: status === 'killed' ? 'reproduced failure: stub killing test' : 'tests and both eval eras passed',
      };
    }),
  }));
}

test('partition: complete and exactly-once for synthetic and real lists', () => {
  for (const mutants of [synthList(1), synthList(7), synthList(23), gate.MUTANTS]) {
    for (const shardCount of [1, 2, 3, 4, 5, 8]) {
      const shards = gate.partitionMutants(mutants, shardCount);
      assert.equal(shards.length, shardCount);
      const ids = shards.flatMap(shard => shard.map(mutant => mutant.id));
      assert.equal(ids.length, mutants.length, `count for ${mutants.length} mutants / ${shardCount} shards`);
      assert.deepEqual([...ids].sort(), mutants.map(mutant => mutant.id).sort());
      // mutantsForShard agrees with partitionMutants shard by shard.
      shards.forEach((shardMutants, index) => {
        assert.deepEqual(gate.mutantsForShard(mutants, index + 1, shardCount).map(m => m.id), shardMutants.map(m => m.id));
      });
    }
  }
});

test('partition: exact frozen-list ordinals and deterministic assignment', () => {
  const mutants = synthList(31);
  const first = gate.partitionMutants(mutants, 4);
  assert.deepEqual(gate.partitionMutants(mutants, 4), first);
  for (const [index, mutant] of mutants.entries()) {
    assert.equal(gate.shardForIndex(index, 4), (index % 4) + 1);
    assert.ok(first[index % 4]!.includes(mutant));
  }
  assert.deepEqual(first.map(shard => shard.length), [8, 8, 8, 7]);
});

test('partition: real mutant list is unique and every shard is non-empty and balanced', () => {
  assert.equal(new Set(gate.MUTANTS.map(m => m.id)).size, gate.MUTANTS.length);
  // 14 is the CI matrix size; 4 keeps the original local split covered.
  for (const count of [4, 14]) {
    const sizes = gate.partitionMutants(gate.MUTANTS, count).map(shard => shard.length);
    assert.equal(sizes.reduce((sum, size) => sum + size, 0), gate.MUTANTS.length);
    assert.ok(Math.min(...sizes) >= 1 && Math.max(...sizes) - Math.min(...sizes) <= 1, `shard sizes ${sizes.join('/')}`);
  }
});

test('parseShardSpec and shardForIndex: valid specs accepted, invalid rejected', () => {
  assert.deepEqual(gate.parseShardSpec('1/4'), { shardIndex: 1, shardCount: 4 });
  assert.deepEqual(gate.parseShardSpec('4/4'), { shardIndex: 4, shardCount: 4 });
  for (const bad of ['', '0/4', '5/4', '1/0', 'a/b', '1-4', '1/4/2', '1.5/4', '1/99999999999999999', '1/1025', 'Infinity/4']) {
    assert.throws(() => gate.parseShardSpec(bad), /invalid --shard spec/, bad);
  }
  for (const index of [0, 1, 29]) {
    const shard = gate.shardForIndex(index, 4);
    assert.ok(Number.isInteger(shard) && shard >= 1 && shard <= 4);
    assert.equal(gate.shardForIndex(index, 1), 1);
  }
});

test('anchor and list hashes: stable and definition-sensitive', () => {
  const mutant = synth('hash-probe');
  assert.equal(gate.anchorHash(mutant), gate.anchorHash({ ...mutant }));
  assert.notEqual(gate.anchorHash(mutant), gate.anchorHash({ ...mutant, find: 'different-anchor' }));
  assert.notEqual(gate.anchorHash(mutant), gate.anchorHash({ ...mutant, replace: 'different-replacement' }));
  const list = synthList(5);
  assert.equal(gate.mutantListHash(list), gate.mutantListHash([...list]));
  assert.notEqual(gate.mutantListHash(list), gate.mutantListHash([...list, synth('extra')]));
});

test('aggregate: complete stubbed run passes with a declared survivor', () => {
  const mutants = synthList(17);
  const reports = stubReports(mutants, 3, ['mutant-03']);
  const outcome = gate.aggregateShardReports(reports, { mutants, binding: BINDING, declared: declaredFor(['mutant-03']), expectedShardCount: 3 });
  assert.equal(outcome.ok, true, outcome.errors.join('\n'));
  assert.deepEqual(outcome.summary, { killed: 16, survived: 1, inconclusive: 0, anchorErrors: 0, declaredSurvivors: 1, total: 17 });
});

test('aggregate: missing mutant (ran zero times) fails', () => {
  const mutants = synthList(11);
  const reports = stubReports(mutants, 2);
  const host = reports.find(report => report.results.some(result => result.id === 'mutant-04'))!;
  host.results = host.results.filter(result => result.id !== 'mutant-04');
  const outcome = gate.aggregateShardReports(reports, { mutants, binding: BINDING, declared: declaredFor([]) });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some(error => error.includes('mutant-04') && error.includes('ran zero times')), outcome.errors.join('\n'));
});

test('aggregate: duplicate mutant (ran more than once) fails', () => {
  const mutants = synthList(11);
  const reports = stubReports(mutants, 2);
  const duplicate = reports[0]!.results[0]!;
  reports[1]!.results.push({ ...duplicate });
  const outcome = gate.aggregateShardReports(reports, { mutants, binding: BINDING, declared: declaredFor([]) });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some(error => error.includes(duplicate.id) && error.includes('ran more than once')), outcome.errors.join('\n'));
});

test('aggregate: missing shard fails', () => {
  const mutants = synthList(13);
  const reports = stubReports(mutants, 3).slice(0, 2);
  const outcome = gate.aggregateShardReports(reports, { mutants, binding: BINDING, declared: declaredFor([]) });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some(error => error.includes('missing shard 3/3')), outcome.errors.join('\n'));
});

test('aggregate: stale survivor (declared but killed) fails', () => {
  const mutants = synthList(9);
  const reports = stubReports(mutants, 2); // everything killed, including the declared survivor
  const outcome = gate.aggregateShardReports(reports, { mutants, binding: BINDING, declared: declaredFor(['mutant-02']) });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some(error => error.includes('mutant-02') && error.includes('declared survivor was killed')), outcome.errors.join('\n'));
});

test('aggregate: undeclared survivor and inconclusive verdicts fail', () => {
  const mutants = synthList(9);
  const survivors = stubReports(mutants, 2, ['mutant-05']);
  const undeclared = gate.aggregateShardReports(survivors, { mutants, binding: BINDING, declared: declaredFor([]) });
  assert.equal(undeclared.ok, false);
  assert.ok(undeclared.errors.some(error => error.includes('mutant-05') && error.includes('SURVIVED without a declared justification')), undeclared.errors.join('\n'));

  const flaky = stubReports(mutants, 2, [], { 'mutant-06': 'inconclusive' });
  const inconclusive = gate.aggregateShardReports(flaky, { mutants, binding: BINDING, declared: declaredFor([]) });
  assert.equal(inconclusive.ok, false);
  assert.ok(inconclusive.errors.some(error => error.includes('mutant-06') && error.includes('INCONCLUSIVE')), inconclusive.errors.join('\n'));
});

test('aggregate: shard-count disagreement, red baseline, and stale anchor definitions fail', () => {
  const mutants = synthList(10);
  const mixed = stubReports(mutants, 2);
  const other = stubReports(mutants, 3)[2]!;
  const disagreed = gate.aggregateShardReports([...mixed, other], { mutants, binding: BINDING, declared: declaredFor([]) });
  assert.equal(disagreed.ok, false);
  assert.ok(disagreed.errors.some(error => error.includes('shard count disagrees')), disagreed.errors.join('\n'));

  const red = stubReports(mutants, 2);
  red[0]!.baseline = 'red';
  const redOutcome = gate.aggregateShardReports(red, { mutants, binding: BINDING, declared: declaredFor([]) });
  assert.equal(redOutcome.ok, false);
  assert.ok(redOutcome.errors.some(error => error.includes('baseline was not green')), redOutcome.errors.join('\n'));

  const stale = stubReports(mutants, 2);
  stale[0]!.results[0]!.anchorHash = '0'.repeat(64);
  const staleOutcome = gate.aggregateShardReports(stale, { mutants, binding: BINDING, declared: declaredFor([]) });
  assert.equal(staleOutcome.ok, false);
  assert.ok(staleOutcome.errors.some(error => error.includes('anchor hash disagrees')), staleOutcome.errors.join('\n'));
});

test('shard reports round-trip through JSON files; aggregate reads a directory', async () => {
  const mutants = synthList(15);
  const dir = await mkdtemp(join(tmpdir(), 'mutation-shards-test-'));
  try {
    const reports = stubReports(mutants, 4, ['mutant-07']);
    for (const report of reports) {
      await writeFile(join(dir, gate.shardReportFileName(report.shardIndex, report.shardCount)), `${JSON.stringify(report, null, 2)}\n`);
    }
    const loaded = await gate.readShardReports(dir);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.reports.length, 4);
    // Report shape: each result carries id, verdict, failing tests and anchor hash; each report its shard id.
    for (const report of loaded.reports) {
      assert.equal(report.schema, gate.SHARD_REPORT_SCHEMA);
      assert.equal(report.shardId, `${report.shardIndex}/${report.shardCount}`);
      for (const result of report.results) {
        assert.ok(result.id && result.verdict && Array.isArray(result.failingTests) && result.anchorHash);
      }
    }
    const outcome = gate.aggregateShardReports(loaded.reports, { mutants, binding: BINDING, declared: declaredFor(['mutant-07']), expectedShardCount: 4 });
    assert.equal(outcome.ok, true, outcome.errors.join('\n'));

    // Removing one file is a missing shard, never a silent pass.
    await rm(join(dir, gate.shardReportFileName(2, 4)));
    const partial = await gate.readShardReports(dir);
    const partialOutcome = gate.aggregateShardReports(partial.reports, { mutants, binding: BINDING, declared: declaredFor(['mutant-07']) });
    assert.equal(partialOutcome.ok, false);
    assert.ok(partialOutcome.errors.some(error => error.includes('missing shard 2/4')), partialOutcome.errors.join('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('aggregate: another candidate, runtime, survivor declaration or CI attempt cannot supply evidence', () => {
  const mutants = synthList(7);
  for (const key of Object.keys(BINDING) as (keyof Binding)[]) {
    const reports = stubReports(mutants, 2);
    (reports[0]!.binding as Record<string, unknown>)[key] = key === 'commit' || key === 'tree'
      ? 'f'.repeat(40) : key.endsWith('Sha256') ? 'f'.repeat(64) : 'another';
    const outcome = gate.aggregateShardReports(reports, { mutants, binding: BINDING, declared: declaredFor([]) });
    assert.equal(outcome.ok, false, key);
    assert.ok(outcome.errors.some(error => error.includes('binding disagrees')), key);
  }
});

test('aggregate: wrong assignments, diagnostic subsets, unperformed anchors and empty kills fail', () => {
  const mutants = synthList(8);
  const check = (mutate: (reports: ShardReport[]) => void) => {
    const reports = stubReports(mutants, 2);
    mutate(reports);
    const outcome = gate.aggregateShardReports(reports, { mutants, binding: BINDING, declared: declaredFor([]) });
    assert.equal(outcome.ok, false, JSON.stringify(reports));
  };
  // Preserve the complete union but exchange two results between shards.
  check(reports => {
    const first = reports[0]!.results[0]!;
    reports[0]!.results[0] = reports[1]!.results[0]!;
    reports[1]!.results[0] = first;
  });
  check(reports => { reports[0]!.mode = 'diagnostic'; });
  check(reports => { reports[0]!.scheduledIds.reverse(); });
  check(reports => { reports[0]!.mutantIds.reverse(); });
  check(reports => { reports[0]!.mutantCount--; });
  check(reports => { reports[0]!.shardId = 'other'; });
  check(reports => { reports[0]!.results[0]!.anchorMatches = 0; });
  check(reports => { reports[0]!.results[0]!.failingTests = []; });
  check(reports => { reports[0]!.results = []; });
  check(reports => { reports[0]!.shardCount = Number.MAX_SAFE_INTEGER; });
  check(reports => { reports.push(structuredClone(reports[0]!)); });
  const timeouts = stubReports(mutants, 2);
  timeouts[0]!.results[0]!.failingTests = [];
  timeouts[0]!.results[0]!.reproducedTimeout = true;
  timeouts[0]!.results[0]!.kill_kind = 'timeout';
  assert.equal(gate.aggregateShardReports(timeouts, { mutants, binding: BINDING, declared: declaredFor([]) }).ok, true);
});

test('candidate binding detects source and survivor changes while excluding output artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mutation-binding-test-'));
  const git = (...argv: string[]) => execFileSync('git', argv, { cwd: dir, stdio: 'pipe' });
  try {
    git('init', '--quiet');
    git('-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'synthetic binding fixture');
    await mkdir(join(dir, 'scripts'));
    await writeFile(join(dir, 'scripts/mutation-survivors.json'), '[]\n');
    await writeFile(join(dir, 'source.ts'), 'const value = 1;\n');
    const before = await gate.candidateBinding(dir);
    assert.match(before.commit, /^[a-f0-9]{40}$/);
    assert.match(before.inputsSha256, /^[a-f0-9]{64}$/);
    assert.equal(before.nodeVersion, process.version);
    await mkdir(join(dir, 'mutation-results'));
    await writeFile(join(dir, 'mutation-results/shard.json'), '{}');
    assert.deepEqual(await gate.candidateBinding(dir), before);
    await writeFile(join(dir, 'source.ts'), 'const value = 2;\n');
    const changed = await gate.candidateBinding(dir);
    assert.equal(changed.commit, before.commit);
    assert.equal(changed.tree, before.tree);
    assert.notEqual(changed.inputsSha256, before.inputsSha256);
    await writeFile(join(dir, 'scripts/mutation-survivors.json'), '[{}]\n');
    assert.notEqual((await gate.candidateBinding(dir)).survivorsSha256, changed.survivorsSha256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('candidate binding records tracked deletions distinctly from empty files and other paths', async () => {
  // All git fixture writes are confined to this temporary synthetic repository.
  const dir = await mkdtemp(join(tmpdir(), 'mutation-deleted-binding-test-'));
  const git = (...argv: string[]) => execFileSync('git', argv, { cwd: dir, stdio: 'pipe' });
  try {
    git('init', '--quiet');
    git('-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'synthetic deletion fixture');
    await mkdir(join(dir, 'scripts'));
    await writeFile(join(dir, 'scripts/mutation-survivors.json'), '[]\n');
    for (const file of ['retired-a.md', 'retired-b.md']) await writeFile(join(dir, file), '');
    git('add', '--', 'retired-a.md', 'retired-b.md');
    const empty = await gate.candidateBinding(dir);
    await rm(join(dir, 'retired-a.md'));
    const deletedA = await gate.candidateBinding(dir);
    assert.match(deletedA.inputsSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(deletedA.inputsSha256, empty.inputsSha256, 'deleted differs from present and empty');
    assert.equal(deletedA.commit, empty.commit); assert.equal(deletedA.tree, empty.tree);
    assert.deepEqual(await gate.candidateBinding(dir), deletedA, 'unchanged deletion binds deterministically');
    await writeFile(join(dir, 'retired-a.md'), ''); await rm(join(dir, 'retired-b.md'));
    const deletedB = await gate.candidateBinding(dir);
    assert.notEqual(deletedB.inputsSha256, deletedA.inputsSha256, 'the deleted path matters');
    await writeFile(join(dir, 'retired-b.md'), '');
    assert.deepEqual(await gate.candidateBinding(dir), empty, 'restoration restores the original digest');
    await rm(join(dir, 'retired-a.md')); await rm(join(dir, 'retired-b.md'));
    const bothDeleted = await gate.candidateBinding(dir);
    await writeFile(join(dir, 'retired-c.md'), ''); git('add', '--', 'retired-c.md'); await rm(join(dir, 'retired-c.md'));
    assert.notEqual((await gate.candidateBinding(dir)).inputsSha256, bothDeleted.inputsSha256, 'an additional deleted tracked name remains bound');
    await symlink('missing-target', join(dir, 'retired-a.md'));
    await assert.rejects(gate.candidateBinding(dir), { code: 'ENOENT' }, 'an existing unreadable input still fails closed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('custom reports cannot enter the candidate input set or invalidate following shards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mutation-report-path-test-'));
  const git = (...argv: string[]) => execFileSync('git', argv, { cwd: dir, stdio: 'pipe' });
  try {
    git('init', '--quiet');
    git('-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'synthetic output-path fixture');
    await mkdir(join(dir, 'scripts'));
    await writeFile(join(dir, 'scripts/mutation-survivors.json'), '[]\n');
    const before = await gate.candidateBinding(dir);
    for (const path of ['local-shard-1.json', 'reports/x.json', 'scripts/report.json', '']) {
      assert.throws(() => gate.validateReportPath(resolve(dir, path), dir), /in-checkout reports must use/, path);
    }
    for (const name of ['mutation-results', '.local', 'artifacts']) {
      await mkdir(join(dir, name));
      const output = join(dir, name, 'custom.json');
      assert.equal(gate.validateReportPath(output, dir), output);
      await writeFile(output, '{}');
      assert.deepEqual(await gate.candidateBinding(dir), before);
    }
    const external = join(tmpdir(), 'external-shard-report.json');
    assert.equal(gate.validateReportPath(external, dir), external);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI refuses missing, repeated, unknown and incompatible shard arguments before running a gate', () => {
  const script = new URL('../scripts/mutation-guards.mjs', import.meta.url);
  for (const argv of [
    ['--shard'], ['--report'], ['--aggregate'], ['--shards', '4'],
    ['--list', '--shard', '1/4'], ['--shard', '1/4', '--only', 'scheme-screen'],
    ['--shard', '1/4', '--shard', '2/4'], ['--unknown'],
    ['--out', 'x', '--report', 'y'], ['--workers', 'Infinity'],
  ]) {
    const result = spawnSync(process.execPath, [fileURLToPath(script), ...argv], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 2, `${argv.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, /mutation-guards:/);
    assert.doesNotMatch(result.stdout, /baseline green|judging|shard report written/);
  }
});

test('aggregate: timeout-only labels are required and their count and ids are surfaced', () => {
  const mutants = synthList(5), reports = stubReports(mutants, 2);
  const result = reports[0]!.results[0]!;
  result.failingTests = [];
  result.reproducedTimeout = true;
  result.kill_kind = 'timeout';
  const options = { mutants, binding: BINDING, declared: declaredFor([]) };
  const outcome = gate.aggregateShardReports(reports, options);
  assert.equal(outcome.ok, true, outcome.errors.join('\n'));
  assert.deepEqual(outcome.timeoutKills, [result.id]);
  assert.equal(gate.timeoutKillSummary(outcome.timeoutKills), `mutation-guards aggregate timeout-only kills: 1 [${result.id}]`);
  for (const bad of [null, 'named', 'other']) {
    result.kill_kind = bad;
    assert.ok(gate.aggregateShardReports(reports, options).errors.some(error => error.includes('kill_kind disagrees')));
  }
});

test('aggregate: suite mismatches and isolation evidence outside declared suites are rejected', () => {
  const mutants = synthList(3), options = { mutants, binding: BINDING, declared: declaredFor([]) };
  const mismatch = stubReports(mutants, 1);
  mismatch[0]!.results[0]!.suites = ['unit', 'isolation'];
  assert.ok(gate.aggregateShardReports(mismatch, options).errors.some(error => error.includes('suite declaration disagrees')));
  const outside = stubReports(mutants, 1);
  outside[0]!.results[0]!.failingTests = ['isolation:synthetic isolation target'];
  assert.ok(gate.aggregateShardReports(outside, options).errors.some(error => error.includes('isolation kill outside declared suites')));
});

test('aggregate: named evidence with repeated timeouts remains named and survivors have no kill kind', () => {
  const mutants = synthList(3), reports = stubReports(mutants, 1);
  const result = reports[0]!.results[0]!;
  result.reproducedTimeout = true;
  const options = { mutants, binding: BINDING, declared: declaredFor([]) };
  const named = gate.aggregateShardReports(reports, options);
  assert.equal(named.ok, true, named.errors.join('\n'));
  assert.deepEqual(named.timeoutKills, []);
  result.kill_kind = 'timeout';
  assert.ok(gate.aggregateShardReports(reports, options).errors.some(error => error.includes('kill_kind disagrees')));
  result.verdict = 'survived';
  result.failingTests = [];
  result.reproducedTimeout = false;
  for (const kind of ['named', 'timeout']) {
    result.kill_kind = kind;
    assert.ok(gate.aggregateShardReports(reports, { ...options, declared: declaredFor([result.id]) }).errors.some(error => error.includes('kill_kind disagrees')));
  }
});
