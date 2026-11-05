import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { FhirGateway, type GatewayConfig, type GatewayEnvelope } from '../packages/core/src/index.js';
import { containsPrecisionFault, FhirDecimal, FhirPrecisionFault, parseFhirJson, stringifyFhir } from '../packages/core/src/decimal.js';
import { authorized, sanitize } from '../packages/core/src/privacy.js';
import { ResultStore } from '../packages/core/src/store.js';
import { createMcpServer } from '../packages/server/src/index.js';
import type { FhirResource } from '../packages/core/src/contracts.js';

const a = 'synthetic-patient-a';
const b = 'synthetic-patient-b';
const observation = (id: string, patient = a, extra: Record<string, unknown> = {}) => ({ resourceType: 'Observation', id, meta: { versionId: '1' }, status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, subject: { reference: `Patient/${patient}` }, effectiveDateTime: '2026-01-02T10:00:00Z', valueQuantity: { value: 7.1, unit: '%', system: 'http://unitsofmeasure.org', code: '%' }, ...extra });

interface ReadReply { status?: number; body: string; contentType?: string }
interface Options {
  records?: Record<string, unknown>[];
  outcomes?: Record<string, unknown>[];
  total?: number;
  nextFor?: (url: URL, nextOffset: number) => string | undefined;
  reads?: Record<string, ReadReply>;
  rawSearch?: (url: URL) => string;
  metadataDelayMs?: number;
}
const METADATA = {
  resourceType: 'CapabilityStatement', fhirVersion: '4.0.1',
  rest: [{ mode: 'server', resource: ['Patient', 'Observation'].map(type => ({
    type, interaction: [{ code: 'read' }, { code: 'search-type' }],
    searchParam: [
      { name: 'patient', type: 'reference' }, { name: 'subject', type: 'reference' }, { name: 'performer', type: 'reference' },
      { name: 'code', type: 'token' }, { name: 'date', type: 'date' },
    ],
  })) }],
};

async function fixture(options: Options = {}) {
  const requests: URL[] = [];
  let baseUrl = '';
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, baseUrl);
    requests.push(url);
    const send = () => {
      res.setHeader('content-type', 'application/fhir+json');
      if (url.pathname.endsWith('/metadata')) { res.end(JSON.stringify(METADATA)); return; }
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length === 3) {
        const id = segments[2]!;
        const reply = options.reads?.[id];
        if (reply) {
          res.statusCode = reply.status ?? 200;
          if (reply.contentType) res.setHeader('content-type', reply.contentType);
          res.end(reply.body);
          return;
        }
        if (id === 'missing') { res.statusCode = 404; res.end('{}'); return; }
        res.end(JSON.stringify(segments[1] === 'Patient' ? { resourceType: 'Patient', id } : observation(id, id.startsWith('obs-b') ? b : a)));
        return;
      }
      if (options.rawSearch) { res.end(options.rawSearch(url)); return; }
      const records = options.records ?? [observation('obs-a'), observation('obs-a2')];
      const count = Number(url.searchParams.get('_count') ?? 20);
      const offset = Number(url.searchParams.get('_offset') ?? 0);
      const page = records.slice(offset, offset + count);
      const nextOffset = offset + page.length;
      const customNext = options.nextFor?.(url, nextOffset);
      const defaultNext = nextOffset < records.length ? (() => { const next = new URL(url); next.searchParams.set('_offset', String(nextOffset)); return next.href; })() : undefined;
      const next = customNext !== undefined ? customNext : defaultNext;
      res.end(JSON.stringify({
        resourceType: 'Bundle', type: 'searchset', total: options.total ?? records.length,
        link: [{ relation: 'self', url: url.href }, ...(next ? [{ relation: 'next', url: next }] : [])],
        entry: [...page.map(resource => ({ resource, search: { mode: 'match' } })), ...(options.outcomes ?? []).map(resource => ({ resource, search: { mode: 'outcome' } }))],
      }));
    };
    if (url.pathname.endsWith('/metadata') && options.metadataDelayMs) setTimeout(send, options.metadataDelayMs).unref?.();
    else send();
  };
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/fhir/`;
  return {
    baseUrl, requests, options,
    gateway: (limits?: GatewayConfig['limits'], extra?: Partial<GatewayConfig>) => new FhirGateway({ mode: 'synthetic', source: { alias: 'fixture', baseUrl }, patientId: a, limits, ...extra }),
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }),
  };
}
const resources = (result: GatewayEnvelope) => result.data.resources as Record<string, unknown>[];
const searchRequests = (requests: URL[]) => requests.filter(url => !url.pathname.endsWith('/metadata'));

// ---------------------------------------------------------------- J-6 decimals

test('J-6 parse/stringify round-trips every source lexeme and keeps canonical numbers plain', () => {
  const text = '{"a":7.0,"b":120.00,"c":0.0100,"d":1e2,"e":-0.0,"f":9007199254740993,"g":5.4,"h":1e400,"i":-0,"j":[2.50,3],"k":42}';
  const parsed = parseFhirJson(text) as Record<string, unknown>;
  assert.equal(stringifyFhir(parsed), text);
  assert.equal(typeof parsed.g, 'number');
  assert.equal(typeof parsed.k, 'number');
  assert.ok(parsed.a instanceof FhirDecimal && parsed.a.lexeme === '7.0');
  assert.equal((parsed.j as unknown[])[1], 3);
});

const DECIMAL_READ = `{"resourceType":"Observation","id":"decimal","meta":{"versionId":"1"},"status":"final","code":{"coding":[{"system":"http://loinc.org","code":"4548-4"}]},"subject":{"reference":"Patient/${a}"},"valueQuantity":{"value":7.0,"unit":"%","system":"http://unitsofmeasure.org","code":"%"},"referenceRange":[{"low":{"value":0.0100},"high":{"value":120.00}}],"component":[{"valueQuantity":{"value":1e2}},{"valueQuantity":{"value":-0.0}}]}`;

test('J-6 decimal lexemes survive read, both formats, retained projection and field selection', async t => {
  const f = await fixture({ reads: { decimal: { body: DECIMAL_READ } } }); t.after(f.close);
  const gateway = f.gateway();
  for (const format of ['fhir', 'compact'] as const) {
    const result = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'decimal', output: { format } });
    assert.equal(result.error, undefined, format);
    const wire = gateway.toToolResult(result);
    for (const lexeme of ['"value":7.0', '"value":0.0100', '"value":120.00', '"value":1e2', '"value":-0.0']) {
      assert.ok(wire.content[0]!.text.includes(lexeme), `${format} text ${lexeme}`);
      assert.ok(JSON.stringify(wire.structuredContent).includes(lexeme), `${format} structured ${lexeme}`);
    }
    assert.equal(JSON.parse(wire.content[0]!.text).data.resources[0].valueQuantity.value, 7);
    const projected = await gateway.execute('fhir_result', { handle: result.result!.handle, action: 'project', fields: ['valueQuantity', 'referenceRange'], output: { format: 'fhir' } });
    assert.equal(projected.error, undefined);
    assert.ok(gateway.toToolResult(projected).content[0]!.text.includes('"value":120.00'), 'retained projection keeps the lexeme (no structuredClone loss)');
  }
});

test('J-6 a mixed-resource Bundle delivers decimal and plain records and suppresses only the foreign one', async t => {
  const bundle = (url: URL) => `{"resourceType":"Bundle","type":"searchset","total":3,"link":[{"relation":"self","url":${JSON.stringify(url.href)}}],"entry":[{"resource":${DECIMAL_READ},"search":{"mode":"match"}},{"resource":${JSON.stringify(observation('obs-plain'))},"search":{"mode":"match"}},{"resource":${JSON.stringify(observation('obs-b-foreign', b))},"search":{"mode":"match"}}]}`;
  const f = await fixture({ rawSearch: bundle }); t.after(f.close);
  const gateway = f.gateway();
  const result = await gateway.execute('fhir_search', { resource_type: 'Observation', output: { format: 'fhir' } });
  assert.equal(result.error, undefined, 'one decimal record must not fail the whole page');
  assert.deepEqual(resources(result).map(resource => resource.id), ['decimal', 'obs-plain']);
  assert.ok(gateway.toToolResult(result).content[0]!.text.includes('"value":7.0'));
});

test('J-6 store content-hash dedupe treats 7.0 and 7 as distinct content', () => {
  const store = new ResultStore<Record<string, unknown>>(100_000, 10, 60_000);
  const decimalValue = { v: new FhirDecimal('120.00'), pad: 'x'.repeat(200) };
  store.put('res', decimalValue);
  // Byte accounting must match the final serialized form (the bare lexeme), not an internal object shape.
  assert.equal(store.usedBytes(), Buffer.byteLength(stringifyFhir(decimalValue)));
  store.put('res', { v: new FhirDecimal('7.0'), pad: 'x'.repeat(200) });
  const afterFirst = store.usedBytes();
  store.put('res', { v: 7, pad: 'x'.repeat(200) });
  assert.ok(store.usedBytes() > afterFirst + 150, `distinct lexemes must not share a blob (${afterFirst} -> ${store.usedBytes()})`);
  const before = store.usedBytes();
  store.put('res', { v: new FhirDecimal('7.0'), pad: 'x'.repeat(200) });
  assert.equal(store.usedBytes(), before, 'identical lexemes still dedupe');
  store.close();
});

test('J-6 precision markers are linkage-neutral until after authorization', () => {
  const resource = observation('obs-marker', a, { valueQuantity: { value: new FhirPrecisionFault() } }) as FhirResource;
  assert.equal(containsPrecisionFault(resource), true);
  assert.equal(containsPrecisionFault(observation('obs-plain')), false);
  assert.equal(authorized(resource, a, new URL('http://127.0.0.1/fhir/')), true, 'authorization judges linkage only; precision is refused afterwards');
  assert.equal(containsPrecisionFault(sanitize(resource).resource), true, 'sanitize passes the marker through for the gateway to refuse per-resource');
});

// ------------------------------------------------------------ J-9 + J-23 links

test('J-9 dropped patient, code and Patient _id constraints reject the link before any fetch', async t => {
  const options: Options = { records: [observation('obs-a'), observation('obs-a2'), observation('obs-a3')] };
  const f = await fixture(options); t.after(f.close);
  const gateway = f.gateway();
  await gateway.execute('fhir_capabilities', { topic: 'server' });
  const cases: [string, () => Promise<GatewayEnvelope>, (url: URL) => string][] = [
    ['patient', () => gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }], page_size: 1 }),
      url => { const next = new URL(url); next.searchParams.delete('patient'); next.searchParams.set('_offset', '1'); return next.href; }],
    ['code', () => gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }], page_size: 1 }),
      url => { const next = new URL(url); next.searchParams.delete('code'); next.searchParams.set('_offset', '1'); return next.href; }],
    ['_id', () => gateway.execute('fhir_search', { resource_type: 'Patient', page_size: 1 }),
      url => { const next = new URL(url); next.searchParams.delete('_id'); next.searchParams.set('_offset', '1'); return next.href; }],
  ];
  for (const [name, run, drop] of cases) {
    let badLink = '';
    options.nextFor = url => { badLink = drop(url); return badLink; };
    const before = f.requests.length;
    const result = await run();
    assert.equal(result.error, undefined, name);
    assert.equal(result.pagination?.has_more, null, name);
    assert.equal(result.pagination?.next_cursor, undefined, name);
    assert.ok(result.coverage.reasons.includes('NON_CONTINUABLE_UPSTREAM_LINK'), name);
    assert.equal(f.requests.length, before + 1, `${name}: only the original search went upstream`);
    assert.ok(!f.requests.some(url => url.href === badLink), `${name}: the dropped-${name} link was never fetched`);
  }
  // Positive control: paging-size variation plus _offset keeps the link continuable.
  options.nextFor = (url, nextOffset) => { const next = new URL(url); next.searchParams.set('_offset', String(nextOffset)); next.searchParams.set('_count', '5'); return next.href; };
  const first = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }], page_size: 1 });
  assert.equal(first.error, undefined);
  assert.equal(first.pagination?.has_more, true);
  const second = await gateway.execute('fhir_page', { cursor: first.pagination!.next_cursor! });
  assert.equal(second.error, undefined);
  assert.ok(resources(second).length > 0);
});

test('J-23 vendor paging tokens: _cursor only with every constraint; ct/_page_token/pageContext are non-continuable partials', async t => {
  const options: Options = { records: [observation('obs-a'), observation('obs-a2'), observation('obs-a3')] };
  const f = await fixture(options); t.after(f.close);
  const gateway = f.gateway();
  await gateway.execute('fhir_capabilities', { topic: 'server' });
  const search = () => gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }], page_size: 1 });
  const withToken = (name: string, keepConstraints = true) => (url: URL, nextOffset: number) => {
    const next = new URL(url);
    if (!keepConstraints) { next.searchParams.delete('code'); next.searchParams.delete('patient'); }
    next.searchParams.set('_offset', String(nextOffset));
    next.searchParams.set(name, 'opaque-token');
    return next.href;
  };
  options.nextFor = withToken('_cursor');
  const cursorFirst = await search();
  assert.equal(cursorFirst.error, undefined);
  assert.equal(cursorFirst.pagination?.has_more, true, '_cursor with every original constraint is continuable');
  const cursorSecond = await gateway.execute('fhir_page', { cursor: cursorFirst.pagination!.next_cursor! });
  assert.equal(cursorSecond.error, undefined);
  assert.ok(searchRequests(f.requests).at(-1)!.searchParams.has('_cursor'));
  for (const [name, keep] of [['_cursor', false], ['ct', true], ['_page_token', true], ['pageContext', true]] as const) {
    options.nextFor = withToken(name, keep);
    const before = f.requests.length;
    const result = await search();
    assert.equal(result.error, undefined, name);
    assert.equal(resources(result).length, 1, `${name}: page 1 evidence is delivered`);
    assert.equal(result.pagination?.has_more, null, `${name}: never presented as exhaustion`);
    assert.equal(result.pagination?.next_cursor, undefined, name);
    assert.equal(result.coverage.state, 'partial', name);
    assert.ok(result.coverage.reasons.includes('NON_CONTINUABLE_UPSTREAM_LINK'), name);
    assert.equal(f.requests.length, before + 1, `${name}: the unsupported link was never fetched`);
  }
});

// ------------------------------------------------------------------ J-15 reads

test('J-15 every pre-authorization read failure class is publicly identical to a missing resource', async t => {
  const foreignBody = JSON.stringify(observation('probe', b, { note: [{ text: 'FOREIGN_NOTE_SECRET' }] }));
  const classes: [string, ReadReply, string][] = [
    ['410 gone', { status: 410, body: '{}' }, 'UPSTREAM_ERROR:410'],
    ['400 bad request', { status: 400, body: '{}' }, 'UPSTREAM_ERROR:400'],
    ['422 unprocessable', { status: 422, body: '{}' }, 'UPSTREAM_ERROR:422'],
    ['oversized', { body: JSON.stringify(observation('probe', b, { note: [{ text: 'x'.repeat(20000) }] })) }, 'UPSTREAM_LIMIT:200'],
    ['malformed json', { body: '{"resourceType":"Observation",' }, 'INVALID_RESPONSE:200'],
    ['wrong content type', { body: foreignBody, contentType: 'text/plain' }, 'UNSUPPORTED_CONTENT:200'],
    ['foreign resource', { body: foreignBody }, ''],
  ];
  for (const [name, reply, cause] of classes) {
    const f = await fixture({ reads: { probe: reply } }); t.after(f.close);
    const gateway = f.gateway({ upstreamBytes: 4096 });
    const probe = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'probe' });
    const missing = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'missing' });
    assert.deepEqual(probe.error, missing.error, name);
    assert.deepEqual(probe.data, {}, name);
    assert.equal(probe.error?.code, 'NOT_FOUND', name);
    const probeAudit = gateway.auditEvents.find(event => event.request_id === probe.request_id)!;
    if (cause) assert.equal(probeAudit.cause, cause, `${name}: precise cause only in the audit`);
    assert.ok(!JSON.stringify([probe, gateway.auditEvents]).includes('FOREIGN_NOTE_SECRET'), name);
    assert.ok(!JSON.stringify(gateway.auditEvents).includes(b), `${name}: audit carries no patient identifiers`);
    gateway.close();
  }
});

// ------------------------------------------------------------- J-21 discovery

test('J-21 each caller races its own deadline around the shared epoch-keyed metadata flight', async t => {
  // The 1 s metadata delay keeps the flight open long enough for the second caller to join
  // deterministically under CPU saturation; the 40 ms caller still expires first.
  const f = await fixture({ metadataDelayMs: 1_000 }); t.after(f.close);
  const gateway = f.gateway({ timeoutMs: 5000 });
  const short = gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' }, { deadlineMs: 40 });
  const pollDeadline = Date.now() + 5_000;
  while (!f.requests.some(url => url.pathname.endsWith('/metadata')) && Date.now() < pollDeadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(f.requests.some(url => url.pathname.endsWith('/metadata')), 'metadata flight must be in progress before the second caller joins');
  const long = gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' }, { deadlineMs: 5000 });
  const [shortResult, longResult] = await Promise.all([short, long]);
  assert.equal(shortResult.error?.code, 'UPSTREAM_TIMEOUT');
  assert.equal(longResult.error, undefined, 'the short-deadline waiter must not poison the shared flight');
  assert.equal(f.requests.filter(url => url.pathname.endsWith('/metadata')).length, 1, 'one shared metadata flight');
  gateway.close();
});

// --------------------------------------------------------------------- J-17

test('J-17 other-patient values on Patient-targeting reference parameters are refused before execution', async t => {
  const f = await fixture(); t.after(f.close);
  const gateway = f.gateway();
  await gateway.execute('fhir_capabilities', { topic: 'server' });
  for (const value of [`Patient/${b}`, new URL(`Patient/${b}`, f.baseUrl).href, `Patient/${a},Patient/${b}`, 'Patient?identifier=synthetic-mrn-b']) {
    const result = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'performer', value }] });
    assert.equal(result.error?.code, 'POLICY_DENIED', value);
  }
  assert.equal(searchRequests(f.requests).length, 0, 'no search reached the source');
  const allowed = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'performer', value: `Patient/${a}` }] });
  assert.equal(allowed.error, undefined, 'positive control: the trusted patient as performer');
  assert.deepEqual(searchRequests(f.requests).at(-1)!.searchParams.getAll('performer'), [`Patient/${a}`]);
});

test('J-17 multi-page suppression: no premature total on any page and a suppression-independent caveat', async t => {
  const f = await fixture({ records: [observation('obs-a'), observation('obs-a2'), observation('obs-b-page2', b, { note: [{ text: 'PAGE2_SECRET' }] })], total: 3 }); t.after(f.close);
  const gateway = f.gateway();
  const first = await gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 2 });
  assert.equal(first.error, undefined);
  assert.deepEqual(resources(first).map(resource => resource.id), ['obs-a', 'obs-a2']);
  assert.equal(first.pagination?.has_more, true);
  assert.equal(first.pagination?.total?.value, undefined, 'page 1 must not publish the upstream total while pages remain');
  const second = await gateway.execute('fhir_page', { cursor: first.pagination!.next_cursor! });
  assert.equal(second.error, undefined);
  assert.equal(resources(second).length, 0, 'the page-2 foreign record is suppressed');
  assert.equal(second.pagination?.total?.value, undefined, 'continuation totals are never taken');
  assert.equal(second.coverage.authorization_limited, first.coverage.authorization_limited);
  assert.ok(!JSON.stringify([first, second]).includes('PAGE2_SECRET'));
  // Same paging shape without any suppression: page 2 carries identical caveat, warnings and total shape.
  const unsuppressed = await fixture({ records: [observation('obs-a'), observation('obs-a2'), observation('obs-a3')], total: 3 }); t.after(unsuppressed.close);
  const cleanGateway = unsuppressed.gateway();
  const cleanFirst = await cleanGateway.execute('fhir_search', { resource_type: 'Observation', page_size: 2 });
  const cleanSecond = await cleanGateway.execute('fhir_page', { cursor: cleanFirst.pagination!.next_cursor! });
  assert.equal(cleanSecond.coverage.authorization_limited, second.coverage.authorization_limited);
  assert.deepEqual(cleanSecond.warnings.map(warning => warning.code), second.warnings.map(warning => warning.code));
  assert.deepEqual(cleanSecond.pagination?.total, second.pagination?.total);
  // Positive control: single complete page, nothing suppressed, no next link -> the total is publishable.
  const clean = await fixture({ records: [observation('obs-a'), observation('obs-a2')], total: 2 }); t.after(clean.close);
  const complete = await clean.gateway().execute('fhir_search', { resource_type: 'Observation' });
  assert.equal(complete.pagination?.total?.value, 2);
  assert.equal(complete.pagination?.has_more, false);
});

// --------------------------------------------------------------------- J-35

test('J-35 OperationOutcome classification: benign empty-result warning, filter issues, and hard errors', async t => {
  const outcome = (issue: Record<string, unknown>) => ({ resourceType: 'OperationOutcome', issue: [issue] });
  // Epic-4101-style warning on an empty result is not a failure.
  const empty = await fixture({ records: [], outcomes: [outcome({ severity: 'warning', code: 'informational', diagnostics: '4101: No records matched the query.' })] }); t.after(empty.close);
  const emptyResult = await empty.gateway().execute('fhir_search', { resource_type: 'Observation' });
  assert.equal(emptyResult.error, undefined);
  assert.equal(resources(emptyResult).length, 0);
  assert.ok(!emptyResult.warnings.some(warning => warning.code === 'FILTER_EXECUTION_UNVERIFIED'));
  // A filter-related issue at information severity unverifies only the named filter.
  const filtered = await fixture({ records: [observation('obs-a')], outcomes: [outcome({ severity: 'information', code: 'informational', expression: ['Observation.code'] })] }); t.after(filtered.close);
  const filteredResult = await filtered.gateway().execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }] });
  assert.equal(filteredResult.error, undefined);
  assert.deepEqual(filteredResult.coverage.constraints?.filter(c => c.execution !== "unknown").map(({ name, value }) => ({ name, value })), [{ name: 'patient', value: `Patient/${a}` }], 'code is never claimed from a self link; confinement stays');
  assert.ok(filteredResult.warnings.some(warning => warning.code === 'FILTER_EXECUTION_UNVERIFIED'));
  // An issue implicating the confinement parameter removes even that from executed.
  const confinement = await fixture({ records: [observation('obs-a')], outcomes: [outcome({ severity: 'warning', code: 'not-supported', diagnostics: 'patient parameter not supported here' })] }); t.after(confinement.close);
  const confinementResult = await confinement.gateway().execute('fhir_search', { resource_type: 'Observation' });
  assert.equal(confinementResult.error, undefined);
  assert.deepEqual(confinementResult.coverage.constraints?.filter(c => c.execution !== 'unknown').map(({ name, value }) => ({ name, value })), [{ name: 'patient', value: `Patient/${a}` }]);
  // A non-filter error still fails the query.
  const hard = await fixture({ records: [observation('obs-a')], outcomes: [outcome({ severity: 'error', code: 'exception', diagnostics: 'upstream failure' })] }); t.after(hard.close);
  assert.equal((await hard.gateway().execute('fhir_search', { resource_type: 'Observation' })).error?.code, 'UNVERIFIED_QUERY');
  // Self link alone: a plain successful search claims only gateway-enforced confinement as executed.
  const plain = await fixture({ records: [observation('obs-a')] }); t.after(plain.close);
  const plainResult = await plain.gateway().execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }, { name: 'date', value: 'ge2026-01-01' }] });
  assert.deepEqual(plainResult.coverage.constraints?.filter(c => c.execution !== "unknown").map(({ name, value }) => ({ name, value })), [{ name: 'patient', value: `Patient/${a}` }]);
});

// ------------------------------------------------------- era byte accounting

async function sdkCall(gateway: FhirGateway, era: 'modern' | 'legacy', tool: string, args: Record<string, unknown>) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  let wireResultBytes = 0;
  let wireText = '';
  const send = serverSide.send.bind(serverSide);
  serverSide.send = async (message, options) => {
    const record = message as { result?: unknown };
    if ('result' in record && record.result !== undefined) { wireText = JSON.stringify(record.result); wireResultBytes = Buffer.byteLength(wireText); }
    return send(message, options);
  };
  const handle = serveStdio(({ era: instanceEra }) => createMcpServer(gateway, { era: instanceEra }), { transport: serverSide });
  const client = new Client({ name: 'integration2-probe', version: '0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } as never : undefined);
  await client.connect(clientSide);
  try {
    const result = await client.callTool({ name: tool, arguments: args }) as { structuredContent?: GatewayEnvelope };
    return { envelope: result.structuredContent!, wireResultBytes, wireText };
  } finally {
    await client.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
}

test('era-specific byte accounting matches the measured SDK wire result in both eras', async t => {
  const f = await fixture(); t.after(f.close);
  const modern = f.gateway();
  const modernCall = await sdkCall(modern, 'modern', 'fhir_capabilities', { topic: 'context' });
  assert.equal(modernCall.envelope.budget.bytes_returned, modernCall.wireResultBytes, 'modern: serverInfo _meta + resultType measured exactly');
  modern.close();
  const legacy = f.gateway();
  const legacyCall = await sdkCall(legacy, 'legacy', 'fhir_capabilities', { topic: 'context' });
  assert.equal(legacyCall.envelope.budget.bytes_returned, legacyCall.wireResultBytes, 'legacy: no _meta/resultType is emitted or counted');
  legacy.close();
  // The era-agnostic default (modern shape) still never under-reports a legacy wire result.
  const unaware = f.gateway();
  const unawareCall = await sdkCall(unaware, 'legacy', 'fhir_capabilities', { topic: 'context' });
  assert.ok(unawareCall.envelope.budget.bytes_returned >= unawareCall.wireResultBytes);
  unaware.close();
});

test('J-6 decimal values pass SDK output-schema validation and reach the wire as JSON numbers', async t => {
  const f = await fixture({ reads: { decimal: { body: DECIMAL_READ } } }); t.after(f.close);
  const gateway = f.gateway();
  const call = await sdkCall(gateway, 'modern', 'fhir_read', { resource_type: 'Observation', id: 'decimal' });
  assert.equal(call.envelope.error, undefined);
  assert.ok(call.wireText.includes('"value":7.0'), call.wireText.slice(0, 200));
  assert.ok(call.wireText.includes('"value":120.00'));
  gateway.close();
});
