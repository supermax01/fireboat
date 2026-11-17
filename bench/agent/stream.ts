// Reads Claude Code's `--output-format stream-json --verbose` log. Pure functions, no I/O.
// Every line is parsed lexeme-preserving: tool results carry FHIR data.
import { LosslessNumber, parseLossless, parseNumbersAsStrings, stringifyLossless, utf8Bytes, type LosslessValue } from '../lib/json.js';
import type { AgentAnswer, AgentRunRecord } from '../lib/types.js';
import { isRequestedModel } from './host.js';

export const MCP_SERVER_NAME = 'ehr';
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';
export const HOST_TRUNCATION_MARKER = '[OUTPUT TRUNCATED - exceeded';
export const CONTEXT_CLEARED_MARKER = '[Old tool result content cleared]';

type Obj = { [key: string]: LosslessValue };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof LosslessNumber);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (v instanceof LosslessNumber ? Number(v.lexeme) : null);
const arr = (v: unknown): LosslessValue[] => (Array.isArray(v) ? v : []);

export interface StreamLine { text: string; at_ms: number } // at_ms: receipt time (epoch ms)

export interface ToolExchange {
  id: string;
  name: string;
  arguments: unknown;
  result_text: string | null; // concatenated text blocks as the model received them
  result_bytes: number;
  is_error: boolean;
  invalid: boolean; // host rejected the call (unknown tool or input validation)
}

export interface ParsedStream {
  init: AgentRunRecord['init'];
  init_at_ms: number | null;
  result_at_ms: number | null;
  models_seen: string[];
  tools: ToolExchange[];
  structured_output_raw: string | null;
  structured_output: AgentAnswer | null;
  structured_output_errors: string[];
  terminal_status: string | null;
  result_is_error: boolean | null;
  num_turns: number | null;
  usage: AgentRunRecord['usage'];
  total_cost_usd: string | null;
  model_usage: Record<string, unknown> | null;
  flags: AgentRunRecord['flags'];
  unparsable_lines: number;
  event_counts: Record<string, number>;
}

function blockText(content: LosslessValue | undefined): string {
  if (typeof content === 'string') return content;
  return arr(content).map(b => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}

const INVALID_CALL = /<tool_use_error>|InputValidationError|No such tool available|is not a valid tool/i;

export function parseStream(lines: readonly StreamLine[], opts: { requestedModel: string; expectServer: boolean }): ParsedStream {
  const out: ParsedStream = {
    init: null, init_at_ms: null, result_at_ms: null, models_seen: [], tools: [],
    structured_output_raw: null, structured_output: null, structured_output_errors: [],
    terminal_status: null, result_is_error: null, num_turns: null, usage: null, total_cost_usd: null, model_usage: null,
    flags: { f4_host: false, host_altered_context: false, wrong_model: false, server_connect_failed: false },
    unparsable_lines: 0, event_counts: {},
  };
  const byId = new Map<string, ToolExchange>();
  let initTools: string[] = [];

  for (const line of lines) {
    if (line.text.trim() === '') continue;
    if (line.text.includes(CONTEXT_CLEARED_MARKER)) out.flags.host_altered_context = true;
    let ev: LosslessValue;
    try { ev = parseLossless(line.text); } catch { out.unparsable_lines++; continue; }
    if (!isObj(ev)) { out.unparsable_lines++; continue; }
    const type = str(ev.type) ?? '?';
    const subtype = str(ev.subtype);
    const key = subtype ? `${type}/${subtype}` : type;
    out.event_counts[key] = (out.event_counts[key] ?? 0) + 1;

    if (type === 'system' && subtype === 'init') {
      initTools = arr(ev.tools).filter((t): t is string => typeof t === 'string');
      out.init = {
        server_status: ev.mcp_servers ?? null,
        tools: initTools,
        claude_code_version: str(ev.claude_code_version),
        model: str(ev.model),
      };
      out.init_at_ms = line.at_ms;
      const servers = arr(ev.mcp_servers).filter(isObj);
      if (opts.expectServer) {
        const ehr = servers.find(s => s.name === MCP_SERVER_NAME);
        if (!ehr || ehr.status !== 'connected') out.flags.server_connect_failed = true;
      }
    } else if (type === 'system' && subtype === 'compact_boundary') {
      out.flags.host_altered_context = true;
    } else if (type === 'assistant' && isObj(ev.message)) {
      const model = str(ev.message.model);
      if (model && !out.models_seen.includes(model)) out.models_seen.push(model);
      for (const b of arr(ev.message.content)) {
        if (!isObj(b) || b.type !== 'tool_use') continue;
        const id = str(b.id) ?? `anon-${byId.size}`;
        const name = str(b.name) ?? '';
        const t: ToolExchange = { id, name, arguments: b.input ?? null, result_text: null, result_bytes: 0, is_error: false, invalid: false };
        if (initTools.length > 0 && !initTools.includes(name)) t.invalid = true;
        byId.set(id, t);
        out.tools.push(t);
      }
    } else if (type === 'user' && isObj(ev.message)) {
      for (const b of arr(ev.message.content)) {
        if (!isObj(b) || b.type !== 'tool_result') continue;
        const t = byId.get(str(b.tool_use_id) ?? '');
        const text = blockText(b.content);
        if (text.includes(HOST_TRUNCATION_MARKER)) out.flags.f4_host = true;
        if (!t) continue;
        t.result_text = (t.result_text ?? '') + text;
        t.result_bytes += utf8Bytes(text);
        t.is_error = t.is_error || b.is_error === true;
        if (t.is_error && INVALID_CALL.test(text)) t.invalid = true;
      }
    } else if (type === 'result') {
      out.result_at_ms = line.at_ms;
      out.terminal_status = subtype;
      out.result_is_error = typeof ev.is_error === 'boolean' ? ev.is_error : null;
      out.num_turns = num(ev.num_turns);
      out.total_cost_usd = ev.total_cost_usd instanceof LosslessNumber ? ev.total_cost_usd.lexeme : null;
      if (isObj(ev.usage)) {
        out.usage = {
          input: num(ev.usage.input_tokens) ?? 0,
          output: num(ev.usage.output_tokens) ?? 0,
          cache_write: num(ev.usage.cache_creation_input_tokens) ?? 0,
          cache_read: num(ev.usage.cache_read_input_tokens) ?? 0,
        };
      }
      out.model_usage = isObj(ev.modelUsage) ? (parseNumbersAsStrings(stringifyLossless(ev.modelUsage)) as Record<string, unknown>) : null;
      if (ev.structured_output !== undefined && ev.structured_output !== null) {
        out.structured_output_raw = stringifyLossless(ev.structured_output);
      }
    }
  }

  // Fallback: the last StructuredOutput tool input, if the result event carried none.
  if (out.structured_output_raw === null) {
    const so = [...out.tools].reverse().find(t => t.name === STRUCTURED_OUTPUT_TOOL && !t.is_error);
    if (so && so.arguments !== null) out.structured_output_raw = stringifyLossless(so.arguments);
  }
  if (out.structured_output_raw !== null) {
    const parsed = parseNumbersAsStrings(out.structured_output_raw);
    const errors = validateAnswer(parsed);
    out.structured_output_errors = errors;
    if (errors.length === 0) out.structured_output = parsed as AgentAnswer;
  }
  if (out.init?.model && !isRequestedModel(out.init.model, opts.requestedModel)) out.flags.wrong_model = true;
  if (out.models_seen.some(m => !isRequestedModel(m, opts.requestedModel))) out.flags.wrong_model = true;
  return out;
}

const KINDS = ['value', 'list', 'none'];
const COMPLETENESS = ['all_retrieved', 'not_all_retrieved', 'not_sure'];
const RESOURCE_ID = /^[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/;
const FIELDS = ['answer_kind', 'answer', 'answer_list', 'value_as_recorded', 'unit', 'timestamp', 'resource_ids', 'completeness', 'abstained', 'explanation'];

/** Validates against agent/answer.schema.json (hand-written for that one schema; a test keeps them in step). */
export function validateAnswer(v: unknown): string[] {
  const e: string[] = [];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return ['not an object'];
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!FIELDS.includes(k)) e.push(`extra field ${k}`);
  for (const k of FIELDS) if (!(k in o)) e.push(`missing ${k}`);
  const strOrNull = (k: string) => { if (k in o && o[k] !== null && typeof o[k] !== 'string') e.push(`${k} not string|null`); };
  if ('answer_kind' in o && !KINDS.includes(o.answer_kind as string)) e.push('answer_kind');
  strOrNull('answer'); strOrNull('value_as_recorded'); strOrNull('unit'); strOrNull('timestamp');
  if ('answer_list' in o && o.answer_list !== null && !(Array.isArray(o.answer_list) && o.answer_list.every(x => typeof x === 'string'))) e.push('answer_list');
  if ('resource_ids' in o && !(Array.isArray(o.resource_ids) && o.resource_ids.every(x => typeof x === 'string' && RESOURCE_ID.test(x)))) e.push('resource_ids');
  if ('completeness' in o && !COMPLETENESS.includes(o.completeness as string)) e.push('completeness');
  if ('abstained' in o && typeof o.abstained !== 'boolean') e.push('abstained');
  if ('explanation' in o && typeof o.explanation !== 'string') e.push('explanation');
  return e;
}

/** MCP tool outputs only (the evidence the model saw from the server). */
export const mcpExchanges = (p: ParsedStream) => p.tools.filter(t => t.name.startsWith(MCP_TOOL_PREFIX));
