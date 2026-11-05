import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openGatewaySession } from '../examples/quickstart/client.js';
import { validateHelperAssets } from '../examples/quickstart/prepare.js';
import { setupOracle } from '../examples/quickstart/setup-oracle.js';
import { sha256 } from '../examples/quickstart/manifest.js';
import { atomicPrivateWrite, jsonBytes } from '../examples/quickstart/run-state.js';
import { verify, type DoctorRunner } from '../examples/quickstart/verify.js';

type Rec = Record<string, unknown>;
const root = fileURLToPath(new URL('../', import.meta.url));
const ndjson = await readFile(join(root, 'packages/evals/fixtures/quickstart/resources.ndjson'), 'utf8');
const ASSETS = { manifest: await readFile(join(root, 'examples/quickstart/seed-manifest.json')), compose: await readFile(join(root, 'compose.quickstart.yaml')), resources: Buffer.from(ndjson) };
const PATIENT = 'd44d0c9c-ccd8-7945-3968-d043ff9a5805';

/**
 * A loopback source serving the checked-in seed as HAPI FHIR does for these tasks: version 1 of every resource with its
 * raw lexemes, token/date/reference search with `-date` sort and `_count`, opaque `_getpages` continuations at the base,
 * and 404 OperationOutcomes. Anything else refuses, so the gateway's actual requests are what is exercised.
 */
async function seededSource() {
  const raw = new Map<string, string>(), parsed = new Map<string, Rec>();
  for (const line of ndjson.trimEnd().split('\n')) {
    const head = /^\{"resourceType":"([A-Za-z]+)","id":"([^"]+)",/.exec(line);
    assert.ok(head, 'each seed line opens with its type and id');
    const body = `${head[0]}"meta":{"versionId":"1"},${line.slice(head[0].length)}`;
    raw.set(`${head[1]}/${head[2]}`, body); parsed.set(`${head[1]}/${head[2]}`, JSON.parse(body) as Rec);
  }
  const types = [...new Set([...parsed.values()].map(r => r.resourceType as string))].sort();
  const params: Record<string, { name: string; type: string }[]> = {
    Observation: [{ name: 'code', type: 'token' }, { name: 'date', type: 'date' }, { name: 'category', type: 'token' }, { name: 'subject', type: 'reference' }, { name: 'patient', type: 'reference' }],
    DocumentReference: [{ name: 'subject', type: 'reference' }, { name: 'patient', type: 'reference' }, { name: 'date', type: 'date' }],
    Patient: [{ name: '_id', type: 'token' }],
  };
  const capability = JSON.stringify({ resourceType: 'CapabilityStatement', status: 'active', date: '2026-10-24', kind: 'instance', fhirVersion: '4.0.1',
    software: { name: 'HAPI FHIR Server', version: '8.12.0' }, format: ['application/fhir+json'],
    rest: [{ mode: 'server', resource: types.map(type => ({ type, interaction: [{ code: 'read' }, { code: 'vread' }, { code: 'search-type' }], searchParam: params[type] ?? [] })) }] });
  const searches = new Map<string, string[]>(), requests: string[] = [];
  const token = (concepts: unknown[], value: string) => {
    const [system, code] = value.includes('|') ? value.split('|') as [string, string] : [undefined, value];
    return concepts.some(c => Array.isArray((c as Rec)?.coding) && ((c as Rec).coding as Rec[]).some(x => x.code === code && (system === undefined || x.system === system)));
  };
  const when = (r: Rec) => Date.parse((r.effectiveDateTime ?? r.date) as string);
  const matches = (r: Rec, name: string, value: string): boolean => {
    if (name === 'subject' || name === 'patient') return (r.subject as Rec | undefined)?.reference === (value.startsWith('Patient/') ? value : `Patient/${value}`);
    if (name === 'code') return token([r.code], value);
    if (name === 'category') return token(Array.isArray(r.category) ? r.category : [], value);
    if (name === 'date') {
      const [, prefix, bound] = /^(ge|gt|le|lt|eq)?(.+)$/.exec(value)!, at = Date.parse(bound!);
      return ({ ge: when(r) >= at, gt: when(r) > at, le: when(r) <= at, lt: when(r) < at, eq: when(r) === at } as Record<string, boolean>)[prefix ?? 'eq']!;
    }
    return false;
  };
  const outcome = (diagnostics: string) => JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'processing', diagnostics }] });
  const server = createServer((req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`), origin = `http://${req.headers.host}`;
    requests.push(`${req.method} ${url.pathname}`);
    res.setHeader('content-type', 'application/fhir+json;charset=utf-8');
    const send = (status: number, body: string) => { res.statusCode = status; res.end(body); };
    const bundle = (id: string, keys: string[], offset: number, count: number) => {
      const next = offset + count < keys.length ? [{ relation: 'next', url: `${origin}/fhir?_getpages=${id}&_getpagesoffset=${offset + count}&_count=${count}&_pretty=true&_bundletype=searchset` }] : [];
      const entries = keys.slice(offset, offset + count).map(key => `{"fullUrl":"${origin}/fhir/${key}","resource":${raw.get(key)!},"search":{"mode":"match"}}`);
      return `{"resourceType":"Bundle","id":"${randomUUID()}","type":"searchset","link":${JSON.stringify([{ relation: 'self', url: `${origin}${req.url}` }, ...next])},"entry":[${entries.join(',')}]}`;
    };
    if (req.method !== 'GET') return send(405, outcome('not supported'));
    const path = url.pathname.split('/').filter(Boolean);
    if (path[0] !== 'fhir') return send(404, outcome('not found'));
    if (path.length === 2 && path[1] === 'metadata') return send(200, capability);
    if (path.length === 1) {
      const keys = searches.get(url.searchParams.get('_getpages') ?? '');
      return keys ? send(200, bundle(url.searchParams.get('_getpages')!, keys, Number(url.searchParams.get('_getpagesoffset')), Number(url.searchParams.get('_count')))) : send(410, outcome('gone'));
    }
    if (path.length === 3) return raw.has(`${path[1]}/${path[2]}`) ? send(200, raw.get(`${path[1]}/${path[2]}`)!) : send(404, outcome(`Resource ${path[1]}/${path[2]} is not known`));
    if (path.length !== 2) return send(404, outcome('not found'));
    const pairs = [...url.searchParams], count = Number(url.searchParams.get('_count') ?? 20), sort = url.searchParams.get('_sort');
    if (pairs.some(([name]) => !['_count', '_sort', ...(params[path[1]!] ?? []).map(p => p.name)].includes(name)) || (sort !== null && sort !== '-date')) return send(400, outcome('unsupported parameter'));
    const keys = [...parsed.entries()].filter(([key, r]) => key.startsWith(`${path[1]}/`) && pairs.every(([name, value]) => name.startsWith('_') || matches(r, name, value))).map(([key]) => key);
    if (sort === '-date') keys.sort((a, b) => when(parsed.get(b)!) - when(parsed.get(a)!));
    const id = randomUUID(); searches.set(id, keys);
    return send(200, bundle(id, keys, 0, count));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/fhir`;
  return { baseUrl, requests, raw, parsed, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

/** A run directory as a completed prepare leaves it for the checked-in helper assets: receipt, attempt record and packet. */
async function preparedRun(directory: string, source: Awaited<ReturnType<typeof seededSource>>): Promise<string> {
  const run = join(directory, 'run');
  await mkdir(run, { mode: 0o700 });
  const manifest = JSON.parse(ASSETS.manifest.toString('utf8')) as { composeSha256: string; resources: { type: string; id: string }[] };
  const runId = 'e2e0e2e0e2e0e2e0', creationNonce = 'c'.repeat(64), containerId = 'f'.repeat(64);
  const instance = { schema: 1, runId, project: `fireboat-qs-${runId}`, service: 'hapi', containerId, creationNonce, createdAt: '2026-10-24T00:00:00.000Z', composeSha256: manifest.composeSha256, volumes: [] };
  const receipt: Rec = { schema: 'fireboat-quickstart-run/1', runId, project: `fireboat-qs-${runId}`, creationNonce, startedAt: '2026-10-24T00:00:00.000Z', phase: 'seeding',
    manifestSha256: sha256(ASSETS.manifest), composeSha256: manifest.composeSha256, containerId, instance, attemptSha256: null, packetSha256: null };
  const attempt = jsonBytes(receipt);
  receipt.attemptSha256 = sha256(attempt);
  const approved = validateHelperAssets(ASSETS);
  const observations = await setupOracle(approved.manifest, approved.puts, { read: async target => Buffer.from(source.raw.get(target)!),
    count: async type => [...source.parsed.values()].filter(r => r.resourceType === type).length });
  const packet = jsonBytes({ schema: 'fireboat-quickstart-setup/1', runId, creationNonce, receiptSha256: receipt.attemptSha256, manifestSha256: receipt.manifestSha256,
    instanceSha256: sha256(jsonBytes(instance)), resources: observations });
  await atomicPrivateWrite(join(run, 'attempt.json'), attempt);
  await atomicPrivateWrite(join(run, 'setup-packet.json'), packet);
  await atomicPrivateWrite(join(run, 'receipt.json'), jsonBytes({ ...receipt, phase: 'complete', packetSha256: sha256(packet) }));
  return run;
}

test('quickstart verify end to end: the CLI, SDK client and observer pass all 18 task-arm runs against a seed-backed source', { timeout: 300_000 }, async t => {
  const source = await seededSource(); t.after(source.close);
  const directory = await mkdtemp(join(tmpdir(), 'qs-e2e-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const runDirectory = await preparedRun(directory, source), config = join(directory, 'gateway.config.json');
  await writeFile(config, JSON.stringify({ mode: 'synthetic', source: { alias: 'qs-e2e', baseUrl: source.baseUrl }, patientId: PATIENT }));
  const cli = join(root, 'packages/server/src/cli.ts');
  const doctor: DoctorRunner = launch => new Promise(resolve => execFile(launch.node, ['--import', 'tsx', launch.cli, '--doctor', '--config', launch.config],
    { cwd: root, env: { PATH: process.env.PATH ?? '' }, timeout: 60_000 }, (error, stdout) => resolve({ exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout })));
  const report = await verify({ runDirectory, node: process.execPath, cli, config, assets: ASSETS }, { doctor, target: source.baseUrl,
    openSession: launch => openGatewaySession({ argv: [launch.node, '--import', 'tsx', launch.cli, '--config', launch.config], era: launch.era, observe: launch.observe }) });
  const failing = report.runs.filter(r => r.status !== 'pass').map(r => `${r.era}/${r.task}/${r.arm}: ${r.failing.join(',')}`);
  assert.deepEqual(failing, [], 'every task-arm run passes');
  assert.ok(report.controls.every(c => c.status === 'pass'));
  assert.equal(report.controls.length, 2);
  assert.equal(report.runs.length, 18); assert.equal(report.passed, 18);
  const limitations = Object.fromEntries(report.runs.map(r => [r.task, r.limitations.join(',')]));
  assert.deepEqual(limitations, { 'package-latest-hba1c': 'FILTER_UNVERIFIED,LATEST_UNVERIFIED', 'package-status-sensitive': '', 'package-drain-reproject': 'CONTINUATION_UNVERIFIED,FILTER_UNVERIFIED' });
  assert.match(report.launch.gateway, /^fireboat \S+ schema=\S+ catalog=\S+$/);
  assert.equal(report.launch.cliSha256, sha256(await readFile(cli)));
  for (const name of ['verify-evidence.ndjson', 'verify-report.json', 'verify-gateway.config.json']) assert.equal((await stat(join(runDirectory, report.verificationId, name))).mode & 0o777, 0o600, name);
  assert.ok(source.requests.every(r => r.startsWith('GET /fhir')), 'reads only');
});
