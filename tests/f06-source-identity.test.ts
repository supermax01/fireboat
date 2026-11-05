import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { FhirGateway } from '../packages/core/src/index.js';
import { ProfileState, declaredSearchProfile, profileForSource, type CapabilitySourceIdentity, type SearchProfile } from '../packages/core/src/query.js';

import * as query from '../packages/core/src/query.js';

// Independent walk: own data descriptors, keys, symbols, Maps, Sets and byte buffers.
// No production policy/projection helper; no field allowlist and no getters invoked.
function strings(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  if (Buffer.isBuffer(value)) return [value.toString('utf8')];
  if (value instanceof Map) return [...value].flatMap(([k, v]) => [...strings(k, seen), ...strings(v, seen)]);
  if (value instanceof Set) return [...value].flatMap(v => strings(v, seen));
  return Reflect.ownKeys(value).flatMap(k => {
    const d = Object.getOwnPropertyDescriptor(value, k)!;
    return [String(k), ...('value' in d ? strings(d.value, seen) : [])];
  });
}

test('F-06: raw software name/version absent from all reachable state; identity changes revoke S2 handles', async t => {
  const canary = 'F06ForeignName81-F06PrivateVersion92-F06HiddenToken73';
  let software = { name: canary, version: `version-${canary}` };
  let baseUrl = '';
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/fhir+json');
    if (req.url === '/fhir/metadata') res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', software,
      rest: [{ mode: 'server', resource: [{ type: 'Observation', interaction: [{ code: 'search-type' }], searchParam: [{ name: 'patient', type: 'reference' }] }] }] }));
    else res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: new URL(req.url!, baseUrl).href }], entry: [{ resource: { resourceType: 'Observation', id: 'obs-a', status: 'final', code: { text: 'Synthetic' }, subject: { reference: 'Patient/synthetic-a' } }, search: { mode: 'match' } }] }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/fhir/`;
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'f06', baseUrl }, patientId: 'synthetic-a' });
  t.after(async () => { gateway.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const state = gateway as unknown as { sourceIdentity: CapabilitySourceIdentity; metadataExpiresAt: number; stateGeneration: number };
  const clean = () => {
    const captured = strings(gateway);
    for (const segment of canary.split('-')) assert.ok(!captured.some(s => s.includes(segment)), 'raw source canary absent from every reachable field');
    assert.ok(captured.includes('Observation'), 'state scan positive control');
  };
  const discover = () => gateway.execute('fhir_capabilities', { topic: 'server' });
  assert.equal((await discover()).error, undefined); clean();
  for (const field of ['name', 'version'] as const) {
    const held = await gateway.execute('fhir_search', { resource_type: 'Observation' });
    assert.equal(held.error, undefined); assert.ok(held.result?.handle);
    state.metadataExpiresAt = 0;
    assert.equal((await discover()).error, undefined);
    assert.equal((await gateway.execute('fhir_result', { handle: held.result.handle })).error, undefined, 'equal digests preserve state');
    const generation = state.stateGeneration;
    software = { ...software, [field]: `${software[field]}-changed` };
    state.metadataExpiresAt = 0;
    assert.equal((await discover()).error, undefined);
    assert.ok(state.stateGeneration > generation, 'identity-only change invalidates S2 generation');
    assert.equal((await gateway.execute('fhir_result', { handle: held.result.handle })).error?.code, 'RESULT_EXPIRED'); clean();
  }
});

test('F-06: source-bound profile matching compares keyed digests and refuses either mismatch', () => {
  const profile: SearchProfile = { ...declaredSearchProfile('synthetic-fixture-r4-v1')!, source: { software: 'trusted-fixture', software_version: '1.0', fhir_version: '4.0.1' } };
  const state = new ProfileState();
  (state as unknown as { setCandidateForTest(p: SearchProfile, privateCandidate: boolean): void }).setCandidateForTest(profile, true);
  // S6: the shipped profile binds the capability revision it was proved on; the identity carries it, and a
  // different or missing revision is refused like any other keyed mismatch.
  const identity: CapabilitySourceIdentity = { digested: true, software: query.sourceIdentityDigest('trusted-fixture'), softwareVersion: query.sourceIdentityDigest('1.0'), fhirVersion: '4.0.1', revision: profile.evidence!.capability_revision! };
  assert.ok(state.profile(profile.id, identity));
  for (const changed of [{ software: query.sourceIdentityDigest('unequal') }, { softwareVersion: query.sourceIdentityDigest('2.0') }, { fhirVersion: '5.0.0' }, { revision: 'other-revision' }, { revision: undefined }]) assert.equal(state.profile(profile.id, { ...identity, ...changed }), undefined);
  assert.ok(profileForSource('generic-r4', identity));
  assert.equal(profileForSource('generic-r4', { ...identity, fhirVersion: '5.0.0' }), undefined);
  state.invalidate(profile.id); assert.equal(state.profile(profile.id, identity), undefined);
});
