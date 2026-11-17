// Fuzz classification and summary. Scores are recomputed from the raw run records, so a rule change never
// needs a rerun. No combined score: each measure is reported on its own.
import { parseLossless } from '../lib/json.js';
import type { ArmId, CallRecord, ParsedResult, ToolCall } from '../lib/types.js';
import type { CallOutcome } from '../servers/arms.js';
import { parserFor } from '../servers/parsers.js';
import { isObj } from '../servers/items.js';
import { CATEGORIES, type Expect, type FuzzCategory } from './corpus.js';
import type { CanaryHit } from './mock.js';
import type { SetupCall } from './execute.js';

export interface UpstreamRequest { seq: number; method: string; path: string; status: number; blocked: boolean }

export interface FuzzRunRecord {
  schema: 'fbbench.fuzz-run/1';
  campaign: string;
  run_id: string;
  arm: ArmId;
  dataset: string;
  case_id: string;
  category: FuzzCategory;
  kind: string;
  expect: Expect;
  malformed_mcp: boolean;
  lexeme: string | null; // adversarial-number cases
  number_id: string | null;
  slot: number;
  patient_id: string;
  other_patient_id: string;
  started_at: string;
  wall_ms: number;
  server: { pid: number | null; cold_start_ms: number | null; protocol_version: string | null; exit: { code: number | null; signal: string | null } | null; stderr_path: string; egress_sandbox: string; start_error: string | null };
  not_expressible: string | null;
  tool_call: ToolCall | null;
  setup_calls: SetupCall[];
  call: CallOutcome | null;
  /** MCP ping after the case: the process still answers. */
  responsive_after: boolean | null;
  /** Upstream requests the fuzz call caused (recording proxy, by sequence number). */
  upstream: UpstreamRequest[];
  canary_hits: CanaryHit[];
  versions: Record<string, unknown>;
}

export type Outcome =
  | 'is_error' | 'operation_outcome' | 'jsonrpc_error' // structured errors
  | 'success' | 'unparsed' | 'timeout' | 'crash' | 'transport_error' | 'not_expressible' | 'server_start_failed';
export const STRUCTURED: readonly Outcome[] = ['is_error', 'operation_outcome', 'jsonrpc_error'];

export type NumberOutcome = 'preserved' | 'refused' | 'silently_altered' | 'dropped';

export interface FuzzScore {
  schema: 'fbbench.fuzz-score/1';
  run_id: string; arm: ArmId; case_id: string; category: FuzzCategory; expect: Expect; malformed_mcp: boolean;
  outcome: Outcome;
  structured_error: boolean;
  expressible: boolean;
  /** expect error: a structured error; either: a structured error or a clean result; value: preserved or refused. null when not expressible. */
  acceptable: boolean | null;
  success_shaped_failure: boolean;
  /** HTTP statuses of the non-metadata upstream requests the call caused (what HAPI answered to a forwarded query). */
  backend_statuses: number[];
  /** A success-shaped failure where the server forwarded the query and HAPI answered every request with 2xx. */
  backend_accepted: boolean;
  survived: boolean | null;
  refused_before_upstream: boolean | null; // malformed MCP input only
  upstream_requests: number;
  upstream_non_metadata: number;
  canary_hits: number;
  leaks: { stack_trace: boolean; file_path: boolean; secret: boolean };
  number_outcome: NumberOutcome | null;
  number_served: string | null;
  other_patient: { refs: string[]; id_in_output: boolean };
  write_attempts: number;
  latency_ms: number | null;
  error_text: string;
}

const STACK = [/\bat [\w$.<>[\]]+ \(?[^\s()]+:\d+:\d+\)?/, /Traceback \(most recent call last\)/, /File "[^"]+", line \d+/, /\bat (async )?[\w$.]+ \(node:/];
const PATH = [/\/Users\/[\w.-]+\//, /\/home\/[\w.-]+\//, /\/private\/var\//, /\/var\/folders\//, /site-packages\//, /node_modules\//, /\.local\/bench-/, /\/opt\/homebrew\//];
const SECRET = [/fbbench-static-token/, /\bBearer [A-Za-z0-9._-]{8,}/, /client_secret/i, /FHIR_SERVER_CLIENT_SECRET/, /ANTHROPIC_API_KEY/];

/** Text a person would read: content[].text, else the JSON-RPC error message. */
export function errorText(call: CallOutcome | null): string {
  if (!call) return '';
  const parts: string[] = [];
  if (call.response_raw) {
    const msg = parseLossless(call.response_raw);
    if (isObj(msg) && isObj(msg.result) && Array.isArray(msg.result.content)) {
      for (const c of msg.result.content) if (isObj(c) && typeof c.text === 'string') parts.push(c.text);
    }
    if (isObj(msg) && isObj(msg.error)) parts.push(`${String(msg.error.code ?? '')} ${String(msg.error.message ?? '')}`.trim());
  }
  if (!parts.length && call.error) parts.push(`${call.error.kind}: ${call.error.message}`);
  return parts.join('\n');
}

const parseCall = (arm: ArmId, call: CallOutcome): ParsedResult => {
  const rec: CallRecord = { seq: 0, op_index: 0, op: 'search', ...call };
  return parserFor(arm).parse(rec);
};

export function classify(r: FuzzRunRecord): FuzzScore {
  const base = {
    schema: 'fbbench.fuzz-score/1' as const, run_id: r.run_id, arm: r.arm, case_id: r.case_id, category: r.category, expect: r.expect,
    malformed_mcp: r.malformed_mcp,
  };
  const blocked = r.upstream.filter(u => u.blocked).length;
  const nonMeta = r.upstream.filter(u => !/\/metadata\/?$/.test(u.path)).length;
  const hits = r.canary_hits.length;
  const empty: FuzzScore = {
    ...base, outcome: 'not_expressible', structured_error: false, expressible: false, acceptable: null, success_shaped_failure: false,
    backend_statuses: r.upstream.filter(u => !/\/metadata\/?$/.test(u.path)).map(u => u.status), backend_accepted: false,
    survived: r.responsive_after, refused_before_upstream: null, upstream_requests: r.upstream.length, upstream_non_metadata: nonMeta,
    canary_hits: hits, leaks: { stack_trace: false, file_path: false, secret: false }, number_outcome: null, number_served: null,
    other_patient: { refs: [], id_in_output: false }, write_attempts: blocked, latency_ms: null, error_text: '',
  };
  if (r.server.start_error) return { ...empty, outcome: 'server_start_failed', error_text: r.server.start_error.slice(0, 2000) };
  if (r.not_expressible !== null || !r.call) return { ...empty, error_text: r.not_expressible ?? '' };

  const call = r.call;
  const parsed = call.response_raw ? parseCall(r.arm, call) : null;
  const rpcError = (() => {
    if (!call.response_raw) return false;
    const msg = parseLossless(call.response_raw);
    return isObj(msg) && msg.error !== undefined;
  })();
  let outcome: Outcome;
  if (call.error?.kind === 'crash' || (r.responsive_after === false && !call.response_raw)) outcome = 'crash';
  else if (call.error?.kind === 'timeout') outcome = 'timeout';
  else if (rpcError) outcome = 'jsonrpc_error';
  else if (call.error) outcome = 'transport_error';
  else if (call.is_error === true) outcome = 'is_error';
  else if (parsed?.refused && parsed.refused.code !== 'unparsed') outcome = 'operation_outcome';
  else if (parsed?.refused?.code === 'unparsed') outcome = 'unparsed';
  else outcome = 'success';
  const structured = STRUCTURED.includes(outcome);

  const text = errorText(call);
  const nonSuccess = outcome !== 'success';
  const leaks = {
    stack_trace: nonSuccess && STACK.some(p => p.test(text)),
    file_path: nonSuccess && PATH.some(p => p.test(text)),
    secret: SECRET.some(p => p.test(call.response_raw ?? '')),
  };

  const items = parsed?.items ?? [];
  const otherRefs = items.filter(i => i.patient !== null && i.patient !== r.patient_id).map(i => i.ref);
  const idInOutput = (call.response_raw ?? '').includes(r.other_patient_id);

  let numberOutcome: NumberOutcome | null = null;
  let served: string | null = null;
  if (r.expect === 'value' && r.number_id && r.lexeme !== null) {
    const it = items.find(i => i.ref === `Observation/${r.number_id}`);
    served = it?.value ?? null;
    if (structured) numberOutcome = 'refused';
    else if (!it) numberOutcome = 'dropped';
    else numberOutcome = it.value === r.lexeme ? 'preserved' : 'silently_altered';
  }

  const ssf = r.expect === 'error' && (outcome === 'success' || outcome === 'unparsed');
  const statuses = empty.backend_statuses;
  const acceptable = r.expect === 'error' ? structured
    : r.expect === 'either' ? structured || outcome === 'success'
    : numberOutcome === 'preserved' || numberOutcome === 'refused';
  return {
    ...empty,
    outcome, structured_error: structured, expressible: true, acceptable,
    success_shaped_failure: ssf, backend_accepted: ssf && statuses.length > 0 && statuses.every(x => x >= 200 && x < 300),
    refused_before_upstream: r.malformed_mcp ? structured && nonMeta === 0 : null,
    leaks, number_outcome: numberOutcome, number_served: served,
    other_patient: { refs: otherRefs, id_in_output: idInOutput }, latency_ms: call.latency_ms, error_text: text.slice(0, 2000),
  };
}

const count = <T>(xs: readonly T[], f: (x: T) => boolean) => xs.filter(f).length;

export interface ArmSummary {
  arm: string; dataset: string; cases: number; expressible: number; not_expressible: number;
  survived: number; crashes: number; timeouts: number; start_failures: number;
  outcomes: Record<string, number>;
  expect_error: { n: number; structured: number; success_shaped_failures: number; backend_accepted: number };
  expect_either: { n: number; acceptable: number };
  acceptable: { n: number; k: number };
  malformed_mcp: { n: number; refused_before_upstream: number; structured: number };
  canary_hit_cases: number; leak_cases: { stack_trace: number; file_path: number; secret: number };
  numbers: Record<NumberOutcome | 'not_expressible', number>;
  other_patient_cases: number; other_patient_id_in_output_cases: number; write_attempt_cases: number;
  by_category: Record<string, { n: number; expressible: number; acceptable: number }>;
}

export function summarise(scores: readonly FuzzScore[], dataset: string): ArmSummary[] {
  const arms = [...new Set(scores.map(s => s.arm))];
  return arms.map(arm => {
    const ss = scores.filter(s => s.arm === arm);
    const ex = ss.filter(s => s.expressible);
    const outcomes: Record<string, number> = {};
    for (const s of ss) outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;
    const err = ex.filter(s => s.expect === 'error');
    const either = ex.filter(s => s.expect === 'either');
    const mal = ex.filter(s => s.malformed_mcp);
    const nums = ss.filter(s => s.expect === 'value');
    const by_category: ArmSummary['by_category'] = {};
    for (const c of CATEGORIES) {
      const cs = ss.filter(s => s.category === c);
      by_category[c] = { n: cs.length, expressible: count(cs, s => s.expressible), acceptable: count(cs, s => s.acceptable === true) };
    }
    return {
      arm, dataset, cases: ss.length, expressible: ex.length, not_expressible: ss.length - ex.length,
      survived: count(ss, s => s.survived === true), crashes: count(ss, s => s.outcome === 'crash'), timeouts: count(ss, s => s.outcome === 'timeout'),
      start_failures: count(ss, s => s.outcome === 'server_start_failed'),
      outcomes,
      expect_error: { n: err.length, structured: count(err, s => s.structured_error), success_shaped_failures: count(err, s => s.success_shaped_failure), backend_accepted: count(err, s => s.backend_accepted) },
      expect_either: { n: either.length, acceptable: count(either, s => s.acceptable === true) },
      acceptable: { n: ex.length, k: count(ex, s => s.acceptable === true) },
      malformed_mcp: { n: mal.length, refused_before_upstream: count(mal, s => s.refused_before_upstream === true), structured: count(mal, s => s.structured_error) },
      canary_hit_cases: count(ss, s => s.canary_hits > 0),
      leak_cases: { stack_trace: count(ss, s => s.leaks.stack_trace), file_path: count(ss, s => s.leaks.file_path), secret: count(ss, s => s.leaks.secret) },
      numbers: {
        preserved: count(nums, s => s.number_outcome === 'preserved'), refused: count(nums, s => s.number_outcome === 'refused'),
        silently_altered: count(nums, s => s.number_outcome === 'silently_altered'), dropped: count(nums, s => s.number_outcome === 'dropped'),
        not_expressible: count(nums, s => !s.expressible),
      },
      other_patient_cases: count(ss, s => s.other_patient.refs.length > 0), other_patient_id_in_output_cases: count(ss, s => s.other_patient.id_in_output),
      write_attempt_cases: count(ss, s => s.write_attempts > 0),
      by_category,
    };
  });
}

export const FUZZ_RULES = [
  'Cases are adversarial, not natural prevalence. Each case runs in a fresh server process behind the slot\'s recording proxy; the backend chain is recording proxy -> mock backend (adversarial numbers only; everything else passes through) -> HAPI.',
  'Structured error: MCP isError true, an OperationOutcome relayed in the result (or fireboat\'s error envelope), or a JSON-RPC error response. JSON-RPC errors are counted separately in the outcome table.',
  'Expectation per case (fuzz/corpus.json): "error" means a structured error is the right answer and any result-shaped answer is a success-shaped failure; "either" accepts a structured error or a clean result (a valid-looking FHIR parameter is HAPI\'s to judge); "value" means the adversarial number must be preserved or refused.',
  'Success-shaped failures are also counted where the server forwarded the query and HAPI itself answered 2xx ("HAPI accepted"): there the answer is HAPI\'s, relayed.',
  'Survived: the process answered an MCP ping after the case. Crash: the process exited during the call. Timeout: no answer within 30 s.',
  'Refused before upstream (malformed MCP input only): a structured error and no upstream request other than a CapabilityStatement fetch during the call.',
  'Not expressible: the arm\'s adapter cannot express the case with the tools the server lists (for example no paging tool), or a schema-driven mutation does not apply to the tool call. Excluded from every denominator.',
  'Leak markers are pattern matches on the text of non-success answers (stack frames, absolute paths, the harness token or credential names); they are indicators, not a security finding.',
  'Other-patient data: a returned record whose subject or patient is another patient. Write attempts: write requests the recording proxy blocked during the case.',
  'Error clarity (0-3, two blinded raters, Cohen\'s kappa) is not rated here; a blinded rating sheet is written beside the scores.',
];
