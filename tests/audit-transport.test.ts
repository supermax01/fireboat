import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type ClientRequest, type Server } from 'node:http';
import { channel } from 'node:diagnostics_channel';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { controlledFetch, FhirTransport } from '../packages/core/src/transport.js';
import { ClientCredentialsProvider } from '../packages/auth/src/client-credentials.js';
import { FhirGateway } from '../packages/core/src/index.js';
import { withSdk, output, patient, lab } from './s57-sdk-helpers.js';
import { guardAgainstUncaught } from './no-uncaught.js';

guardAgainstUncaught();
const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/fhir/';
};
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
// Stored empty deflate blocks expand the intermediate gzip stream without increasing its final JSON.
function paddedGzip(body: string, blocks = 100_000): Buffer {
  const gz = gzipSync(body), padding = Buffer.alloc(blocks * 5);
  for (let i = 0; i < padding.length; i += 5) padding.set([0, 0, 0, 255, 255], i);
  return Buffer.concat([gz.subarray(0, 10), padding, gz.subarray(10)]);
}
const br = (bytes: Buffer) => brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } });

test('F-03: every decoding layer is metered, including zero-output intermediate expansion and token responses', async t => {
  const encoded = br(paddedGzip('{"resourceType":"Observation","id":"synthetic"}'));
  assert.ok(encoded.length < 8192);
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/fhir+json'); res.setHeader('content-encoding', 'gzip, br'); res.end(encoded);
  });
  const base = await listen(server); t.after(() => close(server));
  const transport = new FhirTransport(base, 8192, 5000);
  await assert.rejects(transport.get(transport.url('Observation/synthetic'), { calls: 0 }), { code: 'UPSTREAM_LIMIT' });
  const provider = new ClientCredentialsProvider(base, { type: 'client_credentials', tokenUrl: new URL('token', base).href, clientId: 'synthetic', clientSecretEnv: 'AUDIT_SYNTHETIC_SECRET' },
    { env: { AUDIT_SYNTHETIC_SECRET: 'synthetic-only' }, maxTokenResponseBytes: 8192 });
  await assert.rejects(provider.authorizationFor(new URL('Observation/synthetic', base)), { code: 'TOKEN_RESPONSE_LIMIT' });
});

test('F-03: two small codings remain usable; three supported codings are refused', async t => {
  let count = 2;
  const body = '{"resourceType":"Observation","id":"synthetic"}';
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/fhir+json'); res.setHeader('content-encoding', Array(count).fill('gzip').join(', '));
    let encoded = Buffer.from(body); for (let i = 0; i < count; i++) encoded = gzipSync(encoded); res.end(encoded);
  });
  const base = await listen(server); t.after(() => close(server));
  const transport = new FhirTransport(base, 8192, 5000);
  assert.deepEqual(await transport.get(transport.url('Observation/synthetic'), { calls: 0 }), JSON.parse(body));
  count = 3;
  await assert.rejects(transport.get(transport.url('Observation/synthetic'), { calls: 0 }), { code: 'UNSUPPORTED_CONTENT' });
});

test('F-03: cancellation and deadline still destroy decoding after the raw response closes', async t => {
  // A small wire response fully drains into the decoders, while final delivery is backpressured.
  const encoded = br(gzipSync('x'.repeat(2 * 1024 * 1024)));
  const server = createServer((_req, res) => { res.setHeader('content-encoding', 'gzip, br'); res.end(encoded); });
  const base = await listen(server); t.after(() => close(server));
  for (const timed of [false, true]) {
    const controller = new AbortController();
    const started = channel('http.client.request.start');
    let rawClosed!: () => void;
    const closed = new Promise<void>(resolve => { rawClosed = resolve; });
    const observe = (message: unknown) => {
      (message as { request: ClientRequest }).request.once('response', incoming => incoming.once('close', rawClosed));
    };
    started.subscribe(observe);
    try {
      const response = await controlledFetch(new URL('Observation/synthetic', base), { signal: controller.signal, maxCompressedBytes: 4 * 1024 * 1024 });
      await closed; // Observe the exact lifetime boundary; final delivery remains backpressured.
      if (timed) {
        const deadline = AbortSignal.timeout(1);
        await new Promise<void>(resolve => deadline.addEventListener('abort', () => { controller.abort(deadline.reason); resolve(); }, { once: true }));
      } else controller.abort();
      await assert.rejects(response.arrayBuffer(), { name: timed ? 'TimeoutError' : 'AbortError' });
    } finally { started.unsubscribe(observe); }
  }
});

test('F-21: continuation userinfo and fragments are refused independently', () => {
  const transport = new FhirTransport('http://127.0.0.1:18801/fhir/', 8192, 1000);
  for (const suffix of ['http://user@127.0.0.1:18801/fhir/Observation', 'http://:pass@127.0.0.1:18801/fhir/Observation',
    'http://user:pass@127.0.0.1:18801/fhir/Observation', 'Observation#fragment']) {
    assert.throws(() => transport.validate(suffix), { code: 'UNSAFE_URL' });
  }
});

for (const era of ['modern', 'legacy'] as const) test('F-21 SDK ' + era + ': unsafe next links cannot trigger credentials or continuation requests', async t => {
  let mode = 'user', base = '';
  const clinical: { url: string; authorization?: string }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, base);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname.endsWith('/metadata')) {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [
        { type: 'Observation', interaction: [{ code: 'search-type' }], searchParam: [{ name: 'patient', type: 'reference' }] },
      ] }] })); return;
    }
    clinical.push({ url: req.url!, authorization: req.headers.authorization });
    const next = new URL(url); next.searchParams.set('_offset', '1');
    if (mode === 'fragment') next.hash = 'synthetic-fragment';
    else if (mode === 'pass') next.password = 'synthetic-password';
    else next.username = 'synthetic-user';
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry: [{ resource: lab(), search: { mode: 'match' } }],
      link: [{ relation: 'self', url: url.href }, { relation: 'next', url: next.href }] }));
  });
  base = await listen(server); t.after(() => close(server));
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'audit', baseUrl: base }, patientId: patient });
  t.after(() => gateway.close());
  await withSdk(gateway, era, async sdk => {
    for (mode of ['user', 'pass', 'fragment']) {
      const before = clinical.length;
      const search = await sdk.call('fhir_search', { resource_type: 'Observation', output });
      assert.equal(search.e.error, undefined);
      assert.ok(JSON.stringify(search.e).includes('NON_CONTINUABLE_UPSTREAM_LINK'));
      assert.equal(search.e.pagination.next_cursor, undefined);
      assert.equal(clinical.length, before + 1);
      assert.ok(clinical.every(req => req.authorization === undefined));
    }
  });
});

test('L-01: HTTPS rejects a self-signed loopback certificate even when ambient TLS verification is disabled', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tls-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Ephemeral synthetic key material is generated per test and never checked in.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  let requests = 0;
  const server = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (_req, res) => {
    requests++; res.setHeader('content-type', 'application/fhir+json'); res.end('{"resourceType":"Observation"}');
  });
  const base = (await listen(server)).replace('http:', 'https:'); t.after(() => close(server));
  const prior = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    for (const value of [undefined, '0']) {
      if (value === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = value;
      const transport = new FhirTransport(base, 8192, 5000);
      await assert.rejects(transport.get(transport.url('Observation/synthetic'), { calls: 0 }), { code: 'UPSTREAM_ERROR' });
      assert.equal(requests, 0);
    }
  } finally { if (prior === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prior; }
});
