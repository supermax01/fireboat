import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { ClientCredentialsProvider, type ClientCredentialsProviderOptions } from '../packages/auth/src/client-credentials.js';
import { stringifyFhir } from '../packages/core/src/decimal.js';
import { ambientProxyRisk, bearerInvalidToken, FhirTransport, GatewayFault, invalidatesCredential, type RejectionInfo, type TransportCredentials } from '../packages/core/src/transport.js';
import { guardAgainstUncaught } from './no-uncaught.js';

guardAgainstUncaught();

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to bind');
  const origin = `http://127.0.0.1:${address.port}`;
  return { origin, base: `${origin}/fhir/`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), label);
}

const SECRET_ENV = 'FHIR_MCP_TRANSPORT_TEST_SECRET';
const json = (res: ServerResponse, body: unknown, status = 200, type = 'application/json') => { res.statusCode = status; res.setHeader('content-type', type); res.end(JSON.stringify(body)); };
const observation = (id: string) => ({ resourceType: 'Observation', id, status: 'final', code: { text: 'Synthetic' } });

/** A real provider behind the TransportCredentials hooks, wired with the agreed policy: invalidate only on 401/validated invalid_token, scoped to the request's generation. */
function credentialed(base: string, tokenUrl: string, options: ClientCredentialsProviderOptions = {}) {
  const provider = new ClientCredentialsProvider(base, { type: 'client_credentials', tokenUrl, clientId: 'synthetic-client', clientSecretEnv: SECRET_ENV }, { env: { [SECRET_ENV]: 'synthetic-secret' }, ...options });
  const rejections: (RejectionInfo | undefined)[] = [];
  const credentials: TransportCredentials = {
    authorizationFor: (url, budget) => provider.authorizationFor(url, budget),
    authorizationWithGeneration: (url, budget) => provider.authorizationWithGeneration(url, budget),
    onRejected: info => { rejections.push(info); if (invalidatesCredential(info)) provider.invalidate(info?.generation); },
  };
  return { provider, credentials, rejections };
}

test('a same-source FHIR root continuation is valid, sibling paths remain blocked', () => {
  const transport = new FhirTransport('http://127.0.0.1:8080/fhir', 1024, 1000);
  assert.equal(transport.validate('http://127.0.0.1:8080/fhir?_getpages=opaque').pathname, '/fhir');
  assert.throws(() => transport.validate('http://127.0.0.1:8080/fhir-evil/Observation'), /configured FHIR source/);
  assert.throws(() => transport.validate('http://127.0.0.1:8080/fhir/../private'), /configured FHIR source/);
  assert.throws(() => transport.validate('http://127.0.0.1:8081/fhir/Observation'), /configured FHIR source/);
});

test('HTTP redirects are rejected without following the destination', async t => {
  let redirectedRequests = 0;
  const f = await fixture((req, res) => {
    if (req.url === '/fhir/metadata') { res.statusCode = 302; res.setHeader('location', '/fhir/target'); res.end(); }
    else { redirectedRequests++; res.end('{}'); }
  }); t.after(f.close);
  const transport = new FhirTransport(f.base, 1024, 1000);
  await assert.rejects(transport.get(transport.url('metadata'), { calls: 0 }), { code: 'UNSAFE_REDIRECT' });
  assert.equal(redirectedRequests, 0);
});

test('decompressed response bytes are bounded even with a small compressed length', async t => {
  const compressed = gzipSync(JSON.stringify({ resourceType: 'Binary', data: 'x'.repeat(20000) }));
  const f = await fixture((_req, res) => { res.setHeader('content-type', 'application/fhir+json'); res.setHeader('content-encoding', 'gzip'); res.setHeader('content-length', compressed.length); res.end(compressed); }); t.after(f.close);
  const transport = new FhirTransport(f.base, 512, 1000);
  await assert.rejects(transport.get(transport.url('Binary/test'), { calls: 0 }), { code: 'UPSTREAM_LIMIT' });
  assert.deepEqual(await new FhirTransport(f.base, 32_768, 1000).get(transport.url('Binary/test'), { calls: 0 }), { resourceType: 'Binary', data: 'x'.repeat(20000) });
});

test('unsupported response content encodings are refused rather than parsed as JSON', async t => {
  const f = await fixture((_req, res) => { res.setHeader('content-type', 'application/fhir+json'); res.setHeader('content-encoding', 'compress'); res.end('{"resourceType":"Basic"}'); }); t.after(f.close);
  const transport = new FhirTransport(f.base, 1024, 1000);
  await assert.rejects(transport.get(transport.url('Basic/x'), { calls: 0 }), { code: 'UNSUPPORTED_CONTENT', retryable: false });
});

test('a nonresponsive upstream terminates at the configured deadline', async t => {
  const f = await fixture(() => { /* Intentionally leave the response open. */ }); t.after(f.close);
  const transport = new FhirTransport(f.base, 512, 20);
  await assert.rejects(transport.get(transport.url('metadata'), { calls: 0 }), { code: 'UPSTREAM_TIMEOUT' });
});

// J-14: credentialed traffic must not follow ambient proxy configuration.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTROL_CHILD = `
import { get } from 'node:http';
const [base] = process.argv.slice(-1);
await fetch(new URL('metadata', base), { signal: AbortSignal.timeout(5000) }).then(response => response.arrayBuffer(), () => undefined);
await new Promise(resolve => {
  const request = get(new URL('metadata', base), response => { response.resume(); response.on('end', resolve); });
  request.on('error', resolve);
  request.setTimeout(5000, () => { request.destroy(); resolve(undefined); });
});
process.exit(0);
`;
const GATEWAY_CHILD = `
const { FhirTransport } = await import(${JSON.stringify(new URL('../packages/core/src/transport.ts', import.meta.url).href)});
const { ClientCredentialsProvider } = await import(${JSON.stringify(new URL('../packages/auth/src/client-credentials.ts', import.meta.url).href)});
const [base, tokenUrl] = process.argv.slice(-2);
const provider = new ClientCredentialsProvider(base, { type: 'client_credentials', tokenUrl, clientId: 'proxy-client', clientSecretEnv: '${SECRET_ENV}' });
const transport = new FhirTransport(base, 65536, 5000, { authorizationFor: url => provider.authorizationFor(url), onRejected: () => undefined });
const resource = await transport.get(transport.url('Patient/synthetic-proxy'), { calls: 0 });
process.stdout.write(JSON.stringify({ resourceType: resource.resourceType }), () => process.exit(0));
`;
function runChild(code: string, env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', exit => resolve({ code: exit, stdout, stderr }));
  });
}

test('FHIR and token traffic bypass ambient proxies in a NODE_USE_ENV_PROXY child process', async t => {
  let proxyConnections = 0;
  const proxy = createServer((_req, res) => { res.statusCode = 502; res.setHeader('connection', 'close'); res.end(); });
  proxy.on('connection', () => { proxyConnections++; });
  proxy.on('connect', (_req, socket) => { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); }));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Proxy failed to bind');
  const seen: { path: string; authorization?: string }[] = [];
  const f = await fixture((req, res) => {
    seen.push({ path: req.url ?? '', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
    if (req.url === '/oauth/token') { req.resume(); json(res, { access_token: 'synthetic-proxy-token', token_type: 'Bearer', expires_in: 3600 }); return; }
    if (req.url === '/fhir/Patient/synthetic-proxy' && req.headers.authorization === 'Bearer synthetic-proxy-token') { json(res, { resourceType: 'Patient', id: 'synthetic-proxy' }, 200, 'application/fhir+json'); return; }
    json(res, { resourceType: 'OperationOutcome' }, req.url === '/fhir/metadata' ? 200 : 401, 'application/fhir+json');
  }); t.after(f.close);
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: 'localhost', no_proxy: 'localhost', [SECRET_ENV]: 'synthetic-proxy-secret' };
  delete env.NODE_TEST_CONTEXT;
  assert.equal(ambientProxyRisk(env, []).risk, true);

  // Positive control: ambient fetch and the default http agent in the same environment do reach the proxy.
  const control = await runChild(CONTROL_CHILD, env, [f.base]);
  assert.equal(control.code, 0, control.stderr);
  assert.ok(proxyConnections >= 1, 'control: the environment proxy must be active for this regression to be meaningful');

  proxyConnections = 0;
  seen.length = 0;
  const run = await runChild(GATEWAY_CHILD, env, [f.base, `${f.origin}/oauth/token`]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { resourceType: 'Patient' });
  assert.equal(proxyConnections, 0, 'the proxy must see zero connections from the gateway transport and token client');
  assert.deepEqual(seen.map(request => request.path), ['/oauth/token', '/fhir/Patient/synthetic-proxy']);
  assert.equal(seen[1]?.authorization, 'Bearer synthetic-proxy-token');
});

test('ambientProxyRisk detects env-proxy activation from the environment, NODE_OPTIONS and execArgv, reporting names only', () => {
  const proxy = 'http://user:proxy-password@127.0.0.1:3128';
  assert.deepEqual(ambientProxyRisk({}, []), { enabled: false, activatedBy: [], proxyVariables: [], risk: false });
  assert.deepEqual(ambientProxyRisk({ HTTP_PROXY: proxy }, []), { enabled: false, activatedBy: [], proxyVariables: ['HTTP_PROXY'], risk: false });
  const active = ambientProxyRisk({ NODE_USE_ENV_PROXY: '1', https_proxy: proxy }, []);
  assert.deepEqual(active, { enabled: true, activatedBy: ['NODE_USE_ENV_PROXY'], proxyVariables: ['https_proxy'], risk: true });
  assert.ok(!JSON.stringify(active).includes('proxy-password'));
  assert.deepEqual(ambientProxyRisk({ NODE_OPTIONS: '--max-old-space-size=128 --use-env-proxy', HTTPS_PROXY: proxy }, []).activatedBy, ['NODE_OPTIONS']);
  assert.deepEqual(ambientProxyRisk({ HTTP_PROXY: proxy }, ['--import', 'tsx', '--use-env-proxy']).activatedBy, ['execArgv']);
  assert.equal(ambientProxyRisk({ NODE_USE_ENV_PROXY: '0', NODE_OPTIONS: '--use-env-proxy --no-use-env-proxy', HTTP_PROXY: proxy }, ['--no-use-env-proxy']).enabled, false);
});

// J-16: structured rejection info; a plain 403 is a request denial, not credential invalidity.
test('only a Bearer invalid_token challenge counts as credential invalidity', () => {
  for (const header of ['Bearer error="invalid_token"', 'Bearer realm="fhir", error="invalid_token", error_description="expired"', 'Basic realm="x", Bearer error=invalid_token', 'bearer  error = "invalid_token"', 'Bearer realm="a,b", error="invalid_token"']) assert.equal(bearerInvalidToken(header), true, header);
  for (const header of [null, '', 'Bearer', 'Bearer error="insufficient_scope"', 'Bearer realm="error=\\"invalid_token\\""', 'Basic error="invalid_token"', 'DPoP error="invalid_token"', 'Bearer error="invalid_token_x"', 'Bearer error_description="invalid_token"']) assert.equal(bearerInvalidToken(header), false, String(header));
  assert.equal(invalidatesCredential({ status: 403, invalidToken: false, isMetadata: true }), false);
  assert.equal(invalidatesCredential({ status: 403, invalidToken: true, isMetadata: false }), true);
  assert.equal(invalidatesCredential({ status: 401, invalidToken: false, isMetadata: false }), true);
  assert.equal(invalidatesCredential(), true, 'legacy callers without info stay conservative');
});

test('onRejected receives status, invalid_token, metadata and generation; a plain 403 changes no credential state', async t => {
  let tokenCalls = 0;
  const f = await fixture((req, res) => {
    if (req.url === '/oauth/token') { tokenCalls++; req.resume(); json(res, { access_token: `synthetic-access-${tokenCalls}`, token_type: 'Bearer', expires_in: 3600 }); return; }
    const challenge: Record<string, [number, string?]> = {
      '/fhir/Observation/denied': [403],
      '/fhir/Observation/scope': [403, 'Bearer realm="fhir", error="insufficient_scope"'],
      '/fhir/Observation/revoked': [403, 'Bearer realm="fhir", error="invalid_token", error_description="revoked"'],
      '/fhir/Observation/expired': [401, 'Bearer error="invalid_token"'],
      '/fhir/metadata': [401],
    };
    const outcome = challenge[req.url ?? ''];
    if (outcome) { if (outcome[1]) res.setHeader('www-authenticate', outcome[1]); json(res, { resourceType: 'OperationOutcome' }, outcome[0], 'application/fhir+json'); return; }
    json(res, observation('ok'), 200, 'application/fhir+json');
  }); t.after(f.close);
  const { credentials, rejections } = credentialed(f.base, `${f.origin}/oauth/token`);
  const transport = new FhirTransport(f.base, 4096, 1000, credentials);
  const get = (path: string) => transport.get(transport.url(path), { calls: 0 });
  await get('Observation/ok');
  for (const path of ['Observation/denied', 'Observation/scope']) {
    await assert.rejects(get(path), { code: 'NOT_FOUND', status: 403 });
    await get('Observation/ok');
  }
  assert.equal(tokenCalls, 1, 'plain and insufficient_scope 403s must not discard the token');
  assert.deepEqual(rejections, [{ status: 403, invalidToken: false, isMetadata: false, generation: 0 }, { status: 403, invalidToken: false, isMetadata: false, generation: 0 }]);
  await assert.rejects(get('Observation/revoked'), { code: 'CONNECTION_REQUIRED', status: 403 });
  await get('Observation/ok');
  assert.equal(tokenCalls, 2, 'a validated invalid_token 403 invalidates the credential that made the request');
  await assert.rejects(get('Observation/expired'), { code: 'CONNECTION_REQUIRED', status: 401 });
  await assert.rejects(get('metadata'), { code: 'CONNECTION_REQUIRED', status: 401 });
  assert.deepEqual(rejections.slice(2), [
    { status: 403, invalidToken: true, isMetadata: false, generation: 0 },
    { status: 401, invalidToken: true, isMetadata: false, generation: 1 },
    { status: 401, invalidToken: false, isMetadata: true, generation: 2 },
  ]);
});

test('a legacy zero-argument onRejected implementation still runs on 401 and 403', async t => {
  const f = await fixture((req, res) => json(res, { resourceType: 'OperationOutcome' }, req.url === '/fhir/metadata' ? 401 : 403, 'application/fhir+json')); t.after(f.close);
  let legacy = 0;
  const transport = new FhirTransport(f.base, 1024, 1000, { authorizationFor: async () => 'Bearer synthetic', onRejected: () => { legacy++; } });
  await assert.rejects(transport.get(transport.url('metadata'), { calls: 0 }), { code: 'CONNECTION_REQUIRED' });
  await assert.rejects(transport.get(transport.url('Observation/x'), { calls: 0 }), { code: 'NOT_FOUND' });
  assert.equal(legacy, 2);
});

// J-21: a late rejection of an older token must not discard a newer one.
test('a late 401 for a superseded credential generation does not invalidate the fresh token', async t => {
  let tokenCalls = 0;
  let rejectNext = false;
  const held: ServerResponse[] = [];
  const f = await fixture((req, res) => {
    if (req.url === '/oauth/token') { tokenCalls++; req.resume(); json(res, { access_token: `synthetic-access-${tokenCalls}`, token_type: 'Bearer', expires_in: 3600 }); return; }
    if (req.url === '/fhir/Observation/held') { held.push(res); return; }
    if (rejectNext || req.headers.authorization !== `Bearer synthetic-access-${tokenCalls}`) { rejectNext = false; json(res, {}, 401); return; }
    json(res, observation('ok'), 200, 'application/fhir+json');
  }); t.after(f.close);
  const { credentials, rejections } = credentialed(f.base, `${f.origin}/oauth/token`);
  const transport = new FhirTransport(f.base, 4096, 2000, credentials);
  const get = (path: string) => transport.get(transport.url(path), { calls: 0 });
  await get('Observation/ok');
  const old = get('Observation/held');
  await waitFor(() => held.length === 1, 'held request must be waiting');
  rejectNext = true;
  await assert.rejects(get('Observation/ok'), { code: 'CONNECTION_REQUIRED' });
  await get('Observation/ok');
  assert.equal(tokenCalls, 2);
  held[0]!.statusCode = 401;
  held[0]!.end('{}');
  await assert.rejects(old, { code: 'CONNECTION_REQUIRED' });
  await get('Observation/ok');
  assert.equal(tokenCalls, 2, 'the late rejection of generation 0 must not discard the generation 1 token');
  assert.deepEqual(rejections.map(info => info?.generation), [0, 0]);
});

// J-22: caller cancellation and an overall deadline, combined with the per-request timeout.
test('get() honors an overall deadline and a caller signal, aborting the upstream request', async t => {
  let opened = 0;
  let closed = 0;
  const f = await fixture((_req, res) => { opened++; res.on('close', () => { closed++; }); }); t.after(f.close);
  const transport = new FhirTransport(f.base, 1024, 5_000);
  let started = Date.now();
  await assert.rejects(transport.get(transport.url('metadata'), { calls: 0 }, { deadline: Date.now() + 50 }), { code: 'UPSTREAM_TIMEOUT', retryable: true });
  assert.ok(Date.now() - started < 2_000, 'the remaining budget, not the 5 s request timeout, must bound the request');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  started = Date.now();
  await assert.rejects(transport.get(transport.url('metadata'), { calls: 0 }, { signal: controller.signal }), { code: 'REQUEST_CANCELLED', retryable: false });
  assert.ok(Date.now() - started < 2_000);
  await waitFor(() => closed === 2, 'both upstream requests must be aborted');
  const stats = { calls: 0 };
  await assert.rejects(transport.get(transport.url('metadata'), stats, { deadline: Date.now() - 1 }), { code: 'UPSTREAM_TIMEOUT' });
  await assert.rejects(transport.get(transport.url('metadata'), stats, { signal: AbortSignal.abort() }), { code: 'REQUEST_CANCELLED' });
  assert.equal(stats.calls, 0);
  assert.equal(opened, 2, 'an exhausted budget never contacts the source');
});

test('token acquisition inside get() honors the transport timeout and aborts the abandoned token request', async t => {
  let tokenClosed = 0;
  let fhirRequests = 0;
  const f = await fixture((req, res) => {
    if (req.url === '/oauth/token') { res.on('close', () => { tokenClosed++; }); return; }
    fhirRequests++; json(res, observation('ok'), 200, 'application/fhir+json');
  }); t.after(f.close);
  const { credentials } = credentialed(f.base, `${f.origin}/oauth/token`);
  const transport = new FhirTransport(f.base, 1024, 60, credentials);
  const stats = { calls: 0 };
  const started = Date.now();
  await assert.rejects(transport.get(transport.url('metadata'), stats), { code: 'TOKEN_TIMEOUT', retryable: true });
  assert.ok(Date.now() - started < 2_000, 'the provider default (10 s) must not outlast the transport timeout');
  assert.equal(stats.calls, 0);
  assert.equal(fhirRequests, 0);
  await waitFor(() => tokenClosed === 1, 'the sole waiter left, so the shared token request must be aborted');
});

// J-41: strict UTF-8 decoding with a defined BOM/charset policy and non-retryable faults.
test('FHIR JSON is decoded as strict UTF-8: malformed bytes and other charsets are refused, a BOM is stripped', async t => {
  const bodies: Record<string, [string, Buffer]> = {
    '/fhir/Basic/ff': ['application/fhir+json', Buffer.concat([Buffer.from('{"resourceType":"Basic","id":"ff","note":"'), Buffer.from([0xff]), Buffer.from('"}')])],
    '/fhir/Basic/latin1': ['application/fhir+json; charset=iso-8859-1', Buffer.from('{"resourceType":"Basic","id":"latin1"}')],
    '/fhir/Basic/bom': ['application/fhir+json; charset="UTF-8"; fhirVersion=4.0', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"resourceType":"Basic","id":"bom","note":"é"}')])],
    '/fhir/Basic/utf16': ['application/fhir+json', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"resourceType":"Basic"}', 'utf16le')])],
    '/fhir/Basic/malformed': ['application/fhir+json', Buffer.from('{"resourceType":"Basic",')],
  };
  const f = await fixture((req, res) => { const [type, body] = bodies[req.url ?? '']!; res.setHeader('content-type', type); res.end(body); }); t.after(f.close);
  const transport = new FhirTransport(f.base, 4096, 1000);
  const get = (id: string) => transport.get(transport.url(`Basic/${id}`), { calls: 0 });
  await assert.rejects(get('ff'), { code: 'INVALID_RESPONSE', retryable: false });
  await assert.rejects(get('latin1'), { code: 'UNSUPPORTED_CONTENT', retryable: false });
  assert.deepEqual(await get('bom'), { resourceType: 'Basic', id: 'bom', note: 'é' });
  await assert.rejects(get('utf16'), { code: 'INVALID_RESPONSE', retryable: false });
  await assert.rejects(get('malformed'), { code: 'INVALID_RESPONSE', retryable: false });
});

// J-15 (transport part): the HTTP status reaches the integrator without changing public codes.
test('faults raised after an upstream response carry the HTTP status; public codes are unchanged', async t => {
  const replies: Record<string, [number, string]> = {
    missing: [404, '{"resourceType":"OperationOutcome"}'], gone: [410, '{"resourceType":"OperationOutcome"}'], denied: [403, '{"resourceType":"OperationOutcome"}'],
    busy: [503, '{}'], big: [200, JSON.stringify({ resourceType: 'Observation', note: 'x'.repeat(5000) })], bad: [200, '{"resourceType":'],
    precise: [200, '{"resourceType":"Observation","id":"precise","valueQuantity":{"value":7.0}}'],
  };
  const f = await fixture((req, res) => { const [status, body] = replies[(req.url ?? '').split('/').at(-1)!]!; res.statusCode = status; res.setHeader('content-type', 'application/fhir+json'); res.end(body); }); t.after(f.close);
  const transport = new FhirTransport(f.base, 4096, 1000);
  const expected: [string, string, number][] = [['missing', 'NOT_FOUND', 404], ['gone', 'UPSTREAM_ERROR', 410], ['denied', 'NOT_FOUND', 403], ['busy', 'UPSTREAM_ERROR', 503], ['big', 'UPSTREAM_LIMIT', 200], ['bad', 'INVALID_RESPONSE', 200]];
  for (const [id, code, status] of expected) {
    await assert.rejects(transport.get(transport.url(`Observation/${id}`), { calls: 0 }), (error: unknown) => error instanceof GatewayFault && error.code === code && error.status === status, id);
  }
  // J-6: a non-canonical decimal lexeme now parses losslessly instead of failing the whole response.
  const precise = await transport.get(transport.url('Observation/precise'), { calls: 0 });
  assert.ok(stringifyFhir(precise).includes('"value":7.0'));
  const unused = await fixture(() => undefined);
  await unused.close();
  const unreachable = new FhirTransport(unused.base, 1024, 1000);
  await assert.rejects(unreachable.get(unreachable.url('metadata'), { calls: 0 }), (error: unknown) => error instanceof GatewayFault && error.code === 'UPSTREAM_ERROR' && error.status === undefined);
});
