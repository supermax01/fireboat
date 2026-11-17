/**
 * At the gateway and over real MCP SDK stdio: coverage never claims completeness after withholding one of the
 * bound patient's own records, explicit other-patient evidence stays silent (twin-equal), and unverifiable clinical-actor
 * references are withheld whole so the rest of the record is delivered. All fixtures are hand-written synthetic shapes.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { FhirGateway, WARNING_MESSAGES, type GatewayConfig, type GatewayEnvelope } from '../packages/core/src/index.js';
import { validateCrossField02 } from '../packages/core/src/contracts.js';
import { startSyntheticFhirServer } from '../examples/synthetic-server.js';
import { FhirPrecisionFault } from '../packages/core/src/decimal.js';

type Rec = Record<string, unknown>;
const A = 'synthetic-patient-a', B = 'synthetic-patient-b';
const SENT_DISPLAY = 'SYNTHETIC_W1_ACTOR_DISPLAY', SENT_VALUE = 'SYNTHETIC_W1_ACTOR_VALUE', SENT_SYSTEM = 'urn:synthetic:w1:actor-system';
const REASON = 'RECORDS_WITHHELD_BY_POLICY';
const code = { coding: [{ system: 'http://loinc.org', code: '4548-4' }] };
const actor = () => ({ identifier: { system: SENT_SYSTEM, value: SENT_VALUE }, display: SENT_DISPLAY });
const obs = (id: string, extra: Rec = {}, subject = A): Rec => ({ resourceType: 'Observation', id, status: 'final', code, subject: { reference: `Patient/${subject}` }, ...extra });
const withheldObs = (id: string) => obs(id, { contained: [{ resourceType: 'Basic', id: 'b1', code }] });
const doc = (id: string, extra: Rec = {}): Rec => ({ resourceType: 'DocumentReference', id, status: 'current', subject: { reference: `Patient/${A}` },
  content: [{ attachment: { contentType: 'text/plain', title: 'Synthetic note' } }], author: [actor()], ...extra });
const medRequest = (id: string, extra: Rec = {}): Rec => ({ resourceType: 'MedicationRequest', id, status: 'active', intent: 'order',
  medicationCodeableConcept: { coding: [{ system: 'urn:synthetic:drug', code: 'd1' }] }, subject: { reference: `Patient/${A}` }, ...extra });
const resources = (envelope: GatewayEnvelope) => envelope.data.resources as Rec[];
const assertNoSentinels = (value: unknown, label: string) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const sentinel of [SENT_DISPLAY, SENT_VALUE, SENT_SYSTEM]) assert.ok(!text.includes(sentinel), `${label}: ${sentinel} leaked`);
};
const hasWarning = (envelope: GatewayEnvelope, warningCode: string) => envelope.warnings.some(warning => warning.code === warningCode);
const assertWithheldSignal = (envelope: GatewayEnvelope, label: string) => {
  assert.equal(envelope.error, undefined, label);
  assert.equal(envelope.coverage.state, 'partial', label);
  assert.ok(envelope.coverage.reasons.includes(REASON), `${label}: reason`);
  assert.deepEqual(envelope.warnings.find(warning => warning.code === REASON), { code: REASON, message: WARNING_MESSAGES[REASON] }, `${label}: warning`);
  assert.notEqual(envelope.coverage.query_exhausted, true, `${label}: never exhausted`);
  assert.equal(envelope.pagination?.total?.value, undefined, `${label}: no published total`);
  assert.equal(hasWarning(envelope, 'NO_MATCHES'), false, `${label}: no NO_MATCHES`);
};
/** Public output that must not depend on suppressed other-patient evidence. Byte counts are left out: they include elapsed_ms. */
const publicView = (envelope: GatewayEnvelope) => {
  const { next_cursor: _cursor, ...pagination } = envelope.pagination ?? {} as Rec;
  return { error: envelope.error, data: envelope.data.resources, coverage: envelope.coverage, warnings: envelope.warnings, transform: envelope.transform,
    pagination, calls: envelope.budget.upstream_calls, limit: envelope.budget.limit_reached, provenance: envelope.provenance?.length };
};

const TYPES = ['Patient', 'Observation', 'DocumentReference', 'MedicationRequest'];
async function fixture(byType: Record<string, Rec[]>) {
  let baseUrl = '';
  const requests: URL[] = [];
  const metadata = { resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: TYPES.map(type => ({
    type, interaction: [{ code: 'read' }, { code: 'search-type' }],
    searchParam: [{ name: 'patient', type: 'reference' }, { name: 'subject', type: 'reference' }, { name: 'code', type: 'token' }],
  })) }] };
  const all = Object.values(byType).flat();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, baseUrl);
    requests.push(url);
    res.setHeader('content-type', 'application/fhir+json');
    const path = url.pathname.slice('/fhir/'.length);
    if (path === 'metadata') { res.end(JSON.stringify(metadata)); return; }
    if (path.includes('/')) {
      const [type, id] = path.split('/');
      const found = all.find(resource => resource.resourceType === type && resource.id === id);
      if (!found) { res.statusCode = 404; res.end('{}'); return; }
      res.end(JSON.stringify(found)); return;
    }
    const records = byType[path] ?? [];
    const count = Number(url.searchParams.get('_count') ?? 20), offset = Number(url.searchParams.get('_offset') ?? 0);
    const page = records.slice(offset, offset + count);
    const next = offset + page.length < records.length ? (() => { const n = new URL(url); n.searchParams.set('_offset', String(offset + page.length)); return n.href; })() : undefined;
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }, ...(next ? [{ relation: 'next', url: next }] : [])],
      entry: page.map(resource => ({ resource, search: { mode: 'match' } })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/fhir/`;
  return {
    baseUrl, requests,
    gateway: (extra: Partial<GatewayConfig> = {}) => new FhirGateway({ mode: 'synthetic', source: { alias: 'w1', baseUrl }, patientId: A, ...extra }),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test('A1: a page that withholds one of the patient\'s own records is partial, says why, and publishes no total', async t => {
  const f = await fixture({ Observation: [obs('o-clean'), withheldObs('o-withheld')] }); t.after(f.close);
  const gateway = f.gateway(); t.after(() => gateway.close());
  const search = await gateway.execute('fhir_search', { resource_type: 'Observation', output: { format: 'fhir' } });
  assertWithheldSignal(search, 'search');
  assert.deepEqual(resources(search).map(resource => resource.id), ['o-clean']);
  assert.equal(search.pagination?.has_more, false);
  assert.equal(search.coverage.query_exhausted, null);
  for (const args of [{ action: 'inspect' }, { action: 'project', fields: ['status'] }, { action: 'page' }] as Rec[]) {
    const retained = await gateway.execute('fhir_result', { handle: search.result!.handle, ...args, output: { format: 'fhir' } });
    assert.equal(retained.error, undefined, String(args.action));
    assert.ok(retained.coverage.reasons.includes(REASON), `fhir_result ${args.action}: reason`);
    assert.ok(hasWarning(retained, REASON), `fhir_result ${args.action}: warning`);
  }
  // The audit cause is metadata-only: the reason code, never an id.
  const audit = JSON.stringify(gateway.auditEvents);
  assert.ok(gateway.auditEvents.some(event => event.cause?.split(',').includes(REASON)));
  assert.ok(!audit.includes('o-withheld') && !audit.includes(A));
  // A read of the withheld record is indistinguishable from a missing one.
  const withheldRead = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'o-withheld', output: { format: 'fhir' } });
  const missingRead = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'o-missing', output: { format: 'fhir' } });
  assert.equal(withheldRead.error?.code, 'NOT_FOUND');
  assert.deepEqual(publicView(withheldRead), publicView(missingRead));
});

test('A1 read: authorization precedes precision checks, so own-withheld and foreign records with unpreservable numbers stay NOT_FOUND', async t => {
  const withQuantity = (record: Rec) => ({ ...record, valueQuantity: { value: 1, unit: 'mg' } });
  const f = await fixture({ Observation: [withQuantity(obs('o-own')), withQuantity(withheldObs('o-withheld')), withQuantity(obs('o-foreign', {}, B))] }); t.after(f.close);
  const gateway = f.gateway(); t.after(() => gateway.close());
  // Inject the parser's explicit loss marker after a real HTTP response, as the canonical message tests do.
  const transport = (gateway as unknown as { transport: { get: (...args: unknown[]) => Promise<Rec> } }).transport;
  const get = transport.get.bind(transport);
  transport.get = async (...args: unknown[]) => {
    const body = await get(...args);
    if (body.resourceType === 'Observation') (body.valueQuantity as Rec).value = new FhirPrecisionFault();
    return body;
  };
  const read = (id: string) => gateway.execute('fhir_read', { resource_type: 'Observation', id, output: { format: 'fhir' } });
  assert.equal((await read('o-own')).error?.code, 'UNSUPPORTED_PRECISION', 'the patient\'s own deliverable record is refused for precision, not hidden');
  const missing = await read('o-missing');
  for (const id of ['o-withheld', 'o-foreign']) {
    const result = await read(id);
    assert.equal(result.error?.code, 'NOT_FOUND', id);
    assert.deepEqual(publicView(result), publicView(missing), id);
  }
});

test('A1: the reason is sticky across the cursor chain in both orders', async t => {
  for (const [label, records, pageWithReason] of [
    ['withheld on page 1', [withheldObs('o1'), obs('o2')], [true, true]],
    ['withheld on page 2', [obs('o1'), withheldObs('o2')], [false, true]],
  ] as const) {
    const f = await fixture({ Observation: [...records] });
    const gateway = f.gateway();
    try {
      const first = await gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 1, output: { format: 'fhir' } });
      assert.equal(first.error, undefined, label);
      assert.equal(first.coverage.reasons.includes(REASON), pageWithReason[0], `${label}: page 1`);
      assert.equal(hasWarning(first, REASON), pageWithReason[0], `${label}: page 1 warning`);
      const second = await gateway.execute('fhir_page', { cursor: first.pagination!.next_cursor!, output: { format: 'fhir' } });
      assertWithheldSignal(second, `${label}: page 2`);
      assert.notEqual(second.pagination?.has_more, true);
    } finally { gateway.close(); await f.close(); }
  }
});

test('A1 twins: explicit other-patient evidence stays silent and leaves the public output unchanged (mirrors CLS-03 and NUM-01)', async t => {
  // One source and one fixed context handle, so the twins differ only in the records the source returns.
  const byType: Record<string, Rec[]> = { Observation: [] };
  const f = await fixture(byType); t.after(f.close);
  const runSearch = async (records: Rec[]) => {
    byType.Observation = records;
    const gateway = f.gateway({ contextId: 'ctx_w1_twins' });
    try { return await gateway.execute('fhir_search', { resource_type: 'Observation', output: { format: 'fhir' } }); }
    finally { gateway.close(); }
  };
  const clean = await runSearch([obs('o-clean')]);
  assert.equal(clean.coverage.reasons.includes(REASON), false);
  for (const [label, decoy] of [
    ['bound record with a Patient/<other> performer', obs('o-decoy', { performer: [{ reference: `Patient/${B}`, display: SENT_DISPLAY }] })],
    ['bound record with a foreign performer and a nested defect', obs('o-decoy', { performer: [{ reference: `Patient/${B}`, extension: [{ url: 'urn:synthetic:x', valueReference: { reference: 'not a ref!' } }] }] })],
    ['another patient\'s record with a defect', obs('o-decoy-b', { contained: [{ resourceType: 'Basic', id: 'b1', code }] }, B)],
    ['another patient\'s clean record', obs('o-decoy-b', {}, B)],
  ] as const) {
    const withDecoy = await runSearch([obs('o-clean'), decoy as Rec]);
    if (label === 'bound record with a foreign performer and a nested defect') {
      // The nested defect does not depend on whose identity the performer carries, so it is signalled in both twins.
      const boundTwin = await runSearch([obs('o-clean'), obs('o-decoy', { performer: [{ reference: `Patient/${A}`, extension: [{ url: 'urn:synthetic:x', valueReference: { reference: 'not a ref!' } }] }] })]);
      assert.deepEqual(publicView(withDecoy), publicView(boundTwin), label);
      assert.ok(withDecoy.coverage.reasons.includes(REASON), label);
      continue;
    }
    assert.deepEqual(publicView(withDecoy), publicView(clean), label);
    assertNoSentinels(withDecoy, label);
  }
  const empty = await runSearch([]);
  const foreignOnly = await runSearch([obs('o-b', {}, B)]);
  assert.deepEqual(publicView(foreignOnly), publicView(empty), 'a foreign-primary-only page equals the empty page');
});

test('A2: unverifiable clinical-actor references are withheld whole and the records are delivered, in every arm', async t => {
  const docs = Array.from({ length: 5 }, (_, i) => doc(`d${i}`));
  const f = await fixture({ DocumentReference: docs, MedicationRequest: [medRequest('m1', { requester: { reference: `Practitioner?identifier=${SENT_SYSTEM}|${SENT_VALUE}`, display: SENT_DISPLAY } })] });
  t.after(f.close);
  const gateway = f.gateway(); t.after(() => gateway.close());
  for (const output of [{ format: 'fhir' }, { format: 'compact' }, { format: 'fhir', fields: ['author', 'status'] }] as Rec[]) {
    const search = await gateway.execute('fhir_search', { resource_type: 'DocumentReference', output });
    const label = JSON.stringify(output);
    assert.equal(search.error, undefined, label);
    assert.deepEqual(resources(search).map(resource => resource.id), ['d0', 'd1', 'd2', 'd3', 'd4'], label);
    assert.equal(search.coverage.reasons.includes(REASON), false, `${label}: redaction is not withholding a record`);
    assert.equal(search.coverage.state, 'complete_for_query', label);
    assert.deepEqual(search.transform.withheld_payloads.filter(entry => entry.reason === 'UNVERIFIED_REFERENCE_WITHHELD'),
      [{ path: '/author/0', reason: 'UNVERIFIED_REFERENCE_WITHHELD', count: 5 }], label);
    assertNoSentinels(search, label);
    if (output.format === 'fhir' && !output.fields) {
      const projected = await gateway.execute('fhir_result', { handle: search.result!.handle, action: 'project', fields: ['author'], output: { format: 'fhir' } });
      assert.equal(projected.error, undefined);
      assert.equal(resources(projected).length, 5);
      assertNoSentinels(projected, 'retained projection');
    }
  }
  const read = await gateway.execute('fhir_read', { resource_type: 'DocumentReference', id: 'd3', output: { format: 'fhir' } });
  assert.equal(read.error, undefined);
  assert.deepEqual(resources(read)[0]!.author, []);
  assertNoSentinels(read, 'read');
  const orders = await gateway.execute('fhir_search', { resource_type: 'MedicationRequest', output: { format: 'fhir' } });
  assert.equal(orders.error, undefined);
  assert.deepEqual(resources(orders).map(resource => resource.id), ['m1']);
  assert.equal(Object.hasOwn(resources(orders)[0]!, 'requester'), false);
  assertNoSentinels(orders, 'conditional requester');
});

test('A2: a realistic own record with an attachment, an identifier-only author and a contained order is delivered redacted', async t => {
  const record = doc('d-real', {
    content: [{ attachment: { contentType: 'text/plain', data: 'U3ludGhldGlj', title: 'Synthetic note' } }],
    author: [actor(), { reference: 'Practitioner/p1', display: 'Synthetic clinician' }],
    contained: [{ resourceType: 'ServiceRequest', id: 'sr1', status: 'active', intent: 'order', subject: { reference: `Patient/${A}` }, requester: { reference: 'urn:uuid:4f1b2c3d-5e6f-4a1b-9c2d-3e4f5a6b7c8d', display: SENT_DISPLAY } }],
    context: { related: [{ reference: '#sr1' }] },
  });
  const f = await fixture({ DocumentReference: [record] }); t.after(f.close);
  const gateway = f.gateway(); t.after(() => gateway.close());
  const search = await gateway.execute('fhir_search', { resource_type: 'DocumentReference', output: { format: 'fhir' } });
  assert.equal(search.error, undefined);
  const delivered = resources(search)[0]!;
  assert.deepEqual(delivered.author, [{ reference: 'Practitioner/p1', display: 'Synthetic clinician' }]);
  assert.equal(Object.hasOwn((delivered.contained as Rec[])[0]!, 'requester'), false);
  assert.deepEqual(search.transform.withheld_payloads.filter(entry => entry.reason === 'UNVERIFIED_REFERENCE_WITHHELD').map(entry => entry.path).sort(), ['/author/0', '/contained/0/requester']);
  assert.ok(search.transform.withheld_payloads.some(entry => entry.reason === 'V1_PAYLOAD_WITHHELD'), 'the attachment payload is still withheld');
  assertNoSentinels(search, 'realistic record');
  assert.equal(gateway.auditEvents.some(event => event.cause?.includes('REDACTION_SELF_CHECK_FAILED')), false);
});

test('A1 strict gate: a completeness claim with the reason, or the reason without its warning, never leaves the gateway', async t => {
  const server = await startSyntheticFhirServer(); t.after(() => server.close());
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'local-synthetic', baseUrl: server.baseUrl }, patientId: A }); t.after(() => gateway.close());
  const search = await gateway.execute('fhir_search', { resource_type: 'Observation', output: { format: 'fhir' } });
  const read = JSON.parse(JSON.stringify(await gateway.execute('fhir_read', { resource_type: 'Observation', id: (resources(search)[0]!).id as string, output: { format: 'fhir' } })));
  assert.equal(read.coverage.state, 'complete_for_query');
  assert.deepEqual(validateCrossField02('fhir_read', read), { ok: true });
  const forged = structuredClone(read);
  forged.coverage.reasons.push(REASON);
  forged.warnings.push({ code: REASON, message: WARNING_MESSAGES[REASON] });
  assert.deepEqual(validateCrossField02('fhir_read', forged), { ok: false, reason: 'INVALID_CROSS_FIELDS' }, 'complete with the reason and its warning');
  // Pairing, isolated on a partial envelope that is otherwise valid: the reason and its warning travel together.
  const partialRead = structuredClone(read);
  partialRead.coverage.state = 'partial';
  partialRead.coverage.query_exhausted = null;
  const paired = structuredClone(partialRead);
  paired.coverage.reasons.push(REASON);
  paired.warnings.push({ code: REASON, message: WARNING_MESSAGES[REASON] });
  assert.deepEqual(validateCrossField02('fhir_read', paired), { ok: true }, 'partial with the reason and its warning');
  const reasonOnly = structuredClone(partialRead);
  reasonOnly.coverage.reasons.push(REASON);
  assert.deepEqual(validateCrossField02('fhir_read', reasonOnly), { ok: false, reason: 'INVALID_CROSS_FIELDS' }, 'reason without warning');
  const warningOnly = structuredClone(partialRead);
  warningOnly.warnings.push({ code: REASON, message: WARNING_MESSAGES[REASON] });
  assert.deepEqual(validateCrossField02('fhir_read', warningOnly), { ok: false, reason: 'INVALID_CROSS_FIELDS' }, 'warning without reason');
  // Inside execute, with the full validation context: dropping either half of the pair is refused as an internal error.
  const f = await fixture({ Observation: [obs('o-clean'), withheldObs('o-withheld')] }); t.after(f.close);
  for (const [label, corrupt] of [
    ['reason without warning', (env: GatewayEnvelope) => { env.warnings = env.warnings.filter(warning => warning.code !== REASON); }],
    ['warning without reason', (env: GatewayEnvelope) => { env.coverage.reasons = env.coverage.reasons.filter(reason => reason !== REASON); }],
  ] as const) {
    const corrupted = new FhirGateway({ mode: 'synthetic', source: { alias: 'w1', baseUrl: f.baseUrl }, patientId: A },
      { testEnvelopeCorruptor: (env, phase) => { if (phase === 'success') corrupt(env); } });
    try {
      const result = await corrupted.execute('fhir_search', { resource_type: 'Observation', output: { format: 'fhir' } });
      assert.equal(result.error?.code, 'INTERNAL_ERROR', label);
    } finally { corrupted.close(); }
  }
});

for (const era of ['modern', 'legacy'] as const) test(`A1/A2 stdio ${era}: partial coverage and whole-node redaction over the real SDK`, async t => {
  const f = await fixture({ DocumentReference: [doc('d-redacted'), doc('d-withheld', { author: [{ reference: 'not a reference!' }] }), doc('d-foreign', { author: [{ reference: `Patient/${B}`, display: SENT_DISPLAY }] })] });
  t.after(f.close);
  const dir = await mkdtemp(join(tmpdir(), 'w1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ mode: 'synthetic', source: { alias: 'w1', baseUrl: f.baseUrl }, patientId: A }));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'packages/server/src/cli.ts', '--config', config],
    env: { ...getDefaultEnvironment(), TMPDIR: tmpdir() }, stderr: 'pipe' });
  const client = new Client({ name: 'coverage-honesty', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  await client.connect(transport);
  t.after(() => client.close());
  const result = await client.callTool({ name: 'fhir_search', arguments: { resource_type: 'DocumentReference', output: { format: 'fhir', max_bytes: 24576 } } }) as { structuredContent?: GatewayEnvelope; content?: { text?: string }[] };
  const envelope = result.structuredContent!;
  assertWithheldSignal(envelope, era);
  assert.deepEqual(resources(envelope).map(resource => resource.id), ['d-redacted']);
  assert.deepEqual(resources(envelope)[0]!.author, []);
  assert.ok(envelope.transform.withheld_payloads.some(entry => entry.path === '/author/0' && entry.reason === 'UNVERIFIED_REFERENCE_WITHHELD'));
  const text = result.content?.[0]?.text ?? '';
  assert.ok(text.length > 0);
  assertNoSentinels(text, `${era} text`);
  assertNoSentinels(envelope, `${era} structured`);
});
