import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { FhirGateway, TOOL_NAMES, type GatewayEnvelope } from '../packages/core/src/index.js';
import { createMcpServer } from '../packages/server/src/index.js';
import { startSyntheticFhirServer } from '../examples/synthetic-server.js';
import { NEGATIVE_CONTROL_DETECTS, runDemo } from '../examples/demo.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

interface CallResultLike {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type?: string; text?: string }[];
}

function envelope(result: CallResultLike): GatewayEnvelope {
  assert.equal(typeof result.structuredContent, 'object', 'tool result must carry structuredContent');
  assert.notEqual(result.structuredContent, null);
  return result.structuredContent as GatewayEnvelope;
}
function assertEnvelopeShape(env: GatewayEnvelope): void {
  assert.equal(env.schema_version, '0.3');
  assert.equal(typeof env.request_id, 'string');
  assert.equal(typeof env.source?.alias, 'string');
  assert.equal(typeof env.coverage?.state, 'string');
  assert.equal(typeof env.budget?.bytes_returned, 'number');
}
function resourceIds(data: unknown, acc: string[] = []): string[] {
  if (Array.isArray(data)) { for (const item of data) resourceIds(item, acc); return acc; }
  if (typeof data === 'object' && data !== null) {
    const rec = data as Record<string, unknown>;
    if (typeof rec['resourceType'] === 'string' && typeof rec['id'] === 'string') acc.push(`${rec['resourceType']}/${rec['id']}`);
    else for (const value of Object.values(rec)) resourceIds(value, acc);
  }
  return acc;
}
// Tool-result failures and protocol rejections are distinct surfaces with distinct helpers (J-20): neither helper
// swallows the other's outcome, so a call that unexpectedly succeeds always fails the test.
//
// INVALID_ARGUMENTS is also satisfied by the SDK's own input-schema rejection, which the SDK reports as an isError
// result with no structuredContent before the gateway runs; both are the safe invalid-arguments outcome.
const SDK_INPUT_VALIDATION = /^Input validation error: /;
async function expectToolError(promise: Promise<CallResultLike>, code: string, label: string): Promise<CallResultLike> {
  const result = await promise;
  assert.equal(result.isError, true, `${label}: expected an isError tool result, got ${JSON.stringify(result).slice(0, 160)}`);
  const text = result.content?.[0]?.text ?? '';
  if (result.structuredContent === undefined && code === 'INVALID_ARGUMENTS') {
    assert.match(text, SDK_INPUT_VALIDATION, `${label}: expected an SDK input-validation rejection`);
    return result;
  }
  const env = envelope(result);
  assert.equal(env.error?.code, code, `${label}: expected error code ${code}, got ${env.error?.code}`);
  assert.equal(env.error?.retryable, false, `${label}: ${code} must not be retryable`);
  assert.deepEqual(env.data, {}, `${label}: an error must carry no data`);
  assert.equal(env.result, undefined, `${label}: an error must not mint a result handle`);
  assert.equal(env.pagination, undefined, `${label}: an error must not mint a cursor`);
  assert.equal(resourceIds(env).length, 0, `${label}: an error must not carry resources`);
  return result;
}
async function expectProtocolError(promise: Promise<unknown>, code: number, label: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, code, `${label}: expected JSON-RPC error ${code}, got ${String((error as { code?: unknown }).code)}`);
    return true;
  }, `${label}: expected a JSON-RPC ${code} rejection, but the call resolved`);
}
const INVALID_PARAMS = -32602;
const EXPECTED_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const EXPECTED_TITLES: Record<string, string> = { fhir_capabilities: 'FHIR capabilities', fhir_search: 'FHIR search', fhir_read: 'FHIR read', fhir_page: 'FHIR next page', fhir_result: 'FHIR retained result' };
const cliArgs = (isTs: boolean): { args: string[] } => {
  // FHIR_MCP_CLI lets the same stdio tests run against the compiled dist CLI (J-43).
  const cliPath = process.env['FHIR_MCP_CLI'] ?? join(repoRoot, 'packages', 'server', 'src', isTs ? 'cli.ts' : 'cli.js');
  return { args: cliPath.endsWith('.ts') ? ['--import', 'tsx', cliPath] : [cliPath] };
};

test('failure helpers reject successful calls, wrong codes and the other failure surface', async () => {
  const success: CallResultLike = { content: [{ type: 'text', text: 'ok' }], structuredContent: { schema_version: '0.1', data: { resources: [] }, coverage: { state: 'partial' } } };
  const toolError = (code: string): CallResultLike => ({ isError: true, content: [{ type: 'text', text: code }], structuredContent: { schema_version: '0.1', data: {}, error: { code, safe_message: 'x', retryable: false } } });
  await assert.rejects(expectToolError(Promise.resolve(success), 'NOT_FOUND', 'self-test'), assert.AssertionError);
  await assert.rejects(expectToolError(Promise.resolve({ ...success, isError: false }), 'NOT_FOUND', 'self-test'), assert.AssertionError);
  await assert.rejects(expectToolError(Promise.resolve(toolError('POLICY_DENIED')), 'NOT_FOUND', 'self-test'), assert.AssertionError);
  await assert.rejects(expectToolError(Promise.resolve({ isError: true, content: [{ type: 'text', text: 'Input validation error: x' }] }), 'NOT_FOUND', 'self-test'), assert.AssertionError);
  await assert.rejects(expectToolError(Promise.resolve({ ...toolError('NOT_FOUND'), structuredContent: { data: { resources: [{ resourceType: 'Observation', id: 'leak' }] }, error: { code: 'NOT_FOUND', retryable: false } } }), 'NOT_FOUND', 'self-test'), assert.AssertionError);
  await assert.rejects(expectToolError(Promise.reject(Object.assign(new Error('rejected'), { code: INVALID_PARAMS })), 'NOT_FOUND', 'self-test'), (error: unknown) => !(error instanceof assert.AssertionError));
  await expectToolError(Promise.resolve(toolError('NOT_FOUND')), 'NOT_FOUND', 'self-test positive control');
  await expectToolError(Promise.resolve({ isError: true, content: [{ type: 'text', text: 'Input validation error: x' }] }), 'INVALID_ARGUMENTS', 'self-test positive control');
  await assert.rejects(expectProtocolError(Promise.resolve(success), INVALID_PARAMS, 'self-test'), assert.AssertionError);
  await assert.rejects(expectProtocolError(Promise.resolve(toolError('NOT_FOUND')), INVALID_PARAMS, 'self-test'), assert.AssertionError);
  await assert.rejects(expectProtocolError(Promise.reject(Object.assign(new Error('other'), { code: -32603 })), INVALID_PARAMS, 'self-test'), assert.AssertionError);
  await expectProtocolError(Promise.reject(Object.assign(new Error('bad params'), { code: INVALID_PARAMS })), INVALID_PARAMS, 'self-test positive control');
  // A real successful SDK call must also fail both helpers.
  const synthetic = await startSyntheticFhirServer();
  try {
    await withInMemoryClient(synthetic.baseUrl, async client => {
      const read = () => client.callTool({ name: 'fhir_read', arguments: { resource_type: 'Observation', id: 'synthetic-obs-a1' } }) as Promise<CallResultLike>;
      await assert.rejects(expectToolError(read(), 'NOT_FOUND', 'real success'), assert.AssertionError);
      await assert.rejects(expectProtocolError(read(), INVALID_PARAMS, 'real success'), assert.AssertionError);
    });
  } finally { await synthetic.close(); }
});

async function withInMemoryClient<T>(
  baseUrl: string,
  fn: (client: Client, gateway: FhirGateway) => Promise<T>,
): Promise<T> {
  const gateway = new FhirGateway({
    mode: 'synthetic',
    source: { alias: 'local-synthetic', baseUrl },
    patientId: 'synthetic-patient-a',
  });
  const server = createMcpServer(gateway, { era: 'modern' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fhir-mcp-integration-test', version: '0.1.0-alpha.1' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await fn(client, gateway);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    gateway.close();
  }
}

test('MCP server exposes exactly the five implemented tools with schemas', async () => {
  const synthetic = await startSyntheticFhirServer();
  try {
    await withInMemoryClient(synthetic.baseUrl, async (client) => {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), [...TOOL_NAMES]);
      assert.equal(tools.length, 5);
      for (const tool of tools) {
        assert.equal(tool.inputSchema?.type, 'object', `${tool.name} must advertise an object input schema`);
        assert.equal(tool.outputSchema?.type, 'object', `${tool.name} must advertise an object output schema`);
        assert.ok(tool.description && tool.description.length > 0, `${tool.name} must have a description`);
        assert.equal(tool.title, EXPECTED_TITLES[tool.name], `${tool.name} title`);
        assert.deepEqual(tool.annotations, EXPECTED_ANNOTATIONS, `${tool.name} must be annotated read-only, non-destructive, idempotent and closed-world`);
      }
      const names = new Set(tools.map((t) => t.name));
      for (const absent of ['fhir_request', 'fhir_operation', 'fhir_context', 'fhir_terminology']) {
        assert.equal(names.has(absent), false, `unsupported tool ${absent} must not be exposed`);
      }
    });
  } finally { await synthetic.close(); }
});

test('SDK schema discovery pages within budget and navigates actual JSON choice paths', async () => {
  const synthetic = await startSyntheticFhirServer();
  try {
    await withInMemoryClient(synthetic.baseUrl, async client => {
      const paths: string[] = [];
      let offset = 0;
      let pages = 0;
      while (true) {
        const result = await client.callTool({ name: 'fhir_capabilities', arguments: { topic: 'schema', resource_type: 'Observation', offset, limit: 50, output: { max_bytes: 8192 } } }) as CallResultLike;
        const env = envelope(result);
        assert.equal(env.error, undefined);
        assert.ok(env.budget.bytes_returned <= 8192);
        assert.equal(env.data.evidence, 'pinned_base_definition');
        assert.equal(env.data.profile_validation, 'not_performed');
        paths.push(...(env.data.elements as { path: string }[]).map(field => field.path));
        pages++;
        if (env.data.next_offset === undefined) break;
        assert.equal(env.coverage.state, 'partial');
        assert.ok((env.data.next_offset as number) > offset);
        offset = env.data.next_offset as number;
        assert.ok(pages < 100);
      }
      assert.ok(pages > 1);
      assert.equal(new Set(paths).size, paths.length);
      assert.ok(paths.includes('value[x]'));
      assert.ok(paths.includes('status'));
      const result = await client.callTool({ name: 'fhir_capabilities', arguments: { topic: 'schema', resource_type: 'Observation', path: 'valueQuantity', limit: 50 } }) as CallResultLike;
      const fields = envelope(result).data.elements as { path: string; types: string[] }[];
      assert.ok(fields.some(field => field.path === 'valueQuantity.system' && field.types.includes('uri')));
      const unsupported = await client.callTool({ name: 'fhir_capabilities', arguments: { topic: 'schema', resource_type: 'Observation', path: 'invented.field' } }) as CallResultLike;
      assert.equal(envelope(unsupported).error?.code, 'INVALID_ELEMENT_PATH');
    });
  } finally { await synthetic.close(); }
});

test('capabilities, patient-safe search, paging, read, and result via SDK client', async () => {
  const synthetic = await startSyntheticFhirServer();
  try {
    await withInMemoryClient(synthetic.baseUrl, async (client) => {
      const caps = await client.callTool({ name: 'fhir_capabilities', arguments: { topic: 'server' } }) as CallResultLike;
      assert.notEqual(caps.isError, true, 'capabilities call should succeed');
      const capsEnv = envelope(caps);
      assertEnvelopeShape(capsEnv);
      assert.equal(capsEnv.error, undefined);
      // Text content must exist for text-only hosts. The audit (J-5) agreed that text consumers receive the bounded
      // envelope, so a JSON text block must be exactly the structured envelope; a non-JSON summary must name the
      // coverage state. The old "must not duplicate JSON" assertion encoded the behaviour J-5 replaces.
      const capsText = caps.content?.[0]?.text ?? '';
      assert.equal(caps.content?.[0]?.type, 'text');
      assert.ok(capsText.length > 0, 'text content must not be empty');
      if (capsText.trim().startsWith('{')) assert.deepEqual(JSON.parse(capsText), caps.structuredContent, 'JSON text must equal structuredContent');
      else assert.ok(capsText.includes(capsEnv.coverage.state), 'summary text must carry the coverage state');

      const search = await client.callTool({
        name: 'fhir_search',
        arguments: { resource_type: 'Observation', params: [], page_size: 1 },
      }) as CallResultLike;
      assert.notEqual(search.isError, true, 'search should succeed');
      const searchEnv = envelope(search);
      assertEnvelopeShape(searchEnv);
      const ids1 = resourceIds(searchEnv.data);
      assert.ok(ids1.length >= 1, 'first page must return at least one Observation');
      assert.ok(ids1.every((id) => id.startsWith('Observation/synthetic-obs-a')), `page 1 must only contain patient A observations, got ${ids1}`);
      const serialized = JSON.stringify(searchEnv);
      assert.equal(serialized.includes('synthetic-obs-b'), false, 'search must not leak patient B observations');
      assert.equal(serialized.includes('synthetic-patient-b'), false, 'search must not leak patient B');

      const cursor = searchEnv.pagination?.next_cursor;
      assert.ok(cursor, 'page_size=1 with multiple observations must return a next_cursor');
      const page2 = await client.callTool({ name: 'fhir_page', arguments: { cursor } }) as CallResultLike;
      assert.notEqual(page2.isError, true, 'fhir_page should succeed');
      const page2Env = envelope(page2);
      const ids2 = resourceIds(page2Env.data);
      assert.ok(ids2.length >= 1, 'second page must return at least one Observation');
      assert.ok(ids2.every((id) => id.startsWith('Observation/synthetic-obs-a')));
      assert.notDeepEqual(ids2, ids1, 'second page must differ from first page');

      const read = await client.callTool({
        name: 'fhir_read',
        arguments: { resource_type: 'Observation', id: 'synthetic-obs-a1', interaction: 'read' },
      }) as CallResultLike;
      assert.notEqual(read.isError, true, 'read of own-patient observation should succeed');
      const readEnv = envelope(read);
      assert.ok(resourceIds(readEnv.data).includes('Observation/synthetic-obs-a1'));

      if (searchEnv.result?.handle) {
        const retained = await client.callTool({
          name: 'fhir_result',
          arguments: { handle: searchEnv.result.handle, action: 'inspect' },
        }) as CallResultLike;
        assert.notEqual(retained.isError, true, 'retained result inspect should succeed');
        assertEnvelopeShape(envelope(retained));
      }
    });
  } finally { await synthetic.close(); }
});

test('search filters by code and repeated date range stay patient-bound', async () => {
  const synthetic = await startSyntheticFhirServer();
  try {
    await withInMemoryClient(synthetic.baseUrl, async (client) => {
      const glucose = await client.callTool({
        name: 'fhir_search',
        arguments: {
          resource_type: 'Observation',
          params: [
            { name: 'code', value: 'http://loinc.org|2345-7' },
            { name: 'date', value: 'ge2025-01-01' },
            { name: 'date', value: 'le2025-12-31' },
            { name: '_sort', value: '-date' },
          ],
          page_size: 20,
        },
      }) as CallResultLike;
      assert.notEqual(glucose.isError, true, 'filtered search should succeed');
      const env = envelope(glucose);
      const ids = resourceIds(env.data);
      assert.ok(ids.length >= 1, 'glucose search must return matches');
      assert.ok(ids.every((id) => id.startsWith('Observation/synthetic-obs-a')), `filtered search leaked: ${ids}`);
      // HbA1c / heart-rate observations must be filtered out by code.
      assert.equal(ids.includes('Observation/synthetic-obs-a2'), false);
      assert.equal(ids.includes('Observation/synthetic-obs-a4'), false);
    });
  } finally { await synthetic.close(); }
});

test('cross-patient and invalid calls are denied safely', async () => {
  const synthetic = await startSyntheticFhirServer();
  try {
    await withInMemoryClient(synthetic.baseUrl, async (client, gateway) => {
      const auditsBefore = gateway.auditEvents.length;

      const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<CallResultLike>;
      const crossObs = await expectToolError(call('fhir_read', { resource_type: 'Observation', id: 'synthetic-obs-b1', interaction: 'read' }), 'NOT_FOUND', 'cross-patient Observation read');
      assert.equal(JSON.stringify(crossObs).includes('"valueQuantity"'), false, 'denial must not include resource body');
      assert.equal(JSON.stringify(crossObs).includes('synthetic-patient-b'), false, 'denial must not echo the other patient');
      await expectToolError(call('fhir_read', { resource_type: 'Patient', id: 'synthetic-patient-b', interaction: 'read' }), 'NOT_FOUND', 'cross-patient Patient read');
      await expectToolError(call('fhir_search', { resource_type: 'Observation', params: [{ name: 'patient', value: 'Patient/synthetic-patient-b' }] }), 'POLICY_DENIED', 'cross-patient selector');
      await expectToolError(call('fhir_search', { resource_type: 'Observation', source: 'another-source' }), 'POLICY_DENIED', 'unconfigured source alias');
      await expectToolError(call('fhir_search', { resource_type: 'Observation', context_handle: 'forged-context' }), 'CONTEXT_REQUIRED', 'forged context handle');
      await expectToolError(call('fhir_read', { resource_type: 'Observation', id: 'synthetic-obs-a1', interaction: 'vread' }), 'INVALID_ARGUMENTS', 'vread must not be supported');
      await expectToolError(call('fhir_search', { params: [], page_size: 20 }), 'INVALID_ARGUMENTS', 'search without resource_type');
      await expectToolError(call('fhir_search', { resource_type: 'Observation', url: 'http://127.0.0.1/fhir/Observation' }), 'INVALID_ARGUMENTS', 'arbitrary URL argument');
      await expectToolError(call('fhir_page', { cursor: 'cur_not-a-real-cursor' }), 'RESULT_EXPIRED', 'bogus cursor');
      await expectToolError(call('fhir_result', { handle: 'res_not-a-real-handle' }), 'RESULT_EXPIRED', 'bogus result handle');
      await expectProtocolError(call('fhir_not_a_tool', {}), INVALID_PARAMS, 'unknown tool');
      await expectProtocolError(call('fhir_request', { method: 'GET', url: 'http://127.0.0.1/fhir/Patient' }), INVALID_PARAMS, 'unimplemented arbitrary-request tool');

      // Audit stays metadata-only: no bodies or patient identifiers.
      assert.ok(gateway.auditEvents.length >= auditsBefore);
      const auditText = JSON.stringify(gateway.auditEvents);
      assert.equal(auditText.includes('valueQuantity'), false);
      assert.equal(auditText.includes('synthetic-patient'), false, 'audit must not contain patient identifiers');
    });
  } finally { await synthetic.close(); }
});

test('stdio subprocess: real SDK client handshake, list, and call', async () => {
  const synthetic = await startSyntheticFhirServer();
  const tempDir = await mkdtemp(join(tmpdir(), 'fhir-mcp-test-'));
  const client = new Client({ name: 'fhir-mcp-stdio-test', version: '0.1.0-alpha.1' });
  try {
    const configPath = join(tempDir, 'config.json');
    await writeFile(configPath, JSON.stringify({
      mode: 'synthetic',
      source: { alias: 'local-synthetic', baseUrl: synthetic.baseUrl },
      patientId: 'synthetic-patient-a',
    }), { encoding: 'utf8', mode: 0o600 });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...cliArgs(import.meta.url.endsWith('.ts')).args, '--config', configPath],
      cwd: repoRoot,
      env: getDefaultEnvironment(),
      stderr: 'pipe',
    });
    await client.connect(transport);

    const serverVersion = client.getServerVersion();
    assert.equal(serverVersion?.name, 'fireboat');
    assert.ok(client.getNegotiatedProtocolVersion(), 'stdio handshake must negotiate a protocol version');

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), [...TOOL_NAMES]);

    const caps = await client.callTool({ name: 'fhir_capabilities', arguments: { topic: 'server' } }) as CallResultLike;
    assert.notEqual(caps.isError, true);
    assertEnvelopeShape(envelope(caps));

    const read = await client.callTool({
      name: 'fhir_read',
      arguments: { resource_type: 'Observation', id: 'synthetic-obs-a1', interaction: 'read' },
    }) as CallResultLike;
    assert.notEqual(read.isError, true);
    assert.ok(resourceIds(envelope(read).data).includes('Observation/synthetic-obs-a1'));
  } finally {
    await client.close().catch(() => undefined);
    await synthetic.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('stdio subprocess negotiates the modern protocol era via discover', async () => {
  const synthetic = await startSyntheticFhirServer();
  const tempDir = await mkdtemp(join(tmpdir(), 'fhir-mcp-modern-'));
  const client = new Client(
    { name: 'fhir-mcp-modern-test', version: '0.1.0-alpha.1' },
    { versionNegotiation: { mode: 'auto' } },
  );
  try {
    const configPath = join(tempDir, 'config.json');
    await writeFile(configPath, JSON.stringify({
      mode: 'synthetic',
      source: { alias: 'local-synthetic', baseUrl: synthetic.baseUrl },
      patientId: 'synthetic-patient-a',
    }), { encoding: 'utf8', mode: 0o600 });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...cliArgs(import.meta.url.endsWith('.ts')).args, '--config', configPath],
      cwd: repoRoot,
      env: getDefaultEnvironment(),
      stderr: 'pipe',
    });
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), 'modern');
    assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), [...TOOL_NAMES]);

    const caps = await client.callTool({ name: 'fhir_capabilities', arguments: { topic: 'server' } }) as CallResultLike;
    assert.notEqual(caps.isError, true);
    assertEnvelopeShape(envelope(caps));
  } finally {
    await client.close().catch(() => undefined);
    await synthetic.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('demo --check asserts every outcome over stdio, and its negative control detects a mis-trusted patient (J-43)', async () => {
  const quiet = () => undefined;
  const outcomes = await runDemo({ log: quiet });
  assert.deepEqual(outcomes.filter(outcome => !outcome.ok), []);
  assert.deepEqual(outcomes.map(outcome => outcome.check_id), ['tools-listed', 'capabilities-succeed', 'search-returns-records', 'search-confined-to-trusted-patient', 'page-continues', 'read-trusted-record', 'cross-patient-read-denied', 'result-inspect']);
  const deviations = (await runDemo({ log: quiet, patientId: 'synthetic-patient-b' })).filter(outcome => !outcome.ok).map(outcome => outcome.check_id);
  for (const id of NEGATIVE_CONTROL_DETECTS) assert.ok(deviations.includes(id), `negative control must detect ${id}`);
  assert.ok(deviations.includes('read-trusted-record'));
});

test('V-15 an SDK client cancellation reaches the gateway: upstream socket closes, nothing allowed or retained', async t => {
  let baseUrl = '';
  let holdRead = false;
  let socketsClosed = 0;
  const held: ServerResponse[] = [];
  const patientId = 'synthetic-patient-a';
  const server = createServer((req, res) => {
    const url = new URL(req.url!, baseUrl);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname.endsWith('/metadata')) {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [{ type: 'Observation', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'patient' }] }] }] }));
      return;
    }
    if (holdRead) {
      res.on('close', () => { if (!res.writableEnded) socketsClosed++; });
      held.push(res);
      return;
    }
    const id = url.pathname.split('/').at(-1)!;
    res.end(JSON.stringify({ resourceType: 'Observation', id, status: 'final', subject: { reference: `Patient/${patientId}` }, code: { text: 'Synthetic' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const address = server.address()!; const port = typeof address === 'object' ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/fhir/`;
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'local-synthetic', baseUrl }, patientId });
  const mcp = createMcpServer(gateway, { era: 'modern' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fhir-mcp-cancel-test', version: '0.1.0-alpha.1' });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close().catch(() => undefined); await mcp.close().catch(() => undefined); gateway.close(); });
  const warm = await client.callTool({ name: 'fhir_capabilities', arguments: { topic: 'server' } }) as CallResultLike;
  assert.notEqual(warm.isError, true);
  const allowedBefore = gateway.auditEvents.filter(e => e.outcome === 'allowed').length;
  const storeSize = () => (gateway as unknown as { store: { size: number } }).store.size;
  const sizeBefore = storeSize();
  holdRead = true;
  const ctrl = new AbortController();
  // SDK 2.3.1: callTool(params, options) — the abort signal travels in the second argument.
  const call = (client as unknown as { callTool: (p: unknown, o: unknown) => Promise<unknown> })
    .callTool({ name: 'fhir_read', arguments: { resource_type: 'Observation', id: 'held-obs' } }, { signal: ctrl.signal });
  const settled = call.then(() => 'resolved', () => 'rejected');
  for (let i = 0; i < 400 && !held.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(held.length, 1, 'upstream read must be in flight');
  ctrl.abort();
  assert.equal(await settled, 'rejected', 'the SDK call itself is cancelled');
  for (let i = 0; i < 400 && socketsClosed < 1; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(socketsClosed, 1, 'the adapter must forward the SDK signal so the upstream socket closes');
  assert.equal(gateway.auditEvents.filter(e => e.outcome === 'allowed').length, allowedBefore, 'cancelled call audited nothing as allowed');
  assert.ok(gateway.auditEvents.some(e => e.code === 'REQUEST_CANCELLED'), 'gateway recorded the cancellation');
  assert.equal(storeSize(), sizeBefore, 'cancelled call retained nothing');
});
