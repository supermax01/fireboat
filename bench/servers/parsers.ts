// Per-arm parsers. Shape only: values are copied as the server returned them.
// Payload choice: structuredContent when present, else the first text block parsed as JSON (lexeme-preserving).
import { parseLossless, type LosslessValue } from '../lib/json.js';
import type { ArmId, CallRecord, CountedSignal, ParsedResult } from '../lib/types.js';
import type { Parser } from './arms.js';
import { bundleLink, bundleTotal, isObj, itemOf, outcomeRefusal, resourcesOf, type Obj } from './items.js';

type Signal = ParsedResult['signals'][number];
const empty = (): ParsedResult => ({ items: [], signals: [], blanket: [], explicit_complete: false, page_handle: null, refused: null, is_error: false });

interface Envelope { result: Obj | null; payload: LosslessValue | undefined; texts: string[] }

/** Reads the JSON-RPC line. `payload` is structuredContent, else the first text block that parses as JSON. */
export function envelope(call: CallRecord): Envelope {
  if (!call.response_raw) return { result: null, payload: undefined, texts: [] };
  const msg = parseLossless(call.response_raw);
  const result = isObj(msg) && isObj(msg.result) ? msg.result : null;
  const texts: string[] = [];
  if (result && Array.isArray(result.content)) for (const c of result.content) if (isObj(c) && typeof c.text === 'string') texts.push(c.text);
  let payload: LosslessValue | undefined = result?.structuredContent;
  if (payload === undefined) {
    for (const t of texts) {
      try { payload = parseLossless(t); break; } catch { /* not JSON */ }
    }
  }
  return { result, payload, texts };
}

/** Failures that never produced a tool result (timeout, crash, JSON-RPC error). */
function transportFailure(call: CallRecord, env: Envelope): ParsedResult | null {
  if (env.result) return null;
  return { ...empty(), is_error: true, refused: { code: call.error?.kind ?? 'no_result', message: call.error?.message ?? '' } };
}

const total = (n: number | null, items: number, out: Signal[]) => {
  if (n !== null && n > items) out.push({ kind: 'total_gt_returned', detail: `total=${n} returned=${items}` });
};

// ---- FB0: fireboat envelope ----------------------------------------------------------------------------------

/** Reasons fireboat attaches to every clinical response (docs/QUERY-EVIDENCE.md): never counted. */
export const FIREBOAT_BLANKET_REASONS = new Set(['CLINICAL_RECORD_COMPLETENESS_UNKNOWN']);
/**
 * Coverage reasons that say matching items were left out of this response (counted signals). Every other reason
 * (for example FILTER_EXECUTION_UNVERIFIED, CONTINUATION_QUERY_UNVERIFIED, ORDER_UNVERIFIED) labels the evidence
 * behind the delivered items, not an omission; it is reported in `blanket` and never counted. Conservative by design.
 */
export const FIREBOAT_OMISSION_REASONS = new Set([
  'MORE_PAGES', 'SOURCE_REPORTED_INCOMPLETE', 'RESOURCE_EXCEEDS_INLINE_BUDGET', 'OVERSIZED_RESOURCE', 'OUTPUT_LIMIT',
  'UPSTREAM_LIMIT', 'RETENTION_LIMIT', 'NON_CONTINUABLE_UPSTREAM_LINK', 'RETAINED_PAGE_IS_NOT_THE_ENTIRE_QUERY',
  // Added after the first release (absent in FB0): a returned record was withheld by policy (docs/SECURITY-MODEL.md).
  'RECORDS_WITHHELD_BY_POLICY', 'SHARED_RECORDS_WITHHELD_BY_POLICY',
]);

export const fireboatParser: Parser = {
  parse(call) {
    const env = envelope(call);
    const fail = transportFailure(call, env);
    if (fail) return fail;
    const out = empty();
    out.is_error = env.result?.isError === true;
    const e = env.payload;
    if (!isObj(e)) {
      out.refused = { code: 'unparsed', message: env.texts.join('\n').slice(0, 500) };
      return out;
    }
    if (isObj(e.error)) {
      out.refused = { code: String(e.error.code ?? 'error'), message: typeof e.error.safe_message === 'string' ? e.error.safe_message : '' };
    }
    const data = isObj(e.data) ? e.data : {};
    const resources = Array.isArray(data.resources) ? data.resources.filter(isObj) : [];
    for (const r of resources) { const it = itemOf(r); if (it) out.items.push(it); }
    const cov = isObj(e.coverage) ? e.coverage : {};
    const reasons = Array.isArray(cov.reasons) ? cov.reasons.filter((x): x is string => typeof x === 'string') : [];
    for (const r of reasons) if (!FIREBOAT_OMISSION_REASONS.has(r)) out.blanket.push(r);
    if (cov.authorization_limited === true) out.blanket.push('authorization_limited');
    const counted = reasons.filter(r => FIREBOAT_OMISSION_REASONS.has(r));
    if (counted.includes('MORE_PAGES')) out.signals.push({ kind: 'more_pages_reason', detail: 'MORE_PAGES' });
    if (cov.state === 'partial') for (const r of counted.filter(r => r !== 'MORE_PAGES')) out.signals.push({ kind: 'coverage_partial', detail: r });
    const pg = isObj(e.pagination) ? e.pagination : null;
    if (pg?.has_more === true) out.signals.push({ kind: 'has_more', detail: 'pagination.has_more=true' });
    if (pg && typeof pg.next_cursor === 'string') {
      out.signals.push({ kind: 'cursor', detail: 'pagination.next_cursor' });
      out.page_handle = pg.next_cursor;
    }
    const tv = pg && isObj(pg.total) ? bundleTotal({ total: pg.total.value ?? null } as Obj) : null;
    total(tv, out.items.length, out.signals);
    if (isObj(data.manifest)) out.signals.push({ kind: 'withheld_manifest', detail: String(data.manifest.reason ?? 'manifest') });
    // Completeness claim (one rule for every arm, report "scoring rules"): an explicit "complete" (fireboat
    // coverage.state complete_for_query) or a total the server presents as exact that equals the items returned.
    // fireboat totals marked estimate or unknown, and has_more:false alone, are not claims.
    const exactTotal = pg && isObj(pg.total) && pg.total.precision === 'accurate';
    out.explicit_complete = cov.state === 'complete_for_query' || (exactTotal === true && tv !== null && tv === out.items.length);
    return out;
  },
};

// ---- W: WSO2 (FHIR JSON under {result: ...}; errors as OperationOutcome or bare issue lists, isError false) ------------

export const wso2Parser: Parser = {
  parse(call) {
    const env = envelope(call);
    const fail = transportFailure(call, env);
    if (fail) return fail;
    const out = empty();
    out.is_error = env.result?.isError === true;
    let body = isObj(env.payload) && 'result' in env.payload ? env.payload.result : env.payload;
    if (isObj(body) && typeof body.severity === 'string' && env.result?.structuredContent === undefined) {
      // A bare OperationOutcome issue list comes back as one text block per issue.
      const issues: LosslessValue[] = [];
      for (const t of env.texts) { try { issues.push(parseLossless(t)); } catch { /* plain text */ } }
      body = issues;
    }
    const refusal = outcomeRefusal(body);
    if (refusal) out.refused = refusal;
    else if (body === undefined || (isObj(body) && Object.keys(body).length === 0 && call.op !== 'capabilities')) {
      out.refused = { code: 'unparsed', message: env.texts.join('\n').slice(0, 500) };
    }
    if (call.op !== 'capabilities') bundleSignals(body, out);
    return out;
  },
};

/** Items and counted signals of a raw FHIR Bundle or resource (W and M). */
function bundleSignals(body: LosslessValue | undefined, out: ParsedResult): void {
  for (const r of resourcesOf(body)) { const it = itemOf(r); if (it) out.items.push(it); }
  if (isObj(body) && body.resourceType === 'Bundle') {
    const next = bundleLink(body, 'next');
    if (next) { out.signals.push({ kind: 'next_link', detail: 'Bundle.link[next]' }); out.page_handle = next; }
    const t = bundleTotal(body);
    total(t, out.items.length, out.signals);
    out.explicit_complete = t !== null && t === out.items.length; // FHIR Bundle.total carries no precision marker: a claim
  }
}

// ---- M: momentum ({method, path, body, response} or {error_message}, possibly under {result: ...}) -----------------

export const momentumParser: Parser = {
  parse(call) {
    const env = envelope(call);
    const fail = transportFailure(call, env);
    if (fail) return fail;
    const out = empty();
    out.is_error = env.result?.isError === true;
    let p = env.payload;
    if (isObj(p) && isObj(p.result) && !('response' in p) && !('error_message' in p)) p = p.result;
    if (isObj(p) && typeof p.error_message === 'string') {
      out.refused = { code: 'error_message', message: p.error_message };
      return out;
    }
    const response = isObj(p) ? p.response : undefined;
    const refusal = outcomeRefusal(response);
    if (refusal) out.refused = refusal;
    else if (response === undefined) out.refused = { code: 'unparsed', message: env.texts.join('\n').slice(0, 500) };
    if (call.op !== 'capabilities') bundleSignals(response, out);
    return out;
  },
};

// ---- H: fhirHydrant envelope {status, hasMore, truncated, bundle, continuation, data} -----------------------------

export const hydrantParser: Parser = {
  parse(call) {
    const env = envelope(call);
    const fail = transportFailure(call, env);
    if (fail) return fail;
    const out = empty();
    out.is_error = env.result?.isError === true;
    const e = env.payload;
    if (!isObj(e)) {
      out.refused = { code: out.is_error ? 'tool_error' : 'unparsed', message: env.texts.join('\n').slice(0, 500) };
      return out;
    }
    const status = typeof e.status === 'string' ? e.status : null;
    if (out.is_error || (status !== null && status !== 'ok' && status !== 'truncated')) {
      const err = isObj(e.error) ? e.error : null;
      out.refused = { code: String(err?.code ?? status ?? 'error'), message: String(err?.message ?? e.message ?? env.texts.join('\n').slice(0, 500)) };
    }
    if (call.op === 'capabilities') return out;
    const data = e.data;
    const oo = outcomeRefusal(data);
    if (oo && !out.refused) out.refused = oo;
    for (const r of resourcesOf(data)) { const it = itemOf(r); if (it) out.items.push(it); }
    if (e.hasMore === true) out.signals.push({ kind: 'has_more', detail: 'hasMore=true' });
    const cont = isObj(e.continuation) && typeof e.continuation.url === 'string' ? e.continuation.url : null;
    const next = cont ?? bundleLink(data, 'next');
    if (next) { out.signals.push({ kind: 'next_link', detail: cont ? 'continuation.url' : 'Bundle.link[next]' }); out.page_handle = next; }
    // No dedicated CountedSignal for a byte-cap truncation; recorded as a query-scoped "more data" reason.
    if (e.truncated === true || status === 'truncated') out.signals.push({ kind: 'more_pages_reason', detail: 'truncated=true' });
    const b = isObj(e.bundle) ? e.bundle : null;
    const t = b ? bundleTotal({ total: b.total ?? null } as Obj) : bundleTotal(data);
    total(t, out.items.length, out.signals);
    // hasMore:false alone is not a completeness claim (same rule as fireboat has_more:false); a FHIR Bundle.total is.
    out.explicit_complete = t !== null && t === out.items.length;
    return out;
  },
};

// ---- AH: AWS HealthLake MCP server (one text block, json.dumps(indent=2); errors {"error": true, "type", "message"}) ----

/**
 * Search and $everything results are a reduced Bundle {resourceType, id, type, total, entry, link, pagination
 * {has_next, next_token}}, with include-mode entries moved to `included` (type -> id -> resource); reads return the
 * resource. Every returned resource is an item, included ones too (they are delivered to the caller). AH fills `total`
 * with the page's entry count when HealthLake sends none, so its total is presented like a FHIR Bundle.total and judged
 * by the same rule. Values are copied as AH printed them (it re-serialises Python floats; lexemes are scored, not fixed).
 */
export const healthlakeMcpParser: Parser = {
  parse(call) {
    const env = envelope(call);
    const fail = transportFailure(call, env);
    if (fail) return fail;
    const out = empty();
    out.is_error = env.result?.isError === true;
    const p = env.payload;
    if (!isObj(p)) {
      out.refused = { code: out.is_error ? 'tool_error' : 'unparsed', message: env.texts.join('\n').slice(0, 500) };
      return out;
    }
    if (p.error === true) {
      out.refused = { code: typeof p.type === 'string' ? p.type : 'error', message: typeof p.message === 'string' ? p.message : '' };
      return out;
    }
    const oo = outcomeRefusal(p);
    if (oo) { out.refused = oo; return out; }
    if (call.op === 'capabilities') return out;
    if (p.resourceType !== 'Bundle') {
      for (const r of resourcesOf(p)) { const it = itemOf(r); if (it) out.items.push(it); }
      return out;
    }
    const main = resourcesOf(p);
    for (const r of main) { const it = itemOf(r); if (it) out.items.push(it); }
    if (isObj(p.included)) {
      for (const byId of Object.values(p.included)) {
        if (!isObj(byId)) continue;
        for (const r of Object.values(byId)) if (isObj(r)) { const it = itemOf(r); if (it) out.items.push(it); }
      }
    }
    const pg = isObj(p.pagination) ? p.pagination : null;
    if (pg?.has_next === true) out.signals.push({ kind: 'has_more', detail: 'pagination.has_next=true' });
    if (pg && typeof pg.next_token === 'string' && pg.next_token) {
      out.signals.push({ kind: 'cursor', detail: 'pagination.next_token' });
      out.page_handle = pg.next_token;
    }
    if (bundleLink(p, 'next')) out.signals.push({ kind: 'next_link', detail: 'Bundle.link[next] (passed through)' });
    const t = bundleTotal(p);
    total(t, main.length, out.signals);
    out.explicit_complete = t !== null && t === main.length;
    return out;
  },
};

export const PARSERS: Partial<Record<ArmId, Parser>> = {
  FB0: fireboatParser, FB: fireboatParser, FBd: fireboatParser, FBt: fireboatParser, W: wso2Parser, Ws: wso2Parser, Wm: wso2Parser, M: momentumParser, H: hydrantParser,
  FBh: fireboatParser, FBdh: fireboatParser, AH: healthlakeMcpParser,
};

export function parserFor(arm: ArmId): Parser {
  const p = PARSERS[arm];
  if (!p) throw new Error(`no parser for arm ${arm}`);
  return p;
}

export type { CountedSignal };
