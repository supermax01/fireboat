import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { lstatSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FhirGateway } from '../packages/core/src/index.js';
import { listenLoopbackCallback } from '../packages/server/src/login.js';
import { prepareGrantDirectory, readTokenFile, removeStoredGrant, withGrantLock, writeTokenFile, type StoredGrant } from '../packages/auth/src/token-store.js';
import { CredentialFault } from '../packages/auth/src/token-provider.js';
import { SmartStandaloneProvider } from '../packages/auth/src/smart-standalone.js';
import { approve, standaloneConfig, startSmartStub, type Rec, type SmartStub, type StubOptions } from './smart-helpers.js';
import { guardAgainstUncaught } from './no-uncaught.js';

guardAgainstUncaught();

async function setup(t: TestContext, options: StubOptions = {}, auth: Rec = {}) {
  const stub = await startSmartStub(options); t.after(stub.close);
  const dir = await mkdtemp(join(tmpdir(), 'fireboat-smart-serve-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, 'grant.json');
  const config = standaloneConfig(stub, tokenFile, auth);
  const gateways: FhirGateway[] = [];
  t.after(() => { for (const gateway of gateways) gateway.close(); });
  const serve = () => { const gateway = new FhirGateway(config as never); gateways.push(gateway); return gateway; };
  /** A separate sign-in, as `fireboat login` would run in its own process. */
  const login = async () => {
    const gateway = new FhirGateway(config as never);
    let pending: Promise<unknown> = Promise.resolve();
    try { return await gateway.smartLogin({ listen: listenLoopbackCallback, timeoutMs: 5_000, onAuthorizeUrl: url => { pending = approve(url.href).catch(error => error); } }); }
    finally { await pending; gateway.close(); }
  };
  const stored = async () => (await readTokenFile(tokenFile))!;
  const rewrite = async (edit: (grant: StoredGrant) => StoredGrant) => writeTokenFile(tokenFile, edit(await stored()));
  const requests = () => ({ discovery: stub.discoveryRequests(), token: stub.tokenRequests.length, fhir: stub.fhirRequests.length });
  return { stub, dir, tokenFile, config, serve, login, stored, rewrite, requests };
}
const search = (gateway: FhirGateway, type = 'Observation') => gateway.execute('fhir_search', { resource_type: type, page_size: 20 });
const read = (gateway: FhirGateway) => gateway.execute('fhir_read', { resource_type: 'Observation', id: 'smart-own' });
const expire = (grant: StoredGrant): StoredGrant => ({ ...grant, issuedAt: Date.now() - 7_200_000, expiresAt: Date.now() - 3_600_000 });

test('SMART standalone serving: a stored grant is used without discovery or a token request', async t => {
  const s = await setup(t);
  await s.login();
  const before = s.requests();
  const gateway = s.serve();
  assert.equal((await search(gateway)).error, undefined);
  assert.equal((await read(gateway)).error, undefined);
  const after = s.requests();
  assert.equal(after.discovery, before.discovery);
  assert.equal(after.token, before.token);
  assert.ok(s.stub.fhirRequests.every(r => r.authorized));
});

test('SMART standalone serving: an expired access token is refreshed once and the rotated refresh token is persisted', async t => {
  const s = await setup(t, { rotateStrictly: true }, { offlineAccess: true });
  await s.login();
  const original = await s.stored();
  await s.rewrite(expire);
  const gateway = s.serve();
  const results = await Promise.all([read(gateway), read(gateway), search(gateway)]);
  assert.ok(results.every(result => !result.error), JSON.stringify(results.map(r => r.error)));
  const refreshes = s.stub.tokenRequests.filter(r => r.form.get('grant_type') === 'refresh_token');
  assert.equal(refreshes.length, 1, 'concurrent calls share one refresh');
  assert.equal(refreshes[0]!.rejected, undefined);
  const renewed = await s.stored();
  assert.notEqual(renewed.refreshToken, original.refreshToken, 'the rotated refresh token was written back');
  assert.notEqual(renewed.accessToken, original.accessToken);
  assert.ok(s.stub.refreshTokens.has(renewed.refreshToken!) && !s.stub.refreshTokens.has(original.refreshToken!));
  assert.equal((await stat(s.tokenFile)).mode & 0o777, 0o600);
  // A later expiry refreshes with the persisted token, which the strictly rotating stub still accepts.
  await s.rewrite(expire);
  const later = s.serve();
  assert.equal((await read(later)).error, undefined);
  assert.equal(s.stub.tokenRequests.filter(r => r.form.get('grant_type') === 'refresh_token').length, 2);
  assert.ok(s.stub.tokenRequests.every(r => r.rejected === undefined));
});

test('SMART standalone serving: a refresh naming another patient is refused; one omitting the patient keeps the binding', async t => {
  const other = await setup(t, { refreshPatient: 'synthetic-smart-b' }, { offlineAccess: true });
  await other.login();
  await other.rewrite(expire);
  const before = await other.stored();
  const gateway = other.serve();
  assert.equal((await read(gateway)).error?.code, 'POLICY_DENIED');
  assert.equal(other.stub.fhirRequests.length, 0, 'nothing reached the FHIR source');
  assert.deepEqual(await other.stored(), before, 'the file was not rewritten');
  const omitted = await setup(t, { refreshPatient: null }, { offlineAccess: true });
  await omitted.login();
  await omitted.rewrite(expire);
  assert.equal((await read(omitted.serve())).error, undefined, 'a refresh without patient context keeps the login binding');
  assert.equal((await omitted.stored()).binding.patientId, 'synthetic-smart-a');
});

test('SMART standalone serving: a token file with group or other access, or a symlink, is CREDENTIAL_UNAVAILABLE with no request', async t => {
  const s = await setup(t);
  await s.login();
  const before = s.requests();
  for (const mode of [0o640, 0o604, 0o660]) {
    await chmod(s.tokenFile, mode);
    assert.equal((await read(s.serve())).error?.code, 'CREDENTIAL_UNAVAILABLE', mode.toString(8));
  }
  await chmod(s.tokenFile, 0o600);
  const link = join(s.dir, 'link.json');
  await symlink(s.tokenFile, link);
  const linked = new FhirGateway(standaloneConfig(s.stub, link) as never);
  t.after(() => linked.close());
  assert.equal((await read(linked)).error?.code, 'CREDENTIAL_UNAVAILABLE');
  await writeFile(join(s.dir, 'garbage.json'), '{"version":1}', { mode: 0o600 });
  const garbage = new FhirGateway(standaloneConfig(s.stub, join(s.dir, 'garbage.json')) as never);
  t.after(() => garbage.close());
  assert.equal((await read(garbage)).error?.code, 'CREDENTIAL_UNAVAILABLE');
  assert.deepEqual(s.requests(), before, 'no discovery, token or FHIR request');
});

test('SMART standalone serving: a token file or grant directory owned by another user is CREDENTIAL_UNAVAILABLE with no request', async t => {
  const s = await setup(t);
  await s.login();
  assert.equal((await read(s.serve())).error, undefined, 'control: the file is usable by its owner');
  const before = s.requests();
  const owner = process.getuid!();
  // The fixtures belong to the user running the tests; reporting another uid makes them belong to someone else.
  t.mock.method(process as { getuid: () => number }, 'getuid', () => owner + 1);
  assert.equal((await read(s.serve())).error?.code, 'CREDENTIAL_UNAVAILABLE');
  await assert.rejects(prepareGrantDirectory(s.tokenFile), (error: unknown) => error instanceof CredentialFault && error.code === 'CREDENTIAL_UNAVAILABLE');
  await assert.rejects(withGrantLock(s.tokenFile, async () => 'ran'), (error: unknown) => error instanceof CredentialFault && error.code === 'CREDENTIAL_UNAVAILABLE');
  assert.deepEqual(s.requests(), before, 'no discovery, token or FHIR request');
});

test('SMART standalone serving: a stored token inside its final expiry margin is not used', async t => {
  const s = await setup(t);
  await s.login();
  // Ten seconds of a one-hour token remain, inside the 30-second expiry margin: it counts as expired.
  await s.rewrite(grant => ({ ...grant, issuedAt: Date.now() - 3_590_000, expiresAt: Date.now() + 10_000 }));
  const before = s.requests();
  assert.equal((await read(s.serve())).error?.code, 'CONNECTION_REQUIRED');
  assert.deepEqual(s.requests(), before, 'no discovery, token or FHIR request');
});

test('SMART standalone serving: a token file bound to another source, client, patient or token endpoint is CONNECTION_REQUIRED with no request', async t => {
  const s = await setup(t, {}, { offlineAccess: true });
  await s.login();
  const good = await s.stored();
  const before = s.requests();
  for (const binding of [{ patientId: 'synthetic-smart-b' }, { clientId: 'another-client' }, { sourceBaseUrl: `${s.stub.origin}/other/fhir/` },
    { tokenEndpoint: 'http://127.0.0.1:1/auth/token' }]) {
    await writeTokenFile(s.tokenFile, { ...good, binding: { ...good.binding, ...binding } });
    assert.equal((await read(s.serve())).error?.code, 'CONNECTION_REQUIRED', JSON.stringify(binding));
  }
  assert.deepEqual(s.requests(), before, 'no discovery, token or FHIR request');
  // A same-origin token endpoint that discovery no longer names is caught when a refresh needs it: no token request.
  await writeTokenFile(s.tokenFile, expire({ ...good, binding: { ...good.binding, tokenEndpoint: `${s.stub.origin}/elsewhere/token` } }));
  assert.equal((await read(s.serve())).error?.code, 'CONNECTION_REQUIRED');
  assert.equal(s.requests().token, before.token);
  assert.equal(s.requests().fhir, before.fhir);
});

test('SMART standalone serving: no stored grant, or an expired one without a refresh token, is CONNECTION_REQUIRED', async t => {
  const s = await setup(t);
  assert.equal((await read(s.serve())).error?.code, 'CONNECTION_REQUIRED');
  await s.login();
  await s.rewrite(expire);
  const before = s.requests();
  assert.equal((await read(s.serve())).error?.code, 'CONNECTION_REQUIRED');
  assert.deepEqual(s.requests(), before);
});

test('SMART standalone serving: a rejected refresh re-reads the token file once and picks up a fresh login', async t => {
  let replacement: StoredGrant | undefined;
  const s = await setup(t, { tokenReply: (body, _call, _scope) => {
    // The refresh is rejected after another process stored a fresh grant (written synchronously before the reply).
    if (replacement) { writeFileSync(sPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 }); replacement = undefined; return { status: 400, body: { error: 'invalid_grant' } }; }
    return body;
  } }, { offlineAccess: true });
  const sPath = s.tokenFile;
  await s.login();
  const old = await s.stored();
  await s.login();
  const fresh = await s.stored();
  await writeTokenFile(s.tokenFile, expire(old));
  replacement = fresh;
  const gateway = s.serve();
  const result = await read(gateway);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.ok(s.stub.fhirRequests.at(-1)!.authorized);
  // Without a fresh grant, a rejected refresh asks for a login.
  await s.rewrite(grant => ({ ...expire(grant), refreshToken: 'unknown-refresh-token-value' }));
  const rejected = await read(s.serve());
  assert.equal(rejected.error?.code, 'CONNECTION_REQUIRED');
});

test('SMART standalone serving: after a 401 the token file is re-read, so a fresh login is picked up without a restart', async t => {
  const s = await setup(t);
  await s.login();
  const gateway = s.serve();
  assert.equal((await read(gateway)).error, undefined);
  s.stub.revokeAll();
  assert.equal((await read(gateway)).error?.code, 'CONNECTION_REQUIRED');
  const fhirBefore = s.stub.fhirRequests.length;
  assert.equal((await read(gateway)).error?.code, 'CONNECTION_REQUIRED', 'the rejected token is not served again');
  assert.equal(s.stub.fhirRequests.length, fhirBefore, 'nothing was sent with the rejected token');
  await s.login();
  const after = await read(gateway);
  assert.equal(after.error, undefined, JSON.stringify(after.error));
  assert.ok(s.stub.fhirRequests.at(-1)!.authorized);
});

test('SMART standalone serving: a re-login with a different grant expires handles retained under the old grant', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const change of [false, true]) {
    const s = await setup(t, { expiresIn: 120 });
    await s.login();
    const gateway = s.serve();
    const first = await read(gateway);
    assert.equal(first.error, undefined, JSON.stringify(first.error));
    now += 91_000; // past the usable lifetime of a 120 s token (30 s skew), inside the retention TTL
    if (change) s.stub.grant((await s.stored()).scope.split(' ').filter(scope => scope !== 'patient/Encounter.rs').join(' '));
    await s.login();
    const retained = await gateway.execute('fhir_result', { handle: first.result!.handle });
    if (change) {
      assert.equal(retained.error?.code, 'RESULT_EXPIRED', 'a narrower grant drops results retained under the old one');
      assert.equal((await search(gateway, 'Encounter')).error?.code, 'POLICY_DENIED');
    } else assert.equal(retained.error, undefined, 'the same grant keeps retained results');
  }
});

test('SMART standalone serving: a discovery continuation needs no token, and expires once a later call finds the grant logged out', async t => {
  const s = await setup(t);
  await s.login();
  // Ninety seconds of a one-hour token remain: usable now, inside the 30-second expiry margin a minute later.
  await s.rewrite(grant => ({ ...grant, issuedAt: Date.now() - 3_510_000, expiresAt: Date.now() + 90_000 }));
  const realNow = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  const gateway = s.serve();
  const first = await gateway.execute('fhir_capabilities', { topic: 'server', limit: 1 });
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  const cursor = (first.data as Rec).next_cursor as string;
  assert.match(cursor, /^cur_/);
  assert.equal(await removeStoredGrant(s.tokenFile), true);
  offset = 61_000; // the token now needs renewal; the continuation's snapshot is still within its lifetime
  const before = s.requests();
  const second = await gateway.execute('fhir_capabilities', { topic: 'server', cursor, limit: 1 });
  assert.equal(second.error, undefined, JSON.stringify(second.error));
  assert.equal(second.budget.upstream_calls, 0);
  assert.deepEqual(s.requests(), before, 'no discovery, token or FHIR request');
  // A call that needs the credential finds the grant gone; the continuation's snapshot expires with the old grant.
  assert.equal((await gateway.execute('fhir_capabilities', { topic: 'server', limit: 1 })).error?.code, 'CONNECTION_REQUIRED');
  const third = await gateway.execute('fhir_capabilities', { topic: 'server', cursor: (second.data as Rec).next_cursor as string, limit: 1 });
  assert.equal(third.error?.code, 'DISCOVERY_EXPIRED');
  assert.deepEqual(s.requests(), before, 'still no request');
});

test('SMART standalone serving canary: tool output and the audit trail carry no token, refresh token or code', async t => {
  const s = await setup(t, {}, { offlineAccess: true });
  await s.login();
  const gateway = s.serve();
  const outputs: unknown[] = [await search(gateway), await read(gateway)];
  await s.rewrite(expire);
  const refreshed = s.serve();
  outputs.push(await read(refreshed), await search(refreshed, 'Condition'), gateway.auditEvents, refreshed.auditEvents);
  const text = JSON.stringify(outputs);
  const secrets = [...s.stub.issued, ...s.stub.refreshTokens.keys(), ...s.stub.codes.keys(),
    ...s.stub.tokenRequests.flatMap(r => [r.form.get('code_verifier'), r.form.get('refresh_token')]).filter((v): v is string => !!v)];
  assert.ok(secrets.length >= 5);
  for (const secret of secrets) assert.ok(!text.includes(secret), 'a token, code or verifier leaked');
  assert.ok(!text.includes(await readFile(s.tokenFile, 'utf8')));
});

test('SMART standalone serving: a refresh waits for the grant lock and adopts a grant another process stored meanwhile instead of overwriting it', async t => {
  const s = await setup(t, {}, { offlineAccess: true });
  await s.login();
  const old = await s.stored();
  await s.login();
  const fresh = await s.stored();
  await writeTokenFile(s.tokenFile, expire(old));
  // Another process (a login) holds the lock while it stores a newer grant.
  await writeFile(`${s.tokenFile}.lock`, 'another-process', { mode: 0o600 });
  const gateway = s.serve();
  const pending = read(gateway);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(s.stub.tokenRequests.filter(r => r.form.get('grant_type') === 'refresh_token').length, 0, 'the refresh waits for the lock');
  await writeTokenFile(s.tokenFile, fresh);
  await unlink(`${s.tokenFile}.lock`);
  const result = await pending;
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(s.stub.tokenRequests.filter(r => r.form.get('grant_type') === 'refresh_token').length, 0, 'the newer grant was adopted, not refreshed');
  assert.deepEqual(await s.stored(), fresh, 'the newer grant was not overwritten');
  assert.ok(s.stub.fhirRequests.at(-1)!.authorized);
  await assert.rejects(lstat(`${s.tokenFile}.lock`), 'no lock is left behind');
});

test('SMART standalone serving: two servers refreshing at once send one refresh request', async t => {
  const s = await setup(t, { rotateStrictly: true }, { offlineAccess: true });
  await s.login();
  await s.rewrite(expire);
  const results = await Promise.all([read(s.serve()), read(s.serve()), search(s.serve())]);
  assert.ok(results.every(result => !result.error), JSON.stringify(results.map(r => r.error)));
  const refreshes = s.stub.tokenRequests.filter(r => r.form.get('grant_type') === 'refresh_token');
  assert.equal(refreshes.length, 1, 'the other servers adopted the refreshed grant under the lock');
  assert.ok(refreshes.every(r => r.rejected === undefined));
});

test('SMART grant lock: a stale lock is taken over, a held lock times out, a linked lock is refused, and only the holder removes it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fireboat-smart-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'grant.json'), lock = `${path}.lock`;
  await writeFile(lock, 'crashed-holder', { mode: 0o600 });
  const old = new Date(Date.now() - 600_000);
  await utimes(lock, old, old);
  assert.equal(await withGrantLock(path, async () => 'ran'), 'ran', 'a stale lock is taken over');
  await assert.rejects(lstat(lock));
  await writeFile(lock, 'live-holder', { mode: 0o600 });
  await assert.rejects(withGrantLock(path, async () => 'ran', { waitMs: 100 }), (error: unknown) => error instanceof CredentialFault && error.code === 'TOKEN_TIMEOUT');
  await unlink(lock);
  await symlink(join(dir, 'elsewhere'), lock);
  await assert.rejects(withGrantLock(path, async () => 'ran', { waitMs: 100 }), (error: unknown) => error instanceof CredentialFault && error.code === 'CREDENTIAL_UNAVAILABLE');
  await unlink(lock);
  await withGrantLock(path, async () => { await unlink(lock); await writeFile(lock, 'taken-over-by-another', { mode: 0o600 }); });
  assert.equal(await readFile(lock, 'utf8'), 'taken-over-by-another', "another holder's lock is not removed");
});

test('SMART grant lock: a live holder that works past the stale limit is never taken over', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fireboat-smart-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'grant.json');
  const events: string[] = [];
  // The holder works for more than three stale limits; its lock stays fresh because the holder keeps touching it.
  const holder = withGrantLock(path, async () => { events.push('holder:start'); await sleep(1_500); events.push('holder:end'); }, { staleMs: 400 });
  for (let i = 0; i < 200 && !events.length; i++) await sleep(5);
  const waiter = withGrantLock(path, async () => { events.push('waiter:start'); }, { staleMs: 400, waitMs: 5_000 });
  await Promise.all([holder, waiter]);
  assert.deepEqual(events, ['holder:start', 'holder:end', 'waiter:start']);
  await assert.rejects(lstat(`${path}.lock`));
});

test('SMART grant lock: a process that finds a stale lock never removes a fresh lock that replaced it, and stale reclaimers take turns', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fireboat-smart-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'grant.json'), lock = `${path}.lock`;
  const stale = async (owner = 'crashed-holder') => { await writeFile(lock, owner, { mode: 0o600 }); const old = new Date(Date.now() - 600_000); await utimes(lock, old, old); };
  const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  const realRename = fsp.rename, realUnlink = fsp.unlink;
  /** Runs `change` once, just before this process first moves or removes the lock it judged stale. */
  const interfere = async (change: () => void) => {
    let done = false;
    const first = (target: unknown) => { if (!done && target === lock) { done = true; change(); } };
    Object.assign(fsp, {
      rename: async (from: string, to: string) => { first(from); return realRename(from, to); },
      unlink: async (target: string) => { first(target); return realUnlink(target); },
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(withGrantLock(path, async () => 'ran', { waitMs: 300 }), (error: unknown) => error instanceof CredentialFault && error.code === 'TOKEN_TIMEOUT');
    } finally {
      Object.assign(fsp, { rename: realRename, unlink: realUnlink });
      syncBuiltinESMExports();
    }
    assert.ok(done);
  };
  // Another reclaimer finishes its takeover first: the lock name now holds that process's fresh lock.
  await stale();
  await interfere(() => { unlinkSync(lock); writeFileSync(lock, 'fresh-holder', { mode: 0o600 }); });
  assert.equal(readFileSync(lock, 'utf8'), 'fresh-holder', 'the fresh lock is still in place');
  // The holder of a lock that looked stale touches it (it was only slow, or its machine slept): it is left in place.
  await unlink(lock);
  await stale('slow-holder');
  await interfere(() => { const now = new Date(); utimesSync(lock, now, now); });
  assert.equal(readFileSync(lock, 'utf8'), 'slow-holder', 'the touched lock is still in place');
  // Several processes that find the same stale lock at once still run one at a time.
  await unlink(lock);
  await stale();
  let active = 0, most = 0, runs = 0;
  await Promise.all(Array.from({ length: 6 }, () => withGrantLock(path, async () => {
    active++; most = Math.max(most, active); runs++;
    await sleep(15);
    active--;
  })));
  assert.equal(runs, 6);
  assert.equal(most, 1, 'no two holders overlapped');
  await assert.rejects(lstat(lock));
});

interface Deferred { promise: Promise<void>; resolve: () => void }
const deferred = (): Deferred => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

/** What a test may do around one named process's file operations; `name` is the process, `target` the file it works on. */
interface LockHooks {
  afterOpen?: (name: string, target: string) => unknown;
  beforeRename?: (name: string, from: string) => unknown;
  afterRename?: (name: string, from: string) => unknown;
  afterLink?: (name: string, to: string) => unknown;
}

/**
 * Runs several lock holders in this process as if each were its own process. Every holder runs under a name, and the
 * patched fs/promises functions (the same technique as `interfere`) call the test's hooks around that holder's
 * operations, so a test can pause one holder at an exact step and decide what the others do meanwhile.
 */
async function lockRace(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'fireboat-smart-lock-'));
  const path = join(dir, 'grant.json'), lock = `${path}.lock`;
  const names = new AsyncLocalStorage<string>();
  const hooks: LockHooks = {};
  const moved: number[] = [];
  const firstInspect = new Map<string, Deferred>();
  const inspected = (name: string) => { if (!firstInspect.has(name)) firstInspect.set(name, deferred()); return firstInspect.get(name)!; };
  const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  const real = { open: fsp.open, rename: fsp.rename, link: fsp.link };
  Object.assign(fsp, {
    open: async (...args: Parameters<typeof fsp.open>) => {
      const handle = await real.open(...args);
      const name = names.getStore(), target = String(args[0]);
      if (name && target === lock) inspected(name).resolve();
      if (name) await hooks.afterOpen?.(name, target);
      return handle;
    },
    rename: async (from: string, to: string) => {
      const name = names.getStore();
      if (name) await hooks.beforeRename?.(name, from);
      if (from === lock) { try { moved.push(lstatSync(lock).ino); } catch { /* nothing to move */ } }
      await real.rename(from, to);
      if (name) await hooks.afterRename?.(name, from);
    },
    link: async (from: string, to: string) => {
      const name = names.getStore();
      try { await real.link(from, to); } finally { if (name) await hooks.afterLink?.(name, to); }
    },
  });
  syncBuiltinESMExports();
  t.after(async () => {
    Object.assign(fsp, real);
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  });
  let active = 0, most = 0;
  const ran: string[] = [];
  /** Starts a named holder that keeps the lock until `release` settles (briefly when omitted). */
  const start = (name: string, release?: Promise<void>) => {
    const started = deferred();
    const done = names.run(name, () => withGrantLock(path, async () => {
      active++; most = Math.max(most, active); ran.push(name); started.resolve();
      await (release ?? sleep(15));
      active--;
    }));
    return { started: started.promise, done };
  };
  /** A lock left by a holder that crashed long ago; returns its inode. */
  const stale = async () => {
    await writeFile(lock, 'crashed-holder', { mode: 0o600 });
    const old = new Date(Date.now() - 600_000);
    await utimes(lock, old, old);
    return lstatSync(lock).ino;
  };
  const current = () => ({ ino: lstatSync(lock).ino, owner: readFileSync(lock, 'utf8') });
  return {
    dir, path, lock, names, hooks, moved, start, stale, current,
    active: () => active, most: () => most, ran,
    /** Settles when the named holder first opens the lock, which it does only after it failed to create it. */
    waiting: (name: string) => inspected(name).promise,
  };
}

test('SMART grant lock: a reclaimer that judged a lock stale before another process replaced it never moves the fresh lock, so a third process never gets in', async t => {
  const r = await lockRace(t);
  const staleIno = await r.stale();
  const paused = deferred(), resume = deferred(), settled = deferred(), releaseFirst = deferred();
  let resumed = false, pausedOnce = false;
  let third: ReturnType<typeof r.start> | undefined;
  // A third process tries the lock the moment the late reclaimer next acts on it: in any gap it leaves, or while it is held.
  const tryThird = async () => { if (third) return; third = r.start('third'); await Promise.race([third.started, r.waiting('third')]); };
  r.hooks.afterOpen = async (name, target) => {
    if (name !== 'late' || target !== r.lock) return;
    // The late reclaimer has opened the stale lock to judge it, and stops there while another process takes it over.
    if (!pausedOnce) { pausedOnce = true; paused.resolve(); await resume.promise; return; }
    if (resumed) await tryThird();
  };
  r.hooks.afterRename = async (name, from) => { if (name === 'late' && from === r.lock) await tryThird(); };
  r.hooks.afterLink = (name, to) => { if (name === 'late' && to === r.lock && resumed) settled.resolve(); };
  const late = r.start('late');
  await paused.promise;
  const first = r.start('first', releaseFirst.promise);
  try {
    await first.started;
    const fresh = r.current();
    assert.notEqual(fresh.ino, staleIno, 'the first process took the stale lock over and created its own');
    resumed = true; resume.resolve();
    // The late reclaimer, still holding its outdated view of the stale lock, has acted and tried the lock again.
    await settled.promise;
    assert.ok(third, 'the third process tried the lock');
    assert.deepEqual(r.current(), fresh, 'the fresh lock was never moved or removed');
    assert.equal(r.active(), 1, 'only the first process holds the lock');
  } finally {
    releaseFirst.resolve(); resume.resolve();
    await Promise.allSettled([late.done, first.done, third?.done]);
  }
  await Promise.all([late.done, first.done, third!.done]);
  assert.deepEqual([...r.ran].sort(), ['first', 'late', 'third']);
  assert.equal(r.most(), 1, 'no two holders overlapped');
  assert.ok(r.moved.every(ino => ino === staleIno), 'only the stale lock was ever moved');
  assert.deepEqual(readdirSync(r.dir), [], 'no lock, guard or temporary file is left behind');
});

test('SMART grant lock: stale reclaimers take turns under a reclaim guard, so one about to move the stale lock is never overtaken', async t => {
  const r = await lockRace(t);
  const staleIno = await r.stale();
  const paused = deferred(), resume = deferred(), otherTried = deferred(), settled = deferred(), releaseOther = deferred();
  let resumed = false, otherLinks = 0;
  let third: ReturnType<typeof r.start> | undefined;
  const tryThird = async () => { if (third) return; third = r.start('third'); await Promise.race([third.started, r.waiting('third')]); };
  // The reclaimer has judged the lock stale and is about to move it aside; it stops there.
  r.hooks.beforeRename = async (name, from) => { if (name === 'reclaimer' && from === r.lock && !resumed) { paused.resolve(); await resume.promise; } };
  r.hooks.afterRename = async (name, from) => { if (name === 'reclaimer' && from === r.lock) await tryThird(); };
  r.hooks.afterLink = (name, to) => {
    if (to !== r.lock) return;
    if (name === 'other' && ++otherLinks === 2) otherTried.resolve();
    if (name === 'reclaimer' && resumed) settled.resolve();
  };
  const reclaimer = r.start('reclaimer');
  await paused.promise;
  const other = r.start('other', releaseOther.promise);
  try {
    // The other process also found the stale lock and has tried to create the lock again: it waited its turn, or took over.
    await otherTried.promise;
    resumed = true; resume.resolve();
    await settled.promise;
    assert.ok(third, 'the third process tried the lock');
    assert.ok(r.active() <= 1, 'no two holders at once');
    assert.ok(r.moved.every(ino => ino === staleIno), 'only the stale lock was moved');
  } finally {
    releaseOther.resolve(); resume.resolve();
    await Promise.allSettled([reclaimer.done, other.done, third?.done]);
  }
  await Promise.all([reclaimer.done, other.done, third!.done]);
  assert.deepEqual([...r.ran].sort(), ['other', 'reclaimer', 'third']);
  assert.equal(r.most(), 1, 'no two holders overlapped');
  assert.ok(r.moved.every(ino => ino === staleIno), 'only the stale lock was ever moved');
  assert.deepEqual(readdirSync(r.dir), [], 'no lock, guard or temporary file is left behind');
});

test('SMART grant lock: a reclaim guard left by a reclaimer that stopped does not block a later takeover, and is removed', async t => {
  const r = await lockRace(t);
  await r.stale();
  const paused = deferred(), resume = deferred();
  // This reclaimer stops for good just before it moves the stale lock, as if its process had crashed there.
  r.hooks.beforeRename = async (name, from) => { if (name === 'stopped' && from === r.lock) { paused.resolve(); await resume.promise; } };
  const stopped = r.start('stopped');
  try {
    await paused.promise;
    const left = readdirSync(r.dir).filter(entry => entry !== 'grant.json.lock');
    assert.equal(left.length, 1, 'the stopped reclaimer holds a reclaim guard');
    const old = new Date(Date.now() - 600_000);
    utimesSync(join(r.dir, left[0]!), old, old);
    assert.equal(await withGrantLock(r.path, async () => 'ran', { waitMs: 300 }), 'ran', 'the stale lock was taken over despite the leftover guard');
    assert.deepEqual(readdirSync(r.dir), [], 'the leftover guard was removed and no lock is left behind');
  } finally {
    resume.resolve();
    await stopped.done.catch(() => undefined);
  }
  assert.deepEqual(readdirSync(r.dir), []);
});

test('SMART grant lock: a stale lock that cannot be moved aside is refused at once, not retried past the wait limit', async t => {
  const r = await lockRace(t);
  await r.stale();
  let attempts = 0;
  r.hooks.beforeRename = (_name, from) => {
    if (from !== r.lock) return;
    // After many refusals the move is allowed, so a loop that retries without limit ends with a takeover instead of spinning.
    if (++attempts <= 50) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  };
  await assert.rejects(r.names.run('blocked', () => withGrantLock(r.path, async () => 'ran', { waitMs: 300 })),
    (error: unknown) => error instanceof CredentialFault && error.code === 'CREDENTIAL_UNAVAILABLE');
  assert.equal(attempts, 1, 'the move was attempted once');
  assert.equal(readFileSync(r.lock, 'utf8'), 'crashed-holder', 'the stale lock is left in place');
  assert.deepEqual(readdirSync(r.dir), ['grant.json.lock'], 'no guard or temporary file is left behind');
});

test('SMART grant lock: a lock that keeps vanishing before it can be inspected still ends at the wait limit', async t => {
  const r = await lockRace(t);
  const started = Date.now();
  let attempts = 0;
  // Each attempt finds a lock in place when it links, and none when it then inspects the lock, so it is told to retry at
  // once. After two seconds the interference stops, so a loop that ignores the wait limit ends with the lock instead.
  const interfering = () => Date.now() - started < 2_000;
  r.hooks.afterOpen = (name, target) => {
    if (name === 'flapping' && target.startsWith(`${r.lock}.`) && target.endsWith('.tmp') && interfering()) { attempts++; writeFileSync(r.lock, 'flapping-holder', { mode: 0o600 }); }
  };
  r.hooks.afterLink = (name, to) => {
    if (name === 'flapping' && to === r.lock && interfering()) { try { if (readFileSync(r.lock, 'utf8') === 'flapping-holder') unlinkSync(r.lock); } catch { /* already gone */ } }
  };
  await assert.rejects(r.names.run('flapping', () => withGrantLock(r.path, async () => 'ran', { waitMs: 200 })),
    (error: unknown) => error instanceof CredentialFault && error.code === 'TOKEN_TIMEOUT');
  assert.ok(Date.now() - started < 2_000, 'the wait limit ended the attempts, not the end of the interference');
  assert.ok(attempts > 1, 'the lock was retried at once');
  r.hooks.afterOpen = undefined; r.hooks.afterLink = undefined;
  assert.deepEqual(readdirSync(r.dir), [], 'no lock, guard or temporary file is left behind');
});

test('SMART grant lock: a reclaimer whose stepped-over leftover guard was replaced gives its own guard back and never moves the lock', async t => {
  const r = await lockRace(t);
  await r.stale();
  const lower = `${r.lock}.reclaim.0`;
  writeFileSync(lower, 'crashed-reclaimer', { mode: 0o600 });
  const old = new Date(Date.now() - 600_000);
  utimesSync(lower, old, old);
  let replaced = false;
  // The late reclaimer has opened the leftover guard to judge it. Meanwhile another reclaimer finished, removed that
  // leftover, and a third reclaimer now holds generation 0 afresh.
  r.hooks.afterOpen = (name, target) => {
    if (name !== 'late' || target !== lower || replaced) return;
    replaced = true;
    unlinkSync(lower); writeFileSync(lower, 'fresh-reclaimer', { mode: 0o600 });
  };
  await assert.rejects(r.names.run('late', () => withGrantLock(r.path, async () => 'ran', { waitMs: 300 })),
    (error: unknown) => error instanceof CredentialFault && error.code === 'TOKEN_TIMEOUT');
  assert.ok(replaced);
  assert.deepEqual(r.moved, [], 'the stale lock was never moved while another reclaimer held a lower guard');
  assert.equal(readFileSync(r.lock, 'utf8'), 'crashed-holder');
  assert.equal(readFileSync(lower, 'utf8'), 'fresh-reclaimer', "the other reclaimer's guard is left in place");
  assert.deepEqual(readdirSync(r.dir).sort(), ['grant.json.lock', 'grant.json.lock.reclaim.0'], 'the higher guard was given back');
});

test('SMART grant lock: a leftover guard is removed only while it is still the same untouched file', async t => {
  const r = await lockRace(t);
  const lower = `${r.lock}.reclaim.0`;
  for (const replacement of ['fresh', 'aged'] as const) {
    await r.stale();
    writeFileSync(lower, 'crashed-reclaimer', { mode: 0o600 });
    const old = new Date(Date.now() - 600_000);
    utimesSync(lower, old, old);
    let replaced = false;
    // Just before this reclaimer moves the stale lock, the leftover it stepped over is replaced by another file: a
    // reclaimer's fresh guard, or one whose reclaimer has since stalled past the stale limit.
    r.hooks.beforeRename = (name, from) => {
      if (name !== 'reclaimer' || from !== r.lock || replaced) return;
      replaced = true;
      unlinkSync(lower); writeFileSync(lower, 'other-reclaimer', { mode: 0o600 });
      if (replacement === 'aged') utimesSync(lower, old, old);
    };
    assert.equal(await r.names.run('reclaimer', () => withGrantLock(r.path, async () => 'ran', { waitMs: 300 })), 'ran', replacement);
    assert.ok(replaced, replacement);
    assert.equal(readFileSync(lower, 'utf8'), 'other-reclaimer', `${replacement}: the replacement guard is left in place`);
    assert.deepEqual(readdirSync(r.dir), ['grant.json.lock.reclaim.0'], `${replacement}: only the replacement guard is left`);
    unlinkSync(lower);
  }
});

test('SMART standalone serving: a refresh whose grant lock was taken over stores nothing', async t => {
  let path = '';
  const s = await setup(t, { tokenReply: (body, _call, _scope) => {
    // While the refresh request is answered, another process takes the lock over (as it may after this one slept).
    if (path && body.refresh_token !== undefined) { unlinkSync(`${path}.lock`); writeFileSync(`${path}.lock`, 'another-process', { mode: 0o600 }); }
    return body;
  } }, { offlineAccess: true });
  await s.login();
  await s.rewrite(expire);
  const before = await s.stored();
  path = s.tokenFile;
  const result = await read(s.serve());
  assert.equal(result.error?.code, 'TOKEN_TIMEOUT', JSON.stringify(result.error));
  assert.equal(result.error?.retryable, true);
  assert.equal(s.stub.tokenRequests.filter(r => r.form.get('grant_type') === 'refresh_token').length, 1);
  assert.deepEqual(await s.stored(), before, 'the holder that lost the lock wrote nothing');
  assert.equal(await readFile(`${s.tokenFile}.lock`, 'utf8'), 'another-process', "the other process's lock is left in place");
  assert.equal(s.stub.fhirRequests.length, 0);
});

test('SMART standalone: a refresh token is neither stored nor used without offlineAccess', async t => {
  const s = await setup(t, { tokenReply: body => ({ ...body, refresh_token: 'unrequested-refresh-token-value' }) });
  const result = await s.login();
  assert.equal(result.refresh, false);
  assert.equal((await s.stored()).refreshToken, undefined, 'the unrequested refresh token was discarded');
  // A refresh token already in the file (from an earlier offline configuration) is not used either.
  await s.rewrite(grant => ({ ...expire(grant), refreshToken: 'stored-refresh-token-value' }));
  const before = s.requests();
  assert.equal((await read(s.serve())).error?.code, 'CONNECTION_REQUIRED');
  assert.deepEqual(s.requests(), before, 'no discovery, token or FHIR request');
});

test('SMART standalone: a grant directory with group or other access is refused and nothing is written', async t => {
  const s = await setup(t);
  const shared = join(s.dir, 'shared');
  await mkdir(shared, { mode: 0o755 });
  await chmod(shared, 0o755);
  const linked = join(s.dir, 'linked');
  await mkdir(join(s.dir, 'private'), { mode: 0o700 });
  await symlink(join(s.dir, 'private'), linked);
  for (const directory of [shared, linked]) {
    const gateway = new FhirGateway(standaloneConfig(s.stub, join(directory, 'grant.json')) as never);
    t.after(() => gateway.close());
    let pending: Promise<unknown> = Promise.resolve(), shown = false;
    await assert.rejects(gateway.smartLogin({ listen: listenLoopbackCallback, timeoutMs: 5_000, onAuthorizeUrl: url => { shown = true; pending = approve(url.href).catch(error => error); } }),
      (error: unknown) => error instanceof CredentialFault && error.code === 'CREDENTIAL_UNAVAILABLE', directory);
    await pending;
    assert.equal(shown, false, 'the login failed before showing the authorization URL');
    assert.deepEqual(s.requests(), { discovery: 0, token: 0, fhir: 0 });
    assert.equal(s.stub.authorizeRequests.length, 0, 'nothing reached the authorization server');
    await assert.rejects(lstat(join(directory, 'grant.json')));
  }
});

test('SMART standalone: a login stores its grant only after the grant lock is free', async t => {
  const s = await setup(t);
  await writeFile(`${s.tokenFile}.lock`, 'a-refreshing-server', { mode: 0o600 });
  const login = s.login();
  for (let i = 0; i < 200 && !s.stub.tokenRequests.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(s.stub.tokenRequests.length, 1, 'the code was exchanged');
  await new Promise(resolve => setTimeout(resolve, 150));
  await assert.rejects(lstat(s.tokenFile), 'nothing is written while another process holds the lock');
  await unlink(`${s.tokenFile}.lock`);
  await login;
  const previous = await readTokenFile(s.tokenFile);
  assert.ok(previous);
  // A login whose token expires while it waits for the lock stores nothing and leaves the previous grant in place.
  const realNow = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  const lock = `${s.tokenFile}.lock`;
  const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  const realLink = fsp.link, realOpen = fsp.open;
  let lockTried = false;
  Object.assign(fsp, {
    link: async (from: string, to: string) => { if (to === lock) lockTried = true; return realLink(from, to); },
    open: async (...args: Parameters<typeof realOpen>) => { if (args[0] === lock) lockTried = true; return realOpen(...args); },
  });
  syncBuiltinESMExports();
  t.after(() => { Object.assign(fsp, { link: realLink, open: realOpen }); syncBuiltinESMExports(); });
  await writeFile(lock, 'a-refreshing-server', { mode: 0o600 });
  const exchanges = s.stub.tokenRequests.length;
  const expiring = s.login();
  for (let i = 0; i < 500 && !(s.stub.tokenRequests.length > exchanges && lockTried); i++) await sleep(10);
  assert.ok(lockTried, 'the login is waiting for the grant lock');
  offset = 3_600_000; // the one-hour token's usable lifetime has now elapsed
  await unlink(lock);
  await assert.rejects(expiring, (error: unknown) => error instanceof CredentialFault && error.code === 'TOKEN_EXPIRED');
  assert.deepEqual(await readTokenFile(s.tokenFile), previous, 'the previous grant is untouched');
});

test('SMART standalone: a tokenFile that is not an absolute path is refused as configuration', () => {
  const build = (tokenFile: string) => new SmartStandaloneProvider('http://127.0.0.1:1/fhir',
    { type: 'smart_standalone_launch', clientId: 'synthetic-client', tokenFile } as never, { patientId: 'synthetic-patient', servedTypes: ['Patient'], alias: 'synthetic' });
  build(join(tmpdir(), 'grant.json')).close();
  for (const tokenFile of ['grant.json', './grant.json', '../grant.json', '']) {
    assert.throws(() => build(tokenFile), (error: unknown) => error instanceof CredentialFault && error.code === 'INVALID_CONFIG', JSON.stringify(tokenFile));
  }
});

const cliPath = fileURLToPath(new URL('../packages/server/src/cli.ts', import.meta.url));
/** Serves the config through the real CLI over stdio and starts one fhir_capabilities call, which needs the credential. */
async function serveOverStdio(t: TestContext, config: Rec, dir: string) {
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, ['--import', 'tsx', cliPath, '--config', configPath], { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  let stderr = '', stdout = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  const initialized = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no initialize response: ${stderr}`)), 15_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.includes('"id":1')) { clearTimeout(timer); resolve(); } });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'shutdown-test', version: '0' } } })}\n`);
  await initialized;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fhir_capabilities', arguments: { topic: 'server' } } })}\n`);
  /** Exit code, or 'running' when the process is still alive `withinMs` after the call. */
  const exitWithin = async (withinMs: number): Promise<number | null | 'running'> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([exited, new Promise<'running'>(resolve => { timer = setTimeout(() => resolve('running'), withinMs); })]);
    clearTimeout(timer);
    return code;
  };
  return { child, exitWithin, stderr: () => stderr };
}

test('SMART standalone serving: shutting down while a refresh holds the grant lock removes the lock and exits within the bound', async t => {
  for (const how of ['end of standard input', 'SIGTERM'] as const) {
    let refreshing!: () => void;
    const arrived = new Promise<void>(resolve => { refreshing = resolve; });
    // The token endpoint takes the refresh request and never answers, so the refresh is inside the grant lock at shutdown.
    const s = await setup(t, { holdToken: request => request.form.get('grant_type') === 'refresh_token' ? (refreshing(), new Promise<void>(() => undefined)) : undefined }, { offlineAccess: true });
    await s.login();
    await s.rewrite(expire);
    const before = await s.stored();
    const server = await serveOverStdio(t, s.config, s.dir);
    await arrived;
    await lstat(`${s.tokenFile}.lock`);
    const startedAt = Date.now();
    if (how === 'SIGTERM') server.child.kill('SIGTERM'); else server.child.stdin.end();
    const code = await server.exitWithin(4_000);
    assert.equal(code, 0, `${how}: the server exits 0 within the bound; stderr: ${server.stderr()}`);
    assert.ok(Date.now() - startedAt < 4_000, how);
    await assert.rejects(lstat(`${s.tokenFile}.lock`), `${how}: no lock is left behind`);
    assert.deepEqual(await s.stored(), before, `${how}: the unanswered refresh stored nothing`);
  }
});

test('SMART standalone serving: a refresh that cannot finish does not keep a shutting-down server alive past the bound', async t => {
  const s = await setup(t, {}, { offlineAccess: true });
  await s.login();
  await s.rewrite(expire);
  // Another process holds the grant lock, so the refresh waits for it (up to the lock wait limit, well past the bound).
  await writeFile(`${s.tokenFile}.lock`, 'another-process', { mode: 0o600 });
  const server = await serveOverStdio(t, s.config, s.dir);
  await sleep(750);
  const startedAt = Date.now();
  server.child.stdin.end();
  const code = await server.exitWithin(5_000);
  assert.equal(code, 0, `the server exits 0 within the bound; stderr: ${server.stderr()}`);
  assert.ok(Date.now() - startedAt < 5_000);
  assert.equal(s.stub.tokenRequests.filter(r => r.form.get('grant_type') === 'refresh_token').length, 0, 'the refresh never got the lock');
  assert.equal(await readFile(`${s.tokenFile}.lock`, 'utf8'), 'another-process', "the other process's lock is left in place");
});
