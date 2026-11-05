// Real-loopback synthetic source and pre-render snapshot seam for the r2 regressions.
import { createServer } from 'node:http';
import { FhirGateway } from '../packages/core/src/index.js';
import { validateCrossField02, type GatewayEnvelope02, type ToolName } from '../packages/core/src/contracts.js';
import { declaredSearchProfile, type SearchProfile } from '../packages/core/src/query.js';
const candidate: SearchProfile = {
  ...declaredSearchProfile('synthetic-fixture-r4-v1')!, id: 'private-r2-candidate', eligible: false,
  source: { software: 'r2 synthetic fixture', software_version: '1', fhir_version: '4.0.1' }, evidence: null,
};
export type Mode = { pages: number; opaque?: boolean; perPage?: number[]; outcome?: (index: number) => unknown; profile?: boolean; self?: 'echo' | 'none'; mutate?: (entries: any[], index: number, base: string) => void; nextHost?: string };
const at = '2026-10-19T12:00:00Z';
const obs = (id: string) => ({ resourceType: 'Observation', id, status: 'final', subject: { reference: 'Patient/synthetic-a' },
  code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, effectiveDateTime: '2025-01-03T00:00:00Z' });

export async function withSource(mode: Mode, fn: (g: FhirGateway, c: any, requests: URL[]) => Promise<void>) {
  let base = '';
  const requests: URL[] = [];
  const source = createServer((req, res) => {
    res.setHeader('content-type', 'application/fhir+json');
    const url = new URL(req.url!, base);
    if (url.pathname.endsWith('/metadata')) {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', software: { name: 'r2 synthetic fixture', version: '1' }, rest: [{ mode: 'server', resource: [
        { type: 'Observation', interaction: [{ code: 'search-type' }, { code: 'read' }], searchParam: ['patient', 'subject', 'code', 'date', 'status', '_id'].map(name => ({ name, type: name === 'date' ? 'date' : ['code', 'status', '_id'].includes(name) ? 'token' : 'reference' })) },
        { type: 'Condition', interaction: [{ code: 'search-type' }, { code: 'read' }], searchParam: ['patient', 'subject', 'code', 'onset-date', 'recorded-date'].map(name => ({ name, type: name.endsWith('date') ? 'date' : name === 'code' ? 'token' : 'reference' })) },
      ] }] }));
      return;
    }
    requests.push(url);
    const read = /\/Observation\/([A-Za-z0-9.-]+)$/.exec(url.pathname);
    if (read) { res.end(JSON.stringify(obs(read[1]!))); return; }
    const index = mode.opaque ? Number(url.searchParams.get('_getpagesoffset') ?? '0') : Number(url.searchParams.get('_offset') ?? '0');
    const next = mode.opaque ? new URL(`${base}?_getpages=abc&_getpagesoffset=${index + 1}`) : (() => { const n = new URL(url); n.searchParams.set('_offset', String(index + 1)); return n; })();
    const count = mode.perPage?.[index] ?? 1;
    const entries: unknown[] = Array.from({ length: count }, (_, i) => ({ search: { mode: 'match' }, resource: obs(`synthetic-p${index}r${i}`) }));
    mode.mutate?.(entries as any[], index, base);
    const outcome = mode.outcome?.(index);
    if (outcome) entries.push({ search: { mode: 'outcome' }, resource: outcome });
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [...(mode.self === 'none' ? [] : [{ relation: 'self', url: url.href }]), ...(index < mode.pages - 1 ? [{ relation: 'next', url: mode.nextHost ? next.href.replace('127.0.0.1', mode.nextHost) : next.href }] : [])], entry: entries }));
  });
  await new Promise<void>(r => source.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(source.address() as { port: number }).port}/fhir`;
  const g = new FhirGateway({ mode: 'synthetic', source: { alias: 'local', baseUrl: base }, patientId: 'synthetic-a', contextId: 'ctx_test' },
    mode.profile ? { testQueryProfile: candidate } as never : undefined);
  const c = g as any; const orig = c.renderV2.bind(c); c.captured = [];
  c.renderV2 = (snap: any, ...rest: unknown[]) => { c.captured.push({ ...snap, ...(snap.queryOverlay ? { queryOverlay: { ...snap.queryOverlay } } : {}) }); return orig(snap, ...rest); };
  c.last = () => c.captured[c.captured.length - 1];
  try { await fn(g, c, requests); } finally { g.close(); source.closeAllConnections(); await new Promise<void>(r => source.close(() => r())); }
}

export function deepFreeze<T>(v: T): T { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; }

/** Build the v2 envelope a correct S5.6 renderer would produce from the 0.1 delivery and the
 * v2 coverage, then run the strict gate with a trusted context derived from the snapshot. */
export function gate(c: any, tool: ToolName, snap: any, assembly: any, delivered: unknown[], page: { has_more: boolean | null; next_cursor?: string } | undefined,
  extra: { chainDeliveredCount?: number; action?: 'inspect' | 'project' | 'page'; readTarget?: { resourceType: string; id: string }; manifest?: unknown; limitReached?: boolean } = {}) {
  const r = c.coverageV2(snap, assembly);
  const resources = delivered.map(x => structuredClone(x));
  const body: any = { data: { resources }, coverage: r.coverage, warnings: r.warnings,
    provenance: resources.map((_, i) => ({ resource_index: i, retrieved_at: at })),
    ...(page ? { pagination: { has_more: page.has_more, returned_matches: resources.length, returned_includes: 0, ...(['fhir_search','fhir_page'].includes(tool) ? { requested_page_size: Number(snap.query.at(-1).value) } : {}), ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}) } } : {}) };
  if (extra.manifest) body.data.manifest = extra.manifest;
  const env: GatewayEnvelope02 = c.envelopeV2(tool, body);
  if (extra.limitReached) env.budget.limit_reached = true;
  const q = snap.queryEvidence;
  const context = deepFreeze({
    requestedPageSize: snap.query.length ? Number(snap.query.at(-1).value) : undefined,
    binding: { sourceAlias: env.source.alias, fhirVersion: env.source.fhir_version, sourceRevision: env.source.capability_revision, policyRevision: env.context.policy_revision, contextHandle: env.context.handle },
    ...(q && tool !== 'fhir_read' ? { query: { resourceType: snap.type, sourceRevision: q.source_revision ?? env.source.capability_revision, policyRevision: env.context.policy_revision, contextHandle: env.context.handle,
      orderedPairs: q.constraints.map((e: any) => ({ name: e.name, value: e.value })), sort: q.sort?.requested ?? [],
      constraintProof: q.constraints.map((e: any) => ({ execution: e.execution, ...(e.evidence_ref ? { evidence_ref: e.evidence_ref } : {}) })),
      // S6: the trusted sort proof travels with the constraint proof (same current evidence).
      ...(q.sort ? { sortProof: { order: q.sort.order, effective: q.sort.effective ? [...q.sort.effective] : null } } : {}) } } : {}),
    ...(extra.chainDeliveredCount !== undefined ? { chainDeliveredCount: extra.chainDeliveredCount } : {}),
    ...(tool === 'fhir_result' ? { action: extra.action ?? 'page', offset: 0, limit: 100 } : {}),
    ...(extra.readTarget ? { readTarget: extra.readTarget } : {}),
  });
  return { r, env, context, result: validateCrossField02(tool, env, context as never) };
}

/** Caller-injected loss fixtures model the real non-continuable pagination state. */
export function callerReasonPage(reason: string): { has_more: false | null } {
  return { has_more: reason === 'NON_CONTINUABLE_UPSTREAM_LINK' ? null : false };
}
