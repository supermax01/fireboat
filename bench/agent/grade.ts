// Deterministic grading of one agent answer against gold and the automatic failure causes.
// Pure functions. Grading choices beyond the plain comparison are marked "rule:" and listed in the agent report.
import type { AgentAnswer, AgentRunRecord, AgentScoreRecord, ArmId, GoldRecord } from '../lib/types.js';
import type { ToolExchange } from './stream.js';

// ---- normalisers --------------------------------------------------------------------------------------------

/** Canonical decimal string (sign, digits without leading or trailing zeros, exponent), or null if not a number. */
export function canonicalDecimal(s: string): string | null {
  const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null;
  let digits = (m[2] ?? '') + (m[3] ?? '');
  let exp = (m[4] ? Number(m[4]) : 0) - (m[3] ?? '').length;
  digits = digits.replace(/^0+/, '');
  if (digits === '') return '0';
  const trailing = /0*$/.exec(digits)![0].length;
  digits = digits.slice(0, digits.length - trailing);
  exp += trailing;
  return `${m[1] === '-' ? '-' : ''}${digits}e${exp}`;
}

export const decimalEqual = (a: string, b: string): boolean => {
  const x = canonicalDecimal(a), y = canonicalDecimal(b);
  return x !== null && x === y;
};

/** Case and whitespace normalisation for text and list items. */
export const normText = (s: string): string => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

const DATE_TIME = /^(\d{4})(?:-(\d\d)(?:-(\d\d)(?:T(\d\d):(\d\d)(?::(\d\d)(?:\.(\d+))?)?)?)?)?(Z|[+-]\d\d:\d\d)?$/;

/** Precision of an ISO 8601 / FHIR dateTime: year, month, day, minute, second or fraction. */
function precisionOf(m: RegExpExecArray): number {
  return m[7] !== undefined ? 6 : m[6] !== undefined ? 5 : m[4] !== undefined ? 4 : m[3] !== undefined ? 3 : m[2] !== undefined ? 2 : 1;
}

/**
 * Instants equal at the gold's precision. With an offset on both sides: compared as UTC instants.
 * rule: an answer without an offset matches only if its literal local date-time equals the gold's at that precision.
 */
export function instantEqual(answer: string, gold: string): boolean {
  const a = DATE_TIME.exec(answer.trim()), g = DATE_TIME.exec(gold.trim());
  if (!a || !g) return false;
  const p = precisionOf(g);
  if (precisionOf(a) < p) return false;
  if (p <= 3 || g[8] === undefined || a[8] === undefined) {
    // date-only gold, or no offset somewhere: literal comparison of the fields up to the gold's precision
    for (let i = 1; i <= Math.min(p, 6); i++) if ((a[i] ?? '') !== (g[i] ?? '')) return false;
    if (p === 6 && (a[7] ?? '').replace(/0+$/, '') !== (g[7] ?? '').replace(/0+$/, '')) return false;
    return true;
  }
  const ms = (m: RegExpExecArray, trunc: number) => {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${trunc >= 5 ? m[6] ?? '00' : '00'}${trunc >= 6 && m[7] ? '.' + m[7].slice(0, 3).padEnd(3, '0') : ''}${m[8] === 'Z' ? 'Z' : m[8]}`;
    return Date.parse(iso);
  };
  const x = ms(a, p), y = ms(g, p);
  return Number.isFinite(x) && x === y;
}

// ---- correctness ----------------------------------------------------------------------------------------------

export interface Correctness { correct: boolean; value_right: boolean; unit_or_time_wrong: boolean; notes: string[] }

const unitNorm = (u: string | null): string => (u ?? '').trim();

/**
 * Units of derived values (computed by the gold rules, not read from a record: E3 hours, F1 and F3 amounts) with their
 * accepted spellings. rule: for a derived value the unit is compared through this table, and a missing unit is accepted.
 */
const DERIVED_UNIT_SYNONYMS: Record<string, string[]> = {
  h: ['h', 'hr', 'hrs', 'hour', 'hours'],
  d: ['d', 'day', 'days'],
  min: ['min', 'mins', 'minute', 'minutes'],
  usd: ['usd', '$', 'us$', 'dollar', 'dollars', 'us dollars'],
  a: ['a', 'y', 'yr', 'yrs', 'year', 'years'],
};
function derivedUnitOk(answer: string | null, gold: string | null): boolean {
  if (gold === null || answer === null || answer.trim() === '') return true;
  const a = normText(answer), g = normText(gold);
  if (a === g) return true;
  const syn = Object.values(DERIVED_UNIT_SYNONYMS).find(list => list.includes(g));
  return syn !== undefined && syn.includes(a);
}

/** Text values compare after case and whitespace normalisation and without trailing sentence punctuation ("NONE." = "none"). */
const textKey = (s: string): string => normText(s).replace(/[.;:,!]+$/, '');

// Composite list entries ("<value> <unit> @ <time>", "<organism> (<specimen>)", "<modality> | <body site>", "key: value")
// are harness formats the agent is never told (the prompt does not describe them), so they are graded by their fields.
const COMPOSITE = /( @ | \| |: |\(.*\)$)/;
/** Labels the gold rules invent (D1, M2); optional in an answer entry. */
const HARNESS_LABELS = new Set(['birth_date', 'deceased', 'gender', 'instances', 'series']);
const DATE_TOKEN = /^\d{4}(-\d\d(-\d\d(T[0-9:.]+(Z|[+-]\d\d:\d\d)?)?)?)?$/;

/** Field tokens of a composite gold entry: decimals, date-times and words, separators and harness labels removed. */
export function compositeTokens(entry: string): string[] {
  return entry.split(/ @ | \| |: |[()]/).flatMap(f => f.trim().split(/\s+/)).map(t => t.trim()).filter(t => t !== '' && !HARNESS_LABELS.has(t.toLowerCase()));
}

/** rule: an answer entry matches a composite gold entry if it contains every field token (decimal-equal, instant-equal or as a word). */
export function compositeMatch(answer: string, gold: string): boolean {
  const aTokens = answer.split(/[\s,;|()@]+/).filter(Boolean);
  const aText = ` ${normText(answer).replace(/[(),;|@]/g, ' ').replace(/\s+/g, ' ')} `;
  return compositeTokens(gold).every(t => {
    if (DATE_TOKEN.test(t) && t.length > 4) return aTokens.some(x => DATE_TOKEN.test(x) && instantEqual(x, t));
    if (canonicalDecimal(t) !== null) return aTokens.some(x => decimalEqual(x.replace(/[^0-9eE+.-]/g, ''), t));
    return aText.includes(` ${normText(t)} `) || aText.includes(normText(t));
  });
}

/** Exact set equality after normalisation; composite gold entries are matched by fields, one answer entry per gold entry. */
export function listEqual(answer: readonly string[], gold: readonly string[]): { equal: boolean; byFields: boolean } {
  const dedupe = (xs: readonly string[]) => [...new Map(xs.map(x => [normText(x), x.trim()])).entries()]; // [normalised, original]
  const gs = dedupe(gold), as = dedupe(answer);
  const byFields = gold.some(g => COMPOSITE.test(g));
  if (gs.length !== as.length) return { equal: false, byFields };
  if (gs.every(([x]) => as.some(([y]) => y === x))) return { equal: true, byFields: false };
  // Bipartite matching (lists are short): gold entry i may take answer entry j if equal, or composite and field-matched.
  const ok = (i: number, j: number) => gs[i]![0] === as[j]![0] || (COMPOSITE.test(gs[i]![1]) && compositeMatch(as[j]![1], gs[i]![1]));
  const owner = new Array<number>(as.length).fill(-1);
  const assign = (i: number, seen: boolean[]): boolean => {
    for (let j = 0; j < as.length; j++) {
      if (seen[j] || !ok(i, j)) continue;
      seen[j] = true;
      if (owner[j] === -1 || assign(owner[j]!, seen)) { owner[j] = i; return true; }
    }
    return false;
  };
  for (let i = 0; i < gs.length; i++) if (!assign(i, new Array<boolean>(as.length).fill(false))) return { equal: false, byFields };
  return { equal: true, byFields };
}

export function gradeAnswer(a: AgentAnswer | null, g: GoldRecord): Correctness {
  const notes: string[] = [];
  if (!a) return { correct: false, value_right: false, unit_or_time_wrong: false, notes: ['no valid structured output'] };
  if (a.abstained) return { correct: false, value_right: false, unit_or_time_wrong: false, notes: ['abstained'] };
  if (g.answer_kind === 'none') {
    const ok = a.answer_kind === 'none';
    return { correct: ok, value_right: ok, unit_or_time_wrong: false, notes };
  }
  // rule: for a yes/no gold "no", answer_kind "none" is the prompt's way of saying the thing is absent: equal to "no".
  if (g.answer_form === 'yes_no' && a.answer_kind === 'none' && g.answer !== null && normText(g.answer) === 'no') {
    return { correct: true, value_right: true, unit_or_time_wrong: false, notes: ['answer_kind none read as "no"'] };
  }
  // rule: a recorded text value (for example L7 "NONE.") is graded on the value only, whatever answer_kind says.
  const textGold = g.answer_form === 'value' && g.answer !== null && canonicalDecimal(g.answer) === null && g.unit === null; // not ">300" or "120/80"
  if (textGold) {
    const given = a.answer ?? (a.answer_kind === 'none' ? 'none' : null);
    const ok = given !== null && textKey(given) === textKey(g.answer!);
    return { correct: ok, value_right: ok, unit_or_time_wrong: false, notes };
  }
  if (a.answer_kind === 'none') return { correct: false, value_right: false, unit_or_time_wrong: false, notes: ['answered none'] };

  if (g.answer_form === 'list') {
    const r = listEqual(a.answer_list ?? (a.answer !== null ? [a.answer] : []), g.answer_list ?? []);
    if (r.byFields) notes.push('composite list entries graded by fields');
    return { correct: r.equal, value_right: r.equal, unit_or_time_wrong: false, notes };
  }
  const given = a.answer ?? (g.answer_form === 'datetime' ? a.timestamp : null);
  if (given === null || g.answer === null) return { correct: false, value_right: false, unit_or_time_wrong: false, notes: ['no answer value'] };

  let valueRight: boolean;
  switch (g.answer_form) {
    case 'count': valueRight = /^\s*\d+\s*$/.test(given) && decimalEqual(given, g.answer); break;
    case 'yes_no': valueRight = normText(given) === normText(g.answer); break;
    case 'datetime': valueRight = instantEqual(given, g.answer); break;
    case 'value':
    default:
      valueRight = canonicalDecimal(g.answer) !== null ? decimalEqual(given, g.answer) : normText(given) === normText(g.answer);
  }
  if (!valueRight) return { correct: false, value_right: false, unit_or_time_wrong: false, notes };

  // Unit and time apply to recorded values (failure code F7). Derived values use the synonym table.
  let unitOrTimeWrong = false;
  if (g.answer_form === 'value') {
    const derived = g.value_as_recorded === null;
    const unitOk = derived ? derivedUnitOk(a.unit, g.unit) : unitNorm(a.unit) === unitNorm(g.unit);
    if (!unitOk) { unitOrTimeWrong = true; notes.push(`unit ${JSON.stringify(a.unit)} != ${JSON.stringify(g.unit)}`); }
    // rule: a missing timestamp is not wrong; a stated one must match the gold instant.
    if (g.timestamp !== null && a.timestamp !== null && !instantEqual(a.timestamp, g.timestamp)) {
      unitOrTimeWrong = true; notes.push('timestamp differs');
    }
  }
  return { correct: !unitOrTimeWrong, value_right: true, unit_or_time_wrong: unitOrTimeWrong, notes };
}

// ---- retrieval evidence -------------------------------------------------------------------------------------

const idPart = (ref: string) => ref.slice(ref.indexOf('/') + 1);

/**
 * rule: a gold record "appeared" in the tool outputs if its id occurs there as a whole token.
 * Ids in both datasets are UUID-shaped, so accidental matches are negligible.
 */
export function refsSeen(refs: readonly string[], outputs: readonly string[]): Set<string> {
  const text = outputs.join('\n');
  const seen = new Set<string>();
  for (const r of refs) {
    const id = idPart(r).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^A-Za-z0-9.-])${id}($|[^A-Za-z0-9.-])`).test(text)) seen.add(r);
  }
  return seen;
}

/** FHIR-AgentBench empty-set conventions: both empty gives P = R = 1. rule: other empty cases give 0. */
export function precisionRecall(cited: readonly string[], gold: readonly string[]): { precision: number; recall: number } {
  const c = new Set(cited), g = new Set(gold);
  if (c.size === 0 && g.size === 0) return { precision: 1, recall: 1 };
  const hit = [...c].filter(x => g.has(x)).length;
  return { precision: c.size === 0 ? 0 : hit / c.size, recall: g.size === 0 ? 0 : hit / g.size };
}

/** Lexeme-normalised tokens of the tool outputs: canonical decimals and normalised text (failure code F5). */
export function valueInOutputs(value: string, outputs: readonly string[]): boolean {
  const target = canonicalDecimal(value);
  if (target !== null) {
    for (const o of outputs) for (const m of o.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) if (canonicalDecimal(m[0]) === target) return true;
    return false;
  }
  const t = normText(value);
  return t.length > 0 && outputs.some(o => normText(o).includes(t));
}

const REFUSAL = /not supported|unsupported|not allowed|forbidden|refus|UNSUPPORTED|NOT_ALLOWED|DENIED/i;
const INVALID_PARAM = /invalid|validation|unknown (search )?param|not a valid|INVALID/i;
const SERVER_FAILURE = /ECONNREFUSED|connection (refused|closed|reset)|server (crashed|error)|MCP error -32000|timed? ?out|ETIMEDOUT/i;
/** Query-specific paging signals as they appear in text (counted signals). Heuristic for F3. */
const PAGING_SIGNAL = /"relation"\s*:\s*"next"|next_?(page|link|cursor)|MORE_PAGES|has_?more"?\s*[:=]\s*true|"cursor"\s*:\s*"[^"]+"|"continuation/i;

export interface ScoreInputs {
  run: AgentRunRecord;
  gold: GoldRecord;
  exchanges: ToolExchange[]; // MCP tool exchanges only
  /** Patient of each cited ref, from the dataset files; null when unknown. */
  citedPatients: Map<string, string | null>;
}

export function scoreRun(i: ScoreInputs): AgentScoreRecord & { notes: string[] } {
  const { run, gold, exchanges } = i;
  const a = run.structured_output;
  const c = gradeAnswer(a, gold);
  const outputs = exchanges.map(e => e.result_text ?? '');
  const depends = gold.depends_on.length > 0 ? gold.depends_on : gold.provenance;
  const seen = refsSeen(depends, outputs);
  const allRetrieved = depends.length === 0 ? true : seen.size === depends.length;
  const cited = a?.resource_ids ?? [];
  const pr = a ? precisionRecall(cited, gold.provenance) : null;
  const failure: string[] = [];
  const add = (code: string, on: boolean) => { if (on && !failure.includes(code)) failure.push(code); };
  const errors = exchanges.filter(e => e.is_error).map(e => e.result_text ?? '');

  add('F1', errors.some(t => REFUSAL.test(t)));
  add('F2', exchanges.some(e => e.invalid) || errors.some(t => INVALID_PARAM.test(t)));
  add('F3', !c.correct && !allRetrieved && outputs.some(t => PAGING_SIGNAL.test(t)));
  add('F4-host', run.flags.f4_host);
  add('F4-ctx', run.flags.host_altered_context);
  // F4-srv needs the arm's parser over the raw server responses; not computed in the smoke (agent report).
  const singleRecordedValue = gold.answer_form === 'value' && gold.answer_kind === 'value';
  add('F5', singleRecordedValue && !c.correct && !!a && !a.abstained && a.answer !== null && !valueInOutputs(a.answer, outputs));
  add('F6', [...i.citedPatients.values()].some(p => p !== null && p !== run.patient_id));
  add('F7', c.value_right && c.unit_or_time_wrong);
  add('F8', !!a && a.abstained);
  add('F9', run.terminal_status === 'error_max_turns' || run.terminal_status === 'error_max_budget_usd');
  add('F10', run.flags.server_connect_failed || errors.some(t => SERVER_FAILURE.test(t)));
  add('F11', !!a && a.completeness === 'all_retrieved' && !c.correct && !allRetrieved);
  add('F12', !!a && !a.abstained && !c.correct && a.answer_kind === 'none' && gold.answer_kind !== 'none');
  add('F13', !!a && (a.completeness === 'not_all_retrieved' || a.completeness === 'not_sure') && allRetrieved && depends.length > 0);
  if (!a) failure.push('NO_ANSWER');

  const lexemeEligible = gold.lexeme_eligible && gold.value_as_recorded !== null;
  return {
    schema: 'fbbench.agent-score/1',
    run_id: run.run_id,
    arm: run.arm as ArmId,
    question_id: run.question_id,
    correct: c.correct ? 1 : 0,
    answered: !!a && !a.abstained,
    resource_id_precision: pr?.precision ?? null,
    resource_id_recall: pr?.recall ?? null,
    completeness_claim: a?.completeness ?? null,
    all_retrieved_from_log: allRetrieved,
    lexeme_match: lexemeEligible && a && a.value_as_recorded !== null ? a.value_as_recorded === gold.value_as_recorded : lexemeEligible && a ? false : null,
    failure,
    notes: c.notes,
  };
}
