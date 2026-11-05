import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SCENARIO_CONTRACTS, overblockingFeature } from './registry.js';
import { extractDesignRecords } from './design-ledger.js';
import { literalOracles, scenarioClauses } from './oracle-registry.js';
export const CHANNELS = ['output_text', 'output_structured', 'raw_frame', 'stderr', 'operational', 'audit', 'state', 'request', 'backend'] as const;
export const LANES = ['core', 'sdk-modern', 'sdk-legacy', 'cli'] as const;
/** Design §3 arithmetic: 287 ledger records = 216 counted + 29 distinct non-counted + 42 aliases. */
export const LEDGER = Object.freeze({ records: 287, counted: 216, non_counted: 29, aliases: 42 });
export const B2_REQUIRED_EARNED = 200;
const bounded = z.string().min(1).max(1024);
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const manifestId = z.string().regex(/^B2-[A-Z]{3}-\d{2}$/);
const capture = z.strictObject({ status: z.enum(['required', 'not_applicable']), reason: bounded, reviewer: bounded });
const captures = z.strictObject(Object.fromEntries(CHANNELS.map(c => [c, capture])) as Record<typeof CHANNELS[number], typeof capture>);
const lane = z.strictObject({ driver: z.enum(LANES), projection: z.array(z.enum(['fhir', 'compact', 'selected'])).min(1).max(3), channel_capture: captures });
const step = z.strictObject({ kind: z.literal('observe'), observation_id: bounded });
const control = z.strictObject({ id: bounded, required: z.literal(true), near_twin_delta: bounded, same_source_state: z.literal(true), steps: z.array(step).min(1).max(64), assertions: z.array(bounded).min(1).max(64), overblocking_challenges: z.array(bounded).min(1).max(10) });
/** A production anchor names shipped runtime source only (review M5): core, server or auth `src`, never a test, the eval
 * harness or a fixture. The legacy scenario-line form is allowed only while a record is not counted (D4). */
export const PRODUCTION_ANCHOR = /^packages\/(?:core|server|auth)\/src\/(?:[\w-]+\/)*[\w-]+(?:\.[\w-]+)*\.ts$/;
const productionFile = z.string().regex(PRODUCTION_ANCHOR).refine(file => !file.endsWith('.test.ts') && !file.endsWith('.d.ts') && !file.split('/').some(segment => segment === '..' || segment === '.'), 'shipped runtime source only');
const sourceAnchor = z.union([z.string().regex(/^tests\/isolation\/scenarios\.ts:\d+$/), z.strictObject({ file: productionFile, find: z.string().min(12).max(400) })]);
const evidenceRecord = z.strictObject({ file: bounded, locator: bounded, vector: bounded, level: z.enum(['helper', 'core', 'sdk', 'cli']), inspected_revision: bounded, run_evidence: z.null() });
const measured = z.strictObject({ tool_calls: z.number().int().nonnegative(), total_upstream_calls: z.number().int().nonnegative(), clinical_calls: z.number().int().nonnegative(), result_bytes: z.number().int().nonnegative(), cell_ms: z.number().int().nonnegative() });
const budgetSource = z.strictObject({ rule: z.literal('exact-max/1'), run_id: bounded, report_sha256: hex64, binding_sha256: hex64, measured });
export const CaseSchema = z.strictObject({
  id: manifestId, family: z.string().regex(/^[A-Z]{3}$/), title: z.string().min(1).max(200), attack_description: bounded,
  obligation_ids: z.array(bounded).min(1).max(10), signature: z.strictObject({ primary_decision: bounded, adversarial_goal: bounded, protected_element_class: bounded, state_transition: bounded, source_anchor: sourceAnchor, discriminating_fault_intent: bounded }),
  independence: bounded, counted: z.boolean(), duplicate_of: z.null(), boundary: z.enum(['decidable', 'residual']), classification: z.enum(['diagnostic', 'B2', 'B3', 'robustness', 'S2', 'residual']), cross_refs: z.array(bounded).min(1).max(10),
  applicability: z.strictObject({ status: z.enum(['applicable', 'not_applicable', 'deferred']), reason: bounded, reviewer: bounded, scope_revision: bounded }),
  fixture_id: z.literal('multi-patient-v1'), behavior_id: bounded, binding_id: z.literal('patient-a'), lanes: z.array(lane).length(4),
  setup: z.array(step).min(1).max(64), attack: z.array(step).min(1).max(64), controls: z.array(control).length(1), followups: z.array(step).max(64),
  oracle_type: z.enum(['pre-send', 'suppression', 'uniform-read', 'continuation', 'locator', 'sanitization', 'logs', 'metadata', 'non-execution', 'counts']),
  expected_outcome_class: bounded, disclosure_class: z.enum(['structured-identity', 'count-relationship', 'forbidden-payload-capability', 'metadata-source-prose', 'operational-identity', 'authority-state', 'induced-request']),
  expected_assertions: z.array(bounded).min(1).max(64), canary_sets: z.array(bounded).min(1).max(10), twin_world: bounded,
  critical_mutants: z.array(bounded).max(50), mutant_intent: bounded.optional(), existing_evidence: z.array(z.union([bounded, evidenceRecord])).max(10),
  budgets: z.strictObject({ max_tool_calls: z.number().int().positive(), max_total_upstream_calls: z.number().int().positive(), max_clinical_calls: z.number().int().nonnegative(), max_result_bytes: z.number().int().positive(), deadline_ms: z.number().int().positive(), max_task_bytes: z.number().int().positive().nullable(), budget_source: budgetSource.nullable() }),
  known_failure: z.strictObject({ reason: bounded, tracking: bounded, since_revision: bounded }).nullable(),
});
/** Merged duplicate of a canonical counted case (design §3): never executable, never counted. */
export const AliasRecord = z.strictObject({ id: manifestId, family: z.string().regex(/^[A-Z]{3}$/), counted: z.literal(false), duplicate_of: manifestId, classification: z.literal('alias'), boundary: z.enum(['decidable', 'residual']), cross_refs: z.array(bounded).min(1).max(10), review_rationale: bounded, reviewer: bounded });
/** Distinct case outside counted B2 (design Appendix A/B): visible in the ledger, never counted. */
export const CatalogueRecord = z.strictObject({ id: manifestId, family: z.string().regex(/^[A-Z]{3}$/), title: z.string().min(1).max(200), counted: z.literal(false), duplicate_of: z.null(), classification: z.enum(['B3', 'robustness', 'S2', 'residual']), boundary: z.enum(['decidable', 'residual']), cross_refs: z.array(bounded).min(1).max(10), rationale: bounded, reviewer: bounded });
export const ManifestSchema = z.strictObject({
  schema_version: z.literal('b2-isolation-manifest/1'), suite_id: z.enum(['b2-v1-first-slice', 'b2-v1']), scope: bounded, scope_revision: bounded,
  fixed_time: z.iso.datetime(), seed: bounded, hashes: z.strictObject({ fixture: hex64, matrix: hex64, scanner: hex64, mutants: hex64, harness: hex64, kill_matrix: hex64, ledger: hex64 }),
  required_eras: z.array(z.enum(['2026-07-28', '2025-11-25'])).length(2).refine(eras => new Set(eras).size === 2, 'two distinct eras'),
  prerequisite_ids: z.array(bounded).min(8).max(30), frozen_ids: z.array(manifestId).min(1).max(216), cases: z.array(CaseSchema).min(1).max(216),
  aliases: z.array(AliasRecord).max(42), catalogue: z.array(CatalogueRecord).max(29),
});
export const LedgerSchema = z.strictObject({
  schema_version: z.literal('b2-ledger/1'), source: bounded, design_sha256: hex64,
  counts: z.strictObject({ records: z.number().int(), counted: z.number().int(), non_counted: z.number().int(), aliases: z.number().int(), first_slice: z.number().int() }),
  families: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().int().positive()),
  records: z.array(z.strictObject({ id: z.string().regex(/^[A-Z]{3}-\d{2}$/), family: z.string().regex(/^[A-Z]{3}$/), class: z.enum(['counted', 'alias', 'B3', 'robustness', 'S2', 'residual']), duplicate_of: z.string().regex(/^[A-Z]{3}-\d{2}$/).nullable(), mapped_shape: z.boolean(), first_slice: z.boolean(), design_line: z.number().int().positive() })).min(1).max(400),
});
export const KillMatrixSchema = z.strictObject({
  schema_version: z.literal('b2-kill-matrix/1'), scope: bounded, excluded: z.array(bounded).max(20),
  rows: z.array(z.strictObject({ mutant_id: bounded, intent: bounded, kills: z.array(z.strictObject({ case_id: manifestId, oracle: z.string().regex(/^[a-z_]+:\S(?:[^\r\n]{1,198}\S)$/) })).min(1).max(64), spares: z.array(manifestId).max(64), executed_all_lane_kill: z.boolean() })).max(600),
  verifier_challenges: z.array(bounded).max(200),
});
const subjectId = z.string().regex(/^(patient|shared|ambiguous):[A-Za-z-]+$/);
export const MATRIX_AXES = {"requirement":["CA-ISO-01","CA-ISO-02","CA-ISO-03","CA-ISO-04","CA-ISO-05","CA-ISO-05a","CA-ISO-05b","CA-ISO-05c","CA-ISO-05d"],"tool":["fhir_capabilities","fhir_search","fhir_read","fhir_page","fhir_result"],"subject":[{"id":"patient:Patient","required":true},{"id":"patient:Observation","required":true},{"id":"patient:Condition","required":true},{"id":"patient:AllergyIntolerance","required":true},{"id":"patient:MedicationRequest","required":true},{"id":"patient:MedicationStatement","required":true},{"id":"patient:Encounter","required":true},{"id":"patient:DocumentReference","required":true},{"id":"patient:DiagnosticReport","required":true},{"id":"patient:Immunization","required":true},{"id":"patient:Procedure","required":true},{"id":"patient:Coverage","required":true},{"id":"patient:ExplanationOfBenefit","required":true},{"id":"patient:ServiceRequest","required":true},{"id":"patient:Claim","required":true},{"id":"shared:Medication","required":true},{"id":"shared:Organization","required":true},{"id":"shared:Location","required":true},{"id":"shared:Practitioner","required":true},{"id":"shared:CodeSystem","required":true},{"id":"shared:ValueSet","required":true},{"id":"shared:StructureDefinition","required":true},{"id":"shared:SearchParameter","required":true},{"id":"shared:CapabilityStatement","required":true},{"id":"shared:OperationDefinition","required":true},{"id":"ambiguous:RelatedPerson","required":true},{"id":"ambiguous:Group","required":true},{"id":"ambiguous:Provenance","required":true},{"id":"ambiguous:AuditEvent","required":true},{"id":"ambiguous:contained-child","required":true}],"interaction":["read","search","continuation","include","retained-project","retained-inspect","metadata"],"channel":["output","retained"]} as const;
const MATRIX_KEYS = ['requirement', 'tool', 'subject', 'interaction', 'channel'] as const;
/** A reviewed not-applicable rule over the matrix axes (review L9): every tuple it matches is N/A with this reviewer.
 * A subject may be a class wildcard (`patient:*`). An empty `when` would mark everything N/A and is refused. */
const naRule = z.strictObject({ id: z.string().regex(/^NA-\d{3}$/), when: z.strictObject({ requirement: bounded.optional(), tool: bounded.optional(), subject: z.string().regex(/^(patient|shared|ambiguous):([A-Za-z-]+|\*)$/).optional(), interaction: bounded.optional(), channel: bounded.optional() }), reason: bounded, reviewer: bounded });
export const CoverageMatrixSchema = z.strictObject({
  schema_version: z.literal('b2-coverage-matrix/1'), scope_revision: bounded,
  axes: z.strictObject({ requirement: z.array(bounded).min(1).max(64), tool: z.array(z.enum(['fhir_capabilities', 'fhir_search', 'fhir_read', 'fhir_page', 'fhir_result'])).min(1).max(5), subject: z.array(z.strictObject({ id: subjectId, required: z.boolean() })).min(1).max(64), interaction: z.array(z.enum(['read', 'search', 'continuation', 'include', 'retained-project', 'retained-inspect', 'metadata'])).min(1).max(7), channel: z.array(z.enum(['output', 'retained'])).min(1).max(2) }),
  cells: z.array(z.strictObject({ id: z.string().regex(/^MX-\d{4}$/), requirement: bounded, tool: bounded, subject: subjectId, interaction: bounded, channel: bounded,
    applicability: z.union([z.strictObject({ status: z.literal('applicable') }), z.strictObject({ status: z.literal('not_applicable'), reason: bounded, reviewer: bounded })]), covered_by: z.array(manifestId).max(64) })).min(1).max(4096),
  not_applicable_rules: z.array(naRule).max(200),
});
/** Draft 2020-12, closed objects at every record; useful to root without installing a validator. */
export const caseJsonSchema = z.toJSONSchema(ManifestSchema, { target: 'draft-2020-12' });
export type IsolationCase = z.infer<typeof CaseSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
export type Ledger = z.infer<typeof LedgerSchema>;
export type KillMatrix = z.infer<typeof KillMatrixSchema>;
export type CoverageMatrix = z.infer<typeof CoverageMatrixSchema>;
export type Lane = typeof LANES[number];
export type Channel = typeof CHANNELS[number];
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const readIsolationFile = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
/** Every loader rejection names a stable code, so a removed check cannot hide behind another check that also throws. */
export class ManifestError extends Error {
  constructor(readonly code: string, readonly id?: string, detail?: string) { super(`${code}${id ? ` (${id})` : ''}${detail ? `: ${detail}` : ''}`); }
}
export interface RegistryMutant { id: string; suites: string[]; edits: { file: string; find: string; replace: string }[] }
export interface SemanticContext {
  ledger: Ledger; killMatrix: KillMatrix; coverage: CoverageMatrix; mutants: RegistryMutant[];
  /** Repository-relative production source for anchor checks; throws when the file is missing. */
  readSource(file: string): string;
  scenarioSource: string; runnerSource: string; stubsSource: string;
}
export function parseManifest(input: unknown = JSON.parse(readIsolationFile('cases-v1.json'))): Manifest {
  try { return ManifestSchema.parse(input); } catch (e) { throw new ManifestError('schema', undefined, (e as Error).message.slice(0, 400)); }
}
export function parseLedger(input: unknown = JSON.parse(readIsolationFile('ledger-v1.json'))): Ledger {
  const ledger = LedgerSchema.parse(input);
  const counts = { records: ledger.records.length,
    counted: ledger.records.filter(r => r.class === 'counted').length,
    non_counted: ledger.records.filter(r => !['counted', 'alias'].includes(r.class)).length, aliases: ledger.records.filter(r => r.class === 'alias').length, first_slice: ledger.records.filter(r => r.first_slice).length };
  if (counts.records !== LEDGER.records || counts.counted !== LEDGER.counted || counts.non_counted !== LEDGER.non_counted || counts.aliases !== LEDGER.aliases) throw new ManifestError('ledger-count', undefined, JSON.stringify(counts));
  // The declared counts block equals the records, field by field, first_slice included (review M10).
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) if (ledger.counts[key] !== counts[key]) throw new ManifestError('ledger-count', undefined, `counts.${key} ${ledger.counts[key]} differs from the records' ${counts[key]}`);
  for (const record of ledger.records) {
    if (!record.id.startsWith(`${record.family}-`)) throw new ManifestError('ledger-family', record.id, record.family);
    // duplicate_of is set exactly on aliases: a counted record carrying one is an alias in disguise (review M10).
    if ((record.class === 'alias') !== (record.duplicate_of !== null)) throw new ManifestError('ledger-alias-shape', record.id, record.class);
  }
  const countedFamilies = [...new Set(ledger.records.filter(r => r.class === 'counted').map(r => r.family))].sort();
  if (Object.keys(ledger.families).sort().join() !== countedFamilies.join()) throw new ManifestError('ledger-count', undefined, 'families block differs from the counted families');
  for (const [family, expected] of Object.entries(ledger.families)) if (ledger.records.filter(r => r.family === family && r.class === 'counted').length !== expected) throw new ManifestError('ledger-count', family, 'family count differs from the design');
  if (new Set(ledger.records.map(r => r.id)).size !== ledger.records.length) throw new ManifestError('id-recycled', undefined, 'ledger');
  return ledger;
}
/** The ledger was extracted from the design document it names (review M10); checked by the aggregator and a counting test. */
export const verifyLedgerDesign = (ledger: Ledger, designText: string) => {
  if (hash(designText) !== ledger.design_sha256) return false;
  const fields = (r: Ledger['records'][number]) => [r.id, r.family, r.class, r.duplicate_of, r.first_slice];
  const expected = extractDesignRecords(designText).map(fields);
  return JSON.stringify(ledger.records.slice().sort((a, b) => a.id.localeCompare(b.id)).map(fields)) === JSON.stringify(expected);
};
export const readDesign = () => readFileSync(new URL('../../proposals/b2-isolation-suite-design.md', import.meta.url), 'utf8');
export function parseKillMatrix(input: unknown = JSON.parse(readIsolationFile('kill-matrix.json'))): KillMatrix { return KillMatrixSchema.parse(input); }
const ruleMatches = (rule: z.infer<typeof naRule>, tuple: Record<typeof MATRIX_KEYS[number], string>) => MATRIX_KEYS.every(key => {
  const want = rule.when[key];
  if (want === undefined) return true;
  return key === 'subject' && want.endsWith(':*') ? tuple.subject.startsWith(want.slice(0, -1)) : tuple[key] === want;
});
export function parseCoverageMatrix(input: unknown = JSON.parse(readIsolationFile('coverage-matrix.json'))): CoverageMatrix {
  const matrix = CoverageMatrixSchema.parse(input);
  for (const key of MATRIX_KEYS) if (JSON.stringify([...matrix.axes[key]].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))) !== JSON.stringify([...MATRIX_AXES[key]].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))) throw new ManifestError('matrix-universe', key);
  const ids = new Set<string>(); const tuples = new Set<string>();
  const subjects = new Set(matrix.axes.subject.map(s => s.id));
  const axis = (key: typeof MATRIX_KEYS[number], value: string) => key === 'subject' ? subjects.has(value) : (matrix.axes[key] as readonly string[]).includes(value);
  for (const cell of matrix.cells) {
    if (ids.has(cell.id)) throw new ManifestError('matrix-duplicate-id', cell.id); ids.add(cell.id);
    const tuple = [cell.requirement, cell.tool, cell.subject, cell.interaction, cell.channel].join('|');
    if (tuples.has(tuple)) throw new ManifestError('matrix-repeated-cell', cell.id); tuples.add(tuple);
    if (!MATRIX_KEYS.every(key => axis(key, cell[key]))) throw new ManifestError('matrix-axis', cell.id);
  }
  for (const subject of matrix.axes.subject) if (subject.required && !matrix.cells.some(c => c.subject === subject.id)) throw new ManifestError('matrix-subject-missing', subject.id);
  const ruleIds = new Set<string>();
  for (const rule of matrix.not_applicable_rules) {
    if (ruleIds.has(rule.id)) throw new ManifestError('matrix-rule', rule.id, 'duplicate id'); ruleIds.add(rule.id);
    const keys = MATRIX_KEYS.filter(key => rule.when[key] !== undefined);
    if (keys.length < 2) throw new ManifestError('matrix-rule', rule.id, 'at least two constrained axes');
    for (const key of keys) { const value = rule.when[key]!; if (!(key === 'subject' && value.endsWith(':*')) && !axis(key, value)) throw new ManifestError('matrix-axis', rule.id, `${key}=${value}`); }
    const matched = matrixTuples(matrix).filter(tuple => ruleMatches(rule, tuple)).length;
    if (matched > 1000) throw new ManifestError('matrix-rule-size', rule.id, String(matched));
    const conflict = matrix.cells.find(cell => cell.applicability.status === 'applicable' && ruleMatches(rule, cell));
    if (conflict) throw new ManifestError('matrix-rule-conflict', rule.id, `marks applicable cell ${conflict.id} not applicable`);
  }
  return matrix;
}
/** The matrix crosses every axis (design §4): each tuple is a listed cell or matches a reviewed N/A rule; the rest are
 * missing and keep the `matrix_complete` gate conjunct false. */
function matrixTuples(matrix: CoverageMatrix) {
  const tuples: Record<typeof MATRIX_KEYS[number], string>[] = [];
  for (const requirement of matrix.axes.requirement) for (const tool of matrix.axes.tool) for (const { id: subject } of matrix.axes.subject) for (const interaction of matrix.axes.interaction) for (const channel of matrix.axes.channel) tuples.push({ requirement, tool, subject, interaction, channel });
  return tuples;
}
export function matrixCompleteness(matrix: CoverageMatrix) {
  const key = (tuple: Record<typeof MATRIX_KEYS[number], string>) => MATRIX_KEYS.map(k => tuple[k]).join('|');
  const listed = new Set(matrix.cells.map(key));
  const tuples = matrixTuples(matrix), missing: string[] = [], byRule: Record<string, number> = {}, byReviewer: Record<string, number> = {};
  const reviewerTuples = new Map<string, Set<string>>(); let ruled = 0;
  for (const rule of matrix.not_applicable_rules) byRule[rule.id] = 0;
  for (const tuple of tuples) {
    const matches = matrix.not_applicable_rules.filter(rule => ruleMatches(rule, tuple));
    for (const rule of matches) { byRule[rule.id]!++; const seen = reviewerTuples.get(rule.reviewer) ?? new Set<string>(); seen.add(key(tuple)); reviewerTuples.set(rule.reviewer, seen); }
    if (listed.has(key(tuple))) continue;
    if (matches.length) ruled++; else missing.push(key(tuple));
  }
  for (const [reviewer, seen] of reviewerTuples) byReviewer[reviewer] = seen.size;
  return { tuples: tuples.length, listed: listed.size, ruled, missing: missing.length, missing_sample: missing.slice(0, 10), ruled_per_rule: byRule, ruled_per_reviewer: byReviewer };
}
const short = (id: string) => id.replace(/^B2-/, '');
/** Punctuation-free lower-case tokens (review M4): "Bypass: X." and "bypass  the X decision" reduce to the same words. */
export const tokens = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const TEMPLATE_WORDS = new Set(['bypass', 'bypasses', 'bypassed', 'bypassing', 'the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'decision', 'is', 'are', 'be', 'by', 'it', 'its', 'this', 'that', 'case', 'fault', 'remove', 'removes', 'removed', 'only', 'attack', 'feature', 'skip', 'skips', 'skipped', 'disable', 'disables', 'disabled', 'drop', 'drops', 'dropped', 'break', 'breaks', 'broken', 'check', 'guard', 'rule', 'not', 'no']);
/** True when every content word is a template word or comes from the given template texts. */
const contentTokens = (value: string, sources: string[]) => { const allowed = new Set(sources.flatMap(tokens)); return tokens(value).filter(token => !TEMPLATE_WORDS.has(token) && !allowed.has(token)); };
const nonAsciiLetters = (value: string) => /[^\x00-\x7f]/u.test(value.replace(/[^\p{L}]/gu, ''));
const templated = (value: string, sources: string[], minimumContent = 4) => nonAsciiLetters(value) || new Set(contentTokens(value, sources)).size < minimumContent;
/** Occurrences counted with step 1, so overlapping matches are not merged (review M5). */
export const occurrences = (text: string, find: string) => { let n = 0; for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) n++; return n; };
/** Scenario blocks that share one executable body: `case 'X': case 'Y': {` labels in scenarios.ts. */
export function scenarioBodies(source: string): Map<string, string> { return scenarioClauses(source); }
export function namedOracles(ctx: Pick<SemanticContext, 'scenarioSource' | 'runnerSource' | 'stubsSource'>): Set<string> {
  return new Set([...Object.values(SCENARIO_CONTRACTS).map(c => `output_structured:${c.predicate_id}`),
    ...literalOracles(ctx.scenarioSource), ...commonOracles(ctx)]);
}
function commonOracles(ctx: Pick<SemanticContext, 'runnerSource' | 'stubsSource'>): Set<string> {
  return new Set([...literalOracles(ctx.runnerSource), ...literalOracles(ctx.stubsSource),
    ...CHANNELS.map(ch => `${ch}:forbidden marker absent`), ...['deny-all', 'overblocking'].map(kind => `control:${kind} rejected by positive control`)]);
}
export const canonicalEdits = (edits: RegistryMutant['edits']) => JSON.stringify(edits.map(e => [e.file.replaceAll('\\', '/'), e.find.replaceAll('\r\n', '\n'), e.replace.replaceAll('\r\n', '\n')]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
export function editsAnchor(edit: RegistryMutant['edits'][number], anchor: { find: string }): boolean {
  const start = edit.find.indexOf(anchor.find); if (start < 0 || edit.replace.includes(anchor.find)) return false;
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(edit.find.length, edit.replace.length) && edit.find[prefix] === edit.replace[prefix]) prefix++;
  while (suffix < Math.min(edit.find.length, edit.replace.length) - prefix && edit.find.at(-suffix - 1) === edit.replace.at(-suffix - 1)) suffix++;
  return start < edit.find.length - suffix && start + anchor.find.length > prefix;
}
function anchorSiblings(a: IsolationCase, b: IsolationCase, ctx: SemanticContext): boolean {
  const x = a.signature.source_anchor, y = b.signature.source_anchor;
  if (typeof x === 'string' || typeof y === 'string' || x.file !== y.file) return false;
  const source = ctx.readSource(x.file), at = source.indexOf(x.find), bt = source.indexOf(y.find);
  if (at < 0 || bt < 0) return false;
  if (at < bt + y.find.length && bt < at + x.find.length) return true;
  return ctx.mutants.flatMap(m => m.edits).some(edit => {
    if (edit.file !== x.file) return false; const from = source.indexOf(edit.find);
    return from >= 0 && at >= from && bt >= from && at + x.find.length <= from + edit.find.length && bt + y.find.length <= from + edit.find.length;
  });
}
export function checkSemantics(manifest: Manifest, ctx: SemanticContext): Manifest {
  if (manifest.required_eras.slice().sort().join() !== ['2025-11-25', '2026-07-28'].join()) throw new ManifestError('required-eras');
  const ledgerById = new Map(ctx.ledger.records.map(r => [r.id, r]));
  const all = [...manifest.cases.map(c => ({ id: c.id, family: c.family, cls: 'counted' as const })), ...manifest.aliases.map(a => ({ id: a.id, family: a.family, cls: 'alias' as const })), ...manifest.catalogue.map(r => ({ id: r.id, family: r.family, cls: r.classification }))];
  const seen = new Set<string>();
  for (const record of all) {
    if (seen.has(record.id)) throw new ManifestError('id-recycled', record.id); seen.add(record.id);
    if (!record.id.startsWith(`B2-${record.family}-`)) throw new ManifestError('family-mismatch', record.id);
    const entry = ledgerById.get(short(record.id));
    if (!entry) throw new ManifestError('ledger-unknown', record.id);
    // Carries the design's "apparent 216 by counting aliases, B3 or repeated cells" rule: a manifest case is always a
    // ledger `counted` record (the former frozen-class and count-inflation codes were unreachable behind this one, L2).
    if (entry.family !== record.family || entry.class !== record.cls) throw new ManifestError('ledger-mismatch', record.id, `${entry.class} vs ${record.cls}`);
  }
  if (manifest.cases.map(c => c.id).sort().join() !== [...manifest.frozen_ids].sort().join()) throw new ManifestError('frozen-set');
  for (const alias of manifest.aliases) {
    const target = ledgerById.get(short(alias.duplicate_of));
    if (!target || target.class !== 'counted') throw new ManifestError('alias-target', alias.id);
    if (ledgerById.get(short(alias.id))?.duplicate_of !== short(alias.duplicate_of)) throw new ManifestError('alias-target', alias.id, 'ledger target differs');
  }
  // The cycle check is defence in depth; the one-hop rule independently rejects alias chains.
  // A ledger alias points at exactly one canonical counted record: cycles, alias-to-alias chains and aliases of B3,
  // robustness, S2 or residual records are all refused (review M10).
  for (const entry of ctx.ledger.records.filter(r => r.class === 'alias')) {
    const walked = new Set<string>([entry.id]); let cursor = entry.duplicate_of; let hops = 0; let target: Ledger['records'][number] | undefined;
    while (cursor) { if (walked.has(cursor)) throw new ManifestError('alias-cycle', entry.id); walked.add(cursor); const next = ledgerById.get(cursor); if (!next) throw new ManifestError('alias-target', entry.id); hops++; target = next; if (next.class !== 'alias') break; cursor = next.duplicate_of; }
    if (hops !== 1) throw new ManifestError('alias-target', entry.id, 'alias chain');
    if (target?.class !== 'counted') throw new ManifestError('alias-target', entry.id, `alias of a ${target?.class} record`);
  }
  const mutantsById = new Map(ctx.mutants.map(m => [m.id, m]));
  const executable = new Set(manifest.cases.map(c => c.id));
  const oracles = namedOracles(ctx);
  // Every kill-matrix row is validated at load, counted or not (review M7): mutants.mjs judges all of them.
  for (const id of ctx.killMatrix.excluded) if (!mutantsById.has(id)) throw new ManifestError('kill-excluded', id, 'not registered');
  const rowIds = new Set<string>(); const editSets = new Set<string>();
  const clauses = scenarioClauses(ctx.scenarioSource), common = commonOracles(ctx);
  for (const row of ctx.killMatrix.rows) {
    if (rowIds.has(row.mutant_id)) throw new ManifestError('kill-row-duplicate', row.mutant_id); rowIds.add(row.mutant_id);
    const mutant = mutantsById.get(row.mutant_id);
    if (!mutant || !mutant.suites.includes('isolation') || ctx.killMatrix.excluded.includes(row.mutant_id)) throw new ManifestError('kill-row-mutant', row.mutant_id, !mutant ? 'not registered' : ctx.killMatrix.excluded.includes(row.mutant_id) ? 'excluded' : 'not in the isolation suite');
    const editSet = canonicalEdits(mutant.edits);
    if (editSets.has(editSet)) throw new ManifestError('kill-row-identical-edits', row.mutant_id); editSets.add(editSet);
    const killed = row.kills.map(k => k.case_id);
    if (new Set(killed).size !== killed.length || new Set(row.spares).size !== row.spares.length || [...killed, ...row.spares].some(id => !executable.has(id)) || row.spares.some(id => killed.includes(id))) throw new ManifestError('kill-row-case', row.mutant_id);
    for (const kill of row.kills) {
      if (!oracles.has(kill.oracle)) throw new ManifestError('kill-row-oracle', row.mutant_id, kill.oracle);
      const own = SCENARIO_CONTRACTS[kill.case_id as keyof typeof SCENARIO_CONTRACTS]?.predicate_id;
      if (kill.oracle !== `output_structured:${own}` && !common.has(kill.oracle) && !literalOracles(clauses.get(kill.case_id) ?? '').has(kill.oracle)) throw new ManifestError('kill-case-oracle', row.mutant_id, kill.oracle);
    }
  }
  const challenges = ctx.killMatrix.verifier_challenges;
  if (new Set(challenges).size !== challenges.length || challenges.some(id => !id.startsWith('b2m-') || rowIds.has(id) || !mutantsById.get(id)?.suites.includes('isolation'))) throw new ManifestError('kill-challenge', undefined, 'verifier challenges are distinct registered isolation-suite b2m-* mutants outside the rows');
  const signatures = new Set<string>(); const controls = new Set<string>(); const faults = new Map<string, string>();
  const bodies = scenarioBodies(ctx.scenarioSource);
  const killVectors = new Map<string, string>();
  const predicateIds = new Set<string>(Object.values(SCENARIO_CONTRACTS).map(contract => contract.predicate_id));
  const counted = manifest.cases.filter(c => c.counted);
  const countedIds = new Set(counted.map(c => c.id));
  for (const c of manifest.cases) {
    const vector = short(c.id);
    if (c.setup.map(s => s.observation_id).join() !== 'liveness' || c.attack.map(s => s.observation_id).join() !== vector || c.followups.map(s => s.observation_id).join() !== 'all-returned-handles' || c.controls.some(ctrl => ctrl.steps.map(s => s.observation_id).join() !== `${vector}-control`)) throw new ManifestError('steps', c.id);
    const s = c.signature;
    // Conflicting signatures are refused before the contract comparison, which they would otherwise always trip (L2).
    const signature = hash(JSON.stringify([s.primary_decision, s.adversarial_goal, s.protected_element_class, s.state_transition]));
    if (signatures.has(signature)) throw new ManifestError('signature-collision', c.id); signatures.add(signature);
    const contract = SCENARIO_CONTRACTS[c.id as keyof typeof SCENARIO_CONTRACTS];
    if (!contract || c.oracle_type !== contract.oracle || c.expected_outcome_class !== contract.outcome || s.primary_decision !== contract.decision || s.adversarial_goal !== contract.goal || !c.expected_assertions.includes(contract.predicate_id) || !predicateIds.has(contract.predicate_id)) throw new ManifestError('contract', c.id);
    if (c.controls.length !== 1) throw new ManifestError('control-contract', c.id, 'exactly one executable control');
    const ctrl = c.controls[0]!; const feature = overblockingFeature(c.id);
    if (ctrl.assertions.slice().sort().join() !== [`${contract.predicate_id}.positive`, `b2.control.${feature}`].sort().join() || ctrl.overblocking_challenges.join() !== feature) throw new ManifestError('control-contract', c.id);
    const knownAssertions = new Set([...predicateIds, 'b2.all.forbidden-markers-absent', 'b2.all.egress-bound']);
    if (new Set(c.expected_assertions).size !== c.expected_assertions.length || c.expected_assertions.some(id => !knownAssertions.has(id))) throw new ManifestError('assertion-contract', c.id);
    if (new Set(c.lanes.map(l => l.driver)).size !== 4) throw new ManifestError('missing-lane', c.id);
    for (const ctrl of c.controls) { if (controls.has(ctrl.id)) throw new ManifestError('duplicate-control', c.id); controls.add(ctrl.id); }
    for (const l of c.lanes) for (const ch of CHANNELS) {
      const na = l.driver === 'core' ? ['raw_frame', 'stderr'].includes(ch) : ['audit', 'state'].includes(ch);
      if ((l.channel_capture[ch].status === 'not_applicable') !== na) throw new ManifestError('channel-applicability', c.id);
    }
    for (const id of c.critical_mutants) if (!mutantsById.has(id)) throw new ManifestError('kill-mutant', c.id, id);
    if (c.budgets.max_task_bytes !== null) throw new ManifestError('task-bytes', c.id);
    if (!c.counted) continue;
    // Count condition and the templated-field rejections apply only to counted records (design §4, RP-71).
    if (c.classification !== 'B2' || c.boundary !== 'decidable' || c.applicability.status !== 'applicable' || !c.controls.every(ctrl => ctrl.required) || c.mutant_intent !== undefined) throw new ManifestError('count-condition', c.id);
    const fault = contentTokens(s.discriminating_fault_intent, []).join(' ');
    const allFaultTokens = tokens(s.discriminating_fault_intent).join(' ');
    if (templated(s.discriminating_fault_intent, [contract.decision, contract.goal, c.independence]) || ` ${allFaultTokens} `.includes(` ${tokens(vector).join(' ')} `) || s.discriminating_fault_intent.trim().length < 40) throw new ManifestError('template-fault', c.id);
    if (faults.has(fault)) throw new ManifestError('template-fault', c.id, `shared with ${faults.get(fault)}`); faults.set(fault, c.id);
    if (typeof s.source_anchor === 'string') throw new ManifestError('template-anchor', c.id);
    if (s.source_anchor.file.includes('..') || !PRODUCTION_ANCHOR.test(s.source_anchor.file) || s.source_anchor.file.endsWith('.test.ts')) throw new ManifestError('template-anchor', c.id, 'not shipped runtime source');
    let source: string; try { source = ctx.readSource(s.source_anchor.file); } catch { throw new ManifestError('anchor-match', c.id, 'file missing'); }
    if (occurrences(source, s.source_anchor.find) !== 1) throw new ManifestError('anchor-match', c.id);
    const anchor = s.source_anchor;
    const killingRows = ctx.killMatrix.rows.filter(row => row.kills.some(k => k.case_id === c.id));
    // The killing mutant edits the anchored file itself, at a find that contains the anchor (review M5).
    if (!killingRows.some(row => mutantsById.get(row.mutant_id)?.edits.some(edit => edit.file === anchor.file && edit.find.includes(anchor.find) && editsAnchor(edit, anchor)))) throw new ManifestError('anchor-fault', c.id);
    if (c.budgets.budget_source === null) throw new ManifestError('template-budget', c.id, 'no measured provenance');
    const derived = deriveBudgets(c.budgets.budget_source.measured);
    if (JSON.stringify({ ...c.budgets, budget_source: null }) !== JSON.stringify({ ...derived, budget_source: null })) throw new ManifestError('template-budget', c.id, 'budgets differ from exact-max/1');
    if (c.existing_evidence.some(entry => typeof entry === 'string')) throw new ManifestError('template-evidence', c.id);
    for (const ctrl of c.controls) if (templated(ctrl.near_twin_delta, [contract.goal, contract.decision, c.independence], 3)) throw new ManifestError('template-twin', c.id);
    if (nonAsciiLetters(s.state_transition) || tokens(s.state_transition).join(' ').endsWith('control then attack and retained followups')) throw new ManifestError('template-transition', c.id);
    if (!c.critical_mutants.length || c.critical_mutants.slice().sort().join() !== killingRows.map(r => r.mutant_id).sort().join()) throw new ManifestError('kill-ref', c.id);
    // Independence (design §2: "a common mutation is insufficient to count multiple rows"): no two counted cases share a
    // critical set, and each counted case has a discriminating row that kills no other counted case and lists every
    // counted sibling sharing its scenario body or production anchor as a spare that must pass (review M3).
    const vectorKey = c.critical_mutants.slice().sort().join();
    if (killVectors.has(vectorKey)) throw new ManifestError('kill-indistinct', c.id, `same critical set as ${killVectors.get(vectorKey)}`); killVectors.set(vectorKey, c.id);
    const siblings = counted.filter(other => other.id !== c.id && ((bodies.get(other.id) ?? other.id) === (bodies.get(c.id) ?? c.id) || other.family === c.family || anchorSiblings(c, other, ctx))).map(other => other.id);
    const discriminating = killingRows.some(row => row.kills.every(k => k.case_id === c.id || !countedIds.has(k.case_id)) && siblings.every(id => row.spares.includes(id)));
    if (!discriminating) throw new ManifestError('kill-indistinct', c.id, `no row kills it alone with its counted siblings (${siblings.join(', ') || 'none'}) as spares`);
    if (!ctx.coverage.cells.some(cell => cell.applicability.status === 'applicable' && cell.covered_by.includes(c.id))) throw new ManifestError('matrix-orphan', c.id);
  }
  for (const cell of ctx.coverage.cells) for (const id of cell.covered_by) if (!executable.has(id)) throw new ManifestError('matrix-cover', cell.id, id);
  return manifest;
}
export const SHIPPED_LIMITS = Object.freeze({ maxBytes: 60000, deadlineMinMs: 15000, deadlineMaxMs: 60000 });
/** Rule `exact-max/1`: each ceiling is the exact maximum over the six passing cells of a full measured run (D5). */
export function deriveBudgets(m: z.infer<typeof measured>): IsolationCase['budgets'] {
  const deadline = Math.min(SHIPPED_LIMITS.deadlineMaxMs, Math.max(SHIPPED_LIMITS.deadlineMinMs, Math.ceil((10 * m.cell_ms) / 1000) * 1000));
  return { max_tool_calls: Math.max(1, m.tool_calls), max_total_upstream_calls: Math.max(1, m.total_upstream_calls), max_clinical_calls: m.clinical_calls, max_result_bytes: Math.max(1, Math.min(SHIPPED_LIMITS.maxBytes, m.result_bytes)), deadline_ms: deadline, max_task_bytes: null, budget_source: null };
}
let registryPromise: Promise<RegistryMutant[]> | undefined;
/** The mutant registry read by import (never by regex), so compound `C()` definitions resolve too. */
export function registryMutants(): Promise<RegistryMutant[]> {
  registryPromise ??= (async () => {
    const gate = await import(new URL('../../scripts/mutation-guards.mjs', import.meta.url).href) as { MUTANTS: unknown[]; mutationSuites(m: unknown): string[]; mutationEdits(m: unknown): { file: string; find: string; replace: string }[] };
    return gate.MUTANTS.map(m => ({ id: (m as { id: string }).id, suites: gate.mutationSuites(m), edits: gate.mutationEdits(m) }));
  })();
  return registryPromise;
}
export async function defaultContext(): Promise<SemanticContext> {
  return { ledger: parseLedger(), killMatrix: parseKillMatrix(), coverage: parseCoverageMatrix(), mutants: await registryMutants(),
    readSource: file => readFileSync(join(process.cwd(), file), 'utf8'), scenarioSource: readIsolationFile('scenarios.ts'), runnerSource: readIsolationFile('runner.ts'), stubsSource: readIsolationFile('stubs.ts') };
}
/** Full validation: schema, ledger, kill matrix, coverage and the per-record count conditions. */
export async function loadManifest(input?: unknown, ctx?: SemanticContext): Promise<Manifest> {
  return checkSemantics(parseManifest(input), ctx ?? await defaultContext());
}
