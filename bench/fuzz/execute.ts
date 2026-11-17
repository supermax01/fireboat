// One fuzz case through one arm's adapter. The adapter expresses the abstract operation from the tools the
// server listed; a mutation then changes the resulting tool call by rules driven by that tool's input schema, so every
// arm gets the same kind of malformed input. Nothing here interprets results; fuzz/score.ts classifies the record.
import { HAPI_PORT } from '../lib/paths.js';
import type { ParsedResult, ToolCall } from '../lib/types.js';
import type { Adapter, CallOutcome, Parser, Refusal } from '../servers/arms.js';
import type { ListedTool } from '../servers/adapters.js';
import type { FuzzCase, FuzzOp, Mutation } from './corpus.js';

export const FUZZ_CALL_TIMEOUT_MS = 30_000;
export const SETUP_CALL_TIMEOUT_MS = 60_000;

export interface Caller { call(call: ToolCall, timeoutMs: number): Promise<CallOutcome> }

export interface SetupCall { tool: string; arguments: Record<string, unknown>; latency_ms: number; is_error: boolean | null; error: CallOutcome['error']; page_handle: string | null }

export interface CaseExecution {
  /** null when the case could be sent; else why not (the adapter cannot express it with this server's tools). */
  not_expressible: string | null;
  tool_call: ToolCall | null;
  setup_calls: SetupCall[];
  call: CallOutcome | null;
}

const isRefusal = (x: unknown): x is Refusal => typeof x === 'object' && x !== null && 'refused' in x;
const emptyParsed = (handle: string | null): ParsedResult => ({ items: [], signals: [], blanket: [], explicit_complete: false, page_handle: handle, refused: null, is_error: false });

const UNKNOWN_ARGUMENT = 'fbfuzz_unknown_argument';

/** The tool call after a schema-driven mutation, or why the mutation does not apply to this call. */
export function mutateCall(tc: ToolCall, inputSchema: unknown, m: Mutation, canary: string): ToolCall | { not_applicable: string } {
  const schema = (inputSchema ?? {}) as { required?: unknown };
  const required = Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === 'string') : [];
  const args: Record<string, unknown> = structuredClone(tc.arguments);
  const presentRequired = required.filter(k => k in args);
  const firstRequiredString = required.find(k => typeof args[k] === 'string');
  const out = (a: Record<string, unknown>): ToolCall => ({ tool: tc.tool, arguments: a });
  switch (m) {
    case 'drop_all_required':
      if (!presentRequired.length) return { not_applicable: 'the tool declares no required argument' };
      for (const k of presentRequired) delete args[k];
      return out(args);
    case 'drop_first_required':
      if (!presentRequired.length) return { not_applicable: 'the tool declares no required argument' };
      delete args[presentRequired[0]!];
      return out(args);
    case 'empty_arguments':
      return Object.keys(args).length ? out({}) : { not_applicable: 'the call already has no arguments' };
    case 'required_string_to_number':
    case 'required_string_to_array':
    case 'required_string_to_object':
    case 'required_string_to_null':
    case 'required_string_to_boolean': {
      if (!firstRequiredString) return { not_applicable: 'no required argument holds a string' };
      const v = args[firstRequiredString];
      args[firstRequiredString] = m === 'required_string_to_number' ? 12345 : m === 'required_string_to_array' ? [v]
        : m === 'required_string_to_object' ? { value: v } : m === 'required_string_to_null' ? null : true;
      return out(args);
    }
    case 'container_to_string': {
      const k = Object.keys(args).find(key => typeof args[key] === 'object' && args[key] !== null);
      if (!k) return { not_applicable: 'no object or array argument' };
      args[k] = 'fbfuzz';
      return out(args);
    }
    case 'nested_leaf_to_number': {
      let done = false;
      const walk = (x: unknown, depth: number): unknown => {
        if (done) return x;
        if (typeof x === 'string' && depth >= 2) { done = true; return 12345; }
        if (Array.isArray(x)) return x.map(y => walk(y, depth + 1));
        if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y, depth + 1)]));
        return x;
      };
      const a = walk(args, 0) as Record<string, unknown>;
      return done ? out(a) : { not_applicable: 'no nested string value' };
    }
    case 'unknown_argument':
      args[UNKNOWN_ARGUMENT] = 'fbfuzz';
      return out(args);
    case 'all_strings_to_canary': {
      let n = 0;
      const walk = (x: unknown): unknown => {
        if (typeof x === 'string') { n++; return canary; }
        if (Array.isArray(x)) return x.map(walk);
        if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
        return x;
      };
      const a = walk(args) as Record<string, unknown>;
      return n ? out(a) : { not_applicable: 'no string argument' };
    }
  }
}

/** Real page handle transforms for cursor cases. */
export function transformHandle(h: string, t: 'truncate' | 'flip' | 'reorigin_backend', proxyPort: number): string | { not_applicable: string } {
  if (t === 'truncate') return h.slice(0, Math.floor(h.length / 2));
  if (t === 'flip') {
    const i = Math.floor(h.length / 2);
    const c = h[i] ?? '';
    const r = /[0-8]/.test(c) ? String(Number(c) + 1) : c === '9' ? '0' : /[a-yA-Y]/.test(c) ? String.fromCharCode(c.charCodeAt(0) + 1) : c === 'z' ? 'a' : c === 'Z' ? 'A' : c === 'x' ? 'y' : 'x';
    return h.slice(0, i) + r + h.slice(i + 1);
  }
  let u: URL;
  try { u = new URL(h); } catch { return { not_applicable: 'the page handle is not a URL' }; }
  if (u.port !== String(proxyPort)) return { not_applicable: 'the page handle does not carry the proxy origin' };
  u.port = String(HAPI_PORT);
  return u.toString();
}

export interface ExecInput {
  adapter: Adapter;
  parser: Parser;
  tools: ListedTool[];
  pageSize: number;
  patientId: string;
  canary: string;
  proxyPort: number;
  setupSearch: { type: string; params: [string, string][]; page_size: number };
}

/** Runs one filled case. Never throws for server-side failures. */
export async function executeCase(s: Caller, x: ExecInput, k: FuzzCase): Promise<CaseExecution> {
  const ex: CaseExecution = { not_expressible: null, tool_call: null, setup_calls: [], call: null };
  const no = (reason: string): CaseExecution => ({ ...ex, not_expressible: reason });
  const opCall = (op: FuzzOp, pageSize: number): ToolCall | Refusal => {
    if (op.op === 'capabilities') return x.adapter.capabilities(op.type);
    if (op.op === 'read') return x.adapter.read(op.type, op.id);
    const r = x.adapter.search(op.type, op.params, pageSize);
    return isRefusal(r) ? r : r.call;
  };
  const setup = async (tc: ToolCall): Promise<SetupCall> => {
    const o = await s.call(tc, SETUP_CALL_TIMEOUT_MS);
    const p = x.parser.parse({ seq: 0, op_index: 0, op: 'search', ...o });
    const rec: SetupCall = { tool: o.tool, arguments: o.arguments, latency_ms: o.latency_ms, is_error: o.is_error, error: o.error, page_handle: p.page_handle };
    ex.setup_calls.push(rec);
    return rec;
  };
  /** A real page handle from the setup search (page size from the corpus, so the patient's records span pages). */
  const realHandle = async (): Promise<string | { not: string }> => {
    const r = x.adapter.search(x.setupSearch.type, x.setupSearch.params, x.setupSearch.page_size);
    if (isRefusal(r)) return { not: `setup search: ${r.refused}` };
    const sc = await setup(r.call);
    return sc.page_handle ?? { not: 'the setup search returned no page handle' };
  };
  const send = async (tc: ToolCall): Promise<CaseExecution> => {
    ex.tool_call = tc;
    ex.call = await s.call(tc, FUZZ_CALL_TIMEOUT_MS);
    return ex;
  };

  if (k.kind === 'op') {
    const tc = opCall(k.op, k.page_size ?? x.pageSize);
    return isRefusal(tc) ? no(tc.refused) : send(tc);
  }
  if (k.kind === 'number') {
    const tc = k.via === 'read' ? x.adapter.read('Observation', k.number_id)
      : opCall({ op: 'search', type: 'Observation', params: [['patient', `Patient/${x.patientId}`], ['_id', k.number_id]] }, x.pageSize);
    return isRefusal(tc) ? no(tc.refused) : send(tc);
  }
  if (k.kind === 'mutate') {
    let base: ToolCall | Refusal;
    if (k.base.op === 'next') {
      const h = await realHandle();
      if (typeof h !== 'string') return no(h.not);
      const n = x.adapter.next(emptyParsed(h));
      base = 'cannot_continue' in n ? { refused: n.cannot_continue } : n;
    } else base = opCall(k.base, x.pageSize);
    if (isRefusal(base)) return no(base.refused);
    const tool = x.tools.find(t => t.name === base.tool);
    const m = mutateCall(base, tool?.inputSchema, k.mutation, x.canary);
    return 'not_applicable' in m ? no(`mutation ${k.mutation}: ${m.not_applicable}`) : send(m);
  }
  // cursor
  let handle: string;
  if (k.cursor !== null) handle = k.cursor;
  else {
    const h = await realHandle();
    if (typeof h !== 'string') return no(h.not);
    if (k.transform === 'replay') {
      const first = x.adapter.next(emptyParsed(h));
      if ('cannot_continue' in first) return no(first.cannot_continue);
      await setup(first);
      handle = h;
    } else if (k.transform) {
      const t = transformHandle(h, k.transform, x.proxyPort);
      if (typeof t !== 'string') return no(t.not_applicable);
      handle = t;
    } else handle = h;
  }
  // The adapter builds the paging call around a placeholder, which is then replaced by the handle under test, so an
  // empty or malformed handle reaches the server exactly as written (adapters skip falsy handles).
  let n: ReturnType<Adapter['next']>;
  try { n = x.adapter.next(emptyParsed(HANDLE_PLACEHOLDER)); } catch (e) { return no(`adapter: ${(e as Error).message}`); }
  if ('cannot_continue' in n) return no(n.cannot_continue);
  return send(replaceString(n, HANDLE_PLACEHOLDER, handle));
}

const HANDLE_PLACEHOLDER = 'fbfuzz-handle-placeholder';

function replaceString(tc: ToolCall, from: string, to: string): ToolCall {
  const walk = (x: unknown): unknown => {
    if (x === from) return to;
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return { tool: tc.tool, arguments: walk(tc.arguments) as Record<string, unknown> };
}
