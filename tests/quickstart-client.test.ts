import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GatewayClientFault, openGatewaySession, type ClientFaultCode, type GatewaySessionOptions } from '../examples/quickstart/client.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const CANARY = 'PRIVATE-BODY-ID-PATH-CANARY';
const read = { resource_type: 'Observation', id: 'qs-obs-0' };
const observation = (id: string) => JSON.stringify({ resourceType: 'Observation', id, meta: { versionId: '1' }, status: 'corrected',
  code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, subject: { reference: 'Patient/qs-patient' },
  effectiveDateTime: '2025-11-03T08:30:00Z', valueQuantity: { value: '@7.00@', comparator: '<', unit: '%' } }).replace('"@7.00@"', '7.00');

async function fixture(t: TestContext, settings: { auth?: boolean; lag?: boolean; delay?: number; tokenFails?: boolean; metadataFails?: boolean; resourceCount?: number } = {}) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/fhir+json');
    if (req.method === 'POST') {
      res.statusCode = settings.tokenFails ? 401 : 200;
      res.end(JSON.stringify({ access_token: CANARY, token_type: 'Bearer', expires_in: 300 })); return;
    }
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (url.pathname === '/fhir/metadata') {
      res.statusCode = settings.metadataFails ? 503 : 200;
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: ['Patient', 'Observation'].map(type => ({
        type, interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'patient', type: 'reference' }, { name: 'subject', type: 'reference' }],
      })) }] })); return;
    }
    const answer = () => {
      if (url.pathname === '/fhir/Observation') {
        const offset = Number(url.searchParams.get('_offset') ?? 0);
        const count = Number(url.searchParams.get('_count') ?? 2);
        const next = new URL(req.url!, `http://${req.headers.host}`); next.searchParams.set('_offset', String(offset + count));
        const total = settings.resourceCount ?? 4;
        const links = [{ relation: 'self', url: `http://${req.headers.host}${req.url}` }, ...(offset + count < total ? [{ relation: 'next', url: next.href }] : [])];
        const rows = Array.from({ length: Math.min(count, total - offset) }, (_, i) => `{"resource":${observation(`qs-obs-${i + offset}`)}}`);
        res.end(`{"resourceType":"Bundle","type":"searchset","link":${JSON.stringify(links)},"entry":[${rows.join(',')}]}`);
      } else if (url.pathname === '/fhir/Patient/qs-patient') res.end('{"resourceType":"Patient","id":"qs-patient","meta":{"versionId":"1"}}');
      else res.end(observation(url.pathname.split('/').at(-1)!));
    };
    if (settings.delay) setTimeout(answer, settings.delay); else answer();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const directory = await mkdtemp(join(tmpdir(), 'qs-client-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, `config-${CANARY}.json`);
  await writeFile(config, JSON.stringify({ mode: 'synthetic', source: { alias: 'qs-test', baseUrl: `${origin}/fhir`, ...(settings.auth ? { auth: {
    type: 'client_credentials', tokenUrl: `${origin}/token`, clientId: 'synthetic-client', clientSecretEnv: 'QS_SECRET',
  } } : {}) }, patientId: 'qs-patient' }));
  const preloads: string[] = [];
  const preload = async (code: string) => {
    const path = join(directory, `preload-${preloads.length}.mjs`); await writeFile(path, code); preloads.push('--import', path);
  };
  if (settings.lag) await preload(`
    import { Socket } from 'node:net';
    const original = Socket.prototype.write;
    Socket.prototype.write = function(chunk, ...args) {
      if (this._handle?.fd === 3 && String(chunk).includes('"snapshot"')) {
        setTimeout(() => original.call(this, chunk, ...args), 120); return true;
      }
      return original.call(this, chunk, ...args);
    };
  `);
  return { directory, origin, requests, config, preload, options: (era: 'modern' | 'legacy', more: Partial<GatewaySessionOptions> = {}): GatewaySessionOptions => ({
    argv: [process.execPath, '--import', 'tsx', ...preloads, join(root, 'packages/server/src/cli.ts'), '--config', config], era, ...more,
  }) };
}
const rejects = (promise: Promise<unknown>, code: ClientFaultCode) => assert.rejects(promise, (e: unknown) => {
  assert.ok(e instanceof GatewayClientFault); assert.equal(e.code, code); assert.equal(e.message, code);
  assert.doesNotMatch(String(e), /PRIVATE|\/Users|\/private|https?:|qs-obs|at .*\(/); return true;
});

test('quickstart client: both pinned eras preserve raw 7.00 and decode the same request frame without client HTTP', async t => {
  const f = await fixture(t);
  const seen: unknown[] = [], diagnostic = channel('http.client.request.start');
  const listener = (message: unknown) => { seen.push(message); }; diagnostic.subscribe(listener); t.after(() => diagnostic.unsubscribe(listener));
  for (const era of ['modern', 'legacy'] as const) {
    const session = await openGatewaySession(f.options(era)); t.after(() => session.close());
    assert.equal(session.negotiatedVersion, era === 'modern' ? '2026-07-28' : '2025-11-25');
    const call = await session.call('fhir_read', read);
    assert.deepEqual(Object.keys(call).sort(), ['envelope', 'frameBytes', 'frames', 'rawFrame', 'rawText', 'requestId', 'resultBytes', 'work']);
    assert.ok(typeof call.requestId === 'number' || typeof call.requestId === 'string');
    assert.match(call.rawText!, /"value":7\.00/);
    assert.deepEqual(call.envelope, JSON.parse(call.rawText!).structuredContent);
    assert.equal(call.resultBytes, Buffer.byteLength(call.rawText!));
    assert.equal(Buffer.byteLength(call.rawFrame), call.frameBytes);
    assert.equal(JSON.parse(call.rawFrame).id, call.requestId);
    assert.equal(JSON.parse(call.rawFrame).result.structuredContent.schema_version, call.envelope!.schema_version);
    assert.ok(call.frames.some(f => f.direction === 'received' && f.text === call.rawFrame));
    assert.ok(call.frames.some(f => f.direction === 'sent' && JSON.parse(f.text).method === 'tools/list'), 'pre-call discovery frames are retained');
    if (era === 'legacy') assert.ok(call.frames.some(f => f.direction === 'sent' && JSON.parse(f.text).method === 'initialize'));
    assert.ok(call.frames.some(f => f.direction === 'sent' && JSON.parse(f.text).id === call.requestId));
    assert.equal(call.frameBytes, Buffer.byteLength(`{"result":${call.rawText},"jsonrpc":"2.0","id":${JSON.stringify(call.requestId)}}\n`));
    assert.deepEqual(call.work, { metadata: 1, auth: 0, clinical: 1 }); assert.equal(call.outcome, undefined);
    const second = await session.call('fhir_read', { ...read, id: 'qs-obs-1' });
    assert.notEqual(second.requestId, call.requestId); assert.deepEqual(second.work, { metadata: 0, auth: 0, clinical: 1 });
    assert.equal((second.envelope!.data.resources as { id: string }[])[0]!.id, 'qs-obs-1');
    await session.close(); await rejects(session.call('fhir_read', read), 'CLIENT_CLOSED');
  }
  assert.equal(seen.length, 0, 'the parent SDK driver has no direct HTTP requests');
});

test('quickstart client: JSON-RPC, SDK text and application errors have separate outcomes and exact failed-call work', async t => {
  const f = await fixture(t);
  // The production adapter deliberately returns application envelopes for invalid input. Exercise the independent
  // SDK-text surface by replacing ONLY that zero-work error result at the child wire boundary.
  await f.preload(`const write = process.stdout.write.bind(process.stdout); process.stdout.write = function(chunk, ...args) {
    let m; try { m = JSON.parse(String(chunk)); } catch {}
    if (m?.result?.structuredContent?.error?.code === 'INVALID_ARGUMENTS') {
      m.result = {...m.result,isError:true,content:[{type:'text',text:'Input validation error: ${CANARY}'}]}; delete m.result.structuredContent;
      return write(JSON.stringify(m)+'\\n', ...args);
    }
    return write(chunk, ...args);
  };`);
  const session = await openGatewaySession(f.options('modern')); t.after(() => session.close());
  const rpc = await session.call('not_a_gateway_tool', {});
  assert.deepEqual(rpc.outcome, { class: 'json_rpc_error', code: -32602 });
  assert.equal(rpc.rawText, undefined); assert.equal(rpc.envelope, undefined); assert.equal(rpc.resultBytes, 0);
  assert.ok(rpc.frameBytes > 0); assert.deepEqual(rpc.work, { metadata: 0, auth: 0, clinical: 0 });
  const sdk = await session.call('fhir_read', { resource_type: 4, id: CANARY });
  assert.deepEqual(sdk.outcome, { class: 'sdk_text_error', code: 'sdk_text_error' });
  assert.equal(sdk.envelope, undefined); assert.ok(sdk.rawText); assert.deepEqual(sdk.work, { metadata: 0, auth: 0, clinical: 0 });
  const application = await session.call('fhir_page', { cursor: 'not-a-valid-cursor' });
  assert.equal(application.outcome?.class, 'application_error'); assert.equal(application.outcome?.code, application.envelope!.error!.code);
  assert.deepEqual(application.envelope, JSON.parse(application.rawText!).structuredContent);
  assert.deepEqual(application.work, { metadata: 0, auth: 0, clinical: 0 });
  assert.equal(f.requests.length, 0, 'all three refusals precede upstream HTTP');
  const good = await session.call('fhir_read', read); assert.deepEqual(good.work, { metadata: 1, auth: 0, clinical: 1 });
});

test('quickstart client: lagging counter pipe still attributes metadata, auth, local remainder and each upstream page exactly', async t => {
  const f = await fixture(t, { auth: true, lag: true, resourceCount: 8 });
  await f.preload(`
    // macOS injects __CF_USER_TEXT_ENCODING when starting Node, independently of spawn's env selection.
    if (Object.keys(process.env).filter(k => k !== '__CF_USER_TEXT_ENCODING').sort().join(',') !== 'PATH,QS_SECRET' || process.env.QS_SECRET !== '${CANARY}') process.exit(2);
  `);
  const session = await openGatewaySession(f.options('modern', { environment: { ...process.env, QS_SECRET: CANARY, NODE_OPTIONS: '--bad',
    HTTP_PROXY: `http://${CANARY}`, https_proxy: `http://${CANARY}`, NODE_USE_ENV_PROXY: '1', UNRELATED_SECRET: CANARY } })); t.after(() => session.close());
  // Four upstream resources cannot all fit in the first response. A larger subsequent delivery drains that retained
  // page before fetching the next. The backend log, independent of gateway budgets and the observer, judges each call.
  const first = await session.call('fhir_search', { resource_type: 'Observation', params: [], page_size: 4, output: { max_bytes: 4096 } });
  assert.equal(first.outcome, undefined); assert.deepEqual(first.work, { metadata: 1, auth: 1, clinical: 1 });
  let cursor = first.envelope?.pagination?.next_cursor; assert.ok(cursor);
  const pages = [first];
  while (cursor) {
    assert.ok(pages.length < 12, 'drain must make bounded progress');
    const before = f.requests.length;
    const page = await session.call('fhir_page', { cursor, output: { max_bytes: 8192 } });
    assert.equal(page.outcome, undefined);
    assert.deepEqual(page.work, { metadata: 0, auth: 0, clinical: f.requests.length - before });
    pages.push(page); cursor = page.envelope?.pagination?.next_cursor;
  }
  assert.deepEqual(pages[1]!.work, { metadata: 0, auth: 0, clinical: 0 }, 'local remainder precedes the next upstream page');
  assert.ok(pages.slice(2).some(call => call.work.clinical === 1), 'a later call fetches the second upstream page');
  const ids = pages.flatMap(call => (call.envelope!.data.resources as { id: string }[]).map(resource => resource.id));
  assert.deepEqual(ids, Array.from({ length: 8 }, (_, i) => `qs-obs-${i}`));
  assert.equal(f.requests.filter(path => path.startsWith('GET /fhir/Observation?')).length, 2);
  assert.equal(f.requests.filter(path => path.startsWith('POST')).length, 1);
  const retained = await session.call('fhir_result', { handle: first.envelope!.result!.handle, action: 'inspect' });
  assert.deepEqual(retained.work, { metadata: 0, auth: 0, clinical: 0 });
  const refused = await session.call('fhir_read', { resource_type: 'Patient', id: 'other-patient' });
  assert.equal(refused.outcome?.class, 'application_error'); assert.deepEqual(refused.work, { metadata: 0, auth: 0, clinical: 0 });
});

test('quickstart client: failed token and metadata attempts are counted rather than erased by error results', async t => {
  for (const mode of ['token', 'metadata'] as const) {
    const f = await fixture(t, { auth: true, tokenFails: mode === 'token', metadataFails: mode === 'metadata' });
    const session = await openGatewaySession(f.options('legacy', { environment: { ...process.env, QS_SECRET: CANARY } })); t.after(() => session.close());
    const call = await session.call('fhir_read', read);
    assert.equal(call.outcome?.class, 'application_error');
    assert.deepEqual(call.work, { metadata: mode === 'metadata' ? 1 : 0, auth: 1, clinical: 0 });
    await session.close();
  }
});

test('quickstart client: duplicate and out-of-order unknown replies refuse without borrowing another response', async t => {
  for (const mode of ['duplicate', 'future', 'stale'] as const) {
    const f = await fixture(t);
    await f.preload(`
      const original = process.stdout.write.bind(process.stdout); let previous;
      process.stdout.write = function(chunk, ...args) {
        const text = String(chunk); let m; try { m = JSON.parse(text); } catch {}
        if (m?.result?.structuredContent?.data?.resources) {
          if ('${mode}' === 'future') return original(JSON.stringify({...m,id:m.id+1})+'\\n'+text, ...args);
          if ('${mode}' === 'duplicate') return original(text+text, ...args);
          if (previous) return original(previous+text, ...args);
          previous = text;
        }
        return original(chunk, ...args);
      };
    `);
    const session = await openGatewaySession(f.options('modern')); t.after(() => session.close());
    if (mode === 'stale') assert.equal((await session.call('fhir_read', read)).outcome, undefined);
    await rejects(session.call('fhir_read', { ...read, id: 'qs-obs-1' }), 'CLIENT_RESPONSE_ID');
  }
});

test('quickstart client: call/frame bounds, concurrency and deadlines refuse with fixed codes and reap the child', async t => {
  const f = await fixture(t, { delay: 80 });
  const session = await openGatewaySession(f.options('legacy', { maxCalls: 1 })); t.after(() => session.close());
  const pending = session.call('fhir_read', read);
  await rejects(session.call('fhir_read', read), 'CLIENT_CALL_BUSY');
  await pending; await rejects(session.call('fhir_read', read), 'CLIENT_CALL_LIMIT');
  await session.close();
  const large = await fixture(t);
  await large.preload(`const write = process.stdout.write.bind(process.stdout); process.stdout.write = function(chunk, ...args) {
    let m; try {m=JSON.parse(String(chunk));} catch {}
    if (m?.result?.structuredContent) {m.result.content[0].text=' '.repeat(65537);return write(JSON.stringify(m)+'\\n', ...args);} return write(chunk, ...args);
  };`);
  const oversized = await openGatewaySession(large.options('legacy', { maxFrameBytes: 65536 })); t.after(() => oversized.close());
  await rejects(oversized.call('fhir_read', read), 'CLIENT_FRAME_LIMIT');
  const outbound = await openGatewaySession(f.options('legacy', { maxFrameBytes: 65536 })); t.after(() => outbound.close());
  await rejects(outbound.call('fhir_read', { ...read, patient_id: 'x'.repeat(65536) }), 'CLIENT_FRAME_LIMIT');
  const slow = await fixture(t, { delay: 5000 });
  let spawned: { exitCode: number | null; signalCode: string | null } | undefined;
  const diagnostic = channel('child_process'), capture = (m: unknown) => { spawned = (m as { process: typeof spawned }).process; };
  diagnostic.subscribe(capture);
  const timed = await openGatewaySession(slow.options('legacy', { callTimeoutMs: 1500 })); diagnostic.unsubscribe(capture); t.after(() => timed.close());
  await rejects(timed.call('fhir_read', read), 'CLIENT_DEADLINE');
  assert.ok(spawned && (spawned.exitCode !== null || spawned.signalCode !== null));
});

test('quickstart client: malformed frames and child stderr never enter safe faults', async t => {
  const f = await fixture(t);
  await f.preload(`const write = process.stdout.write.bind(process.stdout); process.stdout.write = function(chunk, ...args) {
    if (String(chunk).includes('"structuredContent"')) { process.stderr.write('${CANARY} /private/path\\n'); return write('{${CANARY}}\\n', ...args); }
    return write(chunk, ...args);
  };`);
  const session = await openGatewaySession(f.options('modern')); t.after(() => session.close());
  await rejects(session.call('fhir_read', read), 'CLIENT_FRAME_INVALID');
  await rejects(openGatewaySession({ argv: ['relative', 'bad', '--config', '/private/' + CANARY], era: 'modern' }), 'CLIENT_OPTIONS_INVALID');
  await rejects(openGatewaySession({ argv: [process.execPath, '/abs/cli', '--config', '/private/' + CANARY], era: 'modern' }), 'CLIENT_CONFIG_INVALID');
  await rejects(openGatewaySession(f.options('modern', { environment: { PATH: CANARY + '\0' } })), 'CLIENT_START_FAILED');
});

test('quickstart client: observer sequence faults and work outside a call refuse rather than certifying zero', async t => {
  for (const mode of ['sequence', 'unscoped'] as const) {
    const f = await fixture(t);
    await f.preload(`
      import { Socket } from 'node:net'; import { get } from 'node:http';
      const write = Socket.prototype.write;
      Socket.prototype.write = function(chunk, ...args) {
        if (this._handle?.fd === 3 && String(chunk).includes('"snapshot","sequence":3')) {
          if ('${mode}' === 'sequence') return write.call(this, String(chunk).replace('"sequence":3','"sequence":99'), ...args);
          setTimeout(() => get('${f.origin}/fhir/Observation/${CANARY}', res => res.resume()).on('error',()=>{}), 30);
        }
        return write.call(this, chunk, ...args);
      };
    `);
    const session = await openGatewaySession(f.options('legacy')); t.after(() => session.close());
    if (mode === 'sequence') await rejects(session.call('fhir_read', read), 'CLIENT_OBSERVER_INVALID');
    else {
      const first = await session.call('fhir_read', read); assert.deepEqual(first.work, { metadata: 1, auth: 0, clinical: 1 });
      await new Promise<void>(resolve => setTimeout(resolve, 150));
      assert.equal(f.requests.length, 3, 'the background request was actually sent by the child');
      await rejects(session.call('fhir_read', read), 'CLIENT_UNSCOPED_WORK');
    }
    await session.close();
  }
});

test('quickstart client: direct client HTTP fails independently of correct MCP facts', async t => {
  const f = await fixture(t);
  const session = await openGatewaySession(f.options('modern')); t.after(() => session.close());
  const good = await session.call('fhir_read', read); assert.equal(good.outcome, undefined);
  await new Promise<void>((resolve, reject) => get(`${f.origin}/fhir/Observation/${CANARY}`, res => { res.resume(); res.on('end', resolve); }).on('error', reject));
  await rejects(session.call('fhir_read', read), 'CLIENT_HTTP_FORBIDDEN');
});

test('quickstart client boundary: emitted client and observer load with only SDK and the pure oracle, without runner or gateway graph', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qs-boundary-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const helper = join(directory, 'examples/quickstart'), kernel = join(directory, 'packages/evals/src');
  await mkdir(helper, { recursive: true }); await mkdir(kernel, { recursive: true });
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'));
  for (const [source, target] of [
    ['examples/quickstart/client.ts', join(helper, 'client.mjs')], ['examples/quickstart/request-observer.ts', join(helper, 'request-observer.mjs')],
    ['packages/evals/src/evidence-oracle.ts', join(kernel, 'evidence-oracle.mjs')], ['packages/evals/src/check-contracts.ts', join(kernel, 'check-contracts.mjs')],
  ]) {
    const code = stripTypeScriptTypes(await readFile(join(root, source!), 'utf8')).replaceAll("'./check-contracts.js'", "'./check-contracts.mjs'")
      .replaceAll("'../../packages/evals/src/evidence-oracle.js'", "'../../packages/evals/src/evidence-oracle.mjs'");
    if (source!.endsWith('request-observer.ts')) {
      const imports = [...code.matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1]);
      assert.ok(imports.every(specifier => specifier!.startsWith('node:')), 'observer has built-ins only');
    }
    await writeFile(target!, code);
  }
  const result = execFileSync(process.execPath, ['--input-type=module', '-e',
    "const c = await import('./examples/quickstart/client.mjs'); process.stdout.write(typeof c.openGatewaySession);"],
  { cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result, 'function');
});

test('quickstart client: clean discovery launches without the observer preload and retains complete frames', async t => {
  const f = await fixture(t);
  await f.preload("if (process.execArgv.some(arg => arg.endsWith('/request-observer.ts') || arg.endsWith('/request-observer.js'))) process.exit(71);");
  const session = await openGatewaySession(f.options('modern', { observe: false })); t.after(() => session.close());
  const call = await session.call('fhir_capabilities', { topic: 'support', resource_type: 'Observation' });
  assert.equal(call.envelope!.data.rows instanceof Array, true);
  assert.deepEqual(call.work, { metadata: 0, auth: 0, clinical: 0 }, 'clean control has no observer counts');
  assert.equal(JSON.parse(call.rawFrame).id, call.requestId);
  assert.ok(call.frames.some(frame => frame.direction === 'received' && frame.text === call.rawFrame));
  assert.ok(f.requests.includes('GET /fhir/metadata'));
});
