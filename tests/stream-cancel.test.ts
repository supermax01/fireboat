import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { ClientCredentialsProvider } from '../packages/auth/src/client-credentials.js';
import { FhirTransport } from '../packages/core/src/transport.js';
import { captureUncaught } from './no-uncaught.js';

/**
 * Regression for the Linux CI failure in auth-gateway: cancelling a response body while the
 * node meter/decoder chain was still flowing let Node's `Readable.toWeb` adapter enqueue a
 * late chunk into the closed web controller (`ERR_INVALID_STATE`), escaping as an
 * uncaughtException that can crash the gateway. The server below sends headers, then keeps
 * streaming chunks on a timer after the client cancels — the forced ordering that exposes
 * late delivery — while each test asserts the safe fault, a closed socket and no escapes.
 */
const CHUNK = Buffer.alloc(16 * 1024, 'x');
const SECRET_ENV = 'FHIR_MCP_STREAM_CANCEL_SECRET';

interface FloodPlan { status: number; headers?: Record<string, string>; first?: Buffer; drip?: Buffer }

async function floodFixture(plan: (req: IncomingMessage) => FloodPlan) {
  let socketsClosed = 0;
  let requests = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests++;
    req.resume();
    res.on('error', () => undefined);
    req.socket.once('close', () => { socketsClosed++; });
    const { status, headers, first, drip } = plan(req);
    res.statusCode = status;
    res.setHeader('content-type', 'application/fhir+json');
    for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value);
    if (first) res.write(first);
    // Keep writing after the client has cancelled; stop only when the socket closes.
    let offset = 0;
    const timer = setInterval(() => {
      if (res.destroyed || res.writableEnded) { clearInterval(timer); return; }
      try {
        if (drip) { res.write(drip.subarray(offset, offset + 8192)); offset += 8192; if (offset >= drip.length) offset = 0; }
        else for (let i = 0; i < 8; i++) res.write(CHUNK);
      } catch { clearInterval(timer); }
    }, 1);
    res.once('close', () => clearInterval(timer));
    if (!first && !drip) res.write(CHUNK);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to bind');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, base: `${origin}/fhir/`, requests: () => requests, socketsClosed: () => socketsClosed,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  // Liveness bound only: socket-close delivery needs both event loops to be scheduled, which
  // can lag seconds when several suite copies oversubscribe the CPU. The asserted condition
  // (every socket closed) is unchanged.
  const deadline = Date.now() + 15_000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), label);
}

/** Deterministic incompressible-ish payload so gzip output streams over many chunks. */
function bigGzipJson(): Buffer {
  let state = 0x2545f491;
  const next = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state.toString(16).padStart(8, '0'); };
  let note = '';
  while (note.length < 240_000) note += next();
  return gzipSync(JSON.stringify({ resourceType: 'Observation', id: 'big', note }));
}

const headerCancels: { name: string; plan: FloodPlan; byteLimit: number; code: string }[] = [
  { name: '401', plan: { status: 401 }, byteLimit: 5_000_000, code: 'CONNECTION_REQUIRED' },
  { name: '403', plan: { status: 403 }, byteLimit: 5_000_000, code: 'NOT_FOUND' },
  { name: 'redirect', plan: { status: 302, headers: { location: '/fhir/elsewhere' } }, byteLimit: 5_000_000, code: 'UNSAFE_REDIRECT' },
  { name: 'wrong content-type', plan: { status: 200, headers: { 'content-type': 'text/plain' } }, byteLimit: 5_000_000, code: 'UNSUPPORTED_CONTENT' },
  { name: 'content-length over the limit', plan: { status: 200, headers: { 'content-length': '10000000' } }, byteLimit: 64 * 1024, code: 'UPSTREAM_LIMIT' },
];

for (const { name, plan, byteLimit, code } of headerCancels) {
  test(`cancelling a flooding ${name} response returns ${code}, closes the socket and escapes nothing`, async t => {
    const captures = captureUncaught(t);
    const f = await floodFixture(() => plan); t.after(f.close);
    const transport = new FhirTransport(f.base, byteLimit, 5_000);
    const repeats = 10;
    for (let i = 0; i < repeats; i++) {
      await assert.rejects(transport.get(transport.url('Observation/streamed'), { calls: 0 }), { code }, `${name} attempt ${i}`);
    }
    await waitFor(() => f.socketsClosed() >= repeats, 'every cancelled response must close its socket');
    await captures.assertNone();
  });
}

const midstreamLimits: { name: string; plan: () => FloodPlan }[] = [
  { name: 'identity', plan: () => ({ status: 200 }) },
  { name: 'gzip', plan: () => ({ status: 200, headers: { 'content-encoding': 'gzip' }, drip: bigGzipJson() }) },
];

for (const { name, plan } of midstreamLimits) {
  test(`a mid-stream ${name} response over the byte limit returns UPSTREAM_LIMIT, closes the socket and escapes nothing`, async t => {
    const captures = captureUncaught(t);
    const f = await floodFixture(() => plan()); t.after(f.close);
    const transport = new FhirTransport(f.base, 64 * 1024, 5_000);
    const repeats = 5;
    for (let i = 0; i < repeats; i++) {
      await assert.rejects(transport.get(transport.url('Observation/streamed'), { calls: 0 }), { code: 'UPSTREAM_LIMIT' }, `${name} attempt ${i}`);
    }
    await waitFor(() => f.socketsClosed() >= repeats, 'every over-limit response must close its socket');
    await captures.assertNone();
  });
}

test('aborting a flooding response mid-body returns REQUEST_CANCELLED, closes the socket and escapes nothing', async t => {
  const captures = captureUncaught(t);
  const f = await floodFixture(() => ({ status: 200, headers: { 'content-encoding': 'gzip' }, drip: bigGzipJson() })); t.after(f.close);
  const transport = new FhirTransport(f.base, 5_000_000, 5_000);
  const repeats = 5;
  for (let i = 0; i < repeats; i++) {
    const controller = new AbortController();
    const seen = f.requests();
    const pending = transport.get(transport.url('Observation/streamed'), { calls: 0 }, { signal: controller.signal });
    pending.catch(() => undefined); // handled below via assert.rejects; this only spans the wait
    // Abort only once the source has the request in flight: a blind timer can fire before
    // dispatch when the CPU is saturated, and then no socket ever exists to close.
    await waitFor(() => f.requests() > seen, 'request must reach the flooding source before the abort');
    controller.abort();
    await assert.rejects(pending, { code: 'REQUEST_CANCELLED' }, `abort attempt ${i}`);
  }
  await waitFor(() => f.socketsClosed() >= repeats, 'every aborted response must close its socket');
  await captures.assertNone();
});

test('cancelling a flooding token-endpoint error returns TOKEN_ENDPOINT_ERROR, closes the socket and escapes nothing', async t => {
  const captures = captureUncaught(t);
  const f = await floodFixture(req => (req.url === '/oauth/token' ? { status: 401, headers: { 'content-type': 'application/json' } } : { status: 404 })); t.after(f.close);
  const repeats = 10;
  for (let i = 0; i < repeats; i++) {
    const provider = new ClientCredentialsProvider(f.base, { type: 'client_credentials', tokenUrl: `${f.origin}/oauth/token`, clientId: 'synthetic-client', clientSecretEnv: SECRET_ENV }, { env: { [SECRET_ENV]: 'synthetic-secret' } });
    await assert.rejects(provider.authorizationFor(new URL(`${f.base}Patient/x`)), { code: 'TOKEN_ENDPOINT_ERROR' }, `token attempt ${i}`);
  }
  await waitFor(() => f.socketsClosed() >= repeats, 'every cancelled token response must close its socket');
  await captures.assertNone();
});

test('a mid-stream token response over the byte limit returns TOKEN_RESPONSE_LIMIT, closes the socket and escapes nothing', async t => {
  const captures = captureUncaught(t);
  const f = await floodFixture(req => (req.url === '/oauth/token' ? { status: 200, headers: { 'content-type': 'application/json' } } : { status: 404 })); t.after(f.close);
  const repeats = 5;
  for (let i = 0; i < repeats; i++) {
    const provider = new ClientCredentialsProvider(f.base, { type: 'client_credentials', tokenUrl: `${f.origin}/oauth/token`, clientId: 'synthetic-client', clientSecretEnv: SECRET_ENV }, { env: { [SECRET_ENV]: 'synthetic-secret' }, maxTokenResponseBytes: 1024 });
    await assert.rejects(provider.authorizationFor(new URL(`${f.base}Patient/x`)), { code: 'TOKEN_RESPONSE_LIMIT' }, `token limit attempt ${i}`);
  }
  await waitFor(() => f.socketsClosed() >= repeats, 'every over-limit token response must close its socket');
  await captures.assertNone();
});
