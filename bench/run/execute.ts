// Scripted executor: runs a question's or probe's operations through one
// arm's adapter, one call at a time, and keeps every call record. Never post-processes results.
import type { AbstractOp, ArmId, CallRecord, OpOutcome, ParsedResult, ToolCall } from '../lib/types.js';
import type { ProbeOp } from '../gold/probes.js';
import type { Adapter, CallOutcome, Parser, Refusal } from '../servers/arms.js';
import type { ListedTool } from '../servers/adapters.js';
import { momentumRawSearch, probeCall } from './probe-adapter.js';

export const DRAIN_CAP = 20; // calls per drain operation, every arm (a harness rule, not a server limit)
export const RUN_CAP = 40; // calls per run, every arm
export const CALL_TIMEOUT_MS = 120_000;

export type AnyOp = AbstractOp | ProbeOp;

export interface Caller { call(call: ToolCall, timeoutMs: number): Promise<CallOutcome> }

export interface ExecContext {
  arm: ArmId;
  tools: ListedTool[];
  adapter: Adapter;
  parser: Parser;
  pageSize: number;
  /** AH: the HealthLake data store id (probe operations need it too). */
  datastoreId?: string;
}

export interface ExecResult {
  calls: CallRecord[];
  parsed: ParsedResult[]; // parallel to calls
  op_outcomes: { op_index: number; outcome: OpOutcome; detail: string }[];
  flags: string[];
}

const isRefusal = (x: unknown): x is Refusal => typeof x === 'object' && x !== null && 'refused' in x;

function outcomeOf(rec: CallRecord, p: ParsedResult): { outcome: OpOutcome; detail: string } {
  if (rec.error) return { outcome: 'failed', detail: `${rec.error.kind}: ${rec.error.message}`.slice(0, 300) };
  if (p.refused || p.is_error) return { outcome: 'tool_error', detail: p.refused ? `${p.refused.code}: ${p.refused.message}`.slice(0, 300) : 'isError' };
  return { outcome: 'ok', detail: '' };
}

export async function executeOps(s: Caller, x: ExecContext, ops: readonly AnyOp[]): Promise<ExecResult> {
  const out: ExecResult = { calls: [], parsed: [], op_outcomes: [], flags: [] };
  const lastParsed: (ParsedResult | null)[] = []; // per op: the last page it produced
  const opDone = (i: number, outcome: OpOutcome, detail: string, last: ParsedResult | null) => {
    out.op_outcomes.push({ op_index: i, outcome, detail });
    lastParsed[i] = last;
  };
  const doCall = async (i: number, op: CallRecord['op'], tc: ToolCall): Promise<{ rec: CallRecord; p: ParsedResult }> => {
    const o = await s.call(tc, CALL_TIMEOUT_MS);
    const rec: CallRecord = { seq: out.calls.length, op_index: i, op, ...o };
    const p = x.parser.parse(rec);
    out.calls.push(rec);
    out.parsed.push(p);
    return { rec, p };
  };
  const capLeft = () => RUN_CAP - out.calls.length;

  for (const [i, op] of ops.entries()) {
    if (capLeft() <= 0) { opDone(i, 'call_cap', `run cap ${RUN_CAP} reached`, null); continue; }
    const raw = 'raw' in op && op.raw === true;
    if (op.op === 'capabilities' || op.op === 'read') {
      const tc = op.op === 'capabilities' ? x.adapter.capabilities(op.type) : x.adapter.read(op.type, op.id);
      if (isRefusal(tc)) { opDone(i, 'refused_by_adapter', tc.refused, null); continue; }
      const { rec, p } = await doCall(i, op.op, tc);
      const o = outcomeOf(rec, p);
      opDone(i, o.outcome, o.detail, p);
      continue;
    }
    if (op.op === 'search' || op.op === 'drain') {
      let tc: ToolCall | Refusal;
      if (raw && x.arm === 'M') tc = momentumRawSearch(x.tools, op.type, op.params, x.pageSize);
      else {
        const r = x.adapter.search(op.type, op.params, x.pageSize);
        if (isRefusal(r)) tc = r;
        else { tc = r.call; for (const f of r.flags) out.flags.push(`op${i}:${f}`); }
      }
      if (isRefusal(tc)) { opDone(i, 'refused_by_adapter', tc.refused, null); continue; }
      let { rec, p } = await doCall(i, 'search', tc);
      let o = outcomeOf(rec, p);
      if (op.op === 'search' || o.outcome !== 'ok') { opDone(i, o.outcome, o.detail, p); continue; }
      const cap = Math.min(op.call_cap ?? DRAIN_CAP, DRAIN_CAP);
      let inOp = 1;
      let result: { outcome: OpOutcome; detail: string } = { outcome: 'ok', detail: '' };
      while (p.page_handle) {
        if (inOp >= cap) { result = { outcome: 'call_cap', detail: `drain cap ${cap} reached with a page handle left` }; break; }
        if (capLeft() <= 0) { result = { outcome: 'call_cap', detail: `run cap ${RUN_CAP} reached with a page handle left` }; break; }
        const n = x.adapter.next(p);
        if ('cannot_continue' in n) { result = { outcome: 'cannot_continue', detail: n.cannot_continue }; break; }
        ({ rec, p } = await doCall(i, 'next', n));
        inOp++;
        o = outcomeOf(rec, p);
        if (o.outcome !== 'ok') { result = o; break; }
      }
      opDone(i, result.outcome, result.detail, p);
      continue;
    }
    if (op.op === 'next' || op.op === 'next_tampered') {
      const prev = lastParsed[op.of] ?? null;
      if (!prev) { opDone(i, 'cannot_continue', `operation ${op.of} produced no result`, null); continue; }
      let from = prev;
      if (op.op === 'next_tampered') {
        const h = prev.page_handle;
        if (!h) { opDone(i, 'cannot_continue', 'no page handle to tamper with', null); continue; }
        if (!h.includes(op.tamper.from)) { opDone(i, 'refused_by_adapter', 'tamper not applicable: the page handle does not carry the patient id', null); continue; }
        from = { ...prev, page_handle: h.split(op.tamper.from).join(op.tamper.to) };
      }
      const n = x.adapter.next(from);
      if ('cannot_continue' in n) { opDone(i, 'cannot_continue', n.cannot_continue, null); continue; }
      const { rec, p } = await doCall(i, 'next', n);
      const o = outcomeOf(rec, p);
      opDone(i, o.outcome, o.detail, p);
      continue;
    }
    // named operations and writes (probes only)
    const tc = probeCall(x.arm, x.tools, op, { datastoreId: x.datastoreId });
    if (isRefusal(tc)) { opDone(i, 'refused_by_adapter', tc.refused, null); continue; }
    const { rec, p } = await doCall(i, op.op === 'operation' ? 'operation' : 'write', tc);
    const o = outcomeOf(rec, p);
    opDone(i, o.outcome, o.detail, p);
  }
  return out;
}
