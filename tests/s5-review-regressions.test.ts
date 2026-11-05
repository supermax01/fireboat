// Reviewer probes (Claude, S5.3). Retained regression corpus. Each test asserts the SAFE
// behaviour required by the contract; a failure is a finding.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FhirGateway } from '../packages/core/src/index.js';
import type { GatewayEnvelope02, ToolName } from '../packages/core/src/contracts.js';
import { validateCrossField02 } from '../packages/core/src/contracts.js';
import { buildQueryEvidence, downgradeEvidence } from '../packages/core/src/query.js';
import { resolveSearchParameters } from '../packages/core/src/search-parameters.js';
import { NO_MATCHES_MESSAGE, NO_MATCHES_UNVERIFIED_SUFFIX } from '../packages/core/src/repairs.js';
import type { QueryEvidence, QueryOverlay } from '../packages/core/src/m3b.js';

type Snapshot = { type: string; records: unknown[]; offset: number; suppressed: boolean; query: { name: string; value: string }[];
  queryEvidence?: QueryEvidence; queryOverlay?: QueryOverlay; nextUrl?: string; nonContinuable?: boolean; precisionRefused?: boolean;
  sourceIncomplete?: boolean; outcomeCodes?: string[]; unverifiedFilters?: string[]; partialReasons?: string[]; queryEvidenceKind?: string };
type Assembly = { tool: 'fhir_search' | 'fhir_page' | 'fhir_read' | 'fhir_result'; deliveredCount: number; filtered: boolean;
  previousEvidence?: QueryEvidence; localRemainder?: boolean; unknownContinuation?: boolean; capped?: boolean; refused?: boolean; reasons?: string[] };
const internal = (g: FhirGateway) => g as unknown as {
  controlCoverageV2(clinical: boolean, faultCode?: string): GatewayEnvelope02['coverage'];
  coverageV2(s: Snapshot, a: Assembly): { coverage: GatewayEnvelope02['coverage']; warnings: GatewayEnvelope02['warnings']; evidence?: QueryEvidence };
  envelopeV2(tool: ToolName, body: unknown): GatewayEnvelope02;
  errorV2(tool: ToolName, fault: { code: string; retryable: boolean; message?: string }): GatewayEnvelope02;
  refusalV2(tool: ToolName, kind: string, work: { upstreamCalls: number; clinicalCalls: number }, admission?: unknown, meta?: { resource_type?: string; parameter?: string }): GatewayEnvelope02;
  warningsV2(w: unknown[]): GatewayEnvelope02['warnings'];
  capabilities?: Map<string, unknown>;
};
const config = { mode: 'synthetic' as const, source: { alias: 'local', baseUrl: 'http://127.0.0.1:9/fhir' }, patientId: 'synthetic-a', contextId: 'ctx_test' };
function gateway() {
  const g = new FhirGateway(config), c = internal(g);
  const resolved = resolveSearchParameters({ resourceType: 'Observation', advertised: true,
    declared: [{ name: 'subject', type: 'reference' }, { name: 'date', type: 'date' }, { name: 'code', type: 'token' }] as never });
  c.capabilities = new Map([['Observation', { declared: [{ name: 'subject', type: 'reference' }, { name: 'date', type: 'date' }, { name: 'code', type: 'token' }], resolvedParameters: new Map([['generic-r4', resolved]]) }]]);
  return { g, c };
}
function evidence(pairs = [{ name: 'code', value: 'http://loinc.org|4548-4' }, { name: 'subject', value: 'Patient/synthetic-a' }]): QueryEvidence {
  return buildQueryEvidence({ resourceType: 'Observation', pairs, sortRequested: [], gatewayEnforcedIndices: new Set([pairs.length - 1]),
    sourceRevision: 'cap', policyRevision: 'policy', contextHandle: 'ctx_test', selfPairs: pairs });
}
const confinementOnly = () => evidence([{ name: 'subject', value: 'Patient/synthetic-a' }]);
function proved(): QueryEvidence {
  const e = evidence();
  return { ...e, constraints: e.constraints.map(x => ({ ...x, execution: 'gateway_enforced' as const })), materialFilterProved: true, evidenceKind: 'exact_id_and_subject_linkage' };
}
function state(e = evidence(), overlay = true): Snapshot {
  return { type: 'Observation', records: [], offset: 0, suppressed: false, query: e.constraints.map(({ name, value }) => ({ name, value })), queryEvidence: e,
    ...(overlay ? { queryOverlay: { deliveredCount: 0, pagesObserved: 1, queryEvidence: { ...e, constraints: [] }, sortProof: 'none' as const,
      constraintProof: e.constraints.map(({ source_reported, execution }) => ({ source_reported, execution })) } } : {}) };
}
const call = (extra: Partial<Assembly> = {}): Assembly => ({ tool: 'fhir_search', deliveredCount: 0, filtered: true, ...extra });
const hasNM = (r: { warnings: { code: string }[] }) => r.warnings.some(w => w.code === 'NO_MATCHES');
function run<T>(fn: (c: ReturnType<typeof internal>) => T): T { const { g, c } = gateway(); try { return fn(c); } finally { g.close(); } }

// ---------- sanity controls (expected to pass) ----------
test('CTRL-1 initial verified filtered zero: complete + NO_MATCHES base + full constraints', () => run(c => {
  const r = c.coverageV2(state(confinementOnly()), call({ filtered: false }));
  assert.equal(r.coverage.state, 'complete_for_query');
  const p = c.coverageV2(state(proved()), call());
  assert.equal(p.coverage.state, 'complete_for_query'); assert.equal(p.warnings.find(w => w.code === 'NO_MATCHES')?.message, NO_MATCHES_MESSAGE);
  assert.equal(p.coverage.constraints!.length, 2);
}));
test('CTRL-2 unchanged page shorthand; changed page full; retained full partial/null; read resource-only', () => run(c => {
  const s = state(proved()); const first = c.coverageV2(s, call());
  const same = c.coverageV2(s, call({ tool: 'fhir_page', previousEvidence: first.evidence }));
  assert.equal(same.coverage.constraints, undefined); assert.equal(same.coverage.constraints_on_first_page, true);
  const changed = c.coverageV2(state(downgradeEvidence({ ...proved(), constraints: proved().constraints.map(x => x.name === 'code' ? { ...x, execution: 'tested_adapter' as const } : x) }, 'code')), call({ tool: 'fhir_page', previousEvidence: first.evidence }));
  assert.equal(changed.coverage.constraints!.length, 2);
  const ret = c.coverageV2(s, call({ tool: 'fhir_result' }));
  assert.equal(ret.coverage.state, 'partial'); assert.equal(ret.coverage.query_exhausted, null); assert.equal(ret.coverage.constraints!.length, 2); assert.equal(hasNM(ret), false);
  const read = c.coverageV2(s, call({ tool: 'fhir_read', deliveredCount: 1 }));
  assert.equal(read.coverage.scope, 'resource'); assert.equal(read.coverage.query_digest, undefined); assert.equal(hasNM(read), false);
}));
test('CTRL-3 replay determinism: identical snapshot twice yields identical coverage and warnings', () => run(c => {
  const s = state(); s.queryOverlay!.deliveredCount = 2;
  const a = c.coverageV2(s, call({ tool: 'fhir_page' })), b = c.coverageV2(s, call({ tool: 'fhir_page' }));
  assert.deepEqual(a.coverage, b.coverage); assert.deepEqual(a.warnings, b.warnings); assert.equal(hasNM(a), false);
}));
test('CTRL-4 replay never upgrades: overlay downgraded proof wins over original tested evidence', () => run(c => {
  const e = { ...proved(), constraints: proved().constraints.map(x => x.name === 'code' ? { ...x, execution: 'tested_adapter' as const, evidence_ref: 'p@1' } : x), evidenceKind: 'tested_adapter' as const };
  const s = state(e); s.queryOverlay!.constraintProof = e.constraints.map(({ source_reported, execution }) => ({ source_reported, execution: execution === 'tested_adapter' ? 'unknown' as const : execution }));
  const r = c.coverageV2(s, call({ tool: 'fhir_page' }));
  assert.notEqual(r.coverage.state, 'complete_for_query');
  // no profile installed: even the original tested_adapter would be stripped
  const s2 = state(e); const r2 = c.coverageV2(s2, call());
  assert.notEqual(r2.coverage.state, 'complete_for_query');
}));
test('CTRL-5 malformed id / precision / source-incomplete / noncontinuable / capped => partial, no NO_MATCHES', () => run(c => {
  for (const [change, extra] of [[{ partialReasons: ['INVALID_RESOURCE_ID'] }, {}], [{ precisionRefused: true }, {}], [{ sourceIncomplete: true }, {}],
    [{ nonContinuable: true }, {}], [{}, { capped: true }]] as [Partial<Snapshot>, Partial<Assembly>][]) {
    const r = c.coverageV2({ ...state(proved()), ...change }, call(extra));
    assert.equal(r.coverage.state, 'partial', JSON.stringify(change) + JSON.stringify(extra)); assert.equal(hasNM(r), false);
  }
}));
test('CTRL-6 caveat independent of suppression (search, page, read, retained)', () => run(c => {
  for (const tool of ['fhir_search', 'fhir_page', 'fhir_read', 'fhir_result'] as const) {
    const a = c.coverageV2(state(), call({ tool })), b = c.coverageV2({ ...state(), suppressed: true }, call({ tool }));
    assert.deepEqual(a, b); assert.ok(a.coverage.reasons.includes('CLINICAL_RECORD_COMPLETENESS_UNKNOWN')); assert.equal(a.coverage.authorization_limited, true);
  }
}));
test('CTRL-7 reasons: 32 distinct accepted untruncated, 33 refuse', () => run(c => {
  const base = c.coverageV2(state(), call({ refused: true, reasons: ['R_0'] })).coverage.reasons.length - 1;
  const fill = Array.from({ length: 32 - base }, (_, i) => `R_${i}`);
  const ok = c.coverageV2(state(), call({ refused: true, reasons: fill }));
  for (const r of fill) assert.ok(ok.coverage.reasons.includes(r));
  assert.throws(() => c.coverageV2(state(), call({ refused: true, reasons: [...fill, 'ONE_MORE'] })));
}));

// ---------- adversarial probes ----------
test('P-A1 delivery loss via reasons only (OVERSIZED_RESOURCE) must not be complete_for_query (search)', () => run(c => {
  const r = c.coverageV2(state(proved()), call({ reasons: ['OVERSIZED_RESOURCE'] }));
  assert.notEqual(r.coverage.state, 'complete_for_query', `state=${r.coverage.state} reasons=${r.coverage.reasons}`);
}));
test('P-A2 delivery loss via reasons only must not emit NO_MATCHES', () => run(c => {
  const r = c.coverageV2(state(proved()), call({ reasons: ['OVERSIZED_RESOURCE'] }));
  assert.equal(hasNM(r), false, JSON.stringify(r.warnings.map(w => w.code)));
}));
test('P-A3 oversized read (S51-03 shape) must not be complete_for_query', () => run(c => {
  const r = c.coverageV2(state(), call({ tool: 'fhir_read', deliveredCount: 0, reasons: ['OVERSIZED_RESOURCE'] }));
  assert.notEqual(r.coverage.state, 'complete_for_query', `state=${r.coverage.state} reasons=${r.coverage.reasons}`);
}));
test('P-A4 opaque continuation (queryEvidenceKind=unverified_continuation) must not be complete_for_query', () => run(c => {
  const s = { ...state(confinementOnly()), queryEvidenceKind: 'unverified_continuation' };
  s.queryOverlay!.deliveredCount = 3;
  const r = c.coverageV2(s, call({ tool: 'fhir_page', filtered: false, deliveredCount: 1 }));
  assert.notEqual(r.coverage.state, 'complete_for_query', `state=${r.coverage.state} qe=${r.coverage.query_evidence} warnings=${r.warnings.map(w => w.code)}`);
}));
test('P-A5 opaque continuation query_evidence label must not claim linkage/self-link proof', () => run(c => {
  const s = { ...state(confinementOnly()), queryEvidenceKind: 'unverified_continuation' };
  const r = c.coverageV2(s, call({ tool: 'fhir_page', filtered: false }));
  assert.equal(r.coverage.query_evidence, 'unverified_continuation', `got ${r.coverage.query_evidence}`);
}));
test('P-A6 opaque continuation terminal zero chain (filtered, unverified) must not emit NO_MATCHES', () => run(c => {
  const s = { ...state(), queryEvidenceKind: 'unverified_continuation' };
  const r = c.coverageV2(s, call({ tool: 'fhir_page' }));
  assert.equal(hasNM(r), false, `warnings=${r.warnings.map(w => w.code + ':' + w.message.slice(-34))} qe=${r.coverage.query_exhausted}`);
}));
test('P-A7 source flagged a gateway-enforced filter (unverifiedFilters=[subject]) => not complete with FILTER_EXECUTION_UNVERIFIED', () => run(c => {
  const s = { ...state(confinementOnly()), unverifiedFilters: ['subject'] };
  const r = c.coverageV2(s, call({ filtered: false, deliveredCount: 1 }));
  const contradiction = r.coverage.state === 'complete_for_query' && r.coverage.reasons.includes('FILTER_EXECUTION_UNVERIFIED');
  assert.equal(contradiction, false, `state=${r.coverage.state} reasons=${r.coverage.reasons} warnings=${r.warnings.map(w => w.code)}`);
}));
test('P-A8 reason FILTER_EXECUTION_UNVERIFIED always paired with its warning', () => run(c => {
  const s = { ...state(confinementOnly()), unverifiedFilters: ['subject'] };
  const r = c.coverageV2(s, call({ filtered: false, deliveredCount: 1 }));
  assert.equal(r.coverage.reasons.includes('FILTER_EXECUTION_UNVERIFIED'), r.warnings.some(w => w.code === 'FILTER_EXECUTION_UNVERIFIED'));
}));
test('P-A9 fhir_page without chain overlay must not emit NO_MATCHES (chain count unknown)', () => run(c => {
  const r = c.coverageV2(state(proved(), false), call({ tool: 'fhir_page' }));
  assert.equal(hasNM(r), false);
}));
test('P-A10 filtered:true on confinement-only evidence must not emit NO_MATCHES', () => run(c => {
  const r = c.coverageV2(state(confinementOnly()), call({ filtered: true }));
  assert.equal(hasNM(r), false);
}));
test('P-A11 search snapshot lacking evidence must not be labelled exact_id_and_subject_linkage', () => run(c => {
  const s = state(); delete s.queryEvidence; delete s.queryOverlay;
  const r = c.coverageV2(s, call({ filtered: false }));
  assert.notEqual(r.coverage.query_evidence, 'exact_id_and_subject_linkage', `state=${r.coverage.state}`);
}));
test('P-A12 clinical error coverage reasons limited to caveat + code (no invented FILTER_EXECUTION_UNVERIFIED)', () => run(c => {
  const env = c.errorV2('fhir_read', { code: 'NOT_FOUND', retryable: false });
  assert.deepEqual(env.coverage.reasons, ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN', 'NOT_FOUND']);
}));
test('P-A13 errorV2 envelopes pass the S5.1 cross-field gate for every tool', () => run(c => {
  for (const tool of ['fhir_capabilities', 'fhir_search', 'fhir_read', 'fhir_page', 'fhir_result'] as const) {
    const env = c.errorV2(tool, { code: 'UPSTREAM_ERROR', retryable: true });
    const v = validateCrossField02(tool, env as never);
    assert.equal(v.ok, true, `${tool}: ${JSON.stringify(v)}`);
  }
}));
test('P-A14 controlCoverageV2(clinical, no fault) never claims exhaustion with zero pages', () => run(c => {
  assert.throws(() => c.controlCoverageV2(true), /requires a fault/);
}));
test('P-A15 unknown warning code fails closed; source prose never survives; NO_MATCHES only base/suffix', () => run(c => {
  assert.throws(() => c.warningsV2([{ code: 'ENTRY_ORIGIN_MISMATCH', message: 'x' }]));
  const w = c.warningsV2([{ code: 'NO_MATCHES', message: 'No matches. Patient X has no diabetes.' }, { code: 'SOURCE_OUTCOME', message: 'diag secret' }]);
  assert.equal(w[0]!.message, NO_MATCHES_MESSAGE); assert.equal(w[1]!.message, 'The source reported outcome issue(s).');
  const v = c.warningsV2([{ code: 'NO_MATCHES', message: NO_MATCHES_MESSAGE + NO_MATCHES_UNVERIFIED_SUFFIX + ' extra' }]);
  assert.equal(v[0]!.message, NO_MATCHES_MESSAGE);
}));
test('P-A16 warningsV2 keeps a source-supplied repair on non-NO_MATCHES warnings? (must not carry unreviewed repair)', () => run(c => {
  const w = c.warningsV2([{ code: 'ORDER_UNVERIFIED', message: 'x', repair: { action: 'discover_search_parameter', parameter: 'unreviewed_secret' } }]);
  assert.equal((w[0] as { repair?: unknown }).repair, undefined, JSON.stringify(w[0]));
}));
test('P-A17 page coverage for nextUrl + unverified opaque: query_exhausted false/null, never true', () => run(c => {
  const s = { ...state(), nextUrl: 'http://x/next', queryEvidenceKind: 'unverified_continuation' };
  const r = c.coverageV2(s, call({ tool: 'fhir_page' }));
  assert.notEqual(r.coverage.query_exhausted, true);
}));
test('P-A18 unsupported_modifier refusal: zero-work literal only when upstreamCalls==0; never with clinical work', () => run(c => {
  assert.throws(() => c.refusalV2('fhir_search', 'unsupported_modifier', { upstreamCalls: 1, clinicalCalls: 1 }));
  assert.match(c.refusalV2('fhir_search', 'unsupported_modifier', { upstreamCalls: 0, clinicalCalls: 0 }).error!.safe_message, /blocked before sending/);
  assert.match(c.refusalV2('fhir_search', 'unsupported_modifier', { upstreamCalls: 1, clinicalCalls: 0 }).error!.safe_message, /No clinical request was sent/);
}));
test('P-A19 refusal repairs never echo unreviewed names', () => run(c => {
  const env = c.refusalV2('fhir_search', 'unsupported_modifier', { upstreamCalls: 0, clinicalCalls: 0 }, undefined, { resource_type: 'Invented', parameter: 'secret-name' });
  assert.equal(JSON.stringify(env).includes('Invented'), false); assert.equal(JSON.stringify(env).includes('secret-name'), false);
}));
test('P-A20 changed-evidence detection is semantic, not key-order (shorthand not suppressed by key order)', () => run(c => {
  const s = state(proved()); const first = c.coverageV2(s, call());
  const reordered = JSON.parse(JSON.stringify(first.evidence, Object.keys(first.evidence!).reverse()));
  const r = c.coverageV2(s, call({ tool: 'fhir_page', previousEvidence: { ...reordered, ...first.evidence } }));
  assert.equal(r.coverage.constraints_on_first_page, true);
}));
test('P-A21 read-origin retained result (no query evidence) must not claim FILTER_EXECUTION_UNVERIFIED', () => run(c => {
  const s: Snapshot = { type: 'Observation', records: [{}], offset: 0, suppressed: false, query: [] };
  const r = c.coverageV2(s, call({ tool: 'fhir_result', filtered: false, deliveredCount: 1 }));
  console.log(`P-A21: state=${r.coverage.state} qe=${r.coverage.query_evidence} reasons=${r.coverage.reasons} warnings=${r.warnings.map(w => w.code)}`);
  assert.equal(r.warnings.some(w => w.code === 'FILTER_EXECUTION_UNVERIFIED') || r.coverage.reasons.includes('FILTER_EXECUTION_UNVERIFIED'), false);
}));

for (const reason of ['OVERSIZED_RESOURCE', 'UNSUPPORTED_PRECISION', 'INVALID_RESOURCE_ID', 'ENTRY_ORIGIN_MISMATCH', 'OUTPUT_LIMIT', 'SOURCE_REPORTED_INCOMPLETE', 'DELIVERY_REFUSED']) {
  test(`F-01 reason-only delivery loss ${reason} refuses all clinical origins`, () => run(c => {
    for (const tool of ['fhir_search', 'fhir_page', 'fhir_read', 'fhir_result'] as const) {
      const r = c.coverageV2(state(proved()), call({ tool, reasons: [reason] }));
      assert.equal(r.coverage.state, 'partial'); assert.notEqual(r.coverage.query_exhausted, true);
      assert.ok(r.coverage.reasons.includes(reason)); assert.equal(hasNM(r), false);
    }
  }));
}
test('F-03 reason-only unverified execution always pairs warning and prevents completeness', () => run(c => {
  const r = c.coverageV2(state(proved()), call({ reasons: ['FILTER_EXECUTION_UNVERIFIED'] }));
  assert.equal(r.coverage.state, 'unknown'); assert.ok(r.warnings.some(w => w.code === 'FILTER_EXECUTION_UNVERIFIED'));
}));
test('F-04 31 caller reasons plus caveat and unproved execution refuses instead of losing the filter reason', () => run(c => {
  assert.throws(() => c.coverageV2(state(), call({ reasons: Array.from({ length: 31 }, (_, i) => `R${i}`) })), /Coverage evidence/);
}));
test('N-04 id selectors never count as material NO_MATCHES filters', () => run(c => {
  const e = evidence([{ name: '_id', value: 'synthetic-o1' }, { name: 'subject', value: 'Patient/synthetic-a' }]);
  assert.equal(hasNM(c.coverageV2(state(e), call({ filtered: false }))), false);
}));
test('F-07 warning boundary strips arbitrary keys and rejects unreviewed NO_MATCHES repairs', () => run(c => {
  assert.deepEqual(c.warningsV2([{ code: 'ORDER_UNVERIFIED', message: 'source', secret: 'canary' }]),
    [{ code: 'ORDER_UNVERIFIED', message: 'Requested ordering is not verified; do not treat the first record as latest.' }]);
  const w = c.warningsV2([{ code: 'NO_MATCHES', message: NO_MATCHES_MESSAGE, repair: { action: 'inspect_observed_codes', resource_type: 'Invented' } }]);
  assert.equal(w[0]!.repair, undefined);
}));
test('F-09 refusal without reasons retains DELIVERY_REFUSED', () => run(c => {
  assert.ok(c.coverageV2(state(proved()), call({ refused: true })).coverage.reasons.includes('DELIVERY_REFUSED'));
}));
test('F-13 C53-M04 INVALID_ARGUMENTS rejects arbitrary fault prose', () => run(c => {
  assert.equal(c.errorV2('fhir_search', { code: 'INVALID_ARGUMENTS', message: 'source canary', retryable: false }).error!.safe_message,
    'Unable to complete the bounded request.');
}));

test('F-02 continuation evidence on retained snapshots keeps the required retained label; reads keep resource evidence', () => run(c => {
  const s = { ...state(proved()), queryEvidenceKind: 'unverified_continuation' };
  const retained = c.coverageV2(s, call({ tool: 'fhir_result' }));
  assert.equal(retained.coverage.query_evidence, 'retained_snapshot');
  assert.equal(retained.coverage.state, 'partial'); assert.equal(retained.coverage.query_exhausted, null);
  const read = c.coverageV2(s, call({ tool: 'fhir_read', deliveredCount: 1 }));
  assert.equal(read.coverage.query_evidence, 'exact_id_and_subject_linkage');
  assert.equal(read.warnings.some(w => w.code === 'CONTINUATION_QUERY_UNVERIFIED'), false);
}));
