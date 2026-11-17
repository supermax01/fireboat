// Live SMART client-flow check: the built fireboat CLI and server against SMART Launcher v2 in front of HAPI FHIR,
// both on literal loopback, synthetic data only. Seeds go directly to HAPI; nothing is ever written through the
// launcher. Secrets, keys and tokens are generated or received at run time and never printed: output is
// categories only, ending in one summary line.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { readTokenFile, writeTokenFile } from '../packages/auth/src/token-store.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const CLI = join(root, 'dist/packages/server/src/cli.js');
const COMPOSE = join(root, 'docker/compose.smart.yaml');
const PROJECT = 'fireboat-smart';
const LAUNCHER = 'http://127.0.0.1:18210';
const HAPI = 'http://127.0.0.1:18211/fhir/';
const PATIENT_A = 'synthetic-smart-a';
const PATIENT_B = 'synthetic-smart-b';
const KEY_ENV = 'FIREBOAT_SMART_PRIVATE_KEY';
type Rec = Record<string, any>;

let step = 'setup';
const results: Record<string, string> = {};

// --- Launch-option encoder (field order from the launcher's src/isomorphic/codec.ts) ---
const LAUNCH_TYPES = ['provider-ehr', 'patient-portal', 'provider-standalone', 'patient-standalone', 'backend-service'];
const CLIENT_TYPES = ['public', 'confidential-symmetric', 'confidential-asymmetric', 'backend-service'];
const PKCE = ['none', 'auto', 'always'];
function encodeSim(o: Rec): string {
  const backend = o.launch_type === 'backend-service';
  const fields = [
    LAUNCH_TYPES.indexOf(o.launch_type), backend ? '' : (o.patient ?? ''), backend ? '' : (o.provider ?? ''), backend ? '' : (o.encounter ?? 'AUTO'),
    !backend && o.skip_login ? 1 : 0, !backend && o.skip_auth ? 1 : 0, 0, o.scope ?? '', backend ? '' : (o.redirect_uris ?? ''), o.client_id ?? '',
    backend ? '' : (o.client_secret ?? ''), o.auth_error ?? '', o.jwks_url ?? '', o.jwks ?? '', CLIENT_TYPES.indexOf(o.client_type ?? 'public'),
    PKCE.indexOf(o.pkce ?? 'auto'), o.fhir_server ?? '',
  ];
  return Buffer.from(JSON.stringify(fields), 'utf8').toString('base64url');
}
const simBase = (sim: Rec) => `${LAUNCHER}/v/r4/sim/${encodeSim(sim)}/fhir`;

function compose(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync('docker', ['compose', ...args], { cwd: root, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`docker compose ${args.find(a => ['up', 'down'].includes(a)) ?? ''} failed`);
}
async function waitFor(url: string, check: (response: Response) => Promise<boolean>, label: string, ms = 240_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3_000) }); if (await check(response)) return; } catch { /* starting */ }
    await sleep(1_500);
  }
  throw new Error(`${label} did not become ready`);
}
/** PUT raw JSON text straight to HAPI's published port, so decimal lexemes such as 7.0 are sent exactly. */
async function seed(type: string, id: string, raw: string): Promise<void> {
  const response = await fetch(new URL(`${type}/${id}`, HAPI), { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/fhir+json', accept: 'application/fhir+json' }, body: raw });
  await response.body?.cancel();
  assert.ok(response.ok, 'synthetic seed accepted by HAPI');
}

interface Run { code: number; stdout: string; stderr: string }
function runLogin(config: string, browser: (url: string) => Promise<void>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'login', '--config', config, '--no-browser', '--timeout', '60'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', started = false, failure: unknown, pending: Promise<void> = Promise.resolve();
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
      const match = /^fireboat: authorize: (\S+)$/m.exec(stderr);
      if (match && !started) { started = true; pending = browser(match[1]!).catch(error => { failure = error; }); }
    });
    child.on('error', reject);
    child.on('close', async code => { await pending; if (failure) reject(failure); else resolve({ code: code ?? -1, stdout, stderr }); });
  });
}
/** A browser that approves at once: the launcher (skip_login, skip_auth) redirects straight to the loopback listener. */
async function approve(authorizeUrl: string): Promise<void> {
  const authorize = new URL(authorizeUrl);
  assert.equal(authorize.origin, LAUNCHER, 'authorization endpoint is the launcher on literal loopback');
  const redirectUri = authorize.searchParams.get('redirect_uri') ?? '';
  assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/, 'redirect URI is the 127.0.0.1 listener');
  const first = await fetch(authorize, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  await first.body?.cancel();
  const location = first.headers.get('location') ?? '';
  assert.equal(first.status, 302, 'authorize redirects without UI');
  assert.ok(location.startsWith(`${redirectUri}?`), 'Location targets the 127.0.0.1 listener');
  const second = await fetch(location, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  await second.body?.cancel();
  assert.equal(second.status, 200, 'listener accepted the callback');
}

async function session(config: string, env: Rec = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, '--config', config], cwd: root,
    env: { ...getDefaultEnvironment(), ...env }, stderr: 'pipe' });
  transport.stderr?.on('data', () => undefined);
  const client = new Client({ name: 'fireboat-test-smart', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(transport);
  const call = async (name: string, args: Rec) => {
    const result = await client.callTool({ name, arguments: { ...args, output: { format: 'fhir', max_bytes: 24576 } } });
    const text = (result.content as { type: string; text?: string }[] | undefined)?.find(item => item.type === 'text')?.text ?? '';
    assert.ok(!text.includes('hapi:8080') && !JSON.stringify(result).includes('hapi:8080'), 'no internal HAPI URL leaks through the launcher');
    return { envelope: result.structuredContent as Rec, text };
  };
  return { call, close: () => client.close() };
}
async function writeConfig(dir: string, name: string, baseUrl: string, auth: Rec, patientId = PATIENT_A): Promise<string> {
  const path = join(dir, `${name}.json`);
  await writeFile(path, JSON.stringify({ mode: 'synthetic', source: { alias: `live-${name}`, baseUrl, auth }, patientId }), { mode: 0o600 });
  return path;
}
function signingKey() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  return { pem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), jwk: pair.publicKey.export({ format: 'jwk' }) as Rec };
}

async function main(): Promise<void> {
  if (!existsSync(CLI)) throw new Error('build first: npm run build');
  compose(['-p', PROJECT, 'down', '-v']);
  step = 'compose up';
  // The launcher's signing SECRET exists only in this child environment.
  compose(['-f', COMPOSE, 'up', '-d', '--pull', 'never'], { ...process.env, SMART_LAUNCHER_SECRET: randomBytes(32).toString('hex') });
  step = 'readiness';
  await waitFor(new URL('metadata', HAPI).href, async r => r.ok && (await r.json() as Rec).resourceType === 'CapabilityStatement', 'HAPI');
  await waitFor(`${LAUNCHER}/v/r4/fhir/.well-known/smart-configuration`, async r => { await r.body?.cancel(); return r.ok; }, 'SMART Launcher');

  step = 'seed';
  for (const id of [PATIENT_A, PATIENT_B]) await seed('Patient', id, JSON.stringify({ resourceType: 'Patient', id, active: true, name: [{ family: 'Synthetic', given: [id === PATIENT_A ? 'Alpha' : 'Beta'] }] }));
  const observation = (id: string, patient: string, value: string) => `{"resourceType":"Observation","id":"${id}","status":"final","code":{"coding":[{"system":"http://loinc.org","code":"4548-4","display":"Synthetic HbA1c"}]},"subject":{"reference":"Patient/${patient}"},"effectiveDateTime":"2026-01-02T10:00:00Z","valueQuantity":{"value":${value},"unit":"%","system":"http://unitsofmeasure.org","code":"%"}}`;
  await seed('Observation', 'live-smart-obs-a1', observation('live-smart-obs-a1', PATIENT_A, '7.0'));
  await seed('Observation', 'live-smart-obs-a2', observation('live-smart-obs-a2', PATIENT_A, '1.50'));
  await seed('Observation', 'live-smart-obs-b1', observation('live-smart-obs-b1', PATIENT_B, '9.9'));
  for (const [id, patient] of [['live-smart-cond-a1', PATIENT_A], ['live-smart-cond-b1', PATIENT_B]] as const) {
    await seed('Condition', id, JSON.stringify({ resourceType: 'Condition', id, subject: { reference: `Patient/${patient}` }, code: { text: 'Synthetic condition' } }));
  }

  const dir = await mkdtemp(join(tmpdir(), 'fireboat-smart-live-'));
  try {
    // (a) Standalone patient launch through the built CLI, then the built server over stdio.
    step = 'standalone login';
    const standaloneSim = { launch_type: 'patient-standalone', patient: PATIENT_A, encounter: 'NONE', skip_login: true, skip_auth: true, client_type: 'public', pkce: 'always' };
    const tokenFile = join(dir, 'state', 'standalone.json');
    const standaloneBase = simBase(standaloneSim);
    const standalone = await writeConfig(dir, 'standalone', standaloneBase, { type: 'smart_standalone_launch', clientId: 'fireboat-live-public', tokenFile, offlineAccess: true });
    const login = await runLogin(standalone, approve);
    assert.equal(login.code, 0, 'standalone login exits 0');
    assert.match(login.stdout, /^login: ok scope=exact granted_types=\d+\/\d+ refresh=present\n$/, 'login summary');
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600, 'token file is 0600');
    step = 'standalone stdio';
    let mcp = await session(standalone);
    const found = await mcp.call('fhir_search', { resource_type: 'Observation' });
    assert.equal(found.envelope.error, undefined, 'standalone search succeeds');
    const ids = (found.envelope.data.resources as Rec[]).map(r => r.id).sort();
    assert.deepEqual(ids, ['live-smart-obs-a1', 'live-smart-obs-a2'], 'only the bound patient\'s observations');
    const own = await mcp.call('fhir_read', { resource_type: 'Observation', id: 'live-smart-obs-a1' });
    assert.equal(own.envelope.error, undefined, 'standalone read succeeds');
    assert.ok(own.text.includes('"value":7.0'), 'the exact decimal 7.0 survives');
    assert.equal((await mcp.call('fhir_read', { resource_type: 'Observation', id: 'live-smart-obs-b1' })).envelope.error?.code, 'NOT_FOUND', 'another patient\'s record is not delivered');
    await mcp.close();
    results.standalone = 'ok';

    // Forced refresh: the stored access token is marked expired (a shape the store accepts); a new server refreshes.
    step = 'refresh';
    const before = (await readTokenFile(tokenFile))!;
    await sleep(1_100); // the launcher's refresh token is byte-identical within the same second
    await writeTokenFile(tokenFile, { ...before, issuedAt: Date.now() - 7_200_000, expiresAt: Date.now() - 3_600_000 });
    mcp = await session(standalone);
    const refreshed = await mcp.call('fhir_read', { resource_type: 'Observation', id: 'live-smart-obs-a2' });
    assert.equal(refreshed.envelope.error, undefined, 'a call after expiry refreshes and succeeds');
    assert.ok(refreshed.text.includes('"value":1.50'), 'the exact decimal 1.50 survives');
    await mcp.close();
    const after = (await readTokenFile(tokenFile))!;
    assert.ok(after.refreshToken && after.refreshToken !== before.refreshToken, 'the rotated refresh token was written back');
    assert.notEqual(after.accessToken, before.accessToken, 'a new access token was stored');
    assert.ok(after.expiresAt > Date.now(), 'the new access token is current');
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600, 'token file stays 0600');
    results.refresh = 'ok';

    step = 'wrong patient';
    const wrongFile = join(dir, 'state', 'wrong-patient.json');
    const wrong = await writeConfig(dir, 'wrong-patient', simBase({ ...standaloneSim, patient: PATIENT_B }), { type: 'smart_standalone_launch', clientId: 'fireboat-live-public', tokenFile: wrongFile });
    const refused = await runLogin(wrong, approve);
    assert.equal(refused.code, 1, 'wrong-patient login exits 1');
    assert.ok(refused.stderr.endsWith('fireboat: PATIENT_MISMATCH\n'), 'wrong-patient login reports PATIENT_MISMATCH');
    assert.equal(existsSync(wrongFile), false, 'no token file for a wrong-patient login');
    results.wrong_patient = 'refused';

    // (b) Backend Services with an inline public JWKS; the private key reaches the server only through its env var.
    step = 'backend';
    const key = signingKey();
    const kid = `live-${randomBytes(6).toString('hex')}`;
    const jwks = (jwk: Rec) => JSON.stringify({ keys: [{ ...jwk, kid, alg: 'ES384', key_ops: ['verify'] }] });
    const backendSim = { launch_type: 'backend-service', client_id: 'fireboat-live-backend', jwks: jwks(key.jwk), client_type: 'backend-service' };
    const backendAuth = { type: 'smart_backend_services', clientId: 'fireboat-live-backend', keyId: kid, privateKeyEnv: KEY_ENV };
    const backend = await writeConfig(dir, 'backend', simBase(backendSim), backendAuth);
    mcp = await session(backend, { [KEY_ENV]: key.pem });
    const backendSearch = await mcp.call('fhir_search', { resource_type: 'Observation' });
    assert.equal(backendSearch.envelope.error, undefined, 'backend search succeeds');
    assert.deepEqual((backendSearch.envelope.data.resources as Rec[]).map(r => r.id).sort(), ['live-smart-obs-a1', 'live-smart-obs-a2'], 'configured confinement is the patient boundary');
    const backendRead = await mcp.call('fhir_read', { resource_type: 'Condition', id: 'live-smart-cond-a1' });
    assert.equal(backendRead.envelope.error, undefined, 'backend read succeeds');
    await mcp.close();
    results.backend = 'ok';

    step = 'narrow grant';
    const narrow = await writeConfig(dir, 'narrow', simBase({ ...backendSim, scope: 'system/Observation.rs' }), backendAuth);
    mcp = await session(narrow, { [KEY_ENV]: key.pem });
    const denied = await mcp.call('fhir_search', { resource_type: 'Condition' });
    assert.equal(denied.envelope.error?.code, 'POLICY_DENIED', 'an ungranted type is refused');
    assert.equal((await mcp.call('fhir_search', { resource_type: 'Observation' })).envelope.error, undefined, 'the granted type still works');
    await mcp.close();
    results.narrow_grant = 'refused';

    step = 'wrong key';
    const other = signingKey();
    mcp = await session(backend, { [KEY_ENV]: other.pem });
    const wrongKey = await mcp.call('fhir_search', { resource_type: 'Observation' });
    assert.ok(['TOKEN_ENDPOINT_ERROR', 'CONNECTION_REQUIRED'].includes(wrongKey.envelope.error?.code), 'a key outside the JWKS is refused');
    assert.deepEqual(wrongKey.envelope.data, {}, 'no records without a token');
    await mcp.close();
    results.wrong_key = 'refused';

    // (c) The launcher rejects a garbage bearer (it does not require one, so this is the only token check it makes).
    step = 'bad bearer';
    const bad = await fetch(`${standaloneBase}/Patient/${PATIENT_A}`, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { authorization: 'Bearer not-a-real-token' } });
    const badBody = await bad.text();
    assert.equal(bad.status, 401, 'garbage bearer gets 401');
    assert.ok(!badBody.includes('hapi:8080'));
    const stored = (await readTokenFile(tokenFile))!;
    const proxied = await fetch(`${standaloneBase}/Observation?patient=${PATIENT_A}&_count=1`, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${stored.accessToken}`, accept: 'application/fhir+json' } });
    const proxiedBody = await proxied.text();
    assert.equal(proxied.status, 200);
    assert.ok(!proxiedBody.includes('hapi:8080'), 'paging links are rewritten to the launcher origin');
    results.bad_bearer = '401';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let failed = false;
try { await main(); }
catch (error) {
  failed = true;
  // Assertion messages are fixed category strings; never print values, tokens or URLs.
  const reason = error instanceof assert.AssertionError ? error.message.split('\n')[0] : error instanceof Error && !/https?:/.test(error.message) ? error.message : 'unexpected error';
  process.stdout.write(`test:smart: FAIL step=${step.replace(/ /g, '_')} reason=${JSON.stringify(reason)}\n`);
} finally {
  try { compose(['-p', PROJECT, 'down', '-v']); } catch { process.stdout.write('test:smart: teardown failed; run docker compose -p fireboat-smart down -v\n'); failed = true; }
}
if (!failed) {
  process.stdout.write(`test:smart: PASS standalone=${results.standalone} refresh=${results.refresh} wrong_patient=${results.wrong_patient} backend=${results.backend} narrow_grant=${results.narrow_grant} wrong_key=${results.wrong_key} bad_bearer=${results.bad_bearer}\n`);
}
process.exitCode = failed ? 1 : 0;
