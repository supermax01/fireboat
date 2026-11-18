import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import r4Index from '../packages/core/src/generated/r4-index.json' with { type: 'json' };
import { startSyntheticFhirServer } from '../examples/synthetic-server.js';
import { FhirGateway } from '../packages/core/src/index.js';
import { listenLoopbackCallback } from '../packages/server/src/login.js';
import { approve, KEY_ENV, smartConfig, standaloneConfig, startSmartStub } from './smart-helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const CANARY = 'PRIVATE-CANARY-NEVER-PRINT';
async function invoke(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--import', 'tsx', 'packages/server/src/cli.ts', ...args],
      { cwd: root, env: { ...process.env, FIREBOAT_CONFIG: undefined, FHIR_MCP_CONFIG: undefined, ...env }, timeout: 20000 }, (error, stdout, stderr) =>
        resolve({ code: error ? typeof error.code === 'number' ? error.code : -1 : 0, stdout, stderr }));
  });
}
const resources = () => ['Patient', 'Observation'].map(type => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }],
  searchParam: [{ name: 'patient', type: 'reference' }, { name: 'subject', type: 'reference' }, { name: 'code', type: 'token' }, { name: 'date', type: 'date' }] }));
const metadata = (rows = resources()): Record<string, unknown> => ({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1',
  software: { name: CANARY, version: CANARY }, publisher: CANARY, rest: [{ mode: 'server', resource: rows }] });

async function backend(body: unknown, status = 200) {
  const requests: { method: string; path: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method!, path: req.url! });
    if (req.method === 'POST' && req.url === `/token-${CANARY}`) {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: CANARY, token_type: 'Bearer', expires_in: 300 })); return;
    }
    res.setHeader('content-type', 'application/fhir+json');
    if (req.method === 'GET' && req.url === '/fhir/metadata') { res.statusCode = status; res.end(typeof body === 'string' ? body : JSON.stringify(body)); return; }
    // A clinical probe still returns valid FHIR, so a mutation cannot hide behind an import/transport failure.
    res.end(JSON.stringify({ resourceType: 'Patient', id: 'doctor-probe', name: [{ text: CANARY }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { requests, origin, baseUrl: `${origin}/fhir`, close: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
async function configFile(baseUrl: string, overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'doctor-PRIVATE-CANARY-'));
  const path = join(directory, `config-${CANARY}.json`);
  await writeFile(path, JSON.stringify({ mode: 'synthetic', source: { alias: 'doctor-source', baseUrl }, patientId: `patient-${CANARY}`,
    privacy: { patientIdentifierSystems: [`urn:${CANARY}`] }, ...overrides }));
  return { path, close: () => rm(directory, { recursive: true, force: true }) };
}
function privateOutput(result: { stdout: string; stderr: string }): void {
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-CANARY|\b(?:https?|file):|\/private|\/Users|source_base_url|token_endpoint_origin|\bat .*\(/);
}

test('CLI config: every presence combination uses --config > FIREBOAT_CONFIG > deprecated alias', async t => {
  const source = await backend(metadata()); t.after(source.close);
  const configs = await Promise.all(['cli-source', 'preferred-source', 'alias-source'].map(alias =>
    configFile(source.baseUrl, { source: { alias, baseUrl: source.baseUrl } })));
  for (const config of configs) t.after(config.close);
  const note = 'fireboat: note: FHIR_MCP_CONFIG is deprecated; use FIREBOAT_CONFIG.\n';
  for (const flag of [false, true]) for (const preferred of [false, true]) for (const alias of [false, true]) {
    for (const form of flag ? ['separate', 'equals'] : ['absent']) {
      const args = ['--doctor', ...(form === 'separate' ? ['--config', configs[0]!.path]
        : form === 'equals' ? [`--config=${configs[0]!.path}`] : [])];
      const result = await invoke(args, { FIREBOAT_CONFIG: preferred ? configs[1]!.path : undefined,
        FHIR_MCP_CONFIG: alias ? configs[2]!.path : undefined });
      const expected = flag ? 'cli-source' : preferred ? 'preferred-source' : alias ? 'alias-source' : undefined;
      assert.equal(result.code, expected ? 0 : 2);
      if (expected) {
        assert.match(result.stdout, new RegExp(`^source: alias=${expected} `, 'm'));
        assert.equal(result.stderr, !flag && !preferred && alias ? note : '');
      } else {
        assert.equal(result.stdout, ''); assert.equal(result.stderr, 'fireboat: CONFIG_INVALID\n');
      }
      privateOutput(result);
    }
  }
  assert.deepEqual(source.requests, Array.from({ length: 11 }, () => ({ method: 'GET', path: '/fhir/metadata' })));
});

test('CLI config: invalid or empty higher-precedence paths refuse without falling through or exposing values', async t => {
  const source = await backend(metadata()); t.after(source.close);
  const config = await configFile(source.baseUrl); t.after(config.close);
  const invalid = `/private/${CANARY}`;
  for (const value of [invalid, '']) {
    for (const args of [...(value ? [['--doctor', '--config', value]] : []), ['--doctor', `--config=${value}`]]) {
      const result = await invoke(args, { FIREBOAT_CONFIG: config.path, FHIR_MCP_CONFIG: config.path });
      assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'fireboat: CONFIG_INVALID\n');
      privateOutput(result);
    }
    const result = await invoke(['--doctor'], { FIREBOAT_CONFIG: value, FHIR_MCP_CONFIG: config.path });
    assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'fireboat: CONFIG_INVALID\n');
    privateOutput(result);
    const legacy = await invoke(['--doctor'], { FHIR_MCP_CONFIG: value });
    assert.equal(legacy.code, 2); assert.equal(legacy.stdout, '');
    assert.equal(legacy.stderr, 'fireboat: note: FHIR_MCP_CONFIG is deprecated; use FIREBOAT_CONFIG.\nfireboat: CONFIG_INVALID\n');
    privateOutput(legacy);
  }
  assert.deepEqual(source.requests, []);
});

test('doctor CLI: only metadata and auth requests; partial summary with targeted Patient and Observation is ready', async t => {
  const wide = Object.entries(r4Index.definitions).filter(([name, definition]) => definition.kind === 'resource' && !['Patient', 'Observation'].includes(name))
    .map(([type]) => ({ type, interaction: [{ code: 'read' }], searchParam: [] }));
  const source = await backend(metadata([...resources(), ...wide])); t.after(source.close);
  const config = await configFile(source.baseUrl, { source: { alias: 'doctor-source', baseUrl: source.baseUrl, auth: {
    type: 'client_credentials', tokenUrl: `${source.origin}/token-${CANARY}`, clientId: CANARY, clientSecretEnv: 'DOCTOR_SECRET', scopes: [CANARY],
  } } }); t.after(config.close);
  const result = await invoke(['--doctor', '--config', config.path], { DOCTOR_SECRET: CANARY, HTTP_PROXY: `http://${CANARY}`, NODE_USE_ENV_PROXY: '1' });
  assert.deepEqual(source.requests, [{ method: 'POST', path: `/token-${CANARY}` }, { method: 'GET', path: '/fhir/metadata' }]);
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
  assert.match(result.stdout, /^doctor: ready\n/); assert.match(result.stdout, /summary=partial/);
  assert.match(result.stdout, /workflow: recent-labs-v1 patient=ready observation=ready/);
  assert.match(result.stdout, /auth=client_credentials/); assert.match(result.stdout, /proxy: present/);
  privateOutput(result);
});

test('doctor CLI: each absent executable interaction is not-ready without a clinical probe', async t => {
  for (const missing of ['Patient', 'Observation']) {
    const rows = resources(); rows.find(row => row.type === missing)!.interaction = [{ code: missing === 'Patient' ? 'search-type' : 'read' }];
    const source = await backend(metadata(rows)); t.after(source.close);
    const config = await configFile(source.baseUrl); t.after(config.close);
    const result = await invoke(['--doctor', '--config', config.path]);
    assert.equal(result.code, 1); assert.match(result.stdout, /^doctor: not-ready\n/);
    assert.match(result.stdout, /faults: WORKFLOW_TYPE_UNAVAILABLE/); privateOutput(result);
    assert.deepEqual(source.requests, [{ method: 'GET', path: '/fhir/metadata' }]);
  }
});

test('doctor CLI: invalid, unavailable and unsupported metadata emit finite codes only', async t => {
  for (const [body, status, fault] of [
    [{ resourceType: 'OperationOutcome', issue: [{ diagnostics: CANARY }] }, 503, 'METADATA_UNAVAILABLE'],
    ['{"broken":"' + CANARY, 200, 'METADATA_INVALID'],
    [{ ...metadata(), rest: CANARY }, 200, 'METADATA_INVALID'],
    [{ ...metadata(), fhirVersion: CANARY }, 200, 'FHIR_VERSION_UNSUPPORTED'],
    [{ ...metadata(), fhirVersion: '4.0.2' }, 200, 'FHIR_VERSION_UNSUPPORTED'],
  ] as const) {
    const source = await backend(body, status); t.after(source.close);
    const config = await configFile(source.baseUrl); t.after(config.close);
    const result = await invoke(['--doctor', '--config', config.path]);
    assert.equal(result.code, 1, result.stderr); assert.match(result.stdout, /^doctor: not-ready\n/);
    assert.ok(result.stdout.includes(fault)); privateOutput(result);
    assert.deepEqual(source.requests, [{ method: 'GET', path: '/fhir/metadata' }]);
  }
});

test('doctor CLI: a client-credentials sign-in that yields no token is SIGN_IN_UNAVAILABLE, and the metadata is not checked', async t => {
  const source = await backend(metadata()); t.after(source.close);
  for (const [tokenPath, env] of [
    // The configured secret is not set: nothing is sent.
    [`/token-${CANARY}`, {}],
    // The token endpoint answers with something that is not a token: only the token request is sent.
    [`/not-a-token-${CANARY}`, { DOCTOR_SECRET: CANARY }],
  ] as const) {
    source.requests.length = 0;
    const config = await configFile(source.baseUrl, { source: { alias: 'doctor-source', baseUrl: source.baseUrl, auth: {
      type: 'client_credentials', tokenUrl: `${source.origin}${tokenPath}`, clientId: CANARY, clientSecretEnv: 'DOCTOR_SECRET', scopes: [CANARY],
    } } }); t.after(config.close);
    const result = await invoke(['--doctor', '--config', config.path], { DOCTOR_SECRET: undefined, ...env });
    assert.equal(result.code, 1, result.stderr); assert.match(result.stdout, /^doctor: not-ready\n/);
    assert.match(result.stdout, /^metadata: not-checked fhir=unknown revision=unknown summary=unknown types=unknown$/m);
    assert.match(result.stdout, /^faults: SIGN_IN_UNAVAILABLE,WORKFLOW_TYPE_UNAVAILABLE$/m);
    assert.deepEqual(source.requests, 'DOCTOR_SECRET' in env ? [{ method: 'POST', path: tokenPath }] : [], tokenPath);
    privateOutput(result);
  }
});

test('doctor CLI: SMART discovery naming an off-origin or non-literal token endpoint, or a redirect from discovery or the token endpoint, is SIGN_IN_UNAVAILABLE before any FHIR request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'doctor-smart-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const cases: [string, Parameters<typeof startSmartStub>[0]][] = [
    ['off-origin token endpoint', { discovery: doc => ({ ...doc, token_endpoint: 'http://127.0.0.1:9/auth/token' }) }],
    ['non-literal token endpoint', { discovery: (doc, origin) => ({ ...doc, token_endpoint: `${origin.replace('127.0.0.1', 'localhost')}/auth/token` }) }],
    ['discovery redirect', { discoveryReply: res => { res.statusCode = 302; res.setHeader('location', 'http://127.0.0.1:9/elsewhere'); res.end(); return true; } }],
    ['token endpoint redirect', { tokenReply: () => ({ status: 307, headers: { location: 'http://127.0.0.1:9/elsewhere' } }) }],
  ];
  for (const [label, options] of cases) {
    const stub = await startSmartStub(options);
    try {
      const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify(smartConfig(stub)));
      const result = await invoke(['--doctor', '--config', path], { [KEY_ENV]: stub.keys.pem });
      assert.equal(result.code, 1, `${label}: ${result.stderr}`);
      assert.match(result.stdout, /^metadata: not-checked fhir=unknown revision=unknown summary=unknown types=unknown$/m, label);
      assert.match(result.stdout, /^faults: SIGN_IN_UNAVAILABLE,WORKFLOW_TYPE_UNAVAILABLE$/m, label);
      assert.equal(stub.fhirRequests.length, 0, `${label}: no FHIR request was sent`);
      privateOutput(result);
    } finally { await stub.close(); }
  }
});

test('doctor CLI: after a good sign-in, a redirect on /metadata is a metadata fault and a token the source rejects is SIGN_IN_UNAVAILABLE', async t => {
  const auth = (origin: string) => ({ type: 'client_credentials', tokenUrl: `${origin}/token-${CANARY}`, clientId: CANARY, clientSecretEnv: 'DOCTOR_SECRET', scopes: [CANARY] });
  for (const [label, status, signIn, metadataLine, fault] of [
    ['redirected metadata', 302, true, /^metadata: unavailable fhir=unknown /m, 'METADATA_UNAVAILABLE'],
    ['rejected token', 401, true, /^metadata: not-checked fhir=unknown revision=unknown summary=unknown types=unknown$/m, 'SIGN_IN_UNAVAILABLE'],
    ['redirected metadata without sign-in', 302, false, /^metadata: unavailable fhir=unknown /m, 'METADATA_UNAVAILABLE'],
  ] as const) {
    const source = await backend(status === 302 ? metadata() : { resourceType: 'OperationOutcome', issue: [{ diagnostics: CANARY }] }, status); t.after(source.close);
    const config = await configFile(source.baseUrl, signIn ? { source: { alias: 'doctor-source', baseUrl: source.baseUrl, auth: auth(source.origin) } } : {}); t.after(config.close);
    const result = await invoke(['--doctor', '--config', config.path], { DOCTOR_SECRET: CANARY });
    assert.equal(result.code, 1, `${label}: ${result.stderr}`);
    assert.match(result.stdout, metadataLine, label);
    assert.match(result.stdout, new RegExp(`^faults: ${fault},WORKFLOW_TYPE_UNAVAILABLE$`, 'm'), label);
    // One token request at most: the credential obtained for the sign-in phase is the one the metadata request carries.
    assert.deepEqual(source.requests, [...signIn ? [{ method: 'POST', path: `/token-${CANARY}` }] : [], { method: 'GET', path: '/fhir/metadata' }], label);
    privateOutput(result);
  }
});

test('doctor CLI: without configured sign-in, a source that refuses the metadata is METADATA_UNAVAILABLE', async t => {
  const source = await backend({ resourceType: 'OperationOutcome', issue: [{ diagnostics: CANARY }] }, 401); t.after(source.close);
  const config = await configFile(source.baseUrl); t.after(config.close);
  const result = await invoke(['--doctor', '--config', config.path]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /^metadata: unavailable fhir=unknown /m);
  assert.match(result.stdout, /^faults: METADATA_UNAVAILABLE,WORKFLOW_TYPE_UNAVAILABLE$/m);
  assert.deepEqual(source.requests, [{ method: 'GET', path: '/fhir/metadata' }]);
  privateOutput(result);
});

test('doctor CLI: config, profile, path and argument faults never echo their inputs', async t => {
  for (const [overrides, code] of [
    [{ mode: CANARY }, 'CONFIG_INVALID'],
    [{ source: { alias: 'doctor-source', baseUrl: `https://${CANARY}/fhir` } }, 'CONFIG_INVALID'],
    [{ source: { alias: 'doctor-source', baseUrl: 'http://127.0.0.1:9/fhir', searchProfile: CANARY } }, 'PROFILE_INVALID'],
    [{ source: { alias: CANARY + '\n', baseUrl: 'http://127.0.0.1:9/fhir' } }, 'CONFIG_INVALID'],
  ] as const) {
    const config = await configFile('http://127.0.0.1:9/fhir', overrides); t.after(config.close);
    const result = await invoke(['--doctor', '--config', config.path]);
    assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.equal(result.stderr, `fireboat: ${code}\n`); privateOutput(result);
  }
  for (const args of [['--doctor', '--config', `/private/${CANARY}`], ['--doctor'], ['--doctor', `--${CANARY}`]]) {
    const result = await invoke(args); assert.equal(result.code, 2); assert.equal(result.stdout, ''); privateOutput(result);
  }
});

test('doctor CLI: bundled synthetic source is ready with safe profile limitation', async t => {
  const source = await startSyntheticFhirServer(); t.after(() => source.close());
  const config = await configFile(source.baseUrl); t.after(config.close);
  const result = await invoke(['--doctor', '--config', config.path]);
  assert.equal(result.code, 0); assert.match(result.stdout, /^doctor: ready\n/);
  assert.match(result.stdout, /search_profile: generic-r4 proof=unproved filter-and-sort-execution=unknown/); privateOutput(result);
});

test('doctor CLI: a SMART standalone source reports discovery, PKCE and the stored grant on one closed line', async t => {
  const stub = await startSmartStub(); t.after(stub.close);
  const directory = await mkdtemp(join(tmpdir(), 'doctor-smart-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = standaloneConfig(stub, join(directory, 'grant.json'));
  const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify(config));
  const absent = await invoke(['--doctor', '--config', path]);
  assert.equal(absent.code, 1, absent.stderr);
  // Without a stored grant the sign-in fails before /metadata is sent: doctor names the sign-in, not the metadata.
  assert.match(absent.stdout, /^metadata: not-checked fhir=unknown revision=unknown summary=unknown types=unknown$/m);
  assert.match(absent.stdout, /^faults: SIGN_IN_UNAVAILABLE,WORKFLOW_TYPE_UNAVAILABLE$/m);
  assert.equal(stub.fhirRequests.length, 0, 'no FHIR request was sent');
  assert.match(absent.stdout, /^smart: discovery=ok pkce=S256 grant=absent patient_context=n\/a scope=unknown granted_types=unknown\/28$/m);
  assert.match(absent.stdout, /^source: alias=smart-launch loopback=literal-ok auth=smart_standalone_launch /m);
  privateOutput(absent);
  const gateway = new FhirGateway(config as never);
  let pending: Promise<unknown> = Promise.resolve();
  try { await gateway.smartLogin({ listen: listenLoopbackCallback, timeoutMs: 5000, onAuthorizeUrl: url => { pending = approve(url.href); } }); }
  finally { await pending; gateway.close(); }
  const present = await invoke(['--doctor', '--config', path]);
  assert.equal(present.code, 0, present.stderr);
  assert.match(present.stdout, /^smart: discovery=ok pkce=S256 grant=present patient_context=match scope=exact granted_types=28\/28$/m);
  assert.match(present.stdout, /^scope: local-stdio synthetic-only read-only metadata-only; smart=client-flows-not-certified; classification=operator-declared-unverified$/m);
  privateOutput(present);
});

test('doctor CLI: a SMART Backend Services source reports the grant acquired for the metadata check', async t => {
  const stub = await startSmartStub({ tokenReply: body => ({ ...body, scope: 'system/Patient.rs system/Observation.rs' }) }); t.after(stub.close);
  const directory = await mkdtemp(join(tmpdir(), 'doctor-smart-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify(smartConfig(stub)));
  const result = await invoke(['--doctor', '--config', path], { [KEY_ENV]: stub.keys.pem });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^smart: discovery=ok pkce=n\/a grant=n\/a patient_context=n\/a scope=narrower granted_types=2\/28$/m);
  privateOutput(result);
});

test('doctor CLI: under SMART, the workflow is ready only when the grant permits Patient read and Observation search', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'doctor-smart-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const cases: [string, 'ready' | 'not-ready', 'ready' | 'not-ready'][] = [
    ['system/Patient.rs', 'ready', 'not-ready'],
    ['system/Observation.rs', 'not-ready', 'ready'],
    ['system/Patient.s system/Observation.r', 'not-ready', 'not-ready'],
    ['system/Patient.r system/Observation.s', 'ready', 'ready'],
  ];
  for (const [scope, patient, observation] of cases) {
    const stub = await startSmartStub({ tokenReply: body => ({ ...body, scope }) });
    try {
      const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify(smartConfig(stub)));
      const result = await invoke(['--doctor', '--config', path], { [KEY_ENV]: stub.keys.pem });
      const ready = patient === 'ready' && observation === 'ready';
      assert.equal(result.code, ready ? 0 : 1, `${scope}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`^workflow: recent-labs-v1 patient=${patient} observation=${observation}$`, 'm'), scope);
      if (!ready) assert.match(result.stdout, /^faults: WORKFLOW_TYPE_UNAVAILABLE$/m, scope);
      assert.deepEqual(stub.fhirRequests.map(r => r.url.pathname.slice(stub.basePath.length)), ['/metadata'], `${scope}: only the metadata request was sent`);
      privateOutput(result);
    } finally { await stub.close(); }
  }
});
