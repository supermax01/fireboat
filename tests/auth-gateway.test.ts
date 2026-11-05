import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { FhirGateway } from '../packages/core/src/index.js';
import { guardAgainstUncaught } from './no-uncaught.js';

guardAgainstUncaught();

const envName = 'FHIR_MCP_TEST_GATEWAY_SECRET';
const secret = 'synthetic-client-secret-gateway';
const patient = 'synthetic-patient-a';
const metadata = { resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [{ type: 'Observation', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'patient' }] }] }] };
async function fixture() {
  let baseUrl = '';
  let tokenCalls = 0;
  let tokenError = false;
  let tokenStatus: number | undefined;
  let expiresIn = 3600;
  let rejection: number | undefined;
  let holdMetadata = false;
  let holdTokens = false;
  const requests: { path: string; authorization?: string }[] = [];
  const held: ServerResponse[] = [];
  const heldMetadata: ServerResponse[] = [];
  const heldTokens: { res: ServerResponse; call: number }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, baseUrl);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname === '/oauth2/token') {
      tokenCalls++;
      assert.equal(req.headers.authorization, `Basic ${Buffer.from(`test-client:${secret}`).toString('base64')}`);
      if (tokenStatus) { res.statusCode = tokenStatus; res.end('{}'); return; }
      if (holdTokens) { heldTokens.push({ res, call: tokenCalls }); return; }
      if (tokenError) { res.statusCode = 401; res.end(JSON.stringify({ secret, access_token: 'MUST_NOT_LEAK' })); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: `synthetic-access-${tokenCalls}`, token_type: 'Bearer', expires_in: expiresIn })); return;
    }
    requests.push({ path: url.pathname, authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer synthetic-access-${tokenCalls}`) { res.statusCode = 401; res.end('{}'); return; }
    if (url.pathname.endsWith('/held')) { held.push(res); return; }
    if (rejection) { res.statusCode = rejection; res.end(JSON.stringify({ resourceType: 'OperationOutcome', diagnostics: secret })); return; }
    if (url.pathname.endsWith('/metadata')) {
      if (holdMetadata) { heldMetadata.push(res); return; }
      res.end(JSON.stringify(metadata)); return;
    }
    if (url.pathname.endsWith('/Observation')) {
      const entry = (id: string) => ({ resource: { resourceType: 'Observation', id, status: 'final', subject: { reference: `Patient/${patient}` }, code: { text: 'Synthetic' } }, search: { mode: 'match' } });
      const next = new URL(url.href); next.searchParams.set('_getpagesoffset', '1');
      res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', total: 2, link: [{ relation: 'self', url: url.href }, { relation: 'next', url: next.href }], entry: [entry('search-1'), entry('search-2')] }));
      return;
    }
    const id = url.pathname.split('/').at(-1)!;
    const resource = { resourceType: 'Observation', id, status: 'final', subject: { reference: `Patient/${id === 'other' ? 'synthetic-patient-b' : patient}` }, code: { text: 'Synthetic' }, valueQuantity: { value: 5, system: 'http://unitsofmeasure.org', code: 'mg', unit: 'mg' } };
    res.end(JSON.stringify(resource));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/fhir/`;
  const previous = process.env[envName];
  process.env[envName] = secret;
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'authenticated-fixture', baseUrl, auth: { type: 'client_credentials', clientId: 'test-client', tokenUrl: new URL('/oauth2/token', baseUrl).href, clientSecretEnv: envName } }, patientId: patient });
  const releaseHeldTokens = () => {
    holdTokens = false;
    for (const held of heldTokens.splice(0)) {
      if (held.res.writableEnded || held.res.destroyed) continue;
      held.res.setHeader('content-type', 'application/json');
      held.res.end(JSON.stringify({ access_token: `synthetic-access-${held.call}`, token_type: 'Bearer', expires_in: expiresIn }));
    }
  };
  return {
    gateway, requests, held, heldMetadata, heldTokens, releaseHeldTokens, tokenCalls: () => tokenCalls,
    tokenError: (value: boolean) => { tokenError = value; }, tokenStatus: (value?: number) => { tokenStatus = value; }, expiresIn: (value: number) => { expiresIn = value; }, reject: (status?: number) => { rejection = status; }, holdMetadata: (value: boolean) => { holdMetadata = value; }, holdTokens: (value: boolean) => { holdTokens = value; },
    close: async () => { gateway.close(); if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
const read = (gateway: FhirGateway, id = 'own') => gateway.execute('fhir_read', { resource_type: 'Observation', id });
async function waitForResponse(queue: ServerResponse[]): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!queue.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(queue.length, 1, 'Fixture response must be waiting');
}
async function waitUntil(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 600 && !cond(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(cond(), label);
}
const storeSize = (gateway: FhirGateway) => (gateway as unknown as { store: { size: number } }).store.size;

test('authenticated gateway shares credentials and keeps patient isolation and safe output', async t => {
  const f = await fixture(); t.after(f.close);
  const results = await Promise.all([read(f.gateway), read(f.gateway), read(f.gateway)]);
  assert.ok(results.every(result => !result.error));
  assert.equal(f.tokenCalls(), 1);
  assert.ok(f.requests.every(request => request.authorization === 'Bearer synthetic-access-1'));
  assert.equal((await read(f.gateway, 'other')).error?.code, 'NOT_FOUND');
  assert.ok(!JSON.stringify([results, f.gateway.auditEvents]).includes(secret));
  assert.ok(!JSON.stringify([results, f.gateway.auditEvents]).includes('synthetic-access-1'));
});

test('failed refresh blocks retained access and clears handles instead of serving old evidence', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(); t.after(f.close);
  f.expiresIn(1);
  const first = await read(f.gateway);
  assert.equal(first.error, undefined);
  now += 1001;
  f.tokenError(true);
  const blocked = await f.gateway.execute('fhir_result', { handle: first.result!.handle });
  assert.equal(blocked.error?.code, 'TOKEN_ENDPOINT_ERROR');
  assert.deepEqual(blocked.data, {});
  assert.ok(!JSON.stringify(blocked).includes(secret));
  f.tokenError(false);
  const expired = await f.gateway.execute('fhir_result', { handle: first.result!.handle });
  assert.equal(expired.error?.code, 'RESULT_EXPIRED');
});

test('backend 401 invalidates the credential cache and retained state', async t => {
  const f = await fixture(); t.after(f.close);
  const first = await read(f.gateway);
  f.reject(401);
  const denied = await read(f.gateway);
  assert.equal(denied.error?.code, 'CONNECTION_REQUIRED');
  assert.ok(!JSON.stringify(denied).includes(secret));
  const retained = await f.gateway.execute('fhir_result', { handle: first.result!.handle });
  assert.equal(retained.error?.code, 'RESULT_EXPIRED');
  assert.equal(f.tokenCalls(), 2);
});

test('a plain resource 403 is indistinguishable from 404 in handles, token and FHIR-call counts (J-16)', async t => {
  const run = async (status: number) => {
    const f = await fixture(); t.after(f.close);
    const first = await read(f.gateway);
    assert.equal(first.error, undefined);
    f.reject(status);
    const denied = await read(f.gateway);
    // Concurrent authorized reads under the same denial observe the same public outcome and disturb nothing.
    const concurrent = await Promise.all([read(f.gateway), read(f.gateway)]);
    f.reject();
    const retained = await f.gateway.execute('fhir_result', { handle: first.result!.handle });
    const after = await read(f.gateway);
    return { denied: denied.error, concurrent: concurrent.map(result => result.error), retained: retained.error, after: after.error, tokens: f.tokenCalls(), fhirCalls: f.requests.length, leaked: JSON.stringify(denied).includes(secret) };
  };
  const forbidden = await run(403);
  const missing = await run(404);
  assert.deepEqual(forbidden, missing);
  assert.equal(forbidden.denied?.code, 'NOT_FOUND');
  assert.equal(forbidden.retained, undefined, 'the retained handle survives a plain 403');
  assert.equal(forbidden.after, undefined, 'authorized work continues without reconnecting');
  assert.equal(forbidden.tokens, 1, 'no new token was acquired');
  assert.equal(forbidden.leaked, false);
});

test('an in-flight read cannot publish data after another request invalidates the connection', async t => {
  const f = await fixture(); t.after(f.close);
  await read(f.gateway);
  const pending = read(f.gateway, 'held');
  for (let i = 0; i < 100 && !f.held.length; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.held.length, 1);
  f.reject(401);
  assert.equal((await read(f.gateway)).error?.code, 'CONNECTION_REQUIRED');
  f.held[0]!.end(JSON.stringify({ resourceType: 'Observation', id: 'held', subject: { reference: `Patient/${patient}` }, code: { text: 'LATE_EVIDENCE' } }));
  const late = await pending;
  assert.equal(late.error?.code, 'CONNECTION_REQUIRED');
  assert.deepEqual(late.data, {});
  assert.equal(late.result, undefined);
});

test('a late 401 on an old-generation token does not wipe a fresh token results or discovery (J-21)', async t => {
  const f = await fixture(); t.after(f.close);
  await read(f.gateway);
  const oldRead = read(f.gateway, 'held');
  await waitForResponse(f.held);
  // A genuine 401 against the current (first) token invalidates it.
  f.reject(401);
  assert.equal((await read(f.gateway)).error?.code, 'CONNECTION_REQUIRED');
  f.reject();
  // Fresh token, fresh discovery, fresh retained result.
  const fresh = await read(f.gateway);
  assert.equal(fresh.error, undefined);
  assert.equal(f.tokenCalls(), 2);
  assert.equal(f.requests.filter(request => request.path.endsWith('/metadata')).length, 2, 'reconnect discovered fresh capabilities');
  // The held first-token request finally returns 401: generation-scoped invalidation must spare the fresh state.
  f.held[0]!.statusCode = 401;
  f.held[0]!.end('{}');
  const lateOld = await oldRead;
  assert.equal(lateOld.error?.code, 'CONNECTION_REQUIRED');
  assert.equal(lateOld.error?.retryable, true, 'a late 401 on a superseded generation is retryable (V-28)');
  const retained = await f.gateway.execute('fhir_result', { handle: fresh.result!.handle });
  assert.equal(retained.error, undefined, 'the fresh retained result survives the late old-generation 401');
  assert.equal((await read(f.gateway)).error, undefined);
  assert.equal(f.tokenCalls(), 2, 'no third token was acquired');
  assert.equal(f.requests.filter(request => request.path.endsWith('/metadata')).length, 2, 'fresh discovery survived too');
});

test('V-4 a late successful old-generation response spares fresh res_ and cur_ handles and stores nothing', async t => {
  const f = await fixture(); t.after(f.close);
  await read(f.gateway);
  const oldRead = read(f.gateway, 'held');
  await waitForResponse(f.held);
  f.reject(401);
  assert.equal((await read(f.gateway)).error?.code, 'CONNECTION_REQUIRED');
  f.reject();
  const fresh = await read(f.gateway);
  assert.equal(fresh.error, undefined);
  const freshSearch = await f.gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 20 });
  assert.equal(freshSearch.error, undefined, JSON.stringify(freshSearch.error));
  const freshCursor = freshSearch.pagination?.next_cursor;
  assert.ok(freshCursor?.startsWith('cur_'), JSON.stringify(freshSearch.pagination));
  assert.equal(f.tokenCalls(), 2);
  const sizeBefore = storeSize(f.gateway);
  f.held[0]!.end(JSON.stringify({ resourceType: 'Observation', id: 'held', subject: { reference: `Patient/${patient}` }, code: { text: 'LATE_EVIDENCE' } }));
  const late = await oldRead;
  assert.equal(late.error?.code, 'CONNECTION_REQUIRED');
  assert.equal(late.error?.retryable, true);
  assert.deepEqual(late.data, {});
  assert.equal(late.result, undefined);
  assert.ok(!JSON.stringify(late).includes('LATE_EVIDENCE'));
  assert.equal(storeSize(f.gateway), sizeBefore, 'the stale request retained nothing and cleared nothing');
  assert.equal(f.tokenCalls(), 2, 'only two tokens were ever issued');
  const retained = await f.gateway.execute('fhir_result', { handle: fresh.result!.handle });
  assert.equal(retained.error, undefined, 'the fresh res_ survives the late old-generation 200');
  const page = await f.gateway.execute('fhir_page', { cursor: freshCursor });
  assert.equal(page.error, undefined, `the fresh cur_ survives: ${JSON.stringify(page.error)}`);
});

test('V-4 a queued request that runs on the fresh generation succeeds and its result survives late old responses', async t => {
  const f = await fixture(); t.after(f.close);
  await read(f.gateway); // token 1 + discovery
  const blockers = Array.from({ length: 4 }, () => read(f.gateway, 'held'));
  await waitUntil(() => f.held.length === 4, 'four old-generation reads held upstream');
  const queued = read(f.gateway, 'own'); // captures the old epoch while queued behind the four slots
  await new Promise(resolve => setTimeout(resolve, 30));
  f.held[0]!.statusCode = 401;
  f.held[0]!.end('{}'); // invalidates generation 1 and frees the slot the queued request takes
  const queuedResult = await queued;
  assert.equal(queuedResult.error, undefined, `queued request must be judged by the generation it ran on: ${JSON.stringify(queuedResult.error)}`);
  assert.ok(queuedResult.result?.handle.startsWith('res_'));
  assert.equal(f.tokenCalls(), 2);
  for (const held of f.held.slice(1)) held.end(JSON.stringify({ resourceType: 'Observation', id: 'held', subject: { reference: `Patient/${patient}` }, code: { text: 'LATE_EVIDENCE' } }));
  const blockerResults = await Promise.all(blockers);
  assert.ok(blockerResults.every(result => result.error?.code === 'CONNECTION_REQUIRED'), JSON.stringify(blockerResults.map(r => r.error)));
  const retained = await f.gateway.execute('fhir_result', { handle: queuedResult.result!.handle });
  assert.equal(retained.error, undefined, 'the queued request result survives the late old-generation responses');
  assert.equal(f.tokenCalls(), 2);
});

test('V-29 a transient token-endpoint 503 during refresh keeps retained handles and discovery', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(); t.after(f.close);
  f.expiresIn(1);
  const first = await read(f.gateway);
  assert.equal(first.error, undefined);
  assert.equal(f.requests.filter(request => request.path.endsWith('/metadata')).length, 1);
  now += 1001;
  f.tokenStatus(503);
  const blocked = await f.gateway.execute('fhir_result', { handle: first.result!.handle });
  assert.equal(blocked.error?.code, 'TOKEN_ENDPOINT_ERROR');
  assert.equal(blocked.error?.retryable, true);
  assert.deepEqual(blocked.data, {});
  f.tokenStatus(undefined);
  const retained = await f.gateway.execute('fhir_result', { handle: first.result!.handle });
  assert.equal(retained.error, undefined, 'the retained handle survives a transient refresh fault');
  assert.equal((await read(f.gateway)).error, undefined);
  assert.equal(f.requests.filter(request => request.path.endsWith('/metadata')).length, 1, 'discovery was not refetched');
});

test('V-15 double supersession: CREDENTIAL_INVALIDATED is retryable and the prior res_ and discovery survive', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(); t.after(f.close);
  f.expiresIn(1);
  const first = await read(f.gateway);
  assert.equal(first.error, undefined);
  assert.equal(f.requests.filter(request => request.path.endsWith('/metadata')).length, 1);
  now += 1001; // cached token no longer usable: the next call starts a token flight
  f.holdTokens(true);
  const credentials = (f.gateway as unknown as { credentials: { invalidate: (generation?: number) => boolean } }).credentials;
  const blocked = read(f.gateway);
  await waitUntil(() => f.heldTokens.length === 1, 'first token flight held');
  credentials.invalidate(); // supersede flight 1: the provider retries once in the new generation
  await waitUntil(() => f.heldTokens.length === 2, 'retried token flight held');
  credentials.invalidate(); // supersede flight 2: CREDENTIAL_INVALIDATED now propagates to the gateway
  const env = await blocked;
  assert.equal(env.error?.code, 'CREDENTIAL_INVALIDATED', JSON.stringify(env.error));
  assert.equal(env.error?.retryable, true, 'a superseded-flight fault is retryable');
  assert.deepEqual(env.data, {});
  // The gateway must not re-invalidate on a supersession fault: prior retained state and discovery survive.
  f.releaseHeldTokens();
  const retained = await f.gateway.execute('fhir_result', { handle: first.result!.handle });
  assert.equal(retained.error, undefined, 'the prior res_ survives double supersession');
  assert.equal(f.requests.filter(request => request.path.endsWith('/metadata')).length, 1, 'discovery was not refetched');
});

test('V-15 discovery after an epoch bump does not join a stale in-flight metadata flight', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(); t.after(f.close);
  f.expiresIn(1);
  f.holdMetadata(true);
  const stale = read(f.gateway);
  await waitUntil(() => f.heldMetadata.length === 1, 'first metadata flight held');
  now += 2000;
  f.tokenError(true);
  const bumped = await read(f.gateway); // non-retryable refresh failure invalidates the generation
  assert.equal(bumped.error?.code, 'TOKEN_ENDPOINT_ERROR');
  f.tokenError(false);
  const fresh = read(f.gateway);
  await waitUntil(() => f.heldMetadata.length === 2, 'fresh epoch must start its own metadata flight instead of joining the stale one');
  f.heldMetadata[1]!.end(JSON.stringify(metadata));
  assert.equal((await fresh).error, undefined);
  f.heldMetadata[0]!.end(JSON.stringify(metadata));
  assert.equal((await stale).error?.code, 'CONNECTION_REQUIRED');
});
