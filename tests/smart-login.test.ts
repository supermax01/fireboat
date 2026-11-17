import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { FhirGateway } from '../packages/core/src/index.js';
import { CallbackFault, type LoginIo } from '../packages/auth/src/smart-standalone.js';
import { listenLoopbackCallback } from '../packages/server/src/login.js';
import { readTokenFile, writeTokenFile } from '../packages/auth/src/token-store.js';
import { approve, KEY_ENV, SMART_PATIENT, smartConfig, standaloneConfig, startSmartStub, type Rec, type SmartStub, type StubOptions } from './smart-helpers.js';
import { guardAgainstUncaught } from './no-uncaught.js';

guardAgainstUncaught();

const root = fileURLToPath(new URL('../', import.meta.url));
const SERVED = 28;

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fireboat-smart-login-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function stubFor(t: TestContext, options: StubOptions = {}): Promise<SmartStub> {
  const stub = await startSmartStub(options); t.after(stub.close); return stub;
}
/**
 * The real listener, closed by the test itself if it outlives its own timeout by five seconds: a listener whose timeout
 * is broken then fails the test (LISTENER_CLOSED) instead of keeping the test file running.
 */
const guardedListen: LoginIo['listen'] = async (port, timeoutMs, accept) => {
  const listener = await listenLoopbackCallback(port, timeoutMs, accept);
  const guard = setTimeout(() => { listener.close(); }, timeoutMs + 5_000);
  guard.unref();
  listener.result.then(() => clearTimeout(guard), () => clearTimeout(guard));
  return listener;
};
/** In-process sign-in through the same gateway method `fireboat login` uses, approved by a browser stand-in. */
async function signIn(config: Rec, browser: (url: string) => Promise<unknown> = approve, timeoutMs = 5_000) {
  const gateway = new FhirGateway(config as never);
  let pending: Promise<unknown> = Promise.resolve();
  let authorizeUrl: URL | undefined;
  try {
    const result = await gateway.smartLogin({ listen: guardedListen, timeoutMs,
      onAuthorizeUrl: url => { authorizeUrl = url; pending = browser(url.href).catch(error => error); } });
    return { result, authorizeUrl: authorizeUrl! };
  } finally { await pending; gateway.close(); }
}
const rawGet = (port: number, path: string, host: string, method = 'GET') => new Promise<{ status: number; headers: Rec; body: string }>((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method, headers: { host } }, res => {
    let body = ''; res.on('data', chunk => { body += String(chunk); }); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
  });
  req.on('error', reject); req.end();
});

interface CliRun { code: number; stdout: string; stderr: string; authorizeUrl?: string }
/** Runs the built-from-source CLI; `browser` receives the authorization URL that login prints to stderr. */
function runCli(args: string[], env: Rec = {}, browser?: (url: string) => Promise<unknown>): Promise<CliRun> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'packages/server/src/cli.ts', ...args], { cwd: root,
      env: { ...process.env, FIREBOAT_CONFIG: undefined, FHIR_MCP_CONFIG: undefined, ...env } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', authorizeUrl: string | undefined, pending: Promise<unknown> = Promise.resolve();
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
      const match = /^fireboat: authorize: (\S+)$/m.exec(stderr);
      if (match && !authorizeUrl) { const url = match[1]!; authorizeUrl = url; if (browser) pending = browser(url).catch(error => error); }
    });
    // A command that hangs (for example a login whose callback timeout never fires) is stopped and fails its test.
    const guard = setTimeout(() => { child.kill('SIGKILL'); }, 30_000);
    child.on('close', async code => { clearTimeout(guard); await pending; resolve({ code: code ?? -1, stdout, stderr, authorizeUrl }); });
  });
}
async function configFile(dir: string, config: Rec): Promise<string> {
  const path = join(dir, 'config.json'); await writeFile(path, JSON.stringify(config)); return path;
}
async function stdioSession(t: TestContext, configPath: string, env: Rec = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'packages/server/src/cli.ts', '--config', configPath],
    env: { ...getDefaultEnvironment(), TMPDIR: tmpdir(), ...env }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'smart-standalone-stdio', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(transport);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await client.close(); } };
  t.after(close);
  const call = async (name: string, args: Rec) => {
    const result = await client.callTool({ name, arguments: { ...args, output: { format: 'fhir', max_bytes: 24576 } } });
    return { envelope: result.structuredContent as Rec, raw: JSON.stringify(result) };
  };
  return { call, close, stderr: () => stderr };
}

test('SMART login listener: binds 127.0.0.1 only and refuses a wrong Host, a wrong path or method, and a second callback', async () => {
  const listener = await listenLoopbackCallback(0, 5_000, params => params.get('state') === 'synthetic-state-value');
  try {
    assert.equal(listener.host, '127.0.0.1');
    assert.equal(listener.redirectUri, `http://127.0.0.1:${listener.port}/callback`);
    let settled = false;
    void listener.result.then(() => { settled = true; }, () => { settled = true; });
    const host = `127.0.0.1:${listener.port}`;
    const valid = '/callback?code=synthetic-code-value&state=synthetic-state-value';
    for (const wrongHost of [`localhost:${listener.port}`, `evil.example.test`, `127.0.0.1:${listener.port + 1}`]) {
      assert.equal((await rawGet(listener.port, valid, wrongHost)).status, 400, wrongHost);
    }
    assert.equal((await rawGet(listener.port, valid.replace('/callback', '/other'), host)).status, 404);
    assert.equal((await rawGet(listener.port, valid, host, 'POST')).status, 404);
    assert.equal(settled, false, 'refused requests do not consume the one callback');
    const page = await rawGet(listener.port, valid, host);
    assert.equal(page.status, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.ok(!page.body.includes('synthetic-code-value') && !page.body.includes('synthetic-state-value'), 'the page never echoes request values');
    assert.match(page.body, /Return to the terminal to see the result\./);
    const params = await listener.result;
    assert.equal(params.get('code'), 'synthetic-code-value');
    assert.equal((await rawGet(listener.port, valid, host)).status, 410, 'a second valid callback is gone');
    listener.close();
    await assert.rejects(rawGet(listener.port, valid, host), 'the listener is closed');
  } finally { listener.close(); }
});

test('SMART login listener: a callback with another state is refused and does not consume the listener', async () => {
  const listener = await listenLoopbackCallback(0, 5_000, params => params.get('state') === 'synthetic-state-value');
  try {
    const host = `127.0.0.1:${listener.port}`;
    let settled = false;
    void listener.result.then(() => { settled = true; }, () => { settled = true; });
    for (const probe of ['/callback', '/callback?code=probe', '/callback?code=probe&state=other-state', '/callback?error=access_denied&state=other-state']) {
      assert.equal((await rawGet(listener.port, probe, host)).status, 400, probe);
    }
    assert.equal(settled, false, 'probes do not consume the callback');
    assert.equal((await rawGet(listener.port, '/callback?code=synthetic-code-value&state=synthetic-state-value', host)).status, 200);
    assert.equal((await listener.result).get('code'), 'synthetic-code-value');
  } finally { listener.close(); }
});

test('SMART login listener: closes after the timeout without a callback', async () => {
  const started = performance.now();
  const listener = await listenLoopbackCallback(0, 60, () => true);
  try {
    const late = sleep(2_000).then(() => { throw new Error('the listener did not time out'); });
    late.catch(() => undefined);
    await assert.rejects(Promise.race([listener.result, late]), (error: unknown) => error instanceof CallbackFault && error.code === 'CALLBACK_TIMEOUT');
    assert.ok(performance.now() - started < 1_500, 'the listener stopped at its timeout');
    await assert.rejects(rawGet(listener.port, '/callback?code=late&state=late', `127.0.0.1:${listener.port}`));
  } finally { listener.close(); }
});

test('SMART login: discovery, PKCE S256 and state reach the authorization server, and the grant is stored 0600 in a 0700 directory', async t => {
  const stub = await stubFor(t);
  const dir = await tempDir(t);
  const tokenFile = join(dir, 'state', 'fireboat', 'smart-launch.json');
  const { result, authorizeUrl } = await signIn(standaloneConfig(stub, tokenFile));
  assert.deepEqual(result, { scope: 'exact', grantedTypes: SERVED, servedTypes: SERVED, refresh: false, warnings: [] });
  const params = authorizeUrl.searchParams;
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('aud'), stub.baseUrl.replace(/\/$/, ''));
  assert.match(params.get('state')!, /^[A-Za-z0-9_-]{43}$/);
  const scope = params.get('scope')!.split(' ');
  assert.equal(scope[0], 'launch/patient');
  assert.ok(scope.includes('patient/Observation.rs') && !scope.includes('offline_access') && scope.every(s => !s.startsWith('system/')));
  const exchange = stub.tokenRequests.at(-1)!;
  assert.equal(exchange.rejected, undefined);
  assert.equal(exchange.form.get('grant_type'), 'authorization_code');
  assert.equal(params.get('code_challenge'), createHash('sha256').update(exchange.form.get('code_verifier')!, 'ascii').digest('base64url'));
  assert.match(exchange.form.get('code_verifier')!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(exchange.form.get('redirect_uri'), params.get('redirect_uri'));
  const grant = await readTokenFile(tokenFile);
  assert.ok(grant);
  assert.equal(grant.binding.patientId, SMART_PATIENT);
  assert.equal(grant.binding.tokenEndpoint, stub.tokenUrl);
  assert.equal(grant.refreshToken, undefined);
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, 'state', 'fireboat'))).mode & 0o777, 0o700);
  assert.equal(stub.fhirRequests.length, 0, 'login sends nothing to the FHIR source');
});

test('SMART login: every sign-in uses a fresh state and PKCE verifier', async t => {
  const stub = await stubFor(t);
  const tokenFile = join(await tempDir(t), 'grant.json');
  const first = await signIn(standaloneConfig(stub, tokenFile));
  const second = await signIn(standaloneConfig(stub, tokenFile));
  assert.notEqual(first.authorizeUrl.searchParams.get('state'), second.authorizeUrl.searchParams.get('state'));
  assert.notEqual(first.authorizeUrl.searchParams.get('code_challenge'), second.authorizeUrl.searchParams.get('code_challenge'));
  const verifiers = stub.tokenRequests.map(r => r.form.get('code_verifier'));
  assert.equal(verifiers.length, 2);
  assert.notEqual(verifiers[0], verifiers[1]);
});

test('SMART login: offline_access is requested only when the operator opts in, and the refresh token is stored', async t => {
  const stub = await stubFor(t);
  const dir = await tempDir(t);
  const tokenFile = join(dir, 'grant.json');
  const { result, authorizeUrl } = await signIn(standaloneConfig(stub, tokenFile, { offlineAccess: true, scopeSyntax: 'v1', scopes: ['patient/Observation.read', 'patient/Patient.read'] }));
  assert.equal(result.refresh, true);
  assert.equal(result.scope, 'exact', 'judged against the operator override, not the served registry');
  assert.equal(result.grantedTypes, 2);
  assert.deepEqual(authorizeUrl.searchParams.get('scope')!.split(' '), ['launch/patient', 'patient/Observation.read', 'patient/Patient.read', 'offline_access']);
  const grant = await readTokenFile(tokenFile);
  assert.ok(grant?.refreshToken && stub.refreshTokens.has(grant.refreshToken));
});

test('SMART login: a code exchange naming another patient, or none, stores nothing and sends no FHIR request', async t => {
  for (const [launchPatient, code] of [['synthetic-smart-b', 'PATIENT_MISMATCH'], [null, 'PATIENT_CONTEXT_MISSING']] as const) {
    const stub = await stubFor(t, { launchPatient });
    const tokenFile = join(await tempDir(t), 'grant.json');
    await assert.rejects(signIn(standaloneConfig(stub, tokenFile)), (error: unknown) => (error as { code?: string }).code === code, code);
    assert.equal(await readTokenFile(tokenFile), null, `${code}: nothing stored`);
    assert.equal(stub.fhirRequests.length, 0);
    assert.equal(stub.tokenRequests.length, 1);
  }
});

test('SMART login: a callback with the wrong state is refused before any code exchange and stores nothing', async t => {
  const stub = await stubFor(t, { authorize: () => ({ state: 'forged-state-value-that-is-long-enough-to-pass-a-length-check' }) });
  const tokenFile = join(await tempDir(t), 'grant.json');
  let callbackStatus = 0;
  await assert.rejects(signIn(standaloneConfig(stub, tokenFile), async url => { callbackStatus = (await approve(url)).status; }, 400),
    (error: unknown) => (error as { code?: string }).code === 'CALLBACK_TIMEOUT');
  assert.equal(callbackStatus, 400, 'the listener refused the forged callback');
  assert.equal(stub.tokenRequests.length, 0, 'the code was never exchanged');
  assert.equal(await readTokenFile(tokenFile), null);
});

test('SMART login: authorization errors, missing PKCE support and write-capable grants store nothing', async t => {
  const cases: [StubOptions, string][] = [
    [{ authorize: () => ({ error: 'access_denied' }) }, 'AUTHORIZATION_DENIED'],
    [{ discovery: doc => ({ ...doc, code_challenge_methods_supported: ['plain'] }) }, 'PKCE_UNSUPPORTED'],
    [{ discovery: doc => { delete doc.code_challenge_methods_supported; return doc; } }, 'PKCE_UNSUPPORTED'],
    [{ discovery: (doc, origin) => ({ ...doc, authorization_endpoint: `${origin.replace('127.0.0.1', 'localhost')}/auth/authorize` }) }, 'LOOPBACK_ONLY'],
    [{ tokenReply: body => ({ ...body, scope: `${body.scope} patient/Observation.cruds` }) }, 'POLICY_DENIED'],
    [{ tokenReply: body => { const { scope: _scope, ...rest } = body; return rest; } }, 'INVALID_TOKEN_RESPONSE'],
  ];
  for (const [options, code] of cases) {
    const stub = await stubFor(t, options);
    const tokenFile = join(await tempDir(t), 'grant.json');
    await assert.rejects(signIn(standaloneConfig(stub, tokenFile)), (error: unknown) => (error as { code?: string }).code === code, code);
    assert.equal(await readTokenFile(tokenFile), null, code);
    assert.equal(stub.fhirRequests.length, 0, code);
  }
});

test('SMART login: an authorization endpoint on another loopback origin needs a pin, and discovery must agree with the pin', async t => {
  const other = await stubFor(t);
  const otherAuthorize = `${other.origin}${other.basePath.replace(/\/fhir$/, '')}/auth/authorize`;
  const dir = await tempDir(t);
  const attempt = async (stub: SmartStub, auth: Rec) => {
    let shown: URL | undefined;
    const gateway = new FhirGateway(standaloneConfig(stub, join(dir, 'grant.json'), auth) as never);
    // Nobody approves: a login that gets as far as the authorization URL ends with CALLBACK_TIMEOUT.
    try { await gateway.smartLogin({ listen: guardedListen, timeoutMs: 200, onAuthorizeUrl: url => { shown = url; } }); return { shown }; }
    catch (error) { return { shown, error: error as { code?: string } }; }
    finally { gateway.close(); }
  };
  // Discovery names an authorization endpoint on another loopback origin.
  const offOrigin = await stubFor(t, { discovery: doc => ({ ...doc, authorization_endpoint: otherAuthorize }) });
  const unpinned = await attempt(offOrigin, {});
  assert.equal(unpinned.error?.code, 'LOOPBACK_ONLY');
  assert.equal(unpinned.shown, undefined, 'no authorization URL was shown');
  const pinned = await attempt(offOrigin, { endpoints: { authorization: otherAuthorize } });
  assert.equal(pinned.error?.code, 'CALLBACK_TIMEOUT', 'the pinned endpoint was used; nobody approved');
  assert.equal(`${pinned.shown!.origin}${pinned.shown!.pathname}`, otherAuthorize);
  // Discovery names the same-origin endpoint, but the operator pinned another one: refused before anything is shown.
  const sameOrigin = await stubFor(t);
  const disagreeing = await attempt(sameOrigin, { endpoints: { authorization: otherAuthorize } });
  assert.equal(disagreeing.error?.code, 'INVALID_TOKEN_RESPONSE');
  assert.equal(disagreeing.shown, undefined);
  assert.equal(offOrigin.tokenRequests.length + sameOrigin.tokenRequests.length + other.tokenRequests.length, 0);
  assert.equal(other.authorizeRequests.length + offOrigin.authorizeRequests.length + sameOrigin.authorizeRequests.length, 0);
  await assert.rejects(lstat(join(dir, 'grant.json')));
});

test('SMART login: a private_key_jwt client authenticates the code exchange with a signed assertion', async t => {
  const stub = await stubFor(t);
  const tokenFile = join(await tempDir(t), 'grant.json');
  const previous = process.env[KEY_ENV]; process.env[KEY_ENV] = stub.keys.pem;
  t.after(() => { if (previous === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = previous; });
  await signIn(standaloneConfig(stub, tokenFile, { clientAuth: 'private_key_jwt', keyId: 'synthetic-kid-1', privateKeyEnv: KEY_ENV }));
  const exchange = stub.tokenRequests.at(-1)!;
  assert.equal(exchange.rejected, undefined);
  assert.ok(exchange.assertion?.signatureValid);
  assert.equal(exchange.assertion!.claims.aud, stub.tokenUrl);
  assert.equal(exchange.form.has('client_id'), false);
  assert.ok(await readTokenFile(tokenFile));
});

test('SMART login over the CLI: the printed URL completes sign-in, then a real MCP SDK client reads over stdio with the stored grant', async t => {
  const stub = await stubFor(t);
  const dir = await tempDir(t);
  const tokenFile = join(dir, 'grant.json');
  const config = await configFile(dir, standaloneConfig(stub, tokenFile));
  let page: Awaited<ReturnType<typeof approve>> | undefined;
  const run = await runCli(['login', '--config', config, '--no-browser'], {}, async url => { page = await approve(url); });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, `login: ok scope=exact granted_types=${SERVED}/${SERVED} refresh=absent\n`);
  assert.match(run.stderr, /^fireboat: authorize: http:\/\/127\.0\.0\.1:\d+\//m);
  assert.equal(page?.status, 200);
  assert.equal(page?.headers.get('cache-control'), 'no-store');
  assert.equal(page?.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  const tokenCalls = stub.tokenRequests.length, discoveries = stub.discoveryRequests();
  const session = await stdioSession(t, config);
  const found = await session.call('fhir_search', { resource_type: 'Observation' });
  assert.equal(found.envelope.error, undefined, JSON.stringify(found.envelope.error));
  assert.equal(found.envelope.data.resources.length, 2);
  const own = await session.call('fhir_read', { resource_type: 'Observation', id: 'smart-own' });
  assert.equal(own.envelope.error, undefined, JSON.stringify(own.envelope.error));
  assert.equal(stub.tokenRequests.length, tokenCalls, 'the server used the stored token without a token request');
  assert.equal(stub.discoveryRequests(), discoveries, 'and without discovery');
  assert.ok(stub.fhirRequests.length >= 3 && stub.fhirRequests.every(r => r.authorized));
});

test('SMART login over the CLI: a timeout without a callback stores nothing and prints one code line', async t => {
  const stub = await stubFor(t);
  const dir = await tempDir(t);
  const tokenFile = join(dir, 'grant.json');
  const run = await runCli(['login', '--config', await configFile(dir, standaloneConfig(stub, tokenFile)), '--no-browser', '--timeout', '1']);
  assert.equal(run.code, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /\nfireboat: CALLBACK_TIMEOUT\n$/);
  await assert.rejects(lstat(tokenFile));
});

test('SMART login over the CLI: a refused code exchange stores nothing and prints one code line without the token', async t => {
  for (const [options, code] of [[{ launchPatient: null }, 'PATIENT_CONTEXT_MISSING'], [{ launchPatient: 'synthetic-smart-b' }, 'PATIENT_MISMATCH'],
    [{ tokenReply: (body: Rec) => ({ ...body, scope: `${body.scope} patient/Observation.cruds` }) }, 'POLICY_DENIED']] as const) {
    const stub = await stubFor(t, options as StubOptions);
    const dir = await tempDir(t);
    const tokenFile = join(dir, 'grant.json');
    const run = await runCli(['login', '--config', await configFile(dir, standaloneConfig(stub, tokenFile)), '--no-browser'], {}, url => approve(url));
    assert.equal(run.code, 1, code);
    assert.equal(run.stdout, '');
    assert.ok(run.stderr.endsWith(`\nfireboat: ${code}\n`), run.stderr);
    assert.equal(run.stderr.split('\n').filter(Boolean).length, 2, 'the authorize URL line and one code line');
    for (const secret of [...stub.issued, ...stub.codes.keys()]) assert.ok(!run.stderr.includes(secret), 'a token or code leaked');
    assert.ok(stub.issued.size >= 1);
    await assert.rejects(lstat(tokenFile));
    assert.equal(stub.fhirRequests.length, 0);
  }
});

test('SMART login CLI: arguments and non-standalone configurations are refused with one code line', async t => {
  const stub = await stubFor(t);
  const dir = await tempDir(t);
  const standalone = await configFile(dir, standaloneConfig(stub, join(dir, 'grant.json')));
  for (const [args, line, code] of [
    [['login'], 'fireboat: CONFIG_INVALID\n', 2], [['login', '--config', standalone, '--bogus'], 'fireboat: ARGUMENTS_INVALID\n', 2],
    [['login', '--config', standalone, '--timeout', '0'], 'fireboat: ARGUMENTS_INVALID\n', 2], [['logout', '--config', standalone, '--no-browser'], 'fireboat: ARGUMENTS_INVALID\n', 2],
    [['login', '--config', join(dir, 'missing.json')], 'fireboat: CONFIG_INVALID\n', 2],
  ] as const) {
    const run = await runCli([...args]);
    assert.equal(run.code, code, args.join(' ')); assert.equal(run.stderr, line, args.join(' ')); assert.equal(run.stdout, '');
  }
  const backendDir = join(dir, 'backend'); await rm(backendDir, { recursive: true, force: true });
  const backend = join(dir, 'backend.json'); await writeFile(backend, JSON.stringify(smartConfig(stub)));
  const run = await runCli(['login', '--config', backend]);
  assert.equal(run.code, 2); assert.equal(run.stderr, 'fireboat: LOGIN_UNSUPPORTED\n');
  // The same config-path rule as serving and doctor: the last --config wins > FIREBOAT_CONFIG > FHIR_MCP_CONFIG (with its note).
  const last = await runCli(['login', '--config', join(dir, 'missing.json'), '--config', backend]);
  assert.equal(last.stderr, 'fireboat: LOGIN_UNSUPPORTED\n');
  const preferred = await runCli(['logout'], { FIREBOAT_CONFIG: backend, FHIR_MCP_CONFIG: join(dir, 'missing.json') });
  assert.equal(preferred.stderr, 'fireboat: LOGIN_UNSUPPORTED\n');
  const legacy = await runCli(['logout'], { FHIR_MCP_CONFIG: backend });
  assert.equal(legacy.stderr, 'fireboat: note: FHIR_MCP_CONFIG is deprecated; use FIREBOAT_CONFIG.\nfireboat: LOGIN_UNSUPPORTED\n');
  assert.equal(stub.discoveryRequests() + stub.tokenRequests.length, 0);
});

test('SMART logout removes the stored grant', async t => {
  const stub = await stubFor(t);
  const dir = await tempDir(t);
  const tokenFile = join(dir, 'grant.json');
  const config = await configFile(dir, standaloneConfig(stub, tokenFile));
  await signIn(standaloneConfig(stub, tokenFile));
  const first = await runCli(['logout', '--config', config]);
  assert.equal(first.code, 0, first.stderr); assert.equal(first.stdout, 'logout: removed\n');
  await assert.rejects(lstat(tokenFile));
  const second = await runCli(['logout', '--config', config]);
  assert.equal(second.code, 0); assert.equal(second.stdout, 'logout: absent\n');
});

test('SMART logout waits for a refresh in progress, so the refreshed grant does not outlive the logout', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let holding = false;
  const stub = await stubFor(t, { holdToken: request => holding && request.form.get('grant_type') === 'refresh_token' ? gate : undefined });
  const dir = await tempDir(t);
  const tokenFile = join(dir, 'grant.json');
  const config = standaloneConfig(stub, tokenFile, { offlineAccess: true });
  const configPath = await configFile(dir, config);
  await signIn(config);
  const grant = (await readTokenFile(tokenFile))!;
  await writeTokenFile(tokenFile, { ...grant, issuedAt: Date.now() - 7_200_000, expiresAt: Date.now() - 3_600_000 });
  holding = true;
  const gateway = new FhirGateway(config as never);
  t.after(() => gateway.close());
  // A serving process starts a refresh; its token request is held before the reply, so the refresh has not stored anything yet.
  const refreshing = gateway.execute('fhir_read', { resource_type: 'Observation', id: 'smart-own' });
  for (let i = 0; i < 500 && !stub.tokenRequests.some(r => r.form.get('grant_type') === 'refresh_token'); i++) await sleep(10);
  assert.ok(stub.tokenRequests.some(r => r.form.get('grant_type') === 'refresh_token'), 'the refresh request was sent');
  const logout = runCli(['logout', '--config', configPath]);
  // A logout that does not wait for the refresh finishes meanwhile; one that waits for the grant lock is still running.
  const finishedEarly = await Promise.race([logout.then(() => true), sleep(3_000).then(() => false)]);
  release();
  const [result, out] = await Promise.all([refreshing, logout]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout, 'logout: removed\n');
  assert.equal(finishedEarly, false, 'the logout waited for the refresh holding the grant lock');
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  await assert.rejects(lstat(tokenFile), 'no grant is left after both finished');
  await assert.rejects(lstat(`${tokenFile}.lock`), 'no lock is left behind');
});

test('SMART standalone canary: no token, code, verifier, refresh token or assertion reaches stderr, stdout or tool output', async t => {
  const stub = await stubFor(t);
  const dir = await tempDir(t);
  const tokenFile = join(dir, 'grant.json');
  const config = await configFile(dir, standaloneConfig(stub, tokenFile, { offlineAccess: true, clientAuth: 'private_key_jwt', keyId: 'synthetic-kid-1', privateKeyEnv: KEY_ENV }));
  const env = { [KEY_ENV]: stub.keys.pem };
  const texts: string[] = [];
  const login = await runCli(['login', '--config', config, '--no-browser'], env, url => approve(url));
  assert.equal(login.code, 0, login.stderr);
  texts.push(login.stdout, login.stderr);
  const session = await stdioSession(t, config, env);
  texts.push((await session.call('fhir_search', { resource_type: 'Observation' })).raw);
  // Force a refresh: the source rejects the stored token, so the server refreshes with the stored refresh token.
  stub.revokeAll();
  texts.push((await session.call('fhir_read', { resource_type: 'Observation', id: 'smart-own' })).raw);
  texts.push((await session.call('fhir_read', { resource_type: 'Observation', id: 'smart-own' })).raw);
  await session.close();
  texts.push(session.stderr());
  const logout = await runCli(['logout', '--config', config]);
  texts.push(logout.stdout, logout.stderr);
  assert.ok(stub.tokenRequests.some(r => r.form.get('grant_type') === 'refresh_token'), 'the refresh path ran');
  const secrets = [...stub.issued, ...stub.refreshTokens.keys(), ...stub.codes.keys(),
    ...stub.tokenRequests.flatMap(r => [r.form.get('code_verifier'), r.form.get('client_assertion'), r.form.get('refresh_token'), r.form.get('code')])
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ...stub.keys.pem.split('\n').filter(line => line.length > 20 && !line.startsWith('-----'))];
  assert.ok(secrets.length > 10);
  const text = texts.join('\n');
  for (const secret of secrets) assert.ok(!text.includes(secret), 'a token, code, verifier, assertion or key fragment leaked');
});
