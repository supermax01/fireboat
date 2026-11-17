import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPrepare } from '../examples/quickstart/guards.js';
import type { FreshState } from '../examples/quickstart/guards.js';
import { ownershipLabels } from '../examples/quickstart/instance.js';
import type { InstanceEvidence, InstanceReceipt } from '../examples/quickstart/instance.js';
import { GENERATOR_PINS, pinsSha256, QUICKSTART_TARGET, sha256, validateSeedManifest } from '../examples/quickstart/manifest.js';

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

test('quickstart guards: exact target refusals perform zero writes', () => {
  const f = fixture(); let writes = 0;
  const targets = ['http://example.invalid:18080', 'http://localhost:18080', 'http://127.1:18080',
    'http://2130706433:18080', 'http://[::1]:18080', 'http://127.0.0.1:18090', 'http://127.0.0.1:18091',
    'http://user:secret@127.0.0.1:18080', 'https://127.0.0.1:18080', 'http://127.0.0.1:18080/',
    'http://127.0.0.1:18080?x=1', ' http://127.0.0.1:18080'].map(origin => ({ origin, basePath: '/fhir' }));
  targets.push(...['/other', '/fhir/', '/fhir/../fhir', '/fhir?x=1', '/%66hir'].map(basePath => ({ ...QUICKSTART_TARGET, basePath })));
  for (const target of targets) assert.throws(() => { assertPrepare(target, f.manifest, f.receipt, f.evidence, f.state); writes++; }, { code: 'TARGET_MISMATCH' });
  assert.equal(writes, 0);
});
test('quickstart guards: foreign ownership provenance labels and port association perform zero writes', () => {
  const f = fixture(); let writes = 0;
  const invalid = [
    { ...f.evidence, project: 'root-owned' }, { ...f.evidence, containerId: 'e'.repeat(64) },
    { ...f.evidence, runId: '0'.repeat(16) }, { ...f.evidence, creationNonce: '' },
    { ...f.evidence, createdAt: '2026-01-02T00:00:00.000Z' }, { ...f.evidence, composeSha256: '0'.repeat(64) },
    { ...f.evidence, labels: {} }, { ...f.evidence, service: 'other' }, { ...f.evidence, volumes: [] },
    ...['com.docker.compose.project', 'com.docker.compose.service', 'io.fireboat.quickstart.run', 'io.fireboat.quickstart.creation', 'io.fireboat.quickstart.compose']
      .map(key => ({ ...f.evidence, labels: { ...f.evidence.labels, [key]: 'foreign' } })),
    ...[{ hostPort: 18091 }, { hostIp: '0.0.0.0' }, { containerId: 'f'.repeat(64) }, { containerPort: 8081 }]
      .map(edit => ({ ...f.evidence, publishedPorts: [{ ...f.evidence.publishedPorts[0]!, ...edit }] }))
  ];
  for (const evidence of invalid) assert.throws(() => { assertPrepare(QUICKSTART_TARGET, f.manifest, f.receipt, evidence, f.state); writes++; }, { code: 'INSTANCE_FOREIGN' });
  assert.throws(() => assertPrepare(QUICKSTART_TARGET, f.manifest, { ...f.receipt, creationNonce: '' }, f.evidence, f.state), { code: 'INSTANCE_FOREIGN' });
  assert.equal(writes, 0);
});
test('quickstart guards: backend index child config software and FHIR mismatch perform zero writes', () => {
  const f = fixture(); let writes = 0;
  for (const key of Object.keys(f.manifest.backend)) {
    const evidence = { ...f.evidence, backend: { ...f.evidence.backend, [key]: 'mismatched' } } as InstanceEvidence;
    assert.throws(() => { assertPrepare(QUICKSTART_TARGET, f.manifest, f.receipt, evidence, f.state); writes++; }, { code: 'BACKEND_MISMATCH' });
  }
  assert.equal(writes, 0);
});
test('quickstart guards: every seeded type missing nonempty partial and reseed state refuses', () => {
  const f = fixture(); let writes = 0;
  for (const type of Object.keys(f.state.counts)) {
    for (const count of [1, -1, NaN, Infinity]) {
      assert.throws(() => { assertPrepare(QUICKSTART_TARGET, f.manifest, f.receipt, f.evidence,
        { ...f.state, counts: { ...f.state.counts, [type]: count } }); writes++; }, { code: 'TARGET_NOT_FRESH' });
    }
    const counts = { ...f.state.counts }; delete counts[type];
    assert.throws(() => assertPrepare(QUICKSTART_TARGET, f.manifest, f.receipt, f.evidence, { ...f.state, counts }), { code: 'TARGET_NOT_FRESH' });
  }
  for (const phase of ['seeding', 'partial', 'complete', 'unknown'] as const) {
    assert.throws(() => { assertPrepare(QUICKSTART_TARGET, f.manifest, f.receipt, f.evidence, { ...f.state, phase }); writes++; }, { code: 'TARGET_NOT_FRESH' });
  }
  for (const sentinel of [{ phase: 'complete', owned: true }, { phase: 'pre-seed', owned: false }])
    assert.throws(() => assertPrepare(QUICKSTART_TARGET, f.manifest, f.receipt, f.evidence, { ...f.state, sentinel } as FreshState), { code: 'TARGET_NOT_FRESH' });
  assert.equal(writes, 0);
});
test('quickstart guards: owned fresh instance and explicitly preseed sentinel pass', () => {
  const f = fixture(); let writes = 0;
  assertPrepare(QUICKSTART_TARGET, f.manifest, f.receipt, f.evidence, f.state); writes++;
  assertPrepare(QUICKSTART_TARGET, f.manifest, f.receipt, f.evidence, { ...f.state, sentinel: { phase: 'pre-seed', owned: true } }); writes++;
  assert.equal(writes, 2);
  assert.throws(() => assertPrepare(QUICKSTART_TARGET, f.manifest, f.receipt, f.evidence,
    { ...f.state, sentinel: { phase: 'pre-seed', owned: true }, counts: { ...f.state.counts, Organization: 1 } }), { code: 'TARGET_NOT_FRESH' });
});
