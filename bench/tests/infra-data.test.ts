// Infra and data units: compose/config pins, dependency plan, Synthea rewriting, canonical form, recording proxy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { parseLossless, stringifyLossless } from '../lib/json.js';
import { slotPorts, tmpDir } from '../lib/paths.js';
import { COMPOSE_FILE, HAPI_APPLICATION_YAML, HAPI_SETTINGS, IMAGES, JVM_OPTIONS, POSTGRES_ARGS } from '../infra/pins.js';
import { startRecordingProxy } from '../infra/proxy.js';
import { literalRefs, patientLink, type Obj } from '../data/fhir.js';
import { canonical, withoutServerMeta } from '../data/hapi.js';
import { DependencyGraph } from '../data/plan.js';
import { newRewriteStats, rewriteSyntheaReferences } from '../data/synthea.js';

test('compose.yaml and hapi/application.yaml mirror pins.ts', () => {
  const compose = readFileSync(COMPOSE_FILE, 'utf8');
  for (const ref of Object.values(IMAGES)) assert.ok(compose.includes(`image: ${ref}`), ref);
  assert.ok(compose.includes('"127.0.0.1:18190:8080"'));
  assert.equal((compose.match(/^\s+ports:/gm) ?? []).length, 1, 'only HAPI publishes a port');
  assert.ok(compose.includes(`JAVA_TOOL_OPTIONS: "${JVM_OPTIONS}"`));
  assert.ok(compose.includes(JSON.stringify(['postgres', ...POSTGRES_ARGS]).replace(/","/g, '", "')));
  assert.doesNotMatch(compose, /\b(8080|18080|18091):/);
  const yaml = readFileSync(HAPI_APPLICATION_YAML, 'utf8');
  for (const [key, value] of Object.entries(HAPI_SETTINGS)) {
    const m = /^hapi\.fhir\.(\w+)$/.exec(key);
    if (!m) continue;
    if (value === null) assert.doesNotMatch(yaml, new RegExp(`^\\s+${m[1]}:`, 'm'), `${key} must stay unset`);
    else assert.match(yaml, new RegExp(`^\\s+${m[1]}: ${String(value)}$`, 'm'), key);
  }
  assert.match(yaml, /dialect: ca\.uhn\.fhir\.jpa\.model\.dialect\.HapiFhirPostgresDialect/);
});

test('dependency plan: targets first, cycles grouped, dangling reported', () => {
  const g = new DependencyGraph();
  for (const k of ['Patient/p', 'Encounter/e1', 'Encounter/e2', 'Observation/a', 'Observation/b', 'Observation/c']) assert.ok(g.define(k));
  assert.equal(g.define('Patient/p'), false);
  g.addEdge('Encounter/e1', 'Patient/p');
  g.addEdge('Encounter/e2', 'Encounter/e1'); // partOf
  g.addEdge('Observation/a', 'Encounter/e2');
  g.addEdge('Observation/a', 'Observation/b'); // hasMember
  g.addEdge('Observation/b', 'Observation/a'); // derivedFrom: a cycle
  g.addEdge('Observation/c', 'Observation/a');
  g.addEdge('Observation/c', 'Observation/c'); // self-reference ignored
  g.addEdge('Observation/c', 'Specimen/missing');
  const { level, group, groupSizes } = g.plan();
  assert.deepEqual(Object.fromEntries(level), {
    'Patient/p': 0, 'Encounter/e1': 1, 'Encounter/e2': 2, 'Observation/a': 3, 'Observation/b': 3, 'Observation/c': 4,
  });
  assert.equal(group.get('Observation/a'), group.get('Observation/b'));
  assert.equal(group.has('Observation/c'), false);
  assert.deepEqual(groupSizes, [2]);
  assert.deepEqual([...g.dangling()], [['Specimen/missing', 1]]);
});

test('Synthea rewrite: urn:uuid to Type/id, unresolved conditional to logical, resolved conditional to Type/id', () => {
  const r = parseLossless(JSON.stringify({
    resourceType: 'Encounter', id: 'e',
    subject: { reference: 'urn:uuid:p1', display: 'P' },
    participant: [{ individual: { reference: 'Practitioner?identifier=http://hl7.org/fhir/sid/us-npi|999', display: 'Dr X' } }],
    serviceProvider: { reference: 'Organization?identifier=https://example.org/org|o1' },
    contained: [{ resourceType: 'Coverage', id: 'cov', beneficiary: { reference: 'urn:uuid:p1' } }],
    insurance: [{ coverage: { reference: '#cov' } }],
  })) as Obj;
  const stats = newRewriteStats();
  rewriteSyntheaReferences(r, {
    fullUrlType: new Map([['urn:uuid:p1', 'Patient']]),
    byIdentifier: new Map([['Organization|https://example.org/org|o1', 'org-1']]),
    where: 'test', stats,
  });
  assert.equal(stringifyLossless(r), JSON.stringify({
    resourceType: 'Encounter', id: 'e',
    subject: { reference: 'Patient/p1', display: 'P' },
    participant: [{ individual: { display: 'Dr X', type: 'Practitioner', identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: '999' } } }],
    serviceProvider: { reference: 'Organization/org-1' },
    contained: [{ resourceType: 'Coverage', id: 'cov', beneficiary: { reference: 'Patient/p1' } }],
    insurance: [{ coverage: { reference: '#cov' } }],
  }));
  assert.equal(stats.resolvedConditional, 1);
  assert.deepEqual([...stats.logical], [['Practitioner http://hl7.org/fhir/sid/us-npi', 1]]);
  assert.deepEqual(literalRefs(r), ['Patient/p1', 'Organization/org-1', 'Patient/p1']);
  assert.deepEqual(patientLink(r), { field: 'subject', patientId: 'p1' });
  assert.throws(() => rewriteSyntheaReferences(parseLossless('{"resourceType":"X","id":"x","a":{"reference":"urn:uuid:zz"}}') as Obj,
    { fullUrlType: new Map(), byIdentifier: new Map(), where: 't', stats: newRewriteStats() }), /unresolved/);
});

test('canonical form keeps lexemes, sorts keys and ignores server meta', () => {
  const file = parseLossless('{"resourceType":"Observation","id":"o","valueQuantity":{"value":12.3400,"unit":"mg"}}') as Obj;
  const served = parseLossless('{"meta":{"versionId":"3","lastUpdated":"2026-01-01T00:00:00Z"},"id":"o","resourceType":"Observation","valueQuantity":{"unit":"mg","value":12.3400}}') as Obj;
  assert.equal(canonical(withoutServerMeta(file)), canonical(withoutServerMeta(served)));
  const rounded = parseLossless('{"resourceType":"Observation","id":"o","valueQuantity":{"value":14,"unit":"mg"}}') as Obj;
  assert.notEqual(canonical(file), canonical(rounded));
  const profiled = parseLossless('{"resourceType":"X","id":"x","meta":{"profile":["p"],"versionId":"1"}}') as Obj;
  assert.equal(canonical(withoutServerMeta(profiled)), '{"id":"x","meta":{"profile":["p"]},"resourceType":"X"}');
});

test('recording proxy forwards reads with Host intact, blocks writes, logs decoded bytes', async () => {
  const seen: { method: string; url: string; host: string }[] = [];
  const body = JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry: Array.from({ length: 50 }, (_, i) => ({ fullUrl: `x${i}` })) });
  const upstream = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', host: req.headers.host ?? '' });
    req.resume();
    req.on('end', () => {
      if (req.headers['accept-encoding'] === 'gzip') {
        res.writeHead(200, { 'content-type': 'application/fhir+json', 'content-encoding': 'gzip' });
        res.end(gzipSync(body));
      } else {
        res.writeHead(200, { 'content-type': 'application/fhir+json' });
        res.end(body);
      }
    });
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  await mkdir(tmpDir('bench-tests'), { recursive: true });
  const dir = await mkdtemp(join(tmpDir('bench-tests'), 'proxy-'));
  const logPath = join(dir, 'proxy.jsonl');
  const slot = 7;
  const proxy = await startRecordingProxy({ slot, runId: 'r1', logPath, upstreamPort: (upstream.address() as AddressInfo).port });
  try {
    const base = `http://127.0.0.1:${slotPorts(slot).recordingProxy}/fhir`;
    const plain = await fetch(`${base}/Observation?code=a%7Cb`);
    assert.equal(await plain.text(), body);
    proxy.setRunId('r2');
    const gz = await rawGet(`${base}/Patient/p`, { 'accept-encoding': 'gzip' });
    assert.equal(gz.status, 200);
    const put = await fetch(`${base}/Patient/p`, { method: 'PUT', body: '{}' });
    assert.equal(put.status, 403);
    assert.match(await put.text(), /OperationOutcome/);
    const post = await fetch(`${base}/Observation/_search`, { method: 'POST', body: 'code=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(post.status, 200);
    await post.text();
    const del = await fetch(`${base}/Observation`, { method: 'DELETE' });
    assert.equal(del.status, 403);
    await del.text();
    assert.equal(proxy.nextSeq(), 5);
    assert.deepEqual(seen.map(s => [s.method, s.url]), [['GET', '/fhir/Observation?code=a%7Cb'], ['GET', '/fhir/Patient/p'], ['POST', '/fhir/Observation/_search']]);
    assert.ok(seen.every(s => s.host === `127.0.0.1:${slotPorts(slot).recordingProxy}`));
    await new Promise(r => setTimeout(r, 50));
    const log = (await readFile(logPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(log.map(l => [l.seq, l.run_id, l.method, l.status, l.blocked]).sort((a, b) => Number(a[0]) - Number(b[0])),
      [[0, 'r1', 'GET', 200, false], [1, 'r2', 'GET', 200, false], [2, 'r2', 'PUT', 403, true], [3, 'r2', 'POST', 200, false], [4, 'r2', 'DELETE', 403, true]]);
    const gzRec = log.find(l => l.seq === 1)!;
    assert.equal(gzRec.response_bytes_decoded, Buffer.byteLength(body));
    assert.equal(log.find(l => l.seq === 0)!.query, 'code=a%7Cb');
  } finally {
    await proxy.close();
    await new Promise<void>(r => upstream.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

function rawGet(url: string, headers: Record<string, string>): Promise<{ status: number; bytes: number }> {
  return new Promise((resolve, reject) => {
    request(url, { headers }, res => {
      let bytes = 0;
      res.on('data', (c: Buffer) => { bytes += c.length; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, bytes }));
    }).on('error', reject).end();
  });
}
