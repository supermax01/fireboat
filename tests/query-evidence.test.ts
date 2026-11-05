import assert from 'node:assert/strict';
import { withGateway, withSdk, hba1c as sdkHba1c, output as sdkOutput } from './s57-sdk-helpers.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { coverageV2Schema, toolInputV2Schemas, type FhirResource } from '../packages/core/src/contracts.js';
import {
  buildQueryEvidence, coverageForSnapshot, dateSearchOutcome, declaredSearchProfile, downgradeEvidence,
  eligibleSearchProfileIds, evidenceViews, filterVariantProved, isProvingSearchProfile,
  matchSelfLink, noMatchesEligible, observationEffective, orderUnverified, parseFhirDateInterval,
  profileForSource, ProfileState, queryDigest, searchProfile, shorthandEvidence, sortVariantListed,
  splitEscapedList, splitToken, tokenAlternatives, tokenMatches, unescapeFhir, validateReturnedPredicates, validateSortOrder, validateSortPage,
  type QueryPair, type SearchProfile,
} from '../packages/core/src/query.js';

// Reflection is deliberately confined to the test harness; the production constructor has no candidate argument.
const candidateState = (profile: import('../packages/core/src/query.js').SearchProfile) => {
  const state = new ProfileState();
  (state as unknown as { setCandidateForTest(profile: import('../packages/core/src/query.js').SearchProfile): void }).setCandidateForTest(profile);
  return state;
};
const brandSearchProfileForTest = (profile: import('../packages/core/src/query.js').SearchProfile) => candidateState(profile).profile(profile.id)!;
import {
  candidateInterval, fhirDateSearchMatches, fixtureSha256, parseM3bFixtureFragment, startEvalFixtureServer,
  type GoldenResource,
} from '../packages/evals/src/fixture.js';
import { parseM3bOracleFile, parseM3bTaskFile } from '../packages/evals/src/tasks.js';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const LOINC_HBA1C = 'http://loinc.org|4548-4';
const obs = (id: string, extra: Record<string, unknown> = {}): FhirResource => ({
  resourceType: 'Observation', id, status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] },
  subject: { reference: 'Patient/eval-patient-a' },
  effectiveDateTime: '2025-06-15T08:00:00.000Z', ...extra,
});
const HBA1C_PAIRS: QueryPair[] = [
  { name: 'code', value: LOINC_HBA1C },
  { name: 'date', value: 'ge2020-01-01' },
  { name: 'date', value: 'lt2026-01-01' },
  { name: 'patient', value: 'Patient/eval-patient-a' },
];
// Q-2/R2-2: synthetic-fixture-r4-v1 is qualified since S6, but the raw
// declaredSearchProfile() copy is still unbranded (cannot prove). Variant/
// evidence logic is exercised through the labelled test seam with a
// branded eligible-with-evidence clone, independent of the registry's state.
const brandedSynthetic: SearchProfile = brandSearchProfileForTest({
  ...declaredSearchProfile('synthetic-fixture-r4-v1')!,
  eligible: true,
  evidence: { report_sha256: 'a'.repeat(64), recorded_at: '2026-01-01T00:00:00.000Z' },
});
const proofProfile = (profileId: string): SearchProfile | undefined =>
  profileId === 'synthetic-fixture-r4-v1' ? brandedSynthetic : searchProfile(profileId);
const buildWith = (profileId: string, extra: Partial<Parameters<typeof buildQueryEvidence>[0]> = {}) => buildQueryEvidence({
  resourceType: 'Observation', pairs: HBA1C_PAIRS, sortRequested: ['-date'],
  selfPairs: [...HBA1C_PAIRS, { name: '_sort', value: '-date' }, { name: '_count', value: '20' }],
  profile: proofProfile(profileId), gatewayEnforcedIndices: new Set([3]),
  sourceRevision: 'cap-rev-1', policyRevision: 'synthetic-v1', contextHandle: 'ctx-1', ...extra,
});
const chainFor = (evidence: ReturnType<typeof buildWith>, over: Record<string, unknown> = {}) => ({
  deliveredCount: 1, pagesObserved: 1, queryEvidence: evidence, sortProof: 'none' as const,
  remainder: 'none' as const, exhausted: true, scope: 'page' as const, authorizationLimited: true, ...over,
});

test('query digest follows the frozen formula byte-for-byte (item 7)', () => {
  const expectedBody = '{"v":1,"source_revision":"cap-rev-1","policy_revision":"synthetic-v1","context_handle":"ctx-1","resource_type":"Observation","constraints":[{"name":"code","value":"http://loinc.org|4548-4"},{"name":"date","value":"ge2020-01-01"},{"name":"date","value":"lt2026-01-01"},{"name":"patient","value":"Patient/eval-patient-a"}],"sort":["-date"]}';
  const expected = createHash('sha256').update(expectedBody, 'utf8').digest('hex');
  assert.equal(buildWith('generic-r4').query_digest, expected);
  assert.equal(queryDigest({ sourceRevision: 'cap-rev-1', policyRevision: 'synthetic-v1', contextHandle: 'ctx-1', resourceType: 'Observation', constraints: HBA1C_PAIRS, sort: ['-date'] }), expected);
  // Evidence flags are not query identity: different self-link evidence, same digest.
  assert.equal(buildWith('generic-r4', { selfPairs: null }).query_digest, expected);
  assert.notEqual(buildWith('generic-r4', { pairs: [...HBA1C_PAIRS].reverse() }).query_digest, expected, 'pair order is identity');
});

test('only the closed profile proves filter execution; echoes never do (item 7)', () => {
  const generic = buildWith('generic-r4');
  assert.equal(generic.materialFilterProved, false);
  assert.deepEqual(generic.constraints.map(c => [c.name, c.source_reported, c.execution]), [
    ['code', 'matched', 'unknown'], ['date', 'matched', 'unknown'], ['date', 'matched', 'unknown'], ['patient', 'matched', 'gateway_enforced'],
  ]);
  const views = evidenceViews(generic);
  assert.equal(views.requested.length, 4);
  assert.equal(views.sourceReported.length, 4);
  assert.deepEqual(views.executed, [{ name: 'patient', value: 'Patient/eval-patient-a' }], 'executed means enforced or tested, never merely echoed');
  const tested = buildWith('synthetic-fixture-r4-v1');
  assert.equal(tested.materialFilterProved, true);
  assert.ok(tested.constraints.every(c => c.execution !== 'unknown'));
  assert.ok(tested.constraints.some(c => c.evidence_ref === 'synthetic-fixture-r4-v1@1'));
  const hapiDeclaration = declaredSearchProfile('hapi-r4-labs-v1')!;
  assert.ok(searchProfile(hapiDeclaration.id), 'the qualified HAPI profile resolves to proof');
  const ineligible = { ...hapiDeclaration, id: 'test-ineligible-hapi', eligible: false };
  assert.equal(candidateState(ineligible).profile(ineligible.id), undefined, 'an ineligible declaration cannot prove even with recorded evidence');
  const unevidenced = { ...hapiDeclaration, id: 'test-unevidenced-hapi', evidence: null };
  assert.equal(candidateState(unevidenced).profile(unevidenced.id), undefined, 'an eligible declaration without evidence cannot prove');
  assert.equal(searchProfile('invented-profile'), undefined);
  // Q-2 / S6: the synthetic profile proves execution only through recorded evidence; the evidence chain
  // (fixture, backend, task corpus, capability revision) is pinned in tests/s6-profile-proof.test.ts.
  assert.ok(searchProfile('synthetic-fixture-r4-v1'), 'the evidenced closed profile resolves to proof');
  assert.deepEqual(eligibleSearchProfileIds(), ['generic-r4', 'hapi-r4-labs-v1', 'synthetic-fixture-r4-v1']);
  const profilesFile = JSON.parse(read('../packages/core/src/data/search-profiles.json')) as { profiles: { id: string; eligible: boolean; evidence?: { report_sha256?: string } | null }[] };
  const synthetic = profilesFile.profiles.find(p => p.id === 'synthetic-fixture-r4-v1')!;
  assert.equal(synthetic.eligible, true);
  assert.match(synthetic.evidence?.report_sha256 ?? '', /^[a-f0-9]{64}$/);
  const hapi = profilesFile.profiles.find(p => p.id === 'hapi-r4-labs-v1')!;
  assert.equal(hapi.eligible, true);
  assert.equal(hapi.evidence?.report_sha256, 'f9f95bde48dd2d29716b89089a54779fb8d4700dbb04e30cfcbfda293996d51e');
});

test('coverage decision table: complete needs proof plus exhaustion (item 7)', () => {
  const proved = buildWith('synthetic-fixture-r4-v1', { sortVerified: true });
  const complete = coverageForSnapshot(proved, chainFor(proved));
  assert.equal(complete.state, 'complete_for_query');
  assert.equal(complete.query_exhausted, true);
  assert.equal(complete.authorization_limited, true);
  assert.ok(complete.reasons.includes('CLINICAL_RECORD_COMPLETENESS_UNKNOWN'), 'standing caveat survives completeness');
  assert.equal(coverageV2Schema.safeParse(complete).success, true);
  const unproved = buildWith('generic-r4');
  const unknown = coverageForSnapshot(unproved, chainFor(unproved));
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.query_exhausted, true);
  const partial = coverageForSnapshot(proved, chainFor(proved, { remainder: 'upstream', exhausted: false }));
  assert.equal(partial.state, 'partial');
  assert.equal(partial.query_exhausted, false);
  const rejected = coverageForSnapshot(proved, chainFor(proved, { remainder: 'rejected_link', exhausted: false }));
  assert.equal(rejected.state, 'partial');
  assert.equal(rejected.query_exhausted, null);
  assert.ok(rejected.reasons.includes('NON_CONTINUABLE_UPSTREAM_LINK'));
  const refused = coverageForSnapshot(proved, chainFor(proved, { refused: true, refusalReasons: ['UNSUPPORTED_PRECISION'] }));
  assert.equal(refused.state, 'partial');
  const retained = coverageForSnapshot(proved, chainFor(proved, { scope: 'retained' }));
  assert.equal(retained.state, 'partial');
  assert.equal(retained.query_exhausted, null);
  assert.equal(retained.query_evidence, 'retained_snapshot');
  assert.ok(retained.reasons.includes('RETAINED_PAGE_IS_NOT_THE_ENTIRE_QUERY'));
  const metadata = coverageForSnapshot(unproved, chainFor(unproved, { scope: 'metadata' }));
  assert.equal(metadata.state, 'complete_for_query', 'metadata completeness is about the snapshot, not clinical filters');
  assert.equal(metadata.authorization_limited, false);
  // Sort never changes set completeness.
  const provedUnsorted = buildWith('synthetic-fixture-r4-v1');
  const stillComplete = coverageForSnapshot(provedUnsorted, chainFor(provedUnsorted));
  assert.equal(stillComplete.state, 'complete_for_query');
  assert.equal(stillComplete.sort?.order, 'requested_unverified');
  assert.equal(orderUnverified(provedUnsorted), true);
  assert.equal(orderUnverified(proved), false);
});

test('continuation shorthand carries digest identity without repeating constraints (item 7)', () => {
  const full = buildWith('synthetic-fixture-r4-v1');
  const shorthand = shorthandEvidence(full);
  assert.equal(shorthand.query_digest, full.query_digest);
  const coverage = coverageForSnapshot(shorthand, chainFor(shorthand, { pagesObserved: 2 }));
  assert.equal(coverage.constraints, undefined);
  assert.equal(coverage.constraints_on_first_page, true);
  assert.equal(coverage.sort?.requested, undefined);
  assert.equal(coverage.sort?.order, full.sort?.order);
  assert.equal(coverageV2Schema.safeParse(coverage).success, true);
  const retainedFull = coverageForSnapshot(full, chainFor(full, { scope: 'retained' }));
  assert.ok(retainedFull.constraints?.length, 'retained inspection stays self-contained');
});

test('self-link accounting is a multiset over occurrences (item 7)', () => {
  const perfect = matchSelfLink(HBA1C_PAIRS, [...HBA1C_PAIRS, { name: '_count', value: '20' }]);
  assert.deepEqual(perfect.flags, ['matched', 'matched', 'matched', 'matched']);
  assert.equal(perfect.materialMismatch, false);
  const dropped = matchSelfLink(HBA1C_PAIRS, HBA1C_PAIRS.filter((_, i) => i !== 1));
  assert.deepEqual(dropped.flags, ['matched', 'not_reported', 'matched', 'matched'], 'one dropped date occurrence is visible');
  assert.equal(dropped.materialMismatch, true);
  const broadened = matchSelfLink(HBA1C_PAIRS, [...HBA1C_PAIRS, { name: 'status', value: 'final' }]);
  assert.equal(broadened.materialMismatch, true, 'an extra material pair refuses the page');
  assert.deepEqual(matchSelfLink(HBA1C_PAIRS, null).flags, ['not_reported', 'not_reported', 'not_reported', 'not_reported']);
  assert.equal(matchSelfLink(HBA1C_PAIRS, null).materialMismatch, false, 'missing evidence is reported, not fabricated');
  assert.deepEqual(matchSelfLink(HBA1C_PAIRS, undefined).flags, ['not_checked', 'not_checked', 'not_checked', 'not_checked']);
});

test('date intervals follow R4 precision semantics, never Date.parse (item 7)', () => {
  const interval = (text: string) => parseFhirDateInterval(text)!;
  assert.equal(dateSearchOutcome(interval('2020'), 'gt2020-06-01'), true, 'year target extends above June');
  assert.equal(dateSearchOutcome(interval('2020'), 'lt2020-06-01'), true, 'year target extends below June');
  assert.equal(dateSearchOutcome(interval('2020-06-15'), 'gt2020-06'), false, 'contained day is not gt its month');
  assert.equal(dateSearchOutcome(interval('2020-06-15'), 'ge2020-06'), true, 'eq makes ge');
  assert.equal(dateSearchOutcome({ start: interval('2019-06').start, end: interval('2020-06').end }, 'ge2020'), false, 'straddling period is neither gt nor eq');
  assert.equal(dateSearchOutcome(interval('2020-06-15T12:00:00+02:00'), 'ge2020-06-15T10:00:00Z'), true, 'equivalent offsets normalize');
  assert.equal(dateSearchOutcome(interval('2020-06-15T12:00:00+02:00'), 'lt2020-06-15T10:00:00Z'), false);
  assert.equal(dateSearchOutcome(interval('2020-06-15'), 'ap2020-06-15'), undefined, 'ap is undecidable, never eq');
  assert.equal(parseFhirDateInterval('2026-13-01'), undefined);
  assert.equal(parseFhirDateInterval('2020-02-30'), undefined, 'no silent month rollover');
  assert.equal(parseFhirDateInterval('2020-06-15T10:00:00')!.timezoneQualified, false);
  const issuedOnly = observationEffective(obs('x', { effectiveDateTime: undefined, issued: '2025-06-01T00:00:00Z' }));
  assert.equal(issuedOnly.kind, 'missing', 'issued is never the clinical date');
  assert.equal(observationEffective(obs('x', { effectiveDateTime: undefined, effectiveTiming: { event: ['2025-01-01'] } })).kind, 'unsupported');
  assert.equal(observationEffective(obs('x', { effectiveDateTime: undefined, _effectiveDateTime: { extension: [] } })).kind, 'unsupported');
});

test('oracle-date-vectors: independent vectors agree with Q semantics and fixture execution (item 7, section 9)', () => {
  const oracle = parseM3bOracleFile(read('../packages/evals/fixtures/m3b-query/oracle-vectors.json'));
  assert.match(oracle.sha256, /^[a-f0-9]{64}$/);
  assert.ok(oracle.vectors.length >= 15);
  for (const vector of oracle.vectors) {
    const resource = vector.resource as FhirResource;
    const effective = observationEffective(resource);
    const qOutcome = effective.kind === 'interval' ? dateSearchOutcome(effective, vector.value) : false;
    assert.equal(qOutcome, vector.matches, `Q: ${vector.id}`);
    const fixtureOutcome = fhirDateSearchMatches(candidateInterval(resource as GoldenResource, vector.parameter), vector.value);
    assert.equal(fixtureOutcome, vector.matches, `fixture: ${vector.id}`);
  }
});

test('returned-predicate contradictions refuse; unverifiable variants only downgrade (item 7)', () => {
  const tested = buildWith('synthetic-fixture-r4-v1');
  assert.deepEqual(validateReturnedPredicates([obs('ok')], tested, 'Observation'), { status: 'ok' });
  const wrongCode = obs('decoy-code', { code: { coding: [{ system: 'http://loinc.org', code: '2345-7' }] } });
  assert.deepEqual(validateReturnedPredicates([wrongCode], tested, 'Observation'), { status: 'contradicted', parameter: 'code' });
  const otherSystem = obs('decoy-system', { code: { coding: [{ system: 'http://example.test/codes', code: '4548-4' }] } });
  assert.deepEqual(validateReturnedPredicates([otherSystem], tested, 'Observation'), { status: 'contradicted', parameter: 'code' }, 'same code in another system never matches');
  assert.deepEqual(validateReturnedPredicates([obs('early', { effectiveDateTime: '2019-06-15T08:00:00.000Z' })], tested, 'Observation'), { status: 'contradicted', parameter: 'date' });
  assert.deepEqual(validateReturnedPredicates([obs('late', { effectiveDateTime: '2027-06-15T08:00:00.000Z' })], tested, 'Observation'), { status: 'contradicted', parameter: 'date' });
  const timing = validateReturnedPredicates([obs('t', { effectiveDateTime: undefined, effectiveTiming: { event: ['2025-01-01'] } })], tested, 'Observation');
  assert.equal(timing.status, 'unverifiable', 'Timing downgrades proof instead of contradicting it');
  const periodInside = obs('p', { effectiveDateTime: undefined, effectivePeriod: { start: '2025-06-01T00:00:00Z', end: '2025-06-02T00:00:00Z' } });
  assert.deepEqual(validateReturnedPredicates([periodInside], tested, 'Observation'), { status: 'ok' });
  const generic = buildWith('generic-r4');
  assert.deepEqual(validateReturnedPredicates([wrongCode], generic, 'Observation'), { status: 'ok' }, 'no claimed proof means nothing to contradict');
});

test('sort proof compares numeric instants within and across pages (item 7)', () => {
  const later = obs('later', { effectiveDateTime: '2025-03-01T08:00:00.000Z' });
  const earlier = obs('earlier', { effectiveDateTime: '2025-02-01T08:00:00.000Z' });
  assert.deepEqual(validateSortOrder([[later], [earlier]], ['-date'], 'Observation'), { status: 'ok' });
  assert.deepEqual(validateSortOrder([[earlier], [later]], ['-date'], 'Observation'), { status: 'contradicted', parameter: 'date' }, 'cross-page reversal contradicts claimed sort');
  assert.deepEqual(validateSortOrder([[later, earlier]], ['-date'], 'Observation'), { status: 'ok' });
  // Lexicographic trap: 2025-01-02T00:30+02:00 is 2025-01-01T22:30Z, before 23:00Z.
  const offsetRecord = obs('offset', { effectiveDateTime: '2025-01-02T00:30:00+02:00' });
  const zuluRecord = obs('zulu', { effectiveDateTime: '2025-01-01T23:00:00Z' });
  assert.deepEqual(validateSortOrder([[zuluRecord, offsetRecord]], ['-date'], 'Observation'), { status: 'ok' }, 'instant order, never lexicographic');
  assert.equal(validateSortOrder([[offsetRecord, zuluRecord]], ['-date'], 'Observation').status, 'contradicted');
  const partial = obs('partial', { effectiveDateTime: '2025-01-02' });
  assert.equal(validateSortOrder([[partial]], ['-date'], 'Observation').status, 'unverifiable', 'partial dates carry no recency proof');
  const tieA = obs('tie-a'); const tieB = obs('tie-b');
  assert.deepEqual(validateSortOrder([[tieA, tieB]], ['-date'], 'Observation'), { status: 'ok' }, 'ties are deterministic paging, not a unique latest');
});

test('NO_MATCHES eligibility needs terminal exhaustion with a material filter (items 3, 7)', () => {
  const unproved = buildWith('generic-r4');
  const terminalUnknown = coverageForSnapshot(unproved, chainFor(unproved, { deliveredCount: 0 }));
  assert.equal(noMatchesEligible(terminalUnknown, 0, true), true, 'terminal unverified zero still earns the hint, labelled unknown');
  assert.equal(noMatchesEligible(terminalUnknown, 0, false), false, 'unfiltered empty stays silent');
  const midChain = coverageForSnapshot(unproved, chainFor(unproved, { remainder: 'upstream', exhausted: false }));
  assert.equal(noMatchesEligible(midChain, 0, true), false, 'an empty page with more work is not terminal');
});

test('R3-L1/R3-L2: fixture date never uses issued and ap is refused, not empty', async () => {
  const subject = { reference: 'Patient/eval-patient-a' };
  const resources: GoldenResource[] = [
    { resourceType: 'Patient', id: 'eval-patient-a', active: true },
    { resourceType: 'Observation', id: 'issued-only', status: 'final', subject, issued: '2025-06-01T00:00:00.000Z', code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, valueQuantity: { value: 1, unit: '%', system: 'http://unitsofmeasure.org', code: '%' } },
    { resourceType: 'Observation', id: 'effective-match', status: 'final', subject, effectiveDateTime: '2025-06-01T00:00:00.000Z', issued: '2019-01-01T00:00:00.000Z', code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, valueQuantity: { value: 2, unit: '%', system: 'http://unitsofmeasure.org', code: '%' } },
  ];
  const server = await startEvalFixtureServer(resources);
  try {
    const search = async (query: string) => {
      const response = await fetch(`${server.baseUrl}/Observation?${query}`);
      return { status: response.status, body: await response.json() as { entry?: { resource: { id: string } }[] } };
    };
    const matched = await search('date=ge2025-01-01');
    assert.equal(matched.status, 200);
    assert.deepEqual((matched.body.entry ?? []).map(entry => entry.resource.id), ['effective-match'], 'issued-only never matches clinical date');
    assert.equal((await search('date=ap2025-06-01')).status, 400, 'date ap is refused');
    assert.equal((await search('value-quantity=ap5')).status, 400, 'quantity ap is refused');
    assert.equal((await search('date=ge2025-01-01')).status, 200, 'positive control still serves');
  } finally {
    await server.close();
  }
});

test('Q eval artifacts and discovery examples parse under the frozen formats (section 9)', () => {
  const fragment = parseM3bFixtureFragment(read('../packages/evals/fixtures/m3b-query/fragment.json'));
  assert.equal(fragment.id, 'm3b-query-decoys');
  assert.equal(fragment.resources.length, 8, 'match, single-predicate decoys, escaped-comma, systemless and instant records');
  const tasks = parseM3bTaskFile(read('../packages/evals/data/m3b-query-tasks.json'));
  const ids = tasks.map(task => task.id);
  for (const id of [
    'discover-observation-search-types', 'repair-code-text-discovery', 'patient-link-bare-id-denied', 'support-before-first-query', 'query-complete-proven', 'query-echo-only-unknown',
    'discover-unknown-and-conflicting-definition', 'discovery-snapshot-drain',
    'support-source-policy-intersection', 'lab-reference-no-hydration', 'contained-unclassified-parent-denied', 'shared-instance-positive-negative',
    'query-ignore-code', 'query-ignore-date-lower', 'query-ignore-date-upper', 'query-ignore-sort', 'query-cross-page-sort',
    'query-empty-page-with-next', 'query-invalid-next-safe-first-page', 'query-opaque-evidence', 'retained-not-query-complete',
    'query-token-escaped-comma', 'query-token-systemless', 'query-date-instant',
  ]) {
    assert.ok(ids.includes(id), id);
  }
  // Q-2: every profile test_id resolves to a drafted task or a unit-test marker.
  const testSources = read('../tests/query-evidence.test.ts') + read('../tests/search-parameters.test.ts');
  const declared = declaredSearchProfile('synthetic-fixture-r4-v1')!;
  const allTestIds = [...declared.testIds, ...declared.testedFilters.flatMap(e => e.test_ids ?? []), ...declared.testedSorts.flatMap(e => e.test_ids ?? [])];
  for (const testId of new Set(allTestIds)) {
    assert.ok(ids.includes(testId) || testSources.includes(testId), `unresolved test_id ${testId}`);
  }
  const examples = JSON.parse(read('../examples/discovery-calls.json')) as { calls: { tool: keyof typeof toolInputV2Schemas; input: unknown }[] };
  assert.equal(examples.calls.length, 3);
  for (const call of examples.calls) {
    assert.equal(toolInputV2Schemas[call.tool].safeParse(call.input).success, true, call.tool);
  }
});

test('Q-1: escaped-list overflow and lone backslashes are explicit refusals, never empty checks', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `x${i}`).join(',');
  assert.equal(splitEscapedList(many(33))?.length, 33, '33 alternatives stay checkable (bound-only positive control)');
  assert.equal(splitEscapedList(many(34)), undefined, '34 alternatives overflow to undefined');
  assert.equal(splitEscapedList(`Patient/synthetic-patient-b,${many(33)}`), undefined);
  assert.equal(splitEscapedList('xx\\xx'), undefined, 'R4-illegal lone backslash');
  assert.equal(splitEscapedList('trailing\\'), undefined);
  assert.deepEqual(splitEscapedList('a\\,b'), ['a,b']);
  assert.equal(filterVariantProved(brandedSynthetic, 'Observation', 'date', many(34)), false, 'overflow is never vacuously proved');
  assert.equal(tokenMatches(obs('x').code, many(34)), undefined, 'overflow is not proved');
});

test('Q-2/Q-9: filter proof is variant-exact; ap, modifiers and loose token forms stay unproved', () => {
  const declared = brandedSynthetic;
  assert.equal(filterVariantProved(declared, 'Observation', 'code', 'http://loinc.org|4548-4'), true);
  assert.equal(filterVariantProved(declared, 'Observation', 'code', '4548-4'), false, 'code-only is untested');
  assert.equal(filterVariantProved(declared, 'Observation', 'code', '|4548-4'), false, 'systemless form is untested as system-code');
  assert.equal(filterVariantProved(declared, 'Observation', 'code', 'http://loinc.org|'), false, 'system-only is untested');
  assert.equal(filterVariantProved(declared, 'Observation', 'code', 'http://loinc.org|4548-4,4548-4'), false, 'one loose OR alternative poisons proof');
  assert.equal(filterVariantProved(declared, 'Observation', 'code:not', 'http://loinc.org|4548-4'), false, 'modifier names never prove');
  assert.equal(filterVariantProved(declared, 'Observation', 'date', 'ap2020'), false, 'r-date-ap-proved: ap is never proved');
  assert.equal(filterVariantProved(declared, 'Observation', 'date', 'ge2020-01-01'), true);
  assert.equal(filterVariantProved(declared, 'Observation', 'status', 'final'), false, 'unlisted parameter is unproved');
  assert.equal(sortVariantListed(declared, 'Observation', ['-date']), true);
  assert.equal(sortVariantListed(declared, 'Observation', ['date']), false, 'ascending is untested; only descending is listed');
});

test('Q-3/Q-11: profiles bind to their tested source and invalidate per gateway', () => {
  assert.ok(profileForSource('generic-r4', { software: 'Anything', fhirVersion: '4.0.1' }), 'generic positive control');
  assert.equal(profileForSource('generic-r4', { fhirVersion: '4.3.0' }), undefined, 'FHIR version mismatch downgrades');
  // The closed profile is ineligible, so neither a matching nor a foreign
  // source can obtain proof from it (source binding + evidence both gate).
  const fixtureIdentity = { software: 'fhir-mcp retrieval eval fixture', softwareVersion: '0.1.0', fhirVersion: '4.0.1' };
  // S6: the qualified profile binds to its tested source AND to the capability revision it was proved on; without a
  // discovered revision there is no proof (fail closed, review finding 6).
  const recordedRevision = declaredSearchProfile('synthetic-fixture-r4-v1')!.evidence!.capability_revision!;
  assert.ok(profileForSource('synthetic-fixture-r4-v1', { ...fixtureIdentity, revision: recordedRevision }), 'the qualified profile applies to its exact tested source at the recorded revision');
  assert.equal(profileForSource('synthetic-fixture-r4-v1', fixtureIdentity), undefined, 'no discovered revision, no proof');
  assert.equal(profileForSource('synthetic-fixture-r4-v1', { ...fixtureIdentity, revision: `${recordedRevision}-drift` }), undefined, 'another capability revision is no proof');
  assert.equal(profileForSource('synthetic-fixture-r4-v1', { software: 'HAPI FHIR', softwareVersion: '7.0', fhirVersion: '4.0.1' }), undefined);
  assert.equal(declaredSearchProfile('synthetic-fixture-r4-v1')?.source.software, 'fhir-mcp retrieval eval fixture');
  const state = new ProfileState();
  assert.ok(state.profile('generic-r4'));
  state.invalidate('generic-r4');
  assert.equal(state.profile('generic-r4'), undefined, 'invalidation is sticky for the process');
  assert.ok(searchProfile('generic-r4'), 'stateless lookup is unaffected; root must consult ProfileState');
});

test('Q-4: echoed _sort never refuses membership; dropped/different sort only downgrades order', () => {
  const echoed = matchSelfLink(HBA1C_PAIRS, [...HBA1C_PAIRS, { name: '_sort', value: '-date' }, { name: '_count', value: '20' }], ['-date']);
  assert.equal(echoed.materialMismatch, false, 'the fixture real self link (with _sort) is not a mismatch');
  assert.equal(echoed.sortReported, 'matched');
  const dropped = matchSelfLink(HBA1C_PAIRS, [...HBA1C_PAIRS], ['-date']);
  assert.equal(dropped.sortReported, 'dropped');
  assert.equal(dropped.materialMismatch, false);
  const different = matchSelfLink(HBA1C_PAIRS, [...HBA1C_PAIRS, { name: '_sort', value: 'date' }], ['-date']);
  assert.equal(different.sortReported, 'different');
  assert.equal(different.materialMismatch, false);
  const proved = buildWith('synthetic-fixture-r4-v1', { sortVerified: true, selfPairs: [...HBA1C_PAIRS] });
  assert.equal(proved.sort?.order, 'requested_unverified', 'dropped self-link sort never verifies order');
});

test('Q-5: gateway enforcement is by occurrence index, never by shared parameter name', () => {
  const pairs: QueryPair[] = [
    { name: 'code', value: LOINC_HBA1C },
    { name: 'patient', value: 'Patient/eval-patient-a,Group/g' },
    { name: 'patient', value: 'Patient/eval-patient-a' },
  ];
  const evidence = buildQueryEvidence({
    resourceType: 'Observation', pairs, selfPairs: [...pairs],
    profile: proofProfile('synthetic-fixture-r4-v1'), gatewayEnforcedIndices: new Set([2]),
    sourceRevision: 'r', policyRevision: 'p', contextHandle: 'c',
  });
  assert.equal(evidence.constraints[1]?.execution, 'unknown', 'mixed Group occurrence sharing the confinement name is not enforced');
  assert.equal(evidence.constraints[2]?.execution, 'gateway_enforced', 'only the confinement index is enforced');
  assert.equal(evidence.materialFilterProved, false);
});

test('Q-6: R4 token vectors parse single-pass (|code, system|, escaped pipe/backslash/comma)', () => {
  const concept = (coding: Record<string, unknown>) => ({ coding: [coding] });
  assert.equal(tokenMatches(concept({ code: '4548-4' }), '|4548-4'), true, '|code matches a systemless coding');
  assert.equal(tokenMatches(concept({ system: 'http://loinc.org', code: '4548-4' }), '|4548-4'), false, '|code never matches a system');
  assert.equal(tokenMatches(concept({ system: 'http://loinc.org', code: '9999-9' }), 'http://loinc.org|'), true, 'system| allows any code');
  assert.equal(tokenMatches(concept({ system: 'a|b', code: 'c' }), 'a\\|b|c'), true, 'escaped pipe stays in the system');
  assert.equal(tokenMatches(concept({ system: 'a\\', code: 'b' }), 'a\\\\|b'), true, 'escaped backslash then pipe');
  assert.equal(tokenMatches(concept({ system: 'http://example.test/codes', code: 'local,hba1c' }), 'http://example.test/codes|local\\,hba1c'), true, 'escaped comma stays in the code');
  assert.equal(tokenMatches(concept({ system: 'http://example.test/other', code: 'hba1c' }), 'http://loinc.org|4548-4,http://example.test/codes|local\\,hba1c'), false, 'A.8 decoy never matches');
});

test('Q-9/Q-12/Q-13: proof guards discriminate (no-profile sort, missing date, unreviewed, exhaust, linkage kind)', () => {
  // r-sort-proof-without-profile
  assert.equal(buildWith('generic-r4', { sortVerified: true }).sort?.order, 'requested_unverified');
  // r-sort-tz-unchecked
  assert.equal(validateSortOrder([[obs('u', { effectiveDateTime: '2025-01-02T10:00:00' })]], ['-date'], 'Observation').status, 'unverifiable');
  // r-missing-effective-ok
  const tested = buildWith('synthetic-fixture-r4-v1');
  assert.deepEqual(validateReturnedPredicates([obs('m', { effectiveDateTime: undefined })], tested, 'Observation'), { status: 'contradicted', parameter: 'date' });
  // r-unreviewed-predicate-ok: a profile listing status still cannot verify it.
  const statusProfile: SearchProfile = brandSearchProfileForTest({ ...brandedSynthetic, testedFilters: [{ resource_type: 'Observation', parameter: 'status', variant: 'token-system-code' }] });
  const statusEvidence = buildQueryEvidence({
    resourceType: 'Observation', pairs: [{ name: 'status', value: 'http://example.test|final' }], selfPairs: [{ name: 'status', value: 'http://example.test|final' }],
    profile: statusProfile, gatewayEnforcedIndices: new Set(), sourceRevision: 'r', policyRevision: 'p', contextHandle: 'c',
  });
  assert.equal(validateReturnedPredicates([obs('s')], statusEvidence, 'Observation').status, 'unverifiable');
  // r-noncontinuable-exhausted (after Q-12)
  const nonContinuable = coverageForSnapshot(tested, chainFor(tested, { remainder: 'none', nonContinuable: true, exhausted: true }));
  assert.equal(nonContinuable.state, 'partial');
  assert.equal(nonContinuable.query_exhausted, null);
  // Q-13: confinement-only completeness is linkage, never self-link-only.
  const linkage = buildQueryEvidence({
    resourceType: 'Observation', pairs: [{ name: 'patient', value: 'Patient/eval-patient-a' }], selfPairs: [{ name: 'patient', value: 'Patient/eval-patient-a' }],
    profile: searchProfile('generic-r4'), gatewayEnforcedIndices: new Set([0]), sourceRevision: 'r', policyRevision: 'p', contextHandle: 'c',
  });
  const linkageCoverage = coverageForSnapshot(linkage, chainFor(linkage));
  assert.equal(linkageCoverage.state, 'complete_for_query');
  assert.equal(linkageCoverage.query_evidence, 'exact_id_and_subject_linkage', 'complete never co-occurs with declared_and_self_link_only');
});

test('oracle-sort-vectors: offsets, ties, partial dates and mixed precision (Q-10/Q-14)', () => {
  const at = (id: string, when: string) => obs(id, { effectiveDateTime: when });
  // Offsets on both sides compare as instants, ties are stable.
  assert.deepEqual(validateSortOrder([[at('a', '2025-01-02T00:30:00+02:00'), at('b', '2025-01-01T17:30:00-05:00')]], ['-date'], 'Observation'), { status: 'ok' }, 'equal instants in different offsets tie');
  assert.equal(validateSortOrder([[at('p', '2025-01-02')]], ['-date'], 'Observation').status, 'unverifiable', 'partial date carries no order proof');
  // Q-14: second precision followed by fractional precision overlaps — unverifiable, never contradicted.
  const mixed = validateSortOrder([[at('s', '2025-01-02T10:00:00Z'), at('f', '2025-01-02T10:00:00.500Z')]], ['-date'], 'Observation');
  assert.equal(mixed.status, 'unverifiable');
  // Q-14: overlapping fraction intervals (.5 = [.500,.600) vs .55) carry no
  // order proof in either direction, never a false contradiction or proof.
  assert.equal(validateSortOrder([[at('tenth', '2025-01-02T10:00:00.5Z'), at('hundredth', '2025-01-02T10:00:00.55Z')]], ['-date'], 'Observation').status, 'unverifiable');
  assert.equal(validateSortOrder([[at('hundredth', '2025-01-02T10:00:00.55Z'), at('tenth', '2025-01-02T10:00:00.5Z')]], ['-date'], 'Observation').status, 'unverifiable');
  assert.deepEqual(validateSortOrder([[at('hi', '2025-01-02T10:00:00.900Z'), at('lo', '2025-01-02T10:00:00.100Z')]], ['-date'], 'Observation'), { status: 'ok' }, 'disjoint fraction intervals still prove order');
  // Q-14: differing precisions are unverifiable even when disjoint and
  // start-ordered — proof is limited to instants of one tested precision.
  assert.equal(validateSortOrder([[at('sec', '2025-01-02T10:00:05Z'), at('frac', '2025-01-02T10:00:00.500Z')]], ['-date'], 'Observation').status, 'unverifiable', 'mixed precision never proves, even when disjoint');
  // Q-11 incremental boundary across pages without retaining bodies.
  const first = validateSortPage([at('later', '2025-03-01T08:00:00.000Z')], ['-date'], 'Observation');
  assert.equal(first.outcome.status, 'ok');
  assert.equal(typeof first.boundary, 'number');
  assert.equal(validateSortPage([at('earlier', '2025-02-01T08:00:00.000Z')], ['-date'], 'Observation', first.boundary, first.boundaryPrecision).outcome.status, 'ok');
  assert.equal(validateSortPage([at('newer', '2025-04-01T08:00:00.000Z')], ['-date'], 'Observation', first.boundary, first.boundaryPrecision).outcome.status, 'contradicted');
});

test('Q-11: downgradeEvidence strips only the named parameter proof', () => {
  const tested = buildWith('synthetic-fixture-r4-v1');
  const downgraded = downgradeEvidence(tested, 'date');
  assert.equal(downgraded.materialFilterProved, false);
  assert.ok(downgraded.constraints.filter(c => c.name === 'date').every(c => c.execution === 'unknown' && c.evidence_ref === undefined));
  assert.equal(downgraded.constraints.find(c => c.name === 'code')?.execution, 'tested_adapter', 'other proof survives');
  assert.equal(downgraded.constraints.find(c => c.name === 'patient')?.execution, 'gateway_enforced', 'enforcement is never downgraded');
  assert.equal(downgraded.query_digest, tested.query_digest, 'identity is unchanged by evidence downgrades');
});

test('Q-2 decoys: fixture executes A.8, systemless and instant queries exactly; ineligible profile never completes', async () => {
  const fragment = parseM3bFixtureFragment(read('../packages/evals/fixtures/m3b-query/fragment.json'));
  const resources = [
    { resourceType: 'Patient', id: 'eval-patient-a', active: true },
    ...fragment.resources,
  ] as GoldenResource[];
  const server = await startEvalFixtureServer(resources);
  try {
    const ids = async (query: string): Promise<string[]> => {
      const response = await fetch(`${server.baseUrl}/Observation?${query}`);
      assert.equal(response.status, 200, query);
      const body = await response.json() as { entry?: { resource: { id: string } }[] };
      return (body.entry ?? []).map(entry => entry.resource.id).sort();
    };
    const escaped = new URLSearchParams([['code', 'http://loinc.org|4548-4,http://example.test/codes|local\\,hba1c']]).toString();
    assert.deepEqual(await ids(escaped), ['q-decoy-early', 'q-decoy-late', 'q-local-comma', 'q-match'], 'escaped comma matches local,hba1c plus every LOINC 4548-4 record; other-system decoy, systemless and the instant record (its own code, S6) excluded');
    assert.deepEqual(await ids(new URLSearchParams([['code', '|4548-4']]).toString()), ['q-systemless'], '|code is system-less only');
    assert.ok((await ids('date=ge2025-01-01&date=lt2026-01-01')).includes('q-instant'), 'effectiveInstant matches clinical dates');
  } finally {
    await server.close();
  }
  // While the profile is ineligible, completeness is unreachable even on
  // perfect data: a missing matching record can never hide behind a claim.
  const genericEvidence = buildWith('generic-r4');
  assert.equal(coverageForSnapshot(genericEvidence, chainFor(genericEvidence)).state, 'unknown');
  const decoy = obs('decoy', { code: { coding: [{ system: 'http://example.test/other', code: 'hba1c' }] } });
  const declaredEvidence = buildWith('synthetic-fixture-r4-v1');
  assert.deepEqual(validateReturnedPredicates([decoy], declaredEvidence, 'Observation'), { status: 'contradicted', parameter: 'code' });
});

test('R2-2: a raw declared profile can never prove execution (reviewer bypass)', () => {
  const raw = declaredSearchProfile('synthetic-fixture-r4-v1')!;
  assert.equal(isProvingSearchProfile(raw), false, 'declared copy is unbranded');
  assert.ok(Object.isFrozen(raw), 'declared copy is frozen');
  assert.equal(filterVariantProved(raw, 'Observation', 'code', 'http://loinc.org|4548-4'), false, 'unbranded filter proof is refused');
  assert.equal(filterVariantProved(raw, 'Observation', 'date', 'ge2020-01-01'), false);
  assert.equal(sortVariantListed(raw, 'Observation', ['-date']), false, 'unbranded sort proof is refused');
  const evidence = buildQueryEvidence({
    resourceType: 'Observation', pairs: HBA1C_PAIRS, sortRequested: ['-date'], sortVerified: true,
    selfPairs: [...HBA1C_PAIRS, { name: '_sort', value: '-date' }],
    profile: raw, gatewayEnforcedIndices: new Set([3]),
    sourceRevision: 'r', policyRevision: 'p', contextHandle: 'c',
  });
  assert.ok(evidence.constraints.every(c => c.execution !== 'tested_adapter'), 'evidence from a raw profile is never tested_adapter');
  assert.equal(evidence.materialFilterProved, false);
  assert.equal(evidence.sort?.order, 'requested_unverified');
  assert.equal(coverageForSnapshot(evidence, chainFor(evidence)).state, 'unknown', 'raw profile never completes a query');
  // A hand-cloned copy of a branded profile is a different, unbranded object.
  const clone: SearchProfile = { ...brandedSynthetic };
  assert.equal(isProvingSearchProfile(clone), false);
  assert.equal(filterVariantProved(clone, 'Observation', 'code', 'http://loinc.org|4548-4'), false, 'clones do not inherit the brand');
  // Branded positive controls still prove through the same builders.
  assert.equal(isProvingSearchProfile(brandedSynthetic), true);
  assert.equal(isProvingSearchProfile(searchProfile('generic-r4')), true, 'selection brands its result');
  assert.equal(buildWith('synthetic-fixture-r4-v1').materialFilterProved, true);
  // The seam stays inaccessible through public exports (plan S6).
  const indexSource = read('../packages/core/src/index.ts');
  for (const seamName of ['brandSearchProfileForTest', 'registerSearchProfileForTest', 'declaredSearchProfile']) {
    assert.ok(!indexSource.includes(seamName), `${seamName} is not re-exported from core index.ts`);
  }
});

test('R2-3: source binding and evidence requirement discriminate via a branded test profile', () => {
  const closedForTest: SearchProfile = {
    id: 'test-closed-r4-v1', version: '1', eligible: true,
    source: { software: 'test fixture software', software_version: '9.9', fhir_version: '4.0.1' },
    evidence: { report_sha256: 'b'.repeat(64), recorded_at: '2026-01-01T00:00:00.000Z' },
    testIds: [],
    testedFilters: [{ resource_type: 'Observation', parameter: 'code', variant: 'token-system-code' }],
    testedSorts: [], testedContinuations: [],
  };
  const state = candidateState(closedForTest);
  const unevidenced = candidateState({ ...closedForTest, id: 'test-unevidenced-r4-v1', evidence: null });
  const matching = { software: 'test fixture software', softwareVersion: '9.9', fhirVersion: '4.0.1' };
  const selected = state.profile('test-closed-r4-v1', matching);
  assert.ok(selected, 'matching identity selects the eligible-with-evidence profile');
  assert.equal(filterVariantProved(selected, 'Observation', 'code', 'http://loinc.org|4548-4'), true, 'selected profile is branded and proves');
  assert.equal(state.profile('test-closed-r4-v1', { ...matching, software: 'other software' }), undefined, 'wrong software never proves');
  assert.equal(state.profile('test-closed-r4-v1', { ...matching, softwareVersion: '9.8' }), undefined, 'wrong software version never proves');
  assert.equal(state.profile('test-closed-r4-v1', { ...matching, fhirVersion: '4.3.0' }), undefined, 'wrong FHIR version never proves');
  assert.equal(state.profile('test-closed-r4-v1', { ...matching, software: undefined }), undefined, 'missing software identity never proves');
  assert.equal(searchProfile('test-unevidenced-r4-v1'), undefined, 'eligible profile with evidence:null proves nothing');
  assert.equal(unevidenced.profile('test-unevidenced-r4-v1', matching), undefined, 'unevidenced profile never binds to a source');
  assert.deepEqual(eligibleSearchProfileIds(), ['generic-r4', 'hapi-r4-labs-v1', 'synthetic-fixture-r4-v1'], 'test registry never widens the production config enum');
});

test('R2-6: token-level lone backslashes are undefined at every layer', () => {
  assert.equal(unescapeFhir('a\\b'), undefined, 'unescape-level lone backslash');
  assert.equal(unescapeFhir('a\\'), undefined, 'trailing backslash');
  assert.equal(tokenAlternatives('a\\b'), undefined, 'token-level lone backslash');
  assert.equal(tokenAlternatives('a|b\\'), undefined, 'trailing backslash after pipe');
  assert.equal(splitToken('x\\y'), undefined, 'single-alternative lone backslash');
  // Positive controls: legal escapes still parse exactly once.
  assert.equal(unescapeFhir('a\\,b'), 'a,b');
  assert.deepEqual(tokenAlternatives('a\\|b|c'), [{ system: 'a|b', code: 'c' }]);
  assert.deepEqual(splitToken('|code'), { system: null, code: 'code' });
});

test('gateway acceptance: HbA1c generic query and private tested-profile control in both SDK eras', async () => {
  for (const era of ['modern','legacy'] as const) for (const profile of [false,true]) await withGateway({profile}, (g, requests) => withSdk(g, era, async sdk => {
    const {e} = await sdk.call('fhir_search', {resource_type:'Observation',params:sdkHba1c,output:sdkOutput});
    assert.equal(e.error, undefined); assert.equal(e.data.resources.length, 1);
    assert.equal(e.coverage.state, profile ? 'complete_for_query' : 'unknown');
    assert.equal(e.coverage.sort.order, profile ? 'verified_by_adapter' : 'requested_unverified');
    assert.equal(e.warnings.some((w: Record<string,unknown>) => w.code === 'FILTER_EXECUTION_UNVERIFIED'), !profile);
    assert.equal(e.warnings.some((w: Record<string,unknown>) => w.code === 'ORDER_UNVERIFIED'), !profile);
    const clinical = requests.filter(u => !u.pathname.endsWith('/metadata')); assert.equal(clinical.length,1);
    assert.deepEqual([...clinical[0]!.searchParams].filter(([name]) => !['_count','subject','patient'].includes(name)), sdkHba1c.map(p => [p.name,p.value]));
    assert.equal(clinical[0]!.searchParams.get('patient'),'Patient/synthetic-a');
  }));
});
test('gateway acceptance: CA-ISO-01 refuses comma/escaped/encoded patient substitution before fetch in both SDK eras', async () => {
  for (const era of ['modern','legacy'] as const) await withGateway({}, (g, requests) => withSdk(g, era, async sdk => {
    const control = await sdk.call('fhir_search', {resource_type:'Observation',params:[{name:'subject',value:'Patient/synthetic-a'}],output:sdkOutput});
    assert.equal(control.e.error,undefined); assert.equal(control.e.data.resources.length,1);
    const before = requests.length;
    for (const value of ['Patient/synthetic-a,Patient/synthetic-other','Patient/synthetic-other', '%50atient%2Fsynthetic-other', 'Patient/synthetic-other\\,extra']) {
      const denied = await sdk.call('fhir_search',{resource_type:'Observation',params:[{name:'subject',value}],output:sdkOutput});
      assert.equal(denied.e.error?.code,'POLICY_DENIED'); assert.equal(requests.length,before);
      assert.ok(!JSON.stringify(denied.result).includes('synthetic-other'));
    }
    const token = 'http://example.test/codes|literal\\,comma';
    const escaped = await sdk.call('fhir_search',{resource_type:'Observation',params:[{name:'code',value:token}],output:sdkOutput});
    assert.equal(escaped.e.error,undefined); assert.equal(requests.at(-1)!.searchParams.get('code'),token);
  }));
});
test('gateway acceptance: discovery snapshot drains stable ordered rows without clinical work in both SDK eras', async () => {
  for (const era of ['modern','legacy'] as const) await withGateway({}, (g, requests) => withSdk(g, era, async sdk => {
    const full = await sdk.call('fhir_capabilities',{topic:'search_parameter',resource_type:'Observation',limit:50,output:sdkOutput});
    assert.equal(full.e.error,undefined); const expected = full.e.data.search_parameters;
    const first = await sdk.call('fhir_capabilities',{topic:'search_parameter',resource_type:'Observation',limit:1,output:sdkOutput});
    let e = first.e; const rows = [...e.data.search_parameters]; const seen = new Set<string>();
    while (e.data.next_cursor) {
      assert.ok(!seen.has(e.data.next_cursor)); seen.add(e.data.next_cursor);
      const page = await sdk.call('fhir_capabilities',{topic:'search_parameter',cursor:e.data.next_cursor,limit:1,output:sdkOutput});
      e = page.e; assert.equal(e.error,undefined); assert.equal(e.data.snapshot_revision,first.e.data.snapshot_revision); rows.push(...e.data.search_parameters);
    }
    assert.deepEqual(rows,expected); assert.ok(rows.length>1); assert.ok(seen.size>0);
    assert.equal(requests.length,1); assert.ok(requests[0]!.pathname.endsWith('/metadata'));
  }));
});

test('S6 review: an effectiveInstant record is outside the proved descending-effectiveDateTime variant (unverifiable, never a contradiction)', () => {
  const instant = { resourceType: 'Observation', id: 'synthetic-instant', status: 'final', effectiveInstant: '2025-06-15T08:00:00Z' } as FhirResource;
  const dateTime = { resourceType: 'Observation', id: 'synthetic-datetime', status: 'final', effectiveDateTime: '2025-06-16T08:00:00Z' } as FhirResource;
  assert.deepEqual(validateSortPage([dateTime, instant], ['-date'], 'Observation').outcome, { status: 'unverifiable', parameter: 'date', variant: 'partial-or-unqualified-date' });
  assert.deepEqual(validateSortPage([dateTime], ['-date'], 'Observation').outcome, { status: 'ok' });
});

// Astra review (2026-10-22): fractional seconds beyond the millisecond arithmetic must never be compared, proved or ordered.
test('sub-millisecond fractional seconds are lexically valid but undecidable for equality, unproved as a variant and unverifiable for order', () => {
  const early = parseFhirDateInterval('2024-01-01T00:00:00.0001Z')!, late = parseFhirDateInterval('2024-01-01T00:00:00.0009Z')!;
  assert.ok(early.subMillisecond && late.subMillisecond && early.start === late.start, 'the millisecond arithmetic cannot tell them apart');
  assert.equal(parseFhirDateInterval('2024-01-01T00:00:00.001Z')!.subMillisecond, false);
  const record = (id: string, effectiveDateTime: string) => ({ resourceType: 'Observation', id, status: 'final', effectiveDateTime } as FhirResource);
  assert.equal(dateSearchOutcome(observationEffective(record('a', '2024-01-01T00:00:00.0001Z')) as never, 'eq2024-01-01T00:00:00.0009Z'), undefined, 'distinct sub-millisecond instants are not called equal');
  assert.equal(dateSearchOutcome(observationEffective(record('a', '2024-01-01T00:00:00.000Z')) as never, 'eq2024-01-01T00:00:00.0001Z'), undefined, 'a sub-millisecond search value is undecidable against any record');
  assert.equal(dateSearchOutcome(observationEffective(record('a', '2024-01-01T00:00:00.000Z')) as never, 'eq2024-01-01T00:00:00.000Z'), true);
  assert.equal(filterVariantProved(proofProfile('synthetic-fixture-r4-v1'), 'Observation', 'date', 'ge2024-01-01T00:00:00.0001Z'), false, 'the tested interval variant never claims a sub-millisecond value');
  assert.equal(filterVariantProved(proofProfile('synthetic-fixture-r4-v1'), 'Observation', 'date', 'ge2024-01-01T00:00:00.001Z'), true);
  const ascendingPair = [record('first', '2024-01-01T00:00:00.0001Z'), record('second', '2024-01-01T00:00:00.0009Z')];
  assert.deepEqual(validateSortPage(ascendingPair, ['-date'], 'Observation').outcome, { status: 'unverifiable', parameter: 'date', variant: 'sub-millisecond-precision' }, 'an ascending sub-millisecond pair is never a verified descending order');
  assert.deepEqual(validateSortPage([record('x', '2024-01-01T00:00:00.002Z'), record('y', '2024-01-01T00:00:00.001Z')], ['-date'], 'Observation').outcome, { status: 'ok' });
});
