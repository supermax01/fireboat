import { SERVER_IDENTITY } from '../packages/core/src/identity.js';
// Gate-F MCP tests (M3b spec §2 acceptance, CA-1/CA-2 as revised by Addendum B):
// real SDK listing/calls in both eras, outcome taxonomy (a) JSON-RPC /
// (b) SDK text / (c) envelope, catalog bytes on the M3b input skeleton (G-1).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import {
  CATALOG_BYTE_CAPS, FhirGateway, LISTED_OUTPUT_SCHEMA, OUTPUT_SPINE, SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS, TOOL_NAMES,
  minimalOutputSchema, permissiveInputSchema, spineOutputSchema, toolInputV2Schemas, validateSpine, type GatewayEnvelope,
} from '../packages/core/src/index.js';
import type { GatewayTestOptions } from '../packages/core/src/delivery.js';
import { createMcpServer } from '../packages/server/src/index.js';
import { drainToolListing, measureCatalog } from '../packages/evals/src/catalog.js';
import { startSyntheticFhirServer } from '../examples/synthetic-server.js';

interface SdkResult { structuredContent?: GatewayEnvelope; content?: { type?: string; text?: string }[]; isError?: boolean }

async function withEra<T>(era: 'modern' | 'legacy', baseUrl: string, fn: (client: Client, gateway: FhirGateway) => Promise<T>): Promise<T> {
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'local-synthetic', baseUrl }, patientId: 'synthetic-patient-a' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(({ era: instanceEra }) => createMcpServer(gateway, { era: instanceEra }), { transport: serverSide });
  const client = new Client({ name: 'm3b-gate-f-probe', version: '0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } as never : undefined);
  await client.connect(clientSide);
  try { return await fn(client, gateway); }
  finally { await client.close().catch(() => undefined); await handle.close().catch(() => undefined); gateway.close(); }
}

async function scratchServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const synthetic = await startSyntheticFhirServer();
  try { return await fn(synthetic.baseUrl); } finally { await synthetic.close(); }
}

for (const era of ['modern', 'legacy'] as const) {
  test(`production catalog lists the exact minimal schema within Addendum B caps (${era})`, () => scratchServer(base => withEra(era, base, async client => {
    const listed = await drainToolListing(cursor => client.listTools(cursor ? { cursor } : {}));
    assert.equal(listed.tools.length, 5);
    for (const tool of listed.tools) assert.deepEqual(tool.outputSchema, LISTED_OUTPUT_SCHEMA, `${tool.name} must list exactly the 97 B schema`);
    const measured = measureCatalog(listed.tools as unknown[], SERVER_INSTRUCTIONS, OUTPUT_SPINE);
    assert.equal(measured.withinCaps, true, JSON.stringify(measured));
    assert.ok(measured.spineBytes <= CATALOG_BYTE_CAPS.outputSpine, `published spine ${measured.spineBytes}B`);
    assert.match(measured.completeSha256, /^[a-f0-9]{64}$/);
    // Instructions actually negotiated equal the catalog constant.
    assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
    // Every advertised discovery topic has an implemented handler.
    const capsTool = listed.tools.find(t => t.name === 'fhir_capabilities')!;
    const listedJson = JSON.stringify(capsTool.inputSchema);
    assert.ok(listedJson.includes('search_parameter') && listedJson.includes('"support"'), 'implemented discovery topics are advertised');
    const caps = client.getServerCapabilities() as { tools?: { listChanged?: boolean } } | undefined;
    assert.equal(caps?.tools?.listChanged, false, 'listChanged:false in both eras (G-18)');
    // R2-9: serverInfo + capabilities are inside the 350 B wrapper allowance.
    assert.ok(measured.advertisedBytes > 0, 'advertised context measured');
    assert.ok(measured.instructionsAndWrapperBytes <= CATALOG_BYTE_CAPS.instructionsAndWrapper, `wrapper ${measured.instructionsAndWrapperBytes}B`);
    // R2-3: the published contract's listed entries equal this era's SDK capture.
    const contract = JSON.parse(readFileSync(join(process.cwd(), 'docs/contracts/m3b-tools.json'), 'utf8')) as { listed: { tools: Record<string, unknown>[] } };
    for (const tool of listed.tools) {
      const entry = contract.listed.tools.find(t => t.name === tool.name)!;
      assert.ok(entry, `${tool.name} published`);
      assert.equal(entry.title, tool.title, `${tool.name} title (${era})`);
      assert.equal(entry.description, tool.description, `${tool.name} description (${era})`);
      assert.deepEqual(entry.annotations, tool.annotations, `${tool.name} annotations (${era})`);
      assert.deepEqual(entry.input_schema, tool.inputSchema, `${tool.name} listed input (${era})`);
      assert.deepEqual(entry.output_schema, tool.outputSchema, `${tool.name} listed output (${era})`);
    }
  })));

  test(`M3b-input catalog skeleton fits Addendum B caps in ${era} era (G-1)`, async () => {
    const make = (): McpServer => {
      const server = new McpServer(SERVER_IDENTITY, { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: { listChanged: false } }, supportedProtocolVersions: ['2026-07-28', '2025-11-25'] });
      for (const name of TOOL_NAMES) {
        const listedInput = z.toJSONSchema(toolInputV2Schemas[name], { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
        delete listedInput['$schema'];
        server.registerTool(name, {
          title: TOOL_DESCRIPTIONS[name].title, description: TOOL_DESCRIPTIONS[name].description,
          inputSchema: permissiveInputSchema(listedInput) as unknown as StandardSchemaWithJSON,
          outputSchema: minimalOutputSchema() as unknown as StandardSchemaWithJSON,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }, async () => ({ content: [] }) as never);
      }
      return server;
    };
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => make(), { transport: serverSide });
    const client = new Client({ name: 'm3b-skeleton-probe', version: '0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } as never : undefined);
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 5);
      for (const tool of tools) assert.deepEqual(tool.outputSchema, LISTED_OUTPUT_SCHEMA, tool.name);
      const measured = measureCatalog(tools as unknown[], SERVER_INSTRUCTIONS, OUTPUT_SPINE);
      for (const name of TOOL_NAMES) assert.ok(measured.perTool[name] <= CATALOG_BYTE_CAPS[name], `${era} ${name}: ${measured.perTool[name]}B exceeds cap ${CATALOG_BYTE_CAPS[name]}`);
      assert.ok(measured.toolsTotal <= CATALOG_BYTE_CAPS.toolsTotal, `tools ${measured.toolsTotal}B`);
      assert.ok(measured.completeBytes <= CATALOG_BYTE_CAPS.complete, `complete ${measured.completeBytes}B`);
      assert.equal(measured.withinCaps, true, JSON.stringify(measured));
    } finally {
      await client.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
    }
  });

  test(`admitted argument faults are application envelopes, never SDK text (${era})`, () => scratchServer(base => withEra(era, base, async (client, gateway) => {
    const callsBefore = gateway.auditEvents.length;
    void callsBefore;
    const classify = async (tool: string, args: Record<string, unknown>) => client.callTool({ name: tool, arguments: args }) as Promise<SdkResult>;
    // Unknown key (200 of them) with a valid allowance: class (c), within budget, zero canary echo.
    const canaryArgs: Record<string, unknown> = { resource_type: 'Observation', output: { max_bytes: 8192 } };
    for (let i = 0; i < 200; i++) canaryArgs[`canary_key_${i}`] = `canary_value_${i}`;
    const unknownKeys = await classify('fhir_search', canaryArgs);
    assert.equal(unknownKeys.isError, true);
    assert.equal(unknownKeys.structuredContent?.error?.code, 'INVALID_ARGUMENTS');
    assert.ok((unknownKeys.structuredContent?.budget.bytes_returned ?? Infinity) <= 8192);
    assert.ok(!JSON.stringify(unknownKeys).includes('canary_value_'), 'rejected values must never echo');
    assert.ok(!JSON.stringify(unknownKeys).includes('canary_key_'), 'unknown key names must never echo');
    // Too-small budget, unsafe path, bad topic combo: all class (c) INVALID_ARGUMENTS.
    for (const [tool, args] of [
      ['fhir_read', { resource_type: 'Observation', id: 'synthetic-obs-a1', output: { max_bytes: 100 } }],
      ['fhir_search', { resource_type: 'Observation', output: { fields: ['__proto__.polluted'] } }],
      ['fhir_read', { resource_type: 'Observation', id: 'synthetic-obs-a1', interaction: 'vread' }],
    ] as const) {
      const result = await classify(tool, args as Record<string, unknown>);
      assert.equal(result.isError, true, tool);
      assert.equal(result.structuredContent?.error?.code, 'INVALID_ARGUMENTS', tool);
    }
    // Source forgery -> POLICY_DENIED; context forgery -> CONTEXT_REQUIRED with use_current_context repair.
    const forgedSource = await classify('fhir_search', { resource_type: 'Observation', source: 'other-alias' });
    assert.equal(forgedSource.structuredContent?.error?.code, 'POLICY_DENIED');
    assert.equal(forgedSource.structuredContent?.error?.repair, undefined);
    const forgedContext = await classify('fhir_search', { resource_type: 'Observation', context_handle: 'ctx_forged' });
    assert.equal(forgedContext.structuredContent?.error?.code, 'CONTEXT_REQUIRED');
    assert.deepEqual(forgedContext.structuredContent?.error?.repair, { action: 'use_current_context' });
    // Direct-read uniformization: foreign and absent are indistinguishable, no repair.
    const absent = await classify('fhir_read', { resource_type: 'Observation', id: 'synthetic-obs-a1' });
    assert.notEqual(absent.isError, true, 'own-patient positive control must succeed');
    const missing = await classify('fhir_read', { resource_type: 'Observation', id: 'does-not-exist-1' });
    assert.equal(missing.structuredContent?.error?.code, 'NOT_FOUND');
    assert.equal(missing.structuredContent?.error?.repair, undefined);
    // Unknown tool -> JSON-RPC error (class a), no result.
    await assert.rejects(classify('fhir_nope', {}), 'unknown tool must be a protocol failure');
  })));

  test(`repairs attach to expired handles; zero upstream work on admission faults (${era})`, () => scratchServer(base => withEra(era, base, async (client, gateway) => {
    const expired = await client.callTool({ name: 'fhir_result', arguments: { handle: 'res_doesnotexistdoesnotexist12', action: 'inspect' } }) as SdkResult;
    assert.equal(expired.structuredContent?.error?.code, 'RESULT_EXPIRED');
    assert.deepEqual(expired.structuredContent?.error?.repair, { action: 'repeat_original_query' });
    const audits = gateway.auditEvents.length;
    const bad = await client.callTool({ name: 'fhir_search', arguments: { resource_type: 'Observation', bogus: true } }) as SdkResult;
    assert.equal(bad.structuredContent?.error?.code, 'INVALID_ARGUMENTS');
    assert.equal(bad.structuredContent?.budget.upstream_calls, 0, 'admission faults make no upstream request');
    assert.equal(gateway.auditEvents.length, audits + 1);
  })));
}

test('G-5: accessor and Proxy direct-call inputs return fitted envelopes, getters never invoked', () => scratchServer(async base => {
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'local-synthetic', baseUrl: base }, patientId: 'synthetic-patient-a' });
  try {
    let hits = 0;
    const evil = Object.defineProperty({ id: 'x' }, 'resource_type', { enumerable: true, get() { hits++; throw new Error('getter-canary'); } });
    const env1 = await gateway.execute('fhir_read', evil);
    assert.ok(env1.error?.code, 'accessor input must produce a fitted error envelope');
    assert.equal(hits, 0, 'getter must never run');
    assert.ok(env1.budget.bytes_returned <= env1.budget.byte_limit);
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('proxy-canary'); } });
    const env2 = await gateway.execute('fhir_read', proxy);
    assert.equal(env2.error?.code, 'INVALID_ARGUMENTS');
    assert.ok(!JSON.stringify(env2).includes('proxy-canary'));
  } finally { gateway.close(); }
}));

test('G-10: removed constructor protocolEra fails with a migration message', () => scratchServer(async base => {
  const config = { mode: 'synthetic' as const, source: { alias: 'local-synthetic', baseUrl: base }, patientId: 'synthetic-patient-a', contextId: 'g10-valid-context' };
  new FhirGateway(config).close();
  assert.throws(
    () => new FhirGateway({ ...config, ...({ protocolEra: 'legacy' } as object) } as never),
    /INVALID_CONFIG|protocolEra was removed/,
  );
  try {
    new FhirGateway({ ...config, ...({ protocolEra: 'legacy' } as object) } as never);
    assert.fail('must throw');
  } catch (error) {
    assert.match((error as Error).message, /protocolEra was removed/);
  }
  assert.throws(
    () => new FhirGateway({ ...config, source: { ...config.source, searchProfile: 'unknown-g10-profile' } }),
    { code: 'INVALID_CONFIG', message: 'Invalid synthetic gateway configuration.' },
  );
  new FhirGateway({ ...config, source: { ...config.source, searchProfile: 'hapi-r4-labs-v1' } }).close();
}));

// Isolated test-only corruption fixture (Addendum B.3.2 / replacement CA-2.2):
// the handler returns a valid envelope, so server output validation passes;
// corruption is injected in serverSide.send AFTER validation, isolating the
// real SDK client's checks. Test-only: no production path can do this.
const GOOD_ENVELOPE = {
  schema_version: '0.1', request_id: 'r', source: { alias: 'a', fhir_version: '4.0.1', capability_revision: 'x' },
  context: { handle: 'h', mode: 'patient-bound', policy_revision: 'synthetic-v1' }, data: {},
  coverage: { state: 'unknown', scope: 'query', reasons: [] },
  transform: { format: 'fhir', projected: false, withheld_payloads: [], delivery_profile: 'full-text-v1' },
  warnings: [], budget: { bytes_returned: 1, byte_limit: 4096, limit_reached: false, upstream_calls: 0, elapsed_ms: 0 },
};
async function corruptibleCall(era: 'modern' | 'legacy', wrapper: 'minimal' | 'spine', corrupt: (result: Record<string, unknown>) => void): Promise<{ accepted: boolean; code?: number | string; isError?: boolean }> {
  const make = (): McpServer => {
    const server = new McpServer({ name: 's', version: '0' }, { capabilities: { tools: { listChanged: false } }, supportedProtocolVersions: ['2026-07-28', '2025-11-25'] });
    server.registerTool('probe_tool', {
      inputSchema: permissiveInputSchema({ type: 'object' }) as unknown as StandardSchemaWithJSON,
      outputSchema: (wrapper === 'minimal' ? minimalOutputSchema() : spineOutputSchema()) as unknown as StandardSchemaWithJSON,
    }, async () => ({ content: [{ type: 'text', text: 'x' }], structuredContent: structuredClone(GOOD_ENVELOPE) }) as never);
    return server;
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const send = serverSide.send.bind(serverSide);
  serverSide.send = async (message, options) => {
    const rec = message as { result?: Record<string, unknown> };
    // Tool results only: handshake/list responses must pass through untouched.
    if (rec.result && typeof rec.result === 'object' && Array.isArray(rec.result.content)) corrupt(rec.result);
    return send(message, options);
  };
  const handle = serveStdio(() => make(), { transport: serverSide });
  const client = new Client({ name: 'c', version: '0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } as never : undefined);
  await client.connect(clientSide);
  try {
    await client.listTools();
    const result = await client.callTool({ name: 'probe_tool', arguments: {} }) as SdkResult;
    return { accepted: true, ...(result.isError !== undefined ? { isError: result.isError } : {}) };
  } catch (error) {
    return { accepted: false, code: (error as { code?: number | string }).code };
  } finally {
    await client.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
}

for (const era of ['modern', 'legacy'] as const) {
  test(`replacement CA-2.2: minimal-schema client rejections and documented loss (${era})`, async () => {
    const missing = await corruptibleCall(era, 'minimal', result => { delete result.structuredContent; });
    assert.deepEqual([missing.accepted, missing.code], [false, -32600], 'missing structuredContent rejected');
    const noVersion = await corruptibleCall(era, 'minimal', result => { delete (result.structuredContent as Record<string, unknown>).schema_version; });
    assert.deepEqual([noVersion.accepted, noVersion.code], [false, -32602], 'missing schema_version rejected');
    const badVersion = await corruptibleCall(era, 'minimal', result => { (result.structuredContent as Record<string, unknown>).schema_version = 7; });
    assert.deepEqual([badVersion.accepted, badVersion.code], [false, -32602], 'non-string schema_version rejected');
    // Documented loss (Addendum B.1): coverage/delivery corruption now PASSES the client;
    // core strict validation (validateSpine) is what rejects it before delivery.
    const badCoverage = { ...structuredClone(GOOD_ENVELOPE), coverage: { state: 'bogus', scope: 'query', reasons: [] } };
    assert.equal(validateSpine(badCoverage), false, 'core gate rejects what the minimal client accepts');
    const accepted = await corruptibleCall(era, 'minimal', result => { (result.structuredContent as Record<string, unknown>).coverage = { state: 'bogus', scope: 'query', reasons: [] }; });
    assert.equal(accepted.accepted, true, 'minimal-schema client accepts invalid coverage (accepted loss)');
  });

  test(`validateSpine agrees with the SDK client under the published spine (${era}, G-6 differential)`, async () => {
    const cases: [string, (env: Record<string, unknown>) => void][] = [
      ['good', () => undefined],
      ['bad-state', env => { (env.coverage as Record<string, unknown>).state = 'bogus'; }],
      ['bad-delivery', env => { (env.transform as Record<string, unknown>).delivery_profile = 'slim'; }],
      ['bad-has-more', env => { env.pagination = { has_more: 'yes', returned_matches: 0, returned_includes: 0 }; }],
      ['bad-provenance', env => { env.provenance = [{ resource_index: 'zero', retrieved_at: '2025-01-01T00:00:00Z' }]; }],
      ['bad-retryable', env => { env.error = { code: 'X', safe_message: 'm', retryable: 'no' }; }],
    ];
    for (const [name, mutate] of cases) {
      const candidate = structuredClone(GOOD_ENVELOPE) as Record<string, unknown>;
      mutate(candidate);
      const outcome = await corruptibleCall(era, 'spine', result => { result.structuredContent = structuredClone(candidate); });
      assert.equal(outcome.accepted, validateSpine(candidate), `${era} ${name}: SDK client and validateSpine must agree`);
    }
  });
}

test('N-2: test-only delivery override is unreachable via public config and labels output', async () => {
  await scratchServer(async base => {
    assert.throws(
      () => new FhirGateway({ mode: 'synthetic', source: { alias: 'local-synthetic', baseUrl: base }, patientId: 'synthetic-patient-a', delivery: { profile: 'structured-evidence-v1', hostProfileId: 'fixture-host' } }),
      /UNVERIFIED_HOST_PROFILE|verified host profile/,
    );
    // The override type is not part of the package public exports.
    const core = await import('../packages/core/src/index.js') as Record<string, unknown>;
    assert.equal(core['resolveDeliveryProfile'], undefined);
    assert.equal(core['HOST_PROFILE_REGISTRY'], undefined);
    assert.equal(core['selectHostProfileEntry'], undefined);
    // With the test-only override, EVERY success and error envelope is labelled (G-14).
    const override: GatewayTestOptions = {
      testDeliveryRegistryOverride: {
        profileId: 'fixture-host',
        entries: [{
          id: 'fixture-host', version: '1', host: { name: 'fixture', version: '1', client_stack: 'sdk', client_stack_version: '2.3.1' },
          era: 'modern', transport: 'stdio', workflow: 'recent-labs-v1', delivery_profile: 'structured-evidence-v1', verification: 'fixture_only',
        }],
      },
    };
    const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'local-synthetic', baseUrl: base }, patientId: 'synthetic-patient-a', delivery: { profile: 'structured-evidence-v1', hostProfileId: 'fixture-host' } }, override);
    try {
      const success = await gateway.execute('fhir_capabilities', { topic: 'context' });
      assert.equal(success.error, undefined);
      assert.ok(success.warnings.some(w => w.code === 'UNVERIFIED_DELIVERY_PROFILE'), 'success envelope labelled');
      const rendered = gateway.toToolResult(success, { era: 'modern' });
      assert.ok(JSON.stringify(rendered.structuredContent).includes('UNVERIFIED_DELIVERY_PROFILE'), 'structured content labelled');
      assert.ok(rendered.content[0]!.text!.includes('UNVERIFIED_DELIVERY_PROFILE'), 'text labelled');
      const failure = await gateway.execute('fhir_search', { resource_type: 'Observation', bogus: true });
      assert.equal(failure.error?.code, 'INVALID_ARGUMENTS');
      assert.deepEqual(failure.warnings, [], 'errors carry no success labels');
    } finally { gateway.close(); }
  });
});
