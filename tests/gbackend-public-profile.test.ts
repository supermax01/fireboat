import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { FhirGateway, type GatewayEnvelope } from '../packages/core/src/index.js';
import { ProfileState, buildQueryEvidence, profileForSource, sourceIdentityDigest, type CapabilitySourceIdentity, type SearchProfile } from '../packages/core/src/query.js';
import { EVAL_PATIENT_ID, loadEvalCorpus, startEvalFixtureServer } from '../packages/evals/src/fixture.js';
import { HAPI_BASE_URL } from '../packages/evals/src/external.js';
import { HAPI_PROFILE, HAPI_RECORDED_EVIDENCE, HAPI_WINDOW_PARAMS, hapiIntegrationBaseUrl, publicHapiConfig } from './gbackend-profile-helpers.js';
import { withSdk } from './s57-sdk-helpers.js';

function assertPublicFallback(gateway: FhirGateway, envelope: GatewayEnvelope): void {
  assert.equal(envelope.error, undefined);
  assert.equal(envelope.coverage.query_evidence, 'declared_and_self_link_only');
  assert.notEqual(envelope.coverage.state, 'complete_for_query');
  assert.deepEqual(envelope.coverage.constraints!.filter(pair => pair.name === 'code' || pair.name === 'date'),
    HAPI_WINDOW_PARAMS.map(pair => ({ ...pair, source_reported: 'matched', execution: 'unknown', evidence_ref: undefined })));
  assert.ok(!envelope.coverage.constraints!.some(pair => pair.execution === 'tested_adapter'));
  assert.ok(envelope.coverage.reasons.includes('FILTER_EXECUTION_UNVERIFIED'));
  assert.ok(!envelope.warnings.some(warning => warning.code === 'TEST_QUERY_EVIDENCE'));
  assert.deepEqual(gateway.describeSearchProfile(), { id: HAPI_PROFILE, eligible: true, proving: false, private: false });
}

for (const era of ['modern', 'legacy'] as const) test(`G-BACKEND public HAPI selection against the real synthetic fixture falls back without a private override (${era})`, async () => {
  const corpus = loadEvalCorpus();
  const fixture = await startEvalFixtureServer(corpus.resources, corpus.rawBodies);
  const gateway = new FhirGateway(publicHapiConfig(fixture.baseUrl));
  try {
    await withSdk(gateway, era, async sdk => {
      const { e } = await sdk.call('fhir_search', { resource_type: 'Observation', params: [...HAPI_WINDOW_PARAMS, { name: '_sort', value: '-date' }], output: { format: 'fhir' } });
      assert.notEqual(e.source.capability_revision, HAPI_RECORDED_EVIDENCE.capability_revision);
      assertPublicFallback(gateway, e as GatewayEnvelope);
      assert.deepEqual(e.coverage.sort, { requested: ['-date'], effective: null, evidence: 'unknown', order: 'requested_unverified' });
    });
  } finally { gateway.close(); await fixture.close(); }
});

test('G-BACKEND public HAPI selection refuses a genuinely different capability revision with matching software name and version', async () => {
  const resources = loadEvalCorpus().resources.filter(resource => ['obs-hba1c-1', 'q-match'].includes(resource.id));
  const requests: URL[] = [];
  let baseUrl = '';
  // This is a synthetic HTTP source advertising HAPI's identity, not captured HAPI metadata.
  // Its smaller capability contract has its own real computed revision; no revision is overridden.
  const source = createServer((req, res) => {
    const url = new URL(req.url!, baseUrl);
    requests.push(url);
    res.setHeader('content-type', 'application/fhir+json');
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (url.pathname === '/fhir/metadata') {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', software: { name: 'HAPI FHIR Server', version: '8.12.0' },
        rest: [{ mode: 'server', resource: [{ type: 'Observation', interaction: [{ code: 'search-type' }], searchParam: [
          { name: 'patient', type: 'reference' }, { name: 'code', type: 'token' }, { name: 'date', type: 'date' },
        ] }] }] }));
    } else if (url.pathname === '/fhir/Observation') {
      res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }],
        entry: resources.map(resource => ({ search: { mode: 'match' }, resource })) }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(source.address() as { port: number }).port}/fhir`;
  const gateway = new FhirGateway(publicHapiConfig(baseUrl));
  try {
    const envelope = await gateway.execute('fhir_search', { resource_type: 'Observation', params: HAPI_WINDOW_PARAMS, output: { format: 'fhir' } });
    assert.equal(envelope.source.fhir_version, '4.0.1');
    assert.notEqual(envelope.source.capability_revision, 'unknown');
    assert.notEqual(envelope.source.capability_revision, HAPI_RECORDED_EVIDENCE.capability_revision);
    assertPublicFallback(gateway, envelope);
    assert.deepEqual(requests.map(url => url.pathname), ['/fhir/metadata', '/fhir/Observation']);
  } finally {
    gateway.close(); source.closeAllConnections();
    await new Promise<void>(resolve => source.close(() => resolve()));
  }
});

test('G-BACKEND public HAPI binding independently refuses each missing or mismatched software version FHIR and revision', () => {
  const state = new ProfileState(); // Ordinary public lookup: no candidate is installed.
  const matching: CapabilitySourceIdentity = { digested: true, software: sourceIdentityDigest('HAPI FHIR Server'), softwareVersion: sourceIdentityDigest('8.12.0'), fhirVersion: '4.0.1', revision: HAPI_RECORDED_EVIDENCE.capability_revision };
  const pairs = [...HAPI_WINDOW_PARAMS, { name: 'patient', value: `Patient/${EVAL_PATIENT_ID}` }];
  const evidence = (profile: SearchProfile | undefined) => buildQueryEvidence({ resourceType: 'Observation', pairs, selfPairs: pairs, profile, gatewayEnforcedIndices: new Set([3]),
    sourceRevision: matching.revision!, policyRevision: 'synthetic-v2', contextHandle: 'gbackend-public-binding' });
  const selected = state.profile(HAPI_PROFILE, matching);
  assert.ok(selected, 'positive control uses the actual eligible registry entry');
  assert.ok(profileForSource(HAPI_PROFILE, matching));
  assert.equal(evidence(selected).evidenceKind, 'tested_adapter');
  assert.deepEqual(evidence(selected).constraints.map(pair => pair.execution), ['tested_adapter', 'tested_adapter', 'tested_adapter', 'gateway_enforced']);
  for (const key of ['software', 'softwareVersion', 'fhirVersion', 'revision'] as const) {
    for (const value of [undefined, key === 'software' || key === 'softwareVersion' ? sourceIdentityDigest('different') : 'different']) {
      const changed = { ...matching, [key]: value };
      assert.equal(state.profile(HAPI_PROFILE, changed), undefined, `${key}: ${value === undefined ? 'missing' : 'mismatched'}`);
      assert.equal(profileForSource(HAPI_PROFILE, changed), undefined, `stateless ${key} binding`);
      const unproved = evidence(state.profile(HAPI_PROFILE, changed));
      assert.equal(unproved.evidenceKind, 'declared_and_self_link_only');
      assert.deepEqual(unproved.constraints.map(pair => pair.execution), ['unknown', 'unknown', 'unknown', 'gateway_enforced']);
    }
  }
  assert.ok(state.profile(HAPI_PROFILE, matching), 'negative bindings do not mutate the qualified profile');
});

test('G-BACKEND opt-in public integration accepts only the exact approved literal-loopback URL before network setup', () => {
  assert.equal(hapiIntegrationBaseUrl(undefined), undefined);
  assert.equal(hapiIntegrationBaseUrl(HAPI_BASE_URL), HAPI_BASE_URL);
  for (const value of ['', 'http://localhost:18091/fhir', 'http://example.invalid/fhir', 'http://169.254.169.254/fhir', 'http://127.0.0.1:18092/fhir',
    'https://127.0.0.1:18091/fhir', 'http://127.0.0.1:18091/other', 'http://user:secret@127.0.0.1:18091/fhir', `${HAPI_BASE_URL}/`, `${HAPI_BASE_URL}?x=1`, `${HAPI_BASE_URL}#fragment`, ` ${HAPI_BASE_URL}`]) {
    assert.throws(() => hapiIntegrationBaseUrl(value), /must equal http:\/\/127\.0\.0\.1:18091\/fhir exactly/);
  }
});
