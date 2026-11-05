import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { searchParameterDataSchema, searchParameterSchema } from '../packages/core/src/contracts.js';
import {
  PINNED_SEARCH_PARAMETER_COUNT, SEARCH_PARAMETER_DEFINITIONS, confinementFor, declaredFromCapability,
  filterSearchParameters, gatewayEnforcedIndicesFor, resolveSearchParameters, reviewedNamesFor, selectFromCatalog, selectPinnedDefinition,
  validatePatientSelectors, validateSearchSyntax, type DeclaredSearchParam, type PinnedDefinition,
} from '../packages/core/src/search-parameters.js';
import {
  advanceDiscoveryCursor, createDiscoveryStore, fitDiscoveryPage, freezeSearchParameterSnapshot,
  normalizedCapabilityRevision, readDiscoverySnapshot, type DiscoveryBinding,
} from '../packages/core/src/discovery.js';
import { buildQueryEvidence, coverageForSnapshot, ProfileState, declaredSearchProfile, noMatchesEligible, searchProfile, splitEscapedList } from '../packages/core/src/query.js';

// Reflection is deliberately confined to the test harness; the production constructor has no candidate argument.
const candidateState = (profile: import('../packages/core/src/query.js').SearchProfile) => {
  const state = new ProfileState();
  (state as unknown as { setCandidateForTest(profile: import('../packages/core/src/query.js').SearchProfile): void }).setCandidateForTest(profile);
  return state;
};
const brandSearchProfileForTest = (profile: import('../packages/core/src/query.js').SearchProfile) => candidateState(profile).profile(profile.id)!;
import { withGateway, withSdk, output as sdkOutput } from './s57-sdk-helpers.js';
import { ResultStore, RetentionLedger } from '../packages/core/src/store.js';

const SP = 'http://hl7.org/fhir/SearchParameter';
const PATIENT = 'synthetic-patient-a';
const OTHER = 'synthetic-patient-b';
const BASE = new URL('http://127.0.0.1:8080/fhir/');
const codeOf = (error: unknown): string => String((error as { code?: string }).code);
const throwsCode = (fn: () => unknown, code: string): void => assert.throws(fn, (error: unknown) => codeOf(error) === code, `expected ${code}`);

const OBS_DECLARED: DeclaredSearchParam[] = [
  { name: 'patient', type: 'reference', definition: `${SP}/clinical-patient`, source_description_present: false },
  { name: 'subject', type: 'reference', definition: `${SP}/Observation-subject`, source_description_present: false },
  { name: 'code', type: 'token', definition: `${SP}/clinical-code`, source_description_present: true },
  { name: 'date', type: 'date', definition: `${SP}/clinical-date`, source_description_present: false },
  { name: 'status', type: 'token', definition: `${SP}/Observation-status`, source_description_present: false },
  { name: 'performer', type: 'reference', definition: `${SP}/Observation-performer`, source_description_present: false },
];
const resolveObs = (declared: DeclaredSearchParam[] = OBS_DECLARED, profile = searchProfile('generic-r4')) =>
  resolveSearchParameters({ resourceType: 'Observation', declared, advertised: true, profile });

test('typed discovery resolves Observation code/date/subject with separate evidence (item 1)', () => {
  const resolved = resolveObs();
  const byName = new Map(resolved.parameters.map(parameter => [parameter.name, parameter]));
  assert.equal(byName.get('code')?.type, 'token');
  assert.equal(byName.get('code')?.definition, `${SP}/clinical-code`);
  assert.equal(byName.get('code')?.definition_evidence, 'pinned_r4');
  assert.equal(byName.get('code')?.executable, true);
  assert.equal(byName.get('date')?.type, 'date');
  assert.deepEqual(byName.get('date')?.comparators.filter(c => ['ge', 'lt'].includes(c.name)).map(c => [c.name, c.executable]), [['ge', true], ['lt', true]]);
  assert.equal(byName.get('subject')?.type, 'reference');
  assert.ok(byName.get('subject')?.targets.includes('Patient'), 'Patient among subject targets');
  assert.equal(byName.get('code')?.evidence, 'declared');
  assert.equal(byName.get('code')?.execution_evidence, 'unknown', 'pinned existence is not execution proof');
  // Reviewed gateway controls appear even when the source omits them.
  for (const control of ['_id', '_lastUpdated', '_sort']) assert.ok(byName.has(control), `control ${control} represented`);
  assert.equal(byName.get('_id')?.definition, `${SP}/Resource-id`, '_id never resolves to the example definition');
  assert.equal(byName.get('_id')?.evidence, 'unknown');
  // Sorted by (name, definition) in codepoint order; every row satisfies the frozen schema.
  const names = resolved.parameters.map(parameter => parameter.name);
  assert.deepEqual(names, [...names].sort());
  for (const parameter of resolved.parameters) assert.equal(searchParameterSchema.safeParse(parameter).success, true, parameter.name);
  const data = {
    resource_type: 'Observation', search_parameters: resolved.parameters, total_parameters: resolved.totalParameters,
    snapshot_revision: 'rev-1', captured_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-01T00:05:00.000Z',
    definitions: SEARCH_PARAMETER_DEFINITIONS,
  };
  assert.equal(searchParameterDataSchema.safeParse(data).success, true);
  assert.equal(PINNED_SEARCH_PARAMETER_COUNT, 1397);
});

test('denied or unadvertised types list no pinned parameters (item 1 decision table)', () => {
  throwsCode(() => resolveSearchParameters({ resourceType: 'Specimen', declared: [], advertised: true }), 'UNSUPPORTED_RESOURCE');
  throwsCode(() => resolveSearchParameters({ resourceType: 'Observation', declared: OBS_DECLARED, advertised: false }), 'UNSUPPORTED_RESOURCE');
});

test('Patient link resolves from R4 with omitted source type; bare ids fail closed (item 1)', () => {
  const declared: DeclaredSearchParam[] = [{ name: 'link', source_description_present: false }];
  const resolved = resolveSearchParameters({ resourceType: 'Patient', declared, advertised: true });
  const link = resolved.byName.get('link')!;
  assert.equal(link.view.type, 'reference', 'missing source type uses the pinned type');
  assert.deepEqual([...link.targetsFull].sort(), ['Patient', 'RelatedPerson']);
  const pairs = (value: string) => [{ name: 'link', value }];
  const validate = (value: string) => validatePatientSelectors({ resourceType: 'Patient', pairs: pairs(value), resolved, patientId: PATIENT, base: BASE, confinementName: '_id' });
  throwsCode(() => validate(OTHER), 'AMBIGUOUS_PATIENT_SELECTOR');
  throwsCode(() => validate(PATIENT), 'AMBIGUOUS_PATIENT_SELECTOR');
  assert.doesNotThrow(() => validate('RelatedPerson/cousin-1'), 'explicit non-Patient target may proceed');
  throwsCode(() => validate(`Patient/${OTHER}`), 'POLICY_DENIED');
});

test('selector positive controls: bound confinement alias and bound reference pass (item 1)', () => {
  const resolved = resolveObs();
  const confinement = confinementFor('Observation', resolved, PATIENT)!;
  assert.deepEqual(confinement, { name: 'patient', value: `Patient/${PATIENT}` });
  const validate = (pairs: { name: string; value: string }[]) =>
    validatePatientSelectors({ resourceType: 'Observation', pairs, resolved, patientId: PATIENT, base: BASE, confinementName: confinement.name });
  assert.doesNotThrow(() => validate([{ name: 'patient', value: PATIENT }]), 'reviewed confinement alias with the trusted id');
  assert.doesNotThrow(() => validate([{ name: 'subject', value: `Patient/${PATIENT}` }]));
  assert.doesNotThrow(() => validate([{ name: 'performer', value: 'Practitioner/dr-1' }]));
  throwsCode(() => validate([{ name: 'performer', value: OTHER }]), 'AMBIGUOUS_PATIENT_SELECTOR');
  throwsCode(() => validate([{ name: 'performer', value: `Patient/${OTHER}` }]), 'POLICY_DENIED');
  throwsCode(() => validate([{ name: 'subject', value: OTHER }]), 'AMBIGUOUS_PATIENT_SELECTOR');
  throwsCode(() => validate([{ name: 'code', value: `Patient/${OTHER}` }]), 'POLICY_DENIED');
});

test('conflicting, unresolved and vendor parameters are listed but unexecutable (item 1)', () => {
  const declared: DeclaredSearchParam[] = [
    { name: 'subject', type: 'token', definition: `${SP}/Observation-subject`, source_description_present: false },
    { name: 'code', type: 'token', definition: `${SP}/Observation-category`, source_description_present: false },
    { name: 'vendor-flag', type: 'token', source_description_present: true },
    { name: 'date', type: 'date', definition: 'http://hl7.org/fhir/SearchParameter/no-such-definition', source_description_present: false },
  ];
  const resolved = resolveObs(declared);
  assert.equal(resolved.byName.get('subject')?.view.definition_evidence, 'conflict');
  assert.equal(resolved.byName.get('subject')?.view.executable, false);
  assert.equal(resolved.byName.get('code')?.view.definition_evidence, 'conflict', 'a conflicting canonical never falls back by name');
  assert.equal(resolved.byName.get('vendor-flag')?.view.definition_evidence, 'source_declared');
  assert.equal(resolved.byName.get('vendor-flag')?.view.description, 'Source-declared parameter; no reviewed definition.');
  assert.equal(resolved.byName.get('date')?.view.definition_evidence, 'unresolved');
  for (const name of ['subject', 'code', 'vendor-flag', 'date']) {
    throwsCode(() => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name, value: 'x' }], resolved }), 'SEARCH_PARAMETER_UNRESOLVED');
  }
  throwsCode(() => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name: 'never-declared', value: 'x' }], resolved }), 'UNSUPPORTED_SEARCH');
  throwsCode(() => confinementFor('Observation', resolved, PATIENT), 'SEARCH_PARAMETER_UNRESOLVED');
});

test('modifiers, joins, chains and composites are refused before fetch (item 1, CA-3)', () => {
  const resolved = resolveObs([
    ...OBS_DECLARED,
    { name: 'code-value-quantity', type: 'composite', definition: `${SP}/Observation-code-value-quantity`, source_description_present: false },
  ]);
  const syntax = (name: string, value = 'x') => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name, value }], resolved });
  throwsCode(() => syntax('code:text', 'diabetes'), 'UNSUPPORTED_MODIFIER');
  throwsCode(() => syntax('_include', 'Observation:patient'), 'UNSUPPORTED_SEARCH');
  throwsCode(() => syntax('_revinclude', 'DiagnosticReport:result'), 'UNSUPPORTED_SEARCH');
  throwsCode(() => syntax('_has', 'Observation:code'), 'UNSUPPORTED_SEARCH');
  throwsCode(() => syntax('subject.name', 'x'), 'UNSUPPORTED_SEARCH');
  throwsCode(() => syntax('code-value-quantity', 'a$b'), 'UNSUPPORTED_SEARCH');
});

test('comparators require a pinned list; malformed dates are INVALID_ARGUMENTS (CA-3)', () => {
  // Patient `age` is the one supported-type number parameter whose pinned
  // definition declares no comparator list: only unprefixed syntax is allowed.
  const resolved = resolveSearchParameters({
    resourceType: 'Patient',
    declared: [{ name: 'age', type: 'number', definition: `${SP}/patient-extensions-Patient-age`, source_description_present: false }],
    advertised: true,
  });
  assert.deepEqual(resolved.byName.get('age')?.comparators, undefined, 'pinned list is absent');
  throwsCode(() => validateSearchSyntax({ resourceType: 'Patient', pairs: [{ name: 'age', value: 'ge30' }], resolved }), 'UNSUPPORTED_COMPARATOR');
  assert.doesNotThrow(() => validateSearchSyntax({ resourceType: 'Patient', pairs: [{ name: 'age', value: '30' }], resolved }));
  const obs = resolveObs();
  throwsCode(() => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name: 'date', value: 'ge2026-13-01' }], resolved: obs }), 'INVALID_ARGUMENTS');
  // Prefixes are never parsed on token values: a token spelled like a date stays data.
  assert.doesNotThrow(() => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name: 'code', value: 'ge2026-13-01' }], resolved: obs }));
});

test('sort validation: one occurrence, reviewed keys only (item 1)', () => {
  const resolved = resolveObs();
  const ok = validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name: '_sort', value: '-date' }], resolved });
  assert.deepEqual(ok.sortRequested, ['-date']);
  assert.deepEqual(ok.materialPairs, []);
  throwsCode(() => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name: '_sort', value: '-date' }, { name: '_sort', value: 'code' }], resolved }), 'UNSUPPORTED_SORT');
  throwsCode(() => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name: '_sort', value: 'performer' }], resolved }), 'UNSUPPORTED_SORT');
  throwsCode(() => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name: '_sort', value: 'date,date' }], resolved }), 'UNSUPPORTED_SORT');
  throwsCode(() => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name: '_sort', value: 'a,b,c,d,e' }], resolved }), 'UNSUPPORTED_SORT');
});

test('escaped lists keep literal commas, pipes and backslashes (CA-8, CA-ISO-01)', () => {
  assert.deepEqual(splitEscapedList('a\\,b,c'), ['a,b', 'c']);
  const combined = 'http://loinc.org|4548-4,http://example.test/codes|local\\,hba1c';
  const wire = new URLSearchParams([['code', combined]]).toString();
  const decodedOnce = new URLSearchParams(wire).get('code')!;
  assert.equal(decodedOnce, combined, 'exact value after one URL decode');
  assert.deepEqual(splitEscapedList(decodedOnce), ['http://loinc.org|4548-4', 'http://example.test/codes|local,hba1c'], 'two alternatives, not three');
  assert.deepEqual(splitEscapedList('sys\\|tem|code'), ['sys|tem|code']);
  assert.deepEqual(splitEscapedList('a\\\\b'), ['a\\b']);
});

test('default generic-r4 HbA1c query is admitted with unknown execution (item 1)', () => {
  const resolved = resolveObs();
  const callerPairs = [
    { name: 'code', value: 'http://loinc.org|4548-4' },
    { name: 'date', value: 'ge2020-01-01' },
    { name: 'date', value: 'lt2026-01-01' },
    { name: '_sort', value: '-date' },
  ];
  const validated = validateSearchSyntax({ resourceType: 'Observation', pairs: callerPairs, resolved });
  const confinement = confinementFor('Observation', resolved, PATIENT)!;
  validatePatientSelectors({ resourceType: 'Observation', pairs: callerPairs.filter(p => p.name !== '_sort'), resolved, patientId: PATIENT, base: BASE, confinementName: confinement.name });
  const outbound = [...validated.materialPairs, confinement];
  const url = new URL('Observation', BASE);
  for (const pair of [...outbound, { name: '_sort', value: '-date' }, { name: '_count', value: '20' }]) url.searchParams.append(pair.name, pair.value);
  assert.deepEqual(url.searchParams.getAll('date'), ['ge2020-01-01', 'lt2026-01-01'], 'repeated dates survive encoding');
  assert.equal(url.searchParams.get('code'), 'http://loinc.org|4548-4');
  assert.equal(url.searchParams.get('patient'), `Patient/${PATIENT}`);
  const evidence = buildQueryEvidence({
    resourceType: 'Observation', pairs: outbound, sortRequested: validated.sortRequested,
    selfPairs: [...outbound, { name: '_sort', value: '-date' }],
    profile: searchProfile('generic-r4'),
    gatewayEnforcedIndices: gatewayEnforcedIndicesFor({ pairs: outbound, confinementIndex: outbound.length - 1, patientId: PATIENT, base: BASE, confinementName: confinement.name, resourceType: 'Observation' }),
    sourceRevision: 'rev-1', policyRevision: 'synthetic-v1', contextHandle: 'ctx-1',
  });
  assert.equal(evidence.materialFilterProved, false, 'echoed self link does not prove execution');
  const coverage = coverageForSnapshot(evidence, {
    deliveredCount: 1, pagesObserved: 1, queryEvidence: evidence, sortProof: 'none',
    remainder: 'none', exhausted: true, scope: 'page', authorizationLimited: true,
  });
  assert.equal(coverage.state, 'unknown');
  assert.ok(coverage.reasons.includes('FILTER_EXECUTION_UNVERIFIED'));
  assert.equal(coverage.sort?.order, 'requested_unverified');
  assert.equal(coverage.sort?.effective, null);
});

test('source documentation canaries never reach declarations, views or snapshots (item 1)', () => {
  const canary = 'Q-CANARY-DOCUMENTATION-9f2c';
  const declared = declaredFromCapability([
    { name: 'code', type: 'token', definition: `${SP}/clinical-code`, documentation: `trust me ${canary}` },
    { name: 'evil name', type: 'token', documentation: canary },
  ]);
  assert.equal(declared.length, 1);
  assert.equal(declared[0]?.source_description_present, true);
  assert.ok(!JSON.stringify(declared).includes(canary));
  const resolved = resolveSearchParameters({ resourceType: 'Observation', declared, advertised: true });
  assert.ok(!JSON.stringify(resolved.parameters).includes(canary));
  assert.deepEqual(filterSearchParameters(resolved.parameters, { query: canary }), [], 'substring search never examines source documentation');
  const ledger = new RetentionLedger(10 * 1024 * 1024);
  const store = createDiscoveryStore({ ledger });
  const binding: DiscoveryBinding = { sourceAlias: 'local', contextHandle: 'ctx-1', policyRevision: 'synthetic-v1', authEpoch: 0, sourceRevision: 'rev-1' };
  const frozen = freezeSearchParameterSnapshot(store, {
    topic: 'search_parameter', resourceType: 'Observation', revision: 'rev-1',
    capturedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:05:00.000Z',
    binding, filter: {}, parameters: resolved.parameters, totalParameters: resolved.totalParameters,
  });
  const read = readDiscoverySnapshot(store, frozen.handle, binding, 'search_parameter');
  assert.ok(!JSON.stringify(read.value).includes(canary));
  store.close();
});

test('protected definition URLs are withheld and never fetched (item 1)', () => {
  const declared = declaredFromCapability([
    { name: 'code', type: 'token', definition: 'https://defs.invalid/sp?access_token=Q-SECRET', documentation: 'x' },
  ]);
  assert.equal(declared[0]?.definition, undefined);
  assert.equal(declared[0]?.definition_withheld, true);
  const resolved = resolveSearchParameters({ resourceType: 'Observation', declared, advertised: true });
  assert.equal(resolved.byName.get('code')?.view.definition_evidence, 'unresolved');
  assert.equal(resolved.byName.get('code')?.view.executable, false);
  assert.ok(!JSON.stringify(resolved.parameters).includes('Q-SECRET'));
  const source = readFileSync(new URL('../packages/core/src/search-parameters.ts', import.meta.url), 'utf8');
  assert.ok(!/\bfetch\s*\(|from '\.\/transport\.js'.*FhirTransport|controlledFetch/.test(source), 'resolution performs no definition fetch');
  assert.equal(selectPinnedDefinition('Observation', 'code', `${SP}/clinical-code`).status, 'selected');
  assert.equal(selectPinnedDefinition('Observation', 'code', `${SP}/clinical-code`, true).status, 'unresolved');
});

test('discovery snapshots freeze order, shrink to budget and drain without skips (item 1)', () => {
  const resolved = resolveObs();
  const ledger = new RetentionLedger(10 * 1024 * 1024);
  const store = createDiscoveryStore({ ledger });
  const binding: DiscoveryBinding = { sourceAlias: 'local', contextHandle: 'ctx-1', policyRevision: 'synthetic-v1', authEpoch: 0, sourceRevision: 'rev-1' };
  const frozen = freezeSearchParameterSnapshot(store, {
    topic: 'search_parameter', resourceType: 'Observation', revision: 'rev-1',
    capturedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:05:00.000Z',
    binding, filter: {}, parameters: resolved.parameters, totalParameters: resolved.totalParameters,
  });
  const drained: string[] = [];
  let cursor = frozen.handle;
  for (let guard = 0; guard < 20; guard++) {
    const { value } = readDiscoverySnapshot(store, cursor, binding, 'search_parameter');
    const fitted = fitDiscoveryPage(value.parameters, value.offset ?? 0, 3, 4096);
    drained.push(...fitted.page.map(parameter => parameter.name));
    if (fitted.nextOffset === undefined) break;
    cursor = advanceDiscoveryCursor(store, cursor, binding, 'search_parameter', fitted.nextOffset).handle;
  }
  assert.deepEqual(drained, resolved.parameters.map(parameter => parameter.name), 'every row exactly once, in frozen order');
  // Tiny budgets shrink pages; one indivisible row refuses instead of truncating.
  const tiny = fitDiscoveryPage(resolved.parameters, 0, 50, 1200);
  assert.ok(tiny.page.length >= 1 && tiny.page.length < resolved.parameters.length);
  throwsCode(() => fitDiscoveryPage(resolved.parameters, 0, 1, 32), 'OUTPUT_LIMIT');
  store.close();
});

test('discovery cursors are binding-, topic- and store-bound with absolute expiry (item 1, CA-ISO-02)', () => {
  let now = 1000000;
  const ledger = new RetentionLedger(10 * 1024 * 1024);
  const store = createDiscoveryStore({ ledger, ttlMs: 1000, now: () => now });
  const binding: DiscoveryBinding = { sourceAlias: 'local', contextHandle: 'ctx-1', policyRevision: 'synthetic-v1', authEpoch: 0, sourceRevision: 'rev-1' };
  const resolved = resolveObs();
  const frozen = freezeSearchParameterSnapshot(store, {
    topic: 'search_parameter', resourceType: 'Observation', revision: 'rev-1',
    capturedAt: new Date(now).toISOString(), expiresAt: new Date(now + 1000).toISOString(),
    binding, filter: {}, parameters: resolved.parameters, totalParameters: resolved.totalParameters,
  });
  assert.doesNotThrow(() => readDiscoverySnapshot(store, frozen.handle, binding, 'search_parameter'));
  throwsCode(() => readDiscoverySnapshot(store, frozen.handle, { ...binding, contextHandle: 'ctx-other' }, 'search_parameter'), 'DISCOVERY_EXPIRED');
  throwsCode(() => readDiscoverySnapshot(store, frozen.handle, { ...binding, authEpoch: 1 }, 'search_parameter'), 'DISCOVERY_EXPIRED');
  throwsCode(() => readDiscoverySnapshot(store, frozen.handle, binding, 'support'), 'DISCOVERY_EXPIRED');
  throwsCode(() => readDiscoverySnapshot(store, 'cur_nonexistent', binding, 'search_parameter'), 'DISCOVERY_EXPIRED');
  const clinical = new ResultStore(1024 * 1024, 10, 60000);
  assert.throws(() => clinical.get(frozen.handle), 'a discovery cursor never resolves in the clinical store');
  clinical.close();
  now += 1001;
  throwsCode(() => readDiscoverySnapshot(store, frozen.handle, binding, 'search_parameter'), 'DISCOVERY_EXPIRED');
  store.close();
});

test('discovery quota evicts oldest metadata cursors and recovers (item 1)', () => {
  const ledger = new RetentionLedger(10 * 1024 * 1024);
  const store = createDiscoveryStore({ ledger, maxHandles: 2 });
  const binding: DiscoveryBinding = { sourceAlias: 'local', contextHandle: 'ctx-1', policyRevision: 'synthetic-v1', authEpoch: 0, sourceRevision: 'rev-1' };
  const make = (revision: string) => freezeSearchParameterSnapshot(store, {
    topic: 'search_parameter', resourceType: 'Observation', revision,
    capturedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:05:00.000Z',
    binding: { ...binding, sourceRevision: revision }, filter: {}, parameters: [], totalParameters: 0,
  });
  const first = make('rev-a');
  make('rev-b');
  const third = make('rev-c');
  throwsCode(() => readDiscoverySnapshot(store, first.handle, { ...binding, sourceRevision: 'rev-a' }, 'search_parameter'), 'DISCOVERY_EXPIRED');
  assert.doesNotThrow(() => readDiscoverySnapshot(store, third.handle, { ...binding, sourceRevision: 'rev-c' }, 'search_parameter'), 'fresh metadata is admitted after eviction');
  store.close();
});

test('normalized capability revision ignores order, changes only on material edits (CA-3)', () => {
  const caps = [
    { type: 'Observation', interactions: ['search-type', 'read'], declared: OBS_DECLARED },
    { type: 'Patient', interactions: ['read'], declared: [{ name: '_id', type: 'token', source_description_present: false }] },
  ];
  const shuffled = [
    { type: 'Patient', interactions: ['read'], declared: [{ name: '_id', type: 'token', source_description_present: true }] },
    { type: 'Observation', interactions: ['read', 'search-type', 'read'], declared: [...OBS_DECLARED].reverse() },
  ];
  assert.equal(normalizedCapabilityRevision('4.0.1', shuffled), normalizedCapabilityRevision('4.0.1', caps), 'array order and documentation presence do not invalidate');
  const material = [{ type: 'Observation', interactions: ['read', 'search-type'], declared: OBS_DECLARED.map(p => p.name === 'date' ? { ...p, type: 'token' } : p) }, caps[1]!];
  assert.notEqual(normalizedCapabilityRevision('4.0.1', material), normalizedCapabilityRevision('4.0.1', caps), 'a type change invalidates');
  assert.notEqual(normalizedCapabilityRevision('4.0.2', caps), normalizedCapabilityRevision('4.0.1', caps), 'a FHIR version change invalidates');
});

test('reviewed names expose only pinned selections to repair advice (items 1-2)', () => {
  const resolved = resolveObs([...OBS_DECLARED, { name: 'vendor-flag', type: 'token', source_description_present: false }]);
  const reviewed = reviewedNamesFor(new Map([['Observation', resolved]]), new Set(['Observation']));
  assert.equal(reviewed.resource('Observation'), true);
  assert.equal(reviewed.resource('Specimen'), false);
  assert.equal(reviewed.parameter('Observation', 'code'), true);
  assert.equal(reviewed.parameter('Observation', 'vendor-flag'), false, 'source-only names never enter advice');
  assert.equal(reviewed.parameter('Observation', '_sort'), true, 'reviewed gateway control');
  // Repetition refusal branch: explicit multipleOr=false refuses comma-OR.
  const fake = {
    parameters: [], totalParameters: 0,
    byName: new Map([['code', { view: resolved.byName.get('code')!.view, targetsFull: [], multipleOr: false, control: false }]]),
  };
  throwsCode(() => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name: 'code', value: 'a|1,b|2' }], resolved: fake as never }), 'UNSUPPORTED_SEARCH');
});

test('Q-1: 34 alternatives refuse before any request on subject/patient/code/date; 33 bound-only passes', () => {
  const resolved = resolveObs();
  const confinement = confinementFor('Observation', resolved, PATIENT)!;
  const extra = (n: number) => Array.from({ length: n }, (_, i) => `x${i}`).join(',');
  const overflowForeign = `Patient/${OTHER},${extra(33)}`; // 34 alternatives
  for (const name of ['subject', 'patient'] as const) {
    throwsCode(() => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name, value: overflowForeign }], resolved }), 'INVALID_ARGUMENTS');
    throwsCode(() => validatePatientSelectors({ resourceType: 'Observation', pairs: [{ name, value: overflowForeign }], resolved, patientId: PATIENT, base: BASE, confinementName: confinement.name }), 'AMBIGUOUS_PATIENT_SELECTOR');
  }
  throwsCode(() => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name: 'code', value: overflowForeign }], resolved }), 'INVALID_ARGUMENTS');
  throwsCode(() => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name: 'date', value: extra(34) }], resolved }), 'INVALID_ARGUMENTS');
  // 33 bound-only alternatives stay checkable and pass both validators.
  const bound33 = Array.from({ length: 33 }, () => `Patient/${PATIENT}`).join(',');
  assert.doesNotThrow(() => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name: 'subject', value: bound33 }], resolved }));
  assert.doesNotThrow(() => validatePatientSelectors({ resourceType: 'Observation', pairs: [{ name: 'subject', value: bound33 }], resolved, patientId: PATIENT, base: BASE, confinementName: confinement.name }));
  // With 32 extra (33 total) the foreign head is still seen and denied.
  throwsCode(() => validatePatientSelectors({ resourceType: 'Observation', pairs: [{ name: 'subject', value: `Patient/${OTHER},${extra(32)}` }], resolved, patientId: PATIENT, base: BASE, confinementName: confinement.name }), 'POLICY_DENIED');
  throwsCode(() => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name: 'code', value: 'xx\\xx' }], resolved }), 'INVALID_ARGUMENTS');
});

test('Q-7: malformed, duplicate and late declarations fail closed, never by name', () => {
  const overlong = declaredFromCapability([{ name: 'patient', type: 'reference', definition: `http://hl7.org/fhir/SearchParameter/clinical-patient${'x'.repeat(600)}` }]);
  assert.equal(overlong[0]?.definition_withheld, true);
  const overlongResolved = resolveObs(overlong);
  assert.equal(overlongResolved.byName.get('patient')?.view.definition_evidence, 'unresolved', 'overlong canonical never falls back to pinned name');
  assert.equal(overlongResolved.byName.get('patient')?.view.executable, false);
  const nonString = declaredFromCapability([{ name: 'patient', type: 'reference', definition: 42 }]);
  assert.equal(nonString[0]?.definition_withheld, true);
  assert.equal(resolveObs(nonString).byName.get('patient')?.view.executable, false);
  const badType = declaredFromCapability([{ name: 'code', type: 42, definition: `${SP}/clinical-code` }]);
  assert.equal(badType[0]?.type_invalid, true);
  assert.equal(resolveObs(badType).byName.get('code')?.view.definition_evidence, 'conflict');
  assert.equal(resolveObs(badType).byName.get('code')?.view.executable, false);
  const duplicate = declaredFromCapability([
    { name: 'code', type: 'token', definition: `${SP}/clinical-code` },
    { name: 'code', type: 'string', definition: `${SP}/clinical-code` },
  ]);
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0]?.duplicate_conflict, true);
  assert.equal(resolveObs(duplicate).byName.get('code')?.view.executable, false, 'differing duplicate never silently keeps the first');
  const late = declaredFromCapability([
    ...Array.from({ length: 300 }, (_, i) => ({ name: `filler-${i}`, type: 'token' })),
    { name: 'patient', type: 'reference', definition: `${SP}/clinical-patient` },
  ]);
  assert.ok(late.some(entry => entry.name === 'patient'), 'confinement beyond entry 256 still resolves');
  assert.equal(selectPinnedDefinition('Observation', 'patient', `${SP}/clinical-patient|4.0.1`).status, 'selected', 'pinned version suffix accepted');
  assert.equal(selectPinnedDefinition('Observation', 'patient', `${SP}/clinical-patient|9.9`).status, 'unresolved', 'foreign version fails closed');
});

test('Q-8/Q-18: _query is never executable; comparators and sort whitespace stay honest', () => {
  const resolved = resolveObs([...OBS_DECLARED, { name: '_query', type: 'token', source_description_present: false }]);
  assert.equal(resolved.byName.get('_query')?.view.executable, false, 'named queries list unexecutable even when pinned');
  throwsCode(() => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name: '_query', value: 'everything' }], resolved }), 'UNSUPPORTED_SEARCH');
  const conflicted = resolveObs([{ name: 'date', type: 'token', definition: `${SP}/clinical-date`, source_description_present: false }]);
  assert.equal(conflicted.byName.get('date')?.view.executable, false);
  assert.ok(conflicted.byName.get('date')!.view.comparators.every(c => !c.executable), 'Q-18a: unexecutable parameter has no executable comparators');
  throwsCode(() => validateSearchSyntax({ resourceType: 'Observation', pairs: [{ name: '_sort', value: ' -date' }], resolved: resolveObs() }), 'UNSUPPORTED_SORT');
  // r-ambiguous-name-picks-first via an injected colliding catalog.
  const colliding: PinnedDefinition[] = [
    { url: 'http://hl7.org/fhir/SearchParameter/a-code', code: 'code', base: ['Observation'], type: 'token' },
    { url: 'http://hl7.org/fhir/SearchParameter/b-code', code: 'code', base: ['Observation'], type: 'token' },
  ];
  assert.equal(selectFromCatalog(colliding, 'Observation', 'code').status, 'conflict', 'ambiguous name never picks the first');
});

test('Q-9/Q-5: foreign hosts, unknown targets, Group confinement and enforced indices discriminate', () => {
  const resolved = resolveObs();
  const confinement = confinementFor('Observation', resolved, PATIENT)!;
  const validate = (pairs: { name: string; value: string }[], over: Partial<Parameters<typeof validatePatientSelectors>[0]> = {}) =>
    validatePatientSelectors({ resourceType: 'Observation', pairs, resolved, patientId: PATIENT, base: BASE, confinementName: confinement.name, ...over });
  // r-foreign-absolute-allowed
  throwsCode(() => validate([{ name: 'subject', value: `http://evil.example/fhir/Patient/${PATIENT}` }]), 'POLICY_DENIED');
  assert.doesNotThrow(() => validate([{ name: 'subject', value: `http://127.0.0.1:8080/fhir/Patient/${PATIENT}` }]), 'same-host absolute bound reference is the positive control');
  // r-unknown-targets-unrestricted: empty targets still fail bare ids closed.
  const codeEntry = resolved.byName.get('code')!;
  const performerEntry = resolved.byName.get('performer')!;
  const unknownTargets = {
    parameters: [], totalParameters: 0,
    byName: new Map([['performer', { ...performerEntry, targetsFull: [] }], ['code', codeEntry]]),
  };
  throwsCode(() => validatePatientSelectors({ resourceType: 'Observation', pairs: [{ name: 'performer', value: OTHER }], resolved: unknownTargets as never, patientId: PATIENT, base: BASE }), 'AMBIGUOUS_PATIENT_SELECTOR');
  // r-confinement-target-unchecked
  const groupOnly = {
    parameters: [], totalParameters: 0,
    byName: new Map([['patient', { ...resolved.byName.get('patient')!, targetsFull: ['Group'] }]]),
  };
  throwsCode(() => confinementFor('Observation', groupOnly as never, PATIENT), 'SEARCH_PARAMETER_UNRESOLVED');
  // Q-5 helper: bound caller occurrence enforced, Group occurrence not.
  const outbound = [
    { name: 'patient', value: `Patient/${PATIENT}` },
    { name: 'patient', value: 'Group/g' },
    { name: 'patient', value: `Patient/${PATIENT}` },
  ];
  const enforced = gatewayEnforcedIndicesFor({ pairs: outbound, confinementIndex: 2, patientId: PATIENT, base: BASE, confinementName: 'patient', resourceType: 'Observation' });
  assert.deepEqual([...enforced].sort(), [0, 2]);
});

test('R2-1: only linkage names are gateway-enforced; performer/focus/token-code never complete a query', () => {
  const confinement = { name: 'patient', value: `Patient/${PATIENT}` };
  const enforcedFor = (callerName: string, callerValue: string) => gatewayEnforcedIndicesFor({
    pairs: [{ name: callerName, value: callerValue }, confinement],
    confinementIndex: 1, patientId: PATIENT, base: BASE, confinementName: 'patient', resourceType: 'Observation',
  });
  assert.deepEqual([...enforcedFor('performer', `Patient/${PATIENT}`)], [1], 'performer=Patient/<bound> is not enforced');
  assert.deepEqual([...enforcedFor('focus', `Patient/${PATIENT}`)], [1], 'focus=Patient/<bound> is not enforced');
  assert.deepEqual([...enforcedFor('code', `Patient/${PATIENT}`)], [1], 'token code=Patient/<bound> is not enforced');
  assert.deepEqual([...enforcedFor('status', `Patient/${PATIENT}`)], [1], 'any non-linkage name is not enforced');
  // Positive controls: both reviewed linkage names for Observation.
  assert.deepEqual([...enforcedFor('subject', `Patient/${PATIENT}`)].sort(), [0, 1], 'subject is the Observation patient link');
  assert.deepEqual([...enforcedFor('patient', `Patient/${PATIENT}`)].sort(), [0, 1], 'patient is the confinement name');
  assert.deepEqual([...enforcedFor('subject', `Patient/${OTHER}`)], [1], 'a foreign value on a linkage name is still not enforced');
  // Completeness consequence under generic-r4 (reviewer probe): a source
  // ignoring performer must not yield complete_for_query / linkage proof.
  const pairs = [{ name: 'performer', value: `Patient/${PATIENT}` }, confinement];
  const evidence = buildQueryEvidence({
    resourceType: 'Observation', pairs, selfPairs: [...pairs],
    profile: searchProfile('generic-r4'),
    gatewayEnforcedIndices: gatewayEnforcedIndicesFor({ pairs, confinementIndex: 1, patientId: PATIENT, base: BASE, confinementName: 'patient', resourceType: 'Observation' }),
    sourceRevision: 'r', policyRevision: 'p', contextHandle: 'c',
  });
  assert.equal(evidence.constraints[0]?.execution, 'unknown');
  assert.equal(evidence.materialFilterProved, false);
  const terminalZero = coverageForSnapshot(evidence, {
    deliveredCount: 0, pagesObserved: 1, queryEvidence: evidence, sortProof: 'none',
    remainder: 'none', exhausted: true, scope: 'page', authorizationLimited: true,
  });
  assert.equal(terminalZero.state, 'unknown', 'terminal zero with an unproved performer filter is never complete_for_query');
  assert.equal(terminalZero.query_evidence, 'declared_and_self_link_only');
  // NO_MATCHES keeps its frozen terminal rule, but now only as an
  // unknown-labelled (unverified-suffix) hint, never on a proved basis.
  assert.equal(noMatchesEligible(terminalZero, 0, true), true);
  // Positive control: confinement-only terminal zero stays complete linkage.
  const linkagePairs = [confinement];
  const linkageEvidence = buildQueryEvidence({
    resourceType: 'Observation', pairs: linkagePairs, selfPairs: [...linkagePairs],
    profile: searchProfile('generic-r4'),
    gatewayEnforcedIndices: gatewayEnforcedIndicesFor({ pairs: linkagePairs, confinementIndex: 0, patientId: PATIENT, base: BASE, confinementName: 'patient', resourceType: 'Observation' }),
    sourceRevision: 'r', policyRevision: 'p', contextHandle: 'c',
  });
  const linkageCoverage = coverageForSnapshot(linkageEvidence, {
    deliveredCount: 0, pagesObserved: 1, queryEvidence: linkageEvidence, sortProof: 'none',
    remainder: 'none', exhausted: true, scope: 'page', authorizationLimited: true,
  });
  assert.equal(linkageCoverage.state, 'complete_for_query');
  assert.equal(linkageCoverage.query_evidence, 'exact_id_and_subject_linkage');
});

test('R2-4: each permission flag flip changes the normalized capability revision', () => {
  const baseParam: DeclaredSearchParam = { name: 'date', type: 'date', definition: `${SP}/clinical-date`, source_description_present: false };
  const revisionWith = (param: DeclaredSearchParam) => normalizedCapabilityRevision('4.0.1', [
    { type: 'Observation', interactions: ['read', 'search-type'], declared: [param] },
  ]);
  const base = revisionWith(baseParam);
  assert.notEqual(revisionWith({ ...baseParam, definition_withheld: true }), base, 'withheld-canonical flip invalidates');
  assert.notEqual(revisionWith({ ...baseParam, type_invalid: true }), base, 'invalid-type flip invalidates');
  assert.notEqual(revisionWith({ ...baseParam, duplicate_conflict: true }), base, 'duplicate-conflict flip invalidates');
  // Absent and explicit-false flags normalize identically (booleans only).
  assert.equal(revisionWith({ ...baseParam, definition_withheld: false, type_invalid: false, duplicate_conflict: false }), base);
  // The withheld VALUE never enters the revision: two different withheld
  // declarations with the same boolean shape share one revision.
  assert.equal(
    revisionWith({ name: 'date', type: 'date', source_description_present: false, definition_withheld: true }),
    revisionWith({ name: 'date', type: 'date', source_description_present: true, definition_withheld: true }),
  );
});

test('R2-2: discovery execution_evidence requires a branded profile', () => {
  const raw = declaredSearchProfile('synthetic-fixture-r4-v1');
  assert.equal(resolveObs(OBS_DECLARED, raw).byName.get('code')?.view.execution_evidence, 'unknown', 'raw declared profile never shows observed support');
  const branded = brandSearchProfileForTest({
    ...declaredSearchProfile('synthetic-fixture-r4-v1')!,
    eligible: true, evidence: { report_sha256: 'c'.repeat(64), recorded_at: '2026-01-01T00:00:00.000Z' },
  });
  assert.equal(resolveObs(OBS_DECLARED, branded).byName.get('code')?.view.execution_evidence, 'observed_supported', 'branded positive control');
});

// W0 closes through the sole production factory and actual SDK in both eras.
test('W0 integration: overflow foreign selector refused before fetch on the wired gateway', async () => {
  for (const era of ['modern','legacy'] as const) await withGateway({}, (g, requests) => withSdk(g, era, async sdk => {
    const control = await sdk.call('fhir_search', { resource_type: 'Observation', params: [{ name: 'patient', value: 'Patient/synthetic-a' }], output: sdkOutput });
    assert.equal(control.e.error, undefined); assert.equal(control.e.data.resources.length, 1);
    assert.equal(requests.filter(u => !u.pathname.endsWith('/metadata')).length, 1);
    const query = requests.at(-1)!.searchParams;
    assert.deepEqual(query.getAll('patient'), ['Patient/synthetic-a','Patient/synthetic-a'], 'independent confinement is always appended, including the original occurrence');
    const before = requests.length;
    for (const params of [[{ name: 'subject', value: ['Patient/synthetic-other', ...Array.from({length:33}, (_,i) => `x${i}`)].join(',') }], [{name:'patient',value:'Patient/synthetic-other'}]]) {
      const denied = await sdk.call('fhir_search', {resource_type:'Observation',params,output:sdkOutput});
      assert.equal(denied.e.error?.code, params[0]!.value.includes(',') ? 'INVALID_ARGUMENTS' : 'POLICY_DENIED'); assert.deepEqual(denied.e.data, {});
      assert.equal(requests.length, before, 'selector denial has zero additional total and clinical work');
      assert.ok(!JSON.stringify(denied.result).includes('synthetic-other'));
    }
  }));
});
