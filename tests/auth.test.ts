import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import {
  ClientCredentialsProvider,
  CredentialFault,
  type ClientCredentialsProviderOptions,
  type OAuthClientCredentialsConfig,
} from '../packages/auth/src/client-credentials.js';
import { guardAgainstUncaught } from './no-uncaught.js';

guardAgainstUncaught();

const ENV_NAME = 'FHIR_MCP_TEST_FAKE_SECRET';
const FAKE_SECRET = 'fake-secret:with@specials/+=';
const CLIENT_ID = 'synthetic-client';
const FAKE_ENV: Record<string, string | undefined> = { [ENV_NAME]: FAKE_SECRET };

interface CapturedRequest { authorization: string | undefined; contentType: string | undefined; body: string }

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

interface TokenReply { status?: number; json?: unknown; raw?: string; contentType?: string; delayMs?: number }

async function tokenFixture(reply: (call: number, req: CapturedRequest) => TokenReply | Promise<TokenReply>) {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const captured: CapturedRequest = {
      authorization: req.headers.authorization,
      contentType: req.headers['content-type'],
      body: await readBody(req),
    };
    requests.push(captured);
    const outcome = await reply(requests.length, captured);
    if (outcome.delayMs) await new Promise(r => setTimeout(r, outcome.delayMs));
    if (res.destroyed) return;
    res.statusCode = outcome.status ?? 200;
    res.setHeader('content-type', outcome.contentType ?? 'application/json');
    res.end(outcome.raw ?? JSON.stringify(outcome.json ?? {}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to bind');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    port: address.port,
    sourceBaseUrl: `${origin}/fhir`,
    tokenUrl: `${origin}/oauth/token`,
    requests,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function config(tokenUrl: string, overrides: Partial<OAuthClientCredentialsConfig> = {}): OAuthClientCredentialsConfig {
  return { type: 'client_credentials', tokenUrl, clientId: CLIENT_ID, clientSecretEnv: ENV_NAME, ...overrides };
}

function provider(sourceBaseUrl: string, tokenUrl: string, options: ClientCredentialsProviderOptions = {}, cfg?: OAuthClientCredentialsConfig) {
  return new ClientCredentialsProvider(sourceBaseUrl, cfg ?? config(tokenUrl), { env: FAKE_ENV, ...options });
}

function goodToken(n: number, extra: Record<string, unknown> = {}): TokenReply {
  return { json: { access_token: `fake-token-${n}`, token_type: 'Bearer', expires_in: 3600, ...extra } };
}

function assertFault(error: unknown, code: string): CredentialFault {
  assert.ok(error instanceof CredentialFault, `expected CredentialFault, got ${String(error)}`);
  assert.equal(error.code, code);
  assert.equal(typeof error.retryable, 'boolean');
  assert.ok(!error.message.includes(FAKE_SECRET), 'fault message must not contain the secret');
  assert.ok(!error.message.includes('fake-token'), 'fault message must not contain a token');
  return error;
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<CredentialFault> {
  try { await promise; } catch (error) { return assertFault(error, code); }
  assert.fail(`expected rejection with ${code}`);
}

test('config rejects non-loopback endpoints, URL credentials/query/hash, literal secrets, and bad env names', () => {
  const good = config('http://127.0.0.1:8080/oauth/token');
  const source = 'http://127.0.0.1:8080/fhir';
  const bad: [string, () => unknown][] = [
    ['remote source', () => new ClientCredentialsProvider('https://example.com/fhir', good)],
    ['named localhost source', () => new ClientCredentialsProvider('http://localhost:8080/fhir', good)],
    ['source with credentials', () => new ClientCredentialsProvider('http://user:pass@127.0.0.1:8080/fhir', good)],
    ['source with query', () => new ClientCredentialsProvider('http://127.0.0.1:8080/fhir?x=1', good)],
    ['source with hash', () => new ClientCredentialsProvider('http://127.0.0.1:8080/fhir#x', good)],
    ['remote token URL', () => new ClientCredentialsProvider(source, config('https://example.com/token'))],
    ['token URL with credentials', () => new ClientCredentialsProvider(source, config('http://user:pass@127.0.0.1:8080/token'))],
    ['token URL with query', () => new ClientCredentialsProvider(source, config('http://127.0.0.1:8080/token?x=1'))],
    ['token URL with hash', () => new ClientCredentialsProvider(source, config('http://127.0.0.1:8080/token#x'))],
    ['literal secret field', () => new ClientCredentialsProvider(source, { ...good, clientSecret: 'literal' } as OAuthClientCredentialsConfig)],
    ['wrong type', () => new ClientCredentialsProvider(source, { ...good, type: 'authorization_code' } as unknown as OAuthClientCredentialsConfig)],
    ['empty clientId', () => new ClientCredentialsProvider(source, { ...good, clientId: '' })],
    ['clientId with whitespace', () => new ClientCredentialsProvider(source, { ...good, clientId: 'a b' })],
    ['env name with dash', () => new ClientCredentialsProvider(source, { ...good, clientSecretEnv: 'MY-SECRET' })],
    ['env name starting with digit', () => new ClientCredentialsProvider(source, { ...good, clientSecretEnv: '1SECRET' })],
    ['empty env name', () => new ClientCredentialsProvider(source, { ...good, clientSecretEnv: '' })],
    ['scope with space', () => new ClientCredentialsProvider(source, { ...good, scopes: ['patient/*.rs extra'] })],
    ['duplicate scopes', () => new ClientCredentialsProvider(source, { ...good, scopes: ['a.rs', 'a.rs'] })],
  ];
  for (const [label, make] of bad) {
    assert.throws(make, (error: unknown) => { assertFault(error, error instanceof CredentialFault ? error.code : ''); return true; }, label);
  }
  assert.ok(new ClientCredentialsProvider('http://[::1]:8080/fhir', config('http://[::1]:8080/token')));
  assert.ok(new ClientCredentialsProvider(`${source}/`, { ...good, scopes: ['patient/Observation.rs'] }));
});

test('token POST uses client_secret_basic with form-encoded credentials and a secret-free body', async t => {
  const f = await tokenFixture(n => goodToken(n));
  t.after(f.close);
  const p = provider(f.sourceBaseUrl, f.tokenUrl, {}, config(f.tokenUrl, { scopes: ['patient/Observation.rs', 'system/Patient.rs'] }));
  const header = await p.authorizationFor(new URL(`${f.origin}/fhir/Patient/synthetic-1`));
  assert.equal(header, 'Bearer fake-token-1');
  assert.equal(f.requests.length, 1);
  const [req] = f.requests as [CapturedRequest];
  assert.match(req.authorization ?? '', /^Basic [A-Za-z0-9+/=]+$/);
  const decoded = Buffer.from((req.authorization ?? '').slice('Basic '.length), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  assert.equal(decodeURIComponent(decoded.slice(0, sep)), CLIENT_ID);
  assert.equal(decodeURIComponent(decoded.slice(sep + 1)), FAKE_SECRET);
  assert.match(req.contentType ?? '', /^application\/x-www-form-urlencoded/);
  const params = new URLSearchParams(req.body);
  assert.equal(params.get('grant_type'), 'client_credentials');
  assert.equal(params.get('scope'), 'patient/Observation.rs system/Patient.rs');
  assert.equal(params.get('client_secret'), null);
  assert.ok(!req.body.includes(FAKE_SECRET) && !req.body.includes(encodeURIComponent(FAKE_SECRET)));
});

test('two-argument constructor reads the secret from process.env', async t => {
  const f = await tokenFixture(n => goodToken(n));
  t.after(f.close);
  const previous = process.env[ENV_NAME];
  process.env[ENV_NAME] = FAKE_SECRET;
  t.after(() => { if (previous === undefined) delete process.env[ENV_NAME]; else process.env[ENV_NAME] = previous; });
  const p = new ClientCredentialsProvider(f.sourceBaseUrl, config(f.tokenUrl));
  assert.equal(await p.authorizationFor(new URL(`${f.origin}/fhir/metadata`)), 'Bearer fake-token-1');
});

test('a valid token is cached once across sequential calls', async t => {
  const f = await tokenFixture(n => goodToken(n));
  t.after(f.close);
  const p = provider(f.sourceBaseUrl, f.tokenUrl);
  const url = new URL(`${f.origin}/fhir/Observation?patient=synthetic-1`);
  assert.equal(await p.authorizationFor(url), 'Bearer fake-token-1');
  assert.equal(await p.authorizationFor(url), 'Bearer fake-token-1');
  assert.equal(await p.authorizationFor(new URL(`${f.origin}/fhir`)), 'Bearer fake-token-1');
  assert.equal(f.requests.length, 1);
});

test('concurrent callers share a single in-flight token request', async t => {
  const f = await tokenFixture(n => ({ ...goodToken(n), delayMs: 40 }));
  t.after(f.close);
  const p = provider(f.sourceBaseUrl, f.tokenUrl);
  const url = new URL(`${f.origin}/fhir/Patient`);
  const headers = await Promise.all(Array.from({ length: 5 }, () => p.authorizationFor(url)));
  assert.deepEqual(headers, Array(5).fill('Bearer fake-token-1'));
  assert.equal(f.requests.length, 1);
});

test('an expired token refreshes exactly once under concurrency (expiry skew applied)', async t => {
  const f = await tokenFixture(n => goodToken(n));
  t.after(f.close);
  let now = 1_000_000_000;
  const p = provider(f.sourceBaseUrl, f.tokenUrl, { now: () => now });
  const url = new URL(`${f.origin}/fhir/Patient`);
  assert.equal(await p.authorizationFor(url), 'Bearer fake-token-1');
  now += 3_569_000; // inside 3600s lifetime minus 30s skew
  assert.equal(await p.authorizationFor(url), 'Bearer fake-token-1');
  assert.equal(f.requests.length, 1);
  now += 2_000; // past the skewed usable-until instant
  const headers = await Promise.all(Array.from({ length: 3 }, () => p.authorizationFor(url)));
  assert.deepEqual(headers, Array(3).fill('Bearer fake-token-2'));
  assert.equal(f.requests.length, 2);
});

test('invalidate clears the cached token', async t => {
  const f = await tokenFixture(n => goodToken(n));
  t.after(f.close);
  const p = provider(f.sourceBaseUrl, f.tokenUrl);
  const url = new URL(`${f.origin}/fhir/Patient`);
  assert.equal(await p.authorizationFor(url), 'Bearer fake-token-1');
  p.invalidate();
  assert.equal(await p.authorizationFor(url), 'Bearer fake-token-2');
  assert.equal(f.requests.length, 2);
});

test('external and sibling targets are refused before any token acquisition', async t => {
  const f = await tokenFixture(n => goodToken(n));
  t.after(f.close);
  const p = provider(f.sourceBaseUrl, f.tokenUrl);
  const refused = [
    `${f.origin}/fhir-evil/Patient`,
    `${f.origin}/Patient`,
    `${f.origin}/`,
    `http://127.0.0.1:${f.port + 1}/fhir/Patient`,
    `https://127.0.0.1:${f.port}/fhir/Patient`,
    `http://user:pass@127.0.0.1:${f.port}/fhir/Patient`,
    `${f.origin}/fhir/Patient#fragment`,
    `${f.origin}/fhir/%2e%2e/private`,
    'http://example.com/fhir/Patient',
  ];
  for (const target of refused) await rejectsWith(p.authorizationFor(new URL(target)), 'UNSAFE_URL');
  assert.equal(f.requests.length, 0);
  for (const ok of [`${f.origin}/fhir`, `${f.origin}/fhir/`, `${f.origin}/fhir/Patient/x?_count=1`]) {
    assert.equal(await p.authorizationFor(new URL(ok)), 'Bearer fake-token-1');
  }
  assert.equal(f.requests.length, 1);
  // A cached token never widens the binding either.
  await rejectsWith(p.authorizationFor(new URL(`${f.origin}/fhir-evil/Patient`)), 'UNSAFE_URL');
  assert.equal(f.requests.length, 1);
});

test('missing or empty secret env fails closed without calling the token endpoint', async t => {
  const f = await tokenFixture(n => goodToken(n));
  t.after(f.close);
  const url = new URL(`${f.origin}/fhir/Patient`);
  await rejectsWith(provider(f.sourceBaseUrl, f.tokenUrl, { env: {} }).authorizationFor(url), 'CREDENTIAL_UNAVAILABLE');
  await rejectsWith(provider(f.sourceBaseUrl, f.tokenUrl, { env: { [ENV_NAME]: '' } }).authorizationFor(url), 'CREDENTIAL_UNAVAILABLE');
  assert.equal(f.requests.length, 0);
});

test('token endpoint redirects are rejected and never followed', async t => {
  let targetHits = 0;
  const server = createServer(async (req, res) => {
    await readBody(req);
    if (req.url === '/oauth/token') { res.statusCode = 302; res.setHeader('location', '/target'); res.end(); }
    else { targetHits++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: 'fake-token-x', token_type: 'Bearer', expires_in: 3600 })); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to bind');
  const origin = `http://127.0.0.1:${address.port}`;
  const p = provider(`${origin}/fhir`, `${origin}/oauth/token`);
  await rejectsWith(p.authorizationFor(new URL(`${origin}/fhir/Patient`)), 'UNSAFE_REDIRECT');
  assert.equal(targetHits, 0);
});

test('token responses are stream-bounded, with or without content-length', async t => {
  const padded = JSON.stringify({ access_token: 'fake-token-1', token_type: 'Bearer', expires_in: 3600, pad: 'x'.repeat(4_000) });
  const chunked = await tokenFixture(() => ({ raw: padded }));
  t.after(chunked.close);
  // tokenFixture ends in one write; force the bounded reader with a small cap either way.
  await rejectsWith(
    provider(chunked.sourceBaseUrl, chunked.tokenUrl, { maxTokenResponseBytes: 256 })
      .authorizationFor(new URL(`${chunked.origin}/fhir/Patient`)),
    'TOKEN_RESPONSE_LIMIT',
  );

  const server = createServer(async (req, res) => {
    await readBody(req);
    res.setHeader('content-type', 'application/json');
    for (let i = 0; i < 20; i++) res.write(padded.slice(i * 200, (i + 1) * 200));
    res.end(padded.slice(4_000));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to bind');
  const origin = `http://127.0.0.1:${address.port}`;
  await rejectsWith(
    provider(`${origin}/fhir`, `${origin}/oauth/token`, { maxTokenResponseBytes: 256 })
      .authorizationFor(new URL(`${origin}/fhir/Patient`)),
    'TOKEN_RESPONSE_LIMIT',
  );
});

test('a nonresponsive token endpoint terminates at the time limit', async t => {
  const f = await tokenFixture(async () => { await new Promise(r => setTimeout(r, 600)); return goodToken(1); });
  t.after(f.close);
  const outcome = await rejectsWith(
    provider(f.sourceBaseUrl, f.tokenUrl, { timeoutMs: 30 }).authorizationFor(new URL(`${f.origin}/fhir/Patient`)),
    'TOKEN_TIMEOUT',
  );
  assert.equal(outcome.retryable, true);
});

function fakeFetch(reply: (call: number) => Response | Promise<Response>) {
  let calls = 0;
  const fetchFn = (async () => reply(++calls)) as typeof fetch;
  return { fetchFn, calls: () => calls };
}

function jsonResponse(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

const FAKE_SOURCE = 'http://127.0.0.1:9/fhir';
const FAKE_TOKEN_URL = 'http://127.0.0.1:9/oauth/token';
const FAKE_TARGET = new URL('http://127.0.0.1:9/fhir/Patient');

test('invalid or missing token fields are rejected without caching or retrying', async () => {
  const base = { access_token: 'fake-token-1', token_type: 'Bearer', expires_in: 3600 };
  const cases: [string, () => Response][] = [
    ['non-JSON body', () => jsonResponse('not json')],
    ['JSON array', () => jsonResponse([base])],
    ['JSON null', () => jsonResponse('null')],
    ['missing access_token', () => jsonResponse({ token_type: 'Bearer', expires_in: 3600 })],
    ['empty access_token', () => jsonResponse({ ...base, access_token: '' })],
    ['access_token with space', () => jsonResponse({ ...base, access_token: 'abc def' })],
    ['access_token with newline', () => jsonResponse({ ...base, access_token: 'abc\ndef' })],
    ['non-string access_token', () => jsonResponse({ ...base, access_token: 42 })],
    ['token_type MAC', () => jsonResponse({ ...base, token_type: 'MAC' })],
    ['missing token_type', () => jsonResponse({ access_token: 'fake-token-1', expires_in: 3600 })],
    ['missing expires_in', () => jsonResponse({ access_token: 'fake-token-1', token_type: 'Bearer' })],
    ['zero expires_in', () => jsonResponse({ ...base, expires_in: 0 })],
    ['negative expires_in', () => jsonResponse({ ...base, expires_in: -5 })],
    ['fractional expires_in', () => jsonResponse({ ...base, expires_in: 1.5 })],
    ['string expires_in', () => jsonResponse({ ...base, expires_in: '3600' })],
    ['unbounded expires_in', () => jsonResponse({ ...base, expires_in: 999_999 })],
    ['non-JSON content type', () => jsonResponse(base, 200, 'text/plain')],
    ['non-UTF-8 charset', () => jsonResponse(base, 200, 'application/json; charset=iso-8859-1')],
  ];
  for (const [label, make] of cases) {
    const fake = fakeFetch(make);
    const p = provider(FAKE_SOURCE, FAKE_TOKEN_URL, { fetchFn: fake.fetchFn });
    await rejectsWith(p.authorizationFor(FAKE_TARGET), 'INVALID_TOKEN_RESPONSE');
    assert.equal(fake.calls(), 1, label);
  }
  const lower = fakeFetch(() => jsonResponse({ ...base, token_type: 'bearer' }));
  assert.equal(await provider(FAKE_SOURCE, FAKE_TOKEN_URL, { fetchFn: lower.fetchFn }).authorizationFor(FAKE_TARGET), 'Bearer fake-token-1');
  const utf8 = fakeFetch(() => jsonResponse(base, 200, 'application/json; charset="UTF-8"'));
  assert.equal(await provider(FAKE_SOURCE, FAKE_TOKEN_URL, { fetchFn: utf8.fetchFn }).authorizationFor(FAKE_TARGET), 'Bearer fake-token-1');
});

test('HTTP and network failures are safe, carry no body or secret, and are not auto-retried', async () => {
  const marker = 'upstream-body-marker';
  const bad400 = fakeFetch(() => jsonResponse({ error: marker, echo: FAKE_SECRET }, 400));
  const e400 = await rejectsWith(provider(FAKE_SOURCE, FAKE_TOKEN_URL, { fetchFn: bad400.fetchFn }).authorizationFor(FAKE_TARGET), 'TOKEN_ENDPOINT_ERROR');
  assert.equal(e400.retryable, false);
  assert.ok(!e400.message.includes(marker));
  assert.equal(bad400.calls(), 1);

  const bad503 = fakeFetch(() => jsonResponse({ error: marker }, 503));
  const e503 = await rejectsWith(provider(FAKE_SOURCE, FAKE_TOKEN_URL, { fetchFn: bad503.fetchFn }).authorizationFor(FAKE_TARGET), 'TOKEN_ENDPOINT_ERROR');
  assert.equal(e503.retryable, true);
  assert.equal(bad503.calls(), 1);

  const network = fakeFetch(() => { throw new Error(`dial failed with ${FAKE_SECRET}`); });
  const eNet = await rejectsWith(provider(FAKE_SOURCE, FAKE_TOKEN_URL, { fetchFn: network.fetchFn }).authorizationFor(FAKE_TARGET), 'TOKEN_ENDPOINT_ERROR');
  assert.equal(eNet.retryable, true);
  assert.equal(network.calls(), 1);
});

test('a failed acquisition clears the flight so a later call can succeed', async t => {
  const f = await tokenFixture(n => (n === 1 ? { status: 500, json: { error: 'boom' } } : goodToken(n)));
  t.after(f.close);
  const p = provider(f.sourceBaseUrl, f.tokenUrl);
  const url = new URL(`${f.origin}/fhir/Patient`);
  const failure = await rejectsWith(p.authorizationFor(url), 'TOKEN_ENDPOINT_ERROR');
  assert.equal(failure.retryable, true);
  assert.equal(await p.authorizationFor(url), 'Bearer fake-token-2');
  assert.equal(f.requests.length, 2);
});

test('a flight superseded by invalidate is retried once in the new generation and never returns or caches the stale token', async () => {
  let releaseFirst: (() => void) | undefined;
  // This fetch ignores abort, so the stale token-1 response really arrives after invalidation.
  const fake = fakeFetch(call => call === 1
    ? new Promise<Response>(resolve => { releaseFirst = () => resolve(jsonResponse({ access_token: 'fake-token-1', token_type: 'Bearer', expires_in: 3600 })); })
    : jsonResponse({ access_token: 'fake-token-2', token_type: 'Bearer', expires_in: 3600 }));
  const p = provider(FAKE_SOURCE, FAKE_TOKEN_URL, { fetchFn: fake.fetchFn });
  const pending = p.authorizationFor(FAKE_TARGET);
  await new Promise(r => setImmediate(r));
  assert.equal(fake.calls(), 1);
  p.invalidate();
  releaseFirst?.();
  assert.equal(await pending, 'Bearer fake-token-2');
  assert.equal(await p.authorizationFor(FAKE_TARGET), 'Bearer fake-token-2');
  assert.equal(fake.calls(), 2);
});

/** A fetch that holds each response until released and, like real fetch, rejects when its signal aborts. */
function heldFetch() {
  const pending: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  const fetchFn = ((_url: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? AbortSignal.abort();
    pending.push({ signal, resolve });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    setTimeout(() => reject(new Error('held fetch was never released')), 3_000).unref();
  })) as typeof fetch;
  return { fetchFn, calls: () => pending.length, signal: (n: number) => pending[n]!.signal, release: (n: number, token: number) => pending[n]!.resolve(jsonResponse({ access_token: `fake-token-${token}`, token_type: 'Bearer', expires_in: 3600 })) };
}

async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition() && Date.now() < deadline) await new Promise(r => setTimeout(r, 2));
  assert.ok(condition(), label);
}

test('a superseded flight is aborted, and a second supersession during the retry propagates instead of retrying again', async () => {
  const held = heldFetch();
  const p = provider(FAKE_SOURCE, FAKE_TOKEN_URL, { fetchFn: held.fetchFn });
  const pending = p.authorizationFor(FAKE_TARGET);
  await waitUntil(() => held.calls() === 1, 'first token request must start');
  assert.equal(p.invalidate(), true);
  assert.equal(held.signal(0).aborted, true, 'the superseded token request is aborted');
  await waitUntil(() => held.calls() === 2, 'the superseded flight must be retried once');
  p.invalidate();
  const failure = await rejectsWith(pending, 'CREDENTIAL_INVALIDATED');
  assert.equal(failure.retryable, true);
  assert.equal(held.calls(), 2);
});

test('invalidate(generation) is a no-op for a stale generation, so a late rejection cannot discard a newer token', async () => {
  const fake = fakeFetch(n => jsonResponse({ access_token: `fake-token-${n}`, token_type: 'Bearer', expires_in: 3600 }));
  const p = provider(FAKE_SOURCE, FAKE_TOKEN_URL, { fetchFn: fake.fetchFn });
  const first = await p.authorizationWithGeneration(FAKE_TARGET);
  assert.equal(first.authorization, 'Bearer fake-token-1');
  assert.deepEqual(await p.authorizationWithGeneration(FAKE_TARGET), first, 'a cached token reports the generation that acquired it');
  assert.equal(p.invalidate(first.generation), true);
  const second = await p.authorizationWithGeneration(FAKE_TARGET);
  assert.equal(second.authorization, 'Bearer fake-token-2');
  assert.notEqual(second.generation, first.generation);
  assert.equal(p.invalidate(first.generation), false, 'a late 401 for token 1 is stale');
  assert.equal(await p.authorizationFor(FAKE_TARGET), 'Bearer fake-token-2');
  assert.equal(fake.calls(), 2);
  assert.equal(p.invalidate(), true, 'the legacy no-argument call still invalidates');
  assert.equal(await p.authorizationFor(FAKE_TARGET), 'Bearer fake-token-3');
  p.close();
  assert.equal(p.invalidate(), false);
});

test('a caller signal bounds only that caller; the shared flight is aborted once no waiter remains', async () => {
  const held = heldFetch();
  const p = provider(FAKE_SOURCE, FAKE_TOKEN_URL, { fetchFn: held.fetchFn });
  const leaving = new AbortController();
  const first = p.authorizationFor(FAKE_TARGET, leaving.signal);
  const second = p.authorizationFor(FAKE_TARGET);
  await waitUntil(() => held.calls() === 1, 'one shared token request');
  leaving.abort();
  const cancelled = await rejectsWith(first, 'REQUEST_CANCELLED');
  assert.equal(cancelled.retryable, false);
  assert.equal(held.signal(0).aborted, false, 'another waiter still needs the shared flight');
  held.release(0, 1);
  assert.equal(await second, 'Bearer fake-token-1');

  p.invalidate();
  const sole = new AbortController();
  const third = p.authorizationFor(FAKE_TARGET, { signal: sole.signal });
  await waitUntil(() => held.calls() === 2, 'second token request');
  sole.abort();
  await rejectsWith(third, 'REQUEST_CANCELLED');
  assert.equal(held.signal(1).aborted, true, 'the abandoned token request is aborted');
  const fourth = p.authorizationFor(FAKE_TARGET);
  await waitUntil(() => held.calls() === 3, 'a later caller starts a fresh flight instead of joining the abandoned one');
  held.release(2, 3);
  assert.equal(await fourth, 'Bearer fake-token-3');
});

test('a caller deadline or timeout signal bounds the wait, and an exhausted deadline never contacts the token endpoint', async () => {
  const held = heldFetch();
  const p = provider(FAKE_SOURCE, FAKE_TOKEN_URL, { fetchFn: held.fetchFn });
  await rejectsWith(p.authorizationFor(FAKE_TARGET, { deadline: Date.now() - 1 }), 'TOKEN_TIMEOUT');
  assert.equal(held.calls(), 0);
  const started = Date.now();
  const timeout = await rejectsWith(p.authorizationFor(FAKE_TARGET, { deadline: Date.now() + 40 }), 'TOKEN_TIMEOUT');
  assert.equal(timeout.retryable, true);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(held.signal(0).aborted, true, 'the sole waiter left, so the token request is aborted');
  await rejectsWith(p.authorizationFor(FAKE_TARGET, AbortSignal.timeout(30)), 'TOKEN_TIMEOUT');
  assert.equal(held.calls(), 2);
});

test('token lifetime is anchored to request start, and an already exhausted token is neither cached nor returned', async () => {
  let now = 5_000_000;
  // 20 s elapse during the token request; 60 s lifetime minus 30 s skew leaves 10 s of use after delivery.
  const slow = fakeFetch(n => { if (n === 1) now += 20_000; return jsonResponse({ access_token: `fake-token-${n}`, token_type: 'Bearer', expires_in: 60 }); });
  const p = provider(FAKE_SOURCE, FAKE_TOKEN_URL, { fetchFn: slow.fetchFn, now: () => now });
  assert.equal(await p.authorizationFor(FAKE_TARGET), 'Bearer fake-token-1');
  now += 9_999;
  assert.equal(await p.authorizationFor(FAKE_TARGET), 'Bearer fake-token-1');
  assert.equal(slow.calls(), 1);
  now += 2;
  assert.equal(await p.authorizationFor(FAKE_TARGET), 'Bearer fake-token-2');
  assert.equal(slow.calls(), 2);

  let clock = 0;
  // A nine-second token request returning expires_in:1 delivers a token whose usable lifetime has already elapsed.
  const exhausted = fakeFetch(n => { if (n === 1) clock += 9_000; return jsonResponse({ access_token: `fake-token-${n}`, token_type: 'Bearer', expires_in: 1 }); });
  const q = provider(FAKE_SOURCE, FAKE_TOKEN_URL, { fetchFn: exhausted.fetchFn, now: () => clock });
  const failure = await rejectsWith(q.authorizationFor(FAKE_TARGET), 'TOKEN_EXPIRED');
  assert.equal(failure.retryable, true);
  assert.equal(await q.authorizationFor(FAKE_TARGET), 'Bearer fake-token-2', 'nothing was cached; a prompt acquisition succeeds');
  assert.equal(exhausted.calls(), 2);
});

test('close during an in-flight request rejects the stale token and blocks all later tokens', async () => {
  let releaseFirst: (() => void) | undefined;
  const fake = fakeFetch(() => new Promise<Response>(resolve => { releaseFirst = () => resolve(jsonResponse({ access_token: 'fake-token-1', token_type: 'Bearer', expires_in: 3600 })); }));
  const p = provider(FAKE_SOURCE, FAKE_TOKEN_URL, { fetchFn: fake.fetchFn });
  const pending = p.authorizationFor(FAKE_TARGET);
  await new Promise(r => setImmediate(r));
  p.close();
  releaseFirst?.();
  await rejectsWith(pending, 'PROVIDER_CLOSED');
  await rejectsWith(p.authorizationFor(FAKE_TARGET), 'PROVIDER_CLOSED');
  p.invalidate(); // invalidate must not reopen a closed provider
  await rejectsWith(p.authorizationFor(FAKE_TARGET), 'PROVIDER_CLOSED');
  assert.equal(fake.calls(), 1);
});

test('close discards a cached token and prevents later acquisition', async () => {
  const fake = fakeFetch(() => jsonResponse({ access_token: 'fake-token-1', token_type: 'Bearer', expires_in: 3600 }));
  const p = provider(FAKE_SOURCE, FAKE_TOKEN_URL, { fetchFn: fake.fetchFn });
  assert.equal(await p.authorizationFor(FAKE_TARGET), 'Bearer fake-token-1');
  p.close();
  p.close(); // idempotent
  await rejectsWith(p.authorizationFor(FAKE_TARGET), 'PROVIDER_CLOSED');
  assert.equal(fake.calls(), 1);
});

test('failures write nothing containing the secret, token, or upstream body to the console', async () => {
  const marker = 'upstream-body-marker';
  const captured: string[] = [];
  const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const capture = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  console.log = capture; console.error = capture; console.warn = capture; console.info = capture;
  try {
    const fake = fakeFetch(() => jsonResponse({ error: marker, access_token: 'fake-token-leak', echo: FAKE_SECRET }, 400));
    await rejectsWith(provider(FAKE_SOURCE, FAKE_TOKEN_URL, { fetchFn: fake.fetchFn }).authorizationFor(FAKE_TARGET), 'TOKEN_ENDPOINT_ERROR');
  } finally {
    console.log = originals.log; console.error = originals.error; console.warn = originals.warn; console.info = originals.info;
  }
  const logged = captured.join('\n');
  assert.ok(!logged.includes(FAKE_SECRET), 'logs must not contain the secret');
  assert.ok(!logged.includes('fake-token'), 'logs must not contain a token');
  assert.ok(!logged.includes(marker), 'logs must not contain the upstream body');
});

test('S55fix R10 token request observer exceptions are outside the fetch error mapper', async () => {
  const marker = new Error('synthetic observer failure'); let fetched = false;
  const p = provider('http://127.0.0.1:9/fhir', 'http://127.0.0.1:9/token', {
    onRequest: () => { throw marker; }, fetchFn: async () => { fetched = true; throw new Error('unexpected fetch'); },
  });
  try {
    await assert.rejects((p as unknown as { request(generation: number, signal: AbortSignal): Promise<unknown> }).request(0, new AbortController().signal), error => error === marker);
    assert.equal(fetched, false);
  } finally { p.close(); }
});
