// HealthLake backend: the loopback signing proxy, AWS access through the CLI, the cost estimator, teardown completeness,
// the REST loader's bundle, and arms FBh, FBdh and AH (configuration, adapter, parser, probes, backend selection).
// No AWS call is made: the proxy talks to a fake transport, the CLI is a fake exec, no server is launched.
// Credential values here are the AWS documentation's example values, never real ones.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import test from 'node:test';
import { parseLossless } from '../lib/json.js';
import { tallyBatchResponse } from '../data/medplum-lib.js';
import {
  AWS_PROFILE, AWS_REGION, AwsSessionError, REFRESH_BEFORE_MS, awsCli, cliCredentialProvider, cliEnv, endpointFor, parseDatastoreEndpoint,
  parseProcessCredentials, scrub, type Credentials, type ExecFn,
} from '../healthlake/aws.js';
import { PRICES, estimateCost } from '../healthlake/cost.js';
import { putBatchBundle, overNoteLimit, bundleTotalOf } from '../healthlake/load-lib.js';
import { filterRequestHeaders, mapPath, rewriteBundleUrls, startSigningProxy, type SigningProxyHandle } from '../healthlake/proxy.js';
import { httpsTransport, makeSigner, queryPairs, strictQuery, type UpstreamRequest, type UpstreamResponse } from '../healthlake/sign.js';
import { CREATED_KINDS, emptyManifest, teardownSteps, type CreatedResource } from '../healthlake/state.js';
import { ARMS, SCRIPTED_ARMS } from '../servers/arms.js';
import { makeAdapter, pageSizeFor, type ListedTool } from '../servers/adapters.js';
import { PARSERS } from '../servers/parsers.js';
import { ahAwsConfig, ahEnv, isAwsDirectArm, isHealthLakeArm } from '../servers/healthlake.js';
import { probeCall } from '../run/probe-adapter.js';
import { rawResources } from '../run/resources.js';
import { backendOf, proxyLogPath, sessionLapsed } from '../run/scripted.js';
import { isProxyLogName, maskArgs } from '../run/score.js';
import { ARM_LABELS, ARM_ORDER } from '../run/report.js';
import { markerHolds, uvLockConstraints } from '../servers/install.js';
import { isFireboatArm, type CallRecord, type LaunchContext } from '../lib/types.js';

const DS = 'a'.repeat(16) + '0123456789abcdef';
const endpoint = endpointFor(DS);
const UP = `https://healthlake.us-east-2.amazonaws.com/datastore/${DS}/r4/`;
// Fake credentials, built at run time so no credential-shaped literal sits in the source (public repo; secret scanners).
const FAKE_SECRET = ['fake', 'secret', 'for', 'tests'].join('-').padEnd(40, 'x');
const CREDS: Credentials = { accessKeyId: 'FAKEKEYID', secretAccessKey: FAKE_SECRET, sessionToken: 'session-token-example' };

interface Fake { calls: UpstreamRequest[]; reply: (r: UpstreamRequest) => UpstreamResponse }
const fakeTransport = (f: Fake) => async (r: UpstreamRequest) => { f.calls.push(r); return f.reply(r); };
const json = (status: number, body: unknown, headers: Record<string, string> = {}): UpstreamResponse =>
  ({ status, headers: { 'content-type': 'application/fhir+json;charset=utf-8', ...headers }, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8') });

async function withProxy(reply: Fake['reply'], fn: (p: SigningProxyHandle, f: Fake) => Promise<void>) {
  const f: Fake = { calls: [], reply };
  const p = await startSigningProxy({ port: 0, endpoint, signer: makeSigner(async () => CREDS), transport: fakeTransport(f) });
  try { await fn(p, f); } finally { await p.close(); }
}

function get(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; host?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host: opts.host ?? `127.0.0.1:${port}`, ...(opts.headers ?? {}) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => s.write(text));
    let out = '';
    s.on('data', d => { out += d.toString('utf8'); if (out.includes('\r\n\r\n')) s.end(); });
    s.on('end', () => resolve(out));
    s.on('error', reject);
  });
}

test('signing proxy: maps /fhir to the data store base and signs with SigV4 for healthlake in us-east-2', async () => {
  await withProxy(() => json(200, { resourceType: 'Patient', id: 'p1' }), async (p, f) => {
    const r = await get(p.port, '/fhir/Observation?patient=Patient/p1&date=ge2020-01-01T00:00:00%2B00:00&code=sys%7C1-2', {
      headers: { authorization: 'Bearer client-token', cookie: 'a=b', 'x-amz-security-token': 'client-supplied', 'x-amz-date': '19990101T000000Z', connection: 'x-custom', 'x-custom': '1', 'accept-encoding': 'gzip', accept: 'application/fhir+json' },
    });
    assert.equal(r.status, 200);
    assert.equal(f.calls.length, 1);
    const c = f.calls[0]!;
    assert.equal(c.host, 'healthlake.us-east-2.amazonaws.com');
    assert.equal(c.method, 'GET');
    assert.equal(c.pathWithQuery, `/datastore/${DS}/r4/Observation?patient=Patient%2Fp1&date=ge2020-01-01T00%3A00%3A00%2B00%3A00&code=sys%7C1-2`);
    const h = c.headers;
    assert.match(h.authorization!, new RegExp(`^AWS4-HMAC-SHA256 Credential=FAKEKEYID/\\d{8}/${AWS_REGION}/healthlake/aws4_request, SignedHeaders=[a-z0-9;-]*host[a-z0-9;-]*, Signature=[0-9a-f]{64}$`));
    assert.match(h['x-amz-date']!, /^\d{8}T\d{6}Z$/);
    assert.notEqual(h['x-amz-date'], '19990101T000000Z');
    assert.equal(h['x-amz-security-token'], 'session-token-example', 'the provider token, never the client-supplied one');
    assert.equal(h.host, 'healthlake.us-east-2.amazonaws.com');
    assert.equal(h.cookie, undefined);
    assert.equal(h['x-custom'], undefined, 'headers named in Connection are hop-by-hop');
    assert.equal(h['accept-encoding'], 'identity');
    assert.equal(h.accept, 'application/fhir+json');
    assert.equal(p.stats().upstream, 1);
  });
});

test('signing proxy: the configured base only; other hosts, regions, schemes and paths are refused', async () => {
  assert.equal(parseDatastoreEndpoint(UP).basePath, `/datastore/${DS}/r4/`);
  for (const bad of [
    `http://healthlake.us-east-2.amazonaws.com/datastore/${DS}/r4/`, `https://healthlake.us-east-1.amazonaws.com/datastore/${DS}/r4/`,
    `https://evil.example.com/datastore/${DS}/r4/`, `https://healthlake.us-east-2.amazonaws.com/datastore/short/r4/`,
    `https://healthlake.us-east-2.amazonaws.com/datastore/${DS}/r4/Patient`, `https://user@healthlake.us-east-2.amazonaws.com/datastore/${DS}/r4/`,
    `https://healthlake.us-east-2.amazonaws.com.evil.example/datastore/${DS}/r4/`,
  ]) assert.throws(() => parseDatastoreEndpoint(bad), /refusing|not a URL/, bad);
  for (const [path, ok] of [['/fhir', true], ['/fhir/', true], ['/fhir/Patient/p1/$everything', true], ['/fhirx', false], ['/admin', false],
    ['/fhir/../x', false], ['/fhir/%2e%2e/x', false], ['/fhir/a%2Fb', false], ['/fhir//Patient', false], ['/fhir/Patient/./x', false], ['/fhir/a%zz', false], ['/fhir/a\\b', false]] as const) {
    const m = mapPath(path, endpoint);
    assert.equal('path' in m, ok, path);
  }
  await withProxy(() => json(200, {}), async (p, f) => {
    for (const path of ['/admin', '/fhir/../datastore/other/r4/Patient', '/fhir/%2e%2e/x', '/datastore/x/r4/Patient']) {
      const r = await get(p.port, path);
      assert.equal(r.status, 403, path);
      assert.match(r.text, /OperationOutcome/);
    }
    assert.equal((await get(p.port, '/fhir/Patient', { host: 'evil.example.com:80' })).status, 403, 'non-loopback Host');
    const abs = await rawRequest(p.port, `GET http://evil.example.com/fhir/Patient HTTP/1.1\r\nHost: 127.0.0.1:${p.port}\r\nConnection: close\r\n\r\n`);
    assert.match(abs, /^HTTP\/1\.1 400/);
    assert.equal(f.calls.length, 0, 'nothing refused reached the transport');
  });
  await assert.rejects(httpsTransport({ method: 'GET', host: 'example.com', pathWithQuery: '/', headers: {} }), /refusing to connect/);
});

test('signing proxy: GET only; every other method is refused before signing', async () => {
  await withProxy(() => json(200, {}), async (p, f) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const r = await get(p.port, '/fhir/Patient/p1', { method });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.allow, 'GET');
    }
    const withBody = await rawRequest(p.port, `GET /fhir/Patient HTTP/1.1\r\nHost: 127.0.0.1:${p.port}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
    assert.match(withBody, /^HTTP\/1\.1 400/);
    assert.equal(f.calls.length, 0);
  });
});

test('signing proxy: Bundle.link and entry.fullUrl move to the proxy base; lexemes, foreign URLs and non-Bundles are untouched', async () => {
  const bundle = `{"resourceType":"Bundle","type":"searchset","total":3,"link":[{"relation":"self","url":"${UP}Observation?_count=2&patient=Patient%2Fp1"},{"relation":"next","url":"${UP}Observation?_count=2&page=eyJ2Ijoy"},{"relation":"previous","url":"https://other.example/x"}],"entry":[{"fullUrl":"${UP}Observation/o1","resource":{"resourceType":"Observation","id":"o1","valueQuantity":{"value":1.50}},"search":{"mode":"match"}},{"fullUrl":"urn:uuid:x","resource":{"resourceType":"Observation","id":"o2","valueQuantity":{"value":7.0e0}}}]}`;
  const read = '{"resourceType":"Observation","id":"o1","link":"' + UP + 'x","valueQuantity":{"value":1.50}}';
  await withProxy(r => (r.pathWithQuery.includes('Observation/o1') ? json(200, read) : json(200, bundle)), async (p, f) => {
    const r = await get(p.port, '/fhir/Observation?patient=Patient/p1&_count=2');
    const pub = `http://127.0.0.1:${p.port}/fhir/`;
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(`"url":"${pub}Observation?_count=2&page=eyJ2Ijoy"`), 'next link rewritten, query untouched');
    assert.ok(r.text.includes(`"url":"${pub}Observation?_count=2&patient=Patient%2Fp1"`));
    assert.ok(r.text.includes(`"fullUrl":"${pub}Observation/o1"`));
    assert.ok(r.text.includes('"url":"https://other.example/x"'), 'foreign link left as sent');
    assert.ok(r.text.includes('"fullUrl":"urn:uuid:x"'));
    assert.ok(r.text.includes('"value":1.50') && r.text.includes('"value":7.0e0'), 'decimal lexemes survive the rewrite');
    assert.ok(!r.text.includes('healthlake.us-east-2.amazonaws.com'));
    assert.equal(Number(r.headers['content-length']), Buffer.byteLength(r.text));
    const rd = await get(p.port, '/fhir/Observation/o1');
    assert.equal(rd.text, read, 'a resource read is passed through byte for byte');
    assert.equal(f.calls.length, 2);
    // The next link, followed through the proxy, reaches the data store with HealthLake's page token intact.
    await get(p.port, `/fhir/Observation?_count=2&page=eyJ2Ijoy`);
    assert.equal(f.calls[2]!.pathWithQuery, `/datastore/${DS}/r4/Observation?_count=2&page=eyJ2Ijoy`);
  });
  assert.equal(rewriteBundleUrls('{"resourceType":"Patient"}', UP, 'http://127.0.0.1:1/fhir/'), null);
  assert.equal(rewriteBundleUrls('not json', UP, 'http://127.0.0.1:1/fhir/'), null);
  const unchanged = '{"resourceType":"Bundle", "entry": []}';
  assert.equal(rewriteBundleUrls(unchanged, UP, 'http://127.0.0.1:1/fhir/')!.text, unchanged, 'nothing to rewrite: original bytes');
});

test('signing proxy: redirects are never followed; a 3xx becomes 502 without its Location', async () => {
  await withProxy(() => ({ status: 302, headers: { location: 'https://evil.example.com/steal' }, body: Buffer.alloc(0) }), async (p, f) => {
    const r = await get(p.port, '/fhir/Patient/p1');
    assert.equal(r.status, 502);
    assert.equal(r.headers.location, undefined);
    assert.match(r.text, /redirects are not followed/);
    assert.equal(f.calls.length, 1, 'exactly one upstream request');
  });
});

test('signing proxy: credential failure answers 502 with the reason, never a credential', async () => {
  const f: Fake = { calls: [], reply: () => json(200, {}) };
  const p = await startSigningProxy({ port: 0, endpoint, signer: makeSigner(async () => { throw new AwsSessionError('the AWS session for profile fireboat is missing or expired'); }), transport: fakeTransport(f) });
  try {
    const r = await get(p.port, '/fhir/Patient/p1');
    assert.equal(r.status, 502);
    assert.match(r.text, /session for profile fireboat/);
    assert.equal(f.calls.length, 0);
    assert.equal(p.stats().credential_errors, 1, 'counted: bench:scripted stops instead of recording a run without a session');
  } finally { await p.close(); }
  await withProxy(() => json(403, { message: 'The security token included in the request is expired' }), async (px) => {
    await get(px.port, '/fhir/Patient/p1');
    assert.equal(px.stats().credential_errors, 1);
  });
  await withProxy(() => json(403, { message: 'User is not authorized to perform: healthlake:ReadResource' }), async (px) => {
    await get(px.port, '/fhir/Patient/p1');
    assert.equal(px.stats().credential_errors, 0, 'a permission refusal is a result, not a lapsed session');
  });
});

test('request header filter and strict query encoding', () => {
  const h = filterRequestHeaders({ host: 'h', 'keep-alive': '1', 'transfer-encoding': 'chunked', 'proxy-authorization': 'x', 'x-amzn-trace-id': 't', 'x-forwarded-for': '1', prefer: 'handling=strict', 'user-agent': 'ua' });
  assert.deepEqual(h, { prefer: 'handling=strict', 'user-agent': 'ua', 'accept-encoding': 'identity' });
  assert.deepEqual(queryPairs('a=1+2&b=%2B&c=x%7Cy&a=3'), [['a', '1 2'], ['b', '+'], ['c', 'x|y'], ['a', '3']]);
  assert.equal(strictQuery([['a', "1 2!'()*"], ['b', '+']]), 'a=1%202%21%27%28%29%2A&b=%2B');
});

test('credentials only through `aws configure export-credentials`, cached and refreshed before expiry', async () => {
  let t = Date.parse('2026-11-15T12:00:00Z');
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  let fail = false;
  const out = (exp: number) => JSON.stringify({ Version: 1, AccessKeyId: 'AKIDEXAMPLE', SecretAccessKey: 'secret-example', SessionToken: 'tok', Expiration: new Date(exp).toISOString() });
  const exec: ExecFn = async (_cmd, args, opts) => { calls.push({ args, env: opts.env }); return fail ? { stdout: '', stderr: 'Error: the session has expired, run aws login', code: 255 } : { stdout: out(t + 3_600_000), stderr: '', code: 0 }; };
  const prev = process.env.AWS_ACCESS_KEY_ID;
  process.env.AWS_ACCESS_KEY_ID = 'AKIDSHOULDNOTPASS';
  try {
    const p = cliCredentialProvider({ exec, now: () => t });
    assert.equal((await p()).accessKeyId, 'AKIDEXAMPLE');
    assert.equal((await p()).sessionToken, 'tok');
    assert.equal(calls.length, 1, 'cached');
    assert.deepEqual(calls[0]!.args, ['configure', 'export-credentials', '--profile', AWS_PROFILE, '--format', 'process']);
    assert.equal(calls[0]!.env.AWS_ACCESS_KEY_ID, undefined, 'no inherited key variables');
    t += 3_600_000 - REFRESH_BEFORE_MS + 1000; // inside the refresh window
    await p();
    assert.equal(calls.length, 2, 'refreshed before expiry');
    fail = true;
    t += 3_600_000 - REFRESH_BEFORE_MS + 1000;
    assert.equal((await p()).accessKeyId, 'AKIDEXAMPLE', 'a failed refresh keeps still-valid credentials');
    t += REFRESH_BEFORE_MS;
    await assert.rejects(p(), (e: unknown) => e instanceof AwsSessionError && /aws login --profile fireboat/.test((e as Error).message) && !/secret-example/.test((e as Error).message));
  } finally {
    if (prev === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prev;
  }
  assert.throws(() => parseProcessCredentials('{"Version":1}'), AwsSessionError);
  assert.throws(() => parseProcessCredentials('nope'), AwsSessionError);
  // A key-id-shaped and a secret-shaped value, assembled at run time (never a literal in the source).
  const keyIdShape = ['AS', 'IA'].join('') + 'Z'.repeat(16);
  const secretShape = 'q'.repeat(40);
  assert.equal(scrub(`id ${keyIdShape} and ${secretShape}`), 'id <redacted-key-id> and <redacted>');
  assert.equal(cliEnv({ AWS_PROFILE: 'x', AWS_REGION: 'us-east-1', AWS_SESSION_TOKEN: 't', PATH: '/bin' }).PATH, '/bin');
  assert.deepEqual(Object.keys(cliEnv({ AWS_PROFILE: 'x', AWS_REGION: 'us-east-1', AWS_SESSION_TOKEN: 't' })).sort(), ['AWS_PAGER']);
});

test('control-plane calls carry the fixed profile and region; an expired session is reported as such', async () => {
  const seen: string[][] = [];
  const ok: ExecFn = async (_c, args) => { seen.push(args); return { stdout: '{"DatastorePropertiesList":[]}', stderr: '', code: 0 }; };
  assert.deepEqual(await awsCli(['healthlake', 'list-fhir-datastores'], { exec: ok }), { DatastorePropertiesList: [] });
  assert.deepEqual(seen[0], ['healthlake', 'list-fhir-datastores', '--profile', 'fireboat', '--region', 'us-east-2', '--output', 'json', '--no-cli-pager']);
  await assert.rejects(awsCli(['healthlake', 'list-fhir-datastores', '--region', 'us-east-1'], { exec: ok }), /sets --region itself/);
  const expired: ExecFn = async () => ({ stdout: '', stderr: 'An error occurred (ExpiredTokenException): The security token included in the request is expired', code: 254 });
  await assert.rejects(awsCli(['healthlake', 'list-fhir-datastores'], { exec: expired }), AwsSessionError);
});

test('cost estimator: data store hours dominate; storage and requests within the included amounts are free', () => {
  const e = estimateCost({ hours: 6, storage_gb: 0.19, requests: 20_000, tier: 'standard' });
  assert.equal(e.lines[0]!.usd_expected, 1.62);
  assert.equal(e.lines[1]!.usd_expected, 0);
  assert.equal(e.lines[2]!.usd_expected, 0, '20,000 requests are under 6 h x 3,500');
  assert.equal(e.lines[2]!.usd_upper, 0.03, 'upper bound: 2 x 10k x $0.015');
  assert.equal(e.total_expected, 1.62);
  assert.equal(e.total_upper, 1.65);
  const day = estimateCost({ hours: 24, storage_gb: 0.19, requests: 118_802, tier: 'advanced' });
  assert.equal(day.lines[0]!.usd_expected, 6.48);
  assert.equal(day.lines[2]!.usd_upper, 0.58, '12 x 10k x $0.048');
  assert.equal(PRICES.datastore_hour_usd, 0.27);
  assert.throws(() => estimateCost({ hours: 0, storage_gb: 0, requests: 0, tier: 'standard' }));
});

const res = (over: Partial<CreatedResource>): CreatedResource => ({
  kind: 'healthlake-datastore', name: 'fbbench-synthea-holdout-x', client_token: 'ct', id: null, arn: null, endpoint: null, status: 'ACTIVE',
  requested_at: '2026-11-15T00:00:00Z', created_at: null, active_at: null, delete_requested_at: null, deleted_at: null, status_checked_at: null, ...over,
});

test('teardown covers every resource the manifest records and refuses kinds it cannot delete', () => {
  const m = emptyManifest('synthea-holdout');
  m.resources.push(res({ id: DS, status: 'ACTIVE' }), res({ id: 'b'.repeat(32), status: 'DELETED' }), res({ name: 'fbbench-pending', client_token: 'ct2', status: 'REQUESTED' }), res({ id: 'c'.repeat(32), status: 'DELETING' }));
  const steps = teardownSteps(m);
  assert.deepEqual(steps, [
    { kind: 'healthlake-datastore', action: 'delete', id: DS, argv: ['healthlake', 'delete-fhir-datastore', '--datastore-id', DS] },
    { kind: 'healthlake-datastore', action: 'lookup-then-delete', name: 'fbbench-pending', client_token: 'ct2' },
    { kind: 'healthlake-datastore', action: 'delete', id: 'c'.repeat(32), argv: ['healthlake', 'delete-fhir-datastore', '--datastore-id', 'c'.repeat(32)] },
  ]);
  // Every kind this tooling can create has a teardown step.
  const all = emptyManifest('synthea-holdout');
  for (const kind of CREATED_KINDS) all.resources.push(res({ kind, id: DS }));
  assert.equal(teardownSteps(all).length, CREATED_KINDS.length);
  const unknown = emptyManifest('synthea-holdout');
  unknown.resources.push(res({ kind: 's3-bucket', id: 'x' }));
  assert.throws(() => teardownSteps(unknown), /does not know resource kind s3-bucket/);
  const gone = emptyManifest('synthea-holdout');
  gone.resources.push(res({ id: DS, status: 'NOT_FOUND' }));
  assert.deepEqual(teardownSteps(gone), []);
});

test('loader bundle: PUT at the file id, resource text embedded byte for byte, ids outside the pattern refused', () => {
  const lines = ['{"resourceType":"Patient","id":"p-1.a","birthDate":"2000-01-01"}', '{"resourceType":"Observation","id":"o1","valueQuantity":{"value":12.3400}}'];
  const { body, sent } = putBatchBundle(lines);
  assert.deepEqual(sent, [{ type: 'Patient', id: 'p-1.a' }, { type: 'Observation', id: 'o1' }]);
  assert.ok(body.includes(`{"resource":${lines[1]},"request":{"method":"PUT","url":"Observation/o1"}}`));
  const b = parseLossless(body) as { type: string; entry: { request: { method: string; url: string } }[] };
  assert.equal(b.type, 'batch');
  assert.deepEqual(b.entry.map(e => e.request.url), ['Patient/p-1.a', 'Observation/o1']);
  assert.throws(() => putBatchBundle(['{"resourceType":"Patient","id":"has space"}']), /id outside/);
  assert.throws(() => putBatchBundle([]), /1\.\.500/);
  const tally = tallyBatchResponse(sent, parseLossless(JSON.stringify({ resourceType: 'Bundle', type: 'batch-response', entry: [
    { response: { status: '201', location: 'Patient/p-1.a/_history/1' } }, { response: { status: '201', location: 'Observation/server-assigned/_history/1' } }] })));
  assert.equal(tally.accepted, 2);
  assert.deepEqual(tally.id_changed, [{ type: 'Observation', id: 'o1' }]);
  assert.equal(overNoteLimit(`{"resourceType":"DocumentReference","id":"d","content":[{"attachment":{"data":"${'A'.repeat(10_001)}"}}]}`), 1);
  assert.equal(overNoteLimit('{"resourceType":"DocumentReference","id":"d","content":[{"attachment":{"data":"QQ=="}}]}'), 0);
  assert.equal(bundleTotalOf('{"resourceType":"Bundle","total":40599}'), 40599);
  assert.equal(bundleTotalOf('{"resourceType":"Bundle"}'), null);
});

// ---- arms FBh, FBdh, AH --------------------------------------------------------------------------------------

const hctx = (arm: LaunchContext['arm']): LaunchContext => ({ arm, dataset: 'synthea-holdout', patientId: 'p1', slot: 0, fhirBaseUrl: 'http://127.0.0.1:18250/fhir', runDir: '/tmp/run', runTmp: '/tmp/run-tmp' });

test('FBh and FBdh are FB and FBd plus the two settings for sources without self links, pointed at the HealthLake recording proxy', () => {
  const cfg = (arm: LaunchContext['arm']) => ARMS[arm].command!(hctx(arm)).files['fireboat.json'];
  const parsed = (arm: LaunchContext['arm']) => JSON.parse(cfg(arm)!) as { source: Record<string, unknown> };
  // Exactly selfLinkOptional and continuationTokenParameter are added to the source; everything else equals FB / FBd.
  const withoutHealthLake = (arm: LaunchContext['arm']) => { const c = parsed(arm); const { selfLinkOptional, continuationTokenParameter, ...source } = c.source; return { c: { ...c, source }, selfLinkOptional, continuationTokenParameter }; };
  for (const [h, base] of [['FBh', 'FB'], ['FBdh', 'FBd']] as const) {
    const w = withoutHealthLake(h);
    assert.deepEqual(w.c, parsed(base));
    assert.equal(w.selfLinkOptional, true);
    assert.equal(w.continuationTokenParameter, 'page');
    assert.equal(parsed(base).source.selfLinkOptional, undefined);
  }
  assert.ok(cfg('FBh')!.includes('"baseUrl": "http://127.0.0.1:18250/fhir"'));
  assert.equal(ARMS.FBh.pin!.commit, ARMS.FB.pin!.commit);
  assert.equal(ARMS.FBh.installDir, ARMS.FB.installDir);
  for (const a of ['FBh', 'FBdh', 'AH'] as const) { assert.ok(SCRIPTED_ARMS.includes(a), a); assert.ok(isHealthLakeArm(a)); assert.ok(ARM_LABELS[a]); assert.ok(ARM_ORDER.includes(a)); }
  assert.ok(isFireboatArm('FBh') && isFireboatArm('FBdh') && !isFireboatArm('AH'));
  assert.ok(isAwsDirectArm('AH') && !isAwsDirectArm('FBh'));
  assert.equal(pageSizeFor('AH'), 100);
  assert.equal(pageSizeFor('FBh'), 100);
});

test('AH: pinned wheel, --readonly, profile and region by name, credentials only through the CLI, no key anywhere', () => {
  assert.equal(ARMS.AH.pin!.version, '0.0.21');
  assert.equal(ARMS.AH.pin!.artifactSha256, '3a56ed34776a860ca3d284555c2e1bbe071b6380aeb6f8f29a21c9c0a36519e4');
  const env = ahEnv('/tmp/run');
  assert.equal(env.AWS_PROFILE, 'fireboat');
  assert.equal(env.AWS_REGION, 'us-east-2');
  assert.equal(env.AWS_CONFIG_FILE, '/tmp/run/aws/config');
  for (const k of Object.keys(env)) assert.doesNotMatch(k, /ACCESS_KEY|SECRET|SESSION_TOKEN/);
  const cfg = ahAwsConfig('/opt/homebrew/bin/aws', '/home/someone');
  assert.match(cfg, /^\[profile fireboat\]\nregion = us-east-2\ncredential_process = \/usr\/bin\/env -i HOME=\/home\/someone PATH=\/opt\/homebrew\/bin:\/usr\/bin:\/bin LANG=C\.UTF-8 \/opt\/homebrew\/bin\/aws configure export-credentials --profile fireboat --format process\n$/);
  assert.doesNotMatch(cfg, /aws_access_key_id|aws_secret_access_key|aws_session_token/i);
  assert.throws(() => ahAwsConfig('/a b/aws', '/home/x'), /whitespace/);
  let cmd;
  try { cmd = ARMS.AH.command!(hctx('AH')); } catch (e) { if (/aws CLI not found/.test((e as Error).message)) return; throw e; }
  assert.deepEqual(cmd.args, ['--readonly']);
  assert.ok(cmd.command.endsWith('/venv/bin/awslabs.healthlake-mcp-server'));
  assert.ok(cmd.files['aws/config']!.includes('configure export-credentials --profile fireboat --format process'));
  for (const k of Object.keys(cmd.env)) assert.doesNotMatch(k, /ACCESS_KEY|SECRET|SESSION_TOKEN/);
});

test('one backend per invocation; --backend must match the arms; HealthLake runs log apart', () => {
  assert.equal(backendOf(['FBh', 'FBdh', 'AH']), 'healthlake');
  assert.equal(backendOf(['FBh'], 'healthlake'), 'healthlake');
  assert.equal(backendOf(['FB0', 'W']), 'hapi');
  assert.throws(() => backendOf(['FBh', 'W']), /one backend/);
  assert.throws(() => backendOf(['Ws', 'AH']), /one backend/);
  assert.throws(() => backendOf(['FB0'], 'healthlake'), /does not match/);
  assert.match(proxyLogPath('c', 0, 'healthlake'), /proxy-healthlake-s0\.jsonl$/);
  assert.match(proxyLogPath('c', 0, 'medplum'), /proxy-medplum-s0\.jsonl$/);
  assert.match(proxyLogPath('c', 0), /proxy-s0\.jsonl$/);
  // The scorer reads every backend's recording proxy log, never the signing proxy's own log.
  for (const [f, ok] of [['proxy-s3.jsonl', true], ['proxy-medplum-s0.jsonl', true], ['proxy-healthlake-s1.jsonl', true], ['signing-proxy-s0.jsonl', false]] as const) assert.equal(isProxyLogName(f), ok, f);
  assert.equal(maskArgs({ datastore_id: DS, next_token: 'abc' }), JSON.stringify({ datastore_id: DS, next_token: '<handle>' }));
});

const AH_TOOLS: ListedTool[] = ['list_datastores', 'get_datastore_details', 'read_fhir_resource', 'search_fhir_resources', 'patient_everything', 'list_fhir_jobs']
  .map(name => ({ name, inputSchema: { type: 'object', properties: {} } }));

test('AH adapter: datastore_id on every call, params mapped like W, repeated params dropped with a flag, paging by next_token', () => {
  assert.throws(() => makeAdapter('AH', AH_TOOLS, { cell: 'default', patientId: 'p1' }), /data store id/);
  const a = makeAdapter('AH', AH_TOOLS, { cell: 'default', patientId: 'p1', datastoreId: DS });
  assert.ok('refused' in a.capabilities('Observation'));
  assert.deepEqual(a.read('Patient', 'p1'), { tool: 'read_fhir_resource', arguments: { datastore_id: DS, resource_type: 'Patient', resource_id: 'p1' } });
  const s = a.search('Observation', [['patient', 'Patient/p1'], ['date', 'ge2020-01-01'], ['date', 'lt2021-01-01'], ['patient.identifier', 'x|1'], ['_revinclude', 'Provenance:target'], ['_count', '500']], 200);
  assert.ok(!('refused' in s));
  if ('refused' in s) return;
  assert.deepEqual(s.call, { tool: 'search_fhir_resources', arguments: {
    datastore_id: DS, resource_type: 'Observation', search_params: { patient: 'Patient/p1', date: 'ge2020-01-01' }, chained_params: { 'patient.identifier': 'x|1' },
    revinclude_params: ['Provenance:target'], count: 100 } });
  assert.deepEqual(s.flags, ['param_dropped:date']);
  const parsed = { items: [], signals: [], blanket: [], explicit_complete: false, page_handle: 'eyJ2IjoyfQ', refused: null, is_error: false };
  assert.deepEqual(a.next(parsed), { tool: 'search_fhir_resources', arguments: { datastore_id: DS, resource_type: 'Observation', next_token: 'eyJ2IjoyfQ' } });
  assert.ok('cannot_continue' in a.next({ ...parsed, page_handle: null }));
  assert.deepEqual(probeCall('AH', AH_TOOLS, { op: 'operation', name: '$everything', type: 'Patient', id: 'p2', body: null, raw: true }, { datastoreId: DS }),
    { tool: 'patient_everything', arguments: { datastore_id: DS, patient_id: 'p2', count: 100 } });
  for (const op of [{ op: 'create', type: 'Patient', resource: {}, raw: true }, { op: 'delete', type: 'Patient', id: 'p1', raw: true }, { op: 'operation', name: '$meta-add', type: 'Observation', id: 'o1', body: {}, raw: true }] as const) {
    assert.ok('refused' in probeCall('AH', AH_TOOLS, op as never, { datastoreId: DS }), op.op);
  }
});

const ahCall = (op: CallRecord['op'], payload: unknown, isError = false): CallRecord => ({
  seq: 0, op_index: 0, op, tool: 'search_fhir_resources', arguments: {}, started_at: '2026-11-15T00:00:00Z', latency_ms: 1, is_error: isError, bytes: null, error: null,
  response_raw: JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }], isError } }),
});

test('AH parser: reduced Bundle items (included too), next_token as the page handle, totals judged like Bundle.total, errors refused', () => {
  const parser = PARSERS.AH!;
  const page = `{\n  "resourceType": "Bundle",\n  "type": "searchset",\n  "total": 5,\n  "entry": [\n    {"fullUrl": "x", "resource": {"resourceType": "Observation", "id": "o1", "subject": {"reference": "Patient/p1"}, "valueQuantity": {"value": 1.5, "unit": "mg"}}},\n    {"resource": {"resourceType": "Observation", "id": "o2", "subject": {"reference": "Patient/p1"}}}\n  ],\n  "link": [{"relation": "next", "url": "${UP}Observation?_count=2&page=t"}],\n  "included": {"Patient": {"p1": {"resourceType": "Patient", "id": "p1"}}},\n  "pagination": {"has_next": true, "next_token": "eyJ2IjoyfQ"}\n}`;
  const p = parser.parse(ahCall('search', page));
  assert.deepEqual(p.items.map(i => i.ref), ['Observation/o1', 'Observation/o2', 'Patient/p1']);
  assert.equal(p.items[0]!.value, '1.5', 'value as AH printed it');
  assert.equal(p.page_handle, 'eyJ2IjoyfQ');
  assert.deepEqual(p.signals.map(s => s.kind).sort(), ['cursor', 'has_more', 'next_link', 'total_gt_returned']);
  assert.equal(p.explicit_complete, false);
  const last = parser.parse(ahCall('next', { resourceType: 'Bundle', type: 'searchset', total: 1, entry: [{ resource: { resourceType: 'Observation', id: 'o3' } }], link: [], pagination: { has_next: false, next_token: null } }));
  assert.equal(last.page_handle, null);
  assert.equal(last.explicit_complete, true, 'a total equal to the entries is a completeness claim (AH fills it with the page size when HealthLake sends none)');
  const err = parser.parse(ahCall('read', { error: true, type: 'not_found', message: 'Resource not found' }));
  assert.deepEqual(err.refused, { code: 'not_found', message: 'Resource not found' });
  const ro = parser.parse(ahCall('write', { error: true, type: 'read_only_violation', message: 'not available in read-only mode' }));
  assert.equal(ro.refused?.code, 'read_only_violation');
  const read = parser.parse(ahCall('read', { resourceType: 'Observation', id: 'o9', valueQuantity: { value: 7 } }));
  assert.deepEqual(read.items.map(i => i.ref), ['Observation/o9']);
  assert.deepEqual(rawResources('AH', ahCall('search', page)).map(r => `${String(r.resourceType)}/${String(r.id)}`), ['Observation/o1', 'Observation/o2', 'Patient/p1']);
  const lapsed = ahCall('search', { error: true, type: 'auth_error', message: 'Error when retrieving token from sso: Token has expired and refresh failed' });
  assert.equal(sessionLapsed({ arm: 'AH', calls: [lapsed] }), true);
  assert.equal(sessionLapsed({ arm: 'AH', calls: [ahCall('search', { error: true, type: 'auth_error', message: 'AccessDenied: not authorized to perform healthlake:SearchEverything' })] }), false);
  assert.equal(sessionLapsed({ arm: 'FBh', calls: [lapsed] }), false);
});

test('AH lock constraints: the release commit uv.lock versions that apply to CPython 3.12 on macOS', () => {
  const lock = ['version = 1', '', '[[package]]', 'name = "mcp"', 'version = "1.30.0"', 'source = { registry = "https://pypi.org/simple" }', '',
    '[[package]]', 'name = "pydantic"', 'version = "2.11.7"', 'source = { registry = "https://pypi.org/simple" }', 'resolution-markers = [', '    "python_full_version < \'3.14\' and sys_platform != \'win32\'",', ']', '',
    '[[package]]', 'name = "pydantic"', 'version = "2.13.4"', 'source = { registry = "https://pypi.org/simple" }', 'resolution-markers = [', '    "python_full_version >= \'3.14\' and sys_platform != \'win32\'",', ']', '',
    '[[package]]', 'name = "awslabs-healthlake-mcp-server"', 'version = "0.0.21"', 'source = { editable = "." }', ''].join('\n');
  assert.deepEqual(uvLockConstraints(lock), ['mcp==1.30.0', 'pydantic==2.11.7']);
  assert.equal(markerHolds("python_full_version >= '3.10' and sys_platform == 'darwin'"), true);
  assert.equal(markerHolds("sys_platform == 'win32'"), false);
  assert.throws(() => markerHolds("platform_machine == 'arm64'"), /unsupported/);
});
