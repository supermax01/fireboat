import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadAssertionKey, signClientAssertion, validateAssertionConfig } from '../packages/auth/src/client-assertion.js';
import { SmartBackendProvider, type SmartBackendServicesConfig } from '../packages/auth/src/smart-backend.js';
import { newState, stateMatches } from '../packages/auth/src/pkce.js';
import { smartConfigurationUrl } from '../packages/auth/src/smart-discovery.js';
import { assessGrant, requestedScopes, validateScopeOverrides } from '../packages/auth/src/smart-scopes.js';
import { CredentialFault, LocalWorkRefusal } from '../packages/auth/src/token-provider.js';
import { controlledFetch, type HttpFetch } from '../packages/core/src/transport.js';
import { decodeAssertion, generateSigningKey, KEY_ENV, SMART_CLIENT, SMART_KID, SMART_PATIENT, startSmartStub, type SmartStub, type StubOptions } from './smart-helpers.js';
import { guardAgainstUncaught } from './no-uncaught.js';

guardAgainstUncaught();

const SERVED = ['Patient', 'Observation', 'Encounter'];
const code = (expected: string) => (error: unknown) => error instanceof CredentialFault && error.code === expected;

async function withStub(options: StubOptions, fn: (stub: SmartStub) => Promise<void>): Promise<void> {
  const stub = await startSmartStub(options);
  try { await fn(stub); } finally { await stub.close(); }
}
function provider(stub: SmartStub, auth: Partial<SmartBackendServicesConfig> = {}, extra: { onRequest?: () => void; onGrantChanged?: () => void; env?: Record<string, string | undefined>; timeoutMs?: number; fetchFn?: HttpFetch } = {}) {
  return new SmartBackendProvider(stub.baseUrl, { type: 'smart_backend_services', clientId: SMART_CLIENT, keyId: SMART_KID, privateKeyEnv: KEY_ENV, ...auth },
    { patientId: SMART_PATIENT, servedTypes: SERVED, env: extra.env ?? { [KEY_ENV]: stub.keys.pem }, onRequest: extra.onRequest, onGrantChanged: extra.onGrantChanged,
      ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }), ...(extra.fetchFn ? { fetchFn: extra.fetchFn } : {}) });
}
const inside = (stub: SmartStub) => new URL('metadata', stub.baseUrl);

test('SMART discovery: the configuration URL keeps a long path-bearing FHIR base', () => {
  const segment = 'a'.repeat(450);
  for (const base of [`http://127.0.0.1:18452/v/r4/sim/${segment}/fhir`, `http://127.0.0.1:18452/v/r4/sim/${segment}/fhir/`, `http://127.0.0.1:18452/v/r4/sim/${segment}/fhir//`]) {
    assert.equal(smartConfigurationUrl(new URL(base)).href, `http://127.0.0.1:18452/v/r4/sim/${segment}/fhir/.well-known/smart-configuration`);
  }
  assert.equal(smartConfigurationUrl(new URL('http://127.0.0.1:18452/')).href, 'http://127.0.0.1:18452/.well-known/smart-configuration');
});

test('SMART backend: a stub-verified assertion obtains a bearer token through discovery on a long path-bearing base', async () => {
  await withStub({}, async stub => {
    assert.ok(stub.baseUrl.length > 400);
    const p = provider(stub);
    const header = await p.authorizationFor(inside(stub));
    assert.match(header, /^Bearer /);
    assert.equal(stub.discoveryRequests(), 1);
    assert.equal(stub.tokenRequests.length, 1);
    assert.equal(stub.tokenRequests[0]!.rejected, undefined);
    assert.equal(stub.tokenRequests[0]!.form.get('scope'), 'system/Patient.rs system/Observation.rs system/Encounter.rs');
    assert.equal(stub.tokenRequests[0]!.assertion!.claims.aud, stub.tokenUrl);
    assert.ok(p.allows('Observation', 'read') && p.allows('Observation', 'search') && p.allows('Encounter', 'search'));
    assert.equal(p.allows('Condition', 'read'), false);
    assert.deepEqual(p.warnings, []);
    p.close();
  });
});

test('SMART discovery: a discovered endpoint off loopback, with credentials, a query or a fragment is refused before any token request', async () => {
  const cases: [string, (origin: string) => string, string][] = [
    ['localhost name', origin => `${origin.replace('127.0.0.1', 'localhost')}/auth/token`, 'LOOPBACK_ONLY'],
    ['other host', () => 'https://smart.example.test/auth/token', 'LOOPBACK_ONLY'],
    ['query', origin => `${origin}/auth/token?tenant=a`, 'INVALID_TOKEN_RESPONSE'],
    ['credentials', origin => `${origin.replace('://', '://user:pw@')}/auth/token`, 'INVALID_TOKEN_RESPONSE'],
    ['fragment', origin => `${origin}/auth/token#frag`, 'INVALID_TOKEN_RESPONSE'],
    ['not a string', () => 42 as unknown as string, 'INVALID_TOKEN_RESPONSE'],
  ];
  for (const [label, endpoint, expected] of cases) {
    await withStub({ discovery: (doc, origin) => ({ ...doc, token_endpoint: endpoint(origin) }) }, async stub => {
      const p = provider(stub);
      await assert.rejects(p.authorizationFor(inside(stub)), code(expected), label);
      assert.equal(stub.tokenRequests.length, 0, label);
      p.close();
    });
  }
});

test('SMART discovery: an off-origin endpoint needs a pin, and discovery must agree with the pin', async () => {
  await withStub({}, async tokenServer => {
    // The FHIR source's discovery names a token endpoint on a different loopback origin.
    await withStub({ discovery: doc => ({ ...doc, token_endpoint: tokenServer.tokenUrl }), keys: tokenServer.keys }, async stub => {
      const unpinned = provider(stub);
      await assert.rejects(unpinned.authorizationFor(inside(stub)), code('LOOPBACK_ONLY'));
      assert.equal(tokenServer.tokenRequests.length + stub.tokenRequests.length, 0);
      unpinned.close();
      const pinned = provider(stub, { endpoints: { token: tokenServer.tokenUrl } });
      assert.match(await pinned.authorizationFor(inside(stub)), /^Bearer /);
      assert.equal(tokenServer.tokenRequests.length, 1);
      assert.equal(tokenServer.tokenRequests[0]!.rejected, undefined);
      pinned.close();
    });
    // Discovery names the same-origin endpoint, but the operator pinned another one: refused, nothing sent.
    await withStub({ keys: tokenServer.keys }, async stub => {
      const before = tokenServer.tokenRequests.length;
      const disagreeing = provider(stub, { endpoints: { token: tokenServer.tokenUrl } });
      await assert.rejects(disagreeing.authorizationFor(inside(stub)), code('INVALID_TOKEN_RESPONSE'));
      assert.equal(stub.tokenRequests.length, 0);
      assert.equal(tokenServer.tokenRequests.length, before);
      disagreeing.close();
    });
  });
});

test('SMART discovery: redirects, oversize documents, errors and malformed documents are refused', async () => {
  const replies: [string, StubOptions, string][] = [
    ['redirect', { discoveryReply: res => { res.statusCode = 302; res.setHeader('location', 'http://127.0.0.1:1/.well-known/smart-configuration'); res.end(); return true; } }, 'UNSAFE_REDIRECT'],
    ['oversize', { discovery: doc => ({ ...doc, padding: 'x'.repeat(70_000) }) }, 'TOKEN_RESPONSE_LIMIT'],
    ['declared oversize', { discoveryReply: res => { res.setHeader('content-type', 'application/json'); res.setHeader('content-length', '70000'); res.end('{}'); return true; } }, 'TOKEN_RESPONSE_LIMIT'],
    ['not found', { discoveryReply: res => { res.statusCode = 404; res.end(); return true; } }, 'TOKEN_ENDPOINT_ERROR'],
    ['not json', { discoveryReply: res => { res.setHeader('content-type', 'text/html'); res.end('<html></html>'); return true; } }, 'INVALID_TOKEN_RESPONSE'],
    ['array', { discoveryReply: res => { res.setHeader('content-type', 'application/json'); res.end('[]'); return true; } }, 'INVALID_TOKEN_RESPONSE'],
    ['missing token endpoint', { discovery: doc => { delete doc.token_endpoint; return doc; } }, 'INVALID_TOKEN_RESPONSE'],
    ['malformed list', { discovery: doc => ({ ...doc, token_endpoint_auth_methods_supported: 'private_key_jwt' }) }, 'INVALID_TOKEN_RESPONSE'],
  ];
  for (const [label, options, expected] of replies) {
    await withStub(options, async stub => {
      const p = provider(stub);
      await assert.rejects(p.authorizationFor(inside(stub)), code(expected), label);
      assert.equal(stub.tokenRequests.length, 0, label);
      p.close();
    });
  }
});

test('SMART discovery: advertised gaps are warnings, and system scopes need not be advertised', async () => {
  await withStub({ discovery: doc => ({ ...doc, scopes_supported: ['launch/patient'], token_endpoint_auth_methods_supported: ['client_secret_basic'], token_endpoint_auth_signing_alg_values_supported: ['RS256'], grant_types_supported: ['authorization_code'] }) }, async stub => {
    const p = provider(stub);
    assert.match(await p.authorizationFor(inside(stub)), /^Bearer /);
    assert.deepEqual(p.warnings, ['SMART_GRANT_TYPE_NOT_ADVERTISED', 'SMART_CLIENT_AUTH_NOT_ADVERTISED', 'SMART_SIGNING_ALG_NOT_ADVERTISED']);
    p.close();
  });
});

test('SMART token endpoint redirects are refused', async () => {
  await withStub({ tokenReply: () => ({ status: 307, headers: { location: 'http://127.0.0.1:1/token' } }) }, async stub => {
    const p = provider(stub);
    await assert.rejects(p.authorizationFor(inside(stub)), code('UNSAFE_REDIRECT'));
    p.close();
  });
});

test('SMART discovery counts against the request allowance before it is sent', async () => {
  await withStub({}, async stub => {
    let counted = 0;
    const p = provider(stub, {}, { onRequest: () => { counted++; } });
    await p.authorizationFor(inside(stub));
    assert.equal(counted, 2, 'discovery and the token request are each counted');
    p.close();
    const refused = provider(stub, {}, { onRequest: () => { throw new LocalWorkRefusal(); } });
    await assert.rejects(refused.authorizationFor(inside(stub)), (error: unknown) => error instanceof LocalWorkRefusal);
    assert.equal(stub.discoveryRequests(), 1, 'a refused allowance sends no discovery request');
    refused.close();
  });
});

test('SMART backend: a caller deadline bounds the whole acquisition, though discovery and the token request each finish within their own timeout', async () => {
  await withStub({}, async stub => {
    // Each request answers after 300 ms, inside the 400 ms per-request timeout; the two together take longer than the 500 ms deadline.
    const slow: HttpFetch = async (url, init) => { await new Promise(resolve => setTimeout(resolve, 300)); return controlledFetch(url, init); };
    const p = provider(stub, {}, { timeoutMs: 400, fetchFn: slow });
    const started = Date.now();
    await assert.rejects(p.authorizationWithGeneration(inside(stub), { deadline: started + 500 }), code('TOKEN_TIMEOUT'));
    assert.ok(Date.now() - started < 590, 'the caller left at its deadline, before the token request could answer');
    // Without a deadline, the same acquisition completes.
    const unbounded = provider(stub, {}, { timeoutMs: 400, fetchFn: slow });
    assert.match(await unbounded.authorizationFor(inside(stub)), /^Bearer /);
    p.close(); unbounded.close();
  });
});

test('SMART login state: only the exact state matches, never a prefix, an extension or another value', () => {
  const state = newState();
  assert.equal(stateMatches(state, state), true);
  for (const received of [state.slice(0, -1), state.slice(0, 8), '', `${state}A`, `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`, newState(), undefined, null, 42]) {
    assert.equal(stateMatches(state, received), false, String(received));
  }
});

test('client assertion: header, claims and signature follow private_key_jwt for ES384 and RS384', async () => {
  for (const kind of ['p384', 'rsa2048'] as const) {
    const keys = generateSigningKey(kind);
    const key = await loadAssertionKey({ privateKeyEnv: KEY_ENV }, SMART_KID, { [KEY_ENV]: keys.pem });
    assert.equal(key.alg, kind === 'p384' ? 'ES384' : 'RS384');
    const now = 1_800_000_000_123;
    const first = decodeAssertion(signClientAssertion(key, SMART_CLIENT, 'http://127.0.0.1:18452/auth/token', now), keys.publicKey);
    const second = decodeAssertion(signClientAssertion(key, SMART_CLIENT, 'http://127.0.0.1:18452/auth/token', now), keys.publicKey);
    assert.ok(first.signatureValid, kind);
    assert.deepEqual(first.header, { alg: key.alg, kid: SMART_KID, typ: 'JWT' });
    assert.equal(first.claims.iss, SMART_CLIENT);
    assert.equal(first.claims.sub, SMART_CLIENT);
    assert.equal(first.claims.aud, 'http://127.0.0.1:18452/auth/token');
    assert.equal(first.claims.iat, 1_800_000_000);
    assert.equal(first.claims.exp - first.claims.iat, 120);
    assert.match(first.claims.jti, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first.claims.jti, second.claims.jti, 'every assertion has a fresh jti');
  }
});

test('client assertion: weak or unsupported keys are refused (P-256, RSA under 2048, Ed25519, public keys)', async () => {
  for (const kind of ['p256', 'rsa1024', 'ed25519'] as const) {
    await assert.rejects(loadAssertionKey({ privateKeyEnv: KEY_ENV }, SMART_KID, { [KEY_ENV]: generateSigningKey(kind).pem }), code('CREDENTIAL_UNAVAILABLE'), kind);
  }
  const publicPem = generateSigningKey('p384').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  await assert.rejects(loadAssertionKey({ privateKeyEnv: KEY_ENV }, SMART_KID, { [KEY_ENV]: publicPem }), code('CREDENTIAL_UNAVAILABLE'));
  await assert.rejects(loadAssertionKey({ privateKeyEnv: KEY_ENV }, SMART_KID, { [KEY_ENV]: 'not a key' }), code('CREDENTIAL_UNAVAILABLE'));
  await assert.rejects(loadAssertionKey({ privateKeyEnv: KEY_ENV }, SMART_KID, {}), code('CREDENTIAL_UNAVAILABLE'));
  // A weak key is refused before any upstream request.
  await withStub({}, async stub => {
    const p = provider(stub, {}, { env: { [KEY_ENV]: generateSigningKey('p256').pem } });
    await assert.rejects(p.authorizationFor(inside(stub)), code('CREDENTIAL_UNAVAILABLE'));
    assert.equal(stub.discoveryRequests() + stub.tokenRequests.length, 0);
    p.close();
  });
});

test('client assertion: the key comes from exactly one source; a key file must be private, regular and not a link', async t => {
  assert.throws(() => validateAssertionConfig({}, SMART_KID), code('INVALID_CONFIG'));
  assert.throws(() => validateAssertionConfig({ privateKeyEnv: KEY_ENV, privateKeyFile: '/tmp/key.pem' }, SMART_KID), code('INVALID_CONFIG'));
  assert.throws(() => validateAssertionConfig({ privateKeyFile: 'relative/key.pem' }, SMART_KID), code('INVALID_CONFIG'));
  assert.throws(() => validateAssertionConfig({ privateKeyEnv: 'BAD-NAME' }, SMART_KID), code('INVALID_CONFIG'));
  assert.throws(() => validateAssertionConfig({ privateKeyEnv: KEY_ENV }, ''), code('INVALID_CONFIG'));
  const dir = await mkdtemp(join(tmpdir(), 'fireboat-smart-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keys = generateSigningKey('p384');
  const file = join(dir, 'key.pem');
  await writeFile(file, keys.pem, { mode: 0o600 });
  assert.equal((await loadAssertionKey({ privateKeyFile: file }, SMART_KID, {})).alg, 'ES384');
  for (const mode of [0o640, 0o604, 0o644]) {
    await chmod(file, mode);
    await assert.rejects(loadAssertionKey({ privateKeyFile: file }, SMART_KID, {}), code('CREDENTIAL_UNAVAILABLE'), mode.toString(8));
  }
  await chmod(file, 0o600);
  // A private regular file that belongs to another user is refused too.
  const owner = process.getuid!();
  t.mock.method(process as { getuid: () => number }, 'getuid', () => owner + 1);
  await assert.rejects(loadAssertionKey({ privateKeyFile: file }, SMART_KID, {}), code('CREDENTIAL_UNAVAILABLE'), 'another owner');
  t.mock.restoreAll();
  assert.equal((await loadAssertionKey({ privateKeyFile: file }, SMART_KID, {})).alg, 'ES384');
  const link = join(dir, 'link.pem');
  await symlink(file, link);
  await assert.rejects(loadAssertionKey({ privateKeyFile: link }, SMART_KID, {}), code('CREDENTIAL_UNAVAILABLE'));
  await assert.rejects(loadAssertionKey({ privateKeyFile: dir }, SMART_KID, {}), code('CREDENTIAL_UNAVAILABLE'));
  await assert.rejects(loadAssertionKey({ privateKeyFile: join(dir, 'missing.pem') }, SMART_KID, {}), code('CREDENTIAL_UNAVAILABLE'));
  // JWK text is accepted from the environment.
  const jwk = JSON.stringify(keys.privateKey.export({ format: 'jwk' }));
  assert.equal((await loadAssertionKey({ privateKeyEnv: KEY_ENV }, SMART_KID, { [KEY_ENV]: jwk })).alg, 'ES384');
});

test('SMART scopes: requests derive from served types; overrides follow a read-only grammar', () => {
  assert.deepEqual(requestedScopes('system', ['Patient', 'Observation'], 'v2'), ['system/Patient.rs', 'system/Observation.rs']);
  assert.deepEqual(requestedScopes('system', ['Patient'], 'v1'), ['system/Patient.read']);
  assert.deepEqual(validateScopeOverrides(['system/Observation.rs', 'system/Patient.r', 'system/Encounter.s'], 'system', 'v2', SERVED), ['system/Observation.rs', 'system/Patient.r', 'system/Encounter.s']);
  assert.deepEqual(validateScopeOverrides(['system/Observation.read'], 'system', 'v1', SERVED), ['system/Observation.read']);
  for (const bad of [[], ['system/*.rs'], ['system/Observation.cruds'], ['system/Observation.rsu'], ['user/Observation.rs'], ['patient/Observation.rs'],
    ['system/Observation.rs?category=lab'], ['system/Condition.rs'], ['system/Observation.read'], ['system/Observation.write'], ['system/Observation.rs', 'system/Observation.rs'], [42]]) {
    assert.throws(() => validateScopeOverrides(bad, 'system', 'v2', SERVED), code('INVALID_CONFIG'), JSON.stringify(bad));
  }
  assert.throws(() => validateScopeOverrides(['system/Observation.rs'], 'system', 'v1', SERVED), code('INVALID_CONFIG'));
});

test('SMART scopes: grants parse broader, narrower, write and parameterised scopes', () => {
  const requested = ['system/Observation.rs', 'system/Encounter.rs'];
  assert.throws(() => assessGrant(undefined, requested, 'system', SERVED), code('INVALID_TOKEN_RESPONSE'));
  assert.throws(() => assessGrant(['system/Observation.rs'], requested, 'system', SERVED), code('INVALID_TOKEN_RESPONSE'));
  assert.throws(() => assessGrant('system/Observation.rs\tsystem/Encounter.rs', requested, 'system', SERVED), code('INVALID_TOKEN_RESPONSE'));
  for (const write of ['system/Observation.cruds', 'system/Observation.rsu', 'system/Observation.c', 'system/*.write', 'patient/Observation.*', 'user/*.d', 'system/Observation.ds?category=lab']) {
    assert.throws(() => assessGrant(`system/Encounter.rs ${write}`, requested, 'system', SERVED), code('POLICY_DENIED'), write);
  }
  for (const odd of ['system/Observation.xyz', 'system/Observation', 'system/observation.rs', 'system/Observation.sr']) {
    assert.throws(() => assessGrant(odd, requested, 'system', SERVED), code('POLICY_DENIED'), odd);
  }
  const exact = assessGrant('system/Encounter.rs system/Observation.rs', requested, 'system', SERVED);
  assert.equal(exact.broader, false); assert.equal(exact.narrower, false);
  assert.equal(exact.scope, 'system/Encounter.rs system/Observation.rs');
  const broader = assessGrant('system/*.read launch/patient offline_access', requested, 'system', SERVED);
  assert.equal(broader.broader, true); assert.equal(broader.narrower, false);
  assert.deepEqual([...broader.permits.keys()], SERVED);
  const narrower = assessGrant('system/Observation.s system/Encounter.rs?status=finished', requested, 'system', SERVED);
  assert.equal(narrower.narrower, true);
  assert.deepEqual([...narrower.permits.get('Observation')!], ['search']);
  assert.equal(narrower.permits.has('Encounter'), false, 'a parameterised scope grants nothing');
  const otherContext = assessGrant('patient/Observation.rs system/Encounter.rs', requested, 'system', SERVED);
  assert.equal(otherContext.permits.has('Observation'), false);
  assert.equal(otherContext.broader, true);
  assert.equal(assessGrant('', requested, 'system', SERVED).permits.size, 0);
  // In a patient launch, user/ and system/ scopes grant nothing.
  const launch = assessGrant('system/Observation.rs user/Encounter.rs', ['patient/Observation.rs', 'patient/Encounter.rs'], 'patient', SERVED);
  assert.equal(launch.permits.size, 0);
  assert.equal(launch.narrower, true);
});

test('SMART backend: a token naming another patient, a write-capable grant or a missing scope caches nothing', async () => {
  const replies: [string, StubOptions['tokenReply'], string][] = [
    ['other patient', body => ({ ...body, patient: 'synthetic-smart-b' }), 'POLICY_DENIED'],
    ['write grant', body => ({ ...body, scope: 'system/Observation.cruds' }), 'POLICY_DENIED'],
    ['missing scope', body => { const { scope: _scope, ...rest } = body; return rest; }, 'INVALID_TOKEN_RESPONSE'],
    ['non-integer lifetime', body => ({ ...body, expires_in: 600.5 }), 'INVALID_TOKEN_RESPONSE'],
  ];
  for (const [label, tokenReply, expected] of replies) {
    await withStub({ tokenReply }, async stub => {
      const p = provider(stub);
      await assert.rejects(p.authorizationFor(inside(stub)), code(expected), label);
      await assert.rejects(p.authorizationFor(inside(stub)), code(expected), `${label}: nothing was cached`);
      assert.equal(stub.tokenRequests.length, 2, label);
      assert.equal(p.allows('Observation', 'read'), false, label);
      p.close();
    });
  }
  await withStub({ tokenReply: body => ({ ...body, patient: SMART_PATIENT }) }, async stub => {
    const p = provider(stub);
    assert.match(await p.authorizationFor(inside(stub)), /^Bearer /, 'a matching patient context is accepted');
    p.close();
  });
});

test('SMART backend: configuration is strict', async () => {
  await withStub({}, async stub => {
    const bad: Partial<SmartBackendServicesConfig>[] = [
      { clientId: '' }, { keyId: '' }, { privateKeyFile: '/abs/key.pem' }, { scopes: ['system/*.rs'] }, { scopeSyntax: 'v3' as never },
      { endpoints: { token: 'https://smart.example.test/token' } }, { endpoints: { authorization: 'http://127.0.0.1:1/a' } as never }, { extra: true } as never,
    ];
    for (const auth of bad) assert.throws(() => provider(stub, auth), (error: unknown) => error instanceof CredentialFault && ['INVALID_CONFIG', 'LOOPBACK_ONLY'].includes(error.code), JSON.stringify(auth));
  });
});
