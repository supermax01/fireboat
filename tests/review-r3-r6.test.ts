import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import { FhirGateway } from '../packages/core/src/index.js';
import { declaredSearchProfile, type SearchProfile } from '../packages/core/src/query.js';
import { ClientCredentialsProvider } from '../packages/auth/src/client-credentials.js';
import { withSdk, type Rec } from './s57-sdk-helpers.js';

// Verified runtime findings R3-R6 (synthetic only). R3: a denied entry's fullUrl cannot change public diagnostics.
// R4: malformed Bundle entry/link structures refuse instead of reading as an empty complete page. R5: oversized
// searchParam declarations fail closed. R6: every acquired credential has its own generation.

const a = 'synthetic-r3r6-a';
const foreign = 'synthetic-r3r6-b';
const CANARY_B = 'SYNTHETIC-R3-DENIED-CANARY';
const TTL = 60_000;
const SOFTWARE = { name: 'r3r6 synthetic fixture', version: '1' };
const loinc = { coding: [{ system: 'http://loinc.org', code: '4548-4' }] };
const obs = (id: string, subject = a, extra: Rec = {}) => ({ resourceType: 'Observation', id, status: 'final', code: loinc, subject: { reference: `Patient/${subject}` }, effectiveDateTime: '2025-01-02T00:00:00Z', ...extra });
const declarations = (extra: Rec[] = []) => [{ name: 'patient', type: 'reference' }, { name: 'subject', type: 'reference' }, { name: 'code', type: 'token' }, ...extra];
const metadataWith = (searchParam: unknown[]) => ({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', software: SOFTWARE,
  rest: [{ mode: 'server', resource: [{ type: 'Observation', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam }] }] });
const candidate: SearchProfile = { ...declaredSearchProfile('synthetic-fixture-r4-v1')!, id: 'private-r3r6-candidate', eligible: false,
  source: { software: SOFTWARE.name, software_version: SOFTWARE.version, fhir_version: '4.0.1' }, evidence: null };
const output = { format: 'fhir' as const, max_bytes: 24576 };
const json = (value: unknown) => JSON.stringify(value);

interface SourceOptions { metadata?: () => unknown; page: (url: URL, base: string, index: number) => unknown; profile?: boolean; clock?: boolean }
/** Loopback synthetic source; `page` builds each search response. With `clock`, Date.now is mocked (once per test) so the metadata TTL can be crossed. */
async function source(t: TestContext, options: SourceOptions) {
  let now = Date.now();
  if (options.clock) t.mock.method(Date, 'now', () => now);
  let base = '';
  const counts = { metadata: 0, clinical: 0 };
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/fhir+json');
    const url = new URL(req.url!, base);
    if (url.pathname.endsWith('/metadata')) { counts.metadata++; res.end(json(options.metadata?.() ?? metadataWith(declarations()))); return; }
    counts.clinical++;
    res.end(json(options.page(url, base, Number(url.searchParams.get('_offset') ?? '0'))));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/fhir/`;
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'r3r6-fixture', baseUrl: base }, patientId: a, discovery: { metadataTtlMs: TTL } },
    options.profile ? { testQueryProfile: candidate } as never : undefined);
  t.after(async () => { gateway.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { gateway, counts, advance: (ms: number) => { assert.ok(options.clock, 'advance needs a mocked clock'); now += ms; } };
}
const DEFAULT_LINKS = Symbol('default links');
const searchset = (url: URL, entry: unknown, next = false, link: unknown = DEFAULT_LINKS) => {
  const following = new URL(url); following.searchParams.set('_offset', String(Number(url.searchParams.get('_offset') ?? '0') + 1));
  return { resourceType: 'Bundle', type: 'searchset', link: link === DEFAULT_LINKS ? [{ relation: 'self', url: url.href }, ...(next ? [{ relation: 'next', url: following.href }] : [])] : link, ...(entry === undefined ? {} : { entry }) };
};
const match = (resource: unknown, fullUrl?: unknown) => ({ ...(fullUrl === undefined ? {} : { fullUrl }), resource, search: { mode: 'match' } });
/** The public, request-independent part of an envelope. */
const publicShape = (e: Rec) => ({ error: e.error, ids: (e.data?.resources as Rec[] | undefined)?.map(r => r.id), coverage: e.coverage, warnings: e.warnings,
  pagination: e.pagination && { ...e.pagination, next_cursor: Boolean(e.pagination.next_cursor) }, withheld: e.transform?.withheld_payloads, retained: Boolean(e.result) });

// ---------------------------------------------------------------- R3 -------

// kills: r3-origin-label-before-authorization
test('R3: a denied foreign entry yields the same public search, page and retained response whatever its fullUrl', async t => {
  const denied = obs('synthetic-r3-denied', foreign, { valueString: CANARY_B });
  const variants = { absent: () => [], local: (base: string) => [match(denied, `${base}Observation/${denied.id}`)], foreign: () => [match(denied, `https://other.example/fhir/Observation/${denied.id}`)] };
  for (const era of ['modern', 'legacy'] as const) {
    const shapes: Record<string, unknown> = {};
    // One source per era, so the source identity (and thus every query digest) is shared by all three twins.
    let extra: (base: string) => unknown[] = variants.absent;
    // Confinement-only query over two pages, and a filtered query whose only entry is the denied one.
    const paged = await source(t, { page: (url, base, index) => url.searchParams.has('code')
      ? searchset(url, extra(base))
      : searchset(url, [match(obs(`synthetic-r3-a${index}`), `${base}Observation/synthetic-r3-a${index}`), ...extra(base)], index === 0) });
    await withSdk(paged.gateway, era, async sdk => {
      for (const [name, variant] of Object.entries(variants)) {
        extra = variant;
        const search = await sdk.call('fhir_search', { resource_type: 'Observation', page_size: 20, output });
        const page = await sdk.call('fhir_page', { cursor: search.e.pagination.next_cursor, output });
        const retained = await sdk.call('fhir_result', { handle: search.e.result.handle, action: 'project', output });
        const filtered = await sdk.call('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }], output });
        for (const r of [search, page, retained, filtered]) assert.ok(!r.raw.includes(CANARY_B) && !r.raw.includes(foreign), `${era} ${name}: no denied content`);
        shapes[name] = [search, page, retained, filtered].map(r => publicShape(r.e));
      }
    });
    assert.deepEqual(shapes.local, shapes.absent, `${era}: a local-origin denied entry is invisible`);
    assert.deepEqual(shapes.foreign, shapes.absent, `${era}: a foreign-origin denied entry is invisible too`);
  }
});

test('R3 control: an A-subject entry with a foreign fullUrl is still labelled and partial', async t => {
  const f = await source(t, { page: (url, base) => searchset(url, [match(obs('synthetic-r3-local'), `${base}Observation/synthetic-r3-local`), match(obs('synthetic-r3-twin'), 'https://other.example/fhir/Observation/synthetic-r3-twin')]) });
  await withSdk(f.gateway, 'modern', async sdk => {
    const search = await sdk.call('fhir_search', { resource_type: 'Observation', output });
    assert.deepEqual((search.e.data.resources as Rec[]).map(r => r.id), ['synthetic-r3-local']);
    assert.ok(search.e.coverage.reasons.includes('ENTRY_ORIGIN_MISMATCH'));
    assert.equal(search.e.coverage.state, 'partial');
  });
});

// ---------------------------------------------------------------- R4 -------

const malformedEntries: [string, unknown][] = [['object', { resource: obs('synthetic-r4-x') }], ['string', 'x'], ['null', null], ['number', 7],
  ['array with a primitive', ['x']], ['array with null', [null]], ['array with a nested array', [[match(obs('synthetic-r4-x'))]]],
  ['resource string', [{ resource: 'x', search: { mode: 'match' } }]], ['resource null', [{ resource: null, search: { mode: 'match' } }]],
  ['resource without resourceType', [{ resource: { id: 'x' }, search: { mode: 'match' } }]], ['resource array', [{ resource: [obs('synthetic-r4-x')], search: { mode: 'match' } }]]];

// kills: r4-malformed-entries-empty-page
test('R4: malformed Bundle entry structures refuse with INVALID_RESPONSE instead of an empty complete result', async t => {
  for (const [label, entry] of malformedEntries) {
    await t.test(label, async st => {
      const f = await source(st, { page: url => searchset(url, entry) });
      await withSdk(f.gateway, 'modern', async sdk => {
        for (const params of [[], [{ name: 'code', value: 'http://loinc.org|4548-4' }]]) {
          const search = await sdk.call('fhir_search', { resource_type: 'Observation', params, output });
          assert.equal(search.e.error?.code, 'INVALID_RESPONSE', `${label} ${json(params)}: ${json(search.e.error)}`);
          assert.equal(search.e.result, undefined, 'no res_ handle');
          assert.deepEqual(search.e.data.resources ?? [], []);
          assert.equal(search.e.pagination?.total, undefined);
          assert.ok(!search.e.warnings.some((w: Rec) => w.code === 'NO_MATCHES'), label);
          assert.notEqual(search.e.coverage.state, 'complete_for_query');
        }
      });
    });
  }
});

test('R4: malformed link lists refuse, and a malformed continuation page is an error, not exhaustion', async t => {
  for (const [label, link] of [['object', { relation: 'self', url: 'x' }], ['string', 'x'], ['null', null], ['array with null', [null]]] as [string, unknown][]) {
    await t.test(`first page link ${label}`, async st => {
      const f = await source(st, { page: url => searchset(url, [match(obs('synthetic-r4-a'))], false, link) });
      await withSdk(f.gateway, 'modern', async sdk => {
        const search = await sdk.call('fhir_search', { resource_type: 'Observation', output });
        assert.equal(search.e.error?.code, 'INVALID_RESPONSE', `${label}: ${json(search.e.error)}`);
        assert.ok(!json(search.e).includes('synthetic-r4-a'));
      });
    });
  }
  for (const [label, page2] of [['entry object', (url: URL) => searchset(url, { resource: obs('synthetic-r4-b') })], ['entry null', (url: URL) => searchset(url, null)],
    ['link object', (url: URL) => searchset(url, [match(obs('synthetic-r4-b'))], false, { relation: 'self', url: url.href })]] as [string, (url: URL) => unknown][]) {
    await t.test(`continuation ${label}`, async st => {
      const f = await source(st, { profile: true, page: (url, _base, index) => index === 0 ? searchset(url, [match(obs('synthetic-r4-a'))], true) : page2(url) });
      await withSdk(f.gateway, 'modern', async sdk => {
        const search = await sdk.call('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }], output });
        assert.equal(search.e.error, undefined);
        const page = await sdk.call('fhir_page', { cursor: search.e.pagination.next_cursor, output });
        assert.equal(page.e.error?.code, 'INVALID_RESPONSE', `${label}: ${json(page.e.error)}`);
        assert.ok(!json(page.e).includes('synthetic-r4-b'));
      });
    });
  }
});

test('R4: a resourceless entry is labelled partial even without a fullUrl, never silently dropped', async t => {
  const f = await source(t, { page: url => searchset(url, [match(obs('synthetic-r4-kept')), { search: { mode: 'match' } }]) });
  await withSdk(f.gateway, 'modern', async sdk => {
    const search = await sdk.call('fhir_search', { resource_type: 'Observation', output });
    assert.equal(search.e.error, undefined);
    assert.deepEqual((search.e.data.resources as Rec[]).map(r => r.id), ['synthetic-r4-kept']);
    assert.ok(search.e.coverage.reasons.includes('ENTRY_ORIGIN_MISMATCH'), json(search.e.coverage));
    assert.equal(search.e.coverage.state, 'partial');
  });
});

test('R4 control: an absent or empty entry list is still the normal empty result; a valid list is unchanged', async t => {
  for (const [label, entry] of [['absent', undefined], ['empty', []]] as [string, unknown][]) {
    await t.test(label, async st => {
      const f = await source(st, { page: url => searchset(url, entry) });
      await withSdk(f.gateway, 'modern', async sdk => {
        const search = await sdk.call('fhir_search', { resource_type: 'Observation', output });
        assert.equal(search.e.error, undefined, label);
        assert.deepEqual(search.e.data.resources, []);
        assert.equal(search.e.coverage.state, 'complete_for_query', `${label}: confinement-only empty result is complete`);
      });
    });
  }
  const f = await source(t, { page: url => searchset(url, [match(obs('synthetic-r4-valid'))]) });
  await withSdk(f.gateway, 'modern', async sdk => {
    const search = await sdk.call('fhir_search', { resource_type: 'Observation', output });
    assert.deepEqual((search.e.data.resources as Rec[]).map(r => r.id), ['synthetic-r4-valid']);
  });
});

// ---------------------------------------------------------------- R5 -------

const fillers = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `synthetic-filler-${i}`, type: 'token' }));

// kills: r5-declaration-prefix-trusted
test('R5: more than 1024 searchParam declarations make the type ambiguous instead of trusting the prefix', async t => {
  const conflict = { name: 'patient', type: 'string' };
  await t.test('1025 declarations, conflicting patient at index 1024: refused with zero clinical calls', async st => {
    const params = [...declarations(), ...fillers(1021), conflict];
    assert.equal(params.length, 1025);
    const f = await source(st, { metadata: () => metadataWith(params), page: url => searchset(url, [match(obs('synthetic-r5-a'))]) });
    const search = await f.gateway.execute('fhir_search', { resource_type: 'Observation', output });
    assert.equal(search.error?.code, 'INVALID_RESPONSE', json(search.error));
    assert.equal(f.counts.clinical, 0);
  });
  await t.test('control: the conflict at index 1023 is seen and refused', async st => {
    const params = [...declarations(), ...fillers(1020), conflict];
    assert.equal(params.length, 1024);
    const f = await source(st, { metadata: () => metadataWith(params), page: url => searchset(url, [match(obs('synthetic-r5-a'))]) });
    const search = await f.gateway.execute('fhir_search', { resource_type: 'Observation', output });
    assert.ok(search.error, 'a conflicting confinement declaration is never executable');
    assert.equal(f.counts.clinical, 0);
  });
  await t.test('control: exactly 1024 valid declarations stay executable', async st => {
    const f = await source(st, { metadata: () => metadataWith([...declarations(), ...fillers(1021)]), page: url => searchset(url, [match(obs('synthetic-r5-a'))]) });
    const search = await f.gateway.execute('fhir_search', { resource_type: 'Observation', output });
    assert.equal(search.error, undefined, json(search.error));
    assert.equal(f.counts.clinical, 1);
  });
  await t.test('a refresh from 1024 to 1025 declarations is material: revision changes and retained handles die', async st => {
    let params: unknown[] = [...declarations(), ...fillers(1021)];
    const f = await source(st, { clock: true, metadata: () => metadataWith(params), page: url => searchset(url, [match(obs('synthetic-r5-a'))]) });
    const first = await f.gateway.execute('fhir_search', { resource_type: 'Observation', output });
    assert.equal(first.error, undefined);
    params = [...params, { name: 'synthetic-filler-tail', type: 'token' }];
    f.advance(TTL + 1);
    const refreshed = await f.gateway.execute('fhir_capabilities', { topic: 'server' });
    assert.equal(refreshed.error, undefined);
    assert.equal(f.counts.metadata, 2, 'metadata actually refreshed');
    assert.notEqual(refreshed.source.capability_revision, first.source.capability_revision);
    assert.equal((await f.gateway.execute('fhir_result', { handle: first.result!.handle })).error?.code, 'RESULT_EXPIRED');
    assert.equal((await f.gateway.execute('fhir_search', { resource_type: 'Observation', output })).error?.code, 'INVALID_RESPONSE');
  });
});

// ---------------------------------------------------------------- R6 -------

const ENV_NAME = 'FHIR_MCP_TEST_R6_SECRET';
const SECRET = 'synthetic-r6-client-secret';

// kills: r6-renewal-shares-generation
test('R6: a token renewed after expiry has its own generation, so the old generation cannot invalidate it', async () => {
  let now = 1_000_000_000, calls = 0;
  const fetchFn = (async () => new Response(json({ access_token: `synthetic-r6-token-${++calls}`, token_type: 'Bearer', expires_in: 60 }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const provider = new ClientCredentialsProvider('http://127.0.0.1:9/fhir', { type: 'client_credentials', tokenUrl: 'http://127.0.0.1:9/oauth/token', clientId: 'synthetic-r6', clientSecretEnv: ENV_NAME },
    { env: { [ENV_NAME]: SECRET }, fetchFn, now: () => now });
  const target = new URL('http://127.0.0.1:9/fhir/Observation');
  const first = await provider.authorizationWithGeneration(target);
  now += 31_000; // past usableUntil: 60 s lifetime minus the 30 s skew
  const second = await provider.authorizationWithGeneration(target);
  assert.equal(second.authorization, 'Bearer synthetic-r6-token-2');
  assert.notEqual(second.generation, first.generation, 'the renewed token has its own identity');
  assert.equal(provider.invalidate(first.generation), false, 'a late rejection of the expired token is stale');
  assert.deepEqual(await provider.authorizationWithGeneration(target), second);
  assert.equal(calls, 2);
  assert.equal(provider.invalidate(second.generation), true, 'control: the current generation still invalidates');
  assert.equal(await provider.authorizationFor(target), 'Bearer synthetic-r6-token-3');
  provider.close();
});

test('R6 e2e: a delayed 401 for an expired token spares the renewed token, its retained result and discovery', async t => {
  let baseUrl = '', tokenCalls = 0, expiresIn = 2, rejection: number | undefined;
  const requests: string[] = [];
  const held: ServerResponse[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, baseUrl);
    if (url.pathname === '/oauth2/token') {
      tokenCalls++;
      res.setHeader('content-type', 'application/json');
      res.end(json({ access_token: `synthetic-r6-access-${tokenCalls}`, token_type: 'Bearer', expires_in: expiresIn })); return;
    }
    res.setHeader('content-type', 'application/fhir+json');
    requests.push(url.pathname);
    if (req.headers.authorization !== `Bearer synthetic-r6-access-${tokenCalls}`) { res.statusCode = 401; res.end('{}'); return; }
    if (url.pathname.endsWith('/held')) { held.push(res); return; }
    if (rejection) { res.statusCode = rejection; res.end('{}'); return; }
    if (url.pathname.endsWith('/metadata')) { res.end(json(metadataWith(declarations()))); return; }
    res.end(json(obs(url.pathname.split('/').at(-1)!)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/fhir/`;
  const previous = process.env[ENV_NAME];
  process.env[ENV_NAME] = SECRET;
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'r6-fixture', baseUrl, auth: { type: 'client_credentials', clientId: 'synthetic-r6', tokenUrl: new URL('/oauth2/token', baseUrl).href, clientSecretEnv: ENV_NAME } }, patientId: a });
  t.after(async () => { gateway.close(); if (previous === undefined) delete process.env[ENV_NAME]; else process.env[ENV_NAME] = previous; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const read = (id = 'synthetic-r6-own') => gateway.execute('fhir_read', { resource_type: 'Observation', id });
  const metadataCalls = () => requests.filter(path => path.endsWith('/metadata')).length;
  assert.equal((await read()).error, undefined);
  const late = read('held');
  for (let i = 0; i < 400 && !held.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(held.length, 1, 'the first-token request is held');
  // Token 1 lives 2 s with a 1 s skew: wait until it is no longer usable, then renew with a long-lived token.
  await new Promise(resolve => setTimeout(resolve, 1200));
  expiresIn = 3600;
  const fresh = await read();
  assert.equal(fresh.error, undefined);
  assert.equal(tokenCalls, 2, 'expiry renewal acquired token 2');
  held[0]!.statusCode = 401;
  held[0]!.setHeader('www-authenticate', 'Bearer error="invalid_token"');
  held[0]!.end('{}');
  const lateOld = await late;
  assert.equal(lateOld.error?.code, 'CONNECTION_REQUIRED');
  assert.equal(lateOld.error?.retryable, true, 'a late rejection of the superseded token is retryable');
  assert.equal((await gateway.execute('fhir_result', { handle: fresh.result!.handle })).error, undefined, 'the retained result made with token 2 survives');
  assert.equal((await read()).error, undefined);
  assert.equal(tokenCalls, 2, 'no third token');
  assert.equal(metadataCalls(), 1, 'discovery survived');
  // Control: a 401 on a token-2 request still invalidates and reacquires.
  rejection = 401;
  assert.equal((await read()).error?.code, 'CONNECTION_REQUIRED');
  rejection = undefined;
  assert.equal((await read()).error, undefined);
  assert.equal(tokenCalls, 3);
});
