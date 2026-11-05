// W-05 private reflection seam. These are candidate preparations, not S5.7 closure.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { FhirGateway } from '../packages/core/src/index.js';
import { createMcpServer } from '../packages/server/src/index.js';
import { SERVER_IDENTITY } from '../packages/core/src/identity.js';
import { validateDeliverable02, type GatewayEnvelope02, type ToolName, type ValidationContext02 } from '../packages/core/src/contracts.js';
import { withSource } from './s53-r2-helpers.js';
import { WARNING_MESSAGES } from '../packages/core/src/catalog.js';
import { evidenceRender } from '../packages/core/src/delivery.js';
import { parseFhirJson, stringifyFhir, toWireValue } from '../packages/core/src/decimal.js';
import { GatewayFault } from '../packages/core/src/transport.js';

type Any = Record<string, any>;
const patient = 'synthetic-s56', context = 'ctx_s56';
const warning = 'TEST_ENVELOPE_CORRUPTOR_ACTIVE';
import type { GatewayTestOptions } from '../packages/core/src/delivery.js';

async function fixture(options: Any = {}) {
  const work = { metadata: 0, clinical: 0 }; let rows = options.rows ?? 3;
  const source = createServer((req, res) => {
    res.setHeader('content-type', 'application/fhir+json');
    if (req.url === '/fhir/metadata') {
      work.metadata++;
      options.onMetadata?.();
      const send = () => res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [
        { type: 'Patient', interaction: [{ code: 'read' }, { code: 'search-type' }] },
        { type: 'Observation', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [
          { name: 'subject', type: 'reference' }, { name: 'date', type: 'date' }, { name: 'code', type: 'token' } ] },
      ] }] }));
      if (options.metadataDelay) setTimeout(send, options.metadataDelay); else send(); return;
    }
    work.clinical++;
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const observation = (i: number) => ({ resourceType: 'Observation', id: `synthetic-o${i}`, meta: { versionId: '7' },
      ...(options.narrative ? { text: { status: 'generated', div: '<div>synthetic withheld narrative</div>' } } : {}),
      subject: { reference: `Patient/${patient}` }, status: 'final', code: { text: `Synthetic A1c ${options.dense ? 'x'.repeat(1100) : ''}` },
      effectiveDateTime: '2025-01-01T00:00:00Z', valueQuantity: { value: 7, unit: '%', system: 'http://unitsofmeasure.org', code: '%' } });
    if (/\/Observation\/synthetic-o\d+$/.test(url.pathname)) res.end(JSON.stringify(observation(Number(url.pathname.match(/o(\d+)$/)![1]))));
    else {
      const next = new URL(url); next.searchParams.set('_getpagesoffset', '1');
      res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href },
        ...(options.upstream && !url.searchParams.has('_getpagesoffset') ? [{ relation: 'next', url: next.href }] : [])],
        entry: Array.from({ length: rows }, (_, i) => ({ search: { mode: 'match' }, resource: observation(i) })) }));
    }
  });
  await new Promise<void>(r => source.listen(0, '127.0.0.1', r));
  const config: Any = { mode: 'synthetic', source: { alias: 'local', baseUrl: `http://127.0.0.1:${(source.address() as any).port}/fhir` },
    patientId: patient, contextId: context, limits: options.limits, discovery: options.discovery,
    ...(options.structured ? { delivery: { profile: 'structured-evidence-v1', hostProfileId: 's56-fixture' } } : {}) };
  const privateOptions: Any = { ...options.testOptions };
  if (options.structured) privateOptions.testDeliveryRegistryOverride = verifiedRegistry();
  const g = new FhirGateway(config as never, privateOptions as GatewayTestOptions), c = g as any;
  if (typeof c.execute !== 'function' || typeof c.isDeliverableV2 !== 'function') {
    g.close(); source.closeAllConnections(); await new Promise<void>(r => source.close(() => r()));
    assert.fail('S56 private candidate delivery pipeline exists');
  }
  const verdicts: Any[] = [], captures: ValidationContext02[] = [];
  const gate = c.isDeliverableV2.bind(g);
  c.isDeliverableV2 = (tool: ToolName, e: GatewayEnvelope02, capture: ValidationContext02) => {
    const v = gate(tool, e, capture); verdicts.push(v); captures.push(capture); return v;
  };
  return { g, c, work, captures, verdicts, setRows: (n: number) => { rows = n; },
    close: async () => { g.close(); source.closeAllConnections(); await new Promise<void>(r => source.close(() => r())); } };
}
function verifiedRegistry(): Any {
  return { profileId: 's56-fixture', entries: ['modern','legacy'].map(era => ({ id: 's56-fixture', version: '1',
    host: { name: 'synthetic', version: '0', client_stack: 'synthetic', client_stack_version: '0' },
    era, transport: 'stdio', workflow: 'recent-labs-v1', delivery_profile: 'structured-evidence-v1',
    verification: 'fixture_only' })) };
}
async function sdk(f: Awaited<ReturnType<typeof fixture>>, era: 'modern' | 'legacy') {
  // The production registration stays untouched; only this test-owned instance
  // routes its existing adapter callback to the private candidate methods.
  const toResult = f.g.toToolResult.bind(f.g);
  f.c.toToolResult = (e: GatewayEnvelope02) => { f.c.lastReturnedCapture = f.c.capturesV2.get(e); return toResult(e); };
  const [a,b] = InMemoryTransport.createLinkedPair(); const frames: Any[] = [];
  const send = b.send.bind(b); b.send = async (message, options) => { if ('result' in message) frames.push(message.result); return send(message, options); };
  const serving = serveStdio(() => createMcpServer(f.g, { era }), { transport: b });
  const client = new Client({ name: 's56-test', version: '0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  await client.connect(a);
  return { client, frames, call: async (name: ToolName, args: Any) => {
    const r = await client.callTool({ name, arguments: args }); const wire = frames.at(-1)!;
    const e = r.structuredContent as Any;
    assert.equal(Buffer.byteLength(JSON.stringify(wire)), e.budget.bytes_returned, 'complete actual SDK bytes');
    assert.ok(e.budget.bytes_returned <= e.budget.byte_limit);
    assert.equal(r.isError, e.error ? true : undefined);
    const original = f.c.lastReturnedCapture;
    if (original) assert.equal(JSON.stringify(wire), JSON.stringify(original.result), 'adapter returns the exact gated capture');
    return { r, wire, e };
  }, close: async () => { await client.close(); await serving.close(); } };
}
for (const era of ['modern','legacy'] as const) {
  test(`S56 ${era} candidate SDK five tools, strict captures and D12/D13 full-text preparation`, async () => {
    const f = await fixture({ dense: true, rows: 8 }); const s = await sdk(f, era);
    try {
      const search = await s.call('fhir_search', { resource_type: 'Observation', params: [{ name: 'date', value: 'ge2020' }, { name: 'date', value: 'lt2027' }], output: { max_bytes: 8192 } });
      assert.equal(search.e.error, undefined); assert.ok(!search.e.warnings.some((w: Any) => w.code === warning));
      assert.equal(search.e.transform.format, 'fhir'); assert.equal(search.e.transform.requested_format, undefined);
      assert.ok(search.e.result); assert.ok(search.e.pagination.next_cursor);
      const page = await s.call('fhir_page', { cursor: search.e.pagination.next_cursor, output: { max_bytes: 8192 } });
      assert.equal(page.e.error, undefined); assert.equal(f.captures.at(-1)!.query!.resourceType, 'Observation');
      assert.deepEqual(f.captures.at(-1)!.query!.orderedPairs.map(p => p.name), ['date','date','subject']);
      assert.equal(page.e.coverage.constraints_on_first_page, true);
      for (const action of ['inspect','project','page']) {
        const retained = await s.call('fhir_result', { handle: search.e.result.handle, action }); assert.equal(retained.e.error, undefined);
      }
      const read = await s.call('fhir_read', { resource_type: 'Observation', id: 'synthetic-o1' }); assert.equal(read.e.error, undefined);
      for (const topic of ['server','resource','context','schema','search_parameter','support']) {
        const cap = await s.call('fhir_capabilities', { topic, ...(['resource','schema','search_parameter'].includes(topic) ? { resource_type: 'Observation' } : {}) });
        assert.equal(cap.e.error, undefined, topic);
      }
      for (const capture of f.captures) {
        assert.ok(Object.isFrozen(capture)); assert.ok(Object.isFrozen(capture.result)); assert.ok(Object.isFrozen(capture.result.structuredContent));
        assert.ok(Object.isFrozen(capture.binding)); assert.equal(capture.era, era); assert.deepEqual(capture.serverIdentity, SERVER_IDENTITY);
        assert.deepEqual(validateDeliverable02((capture.topic ? 'fhir_capabilities' : capture.action ? 'fhir_result' : capture.readTarget ? 'fhir_read' : 'fhir_page'), capture.result.structuredContent, capture), { ok: true });
      }
      assert.ok(f.verdicts.every(v => v.ok)); assert.equal(f.work.metadata, 1);
    } finally { await s.close(); await f.close(); }
  });
  test(`S56 ${era} fitted SDK faults, input bindings, expiry repairs and zero work controls`, async () => {
    const f = await fixture(); const s = await sdk(f, era);
    try {
      const cases: [ToolName, Any, string, Any?][] = [
        ['fhir_search', { resource_type: 'Observation', source: 'other' }, 'POLICY_DENIED'],
        ['fhir_read', { resource_type: 'Observation', id: 'synthetic-o1', context_handle: 'other' }, 'CONTEXT_REQUIRED', { action: 'use_current_context' }],
        ['fhir_search', { resource_type: 'Observation', injected: true, output: { max_bytes: 4096 } }, 'INVALID_ARGUMENTS'],
        ['fhir_search', { resource_type: 'Observation', output: { max_bytes: 1024 } }, 'INVALID_ARGUMENTS'],
        ['fhir_capabilities', { topic: 'support', cursor: 'cur_unknown' }, 'DISCOVERY_EXPIRED', { action: 'repeat_original_query', tool: 'fhir_capabilities' }],
        ['fhir_result', { handle: 'res_unknown' }, 'RESULT_EXPIRED', { action: 'repeat_original_query' }],
      ];
      for (const [name,args,code,repair] of cases) {
        const { e } = await s.call(name,args); assert.equal(e.error.code, code); assert.deepEqual(e.warnings, []);
        assert.deepEqual(e.error.repair, repair); assert.deepEqual(e.data, {});
        if (code === 'POLICY_DENIED') assert.equal(e.error.safe_message, 'Source is not available to this workload.');
        if (code === 'CONTEXT_REQUIRED') assert.equal(e.error.safe_message, 'Context does not match the trusted configured patient.');
      }
      assert.deepEqual(f.work, { metadata: 0, clinical: 0 });
      const good = await s.call('fhir_read', { resource_type: 'Observation', id: 'synthetic-o1' }); assert.equal(good.e.error, undefined);
      assert.deepEqual(f.work, { metadata: 1, clinical: 1 });
      const unsupported = await s.call('fhir_capabilities', { topic: 'resource', resource_type: 'Encounter' });
      assert.equal(unsupported.e.error.code, 'UNSUPPORTED_RESOURCE');
      assert.deepEqual(unsupported.e.error.repair, { action: 'choose_supported_resource', tool: 'fhir_capabilities' });
      assert.deepEqual(unsupported.e.warnings, []); assert.equal(unsupported.e.budget.upstream_calls, 0);
      assert.deepEqual(f.work, { metadata: 1, clinical: 1 });
    } finally { await s.close(); await f.close(); }
  });
  test(`S56 ${era} discovery continuation captures stored resource type before rendering`, async () => {
    const f = await fixture(); const s = await sdk(f, era);
    try {
      const first = await s.call('fhir_capabilities', { topic: 'search_parameter', resource_type: 'Observation', limit: 1 });
      assert.ok(first.e.data.next_cursor);
      const next = await s.call('fhir_capabilities', { topic: 'search_parameter', cursor: first.e.data.next_cursor, limit: 1 });
      assert.equal(next.e.error, undefined); assert.equal(f.captures.at(-1)!.resourceType, 'Observation');
      assert.equal(f.work.metadata, 1);
    } finally { await s.close(); await f.close(); }
  });
  for (const kind of ['count','bytes','request','cycle','nonjson','shape'] as const) test(`S56 ${era} post-capture ${kind} corruption has exact diagnostic and clean fitted fallback`, async () => {
    const expected = { count: 'INVALID_CROSS_FIELDS', bytes: 'INVALID_FINAL_BYTES', request: 'VALIDATION_CONTEXT_MISMATCH', shape: 'INVALID_SHAPE' };
    const f = await fixture({ testOptions: { testEnvelopeCorruptor: (e: Any, phase: string) => {
      if (phase !== 'success') return;
      if (kind === 'count') e.pagination.returned_matches++;
      if (kind === 'bytes') e.budget.bytes_returned--;
      if (kind === 'request') e.request_id = (e.request_id[0] === 'a' ? 'b' : 'a') + e.request_id.slice(1);
      if (kind === 'cycle') e.data.loop = e;
      if (kind === 'nonjson') e.data.bad = () => 0;
      if (kind === 'shape') e.transform.delivery_profile = 'unrecognized';
    } } });
    const s = await sdk(f, era);
    try {
      const { e } = await s.call('fhir_search', { resource_type: 'Observation' });
      assert.equal(e.error.code, 'INTERNAL_ERROR'); assert.deepEqual(e.warnings, []);
      assert.equal(f.c.store.size, 0); assert.equal(f.c.discoveryStore.size, 0);
      if (kind in expected) assert.deepEqual(f.verdicts[0], { ok: false, reason: expected[kind as keyof typeof expected] });
      const capture = f.captures[0];
      if (capture) assert.deepEqual(validateDeliverable02('fhir_search', capture.result.structuredContent, capture), { ok: true }, 'uncorrupted control');
    } finally { await s.close(); await f.close(); }
  });
  test(`S56 ${era} broken renderer emergency is independent and errors have no warning`, async () => {
    const f = await fixture(); const s = await sdk(f, era);
    try {
      f.c.bytesV2 = () => { throw new Error('synthetic render fault'); };
      const { e } = await s.call('fhir_search', { resource_type: 'Observation' });
      assert.equal(e.error.code, 'INTERNAL_ERROR'); assert.deepEqual(e.warnings, []);
      assert.equal(f.c.store.size, 0);
    } finally { await s.close(); await f.close(); }
  });
}

for (const era of ['modern','legacy'] as const) {
  test(`D${era === 'modern' ? '12' : '13'} S56 real-SDK slim text and D14 whole-result fallback ${era}`, async () => {
    const f = await fixture({ structured: true }); const s = await sdk(f, era);
    try {
      const { e, r } = await s.call('fhir_search', { resource_type: 'Observation', output: { format: 'compact', max_bytes: 4096 } });
      assert.equal(e.error, undefined); assert.equal(e.transform.delivery_profile, 'structured-evidence-v1');
      assert.ok(e.warnings.some((w: Any) => w.code === 'UNVERIFIED_DELIVERY_PROFILE'));
      assert.match((r.content as Any[])[0]!.text, /^delivery_profile: "structured-evidence-v1"\n/);
      assert.match((r.content as Any[])[0]!.text, /value=7/);
      assert.equal(e.budget.byte_limit, 4096); assert.ok(e.data.resources.length >= 1); assert.equal(e.provenance.length, e.data.resources.length);
      assert.equal(e.data.resources[0].valueQuantity.value, 7); assert.equal(e.data.resources[0].meta.versionId, '7');
      for (const topic of ['server','resource','context','schema','search_parameter','support']) {
      const { e: fallback, r: fr } = await s.call('fhir_capabilities', { topic, ...(['resource','schema','search_parameter'].includes(topic) ? { resource_type: 'Observation' } : {}), output: { max_bytes: topic === 'context' ? 4096 : 24576 } });
      assert.equal(fallback.error, undefined); assert.equal(fallback.transform.delivery_profile, 'full-text-v1');
      assert.match((fr.content as Any[])[0]!.text, /^delivery_profile: "full-text-v1"\n/);
      assert.match((fr.content as Any[])[0]!.text, /"delivery_profile":"full-text-v1"/);
      assert.ok(f.verdicts.every(v => v.ok));
      assert.doesNotMatch((fr.content as Any[])[0]!.text, /(?:^|\n)(?:record source=|retained_resource_count:)/);
      }
      // Both profiles use the complete era-specific SDK result, including metadata.
      assert.equal(f.captures[0]!.result.resultType, era === 'modern' ? 'complete' : undefined);
      assert.equal(f.captures[1]!.deliveryProfile, 'full-text-v1');
    } finally { await s.close(); await f.close(); }
  });
  test(`S56 ${era} candidate error corruption is discarded by the emergency gate`, async () => {
    const f = await fixture({ testOptions: { testEnvelopeCorruptor: (e: Any, phase: string) => {
      if (phase === 'error') { e.data = { resources: [] }; }
    } } }); const s = await sdk(f, era);
    try {
      const { e } = await s.call('fhir_page', { cursor: 'cur_missing' });
      assert.equal(e.error.code, 'INTERNAL_ERROR'); assert.deepEqual(e.data, {}); assert.deepEqual(e.warnings, []);
      assert.deepEqual(f.verdicts, [{ ok: false, reason: 'INVALID_CROSS_FIELDS' }]);
    } finally { await s.close(); await f.close(); }
  });
  test(`S56 ${era} candidate adapter forwards SDK cancellation signal`, async () => {
    const f = await fixture(); const s = await sdk(f, era);
    let signal: AbortSignal | undefined;
    const execute = f.c.execute.bind(f.g);
    f.c.execute = (tool: ToolName, args: unknown, options: Any) => { signal = options.signal; return execute(tool,args,options); };
    try {
      const good = await s.call('fhir_search', { resource_type: 'Observation' }); assert.equal(good.e.error, undefined);
      assert.ok(signal instanceof AbortSignal, 'SDK cancellation reaches candidate execute');
      const cancelled = await f.c.execute('fhir_search', { resource_type: 'Observation' }, { era, signal: AbortSignal.abort() });
      assert.equal(cancelled.error.code, 'REQUEST_CANCELLED'); assert.deepEqual(cancelled.warnings, []);
      assert.equal(f.work.clinical, 1);
    } finally { await s.close(); await f.close(); }
  });
}

test('S56 direct calls default modern and a modern-only profile never upgrades a legacy call', async () => {
  const f = await fixture({ structured: true });
  try {
    f.c.testOptions.testDeliveryRegistryOverride.entries = f.c.testOptions.testDeliveryRegistryOverride.entries.filter((e: Any) => e.era === 'modern');
    const modern = await f.c.execute('fhir_search', { resource_type: 'Observation' });
    assert.equal(modern.error, undefined); assert.equal(f.captures.at(-1)!.era, 'modern');
    assert.equal(modern.transform.delivery_profile, 'structured-evidence-v1');
    const legacy = await f.c.execute('fhir_search', { resource_type: 'Observation' }, { era: 'legacy' });
    assert.equal(legacy.error, undefined); assert.equal(legacy.transform.delivery_profile, 'full-text-v1');
    const result = f.c.toToolResult(legacy); assert.equal(result.content[0].text, stringifyFhir(legacy));
  } finally { await f.close(); }
});

for (const era of ['modern','legacy'] as const) test(`S56 ${era} gate failure rolls back discovery eviction and preserves clinical reservations`, async () => {
  let corrupt = false;
  const f = await fixture({ discovery: { maxHandles: 1 }, testOptions: { testEnvelopeCorruptor: (e: Any, phase: string) => {
    if (corrupt && phase === 'success') e.request_id = (e.request_id[0] === 'a' ? 'b' : 'a') + e.request_id.slice(1);
  } } }); const s = await sdk(f, era);
  try {
    const clinical = await s.call('fhir_search', { resource_type: 'Observation' }); assert.equal(clinical.e.error, undefined);
    const first = await s.call('fhir_capabilities', { topic: 'search_parameter', resource_type: 'Observation', limit: 1 });
    const handle = first.e.data.next_cursor; assert.ok(handle);
    const bytes = f.c.retentionLedger.usedBytes();
    const clinicalSize = f.c.store.size;
    let evicted = false;
    const put = f.c.discoveryStore.putBatch.bind(f.c.discoveryStore);
    f.c.discoveryStore.putBatch = (...args: any[]) => {
      const result = put(...args);
      try { f.c.discoveryStore.get(handle); } catch { evicted = true; }
      return result;
    };
    corrupt = true;
    const failed = await s.call('fhir_capabilities', { topic: 'search_parameter', resource_type: 'Observation', limit: 1 });
    assert.equal(failed.e.error.code, 'INTERNAL_ERROR'); assert.equal(evicted, true, 'real discovery eviction occurred before failed gate');
    assert.equal(f.c.discoveryStore.size, 1); assert.equal(f.c.store.size, clinicalSize);
    assert.equal(f.c.retentionLedger.usedBytes(), bytes);
    assert.ok(f.c.discoveryStore.get(handle)); assert.ok(f.c.store.get(clinical.e.result.handle));
    corrupt = false;
    const replay = await s.call('fhir_capabilities', { topic: 'search_parameter', cursor: handle, limit: 1 });
    assert.equal(replay.e.error, undefined);
  } finally { await s.close(); await f.close(); }
});

test('S56 constructor validates v2 emergencies for both eras and both requested profiles', () => {
  const proto = FhirGateway.prototype as Any, original = proto.makeEmergencyEnvelopeV2;
  const seen: string[] = [];
  proto.makeEmergencyEnvelopeV2 = function (...args: any[]) { seen.push(`${args[5].era}/${args[5].profile}`); return original.apply(this,args); };
  const config = { mode: 'synthetic' as const, source: { alias: 'local', baseUrl: 'http://127.0.0.1:9/fhir' }, patientId: patient };
  try { const g = new FhirGateway(config); g.close(); }
  finally { proto.makeEmergencyEnvelopeV2 = original; }
  assert.deepEqual(seen, ['modern/full-text-v1','modern/structured-evidence-v1','legacy/full-text-v1','legacy/structured-evidence-v1']);
  for (const target of seen) {
    proto.makeEmergencyEnvelopeV2 = function (...args: any[]) {
      const e = original.apply(this,args);
      if (`${args[5].era}/${args[5].profile}` === target) e.warnings = [{ code: warning, message: 'synthetic-invalid' }];
      return e;
    };
    try { assert.throws(() => new FhirGateway(config), { code: 'INVALID_CONFIG' }); }
    finally { proto.makeEmergencyEnvelopeV2 = original; }
  }
});

for (const era of ['modern','legacy'] as const) for (const drop of ['structuredContent','schema_version'] as const) {
  test(`S56 ${era} isolated post-gate client negative control ${drop}`, async () => {
    const f = await fixture(); const [a,b] = InMemoryTransport.createLinkedPair();
    f.c.execute = f.c.execute.bind(f.g); f.c.toToolResult = f.c.toToolResult.bind(f.g);
    const send = b.send.bind(b);
    b.send = async (message, options) => {
      const result = (message as Any).result;
      if (result?.content) {
        // Clone only after the gate. Production capture remains frozen and valid.
        message = structuredClone(message);
        const corrupted = (message as Any).result;
        if (drop === 'structuredContent') delete corrupted.structuredContent;
        else delete corrupted.structuredContent.schema_version;
      }
      return send(message, options);
    };
    const serving = serveStdio(() => createMcpServer(f.g,{ era }), { transport: b });
    const client = new Client({ name: 's56-negative', version: '0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
    try {
      await client.connect(a); await client.listTools();
      await assert.rejects(client.callTool({ name: 'fhir_search', arguments: { resource_type: 'Observation' } }), { code: drop === 'structuredContent' ? -32600 : -32602 });
      assert.deepEqual(f.verdicts, [{ ok: true }]);
    } finally { await client.close(); await serving.close(); await f.close(); }
  });
}

for (const change of ['auth','state','cancel'] as const) test(`S56 final ${change} check refuses stale rendered state before committing`, async () => {
  const controller = new AbortController();
  const f = await fixture({ testOptions: { testEnvelopeCorruptor: (_e: Any, phase: string) => {
    if (change === 'cancel' && phase === 'success') controller.abort();
  } } });
  const render = f.c.renderV2.bind(f.g);
  f.c.renderV2 = (...args: any[]) => {
    const e = render(...args);
    if (change === 'auth') f.c.authEpoch++;
    if (change === 'state') f.c.stateGeneration++;
    return e;
  };
  try {
    const e = await f.c.execute('fhir_search', { resource_type: 'Observation' }, { signal: controller.signal });
    assert.equal(e.error.code, change === 'cancel' ? 'REQUEST_CANCELLED' : 'CONNECTION_REQUIRED');
    assert.equal(f.c.store.size, 0); assert.equal(f.c.discoveryStore.size, 0);
    assert.deepEqual(e.warnings, []);
  } finally { await f.close(); }
});

test('S56 capture is made once after fitting, frozen deeply, and actual adapter delivery never rerenders', async () => {
  const f = await fixture(); let captures = 0;
  const capture = f.c.captureV2.bind(f.g);
  f.c.captureV2 = (...args: any[]) => { captures++; return capture(...args); };
  try {
    const e = await f.c.execute('fhir_search', { resource_type: 'Observation' }); assert.equal(e.error, undefined);
    assert.equal(captures, 1);
    const c = f.c.capturesV2.get(e) as ValidationContext02;
    assert.ok(Object.isFrozen(c.query)); assert.ok(Object.isFrozen(c.query!.orderedPairs));
    assert.ok(Object.isFrozen((c.result.structuredContent as Any).data.resources));
    assert.throws(() => { ((c.result.structuredContent as Any).data.resources[0]).status = 'changed'; }, TypeError);
    const serialized = JSON.stringify(f.c.toToolResult(e));
    f.c.sdkResultV2 = () => { throw new Error('adapter must use original capture'); };
    assert.equal(JSON.stringify(f.c.toToolResult(e)), serialized);
    assert.equal(captures, 1);
  } finally { await f.close(); }
});

test('S56 renderer cannot replace the trusted original query with a coherent new digest', async () => {
  const { createHash } = await import('node:crypto');
  const f = await fixture(); const render = f.c.renderV2.bind(f.g);
  f.c.renderV2 = (...args: any[]) => {
    const e = render(...args);
    const constraints = e.coverage.constraints.map((p: Any) => ({ ...p, ...(p.name === 'date' ? { value: 'ge2021' } : {}) }));
    e.coverage.constraints = constraints;
    e.coverage.query_digest = createHash('sha256').update(JSON.stringify({ v: 1, source_revision: f.c.capabilityRevision,
      policy_revision: f.c.policyRevision, context_handle: context, resource_type: 'Observation',
      constraints: constraints.map(({ name, value }: Any) => ({ name, value })), sort: [] })).digest('hex');
    return e;
  };
  try {
    const e = await f.c.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'date', value: 'ge2020' }] });
    assert.equal(e.error.code, 'INTERNAL_ERROR');
    assert.deepEqual(f.verdicts[0], { ok: false, reason: 'VALIDATION_CONTEXT_MISMATCH' });
    assert.equal(f.captures[0]!.query!.orderedPairs[0]!.value, 'ge2020');
    assert.equal(f.c.store.size, 0);
  } finally { await f.close(); }
});

test('S56 clinical gate failure restores discovery evictions made inside the delivery window', async () => {
  let corrupt = false;
  const f = await fixture({ discovery: { maxHandles: 1 }, testOptions: { testEnvelopeCorruptor: (e: Any, phase: string) => {
    if (corrupt && phase === 'success') e.request_id = (e.request_id[0] === 'a' ? 'b' : 'a') + e.request_id.slice(1);
  } } });
  try {
    const metadata = await f.c.execute('fhir_capabilities', { topic: 'search_parameter', resource_type: 'Observation', limit: 1 });
    const handle = metadata.data.next_cursor; assert.ok(handle);
    const snapshot = f.c.discoveryStore.get(handle).value;
    const before = f.c.retentionLedger.usedBytes();
    const render = f.c.renderV2.bind(f.g);
    let evicted = false;
    f.c.renderV2 = (...args: any[]) => {
      const e = render(...args);
      f.c.discoveryStore.putBatch([{ prefix: 'cur', value: { ...snapshot, offset: 2 } }]);
      try { f.c.discoveryStore.get(handle); } catch { evicted = true; }
      return e;
    };
    corrupt = true;
    const error = await f.c.execute('fhir_search', { resource_type: 'Observation' });
    assert.equal(error.error.code, 'INTERNAL_ERROR'); assert.equal(evicted, true);
    assert.equal(f.c.store.size, 0); assert.equal(f.c.discoveryStore.size, 1);
    assert.deepEqual(f.c.discoveryStore.get(handle).value, snapshot);
    assert.equal(f.c.retentionLedger.usedBytes(), before);
  } finally { await f.close(); }
});

for (const era of ['modern','legacy'] as const) test(`S56 ${era} upstream page preserves frozen query binding through shared load`, async () => {
  const f = await fixture({ rows: 1, upstream: true }); const s = await sdk(f, era);
  try {
    const initial = await s.call('fhir_search', { resource_type: 'Observation' });
    const cursor = initial.e.pagination.next_cursor; assert.ok(cursor);
    const original = f.c.store.get(cursor).value.queryBinding; assert.ok(original);
    const next = await s.call('fhir_page', { cursor });
    assert.equal(next.e.error, undefined); assert.equal(f.work.clinical, 2);
    assert.deepEqual(f.c.store.get(cursor).value.queryBinding, original);
    assert.equal(f.captures.at(-1)!.query!.sourceRevision, original.sourceRevision);
    assert.equal(f.captures.at(-1)!.query!.policyRevision, original.policyRevision);
    assert.equal(f.captures.at(-1)!.query!.contextHandle, original.contextHandle);
  } finally { await s.close(); await f.close(); }
});

for (const era of ['modern','legacy'] as const) test(`S56 ${era} A2 narrative omission is derived from the delivered sanitized records`, async () => {
  const f = await fixture({ narrative: true }); const s = await sdk(f, era);
  try {
    const { e, wire } = await s.call('fhir_search', { resource_type: 'Observation' });
    assert.equal(e.error, undefined);
    assert.equal(e.transform.narrative_omitted, true);
    assert.ok(e.transform.omitted_fields.includes('/text'));
    assert.ok(!JSON.stringify(wire).includes('synthetic withheld narrative'));
    assert.equal(e.data.resources.length, e.provenance.length);
  } finally { await s.close(); await f.close(); }
});

for (const era of ['modern','legacy'] as const) test(`S56 ${era} six canonical SDK refusals use trusted total-work wording`, async () => {
  const { REFUSAL_MESSAGES, MODIFIER_NO_CLINICAL_MESSAGE } = await import('../packages/core/src/catalog.js');
  const f = await fixture(); const s = await sdk(f, era);
  try {
    const cases: [ToolName, Any, keyof typeof REFUSAL_MESSAGES][] = [
      ['fhir_capabilities',{ topic: 'invented' },'invalid_topic'],
      ['fhir_search',{ resource_type: 'Observation', output: { format: 'summary' } },'invalid_format'],
      ['fhir_read',{ resource_type: 'Observation', id: 'synthetic-o0', interaction: 'vread' },'invalid_interaction'],
      ['fhir_result',{ handle: 'res_missing', action: 'invented' },'invalid_action'],
      ['fhir_result',{ handle: 'res_missing' },'expired_result'],
    ];
    for (const [name, args, key] of cases) {
      const { e } = await s.call(name,args);
      assert.equal(e.error.safe_message,REFUSAL_MESSAGES[key]);
      assert.equal(e.budget.upstream_calls,0); assert.deepEqual(e.warnings,[]);
    }
    const args = { resource_type: 'Observation', params: [{ name: 'code:text', value: 'synthetic' }] };
    const first = await s.call('fhir_search',args);
    assert.equal(first.e.error.code,'UNSUPPORTED_MODIFIER'); assert.equal(first.e.budget.upstream_calls,1);
    assert.equal(first.e.error.safe_message,MODIFIER_NO_CLINICAL_MESSAGE);
    const cached = await s.call('fhir_search',args);
    assert.equal(cached.e.error.safe_message,REFUSAL_MESSAGES.unsupported_modifier);
    assert.equal(cached.e.budget.upstream_calls,0);
    assert.deepEqual(f.work,{ metadata: 1, clinical: 0 });
    const denied = await s.call('fhir_search',{ resource_type: 'Observation', source: 'other' });
    assert.equal(denied.e.error.code,'POLICY_DENIED'); assert.equal(f.g.auditEvents.at(-1)!.outcome,'denied');
  } finally { await s.close(); await f.close(); }
});

// S5.6 review fix round: independent authorities and changed-evidence controls.
for (const era of ['modern','legacy'] as const) {
  test(`S56 R01 ${era} 0.1 structured metadata uses trusted invocation for all topics`, async () => {
    const f = await fixture({ structured: true });
    try {
      for (const topic of ['server','resource','context','schema','search_parameter','support']) {
        const args = { topic, ...(['resource','schema','search_parameter'].includes(topic) ? { resource_type:'Observation' } : {}) };
        const candidate = await f.c.capabilitiesV2(args, { era, profile:'structured-evidence-v1' });
        assert.equal(candidate.error, undefined);
        assert.equal(candidate.transform.delivery_profile, 'full-text-v1', 'the metadata handler supplies its own trusted tool even without execute');
        // 0.1 implements only the original four topics; the other two are admitted
        // faults and must also avoid clinical/inspection text.
        const e = await f.g.execute('fhir_capabilities', { topic, ...(['resource','schema','search_parameter'].includes(topic) ? { resource_type:'Observation' } : {}) }, { era });
        const text = f.g.toToolResult(e).content[0]!.text!;
        assert.doesNotMatch(text, /(?:^|\n)(?:record source=|retained_resource_count:)/);
        if (!e.error) { assert.match(text, /^delivery_profile: "full-text-v1"\n/); assert.ok(text.includes(JSON.stringify(e))); }
      }
    } finally { await f.close(); }
  });
  test(`S56 R03 ${era} downgraded continuation requires full evidence`, async () => {
    await withSource({ pages:3, perPage:[1,1,1], profile:true, opaque:true }, async (_g,c) => {
      const captures: Any[] = []; const gate = c.isDeliverableV2.bind(c);
      c.isDeliverableV2 = (t: ToolName,e: Any,cap: Any) => { captures.push(cap); return gate(t,e,cap); };
      const first = await c.execute('fhir_search', { resource_type:'Observation', params:[{name:'code',value:'http://loinc.org|4548-4'}], page_size:1 }, { era });
      assert.equal(first.error,undefined); assert.equal(first.coverage.constraints.find((x: Any) => x.name==='code').execution,'tested_adapter');
      const page = await c.execute('fhir_page', {cursor:first.pagination.next_cursor}, {era});
      assert.equal(page.error,undefined); assert.equal(page.coverage.constraints_on_first_page,undefined);
      assert.equal(page.coverage.constraints.find((x: Any) => x.name==='code').execution,'unknown');
      const cap = captures.at(-1)! as ValidationContext02; assert.equal(cap.query!.fullEvidenceRequired,true);
      const bad = structuredClone(toWireValue(page)) as Any;
      delete bad.coverage.constraints; if (bad.coverage.sort) delete bad.coverage.sort.requested;
      bad.coverage.constraints_on_first_page = true;
      assert.deepEqual(validateDeliverable02('fhir_page',bad,cap), {ok:false,reason:'INVALID_CROSS_FIELDS'});
    });
  });
  test(`S56 R04 ${era} nested non-JSON FHIR leaf cannot commit`, async () => {
    const f = await fixture({ testOptions:{testEnvelopeCorruptor:(e: Any,phase:string) => { if(phase==='success') e.data.resources[0].fn=()=>0; }} });
    try { const e=await f.c.execute('fhir_search',{resource_type:'Observation'},{era}); assert.equal(e.error.code,'INTERNAL_ERROR'); assert.equal(f.c.store.size,0); }
    finally { await f.close(); }
  });
  for (const field of ['sort','readTarget'] as const) test(`S56 R04 ${era} renderer cannot replace trusted ${field}`, async () => {
    const {createHash}=await import('node:crypto'); const f=await fixture(); const render=f.c.renderV2.bind(f.c);
    f.c.renderV2=(...args:any[])=>{ const e=render(...args);
      if(field==='readTarget') e.data.resources[0].id='synthetic-other';
      else {
        e.coverage.sort={order:'requested_unverified',evidence:'unknown',effective:null,requested:['-date']};
        e.warnings.push({code:'ORDER_UNVERIFIED',message:WARNING_MESSAGES.ORDER_UNVERIFIED});
        e.coverage.query_digest=createHash('sha256').update(JSON.stringify({v:1,source_revision:f.c.capabilityRevision,policy_revision:f.c.policyRevision,context_handle:context,resource_type:'Observation',constraints:e.coverage.constraints.map(({name,value}:Any)=>({name,value})),sort:['-date']})).digest('hex');
      } return e; };
    try { const e=await f.c.execute(field==='readTarget'?'fhir_read':'fhir_search',field==='readTarget'?{resource_type:'Observation',id:'synthetic-o1'}:{resource_type:'Observation'},{era});
      assert.equal(e.error.code,'INTERNAL_ERROR'); assert.equal(f.c.store.size,0);
      assert.deepEqual(f.verdicts[0],{ok:false,reason:'VALIDATION_CONTEXT_MISMATCH'});
      if(field==='readTarget') assert.equal(f.captures[0]!.readTarget!.id,'synthetic-o1'); else assert.deepEqual(f.captures[0]!.query!.sort,[]);
    } finally { await f.close(); }
  });
  test(`S56 R04 ${era} chain delivery prevents terminal NO_MATCHES`, async () => {
    await withSource({pages:2,perPage:[1,0],profile:true},async(_g,c)=>{
      const gate=c.isDeliverableV2.bind(c); let captured:ValidationContext02 = undefined as never;
      c.isDeliverableV2=(t:ToolName,e:Any,cap:ValidationContext02)=>{captured=cap;return gate(t,e,cap);};
      const first=await c.execute('fhir_search',{resource_type:'Observation',params:[{name:'code',value:'http://loinc.org|4548-4'}]},{era});
      const page=await c.execute('fhir_page',{cursor:first.pagination.next_cursor},{era});
      assert.equal(page.error,undefined); assert.ok(captured.chainDeliveredCount!>0);
      assert.ok(!page.warnings.some((w:Any)=>w.code==='NO_MATCHES'));
      const bad=structuredClone(toWireValue(page)) as Any; bad.warnings.push({code:'NO_MATCHES',message:WARNING_MESSAGES.NO_MATCHES});
      assert.deepEqual(validateDeliverable02('fhir_page',bad,captured),{ok:false,reason:'INVALID_CROSS_FIELDS'});
    });
  });
  test(`S56 R04 ${era} admission is deeply frozen before pipeline dispatch`, async()=>{
    const f=await fixture(); const render=f.c.renderV2.bind(f.c); let checked=false;
    f.c.renderV2=(snapshot:Any,admission:Any,...rest:any[])=>{
      checked=true; assert.ok(Object.isFrozen(admission)); assert.ok(Object.isFrozen(admission.input));
      assert.ok(Object.isFrozen(admission.input.params)); assert.ok(Object.isFrozen(admission.input.params[0]));
      return render(snapshot,admission,...rest);
    };
    try { const e=await f.c.execute('fhir_search',{resource_type:'Observation',params:[{name:'date',value:'ge2020'}]},{era}); assert.equal(e.error,undefined); assert.ok(checked); }
    finally {await f.close();}
  });
  for (const broken of ['sdkResultV2','bytesV2','captureV2']) test(`S56 R05 ${era} emergency never calls normal ${broken}`,async()=>{
    const f=await fixture();
    try {
      f.c[broken]=()=>{throw new Error('synthetic normal pipeline failure');};
      const e=await f.c.execute('fhir_search',{resource_type:'Observation'},{era});
      assert.equal(e.error.code,'INTERNAL_ERROR');assert.deepEqual(e.warnings,[]);assert.equal(f.c.store.size,0);
      // Once the normal pipeline has failed, none of its helpers can be used
      // even if failure originated in another helper.
      for(const name of ['sdkResultV2','bytesV2','captureV2']) f.c[name]=()=>{assert.fail('normal helper entered from emergency');};
      const inv=f.c.invocationV2(undefined,24576);
      const clean=f.c.emergencyDeliveryV2('fhir_search',24576,0,0,{era,profile:'full-text-v1'},undefined,inv);
      assert.equal(clean.env.error.code,'INTERNAL_ERROR');
      assert.deepEqual(validateDeliverable02('fhir_search',toWireValue(clean.env),clean.capture),{ok:true});
    }finally{await f.close();}
  });
  test(`S56 R06 ${era} discovery shares stats and cancellation budget`,async()=>{
    let abort:AbortController|undefined;
    const f=await fixture({metadataDelay:150,onMetadata:()=>abort?.abort()});
    try{
      const first=await f.c.execute('fhir_capabilities',{topic:'server'},{era});assert.equal(first.error,undefined);
      assert.equal(first.budget.upstream_calls,1);assert.equal(f.work.metadata,1);assert.equal(f.work.clinical,0);
      f.c.metadataExpiresAt=0;abort=new AbortController();
      let completed=false;const discover=f.c.discover.bind(f.c);
      f.c.discover=async(...args:any[])=>{await discover(...args);completed=true;};
      const cancelled=await f.c.execute('fhir_capabilities',{topic:'server'},{era,signal:abort.signal});
      assert.equal(cancelled.error.code,'REQUEST_CANCELLED');assert.equal(completed,false,'cancellation returns before metadata completion');
      assert.equal(f.work.clinical,0);assert.equal(f.c.discoveryStore.size,0);
    }finally{await f.close();}
  });
  for(const tool of ['fhir_search','fhir_read']) test(`S56 R06 ${era} ${tool} refusal guard counts clinical work`,async()=>{
    const f=await fixture();const get=f.c.transport.get.bind(f.c.transport);
    f.c.transport.get=async(url:URL,...rest:any[])=>{ if(!url.pathname.endsWith('/metadata')) throw new GatewayFault('UNSUPPORTED_MODIFIER','synthetic late fault'); return get(url,...rest); };
    try{const e=await f.c.execute(tool,{resource_type:'Observation',...(tool==='fhir_read'?{id:'synthetic-o1'}:{})},{era});
      assert.equal(e.error.code,'INTERNAL_ERROR');assert.doesNotMatch(e.error.safe_message,/No clinical request was sent/);
    }finally{await f.close();}
  });
  test(`S56 R07 ${era} unknown direct tool throws before any pipeline side effect; SDK rejects at protocol`,async()=>{
    const f=await fixture();const s=await sdk(f,era);
    try{
      for(const name of ['admitV2','admit','invocationV2','emergencyDeliveryV2']) f.c[name]=()=>assert.fail('unknown tool entered pipeline');
      await assert.rejects(f.c.execute('fhir_bogus',{}, {era}), (e:unknown)=>e instanceof GatewayFault && e.code==='UNKNOWN_TOOL' && e.message==='Tool is not implemented in this prototype.');
      await assert.rejects(s.client.callTool({name:'fhir_bogus',arguments:{}}),(e:Any)=>e.code===-32602);
      assert.deepEqual(f.work,{metadata:0,clinical:0});assert.equal(f.c.store.size,0);assert.equal(f.c.discoveryStore.size,0);
      assert.equal(f.g.auditEvents.length,0);assert.equal(f.captures.length,0);
    }finally{await s.close();await f.close();}
  });
  test(`S56 R02 ${era} slow metadata fits at exact pre-elapsed edge`,async()=>{
    const f=await fixture(); const now=Date.now; let offset=0;
    try{
      const first=await f.c.execute('fhir_capabilities',{topic:'search_parameter',resource_type:'Observation'},{era});assert.equal(first.error,undefined);
      // The full three-row result is the exact limit before finish stamps a
      // four-digit elapsed value. Headroom must force a smaller safe page.
      const limit=first.budget.bytes_returned;
      const discover=f.c.discover.bind(f.c);
      f.c.discover=async(...args:any[])=>{await discover(...args);offset=1000;};
      Date.now=()=>now()+offset;
      const e=await f.c.execute('fhir_capabilities',{topic:'search_parameter',resource_type:'Observation',output:{max_bytes:limit}},{era});
      assert.equal(e.error,undefined);assert.ok(e.budget.elapsed_ms>=1000);assert.ok(e.budget.bytes_returned<=limit);
      assert.ok(e.data.search_parameters.length>0);assert.ok(e.data.search_parameters.length<first.data.search_parameters.length);
    }finally{Date.now=now;await f.close();}
  });
}

for(const era of ['modern','legacy'] as const) test(`S56 R05 ${era} runtime emergency must be freshly gated`,async()=>{
  const f=await fixture(); const emergency=f.c.makeEmergencyEnvelopeV2.bind(f.c);
  try{
    f.c.bytesV2=()=>{throw new Error('synthetic render failure');};
    f.c.makeEmergencyEnvelopeV2=(...args:any[])=>{const e=emergency(...args);e.data={resources:[]};return e;};
    await assert.rejects(f.c.execute('fhir_search',{resource_type:'Observation'},{era}), (e:unknown)=>e instanceof GatewayFault && e.code==='INTERNAL_ERROR' && e.message==='Emergency validation failed.');
    assert.equal(f.c.store.size,0);assert.equal(f.g.auditEvents.length,0);
  }finally{await f.close();}
});
