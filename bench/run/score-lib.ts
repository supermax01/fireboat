// Scripted-track scoring of questions and probes. Pure functions over RunRecords and gold.
// Scoring choices beyond the plain checks are marked "rule:" and listed in the report.
import { LosslessNumber, type LosslessValue } from '../lib/json.js';
import type { CallBytes, CountedSignal, GoldItem, GoldRecord, ParsedResult, QuestionRecord, Ref, RunRecord, ScoreRecord, Verdict } from '../lib/types.js';
import type { ProbeGoldRecord, ProbeRecord } from '../gold/probes.js';
import { decimalEquals, isDecimalLexeme, lexemeChangedByFloat } from '../gold/decimal.js';
import { bandOf } from '../gold/longlist.js';
import { instantEqual } from '../agent/grade.js';
import { parserFor } from '../servers/parsers.js';
import { isObj, type Obj } from '../servers/items.js';
import { rawResources } from './resources.js';

// ---- value, unit and time evidence inside one returned resource --------------------------------------------------

interface ValueNode { lexeme: string; unit: string | null; code: string | null; system: string | null }

const lex = (v: LosslessValue | undefined): string | null =>
  v instanceof LosslessNumber ? v.lexeme : typeof v === 'string' && isDecimalLexeme(v) ? v : null; // decimals written as strings are accepted

/** Every Quantity-like object ({value, unit|code|currency}) and every value[x] primitive, anywhere in the resource. */
export function valueNodes(r: LosslessValue): ValueNode[] {
  const out: ValueNode[] = [];
  const walk = (v: LosslessValue) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!isObj(v)) return;
    const q = lex(v.value);
    if (q !== null) {
      const unit = typeof v.unit === 'string' ? v.unit : typeof v.code === 'string' ? v.code : typeof v.currency === 'string' ? v.currency : null;
      out.push({ lexeme: q, unit, code: typeof v.code === 'string' ? v.code : null, system: typeof v.system === 'string' ? v.system : null });
    }
    for (const [k, x] of Object.entries(v)) {
      if (k !== 'value' && k.startsWith('value')) {
        const p = x instanceof LosslessNumber ? x.lexeme : typeof x === 'string' ? x : null;
        if (p !== null) out.push({ lexeme: p, unit: null, code: null, system: null });
        if (isObj(x) && x.value === undefined) { // valueCodeableConcept: its text and coding displays are text values
          if (typeof x.text === 'string') out.push({ lexeme: x.text, unit: null, code: null, system: null });
          for (const c of Array.isArray(x.coding) ? x.coding : []) if (isObj(c) && typeof c.display === 'string') out.push({ lexeme: c.display, unit: null, code: null, system: null });
        }
      }
      walk(x);
    }
  };
  walk(r);
  return out;
}

const DATE_LIKE = /^\d{4}(-\d\d(-\d\d(T\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)?)?)?)?$/;

export function timeStrings(r: LosslessValue): string[] {
  const out: string[] = [];
  const walk = (v: LosslessValue) => {
    if (typeof v === 'string') { if (DATE_LIKE.test(v)) out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (isObj(v)) for (const x of Object.values(v)) walk(x);
  };
  walk(r);
  return out;
}

export interface ItemCheck { ref: Ref; found: boolean; identity: boolean; value: boolean | null; unit: boolean | null; time: boolean | null;
  unit_code: boolean | null; lexeme_eligible: boolean; lexeme_exact: boolean | null }

/**
 * Item checks (value, unit, time, identity) for one gold item against every returned copy of its resource.
 * rule: value and unit are checked only when the gold value is recorded in the resource (value_as_recorded non-null);
 *       derived values (for example a length of stay) are not item checks. Time is checked when the gold item has one.
 * rule: a value passes if some Quantity or value[x] in the resource is decimal-equal (text: exactly equal); the unit
 *       passes if that same node shows the gold unit (unit, else code, else currency), or none when the gold has none.
 */
export function checkItem(g: GoldItem, copies: Obj[], identityOk: boolean): ItemCheck {
  const c: ItemCheck = { ref: g.ref, found: copies.length > 0, identity: identityOk && copies.length > 0, value: null, unit: null, time: null,
    unit_code: null, lexeme_eligible: false, lexeme_exact: null };
  if (!c.found) return c;
  const rec = g.value_as_recorded;
  if (rec !== null) {
    const numeric = isDecimalLexeme(rec);
    const nodes = copies.flatMap(r => valueNodes(r)).filter(n => (numeric ? isDecimalLexeme(n.lexeme) && decimalEquals(n.lexeme, rec) : n.lexeme === rec));
    c.value = nodes.length > 0;
    c.unit = nodes.some(n => (g.unit === null ? n.unit === null : n.unit !== null && n.unit.trim() === g.unit.trim()));
    if (g.unit_code !== null) c.unit_code = nodes.some(n => n.code === g.unit_code && (g.unit_system === null || n.system === g.unit_system));
    if (numeric && lexemeChangedByFloat(rec)) { c.lexeme_eligible = true; c.lexeme_exact = nodes.some(n => n.lexeme === rec); }
  }
  if (g.time !== null) c.time = copies.some(r => timeStrings(r).some(t => instantEqual(t, g.time!)));
  return c;
}

const itemOk = (c: ItemCheck) => c.found && c.identity && c.value !== false && c.unit !== false && c.time !== false;

// ---- completeness ----------------------------------------------------------------------------------------------

/**
 * Completeness verdict. rule: signals are the counted signals on the final response of each list operation (earlier
 * pages' handles were followed); a counted signal takes precedence over an explicit completeness claim.
 */
export function verdictOf(G: ReadonlySet<Ref>, R: ReadonlySet<Ref>, finalSignals: readonly CountedSignal[], explicitComplete: boolean): Verdict {
  for (const g of G) if (!R.has(g)) return finalSignals.length > 0 ? 'signalled_partial' : explicitComplete ? 'false_completeness' : 'silent_truncation';
  return 'complete';
}

/** FHIR-AgentBench empty-set convention, as in agent/grade.ts: both empty = 1, otherwise an empty side gives 0. */
export function precisionRecall(R: ReadonlySet<Ref>, G: ReadonlySet<Ref>): { precision: number; recall: number } {
  if (R.size === 0 && G.size === 0) return { precision: 1, recall: 1 };
  let hit = 0;
  for (const r of R) if (G.has(r)) hit++;
  return { precision: R.size === 0 ? 0 : hit / R.size, recall: G.size === 0 ? 0 : hit / G.size };
}

export const VERDICT_SCORE: Record<Verdict, number> = { complete: 1, signalled_partial: 0.5, silent_truncation: 0, false_completeness: 0 };

const sumBytes = (calls: RunRecord['calls']): CallBytes => calls.reduce((a, c) => ({
  content_text: a.content_text + (c.bytes?.content_text ?? 0), structured_content: a.structured_content + (c.bytes?.structured_content ?? 0),
  result: a.result + (c.bytes?.result ?? 0), line: a.line + (c.bytes?.line ?? 0),
}), { content_text: 0, structured_content: 0, result: 0, line: 0 });

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Middle value (mean of the two middle values for an even count); null for an empty list. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Session cost versus per-call cost. Every scripted run starts a fresh server, so the first call also
 * pays once-per-session work (fireboat: the CapabilityStatement fetch); the later calls show the per-call cost.
 */
export function latencySplit(calls: RunRecord['calls']): { first_call_ms: number | null; later_calls_median_ms: number | null } {
  const ordered = [...calls].sort((a, b) => a.seq - b.seq);
  const later = median(ordered.slice(1).map(c => c.latency_ms));
  return { first_call_ms: ordered.length ? round3(ordered[0]!.latency_ms) : null, later_calls_median_ms: later === null ? null : round3(later) };
}
const LIST_OPS = new Set(['search', 'drain']);

export interface ParsedRun { parsed: ParsedResult[]; resources: Obj[][] }

/** The recording proxy's view of one run (ProxyLogRecord fields the scorer needs). */
export interface UpstreamRec { method: string; path: string; status: number }

/**
 * Templates whose scripted plan deliberately fetches more than the gold set (the reader applies the selection):
 * K2 drains every CareTeam and the gold keeps the one that started on the named date. For every other template the
 * plan's searches select exactly depends_on (checked on the development data: M, which forwards the plan to HAPI
 * verbatim, returns no record outside depends_on on any other template).
 */
export const PLAN_WIDER_THAN_GOLD = new Set(['K2']);

/** Strata: which questions belong to a stratum, never pooled with the main question set. */
export function stratumOf(templateId: string): 'B1' | 'B2' | 'B3' | 'B4' | 'decimal' | null {
  if (templateId.startsWith('DEC-')) return 'decimal';
  if (/^LS[12]-B\d+$/.test(templateId)) return (bandOf(templateId)?.id ?? null) as 'B1' | 'B2' | 'B3' | 'B4' | null;
  return null;
}

/**
 * How a stratum question is scored: B4 on the completeness verdict; LS2 in B1-B3 on the answer, with the
 * depends_on verdict reported beside it, never folded in; everything else (LS1 in B1-B3, decimal) by the ordinary rules.
 */
export function strataScoring(templateId: string): 'answer' | 'verdict' | null {
  const s = stratumOf(templateId);
  if (s === 'B4') return 'verdict';
  if (s !== null && s !== 'decimal' && templateId.startsWith('LS2-')) return 'answer';
  return null;
}

const NOT_FOUND = /not[-_ ]?found|^404$/i;
const servedPath = (path: string) => path.replace(/\/+$/, '');

/** A read the server answered NOT_FOUND although the proxy log shows HAPI answered the same GET with 200. */
function suppressedRead(op: { type: string; id: string }, refusal: string | null, upstream: readonly UpstreamRec[]): boolean {
  if (refusal === null || !NOT_FOUND.test(refusal)) return false;
  const suffix = `/${op.type}/${op.id}`;
  return upstream.some(u => (u.method === 'GET' || u.method === 'HEAD') && u.status === 200 && servedPath(u.path).endsWith(suffix));
}

/** A search the server answered NOT_FOUND although HAPI answered a search on that type with 200. */
function suppressedSearch(type: string, refusal: string | null, upstream: readonly UpstreamRec[]): boolean {
  if (refusal === null || !NOT_FOUND.test(refusal)) return false;
  return upstream.some(u => u.status === 200 && (u.method === 'GET' || u.method === 'POST') && /\/fhir(?:\/R4)?\/([A-Za-z]+)(\/_search)?$/.exec(servedPath(u.path))?.[1] === type);
}

export function parseRun(run: RunRecord): ParsedRun {
  const parser = parserFor(run.arm);
  return { parsed: run.calls.map(c => parser.parse(c)), resources: run.calls.map(c => rawResources(run.arm, c)) };
}

export function scoreQuestionRun(run: RunRecord, q: QuestionRecord, g: GoldRecord, pr: ParsedRun = parseRun(run), upstream: readonly UpstreamRec[] = []): ScoreRecord {
  const notes: string[] = [];
  const items = pr.parsed.flatMap(p => p.items);
  const R = new Set(items.map(i => i.ref));
  const other = [...new Set(items.filter(i => i.patient !== null && i.patient !== run.patient_id).map(i => i.ref))].sort();
  const byRef = new Map<Ref, Obj[]>();
  for (const list of pr.resources) for (const r of list) {
    const ref = `${String(r.resourceType)}/${String(r.id)}`;
    byRef.set(ref, [...(byRef.get(ref) ?? []), r]);
  }
  const identityOf = (ref: Ref) => items.some(i => i.ref === ref && (i.patient === null || i.patient === run.patient_id));
  const checks = g.items.map(gi => checkItem(gi, byRef.get(gi.ref) ?? [], identityOf(gi.ref)));
  const outcomes = new Set(run.op_outcomes.map(o => o.outcome));
  const opsOk = run.op_outcomes.length === q.operations.length && [...outcomes].every(o => o === 'ok');

  const G = new Set(g.depends_on);
  const listOps = q.operations.map((o, i) => ({ o, i })).filter(x => LIST_OPS.has(x.o.op)).map(x => x.i);
  const isList = listOps.length > 0;
  const lastRefusal = (i: number): string | null => {
    const k = run.calls.map((c, j) => (c.op_index === i ? j : -1)).filter(j => j >= 0).pop();
    return k === undefined ? null : pr.parsed[k]!.refused?.code ?? null;
  };
  const failedOps = run.op_outcomes.filter(o => o.outcome === 'tool_error' || o.outcome === 'failed' || o.outcome === 'refused_by_adapter');
  // rule: a list operation answered NOT_FOUND while HAPI served the search is a suppression (silent truncation), not "no result".
  const suppressedLists = failedOps.filter(o => listOps.includes(o.op_index)).filter(o => {
    const op = q.operations[o.op_index];
    return o.outcome === 'tool_error' && op !== undefined && 'type' in op && typeof op.type === 'string' && suppressedSearch(op.type, lastRefusal(o.op_index), upstream);
  }).map(o => o.op_index);
  const listFailed = failedOps.some(o => listOps.includes(o.op_index) && !suppressedLists.includes(o.op_index));
  // rule: a read answered NOT_FOUND while the proxy log shows HAPI returned the record is a silent truncation.
  const suppressedReads = q.operations.flatMap((op, i) => (op.op === 'read' && run.op_outcomes.some(o => o.op_index === i && o.outcome === 'tool_error')
    && suppressedRead(op, lastRefusal(i), upstream) ? [`${op.type}/${op.id}`] : []));
  const finals: ParsedResult[] = [];
  const firsts: ParsedResult[] = [];
  for (const i of listOps) {
    const idx = run.calls.map((c, k) => (c.op_index === i ? k : -1)).filter(k => k >= 0);
    if (idx.length) { firsts.push(pr.parsed[idx[0]!]!); finals.push(pr.parsed[idx[idx.length - 1]!]!); }
  }
  const finalSignals = [...new Set(finals.flatMap(p => p.signals.map(s => s.kind)))];
  let verdict: Verdict | null = null;
  let fpc: number | null = null;
  let recall: number | null = null;
  let precision: number | null = null;
  if (isList) {
    // rule: a list operation that errored or was refused gets no verdict (reported as "no result"), not a completeness class.
    if (!listFailed) verdict = verdictOf(G, R, finalSignals, finals.some(p => p.explicit_complete));
    if (verdict === 'complete' && suppressedReads.length) verdict = 'silent_truncation'; // a withheld record answered NOT_FOUND
    if (G.size > 0) {
      const first = new Set(firsts.flatMap(p => p.items.map(i => i.ref)));
      fpc = round4([...G].filter(x => first.has(x)).length / G.size);
    }
    const pr2 = precisionRecall(R, G);
    recall = round4(pr2.recall);
    precision = round4(pr2.precision);
  }
  // rule: an item-free gold (an explicit "none" or empty count) is correct only if every operation succeeded and R covers G.
  const itemsCorrect = g.items.length > 0 ? checks.every(itemOk) : opsOk && [...G].every(x => R.has(x));
  // rule: a list question is correct only if R covers depends_on (the answer is known to be right) and, where the plan
  // selects exactly G, no list operation returned a record outside G or the gold items (identity applies to every
  // returned item; returning too much is not rewarded).
  const coversG = !isList || [...G].every(x => R.has(x));
  const goldRefs = new Set([...G, ...g.items.map(i => i.ref)]);
  const listRefs = new Set(pr.parsed.flatMap((p, k) => (listOps.includes(run.calls[k]!.op_index) ? p.items.map(i => i.ref) : [])));
  const extras = isList && !PLAN_WIDER_THAN_GOLD.has(q.template_id) ? [...listRefs].filter(r => !goldRefs.has(r)) : [];
  if (!coversG) notes.push('returned set does not cover depends_on');
  if (extras.length) notes.push(`${extras.length} returned record(s) outside the gold set`);
  const mode = strataScoring(q.template_id);
  let correct: 0 | 1 = itemsCorrect && other.length === 0 && coversG && extras.length === 0 && suppressedReads.length === 0 ? 1 : 0;
  if (mode === 'answer') {
    // rule: LS2 is correct on the answer (the records holding the maximum, checked like any value item);
    // whether the returned set covers depends_on is the separate verdict, not part of correctness.
    correct = itemsCorrect && other.length === 0 && extras.length === 0 && suppressedReads.length === 0 ? 1 : 0;
    notes.push('scored on the answer; the depends_on verdict is reported beside it');
  } else if (mode === 'verdict') {
    // rule: B4 exceeds the drain cap for every arm. signalled_partial passes; complete passes only when
    // the returned set truly covers depends_on (verdictOf), with no suppressed read; ST, FC and no result fail.
    correct = other.length === 0 && (verdict === 'signalled_partial' || (verdict === 'complete' && coversG)) ? 1 : 0;
    notes.push('scored on the completeness verdict (band B4)');
  }
  if (g.items.some(i => i.value_as_recorded === null && i.value !== null)) notes.push('derived item value not checked');

  const failure: string[] = [...outcomes].filter(o => o !== 'ok');
  if (run.flags.includes('server_start_failed')) failure.push('server_start_failed');
  if (run.flags.some(f => f.includes('param_dropped'))) failure.push('param_dropped');
  if (extras.length) failure.push('extra_records');
  if (suppressedReads.length || suppressedLists.length) failure.push('suppressed_not_found');
  return {
    schema: 'fbbench.score/1', campaign: run.campaign, run_id: run.run_id, arm: run.arm, cell: run.cell, pass: run.pass, dataset: run.dataset,
    question_id: q.id, template_id: q.template_id, category: q.category, correct,
    items: {
      gold: g.items.length, returned: R.size, matched: checks.filter(c => c.found && c.identity).length,
      value_ok: checks.filter(c => c.found && c.value !== false).length, unit_ok: checks.filter(c => c.found && c.unit !== false).length,
      time_ok: checks.filter(c => c.found && c.time !== false).length, identity_ok: checks.filter(c => c.identity).length,
      unit_code_kept: checks.filter(c => c.unit_code === true).length, unit_code_eligible: g.items.filter(i => i.unit_code !== null).length,
    },
    other_patient_refs: other, verdict, first_page_coverage: fpc, recall, precision, extra_records: extras.length, suppressed_reads: suppressedReads,
    lexeme: { eligible: checks.filter(c => c.lexeme_eligible).length, exact: checks.filter(c => c.lexeme_exact === true).length },
    calls: run.calls.length, bytes: sumBytes(run.calls),
    latency_ms: Math.round(run.calls.reduce((a, c) => a + c.latency_ms, 0) * 1000) / 1000,
    ...latencySplit(run.calls),
    signals: finalSignals, failure: [...new Set(failure)], notes,
    ...(mode ? { scored_on: mode } : {}),
  };
}

// ---- probes (capability: confinement and writes) ------------------------------------------------------------------

export interface ProbeScore {
  schema: 'fbbench.probe-score/1';
  campaign: string; run_id: string; arm: RunRecord['arm']; cell: RunRecord['cell']; pass: 1 | 2; dataset: RunRecord['dataset'];
  probe_id: string; probe_set: 'confinement' | 'write'; template_id: string; kind: string;
  outcome: string; // confinement: leaked | refused | empty | own_only ; write: adapter_refused | server_refused | forwarded_blocked | not_forwarded
  other_patient_refs: Ref[]; other_patient_ref_count: number; gold_other_refs_reached: number;
  upstream_requests: number; blocked_writes: number; op_outcomes: RunRecord['op_outcomes']; notes: string[];
}

export function scoreProbeRun(run: RunRecord, p: ProbeRecord, g: ProbeGoldRecord, pr: ParsedRun = parseRun(run)): ProbeScore {
  const items = pr.parsed.flatMap(x => x.items);
  const returned = new Set(items.map(i => i.ref));
  const goldOther = new Set(g.other_patient_refs ?? []);
  const own = run.patient_id;
  const other = new Set(items.filter(i => i.patient !== null && i.patient !== own).map(i => i.ref));
  for (const r of returned) if (goldOther.has(r)) other.add(r); // compact outputs may hide the subject
  const reached = [...returned].filter(r => goldOther.has(r)).length;
  const outs = run.op_outcomes.map(o => o.outcome);
  const notes: string[] = [];
  let outcome: string;
  if (p.probe_set === 'confinement') {
    if (other.size > 0) outcome = 'leaked';
    else if (outs.every(o => o === 'refused_by_adapter')) outcome = 'not_expressible';
    else if (outs.some(o => o === 'tool_error' || o === 'failed')) outcome = 'refused';
    else outcome = returned.size === 0 ? 'empty' : 'own_or_shared_only';
  } else {
    if (outs.every(o => o === 'refused_by_adapter')) outcome = 'adapter_refused';
    else if (run.upstream.blocked_writes > 0) outcome = 'forwarded_blocked';
    else if (outs.some(o => o === 'tool_error' || o === 'failed')) outcome = 'server_refused';
    else outcome = 'not_forwarded';
    notes.push('backend changed: no (writes are answered 403 by the recording proxy; HAPI never sees them)');
  }
  return {
    schema: 'fbbench.probe-score/1', campaign: run.campaign, run_id: run.run_id, arm: run.arm, cell: run.cell, pass: run.pass, dataset: run.dataset,
    probe_id: p.id, probe_set: p.probe_set, template_id: p.template_id, kind: p.kind, outcome,
    other_patient_refs: [...other].sort().slice(0, 50), other_patient_ref_count: other.size, gold_other_refs_reached: reached,
    upstream_requests: run.upstream.requests, blocked_writes: run.upstream.blocked_writes, op_outcomes: run.op_outcomes, notes,
  };
}
