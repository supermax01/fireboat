import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, symlinkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { scan } from './scanners.js';
import { CaseReportSchema, parseEvidenceJSON, parseEvidence } from './evidence.js';
import { M3B_SCHEMA_VERSION } from '../../packages/core/src/contracts.js';
import { CHANNELS, CaseSchema, LEDGER, ManifestError, PRODUCTION_ANCHOR, checkSemantics, defaultContext, deriveBudgets, hash, loadManifest, matrixCompleteness, namedOracles, occurrences, parseCoverageMatrix, parseKillMatrix, parseLedger, parseManifest, readDesign, registryMutants, scenarioBodies, verifyLedgerDesign, type CoverageMatrix, type IsolationCase, type KillMatrix, type Manifest, type SemanticContext } from './case-schema.js';
import { AggregateError, PROHIBITED_PREDICATES, candidateInfo, computeGate, computeStanding, expectedPins, filesHash, gateProblems, harnessFiles, readKills, runBinding, runContext, sameBinding, verifyBudgetProvenance, verifyPins, type KillRecord, bindingDigest, casesDigest, type KillsFile, type RunBinding } from './report.js';
import { runCell, workFingerprint, validateAggregate, type CaseReport, type CellReport, type Counts } from './runner.js';
import { startBackend } from './backend.js';
import { cellDrivers, createDriver, captureDepth, type Driver } from './drivers.js';
import { B } from './canaries.js';
import { aggregateRun, type PrerequisitesFile } from './aggregate.js';
import { STALE_LOCK_MS, builtMatchesSource, ensureBuilt, lockIsStale, sourceStamp, distDigest } from './build.js';
import { caseTestOptions, selectedCases, selection, writeShardReport, type ShardReport } from './shard.js';

// B2-0 counting machinery: every rule a counted record must meet, each with its stable rejection code, plus the
// computed standing, gate, coverage, binding and pin checks. Only the budget, driver and watchdog tests execute cells.
const outerSkipBuild = process.env.B2_SKIP_BUILD === '1';
// Hermetic (review L7): the focused-debugging variables of a run never change these unit-level verdicts.
for (const key of ['B2_CORE_ONLY', 'B2_CASE_IDS', 'B2_QUALIFY', 'B2_SKIP_BUILD', 'B2_RUN_ID', 'B2_ATTEMPT_ID']) delete process.env[key];
// Lazy (review M9): a semantic-context defect fails the tests that need it by name, never this file's import.
let basePromise: Promise<SemanticContext> | undefined;
const getBase = () => (basePromise ??= defaultContext());
const manifest = parseManifest();
const rejects = (input: Manifest, code: string, ctx: SemanticContext) => {
  try { checkSemantics(input, ctx); } catch (e) { assert.ok(e instanceof ManifestError, `${code}: ${(e as Error).message}`); assert.equal(e.code, code, e.message); return; }
  assert.fail(`expected rejection ${code}`);
};
const clone = <T>(value: T): T => structuredClone(value);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const MEASURED = { tool_calls: 7, total_upstream_calls: 9, clinical_calls: 4, result_bytes: 12345, cell_ms: 2300 };
const ANCHOR = { file: 'packages/core/src/index.ts', find: 'SYNTHETIC-ANCHOR-TEXT-FOR-COUNTING-TESTS' };
const synthetic = (id: string, file = ANCHOR.file) => ({ id, suites: ['unit', 'isolation'], edits: [{ file, find: `const pairs = ${ANCHOR.find}; drop it`, replace: `// distinct synthetic edit ${id}` }] });
/** A synthetic context in which one case (B2-SEL-01) can be counted: one killing mutant whose find contains the production anchor. */
function countedContext(base: SemanticContext): SemanticContext {
  const killMatrix = clone(base.killMatrix);
  killMatrix.rows = [{ mutant_id: 'synthetic-confinement-dropped', intent: 'the appended trusted confinement pair is dropped before the search is sent', kills: [{ case_id: 'B2-SEL-01', oracle: 'output_structured:b2.sel-01.terminal' }], spares: [], executed_all_lane_kill: false }];
  const coverage = clone(base.coverage);
  coverage.cells[1]!.covered_by = ['B2-SEL-01'];
  return { ...base, killMatrix, coverage, mutants: [...base.mutants, synthetic('synthetic-confinement-dropped')],
    readSource: file => file === ANCHOR.file ? `prefix ${ANCHOR.find} suffix` : base.readSource(file) };
}
const VARIANTS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
/** Turns a manifest case into a valid counted record (B2-1 shape) with distinct authored fields. */
function makeCounted(c: IsolationCase, variant: string, critical: string[]) {
  c.counted = true; c.classification = 'B2'; delete c.mutant_intent;
  c.signature.discriminating_fault_intent = `variant ${variant}: the gateway forwards a caller-supplied foreign selector instead of refusing it before any clinical request`;
  c.signature.source_anchor = { ...ANCHOR };
  c.signature.state_transition = `pre-send refusal before any clinical request; variant ${variant}; retained follow-ups unchanged`;
  c.controls[0]!.near_twin_delta = `the same request with the bound patient A in place of the ${variant} foreign selector`;
  c.existing_evidence = [];
  c.critical_mutants = critical;
  c.budgets = { ...deriveBudgets(MEASURED), budget_source: { rule: 'exact-max/1', run_id: 'synthetic-run', report_sha256: 'a'.repeat(64), binding_sha256: 'b'.repeat(64), measured: MEASURED } };
}
function countedManifest(): Manifest {
  const m = clone(manifest);
  const c = m.cases.find(x => x.id === 'B2-SEL-01')!;
  makeCounted(c, 'primary', ['synthetic-confinement-dropped']);
  c.signature.discriminating_fault_intent = 'the gateway forwards a caller-supplied foreign patient selector instead of refusing it before any clinical request';
  c.signature.state_transition = 'pre-send refusal before any clinical request; retained follow-ups unchanged';
  c.controls[0]!.near_twin_delta = 'the same Observation search with the bound patient A instead of the foreign selector';
  return m;
}
const counted = (mutate: (c: IsolationCase, m: Manifest) => void = () => {}): Manifest => { const m = countedManifest(); mutate(m.cases.find(x => x.id === 'B2-SEL-01')!, m); return m; };
/** Several counted cases sharing one production anchor, with the given rows (mutant id → killed case ids and spares). */
function countedSet(base: SemanticContext, ids: string[], rows: { mutant: string; kills: string[]; spares?: string[] }[]): { m: Manifest; ctx: SemanticContext } {
  const m = clone(manifest);
  ids.forEach((id, i) => makeCounted(m.cases.find(x => x.id === id)!, VARIANTS[i]!, rows.filter(r => r.kills.includes(id)).map(r => r.mutant)));
  const killMatrix: KillMatrix = { ...clone(base.killMatrix), rows: rows.map(r => ({ mutant_id: r.mutant, intent: `synthetic ${r.mutant}`, kills: r.kills.map(id => ({ case_id: id, oracle: `output_structured:b2.${id.slice(3).toLowerCase()}.terminal` })), spares: r.spares ?? [], executed_all_lane_kill: false })) };
  const coverage = clone(base.coverage); coverage.cells[1]!.covered_by = [...ids];
  return { m, ctx: { ...base, killMatrix, coverage, mutants: [...base.mutants, ...rows.map(r => synthetic(r.mutant))], readSource: file => file === ANCHOR.file ? `prefix ${ANCHOR.find} suffix` : base.readSource(file) } };
}

test('the current manifest loads: 68 frozen records, 0 counted, ledger and matrices consistent', async () => {
  const full = await loadManifest();
  assert.equal(full.cases.length, 68); assert.equal(full.cases.filter(c => c.counted).length, 0);
  assert.equal(full.frozen_ids.length, 68); assert.deepEqual(full.aliases, []); assert.deepEqual(full.catalogue, []);
  const ledger = parseLedger();
  assert.deepEqual({ records: ledger.records.length, counted: ledger.counts.counted, non_counted: ledger.counts.non_counted, aliases: ledger.counts.aliases }, LEDGER);
  assert.equal(ledger.counts.first_slice, 61);
  const base = await getBase();
  assert.ok(checkSemantics(countedManifest(), countedContext(base)).cases.some(c => c.counted), 'the synthetic counted record is accepted');
});
test('count condition: classification, boundary, applicability, required controls and a present mutant_intent reject a counted record', async () => {
  const ctx = countedContext(await getBase());
  for (const classification of ['diagnostic', 'B3', 'S2', 'residual', 'robustness'] as const) rejects(counted(c => { c.classification = classification; }), 'count-condition', ctx);
  rejects(counted(c => { c.boundary = 'residual'; }), 'count-condition', ctx);
  for (const status of ['deferred', 'not_applicable'] as const) rejects(counted(c => { c.applicability.status = status; }), 'count-condition', ctx);
  rejects(counted(c => { (c.controls[0] as { required: boolean }).required = false; }), 'count-condition', ctx);
  assert.throws(() => parseManifest(counted(c => { (c.controls[0] as { required: boolean }).required = false; })), (e: ManifestError) => e.code === 'schema');
  rejects(counted(c => { c.mutant_intent = 'Bypass refuse conflicting caller patient'; }), 'count-condition', ctx);
});
test('templated fault intents are rejected after punctuation and spacing are normalized: decision, goal, Bypass <decision>, the case id, short text and a duplicate', async () => {
  const ctx = countedContext(await getBase());
  for (const value of ['Bypass refuse conflicting caller patient', 'refuse conflicting caller patient', 'substitute B for trusted A', 'refuse conflicting caller patient; substitute B for trusted A', 'SEL-01 is bypassed by dropping the appended trusted confinement pair', 'too short to discriminate',
    // review M4: the punctuation and spacing variants the exact-string comparison admitted
    'Bypass refuse conflicting caller patient.', 'Bypass: refuse conflicting caller patient', 'refuse conflicting caller patient: substitute B for trusted A', 'refuse conflicting caller patient, substitute B for trusted A', 'Bypass  the  refuse conflicting caller patient decision'])
    rejects(counted(c => { c.signature.discriminating_fault_intent = value; }), 'template-fault', ctx);
  // A duplicate intent on an otherwise independent counted pair (own rows, each other as spares), case and punctuation changed.
  const pair = countedSet(await getBase(), ['B2-SEL-01', 'B2-SEL-03'], [{ mutant: 'synthetic-only-01', kills: ['B2-SEL-01'], spares: ['B2-SEL-03'] }, { mutant: 'synthetic-only-03', kills: ['B2-SEL-03'], spares: ['B2-SEL-01'] }]);
  const first = pair.m.cases.find(x => x.id === 'B2-SEL-01')!.signature.discriminating_fault_intent;
  pair.m.cases.find(x => x.id === 'B2-SEL-03')!.signature.discriminating_fault_intent = `${first.toUpperCase()}!`;
  rejects(pair.m, 'template-fault', pair.ctx);
});
test('a counted record needs a one-match shipped-runtime anchor that a killing mutant edits in the same file', async () => {
  const ctx = countedContext(await getBase());
  rejects(counted(c => { c.signature.source_anchor = 'tests/isolation/scenarios.ts:128'; }), 'template-anchor', ctx);
  rejects(counted(c => { c.signature.source_anchor = { file: 'packages/core/src/../../secrets.ts', find: ANCHOR.find }; }), 'template-anchor', ctx);
  assert.throws(() => parseManifest(counted(c => { c.signature.source_anchor = { file: 'packages/core/src/../../secrets.ts', find: ANCHOR.find }; })), (e: ManifestError) => e.code === 'schema');
  // review M5: the eval harness, a test file and a fixture are never production anchors
  for (const file of ['packages/evals/src/fixture.ts', 'packages/core/src/x.test.ts', 'tests/isolation/fixture.ts']) {
    assert.throws(() => parseManifest(counted(c => { c.signature.source_anchor = { file, find: ANCHOR.find }; })), (e: ManifestError) => e.code === 'schema', file);
    rejects(counted(c => { c.signature.source_anchor = { file, find: ANCHOR.find }; }), 'template-anchor', ctx);
  }
  assert.ok(PRODUCTION_ANCHOR.test('packages/server/src/cli.ts') && PRODUCTION_ANCHOR.test('packages/auth/src/token-store.ts') && !PRODUCTION_ANCHOR.test('packages/evals/src/runner.ts'));
  rejects(counted(c => { c.signature.source_anchor = { file: 'packages/core/src/missing.ts', find: ANCHOR.find }; }), 'anchor-match', { ...ctx, readSource: file => { if (file === 'packages/core/src/missing.ts') throw new Error('ENOENT'); return ctx.readSource(file); } });
  rejects(counted(c => { c.signature.source_anchor = { file: ANCHOR.file, find: 'prefix-never-present-anywhere' }; }), 'anchor-match', ctx);
  rejects(counted(), 'anchor-match', { ...ctx, readSource: () => `${ANCHOR.find} twice ${ANCHOR.find}` });
  // review M5: overlapping occurrences are two matches, not one
  assert.equal(occurrences('abcabcabcabcabc', 'abcabcabcabc'), 2);
  rejects(counted(c => { c.signature.source_anchor = { file: ANCHOR.file, find: 'abcabcabcabc' }; }), 'anchor-match', { ...ctx, readSource: () => 'abcabcabcabcabc' });
  rejects(counted(c => { c.signature.source_anchor = { file: ANCHOR.file, find: 'suffix' }; }), 'anchor-fault', { ...ctx, readSource: () => `prefix ${ANCHOR.find} suffix` });
  // review M5: a killing mutant that edits another file does not touch the anchor
  rejects(counted(), 'anchor-fault', { ...ctx, mutants: ctx.mutants.map(m => m.id === 'synthetic-confinement-dropped' ? synthetic(m.id, 'packages/server/src/cli.ts') : m) });
});
test('budgets must carry measured provenance and equal exact-max/1 within the shipped limits', async () => {
  const ctx = countedContext(await getBase());
  rejects(counted(c => { c.budgets.budget_source = null; }), 'template-budget', ctx);
  rejects(counted(c => { c.budgets.max_tool_calls = 100; c.budgets.max_clinical_calls = 60; }), 'template-budget', ctx);
  rejects(counted(c => { c.budgets.max_result_bytes = 60001; }), 'template-budget', ctx);
  rejects(counted(c => { c.budgets.max_task_bytes = 1; }), 'task-bytes', ctx);
  assert.deepEqual(deriveBudgets(MEASURED), { max_tool_calls: 7, max_total_upstream_calls: 9, max_clinical_calls: 4, max_result_bytes: 12345, deadline_ms: 23000, max_task_bytes: null, budget_source: null });
  assert.equal(deriveBudgets({ ...MEASURED, cell_ms: 100 }).deadline_ms, 15000, 'deadline floor');
  assert.equal(deriveBudgets({ ...MEASURED, cell_ms: 60000 }).deadline_ms, 60000, 'deadline ceiling');
  assert.equal(deriveBudgets({ ...MEASURED, result_bytes: 99999 }).max_result_bytes, 60000, 'shipped byte limit');
});
test('templated near-twin deltas, transitions and string evidence are rejected on a counted record', async () => {
  const ctx = countedContext(await getBase());
  for (const delta of ['Remove only the attack feature: substitute B for trusted A', 'remove only the attack feature - substitute b for trusted a.']) rejects(counted(c => { c.controls[0]!.near_twin_delta = delta; }), 'template-twin', ctx);
  rejects(counted(c => { c.signature.state_transition = 'pre-send:control-then-attack-and-retained-followups'; }), 'template-transition', ctx);
  rejects(counted(c => { c.existing_evidence = ['tests/core.test.ts:78']; }), 'template-evidence', ctx);
});
test('kill matrix: counted records bind to the rows that kill them, and each needs a discriminating row', async () => {
  const base = await getBase(); const ctx = countedContext(base);
  rejects(counted(c => { c.critical_mutants = []; }), 'kill-ref', ctx);
  rejects(counted(c => { c.critical_mutants = ['synthetic-confinement-dropped', 'outbound-confinement-dropped']; }), 'kill-ref', ctx);
  rejects(counted(c => { c.critical_mutants = ['no-such-mutant']; }), 'kill-mutant', ctx);
  const withCtx = (patch: Partial<SemanticContext>): SemanticContext => ({ ...ctx, ...patch });
  rejects(counted(), 'kill-row-mutant', withCtx({ mutants: ctx.mutants.map(m => m.id === 'synthetic-confinement-dropped' ? { ...m, suites: ['unit'] } : m) }));
  rejects(counted(), 'kill-row-mutant', withCtx({ killMatrix: { ...ctx.killMatrix, excluded: [...ctx.killMatrix.excluded, 'synthetic-confinement-dropped'] } }));
  const sharedRows = clone(ctx.killMatrix.rows); sharedRows[0]!.kills.push({ case_id: 'B2-SEL-02', oracle: 'output_structured:b2.sel-02.terminal' });
  const sharedCells = clone(ctx.coverage.cells); sharedCells[1]!.covered_by.push('B2-SEL-02');
  const shared = withCtx({ killMatrix: { ...ctx.killMatrix, rows: sharedRows }, coverage: { ...ctx.coverage, cells: sharedCells } });
  const sibling = counted((_c, m) => { makeCounted(m.cases.find(x => x.id === 'B2-SEL-02')!, 'sibling', ['synthetic-confinement-dropped']); });
  rejects(sibling, 'kill-indistinct', shared);
  assert.ok(scenarioBodies(base.scenarioSource).get('B2-SEL-01') === scenarioBodies(base.scenarioSource).get('B2-SEL-02'), 'SEL-01 and SEL-02 share one scenario body');
  // review M3: six counted cases in different bodies, one common mutant, one anchor, no spares
  const six = ['B2-SEL-01', 'B2-SEL-03', 'B2-SEL-04', 'B2-SEL-06', 'B2-SEL-15', 'B2-SEL-19'];
  assert.equal(new Set(six.map(id => scenarioBodies(base.scenarioSource).get(id))).size, 6, 'six distinct bodies');
  const common = countedSet(base, six, [{ mutant: 'synthetic-common-linkage', kills: six }]);
  rejects(common.m, 'kill-indistinct', common.ctx);
  // distinct critical sets but no row that kills SEL-01 alone: still indistinct
  const nested = countedSet(base, ['B2-SEL-01', 'B2-SEL-03'], [{ mutant: 'synthetic-shared', kills: ['B2-SEL-01', 'B2-SEL-03'] }, { mutant: 'synthetic-only-03', kills: ['B2-SEL-03'], spares: ['B2-SEL-01'] }]);
  rejects(nested.m, 'kill-indistinct', nested.ctx);
  // anchor siblings must be spares of each discriminating row; with them listed the pair is independent
  const noSpares = countedSet(base, ['B2-SEL-01', 'B2-SEL-03'], [{ mutant: 'synthetic-only-01', kills: ['B2-SEL-01'] }, { mutant: 'synthetic-only-03', kills: ['B2-SEL-03'] }]);
  rejects(noSpares.m, 'kill-indistinct', noSpares.ctx);
  const independent = countedSet(base, ['B2-SEL-01', 'B2-SEL-03'], [{ mutant: 'synthetic-only-01', kills: ['B2-SEL-01'], spares: ['B2-SEL-03'] }, { mutant: 'synthetic-only-03', kills: ['B2-SEL-03'], spares: ['B2-SEL-01'] }]);
  assert.equal(checkSemantics(independent.m, independent.ctx).cases.filter(c => c.counted).length, 2);
});
test('kill matrix rows are validated at load whether or not a case is counted: mutants, case ids, oracles, duplicates and challenges', async () => {
  const base = await getBase();
  const withRows = (mutate: (k: KillMatrix) => void): SemanticContext => { const k = clone(base.killMatrix); mutate(k); return { ...base, killMatrix: k }; };
  const seeded = base.killMatrix.rows[0]!;
  rejects(clone(manifest), 'kill-row-duplicate', withRows(k => { k.rows.push(clone(seeded)); }));
  rejects(clone(manifest), 'kill-row-mutant', withRows(k => { k.rows.push({ ...clone(seeded), mutant_id: 'not-a-registered-mutant' }); }));
  rejects(clone(manifest), 'kill-row-mutant', withRows(k => { k.rows.push({ ...clone(seeded), mutant_id: 'render-cancel-guard' }); }));
  rejects(clone(manifest), 'kill-row-mutant', withRows(k => { k.excluded.push(seeded.mutant_id); }));
  rejects(clone(manifest), 'kill-row-case', withRows(k => { k.rows[0]!.kills[0]!.case_id = 'B2-ZZZ-99'; }));
  rejects(clone(manifest), 'kill-row-case', withRows(k => { k.rows[0]!.spares = [k.rows[0]!.kills[0]!.case_id]; }));
  rejects(clone(manifest), 'kill-row-case', withRows(k => { k.rows[0]!.spares = ['B2-ZZZ-98']; }));
  // review M4: oracles come from the registry, never from a source substring; harness and determinism never kill
  for (const oracle of ['harness:execution/capture completes', 'determinism:fresh-fixture double-run agrees', 'output_structured:no.such.predicate', 'request:const', 'output_structured:import', 'backend:await', 'control:check(']) rejects(clone(manifest), 'kill-row-oracle', withRows(k => { k.rows[0]!.kills[0]!.oracle = oracle; }));
  for (const challenges of [['scheme-screen'], ['b2m-not-registered'], [base.killMatrix.verifier_challenges[0]!, base.killMatrix.verifier_challenges[0]!], [seeded.mutant_id]]) rejects(clone(manifest), 'kill-challenge', withRows(k => { k.verifier_challenges = challenges; }));
  rejects(clone(manifest), 'kill-excluded', withRows(k => { k.excluded.push('never-registered-excluded'); }));
  const oracles = namedOracles(base);
  assert.ok(oracles.has('output_structured:b2.sel-01.terminal') && oracles.has('request:zero target traffic at live sinks') && oracles.has('backend:clinical mutation digest unchanged') && oracles.has('control:overblocking rejected by positive control'));
  assert.ok(![...oracles].some(o => o.startsWith('harness:') || o.startsWith('determinism:')));
});
test('ledger: counts, families, alias shape and targets, recycled ids, the design digest and inflated counts are rejected', async () => {
  const ledger = parseLedger();
  const fails = (mutate: (l: typeof ledger) => void, code: string) => { const l = clone(ledger); mutate(l); assert.throws(() => parseLedger(l), (e: ManifestError) => e.code === code, code); };
  fails(l => { l.counts.counted = 215; }, 'ledger-count');
  fails(l => { l.families.SEL = 32; }, 'ledger-count');
  fails(l => { l.records[1]!.id = l.records[0]!.id; }, 'id-recycled');
  // review M10: first_slice and aliases in the declared block, a deleted family key, swapped id/family, aliases in disguise
  fails(l => { l.counts.first_slice = 216; }, 'ledger-count');
  fails(l => { l.counts.aliases = 41; }, 'ledger-count');
  fails(l => { delete l.families.SEL; }, 'ledger-count');
  fails(l => { const r = l.records.find(x => x.id.startsWith('SEL-'))!; r.family = 'PTH'; }, 'ledger-family');
  fails(l => { l.records.find(x => x.class === 'counted')!.duplicate_of = 'SEL-01'; }, 'ledger-alias-shape');
  fails(l => { l.records.find(x => x.class === 'alias')!.duplicate_of = null; }, 'ledger-alias-shape');
  assert.ok(verifyLedgerDesign(ledger, readDesign()), 'the ledger was extracted from the committed design');
  assert.equal(verifyLedgerDesign(ledger, `${readDesign()}\n`), false);
  const ctx = await getBase();
  const withLedger = (mutate: (l: typeof ledger) => void): SemanticContext => { const l = clone(ledger); mutate(l); return { ...ctx, ledger: l }; };
  // SEL-17 is itself an alias (of SEL-16): an alias pointing at it must be refused as a chain even before a cycle forms.
  rejects(clone(manifest), 'alias-target', withLedger(l => { l.records.find(r => r.id === 'SEL-07')!.duplicate_of = 'SEL-17'; }));
  rejects(clone(manifest), 'alias-cycle', withLedger(l => { l.records.find(r => r.id === 'SEL-07')!.duplicate_of = 'SEL-17'; l.records.find(r => r.id === 'SEL-17')!.duplicate_of = 'SEL-07'; }));
  rejects(clone(manifest), 'alias-target', withLedger(l => { l.records.find(r => r.id === 'SEL-07')!.duplicate_of = 'SEL-99'; }));
  // review M10: an alias of a B3/robustness record is not a duplicate of a counted case
  const b3 = ledger.records.find(r => r.class === 'B3')!;
  rejects(clone(manifest), 'alias-target', withLedger(l => { l.records.find(r => r.class === 'alias')!.duplicate_of = b3.id; }));
  const withAlias = clone(manifest); withAlias.aliases.push({ id: 'B2-SEL-07', family: 'SEL', counted: false, duplicate_of: 'B2-SEL-01', classification: 'alias', boundary: 'decidable', cross_refs: ['CA-ISO-01'], review_rationale: 'synthetic', reviewer: 'test' });
  rejects(withAlias, 'alias-target', ctx);
  const recycledManifest = clone(manifest); recycledManifest.aliases.push({ id: 'B2-SEL-01', family: 'SEL', counted: false, duplicate_of: 'B2-SEL-06', classification: 'alias', boundary: 'decidable', cross_refs: ['CA-ISO-01'], review_rationale: 'synthetic', reviewer: 'test' });
  rejects(recycledManifest, 'id-recycled', ctx);
  rejects(clone(manifest), 'ledger-mismatch', withLedger(l => { const r = l.records.find(x => x.id === 'SEL-01')!; r.class = 'alias'; r.duplicate_of = 'SEL-02'; }));
  rejects(clone(manifest), 'ledger-mismatch', withLedger(l => { l.records.find(x => x.id === 'SEL-01')!.class = 'B3'; }));
  const frozen = clone(manifest); frozen.frozen_ids = frozen.frozen_ids.slice(1); rejects(frozen, 'frozen-set', ctx);
  const unknown = clone(manifest); unknown.cases[0]!.id = 'B2-SEL-99'; unknown.frozen_ids[0] = 'B2-SEL-99'; rejects(unknown, 'ledger-unknown', ctx);
});
test('loader structural rejections keep their codes: duplicate ids, missing capture, signature collision, unknown keys, contract drift', async () => {
  const base = await getBase();
  const duplicate = clone(manifest); duplicate.cases[1]!.id = duplicate.cases[0]!.id; rejects(duplicate, 'id-recycled', base);
  const missing = clone(manifest); delete (missing.cases[0]!.lanes[0]!.channel_capture as Partial<Record<string, unknown>>).state; assert.throws(() => parseManifest(missing), (e: ManifestError) => e.code === 'schema');
  // review L2: a copied signature is a signature collision, checked before the contract comparison it would also trip
  const collision = clone(manifest); collision.cases[1]!.signature = clone(collision.cases[0]!.signature); rejects(collision, 'signature-collision', base);
  assert.throws(() => parseManifest({ ...manifest, unknown: true }), (e: ManifestError) => e.code === 'schema');
  const inconsistent = clone(manifest); inconsistent.cases[0]!.expected_outcome_class = 'invented success'; rejects(inconsistent, 'contract', base);
  assert.ok(CaseSchema.safeParse(manifest.cases[0]).success);
});
test('coverage matrix: duplicate ids, repeated tuples, unknown axes, alias cover, missing subjects, N/A rules and the full cross product', async () => {
  const base = await getBase();
  const matrix = parseCoverageMatrix();
  const throwsCode = (input: unknown, code: string) => assert.throws(() => parseCoverageMatrix(input), (e: ManifestError) => e.code === code, code);
  const dup = clone(matrix); dup.cells[1]!.id = dup.cells[0]!.id; throwsCode(dup, 'matrix-duplicate-id');
  const repeated = clone(matrix); repeated.cells[1] = { ...clone(repeated.cells[0]!), id: 'MX-9999' }; throwsCode(repeated, 'matrix-repeated-cell');
  const era = clone(matrix) as unknown as Record<string, unknown>; era.era = ['modern']; assert.throws(() => parseCoverageMatrix(era));
  const axis = clone(matrix); axis.cells[0]!.requirement = 'CA-ISO-99'; throwsCode(axis, 'matrix-axis');
  const subjectMissing = clone(matrix); subjectMissing.cells = subjectMissing.cells.filter(c => c.subject !== 'patient:Claim'); throwsCode(subjectMissing, 'matrix-subject-missing');
  const na = clone(matrix) as unknown as { cells: Record<string, unknown>[] }; na.cells[0]!.applicability = { status: 'not_applicable', reason: 'x' }; assert.throws(() => parseCoverageMatrix(na));
  const aliasCells = clone(base.coverage.cells); aliasCells[0]!.covered_by = ['B2-SEL-07'];
  rejects(clone(manifest), 'matrix-cover', { ...base, coverage: { ...base.coverage, cells: aliasCells } });
  const orphan = countedContext(base); orphan.coverage = { ...orphan.coverage, cells: orphan.coverage.cells.map(c => ({ ...c, covered_by: c.covered_by.filter(id => id !== 'B2-SEL-01') })) };
  rejects(counted(), 'matrix-orphan', orphan);
  // review L9: the matrix crosses its axes; unlisted tuples are missing unless a reviewed rule marks them N/A
  const complete = matrixCompleteness(matrix);
  const product = matrix.axes.requirement.length * matrix.axes.tool.length * matrix.axes.subject.length * matrix.axes.interaction.length * matrix.axes.channel.length;
  assert.deepEqual({ tuples: complete.tuples, listed: complete.listed, ruled: complete.ruled, missing: complete.missing }, { tuples: product, listed: matrix.cells.length, ruled: 0, missing: product - matrix.cells.length });
  const rule = { id: 'NA-001', when: { tool: 'fhir_capabilities' as const, subject: 'patient:*', channel: 'output' }, reason: 'capabilities carry no patient-class subject', reviewer: 'counting-test' };
  const ruled: CoverageMatrix = parseCoverageMatrix({ ...clone(matrix), not_applicable_rules: [rule] });
  const after = matrixCompleteness(ruled);
  assert.equal(after.ruled, matrix.axes.requirement.length * matrix.axes.subject.filter(s => s.id.startsWith('patient:')).length * matrix.axes.interaction.length);
  assert.equal(after.missing, complete.missing - after.ruled);
  throwsCode({ ...clone(matrix), not_applicable_rules: [{ ...rule, when: {} }] }, 'matrix-rule');
  throwsCode({ ...clone(matrix), not_applicable_rules: [rule, rule] }, 'matrix-rule');
  throwsCode({ ...clone(matrix), not_applicable_rules: [{ ...rule, when: { tool: 'fhir_history', channel: 'output' } }] }, 'matrix-axis');
  throwsCode({ ...clone(matrix), not_applicable_rules: [{ ...rule, when: { tool: matrix.cells[0]!.tool, subject: matrix.cells[0]!.subject } }] }, 'matrix-rule-conflict');
});
const counts = (tools = 1): Counts => ({ tool_calls: tools, total_upstream_calls: 1, clinical: 1, metadata: 0, auth: 0, probe: 0, sink: 0, mutations: 0, max_call_bytes: 100, per_driver: [tools] });
const naOf = (lane: CellReport['lane']) => lane === 'core' ? ['raw_frame', 'stderr'] : ['audit', 'state'];
const cell = (lane: CellReport['lane'], run: number, verdict: CellReport['verdict'] = 'PASS', control = 'PASS'): CellReport => {
  const scanned = CHANNELS.filter(ch => !naOf(lane).includes(ch));
  return { lane, era: lane === 'core' ? 'core/public-serializer' : lane === 'sdk-modern' ? '2026-07-28' : '2025-11-25', run, verdict, channels_na: naOf(lane), channels_scanned: scanned, failures: [], control_result: control, stubs: (['deny-all', 'overblocking'] as const).map(kind => ({ verdict: 'PASS', kind, feature: 'synthetic', specificity: 'feature', blocked_calls: 1, rejected_by: 'authorized control succeeds' })), request_counts: {}, request_marker_observations: [], tool_calls: 1, retained_followups: 0,
    capture_hashes: Object.fromEntries(scanned.map(ch => [ch, 'a'.repeat(64)])), fingerprint: 'f'.repeat(64), arms: { control: counts(), attack: counts(), followups: counts() }, pre_stub: counts(), timing: { cell_ms: 1, control_ms: 1, attack_ms: 0, followups_ms: 0, checks_ms: 0, stubs_ms: 0 }, phase: 'done', stub_counts: {} };
};
const caseReport = (id: string, verdict: string = 'PASS'): CaseReport => ({ id, family: id.slice(3, 6), verdict, lanes: (['core', 'sdk-modern', 'sdk-legacy'] as const).flatMap(l => [cell(l, 1, verdict as CellReport['verdict']), cell(l, 2, verdict as CellReport['verdict'])]), cli: { verdict: verdict as CellReport['verdict'], source_lanes: ['sdk-modern', 'sdk-legacy'], channels_na: ['audit', 'state'], channels_scanned: CHANNELS.filter(ch => !['audit', 'state'].includes(ch)) }, critical_mutants: [] });
const DIGEST = 'e'.repeat(64);
const syntheticBinding = (runId = 'run-a', attemptId = 'attempt-a'): RunBinding => ({ run_id: runId, attempt_id: attemptId, inputs_sha256: DIGEST, commit: 'c'.repeat(40), tree: 'd'.repeat(40), build: { stamp: 'a'.repeat(64), output_sha256: 'b'.repeat(64), matches_sources: true, skipped: false }, pins: { verified: true, mismatches: [] }, env: { B2_CORE_ONLY: null, B2_CASE_IDS: null, B2_SKIP_BUILD: null, B2_QUALIFY: null }, dependencies: { lock_hash: DIGEST, installed_tree_hash: DIGEST, sdk_client_hash: DIGEST, sdk_server_hash: DIGEST }, manifest_sha256: DIGEST, node: process.version });
const qualifyingRun = () => runContext({ B2_QUALIFY: '1' }, { dirty: false, pinMismatches: [], installedPackageLane: true, shardsComplete: true });
test('run context: qualifying needs B2_QUALIFY, no selection (even an empty one), no lane filter, a fresh build, a clean tree, matching pins and the installed lane', () => {
  const dev = runContext({}, { dirty: false, pinMismatches: [], installedPackageLane: true, shardsComplete: true });
  assert.equal(dev.qualifying, false); assert.ok(dev.reasons_not_qualifying.includes('B2_QUALIFY not set'));
  assert.equal(qualifyingRun().qualifying, true);
  for (const env of [{ B2_QUALIFY: '1', B2_CASE_IDS: 'B2-SEL-01' }, { B2_QUALIFY: '1', B2_CASE_IDS: ',' }, { B2_QUALIFY: '1', B2_CASE_IDS: '' }, { B2_QUALIFY: '1', B2_CORE_ONLY: '1' }, { B2_QUALIFY: '1', B2_SKIP_BUILD: '1' }])
    assert.equal(runContext(env, { dirty: false, pinMismatches: [], installedPackageLane: true, shardsComplete: true }).qualifying, false, JSON.stringify(env));
  assert.ok(runContext({ B2_QUALIFY: '1', B2_SKIP_BUILD: '1' }, { dirty: false, pinMismatches: [], installedPackageLane: true }).reasons_not_qualifying.some(r => r.startsWith('B2_SKIP_BUILD')));
  assert.equal(runContext({ B2_QUALIFY: '1' }, { dirty: true, pinMismatches: [], installedPackageLane: true, shardsComplete: true }).qualifying, false, 'dirty tree');
  assert.equal(runContext({ B2_QUALIFY: '1' }, { dirty: false, pinMismatches: ['fixture'], installedPackageLane: true, shardsComplete: true }).qualifying, false, 'pin mismatch');
  assert.equal(runContext({ B2_QUALIFY: '1' }, { dirty: false, pinMismatches: [], installedPackageLane: false, shardsComplete: true }).qualifying, false, 'installed-package lane absent');
});
test('computeStanding: earned needs counted PASS in six covered cells, no known failure, proven budgets, a non-empty critical set and bound kills', () => {
  const qualifying = qualifyingRun(); const dev = runContext({}, { dirty: false, pinMismatches: [], installedPackageLane: true });
  const kill: KillRecord = { mutant_id: 'synthetic-confinement-dropped', case_id: 'B2-SEL-01', verdict: 'KILLED', inputs_sha256: DIGEST };
  const c = countedManifest().cases.find(x => x.id === 'B2-SEL-01')!;
  const standing = (report: CaseReport | undefined, run = qualifying, kills = [kill], digest: string | undefined = DIGEST, unproven?: Map<string, string>, x: typeof c = c) => computeStanding(x, report, run, kills, digest, unproven).standing;
  assert.equal(standing(caseReport(c.id)), 'earned');
  assert.equal(standing(caseReport(c.id), dev), 'counted_unqualified_run');
  assert.equal(standing(caseReport(c.id), qualifying, []), 'counted_missing_kill');
  assert.equal(standing(caseReport(c.id), qualifying, [{ ...kill, inputs_sha256: 'other' }]), 'counted_missing_kill', 'a kill on another candidate does not count');
  assert.equal(computeStanding(c, caseReport(c.id), qualifying, [kill], undefined).standing, 'counted_missing_kill', 'no candidate digest, no credited kill');
  assert.equal(standing(caseReport(c.id, 'FAIL')), 'counted_fail');
  assert.equal(standing(caseReport(c.id, 'INCONCLUSIVE')), 'counted_inconclusive');
  assert.equal(standing(caseReport(c.id, 'PENDING')), 'counted_pending');
  assert.equal(standing(caseReport(c.id), qualifying, [kill], DIGEST, undefined, { ...c, known_failure: { reason: 'r', tracking: 't', since_revision: 's' } }), 'stale_known_failure');
  assert.equal(computeStanding({ ...c, known_failure: { reason: 'r', tracking: 't', since_revision: 's' } }, caseReport(c.id, 'FAIL'), qualifying, [kill], DIGEST).standing, 'counted_known_failure');
  assert.equal(computeStanding({ ...c, counted: false }, caseReport(c.id), qualifying, [kill], DIGEST).standing, 'not_counted');
  assert.equal(computeStanding(c, undefined, qualifying, [kill], DIGEST).blocking, true, 'a counted case without a report blocks');
  // review M2: coverage and cells are never self-declared
  assert.equal(standing({ ...caseReport(c.id), lanes: [] }), 'counted_incomplete', 'a PASS report with no cells');
  assert.equal(standing({ ...caseReport(c.id), lanes: caseReport(c.id).lanes.slice(0, 2) }), 'counted_incomplete', 'core-only cells');
  assert.equal(standing({ ...caseReport(c.id), lanes: caseReport(c.id).lanes.map(l => ({ ...l, channels_na: [...CHANNELS], channels_scanned: [], capture_hashes: {} })) }), 'counted_incomplete', 'all channels self-declared N/A');
  assert.equal(standing({ ...caseReport(c.id), lanes: caseReport(c.id).lanes.map(l => ({ ...l, capture_hashes: {} })) }), 'counted_incomplete', 'scanned without capture hashes');
  assert.equal(standing({ ...caseReport(c.id), cli: { ...caseReport(c.id).cli, verdict: 'NOT_RUN' } }), 'counted_incomplete', 'no CLI view');
  assert.equal(computeStanding(c, { ...caseReport(c.id), lanes: [] }, qualifying, [kill], DIGEST).blocking, true, 'an incomplete counted case blocks');
  assert.equal(standing(caseReport(c.id), qualifying, [kill], DIGEST, undefined, { ...c, critical_mutants: [] }), 'counted_missing_kill', 'an empty critical set never earns');
  // review M6: unproven budget provenance
  assert.equal(standing(caseReport(c.id), qualifying, [kill], DIGEST, new Map([[c.id, 'report missing']])), 'counted_unproven_budget');
});
test('acceptance gate: every counted case must pass, and a prohibited failure in any cell of any case fails it, whatever its class', async () => {
  const base = await getBase(); void base;
  const qualifying = qualifyingRun(); const dev = runContext({}, { dirty: false, pinMismatches: [], installedPackageLane: true, shardsComplete: true });
  const kill: KillRecord = { mutant_id: 'synthetic-confinement-dropped', case_id: 'B2-SEL-01', verdict: 'KILLED', inputs_sha256: DIGEST };
  const ledger = parseLedger(); const coverage = parseCoverageMatrix();
  const reports = manifest.cases.map(x => caseReport(x.id));
  const development = computeGate(manifest, ledger, coverage, reports, dev, [], undefined);
  assert.equal(development.earned, 0); assert.equal(development.acceptance_gate.passed, false); assert.equal(development.diagnostic, true);
  assert.equal(development.counts.declared, 287); assert.equal(development.counts.manifested, 68); assert.equal(development.counts.first_slice.ids, 61); assert.equal(development.counts.passed, 68);
  assert.equal(development.b2_gate.required, 200);
  assert.equal(development.acceptance_gate.conjuncts.matrix_complete, false, 'unlisted tuples keep the matrix incomplete');
  assert.ok(development.matrix.missing_tuples > 0);
  const m = countedManifest();
  const gateQualifying = computeGate(m, ledger, coverage, reports, qualifying, [kill], DIGEST);
  assert.equal(gateQualifying.earned, 1); assert.equal(gateQualifying.acceptance_gate.conjuncts.earned_ge_200, false); assert.equal(gateQualifying.acceptance_gate.conjuncts.qualifying_run, true);
  assert.deepEqual(gateQualifying.acceptance_gate.blocking_cases, []); assert.equal(gateQualifying.acceptance_gate.conjuncts.no_blocking_counted_cases, true);
  assert.equal(gateQualifying.acceptance_gate.conjuncts.zero_prohibited_disclosure, true);
  const failing = computeGate(m, ledger, coverage, reports.map(r => r.id === 'B2-SEL-01' ? caseReport(r.id, 'FAIL') : r), qualifying, [kill], DIGEST);
  assert.deepEqual(failing.acceptance_gate.blocking_cases, ['B2-SEL-01']); assert.equal(failing.earned, 0);
  // review H1: the failing counted case is a gate conjunct, not only a list
  assert.equal(failing.acceptance_gate.conjuncts.no_blocking_counted_cases, false);
  assert.equal(computeGate(m, ledger, coverage, reports.map(r => r.id === 'B2-SEL-01' ? caseReport(r.id, 'INCONCLUSIVE') : r), qualifying, [kill], DIGEST).earned, 0);
  assert.equal(computeGate(m, ledger, coverage, reports, qualifying, [], DIGEST).standings.find(s => s.id === 'B2-SEL-01')!.standing, 'counted_missing_kill');
  assert.ok(gateQualifying.matrix.uncovered_applicable.length > 0, 'uncovered applicable cells stay visible');
  assert.equal(gateQualifying.acceptance_gate.conjuncts.matrix_cells_covered, false, 'uncovered applicable cells block the matrix conjunct');
  assert.equal(gateQualifying.acceptance_gate.conjuncts.ledger_complete, false, 'no alias or catalogue records yet');
  // review H1: a non-counted case failing a mutation, GET-only, sink or confinement oracle fails the gate too
  for (const [cls, predicates] of Object.entries(PROHIBITED_PREDICATES)) for (const predicate of predicates) {
    const leaking = reports.map(r => r.id !== 'B2-ERR-03' ? r : { ...caseReport(r.id, 'FAIL'), lanes: caseReport(r.id, 'FAIL').lanes.map(l => ({ ...l, failures: [{ channel: 'backend', predicate, expected: true, observed: false }] })) });
    const gate = computeGate(m, ledger, coverage, leaking, qualifying, [kill], DIGEST);
    assert.equal(gate.acceptance_gate.conjuncts.zero_prohibited_disclosure, false, `${cls}: ${predicate}`);
    assert.equal(gate.acceptance_gate.conjuncts.no_blocking_counted_cases, true, 'the leaking case is not counted');
    assert.ok(gate.acceptance_gate.prohibited_failures.some(f => f.startsWith('B2-ERR-03:') && f.endsWith(predicate)));
  }
  // review L1: with no candidate digest, kill records without one never satisfy the critical-mutants conjunct
  const undefinedDigest = computeGate(m, ledger, coverage, reports, qualifying, [{ mutant_id: 'synthetic-confinement-dropped', case_id: 'B2-SEL-01', verdict: 'KILLED' } as unknown as KillRecord], undefined);
  assert.equal(undefinedDigest.counts.mutants.valid_kills, 0); assert.equal(undefinedDigest.acceptance_gate.conjuncts.critical_mutants_validly_killed, false);
});
test('every prohibited predicate is a literal check predicate of the runner or the scenarios', async () => {
  const base = await getBase();
  for (const predicate of Object.values(PROHIBITED_PREDICATES).flat()) assert.ok(base.runnerSource.includes(`'${predicate}'`) || base.scenarioSource.includes(`'${predicate}'`), predicate);
});
test('aggregate problems name stale known failures, unproven budgets, prohibited failures and rejected kill evidence', () => {
  const m = clone(manifest); m.cases.find(c => c.id === 'B2-ERR-03')!.known_failure = { reason: 'tracked', tracking: 'T-1', since_revision: 'abc' };
  const gate = computeGate(m, parseLedger(), parseCoverageMatrix(), manifest.cases.map(c => caseReport(c.id)), runContext({}), [], undefined);
  const problems = gateProblems({ status: 'DIAGNOSTIC', pins: [], reports: manifest.cases.map(c => caseReport(c.id)), gate, killProblems: ['kills.json belongs to run other'], designVerified: false });
  assert.ok(problems.includes('stale known failure B2-ERR-03'), problems.join('; '));
  assert.ok(problems.includes('kills: kills.json belongs to run other'));
  assert.ok(problems.includes('ledger design digest differs from the design file'));
});
test('pins: every tampered manifest hash is reported; the pins are separator-safe and cover every harness and shard file', async () => {
  // D1: the live "committed pins match" check runs in the aggregator (readiness INCONCLUSIVE on drift), never here, so
  // a harness mutant is killed by its named test rather than by every pin assertion. These checks are state-independent.
  const mutants = await registryMutants(); const killMatrix = parseKillMatrix();
  const expected = expectedPins(mutants, killMatrix);
  const current = { ...clone(manifest), hashes: { ...expected } };
  assert.deepEqual(verifyPins(current, mutants, killMatrix), []);
  for (const key of Object.keys(expected) as (keyof Manifest['hashes'])[]) {
    const tampered = clone(current); tampered.hashes[key] = '0'.repeat(64);
    assert.deepEqual(verifyPins(tampered, mutants, killMatrix).map(m => m.key), [key]);
  }
  const unitOnlyAdded = [...mutants, { id: 'synthetic-unit-only', suites: ['unit'], edits: [] }];
  assert.deepEqual(verifyPins(current, unitOnlyAdded, killMatrix), [], 'a unit-only registration never forces a manifest refresh');
  const isolationAdded = [...mutants, { id: 'synthetic-isolation', suites: ['unit', 'isolation'], edits: [] }];
  assert.deepEqual(verifyPins(current, isolationAdded, killMatrix).map(m => m.key), ['mutants']);
  const machinery = mutants.filter(m => m.id.startsWith('b2m-')).map(m => m.id).sort();
  assert.deepEqual([...killMatrix.verifier_challenges].sort(), machinery, 'the verifier challenges are exactly the registered b2m mutants');
  assert.ok(mutants.filter(m => m.id.startsWith('b2m-')).every(m => m.suites.includes('isolation')));
  // review L5: moving bytes between files changes the digest; the prerequisites, counting and shard files are pinned
  assert.notEqual(filesHash([['a', 'xy'], ['b', 'z']]), filesHash([['a', 'x'], ['b', 'yz']]));
  const pinned = harnessFiles();
  for (const file of ['isolation.test.ts', 'counting.test.ts', 'oracles.test.ts', 'shard.ts', 'aggregate.ts', ...readdirSync(new URL('.', import.meta.url)).filter(f => /^cases-[a-z]{3}\.test\.ts$/.test(f))]) assert.ok(pinned.includes(file), file);
});
test('report inputs come from the installed packages, the repository and the declared schema constant', () => {
  const info = candidateInfo([M3B_SCHEMA_VERSION, M3B_SCHEMA_VERSION]);
  const installed = (name: string) => (JSON.parse(readFileSync(join(process.cwd(), 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version;
  assert.equal(info.sdk.client, installed('@modelcontextprotocol/client')); assert.equal(info.sdk.server, installed('@modelcontextprotocol/server'));
  assert.equal(info.schema.declared, M3B_SCHEMA_VERSION); assert.equal(info.schema.consistent, true);
  assert.equal(candidateInfo(['0.1']).schema.consistent, false);
  assert.match(info.manifest_sha256, /^[a-f0-9]{64}$/);
  // review L4: the lock, installed tree, SDK packages, OS and every isolation file are pinned in the report
  for (const key of ['lock_hash', 'installed_tree_hash', 'sdk_client_hash', 'sdk_server_hash', 'package_hash'] as const) assert.match(info[key], /^[a-f0-9]{64}$/, key);
  assert.ok(info.os_release.length > 0); assert.match(info.files['case-schema.ts']!, /^[a-f0-9]{64}$/); assert.match(info.files['cases-v1.json']!, /^[a-f0-9]{64}$/);
});
async function validKillsFixture(): Promise<KillsFile> {
  const matrix = parseKillMatrix(), mutants = await registryMutants();
  const frozen = matrix.rows.find(r => r.mutant_id === 'outbound-confinement-dropped')!, mutant = mutants.find(m => m.id === frozen.mutant_id)!;
  const ids = [...frozen.kills.map(k => k.case_id), ...frozen.spares];
  const baseline = ids.map(id => caseReport(id));
  const cases = baseline.map(c => {
    const k = frozen.kills.find(k => k.case_id === c.id); if (!k) return c;
    const [channel, predicate] = k.oracle.split(/:(.*)/s);
    const fail = caseReport(c.id, 'FAIL'); for (const cell of fail.lanes) cell.failures = [{ channel: channel!, predicate: predicate!, expected: true, observed: false }]; return fail;
  });
  return { schema_version: 'b2-kills/1', run_id: 'run-a', binding: syntheticBinding(), core_only: false, cells_per_case: 6, candidate: { inputs_sha256: DIGEST },
    rows: [{ mutant_id: frozen.mutant_id, intent: frozen.intent, designated: frozen.kills, spares: frozen.spares,
      anchor_matches: mutant.edits.map(e => ({ file: e.file, edit_sha256: hash(JSON.stringify([e.file, e.find, e.replace])), matches: 1 })), compiled: true, compile_exit: 0, build_output_sha256: DIGEST,
      baseline: { exit: 0, cases: baseline.map(c => CaseReportSchema.parse(c)) }, cases: cases.map(c => CaseReportSchema.parse(c)), verdict: 'KILLED', detail: 'synthetic complete execution fixture' }],
    kills: frozen.kills.map(k => ({ mutant_id: frozen.mutant_id, case_id: k.case_id, oracle: k.oracle, verdict: 'KILLED', inputs_sha256: DIGEST })) };
}
test('kill evidence is credited only from this run, a full six-cell run, and the same candidate digest as every record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'b2-kills-'));
  const fixture = await validKillsFixture(); const record = fixture.kills[0]!;
  const write = (patch: Record<string, unknown> = {}) => writeFileSync(join(dir, 'kills.json'), JSON.stringify({ ...fixture, ...patch }));
  const read = (digest: string | undefined = DIGEST) => readKills('run-a', digest, dir, { binding: fixture.binding });
  try {
    assert.deepEqual(await read(), { kills: [], problems: [] }, 'no file, no kills, no problem');
    write(); assert.deepEqual(await read(), { kills: fixture.kills, problems: [] });
    for (const [patch, label] of [[{ run_id: 'run-b' }, 'another run'], [{ core_only: true }, 'core only'], [{ cells_per_case: 2 }, 'two cells'], [{ candidate: { inputs_sha256: 'x'.repeat(64) } }, 'another candidate'], [{ kills: [{ ...record, inputs_sha256: 'x'.repeat(64) }] }, 'a record of another candidate'], [{ schema_version: 'b2-kills/0' }, 'old schema']] as const) {
      write(patch as Record<string, unknown>); const result = await read();
      assert.deepEqual(result.kills, [], label); assert.ok(result.problems.length > 0, label);
    }
    write(); assert.deepEqual((await readKills('run-a', undefined, dir, { binding: fixture.binding })).kills, [], 'no candidate digest');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('budget provenance names a real full run report with that digest whose per-cell maxima equal the declared measurements', () => {
  const c = countedManifest().cases.find(x => x.id === 'B2-SEL-01')!;
  const binding = syntheticBinding('prov-run');
  const measuredReport = (env: { B2_CORE_ONLY: boolean }, lanes = caseReport(c.id).lanes.map((l, i) => {
    const n = { ...l.pre_stub, tool_calls: i === 0 ? 7 : 3, total_upstream_calls: i === 1 ? 9 : 4, clinical: i === 2 ? 4 : 1, max_call_bytes: i === 3 ? 12345 : 10 };
    n.metadata = n.total_upstream_calls - n.clinical; n.per_driver = [n.tool_calls];
    return { ...l, tool_calls: n.tool_calls, pre_stub: n, timing: { ...l.timing, cell_ms: i === 4 ? 2300 : 5 } };
  })) => JSON.stringify({ schema_version: 'b2-isolation-report/3', status: 'DIAGNOSTIC', run_id: 'prov-run', binding, pins: { verified: true }, run: { run_id: 'prov-run', env: { ...env, B2_SKIP_BUILD: false, B2_CASE_IDS: [] } }, cases: [{ ...caseReport(c.id, lanes.every(l => l.verdict === 'PASS') ? 'PASS' : 'FAIL'), lanes }] });
  const text = measuredReport({ B2_CORE_ONLY: false });
  const at = (t: string, runId = 'prov-run') => ({ ...c, budgets: { ...c.budgets, budget_source: { ...c.budgets.budget_source!, run_id: runId, report_sha256: hash(t), binding_sha256: bindingDigest(binding) } } });
  const reader = (t: string) => (id: string) => id === 'prov-run' ? t : undefined;
  assert.deepEqual([...verifyBudgetProvenance([at(text)], reader(text))], []);
  assert.ok(verifyBudgetProvenance([at(text, 'never-ran')], reader(text)).get(c.id)?.includes('missing'));
  assert.ok(verifyBudgetProvenance([{ ...at(text), budgets: { ...at(text).budgets, budget_source: { ...at(text).budgets.budget_source!, report_sha256: 'f'.repeat(64) } } }], reader(text)).get(c.id)?.includes('digest'));
  const coreOnly = measuredReport({ B2_CORE_ONLY: true }); assert.ok(verifyBudgetProvenance([at(coreOnly)], reader(coreOnly)).get(c.id)?.includes('six-cell'));
  const failing = measuredReport({ B2_CORE_ONLY: false }, caseReport(c.id, 'FAIL').lanes); assert.ok(verifyBudgetProvenance([at(failing)], reader(failing)).get(c.id)?.includes('passing'));
  const drifted = measuredReport({ B2_CORE_ONLY: false }, caseReport(c.id).lanes); assert.ok(verifyBudgetProvenance([at(drifted)], reader(drifted)).get(c.id)?.includes('differs'));
  assert.deepEqual([...verifyBudgetProvenance(manifest.cases, () => undefined)], [], 'uncounted cases need no provenance');
});

// B2-0 §3: budgets are enforced on the pre-stub snapshot under named predicates; deadline_ms is a harness watchdog.
test('budget enforcement: the exact measured ceiling passes, one below fails under the named predicate, and stub replays never count', { timeout: 180000 }, async () => {
  const c = manifest.cases.find(x => x.id === 'B2-CLS-01')!;
  const measured = await runCell(c, 'core', 1);
  assert.equal(measured.verdict, 'PASS', JSON.stringify(measured.failures));
  assert.equal(measured.phase, 'done');
  assert.ok(measured.pre_stub.total_upstream_calls > 0 && measured.pre_stub.tool_calls > 0);
  const afterStubs = Object.entries(measured.request_counts).filter(([kind]) => kind !== 'sink').reduce((n, [, v]) => n + v, 0);
  assert.ok(measured.pre_stub.total_upstream_calls < afterStubs, `stub replays add requests after the pre-stub snapshot (${measured.pre_stub.total_upstream_calls} < ${afterStubs})`);
  assert.deepEqual(measured.arms.followups, measured.pre_stub);
  assert.ok(measured.timing.cell_ms > 0 && measured.timing.control_ms >= 0 && measured.timing.stubs_ms >= 0);
  const exact = { ...c, budgets: { ...c.budgets, max_tool_calls: measured.pre_stub.tool_calls, max_total_upstream_calls: measured.pre_stub.total_upstream_calls, max_clinical_calls: measured.pre_stub.clinical, max_result_bytes: Math.max(1, measured.pre_stub.max_call_bytes) } };
  const atCeiling = await runCell(exact, 'core', 1);
  assert.equal(atCeiling.verdict, 'PASS', JSON.stringify(atCeiling.failures));
  assert.equal(atCeiling.fingerprint, measured.fingerprint, 'timing and budgets never enter the fingerprint');
  const below = await runCell({ ...exact, budgets: { ...exact.budgets, max_total_upstream_calls: measured.pre_stub.total_upstream_calls - 1 } }, 'core', 1);
  assert.equal(below.verdict, 'FAIL');
  assert.ok(below.failures.some(f => f.predicate === 'b2.budget.max_total_upstream_calls'), JSON.stringify(below.failures));
  assert.equal(below.stubs.length, 2, 'stubs still run after a budget failure');
});
test('driver cleanup: a cell with a foreign gateway restores console and streams, clears its registry, and closing twice leaves a newer capture intact', { timeout: 180000 }, async () => {
  const functions = () => ({ console: { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug }, stdout: process.stdout.write, stderr: process.stderr.write });
  const before = functions();
  const backend = await startBackend();
  const drivers: Awaited<ReturnType<typeof createDriver>>[] = [];
  try {
    const c = manifest.cases.find(x => x.id === 'B2-CUR-04')!;
    const measured = await runCell(c, 'core', 1);
    assert.equal(measured.verdict, 'PASS', JSON.stringify(measured.failures));
    assert.deepEqual(functions(), before, 'the cell restores the original function objects');
    assert.equal(cellDrivers.current, undefined);
    const driver = await createDriver('core', backend.base); drivers.push(driver);
    await driver.close();
    assert.deepEqual(functions(), before, 'the first close restores the original function objects');
    const newer = await createDriver('core', backend.base); drivers.push(newer);
    const active = functions();
    await driver.close();
    assert.deepEqual(functions(), active, 'the second close does not restore over a newer driver');
    await newer.close();
    assert.deepEqual(functions(), before, 'all captures are unwound');
  } finally {
    try { for (const driver of drivers.toReversed()) await driver.close(); }
    finally {
      Object.assign(console, before.console); process.stdout.write = before.stdout; process.stderr.write = before.stderr;
      await backend.close();
    }
  }
});
test('a secondary gateway opened by the scenario counts against the case tool-call budget', { timeout: 180000 }, async () => {
  const c = manifest.cases.find(x => x.id === 'B2-CUR-04')!;
  const measured = await runCell(c, 'core', 1);
  assert.equal(measured.verdict, 'PASS', JSON.stringify(measured.failures));
  assert.equal(measured.pre_stub.per_driver.length, 2, 'primary and foreign gateway');
  assert.ok(measured.pre_stub.per_driver[1]! > 0);
  assert.equal(measured.pre_stub.tool_calls, measured.pre_stub.per_driver[0]! + measured.pre_stub.per_driver[1]!);
  const primaryOnly = await runCell({ ...c, budgets: { ...c.budgets, max_tool_calls: measured.pre_stub.per_driver[0]! } }, 'core', 1);
  assert.equal(primaryOnly.verdict, 'FAIL');
  assert.ok(primaryOnly.failures.some(f => f.predicate === 'b2.budget.max_tool_calls'), JSON.stringify(primaryOnly.failures));
});
test('watchdog: a held clinical request yields INCONCLUSIVE under the deadline predicate alone, and the returned report never changes', { timeout: 90000 }, async () => {
  const c = { ...manifest.cases.find(x => x.id === 'B2-CLS-01')!, budgets: { ...manifest.cases[0]!.budgets, deadline_ms: 2000 } };
  const result = await runCell(c, 'core', 1, { afterBackendStart: backend => { backend.holdNextClinical(); } });
  const atReturn = JSON.stringify(result);
  assert.equal(result.verdict, 'INCONCLUSIVE', JSON.stringify(result.failures));
  assert.deepEqual(result.failures.map(f => `${f.channel}:${f.predicate}`), ['harness:b2.watchdog.deadline'], 'the abandoned body adds nothing (review M1)');
  assert.equal(result.control_result, 'NOT_RUN');
  assert.deepEqual(result.stubs, []);
  assert.equal(result.phase, 'control');
  assert.ok(result.timing.cell_ms >= 2000);
  await sleep(3000);
  assert.equal(JSON.stringify(result), atReturn, 'no late write after return');
});
test('watchdog during a held stub replay stays INCONCLUSIVE: the abandoned replay cannot turn it into FAIL', { timeout: 120000 }, async () => {
  const base = manifest.cases.find(x => x.id === 'B2-CLS-01')!;
  const measured = await runCell(base, 'core', 1);
  assert.equal(measured.verdict, 'PASS');
  const preStubCalls = measured.pre_stub.per_driver[0]!;
  const c = { ...base, budgets: { ...base.budgets, deadline_ms: 2000 } };
  let held: { holdNextClinical(): unknown } | undefined;
  const result = await runCell(c, 'core', 1, {
    afterBackendStart: backend => { held = backend; },
    afterDriverStart: driver => { const call = driver.call.bind(driver); let n = 0; driver.call = async (name, args) => { if (n++ === preStubCalls) held!.holdNextClinical(); return call(name, args); }; },
  });
  const atReturn = JSON.stringify(result);
  assert.equal(result.phase, 'stubs');
  assert.equal(result.verdict, 'INCONCLUSIVE', JSON.stringify(result.failures));
  assert.deepEqual(result.failures.map(f => `${f.channel}:${f.predicate}`), ['harness:b2.watchdog.deadline']);
  await sleep(3000);
  assert.equal(JSON.stringify(result), atReturn);
});
test('watchdog with a captured disclosure: FAIL outranks INCONCLUSIVE', { timeout: 60000 }, async () => {
  const c = { ...manifest.cases.find(x => x.id === 'B2-CLS-01')!, budgets: { ...manifest.cases[0]!.budgets, deadline_ms: 2000 } };
  const result = await runCell(c, 'core', 1, { afterBackendStart: backend => { backend.holdNextClinical(); }, afterDriverStart: driver => { driver.operational.push(`planted ${B} before the hang`); } });
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.failures.some(f => f.predicate === 'forbidden marker absent'));
  assert.deepEqual(result.stubs, []);
});

// B2-0 §6: the family shards, the build stamp and the aggregator.
test('family shards: one static file per manifest family registers exactly that family; selection honours B2_CASE_IDS; a known failure runs as TODO', () => {
  const families = [...new Set(manifest.cases.map(c => c.family))].sort();
  const files = readdirSync(new URL('.', import.meta.url)).filter(f => /^cases-[a-z]{3}\.test\.ts$/.test(f)).sort();
  assert.deepEqual(files, families.map(f => `cases-${f.toLowerCase()}.test.ts`));
  for (const family of families) assert.match(readFileSync(new URL(`./cases-${family.toLowerCase()}.test.ts`, import.meta.url), 'utf8'), new RegExp(`registerFamily\\('${family}'\\)`));
  assert.equal(selectedCases(manifest).length, 68);
  assert.ok(selectedCases(manifest, 'SEL').length > 0 && selectedCases(manifest, 'SEL').every(c => c.family === 'SEL'));
  try {
    process.env.B2_CASE_IDS = 'B2-SEL-01,B2-ERR-03';
    assert.deepEqual(selectedCases(manifest).map(c => c.id).sort(), ['B2-ERR-03', 'B2-SEL-01']); assert.deepEqual(selectedCases(manifest, 'ERR').map(c => c.id), ['B2-ERR-03']);
    assert.deepEqual(selectedCases(manifest, 'ADM'), [], 'an unselected family selects nothing and writes no shard');
    process.env.B2_CASE_IDS = ',';
    assert.deepEqual(selection(), { raw: ',', ids: [] }); assert.equal(selectedCases(manifest).length, 0, 'a set but empty selection selects nothing');
  } finally { delete process.env.B2_CASE_IDS; }
  const c = manifest.cases[0]!;
  // review L6: six expiring cells, each its deadline plus close grace, settle and backend start/close, plus slack
  assert.deepEqual(caseTestOptions(c), { timeout: 6 * (c.budgets.deadline_ms + 15000) + 30000 });
  assert.deepEqual(caseTestOptions({ ...c, known_failure: { reason: 'tracked defect', tracking: 'T-1', since_revision: 'abc' } }), { timeout: 6 * (c.budgets.deadline_ms + 15000) + 30000, todo: 'tracked defect' });
});
test('aggregate: binds every shard and the prerequisites to this candidate, build, pins and environment, validates the selection and coverage, and refuses each defect with its code', { timeout: 300000 }, async () => {
  const runId = `counting-test-${process.pid}`;
  const dir = join('artifacts', 'b2', runId);
  process.env.B2_RUN_ID = runId; process.env.B2_ATTEMPT_ID = 'counting-attempt';
  rmSync(dir, { recursive: true, force: true });
  const refuses = (code: string) => assert.rejects(aggregateRun(runId, { compatibilityCopy: false }), (e: unknown) => e instanceof AggregateError && e.code === code, code);
  const checks = Object.fromEntries(['manifest_and_verifier', 'scanners', 'server_traffic', 'backend_liveness', 'operational_sinks', 'barrier_schedule'].map(k => [k, { verdict: 'PASS' }]));
  const families = [...new Set(manifest.cases.map(c => c.family))].sort();
  try {
    if (!outerSkipBuild) await ensureBuilt();
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'attempt.json'), JSON.stringify({ run_id: runId, attempt_id: process.env.B2_ATTEMPT_ID }));
    const b = await runBinding();
    const writePrerequisites = (patch: Partial<PrerequisitesFile> = {}, binding: RunBinding = b) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'prerequisites.json'), JSON.stringify({ schema_version: 'b2-prerequisites/1', run_id: runId, binding: { start: binding, end: binding }, checks, ...patch })); };
    const writeShards = (binding: RunBinding = b, only: string[] = families, reportsFor = (f: string) => manifest.cases.filter(c => c.family === f).map(c => caseReport(c.id))) => {
      for (const f of families) rmSync(join(dir, `shard-${f}.json`), { force: true });
      for (const f of only) writeShardReport(f, reportsFor(f), { start: binding, end: binding });
    };
    await refuses('prerequisites-missing');
    writePrerequisites(); writeShards();
    const { report, problems } = await aggregateRun(runId, { compatibilityCopy: false });
    assert.equal(report.cases.length, 68); assert.equal(report.shards.length, families.length); assert.equal(report.gate.earned, 0); assert.equal(report.run.qualifying, false);
    if (existsSync('.git')) assert.match(report.candidate.inputs.inputsSha256!, /^[a-f0-9]{64}$/); else assert.equal(report.candidate.inputs.inputsSha256, undefined, 'without a repository no kill can be credited');
    assert.equal(report.acceptance_gate.conjuncts.matrix_cells_covered, false); assert.equal(report.acceptance_gate.passed, false);
    assert.ok(existsSync(join(dir, 'report.json')));
    assert.deepEqual(problems.filter(p => p.startsWith('case ') || p.startsWith('blocking ') || p.startsWith('prohibited ')), []);
    const shard = JSON.parse(readFileSync(join(dir, 'shard-SEL.json'), 'utf8')) as ShardReport;
    const tamper = (value: unknown) => { const s = clone(value) as ShardReport; s.binding.end = { ...s.binding.end, cases_sha256: casesDigest(s.cases) }; writeFileSync(join(dir, 'shard-SEL.json'), JSON.stringify(s)); };
    rmSync(join(dir, 'shard-SEL.json')); await refuses('shard-set'); writeShards();
    tamper({ ...shard, manifest_sha256: b.manifest_sha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64) }); await refuses('shard-manifest'); writeShards();
    tamper({ ...shard, run_id: 'other-run' }); await refuses('shard-run'); writeShards();
    tamper({ ...shard, schema_version: 'b2-shard/1' }); await refuses('shard-shape'); writeShards();
    tamper({ ...shard, cases: [...shard.cases, shard.cases[0]] }); await refuses('duplicate-case'); writeShards();
    tamper({ ...shard, cases: [...shard.cases, caseReport('B2-ERR-03')] }); await refuses('shard-family'); writeShards();
    // review H2: a shard from another candidate, a stale build, another selection environment or drift during the run
    // D1: derive every tamper from the live binding, whose pins already differ in a harness-mutant copy.
    const differentInputs = { ...b, inputs_sha256: b.inputs_sha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64) };
    for (const start of [differentInputs,
      { ...b, build: { ...b.build, skipped: !b.build.skipped, stamp: `${b.build.stamp}-tampered` } },
      { ...b, env: { ...b.env, B2_CORE_ONLY: b.env.B2_CORE_ONLY === '1' ? null : '1' } },
      { ...b, pins: { verified: !b.pins.verified, mismatches: b.pins.mismatches.length ? [] : ['harness'] } },
    ]) {
      assert.equal(sameBinding(start, b), false, 'tampered shard start binding differs from the real binding');
      tamper({ ...shard, binding: { start, end: b } }); await refuses('shard-binding');
    }
    const end = { ...b, commit: b.commit === 'f'.repeat(40) ? 'e'.repeat(40) : 'f'.repeat(40) };
    assert.equal(sameBinding(end, b), false, 'tampered shard end binding differs from the real binding');
    tamper({ ...shard, binding: { start: b, end } }); await refuses('shard-binding'); writeShards();
    assert.equal(sameBinding(differentInputs, b), false, 'tampered prerequisites binding differs from the real binding');
    writePrerequisites({ binding: { start: b, end: differentInputs } }); await refuses('prerequisites-binding');
    writePrerequisites({ run_id: 'other-run' }); await refuses('prerequisites-run');
    writePrerequisites({ schema_version: 'b2-prerequisites/0' } as unknown as Partial<PrerequisitesFile>); await refuses('prerequisites-run'); writePrerequisites();
    // review M2/L10: self-declared coverage and a missing case are coded refusals
    const blind = caseReport('B2-SEL-01'); blind.lanes = blind.lanes.map(l => ({ ...l, channels_na: [...CHANNELS], channels_scanned: [], capture_hashes: {} }));
    tamper({ ...shard, cases: shard.cases.map(c => c.id === 'B2-SEL-01' ? blind : c) }); await refuses('cell-coverage'); writeShards();
    tamper({ ...shard, cases: shard.cases.slice(1) }); await refuses('case-set'); writeShards();
    tamper({ ...shard, cases: shard.cases.map((c, i) => i === 0 ? { ...c, lanes: c.lanes.slice(1) } : c) }); await refuses('cell-set'); writeShards();
    // review M8: an empty or unknown selection is refused; a real subset aggregates with exactly its families' shards
    process.env.B2_CASE_IDS = ','; await refuses('selection-empty');
    process.env.B2_CASE_IDS = ''; await refuses('selection-empty');
    process.env.B2_CASE_IDS = 'B2-ZZZ-99'; await refuses('selection-unknown');
    process.env.B2_CASE_IDS = 'B2-SEL-01,B2-ERR-03';
    const subsetBinding = await runBinding();
    writePrerequisites({}, subsetBinding);
    writeShards(subsetBinding, ['ERR', 'SEL'], f => manifest.cases.filter(c => c.family === f && ['B2-SEL-01', 'B2-ERR-03'].includes(c.id)).map(c => caseReport(c.id)));
    const subset = await aggregateRun(runId, { compatibilityCopy: false });
    assert.equal(subset.report.cases.length, 2); assert.equal(subset.report.run.qualifying, false);
    assert.ok(subset.report.run.reasons_not_qualifying.includes('B2_CASE_IDS selects cases'));
    writeShardReport('ADM', [], { start: subsetBinding, end: subsetBinding }); await refuses('shard-set');
  } finally { delete process.env.B2_RUN_ID; delete process.env.B2_ATTEMPT_ID; delete process.env.B2_CASE_IDS; rmSync(dir, { recursive: true, force: true }); }
});
test('validateAggregate refuses missing cases, missing cells, incomplete passing cells and self-declared coverage with codes', () => {
  const ids = ['B2-SEL-01']; const cases = manifest.cases.filter(c => ids.includes(c.id));
  const code = (fn: () => void, expected: string) => assert.throws(fn, (e: unknown) => e instanceof AggregateError && e.code === expected, expected);
  validateAggregate([caseReport('B2-SEL-01')], ids, cases);
  code(() => validateAggregate([], ids, cases), 'case-set');
  code(() => validateAggregate([{ ...caseReport('B2-SEL-01'), lanes: caseReport('B2-SEL-01').lanes.slice(1) }], ids, cases), 'cell-set');
  code(() => validateAggregate([{ ...caseReport('B2-SEL-01'), lanes: caseReport('B2-SEL-01').lanes.map(l => ({ ...l, control_result: 'FAIL' })) }], ids, cases), 'cell-incomplete');
  code(() => validateAggregate([{ ...caseReport('B2-SEL-01'), lanes: caseReport('B2-SEL-01').lanes.map(l => ({ ...l, channels_na: [...CHANNELS], channels_scanned: [] })) }], ids, cases), 'cell-coverage');
  code(() => validateAggregate([{ ...caseReport('B2-SEL-01'), lanes: caseReport('B2-SEL-01').lanes.map(l => ({ ...l, capture_hashes: {} })) }], ids, cases), 'cell-coverage');
});
test('build stamp: the source digest is deterministic, B2_SKIP_BUILD never builds, the stamp matches after ensureBuilt, and only an untouched lock is stale', { timeout: 300000 }, async () => {
  assert.equal(sourceStamp(), sourceStamp());
  process.env.B2_SKIP_BUILD = '1';
  try { assert.deepEqual(await ensureBuilt(), { built: false, stamp: 'skipped' }); }
  finally { delete process.env.B2_SKIP_BUILD; }
  if (outerSkipBuild) return; // N12: the outer skip-build run owns dist; this test must never rebuild it.
  const first = await ensureBuilt(); assert.equal(first.stamp, sourceStamp()); assert.ok(builtMatchesSource());
  assert.deepEqual(await ensureBuilt(), { built: false, stamp: first.stamp }, 'a fresh build is skipped');
  assert.equal(readFileSync(join('dist', '.b2-build-stamp'), 'utf8').trim(), first.stamp);
  const lockDir = mkdtempSync(join(tmpdir(), 'b2-lock-')); const lock = join(lockDir, 'held');
  try {
    assert.equal(lockIsStale(lock), false, 'a missing lock is not stale');
    mkdirSync(lock); assert.equal(lockIsStale(lock), false, 'a fresh lock is not stale');
    const old = new Date(Date.now() - STALE_LOCK_MS - 5000); utimesSync(lock, old, old); assert.equal(lockIsStale(lock), true);
  } finally { rmSync(lockDir, { recursive: true, force: true }); }
});

// Round 2 witnesses keep every unrelated condition valid: each rejected input would be admitted by its named weakening.
test('capture stack: closing a live older frame preserves the newer capture and original functions', async () => {
  const before = { log: console.log, stdout: process.stdout.write, stderr: process.stderr.write }; const originalDate = Date;
  const backend = await startBackend(); let older: Driver | undefined, newer: Driver | undefined;
  try {
    older = await createDriver('core', backend.base); newer = await createDriver('core', backend.base);
    const active = { log: console.log, stdout: process.stdout.write, stderr: process.stderr.write }; const ownedDate = Date;
    await older.close(); assert.equal(Date, ownedDate);
    const afterOlderClose = { log: console.log, stdout: process.stdout.write, stderr: process.stderr.write };
    console.log(B); process.stdout.write(B); process.stderr.write(B);
    assert.ok(scan('operational', newer.operational).length > 0, 'lost capture must not admit a clean marker scan');
    assert.deepEqual(afterOlderClose, active);
    assert.equal(newer.operational.filter(s => s.includes(B)).length, 3);
    await newer.close();
    assert.deepEqual({ log: console.log, stdout: process.stdout.write, stderr: process.stderr.write }, before); assert.equal(captureDepth(), 0); assert.equal(Date, originalDate);
  } finally { await older?.close(); await newer?.close(); Object.assign(console, { log: before.log }); process.stdout.write = before.stdout; process.stderr.write = before.stderr; await backend.close(); }
});
test('startup deadline: a silent SDK initialize is inconclusive, reaps its child, restores captures, and cannot blind the next cell', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'b2-silent-cli-')), script = join(dir, 'silent.mjs');
  writeFileSync(script, 'process.stdin.resume(); setInterval(() => {}, 1000);\n');
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug, stdout: process.stdout.write, stderr: process.stderr.write };
  const c = clone(manifest.cases.find(c => c.id === 'B2-CLS-01')!); c.budgets.deadline_ms = 500;
  let child: import('node:child_process').ChildProcess | undefined;
  try {
    const result = await runCell(c, 'sdk-modern', 1, { cliScript: script, onChild(p) { child = p; } });
    assert.equal(result.verdict, 'INCONCLUSIVE'); assert.deepEqual(result.failures.map(f => f.predicate), ['b2.watchdog.deadline']);
    assert.ok(child && (child.exitCode !== null || child.signalCode !== null), 'half-open child exited');
    assert.equal(captureDepth(), 0); assert.equal(cellDrivers.current, undefined);
    assert.deepEqual({ log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug, stdout: process.stdout.write, stderr: process.stderr.write }, original);
    const next = await runCell({ ...c, budgets: { ...c.budgets, deadline_ms: 15000 } }, 'core', 1, { afterDriverStart() { console.log(B); } });
    assert.equal(next.verdict, 'FAIL'); assert.ok(next.failures.some(f => f.predicate === 'forbidden marker absent'));
  } finally { child?.kill('SIGKILL'); await sleep(50); Object.assign(console, original); process.stdout.write = original.stdout; process.stderr.write = original.stderr; rmSync(dir, { recursive: true, force: true }); }
});
test('child ownership: failed SDK startup reaps its child even after SDK bookkeeping is cleared', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'b2-owned-child-')), script = join(dir, 'silent.mjs');
  writeFileSync(script, 'process.stdin.resume(); setInterval(() => {}, 1000);');
  const start = StdioClientTransport.prototype.start, original = { log: console.log, stdout: process.stdout.write, stderr: process.stderr.write };
  let child: import('node:child_process').ChildProcess | undefined, guard: NodeJS.Timeout | undefined, guardFired = false;
  // Model the SDK's close() bookkeeping transition while retaining the independently observed child identity.
  StdioClientTransport.prototype.start = function () { const promise = start.call(this); queueMicrotask(() => { (this as unknown as { _process: unknown })._process = undefined; }); return promise; };
  try {
    const c = clone(manifest.cases[0]!); c.budgets.deadline_ms = 1000;
    const result = await runCell(c, 'sdk-modern', 1, { cliScript: script, onChild(p) { child = p; guard = setTimeout(() => { guardFired = true; p.kill('SIGKILL'); }, 3000); } });
    assert.equal(result.verdict, 'INCONCLUSIVE'); assert.equal(guardFired, false, 'driver teardown owns the kill');
    assert.ok(child && (child.exitCode !== null || child.signalCode !== null), 'a forgotten SDK field must not admit a live child after return');
    assert.equal(captureDepth(), 0); assert.equal(cellDrivers.current, undefined);
    assert.deepEqual({ log: console.log, stdout: process.stdout.write, stderr: process.stderr.write }, original);
  } finally { StdioClientTransport.prototype.start = start; if (guard) clearTimeout(guard); child?.kill('SIGKILL'); await sleep(50); rmSync(dir, { recursive: true, force: true }); }
});
test('startup cancellation: a backend hook released after the deadline cannot open a driver', { timeout: 30000 }, async () => {
  let release!: () => void; const held = new Promise<void>(r => { release = r; }); let opens = 0; const opened: Driver[] = [];
  const c = clone(manifest.cases[0]!); c.budgets.deadline_ms = 100;
  const result = await runCell(c, 'core', 1, { afterBackendStart: () => held, afterDriverStart(d) { opens++; opened.push(d); } });
  const snapshot = JSON.stringify(result); release(); await sleep(100);
  try { assert.equal(result.verdict, 'INCONCLUSIVE'); assert.equal(opens, 0); assert.equal(captureDepth(), 0); assert.equal(cellDrivers.current, undefined); assert.equal(JSON.stringify(result), snapshot); }
  finally { for (const driver of opened.toReversed()) await driver.close(); }
});
test('disclosure scans: stub replay, destructive deadline close and teardown cannot erase a marker', { timeout: 30000 }, async () => {
  const c = manifest.cases.find(c => c.id === 'B2-CLS-01')!, base = await runCell(c, 'core', 1);
  for (const mode of ['stub', 'held-stub', 'state-before-close', 'teardown'] as const) {
    let backend: Awaited<ReturnType<typeof startBackend>>;
    const result = await runCell({ ...c, budgets: { ...c.budgets, deadline_ms: 700 } }, 'core', 1, {
      afterBackendStart(b) { backend = b; if (mode === 'state-before-close') b.holdNextClinical(); },
      afterDriverStart(d) {
        const close = d.close.bind(d), call = d.call.bind(d); let closed = false, n = 0;
        if (mode === 'state-before-close') { d.state = () => closed ? {} : { payload: B }; d.close = async () => { closed = true; await close(); }; }
        else if (mode === 'teardown') d.close = async () => { d.operational.push(B); await close(); };
        else d.call = async (name, args) => { if (n++ === base.pre_stub.per_driver[0]) { d.operational.push(B); if (mode === 'held-stub') backend.holdNextClinical(); } return call(name, args); };
      },
    });
    assert.equal(result.verdict, 'FAIL', mode); assert.ok(result.failures.some(f => f.predicate === 'forbidden marker absent'), mode);
  }
});
test('prohibited collectors: byte-count failure cannot mask sink traffic, mutation, GET or confinement failures', async () => {
  const c = manifest.cases.find(c => c.id === 'B2-CLS-01')!; let backend: Awaited<ReturnType<typeof startBackend>>;
  const result = await runCell(c, 'core', 1, {
    afterBackendStart(b) { backend = b; },
    async afterDriverStart(d) {
      await fetch(`${backend.sinkUrl}exfil`); await fetch(`${new URL(backend.base).origin}/admin/write`, { method: 'POST', body: 'synthetic' });
      await fetch(`${backend.base}Observation`, { method: 'POST' });
      const call = d.call.bind(d); let first = true;
      d.call = async (name, args) => { const r = await call(name, args); if (first) { first = false; r.bytes++; } return r; };
    },
  });
  assert.equal(result.verdict, 'FAIL');
  for (const predicate of ['byte observation matches independently reconstructed wire', 'zero target traffic at live sinks', 'clinical mutation digest unchanged', 'all clinical methods are GET', 'ordinary search retains immutable patient confinement']) assert.ok(result.failures.some(f => f.predicate === predicate), predicate);
});
test('channel scan isolation: an unreadable audit cannot mask a forbidden marker in state', async () => {
  const c = manifest.cases.find(c => c.id === 'B2-CLS-01')!;
  const r = await runCell(c, 'core', 1, { afterDriverStart(d) { d.audit = () => { throw new Error('synthetic capture failure'); }; d.state = () => ({ payload: B }); } });
  assert.equal(r.verdict, 'FAIL'); assert.ok(r.failures.some(f => f.channel === 'audit' && f.predicate === 'capture readable'));
  assert.ok(r.failures.some(f => f.channel === 'state' && f.predicate === 'forbidden marker absent'));
});
test('repeat evidence: an extra recorded metadata request changes the observable-work digest', async () => {
  const c = manifest.cases.find(c => c.id === 'B2-CLS-01')!, normal = await runCell(c, 'core', 1);
  const extra = await runCell(c, 'core', 2, { async afterBackendStart(b) { await fetch(`${b.base}metadata`); } });
  assert.equal(normal.verdict, 'PASS'); assert.equal(extra.verdict, 'PASS'); assert.equal(extra.pre_stub.total_upstream_calls, normal.pre_stub.total_upstream_calls + 1); assert.notEqual(extra.fingerprint, normal.fingerprint);
});
test('cell evidence: strict shapes, eras, passing facts, stub identities, budgets and repeat agreement are derived', () => {
  const c = manifest.cases.find(c => c.id === 'B2-SEL-01')!;
  const refuses = (mutate: (r: CaseReport) => void, code: string) => { const r = caseReport(c.id); mutate(r); assert.throws(() => validateAggregate([r], [c.id], [c]), (e: unknown) => e instanceof AggregateError && e.code === code, code); };
  validateAggregate([caseReport(c.id)], [c.id], [c]);
  refuses(r => { (r as unknown as Record<string, unknown>).extra = true; }, 'case-shape');
  refuses(r => { (r.lanes[0] as unknown as Record<string, unknown>).extra = true; }, 'case-shape');
  refuses(r => { r.lanes[2]!.era = '2025-11-25'; }, 'cell-era');
  refuses(r => { r.lanes[0]!.failures.push({ channel: 'backend', predicate: 'clinical mutation digest unchanged', expected: true, observed: false }); }, 'cell-pass-failures');
  refuses(r => { r.lanes[0]!.stubs[1]!.kind = 'deny-all'; }, 'cell-incomplete');
  refuses(r => { r.lanes[0]!.channels_na = [...CHANNELS]; r.lanes[0]!.channels_scanned = []; }, 'cell-coverage');
  refuses(r => { r.lanes[0]!.capture_hashes.state = ''; }, 'cell-coverage');
  refuses(r => { r.lanes[0]!.capture_hashes.state = 'g'.repeat(64); }, 'cell-coverage');
  refuses(r => { r.lanes[0]!.pre_stub.max_call_bytes = c.budgets.max_result_bytes + 1; }, 'cell-budget');
  refuses(r => { r.lanes[0]!.pre_stub.tool_calls = c.budgets.max_tool_calls + 1; }, 'cell-budget');
  refuses(r => { r.lanes[0]!.tool_calls++; }, 'cell-counts');
  refuses(r => { r.lanes.forEach(l => { l.fingerprint = ''; }); }, 'cell-repeat-digest');
  refuses(r => { r.lanes[1]!.fingerprint = 'b'.repeat(64); }, 'case-repeat');
  refuses(r => { r.lanes[0]!.verdict = 'FAIL'; }, 'case-verdict');
  refuses(r => { r.cli.verdict = 'FAIL'; }, 'cli-verdict');
  refuses(r => { r.family = 'ERR'; }, 'case-identity');
  assert.throws(() => validateAggregate([caseReport(c.id)], [c.id], undefined as never), (e: AggregateError) => e.code === 'manifest-cases-required');
});
test('standing evidence: inconsistent passing cells never earn counted credit', () => {
  const c = countedManifest().cases.find(c => c.id === 'B2-SEL-01')!, kills: KillRecord[] = [{ mutant_id: c.critical_mutants[0]!, case_id: c.id, verdict: 'KILLED', inputs_sha256: DIGEST }];
  for (const mutate of [(r: CaseReport) => { r.lanes[2]!.era = '2025-11-25'; }, (r: CaseReport) => { r.lanes[0]!.pre_stub.max_call_bytes = c.budgets.max_result_bytes + 1; }, (r: CaseReport) => { r.lanes[1]!.fingerprint = 'c'.repeat(64); }]) {
    const r = caseReport(c.id); mutate(r); assert.equal(computeStanding(c, r, qualifyingRun(), kills, DIGEST).counts_toward_b2, false);
  }
});
test('kill row evidence: summaries, contradictory rows, anchors, compilation, baseline, oracle and spares cannot earn credit', async () => {
  const fixture = await validKillsFixture(), dir = mkdtempSync(join(tmpdir(), 'b2-kill-proof-'));
  const write = (f: KillsFile) => writeFileSync(join(dir, 'kills.json'), JSON.stringify(f));
  const read = () => readKills('run-a', DIGEST, dir, { binding: fixture.binding });
  try {
    write(fixture); assert.equal((await read()).kills.length, fixture.kills.length);
    const changes: ((f: KillsFile) => void)[] = [
      f => { f.rows = []; }, f => { f.rows[0]!.verdict = 'INVALID'; }, f => { f.rows[0]!.compiled = false; },
      f => { f.rows[0]!.compile_exit = 1; }, f => { f.rows[0]!.anchor_matches[0]!.matches = 2; },
      f => { f.rows[0]!.baseline.exit = 1; }, f => { f.rows[0]!.baseline.cases[0]!.lanes[0]!.control_result = 'FAIL'; },
      f => { f.rows[0]!.cases[0]!.lanes[0]!.failures = []; }, f => { f.rows[0]!.cases[0]!.lanes[0]!.era = 'wrong'; },
      f => { f.kills[0]!.oracle = 'harness:made-up'; }, f => { f.kills[0]!.case_id = 'B2-ERR-03'; },
      f => { f.kills.push(clone(f.kills[0]!)); }, f => { f.rows.push(clone(f.rows[0]!)); },
      f => { f.rows[0]!.mutant_id = 'unknown-mutant'; }, f => { f.rows[0]!.cases[0]!.lanes[0]!.capture_hashes = {}; },
    ];
    for (const change of changes) { const f = clone(fixture); change(f); write(f); const result = await read(); assert.deepEqual(result.kills, []); assert.ok(result.problems.length); }
    const matrix = parseKillMatrix(), row = matrix.rows.find(r => r.mutant_id === fixture.rows[0]!.mutant_id)!; row.spares = ['B2-ERR-03'];
    const f = clone(fixture); f.rows[0]!.spares = row.spares; f.rows[0]!.baseline.cases.push(CaseReportSchema.parse(caseReport('B2-ERR-03'))); f.rows[0]!.cases.push(CaseReportSchema.parse(caseReport('B2-ERR-03')));
    write(f); assert.equal((await readKills('run-a', DIGEST, dir, { binding: fixture.binding, matrix })).kills.length, fixture.kills.length);
    f.rows[0]!.cases[f.rows[0]!.cases.length - 1] = CaseReportSchema.parse(caseReport('B2-ERR-03', 'FAIL')); write(f);
    assert.deepEqual((await readKills('run-a', DIGEST, dir, { binding: fixture.binding, matrix })).kills, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
async function aggregateFixture(label: string, selected: string | undefined = 'B2-SEL-01') {
  const runId = `b2-proof-${label}-${process.pid}`, dir = join('artifacts', 'b2', runId);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  process.env.B2_RUN_ID = runId; process.env.B2_ATTEMPT_ID = `attempt-${label}`;
  if (selected === undefined) delete process.env.B2_CASE_IDS; else process.env.B2_CASE_IDS = selected;
  if (!outerSkipBuild) await ensureBuilt();
  const binding = await runBinding();
  const checks = Object.fromEntries(['manifest_and_verifier', 'scanners', 'server_traffic', 'backend_liveness', 'operational_sinks', 'barrier_schedule'].map(k => [k, { verdict: 'PASS' }]));
  writeFileSync(join(dir, 'attempt.json'), JSON.stringify({ run_id: runId, attempt_id: binding.attempt_id }));
  writeFileSync(join(dir, 'prerequisites.json'), JSON.stringify({ schema_version: 'b2-prerequisites/1', run_id: runId, binding: { start: binding, end: binding }, checks }));
  for (const family of new Set(selectedCases(manifest).map(c => c.family))) writeShardReport(family, selectedCases(manifest, family).map(c => caseReport(c.id)), { start: binding, end: binding });
  return { runId, dir, binding, aggregate: () => aggregateRun(runId, { compatibilityCopy: false }),
    cleanup() { delete process.env.B2_RUN_ID; delete process.env.B2_ATTEMPT_ID; delete process.env.B2_CASE_IDS; rmSync(dir, { recursive: true, force: true }); } };
}
test('aggregate admission witnesses: complete empty selection and an unselected empty shard are refused', { timeout: 120000 }, async () => {
  const empty = await aggregateFixture('empty', '');
  try { await assert.rejects(empty.aggregate(), (e: AggregateError) => e.code === 'selection-empty'); } finally { empty.cleanup(); }
  const full = await aggregateFixture('extra');
  try {
    assert.equal((await full.aggregate()).report.cases.length, 1);
    writeShardReport('ADM', [], { start: full.binding, end: full.binding });
    await assert.rejects(full.aggregate(), (e: AggregateError) => e.code === 'shard-set');
  } finally { full.cleanup(); }
});
test('attempt provenance: missing attempts and copying old evidence into a relabelled run are refused', { timeout: 120000 }, async () => {
  const old = await aggregateFixture('old'), dir = `${old.dir}-copied`, runId = `${old.runId}-copied`;
  try {
    assert.equal((await old.aggregate()).report.cases.length, 1);
    cpSync(old.dir, dir, { recursive: true }); process.env.B2_RUN_ID = runId; process.env.B2_ATTEMPT_ID = 'new-attempt';
    for (const name of ['prerequisites.json', 'shard-SEL.json']) { const file = join(dir, name), evidence = JSON.parse(readFileSync(file, 'utf8')); evidence.run_id = runId; writeFileSync(file, JSON.stringify(evidence)); }
    writeFileSync(join(dir, 'attempt.json'), JSON.stringify({ run_id: runId, attempt_id: 'new-attempt' }));
    await assert.rejects(aggregateRun(runId, { compatibilityCopy: false }), (e: AggregateError) => e.code === 'prerequisites-binding');
    process.env.B2_RUN_ID = old.runId; process.env.B2_ATTEMPT_ID = old.binding.attempt_id!;
    // Otherwise self-consistent evidence, but missing attempt identity everywhere.
    const noAttempt = { ...old.binding, attempt_id: null };
    const p = JSON.parse(readFileSync(join(old.dir, 'prerequisites.json'), 'utf8')); p.binding = { start: noAttempt, end: noAttempt }; writeFileSync(join(old.dir, 'prerequisites.json'), JSON.stringify(p));
    writeShardReport('SEL', [caseReport('B2-SEL-01')], { start: noAttempt, end: noAttempt }); delete process.env.B2_ATTEMPT_ID;
    writeFileSync(join(old.dir, 'attempt.json'), JSON.stringify({ run_id: old.runId, attempt_id: null }));
    await assert.rejects(old.aggregate(), (e: AggregateError) => e.code === 'attempt-missing');
  } finally { old.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});
test('shard content and dependency bindings: changed reports or installed input hashes cannot reuse evidence', { timeout: 120000 }, async () => {
  const fixture = await aggregateFixture('bindings'), path = join(fixture.dir, 'shard-SEL.json'), initial = JSON.parse(readFileSync(path, 'utf8')) as ShardReport;
  try {
    const changed = clone(initial); changed.cases[0]!.lanes[0]!.timing.cell_ms++;
    writeFileSync(path, JSON.stringify(changed)); await assert.rejects(fixture.aggregate(), (e: AggregateError) => e.code === 'shard-cases-digest');
    for (const key of ['lock_hash', 'installed_tree_hash', 'sdk_client_hash', 'sdk_server_hash'] as const) {
      const changed = clone(initial); changed.binding.start.dependencies[key] = hash(`${changed.binding.start.dependencies[key]} changed`);
      writeFileSync(path, JSON.stringify(changed)); await assert.rejects(fixture.aggregate(), (e: AggregateError) => e.code === 'shard-binding', key);
    }
  } finally { fixture.cleanup(); }
});
function scratchBuildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'b2-build-proof-'));
  mkdirSync(join(root, 'packages/server/src'), { recursive: true }); mkdirSync(join(root, 'dist/packages/server/src'), { recursive: true });
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}'); writeFileSync(join(root, 'package-lock.json'), '{}');
  writeFileSync(join(root, 'tsconfig.base.json'), '{"compilerOptions":{"target":"ES2023","module":"NodeNext","moduleResolution":"NodeNext","rootDir":".","outDir":"dist","resolveJsonModule":true}}');
  writeFileSync(join(root, 'tsconfig.build.json'), '{"extends":"./tsconfig.base.json","include":["packages/**/*.ts"]}');
  writeFileSync(join(root, 'packages/server/src/cli.ts'), 'import data from "./policy.json" with { type: "json" }; export const version = data.version;');
  writeFileSync(join(root, 'packages/server/src/policy.json'), '{"version":1}');
  writeFileSync(join(root, 'dist/packages/server/src/cli.js'), 'export const version = 1;');
  writeFileSync(join(root, 'dist/.b2-build-stamp'), sourceStamp(root)); writeFileSync(join(root, 'dist/.b2-build-output'), distDigest(root));
  return root;
}
test('build attestation: JSON assets, inherited config and emitted bytes describe the executable', { timeout: 120000 }, () => {
  const root = scratchBuildFixture();
  try {
    assert.ok(builtMatchesSource(root)); const initial = sourceStamp(root);
    for (const name of ['packages/server/src/policy.json', 'tsconfig.base.json']) {
      const path = join(root, name), before = readFileSync(path, 'utf8'); writeFileSync(path, `${before}\n`);
      assert.notEqual(sourceStamp(root), initial, name); assert.equal(builtMatchesSource(root), false, name); writeFileSync(path, before);
    }
    const path = join(root, 'dist/packages/server/src/cli.js'); writeFileSync(path, 'throw new Error("wrong executable");');
    assert.equal(sourceStamp(root), initial); assert.equal(builtMatchesSource(root), false, 'emitted byte tamper invalidates attestation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('budget measurement evidence: schema, readiness, pins, build, distinct cells, captures and binding are necessary', () => {
  const c = countedManifest().cases.find(c => c.id === 'B2-SEL-01')!, binding = syntheticBinding('prov-run');
  const report = { schema_version: 'b2-isolation-report/3', status: 'DIAGNOSTIC', run_id: 'prov-run', binding, pins: { verified: true }, run: { run_id: 'prov-run', env: { B2_CORE_ONLY: false, B2_SKIP_BUILD: false, B2_CASE_IDS: [] } }, cases: [caseReport(c.id)] };
  const at = (value: typeof report, declaredBinding = value.binding) => {
    const text = JSON.stringify(value), subject = clone(c);
    subject.budgets.budget_source = { rule: 'exact-max/1', run_id: 'prov-run', report_sha256: hash(text), binding_sha256: bindingDigest(declaredBinding), measured: { tool_calls: 1, total_upstream_calls: 1, clinical_calls: 1, result_bytes: 100, cell_ms: 1 } };
    return verifyBudgetProvenance([subject], () => text);
  };
  assert.equal(at(report).size, 0);
  for (const mutate of [
    (r: typeof report) => { r.schema_version = 'bogus'; }, (r: typeof report) => { r.status = 'INCONCLUSIVE'; },
    (r: typeof report) => { r.pins.verified = false; }, (r: typeof report) => { r.binding.build.matches_sources = false; },
    (r: typeof report) => { r.binding.build.skipped = true; }, (r: typeof report) => { r.run.env.B2_SKIP_BUILD = true; },
    (r: typeof report) => { r.run.env.B2_CORE_ONLY = true; }, (r: typeof report) => { r.cases[0]!.lanes = Array(6).fill(r.cases[0]!.lanes[0]); },
    (r: typeof report) => { r.cases[0]!.lanes[2]!.era = '2025-11-25'; }, (r: typeof report) => { r.cases[0]!.lanes[0]!.stubs = []; },
    (r: typeof report) => { r.cases[0]!.lanes[0]!.control_result = 'FAIL'; }, (r: typeof report) => { r.cases[0]!.lanes[0]!.capture_hashes = {}; },
    (r: typeof report) => { r.run_id = 'other'; },
  ]) { const value = clone(report); mutate(value); assert.ok(at(value).has(c.id)); }
  const rebound = clone(report); rebound.binding.inputs_sha256 = 'f'.repeat(64); assert.ok(at(rebound, binding).has(c.id));
});
test('evidence parser refusals: malformed JSON and null shapes always carry AggregateError codes', { timeout: 120000 }, async () => {
  const fixture = await aggregateFixture('malformed');
  try {
    for (const [name, jsonCode, shapeCode] of [['prerequisites.json', 'prerequisites-json', 'prerequisites-shape'], ['shard-SEL.json', 'shard-json', 'shard-shape']] as const) {
      const path = join(fixture.dir, name), before = readFileSync(path, 'utf8');
      for (const [text, code] of [['{', jsonCode], ['null', shapeCode]]) { writeFileSync(path, text!); await assert.rejects(fixture.aggregate(), (e: unknown) => e instanceof AggregateError && e.code === code); }
      writeFileSync(path, before);
    }
    for (const [text, code] of [['{', 'kills-json'], ['null', 'kills-shape']]) {
      writeFileSync(join(fixture.dir, 'kills.json'), text!); await assert.rejects(readKills(fixture.runId, DIGEST, fixture.dir), (e: unknown) => e instanceof AggregateError && e.code === code);
    }
    const c = countedManifest().cases.find(c => c.id === 'B2-SEL-01')!;
    for (const [text, code] of [['{', 'provenance-json'], ['null', 'provenance-shape']]) {
      c.budgets.budget_source!.report_sha256 = hash(text!); assert.throws(() => verifyBudgetProvenance([c], () => text), (e: unknown) => e instanceof AggregateError && e.code === code);
    }
  } finally { fixture.cleanup(); }
});
test('loader independence: identical edit sets, family spares and overlapping or shared-window anchors are refused', async () => {
  const base = await getBase();
  const pair = countedSet(base, ['B2-SEL-01', 'B2-SEL-03'], [{ mutant: 'synthetic-one', kills: ['B2-SEL-01'], spares: ['B2-SEL-03'] }, { mutant: 'synthetic-two', kills: ['B2-SEL-03'], spares: ['B2-SEL-01'] }]);
  assert.equal(checkSemantics(pair.m, pair.ctx).cases.filter(c => c.counted).length, 2);
  const duplicated = { ...pair.ctx, mutants: pair.ctx.mutants.map(m => m.id === 'synthetic-two' ? { ...m, edits: clone(pair.ctx.mutants.find(m => m.id === 'synthetic-one')!.edits) } : m) };
  rejects(pair.m, 'kill-row-identical-edits', duplicated);
  // Distinct anchors and bodies still require same-family spares.
  const isolated = clone(pair.m); isolated.cases.find(c => c.id === 'B2-SEL-03')!.signature.source_anchor = { file: 'packages/server/src/cli.ts', find: 'ANOTHER-SYNTHETIC-ANCHOR' };
  const isolatedCtx: SemanticContext = { ...pair.ctx, readSource: file => file === 'packages/server/src/cli.ts' ? 'ANOTHER-SYNTHETIC-ANCHOR' : pair.ctx.readSource(file), mutants: pair.ctx.mutants.map(m => m.id === 'synthetic-two' ? { ...m, edits: [{ file: 'packages/server/src/cli.ts', find: 'ANOTHER-SYNTHETIC-ANCHOR', replace: '' }] } : m), killMatrix: { ...clone(pair.ctx.killMatrix), rows: pair.ctx.killMatrix.rows.map(r => ({ ...r, spares: [] })) } };
  rejects(isolated, 'kill-indistinct', isolatedCtx);
  for (const mode of ['overlap', 'window'] as const) {
    const cross = countedSet(base, ['B2-SEL-01', 'B2-PTH-01'], [{ mutant: 'synthetic-one', kills: ['B2-SEL-01'] }, { mutant: 'synthetic-two', kills: ['B2-PTH-01'] }]);
    const x = 'AAAAAAAAAAAAXXXXXXXXXXXX', y = mode === 'overlap' ? 'XXXXXXXXXXXXBBBBBBBBBBBB' : 'CCCCCCCCCCCCBBBBBBBBBBBB';
    const source = mode === 'overlap' ? 'AAAAAAAAAAAAXXXXXXXXXXXXBBBBBBBBBBBB' : `${x} middle ${y}`;
    cross.m.cases.find(c => c.id === 'B2-SEL-01')!.signature.source_anchor = { file: ANCHOR.file, find: x };
    cross.m.cases.find(c => c.id === 'B2-PTH-01')!.signature.source_anchor = { file: ANCHOR.file, find: y };
    cross.ctx.readSource = () => source;
    cross.ctx.mutants = cross.ctx.mutants.map(m => m.id === 'synthetic-one' || m.id === 'synthetic-two' ? { ...m, edits: [{ file: ANCHOR.file, find: mode === 'window' ? source : m.id === 'synthetic-one' ? x : y, replace: `// ${m.id}` }] } : m);
    rejects(cross.m, 'kill-indistinct', cross.ctx);
    cross.ctx.killMatrix.rows[0]!.spares = ['B2-PTH-01']; cross.ctx.killMatrix.rows[1]!.spares = ['B2-SEL-01'];
    assert.equal(checkSemantics(cross.m, cross.ctx).cases.filter(c => c.counted).length, 2);
  }
});
test('anchor edit evidence: a preserved anchor or an unchanged anchor span is not an edited decision', async () => {
  const ctx = countedContext(await getBase());
  const changed = (replace: string) => ({ ...ctx, mutants: ctx.mutants.map(m => m.id === 'synthetic-confinement-dropped' ? { ...m, edits: [{ file: ANCHOR.file, find: `before ${ANCHOR.find} tail`, replace }] } : m) });
  rejects(counted(), 'anchor-fault', changed(`after ${ANCHOR.find} tail`));
  rejects(counted(), 'anchor-fault', changed(`before ${ANCHOR.find} tail // comment`));
  // Insertions just outside the anchor are not overlap even if a separate changed span deletes its verbatim copy.
  assert.ok(checkSemantics(counted(), changed('before changed decision tail')).cases.some(c => c.counted));
});
test('authored content: novel tokens, ASCII letters, stopword duplicates and tokenized transitions are enforced', async () => {
  const ctx = countedContext(await getBase());
  for (const intent of ['The gateway bypasses refuse conflicting caller patient', 'Bypass refuse conflicting caller patient (gateway path)', 'zzz qqq www refuse conflicting caller patient substitute', 'refuse conflicting caller pаtient: substitute B for trusted A']) rejects(counted(c => { c.signature.discriminating_fault_intent = intent; }), 'template-fault', ctx);
  rejects(counted(c => { c.signature.discriminating_fault_intent = `${c.signature.discriminating_fault_intent} ɑ`; }), 'template-fault', ctx);
  rejects(counted(c => { c.controls[0]!.near_twin_delta = `${c.controls[0]!.near_twin_delta} ɑ`; }), 'template-twin', ctx);
  rejects(counted(c => { c.controls[0]!.near_twin_delta = 'refuse conflicting caller patient; xylophone banana'; }), 'template-twin', ctx);
  for (const transition of ['pre-send:control-then-attack-and-retained-followups.', 'pre send control then attack and retained followups', 'authorized delivery ɑ']) rejects(counted(c => { c.signature.state_transition = transition; }), 'template-transition', ctx);
  const pair = countedSet(await getBase(), ['B2-SEL-01', 'B2-SEL-03'], [{ mutant: 'synthetic-one', kills: ['B2-SEL-01'], spares: ['B2-SEL-03'] }, { mutant: 'synthetic-two', kills: ['B2-SEL-03'], spares: ['B2-SEL-01'] }]);
  pair.m.cases.find(c => c.id === 'B2-SEL-03')!.signature.discriminating_fault_intent = `the ${pair.m.cases.find(c => c.id === 'B2-SEL-01')!.signature.discriminating_fault_intent}`;
  rejects(pair.m, 'template-fault', pair.ctx);
});
test('executable contracts: exactly one control, exact assertion and challenge ids, known expected assertions and two eras', async () => {
  const ctx = await getBase();
  const mutate = (fn: (m: Manifest) => void, code: string) => { const m = clone(manifest); fn(m); rejects(m, code, ctx); };
  mutate(m => { m.cases[0]!.controls.push({ ...clone(m.cases[0]!.controls[0]!), id: 'undefined-control' }); }, 'control-contract');
  mutate(m => { m.cases[0]!.controls[0]!.assertions.push('undefined-assertion'); }, 'control-contract');
  mutate(m => { m.cases[0]!.controls[0]!.overblocking_challenges = ['undefined-challenge']; }, 'control-contract');
  mutate(m => { m.cases[0]!.expected_assertions.push('undefined-assertion'); }, 'assertion-contract');
  mutate(m => { m.required_eras = ['2026-07-28', '2026-07-28']; }, 'required-eras');
  const eras = clone(manifest); eras.required_eras = ['2026-07-28', '2026-07-28']; assert.throws(() => parseManifest(eras));
});
test('oracle syntax and ownership: parse literal calls and evidence, ignore comments and variables, accept spaces and scanner hits', async () => {
  const base = await getBase(); const registry = namedOracles(base);
  assert.equal(registry.has('equal:different'), false);
  const withComment = { ...base, runnerSource: `${base.runnerSource}\n// check(true, 'backend', 'comment is not evidence');\ncheck(true, 'output_structured', label, 'equal', 'different');` };
  assert.equal(namedOracles(withComment).has('backend:comment is not evidence'), false); assert.equal(namedOracles(withComment).has('equal:different'), false);
  for (const channel of CHANNELS) assert.ok(registry.has(`${channel}:forbidden marker absent`));
  const row = clone(base.killMatrix.rows[0]!); row.kills = [{ case_id: 'B2-SEL-01', oracle: 'output_structured:b2.sel-02.terminal' }];
  const ctx = { ...base, killMatrix: { ...base.killMatrix, rows: [row] } };
  rejects(clone(manifest), 'kill-case-oracle', ctx);
  row.kills[0]!.oracle = 'equal:different'; rejects(clone(manifest), 'kill-row-oracle', ctx);
  row.kills[0]!.oracle = 'backend:clinical mutation digest unchanged';
  assert.ok(parseKillMatrix(ctx.killMatrix)); assert.ok(checkSemantics(clone(manifest), ctx));
  for (const oracle of ['backend: clinical mutation digest unchanged', 'backend:clinical mutation digest unchanged ']) { row.kills[0]!.oracle = oracle; assert.throws(() => parseKillMatrix(ctx.killMatrix)); }
});
test('coverage universe: deleting axes and overly broad N/A rules cannot erase obligations', () => {
  const original = parseCoverageMatrix();
  const reduced = clone(original); for (const key of ['requirement', 'tool', 'subject', 'interaction', 'channel'] as const) (reduced.axes[key] as unknown[]) = reduced.axes[key].slice(0, 1);
  reduced.cells = [clone(reduced.cells[0]!)]; reduced.axes.tool = [reduced.cells[0]!.tool as 'fhir_search']; reduced.axes.interaction = ['search'];
  assert.throws(() => parseCoverageMatrix(reduced), (e: ManifestError) => e.code === 'matrix-universe');
  const single = { id: 'NA-001', when: { tool: 'fhir_capabilities' }, reason: 'synthetic reviewed rule', reviewer: 'reviewer-a' };
  assert.throws(() => parseCoverageMatrix({ ...original, not_applicable_rules: [single] }), (e: ManifestError) => e.code === 'matrix-rule');
  const narrowSingle = clone(original); narrowSingle.cells.filter(c => c.subject === 'patient:Patient').forEach(c => { c.applicability = { status: 'not_applicable', reason: 'synthetic', reviewer: 'test' }; });
  narrowSingle.not_applicable_rules = [{ ...single, when: { subject: 'patient:Patient' } }];
  assert.throws(() => parseCoverageMatrix(narrowSingle), (e: ManifestError) => e.code === 'matrix-rule');
  const broad = { ...single, when: { tool: 'fhir_capabilities', subject: 'patient:*' } };
  assert.throws(() => parseCoverageMatrix({ ...original, not_applicable_rules: [broad] }), (e: ManifestError) => e.code === 'matrix-rule-size');
  const limited = { ...broad, when: { ...broad.when, channel: 'output' } }, m = parseCoverageMatrix({ ...original, not_applicable_rules: [limited] }), result = matrixCompleteness(m);
  assert.equal(result.ruled_per_rule['NA-001'], 945); assert.equal(result.ruled_per_reviewer['reviewer-a'], 945);
});
test('design ledger identity: swapping counted and B3 labels or moving first-slice flags is refused', () => {
  const ledger = parseLedger(); assert.ok(verifyLedgerDesign(ledger, readDesign()));
  const relabelled = clone(ledger), a = relabelled.records.find(r => r.id === 'CNT-03')!, b = relabelled.records.find(r => r.id === 'CNT-05')!; [a.class, b.class] = [b.class, a.class];
  assert.ok(parseLedger(relabelled)); assert.equal(verifyLedgerDesign(relabelled, readDesign()), false);
  const moved = clone(ledger), first = moved.records.find(r => r.first_slice)!, other = moved.records.find(r => r.class === 'counted' && !r.first_slice)!; first.first_slice = false; other.first_slice = true;
  assert.ok(parseLedger(moved)); assert.equal(verifyLedgerDesign(moved, readDesign()), false);
});
function fullGateFixture() {
  const m = countedManifest(), template = m.cases.find(c => c.id === 'B2-SEL-01')!;
  m.cases = Array.from({ length: 201 }, (_, i) => ({ ...clone(template), id: `B2-SEL-${String(i + 1).padStart(3, '0')}` }));
  m.aliases = Array.from({ length: 42 }, () => ({}) as Manifest['aliases'][number]); m.catalogue = Array.from({ length: 29 }, () => ({}) as Manifest['catalogue'][number]);
  const reports = m.cases.map(c => caseReport(c.id)), kills: KillRecord[] = m.cases.map(c => ({ mutant_id: c.critical_mutants[0]!, case_id: c.id, verdict: 'KILLED', inputs_sha256: DIGEST }));
  const coverage = parseCoverageMatrix(), first = clone(coverage.cells[0]!); first.covered_by = m.cases.map(c => c.id);
  coverage.cells = [first]; coverage.axes = { requirement: [first.requirement], tool: [first.tool as 'fhir_search'], subject: [{ id: first.subject, required: true }], interaction: [first.interaction as 'search'], channel: [first.channel as 'output'] };
  const gate = (unprovenBudgets?: ReadonlyMap<string, string>) => computeGate(m, parseLedger(), coverage, reports, qualifyingRun(), kills, DIGEST, false, [], { unprovenBudgets });
  return { m, reports, kills, coverage, gate };
}
test('gate admission witnesses: 200 greens cannot conceal a counted annotation, unproven budget or failing manifest case', () => {
  const base = fullGateFixture(); assert.equal(base.gate().acceptance_gate.passed, true, 'synthetic gate fixture, never execution/qualification evidence');
  const annotated = fullGateFixture(); annotated.m.cases[200]!.known_failure = { reason: 'still tracked', tracking: 'test', since_revision: 'test' };
  assert.equal(annotated.gate().earned, 200); assert.equal(annotated.gate().acceptance_gate.passed, false);
  const unproven = fullGateFixture(), budgets = new Map([[unproven.m.cases[200]!.id, 'measurement missing']]);
  assert.equal(unproven.gate(budgets).earned, 200); assert.equal(unproven.gate(budgets).acceptance_gate.passed, false);
  const failed = fullGateFixture(); failed.reports[200] = caseReport(failed.reports[200]!.id, 'FAIL');
  assert.equal(failed.gate().earned, 200); assert.equal(failed.gate().acceptance_gate.passed, false);
  const diagnostic = fullGateFixture(); diagnostic.m.cases.push({ ...clone(diagnostic.m.cases[0]!), id: 'B2-ERR-03', family: 'ERR', counted: false, critical_mutants: [] }); diagnostic.reports.push(caseReport('B2-ERR-03', 'PENDING'));
  assert.equal(diagnostic.gate().earned, 201); assert.equal(diagnostic.gate().acceptance_gate.passed, false);
  const prohibited = fullGateFixture(); prohibited.m.cases.push({ ...clone(prohibited.m.cases[0]!), id: 'B2-ERR-03', family: 'ERR', counted: false, critical_mutants: [] });
  const denied = caseReport('B2-ERR-03', 'FAIL'); denied.lanes.forEach(l => { l.failures = [{ channel: 'backend', predicate: 'clinical mutation digest unchanged', expected: true, observed: false }]; }); prohibited.reports.push(denied);
  assert.equal(prohibited.gate().acceptance_gate.passed, false);
});
test('gate matrix admission witnesses: an uncovered cell or an unlisted tuple blocks an otherwise passing gate', () => {
  const uncovered = fullGateFixture(); assert.equal(uncovered.gate().acceptance_gate.passed, true);
  uncovered.coverage.cells[0]!.covered_by = []; assert.equal(uncovered.gate().acceptance_gate.passed, false);
  const missing = fullGateFixture(); missing.coverage.axes.channel = ['output', 'retained']; assert.equal(missing.gate().acceptance_gate.passed, false);
});
test('nonproduction anchor admission witness: exact matching edits in an eval fixture are still not runtime decisions', async () => {
  const ctx = countedContext(await getBase()), m = counted(), file = 'packages/evals/src/fixture.ts';
  m.cases.find(c => c.id === 'B2-SEL-01')!.signature.source_anchor = { file, find: ANCHOR.find };
  ctx.readSource = () => ANCHOR.find; ctx.mutants = ctx.mutants.map(r => r.id === 'synthetic-confinement-dropped' ? synthetic(r.id, file) : r);
  rejects(m, 'template-anchor', ctx);
});
test('secondary budget admission witness: primary-only ceiling refuses combined primary and foreign work', async () => {
  const c = manifest.cases.find(c => c.id === 'B2-CUR-04')!, measured = await runCell(c, 'core', 1);
  const result = await runCell({ ...c, budgets: { ...c.budgets, max_tool_calls: measured.pre_stub.per_driver[0]! } }, 'core', 1);
  assert.equal(result.verdict, 'FAIL'); assert.ok(result.failures.some(f => f.predicate === 'b2.budget.max_tool_calls'));
});
test('outer skip-build admission witness: the build-stamp child leaves a stale executable untouched', { timeout: 120000 }, () => {
  const root = scratchBuildFixture();
  try {
    writeFileSync(join(root, 'dist/.b2-build-stamp'), 'deliberately-stale'); const before = distDigest(root);
    const childEnv = { ...process.env, B2_SKIP_BUILD: '1' }; delete (childEnv as NodeJS.ProcessEnv).NODE_TEST_CONTEXT;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-name-pattern=^build stamp:', resolve('tests/isolation/counting.test.ts')], { cwd: root, env: childEnv, encoding: 'utf8', maxBuffer: 8 << 20 });
    assert.match(output, /# fail 0/); assert.equal(readFileSync(join(root, 'dist/.b2-build-stamp'), 'utf8'), 'deliberately-stale'); assert.equal(distDigest(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('parser admission witnesses: malformed JSON and invalid shapes are never returned as validated data', () => {
  assert.throws(() => parseEvidenceJSON('{', 'synthetic-json'), (e: unknown) => e instanceof AggregateError && e.code === 'synthetic-json');
  assert.throws(() => parseEvidence(z.strictObject({ ready: z.literal(true) }), { ready: false }, 'synthetic-shape'), (e: unknown) => e instanceof AggregateError && e.code === 'synthetic-shape');
});
test('build evidence admission witness: an unverified executable cannot supply otherwise complete shard evidence', { timeout: 120000 }, () => {
  const root = scratchBuildFixture(), source = resolve('tests/isolation'), runId = 'unverified-proof';
  writeFileSync(join(root, 'dist/.b2-build-stamp'), 'stale');
  const script = `import {mkdirSync,writeFileSync} from 'node:fs';
    import {runBinding} from ${JSON.stringify(`${source}/report.ts`)};
    import {writeShardReport} from ${JSON.stringify(`${source}/shard.ts`)};
    import {aggregateRun} from ${JSON.stringify(`${source}/aggregate.ts`)};
    const dir='artifacts/b2/${runId}';mkdirSync(dir,{recursive:true}); const b=await runBinding();
    writeFileSync(dir+'/attempt.json',JSON.stringify({run_id:'${runId}',attempt_id:b.attempt_id}));
    writeFileSync(dir+'/prerequisites.json',JSON.stringify({schema_version:'b2-prerequisites/1',run_id:'${runId}',binding:{start:b,end:b},checks:${JSON.stringify(Object.fromEntries(['manifest_and_verifier', 'scanners', 'server_traffic', 'backend_liveness', 'operational_sinks', 'barrier_schedule'].map(k => [k, { verdict: 'PASS' }])))} }));
    writeShardReport('SEL',${JSON.stringify([caseReport('B2-SEL-01')])},{start:b,end:b});
    try {await aggregateRun('${runId}',{compatibilityCopy:false});console.log('accepted');} catch(e) {console.log(e.code ?? e.name);}`;
  writeFileSync(join(root, 'probe.mjs'), script);
  try {
    const env = { ...process.env, B2_RUN_ID: runId, B2_ATTEMPT_ID: 'attempt-proof', B2_CASE_IDS: 'B2-SEL-01' }; delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT;
    const result = execFileSync(process.execPath, ['--import', 'tsx', 'probe.mjs'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 << 20 });
    assert.equal(result.trim(), 'build-unverified');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('repeat normalization: timing alone agrees while count, state, audit, destination and ordered pairs remain protected', () => {
  const make = (elapsed_ms: number) => {
    const envelope = { request_id: 'request-opaque', elapsed_ms, data: { ok: true } };
    const wire = { structuredContent: envelope, content: [{ type: 'text', text: JSON.stringify(envelope) }] };
    const driver = { calls: [{ envelope, wire, bytes: Buffer.byteLength(JSON.stringify(wire)) }], state: () => ({ count: 1 }), audit: () => [{ outcome: 'allowed' }] } as unknown as Driver;
    const backend = { base: 'http://127.0.0.1:1001/fhir/', sinkUrl: 'http://127.0.0.1:1002/', requests: [{ phase: 'target', method: 'GET', url: 'http://127.0.0.1:1001/fhir/Observation', pairs: [['code', 'x'], ['code', 'y']], credential_fingerprint: 'credential-one' }] } as unknown as Awaited<ReturnType<typeof startBackend>>;
    const counts: Counts = { tool_calls: 1, total_upstream_calls: 1, clinical: 1, metadata: 0, auth: 0, probe: 0, sink: 0, mutations: 0, max_call_bytes: driver.calls[0]!.bytes, per_driver: [1] };
    return { driver, backend, counts, digest() { return workFingerprint(this.backend, [this.driver], this.counts); } };
  };
  const first = make(1), later = make(123); assert.equal(first.digest(), later.digest());
  for (const mutate of [(x: ReturnType<typeof make>) => { x.counts.tool_calls++; }, (x: ReturnType<typeof make>) => { x.counts.max_call_bytes++; },
    (x: ReturnType<typeof make>) => { x.driver.state = () => ({ count: 2 }); }, (x: ReturnType<typeof make>) => { x.driver.audit = () => [{ outcome: 'denied' }]; },
    (x: ReturnType<typeof make>) => { (x.backend.requests[0] as unknown as { url: string }).url = 'http://127.0.0.1:1002/exfil'; },
    (x: ReturnType<typeof make>) => { (x.backend.requests[0] as unknown as { pairs: string[][] }).pairs.reverse(); }]) {
    const changed = make(1); mutate(changed); assert.notEqual(changed.digest(), first.digest());
  }
});
