import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPrepare } from '../examples/quickstart/guards.js';
import type { FreshState } from '../examples/quickstart/guards.js';
import { ownershipLabels } from '../examples/quickstart/instance.js';
import type { InstanceEvidence, InstanceReceipt } from '../examples/quickstart/instance.js';
import { GENERATOR_PINS, pinsSha256, QUICKSTART_TARGET, sha256, validateSeedManifest } from '../examples/quickstart/manifest.js';

import type { request as httpRequest } from 'node:http';
import { fakeHttp } from './quickstart/fake-http.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSeedHttpClient as createClient } from '../examples/quickstart/seed-http.js';
let activeRequest: typeof httpRequest;
const createSeedHttpClient = (...[manifest, target, options]: Parameters<typeof createClient>) =>
  createClient(manifest, target, { ...options, request: activeRequest });
import type { SeedPut } from '../examples/quickstart/seed-http.js';

function fixture() {
  const bodies = ['Patient', 'Observation', 'Organization', 'Practitioner'].map(type =>
    Buffer.from(`{"resourceType":"${type}","id":"synthetic-${type}","value":7.00}`));
  const manifest = validateSeedManifest({ schema: 1, target: QUICKSTART_TARGET, pinsSha256: pinsSha256(), composeSha256: sha256('synthetic compose'),
    artifacts: { generatorSha256: sha256('generator'), configSha256: sha256('config'), rawExportsSha256: sha256('raw'), transformSha256: sha256('transform') },
    backend: { imageIndexDigest: GENERATOR_PINS.hapi.indexDigest, imageManifestDigest: `sha256:${'1'.repeat(64)}`,
      imageConfigDigest: `sha256:${'2'.repeat(64)}`, softwareName: 'HAPI FHIR Server', softwareVersion: '8.12.0', fhirVersion: '4.0.1' },
    resources: ['Patient', 'Observation', 'Organization', 'Practitioner'].map((type, i) =>
      ({ type, id: `synthetic-${type}`, bytes: bodies[i]!.length, sha256: sha256(bodies[i]!), origin: 'edge' })) });
  const receipt: InstanceReceipt = { schema: 1, runId: 'a'.repeat(16), project: `fireboat-qs-${'a'.repeat(16)}`, service: 'hapi',
    containerId: 'b'.repeat(64), creationNonce: 'c'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z', composeSha256: manifest.composeSha256,
    volumes: [{ name: `fireboat-qs-${'a'.repeat(16)}-data`, createdAt: '2026-01-01T00:00:00.000Z', identitySha256: 'd'.repeat(64) }] };
  const evidence: InstanceEvidence = { containerId: receipt.containerId, project: receipt.project, service: 'hapi', runId: receipt.runId,
    creationNonce: receipt.creationNonce, createdAt: receipt.createdAt, composeSha256: receipt.composeSha256, labels: ownershipLabels(receipt),
    publishedPorts: [{ hostIp: '127.0.0.1', hostPort: 18080, containerPort: 8080, protocol: 'tcp', containerId: receipt.containerId }],
    volumes: receipt.volumes, backend: manifest.backend };
  const state: FreshState = { phase: 'pre-seed', counts: { Patient: 0, Observation: 0, Organization: 0, Practitioner: 0 } };
  const puts = manifest.resources.map((r, i) => ({ method: 'PUT' as const, target: `${r.type}/${r.id}`, body: bodies[i]! }));
  return { manifest, receipt, evidence, state, puts };
}

async function recording(handler?: (req: IncomingMessage, res: ServerResponse) => void) {
  const stub = fakeHttp(handler); activeRequest = stub.request; return stub;
}
const prepared = (f: ReturnType<typeof fixture>) => ({ ...f, inspect: async () => f.evidence });

test('quickstart HTTP: owned fresh positive sends only listed fixed PUTs and bounded read routes', async () => {
  const stub = await recording(), f = fixture(), client = createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: {} });
  try {
    await client.metadata();
    for (const type of Object.keys(f.state.counts)) assert.equal(await client.count(type), 0);
    await client.seed(prepared(f), f.puts);
    await client.read(f.puts[0]!.target);
    const puts = stub.requests.filter(r => r.method === 'PUT');
    assert.equal(puts.length, f.puts.length);
    puts.forEach((r, i) => {
      assert.equal(r.path, `/fhir/${f.puts[i]!.target}`); assert.deepEqual(r.body, f.puts[i]!.body);
      assert.match(r.body.toString(), /7\.00/); assert.equal(r.host, '127.0.0.1:18080');
    });
    assert(stub.requests.every(r => ['GET', 'PUT'].includes(r.method)));
    // HAPI reuses cached identical searches: every GET bypasses that cache; no PUT carries the directive.
    for (const r of stub.requests) assert.equal((r.options.headers as Record<string, unknown>)['cache-control'],
      r.method === 'GET' ? 'no-cache' : undefined, `${r.method} ${r.path}`);
    await assert.rejects(client.seed(prepared(f), f.puts), { code: 'SEED_ALREADY_ATTEMPTED' });
    assert.equal(stub.requests.filter(r => r.method === 'PUT').length, puts.length);
  } finally { client.close(); await stub.close(); }
});

test('quickstart HTTP: every prepare refusal yields zero recording-stub PUTs', async () => {
  const stub = await recording(), f = fixture();
  try {
    for (const target of [ { ...QUICKSTART_TARGET, origin: 'http://example.invalid:18080' },
      { ...QUICKSTART_TARGET, origin: 'http://127.0.0.1:18090' }, { ...QUICKSTART_TARGET, origin: 'http://127.0.0.1:18091' },
      { ...QUICKSTART_TARGET, basePath: '/other' } ])
      assert.throws(() => createSeedHttpClient(f.manifest, target, { environment: {} }), { code: 'TARGET_MISMATCH' });
    const cases = [
      { evidence: { ...f.evidence, project: 'foreign' }, code: 'INSTANCE_FOREIGN' },
      { evidence: { ...f.evidence, labels: {} }, code: 'INSTANCE_FOREIGN' },
      { evidence: { ...f.evidence, publishedPorts: [{ ...f.evidence.publishedPorts[0]!, containerId: 'e'.repeat(64) }] }, code: 'INSTANCE_FOREIGN' },
      { evidence: { ...f.evidence, backend: { ...f.evidence.backend, imageConfigDigest: `sha256:${'e'.repeat(64)}` } }, code: 'BACKEND_MISMATCH' },
      ...Object.keys(f.state.counts).map(type => ({ state: { ...f.state, counts: { ...f.state.counts, [type]: 1 } }, code: 'TARGET_NOT_FRESH' })),
      ...(['partial', 'complete'] as const).map(phase => ({ state: { ...f.state, phase }, code: 'TARGET_NOT_FRESH' }))
    ];
    for (const c of cases) {
      const client = createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: {} });
      try { await assert.rejects(client.seed({ ...prepared(f), ...c }, f.puts), { code: c.code }); }
      finally { client.close(); }
    }
    assert.equal(stub.requests.length, 0);
  } finally { await stub.close(); }
});

test('quickstart HTTP: changed body unlisted conditional method and late invalid batch refuse before writes', async () => {
  const stub = await recording(), f = fixture();
  const invalid = [
    { ...f.puts[0]!, body: Buffer.from(f.puts[0]!.body.toString().replace('7.00', '8.00')) },
    { ...f.puts[0]!, body: Buffer.alloc(1_048_577) }, { ...f.puts[0]!, body: f.puts[0]!.body.subarray(1) },
    { ...f.puts[0]!, target: 'Patient/unlisted' }, { ...f.puts[0]!, target: 'Binary/synthetic' },
    { ...f.puts[0]!, target: 'Patient?identifier=x' }, { ...f.puts[0]!, target: '../Patient/synthetic' },
    { ...f.puts[0]!, method: 'POST' }, { ...f.puts[0]!, headers: { authorization: 'secret' } }
  ];
  try {
    for (const request of invalid) {
      const client = createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: {} });
      try { await assert.rejects(client.seed(prepared(f), [...f.puts.slice(1), request] as SeedPut[]), { code: 'SEED_NOT_LISTED' }); }
      finally { client.close(); }
    }
    const client = createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: {} });
    try {
      await assert.rejects(client.seed(prepared(f), f.puts.slice(1)), { code: 'SEED_NOT_LISTED' });
      await assert.rejects(client.seed(prepared(f), f.puts.map(() => f.puts[0]!)), { code: 'SEED_NOT_LISTED' });
      await assert.rejects(client.read('Patient/unlisted'), { code: 'SEED_NOT_LISTED' });
      await assert.rejects(client.count('Binary'), { code: 'SEED_NOT_LISTED' });
    } finally { client.close(); }
    assert.equal(stub.requests.length, 0);
  } finally { await stub.close(); }
});

test('quickstart HTTP: provenance substitution immediately before writes refuses', async () => {
  const stub = await recording(), f = fixture(), client = createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: {} });
  try {
    await assert.rejects(client.seed({ ...prepared(f), inspect: async () => ({ ...f.evidence, containerId: 'f'.repeat(64) }) }, f.puts), { code: 'INSTANCE_FOREIGN' });
    assert.equal(stub.requests.length, 0);
    await assert.rejects(client.seed(prepared(f), f.puts), { code: 'SEED_ALREADY_ATTEMPTED' });
  } finally { client.close(); await stub.close(); }
});

test('quickstart HTTP: validated body snapshot resists substitution during inspection', async () => {
  const stub = await recording(), f = fixture(), client = createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: {} });
  const original = Buffer.from(f.puts[0]!.body);
  try {
    await client.seed({ ...prepared(f), inspect: async () => { f.puts[0]!.body.fill(120); return f.evidence; } }, f.puts);
    assert.deepEqual(stub.requests[0]!.body, original);
  } finally { client.close(); await stub.close(); }
});

test('quickstart HTTP: redirects refuse and never follow even same-origin routes', async () => {
  for (const status of [302, 307, 308]) {
    const stub = await recording((_req, res) => { res.writeHead(status, { location: 'http://127.0.0.1:18080/fhir/Patient/unlisted' }); res.end('{}'); });
    const f = fixture(), client = createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: {} });
    try {
      await assert.rejects(client.metadata(), { code: 'REDIRECT_REFUSED' });
      assert.equal(stub.requests.length, 1); assert.equal(stub.requests[0]!.path, '/fhir/metadata');
    } finally { client.close(); await stub.close(); }
  }
});

test('quickstart HTTP: activated proxy configuration refuses before requests', async () => {
  const stub = await recording(), f = fixture();
  try {
    for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'ALL_PROXY', 'npm_config_proxy', 'NODE_USE_ENV_PROXY'])
      assert.throws(() => createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: { [key]: key === 'NODE_USE_ENV_PROXY' ? '1' : 'http://127.0.0.1:1' } }), { code: 'PROXY_REFUSED' });
    assert.throws(() => createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: { NODE_OPTIONS: '--use-env-proxy' } }), { code: 'PROXY_REFUSED' });
    assert.equal(stub.requests.length, 0);
  } finally { await stub.close(); }
});

test('quickstart HTTP: explicit nonproxy agent ignores actual ambient proxy routing', async () => {
  const saved = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY };
  const stub = await recording(), f = fixture();
  process.env.HTTP_PROXY = process.env.http_proxy = 'http://127.0.0.1:1';
  process.env.NODE_USE_ENV_PROXY = '1';
  const client = createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: {} });
  try {
    await client.metadata(); assert.equal(stub.requests.length, 1);
    const options = stub.requests[0]!.options;
    assert.equal(options.hostname, '127.0.0.1'); assert.equal(options.port, 18080);
    assert.equal(options.agent && typeof options.agent === 'object' && options.agent.constructor.name, 'Agent');
    assert.throws(() => createSeedHttpClient(f.manifest, QUICKSTART_TARGET), { code: 'PROXY_REFUSED' });
  } finally {
    client.close(); await stub.close();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('quickstart HTTP: response size encoding request budget and deadline stay bounded', async () => {
  const f = fixture();
  for (const handler of [
    (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { 'content-length': 100 }); res.end('x'.repeat(100)); },
    (_req: IncomingMessage, res: ServerResponse) => { res.write('12345'); res.end('67890'); },
    (_req: IncomingMessage, res: ServerResponse) => { res.setHeader('content-encoding', 'gzip'); res.end('{}'); }
  ]) {
    const stub = await recording(handler), client = createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: {}, responseBytes: 8 });
    try { await assert.rejects(client.metadata(), { code: 'HTTP_LIMIT' }); }
    finally { client.close(); await stub.close(); }
  }
  const idle = await recording(() => {}), timed = createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: {}, deadlineMs: 2 });
  try { await assert.rejects(timed.metadata(), { code: 'HTTP_TIMEOUT' }); } finally { timed.close(); await idle.close(); }
  const stub = await recording(), client = createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: {}, requestBudget: 1 });
  try { await client.metadata(); await assert.rejects(client.metadata(), { code: 'HTTP_LIMIT' }); assert.equal(stub.requests.length, 1); }
  finally { client.close(); await stub.close(); }
});

test('quickstart HTTP: unreliable counts and failed writes have fixed faults and cannot replay', async () => {
  const f = fixture();
  for (const body of ['not-json', '{"resourceType":"Bundle","type":"searchset"}',
    '{"resourceType":"Bundle","type":"searchset","total":-1}',
    '{"resourceType":"Bundle","type":"searchset","total":1e-999}',
    '{"resourceType":"Bundle","type":"searchset","total":0.0}',
    Buffer.concat([Buffer.from('{"resourceType":"Bundle","type":"searchset","total":0,"id":"'), Buffer.from([255]), Buffer.from('"}')]),
    '{"resourceType":"Bundle","type":"searchset","total":0,"entry":[{}]}',
    '{"resourceType":"Bundle","type":"searchset","total":0,"link":[{"relation":"next"}]}']) {
    const stub = await recording((_req, res) => res.end(body)), client = createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: {} });
    try { await assert.rejects(client.count('Organization'), { code: 'HTTP_RESPONSE_INVALID' }); assert.equal(stub.requests.filter(r => r.method === 'PUT').length, 0); }
    finally { client.close(); await stub.close(); }
  }
  const stub = await recording((_req, res) => { res.statusCode = 500; res.end('secret error /path'); });
  const client = createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: {} });
  try {
    await assert.rejects(client.seed(prepared(f), f.puts), { code: 'HTTP_STATUS', message: 'HTTP_STATUS' });
    await assert.rejects(client.seed(prepared(f), f.puts), { code: 'SEED_ALREADY_ATTEMPTED' });
    assert.equal(stub.requests.length, 1);
  } finally { client.close(); await stub.close(); }
  const aborted = await recording((req, _res) => req.socket.destroy());
  const abortClient = createSeedHttpClient(f.manifest, QUICKSTART_TARGET, { environment: {} });
  try { await assert.rejects(abortClient.metadata(), { code: 'HTTP_FAILED', message: 'HTTP_FAILED' }); }
  finally { abortClient.close(); await aborted.close(); }
});
