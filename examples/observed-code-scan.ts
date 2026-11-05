// Explicit CLIENT task, inert: importing this module performs no calls. Never
// imported by store.ts, the gateway, or its adapter. S5.7 wires a v2 demo later.
import { OBSERVED_CODE_FIELDS, OBSERVED_CODE_DATE_PARAMETERS, OBSERVED_CODE_SCAN_LIMITS, observedCodeOrValueDetailed, splitEscapedCommaOrDetailed } from '../packages/core/src/repairs.js';

type Pair = { name: string; value: string };
type Result = { structuredContent?: unknown; isError?: boolean };
export interface ScanClient {
  callTool(request: { name: string; arguments: Record<string, unknown> }, options: { signal: AbortSignal }): Promise<Result>;
  /** Trusted client-side recorder INCLUDING auth/metadata, not envelope stats.
   * maxPerCall is an independently enforced upper bound of the client driver
   * (including retries); reserve it before each call. No unbounded driver fits. */
  upstreamWork: { total(): number; maxPerCall: number };
}
export interface ScanOptions {
  resourceType: string;
  trustedBinding: { source: string; contextHandle: string; selector: Pair };
  /** Exact ordered original date occurrences; never inferred from observed data. */
  dateWindow: readonly Pair[];
  originalCodeOr?: string;
  limits?: Partial<Record<'pageSize' | 'maxClinicalPages' | 'maxMcpCalls' | 'maxUpstreamCalls' | 'maxSeconds' | 'maxBytesPerCall' | 'maxBytesPerTask', number>>;
  now?: () => number;
}
export interface ScanReport {
  status: 'chain_exhausted' | 'exhaustion_unverified' | 'partial' | 'refused';
  /** Exhaustion of the observed chain is never a complete code inventory. */
  chainExhausted?: boolean;
  pages: { state?: string; reasons: string[]; unresolved_fields: unknown[]; withheld_payloads: unknown[] }[];
  code?: 'SCAN_EXHAUSTION_UNVERIFIED' | 'SCAN_LIMIT_REACHED' | 'SCAN_REFUSED' | 'TRUNCATED_OR_REFUSED';
  tuples: { system?: string; code: string }[];
  observed: { system?: string; code: string; version?: string; display?: string;
    citation: { source: string; resource_type: string; id?: string; version?: string; mcp_call: number; resource_index: number } }[];
  clinicalPages: number; mcpCalls: number; upstreamCalls: number; bytes: number;
  /** Only exhausted, delivery-safe chains supply an escaped OR requery; no request is sent. */
  requery?: { source: string; context_handle: string; resource_type: string; params: Pair[]; encodedQuery: string };
}

export async function scanObservedCodes(client: ScanClient, options: ScanOptions): Promise<ScanReport> {
  const { recipe: _recipe, ...caps } = OBSERVED_CODE_SCAN_LIMITS;
  const limits = { pageSize: 100, ...caps };
  const report: ScanReport = { status: 'refused', code: 'SCAN_REFUSED', tuples: [], observed: [], pages: [], clinicalPages: 0, mcpCalls: 0, upstreamCalls: 0, bytes: 0 };
  const refuse = (code: ScanReport['code'] = 'SCAN_REFUSED'): ScanReport => ({ ...report, status: code === 'SCAN_LIMIT_REACHED' ? 'partial' : 'refused', code });
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (!Object.hasOwn(limits, key) || !Number.isFinite(value) || value <= 0 || value > limits[key as keyof typeof limits]!
      || (key !== 'maxSeconds' && !Number.isInteger(value))) return refuse();
    Object.assign(limits, { [key]: value });
  }
  const resourceType = options.resourceType;
  const field = OBSERVED_CODE_FIELDS[resourceType];
  const { source, contextHandle, selector } = options.trustedBinding;
  if (!field || !source || !contextHandle || !['patient', 'subject'].includes(selector.name) || !/^Patient\/[A-Za-z0-9.-]{1,64}$/.test(selector.value)
    || !options.dateWindow.length || options.dateWindow.some(pair => !OBSERVED_CODE_DATE_PARAMETERS[resourceType]?.includes(pair.name) || !pair.value)
    || !Number.isSafeInteger(client.upstreamWork.maxPerCall) || client.upstreamWork.maxPerCall < 1) return refuse();
  if (options.originalCodeOr !== undefined && splitEscapedCommaOrDetailed(options.originalCodeOr).truncated) return refuse('TRUNCATED_OR_REFUSED');
  const now = options.now ?? Date.now, started = now(), upstreamStart = client.upstreamWork.total();
  if (!Number.isSafeInteger(upstreamStart) || upstreamStart < 0) return refuse();
  let lastWork = upstreamStart;
  const sampleWork = (afterCall = false): boolean => {
    const total = client.upstreamWork.total();
    if (!Number.isSafeInteger(total) || total < lastWork) return false;
    const delta = total - lastWork;
    lastWork = total;
    report.upstreamCalls = total - upstreamStart;
    return !afterCall || delta <= client.upstreamWork.maxPerCall;
  };
  const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(limits.maxSeconds * 1000)));
  const params = [...options.dateWindow.map(pair => ({ ...pair })), { ...selector }];
  const output = { format: 'fhir', fields: [field], max_bytes: limits.maxBytesPerCall };
  let cursor: string | undefined;
  let discovery = true;
  for (;;) {
    if (!sampleWork()) return refuse();
    if (deadline.aborted || now() - started >= limits.maxSeconds * 1000 || report.mcpCalls >= limits.maxMcpCalls
      || (!discovery && report.clinicalPages >= limits.maxClinicalPages)
      || report.upstreamCalls + client.upstreamWork.maxPerCall > limits.maxUpstreamCalls
      || report.bytes + limits.maxBytesPerCall > limits.maxBytesPerTask) return refuse('SCAN_LIMIT_REACHED');
    const name = discovery ? 'fhir_capabilities' : cursor ? 'fhir_page' : 'fhir_search';
    const args: Record<string, unknown> = discovery
      ? { topic: 'search_parameter', source, context_handle: contextHandle, resource_type: resourceType, name: 'code', output: { max_bytes: limits.maxBytesPerCall } }
      : cursor ? { cursor, context_handle: contextHandle, output }
      : { source, context_handle: contextHandle, resource_type: resourceType, params, page_size: limits.pageSize, output };
    report.mcpCalls++;
    if (!discovery) report.clinicalPages++; // includes fhir_page local remainders
    let result: Result;
    try {
      // Cancel the actual SDK call and bound a driver that fails to settle.
      result = await new Promise<Result>((resolve, reject) => {
        const onAbort = () => reject(new Error('scan deadline'));
        deadline.addEventListener('abort', onAbort, { once: true });
        client.callTool({ name, arguments: args }, { signal: deadline }).then(resolve, reject)
          .finally(() => deadline.removeEventListener('abort', onAbort));
      });
    } catch { if (!sampleWork(true)) return refuse(); return refuse(deadline.aborted ? 'SCAN_LIMIT_REACHED' : 'SCAN_REFUSED'); }
    if (!sampleWork(true)) return refuse();
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(result)); } catch { return refuse(); }
    report.bytes += bytes;
    if (deadline.aborted || now() - started >= limits.maxSeconds * 1000 || bytes > limits.maxBytesPerCall
      || report.bytes > limits.maxBytesPerTask || report.upstreamCalls > limits.maxUpstreamCalls) return refuse('SCAN_LIMIT_REACHED');
    const env = result.structuredContent as { schema_version?: string; error?: unknown; data?: Record<string, unknown>; context?: { handle?: string }; source?: { alias?: string }; transform?: { unresolved_fields?: unknown[]; withheld_payloads?: unknown[] }; coverage?: { query_exhausted?: boolean | null; state?: string; reasons?: string[] }; pagination?: { has_more?: boolean | null; next_cursor?: string } } | undefined;
    if (result.isError || env?.error || env?.schema_version !== '0.3' || env.context?.handle !== contextHandle || env.source?.alias !== source) return refuse();
    if (discovery) {
      const entries = env.data?.search_parameters;
      if (!Array.isArray(entries) || !entries.some(entry => entry && entry.name === 'code' && entry.type === 'token'
        && ['pinned_r4', 'approved_overlay'].includes(entry.definition_evidence))) return refuse();
      discovery = false; continue;
    }
    if (!Array.isArray(env.data?.resources) || env.data.resources.some(resource => resource?.resourceType !== resourceType)) return refuse();
    report.pages.push({ state: env.coverage?.state, reasons: [...(env.coverage?.reasons ?? [])],
      unresolved_fields: [...(env.transform?.unresolved_fields ?? [])], withheld_payloads: [...(env.transform?.withheld_payloads ?? [])] });
    if (!env.coverage || !['complete_for_query', 'partial', 'unknown'].includes(env.coverage.state ?? '')
      || env.transform?.unresolved_fields?.length || env.transform?.withheld_payloads?.length
      || env.coverage.reasons?.some(reason => ['UNRESOLVED_FIELDS', 'OVERSIZED_RESOURCE', 'UNSUPPORTED_PRECISION', 'INVALID_RESOURCE_ID', 'ENTRY_ORIGIN_MISMATCH', 'OUTPUT_LIMIT', 'SOURCE_REPORTED_INCOMPLETE', 'DELIVERY_REFUSED'].includes(reason))) return refuse();
    for (const [resourceIndex, resource] of env.data.resources.entries()) {
      const coding = resource?.[field]?.coding;
      if (!Array.isArray(coding)) continue;
      for (const tuple of coding) if (typeof tuple?.code === 'string' && tuple.code
        && (tuple.system === undefined || typeof tuple.system === 'string')) {
        const item = { ...(tuple.system ? { system: tuple.system } : {}), code: tuple.code };
        if (!report.tuples.some(old => old.system === item.system && old.code === item.code)) report.tuples.push(item);
        // Keep observed versions/displays and response-local citations separate
        // from the system/code token set. No terminology equivalence is inferred.
        report.observed.push({ ...item, ...(typeof tuple.version === 'string' ? { version: tuple.version } : {}),
          ...(typeof tuple.display === 'string' ? { display: tuple.display } : {}), citation: { source: env.source!.alias!, resource_type: resource.resourceType,
            ...(typeof resource.id === 'string' ? { id: resource.id } : {}),
            ...(typeof resource.meta?.versionId === 'string' ? { version: resource.meta.versionId } : {}),
            mcp_call: report.mcpCalls, resource_index: resourceIndex } });
      }
    }
    const or = observedCodeOrValueDetailed(report.tuples);
    if (or.truncated || splitEscapedCommaOrDetailed(or.value).truncated) return refuse('TRUNCATED_OR_REFUSED');
    if (env.pagination?.has_more === false) {
      if (env.coverage.query_exhausted === null) return { ...report, status: 'exhaustion_unverified', code: 'SCAN_EXHAUSTION_UNVERIFIED' };
      if (env.coverage.query_exhausted !== true) return refuse();
      const finalParams = [...params, ...(or.value ? [{ name: 'code', value: or.value }] : [])];
      // Empty scans cannot suggest an unfiltered requery.
      return { ...report, status: 'chain_exhausted', chainExhausted: true, code: undefined, ...(or.value ? { requery: { source, context_handle: contextHandle, resource_type: resourceType, params: finalParams,
        encodedQuery: new URLSearchParams(finalParams.map(pair => [pair.name, pair.value])).toString() } } : {}) };
    }
    if (env.pagination?.has_more === null && env.coverage.query_exhausted === null && !env.pagination.next_cursor) return { ...report, status: 'exhaustion_unverified', code: 'SCAN_EXHAUSTION_UNVERIFIED' };
    if (env.pagination?.has_more !== true || !env.pagination.next_cursor) return refuse();
    cursor = env.pagination.next_cursor; // honest gateway continuation, never reconstructed/broadened
  }
}
