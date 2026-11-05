import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { FhirGateway, type GatewayConfig } from '../packages/core/src/index.js';
import { ProfileState, assertSearchProfileRegistry, declaredSearchProfile, eligibleSearchProfileIds, searchProfile, type SearchProfile } from '../packages/core/src/query.js';
import { EVAL_PATIENT_ID, EVAL_SOURCE_ALIAS, canonicalJson, fixtureSha256, parseM3bFixtureFragment, parseM3bTaskFile, startEvalFixtureServer } from '../packages/evals/src/index.js';
import { fixtureBackendSha256, loadEvalCorpus } from '../packages/evals/src/fixture.js';
import { profileDrift, queryFragmentResources } from '../packages/evals/src/runner.js';
import { assertIneligibleCatalogueSelectionRefused } from './search-profile-catalogue-helper.js';

// S6: the synthetic fixture profile is qualified through the non-circular order (independent vectors, labelled
// private candidate, frozen evidence, eligibility, ordinary public selection). These tests pin the binding chain
// that keeps that proof honest: evidence hashes, the capability-revision binding and the derived config enum.

const PROFILE = 'synthetic-fixture-r4-v1';
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('S6 the qualified public profile records evidence bound to the exact fixture, backend, task corpus and capability revision', async () => {
  const profile = declaredSearchProfile(PROFILE)!;
  assert.equal(profile.eligible, true);
  assert.ok(searchProfile(PROFILE), 'the evidenced profile resolves to proof');
  assert.deepEqual(eligibleSearchProfileIds(), ['generic-r4', 'hapi-r4-labs-v1', PROFILE]);
  const evidence = profile.evidence!;
  assert.match(evidence.report_sha256, /^[a-f0-9]{64}$/);
  assert.ok(!Number.isNaN(Date.parse(evidence.recorded_at)));
  const fragment = parseM3bFixtureFragment(read('../packages/evals/fixtures/m3b-query/fragment.json'));
  assert.deepEqual(queryFragmentResources(), fragment.resources, 'the runner digests exactly the fragment resources the registry pins');
  assert.equal(profile.source.fixture_sha256, fixtureSha256(undefined, undefined, undefined, fragment.resources), 'fixture drift invalidates the recorded proof: re-qualify');
  assert.equal(profile.source.backend_sha256, fixtureBackendSha256(), 'backend drift invalidates the recorded proof: re-qualify');
  assert.equal(evidence.tasks_sha256, createHash('sha256').update(canonicalJson(parseM3bTaskFile(read('../packages/evals/data/m3b-query-tasks.json')))).digest('hex'), 'task corpus drift invalidates the recorded proof: re-qualify');
  const corpus = loadEvalCorpus();
  const fixture = await startEvalFixtureServer(corpus.resources, corpus.rawBodies);
  try {
    const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: EVAL_SOURCE_ALIAS, baseUrl: fixture.baseUrl, searchProfile: PROFILE }, patientId: EVAL_PATIENT_ID, contextId: 'eval-context-v0' } as GatewayConfig);
    const metadata = await gateway.execute('fhir_capabilities', { topic: 'server' });
    assert.equal(metadata.error, undefined);
    assert.equal(evidence.capability_revision, metadata.source.capability_revision, 'the proof is bound to the capability revision the fixture serves');
  } finally { await fixture.close(); }
});

test('S6 the eval runner refuses a qualified profile whose recorded fixture or backend digest drifted from what it serves', () => {
  const profile = declaredSearchProfile(PROFILE)!;
  assert.equal(profileDrift(profile), undefined, 'the recorded digests match the served fixture and executing backend');
  assert.match(profileDrift({ ...profile, source: { ...profile.source, fixture_sha256: '0'.repeat(64) } }) ?? '', /fixture_sha256/);
  assert.match(profileDrift({ ...profile, source: { ...profile.source, backend_sha256: '0'.repeat(64) } }) ?? '', /backend_sha256/);
  assert.match(profileDrift({ ...profile, source: { software: profile.source.software, fhir_version: profile.source.fhir_version } }) ?? '', /unset/);
  assert.match(profileDrift({ ...profile, evidence: { ...profile.evidence!, tasks_sha256: '0'.repeat(64) } }) ?? '', /tasks_sha256/, 'task-corpus drift is refused too');
});

test('S6 a shipped eligible profile that claims proof must record its capability revision (registry invariant)', () => {
  const profile = declaredSearchProfile(PROFILE)!;
  assert.doesNotThrow(() => assertSearchProfileRegistry([profile, declaredSearchProfile('generic-r4')!, declaredSearchProfile('hapi-r4-labs-v1')!]));
  assert.throws(() => assertSearchProfileRegistry([{ ...profile, evidence: { report_sha256: profile.evidence!.report_sha256, recorded_at: profile.evidence!.recorded_at } }]), /capability revision/);
  assert.doesNotThrow(() => assertSearchProfileRegistry([{ ...profile, eligible: false, evidence: null }]), 'an ineligible declaration records nothing');
});

test('S6 against a source whose capability contract differs from the qualified one, the public profile proves nothing and the doctor status says so', async () => {
  const corpus = loadEvalCorpus();
  const fixture = await startEvalFixtureServer(corpus.resources, corpus.rawBodies);
  try {
    const config = { mode: 'synthetic', source: { alias: EVAL_SOURCE_ALIAS, baseUrl: fixture.baseUrl, searchProfile: PROFILE }, patientId: EVAL_PATIENT_ID, contextId: 'eval-context-v0' } as GatewayConfig;
    const params = [{ name: 'code', value: 'http://loinc.org|4548-4' }, { name: 'date', value: 'ge2020-01-01' }, { name: '_sort', value: '-date' }];
    const bound = new FhirGateway(config);
    const proved = await bound.execute('fhir_search', { resource_type: 'Observation', params, output: { format: 'fhir' } });
    assert.equal(proved.error, undefined);
    assert.equal(proved.coverage.query_evidence, 'tested_adapter');
    assert.deepEqual(bound.describeSearchProfile(), { id: PROFILE, eligible: true, proving: true, private: false });
    fixture.setMode('wide-capability');
    const drifted = new FhirGateway(config);
    const unproved = await drifted.execute('fhir_search', { resource_type: 'Observation', params, output: { format: 'fhir' } });
    assert.equal(unproved.error, undefined);
    assert.equal(unproved.coverage.query_evidence, 'declared_and_self_link_only', 'a different capability revision binds to no proof');
    assert.ok(unproved.coverage.constraints!.filter(c => c.name !== 'patient').every(c => c.execution === 'unknown'));
    assert.ok(unproved.coverage.reasons.includes('FILTER_EXECUTION_UNVERIFIED'));
    assert.deepEqual(drifted.describeSearchProfile(), { id: PROFILE, eligible: true, proving: false, private: false });
  } finally { await fixture.close(); }
});

test('S6 a recorded capability revision binds the profile to the discovered source; another revision is no proof', () => {
  const base: SearchProfile = { ...declaredSearchProfile(PROFILE)!, id: 'private-s6-binding', eligible: false,
    source: { software: 's6 binding fixture', fhir_version: '4.0.1' },
    evidence: { report_sha256: 'f'.repeat(64), recorded_at: '2026-01-01T00:00:00.000Z', capability_revision: 'rev-a' } };
  const state = new ProfileState();
  (state as unknown as { setCandidateForTest(profile: SearchProfile, privateCandidate: boolean): void }).setCandidateForTest(base, true);
  const capability = { software: 's6 binding fixture', fhirVersion: '4.0.1' };
  assert.ok(state.profile(base.id, { ...capability, revision: 'rev-a' }), 'matching revision proves');
  assert.equal(state.profile(base.id, { ...capability, revision: 'rev-b' }), undefined, 'a different capability revision is no proof');
  assert.equal(state.profile(base.id, capability), undefined, 'a recorded revision fails closed when the discovered identity carries none (review finding 6)');
  const unbound = { ...base, evidence: { report_sha256: 'f'.repeat(64), recorded_at: '2026-01-01T00:00:00.000Z' } };
  const unboundState = new ProfileState();
  (unboundState as unknown as { setCandidateForTest(profile: SearchProfile, privateCandidate: boolean): void }).setCandidateForTest(unbound, true);
  assert.ok(unboundState.profile(unbound.id, { ...capability, revision: 'rev-b' }), 'a private candidate without a recorded revision is not revision-bound');
});

test('S6 the config enum is derived from eligibility: qualified profiles construct, ineligible ones are INVALID_CONFIG', () => {
  const config = (searchProfile: string): GatewayConfig => ({ mode: 'synthetic', source: { alias: 'local', baseUrl: 'http://127.0.0.1:9/fhir', searchProfile }, patientId: 'synthetic-p', contextId: 'ctx-s6' } as GatewayConfig);
  assert.doesNotThrow(() => new FhirGateway(config('generic-r4')));
  assert.doesNotThrow(() => new FhirGateway(config(PROFILE)));
  assert.doesNotThrow(() => new FhirGateway(config('hapi-r4-labs-v1')));
  for (const id of ['private-s6-binding', 'synthetic-fixture-r4-v2']) assert.throws(() => new FhirGateway(config(id)), { code: 'INVALID_CONFIG' }, id);
  assertIneligibleCatalogueSelectionRefused();
});
