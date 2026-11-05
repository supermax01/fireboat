import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ExternalClient, HAPI_BASE_URL, HAPI_IMAGE_DIGEST, censusExternalCorpus, compareExternalResource, externalApplicability, externalCandidate, externalCapabilityRevisionMatches, externalCorpus, externalHash, externalTaskHash, externalTasks, externalTransport, immutableExternalBackend, loadExternalCorpus, selectExternalTasks, verifyExternalBackend, type ExternalCorpus, type ExternalIdentity } from '../packages/evals/src/external.js';
import { externalQualificationProblems } from '../packages/evals/src/external-qualification.js';
import { collectEvidence, evaluateCheck, profileDrift, runEvals, type EvalReport, type TaskArmResult } from '../packages/evals/src/runner.js';
import { ARM_ORDER, parseM3bTaskFile, TASKS } from '../packages/evals/src/tasks.js';
import { GOLDEN_RESOURCES, RAW_READ_BODIES, canonicalJson, type GoldenResource } from '../packages/evals/src/fixture.js';
import { ProfileState, assertSearchProfileRegistry, declaredSearchProfile, sourceIdentityDigest, type SearchProfile } from '../packages/core/src/query.js';
import type { HttpFetch } from '../packages/core/src/transport.js';
import { HAPI_RECORDED_EVIDENCE, assertHapiProfilePins } from './gbackend-profile-helpers.js';

const observation: GoldenResource = { resourceType: 'Observation', id: 'synthetic-a', status: 'final', code: { text: 'invented' }, subject: { reference: 'Patient/synthetic-a' }, valueQuantity: { value: 7 } };
const corpus = (resources = [observation]): ExternalCorpus => ({ resources, bodies: resources.map(resource => JSON.stringify(resource)), sha256: 'c'.repeat(64), types: [...new Set(resources.map(resource => resource.resourceType))], omitted: [], transformations: [] });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/fhir+json' } });
const identity: ExternalIdentity = { software: 'HAPI FHIR Server', software_version: '8.12.0', fhir_version: '4.0.1', image_digest: HAPI_IMAGE_DIGEST, capability_revision: 'abc0123456789def', corpus_sha256: 'c'.repeat(64), tasks_sha256: 't'.repeat(64).replaceAll('t', 'a') };
const profile = (): SearchProfile => ({ id: 'external-test', version: '1', eligible: true, source: { kind: 'external', software: identity.software, software_version: identity.software_version, fhir_version: identity.fhir_version, image_digest: identity.image_digest, corpus_sha256: identity.corpus_sha256 }, evidence: { report_sha256: 'f'.repeat(64), recorded_at: '2026-10-23T00:00:00Z', capability_revision: identity.capability_revision, tasks_sha256: identity.tasks_sha256 }, testIds: ['query-complete-proven'], testedFilters: [{ resource_type: 'Observation', parameter: 'code', variant: 'token-system-code' }], testedSorts: [], testedContinuations: [] });

test('G-BACKEND loopback confinement and redirects refuse before contacting an unsafe destination', async () => {
  for (const url of ['http://localhost:18091/fhir', 'http://example.invalid/fhir', 'http://169.254.169.254/fhir', 'file:///tmp/fhir', 'http://x:secret@127.0.0.1:18091/fhir', `${HAPI_BASE_URL}?x=1`, `${HAPI_BASE_URL}#x`]) assert.throws(() => externalTransport(url));
  assert.equal(externalTransport(HAPI_BASE_URL).base.hostname, '127.0.0.1');
  let calls = 0;
  const client = new ExternalClient(HAPI_BASE_URL, async () => { calls++; return new Response(JSON.stringify({ resourceType: 'CapabilityStatement' }), { status: 302, headers: { location: 'http://example.invalid/fhir', 'content-type': 'application/fhir+json' } }); });
  for (const url of ['http://example.invalid/fhir', 'http://127.0.0.1:9999/fhir', 'http://127.0.0.1:18091/other', '/fhir/%2Fother']) await assert.rejects(client.request(url));
  assert.equal(calls, 0);
  await assert.rejects(client.request(client.transport.url('metadata')), /redirect/);
  assert.equal(calls, 1);
});

test('G-BACKEND bounded client refuses oversized and malformed responses without payload diagnostics', async () => {
  const large = new ExternalClient(HAPI_BASE_URL, async () => response({ resourceType: 'Binary', data: 'x'.repeat(5 * 1024 * 1024 + 1) }));
  await assert.rejects(large.request(large.transport.url('metadata')), /bounded-response/);
  const malformed = new ExternalClient(HAPI_BASE_URL, async () => response('synthetic-secret-body'));
  await assert.rejects(malformed.request(malformed.transport.url('metadata')), error => error instanceof Error && !error.message.includes('synthetic-secret-body') && /resource-shape/.test(error.message));
});

test('G-BACKEND strict round-trip comparator ignores only documented server metadata', () => {
  const expected = { ...observation, meta: { versionId: 'old', lastUpdated: 'old', tag: [{ code: 'keep' }] } };
  const actual = { ...expected, meta: { versionId: 'new', lastUpdated: 'new', source: '#generated', tag: [{ code: 'keep' }] } };
  assert.equal(compareExternalResource(expected, actual), true);
  assert.equal(compareExternalResource(expected, { ...actual, valueQuantity: { value: 8 } }), false);
  assert.equal(compareExternalResource(expected, { ...actual, meta: { ...actual.meta, tag: [] } }), false);
  assert.equal(compareExternalResource({ ...expected, meta: { source: 'specified' } }, { ...actual, meta: { source: 'changed' } }), false);
  assert.equal(compareExternalResource(expected, { ...actual, text: { div: 'server-added-content' } }), false);
  assert.equal(compareExternalResource({ ...observation, extension: [{ url: 'x', valueString: 'keep' }] }, observation), false);
});

function fakeStore(options: { extra?: boolean; corruptRead?: boolean } = {}) {
  const data = new Map<string, Record<string, unknown>>();
  if (options.extra) data.set('Observation/foreign-record', { ...observation, id: 'foreign-record' });
  const writes: Record<string, unknown>[] = [];
  const fetcher: HttpFetch = async (url, init) => {
    if (init.method === 'POST') {
      const bundle = JSON.parse(init.body!);
      writes.push(bundle);
      for (const entry of bundle.entry) data.set(entry.request.url, { ...entry.resource, meta: { versionId: '2', lastUpdated: '2026-01-01T00:00:00Z', source: '#assigned' } });
      return response({ resourceType: 'Bundle', type: 'transaction-response', entry: bundle.entry.map(() => ({ response: { status: '200 OK' } })) });
    }
    const path = url.pathname.slice('/fhir/'.length);
    if (!path.includes('/')) return response({ resourceType: 'Bundle', type: 'searchset', ...(options.extra ? {} : { total: data.size }), entry: [...data.values()].map(resource => ({ resource })) });
    const found = data.get(path)!;
    return response(options.corruptRead ? { ...found, status: 'preliminary' } : found);
  };
  return { data, writes, client: new ExternalClient(HAPI_BASE_URL, fetcher) };
}

test('G-BACKEND transaction PUT loader reads every body and preserves fixed identities', async () => {
  const store = fakeStore();
  const resources = [observation, { ...observation, id: 'synthetic-b' }];
  const versions = await loadExternalCorpus(store.client, corpus(resources));
  assert.deepEqual([...versions.values()], ['2', '2']);
  assert.equal(store.writes.length, 1);
  const entries = store.writes[0]!.entry as { resource: GoldenResource; request: { method: string; url: string } }[];
  assert.deepEqual(entries.map(entry => entry.request), resources.map(resource => ({ method: 'PUT', url: `${resource.resourceType}/${resource.id}` })));
  assert.deepEqual(entries.map(entry => entry.resource), resources);
  const corrupt = fakeStore({ corruptRead: true });
  await assert.rejects(loadExternalCorpus(corrupt.client, corpus()), /round-trip-mismatch/);
});

test('G-BACKEND hermetic census refuses foreign, missing, duplicate and changed records', async () => {
  const foreign = fakeStore({ extra: true });
  await assert.rejects(loadExternalCorpus(foreign.client, corpus()), /census-extra-resource/);
  assert.equal(foreign.writes.length, 0, 'census refusal precedes transaction');
  for (const [entries, expected] of [[[], /census-missing-resource/], [[observation, observation], /census-duplicate-resource/], [[{ ...observation, status: 'preliminary' }], /census-resource-mismatch/]] as const) {
    const client = new ExternalClient(HAPI_BASE_URL, async () => response({ resourceType: 'Bundle', type: 'searchset', entry: entries.map(resource => ({ resource })) }));
    await assert.rejects(censusExternalCorpus(client, corpus(), true), expected);
  }
});

test('G-BACKEND census binds totals and rejects unsafe, duplicate or endless next links', async () => {
  for (const total of [-1, 0.5, '1', 2]) {
    const client = new ExternalClient(HAPI_BASE_URL, async () => response({ resourceType: 'Bundle', type: 'searchset', total, entry: [{ resource: observation }] }));
    await assert.rejects(censusExternalCorpus(client, corpus(), true), /census-total/);
  }
  for (const next of ['http://example.invalid/fhir/Observation', 'http://127.0.0.1:18092/fhir/Observation', 'http://127.0.0.1:18091/elsewhere']) {
    let calls = 0;
    const client = new ExternalClient(HAPI_BASE_URL, async () => { calls++; return response({ resourceType: 'Bundle', type: 'searchset', entry: [{ resource: observation }], link: [{ relation: 'next', url: next }] }); });
    await assert.rejects(censusExternalCorpus(client, corpus(), true));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const repeating = new ExternalClient(HAPI_BASE_URL, async url => { calls++; return response({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'next', url: url.href }] }); });
  await assert.rejects(censusExternalCorpus(repeating, corpus(), true), /census-pagination/);
  assert.equal(calls, 1);
  const duplicate = new ExternalClient(HAPI_BASE_URL, async () => response({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'next', url: HAPI_BASE_URL }, { relation: 'next', url: HAPI_BASE_URL }] }));
  await assert.rejects(censusExternalCorpus(duplicate, corpus(), true), /census-next-link/);
  let page = 0;
  const second = { ...observation, id: 'synthetic-b' };
  const changingTotal = new ExternalClient(HAPI_BASE_URL, async () => response(++page === 1
    ? { resourceType: 'Bundle', type: 'searchset', total: 1, entry: [{ resource: observation }], link: [{ relation: 'next', url: `${HAPI_BASE_URL}/Observation?_offset=1` }] }
    : { resourceType: 'Bundle', type: 'searchset', total: 2, entry: [{ resource: second }] }));
  await assert.rejects(censusExternalCorpus(changingTotal, corpus([observation, second]), true), /census-total/);
});

test('G-BACKEND explicit payload input encoding leaves fixtures untouched and does not relax comparison', () => {
  const before = canonicalJson(GOLDEN_RESOURCES);
  const raw = canonicalJson(RAW_READ_BODIES);
  const external = externalCorpus();
  assert.equal(external.resources.length, 52);
  assert.equal(external.omitted[0]!.resources, 4);
  assert.equal(external.transformations.reduce((sum, row) => sum + row.count, 0), 2);
  for (const type of ['DocumentReference', 'DiagnosticReport']) {
    const source = GOLDEN_RESOURCES.find(resource => resource.resourceType === type)!;
    const encoded = external.resources.find(resource => resource.resourceType === type)!;
    const pick = (resource: GoldenResource) => type === 'DocumentReference' ? (resource.content as { attachment: { data: string } }[])[0]!.attachment.data : (resource.presentedForm as { data: string }[])[0]!.data;
    assert.equal(Buffer.from(pick(encoded), 'base64').toString('utf8'), pick(source));
    assert.equal(compareExternalResource(encoded, source), false, 'input encoding is not a comparator exception');
  }
  assert.equal(canonicalJson(GOLDEN_RESOURCES), before);
  assert.equal(canonicalJson(RAW_READ_BODIES), raw);
  assert.equal(external.sha256, externalHash({ schema: 'external-eval/1', bodies: external.bodies }));
  assert.ok(external.bodies.includes(RAW_READ_BODIES['obs-decimal-1']!));
});

test('G-BACKEND prepared inputs are immutable owned snapshots and unprepared sources cannot run', async () => {
  const input = { baseUrl: HAPI_BASE_URL, identity: structuredClone(identity), corpus: corpus(), versions: new Map([['synthetic-a', '2']]) };
  const owned = immutableExternalBackend(input);
  input.identity.capability_revision = 'drift';
  (input.corpus.resources[0] as Record<string, unknown>).status = 'changed';
  input.versions.set('synthetic-a', '3');
  assert.equal(owned.identity.capability_revision, identity.capability_revision);
  assert.equal(owned.corpus.resources[0]!.status, 'final');
  assert.equal(owned.versions.get('synthetic-a'), '2');
  assert.throws(() => { (owned.corpus.resources[0] as Record<string, unknown>).status = 'changed'; }, TypeError);
  assert.throws(() => { (owned as { baseUrl: string }).baseUrl = 'http://example.invalid'; }, TypeError);
  assert.equal('set' in owned.versions, false);
  await assert.rejects(verifyExternalBackend(owned), /unprepared-backend/);
  observation.status = 'final';
});

test('G-BACKEND applicability is total stable and fails closed on task or classification drift', () => {
  const rows = externalApplicability();
  const tasks = externalTasks();
  assert.equal(TASKS.length, 77);
  assert.equal(rows.length, 81);
  assert.equal(rows.filter(row => row.classification === 'real-backend').length, 59);
  assert.deepEqual(rows.filter(row => row.profile_control).map(row => row.task_id), ['hapi-code-membership', 'hapi-code-date-window', 'hapi-date-lower-discrimination', 'hapi-date-upper-discrimination']);
  assert.deepEqual(rows.filter(row => row.classification === 'profile-inapplicable').map(row => row.retained_synthetic_task), ['query-complete-proven', 'query-cross-page-sort']);
  assert.equal(rows.filter(row => row.corpus === 'query').length, tasks.filter(task => task.corpus === 'query').length);
  assert.deepEqual(externalApplicability([...tasks].reverse()).map(row => row.task_id), [...tasks].reverse().map(task => task.id));
  assert.throws(() => externalApplicability([...tasks, { ...tasks[0]!, id: 'unreviewed' }]), /applicability-not-total/);
  assert.throws(() => externalApplicability([...tasks, tasks[0]!]), /applicability-not-total/);
  assert.throws(() => externalApplicability(tasks, rows.slice(1)), /applicability-not-total/);
  assert.throws(() => externalApplicability([{ ...tasks[0]!, fixtureMode: 'wide-capability' }, ...tasks.slice(1)]), /applicability-task-drift/);
  assert.throws(() => externalApplicability([{ ...tasks[0]!, budget: { ...tasks[0]!.budget, maxBytes: 999999 } }, ...tasks.slice(1)]), /applicability-task-drift/);
  const invalid = structuredClone(rows); invalid[0]!.reason = '';
  assert.throws(() => externalApplicability(tasks, invalid), /applicability-invalid/);
  const excluded = structuredClone(rows); excluded.find(row => row.profile_control)!.classification = 'fixture-simulated';
  assert.throws(() => externalApplicability(tasks, excluded), /applicability-control-excluded/);
  const reassigned = structuredClone(rows); reassigned[0]!.classification = 'fixture-simulated';
  assert.throws(() => externalApplicability(tasks, reassigned), /applicability-assignment-drift/);
  const swapped = structuredClone(rows); swapped[0]!.classification = 'fixture-simulated'; swapped.find(row => row.task_id === 'capabilities-server')!.classification = 'real-backend';
  assert.throws(() => externalApplicability(tasks, swapped), /applicability-assignment-drift/, 'same totals cannot hide a changed assignment');
  const lostRegression = structuredClone(rows); delete lostRegression.find(row => row.classification === 'profile-inapplicable')!.retained_synthetic_task;
  assert.throws(() => externalApplicability(tasks, lostRegression), /applicability-retained-regression/);
  assert.match(externalTaskHash(), /^[a-f0-9]{64}$/);
});

test('G-BACKEND external selection excludes fixture simulations and refuses altered or unknown tasks', () => {
  const selected = selectExternalTasks(externalTasks());
  assert.equal(selected.length, 59);
  assert.ok(selected.every(task => task.fixtureMode === undefined));
  assert.ok(!selected.some(task => task.id === 'query-ignore-date-lower'));
  assert.ok(selected.some(task => task.id === 'query-cross-page-sort-generic'), 'genuine opaque paging honesty stays applicable');
  assert.ok(selected.some(task => task.id === 'heart-rate-paging-drain'));
  assert.ok(selected.some(task => task.id === 'p-guidance-cursor-drain'));
  assert.ok(!selected.some(task => task.id === 'query-cross-page-sort'), 'the unsupported sort-proof obligation is explicitly retained in the synthetic regression suite');
  assert.throws(() => selectExternalTasks([{ ...TASKS[0]!, id: 'unknown-task' }]), /external-task-selection/);
  assert.throws(() => selectExternalTasks([{ ...TASKS[0]!, checks: [] }]), /external-task-selection/);
});

test('G-BACKEND every discovered envelope binds the measured capability revision during a run', () => {
  assert.equal(externalCapabilityRevisionMatches(identity.capability_revision, identity.capability_revision, false), true);
  assert.equal(externalCapabilityRevisionMatches('changed', identity.capability_revision, false), false);
  assert.equal(externalCapabilityRevisionMatches('changed', identity.capability_revision, true), false);
  assert.equal(externalCapabilityRevisionMatches('unknown', identity.capability_revision, false), false);
  assert.equal(externalCapabilityRevisionMatches('unknown', identity.capability_revision, true), true, 'a pre-discovery refusal claims no source proof');
});

test('G-BACKEND external eligible registry requires each independent binding', () => {
  assert.doesNotThrow(() => assertSearchProfileRegistry([profile()]));
  for (const [key, expected] of [['software', /software/], ['software_version', /software/], ['fhir_version', /FHIR/], ['image_digest', /image_digest/], ['corpus_sha256', /corpus_sha256/]] as const) {
    const changed = profile(); delete (changed.source as unknown as Record<string, unknown>)[key];
    assert.throws(() => assertSearchProfileRegistry([changed]), expected);
  }
  for (const [key, expected] of [['tasks_sha256', /tasks_sha256/], ['capability_revision', /capability revision/], ['report_sha256', /recorded evidence/], ['recorded_at', /recorded evidence/]] as const) {
    const changed = profile(); delete (changed.evidence as unknown as Record<string, unknown>)[key];
    assert.throws(() => assertSearchProfileRegistry([changed]), expected);
  }
  const ineligible = { ...profile(), eligible: false, evidence: null };
  assert.doesNotThrow(() => assertSearchProfileRegistry([ineligible]));
});

test('G-BACKEND source binding uses exact keyed software version FHIR and revision with no external wildcard', () => {
  const resolve = (candidate: SearchProfile, source: Record<string, unknown>) => {
    const state = new ProfileState();
    (state as unknown as { setCandidateForTest(candidate: SearchProfile, privateCandidate: boolean): void }).setCandidateForTest(candidate, true);
    return state.profile(candidate.id, source);
  };
  const source = { digested: true as const, software: sourceIdentityDigest(identity.software), softwareVersion: sourceIdentityDigest(identity.software_version), fhirVersion: identity.fhir_version, revision: identity.capability_revision };
  assert.ok(resolve(profile(), source));
  for (const key of ['software', 'softwareVersion', 'fhirVersion', 'revision']) {
    assert.equal(resolve(profile(), { ...source, [key]: 'drift' }), undefined, key);
    const missing = { ...source }; delete (missing as Record<string, unknown>)[key];
    assert.equal(resolve(profile(), missing), undefined, `missing ${key}`);
  }
  const wildcard = profile(); delete wildcard.source.software_version;
  assert.equal(resolve(wildcard, source), undefined);
  const noRevision = profile(); delete noRevision.evidence!.capability_revision;
  assert.equal(resolve(noRevision, source), undefined);
  assert.ok(resolve({ ...profile(), eligible: false, evidence: null }, source), 'labelled private candidate does not fabricate recorded proof');
});

test('G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding', () => {
  assert.equal(profileDrift(profile(), identity), undefined);
  for (const [sourceKey, identityKey] of [['software', 'software'], ['software_version', 'software_version'], ['fhir_version', 'fhir_version'], ['image_digest', 'image_digest'], ['corpus_sha256', 'corpus_sha256']] as const) {
    const changed = profile(); changed.source[sourceKey] = 'drift';
    assert.match(profileDrift(changed, identity) ?? '', new RegExp(identityKey));
  }
  for (const key of ['capability_revision', 'tasks_sha256'] as const) {
    const changed = profile(); changed.evidence![key] = 'drift';
    assert.match(profileDrift(changed, identity) ?? '', new RegExp(key));
  }
  assert.match(profileDrift(profile()) ?? '', /external identity missing/);
  assert.match(profileDrift(declaredSearchProfile('synthetic-fixture-r4-v1')!, identity) ?? '', /synthetic profile/);
  assert.equal(profileDrift(declaredSearchProfile('synthetic-fixture-r4-v1')!), undefined);
});

function cleanReport(): EvalReport {
  const results = externalApplicability().filter(row => row.classification === 'real-backend').flatMap(task => ARM_ORDER.map(arm => {
    const query_profile = { id: task.profile_control ? 'hapi-r4-labs-v1' : 'generic-r4', eligible: !task.profile_control, private: task.profile_control, warning_codes: task.profile_control ? ['TEST_QUERY_EVIDENCE'] : [] };
    return { task_id: task.task_id, arm, status: task.profile_control ? 'private_profile_control' : 'pass', ...(task.profile_control ? { private_profile_verdict: 'pass' } : {}), query_profile, failures: [],
      checks: externalTasks().find(definition => definition.id === task.task_id)!.checks.map(check => ({ check_id: check.id, kind: check.kind, step: check.step ?? 0, status: 'pass' })),
      calls: [{ query_profile, observed_warning_codes: task.profile_control ? ['TEST_QUERY_EVIDENCE'] : [] }], opaque_continuations: [] } as unknown as TaskArmResult;
  }));
  return { results, protocol: { era: 'modern' }, external_backend: { identity, applicability: externalApplicability(), omitted_inputs: [], input_transformations: [] }, summary: { pending_profile_proof: [], failures_by_cause: {}, byte_accounting: { under_reported_calls: 0, over_reported_calls: 0 } } } as unknown as EvalReport;
}

test('G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity', () => {
  const problems = (report: EvalReport) => externalQualificationProblems(report, identity, 'hapi-r4-labs-v1');
  assert.deepEqual(problems(cleanReport()), []);
  const missing = cleanReport(); missing.results.pop(); assert.ok(problems(missing).some(problem => /task-arm denominator/.test(problem)));
  const duplicate = cleanReport(); duplicate.results.push(duplicate.results[0]!); assert.ok(problems(duplicate).some(problem => /task-arm denominator/.test(problem)));
  const control = cleanReport(); control.results.find(row => row.status === 'private_profile_control')!.status = 'pass'; assert.ok(problems(control).some(problem => /private-control denominator/.test(problem)));
  const failed = cleanReport(); failed.results.find(row => row.status === 'private_profile_control')!.private_profile_verdict = 'fail'; assert.ok(problems(failed).includes('private controls failed'));
  assert.ok(!problems(failed).includes('public run not clean'), 'private failures are not mislabeled as public failures');
  const mislabelled = cleanReport(); mislabelled.results.find(row => row.status === 'private_profile_control')!.query_profile.private = false; assert.ok(problems(mislabelled).includes('private controls mislabelled'));
  const pending = cleanReport(); pending.results[0]!.status = 'pending_profile_proof'; assert.ok(problems(pending).includes('pending profile proof'));
  const pendingCheck = cleanReport(); pendingCheck.results[0]!.checks.push({ check_id: 'pending', kind: 'dataPath', status: 'pending_profile_proof' }); assert.ok(problems(pendingCheck).includes('pending profile proof'));
  const publicFailure = cleanReport(); publicFailure.results[0]!.status = 'known-defect'; assert.ok(problems(publicFailure).includes('public run not clean'));
  const changed = cleanReport(); changed.external_backend = { ...changed.external_backend!, identity: { ...identity, capability_revision: 'changed' } }; assert.ok(problems(changed).includes('external identity changed'));
  const assignment = cleanReport(); assignment.external_backend!.applicability[0]!.reason = 'Changed classification rationale'; assert.ok(problems(assignment).includes('applicability report changed'));
  const accounting = cleanReport(); accounting.summary.byte_accounting.under_reported_calls = 1; assert.ok(problems(accounting).includes('independent byte accounting failed'));
  const era = cleanReport(); era.protocol.era = 'legacy'; assert.ok(problems(era).some(problem => /protocol era/.test(problem)));
  assert.deepEqual(externalQualificationProblems(era, identity, 'hapi-r4-labs-v1', 'legacy'), []);
  const labels = cleanReport(); labels.results.find(row => row.status === 'private_profile_control')!.calls[0]!.observed_warning_codes = [];
  assert.ok(problems(labels).includes('private control evidence labels missing'));
  const emptyChecks = cleanReport(); emptyChecks.results.find(row => row.status === 'private_profile_control')!.checks = [];
  assert.ok(problems(emptyChecks).some(problem => /check identities/.test(problem)));
});

test('G-BACKEND corpus classification and external implementation leave original fixture evidence pinned', () => {
  const registry = JSON.parse(readFileSync(new URL('../packages/core/src/data/search-profiles.json', import.meta.url), 'utf8'));
  const hapi = registry.profiles.find((entry: { id: string }) => entry.id === 'hapi-r4-labs-v1');
  assert.equal(hapi.eligible, true);
  assert.deepEqual(hapi.evidence, HAPI_RECORDED_EVIDENCE);
  assertHapiProfilePins();
  assert.equal(profileDrift(declaredSearchProfile('synthetic-fixture-r4-v1')!), undefined);
});

test('G-BACKEND narrow candidate copies the pinned declaration and refuses every source identity drift', () => {
  const resources = externalCorpus();
  const backend = { baseUrl: HAPI_BASE_URL, identity: { ...identity, corpus_sha256: resources.sha256 }, corpus: resources, versions: new Map<string, string>() };
  const candidate = externalCandidate(backend);
  const declared = declaredSearchProfile('hapi-r4-labs-v1')!;
  assert.deepEqual(candidate, { ...declared, eligible: false, evidence: null });
  assert.equal(candidate.eligible, false);
  assert.equal(candidate.evidence, null);
  assert.deepEqual(candidate.testedSorts, []);
  assert.deepEqual(candidate.testedContinuations, []);
  assert.deepEqual(candidate.testedFilters.map(entry => [entry.resource_type, entry.parameter, entry.variant]), [['Observation', 'code', 'token-system-code'], ['Observation', 'date', 'effective-interval-ge-lt']]);
  for (const key of ['software', 'software_version', 'fhir_version', 'image_digest', 'corpus_sha256'] as const) {
    assert.throws(() => externalCandidate({ ...backend, identity: { ...backend.identity, [key]: 'drift' } }), /candidate-declaration/);
  }
  candidate.source.software = 'changed private copy';
  candidate.testIds = [...candidate.testIds, 'changed-private-control'];
  assert.deepEqual(declaredSearchProfile('hapi-r4-labs-v1'), declared, 'private candidate changes cannot mutate the qualified declaration');
});

test('G-BACKEND exact unordered membership rejects missing extra and duplicate resources without changing ordered checks', () => {
  const evidence = collectEvidence([]);
  for (const [ids, expected] of [[['a', 'b'], 'pass'], [['b', 'a'], 'pass'], [['a'], 'fail'], [['a', 'b', 'c'], 'fail'], [['a', 'b', 'b'], 'fail']] as const) {
    evidence.resourceOrder = [...ids];
    assert.equal(evaluateCheck({ kind: 'resourceIdSet', id: 'set', equals: ['a', 'b'] }, 'fhir', evidence).status, expected);
  }
  evidence.resourceOrder = ['b', 'a'];
  assert.equal(evaluateCheck({ kind: 'resourceIds', id: 'ordered', equals: ['a', 'b'] }, 'fhir', evidence).status, 'fail');
  const task = structuredClone(externalTasks().find(task => task.id === 'hapi-code-membership')!);
  task.checks[0] = { kind: 'resourceIdSet', id: 'duplicate-expectation', step: 0, equals: ['a', 'a'] };
  assert.throws(() => parseM3bTaskFile(JSON.stringify({ schema_version: 'm3b-tasks/1', tasks: [task] })), /duplicated/);
});

test('G-BACKEND new controls discriminate membership under the narrow private fixture candidate', async () => {
  const declared = declaredSearchProfile('hapi-r4-labs-v1')!;
  const fixture = declaredSearchProfile('synthetic-fixture-r4-v1')!;
  const candidate = { ...declared, eligible: false, evidence: null, source: fixture.source };
  const tasks = externalTasks().filter(task => task.id.startsWith('hapi-'));
  const report = await runEvals({ tasks, arms: ['fhir'] }, { testQueryProfile: candidate });
  assert.equal(report.results.length, 4);
  for (const row of report.results) assert.equal(row.private_profile_verdict, 'pass', `${row.task_id}: ${JSON.stringify(row.failures)}`);
  assert.ok(report.results.every(row => row.query_profile.private && row.calls.every(call => call.observed_warning_codes?.includes('TEST_QUERY_EVIDENCE'))), 'private controls stay visibly labelled after public qualification');
  const broken = await runEvals({ tasks: [{ ...tasks[0]!, fixtureMode: 'self-link-claims-unapplied-filter' }], arms: ['fhir'] }, { testQueryProfile: candidate });
  assert.equal(broken.results[0]!.private_profile_verdict, 'fail');
  assert.ok(broken.results[0]!.checks.some(check => check.check_id === 'members-0' && check.status === 'fail'));
});
