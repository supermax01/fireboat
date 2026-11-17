import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FhirGateway } from '../packages/core/src/index.js';
import { KEY_ENV, smartConfig, startSmartStub, type Rec, type SmartStub, type StubOptions } from './smart-helpers.js';
import { guardAgainstUncaught } from './no-uncaught.js';

guardAgainstUncaught();

async function fixture(options: StubOptions = {}, auth: Rec = {}) {
  const stub = await startSmartStub(options);
  const previous = process.env[KEY_ENV];
  process.env[KEY_ENV] = stub.keys.pem;
  const gateway = new FhirGateway(smartConfig(stub, auth) as never);
  return { stub, gateway, close: async () => {
    gateway.close();
    if (previous === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = previous;
    await stub.close();
  } };
}
const search = (gateway: FhirGateway, type = 'Observation') => gateway.execute('fhir_search', { resource_type: type, page_size: 20 });
const read = (gateway: FhirGateway, type = 'Observation', id = 'smart-own') => gateway.execute('fhir_read', { resource_type: type, id });
/** Every secret the run produced: issued access tokens, signed assertions and the private key's body lines. */
function secrets(stub: SmartStub): string[] {
  const keyLines = stub.keys.pem.split('\n').filter(line => line.length > 20 && !line.startsWith('-----'));
  return [...stub.issued, ...stub.tokenRequests.map(r => r.form.get('client_assertion') ?? '').filter(Boolean), ...keyLines];
}

test('SMART backend gateway: stub-verified assertions authorize search and read; the stub sees discovery, one token request and bearer FHIR calls', async t => {
  const f = await fixture(); t.after(f.close);
  const first = await search(f.gateway);
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  assert.equal((first.data as Rec).resources.length, 2);
  assert.equal(first.budget.upstream_calls, 4, 'discovery, token, metadata and the search are all counted');
  const own = await read(f.gateway);
  assert.equal(own.error, undefined, JSON.stringify(own.error));
  assert.equal(own.budget.upstream_calls, 1, 'the cached token is reused');
  assert.equal(f.stub.discoveryRequests(), 1);
  assert.equal(f.stub.tokenRequests.length, 1);
  assert.equal(f.stub.tokenRequests[0]!.rejected, undefined);
  assert.ok(f.stub.fhirRequests.length >= 3 && f.stub.fhirRequests.every(r => r.authorized));
});

test('SMART backend gateway: a type outside the grant is refused with POLICY_DENIED before any FHIR request', async t => {
  const f = await fixture({ tokenReply: body => ({ ...body, scope: 'system/Observation.s system/Patient.rs' }) }); t.after(f.close);
  const denied = await search(f.gateway, 'Encounter');
  assert.equal(denied.error?.code, 'POLICY_DENIED');
  assert.equal(f.stub.fhirRequests.length, 0, 'nothing reached the FHIR source');
  assert.equal(f.stub.tokenRequests.length, 1);
  assert.equal((await search(f.gateway)).error, undefined, 'a granted search proceeds');
  const before = f.stub.fhirRequests.length;
  const again = await search(f.gateway, 'Encounter');
  assert.equal(again.error?.code, 'POLICY_DENIED');
  assert.equal(again.budget.upstream_calls, 0, 'with a cached token the refusal sends nothing at all');
  // `.s` grants search but not read.
  const unreadable = await read(f.gateway);
  assert.equal(unreadable.error?.code, 'POLICY_DENIED');
  assert.equal(f.stub.fhirRequests.length, before);
  assert.equal(f.gateway.auditEvents.at(-1)?.cause, 'SCOPE_NOT_GRANTED');
});

test('SMART backend gateway: a reference target outside the grant is refused before its confirmation search is sent', async t => {
  const withEncounter = { name: 'encounter', value: 'Encounter/synthetic-enc-1' };
  const narrow = await fixture({ tokenReply: body => ({ ...body, scope: 'system/Observation.rs system/Patient.rs' }) }); t.after(narrow.close);
  assert.equal((await search(narrow.gateway)).error, undefined);
  const before = narrow.stub.fhirRequests.length;
  const denied = await narrow.gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 20, params: [withEncounter] });
  assert.equal(denied.error?.code, 'POLICY_DENIED');
  assert.equal(narrow.stub.fhirRequests.length, before, 'no confirmation search for an ungranted target type was sent');
  assert.equal(narrow.gateway.auditEvents.at(-1)?.cause, 'SCOPE_NOT_GRANTED');
  // Control: with Encounter granted, the same search sends the confinement-checked confirmation search.
  const full = await fixture(); t.after(full.close);
  assert.equal((await search(full.gateway)).error, undefined);
  await full.gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 20, params: [withEncounter] });
  const confirmation = full.stub.fhirRequests.find(r => r.url.pathname.endsWith('/Encounter'));
  assert.ok(confirmation, 'the granted confirmation search was sent');
  assert.equal(confirmation.url.searchParams.get('_id'), 'synthetic-enc-1');
});

test('SMART backend gateway: a write-capable grant is refused and nothing is sent to FHIR', async t => {
  const f = await fixture({ tokenReply: body => ({ ...body, scope: `${body.scope} system/Observation.cruds` }) }); t.after(f.close);
  const denied = await search(f.gateway);
  assert.equal(denied.error?.code, 'POLICY_DENIED');
  assert.deepEqual(denied.data, {});
  assert.equal(f.stub.fhirRequests.length, 0);
  assert.equal((await read(f.gateway)).error?.code, 'POLICY_DENIED');
  assert.equal(f.stub.fhirRequests.length, 0);
});

test('SMART backend gateway: a token response without scope is INVALID_TOKEN_RESPONSE and nothing is sent to FHIR', async t => {
  const f = await fixture({ tokenReply: body => { const { scope: _scope, ...rest } = body; return rest; } }); t.after(f.close);
  const refused = await search(f.gateway);
  assert.equal(refused.error?.code, 'INVALID_TOKEN_RESPONSE');
  assert.equal(f.stub.fhirRequests.length, 0);
});

test('SMART backend gateway: a token naming another patient is refused with POLICY_DENIED', async t => {
  const f = await fixture({ tokenReply: body => ({ ...body, patient: 'synthetic-smart-b' }) }); t.after(f.close);
  assert.equal((await read(f.gateway)).error?.code, 'POLICY_DENIED');
  assert.equal(f.stub.fhirRequests.length, 0);
});

test('SMART backend gateway: a missing key is CREDENTIAL_UNAVAILABLE before any upstream request', async t => {
  const f = await fixture(); t.after(f.close);
  delete process.env[KEY_ENV];
  assert.equal((await search(f.gateway)).error?.code, 'CREDENTIAL_UNAVAILABLE');
  assert.equal(f.stub.discoveryRequests() + f.stub.tokenRequests.length + f.stub.fhirRequests.length, 0);
});

test('SMART backend gateway: a changed grant at renewal expires handles retained under the old grant', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const change of [false, true]) {
    const f = await fixture({ tokenReply: (body, call, requested) => call === 2 && change ? { ...body, scope: requested.replace(' system/Encounter.rs', '') } : body });
    try {
      const first = await read(f.gateway);
      assert.equal(first.error, undefined, JSON.stringify(first.error));
      now += 571_000; // past the usable lifetime of a 600 s token (30 s skew)
      const retained = await f.gateway.execute('fhir_result', { handle: first.result!.handle });
      assert.equal(f.stub.tokenRequests.length, 2, 'the token was renewed');
      if (change) assert.equal(retained.error?.code, 'RESULT_EXPIRED', 'a narrower grant drops results retained under the old one');
      else assert.equal(retained.error, undefined, 'the same grant keeps retained results across renewal');
      if (change) assert.equal((await search(f.gateway, 'Encounter')).error?.code, 'POLICY_DENIED');
    } finally { await f.close(); }
  }
});

test('SMART backend gateway: a token renewed during metadata retrieval with a narrower grant sends no request for the type it no longer grants', async t => {
  const realNow = Date.now.bind(Date);
  for (const tool of ['fhir_search', 'fhir_read'] as const) {
    // The first token is usable for one second (a two-second lifetime with half of it as skew). The clock moves past
    // that once the metadata request reaches the source, so the clinical request finds the token expired and renews it.
    let metadataSeen = false;
    t.mock.method(Date, 'now', () => realNow() + (metadataSeen ? 1_500 : 0));
    const f = await fixture({ expiresIn: 2, tokenReply: (body, call, requested) => call === 2
      ? { ...body, scope: requested.split(' ').filter(scope => !scope.startsWith('system/Observation.')).join(' ') } : body });
    try {
      const fhirRequests = f.stub.fhirRequests;
      const push = fhirRequests.push.bind(fhirRequests);
      fhirRequests.push = (...items) => { if (items.some(r => r.url.pathname.endsWith('/metadata'))) metadataSeen = true; return push(...items); };
      const result = tool === 'fhir_search' ? await search(f.gateway) : await read(f.gateway);
      assert.equal(result.error?.code, 'POLICY_DENIED', `${tool}: ${JSON.stringify(result.error)}`);
      assert.equal(f.gateway.auditEvents.at(-1)?.cause, 'SCOPE_NOT_GRANTED', tool);
      assert.ok(metadataSeen, tool);
      assert.equal(f.stub.tokenRequests.length, 2, `${tool}: the token was renewed before the clinical request`);
      assert.equal(fhirRequests.filter(r => r.url.pathname.includes('/Observation')).length, 0, `${tool}: no Observation request was sent`);
    } finally { t.mock.restoreAll(); await f.close(); }
  }
});

test('SMART backend gateway: a reference target outside the grant is refused before an expired token is renewed for its confirmation search', async t => {
  const realNow = Date.now.bind(Date);
  let metadataSeen = false;
  t.mock.method(Date, 'now', () => realNow() + (metadataSeen ? 1_500 : 0));
  const f = await fixture({ expiresIn: 2, tokenReply: body => ({ ...body, scope: 'system/Observation.rs system/Patient.rs' }) }); t.after(f.close);
  const fhirRequests = f.stub.fhirRequests;
  const push = fhirRequests.push.bind(fhirRequests);
  fhirRequests.push = (...items) => { if (items.some(r => r.url.pathname.endsWith('/metadata'))) metadataSeen = true; return push(...items); };
  const denied = await f.gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 20, params: [{ name: 'encounter', value: 'Encounter/synthetic-enc-1' }] });
  assert.equal(denied.error?.code, 'POLICY_DENIED', JSON.stringify(denied.error));
  assert.equal(f.gateway.auditEvents.at(-1)?.cause, 'SCOPE_NOT_GRANTED');
  assert.ok(metadataSeen);
  assert.equal(f.stub.tokenRequests.length, 1, 'the ungranted search was refused before the expired token was renewed');
  assert.equal(fhirRequests.filter(r => !r.url.pathname.endsWith('/metadata')).length, 0, 'only the metadata request reached the source');
});

test('SMART backend gateway: every token request carries a fresh assertion with a new jti, including after a 401', async t => {
  const f = await fixture(); t.after(f.close);
  assert.equal((await read(f.gateway)).error, undefined);
  f.stub.revokeAll();
  assert.equal((await read(f.gateway)).error?.code, 'CONNECTION_REQUIRED', 'the source rejected the revoked token');
  const after = await read(f.gateway);
  assert.equal(after.error, undefined, JSON.stringify(after.error));
  assert.equal(f.stub.tokenRequests.length, 2);
  assert.ok(f.stub.tokenRequests.every(r => r.rejected === undefined), JSON.stringify(f.stub.tokenRequests.map(r => r.rejected)));
  const jtis = f.stub.tokenRequests.map(r => r.assertion!.claims.jti);
  assert.notEqual(jtis[0], jtis[1]);
  assert.equal(f.stub.discoveryRequests(), 2, 'discovery runs again for the new token');
});

test('SMART canary: no access token, assertion or key material appears in tool output or the audit trail', async t => {
  const outputs: unknown[] = [];
  const stubs: SmartStub[] = [];
  for (const options of [{}, { tokenReply: (body: Rec) => ({ ...body, scope: 'system/Observation.cruds' }) },
    { tokenReply: (body: Rec) => { const { scope: _scope, ...rest } = body; return rest; } }, { tokenReply: (body: Rec) => ({ ...body, patient: 'synthetic-smart-b' }) }] as StubOptions[]) {
    const f = await fixture(options); t.after(f.close);
    stubs.push(f.stub);
    outputs.push(await search(f.gateway), await read(f.gateway), await search(f.gateway, 'Encounter'));
    f.stub.revokeAll();
    outputs.push(await read(f.gateway), f.gateway.auditEvents);
  }
  const text = JSON.stringify(outputs);
  const all = stubs.flatMap(secrets);
  assert.ok(all.length > 8, 'the canary has secrets to look for');
  for (const secret of all) assert.ok(!text.includes(secret), 'a token, assertion or key fragment leaked');
});
