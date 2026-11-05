import { z } from 'zod';
import { CHANNELS, type IsolationCase } from './case-schema.js';
import type { CaseReport, CellReport } from './runner.js';
export class AggregateError extends Error { constructor(readonly code: string, detail?: string) { super(`${code}${detail ? `: ${detail}` : ''}`); } }
export function parseEvidence<T>(schema: z.ZodType<T>, input: unknown, code: string): T {
  const parsed = schema.safeParse(input); if (!parsed.success) throw new AggregateError(code, 'invalid evidence shape'); return parsed.data;
}
export function parseEvidenceJSON(text: string, code: string): unknown {
  try { return JSON.parse(text); } catch { throw new AggregateError(code, 'invalid JSON'); }
}
const text = z.string().max(4096), nonempty = text.min(1), count = z.number().int().nonnegative(), hex = z.string().regex(/^[a-f0-9]{64}$/);
const verdict = z.enum(['PASS', 'FAIL', 'INCONCLUSIVE', 'PENDING']);
export const BindingSchema = z.strictObject({
  inputs_sha256: hex.nullable(), commit: nonempty, tree: nonempty, run_id: nonempty, attempt_id: nonempty.nullable(),
  build: z.strictObject({ stamp: nonempty, output_sha256: nonempty, matches_sources: z.boolean(), skipped: z.boolean() }),
  pins: z.strictObject({ verified: z.boolean(), mismatches: z.array(nonempty) }),
  env: z.strictObject({ B2_CORE_ONLY: text.nullable(), B2_CASE_IDS: text.nullable(), B2_SKIP_BUILD: text.nullable(), B2_QUALIFY: text.nullable() }),
  dependencies: z.strictObject({ lock_hash: nonempty, installed_tree_hash: nonempty, sdk_client_hash: nonempty, sdk_server_hash: nonempty }),
  manifest_sha256: hex, node: nonempty,
});
const counts = z.strictObject({ tool_calls: count, total_upstream_calls: count, clinical: count, metadata: count, auth: count, probe: count, sink: count, mutations: count, max_call_bytes: count, per_driver: z.array(count).max(20) });
const failure = z.strictObject({ channel: nonempty, predicate: nonempty, expected: z.unknown(), observed: z.unknown() });
const stub = z.strictObject({ verdict: z.enum(['PASS', 'FAIL']), kind: z.enum(['deny-all', 'overblocking']), feature: nonempty, specificity: z.literal('feature'), blocked_calls: count, reason: nonempty.optional(), rejected_by: nonempty.optional() });
const hit = z.strictObject({ channel: z.enum([...CHANNELS, 'retained']), marker_id: nonempty, segment_index: count, path: nonempty, encoding: nonempty });
export const CellReportSchema = z.strictObject({
  lane: z.enum(['core', 'sdk-modern', 'sdk-legacy']), era: text, run: z.number().int(), verdict,
  channels_scanned: z.array(z.enum(CHANNELS)).max(9), channels_na: z.array(z.enum(CHANNELS)).max(9), failures: z.array(failure).max(10000),
  control_result: z.enum(['PASS', 'FAIL', 'NOT_RUN']), stubs: z.array(stub).max(2), request_counts: z.record(nonempty, count), request_marker_observations: z.array(hit), tool_calls: count, retained_followups: count,
  capture_hashes: z.partialRecord(z.enum(CHANNELS), text), fingerprint: text, pending_reason: nonempty.optional(),
  arms: z.strictObject({ control: counts, attack: counts, followups: counts }), pre_stub: counts,
  timing: z.strictObject({ cell_ms: count, control_ms: count, attack_ms: count, followups_ms: count, checks_ms: count, stubs_ms: count }),
  phase: z.enum(['start', 'control', 'attack', 'followups', 'checks', 'stubs', 'done']), stub_counts: z.record(nonempty, counts),
});
export const CaseReportSchema = z.strictObject({ id: nonempty, family: nonempty, verdict, lanes: z.array(CellReportSchema).max(6),
  cli: z.strictObject({ verdict: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE', 'PENDING', 'NOT_RUN']), source_lanes: z.array(nonempty), channels_na: z.array(nonempty), channels_scanned: z.array(nonempty) }), critical_mutants: z.array(nonempty) });
export const ShardSchema = z.strictObject({ schema_version: z.literal('b2-shard/2'), family: nonempty, run_id: nonempty, manifest_sha256: hex,
  binding: z.strictObject({ start: BindingSchema, end: BindingSchema.extend({ cases_sha256: hex }) }), cases: z.array(CaseReportSchema) });
export const PrerequisitesSchema = z.strictObject({ schema_version: z.string(), run_id: nonempty,
  binding: z.strictObject({ start: BindingSchema, end: BindingSchema }), checks: z.record(nonempty, z.object({ verdict: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']) }).catchall(z.unknown())) });
export const ERAS = { core: 'core/public-serializer', 'sdk-modern': '2026-07-28', 'sdk-legacy': '2025-11-25' } as const;
const kinds = ['core', 'sdk-modern', 'sdk-legacy'] as const;
export const summarizeVerdict = (cells: readonly Pick<CellReport, 'verdict'>[]) => cells.some(l => l.verdict === 'FAIL') ? 'FAIL' : cells.some(l => l.verdict === 'INCONCLUSIVE') ? 'INCONCLUSIVE' : cells.some(l => l.verdict === 'PENDING') ? 'PENDING' : cells.length ? 'PASS' : 'NOT_RUN';
export const naChannels = (c: Pick<IsolationCase, 'lanes'>, driver: string): string[] => {
  const lane = c.lanes.find(l => l.driver === driver); return lane ? CHANNELS.filter(ch => lane.channel_capture[ch].status === 'not_applicable') : [...CHANNELS];
};
export function cellCoverageProblem(c: Pick<IsolationCase, 'lanes'>, cell: Pick<CellReport, 'lane' | 'verdict' | 'channels_na' | 'channels_scanned' | 'capture_hashes'>): string | undefined {
  const na = naChannels(c, cell.lane);
  if ([...cell.channels_na].sort().join() !== [...na].sort().join()) return `${cell.lane}: N/A channels differ from manifest`;
  if (cell.verdict !== 'PASS') return undefined;
  const missing = CHANNELS.filter(ch => !na.includes(ch) && (!cell.channels_scanned.includes(ch) || !/^[a-f0-9]{64}$/.test(cell.capture_hashes[ch] ?? '')));
  return missing.length ? `${cell.lane}: required channels not scanned: ${missing.join('+')}` : undefined;
}
/** Shard labels are assertions to verify, never evidence to trust. All credited facts are derived from these cells. */
export function validateAggregate(reports: CaseReport[], expectedIds: string[], cases: readonly IsolationCase[], coreOnly = process.env.B2_CORE_ONLY === '1'): void {
  if (!cases) throw new AggregateError('manifest-cases-required');
  for (const r of reports) parseEvidence(CaseReportSchema, r, 'case-shape');
  if (reports.map(r => r.id).sort().join() !== [...expectedIds].sort().join()) throw new AggregateError('case-set', 'missing, duplicate or unknown case report');
  const byId = new Map(cases.map(c => [c.id, c]));
  for (const report of reports) {
    const c = byId.get(report.id); if (!c || c.family !== report.family || !report.id.startsWith(`B2-${report.family}-`)) throw new AggregateError('case-identity', report.id);
    const expected = (coreOnly ? ['core'] : kinds).flatMap(kind => [`${kind}:1`, `${kind}:2`]).sort().join();
    if (report.lanes.map(l => `${l.lane}:${l.run}`).sort().join() !== expected) throw new AggregateError('cell-set', report.id);
    for (const cell of report.lanes) {
      if (cell.era !== ERAS[cell.lane]) throw new AggregateError('cell-era', report.id);
      if (new Set(cell.channels_scanned).size !== cell.channels_scanned.length) throw new AggregateError('cell-coverage', report.id);
      const coverage = cellCoverageProblem(c, cell); if (coverage) throw new AggregateError('cell-coverage', `${report.id} ${coverage}`);
      if (cell.verdict === 'PASS') {
        if (cell.failures.length) throw new AggregateError('cell-pass-failures', report.id);
        if (cell.control_result !== 'PASS' || cell.stubs.length !== 2 || cell.stubs.some(s => s.verdict !== 'PASS') || cell.stubs.map(s => s.kind).sort().join() !== 'deny-all,overblocking') throw new AggregateError('cell-incomplete', report.id);
        const b = c.budgets, n = cell.pre_stub;
        if (n.tool_calls > b.max_tool_calls || n.total_upstream_calls > b.max_total_upstream_calls || n.clinical > b.max_clinical_calls || n.max_call_bytes > b.max_result_bytes) throw new AggregateError('cell-budget', report.id);
        if (cell.tool_calls !== n.tool_calls || n.per_driver.reduce((a, b) => a + b, 0) !== n.tool_calls || n.total_upstream_calls !== n.clinical + n.metadata + n.auth + n.probe) throw new AggregateError('cell-counts', report.id);
        if (!/^[a-f0-9]{64}$/.test(cell.fingerprint)) throw new AggregateError('cell-repeat-digest', report.id);
      }
    }
    if (report.verdict !== summarizeVerdict(report.lanes)) throw new AggregateError('case-verdict', report.id);
    const stdio = report.lanes.filter(l => l.lane !== 'core');
    if (report.cli.verdict !== summarizeVerdict(stdio)) throw new AggregateError('cli-verdict', report.id);
    if (report.cli.source_lanes.join() !== 'sdk-modern,sdk-legacy' || report.cli.channels_na.slice().sort().join() !== 'audit,state' || report.cli.channels_scanned.slice().sort().join() !== [...new Set(stdio.flatMap(l => l.channels_scanned))].sort().join()) throw new AggregateError('cli-coverage', report.id);
    if (report.verdict === 'PASS') for (const lane of coreOnly ? ['core'] : kinds) {
      const [a, b] = report.lanes.filter(l => l.lane === lane);
      if (a!.fingerprint !== b!.fingerprint) throw new AggregateError('case-repeat', report.id);
    }
  }
}
