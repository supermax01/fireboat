import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import * as publicCore from '../packages/core/src/index.js';
import * as queryModule from '../packages/core/src/query.js';
import { FhirGateway, type GatewayConfig, type GatewayEnvelope, type QueryEvidence, type QueryOverlay } from '../packages/core/src/index.js';
import { coverageForSnapshot, declaredSearchProfile, eligibleSearchProfileIds, searchProfile, validateSortPage, type SearchProfile } from '../packages/core/src/query.js';
import type { FhirResource } from '../packages/core/src/contracts.js';

// Labelled PRIVATE CANDIDATE evidence. This is not production profile qualification.
const candidate: SearchProfile = {
  ...declaredSearchProfile('synthetic-fixture-r4-v1')!, id: 'private-s4-candidate', eligible: false,
  source: { software: 's4 synthetic fixture', software_version: '1', fhir_version: '4.0.1' },
  evidence: null,
};
const patient = 'synthetic-s4';
const output = { format: 'fhir' as const, max_bytes: 60000 };
const code = { name: 'code', value: 'http://loinc.org|4548-4' };
const date = { name: 'date', value: 'ge2020-01-01' };
const sort = { name: '_sort', value: '-date' };
const obs = (id: string, effectiveDateTime = '2025-01-03T00:00:00Z', extra: Record<string, unknown> = {}): FhirResource => ({
  resourceType: 'Observation', id, status: 'final', subject: { reference: `Patient/${patient}` },
  code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, effectiveDateTime, ...extra,
});
interface State { query: { name: string; value: string }[]; queryEvidence: QueryEvidence; queryOverlay: QueryOverlay; records: unknown[]; expiresAt?: number }
const internal = (gateway: FhirGateway) => gateway as unknown as {
  currentQueryEvidence(state: State): QueryEvidence;
  store: { size: number; usedBytes(): number; get(key: string): { value: State; expires_at: string }; shared: Map<string, { value: object }>; blobs: Map<string, { value: object }>; items: Map<string, { overlay?: State }> };
};
const stateOf = (gw: FhirGateway, result: GatewayEnvelope) => internal(gw).store.get(result.result!.handle).value;
const evidenceOf = (gw: FhirGateway, result: GatewayEnvelope) => internal(gw).currentQueryEvidence(stateOf(gw, result));
const execution = (evidence: QueryEvidence, name: string) => evidence.constraints.filter(entry => entry.name === name).map(entry => entry.execution);
const ok = (result: GatewayEnvelope) => assert.equal(result.error, undefined, 'fixed success assertion');
interface Options {
  pages?: FhirResource[][]; self?: (url: URL, index: number) => URL | null; next?: (url: URL, index: number) => URL;
  opaque?: boolean; profile?: SearchProfile | false; hold?: boolean;
}
async function fixture(t: TestContext, options: Options = {}) {
  const pages = options.pages ?? [[obs('first')]];
  let base = '';
  let calls = 0;
  const held: { res: ServerResponse; body: string }[] = [];
  const requests: URL[] = [];
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/fhir+json');
    const url = new URL(req.url!, base);
    if (url.pathname.endsWith('/metadata')) {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', software: { name: 's4 synthetic fixture', version: '1' }, rest: [{ mode: 'server', resource: [{ type: 'Observation', interaction: [{ code: 'search-type' }], searchParam: ['patient', 'subject', 'performer', 'code', 'date', 'status'].map(name => ({ name, type: name === 'date' ? 'date' : ['code', 'status'].includes(name) ? 'token' : 'reference' })) }] }] })); return;
    }
    calls++; requests.push(url);
    const index = Number(url.searchParams.get('_getpagesoffset') ?? url.searchParams.get('_offset') ?? '0');
    const self = options.self ? options.self(new URL(url), index) : new URL(url);
    let next: URL | undefined;
    if (index + 1 < pages.length) {
      next = options.opaque ? new URL(base) : new URL(url);
      if (options.opaque) { next.searchParams.set('_getpages', 'fixed-private-token'); next.searchParams.set('_getpagesoffset', String(index + 1)); }
      else next.searchParams.set('_offset', String(index + 1));
      if (options.next) next = options.next(next, index);
    }
    const body = JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [...(self ? [{ relation: 'self', url: self.href }] : []), ...(next ? [{ relation: 'next', url: next.href }] : [])], entry: pages[index]!.map(resource => ({ resource, search: { mode: 'match' } })) });
    if (options.hold && index > 0) held.push({ res, body }); else res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}/fhir/`;
  const config: GatewayConfig = { mode: 'synthetic', source: { alias: 's4-fixture', baseUrl: base }, patientId: patient };
  const gw = new FhirGateway(config, options.profile === false ? undefined : { testQueryProfile: options.profile ?? candidate });
  t.after(async () => { gw.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { gw, config, requests, calls: () => calls, held,
    search: (params = [code, date, sort], maxBytes = 60000) => gw.execute('fhir_search', { resource_type: 'Observation', params, output: { ...output, max_bytes: maxBytes } }),
    page: (cursor: string) => gw.execute('fhir_page', { cursor, output }),
  };
}

for (const variant of ['dropped', 'different', 'duplicated'] as const) test(`S4 self sort ${variant} downgrades order only and stays sticky`, async t => {
  const f = await fixture(t, { pages: [[obs('first')], [obs('second', '2025-01-02T00:00:00Z')]], self: (url, index) => {
    if (!index) { if (variant === 'dropped') url.searchParams.delete('_sort'); else if (variant === 'different') url.searchParams.set('_sort', 'date'); else url.searchParams.append('_sort', '-date'); } return url;
  } });
  const first = await f.search(); ok(first);
  assert.equal(evidenceOf(f.gw, first).sort?.order, 'requested_unverified');
  assert.equal(evidenceOf(f.gw, first).materialFilterProved, true);
  const second = await f.page(first.pagination!.next_cursor!); ok(second);
  assert.equal(evidenceOf(f.gw, second).sort?.order, 'requested_unverified');
  assert.ok(first.warnings.some(w => w.code === 'TEST_QUERY_EVIDENCE'));
});

test('S4 initial missing self fails closed and commits no candidate handles', async t => {
  const f = await fixture(t, { self: () => null });
  const result = await f.search(); assert.equal(result.error?.code, 'UNVERIFIED_QUERY');
  assert.equal(internal(f.gw).store.size, 0);
  assert.deepEqual(result.warnings, [], 'errors carry no test labels');
});

test('S4 immutable multiplicity shares original metadata once; counters measure branch delivery only', async t => {
  const f = await fixture(t, { pages: [[obs('a'), obs('b'), obs('c')], [obs('d', '2025-01-02T00:00:00Z')]], self: url => {
    const seen = new Set<string>(); const collapsed = new URL(url); collapsed.search = '';
    for (const [key, value] of url.searchParams) { const pair = `${key}=${value}`; if (seen.has(pair) && !key.startsWith('_')) continue; seen.add(pair); collapsed.searchParams.append(key, value); } return collapsed;
  } });
  const first = await f.search([{ ...code }, { ...code }, date, sort]); ok(first);
  const store = internal(f.gw).store;
  const original = stateOf(f.gw, first);
  assert.equal(original.queryEvidence.constraints.filter(p => p.name === 'code').length, 2);
  assert.ok(Object.isFrozen(original.query) && Object.isFrozen(original.queryEvidence.constraints));
  const firstExpiry = first.result!.expires_at;
  const firstCount = original.queryOverlay.deliveredCount;
  assert.equal(firstCount, 3); assert.equal(original.queryOverlay.pagesObserved, 1);
  const cursor = first.pagination!.next_cursor!;
  const [second, replay] = await Promise.all([f.page(cursor), f.page(cursor)]); ok(second); ok(replay);
  assert.equal(f.calls(), 2);
  for (const result of [second, replay]) {
    const state = stateOf(f.gw, result);
    assert.equal(state.queryOverlay.pagesObserved, 2); assert.equal(state.queryOverlay.deliveredCount, 4);
    assert.equal(state.queryEvidence, original.queryEvidence); assert.equal(state.query, original.query);
    assert.equal(result.result!.expires_at, firstExpiry);
  }
  assert.equal(store.shared.size, 1, 'one full query/evidence backing across upstream page blobs');
  for (const blob of store.blobs.values()) { assert.ok(!('query' in blob.value)); assert.ok(!('queryEvidence' in blob.value)); assert.equal((blob.value as { queryOverlay?: unknown }).queryOverlay, undefined); }
  for (const item of store.items.values()) if (item.overlay?.queryOverlay) assert.equal(item.overlay.queryOverlay.queryEvidence.constraints.length, 0);
  assert.equal(first.schema_version, '0.3'); assert.ok('constraints' in first.coverage);
});

test('S4 local remainder and replay never inflate upstream pages or cumulative delivered count', async t => {
  const f = await fixture(t, { pages: [Array.from({ length: 12 }, (_, i) => obs(`row-${i}`, '2025-01-03T00:00:00Z', { valueString: 'x'.repeat(900) }))] });
  const first = await f.search([code, sort], 7000); ok(first);
  assert.ok(first.pagination!.next_cursor);
  const cursor = first.pagination!.next_cursor!;
  const initial = stateOf(f.gw, first).queryOverlay;
  const second = await f.page(cursor); const replay = await f.page(cursor); ok(second); ok(replay);
  for (const result of [second, replay]) {
    const overlay = stateOf(f.gw, result).queryOverlay;
    assert.equal(overlay.pagesObserved, 1);
    assert.equal(overlay.deliveredCount, initial.deliveredCount + result.pagination!.returned_matches);
  }
  assert.equal(f.calls(), 1);
});

test('S4 claimed raw predicate contradiction invalidates profile; replay and new queries cannot restore it', async t => {
  const f = await fixture(t, { pages: [[obs('a')], [obs('b', '2025-01-02T00:00:00Z', { code: { coding: [{ system: 'http://loinc.org', code: 'wrong' }] } })]] });
  const first = await f.search(); ok(first);
  const before = internal(f.gw).store.size;
  const cursor = first.pagination!.next_cursor!;
  const failed = await f.page(cursor); assert.equal(failed.error?.code, 'UNVERIFIED_QUERY');
  assert.equal(internal(f.gw).store.size, before, 'no candidate handles committed');
  assert.deepEqual(execution(evidenceOf(f.gw, first), 'code'), ['unknown']);
  assert.equal(evidenceOf(f.gw, first).sort?.order, 'requested_unverified', 'old retained result cannot resurrect invalidated order proof');
  const replay = await f.page(cursor); ok(replay);
  assert.deepEqual(execution(evidenceOf(f.gw, replay), 'code'), ['unknown']);
  assert.equal(evidenceOf(f.gw, replay).sort?.order, 'requested_unverified');
  const fresh = await f.search(); ok(fresh); assert.deepEqual(execution(evidenceOf(f.gw, fresh), 'code'), ['unknown']);
});

test('S4 predicate checks run before fields projection can hide a contradiction', async t => {
  const f = await fixture(t, { pages: [[obs('bad', '2019-01-01T00:00:00Z')]] });
  const result = await f.gw.execute('fhir_search', { resource_type: 'Observation', params: [code, date], output: { ...output, fields: ['id'] } });
  assert.equal(result.error?.code, 'UNVERIFIED_QUERY'); assert.equal(result.result, undefined);
});

test('S4 repeated unverifiable parameters all downgrade and never upgrade on later pages (mixed proof, S6)', async t => {
  const profile = { ...candidate, testedFilters: [...candidate.testedFilters, { resource_type: 'Observation', parameter: 'status', variant: 'token-system-code' }] };
  const timing = obs('timing'); delete timing.effectiveDateTime; timing.effectiveTiming = { event: ['2025-01-01'] };
  const f = await fixture(t, { profile, pages: [[timing], [obs('ordinary', '2025-01-02T00:00:00Z')]] });
  const first = await f.search([code, date, { name: 'status', value: 'urn:status|final' }, sort]); ok(first);
  for (const name of ['date', 'status']) assert.deepEqual(execution(evidenceOf(f.gw, first), name), ['unknown']);
  const second = await f.page(first.pagination!.next_cursor!); ok(second);
  for (const name of ['date', 'status']) assert.deepEqual(execution(evidenceOf(f.gw, second), name), ['unknown']);
  assert.deepEqual(execution(evidenceOf(f.gw, second), 'code'), ['tested_adapter']);
  assert.equal(evidenceOf(f.gw, second).sort?.order, 'requested_unverified');
  // S6 wire labels: the mixed proof is disclosed honestly under the declared kind with the caveat, never complete.
  for (const result of [first, second]) {
    assert.equal(result.coverage.query_evidence, 'declared_and_self_link_only');
    assert.ok(result.coverage.reasons.includes('FILTER_EXECUTION_UNVERIFIED'));
    assert.ok(result.warnings.some(w => w.code === 'FILTER_EXECUTION_UNVERIFIED'));
    assert.notEqual(result.coverage.state, 'complete_for_query');
    assert.ok(result.coverage.constraints_on_first_page === true || result.coverage.constraints!.some(c => c.name === 'code' && c.execution === 'tested_adapter'));
  }
});

for (const crossPage of [false, true]) test(`S4 claimed ${crossPage ? 'cross-page' : 'within-page'} sort contradiction refuses and invalidates`, async t => {
  const early = obs('early', '2025-01-01T00:00:00Z'); const late = obs('late', '2025-01-02T00:00:00Z');
  const f = await fixture(t, { pages: crossPage ? [[early], [late]] : [[early, late]] });
  const first = await f.search();
  const result = crossPage ? await f.page(first.pagination!.next_cursor!) : first;
  assert.equal(result.error?.code, 'UNVERIFIED_QUERY');
});

for (const variant of ['mixed', 'overlap', 'ties-offsets'] as const) test(`S4 cross-page sort ${variant} preserves precision and numeric offset semantics`, async t => {
  const firstDate = variant === 'mixed' ? '2025-01-03T00:00:00.120Z' : variant === 'overlap' ? '2025-01-03T00:00:00.12Z' : '2025-01-03T01:00:00+01:00';
  const nextDate = variant === 'mixed' ? '2025-01-03T00:00:00Z' : variant === 'overlap' ? '2025-01-03T00:00:00.1Z' : '2025-01-03T00:00:00Z';
  const f = await fixture(t, { pages: [[obs('a', firstDate)], [obs('b', nextDate)], [obs('c', '2025-01-02T00:00:00Z')]] });
  const first = await f.search(); ok(first);
  assert.equal(stateOf(f.gw, first).queryOverlay.sortBoundaryPrecision, variant === 'ties-offsets' ? 'second' : 'fraction');
  const second = await f.page(first.pagination!.next_cursor!); ok(second);
  assert.equal(evidenceOf(f.gw, second).sort?.order, variant === 'ties-offsets' ? 'verified_by_adapter' : 'requested_unverified');
  const third = await f.page(second.pagination!.next_cursor!); ok(third);
  assert.equal(evidenceOf(f.gw, third).sort?.order, variant === 'ties-offsets' ? 'verified_by_adapter' : 'requested_unverified');
});

test('S4 boundary without precision is unverifiable, including empty observed pages', () => {
  for (const page of [[], [obs('fraction', '2025-01-03T00:00:00.1Z')]]) {
    assert.equal(validateSortPage(page, ['-date'], 'Observation', Date.parse('2025-01-03T00:00:00.12Z')).outcome.status, 'unverifiable');
  }
});

test('S4 generic source cannot claim contradictions or name-based enforcement', async t => {
  const f = await fixture(t, { profile: false, pages: [[obs('bad', '2019-01-01T00:00:00Z', { code: { coding: [{ code: 'other' }] }, performer: [{ reference: 'Practitioner/different' }] })]] });
  const result = await f.search([code, date, { name: 'performer', value: `Patient/${patient}` }, sort]); ok(result);
  const evidence = evidenceOf(f.gw, result);
  for (const name of ['code', 'date', 'performer']) assert.deepEqual(execution(evidence, name), ['unknown']);
  assert.deepEqual(execution(evidence, 'patient'), ['gateway_enforced']);
  assert.equal(evidence.sort?.order, 'requested_unverified'); assert.equal(evidence.materialFilterProved, false);
});

test('S4 only reviewed continuation forms retain proof; HAPI opaque stays unverified', async t => {
  const f = await fixture(t, { opaque: true, pages: [[obs('a')], [obs('b')]] });
  const first = await f.search(); ok(first);
  const second = await f.page(first.pagination!.next_cursor!); ok(second);
  assert.deepEqual(execution(evidenceOf(f.gw, second), 'code'), ['unknown']);
  assert.equal(evidenceOf(f.gw, second).sort?.order, 'requested_unverified');
  assert.equal(second.coverage.query_evidence, 'unverified_continuation');
  assert.equal(stateOf(f.gw, second).queryOverlay.pagesObserved, 2);
  assert.equal(coverageForSnapshot(evidenceOf(f.gw, second), { deliveredCount: 2, pagesObserved: 2, queryEvidence: evidenceOf(f.gw, second), sortProof: 'none', remainder: 'none', exhausted: true, scope: 'page', authorizationLimited: true }).state, 'unknown');
});

test('S4 private seam cannot escape through public config, CLI or exported factories', async t => {
  const f = await fixture(t, { profile: false });
  for (const config of [{ ...f.config, testQueryProfile: candidate }, { ...f.config, source: { ...f.config.source, searchProfile: candidate.id } }, { ...f.config, source: { ...f.config.source, testQueryProfile: candidate } }]) {
    assert.throws(() => new FhirGateway(config as GatewayConfig), { code: 'INVALID_CONFIG' });
  }
  const exportedState = Reflect.construct(queryModule.ProfileState, [candidate, true]) as queryModule.ProfileState;
  assert.equal(exportedState.profile(candidate.id), undefined, 'exported ProfileState constructor cannot install test candidates');
  assert.equal(queryModule.ProfileState.length, 0, 'no public candidate constructor arguments');
  for (const name of ['brandSearchProfileForTest', 'registerSearchProfileForTest', 'setCandidateForTest']) {
    assert.ok(!(name in publicCore)); assert.ok(!(name in queryModule));
  }
  assert.ok(!readFileSync(new URL('../packages/server/src/cli.ts', import.meta.url), 'utf8').includes('testQueryProfile'));
  assert.deepEqual(eligibleSearchProfileIds(), ['generic-r4', 'hapi-r4-labs-v1', 'synthetic-fixture-r4-v1']);
  assert.equal(searchProfile('private-s4-candidate'), undefined);
  assert.ok(searchProfile('synthetic-fixture-r4-v1'), 'the qualified public profile resolves through the registry, never through the seam (S6)');
  const result = await f.search(); ok(result); assert.ok(!result.warnings.some(w => w.code === 'TEST_QUERY_EVIDENCE'));
});

test('S4 ordinary continuation self material mismatch refuses before any candidate handles', async t => {
  const f = await fixture(t, { pages: [[obs('a')], [obs('b')]], self: (url, index) => { if (index) url.searchParams.set('code', 'http://loinc.org|different'); return url; } });
  const first = await f.search(); ok(first);
  const count = internal(f.gw).store.size;
  const second = await f.page(first.pagination!.next_cursor!);
  assert.equal(second.error?.code, 'UNVERIFIED_QUERY'); assert.equal(second.result, undefined);
  assert.equal(internal(f.gw).store.size, count);
});

test('S4 unsafe sort-changing next link preserves a safe partial prefix without upstream work', async t => {
  const f = await fixture(t, { pages: [[obs('a')], [obs('b')]], next: url => { url.searchParams.set('_sort', 'date'); return url; } });
  const first = await f.search(); ok(first);
  assert.equal(first.pagination!.next_cursor, undefined); assert.equal(first.pagination!.has_more, null);
  assert.equal(stateOf(f.gw, first).queryOverlay.nonContinuable, true);
  assert.equal(stateOf(f.gw, first).queryOverlay.pagesObserved, 1); assert.equal(f.calls(), 1);
});

test('S4 unlisted full-query continuation forms cannot inherit closed-profile proof', async t => {
  for (const variant of ['cursor', 'non-numeric-offset', 'duplicate-offset', 'getpagesoffset']) {
    const f = await fixture(t, { pages: [[obs('a')], [obs('b')]], next: url => {
      // Keep the independent fixture page index numeric while varying the claimed form.
      if (variant === 'cursor') url.searchParams.set('_cursor', 'fixed-unlisted-form');
      else if (variant === 'getpagesoffset') url.searchParams.set('_getpagesoffset', '1');
      else if (variant === 'duplicate-offset') url.searchParams.append('_offset', '1');
      else { url.searchParams.set('_offset', '01opaque'); url.searchParams.set('_getpagesoffset', '1'); }
      return url;
    } });
    const first = await f.search(); ok(first);
    const second = await f.page(first.pagination!.next_cursor!); ok(second);
    assert.deepEqual(execution(evidenceOf(f.gw, second), 'code'), ['unknown']);
    assert.equal(evidenceOf(f.gw, second).sort?.order, 'requested_unverified');
  }
});

test('S4 private candidate binding still checks source identity and invents no report', async t => {
  assert.equal(candidate.eligible, false); assert.equal(candidate.evidence, null);
  const f = await fixture(t, { profile: { ...candidate, source: { ...candidate.source, software_version: 'different' } } });
  const result = await f.search(); ok(result);
  assert.deepEqual(execution(evidenceOf(f.gw, result), 'code'), ['unknown']);
  assert.ok(result.warnings.some(w => w.code === 'TEST_QUERY_EVIDENCE'));
});

test('S4 shared page flight carries inherited expiry and generation across concurrent waiters', async t => {
  const f = await fixture(t, { hold: true, pages: [[obs('a')], [obs('b')]] });
  const first = await f.search(); ok(first);
  const state = stateOf(f.gw, first);
  assert.equal(state.queryOverlay.pagesObserved, 1); assert.equal(new Date(state.expiresAt!).toISOString(), first.result!.expires_at);
  const cursor = first.pagination!.next_cursor!;
  const pending = [f.page(cursor), f.page(cursor)];
  for (let i = 0; !f.held.length && i < 500; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(f.held.length, 1, 'one upstream page flight shared by both waiters');
  (f.gw as unknown as { invalidateState(): void }).invalidateState();
  f.held[0]!.res.end(f.held[0]!.body);
  const results = await Promise.all(pending);
  for (const result of results) { assert.equal(result.error?.code, 'CONNECTION_REQUIRED'); assert.equal(result.result, undefined); }
  assert.equal(internal(f.gw).store.size, 0, 'old flight commits no metadata or handles after invalidation');
});

for (const proof of ['predicate', 'sort'] as const) test(`S4-F2 malformed-id ${proof} contradiction invalidates without retaining candidates`, async t => {
  const pages = proof === 'predicate'
    ? [[obs('bad_id', '2019-01-01T00:00:00Z'), obs('valid')]]
    : [[obs('first', '2025-01-01T00:00:00Z'), obs('bad_latest', '2025-12-01T00:00:00Z'), obs('last', '2024-01-01T00:00:00Z')]];
  const f = await fixture(t, { pages });
  const failed = await f.search(); assert.equal(failed.error?.code, 'UNVERIFIED_QUERY'); assert.equal(failed.result, undefined);
  assert.equal(internal(f.gw).store.size, 0, 'no candidate page is committed');
  const fresh = await f.search(); ok(fresh);
  assert.deepEqual(execution(evidenceOf(f.gw, fresh), 'date'), ['unknown']);
  assert.equal(evidenceOf(f.gw, fresh).sort?.order, 'requested_unverified');
  assert.ok(!(fresh.data.resources as { id?: string }[]).some(r => r.id?.includes('_')));
  assert.equal(fresh.pagination?.total?.value, undefined);
});

test('S4-F3 downgraded constraints shed evidence references on first and subsequent pages (mixed proof, S6)', async t => {
  const timing = obs('timing'); delete timing.effectiveDateTime; timing.effectiveTiming = { event: ['2025-01-01'] };
  const f = await fixture(t, { pages: [[timing], [obs('ordinary')]] });
  const first = await f.search(); ok(first);
  const second = await f.page(first.pagination!.next_cursor!); ok(second);
  for (const result of [first, second]) {
    const evidence = evidenceOf(f.gw, result);
    const dateClaim = evidence.constraints.find(c => c.name === 'date')!;
    assert.equal(dateClaim.execution, 'unknown'); assert.equal(dateClaim.evidence_ref, undefined);
    const codeClaim = evidence.constraints.find(c => c.name === 'code')!;
    assert.equal(codeClaim.execution, 'tested_adapter'); assert.equal(codeClaim.evidence_ref, `${candidate.id}@${candidate.version}`);
    assert.equal(result.coverage.query_evidence, 'declared_and_self_link_only');
    assert.ok(result.coverage.reasons.includes('FILTER_EXECUTION_UNVERIFIED'));
    assert.notEqual(result.coverage.state, 'complete_for_query');
  }
});

// S6: a continuation the proving profile lists (offset next link) whose page reports a matching self link keeps
// the chain's evidence kind; a drained chain can then be complete_for_query. Generic sources keep N-06.
for (const proved of [true, false]) test(`S6 ${proved ? 'proved' : 'generic'} continuation ${proved ? 'keeps the evidence kind and completes when drained' : 'stays unverified_continuation and never completes'}`, async t => {
  const f = await fixture(t, { profile: proved ? candidate : false, pages: [[obs('late', '2025-01-03T00:00:00Z')], [obs('early', '2025-01-02T00:00:00Z')]] });
  const first = await f.search([code, date, sort]); ok(first);
  assert.equal(first.coverage.query_evidence, proved ? 'tested_adapter' : 'declared_and_self_link_only');
  assert.equal(first.coverage.state, 'partial');
  const second = await f.page(first.pagination!.next_cursor!); ok(second);
  assert.equal(second.coverage.query_evidence, proved ? 'tested_adapter' : 'unverified_continuation');
  // N-06: an unverified continuation is a remainder of unknown extent, so the generic chain stays partial.
  assert.equal(second.coverage.state, proved ? 'complete_for_query' : 'partial');
  assert.equal(second.coverage.query_exhausted, proved ? true : null);
  assert.equal(second.coverage.pages_observed, 2);
  assert.equal(second.warnings.some(w => w.code === 'CONTINUATION_QUERY_UNVERIFIED'), !proved);
  assert.equal(second.coverage.sort?.order, proved ? 'verified_by_adapter' : 'requested_unverified');
  assert.deepEqual(execution(evidenceOf(f.gw, second), 'code'), [proved ? 'tested_adapter' : 'unknown']);
});

test('S6 a proved continuation form without a reported self link keeps N-06', async t => {
  const f = await fixture(t, { pages: [[obs('late', '2025-01-03T00:00:00Z')], [obs('early', '2025-01-02T00:00:00Z')]], self: (url, index) => index === 0 ? url : null });
  const first = await f.search([code, date, sort]); ok(first);
  const second = await f.page(first.pagination!.next_cursor!); ok(second);
  assert.equal(second.coverage.query_evidence, 'unverified_continuation');
  assert.notEqual(second.coverage.state, 'complete_for_query');
});

// S6 review findings 1-3: offset arithmetic, sticky N-06 and the continued page's own paging parameters.
test('S6 a next link that skips a window is never a proved continuation (finding 1)', async t => {
  const f = await fixture(t, { pages: [[obs('p0', '2025-01-03T00:00:00Z')], [obs('p1', '2025-01-02T00:00:00Z')], [obs('p2', '2025-01-01T00:00:00Z')]],
    next: (url, index) => { if (index === 0) url.searchParams.set('_offset', '2'); return url; } });
  const first = await f.search([code, date, sort]); ok(first);
  const second = await f.page(first.pagination!.next_cursor!); ok(second);
  assert.equal(second.coverage.query_evidence, 'unverified_continuation');
  assert.equal(second.coverage.state, 'partial');
  assert.equal(second.coverage.query_exhausted, null);
  assert.ok(second.warnings.some(w => w.code === 'CONTINUATION_QUERY_UNVERIFIED'));
  assert.ok(!second.warnings.some(w => w.code === 'NO_MATCHES'));
  assert.equal(second.coverage.sort?.order, 'requested_unverified');
});

test('S6 an empty page whose next link advances past it cannot complete with a verified NO_MATCHES (finding 1, fixture scenario)', async t => {
  // The fixture links page 0 to _offset=1 although page 0 returned no entries: a skipped window, never a proof.
  const f = await fixture(t, { pages: [[], []] });
  const first = await f.search([code, date, sort]); ok(first);
  assert.equal(first.coverage.state, 'partial');
  const second = await f.page(first.pagination!.next_cursor!); ok(second);
  assert.equal(second.coverage.query_evidence, 'unverified_continuation');
  assert.equal(second.coverage.state, 'partial');
  assert.ok(!second.warnings.some(w => w.code === 'NO_MATCHES'), 'no completeness claim over a skipped window');
});

test('S6 once a continuation is unverified, later verified pages never relabel or complete the chain (finding 2)', async t => {
  const f = await fixture(t, { pages: [[obs('p0', '2025-01-03T00:00:00Z')], [obs('p1', '2025-01-02T00:00:00Z')], [obs('p2', '2025-01-01T00:00:00Z')]],
    self: (url, index) => index === 1 ? null : url });
  const first = await f.search([code, date, sort]); ok(first);
  const second = await f.page(first.pagination!.next_cursor!); ok(second);
  assert.equal(second.coverage.query_evidence, 'unverified_continuation');
  const third = await f.page(second.pagination!.next_cursor!); ok(third);
  assert.equal(third.coverage.query_evidence, 'unverified_continuation', 'the flag is sticky');
  assert.notEqual(third.coverage.state, 'complete_for_query');
  assert.equal(third.coverage.query_exhausted, null);
  assert.equal(third.coverage.pages_observed, 3);
  assert.ok(third.warnings.some(w => w.code === 'CONTINUATION_QUERY_UNVERIFIED'));
  assert.equal(stateOf(f.gw, third).queryOverlay.continuationUnverified, true);
});

test('S6 a continued page whose self link reports another offset or an opaque paging token is not verified (finding 3)', async t => {
  for (const variant of ['other-offset', 'getpages'] as const) {
    const f = await fixture(t, { pages: [[obs('p0', '2025-01-03T00:00:00Z')], [obs('p1', '2025-01-02T00:00:00Z')]],
      self: (url, index) => { if (index === 1) { if (variant === 'other-offset') url.searchParams.set('_offset', '0'); else { url.searchParams.delete('_offset'); url.searchParams.set('_getpages', 'x'); } } return url; } });
    const first = await f.search([code, date, sort]); ok(first);
    const second = await f.page(first.pagination!.next_cursor!); ok(second);
    assert.equal(second.coverage.query_evidence, 'unverified_continuation', variant);
    assert.notEqual(second.coverage.state, 'complete_for_query', variant);
  }
});

test('S6 consistent offsets with matching self links are the only proved continuation; the drained chain completes', async t => {
  const f = await fixture(t, { pages: [[obs('p0', '2025-01-03T00:00:00Z')], [obs('p1', '2025-01-02T00:00:00Z')], [obs('p2', '2025-01-01T00:00:00Z')]] });
  const first = await f.search([code, date, sort]); ok(first);
  const second = await f.page(first.pagination!.next_cursor!); ok(second);
  const third = await f.page(second.pagination!.next_cursor!); ok(third);
  assert.equal(third.coverage.query_evidence, 'tested_adapter');
  assert.equal(third.coverage.state, 'complete_for_query');
  assert.equal(third.coverage.query_exhausted, true);
  assert.equal(third.coverage.sort?.order, 'verified_by_adapter');
  assert.deepEqual([stateOf(f.gw, second).queryOverlay.pageOffset, stateOf(f.gw, second).queryOverlay.pageEntries], [1, 1]);
});
