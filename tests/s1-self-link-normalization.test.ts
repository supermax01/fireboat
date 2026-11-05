import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { test, type TestContext } from 'node:test';
import { FhirGateway, type GatewayEnvelope } from '../packages/core/src/index.js';
import {
  buildQueryEvidence, eligibleSearchProfileIds, matchSelfLink, queryDigest, queryEvidencePairsMatch, searchProfile, type QueryPair,
} from '../packages/core/src/query.js';

// Synthetic private oracle/recordings only. Assertions deliberately report
// booleans, fixed labels, counts and fault codes, never bodies, ids or URLs.
const BOUND = 'normalization-synthetic-bound';
const FOREIGN = 'normalization-synthetic-foreign';
const REF = `Patient/${BOUND}`;
const CODE = 'http://loinc.org|4548-4';
const WINDOW: QueryPair[] = [{ name: 'date', value: 'ge2020-01-01' }, { name: 'date', value: 'lt2026-01-01' }];
const OUTPUT = { format: 'fhir' as const, max_bytes: 24000 };
const equalPrivate = (actual: unknown, expected: unknown, label: string): void => assert.ok(isDeepStrictEqual(actual, expected), label);
const pairsOf = (url: URL): QueryPair[] => [...url.searchParams].map(([name, value]) => ({ name, value }));
const recordsOf = (result: GatewayEnvelope): Record<string, unknown>[] => result.data.resources as Record<string, unknown>[];
const idsOf = (result: GatewayEnvelope): unknown[] => recordsOf(result).map(resource => resource.id);
const success = (result: GatewayEnvelope): void => assert.equal(result.error?.code, undefined, 'gateway success code');

const observation = (index: number, patient = BOUND, code = '4548-4', date = `2025-01-${String(index + 1).padStart(2, '0')}T10:00:00Z`) => ({
  resourceType: 'Observation', id: `normalization-observation-${index}`, meta: { versionId: '1' }, status: 'final',
  subject: { reference: `Patient/${patient}` }, code: { coding: [{ system: 'http://loinc.org', code }] },
  effectiveDateTime: date, valueQuantity: { value: 7, unit: '%' },
});
const OBSERVATIONS = [
  ...Array.from({ length: 7 }, (_, index) => observation(index)),
  observation(7, FOREIGN), observation(8, BOUND, '2345-7'),
  observation(9, BOUND, '4548-4', '2019-12-31T10:00:00Z'),
  observation(10, BOUND, '4548-4', '2026-01-01T10:00:00Z'),
];
const PATIENTS = [BOUND, FOREIGN].map(id => ({ resourceType: 'Patient', id, active: true }));

// This fixture transformation intentionally does not import the comparator
// under test. URLSearchParams has already decoded query syntax exactly once.
function collapsePredicates(url: URL): URL {
  const result = new URL(url);
  result.search = '';
  const seen = new Map<string, Set<string>>();
  for (const [name, value] of url.searchParams) {
    if (!name.startsWith('_') || name === '_id' || name === '_lastUpdated') {
      const values = seen.get(name) ?? new Set<string>();
      if (values.has(value)) continue;
      values.add(value); seen.set(name, values);
    }
    result.searchParams.append(name, value);
  }
  result.searchParams.sort();
  return result;
}

interface FixtureOptions {
  alias?: 'patient' | 'subject';
  collapse?: boolean;
  pageWidth?: number;
  omitSelf?: boolean;
  selfChange?: (url: URL) => void;
  nextChange?: (url: URL) => void;
  opaque?: boolean;
  injectForeign?: boolean;
}
interface Recording { pairs: QueryPair[]; self?: QueryPair[]; next?: QueryPair[]; strict: boolean; opaque: boolean }
async function fixture(t: TestContext, options: FixtureOptions = {}) {
  let base = '';
  let metadataCalls = 0;
  let unexpectedCalls = 0;
  let opaqueQuery: URL | undefined;
  const requests: Recording[] = [];
  const gateways: FhirGateway[] = [];
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/fhir+json');
    const url = new URL(req.url!, base);
    if (req.method !== 'GET') { unexpectedCalls++; res.statusCode = 405; res.end('{}'); return; }
    if (url.pathname === '/fhir/metadata') {
      metadataCalls++;
      res.end(JSON.stringify({
        resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', software: { name: 'synthetic-normalization', version: '1' },
        rest: [{ mode: 'server', resource: ['Patient', 'Observation'].map(type => ({
          type, interaction: [{ code: 'search-type' }],
          searchParam: (type === 'Patient' ? [] : [options.alias === 'subject' ? 'subject' : 'patient', ...(options.alias === 'subject' ? [] : ['subject']), 'code', 'date', 'performer']).map(name => ({ name, type: ['code'].includes(name) ? 'token' : name === 'date' ? 'date' : 'reference' })),
        })) }],
      }));
      return;
    }
    const opaque = url.pathname === '/fhir' && url.searchParams.has('_getpages');
    const type = opaque ? 'Observation' : url.pathname === '/fhir/Observation' ? 'Observation' : url.pathname === '/fhir/Patient' ? 'Patient' : undefined;
    if (!type || (opaque && !opaqueQuery)) { unexpectedCalls++; res.statusCode = 404; res.end('{}'); return; }
    const effective = opaque ? opaqueQuery! : url;
    // Independent semantic selection over fixed resources. Each date/code
    // decoy is excluded by precisely one requested predicate.
    let selected: Record<string, unknown>[] = type === 'Patient' ? [...PATIENTS] : [...OBSERVATIONS];
    for (const [name, value] of effective.searchParams) {
      if (name === '_id') selected = selected.filter(resource => resource.id === value);
      if (name === 'patient' || name === 'subject') selected = selected.filter(resource => (resource.subject as { reference?: string } | undefined)?.reference === value);
      if (name === 'code') selected = selected.filter(resource => (resource.code as { coding: { system: string; code: string }[] }).coding.some(coding => `${coding.system}|${coding.code}` === value));
      if (name === 'date') selected = selected.filter(resource => value.startsWith('ge') ? Date.parse(resource.effectiveDateTime as string) >= Date.parse(value.slice(2)) : value.startsWith('lt') && Date.parse(resource.effectiveDateTime as string) < Date.parse(value.slice(2)));
    }
    if (effective.searchParams.has('_sort')) selected.sort((a, b) => (effective.searchParams.get('_sort') === '-date' ? -1 : 1) * (Date.parse(a.effectiveDateTime as string) - Date.parse(b.effectiveDateTime as string)));
    const offset = Number(url.searchParams.get(opaque ? '_getpagesoffset' : '_offset') ?? 0);
    const width = options.pageWidth ?? Number(effective.searchParams.get('_count') ?? 20);
    const page = selected.slice(offset, offset + width);
    const self = options.collapse === false ? new URL(url) : collapsePredicates(url);
    options.selfChange?.(self);
    let next: URL | undefined;
    if (offset + page.length < selected.length) {
      if (options.opaque) {
        opaqueQuery ??= new URL(url);
        next = new URL('/fhir', base);
        next.searchParams.set('_getpages', 'synthetic-query-handle');
        next.searchParams.set('_getpagesoffset', String(offset + page.length));
        next.searchParams.set('_count', String(width));
        next.searchParams.set('_bundletype', 'searchset');
      } else {
        next = options.collapse === false ? new URL(url) : collapsePredicates(url);
        next.searchParams.set('_offset', String(offset + page.length));
      }
      options.nextChange?.(next);
    }
    requests.push({ pairs: pairsOf(url), ...(options.omitSelf ? {} : { self: pairsOf(self) }), ...(next ? { next: pairsOf(next) } : {}), strict: req.headers.prefer === 'handling=strict', opaque });
    res.end(JSON.stringify({
      resourceType: 'Bundle', type: 'searchset', total: selected.length,
      link: [...(options.omitSelf ? [] : [{ relation: 'self', url: self.href }]), ...(next ? [{ relation: 'next', url: next.href }] : [])],
      entry: [...page, ...(options.injectForeign ? [type === 'Patient' ? PATIENTS[1]! : observation(7, FOREIGN)] : [])].map(resource => ({ resource, search: { mode: 'match' } })),
    }));
  });
  t.after(async () => {
    gateways.forEach(gateway => gateway.close());
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(new Error('synthetic fixture close failed')) : resolve()));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', () => reject(new Error('synthetic fixture listen failed'))); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string', 'literal loopback fixture bound');
  base = `http://127.0.0.1:${address.port}/fhir/`;
  return {
    requests, metadataCalls: () => metadataCalls, unexpectedCalls: () => unexpectedCalls,
    gateway: () => {
      const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'normalization-fixture', baseUrl: base, searchProfile: 'generic-r4' }, patientId: BOUND });
      gateways.push(gateway); return gateway;
    },
  };
}

function observationParams(alias: 'patient' | 'subject' = 'patient'): QueryPair[] {
  return [
    { name: alias, value: REF },
    ...(alias === 'patient' ? [{ name: 'subject', value: REF }] : []),
    { name: 'code', value: CODE }, ...WINDOW, { name: 'code', value: CODE }, { name: '_sort', value: 'date' },
  ];
}
function assertLabels(result: GatewayEnvelope, frozen: QueryPair[], confinement: string): void {
  success(result);
  const material = frozen.filter(p => !['_sort', '_count'].includes(p.name));
  assert.equal(result.coverage.query_digest, queryDigest({ sourceRevision: result.source.capability_revision, policyRevision: result.context.policy_revision, contextHandle: result.context.handle,
    resourceType: recordsOf(result)[0]?.resourceType as string ?? 'Observation', constraints: material, sort: frozen.filter(p => p.name === '_sort').flatMap(p => p.value.split(',')) }));
  if (result.coverage.constraints) equalPrivate(result.coverage.constraints.map(({ name, value }) => ({ name, value })), material, 'original ordered requested evidence retained');
  else assert.equal(result.coverage.constraints_on_first_page, true, 'continuation shorthand is explicit');
  assert.ok(result.coverage.state !== 'complete_for_query', 'generic source never gains complete proof');
  assert.equal(result.coverage.sort?.order, 'requested_unverified');
  assert.ok(((result.coverage.constraints ?? []).filter(c => c.execution !== "unknown").map(({ name, value }) => ({ name, value })) as QueryPair[]).every(pair => ['patient', 'subject', confinement].includes(pair.name) && pair.value === REF), 'execution restricted to independent confinement checks');
  assert.equal(result.source.alias, 'normalization-fixture');
  assert.equal(result.schema_version, '0.3');
  assert.equal(result.coverage.scope, 'page');
  assert.equal(result.coverage.authorization_limited, true);
  assert.ok(result.budget.bytes_returned <= result.budget.byte_limit, 'wire budget retained');
}

for (const [id, alias] of [['S1-N01', 'patient'], ['S1-N02', 'subject']] as const) {
  test(`${id} actual outbound duplicates survive source self-link collapse for the confinement alias`, async t => {
    const f = await fixture(t, { alias, injectForeign: true });
    const gateway = f.gateway();
    const caller = observationParams(alias);
    const frozen = [...caller.filter(pair => pair.name !== '_sort'), { name: alias, value: REF }, ...caller.filter(pair => pair.name === '_sort'), { name: '_count', value: '20' }];
    const result = await gateway.execute('fhir_search', { resource_type: 'Observation', params: caller, output: OUTPUT });
    assertLabels(result, frozen, alias);
    assert.equal(f.metadataCalls(), 1);
    assert.equal(f.requests.length, 1);
    equalPrivate(f.requests[0]!.pairs, frozen, 'actual wire order and multiplicity include trusted append');
    assert.equal(f.requests[0]!.pairs.filter(pair => pair.name === alias).length, 2);
    assert.equal(f.requests[0]!.self!.filter(pair => pair.name === alias).length, 1);
    assert.equal(f.requests[0]!.self!.filter(pair => pair.name === 'code').length, 1);
    assert.ok(f.requests[0]!.strict, 'strict search header unchanged');
    equalPrivate(idsOf(result), OBSERVATIONS.slice(0, 7).map(resource => resource.id), 'independently authorized exact record sequence');
    assert.ok(recordsOf(result).every(resource => (resource.subject as { reference: string }).reference === REF), 'foreign injected record suppressed');
    assert.equal(result.coverage.query_evidence, 'declared_and_self_link_only');
    assert.equal(f.unexpectedCalls(), 0);
  });
}

test('S1-N03 actual outbound Patient id duplicates survive collapse and independent authorization', async t => {
  const f = await fixture(t, { injectForeign: true });
  const gateway = f.gateway();
  const caller = [{ name: '_id', value: BOUND }];
  const frozen = [...caller, ...caller, { name: '_count', value: '20' }];
  const result = await gateway.execute('fhir_search', { resource_type: 'Patient', params: caller, output: OUTPUT });
  success(result);
  equalPrivate(f.requests[0]!.pairs, frozen, 'actual Patient outbound retains caller and trusted occurrences');
  assert.equal(f.requests[0]!.self!.filter(pair => pair.name === '_id').length, 1);
  equalPrivate(result.coverage.constraints?.map(({ name, value }) => ({ name, value })), frozen.filter(p => !['_sort', '_count'].includes(p.name)), 'Patient evidence retains original multiplicity');
  equalPrivate(idsOf(result), [BOUND], 'only the independently authorized Patient is delivered');
  assert.equal(result.coverage.state, 'complete_for_query');
  assert.equal(result.coverage.query_evidence, 'exact_id_and_subject_linkage');
});

const SELF_CASES: [string, FixtureOptions][] = [
  ['S1-N04 missing distinct repeated date', { selfChange: url => { url.searchParams.delete('date'); url.searchParams.append('date', WINDOW[0]!.value); } }],
  ['S1-N05 extra distinct repeated date', { selfChange: url => { url.searchParams.append('date', 'ge2021-01-01'); } }],
  ['S1-N06 changed exact token spelling', { selfChange: url => { url.searchParams.set('code', 'http://loinc.org|4548-04'); } }],
  ['S1-N07 changed exact token case', { selfChange: url => { url.searchParams.set('code', 'http://LOINC.org|4548-4'); } }],
  ['S1-N08 missing confinement', { selfChange: url => { url.searchParams.delete('patient'); } }],
  ['S1-N09 absent self evidence', { omitSelf: true }],
  ['S1-N10 extra material name', { selfChange: url => { url.searchParams.append('status', 'final'); } }],
  ['S1-N11 duplicated count control', { selfChange: url => { url.searchParams.append('_count', '20'); } }],
];
for (const [id, options] of SELF_CASES) {
  test(`${id} refuses source self evidence before any disclosure`, async t => {
    const f = await fixture(t, options);
    const gateway = f.gateway();
    const result = await gateway.execute('fhir_search', { resource_type: 'Observation', params: observationParams(), output: OUTPUT });
    assert.equal(result.error?.code, 'UNVERIFIED_QUERY');
    equalPrivate(result.data, {}, 'refused self evidence discloses no records');
    assert.equal(result.result, undefined);
    assert.equal(result.pagination, undefined);
    assert.equal(f.requests.length, 1);
    assert.equal(f.unexpectedCalls(), 0);
  });
}

test('S1-N13 missing Patient confinement refuses despite a collapsed source echo', async t => {
  const f = await fixture(t, { selfChange: url => { url.searchParams.delete('_id'); } });
  const result = await f.gateway().execute('fhir_search', { resource_type: 'Patient', params: [{ name: '_id', value: BOUND }], output: OUTPUT });
  assert.equal(result.error?.code, 'UNVERIFIED_QUERY');
  equalPrivate(result.data, {}, 'missing Patient confinement discloses nothing');
});

test('S1-N14 normalized ordinary continuation drains upstream pages and retained remainders without loss or replay work', async t => {
  const f = await fixture(t, { pageWidth: 3 });
  const gateway = f.gateway();
  const caller = observationParams();
  const frozen = structuredClone([...caller.filter(pair => pair.name !== '_sort'), { name: 'patient', value: REF }, ...caller.filter(pair => pair.name === '_sort'), { name: '_count', value: '1' }]);
  let result = await gateway.execute('fhir_search', { resource_type: 'Observation', params: caller, page_size: 1, output: { format: 'fhir', max_bytes: 10000 } });
  success(result);
  assert.ok(recordsOf(result).length > 0 && recordsOf(result).length < 3, 'small output forces a retained first-page remainder');
  caller[0]!.value = `Patient/${FOREIGN}`;
  caller.reverse();
  caller.push({ name: 'code', value: 'changed-after-admission' });
  const initialIds = idsOf(result);
  const firstCursor = result.pagination!.next_cursor!;
  assert.ok(firstCursor, 'retained remainder has a protected cursor');
  const retained = await gateway.execute('fhir_result', { handle: result.result!.handle, action: 'project', output: OUTPUT });
  success(retained);
  equalPrivate(idsOf(retained), initialIds, 'retained result covers exactly the delivered range');
  assert.equal(retained.coverage.scope, 'retained');
  const initialExpiry = result.result!.expires_at;
  const delivered = [...initialIds];
  const remainder = await gateway.execute('fhir_page', { cursor: firstCursor, output: OUTPUT });
  assertLabels(remainder, frozen, 'patient');
  assert.equal(f.requests.length, 1, 'local remainder makes no upstream fetch');
  const localReplay = await gateway.execute('fhir_page', { cursor: firstCursor, output: OUTPUT });
  assertLabels(localReplay, frozen, 'patient');
  equalPrivate(idsOf(localReplay), idsOf(remainder), 'local remainder cursor replay is stable');
  assert.equal(f.requests.length, 1, 'local replay makes no upstream fetch');
  delivered.push(...idsOf(remainder));
  result = remainder;
  let deliveries = 2;
  while (result.pagination?.next_cursor) {
    assert.ok(deliveries++ < 12, 'bounded continuation chain terminates');
    const cursor = result.pagination.next_cursor;
    const before = f.requests.length;
    result = await gateway.execute('fhir_page', { cursor, output: OUTPUT });
    assertLabels(result, frozen, 'patient');
    assert.equal(result.result?.expires_at, initialExpiry, 'absolute retention expiry is inherited');
    delivered.push(...idsOf(result));
    if (f.requests.length > before) {
      const after: number = f.requests.length;
      const replay = await gateway.execute('fhir_page', { cursor, output: OUTPUT });
      assertLabels(replay, frozen, 'patient');
      equalPrivate(idsOf(replay), idsOf(result), 'loaded upstream cursor replay is stable');
      assert.equal(f.requests.length, after, 'loaded upstream replay never refetches');
    }
  }
  equalPrivate(delivered, OBSERVATIONS.slice(0, 7).map(resource => resource.id), 'full privately checked ordered delivery, without gaps or duplicates');
  assert.equal(f.requests.length, 3, 'three independently observed upstream pages');
  assert.equal(result.pagination?.has_more, null);
  assert.equal(result.coverage.state, 'partial', 'unverified continuation retains unknown exhaustion and never promotes execution proof');
  equalPrivate(f.requests[0]!.pairs, frozen, 'initial wire retains the full original sequence');
  for (const request of f.requests.slice(1)) {
    assert.equal(request.pairs.filter(pair => pair.name === 'patient').length, 1, 'source-collapsed continuation is actually fetched');
    assert.equal(request.pairs.filter(pair => pair.name === 'code').length, 1);
    equalPrivate(request.pairs.filter(pair => pair.name === 'date'), WINDOW, 'both distinct date predicates survive every upstream page');
    assert.ok(request.strict, 'strict header persists on continuation');
  }
  assert.equal(f.unexpectedCalls(), 0);
});

const NEXT_CASES: [string, (url: URL) => void][] = [
  ['S1-N15 distinct date dropped', url => { url.searchParams.delete('date'); url.searchParams.append('date', WINDOW[0]!.value); }],
  ['S1-N16 distinct date added', url => { url.searchParams.append('date', 'ge2021-01-01'); }],
  ['S1-N17 confinement dropped', url => { url.searchParams.delete('patient'); }],
  ['S1-N18 material name added', url => { url.searchParams.set('_filter', 'synthetic'); }],
  ['S1-N19 exact case changed', url => { url.searchParams.set('code', CODE.toUpperCase()); }],
  ['S1-N20 sort changed', url => { url.searchParams.set('_sort', '-date'); }],
  ['S1-N21 sort duplicated', url => { url.searchParams.append('_sort', 'date'); }],
  ['S1-N22 sort dropped', url => { url.searchParams.delete('_sort'); }],
  ['S1-N23 resource path changed', url => { url.pathname = '/fhir/Patient'; }],
  ['S1-N24 base path escaped', url => { url.pathname = '/outside'; }],
  ['S1-N25 origin changed', url => { url.port = url.port === '1' ? '2' : '1'; }],
];
for (const [id, nextChange] of NEXT_CASES) {
  test(`${id} keeps a safe prefix without fetching a changed continuation`, async t => {
    const f = await fixture(t, { pageWidth: 1, nextChange });
    const gateway = f.gateway();
    const result = await gateway.execute('fhir_search', { resource_type: 'Observation', params: observationParams(), page_size: 1, output: OUTPUT });
    success(result);
    equalPrivate(idsOf(result), [OBSERVATIONS[0]!.id], 'independently authorized safe prefix is preserved');
    assert.equal(result.pagination?.has_more, null);
    assert.equal(result.pagination.next_cursor, undefined);
    assert.ok(result.coverage.reasons.includes('NON_CONTINUABLE_UPSTREAM_LINK'));
    assert.equal(f.requests.length, 1, 'unsafe/broadened continuation makes zero additional clinical fetches');
    assert.equal(f.unexpectedCalls(), 0);
  });
}

test('S1-N26 a later normalized page cannot drop a distinct date from the frozen original query', async t => {
  let nextLinks = 0;
  const f = await fixture(t, { pageWidth: 1, nextChange: url => {
    if (++nextLinks === 2) { url.searchParams.delete('date'); url.searchParams.append('date', WINDOW[0]!.value); }
  } });
  const gateway = f.gateway();
  const caller = observationParams();
  const frozen = [...caller.filter(pair => pair.name !== '_sort'), { name: 'patient', value: REF }, ...caller.filter(pair => pair.name === '_sort'), { name: '_count', value: '1' }];
  const first = await gateway.execute('fhir_search', { resource_type: 'Observation', params: caller, page_size: 1, output: OUTPUT });
  assertLabels(first, frozen, 'patient');
  const second = await gateway.execute('fhir_page', { cursor: first.pagination!.next_cursor!, output: OUTPUT });
  assertLabels(second, frozen, 'patient');
  equalPrivate(idsOf(second), [OBSERVATIONS[1]!.id], 'second safe page retained');
  assert.equal(second.pagination?.has_more, null);
  assert.equal(second.pagination.next_cursor, undefined);
  assert.ok(second.coverage.reasons.includes('NON_CONTINUABLE_UPSTREAM_LINK'));
  assert.equal(f.requests.length, 2, 'third broadened page is never fetched');
});

test('S1-N27 ordinary positive and reviewed HAPI root opaque continuation keep existing unknown labels', async t => {
  for (const opaque of [false, true]) {
    const f = await fixture(t, { collapse: false, pageWidth: 1, opaque });
    const gateway = f.gateway();
    const caller = [{ name: 'code', value: CODE }, ...WINDOW, { name: '_sort', value: 'date' }];
    const frozen = [...caller.filter(pair => pair.name !== '_sort'), { name: 'patient', value: REF }, ...caller.filter(pair => pair.name === '_sort'), { name: '_count', value: '1' }];
    let result = await gateway.execute('fhir_search', { resource_type: 'Observation', params: caller, page_size: 1, output: OUTPUT });
    const delivered: unknown[] = [];
    do {
      assertLabels(result, frozen, 'patient');
      delivered.push(...idsOf(result));
      if (!result.pagination?.next_cursor) break;
      assert.ok(delivered.length < 12, 'bounded ordinary/opaque chain terminates');
      result = await gateway.execute('fhir_page', { cursor: result.pagination.next_cursor, output: OUTPUT });
      assert.equal(result.coverage.query_evidence, 'unverified_continuation');
      assert.ok(result.warnings.some(warning => warning.code === 'CONTINUATION_QUERY_UNVERIFIED'));
    } while (true);
    equalPrivate(delivered, OBSERVATIONS.slice(0, 7).map(resource => resource.id), 'ordinary/opaque exact authorized sequence unchanged');
    assert.equal(f.requests.length, 7);
    assert.equal(f.requests.filter(request => request.opaque).length, opaque ? 6 : 0);
    assert.equal(f.unexpectedCalls(), 0);
  }
});

test('S1-N28 foreign conditional overflow and OR selectors still refuse before clinical fetch', async t => {
  const f = await fixture(t);
  const gateway = f.gateway();
  const caps = await gateway.execute('fhir_capabilities', { topic: 'server' });
  success(caps);
  const metadataBefore = f.metadataCalls();
  const overflow = [`Patient/${FOREIGN}`, ...Array.from({ length: 33 }, () => REF)].join(',');
  const cases: [string, QueryPair][] = [
    ['foreign selector', { name: 'patient', value: `Patient/${FOREIGN}` }],
    ['conditional selector', { name: 'subject', value: 'Patient?identifier=synthetic' }],
    ['foreign-host selector', { name: 'subject', value: `http://example.invalid/fhir/${REF}` }],
    ['OR selector', { name: 'subject', value: `${REF},Patient/${FOREIGN}` }],
    ['encoded OR selector', { name: 'patient', value: `${REF}%2CPatient%2F${FOREIGN}` }],
    ...['patient', 'subject', 'code', 'date'].map(name => ['overflow selector', { name, value: overflow }] as [string, QueryPair]),
  ];
  for (const [label, pair] of cases) {
    const before = f.requests.length;
    const result = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [pair], output: OUTPUT });
    assert.equal(result.error?.code, label === 'overflow selector' ? 'INVALID_ARGUMENTS' : 'POLICY_DENIED', label);
    assert.equal(f.requests.length, before, 'pre-send veto makes zero clinical fetches');
    assert.equal(f.metadataCalls(), metadataBefore, 'cached metadata independently counted');
    equalPrivate(result.data, {}, 'refused selector discloses nothing');
  }
  const positive = await gateway.execute('fhir_search', { resource_type: 'Observation', params: observationParams(), output: OUTPUT });
  success(positive);
  assert.equal(f.requests.length, 1, 'neighboring authorized control really fetches');
  equalPrivate(idsOf(positive), OBSERVATIONS.slice(0, 7).map(resource => resource.id), 'authorized control succeeds');
  const audit = JSON.stringify(gateway.auditEvents);
  assert.ok(![BOUND, FOREIGN, REF, CODE, 'http:', 'identifier='].some(canary => audit.includes(canary)), 'ordinary audit carries no ids queries URLs or bodies');
});

test('S1-N29 Q matcher normalizes exact duplicates without changing occurrences digest eligibility or execution', () => {
  const requested = [...observationParams().filter(pair => pair.name !== '_sort'), { name: 'patient', value: REF }];
  const original = structuredClone(requested);
  const self = pairsOf(collapsePredicates(new URL(`http://127.0.0.1/fhir/Observation?${new URLSearchParams([...requested.map(pair => [pair.name, pair.value] as [string, string]), ['_sort', 'date'], ['_count', '20']])}`)));
  const eligible = [...eligibleSearchProfileIds()];
  const match = matchSelfLink(requested, self, ['date']);
  assert.equal(match.materialMismatch, false);
  equalPrivate(match.flags, requested.map(() => 'matched'), 'one matched flag for every original occurrence');
  assert.equal(match.sortReported, 'matched');
  const identity = { sourceRevision: 'revision', policyRevision: 'policy', contextHandle: 'context', resourceType: 'Observation' };
  const evidence = buildQueryEvidence({ ...identity, pairs: requested, selfPairs: self, sortRequested: ['date'], profile: searchProfile('generic-r4'), gatewayEnforcedIndices: new Set([requested.length - 1]) });
  equalPrivate(evidence.constraints.map(({ name, value }) => ({ name, value })), original, 'Q evidence preserves the complete requested sequence');
  equalPrivate(requested, original, 'matcher never mutates original evidence');
  assert.equal(evidence.query_digest, queryDigest({ ...identity, constraints: original, sort: ['date'] }));
  assert.ok(evidence.query_digest !== queryDigest({ ...identity, constraints: self.filter(pair => !pair.name.startsWith('_')), sort: ['date'] }), 'digest does not silently normalize requested multiplicity');
  assert.equal(evidence.materialFilterProved, false);
  assert.equal(evidence.evidenceKind, 'declared_and_self_link_only');
  assert.equal(evidence.sort?.order, 'requested_unverified');
  assert.equal(evidence.sort?.effective, null);
  assert.ok(evidence.constraints.slice(0, -1).every(constraint => constraint.execution === 'unknown' && constraint.evidence_ref === undefined), 'echoes never become adapter or gateway execution proof');
  equalPrivate(eligibleSearchProfileIds(), eligible, 'profile eligibility unchanged');
  assert.ok(searchProfile('synthetic-fixture-r4-v1'), 'the qualified closed fixture profile resolves through the registry (S6); this generic chain never selected it');
});

test('S1-N30 Q matcher rejects distinct values names aliases case lexemes escapes and double decoding', () => {
  const cases: [QueryPair[], QueryPair[]][] = [
    [WINDOW, WINDOW.slice(0, 1)],
    [WINDOW, [...WINDOW, { name: 'date', value: 'ge2021-01-01' }]],
    [[{ name: 'patient', value: REF }], [{ name: 'subject', value: REF }]],
    [[{ name: 'code', value: CODE }], [{ name: 'Code', value: CODE }]],
    [[{ name: 'code', value: CODE }], [{ name: 'code', value: CODE.toUpperCase() }]],
    [[{ name: 'value-quantity', value: '7.0' }], [{ name: 'value-quantity', value: '7' }]],
    [[{ name: 'code', value: 'system|literal\\,comma' }], [{ name: 'code', value: 'system|literal,comma' }]],
    [[{ name: 'code', value: 'system|literal\\|pipe' }], [{ name: 'code', value: 'system|literal|pipe' }]],
    [[{ name: 'code', value: 'system|literal\\\\slash' }], [{ name: 'code', value: 'system|literal\\slash' }]],
    [[{ name: 'code', value: 'system|literal%2Ccomma' }], [{ name: 'code', value: 'system|literal,comma' }]],
    [[{ name: 'code', value: 'system|literal+plus' }], [{ name: 'code', value: 'system|literal plus' }]],
    [[{ name: 'patient', value: REF }], []],
  ];
  for (const [requested, reported] of cases) assert.equal(matchSelfLink(requested, reported).materialMismatch, true, 'distinct decoded predicate mismatch remains material');
  const escaped = 'system|literal\\,comma%2C\\|pipe\\\\slash+plus';
  const once = new URLSearchParams(new URLSearchParams([['code', escaped]]).toString()).get('code')!;
  assert.ok(once === escaped, 'query syntax decoded exactly once');
  assert.equal(matchSelfLink([{ name: 'code', value: escaped }, { name: 'code', value: escaped }], [{ name: 'code', value: once }]).materialMismatch, false);
});

test('S1-N31 Q sort and missing-self semantics stay separate from predicate matching', () => {
  const requested = [{ name: 'code', value: CODE }, { name: 'code', value: CODE }];
  for (const [sort, expected] of [[[], 'dropped'], [[{ name: '_sort', value: '-date' }], 'different'], [[{ name: '_sort', value: 'date' }, { name: '_sort', value: 'date' }], 'different']] as const) {
    const result = matchSelfLink(requested, [{ name: 'code', value: CODE }, ...sort, { name: '_count', value: '1' }, { name: '_cursor', value: 'opaque%2Ctoken' }], ['date']);
    assert.equal(result.materialMismatch, false, 'sort mismatches downgrade order without refusing material membership');
    assert.equal(result.sortReported, expected);
  }
  equalPrivate(matchSelfLink(requested, null).flags, ['not_reported', 'not_reported'], 'missing self remains explicitly unreported');
  equalPrivate(matchSelfLink(requested, undefined).flags, ['not_checked', 'not_checked'], 'unavailable evidence never becomes matched');
  const distinct = matchSelfLink([{ name: 'code', value: CODE }, { name: 'code', value: 'other' }], [{ name: 'code', value: CODE }]);
  equalPrivate(distinct.flags, ['matched', 'not_reported'], 'one existing value cannot satisfy a different value');
  assert.equal(distinct.materialMismatch, true);
});

test('S1-N32 exact controls and opaque tokens never acquire predicate idempotence', () => {
  for (const name of ['_sort', '_count', '_cursor', '_getpages', '_filter', '_query', '_summary', '_elements']) {
    const pair = { name, value: 'opaque%2Cvalue' };
    assert.equal(queryEvidencePairsMatch([pair, pair], [pair]), false, 'control multiplicity remains exact');
    assert.equal(queryEvidencePairsMatch([pair], [{ name, value: 'opaque,value' }]), false, 'opaque/control value remains exact');
    assert.equal(queryEvidencePairsMatch([pair], [pair, pair]), false, 'control duplicate expansion remains refused');
  }
  for (const name of ['_id', '_lastUpdated', 'patient', 'subject', 'code', 'date']) {
    const pair = { name, value: 'exact' };
    assert.equal(queryEvidencePairsMatch([pair, pair], [pair]), true, 'implemented exact predicate duplicates may collapse');
    assert.equal(queryEvidencePairsMatch([pair], [pair, pair]), true, 'distinct-pair equality preserves idempotence');
  }
});

test('S1-N33 identical reported repetition is idempotent across a full ordinary query chain', async t => {
  const repeatLowerBound = (url: URL) => { url.searchParams.append('date', WINDOW[0]!.value); };
  const f = await fixture(t, { pageWidth: 1, selfChange: repeatLowerBound, nextChange: repeatLowerBound });
  const gateway = f.gateway();
  const caller = observationParams();
  const frozen = [...caller.filter(pair => pair.name !== '_sort'), { name: 'patient', value: REF }, ...caller.filter(pair => pair.name === '_sort'), { name: '_count', value: '1' }];
  let result = await gateway.execute('fhir_search', { resource_type: 'Observation', params: caller, page_size: 1, output: OUTPUT });
  const delivered: unknown[] = [];
  while (true) {
    assertLabels(result, frozen, 'patient');
    delivered.push(...idsOf(result));
    if (!result.pagination?.next_cursor) break;
    assert.ok(delivered.length < 12, 'identical repetition cannot create a nonterminating chain');
    result = await gateway.execute('fhir_page', { cursor: result.pagination.next_cursor, output: OUTPUT });
  }
  equalPrivate(delivered, OBSERVATIONS.slice(0, 7).map(resource => resource.id), 'distinct-predicate equality preserves the complete authorized sequence');
  assert.equal(f.requests.length, 7);
  assert.equal(f.requests[0]!.pairs.filter(pair => pair.name === 'date').length, 2, 'initial caller multiplicity remains unchanged');
  assert.equal(f.requests[0]!.self!.filter(pair => pair.name === 'date').length, 3, 'the same predicate may be echoed repeatedly without a new distinct value');
  assert.equal(f.requests[1]!.pairs.filter(pair => pair.name === 'date').length, 3, 'ordinary continuation equivalence uses the same exact predicate rule');
});
