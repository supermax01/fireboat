// D06 internal preparation only: separate explicit CLIENT work, not a gateway retry.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { scanObservedCodes, type ScanClient, type ScanOptions } from '../examples/observed-code-scan.js';
import { createMcpServer } from '../packages/server/src/index.js';
import { FhirGateway } from '../packages/core/src/index.js';
import { permissiveInputSchema, toMcpToolResult02, type GatewayEnvelope02 } from '../packages/core/src/contracts.js';
import { OBSERVED_CODE_DATE_PARAMETERS, OBSERVED_CODE_FIELDS, repairForNoMatches } from '../packages/core/src/repairs.js';
import pinned from '../packages/core/src/generated/r4-search-parameters.json' with { type: 'json' };
import { tokenAlternatives } from '../packages/core/src/query.js';

const opts: ScanOptions = { resourceType: 'Observation', trustedBinding: { source: 'local', contextHandle: 'ctx_test', selector: { name: 'subject', value: 'Patient/synthetic-a' } },
  dateWindow: [{ name: 'date', value: 'ge2025-01-01' }, { name: 'date', value: 'le2025-02-01' }, { name: 'date', value: 'ge2025-01-01' }] };
const metadata = () => ({ structuredContent: { schema_version: '0.3', context: { handle: 'ctx_test' }, source: { alias: 'local' }, data: { search_parameters: [{ name: 'code', type: 'token', definition_evidence: 'pinned_r4' }] } } });
const page = (more: boolean | null = false, coding = [{ system: 'http://loinc.org', code: '4548-4' }]) => ({ structuredContent: { schema_version: '0.3', context: { handle: 'ctx_test' }, source: { alias: 'local' }, coverage: { state: 'unknown', reasons: ['FILTER_EXECUTION_UNVERIFIED'], query_exhausted: more === false }, data: { resources: [{ resourceType: 'Observation', code: { coding } }] }, pagination: { has_more: more, ...(more ? { next_cursor: 'cur_private-test' } : {}) } } });
function driver(responses: unknown[] = [metadata(), page()], maxPerCall = 1) {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  let work = 0;
  const client: ScanClient = { upstreamWork: { total: () => work, maxPerCall }, callTool: async request => {
    calls.push(structuredClone(request)); work++;
    if (calls.length > responses.length) throw new Error('unexpected extra call');
    return structuredClone(responses[calls.length - 1]) as never;
  } };
  return { client, calls };
}
test('scan preserves repeated original dates and trusted binding, reviewed roots, faithful escaped tuples and one encoding', async () => {
  const tuples = [{ system: 'http://synthetic.test/a|b', code: 'local,x\\y' }, { system: 'http://other.test', code: 'local,x\\y' }, { code: 'no,system' }];
  const { client, calls } = driver([metadata(), page(false, tuples as never)]);
  const result = await scanObservedCodes(client, opts);
  assert.equal(result.status, 'chain_exhausted'); assert.equal(result.mcpCalls, 2); assert.equal(result.clinicalPages, 1);
  assert.deepEqual(calls.map(c => c.name), ['fhir_capabilities', 'fhir_search']);
  assert.equal(calls[0]!.arguments.context_handle, 'ctx_test'); assert.equal(calls[0]!.arguments.source, 'local');
  assert.equal(calls[1]!.arguments.page_size, 100);
  assert.deepEqual(calls[1]!.arguments.params, [...opts.dateWindow, opts.trustedBinding.selector]);
  assert.deepEqual(calls[1]!.arguments.output, { format: 'fhir', fields: ['code'], max_bytes: 24576 });
  assert.equal(calls[1]!.arguments.context_handle, 'ctx_test'); assert.equal(calls[1]!.arguments.source, 'local');
  const requery = result.requery!;
  assert.equal(requery.source, 'local'); assert.equal(requery.context_handle, 'ctx_test'); assert.equal(requery.resource_type, 'Observation');
  const decoded = new URLSearchParams(requery.encodedQuery);
  assert.deepEqual([...decoded.entries()], requery.params.map(pair => [pair.name, pair.value]));
  assert.deepEqual(decoded.getAll('date'), opts.dateWindow.map(p => p.value)); assert.equal(decoded.get('subject'), opts.trustedBinding.selector.value);
  assert.deepEqual(tokenAlternatives(decoded.get('code')!), tuples.map(x => ({ system: x.system ?? null, code: x.code })));
  assert.equal(calls.some(c => /terminology|expand|lookup|read/.test(c.name)), false);
});

test('at default page cap includes local remainders and preserves honest gateway cursor/coverage', async () => {
  const responses = [metadata(), page(true), page(true), page(true)], before = JSON.stringify(responses);
  const { client, calls } = driver(responses);
  const result = await scanObservedCodes(client, opts);
  assert.equal(result.status, 'partial'); assert.equal(result.code, 'SCAN_LIMIT_REACHED'); assert.equal(result.clinicalPages, 3); assert.equal(result.mcpCalls, 4);
  assert.equal(result.requery, undefined); assert.deepEqual(calls.map(c => c.name), ['fhir_capabilities', 'fhir_search', 'fhir_page', 'fhir_page']);
  for (const c of calls.slice(2)) { assert.equal(c.arguments.context_handle, 'ctx_test'); assert.equal(c.arguments.cursor, 'cur_private-test'); assert.equal('params' in c.arguments, false); }
  assert.equal(JSON.stringify(responses), before);
});
for (const [cap, value, expectedCalls] of [
  ['maxClinicalPages', 1, 2], ['maxMcpCalls', 1, 1], ['maxUpstreamCalls', 1, 1], ['maxBytesPerTask', 24576, 1],
] as const) test(`scan lower operator ${cap} stops before next call`, async () => {
  const { client, calls } = driver([metadata(), page(true), page(true), page(false)]);
  const r = await scanObservedCodes(client, { ...opts, limits: { [cap]: value } });
  assert.equal(r.status, 'partial'); assert.equal(r.code, 'SCAN_LIMIT_REACHED'); assert.equal(calls.length, expectedCalls); assert.equal(r.requery, undefined);
});
test('upstream budget reserves enforced driver maximum INCLUDING metadata/auth before send', async () => {
  const { client, calls } = driver([metadata(), page()], 20);
  const r = await scanObservedCodes(client, opts);
  assert.equal(r.code, 'SCAN_LIMIT_REACHED'); assert.equal(calls.length, 1);
  const none = driver([metadata()], 21);
  assert.equal((await scanObservedCodes(none.client, opts)).code, 'SCAN_LIMIT_REACHED'); assert.equal(none.calls.length, 0);
});
for (const [name, response, limits] of [
  ['per-call bytes', { ...metadata(), padding: 'x'.repeat(24576) }, undefined],
  ['lower per-call bytes', { ...metadata(), padding: 'x'.repeat(1000) }, { maxBytesPerCall: 1000 }],
] as const) test(`scan refuses ${name} without retry`, async () => {
  const { client, calls } = driver([response]);
  assert.equal((await scanObservedCodes(client, { ...opts, limits })).code, 'SCAN_LIMIT_REACHED'); assert.equal(calls.length, 1);
});
test('task byte cap uses measured complete SDK results, reserves remaining allowance', async () => {
  const { client, calls } = driver([{ ...metadata(), padding: 'x'.repeat(24000) }, { ...page(true), padding: 'x'.repeat(24000) }, { ...page(true), padding: 'x'.repeat(24000) }, page(false)]);
  const r = await scanObservedCodes(client, opts);
  assert.equal(r.code, 'SCAN_LIMIT_REACHED'); assert.equal(calls.length, 3); assert.ok(r.bytes <= 73728);
});
test('45 second wall-clock cap refuses before another call, even if a page is terminal', async () => {
  const { client, calls } = driver([metadata(), page()]);
  let time = 0;
  const wrapped: ScanClient = { ...client, callTool: async (...args) => { const r = await client.callTool(...args); time = 45000; return r; } };
  const r = await scanObservedCodes(wrapped, { ...opts, now: () => time });
  assert.equal(r.code, 'SCAN_LIMIT_REACHED'); assert.equal(calls.length, 1);
});
test('lower real deadline cancels outstanding SDK call and never retries', async () => {
  let calls = 0, aborted = false;
  const client: ScanClient = { upstreamWork: { total: () => calls, maxPerCall: 1 }, callTool: async (_request, { signal }) => {
    calls++;
    return await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }); });
  } };
  const timer = setTimeout(() => {}, 1000); // keep test alive for unref'ed AbortSignal timer
  try { assert.equal((await scanObservedCodes(client, { ...opts, limits: { maxSeconds: 0.02 } })).code, 'SCAN_LIMIT_REACHED'); assert.equal(aborted, true); assert.equal(calls, 1); }
  finally { clearTimeout(timer); }
});
for (const key of ['pageSize', 'maxClinicalPages', 'maxMcpCalls', 'maxUpstreamCalls', 'maxSeconds', 'maxBytesPerCall', 'maxBytesPerTask'] as const) test(`scan refuses raised/invalid ${key}; accepts lower page size`, async () => {
  const defaults = { pageSize: 100, maxClinicalPages: 3, maxMcpCalls: 4, maxUpstreamCalls: 20, maxSeconds: 45, maxBytesPerCall: 24576, maxBytesPerTask: 73728 };
  for (const value of [defaults[key] + 1, 0, -1, NaN]) {
    const { client, calls } = driver(); assert.equal((await scanObservedCodes(client, { ...opts, limits: { [key]: value } })).code, 'SCAN_REFUSED'); assert.equal(calls.length, 0);
  }
  if (key === 'pageSize') { const d = driver(); assert.equal((await scanObservedCodes(d.client, { ...opts, limits: { pageSize: 7 } })).status, 'chain_exhausted'); assert.equal(d.calls[1]!.arguments.page_size, 7); }
});
test('refuse truncated original splits before any work and observed tuple overflow without requery', async () => {
  const d = driver(); const input = Array.from({ length: 33 }, (_, i) => `s|c${i}`).join(',');
  assert.equal((await scanObservedCodes(d.client, { ...opts, originalCodeOr: input })).code, 'TRUNCATED_OR_REFUSED'); assert.equal(d.calls.length, 0);
  const many = driver([metadata(), page(false, Array.from({ length: 33 }, (_, i) => ({ system: 's', code: `c${i}` })))]);
  const r = await scanObservedCodes(many.client, opts); assert.equal(r.code, 'TRUNCATED_OR_REFUSED'); assert.equal(r.requery, undefined); assert.equal(many.calls.length, 2);
});
for (const [name, options] of [
  ['unreviewed root', { resourceType: 'MedicationRequest' }], ['missing dates', { dateWindow: [] }],
  ['changed date name', { dateWindow: [{ name: 'issued', value: '2025' }] }],
  ['missing context', { trustedBinding: { ...opts.trustedBinding, contextHandle: '' } }],
  ['untrusted selector', { trustedBinding: { ...opts.trustedBinding, selector: { name: 'performer', value: 'Patient/synthetic-a' } } }],
] as [string, Partial<ScanOptions>][]) test(`scan refuses ${name} before work`, async () => {
  const { client, calls } = driver(); assert.equal((await scanObservedCodes(client, { ...opts, ...options })).code, 'SCAN_REFUSED'); assert.equal(calls.length, 0);
});
for (const [name, responses, expected] of [
  ['source-only code discovery', [{ structuredContent: { schema_version: '0.3', context: { handle: 'ctx_test' }, source: { alias: 'local' }, data: { search_parameters: [{ name: 'code', type: 'token', definition_evidence: 'source_declared' }] } } }], 'SCAN_REFUSED'],
  ['gateway error', [metadata(), { isError: true, structuredContent: { schema_version: '0.3', context: { handle: 'ctx_test' }, source: { alias: 'local' }, error: { code: 'UPSTREAM_ERROR' } } }], 'SCAN_REFUSED'],
  ['unknown continuation', [metadata(), page(null)], 'SCAN_REFUSED'],
  ['terminal unexhausted coverage', [metadata(), { ...page(false), structuredContent: { ...page(false).structuredContent, coverage: { state: 'unknown', query_exhausted: null } } }], 'SCAN_EXHAUSTION_UNVERIFIED'],
  ['missing cursor', [metadata(), { ...page(true), structuredContent: { ...page(true).structuredContent, pagination: { has_more: true } } }], 'SCAN_REFUSED'],
  ['0.1 output', [{ structuredContent: { schema_version: '0.1' } }], 'SCAN_REFUSED'],
] as const) test(`scan refuses ${name} without broadening/retry`, async () => {
  const { client, calls } = driver([...responses]); assert.equal((await scanObservedCodes(client, opts)).code, expected); assert.equal(calls.length, responses.length);
});
test('empty observed codes yield no broadened requery', async () => {
  const d = driver([metadata(), page(false, [])]); const r = await scanObservedCodes(d.client, opts); assert.equal(r.status, 'chain_exhausted'); assert.equal(r.requery, undefined);
});

for (const era of ['modern', 'legacy'] as const) test(`D06 internal ${era}: real SDK client task + recorded source, three pages/four calls, no terminology fetch`, async () => {
  let base = '', upstream = 0, clinical = 0;
  const urls: URL[] = [];
  const source = createServer((req, res) => {
    upstream++; const url = new URL(req.url!, base); urls.push(url); res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname.endsWith('/metadata')) { res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [{ type: 'Observation', interaction: [{ code: 'search-type' }], searchParam: [{ name: 'subject', type: 'reference' }, { name: 'date', type: 'date' }, { name: 'code', type: 'token' }] }] }] })); return; }
    clinical++; const index = Number(url.searchParams.get('_offset') ?? '0'), next = new URL(url); next.searchParams.set('_offset', String(index + 1));
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }, ...(index < 2 ? [{ relation: 'next', url: next.href }] : [])], entry: [{ search: { mode: 'match' }, resource: { resourceType: 'Observation', id: `synthetic-o${index}`, subject: { reference: 'Patient/synthetic-a' }, code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, effectiveDateTime: '2025-01-02T00:00:00Z' } }] }));
  });
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(source.address() as { port: number }).port}/fhir/`;
  const gw = new FhirGateway({ mode: 'synthetic', source: { alias: 'local', baseUrl: base }, patientId: 'synthetic-a', contextId: 'ctx_test' });
  const c = gw as unknown as { envelopeV2(tool: string, body: unknown): GatewayEnvelope02; coverageV2(s: unknown, a: unknown): unknown; store: { get(handle: string): { value: unknown } } };
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(() => createMcpServer(gw, { era }), { transport: b });
  const client = new Client({ name: 's53-scan', version: '0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  try {
    await client.connect(a);
    const calls: string[] = [];
    const driver: ScanClient = { upstreamWork: { total: () => upstream, maxPerCall: 2 }, callTool: (request, { signal }) => { calls.push(request.name); return client.callTool(request, { signal }) as never; } };
    const r = await scanObservedCodes(driver, opts);
    assert.equal(r.status, 'exhaustion_unverified'); assert.equal(r.code, 'SCAN_EXHAUSTION_UNVERIFIED'); assert.equal(r.chainExhausted, undefined); assert.equal(r.requery, undefined); assert.equal(r.observed.length, 3); assert.equal(r.pages.at(-1)!.state, 'partial'); assert.equal(r.clinicalPages, 3); assert.equal(r.mcpCalls, 4); assert.equal(r.upstreamCalls, 4);
    assert.equal(clinical, 3); assert.equal(upstream, 4); assert.ok(r.bytes <= 73728);
    assert.deepEqual(calls, ['fhir_capabilities', 'fhir_search', 'fhir_page', 'fhir_page']);
    for (const url of urls.filter(u => !u.pathname.endsWith('/metadata'))) {
      assert.deepEqual(url.searchParams.getAll('date'), opts.dateWindow.map(p => p.value));
      assert.ok(url.searchParams.getAll('subject').every(v => v === 'Patient/synthetic-a')); assert.equal(url.searchParams.get('_count'), '100');
    }
    assert.equal(urls.some(u => /ValueSet|CodeSystem|\$expand|\$lookup/.test(u.pathname)), false);
  } finally { await client.close(); await server.close(); gw.close(); source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve())); }
});
test('scan is separate/import-inert and no gateway/store runtime imports it', () => {
  for (const file of ['packages/core/src/index.ts', 'packages/core/src/store.ts', 'packages/server/src/index.ts']) {
    const text = readFileSync(new URL('../' + file, import.meta.url), 'utf8'); assert.equal(text.includes('observed-code-scan'), false);
  }
});

test('scan freezes original type, dates and binding before asynchronous discovery', async () => {
  const options = structuredClone(opts), d = driver();
  const wrapped: ScanClient = { ...d.client, callTool: async (...args) => {
    const result = await d.client.callTool(...args);
    options.resourceType = 'Condition'; options.dateWindow[0]!.value = 'ge1900'; options.trustedBinding.selector.value = 'Patient/synthetic-b';
    return result;
  } };
  const r = await scanObservedCodes(wrapped, options);
  assert.equal(r.status, 'chain_exhausted'); assert.equal(d.calls[1]!.arguments.resource_type, 'Observation');
  assert.deepEqual(d.calls[1]!.arguments.params, [...opts.dateWindow, opts.trustedBinding.selector]);
  assert.equal(r.requery!.resource_type, 'Observation');
});

test('scan retains exact observed coding version/display and response-local source/version citations', async () => {
  const response = page(false);
  Object.assign(response.structuredContent.data.resources[0]!, { id: 'synthetic-o1', meta: { versionId: 'source-v2' },
    code: { coding: [{ system: 'http://loinc.org', code: '4548-4', version: '2.76', display: 'Synthetic display' }] } });
  const d = driver([metadata(), response]); const r = await scanObservedCodes(d.client, opts);
  assert.equal(r.status, 'chain_exhausted');
  assert.deepEqual(r.observed, [{ system: 'http://loinc.org', code: '4548-4', version: '2.76', display: 'Synthetic display',
    citation: { source: 'local', resource_type: 'Observation', id: 'synthetic-o1', version: 'source-v2', mcp_call: 2, resource_index: 0 } }]);
});

test('F-13 C53-M02 hard deadline bounds a driver that ignores AbortSignal and never settles', async () => {
  let calls = 0;
  const client: ScanClient = { upstreamWork: { total: () => calls, maxPerCall: 1 }, callTool: () => { calls++; return new Promise(() => {}); } };
  let timer: ReturnType<typeof setTimeout>;
  const watchdog = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('hard deadline missing')), 300); });
  try {
    const r = await Promise.race([scanObservedCodes(client, { ...opts, limits: { maxSeconds: 0.01 } }), watchdog]);
    assert.equal(r.code, 'SCAN_LIMIT_REACHED'); assert.equal(calls, 1);
  } finally { clearTimeout(timer!); }
});
test('F-13 C53-M05 post-call absolute upstream overrun refuses a dishonest driver', async () => {
  let work = 0, calls = 0;
  const client: ScanClient = { upstreamWork: { total: () => work, maxPerCall: 1 }, callTool: async () => {
    calls++; work += calls === 1 ? 1 : 20; return calls === 1 ? metadata() : page();
  } };
  const r = await scanObservedCodes(client, opts);
  assert.equal(r.code, 'SCAN_REFUSED'); assert.equal(r.upstreamCalls, 21); assert.equal(r.requery, undefined); assert.equal(calls, 2);
});
for (const value of [NaN, -1, 0.5, Infinity]) test(`F-10 bad work counter ${value} refuses before work`, async () => {
  const d = driver(); d.client.upstreamWork.total = () => value;
  const r = await scanObservedCodes(d.client, opts);
  assert.equal(r.code, 'SCAN_REFUSED'); assert.equal(d.calls.length, 0); assert.equal(r.upstreamCalls, 0);
});
test('F-10 invalid and decreasing post-call counter refuses without negative/NaN report', async () => {
  for (const end of [NaN, -1, 0.5, 4]) {
    const d = driver(); let n = 0; d.client.upstreamWork.total = () => ++n < 3 ? 5 : end;
    const r = await scanObservedCodes(d.client, opts);
    assert.equal(r.code, 'SCAN_REFUSED'); assert.equal(d.calls.length, 1); assert.equal(r.upstreamCalls, 0);
  }
});
for (const where of ['discovery', 'clinical'] as const) for (const field of ['source', 'context', 'resourceType'] as const) {
  if (where === 'discovery' && field === 'resourceType') continue;
  test(`F-12 ${where} rejects mismatched ${field}`, async () => {
    const response = where === 'discovery' ? metadata() : page();
    if (field === 'source') response.structuredContent.source.alias = 'foreign';
    else if (field === 'context') response.structuredContent.context.handle = 'ctx_foreign';
    else (response as ReturnType<typeof page>).structuredContent.data.resources[0]!.resourceType = 'Condition';
    const d = driver(where === 'discovery' ? [response] : [metadata(), response]);
    const r = await scanObservedCodes(d.client, opts);
    assert.equal(r.code, 'SCAN_REFUSED'); assert.deepEqual(r.observed, []); assert.equal(r.requery, undefined);
  });
}
test('F-11 unresolved/withheld code delivery reports evidence and refuses a requery', async () => {
  for (const transform of [{ unresolved_fields: ['code'], withheld_payloads: [] }, { unresolved_fields: [], withheld_payloads: [{ reason: 'policy' }] }]) {
    const p = page(); Object.assign(p.structuredContent, { transform });
    const d = driver([metadata(), p]); const r = await scanObservedCodes(d.client, opts);
    assert.equal(r.code, 'SCAN_REFUSED'); assert.equal(r.chainExhausted, undefined); assert.equal(r.requery, undefined);
    assert.deepEqual(r.pages[0], { ...transform, state: 'unknown', reasons: ['FILTER_EXECUTION_UNVERIFIED'] });
  }
});

test('F-14 every offered scan type has the complete pinned date-parameter set', () => {
  for (const type of Object.keys(OBSERVED_CODE_FIELDS)) {
    const names = pinned.definitions.filter(p => p.type === 'date' && p.base.includes(type)).map(p => p.code).sort();
    assert.deepEqual([...OBSERVED_CODE_DATE_PARAMETERS[type]!].sort(), names, type);
    assert.equal(repairForNoMatches(type, { resource: () => true, parameter: () => true }, [{ name: names[0]!, value: 'ge2025-01-01' }])!.action, 'inspect_observed_codes');
  }
});
for (const [resourceType, names] of Object.entries(OBSERVED_CODE_DATE_PARAMETERS)) for (const name of names) {
  test(`F-14 scan preserves ${resourceType} ${name} window occurrences`, async () => {
    const p = page(); p.structuredContent.data.resources[0]!.resourceType = resourceType;
    const d = driver([metadata(), p]); const dateWindow = [{ name, value: 'ge2025-01-01' }, { name, value: 'lt2025-02-01' }];
    const r = await scanObservedCodes(d.client, { ...opts, resourceType, dateWindow });
    assert.equal(r.status, 'chain_exhausted'); assert.deepEqual(d.calls[1]!.arguments.params, [...dateWindow, opts.trustedBinding.selector]);
    assert.deepEqual(r.requery!.params.slice(0, 2), dateWindow);
  });
}
test('F-14 Condition rejects non-R4 date parameter before discovery', async () => {
  const d = driver(); const r = await scanObservedCodes(d.client, { ...opts, resourceType: 'Condition' });
  assert.equal(r.code, 'SCAN_REFUSED'); assert.equal(d.calls.length, 0);
});
