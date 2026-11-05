// Reviewer integration probes (Claude, S5.3): real 0.1 snapshots from a loopback
// synthetic source, assembled by the inert v2 coverageV2. Retained regression corpus.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { FhirGateway } from '../packages/core/src/index.js';
import type { GatewayEnvelope02 } from '../packages/core/src/contracts.js';

type Mode = { pages: number; opaque: boolean; empty: boolean; outcome?: unknown };
async function withSource(mode: Mode, fn: (g: FhirGateway, c: any) => Promise<void>) {
  let base = '';
  const source = createServer((req, res) => {
    res.setHeader('content-type', 'application/fhir+json');
    const url = new URL(req.url!, base);
    if (url.pathname.endsWith('/metadata')) {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [{ type: 'Observation', interaction: [{ code: 'search-type' }, { code: 'read' }], searchParam: [{ name: 'subject', type: 'reference' }, { name: 'code', type: 'token' }, { name: 'date', type: 'date' }] }] }] }));
      return;
    }
    const index = mode.opaque ? Number(url.searchParams.get('_getpagesoffset') ?? '0') : Number(url.searchParams.get('_offset') ?? '0');
    const next = mode.opaque ? new URL(`${base}?_getpages=abc&_getpagesoffset=${index + 1}`) : (() => { const n = new URL(url); n.searchParams.set('_offset', String(index + 1)); return n; })();
    const entries = mode.empty ? [] : [{ search: { mode: 'match' }, resource: { resourceType: 'Observation', id: `synthetic-o${index}`, status: 'final', subject: { reference: 'Patient/synthetic-a' }, code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] } } }];
    if (mode.outcome) entries.push({ search: { mode: 'outcome' }, resource: mode.outcome } as never);
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }, ...(index < mode.pages - 1 ? [{ relation: 'next', url: next.href }] : [])], entry: entries }));
  });
  await new Promise<void>(r => source.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(source.address() as { port: number }).port}/fhir`;
  const g = new FhirGateway({ mode: 'synthetic', source: { alias: 'local', baseUrl: base }, patientId: 'synthetic-a', contextId: 'ctx_test' });
  try { await fn(g, g as any); } finally { g.close(); source.closeAllConnections(); await new Promise<void>(r => source.close(() => r())); }
}

for (const opaque of [false, true]) test(`I-1 confinement-only 2-page chain (${opaque ? 'HAPI _getpages' : '_offset'}) terminal page: v2 must not claim complete with CONTINUATION_QUERY_UNVERIFIED`, async () => {
  await withSource({ pages: 2, opaque, empty: false }, async (g, c) => {
    const first = await g.execute('fhir_search', { resource_type: 'Observation' });
    assert.equal(first.error, undefined, JSON.stringify(first.error));
    const cursor = first.pagination!.next_cursor!;
    const second = await g.execute('fhir_page', { cursor });
    assert.equal(second.error, undefined, JSON.stringify(second.error));
    const snap = c.store.get(cursor).value;
    const r = c.coverageV2(snap, { tool: 'fhir_page', deliveredCount: second.pagination!.returned_matches, filtered: false });
    const cov = r.coverage as GatewayEnvelope02['coverage'];
    console.log(`I-1 ${opaque ? 'opaque' : 'offset'}: 0.1 state=${second.coverage.state} qe=${(second.coverage as any).query_evidence} | v2 state=${cov.state} qe=${cov.query_evidence} exhausted=${cov.query_exhausted} reasons=${cov.reasons} warnings=${r.warnings.map((w: any) => w.code)}`);
    assert.equal(cov.query_evidence, 'unverified_continuation'); assert.equal(cov.query_exhausted, null);
    assert.ok(r.warnings.some((w: any) => w.code === 'CONTINUATION_QUERY_UNVERIFIED'));
    assert.equal(cov.state === 'complete_for_query' && r.warnings.some((w: any) => w.code === 'CONTINUATION_QUERY_UNVERIFIED'), false);
  });
});

test('I-2 filtered generic chain: empty page 1 with next, empty terminal opaque page 2 => NO_MATCHES on unverified continuation?', async () => {
  await withSource({ pages: 2, opaque: true, empty: true }, async (g, c) => {
    const first = await g.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }] });
    assert.equal(first.error, undefined, JSON.stringify(first.error));
    const firstSnap = c.store.get(first.pagination!.next_cursor!).value; // not used for render
    void firstSnap;
    const cursor = first.pagination!.next_cursor!;
    const second = await g.execute('fhir_page', { cursor });
    const snap = c.store.get(cursor).value;
    const r = c.coverageV2(snap, { tool: 'fhir_page', deliveredCount: 0, filtered: true });
    console.log(`I-2: v2 state=${r.coverage.state} exhausted=${r.coverage.query_exhausted} reasons=${r.coverage.reasons} warnings=${r.warnings.map((w: any) => w.code)}`);
    assert.equal(r.warnings.some((w: any) => w.code === 'NO_MATCHES'), false);
  });
});

test('I-3 confinement-only single page with warning OperationOutcome naming subject: v2 complete + FILTER_EXECUTION_UNVERIFIED reason, no warning?', async () => {
  const outcome = { resourceType: 'OperationOutcome', issue: [{ severity: 'warning', code: 'informational', diagnostics: 'subject index rebuilt' }] };
  await withSource({ pages: 1, opaque: false, empty: false, outcome }, async (g, c) => {
    const first = await g.execute('fhir_search', { resource_type: 'Observation' });
    assert.equal(first.error, undefined, JSON.stringify(first.error));
    const snap = c.store.get(first.result!.handle).value;
    // res_ overlay already advanced deliveredCount; coverage below only checks state/reasons.
    const r = c.coverageV2(snap, { tool: 'fhir_search', deliveredCount: 0, filtered: false });
    console.log(`I-3: 0.1 state=${first.coverage.state} warnings=${first.warnings.map(w => w.code)} | v2 state=${r.coverage.state} reasons=${r.coverage.reasons} warnings=${r.warnings.map((w: any) => w.code)} unverified=${snap.unverifiedFilters}`);
    assert.notEqual(r.coverage.state, 'complete_for_query'); assert.ok(r.coverage.reasons.includes('FILTER_EXECUTION_UNVERIFIED'));
    assert.ok(r.warnings.some((w: any) => w.code === 'FILTER_EXECUTION_UNVERIFIED'));
  });
});

test('I-4 reviewed names depend on prior searches (state-dependent repair)', async () => {
  await withSource({ pages: 1, opaque: false, empty: false }, async (g, c) => {
    await g.execute('fhir_capabilities', { topic: 'resource', resource_type: 'Observation' });
    const before = c.reviewedNamesV2().resource('Observation');
    const repairBefore = c.refusalV2('fhir_search', 'unsupported_modifier', { upstreamCalls: 1, clinicalCalls: 0 }, undefined, { resource_type: 'Observation', parameter: 'code' }).error.repair;
    await g.execute('fhir_search', { resource_type: 'Observation' });
    const after = c.reviewedNamesV2().resource('Observation');
    const repairAfter = c.refusalV2('fhir_search', 'unsupported_modifier', { upstreamCalls: 1, clinicalCalls: 0 }, undefined, { resource_type: 'Observation', parameter: 'code' }).error.repair;
    console.log(`I-4: reviewed before search=${before} after=${after}; repair before=${JSON.stringify(repairBefore)} after=${JSON.stringify(repairAfter)}`);
    assert.equal(before, true); assert.equal(before, after); assert.deepEqual(repairBefore, repairAfter);
  });
});
