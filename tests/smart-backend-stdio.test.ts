// Real MCP SDK client over stdio against the CLI, with the in-repo SMART stub as authorization server and FHIR source.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { KEY_ENV, smartConfig, startSmartStub, type Rec, type SmartStub, type StubOptions } from './smart-helpers.js';

const output = { format: 'fhir', max_bytes: 24576 };

async function connect(t: TestContext, stub: SmartStub, era: 'modern' | 'legacy' = 'modern') {
  const dir = await mkdtemp(join(tmpdir(), 'fireboat-smart-stdio-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify(smartConfig(stub)));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'packages/server/src/cli.ts', '--config', config],
    env: { ...getDefaultEnvironment(), TMPDIR: tmpdir(), [KEY_ENV]: stub.keys.pem }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'smart-backend-stdio', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  await client.connect(transport);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await client.close(); } };
  t.after(close);
  const call = async (name: string, args: Rec) => {
    const result = await client.callTool({ name, arguments: { ...args, output } });
    return { envelope: result.structuredContent as Rec, raw: JSON.stringify(result) };
  };
  return { call, close, stderr: () => stderr };
}

test('SMART backend over stdio: a real MCP SDK client searches and reads with stub-verified assertions', async t => {
  for (const era of ['modern', 'legacy'] as const) {
    const stub = await startSmartStub(); t.after(stub.close);
    const session = await connect(t, stub, era);
    const found = await session.call('fhir_search', { resource_type: 'Observation' });
    assert.equal(found.envelope.error, undefined, JSON.stringify(found.envelope.error));
    assert.equal(found.envelope.data.resources.length, 2, era);
    const own = await session.call('fhir_read', { resource_type: 'Observation', id: 'smart-own' });
    assert.equal(own.envelope.error, undefined, JSON.stringify(own.envelope.error));
    assert.equal(own.envelope.data.resources[0].id, 'smart-own');
    assert.equal(stub.tokenRequests.length, 1, era);
    assert.equal(stub.tokenRequests[0]!.rejected, undefined, era);
    assert.equal(stub.tokenRequests[0]!.assertion!.claims.aud, stub.tokenUrl);
    assert.ok(stub.fhirRequests.every(r => r.authorized), era);
    await session.close();
  }
});

test('SMART backend over stdio: an ungranted type is POLICY_DENIED with zero FHIR requests', async t => {
  const stub = await startSmartStub({ tokenReply: body => ({ ...body, scope: 'system/Observation.rs' }) }); t.after(stub.close);
  const session = await connect(t, stub);
  const denied = await session.call('fhir_search', { resource_type: 'Encounter' });
  assert.equal(denied.envelope.error?.code, 'POLICY_DENIED');
  assert.equal(stub.fhirRequests.length, 0);
  assert.equal(stub.tokenRequests.length, 1);
  assert.equal((await session.call('fhir_search', { resource_type: 'Observation' })).envelope.error, undefined);
});

test('SMART canary over stdio: no access token, assertion or key material reaches stderr or tool output, on success or refusal', async t => {
  const cases: StubOptions[] = [{}, { tokenReply: body => ({ ...body, scope: `${body.scope} system/Observation.cruds` }) },
    { tokenReply: body => { const { scope: _scope, ...rest } = body; return rest; } }, { tokenReply: body => ({ ...body, patient: 'synthetic-smart-b' }) },
    { tokenReply: body => ({ ...body, expires_in: 'soon' }) }];
  for (const options of cases) {
    const stub = await startSmartStub(options); t.after(stub.close);
    const session = await connect(t, stub);
    const texts = [(await session.call('fhir_search', { resource_type: 'Observation' })).raw,
      (await session.call('fhir_read', { resource_type: 'Observation', id: 'smart-own' })).raw];
    stub.revokeAll();
    texts.push((await session.call('fhir_read', { resource_type: 'Observation', id: 'smart-own' })).raw);
    await session.close();
    texts.push(session.stderr());
    const keyLines = stub.keys.pem.split('\n').filter(line => line.length > 20 && !line.startsWith('-----'));
    const secrets = [...stub.tokenRequests.map(r => r.form.get('client_assertion') ?? ''), ...keyLines, ...stub.issued].filter(Boolean);
    // Tokens the stub minted for refused responses are secrets too, even though they were never issued as usable.
    assert.ok(stub.tokenRequests.length >= 1 && secrets.length > keyLines.length);
    const text = texts.join('\n');
    for (const secret of secrets) assert.ok(!text.includes(secret), 'a token, assertion or key fragment leaked');
  }
});
