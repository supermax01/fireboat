/**
 * M3a Repair D regression tests: GPT final-review findings F-1..F-5
 * (proposals/audit/gpt-m3a-final-review.md). Every test here reproduces a
 * reviewed failure against the pre-repair code (revert-proved) and passes
 * after the fix; positive controls keep ordinary behavior pinned.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { FhirGateway, type GatewayConfig, type GatewayEnvelope } from '../packages/core/src/index.js';
import * as privacy from '../packages/core/src/privacy.js';
import { controlledFetch, FhirTransport } from '../packages/core/src/transport.js';
import { ClientCredentialsProvider } from '../packages/auth/src/client-credentials.js';
import { fixtureSha256, RAW_READ_BODIES } from '../packages/evals/src/fixture.js';
import { createMcpServer } from '../packages/server/src/index.js';
import type { FhirResource } from '../packages/core/src/contracts.js';

const a = 'synthetic-patient-a';
const base = new URL('http://127.0.0.1:4321/fhir/');
const json = (value: unknown) => JSON.stringify(value);
const resources = (envelope: GatewayEnvelope) => envelope.data.resources as Record<string, unknown>[];

const obs = (extra: Record<string, unknown> = {}): FhirResource => ({
  resourceType: 'Observation', id: 'o1', status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }], text: 'Synthetic' },
  subject: { reference: `Patient/${a}` },
  ...extra,
});

const DISPLAY_SENTINEL = 'SYNTHETIC_B_PRIVATE';
const MRN_SENTINEL = 'SYNTHETIC_B_MRN';
const leakyPerformer = (reference: string) => [{
  reference, display: DISPLAY_SENTINEL,
  identifier: { system: 'urn:synthetic:mrn', value: MRN_SENTINEL },
}];
const assertNoSentinels = (value: unknown, label: string) => {
  const text = typeof value === 'string' ? value : json(value);
  assert.ok(!text.includes(DISPLAY_SENTINEL), `${label}: foreign display leaked`);
  assert.ok(!text.includes(MRN_SENTINEL), `${label}: foreign identifier leaked`);
  assert.ok(!text.includes('48213'), `${label}: foreign identifier value leaked`);
};

interface GatewayFixtureOptions {
  reads?: Record<string, unknown>;
  records?: Record<string, unknown>[];
  /** OperationOutcome resources appended to a searchset; receives the request offset. */
  outcomesFor?: (offset: number) => Record<string, unknown>[];
}
async function gatewayFixture(options: GatewayFixtureOptions = {}) {
  let baseUrl = '';
  const metadata = {
    resourceType: 'CapabilityStatement', fhirVersion: '4.0.1',
    rest: [{ mode: 'server', resource: ['Patient', 'Observation'].map(type => ({
      type, interaction: [{ code: 'read' }, { code: 'search-type' }],
      searchParam: [{ name: 'patient', type: 'reference' }, { name: 'subject', type: 'reference' }, { name: 'performer', type: 'reference' }, { name: 'code', type: 'token' }],
    })) }],
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, baseUrl);
    res.setHeader('content-type', 'application/fhir+json');
    const path = url.pathname.slice('/fhir/'.length);
    if (path === 'metadata') { res.end(json(metadata)); return; }
    if (path.includes('/')) {
      if (!Object.hasOwn(options.reads ?? {}, path)) { res.statusCode = 404; res.end('{}'); return; }
      res.end(json((options.reads!)[path])); return;
    }
    const records = options.records ?? [];
    const count = Number(url.searchParams.get('_count') ?? 20);
    const offset = Number(url.searchParams.get('_offset') ?? 0);
    const page = records.slice(offset, offset + count);
    const nextOffset = offset + page.length;
    const next = nextOffset < records.length ? (() => { const n = new URL(url); n.searchParams.set('_offset', String(nextOffset)); return n.href; })() : undefined;
    res.end(json({
      resourceType: 'Bundle', type: 'searchset',
      link: [{ relation: 'self', url: url.href }, ...(next ? [{ relation: 'next', url: next }] : [])],
      entry: [
        ...page.map(resource => ({ resource, search: { mode: 'match' } })),
        ...(options.outcomesFor?.(offset) ?? []).map(resource => ({ resource, search: { mode: 'outcome' } })),
      ],
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/fhir/`;
  return {
    baseUrl,
    gateway: (limits?: GatewayConfig['limits'], extra?: Partial<GatewayConfig>) =>
      new FhirGateway({ mode: 'synthetic', source: { alias: 'fixture', baseUrl }, patientId: a, limits, ...extra }),
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }),
  };
}

// --------------------------------------------------------------------- F-1

const CONDITIONAL_VARIANTS: [string, string][] = [
  ['literal Patient', 'Patient?identifier=urn:synthetic:mrn|48213'],
  ['lowercase patient', 'patient?identifier=urn:synthetic:mrn|48213'],
  ['mixed-case PaTiEnT', 'PaTiEnT?identifier=urn:synthetic:mrn|48213'],
  ['percent-encoded P (%50atient)', '%50atient?identifier=urn:synthetic:mrn|48213'],
  ['percent-encoded i (Pat%69ent)', 'Pat%69ent?identifier=urn:synthetic:mrn|48213'],
  ['double-encoded (%2550atient)', '%2550atient?identifier=urn:synthetic:mrn|48213'],
  ['unknown conditional type', 'PersonRecord?identifier=urn:synthetic:mrn|48213'],
  ['known non-Patient conditional (Practitioner)', 'Practitioner?identifier=urn:synthetic:mrn|48213'],
];

test('F-1: only a literal, case-exact, known resource type parses as conditional; encoded/malformed/unknown types are unsupported', () => {
  const parse = (value: string) => privacy.parseReference(value, base);
  assert.deepEqual(parse('Patient?identifier=urn:mrn|B'), { form: 'conditional', type: 'Patient', patientLike: true });
  assert.deepEqual(parse('Practitioner?identifier=urn:npi|1'), { form: 'conditional', type: 'Practitioner', patientLike: false });
  for (const value of [
    '%50atient?identifier=urn:mrn|B',
    'Pat%69ent?identifier=urn:mrn|B',
    '%2550atient?identifier=urn:mrn|B',
    'patient?identifier=urn:mrn|B',
    'PaTiEnT?identifier=urn:mrn|B',
  ]) {
    const parsed = parse(value);
    assert.equal(parsed.form, 'unsupported', value);
    assert.equal(parsed.patientLike, true, `${value}: encoded/case-variant Patient must stay patient-like`);
  }
  const unknown = parse('PersonRecord?identifier=urn:mrn|B');
  assert.equal(unknown.form, 'unsupported', 'an unknown conditional type is never an ordinary reference');
});

test('F-1/F-2: every conditional variant is denied as a secondary reference and as the subject linkage', () => {
  const ok = (resource: FhirResource) => privacy.authorized(resource, a, base);
  for (const [label, reference] of CONDITIONAL_VARIANTS) {
    assert.equal(ok(obs({ performer: leakyPerformer(reference) })), false, label);
    assert.equal(ok(obs({ subject: { reference } })), false, `${label} as subject`);
  }
  // Positive controls: ordinary local references, with display, keep working.
  assert.equal(ok(obs({ performer: [{ reference: 'Practitioner/p1', display: 'Synthetic clinician' }] })), true);
  assert.equal(ok(obs({ performer: [{ reference: `Patient/${a}` }] })), true);
});

test('F-1: sanitize never preserves the display or identifier of a conditional/unsupported reference', () => {
  for (const [label, reference] of CONDITIONAL_VARIANTS) {
    assertNoSentinels(privacy.sanitize(obs({ performer: leakyPerformer(reference) })), label);
  }
  // Positive control: a verifiable local Practitioner reference keeps its display.
  const clean = privacy.sanitize(obs({ performer: [{ reference: 'Practitioner/p1', display: 'Synthetic clinician' }] }));
  assert.equal((clean.resource.performer as Record<string, unknown>[])[0]?.display, 'Synthetic clinician');
});

test('F-1: gateway read, FHIR search and retained projection disclose no conditional-reference companions', async t => {
  const cleanObs = obs({ id: 'o-clean', performer: [{ reference: 'Practitioner/p1', display: 'Synthetic clinician' }] });
  const leaky = CONDITIONAL_VARIANTS.map(([, reference], i) => obs({ id: `o-leak-${i}`, performer: leakyPerformer(reference) }));
  const reads: Record<string, unknown> = { 'Observation/o-clean': cleanObs };
  for (const record of leaky) reads[`Observation/${record.id}`] = record;
  const f = await gatewayFixture({ reads, records: [cleanObs, ...leaky] }); t.after(f.close);
  const gateway = f.gateway();
  for (const [i, [label]] of CONDITIONAL_VARIANTS.entries()) {
    const read = await gateway.execute('fhir_read', { resource_type: 'Observation', id: `o-leak-${i}`, output: { format: 'fhir' } });
    assert.equal(read.error?.code, 'NOT_FOUND', label);
    assertNoSentinels(read, `${label} read`);
  }
  const cleanRead = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'o-clean', output: { format: 'fhir' } });
  assert.equal(cleanRead.error, undefined, 'ordinary Practitioner/p1 control stays readable');
  const search = await gateway.execute('fhir_search', { resource_type: 'Observation', output: { format: 'fhir' } });
  assert.equal(search.error, undefined);
  assert.deepEqual(resources(search).map(resource => resource.id), ['o-clean'], 'every conditional-variant record is suppressed');
  assertNoSentinels(search, 'search');
  const retained = await gateway.execute('fhir_result', { handle: search.result!.handle, action: 'project', fields: ['performer', 'subject'], output: { format: 'fhir' } });
  assert.equal(retained.error, undefined);
  assert.deepEqual(resources(retained).map(resource => resource.id), ['o-clean']);
  assertNoSentinels(retained, 'retained projection');
  assert.equal((resources(retained)[0]?.performer as Record<string, unknown>[])[0]?.display, 'Synthetic clinician');
  gateway.close();
});

interface SdkResult { structuredContent?: GatewayEnvelope; content?: { type?: string; text?: string }[]; isError?: boolean }
async function sdkCall(gateway: FhirGateway, era: 'modern' | 'legacy', tool: string, args: Record<string, unknown>): Promise<SdkResult> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(({ era: instanceEra }) => createMcpServer(gateway, { era: instanceEra }), { transport: serverSide });
  const client = new Client({ name: 'repair-d-probe', version: '0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } as never : undefined);
  await client.connect(clientSide);
  try { return await client.callTool({ name: tool, arguments: args }) as SdkResult; }
  finally { await client.close().catch(() => undefined); await handle.close().catch(() => undefined); }
}

test('F-1: actual SDK calls in both eras carry no conditional-reference companions in text or structured content', async t => {
  const cleanObs = obs({ id: 'o-clean', performer: [{ reference: 'Practitioner/p1', display: 'Synthetic clinician' }] });
  // The review's minimal reproduction shape (encoded conditional Patient performer).
  const leakyObs = obs({ id: 'o-leak', performer: leakyPerformer('%50atient?identifier=urn:synthetic:mrn|48213') });
  const f = await gatewayFixture({ reads: { 'Observation/o-clean': cleanObs, 'Observation/o-leak': leakyObs }, records: [cleanObs, leakyObs] }); t.after(f.close);
  for (const era of ['modern', 'legacy'] as const) {
    const gateway = f.gateway();
    const read = await sdkCall(gateway, era, 'fhir_read', { resource_type: 'Observation', id: 'o-leak', output: { format: 'fhir' } });
    assert.equal(read.structuredContent?.error?.code, 'NOT_FOUND', era);
    const search = await sdkCall(gateway, era, 'fhir_search', { resource_type: 'Observation', output: { format: 'fhir' } });
    assert.equal(search.structuredContent?.error, undefined, era);
    assert.deepEqual(resources(search.structuredContent!).map(resource => resource.id), ['o-clean'], era);
    const retained = await sdkCall(gateway, era, 'fhir_result', { handle: search.structuredContent!.result!.handle, action: 'project', fields: ['performer'], output: { format: 'fhir' } });
    assert.equal(retained.structuredContent?.error, undefined, era);
    for (const [label, result] of [['read', read], ['search', search], ['retained', retained]] as const) {
      const text = result.content?.[0]?.text ?? '';
      assert.ok(text.length > 0, `${era} ${label}: text content must exist`);
      assertNoSentinels(text, `${era} ${label} text`);
      assertNoSentinels(result.structuredContent, `${era} ${label} structured`);
    }
    gateway.close();
  }
});

// --------------------------------------------------------------------- F-3

async function rawFixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Raw fixture did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  return { origin, base: `${origin}/fhir/`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
/** Write without Content-Length (chunked), in slices, so only stream metering can bound the bytes. */
function writeChunked(res: ServerResponse, body: Buffer): void {
  for (let i = 0; i < body.length; i += 1024) res.write(body.subarray(i, i + 1024));
  res.end();
}
const emptyGzipMembers = (count: number) => Buffer.concat(Array.from({ length: count }, () => gzipSync('')));

test('F-3: compressed bytes are metered before decompression, independently of Content-Length (FHIR)', async t => {
  const small = json({ resourceType: 'Observation', id: 'tiny', status: 'final' });
  // Decoded body is tiny; compressed size is inflated with concatenated empty gzip members
  // (scaled equivalent of the review's 6,000,066-byte case against a 5 MiB allowance).
  const bloated = Buffer.concat([gzipSync(small), emptyGzipMembers(600)]);
  assert.ok(bloated.length > 4096, `fixture sanity: ${bloated.length} compressed bytes`);
  const f = await rawFixture((req, res) => {
    res.setHeader('content-type', 'application/fhir+json');
    if ((req.url ?? '').includes('bloated')) { res.setHeader('content-encoding', 'gzip'); writeChunked(res, bloated); return; }
    if ((req.url ?? '').includes('normal')) { res.setHeader('content-encoding', 'gzip'); writeChunked(res, Buffer.concat([gzipSync(small), emptyGzipMembers(5)])); return; }
    if ((req.url ?? '').includes('identity')) { writeChunked(res, Buffer.from(json({ resourceType: 'Observation', id: 'big', note: 'x'.repeat(8000) }))); return; }
    // Decoded-expansion: small compressed body, large decoded JSON.
    res.setHeader('content-encoding', 'gzip'); writeChunked(res, gzipSync(json({ resourceType: 'Binary', data: 'x'.repeat(20000) })));
  }); t.after(f.close);
  const transport = new FhirTransport(f.base, 4096, 2000);
  const get = (id: string) => transport.get(transport.url(`Observation/${id}`), { calls: 0 });
  await assert.rejects(get('bloated'), { code: 'UPSTREAM_LIMIT' }, 'chunked concatenated gzip over the compressed allowance is refused without Content-Length');
  await assert.rejects(get('identity'), { code: 'UPSTREAM_LIMIT' }, 'chunked identity over the allowance is refused');
  await assert.rejects(get('expanded'), { code: 'UPSTREAM_LIMIT' }, 'decoded expansion stays refused by the decoded-byte counter');
  assert.deepEqual(await get('normal'), { resourceType: 'Observation', id: 'tiny', status: 'final' }, 'ordinary compressed success (concatenated members under the allowance)');
  // The same bloated payload succeeds under a generous allowance, proving size — not shape — caused the refusal.
  const generous = new FhirTransport(f.base, 64 * 1024, 2000);
  assert.deepEqual(await generous.get(generous.url('Observation/bloated'), { calls: 0 }), { resourceType: 'Observation', id: 'tiny', status: 'final' });
});

test('F-3: controlledFetch enforces an explicit compressed-byte allowance on the raw stream', async t => {
  const bloated = Buffer.concat([gzipSync('{"resourceType":"Basic"}'), emptyGzipMembers(200)]);
  const f = await rawFixture((_req, res) => { res.setHeader('content-type', 'application/fhir+json'); res.setHeader('content-encoding', 'gzip'); writeChunked(res, bloated); }); t.after(f.close);
  const url = new URL(`${f.base}Basic/x`);
  const limited = await controlledFetch(url, { maxCompressedBytes: 1024 } as Parameters<typeof controlledFetch>[1]);
  await assert.rejects(limited.text(), (error: unknown) => (error as { code?: string }).code === 'UPSTREAM_LIMIT', 'raw-stream meter destroys the body with UPSTREAM_LIMIT');
  const generous = await controlledFetch(url, { maxCompressedBytes: 64 * 1024 } as Parameters<typeof controlledFetch>[1]);
  assert.equal(await generous.text(), '{"resourceType":"Basic"}');
});

test('F-3: compressed bytes are metered for token responses too', async t => {
  const tokenJson = json({ access_token: 'synthetic-token', token_type: 'Bearer', expires_in: 3600 });
  let bloated = true;
  const f = await rawFixture((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.setHeader('content-encoding', 'gzip');
    writeChunked(res, bloated ? Buffer.concat([gzipSync(tokenJson), emptyGzipMembers(200)]) : gzipSync(tokenJson));
  }); t.after(f.close);
  const secretEnv = 'FHIR_MCP_REPAIR_D_SECRET';
  const provider = () => new ClientCredentialsProvider(f.base, { type: 'client_credentials', tokenUrl: `${f.origin}/oauth/token`, clientId: 'synthetic-client', clientSecretEnv: secretEnv }, { env: { [secretEnv]: 'synthetic-secret' }, maxTokenResponseBytes: 1024 });
  await assert.rejects(
    provider().authorizationFor(new URL(`${f.base}Patient/x`)),
    (error: unknown) => (error as { code?: string }).code === 'TOKEN_RESPONSE_LIMIT',
    'chunked gzip token body over the compressed allowance is refused without Content-Length',
  );
  bloated = false;
  assert.equal(await provider().authorizationFor(new URL(`${f.base}Patient/x`)), 'Bearer ' + 'synthetic-token', 'ordinary compressed token success');
});

// --------------------------------------------------------------------- F-4

const incompleteOutcome = { resourceType: 'OperationOutcome', issue: [{ severity: 'warning', code: 'incomplete', diagnostics: 'Results truncated at a server limit' }] };

test('F-4: retained inspect on a source-incomplete page reports an unknown remainder and keeps the reason', async t => {
  const f = await gatewayFixture({ records: [obs({ id: 'o1' })], outcomesFor: () => [incompleteOutcome] }); t.after(f.close);
  const gateway = f.gateway();
  const search = await gateway.execute('fhir_search', { resource_type: 'Observation' });
  assert.equal(search.error, undefined);
  assert.equal(search.pagination?.has_more, null);
  assert.ok(search.coverage.reasons.includes('SOURCE_REPORTED_INCOMPLETE'));
  const inspect = await gateway.execute('fhir_result', { handle: search.result!.handle, action: 'inspect' });
  assert.equal(inspect.error, undefined);
  assert.equal(inspect.data.upstream_pages_remain, null, 'source-incomplete without a next URL is unknown, not exhausted');
  assert.ok(inspect.coverage.reasons.includes('SOURCE_REPORTED_INCOMPLETE'));
  gateway.close();
  // Control: a genuinely exhausted page still reports false and carries no incompleteness reason.
  const clean = await gatewayFixture({ records: [obs({ id: 'o1' })] }); t.after(clean.close);
  const cleanGateway = clean.gateway();
  const cleanSearch = await cleanGateway.execute('fhir_search', { resource_type: 'Observation' });
  const cleanInspect = await cleanGateway.execute('fhir_result', { handle: cleanSearch.result!.handle, action: 'inspect' });
  assert.equal(cleanInspect.data.upstream_pages_remain, false);
  assert.ok(!cleanInspect.coverage.reasons.includes('SOURCE_REPORTED_INCOMPLETE'));
  cleanGateway.close();
});

test('F-4: source-incompleteness survives a paged merge into retained inspect; a usable next URL still reports true', async t => {
  // Only page 1 reports incompleteness; the merged page-2 snapshot must retain it.
  const f = await gatewayFixture({
    records: [obs({ id: 'o1' }), obs({ id: 'o2' })],
    outcomesFor: offset => offset === 0 ? [incompleteOutcome] : [],
  }); t.after(f.close);
  const gateway = f.gateway();
  const first = await gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 1 });
  assert.equal(first.error, undefined);
  assert.equal(first.pagination?.has_more, true);
  const firstInspect = await gateway.execute('fhir_result', { handle: first.result!.handle, action: 'inspect' });
  assert.equal(firstInspect.data.upstream_pages_remain, true, 'a usable next URL still reports true');
  const second = await gateway.execute('fhir_page', { cursor: first.pagination!.next_cursor! });
  assert.equal(second.error, undefined);
  assert.deepEqual(resources(second).map(resource => resource.id), ['o2']);
  assert.ok(second.coverage.reasons.includes('SOURCE_REPORTED_INCOMPLETE'), 'paged merge keeps the marker');
  const secondInspect = await gateway.execute('fhir_result', { handle: second.result!.handle, action: 'inspect' });
  assert.equal(secondInspect.data.upstream_pages_remain, null, 'merged incompleteness is unknown remainder, not exhaustion');
  assert.ok(secondInspect.coverage.reasons.includes('SOURCE_REPORTED_INCOMPLETE'));
  gateway.close();
});

// --------------------------------------------------------------------- F-5

test('F-5: the fixture hash covers the raw read bodies (numeric value and lexeme), with a stability control', () => {
  const baseline = fixtureSha256();
  assert.equal(fixtureSha256(), baseline, 'unchanged inputs are stable');
  const raw = RAW_READ_BODIES['obs-decimal-1']!;
  assert.ok(raw.includes('"value":7.0'), 'fixture sanity: the raw decimal lexeme is present');
  const changedValue = { ...RAW_READ_BODIES, 'obs-decimal-1': raw.replace('"value":7.0', '"value":8.0') };
  assert.notEqual(fixtureSha256(undefined, undefined, changedValue), baseline, 'changing only a raw numeric value changes the fingerprint');
  const changedLexeme = { ...RAW_READ_BODIES, 'obs-decimal-1': raw.replace('"value":7.0', '"value":7.00') };
  assert.notEqual(fixtureSha256(undefined, undefined, changedLexeme), baseline, 'changing only a raw decimal lexeme changes the fingerprint');
  // The default hash tracks the live raw-body table the fixture server actually serves.
  const original = RAW_READ_BODIES['obs-decimal-1']!;
  try {
    RAW_READ_BODIES['obs-decimal-1'] = changedValue['obs-decimal-1']!;
    assert.notEqual(fixtureSha256(), baseline);
  } finally { RAW_READ_BODIES['obs-decimal-1'] = original; }
  assert.equal(fixtureSha256(), baseline);
});
