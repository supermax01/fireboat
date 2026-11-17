import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { resolveSearchParameters, validateSearchAdmission } from '../packages/core/src/search-parameters.js';
import type { GatewayEnvelope } from '../packages/core/src/index.js';
import catalog from '../packages/core/src/generated/r4-search-parameters.json' with { type: 'json' };

const mrn = 'urn:synthetic:audit:mrn', directory = 'urn:synthetic:audit:directory';
const types = ['Practitioner', 'Organization', 'Location', 'Medication', 'CodeSystem', 'ValueSet'];
const declarations = (type: string) => catalog.definitions.filter(d => d.base.includes(type)).map(d => ({ name: d.code, type: d.type, source_description_present: false }));
const refused: [string, string, string][] = [
  ...types.flatMap(type => ['guess', '|guess', mrn + '|guess', mrn + '|', directory + '|', 'relative|guess',
    directory + '|safe,' + mrn + '|guess', directory + '|safe,guess', directory + '|safe,|guess']
    .map(value => [type, 'identifier', value] as [string, string, string])),
  ['Organization', 'name', 'masked'], ['Location', 'name', 'masked'],
  ...['CodeSystem', 'ValueSet'].flatMap(type => ['title', 'description', 'publisher'].map(name => [type, name, 'masked'] as [string, string, string])),
  ['Medication', 'lot-number', 'masked'],
  // A shared Medication delivers identifiers only in operator-listed product systems
  // (privacy.sharedIdentifierSystems, empty here), so an identifier predicate over any other system is refused.
  ['Medication', 'identifier', directory + '|safe'],
];
// Shared-directory reachability: a Practitioner, Organization or Location search is `_id` alone on reachable ids, so each
// of these directory predicates is refused before sending, alone as well as beside `_id`.
const directoryRefused: [string, string, string][] = [
  ...['Practitioner', 'Organization', 'Location'].map(type => [type, 'identifier', directory + '|safe'] as [string, string, string]),
  ['Practitioner', 'name', 'Synthetic'], ['Organization', 'phonetic', 'Synthetic'], ['Location', 'status', 'active'],
  ['Practitioner', 'identifier', directory + '|safe\\,code,' + directory + '|safe\\|code'],
];
const allowed: [string, string, string][] = [
  ...['CodeSystem', 'ValueSet'].map(type => [type, 'identifier', directory + '|safe'] as [string, string, string]),
  ['Medication', 'code', 'urn:synthetic:drug|safe'],
  ['CodeSystem', 'name', 'Synthetic'], ['ValueSet', 'name', 'Synthetic'],
];

test('F-02 admission: every alternative and every pinned expression path must survive shared egress', () => {
  for (const [resourceType, name, value] of refused) {
    const resolved = resolveSearchParameters({ resourceType, declared: declarations(resourceType), advertised: true });
    assert.throws(() => validateSearchAdmission({ resourceType, resolved, pairs: [{ name, value }], patientId: 'synthetic-a', privacy: { patientIdentifierSystems: [mrn] } }),
      { code: 'POLICY_DENIED' }, resourceType + ' ' + name + ' ' + value);
  }
  for (const [resourceType, name, value] of allowed) {
    const resolved = resolveSearchParameters({ resourceType, declared: declarations(resourceType), advertised: true });
    assert.doesNotThrow(() => validateSearchAdmission({ resourceType, resolved, pairs: [{ name, value }], patientId: 'synthetic-a', privacy: { patientIdentifierSystems: [mrn] } }));
  }
  for (const [resourceType, name, value] of directoryRefused) {
    const resolved = resolveSearchParameters({ resourceType, declared: declarations(resourceType), advertised: true });
    for (const pairs of [[{ name, value }], [{ name: '_id', value: 'synthetic-directory' }, { name, value }]]) {
      assert.throws(() => validateSearchAdmission({ resourceType, resolved, pairs, patientId: 'synthetic-a', privacy: { patientIdentifierSystems: [mrn] }, reachable: () => true }),
        { code: 'POLICY_DENIED' }, resourceType + ' ' + JSON.stringify(pairs));
    }
  }
  // Once the operator lists a product system, Medication identifier predicates in that system are admitted, and only those.
  const medication = resolveSearchParameters({ resourceType: 'Medication', declared: declarations('Medication'), advertised: true });
  const listed = { patientIdentifierSystems: [mrn], sharedIdentifierSystems: [directory] };
  assert.doesNotThrow(() => validateSearchAdmission({ resourceType: 'Medication', resolved: medication, pairs: [{ name: 'identifier', value: directory + '|safe' }], patientId: 'synthetic-a', privacy: listed }));
  for (const value of [directory + '|safe,urn:synthetic:audit:other|x', 'urn:synthetic:audit:other|x', mrn + '|guess', '|safe', 'safe']) {
    assert.throws(() => validateSearchAdmission({ resourceType: 'Medication', resolved: medication, pairs: [{ name: 'identifier', value }], patientId: 'synthetic-a', privacy: listed }), { code: 'POLICY_DENIED' }, value);
  }
  const escapedSystem = mrn + '|segment';
  const practitioner = resolveSearchParameters({ resourceType: 'Practitioner', declared: declarations('Practitioner'), advertised: true });
  assert.throws(() => validateSearchAdmission({ resourceType: 'Practitioner', resolved: practitioner, pairs: [{ name: 'identifier', value: mrn + '\\|segment|guess' }],
    patientId: 'synthetic-a', privacy: { patientIdentifierSystems: [escapedSystem] } }), { code: 'POLICY_DENIED' });
  const resourceType = 'Organization', resolved = resolveSearchParameters({ resourceType, declared: declarations(resourceType), advertised: true });
  for (const sort of ['name', '-identifier']) assert.throws(() => validateSearchAdmission({ resourceType, resolved, pairs: [], patientId: 'synthetic-a', sort: [sort] }), { code: 'POLICY_DENIED' });
});

for (const era of ['modern', 'legacy'] as const) test('F-02 stdio ' + era + ': withheld predicates never reach the source; catalog shared searches remain source-wide, directory predicates never send', async t => {
  const requests: URL[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1'); requests.push(url);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname.endsWith('/metadata')) {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server',
        resource: types.map(type => ({ type, interaction: [{ code: 'search-type' }], searchParam: declarations(type) })) }] }));
    } else res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: req.url }], entry: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const dir = await mkdtemp(join(tmpdir(), 'f02-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ mode: 'synthetic', source: { alias: 'audit', baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/fhir/' },
    patientId: 'synthetic-a', privacy: { patientIdentifierSystems: [mrn] } }));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'packages/server/src/cli.ts', '--config', config],
    env: { ...getDefaultEnvironment(), TMPDIR: tmpdir() }, stderr: 'pipe' });
  const client = new Client({ name: 'audit-f02', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  await client.connect(transport);
  t.after(() => client.close());
  const clinical = () => requests.filter(url => !url.pathname.endsWith('/metadata'));
  const search = async (type: string, params: { name: string; value: string }[]) => {
    const result = await client.callTool({ name: 'fhir_search', arguments: { resource_type: type, params, output: { format: 'fhir', max_bytes: 24576 } } });
    return result.structuredContent as GatewayEnvelope;
  };
  for (const [type, name, value] of refused) {
    const before = clinical().length;
    const result = await search(type, [{ name: '_id', value: 'synthetic-directory' }, { name, value }]);
    assert.equal(result.error?.code, 'POLICY_DENIED', type + ' ' + name + ' ' + value);
    assert.equal(clinical().length, before);
  }
  for (const value of ['name', '-identifier']) {
    const before = clinical().length;
    assert.equal((await search('Organization', [{ name: '_sort', value }])).error?.code, 'POLICY_DENIED');
    assert.equal(clinical().length, before);
  }
  // The directory predicates are refused alone, before sending.
  for (const [type, name, value] of directoryRefused) {
    const before = clinical().length;
    assert.equal((await search(type, [{ name, value }])).error?.code, 'POLICY_DENIED', type + ' ' + name + ' ' + value);
    assert.equal(clinical().length, before);
  }
  for (const [type, name, value] of allowed) {
    const before = clinical().length, result = await search(type, [{ name, value }]);
    assert.equal(result.error, undefined, type + ' ' + name);
    assert.equal(clinical().length, before + 1);
    assert.equal(clinical().at(-1)!.searchParams.get(name), value);
    assert.equal(clinical().at(-1)!.searchParams.has('patient'), false);
    assert.equal(clinical().at(-1)!.searchParams.has('subject'), false);
  }
});
