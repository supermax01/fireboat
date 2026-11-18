// Mutation-gate scopes: fast unit tests over the scope function, the scoped
// partition and the scoped aggregate in scripts/mutation-guards.mjs. Synthetic
// mutant lists and stubbed verdicts only; no mutant is judged here. Nothing
// here needs git or spawns the gate: the unit suite also runs inside the
// gate's own worker copies, which have no repository.
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import test from 'node:test';

type Edit = { file: string; find: string; replace: string };
type Mutant = Edit & { id: string; edits?: Edit[] };
type Verdict = 'killed' | 'survived' | 'inconclusive' | 'anchor-error';
type Binding = { commit: string; tree: string; inputsSha256: string; survivorsSha256: string; nodeVersion: string; platform: string; arch: string; runId: string | null; runAttempt: string | null };
type JudgeResult = { id: string; status: Verdict; anchorMatches: number; failingTests: string[]; kill_kind?: string | null; detail: string };
type ShardReportResult = { id: string; verdict: Verdict; failingTests: string[]; anchorHash: string | null; anchorMatches: number; suites: string[]; reproducedTimeout: boolean; kill_kind: string | null; decided_by: string; detail: string };
type ShardReport = {
  schema: string; shardId: string; shardIndex: number; shardCount: number; scope?: string;
  mutantListHash: string; mutantCount: number; mutantIds: string[]; scheduledIds: string[]; binding: Binding; mode: string; baseline: string;
  results: ShardReportResult[];
};
type AggregateOutcome = {
  ok: boolean; errors: string[]; timeoutKills: string[]; scope: string | null; inScope: number; registered: number;
  inScopeDeclared: number; outOfScopeSurvivors: string[]; refused: boolean;
  summary: { killed: number; survived: number; inconclusive: number; anchorErrors: number; declaredSurvivors: number; total: number };
  decisions: Record<string, number>;
};
type AggregateOptions = {
  mutants: Mutant[]; declared: Map<string, { justification: string }>; binding: Binding;
  expectedShardCount?: number; expectedScope?: string;
};
type RunSelection = {
  scope: string; registry: Mutant[]; inScope: Mutant[]; selected: Mutant[]; reportSpec: { shardIndex: number; shardCount: number };
  selectionLine: string | undefined; label: string; mode: string; reportFileName: string;
};
type GateModule = {
  MUTANTS: Mutant[];
  MUTATION_SCOPES: readonly string[];
  GATEWAY_PATH_PREFIXES: readonly string[];
  parseMutationScope: (name: unknown) => string;
  inMutationScope: (mutant: Mutant, scope: unknown) => boolean;
  scopedMutants: (mutants: Mutant[], scope: unknown) => Mutant[];
  anchorHash: (mutant: Mutant) => string;
  mutantListHash: (mutants: Mutant[]) => string;
  mutationEdits: (mutant: Mutant) => Edit[];
  mutantListing: (mutants: Mutant[], scope?: unknown) => Record<string, unknown>;
  validateArgs: (argv: string[]) => Record<string, unknown>;
  selectRun: (mutants: Mutant[], options?: { scope?: string; shard?: { shardIndex: number; shardCount: number }; only?: Set<string> }) => RunSelection;
  selectionReport: (selection: RunSelection, input: { binding: Binding; baseline: string; results: JudgeResult[]; durationMs: number }) => ShardReport;
  runSummaryLines: (selection: RunSelection, input: { results: (JudgeResult & { decidedBy: string })[]; declared: Map<string, { justification: string }>; seconds: string }) => { summary: string[]; ok: string };
  shardReportFileName: (shardIndex: number, shardCount: number, scope?: string) => string;
  partitionMutants: (mutants: Mutant[], shardCount: number) => Mutant[][];
  mutantsForShard: (mutants: Mutant[], shardIndex: number, shardCount: number) => Mutant[];
  timeoutKillSummary: (ids: string[], scope?: string) => string;
  buildShardReport: (input: {
    shardIndex: number; shardCount: number; mutants: Mutant[]; binding: Binding; baseline: string;
    results: JudgeResult[]; durationMs: number; mode?: string; scope?: string;
  }) => ShardReport;
  aggregateShardReports: (reports: unknown[], options: AggregateOptions) => AggregateOutcome;
  aggregateSummaryLines: (outcome: AggregateOutcome, input: { reportCount: number; seconds: string }) => { summary: string[]; ok: string | undefined };
};

const gate = (await import(new URL('../scripts/mutation-guards.mjs', import.meta.url).href)) as GateModule;

const BINDING: Binding = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), inputsSha256: 'c'.repeat(64), survivorsSha256: 'd'.repeat(64), nodeVersion: 'v24.22.0', platform: 'linux', arch: 'x64', runId: null, runAttempt: null };
const JUSTIFICATION = { justification: 'Synthetic justification, long enough for the length check.' };
const declaredFor = (ids: string[]) => new Map(ids.map(id => [id, JUSTIFICATION]));

const at = (id: string, file: string): Mutant => ({ id, file, find: `find-${id}`, replace: `replace-${id}` });
const combined = (id: string, files: string[]): Mutant => {
  const edits = files.map((file, index) => ({ file, find: `find-${id}-${index}`, replace: `replace-${id}-${index}` }));
  return { id, ...edits[0]!, edits };
};
const GATEWAY_FILES = ['packages/core/src/query.ts', 'packages/auth/src/pkce.ts', 'packages/server/src/cli.ts'];
const TOOLING_FILES = ['scripts/stage-package.ts', 'tests/isolation/evidence.ts', 'examples/quickstart/helper.ts', 'packages/evals/src/cli.ts'];

/** A synthetic registry interleaving gateway, tooling and combined mutants. */
function registry(): Mutant[] {
  const list: Mutant[] = [];
  for (let i = 0; i < 24; i++) {
    const files = i % 2 === 0 ? GATEWAY_FILES : TOOLING_FILES;
    list.push(at(`m-${String(i).padStart(2, '0')}`, files[i % files.length]!));
  }
  list.push(combined('m-combined-gateway', ['scripts/mutation-guards.mjs', 'packages/auth/src/token-store.ts']));
  list.push(combined('m-combined-tooling', ['scripts/stage-package.ts', 'tests/package/staging.test.ts']));
  return list;
}

/** Stubbed reports for a scope: every in-scope mutant killed except the named survivors. */
function scopedReports(all: Mutant[], scope: string, shardCount: number, survivors: string[] = []): ShardReport[] {
  const inScope = gate.scopedMutants(all, scope);
  return gate.partitionMutants(inScope, shardCount).map((shardMutants, index) => gate.buildShardReport({
    shardIndex: index + 1, shardCount, mutants: inScope, scope, baseline: 'green', binding: { ...BINDING }, durationMs: 1000,
    results: shardMutants.map(mutant => resultFor(mutant, survivors.includes(mutant.id) ? 'survived' : 'killed')),
  }));
}

function resultFor(mutant: Mutant, status: Verdict): JudgeResult {
  return {
    id: mutant.id, status, anchorMatches: 1,
    failingTests: status === 'killed' ? ['stub killing test'] : [],
    kill_kind: status === 'killed' ? 'named' : null,
    detail: status === 'killed' ? 'reproduced failure: stub killing test' : 'tests and both eval eras passed',
  };
}

const aggregate = (reports: unknown[], options: Partial<AggregateOptions> = {}) =>
  gate.aggregateShardReports(reports, { mutants: registry(), binding: BINDING, declared: declaredFor([]), ...options });
/** An aggregate that asks for scope gateway, as --aggregate <dir> --scope gateway does. */
const aggregateGateway = (reports: unknown[], options: Partial<AggregateOptions> = {}) => aggregate(reports, { expectedScope: 'gateway', ...options });

test('scope function: gateway files are in, tooling files are out, a combined mutant with one gateway edit is in', () => {
  assert.deepEqual([...gate.MUTATION_SCOPES], ['all', 'gateway']);
  assert.deepEqual([...gate.GATEWAY_PATH_PREFIXES], ['packages/core/', 'packages/auth/', 'packages/server/']);
  for (const file of GATEWAY_FILES) assert.equal(gate.inMutationScope(at('probe', file), 'gateway'), true, file);
  for (const file of [...TOOLING_FILES, 'packages/core-extra/src/x.ts', 'packages/serverless/x.ts', 'tests/packages/core/x.ts', 'docs/contracts/m3b-tools.json']) {
    assert.equal(gate.inMutationScope(at('probe', file), 'gateway'), false, file);
  }
  assert.equal(gate.inMutationScope(combined('probe', ['scripts/stage-package.ts', 'packages/server/src/main.ts']), 'gateway'), true);
  assert.equal(gate.inMutationScope(combined('probe', ['packages/core/src/store.ts', 'tests/store.test.ts']), 'gateway'), true);
  assert.equal(gate.inMutationScope(combined('probe', ['scripts/stage-package.ts', 'tests/package/staging.test.ts']), 'gateway'), false);
  for (const file of [...GATEWAY_FILES, ...TOOLING_FILES]) assert.equal(gate.inMutationScope(at('probe', file), 'all'), true, file);
  // The decision uses the validated edit list, so a malformed entry is refused rather than classified.
  assert.throws(() => gate.inMutationScope({ id: 'bad', file: '', find: 'x', replace: 'y' }, 'gateway'), /invalid edits/);
});

test('scope function: unknown scope names are refused', () => {
  for (const name of ['', 'Gateway', 'GATEWAY', 'core', 'full', 'gateway ', undefined, null, 1]) {
    assert.throws(() => gate.parseMutationScope(name), /unknown mutation scope/, String(name));
    assert.throws(() => gate.inMutationScope(at('probe', GATEWAY_FILES[0]!), name), /unknown mutation scope/, String(name));
    assert.throws(() => gate.scopedMutants(registry(), name), /unknown mutation scope/, String(name));
  }
  assert.equal(gate.parseMutationScope('gateway'), 'gateway');
  assert.equal(gate.parseMutationScope('all'), 'all');
});

test('scoped list: an ordered sublist of the registry; scope all is the registry itself', () => {
  const all = registry();
  const gateway = gate.scopedMutants(all, 'gateway');
  assert.deepEqual(gate.scopedMutants(all, 'all').map(m => m.id), all.map(m => m.id));
  const realAll = gate.scopedMutants(gate.MUTANTS, 'all');
  assert.equal(realAll.length, gate.MUTANTS.length);
  assert.ok(realAll.every((mutant, index) => mutant === gate.MUTANTS[index]), 'the real registry, entry for entry, in order');
  assert.equal(gate.mutantListHash(realAll), gate.mutantListHash(gate.MUTANTS));
  assert.deepEqual(gateway.map(m => m.id), all.filter(m => gate.inMutationScope(m, 'gateway')).map(m => m.id));
  assert.equal(gateway.length, 13);
  assert.ok(gateway.some(m => m.id === 'm-combined-gateway') && !gateway.some(m => m.id === 'm-combined-tooling'));
  assert.notEqual(gate.mutantListHash(gateway), gate.mutantListHash(all));

  const real = gate.scopedMutants(gate.MUTANTS, 'gateway');
  assert.ok(real.length > 0 && real.length < gate.MUTANTS.length, `${real.length} of ${gate.MUTANTS.length}`);
  let cursor = 0;
  for (const mutant of real) {
    cursor = gate.MUTANTS.indexOf(mutant, cursor) + 1;
    assert.ok(cursor > 0, `${mutant.id} keeps registry order`);
  }
});

test('shard partition in scope: every in-scope mutant exactly once, none out of scope, stable', () => {
  for (const all of [registry(), gate.MUTANTS]) {
    const inScope = gate.scopedMutants(all, 'gateway');
    const inScopeIds = inScope.map(m => m.id).sort();
    for (const shardCount of [1, 2, 3, 4, 13]) {
      const shards = Array.from({ length: shardCount }, (_, index) => gate.mutantsForShard(inScope, index + 1, shardCount));
      const ids = shards.flatMap(shard => shard.map(m => m.id));
      assert.equal(ids.length, inScope.length, `${shardCount} shards`);
      assert.deepEqual([...ids].sort(), inScopeIds);
      assert.ok(ids.every(id => gate.inMutationScope(all.find(m => m.id === id)!, 'gateway')));
      assert.deepEqual(shards.map(shard => shard.map(m => m.id)), gate.partitionMutants(gate.scopedMutants(all, 'gateway'), shardCount).map(shard => shard.map(m => m.id)));
      const sizes = shards.map(shard => shard.length);
      assert.ok(Math.min(...sizes) >= 1 && Math.max(...sizes) - Math.min(...sizes) <= 1, `sizes ${sizes.join('/')}`);
    }
  }
});

test('shard reports record their scope, the scoped list hash and the in-scope count', () => {
  const all = registry();
  const inScope = gate.scopedMutants(all, 'gateway');
  const [report] = scopedReports(all, 'gateway', 2);
  assert.equal(report!.scope, 'gateway');
  assert.equal(report!.mutantListHash, gate.mutantListHash(inScope));
  assert.equal(report!.mutantCount, inScope.length);
  assert.deepEqual(report!.mutantIds, inScope.map(m => m.id));
  assert.deepEqual(report!.scheduledIds, gate.mutantsForShard(inScope, 1, 2).map(m => m.id));
  assert.equal(scopedReports(all, 'all', 2)[0]!.scope, 'all');
  assert.throws(() => gate.buildShardReport({ shardIndex: 1, shardCount: 1, mutants: inScope, scope: 'core', baseline: 'green', binding: BINDING, durationMs: 0, results: [] }), /unknown mutation scope/);
});

test('aggregate in scope gateway: a complete set passes and every line names the scope', () => {
  const all = registry();
  const outcome = aggregateGateway(scopedReports(all, 'gateway', 3, ['m-04']), { declared: declaredFor(['m-04']), expectedShardCount: 3 });
  assert.equal(outcome.ok, true, outcome.errors.join('\n'));
  assert.equal(outcome.scope, 'gateway');
  assert.equal(outcome.inScope, 13);
  assert.equal(outcome.registered, all.length);
  assert.deepEqual(outcome.summary, { killed: 12, survived: 1, inconclusive: 0, anchorErrors: 0, declaredSurvivors: 1, total: 13 });
  const lines = gate.aggregateSummaryLines(outcome, { reportCount: 3, seconds: '7' });
  for (const line of [...lines.summary, lines.ok ?? '']) assert.match(line, /^mutation-guards aggregate \(scope gateway\)/, line);
  assert.deepEqual(lines.summary, [
    'mutation-guards aggregate (scope gateway) timeout-only kills: 0 []',
    'mutation-guards aggregate (scope gateway) decided by: targeted pass 0, full path 13, checks before tests 0',
    `mutation-guards aggregate (scope gateway): 12 killed, 1 survived, 0 inconclusive, 0 anchor-errors (declared survivors: 1 in scope of 1, mutants: 13/13 in scope, ${all.length} registered, shard reports: 3), 7s`,
    'mutation-guards aggregate (scope gateway): declared survivors outside the scope, not judged and so not checked for staleness: 0 []',
  ]);
  assert.equal(lines.ok, 'mutation-guards aggregate (scope gateway): OK (every mutant in scope ran exactly once; no undeclared survivors)');
  assert.ok(![...lines.summary, lines.ok].some(line => line.includes('every mutant ran exactly once')));

  // An unsharded gateway run's report (mode full, one shard) is a complete set too.
  const inScope = gate.scopedMutants(all, 'gateway');
  const single = gate.buildShardReport({ shardIndex: 1, shardCount: 1, mutants: inScope, scope: 'gateway', mode: 'full', baseline: 'green', binding: { ...BINDING }, durationMs: 1, results: inScope.map(m => resultFor(m, 'killed')) });
  const singleOutcome = aggregate([single], { expectedScope: 'gateway' });
  assert.equal(singleOutcome.ok, true, singleOutcome.errors.join('\n'));
});

test('aggregate refuses reports of different scopes, or a report without a scope among scoped ones', () => {
  const all = registry();
  const gatewayReports = scopedReports(all, 'gateway', 2);
  const fullReports = scopedReports(all, 'all', 2);
  for (const requested of [aggregateGateway, aggregate]) {
    const mixed = requested([gatewayReports[0], fullReports[1]]);
    assert.equal(mixed.ok, false);
    assert.ok(mixed.errors.some(error => error.includes('mutation scope disagrees across reports (all, gateway)')), mixed.errors.join('\n'));
  }

  const scopeless = structuredClone(gatewayReports);
  delete scopeless[1]!.scope;
  const outcome = aggregateGateway(scopeless);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some(error => error.includes('mutation scope disagrees') && error.includes('a report without a scope counts as scope all')), outcome.errors.join('\n'));
  // A refused aggregate prints one plain refusal line, never in-scope counts.
  assert.equal(outcome.refused, true);
  const lines = gate.aggregateSummaryLines(outcome, { reportCount: 2, seconds: '0' });
  assert.deepEqual(lines.summary, ['mutation-guards aggregate (scope gateway): refused before any result was judged (1 error above); no counts are reported']);
  assert.equal(lines.ok, undefined);

  for (const bad of ['core', null, 7]) {
    const unknown = structuredClone(gatewayReports);
    (unknown[0] as Record<string, unknown>).scope = bad;
    const refused = aggregateGateway(unknown);
    assert.equal(refused.ok, false);
    assert.ok(refused.errors.some(error => error.includes('unknown mutation scope in shard reports')), String(bad));
  }
});

test('aggregate without a requested scope is scope all, so a complete gateway set is refused', () => {
  const all = registry();
  const gatewayReports = scopedReports(all, 'gateway', 2);
  const base = { mutants: all, binding: BINDING, declared: declaredFor([]) };
  // No scope at all, and an explicitly undefined one (what the CLI passes without --scope).
  for (const absent of [gate.aggregateShardReports(gatewayReports, base), gate.aggregateShardReports(gatewayReports, { ...base, expectedScope: undefined })]) {
    assert.equal(absent.ok, false);
    assert.equal(absent.scope, 'all');
    assert.ok(absent.errors.includes("the reports' mutation scope gateway disagrees with the requested scope all (an aggregate without --scope is scope all)"), absent.errors.join('\n'));
    assert.equal(absent.refused, true);
    assert.deepEqual(gate.aggregateSummaryLines(absent, { reportCount: 2, seconds: '0' }).summary,
      ['mutation-guards aggregate: refused before any result was judged (1 error above); no counts are reported']);
  }
  assert.equal(gate.aggregateShardReports(gatewayReports, { ...base, expectedScope: 'gateway' }).ok, true);
  // The same holds the other way: a full set is refused when scope gateway is requested.
  const full = scopedReports(all, 'all', 2);
  assert.equal(gate.aggregateShardReports(full, base).ok, true);
  const wrong = aggregateGateway(full);
  assert.equal(wrong.ok, false);
  assert.ok(wrong.errors.includes("the reports' mutation scope all disagrees with the requested scope gateway"), wrong.errors.join('\n'));
  const legacy = structuredClone(full);
  for (const report of legacy) delete report.scope;
  assert.equal(aggregateGateway(legacy).ok, false);
  const unknown = aggregate(gatewayReports, { expectedScope: 'core' });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some(error => error.includes('unknown expected mutation scope')), unknown.errors.join('\n'));
  assert.deepEqual(gate.aggregateSummaryLines(unknown, { reportCount: 2, seconds: '0' }).summary,
    ['mutation-guards aggregate (scope unknown): refused before any result was judged (1 error above); no counts are reported']);
});

test('aggregate in scope gateway refuses a missing, duplicated or out-of-scope mutant', () => {
  const all = registry();
  const missing = scopedReports(all, 'gateway', 2);
  for (const report of missing) report.results = report.results.filter(result => result.id !== 'm-combined-gateway');
  const missingOutcome = aggregateGateway(missing);
  assert.equal(missingOutcome.ok, false);
  assert.ok(missingOutcome.errors.some(error => error === 'mutant m-combined-gateway: ran zero times (no shard reported it)'), missingOutcome.errors.join('\n'));

  const duplicate = scopedReports(all, 'gateway', 2);
  const repeated = duplicate[0]!.results[0]!;
  duplicate[1]!.results.push({ ...repeated });
  const duplicateOutcome = aggregateGateway(duplicate);
  assert.equal(duplicateOutcome.ok, false);
  assert.ok(duplicateOutcome.errors.some(error => error.includes(repeated.id) && error.includes('ran more than once')), duplicateOutcome.errors.join('\n'));

  // A tooling mutant judged inside a gateway report, with otherwise valid evidence.
  const outside = scopedReports(all, 'gateway', 2);
  const tooling = all.find(m => m.id === 'm-combined-tooling')!;
  const extra = gate.buildShardReport({ shardIndex: 1, shardCount: 1, mutants: [tooling], baseline: 'green', binding: BINDING, durationMs: 0, results: [resultFor(tooling, 'killed')] }).results[0]!;
  outside[0]!.results.push(extra);
  const outsideOutcome = aggregateGateway(outside);
  assert.equal(outsideOutcome.ok, false);
  assert.ok(outsideOutcome.errors.includes('mutant m-combined-tooling: outside scope gateway'), outsideOutcome.errors.join('\n'));
});

test('aggregate in scope gateway refuses a stale scoped list hash', () => {
  const all = registry();
  // A report carrying the full list's hash, count and ids cannot pass for a gateway report.
  const fullHash = scopedReports(all, 'gateway', 2);
  fullHash[0]!.mutantListHash = gate.mutantListHash(all);
  const fullHashOutcome = aggregateGateway(fullHash);
  assert.equal(fullHashOutcome.ok, false);
  assert.ok(fullHashOutcome.errors.some(error => error.includes('mutant list hash disagrees with the current mutant list in scope gateway')), fullHashOutcome.errors.join('\n'));
  const fullIds = scopedReports(all, 'gateway', 2);
  fullIds[0]!.mutantIds = all.map(m => m.id);
  fullIds[0]!.mutantCount = all.length;
  const fullIdsOutcome = aggregateGateway(fullIds);
  assert.equal(fullIdsOutcome.ok, false);
  assert.ok(fullIdsOutcome.errors.some(error => error.includes('scope gateway mutant ids/count disagree')), fullIdsOutcome.errors.join('\n'));

  // The registry gained an in-scope mutant after the reports were written.
  const reports = scopedReports(all, 'gateway', 2);
  const grown = [...all, at('m-new-core', 'packages/core/src/store.ts')];
  const grownOutcome = aggregateGateway(reports, { mutants: grown });
  assert.equal(grownOutcome.ok, false);
  assert.ok(grownOutcome.errors.some(error => error.includes('mutant list hash disagrees')), grownOutcome.errors.join('\n'));
  assert.ok(grownOutcome.errors.some(error => error.includes('m-new-core') && error.includes('ran zero times')), grownOutcome.errors.join('\n'));

  // An in-scope anchor changed after the reports were written.
  const changed = all.map(m => (m.id === 'm-00' ? { ...m, find: 'another anchor' } : m));
  const changedOutcome = aggregateGateway(scopedReports(all, 'gateway', 2), { mutants: changed });
  assert.equal(changedOutcome.ok, false);
  assert.ok(changedOutcome.errors.some(error => error.includes('mutant list hash disagrees')), changedOutcome.errors.join('\n'));
});

test('aggregate in scope gateway: an out-of-scope declared survivor is not judged, so it is not reported stale', () => {
  const all = registry();
  const declared = declaredFor(['m-01', 'm-combined-tooling', 'm-02']);
  const outcome = aggregateGateway(scopedReports(all, 'gateway', 2, ['m-02']), { declared });
  assert.equal(outcome.ok, true, outcome.errors.join('\n'));
  assert.deepEqual(outcome.outOfScopeSurvivors, ['m-01', 'm-combined-tooling']);
  assert.equal(outcome.inScopeDeclared, 1);
  assert.ok(!outcome.errors.some(error => error.includes('stale')));
  const lines = gate.aggregateSummaryLines(outcome, { reportCount: 2, seconds: '1' });
  assert.ok(lines.summary.includes('mutation-guards aggregate (scope gateway): declared survivors outside the scope, not judged and so not checked for staleness: 2 [m-01, m-combined-tooling]'), lines.summary.join('\n'));
  assert.ok(lines.summary.some(line => line.includes('(declared survivors: 1 in scope of 3,')), lines.summary.join('\n'));

  // The stale-survivor check still applies to every declared survivor in scope.
  const stale = aggregateGateway(scopedReports(all, 'gateway', 2), { declared });
  assert.equal(stale.ok, false);
  assert.ok(stale.errors.includes('FAIL m-02: declared survivor was killed; remove the stale entry'), stale.errors.join('\n'));
  // An undeclared survivor in scope fails, and a survivor entry naming no registered mutant still fails.
  const undeclared = aggregateGateway(scopedReports(all, 'gateway', 2, ['m-06']));
  assert.equal(undeclared.ok, false);
  assert.ok(undeclared.errors.includes('FAIL m-06: SURVIVED without a declared justification'), undeclared.errors.join('\n'));
  const unknownEntry = aggregateGateway(scopedReports(all, 'gateway', 2), { declared: declaredFor(['no-such-mutant']) });
  assert.equal(unknownEntry.ok, false);
  assert.ok(unknownEntry.errors.includes('FAIL survivor entry no-such-mutant: no such mutant'), unknownEntry.errors.join('\n'));

  // In scope all the same out-of-scope survivor is judged, and a kill makes it stale.
  const full = aggregate(scopedReports(all, 'all', 2, ['m-01', 'm-02']), { declared });
  assert.equal(full.ok, false);
  assert.ok(full.errors.includes('FAIL m-combined-tooling: declared survivor was killed; remove the stale entry'), full.errors.join('\n'));
  assert.deepEqual(full.outOfScopeSurvivors, []);
});

test('aggregate in scope all: lines keep their exact wording, with or without a recorded scope', () => {
  const all = registry();
  const expected = [
    'mutation-guards aggregate timeout-only kills: 0 []',
    `mutation-guards aggregate decided by: targeted pass 0, full path ${all.length}, checks before tests 0`,
    `mutation-guards aggregate: ${all.length - 1} killed, 1 survived, 0 inconclusive, 0 anchor-errors (declared survivors: 1, mutants: ${all.length}/${all.length}, shard reports: 2), 5s`,
  ];
  const ok = 'mutation-guards aggregate: OK (every mutant ran exactly once; no undeclared survivors)';
  const recorded = scopedReports(all, 'all', 2, ['m-03']);
  // Reports written before scopes existed carry no scope and count as scope all.
  const legacy = structuredClone(recorded);
  for (const report of legacy) delete report.scope;
  for (const reports of [recorded, legacy]) {
    const outcome = aggregate(reports, { declared: declaredFor(['m-03']) });
    assert.equal(outcome.ok, true, outcome.errors.join('\n'));
    assert.equal(outcome.scope, 'all');
    const lines = gate.aggregateSummaryLines(outcome, { reportCount: 2, seconds: '5' });
    assert.deepEqual(lines.summary, expected);
    assert.equal(lines.ok, ok);
  }
  assert.equal(gate.timeoutKillSummary(['a', 'b']), 'mutation-guards aggregate timeout-only kills: 2 [a, b]');
  assert.equal(gate.timeoutKillSummary(['a'], 'gateway'), 'mutation-guards aggregate (scope gateway) timeout-only kills: 1 [a]');
  // An empty directory has no scope to report and keeps the scope all wording.
  const empty = aggregate([]);
  assert.equal(empty.ok, false);
  assert.equal(gate.aggregateSummaryLines(empty, { reportCount: 0, seconds: '0' }).summary[2],
    `mutation-guards aggregate: 0 killed, 0 survived, 0 inconclusive, 0 anchor-errors (declared survivors: 0, mutants: 0/${all.length}, shard reports: 0), 0s`);
});

test('listing: the default listing is unchanged and the gateway scope lists the scoped count, hash and ids', () => {
  const listed = gate.mutantListing(gate.MUTANTS);
  assert.deepEqual(Object.keys(listed), ['count', 'mutantListHash', 'ids']);
  assert.equal(listed.count, gate.MUTANTS.length);
  assert.equal(listed.mutantListHash, gate.mutantListHash(gate.MUTANTS));
  assert.deepEqual(listed.ids, gate.MUTANTS.map(m => m.id));

  const gatewayListed = gate.mutantListing(gate.MUTANTS, 'gateway');
  const inScope = gate.MUTANTS.filter(m => gate.inMutationScope(m, 'gateway'));
  assert.deepEqual(Object.keys(gatewayListed), ['scope', 'count', 'registered', 'mutantListHash', 'ids']);
  assert.equal(gatewayListed.scope, 'gateway');
  assert.equal(gatewayListed.count, inScope.length);
  assert.equal(gatewayListed.registered, gate.MUTANTS.length);
  assert.equal(gatewayListed.mutantListHash, gate.mutantListHash(inScope));
  assert.notEqual(gatewayListed.mutantListHash, listed.mutantListHash);
  assert.deepEqual(gatewayListed.ids, inScope.map(m => m.id));

  assert.deepEqual(gate.mutantListing(gate.MUTANTS, 'all'), listed, '--scope all lists exactly what --list alone lists');
  assert.throws(() => gate.mutantListing(gate.MUTANTS, 'core'), /unknown mutation scope/);
});

test('arguments: --only with --scope, unknown scopes and --list with options other than --scope are refused', () => {
  for (const [argv, message] of [
    [['--only', 'scheme-screen', '--scope', 'gateway'], /--only cannot be combined with --scope/],
    [['--scope', 'gateway', '--only', 'scheme-screen'], /--only cannot be combined with --scope/],
    [['--only', 'scheme-screen', '--scope', 'all'], /--only cannot be combined with --scope/],
    [['--scope', 'core'], /unknown mutation scope "core"/],
    [['--list', '--scope', 'Gateway'], /unknown mutation scope "Gateway"/],
    [['--shard', '1/2', '--scope', 'full'], /unknown mutation scope "full"/],
    [['--aggregate', 'mutation-results/x', '--scope', 'tooling'], /unknown mutation scope "tooling"/],
    [['--scope'], /--scope requires a value/],
    [['--scope', 'gateway', '--scope', 'gateway'], /unknown or repeated option --scope/],
    [['--list', '--workers', '2'], /--list can only be combined with --scope/],
    [['--list', '--scope', 'gateway', '--shard', '1/2'], /--list can only be combined with --scope/],
    [['--aggregate', 'mutation-results/x', '--shard', '1/2', '--scope', 'gateway'], /--aggregate cannot be combined with --shard or --only/],
    [['--shard', '3/2', '--scope', 'gateway'], /invalid --shard spec/],
  ] as const) {
    assert.throws(() => gate.validateArgs([...argv]), message, argv.join(' '));
  }
  for (const argv of [
    ['--list', '--scope', 'gateway'], ['--list'], ['--scope', 'gateway'],
    ['--shard', '1/2', '--scope', 'gateway', '--out', 'mutation-results/x', '--hints', 'mutation-results/x'],
    ['--aggregate', 'mutation-results/x', '--shards', '2', '--scope', 'gateway'], ['--aggregate', 'mutation-results/x'],
    ['--only', 'a,b', '--hints', 'mutation-results/x'],
  ]) assert.doesNotThrow(() => gate.validateArgs(argv), argv.join(' '));
});

test('default shard report names: scope all keeps its names and any other scope is named in the file', () => {
  assert.equal(gate.shardReportFileName(1, 2), 'mutation-shard-1-of-2.json');
  assert.equal(gate.shardReportFileName(2, 2, 'all'), 'mutation-shard-2-of-2.json');
  assert.equal(gate.shardReportFileName(1, 2, 'gateway'), 'mutation-shard-gateway-1-of-2.json');
  assert.notEqual(gate.shardReportFileName(1, 2, 'gateway'), gate.shardReportFileName(1, 2));
  assert.throws(() => gate.shardReportFileName(1, 2, 'core'), /unknown mutation scope/);
});

test('edit paths: every registered edit names a normalized repository-relative file, and other spellings are refused', () => {
  for (const mutant of gate.MUTANTS) {
    for (const { file } of gate.mutationEdits(mutant)) {
      assert.ok(!file.includes('\\') && !file.startsWith('/') && posix.normalize(file) === file
        && file.split('/').every(part => part && part !== '.' && part !== '..'), `${mutant.id}: ${file}`);
    }
  }
  for (const file of ['packages\\core\\src\\query.ts', 'packages/core\\src/query.ts', 'packages//core/src/query.ts', './packages/core/src/query.ts',
    'packages/core/src/', '/packages/core/src/query.ts', 'packages/core/../core/src/query.ts']) {
    assert.throws(() => gate.mutationEdits(at('probe', file)), /invalid edits/, file);
    assert.throws(() => gate.inMutationScope(at('probe', file), 'gateway'), /invalid edits/, file);
  }
});

test('arguments: --scope all is the same as no --scope', () => {
  for (const argv of [['--list'], ['--shard', '1/2', '--out', 'mutation-results/x'], ['--aggregate', 'mutation-results/x', '--shards', '2'], []]) {
    assert.deepEqual(gate.validateArgs([...argv, '--scope', 'all']), gate.validateArgs(argv), argv.join(' '));
  }
  const options = gate.validateArgs(['--shard', '2/3', '--scope', 'gateway', '--hints', 'mutation-results/x', '--workers', '3']);
  assert.equal(options.scope, 'gateway');
  assert.deepEqual(options.shard, { shardIndex: 2, shardCount: 3 });
  assert.equal(options.hints, 'mutation-results/x');
  assert.equal(options.workers, 3);
  assert.equal(options.targeted, true);
  assert.deepEqual(gate.validateArgs(['--only', 'a,b,,a']).only, new Set(['a', 'b']));
});

test('run selection: a gateway shard judges its part of the in-scope list and reports the scoped list', () => {
  const all = registry();
  const inScope = gate.scopedMutants(all, 'gateway');
  const selections = [1, 2].map(shardIndex => gate.selectRun(all, { scope: 'gateway', shard: { shardIndex, shardCount: 2 } }));
  for (const [index, selection] of selections.entries()) {
    assert.deepEqual(selection.inScope.map(m => m.id), inScope.map(m => m.id));
    assert.deepEqual(selection.selected.map(m => m.id), gate.mutantsForShard(inScope, index + 1, 2).map(m => m.id));
    assert.equal(selection.mode, 'shard');
    assert.equal(selection.label, 'mutation-guards (scope gateway):');
    assert.equal(selection.reportFileName, `mutation-shard-gateway-${index + 1}-of-2.json`);
    assert.equal(selection.selectionLine, `mutation-guards: shard ${index + 1}/2 selects ${selection.selected.length} of 13 mutants in scope gateway (${all.length} registered)`);
  }
  // The reports main() writes from these selections aggregate as a complete gateway set.
  const reports = selections.map(selection => gate.selectionReport(selection, { binding: { ...BINDING }, baseline: 'green', durationMs: 1, results: selection.selected.map(m => resultFor(m, 'killed')) }));
  for (const report of reports) {
    assert.equal(report.scope, 'gateway');
    assert.equal(report.mutantListHash, gate.mutantListHash(inScope));
    assert.equal(report.mutantCount, inScope.length);
  }
  const outcome = aggregateGateway(reports, { expectedShardCount: 2 });
  assert.equal(outcome.ok, true, outcome.errors.join('\n'));
  assert.equal(aggregate(reports).ok, false, 'without --scope the same reports are refused');

  const single = gate.selectRun(all, { scope: 'gateway' });
  assert.deepEqual(single.selected.map(m => m.id), inScope.map(m => m.id));
  assert.equal(single.mode, 'full');
  assert.equal(single.selectionLine, `mutation-guards: scope gateway selects 13 of ${all.length} mutants`);
  const singleOutcome = aggregateGateway([gate.selectionReport(single, { binding: { ...BINDING }, baseline: 'green', durationMs: 1, results: single.selected.map(m => resultFor(m, 'killed')) })]);
  assert.equal(singleOutcome.ok, true, singleOutcome.errors.join('\n'));
});

test('run selection: shard counts are checked against the in-scope list, and scope all selects as before', () => {
  const all = registry();
  // 13 in scope, 26 registered: 14 gateway shards would leave one empty although the registry could fill it.
  assert.throws(() => gate.selectRun(all, { scope: 'gateway', shard: { shardIndex: 1, shardCount: 14 } }), /empty shards are not allowed/);
  assert.doesNotThrow(() => gate.selectRun(all, { scope: 'gateway', shard: { shardIndex: 13, shardCount: 13 } }));
  const full = gate.selectRun(all, { shard: { shardIndex: 1, shardCount: 14 } });
  assert.deepEqual(full.selected.map(m => m.id), gate.mutantsForShard(all, 1, 14).map(m => m.id));
  assert.equal(full.selectionLine, `mutation-guards: shard 1/14 selects ${full.selected.length} of ${all.length} mutants`);
  assert.equal(full.reportFileName, 'mutation-shard-1-of-14.json');
  assert.equal(full.label, 'mutation-guards:');
  assert.equal(gate.selectRun(all).selectionLine, undefined);
  assert.equal(gate.selectRun(all).mode, 'full');
  const only = gate.selectRun(all, { only: new Set(['m-01', 'm-00']) });
  assert.deepEqual(only.selected.map(m => m.id), ['m-00', 'm-01']);
  assert.equal(only.mode, 'diagnostic');
  assert.throws(() => gate.selectRun(all, { only: new Set(['m-00', 'no-such']) }), /--only contains an unknown mutant id/);
  assert.throws(() => gate.selectRun(all, { only: new Set(['no-such']) }), /no mutants selected/);
  // A narrower scope with nothing in it is refused; scope all of the same registry is not.
  const toolingOnly = all.filter(m => !gate.inMutationScope(m, 'gateway'));
  assert.throws(() => gate.selectRun(toolingOnly, { scope: 'gateway' }), /no registered mutant is in scope gateway/);
  assert.throws(() => gate.selectRun(toolingOnly, { scope: 'gateway', shard: { shardIndex: 1, shardCount: 2 } }), /no registered mutant is in scope gateway/);
  assert.equal(gate.selectRun(toolingOnly).selected.length, toolingOnly.length);
});

test('run summary lines: scope all keeps its wording and scope gateway names the scope on every line', () => {
  const all = registry();
  const judged = (selection: RunSelection) => selection.selected.map((m, index) => ({ ...resultFor(m, index === 0 ? 'survived' : 'killed'), decidedBy: index % 2 ? 'targeted' : 'full' }));
  const declared = declaredFor(['m-00', 'm-01']);
  const full = gate.selectRun(all);
  const fullLines = gate.runSummaryLines(full, { results: judged(full), declared, seconds: '9' });
  assert.deepEqual(fullLines.summary, [
    'mutation-guards: decided by: targeted pass 13, full path 13, checks before tests 0',
    'mutation-guards: 25 killed, 1 survived, 0 inconclusive (declared survivors: 2), 9s',
  ]);
  assert.equal(fullLines.ok, 'mutation-guards: OK (no undeclared survivors)');

  const shard = gate.selectRun(all, { scope: 'gateway', shard: { shardIndex: 1, shardCount: 2 } });
  const lines = gate.runSummaryLines(shard, { results: judged(shard), declared, seconds: '4' });
  assert.deepEqual(lines.summary, [
    'mutation-guards (scope gateway): decided by: targeted pass 3, full path 4, checks before tests 0',
    `mutation-guards (scope gateway): 6 killed, 1 survived, 0 inconclusive (declared survivors: 1 in scope of 2, mutants: 7 judged of 13 in scope, ${all.length} registered), 4s`,
    'mutation-guards (scope gateway): declared survivors outside the scope, not judged and so not checked for staleness: 1 [m-01]',
  ]);
  assert.equal(lines.ok, 'mutation-guards (scope gateway): OK (no undeclared survivors)');
});
