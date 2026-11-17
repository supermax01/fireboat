// Aggregates for scores/<campaign>/summary.json and consistency.json. No combined score.
import type { QuestionRecord, ScoreRecord, Verdict } from '../lib/types.js';
import { stratumOf, VERDICT_SCORE, type ProbeScore } from './score-lib.js';

export const quantile = (xs: readonly number[], q: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
};
const mean = (xs: readonly number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1e4) / 1e4 : null);

export interface Row {
  dataset: string; arm: string; cell: string; group: string; // group: category letter or template id
  n: number; correct: number;
  list_n: number; verdicts: Record<Verdict | 'no_result', number>;
  summary_score_mean_no_result_as_0: number | null; // headline: over every list probe, "no result" scored 0
  summary_score_mean: number | null; // secondary: over list probes with a verdict only (1, 0.5, 0, 0)
  first_page_coverage_mean: number | null; recall_mean: number | null; precision_mean: number | null;
  runs_with_extra_records: number; // list questions that returned records outside the gold set
  suppressed_reads: number; runs_with_suppressed_reads: number; // reads answered NOT_FOUND although HAPI served them (silent truncation)
  items: { gold: number; matched: number; value_ok: number; unit_ok: number; time_ok: number };
  lexeme: { eligible: number; exact: number }; unit_code: { eligible: number; kept: number };
  other_patient_refs: number; runs_with_other_patient_refs: number;
  failures: Record<string, number>;
  calls_total: number;
  // content[].text and structuredContent are counted separately (a host reads one channel); no combined figure.
  bytes_content_text: { median: number | null; total: number }; bytes_structured: { median: number | null; total: number };
  latency_ms_per_run: { median: number | null; p95: number | null; max: number | null };
  // Over runs that have the field (absent in older scores): the first call's latency, and each
  // run's median latency of the calls after the first (runs with one call have none).
  first_call_ms?: { n: number; median: number | null; p95: number | null };
  later_calls_median_ms?: { n: number; median: number | null; p95: number | null };
}

function row(key: Pick<Row, 'dataset' | 'arm' | 'cell' | 'group'>, ss: ScoreRecord[]): Row {
  const verdicts: Row['verdicts'] = { complete: 0, signalled_partial: 0, silent_truncation: 0, false_completeness: 0, no_result: 0 };
  const list = ss.filter(s => s.recall !== null);
  for (const s of list) verdicts[s.verdict ?? 'no_result']++;
  const scored = list.filter(s => s.verdict !== null).map(s => VERDICT_SCORE[s.verdict!]);
  const failures: Record<string, number> = {};
  for (const s of ss) for (const f of s.failure) failures[f] = (failures[f] ?? 0) + 1;
  const sum = (f: (s: ScoreRecord) => number) => ss.reduce((a, s) => a + f(s), 0);
  const text = ss.map(s => s.bytes.content_text);
  const structured = ss.map(s => s.bytes.structured_content);
  const lat = ss.map(s => s.latency_ms);
  const first = ss.flatMap(s => (typeof s.first_call_ms === 'number' ? [s.first_call_ms] : []));
  const later = ss.flatMap(s => (typeof s.later_calls_median_ms === 'number' ? [s.later_calls_median_ms] : []));
  return {
    ...key, n: ss.length, correct: sum(s => s.correct), list_n: list.length, verdicts,
    summary_score_mean: mean(scored), summary_score_mean_no_result_as_0: mean(list.map(s => (s.verdict ? VERDICT_SCORE[s.verdict] : 0))),
    first_page_coverage_mean: mean(ss.filter(s => s.first_page_coverage !== null).map(s => s.first_page_coverage!)),
    recall_mean: mean(list.map(s => s.recall!)), precision_mean: mean(list.map(s => s.precision!)),
    runs_with_extra_records: ss.filter(s => (s.extra_records ?? 0) > 0).length,
    suppressed_reads: sum(s => s.suppressed_reads?.length ?? 0), runs_with_suppressed_reads: ss.filter(s => (s.suppressed_reads?.length ?? 0) > 0).length,
    items: { gold: sum(s => s.items.gold), matched: sum(s => s.items.matched), value_ok: sum(s => s.items.value_ok), unit_ok: sum(s => s.items.unit_ok), time_ok: sum(s => s.items.time_ok) },
    lexeme: { eligible: sum(s => s.lexeme.eligible), exact: sum(s => s.lexeme.exact) },
    unit_code: { eligible: sum(s => s.items.unit_code_eligible), kept: sum(s => s.items.unit_code_kept) },
    other_patient_refs: sum(s => s.other_patient_refs.length), runs_with_other_patient_refs: ss.filter(s => s.other_patient_refs.length > 0).length,
    failures, calls_total: sum(s => s.calls),
    bytes_content_text: { median: quantile(text, 0.5), total: text.reduce((a, b) => a + b, 0) },
    bytes_structured: { median: quantile(structured, 0.5), total: structured.reduce((a, b) => a + b, 0) },
    latency_ms_per_run: { median: quantile(lat, 0.5), p95: quantile(lat, 0.95), max: quantile(lat, 1) },
    first_call_ms: { n: first.length, median: quantile(first, 0.5), p95: quantile(first, 0.95) },
    later_calls_median_ms: { n: later.length, median: quantile(later, 0.5), p95: quantile(later, 0.95) },
  };
}

function groupBy<T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) { const k = key(x); m.set(k, [...(m.get(k) ?? []), x]); }
  return m;
}

/** Pass 1 is the scored pass; pass 2 exists for the consistency check. */
export function summarise(scores: ScoreRecord[], probes: ProbeScore[], questions: Map<string, QuestionRecord>) {
  // Strata questions are never pooled with the main set: they get their own rows only.
  const all1 = scores.filter(s => s.pass === 1);
  const p1 = all1.filter(s => stratumOf(s.template_id) === null);
  const strata1 = all1.filter(s => stratumOf(s.template_id) !== null);
  const byStratum: StratumRow[] = [...groupBy(strata1, s => `${s.dataset}|${s.arm}|${s.cell}|${s.template_id}`)].map(([k, ss]): StratumRow => {
    const [dataset, arm, cell, group] = k.split('|') as [string, string, string, string];
    return { ...row({ dataset, arm, cell, group }, ss), stratum: stratumOf(group)!, scored_on: ss[0]!.scored_on ?? 'standard' };
  }).sort((a, b) => (a.dataset + a.group + a.arm + a.cell).localeCompare(b.dataset + b.group + b.arm + b.cell));
  const strataQuestions = [...questions.keys()].filter(id => stratumOf(questions.get(id)!.template_id) !== null).length;
  const byCategory = [...groupBy(p1, s => `${s.dataset}|${s.arm}|${s.cell}|${s.category}`)].map(([k, ss]) => {
    const [dataset, arm, cell, group] = k.split('|') as [string, string, string, string];
    return row({ dataset, arm, cell, group }, ss);
  }).sort((a, b) => (a.dataset + a.group + a.arm + a.cell).localeCompare(b.dataset + b.group + b.arm + b.cell));
  const byTemplate = [...groupBy(p1, s => `${s.dataset}|${s.arm}|${s.cell}|${s.template_id}`)].map(([k, ss]) => {
    const [dataset, arm, cell, group] = k.split('|') as [string, string, string, string];
    return row({ dataset, arm, cell, group }, ss);
  }).sort((a, b) => (a.dataset + a.group + a.arm + a.cell).localeCompare(b.dataset + b.group + b.arm + b.cell));
  const byArm = [...groupBy(p1, s => `${s.dataset}|${s.arm}|${s.cell}`)].map(([k, ss]) => {
    const [dataset, arm, cell] = k.split('|') as [string, string, string];
    return row({ dataset, arm, cell, group: 'all' }, ss);
  }).sort((a, b) => (a.dataset + a.arm + a.cell).localeCompare(b.dataset + b.arm + b.cell));
  const pp1 = probes.filter(s => s.pass === 1);
  const probeRows = [...groupBy(pp1, s => `${s.dataset}|${s.arm}|${s.cell}|${s.probe_set}|${s.template_id}|${s.kind}`)].map(([k, ss]) => {
    const [dataset, arm, cell, probe_set, template_id, kind] = k.split('|') as [string, string, string, string, string, string];
    const outcomes: Record<string, number> = {};
    for (const s of ss) outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;
    return { dataset, arm, cell, probe_set, template_id, kind, n: ss.length, outcomes,
      other_patient_refs: ss.reduce((a, s) => a + s.other_patient_ref_count, 0), upstream_requests: ss.reduce((a, s) => a + s.upstream_requests, 0),
      blocked_writes: ss.reduce((a, s) => a + s.blocked_writes, 0) };
  }).sort((a, b) => (a.dataset + a.probe_set + a.template_id.padStart(3, '0') + a.arm).localeCompare(b.dataset + b.probe_set + b.template_id.padStart(3, '0') + b.arm));
  const collapsed = [...groupBy(pp1, s => `${s.dataset}|${s.arm}|${s.cell}|${s.probe_set}`)].map(([k, ss]) => {
    const [dataset, arm, cell, probe_set] = k.split('|') as [string, string, string, string];
    const outcomes: Record<string, number> = {};
    for (const s of ss) outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;
    return { dataset, arm, cell, probe_set, n: ss.length, outcomes, other_patient_refs: ss.reduce((a, s) => a + s.other_patient_ref_count, 0) };
  });
  return { question_count: questions.size - strataQuestions, by_category: byCategory, by_template: byTemplate, by_arm: byArm, probes_detail: probeRows, probes_collapsed: collapsed,
    ...(strataQuestions || byStratum.length ? { strata_question_count: strataQuestions, by_stratum: byStratum } : {}) };
}

export type StratumRow = Row & { stratum: string; scored_on: 'answer' | 'verdict' | 'standard' };

export interface Fingerprint {
  key: string; pass: 1 | 2; run_id: string;
  calls: { tool: string; args: string; error: string | null; is_error: boolean | null; refs: string[]; signals: string[]; refused: string | null }[];
  outcomes: string[]; flags: string[]; bytes_result: number;
}

/** Pass 1 vs pass 2 on everything except timing and server-generated handles. Byte differences are listed separately. */
export function consistency(prints: Fingerprint[]) {
  const differences: { key: string; field: string; pass1: unknown; pass2: unknown }[] = [];
  const byteDiffs: { key: string; pass1: number; pass2: number }[] = [];
  let compared = 0;
  let unpaired = 0;
  for (const [key, fs] of groupBy(prints, f => f.key)) {
    const a = fs.find(f => f.pass === 1), b = fs.find(f => f.pass === 2);
    if (!a || !b) { unpaired++; continue; }
    compared++;
    const cut = (v: unknown) => { const s = JSON.stringify(v); return s.length > 400 ? s.slice(0, 400) + '...' : JSON.parse(s); };
    if (JSON.stringify(a.outcomes) !== JSON.stringify(b.outcomes)) differences.push({ key, field: 'op_outcomes', pass1: a.outcomes, pass2: b.outcomes });
    if (JSON.stringify(a.flags) !== JSON.stringify(b.flags)) differences.push({ key, field: 'flags', pass1: a.flags, pass2: b.flags });
    if (a.calls.length !== b.calls.length) differences.push({ key, field: 'calls.length', pass1: a.calls.length, pass2: b.calls.length });
    for (let i = 0; i < Math.min(a.calls.length, b.calls.length); i++) {
      for (const f of ['tool', 'args', 'error', 'is_error', 'refs', 'signals', 'refused'] as const) {
        if (JSON.stringify(a.calls[i]![f]) !== JSON.stringify(b.calls[i]![f])) differences.push({ key, field: `calls[${i}].${f}`, pass1: cut(a.calls[i]![f]), pass2: cut(b.calls[i]![f]) });
      }
    }
    if (a.bytes_result !== b.bytes_result) byteDiffs.push({ key, pass1: a.bytes_result, pass2: b.bytes_result });
  }
  return { schema: 'fbbench.consistency/1', compared, unpaired, differences, byte_differences: { count: byteDiffs.length, examples: byteDiffs.slice(0, 20) } };
}
