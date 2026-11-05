import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPrepare } from '../examples/quickstart/guards.js';
import type { FreshState } from '../examples/quickstart/guards.js';
import { ownershipLabels } from '../examples/quickstart/instance.js';
import type { InstanceEvidence, InstanceReceipt } from '../examples/quickstart/instance.js';
import { GENERATOR_PINS, pinsSha256, QUICKSTART_TARGET, sha256, validateSeedManifest } from '../examples/quickstart/manifest.js';


import { cleanupPlan, down } from '../examples/quickstart/down.js';
import type { CleanupAction } from '../examples/quickstart/down.js';

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

test('quickstart down: foreign container volume project and missing provenance cause zero cleanup', async () => {
  const f = fixture();
  const bad = [
    { ...f.evidence, containerId: 'e'.repeat(64) }, { ...f.evidence, project: 'root-project' },
    { ...f.evidence, labels: {} }, { ...f.evidence, creationNonce: 'e'.repeat(64) },
    { ...f.evidence, volumes: [{ ...f.evidence.volumes[0]!, name: 'foreign-volume' }] },
    { ...f.evidence, volumes: [{ ...f.evidence.volumes[0]!, identitySha256: 'e'.repeat(64) }] },
    { ...f.evidence, volumes: [{ ...f.evidence.volumes[0]!, createdAt: '2026-01-02T00:00:00.000Z' }] },
    { ...f.evidence, publishedPorts: [{ ...f.evidence.publishedPorts[0]!, hostPort: 18091 }] }
  ];
  for (const inspected of bad) {
    const actions: CleanupAction[] = [];
    await assert.rejects(down(f.manifest, f.receipt, { inspect: async () => inspected, execute: async action => { actions.push(action); } }, true), { code: 'CLEANUP_FOREIGN' });
    assert.deepEqual(actions, []);
  }
});
test('quickstart down: valid owned cleanup retains volumes by default and explicit volumes are receipt-bound', async () => {
  const f = fixture();
  const basic = cleanupPlan(f.receipt, f.evidence, f.manifest);
  assert.deepEqual(basic, [ { kind: 'stop-container', containerId: f.receipt.containerId }, { kind: 'remove-container', containerId: f.receipt.containerId },
    { kind: 'remove-network', project: f.receipt.project } ]);
  const actions: CleanupAction[] = [];
  const result = await down(f.manifest, f.receipt, { inspect: async () => f.evidence, execute: async action => { actions.push(action); } }, true);
  assert.equal(result.actions, 4); assert.deepEqual(actions.slice(0, 3), basic);
  assert.deepEqual(actions[3], { kind: 'remove-volume', name: f.receipt.volumes[0]!.name, identitySha256: f.receipt.volumes[0]!.identitySha256 });
});
test('quickstart down: inspection and executor errors become fixed faults', async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(down(f.manifest, f.receipt, { inspect: async () => { throw new Error('secret path'); }, execute: async () => { calls++; } }), { code: 'CLEANUP_FOREIGN', message: 'CLEANUP_FOREIGN' });
  assert.equal(calls, 0);
  await assert.rejects(down(f.manifest, f.receipt, { inspect: async () => f.evidence, execute: async () => { throw new Error('secret path'); } }), { code: 'CLEANUP_FAILED', message: 'CLEANUP_FAILED' });
});
