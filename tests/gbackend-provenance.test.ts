import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { controlledFetch } from '../packages/core/src/transport.js';
import { IssuedLinkProvenance, SourceResponseObserver, type UpstreamChain } from '../packages/evals/src/upstream-provenance.js';
import { collectEvidence, evaluateCheck } from '../packages/evals/src/runner.js';
import { EVAL_PATIENT_ID } from '../packages/evals/src/fixture.js';

const chain: UpstreamChain = { chain: 'search-1', query: 'synthetic-query-a', resourceType: 'Observation' };
const searchPath = `/fhir/Observation?patient=${EVAL_PATIENT_ID}&code=synthetic-system%7Ca&date=ge2020&date=lt2026`;
const nextPath = '/fhir?_getpages=synthetic-issued-a&_getpagesoffset=1&_count=1&_bundletype=searchset';
const lastPath = '/fhir?_getpages=synthetic-issued-b&_getpagesoffset=2&_count=1&_bundletype=searchset';
type SourceOptions = { encoding?: 'gzip' | 'deflate' | 'br'; reply?: (url: URL, base: string) => { body: unknown; status?: number; raw?: string; abort?: boolean; contentType?: string }; serverSide?: boolean };

async function withSource(options: SourceOptions, use: (base: string, observer: SourceResponseObserver, send: (path: string, context?: UpstreamChain) => Promise<void>) => Promise<void>) {
  let base = '';
  const server = createServer((request, response: ServerResponse) => {
    const url = new URL(request.url!, base);
    const next = url.pathname.endsWith('/Observation') ? nextPath : url.searchParams.get('_getpages') === 'synthetic-issued-a' ? lastPath : undefined;
    const reply = options.reply?.(url, base) ?? { body: { resourceType: 'Bundle', type: 'searchset', entry: [], ...(next ? { link: [{ relation: 'next', url: base + next.slice('/fhir'.length) }] } : {}) } };
    response.statusCode = reply.status ?? 200;
    response.setHeader('content-type', reply.contentType ?? 'application/fhir+json');
    let bytes: Buffer<ArrayBufferLike> = Buffer.from(reply.raw ?? JSON.stringify(reply.body));
    if (options.encoding) {
      response.setHeader('content-encoding', options.encoding);
      bytes = ({ gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync })[options.encoding](bytes);
    }
    if (reply.abort) {
      response.setHeader('content-length', bytes.length + 50);
      response.write(bytes);
      setImmediate(() => response.destroy());
    } else response.end(bytes);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/fhir`;
  const observer = new SourceResponseObserver(base, 'synthetic-task/fhir', options.serverSide);
  const send = async (path: string, context = chain) => {
    observer.beginCall(context);
    try {
      const response = await controlledFetch(new URL(path, base), { maxCompressedBytes: 6 * 1024 * 1024 });
      await response.text();
    } finally { observer.endCall(); }
  };
  try { await use(base, observer, send); }
  finally { observer.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('G-BACKEND source-issued opaque chains pass recursively with privacy-safe observations and inherited constraints', async () => {
  for (const options of [{}, { encoding: 'gzip' }, { encoding: 'deflate' }, { encoding: 'br' }, { serverSide: true }] as SourceOptions[]) {
    await withSource(options, async (_base, observer, send) => {
      await send(searchPath); await send(nextPath); await send(lastPath);
      const ledger = observer.provenance;
      assert.equal(ledger.requests.length, 3);
      assert.ok(ledger.requests.every(request => request.confined && !request.gap));
      assert.deepEqual(ledger.acceptedOpaqueLinks().map(row => [row.request_index, row.issuing_request_index, row.confined_root_request_index]), [[2, 1, 1], [3, 2, 1]]);
      for (const request of ledger.requests) {
        assert.equal(ledger.hasConstraint(request, 'code', 'synthetic-system|a'), true);
        assert.equal(ledger.hasConstraint(request, 'date', 'ge2020'), true);
        assert.equal(ledger.hasConstraint(request, 'date', 'lt2026'), true);
        assert.equal(ledger.hasConstraint(request, 'date', 'ge2030'), false);
      }
      const evidence = collectEvidence([], ledger.requests.map(request => request.url.pathname + request.url.search), { upstreamProvenance: { ledger, requests: ledger.requests } });
      assert.equal(evaluateCheck({ kind: 'upstreamConstraint', id: 'code', name: 'code', value: 'synthetic-system|a' }, 'fhir', evidence).status, 'pass');
      const report = JSON.stringify(ledger.acceptedOpaqueLinks());
      for (const secret of [EVAL_PATIENT_ID, 'synthetic-issued', '_getpages', 'synthetic-system', '/fhir', 'resourceType']) assert.ok(!report.includes(secret), secret);
      assert.ok(ledger.acceptedOpaqueLinks().every(row => /^[a-f0-9]{64}$/.test(row.issued_link_sha256) && /^[a-f0-9]{64}$/.test(row.query_sha256)));
    });
  }
});

test('G-BACKEND opaque continuation rejects unissued tokens without provenance', async () => {
  await withSource({}, async (_base, observer, send) => {
    await send(searchPath);
    await send(nextPath.replace('synthetic-issued-a', 'synthetic-forged'));
    const forged = observer.provenance.requests[1]!;
    assert.equal(forged.confined, false, 'an arbitrary _getpages parameter is not source-issued provenance');
    assert.match(forged.gap ?? '', /lacks visible confinement/);
    assert.deepEqual(observer.provenance.acceptedOpaqueLinks(), []);
    assert.equal(observer.provenance.hasConstraint(forged, 'code', 'synthetic-system|a'), false);
  });
});

test('G-BACKEND opaque provenance rejects first requests and other task chains or queries', async () => {
  await withSource({}, async (_base, observer, send) => {
    await send(nextPath);
    assert.equal(observer.provenance.requests[0]!.confined, false, 'the first opaque request has no ancestor');
    await send(searchPath);
    await send(nextPath, { ...chain, chain: 'another-search-same-query' });
    await send(nextPath, { ...chain, query: 'different-query' });
    assert.ok(observer.provenance.requests.slice(2).every(request => !request.confined));
    await send(nextPath);
    assert.equal(observer.provenance.requests[4]!.confined, true, 'only the issuing search chain can use the token');
    const otherTask = new IssuedLinkProvenance(observer.provenance.requests[1]!.url.origin + '/fhir', 'different-task/fhir');
    assert.equal(otherTask.beginRequest(nextPath, chain).confined, false);
  });
});

test('G-BACKEND opaque issued links bind origin path every ordered parameter and duplicate occurrence', async () => {
  await withSource({}, async (base, observer, send) => {
    await send(searchPath);
    const alterations = [nextPath.replace('/fhir?', '/fhir/Observation?'), `${nextPath}&code=changed`, nextPath.replace('_count=1', '_count=2'),
      `${nextPath}&_count=1`, nextPath.replace('&_count=1', ''), nextPath.replace('_getpagesoffset=1&_count=1', '_count=1&_getpagesoffset=1')];
    for (const path of alterations) await send(path);
    assert.ok(observer.provenance.requests.slice(1).every(request => !request.confined));
    const changedOrigin = new URL(base + nextPath.slice('/fhir'.length)); changedOrigin.port = changedOrigin.port === '9' ? '10' : '9';
    assert.equal(observer.provenance.beginRequest(changedOrigin, chain).confined, false);
    await send(nextPath);
    assert.equal(observer.provenance.requests.at(-1)!.confined, true);
  });
});

test('G-BACKEND source-issued conflicting predicates and wrong resource paths never inherit proof', async () => {
  for (const suffix of ['&patient=foreign-synthetic', '&subject=Patient%2Fforeign-synthetic']) {
    await withSource({ reply: (_url, base) => ({ body: { resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'next', url: `${base}${nextPath.slice('/fhir'.length)}${suffix}` }] } }) }, async (_base, observer, send) => {
      await send(searchPath); await send(nextPath + suffix);
      assert.equal(observer.provenance.requests[1]!.confined, false);
    });
  }
  await withSource({ reply: (_url, base) => ({ body: { resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'next', url: `${base}${nextPath.slice('/fhir'.length)}&code=modified&date=ge2020` }] } }) }, async (_base, observer, send) => {
    await send(searchPath); await send(nextPath + '&code=modified&date=ge2020');
    const request = observer.provenance.requests[1]!;
    assert.equal(request.confined, true, 'the source-issued link still binds confinement');
    assert.equal(observer.provenance.hasConstraint(request, 'code', 'synthetic-system|a'), false, 'present conflicting code cannot inherit');
    assert.equal(observer.provenance.hasConstraint(request, 'date', 'lt2026'), false, 'an incomplete visible repeated parameter cannot inherit');
  });
  const ledger = new IssuedLinkProvenance('http://127.0.0.1:18091/fhir', 'path-tests');
  assert.equal(ledger.beginRequest(`/fhir/Patient?patient=${EVAL_PATIENT_ID}`, chain).confined, false);
  assert.equal(ledger.beginRequest(`/fhir/Observation?_id=${EVAL_PATIENT_ID}`, { ...chain, resourceType: 'Patient' }).confined, false);
  assert.equal(ledger.beginRequest(`/fhir/Patient?_id=${EVAL_PATIENT_ID}`, { ...chain, resourceType: 'Patient' }).confined, true);
});

test('G-BACKEND response provenance requires valid completed successful search Bundles and confined ancestors', async () => {
  const next = { relation: 'next', url: nextPath };
  const replies: NonNullable<SourceOptions['reply']>[] = [
    () => ({ status: 400, body: { resourceType: 'Bundle', type: 'searchset', link: [next] } }),
    () => ({ body: { resourceType: 'OperationOutcome', type: 'searchset', link: [next] } }),
    () => ({ body: { resourceType: 'Bundle', type: 'collection', link: [next] } }),
    () => ({ body: { resourceType: 'Bundle', type: 'searchset', link: [next, next] } }),
    () => ({ body: { resourceType: 'Bundle', type: 'searchset', entry: {}, link: [next] } }),
    () => ({ body: {}, raw: '{"resourceType":"Bundle","type":"searchset","link":[' }),
    () => ({ body: { resourceType: 'Bundle', type: 'searchset', link: [next] }, abort: true }),
    () => ({ body: { resourceType: 'Bundle', type: 'searchset', link: [next] }, contentType: 'text/plain' }),
  ];
  for (const reply of replies) {
    await withSource({ reply }, async (_base, observer, send) => {
      await send(searchPath).catch(() => undefined); await send(nextPath).catch(() => undefined);
      assert.equal(observer.provenance.requests[1]!.confined, false);
    });
  }
  await withSource({}, async (_base, observer, send) => {
    await send('/fhir/Observation?code=synthetic-system%7Ca'); await send(nextPath); await send(lastPath);
    assert.ok(observer.provenance.requests.every(request => !request.confined), 'a recursively issued link cannot repair an unconfined root');
  });
});

test('G-BACKEND provenance decoding bounds compressed and decoded source bytes', async () => {
  for (const encoding of [undefined, 'gzip', 'deflate', 'br'] as const) {
    await withSource({ encoding, reply: () => ({ body: { resourceType: 'Bundle', type: 'searchset', padding: 'x'.repeat(5 * 1024 * 1024), link: [{ relation: 'next', url: nextPath }] } }) }, async (_base, observer, send) => {
      await send(searchPath); await send(nextPath);
      assert.equal(observer.provenance.requests[1]!.confined, false);
    });
  }
});

test('G-BACKEND response links must be issued before the requesting event and uniquely matched', () => {
  const ledger = new IssuedLinkProvenance('http://127.0.0.1:18091/fhir', 'causal-order');
  const root = ledger.beginRequest(searchPath, chain);
  const tooEarly = ledger.beginRequest(nextPath, chain);
  const body = { resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'next', url: nextPath }] };
  ledger.completeResponse(root, 200, body);
  assert.equal(tooEarly.confined, false, 'later response observation cannot retroactively authorize a request');
  const otherRoot = ledger.beginRequest(searchPath, chain);
  ledger.completeResponse(otherRoot, 200, body);
  assert.equal(ledger.beginRequest(nextPath, chain).confined, false, 'two issuer matches are ambiguous');
});

test('E3 confinement observer trusts the configured patient: a natural patient is confined, the golden fixture patient becomes the wrong patient', () => {
  const natural = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000009';
  const base = 'http://127.0.0.1:9/fhir', observation: UpstreamChain = { chain: 'search-n', query: 'natural-query', resourceType: 'Observation' };
  const search = (patient: string) => `/fhir/Observation?patient=Patient/${patient}&category=laboratory`;
  const trusted = new IssuedLinkProvenance(base, 'natural/fhir', natural);
  const own = trusted.beginRequest(search(natural), observation);
  assert.equal(own.confined, true); assert.equal(own.gap, undefined);
  assert.equal(trusted.beginRequest(`/fhir/Observation?subject=${natural}`, { ...observation, chain: 'bare' }).confined, true);
  assert.equal(trusted.beginRequest(`/fhir/Patient?_id=${natural}`, { chain: 'p', query: 'p', resourceType: 'Patient' }).confined, true);
  // Wrong-patient negative controls stay conflicting under the natural trust: the fixture patient, another natural
  // patient, and a list that smuggles a second patient beside the trusted one.
  for (const value of [EVAL_PATIENT_ID, other, `${natural},${other}`]) {
    const wrong = trusted.beginRequest(`/fhir/Observation?patient=${encodeURIComponent(value.includes(',') ? value : `Patient/${value}`)}`, { ...observation, chain: value });
    assert.equal(wrong.confined, false, value); assert.match(wrong.gap ?? '', /conflicting confinement predicate/);
  }
  // The default (golden fixture) trust is unchanged: the natural predicate is the wrong patient there.
  const fixture = new IssuedLinkProvenance(base, 'fixture/fhir');
  assert.match(fixture.beginRequest(search(natural), observation).gap ?? '', /conflicting confinement predicate/);
  assert.equal(fixture.beginRequest(search(EVAL_PATIENT_ID), { ...observation, chain: 'fixture' }).confined, true);
  assert.throws(() => new IssuedLinkProvenance(base, 'bad', 'Patient/x?y'), /Invalid trusted patient identity/);
});
