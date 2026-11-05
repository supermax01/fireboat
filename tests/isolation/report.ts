import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { platform, release } from 'node:os';
import { M3B_SCHEMA_VERSION } from '../../packages/core/src/contracts.js';
import { B2_REQUIRED_EARNED, CHANNELS, LEDGER, hash, matrixCompleteness, parseKillMatrix, parseManifest, readIsolationFile, registryMutants, type CoverageMatrix, type IsolationCase, type KillMatrix, type Ledger, type Manifest, type RegistryMutant } from './case-schema.js';
import { builtMatchesSource, sourceStamp, distDigest } from './build.js';
import { dependencyDigests } from './digests.js';
import { SCENARIO_CONTRACTS } from './registry.js';
import { AggregateError, BindingSchema, CaseReportSchema, parseEvidence, parseEvidenceJSON, validateAggregate, cellCoverageProblem } from './evidence.js';
import { z } from 'zod';
export { AggregateError, cellCoverageProblem, naChannels } from './evidence.js';
import type { CaseReport, CellReport } from './runner.js';

/** Predicates whose failure is a prohibited disclosure or a clinical mutation (design §1 pass rule), by class.
 * Every entry must exist verbatim as a check predicate in runner.ts or scenarios.ts (counting test). Any cell of any
 * case failing one of them fails the acceptance gate, counted or not (review H1). */
export const PROHIBITED_PREDICATES = Object.freeze({
  disclosure: ['forbidden marker absent'],
  scenario_disclosure: ['foreign process/store cannot resolve locator', 'explicit B primary cannot borrow A secondary', 'all foreign handle actions unavailable', 'reverse cross-store locator unavailable', 'foreign fullUrl cannot authorize relative A subject', 'bound Patient companions withheld symmetrically', 'opaque rebound B page suppressed', 'foreign and missing direct reads uniform NOT_FOUND', 'unauthorized composite read denied', 'unauthorized composite search suppressed', 'contained foreign Patient denied too', 'wrong body type/identity unavailable', 'conditional patient companion owning resource denied', 'conditional patient companion search suppressed', 'Patient.link.other withheld', 'foreign-only output empty', 'late foreign page suppressed', 'foreign companion read unavailable', 'cross-store attacks perform zero total upstream work', 'pre-send refusal performs zero clinical work', 'continuation vectors never reach foreign/admin sink'],
  foreign_selector: ['no foreign patient pair in upstream request'],
  confinement: ['ordinary search retains immutable patient confinement', 'ordinary Patient search retains trusted _id', 'opaque token appears in independent source ledger'],
  clinical_mutation: ['clinical mutation digest unchanged', 'all clinical methods are GET'],
  sink: ['zero target traffic at live sinks'],
} as const);
const prohibited = new Set<string>([...Object.values(PROHIBITED_PREDICATES).flat(), ...Object.values(SCENARIO_CONTRACTS).map(c => c.predicate_id)]);
const disclosures = new Set<string>([...PROHIBITED_PREDICATES.disclosure, ...PROHIBITED_PREDICATES.foreign_selector, ...PROHIBITED_PREDICATES.scenario_disclosure, ...Object.values(SCENARIO_CONTRACTS).map(c => c.predicate_id)]);
export const isProhibited = (f: { predicate: string }) => prohibited.has(f.predicate);
/** The subset a watchdog expiry may already have captured: identity or foreign-selector disclosure. */
export const isDisclosure = (f: { predicate: string }) => disclosures.has(f.predicate);

/** Run context (B2-0): a run can qualify only on the installed package (S9), with no case/lane selection, a fresh
 * build, a clean candidate and matching pins. */
export interface RunContext {
  run_id: string; mode: 'development' | 'qualifying'; qualifying: boolean; reasons_not_qualifying: string[];
  env: { B2_CORE_ONLY: boolean; B2_CASE_IDS: string[]; B2_SKIP_BUILD: boolean; B2_QUALIFY: boolean };
}
export function runContext(env: NodeJS.ProcessEnv = process.env, extra: { dirty?: boolean; pinMismatches?: string[]; installedPackageLane?: boolean; shardsComplete?: boolean } = {}): RunContext {
  const context: RunContext = { run_id: env.B2_RUN_ID ?? 'unbound', mode: 'development', qualifying: false, reasons_not_qualifying: [],
    env: { B2_CORE_ONLY: env.B2_CORE_ONLY === '1', B2_CASE_IDS: env.B2_CASE_IDS ? env.B2_CASE_IDS.split(',').map(s => s.trim()).filter(Boolean) : [], B2_SKIP_BUILD: env.B2_SKIP_BUILD === '1', B2_QUALIFY: env.B2_QUALIFY === '1' } };
  const reasons = context.reasons_not_qualifying;
  if (!context.env.B2_QUALIFY) reasons.push('B2_QUALIFY not set');
  if (context.env.B2_CORE_ONLY) reasons.push('B2_CORE_ONLY selects one lane');
  // Any set selection variable is a selection, even one that parses to no ids (review M8).
  if (env.B2_CASE_IDS !== undefined) reasons.push('B2_CASE_IDS selects cases');
  if (context.env.B2_SKIP_BUILD) reasons.push('B2_SKIP_BUILD: dist/ was not rebuilt from this candidate');
  if (extra.shardsComplete === false) reasons.push('shards or prerequisites missing');
  if (extra.dirty !== false) reasons.push('candidate tree dirty or unknown');
  if (extra.pinMismatches?.length) reasons.push(`pins differ: ${extra.pinMismatches.join(', ')}`);
  if (!extra.installedPackageLane) reasons.push('installed-package lane absent (S9)');
  context.qualifying = reasons.length === 0;
  context.mode = context.qualifying ? 'qualifying' : 'development';
  return context;
}

export interface KillRecord { mutant_id: string; case_id: string; verdict: 'KILLED' | 'SURVIVED' | 'INCONCLUSIVE' | 'INVALID'; inputs_sha256: string; oracle?: string }
const nonemptyEvidence = z.string().min(1);
const killRecordSchema = z.strictObject({ mutant_id: nonemptyEvidence, case_id: nonemptyEvidence, verdict: z.enum(['KILLED', 'SURVIVED', 'INCONCLUSIVE', 'INVALID']), inputs_sha256: nonemptyEvidence, oracle: nonemptyEvidence.optional() });
const killRowSchema = z.strictObject({ mutant_id: nonemptyEvidence, intent: nonemptyEvidence,
  designated: z.array(z.strictObject({ case_id: nonemptyEvidence, oracle: nonemptyEvidence })), spares: z.array(nonemptyEvidence),
  anchor_matches: z.array(z.strictObject({ file: nonemptyEvidence, edit_sha256: nonemptyEvidence, matches: z.number().int().nonnegative() })),
  compiled: z.boolean(), compile_exit: z.number().int().nullable(), build_output_sha256: nonemptyEvidence.nullable(),
  baseline: z.strictObject({ exit: z.number().int(), cases: z.array(CaseReportSchema) }),
  cases: z.array(CaseReportSchema), verdict: z.enum(['KILLED', 'SURVIVED', 'INCONCLUSIVE', 'INVALID']), detail: z.string(), exit: z.number().int().optional(), output_hash: nonemptyEvidence.optional(),
});
const killsFileSchema = z.strictObject({ schema_version: z.string(), run_id: nonemptyEvidence, binding: BindingSchema,
  core_only: z.boolean(), cells_per_case: z.number().int(), candidate: z.strictObject({ inputs_sha256: z.string().nullable(), commit: z.string().optional(), tree: z.string().optional() }),
  rows: z.array(killRowSchema), kills: z.array(killRecordSchema), diagnostic: z.boolean().optional(), scope: z.string().optional(), work_trees_cleaned_on_exit: z.boolean().optional() });
export type KillsFile = z.infer<typeof killsFileSchema>;
/** Derive credit from row executions and the frozen matrix. These local records detect accidental reuse and
 * contradictions, not a person deliberately rewriting both source and evidence (the operator trust boundary). */
export async function readKills(runId: string, inputsSha256: string | undefined, dir: string = join('artifacts', 'b2', runId), context: { binding?: RunBinding; matrix?: KillMatrix; mutants?: RegistryMutant[]; cases?: IsolationCase[] } = {}): Promise<{ kills: KillRecord[]; problems: string[] }> {
  const path = join(dir, 'kills.json');
  if (!existsSync(path)) return { kills: [], problems: [] };
  const parsed = parseEvidence(killsFileSchema, parseEvidenceJSON(readFileSync(path, 'utf8'), 'kills-json'), 'kills-shape');
  const matrix = context.matrix ?? parseKillMatrix(), mutants = context.mutants ?? await registryMutants(), cases = context.cases ?? parseManifest().cases;
  const problems: string[] = [];
  if (parsed.schema_version !== 'b2-kills/1') problems.push('kills-schema: schema differs');
  if (parsed.run_id !== runId) problems.push(`kills-run: kills.json belongs to run ${String(parsed.run_id)}`);
  if (parsed.core_only !== false || parsed.cells_per_case !== 6) problems.push('kills-lanes: kills.json is not a full six-cell run');
  if (inputsSha256 === undefined || parsed.candidate.inputs_sha256 !== inputsSha256) problems.push('kills-candidate: candidate differs');
  const binding = context.binding ?? await runBinding();
  if (!parsed.binding.attempt_id || !binding.attempt_id || !sameBinding(parsed.binding, binding)) problems.push('kills-binding: run/attempt/build binding differs');
  if (parsed.kills.some(k => k.inputs_sha256 !== parsed.candidate.inputs_sha256)) problems.push('kills-record-candidate: record belongs to another candidate');
  const rowIds = parsed.rows.map(r => r.mutant_id), recordIds = parsed.kills.map(k => `${k.mutant_id}|${k.case_id}`);
  if (new Set(rowIds).size !== rowIds.length || new Set(recordIds).size !== recordIds.length) problems.push('kills-duplicate: duplicate rows or records');
  const credited: KillRecord[] = [];
  for (const row of parsed.rows) {
    const frozen = matrix.rows.find(r => r.mutant_id === row.mutant_id), mutant = mutants.find(m => m.id === row.mutant_id);
    const fail = (code: string) => problems.push(`${code}: ${row.mutant_id}`);
    if (!frozen || !mutant || matrix.excluded.includes(row.mutant_id)) { fail('kills-unknown-row'); continue; }
    if (!sameBinding(row.designated, frozen.kills) || !sameBinding(row.spares, frozen.spares)) { fail('kills-matrix'); continue; }
    const anchors = mutant.edits.map(e => ({ file: e.file, edit_sha256: hash(JSON.stringify([e.file, e.find, e.replace])), matches: 1 }));
    if (!sameBinding(row.anchor_matches, anchors)) { fail('kills-anchors'); continue; }
    if (!row.compiled || row.compile_exit !== 0 || !/^[a-f0-9]{64}$/.test(row.build_output_sha256 ?? '')) { fail('kills-compile'); continue; }
    const ids = [...frozen.kills.map(k => k.case_id), ...frozen.spares];
    try { validateAggregate(row.baseline.cases, ids, cases, false); } catch { fail('kills-baseline-cells'); continue; }
    if (row.baseline.exit !== 0 || row.baseline.cases.some(c => c.verdict !== 'PASS')) { fail('kills-baseline'); continue; }
    try { validateAggregate(row.cases, ids, cases, false); } catch { fail('kills-mutant-cells'); continue; }
    const killed = frozen.kills.every(k => {
      const c = row.cases.find(c => c.id === k.case_id)!, spec = cases.find(c => c.id === k.case_id)!;
      return c.lanes.length === 6 && c.lanes.every(l => l.verdict === 'FAIL' && !cellCoverageProblem(spec, { ...l, verdict: 'PASS' }) && l.failures.some(f => `${f.channel}:${f.predicate}` === k.oracle) && !l.failures.some(f => ['harness', 'determinism'].includes(f.channel) || f.predicate === 'required capture exists'));
    });
    const spared = frozen.spares.every(id => row.cases.find(c => c.id === id)?.verdict === 'PASS');
    if (!killed || !spared || row.verdict !== 'KILLED') { fail('kills-execution'); continue; }
    for (const k of frozen.kills) {
      const matches = parsed.kills.filter(r => r.mutant_id === row.mutant_id && r.case_id === k.case_id && r.oracle === k.oracle && r.verdict === 'KILLED');
      if (matches.length !== 1) fail('kills-summary'); else credited.push(matches[0]!);
    }
  }
  if (parsed.kills.some(k => !credited.some(c => sameBinding(c, k)))) problems.push('kills-unproven-record: summary lacks matching row execution');
  return { kills: problems.length ? [] : credited, problems };
}

export type Standing = 'earned' | 'not_counted' | 'counted_unqualified_run' | 'counted_fail' | 'counted_inconclusive' | 'counted_pending' | 'counted_known_failure' | 'stale_known_failure' | 'counted_incomplete' | 'counted_unproven_budget' | 'counted_missing_kill';
export interface CaseStanding { id: string; standing: Standing; counts_toward_b2: boolean; blocking: boolean; detail?: string }
/** Six cells (three lanes, two fresh runs), each PASS with its control and both stubs, full coverage, and a PASS CLI view. */
export function cellsComplete(c: IsolationCase, report: CaseReport): string | undefined {
  try { validateAggregate([report], [c.id], [c], false); }
  catch (e) { return e instanceof AggregateError ? e.code : 'invalid cells'; }
  if (report.lanes.some(l => l.verdict !== 'PASS')) return 'cells not fully passing';
  return undefined;
}
/** A case earns only in a qualifying run: counted, PASS in all six covered cells and controls, no known failure, budgets
 * with verified measured provenance, a non-empty critical set, and every kill-matrix row killed on this candidate. */
export function computeStanding(c: IsolationCase, report: CaseReport | undefined, run: RunContext, kills: KillRecord[], inputsSha256: string | undefined, unprovenBudgets: ReadonlyMap<string, string> = new Map()): CaseStanding {
  const verdict = report?.verdict ?? 'MISSING';
  const incomplete = report ? cellsComplete(c, report) : 'no report';
  const result = (standing: Standing, earned = false, detail?: string): CaseStanding => ({ id: c.id, standing, counts_toward_b2: earned, blocking: c.counted && (verdict !== 'PASS' || incomplete !== undefined), ...(detail ? { detail } : {}) });
  if (!c.counted) return result(c.known_failure && verdict === 'PASS' ? 'stale_known_failure' : 'not_counted');
  if (c.known_failure) return result(verdict === 'PASS' ? 'stale_known_failure' : 'counted_known_failure');
  if (verdict === 'FAIL' || verdict === 'MISSING') return result('counted_fail');
  if (verdict === 'INCONCLUSIVE') return result('counted_inconclusive');
  if (verdict === 'PENDING') return result('counted_pending');
  if (incomplete !== undefined) return result('counted_incomplete', false, incomplete);
  if (unprovenBudgets.has(c.id)) return result('counted_unproven_budget', false, unprovenBudgets.get(c.id));
  if (!run.qualifying) return result('counted_unqualified_run');
  const killed = c.critical_mutants.length > 0 && c.critical_mutants.every(id => kills.some(k => k.mutant_id === id && k.case_id === c.id && k.verdict === 'KILLED' && inputsSha256 !== undefined && k.inputs_sha256 === inputsSha256));
  if (!killed) return result('counted_missing_kill');
  return result('earned', true);
}
export interface GateReport {
  earned: number; diagnostic: boolean; diagnostic_counted_passing: number; standings: CaseStanding[];
  counts: { declared: number; manifested: number; first_slice: { ids: number; manifested: number; passed: number }; independent: number; applicable: number; executed: number; passed: number; failed: number; pending: number; inconclusive: number; unsupported: number;
    controls: { required: number; passed: number; failed: number }; cells: { required: number; executed: number; passed: number; failed: number; inconclusive: number; not_applicable: number }; mutants: { critical_declared: number; valid_kills: number; survived: number; invalid: number; missing: number } };
  b2_gate: { earned: number; required: number; slice_can_qualify: boolean };
  acceptance_gate: { passed: boolean; conjuncts: Record<string, boolean>; blocking_cases: string[]; prohibited_failures: string[] };
  matrix: { cells: number; applicable: number; covered_by_any: number; covered_by_earned: number; uncovered_applicable: string[]; tuples: number; listed: number; ruled_not_applicable: number; missing_tuples: number; ruled_per_rule: Record<string, number>; ruled_per_reviewer: Record<string, number> };
}
export function computeGate(manifest: Manifest, ledger: Ledger, coverage: CoverageMatrix, reports: CaseReport[], run: RunContext, kills: KillRecord[], inputsSha256: string | undefined, prohibitedDisclosure = false, unresolvedDefects: string[] | null = null, extra: { unprovenBudgets?: ReadonlyMap<string, string> } = {}): GateReport {
  const byId = new Map(reports.map(r => [r.id, r]));
  const standings = manifest.cases.map(c => computeStanding(c, byId.get(c.id), run, kills, inputsSha256, extra.unprovenBudgets));
  const earnedIds = new Set(standings.filter(s => s.counts_toward_b2).map(s => s.id));
  const firstSlice = new Set(ledger.records.filter(r => r.first_slice).map(r => `B2-${r.id}`));
  const verdictOf = (id: string) => byId.get(id)?.verdict ?? 'MISSING';
  const cells = reports.flatMap(r => r.lanes);
  const lanesPerCase = run.env.B2_CORE_ONLY ? 2 : 6;
  // A kill counts only on a defined candidate digest (review L1).
  const validKill = (k: KillRecord) => k.verdict === 'KILLED' && inputsSha256 !== undefined && k.inputs_sha256 === inputsSha256;
  const counts: GateReport['counts'] = {
    declared: ledger.records.length, manifested: manifest.cases.length + manifest.aliases.length + manifest.catalogue.length,
    first_slice: { ids: firstSlice.size, manifested: manifest.cases.filter(c => firstSlice.has(c.id)).length, passed: manifest.cases.filter(c => firstSlice.has(c.id) && verdictOf(c.id) === 'PASS').length },
    independent: manifest.cases.filter(c => c.counted).length, applicable: manifest.cases.filter(c => c.counted && c.applicability.status === 'applicable').length,
    executed: reports.filter(r => r.verdict === 'PASS' || r.verdict === 'FAIL').length, passed: reports.filter(r => r.verdict === 'PASS').length, failed: reports.filter(r => r.verdict === 'FAIL').length,
    pending: reports.filter(r => r.verdict === 'PENDING').length, inconclusive: reports.filter(r => r.verdict === 'INCONCLUSIVE').length,
    // Design §4 counts: required lanes a reviewer marked wholly not applicable; counted separately, never earned.
    unsupported: manifest.cases.reduce((n, c) => n + c.lanes.filter(l => Object.values(l.channel_capture).every(ch => ch.status === 'not_applicable')).length, 0),
    controls: { required: manifest.cases.reduce((n, c) => n + c.controls.length, 0), passed: cells.filter(l => l.control_result === 'PASS').length, failed: cells.filter(l => l.control_result === 'FAIL').length },
    cells: { required: manifest.cases.length * lanesPerCase, executed: cells.filter(l => l.verdict === 'PASS' || l.verdict === 'FAIL').length, passed: cells.filter(l => l.verdict === 'PASS').length, failed: cells.filter(l => l.verdict === 'FAIL').length, inconclusive: cells.filter(l => l.verdict === 'INCONCLUSIVE').length, not_applicable: cells.reduce((n, l) => n + l.channels_na.length, 0) },
    mutants: { critical_declared: new Set(manifest.cases.flatMap(c => c.critical_mutants)).size, valid_kills: kills.filter(validKill).length, survived: kills.filter(k => k.verdict === 'SURVIVED').length, invalid: kills.filter(k => k.verdict === 'INVALID').length,
      missing: manifest.cases.flatMap(c => c.critical_mutants.map(id => `${id}|${c.id}`)).filter(key => !kills.some(k => `${k.mutant_id}|${k.case_id}` === key && validKill(k))).length },
  };
  const applicableCells = coverage.cells.filter(cell => cell.applicability.status === 'applicable');
  const uncovered = applicableCells.filter(cell => !cell.covered_by.some(id => earnedIds.has(id))).map(cell => cell.id);
  const completeness = matrixCompleteness(coverage);
  const requiredControlsPass = reports.every(r => r.lanes.every(l => l.control_result === 'PASS'));
  const prohibitedFailures = reports.flatMap(r => r.lanes.flatMap(l => l.failures.filter(isProhibited).map(f => `${r.id}:${l.lane}:${l.run}:${f.channel}:${f.predicate}`)));
  const blockingCases = standings.filter(s => s.blocking).map(s => s.id);
  const conjuncts = {
    qualifying_run: run.qualifying,
    earned_ge_200: earnedIds.size >= B2_REQUIRED_EARNED,
    every_counted_earned: standings.filter(s => manifest.cases.find(c => c.id === s.id)!.counted).every(s => s.counts_toward_b2),
    no_counted_known_failure: manifest.cases.every(c => !c.counted || !c.known_failure),
    no_unproven_budget: (extra.unprovenBudgets?.size ?? 0) === 0,
    every_manifest_case_pass: manifest.cases.every(c => byId.get(c.id)?.verdict === 'PASS'),
    no_blocking_counted_cases: blockingCases.length === 0,
    zero_prohibited_disclosure: !prohibitedDisclosure && prohibitedFailures.length === 0,
    required_controls_pass: requiredControlsPass && reports.length > 0,
    critical_mutants_validly_killed: counts.mutants.missing === 0 && counts.mutants.critical_declared > 0,
    matrix_cells_covered: uncovered.length === 0 && applicableCells.length > 0,
    matrix_complete: completeness.missing === 0,
    ledger_complete: manifest.aliases.length === LEDGER.aliases && manifest.catalogue.length === LEDGER.non_counted,
    no_unresolved_defects: unresolvedDefects !== null && unresolvedDefects.length === 0,
  };
  return {
    earned: earnedIds.size, diagnostic: !run.qualifying, diagnostic_counted_passing: manifest.cases.filter(c => c.counted && verdictOf(c.id) === 'PASS' && !earnedIds.has(c.id)).length, standings, counts,
    b2_gate: { earned: earnedIds.size, required: B2_REQUIRED_EARNED, slice_can_qualify: run.qualifying },
    acceptance_gate: { passed: Object.values(conjuncts).every(Boolean), conjuncts, blocking_cases: blockingCases, prohibited_failures: prohibitedFailures },
    matrix: { cells: coverage.cells.length, applicable: applicableCells.length, covered_by_any: applicableCells.filter(cell => cell.covered_by.length > 0).length, covered_by_earned: applicableCells.length - uncovered.length, uncovered_applicable: uncovered, tuples: completeness.tuples, listed: completeness.listed, ruled_not_applicable: completeness.ruled, missing_tuples: completeness.missing, ruled_per_rule: completeness.ruled_per_rule, ruled_per_reviewer: completeness.ruled_per_reviewer },
  };
}
/** Problems the aggregate reports besides its own refusals: readiness, pins, failing and blocking cases, prohibited
 * failures, stale known failures (review L3), unproven budgets and rejected kill evidence. */
export function gateProblems(input: { status: string; pins: { key: string }[]; reports: CaseReport[]; gate: GateReport; killProblems: string[]; designVerified: boolean }): string[] {
  return [
    ...(input.status !== 'DIAGNOSTIC' ? [`readiness ${input.status}`] : []),
    ...input.pins.map(p => `pin ${p.key} differs`),
    ...(input.designVerified ? [] : ['ledger design digest differs from the design file']),
    ...input.reports.filter(r => r.verdict !== 'PASS').map(r => `case ${r.id}:${r.verdict}`),
    ...input.gate.acceptance_gate.blocking_cases.map(id => `blocking ${id}`),
    ...input.gate.acceptance_gate.prohibited_failures.map(f => `prohibited ${f}`),
    ...input.gate.standings.filter(s => s.standing === 'stale_known_failure').map(s => `stale known failure ${s.id}`),
    ...input.gate.standings.filter(s => s.standing === 'counted_unproven_budget').map(s => `unproven budget ${s.id}: ${s.detail ?? ''}`),
    ...input.killProblems.map(p => `kills: ${p}`),
  ];
}
/** Budget provenance (review M6): a counted case's `budget_source` names a real run report with that digest, from a full
 * six-cell run in which the case passed, whose per-cell maxima equal the declared measurements. */
export function verifyBudgetProvenance(cases: IsolationCase[], readReport: (runId: string) => string | undefined): Map<string, string> {
  const problems = new Map<string, string>();
  for (const c of cases.filter(x => x.counted)) {
    const source = c.budgets.budget_source;
    if (!source) { problems.set(c.id, 'no measured provenance'); continue; }
    const text = readReport(source.run_id);
    if (text === undefined) { problems.set(c.id, `report for run ${source.run_id} is missing`); continue; }
    if (hash(text) !== source.report_sha256) { problems.set(c.id, 'report digest differs from report_sha256'); continue; }
    const raw = parseEvidenceJSON(text, 'provenance-json');
    const shape = z.object({ schema_version: z.string(), status: z.string(), run_id: z.string(),
      binding: BindingSchema, pins: z.object({ verified: z.boolean() }),
      run: z.object({ run_id: z.string(), env: z.object({ B2_CORE_ONLY: z.boolean(), B2_SKIP_BUILD: z.boolean(), B2_CASE_IDS: z.array(z.string()) }) }), cases: z.array(CaseReportSchema) });
    const report = parseEvidence(shape, raw, 'provenance-shape');
    if (report.schema_version !== 'b2-isolation-report/3' || report.status !== 'DIAGNOSTIC' || !report.pins.verified || !report.binding.pins.verified || !report.binding.build.matches_sources || report.binding.build.skipped || !/^[a-f0-9]{64}$/.test(report.binding.build.output_sha256)) { problems.set(c.id, 'provenance-status: measurement is not verified diagnostic evidence'); continue; }
    if (report.run.env.B2_CORE_ONLY || report.run.env.B2_SKIP_BUILD || report.binding.env.B2_CORE_ONLY === '1' || report.binding.env.B2_SKIP_BUILD === '1') { problems.set(c.id, 'measurement run is not a built six-cell run'); continue; }
    if (report.run_id !== source.run_id || report.run.run_id !== source.run_id || report.binding.run_id !== source.run_id || !report.binding.attempt_id || bindingDigest(report.binding) !== source.binding_sha256) { problems.set(c.id, 'provenance-binding: measurement binding differs'); continue; }
    const measuredCase = report.cases.find(r => r.id === c.id);
    if (!measuredCase || measuredCase.verdict !== 'PASS') { problems.set(c.id, 'measurement has no passing case'); continue; }
    try { validateAggregate([measuredCase], [c.id], [c], false); }
    catch (e) { problems.set(c.id, `measurement lacks six passing consistent cells: ${(e as AggregateError).code}`); continue; }
    const max = (f: (l: CellReport) => number) => Math.max(...measuredCase.lanes.map(f));
    const derived = { tool_calls: max(l => l.pre_stub.tool_calls), total_upstream_calls: max(l => l.pre_stub.total_upstream_calls), clinical_calls: max(l => l.pre_stub.clinical), result_bytes: max(l => l.pre_stub.max_call_bytes), cell_ms: max(l => l.timing.cell_ms) };
    const declared = source.measured;
    if ((Object.keys(derived) as (keyof typeof derived)[]).some(key => derived[key] !== declared[key])) problems.set(c.id, `measured ${JSON.stringify(declared)} differs from the report's ${JSON.stringify(derived)}`);
  }
  return problems;
}

const pin = (args: string[]) => { try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return 'unavailable'; } };
const packageVersion = (name: string) => { try { return (JSON.parse(readFileSync(join(process.cwd(), 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version; } catch { return 'unavailable'; } };
const fileHash = (path: string) => { try { return hash(readFileSync(path, 'utf8')); } catch { return 'unavailable'; } };
/** Report inputs read from the installed packages and the repository, never from constants (design §4 reports pin the
 * candidate, package, installed dependency tree, schema, SDK, runtime and OS). */
export function candidateInfo(observedSchemaVersions: string[] = []) {
  const manifestFile = readIsolationFile('cases-v1.json');
  const declared = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const isolationFiles = readdirSync(new URL('.', import.meta.url)).filter(f => /\.(ts|mjs|json|txt)$/.test(f)).sort();
  return {
    commit: pin(['rev-parse', 'HEAD']), tree: pin(['rev-parse', 'HEAD^{tree}']), dirty: Boolean(pin(['status', '--porcelain'])),
    sdk: { client: packageVersion('@modelcontextprotocol/client'), server: packageVersion('@modelcontextprotocol/server'), declared: { ...(declared.dependencies ?? {}), ...(declared.devDependencies ?? {}) } },
    schema: { declared: M3B_SCHEMA_VERSION, observed: [...new Set(observedSchemaVersions)].sort(), consistent: observedSchemaVersions.every(v => v === M3B_SCHEMA_VERSION) },
    manifest_sha256: hash(manifestFile), node: process.version, platform: `${process.platform} ${process.arch}`, platform_name: platform(), os_release: release(),
    package_hash: fileHash('package.json'), ...dependencyDigests(),
    files: Object.fromEntries(isolationFiles.map(f => [f, hash(readIsolationFile(f))])),
  };
}
/** Separator-safe digest of named files (review L5): moving bytes from one file to another changes it. */
export const filesHash = (entries: [string, string][]) => hash(JSON.stringify(entries));
export const FIXTURE_FILES = ['canaries.ts', 'backend.ts', 'scenarios.ts', 'registry.ts', 'stubs.ts', 'drivers.ts'] as const;
export const HARNESS_FILES = ['case-schema.ts', 'design-ledger.ts', 'oracle-registry.ts', 'evidence.ts', 'digests.ts', 'machinery-witnesses.json', 'runner.ts', 'report.ts', 'verifier.ts', 'build.ts', 'shard.ts', 'aggregate.ts', 'run.mjs', 'mutants.mjs', 'generate-manifest.mjs', 'isolation.test.ts', 'counting.test.ts', 'oracles.test.ts'] as const;
/** The harness pin also covers every family shard file, whatever families exist. */
export const harnessFiles = (): string[] => [...HARNESS_FILES, ...readdirSync(new URL('.', import.meta.url)).filter(f => /^cases-[a-z]{3}\.test\.ts$/.test(f)).sort()];
export const fixtureHash = () => filesHash(FIXTURE_FILES.map(f => [f, readIsolationFile(f)]));
export const harnessHash = () => filesHash(harnessFiles().map(f => [f, readIsolationFile(f)]));
/** Only the isolation-relevant registry entries pin the manifest (D7): unit-only registrations elsewhere never force a refresh. */
export function isolationMutantsHash(mutants: RegistryMutant[], killMatrix: KillMatrix): string {
  const listed = new Set(killMatrix.rows.map(r => r.mutant_id));
  const relevant = mutants.filter(m => m.suites.includes('isolation') || listed.has(m.id)).map(m => ({ id: m.id, edits: m.edits, suites: m.suites })).sort((a, b) => a.id.localeCompare(b.id));
  return hash(JSON.stringify(relevant));
}
export function expectedPins(mutants: RegistryMutant[], killMatrix: KillMatrix): Manifest['hashes'] {
  return { fixture: fixtureHash(), scanner: hash(readIsolationFile('scanners.ts')), harness: harnessHash(), matrix: hash(readIsolationFile('coverage-matrix.json')), kill_matrix: hash(readIsolationFile('kill-matrix.json')), ledger: hash(readIsolationFile('ledger-v1.json')), mutants: isolationMutantsHash(mutants, killMatrix) };
}
/** Pin verification lives outside node:test (D1) so a harness mutant is killed by the behaviour it weakens, not by the pin. */
export function verifyPins(manifest: Manifest, mutants: RegistryMutant[], killMatrix: KillMatrix): { key: string; expected: string; actual: string }[] {
  const expected = expectedPins(mutants, killMatrix);
  return (Object.keys(expected) as (keyof Manifest['hashes'])[]).filter(key => manifest.hashes[key] !== expected[key]).map(key => ({ key, expected: expected[key], actual: manifest.hashes[key] }));
}
/** The candidate's inputs digest (tracked and untracked files outside node_modules/dist/.local/artifacts), from the same
 * routine the judge binds its runs to; kill records carry it and only records on the same digest count. */
export async function candidateInputs(checkout: string = process.cwd()): Promise<{ commit: string; tree: string; inputsSha256: string | undefined }> {
  try {
    const gate = await import(new URL('../../scripts/mutation-guards.mjs', import.meta.url).href) as { candidateBinding(checkout?: string): Promise<{ commit: string; tree: string; inputsSha256: string }> };
    const binding = await gate.candidateBinding(checkout);
    return { commit: binding.commit, tree: binding.tree, inputsSha256: binding.inputsSha256 };
  } catch {
    // A copy without a repository (the judge's worker copies carry no .git) has no candidate digest: every kill
    // record then fails to bind and no case can earn (fail closed); the readiness verdict stays diagnostic.
    return { commit: 'unavailable', tree: 'unavailable', inputsSha256: undefined };
  }
}
export const BINDING_ENV = ['B2_CORE_ONLY', 'B2_CASE_IDS', 'B2_SKIP_BUILD', 'B2_QUALIFY'] as const;
/** What a shard or the prerequisites ran on (review H2): the candidate digest, the build, the pins and the selection
 * environment. The aggregator recomputes it and refuses any shard or prerequisites file that differs. */
export type RunBinding = z.infer<typeof BindingSchema>;
export async function runBinding(env: NodeJS.ProcessEnv = process.env): Promise<RunBinding> {
  const inputs = await candidateInputs();
  const pins = verifyPins(parseManifest(), await registryMutants(), parseKillMatrix());
  const skipped = env.B2_SKIP_BUILD === '1';
  return {
    run_id: env.B2_RUN_ID ?? 'unbound', attempt_id: env.B2_ATTEMPT_ID ?? null, dependencies: dependencyDigests(),
    inputs_sha256: inputs.inputsSha256 ?? null, commit: inputs.commit, tree: inputs.tree,
    build: { stamp: sourceStamp(), output_sha256: distDigest(), matches_sources: builtMatchesSource(), skipped },
    pins: { verified: pins.length === 0, mismatches: pins.map(p => p.key) },
    env: Object.fromEntries(BINDING_ENV.map(key => [key, env[key] ?? null])) as RunBinding['env'],
    manifest_sha256: hash(readIsolationFile('cases-v1.json')), node: process.version,
  };
}
// Bindings and content hashes detect reuse/staleness/inconsistency, not deliberate rewriting by a local artifact writer.
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
export const sameBinding = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const bindingDigest = (b: RunBinding) => hash(JSON.stringify(canonical(b)));
export const casesDigest = (reports: CaseReport[]) => hash(JSON.stringify(canonical(reports)));
