import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LAB_EVIDENCE_RECIPE_ID, RECIPE_IDS, supportDataSchema, supportRowSchema, type FhirResource } from '../packages/core/src/contracts.js';
import {
  SEARCH_PARAMETER_DEFINITIONS,
} from '../packages/core/src/search-parameters.js';
import {
  SUPPORT_DENOMINATOR, SUPPORT_MATRIX_REVISION, SUPPORT_POLICY_REVISION, classifiedTypes, effectiveSupport,
  supportForType, supportMatrixDrift, workflowSupport, type SupportMatrixFile, type SupportRow,
} from '../packages/core/src/support.js';
import {
  advanceDiscoveryCursor, createDiscoveryStore, fitDiscoveryPage, freezeSupportSnapshot,
  readDiscoverySnapshot, type DiscoveryBinding, type SupportSnapshotValue,
} from '../packages/core/src/discovery.js';
import { authorized, resourceClass } from '../packages/core/src/privacy.js';
import { projectSanitized } from '../packages/core/src/projection.js';
import { RetentionLedger } from '../packages/core/src/store.js';

const PATIENT = 'synthetic-patient-a';
const BASE = new URL('http://127.0.0.1:8080/fhir/');
const PATIENT_TYPES = ['Patient', 'Observation', 'Condition', 'AllergyIntolerance', 'MedicationRequest', 'MedicationStatement', 'Encounter', 'DocumentReference', 'DiagnosticReport', 'Immunization', 'Procedure', 'Coverage', 'ExplanationOfBenefit', 'ServiceRequest', 'Claim'];
const SHARED_TYPES = ['Medication', 'Organization', 'Location', 'Practitioner', 'CodeSystem', 'ValueSet', 'StructureDefinition', 'SearchParameter', 'CapabilityStatement', 'OperationDefinition'];
const bundledMatrix = (): SupportMatrixFile => JSON.parse(readFileSync(new URL('../packages/core/src/data/support-matrix.json', import.meta.url), 'utf8'));

test('support matrix names the exact 25 classified types and workflow minimum (item 6)', () => {
  assert.deepEqual(supportMatrixDrift(), [], 'manifest equals the enforcement exports');
  assert.deepEqual(classifiedTypes(), [...PATIENT_TYPES, ...SHARED_TYPES]);
  const workflow = workflowSupport();
  assert.equal(workflow.workflow, 'recent-labs-v1');
  assert.deepEqual(workflow.required_resources, ['Patient', 'Observation']);
  assert.equal(workflow.document_support, 'metadata_only');
  assert.deepEqual(workflow.clinical_sections, [], 'zero clinical sections in M3b');
  assert.equal(SUPPORT_MATRIX_REVISION, 'support-matrix/2');
  assert.equal(SUPPORT_POLICY_REVISION, '2026-10-19.1', 'Q-15: manifest records the enforcement policy revision');
  // Contract request 1 / Q-15: 120-char cap kept; summaries state the real policy.
  assert.equal(supportForType('Medication').instance_policy, 'Catalog products only; no identifier/batch; any code fully coded; coded product for ingredients.');
  for (const type of ['CodeSystem', 'ValueSet', 'StructureDefinition', 'SearchParameter', 'CapabilityStatement', 'OperationDefinition']) {
    assert.equal(supportForType(type).instance_policy, 'Base R4 elements only; no profiles, security labels or extensions.', type);
  }
  for (const type of classifiedTypes()) assert.ok(supportForType(type).instance_policy.length <= 120, type);
  assert.equal(supportForType('Observation').patient_link, 'subject');
  assert.equal(supportForType('AllergyIntolerance').patient_link, 'patient');
  assert.equal(supportForType('Coverage').patient_link, 'beneficiary');
  assert.equal(supportForType('DiagnosticReport').workflow_role, 'optional');
});

test('S7 support compact recipes follow the active gateway projector for every row', () => {
  const bundled = bundledMatrix();
  const record = (resourceType: string) => ({
    resource: { resourceType }, retrievedAt: '2026-10-23T00:00:00Z', policyOmitted: [],
    withheldReasons: [], requiresStructuralView: false,
  });
  assert.deepEqual(supportMatrixDrift(bundled), [], 'positive control');
  assert.equal(projectSanitized(record('Observation'), 'compact').meta.recipe_id, LAB_EVIDENCE_RECIPE_ID);
  assert.equal(supportForType('Observation').compact_recipe, LAB_EVIDENCE_RECIPE_ID);
  assert.notEqual(supportForType('Observation').compact_recipe, RECIPE_IDS.Observation, 'the helper recipe is not the gateway recipe');
  for (const row of bundled.rows) {
    const actual = projectSanitized(record(row.resource_type), 'compact').meta.recipe_id ?? null;
    assert.equal(supportForType(row.resource_type).compact_recipe, actual, row.resource_type);
    const stale = row.compact_recipe === null ? RECIPE_IDS.Observation : null;
    assert.deepEqual(supportMatrixDrift({
      ...bundled, rows: bundled.rows.map(other => other === row ? { ...other, compact_recipe: stale } : other),
    }), [`${row.resource_type}: compact_recipe disagrees with gateway projection`], row.resource_type);
  }
  assert.deepEqual(supportMatrixDrift({
    ...bundled, rows: bundled.rows.map(row => row.resource_type === 'Observation' ? { ...row, compact_recipe: RECIPE_IDS.Observation } : row),
  }), ['Observation: compact_recipe disagrees with gateway projection']);
  assert.equal(projectSanitized(record('Observation'), 'compact', ['code']).meta.recipe_id, undefined);
  const structural = projectSanitized({ ...record('Observation'), requiresStructuralView: true }, 'compact');
  assert.equal(structural.meta.interpretation, 'structural');
  assert.equal(structural.meta.recipe_id, undefined);
  const limits = supportForType('Observation').limitations.join(' ');
  assert.match(limits, /Fields override/);
  assert.match(limits, /modifiers force structural sanitized FHIR/);
});

test('R4 denominator is regenerated from the bundled index, never rounded up (CA-4)', () => {
  const index = JSON.parse(readFileSync(new URL('../packages/core/src/generated/r4-index.json', import.meta.url), 'utf8')) as {
    package: string; version: string; source_sha256: string; definitions: Record<string, { kind: string }>;
  };
  const resourceTypes = Object.entries(index.definitions).filter(([, definition]) => definition.kind === 'resource').map(([name]) => name);
  assert.deepEqual(SUPPORT_DENOMINATOR, {
    package: index.package, version: index.version, source_sha256: index.source_sha256,
    resource_type_count: resourceTypes.length,
  }, 'the whole denominator identity equals the generated R4 index');
  assert.equal(SEARCH_PARAMETER_DEFINITIONS.source_sha256, index.source_sha256, 'one pinned archive for schema and search parameters');
  for (const type of classifiedTypes()) assert.ok(resourceTypes.includes(type), `${type} is a real R4 resource type`);
  const unclassified = resourceTypes.filter(type => !classifiedTypes().includes(type));
  assert.ok(unclassified.length > 100, 'most R4 types stay explicitly unclassified, not silently supported');
  for (const type of unclassified) assert.equal(supportForType(type).policy_class, 'denied', type);
});

test('Specimen, CarePlan, Goal and unknown types stay denied by default (item 6)', () => {
  for (const type of ['Specimen', 'CarePlan', 'Goal', 'NonsenseType']) {
    const row = supportForType(type);
    assert.equal(row.policy_class, 'denied', type);
    assert.equal(row.compact_recipe, null, type);
    assert.ok(row.limitations.length >= 1, type);
  }
  assert.match(supportForType('Specimen').limitations[0]!, /unresolved provenance|Denied/);
  const effective = effectiveSupport({
    advertised: [{ type: 'Specimen', interactions: ['read', 'search-type'] }],
    confinementExecutable: new Set(['Specimen']),
    resourceType: 'Specimen',
  });
  assert.equal(effective[0]?.source_advertised, true);
  assert.deepEqual(effective[0]?.executable_interactions, [], 'advertisement never enables a denied type');
});

test('support-matrix:intersection: effective support is the policy, advertisement and confinement intersection (item 6)', () => {
  const advertised = [
    { type: 'Observation', interactions: ['read', 'search-type', 'create'] },
    { type: 'Condition', interactions: ['read', 'search-type'] },
    { type: 'Medication', interactions: ['read', 'search-type'] },
  ];
  const withConfinement = effectiveSupport({ advertised, confinementExecutable: new Set(['Observation']) });
  const row = (rows: typeof withConfinement, type: string) => rows.find(candidate => candidate.resource_type === type)!;
  assert.deepEqual(row(withConfinement, 'Observation').executable_interactions, ['read', 'search-type'], 'positive control: a deny-all matrix cannot pass');
  assert.deepEqual(row(withConfinement, 'Condition').executable_interactions, ['read'], 'search needs a resolved confinement predicate');
  assert.deepEqual(row(withConfinement, 'Medication').executable_interactions, ['read', 'search-type']);
  assert.match(row(withConfinement, 'Medication').instance_policy, /Catalog products only/, 'conditional instance policy stays visible');
  assert.equal(row(withConfinement, 'Patient').source_advertised, false);
  assert.deepEqual(row(withConfinement, 'Patient').executable_interactions, [], 'unadvertised types are not executable');
  const without = effectiveSupport({ advertised, confinementExecutable: new Set() });
  assert.deepEqual(row(without, 'Observation').executable_interactions, ['read'], 'missing confinement typing fails search closed');
  for (const supportRow of withConfinement) assert.equal(supportRowSchema.safeParse(supportRow).success, true, supportRow.resource_type);
});

test('support-matrix:patient-predicates: patient predicates in the matrix agree with authorized() (item 6)', () => {
  const rows = bundledMatrix().rows.filter(row => row.policy_class === 'patient');
  assert.deepEqual(rows.map(row => row.resource_type), PATIENT_TYPES, 'all 15 patient-linked rows are exercised');
  for (const row of rows) {
    assert.equal(resourceClass(row.resource_type), 'patient', row.resource_type);
    assert.ok(row.patient_link, `${row.resource_type}: a patient link is required`);
    const absent: FhirResource = { resourceType: row.resource_type };
    // `_id` is Patient's search selector; its instance authorization uses id.
    const own = row.patient_link === '_id' ? { ...absent, id: PATIENT }
      : { ...absent, id: 'synthetic-linked', [row.patient_link]: { reference: `Patient/${PATIENT}` } };
    const foreign = row.patient_link === '_id' ? { ...absent, id: 'synthetic-foreign' }
      : { ...absent, id: 'synthetic-linked', [row.patient_link]: { reference: 'Patient/synthetic-foreign' } };
    assert.equal(authorized(own, PATIENT, BASE), true, `${row.resource_type}: bound link permits access`);
    assert.equal(authorized(foreign, PATIENT, BASE), false, `${row.resource_type}: foreign link is denied`);
    assert.equal(authorized(absent, PATIENT, BASE), false, `${row.resource_type}: missing link is denied`);
  }
  const own = { resourceType: 'Observation', id: 'o1', status: 'final', subject: { reference: `Patient/${PATIENT}` } };
  const containedUnknown = { ...own, contained: [{ resourceType: 'Specimen', id: 's1' }] };
  assert.equal(authorized(containedUnknown as never, PATIENT, BASE), false, 'unclassified contained dependency denies the parent uniformly');
  for (const type of PATIENT_TYPES) assert.equal(resourceClass(type), 'patient', type);
  for (const type of SHARED_TYPES) assert.equal(resourceClass(type), 'shared', type);
});

test('S7 support patient-link drift is rejected, including Condition beneficiary', () => {
  const bundled = bundledMatrix();
  assert.deepEqual(supportMatrixDrift(bundled), [], 'positive control');
  for (const row of bundled.rows) {
    const wrongLink = row.patient_link === 'subject' ? 'beneficiary' : 'subject';
    assert.deepEqual(supportMatrixDrift({
      ...bundled, rows: bundled.rows.map(other => other === row ? { ...other, patient_link: wrongLink } : other),
    }), [`${row.resource_type}: patient_link disagrees with privacy enforcement`], `${row.resource_type}: ${wrongLink}`);
  }
});

test('S7 support denominator identity drift is rejected for every pinned field', () => {
  const bundled = bundledMatrix();
  assert.deepEqual(supportMatrixDrift(bundled), [], 'positive control');
  for (const [key, value] of Object.entries({
    package: 'unreviewed.core', version: '999.0.0', source_sha256: '0'.repeat(64), resource_type_count: 148,
  })) {
    assert.deepEqual(supportMatrixDrift({ ...bundled, denominator: { ...bundled.denominator, [key]: value } }),
      [`denominator.${key} disagrees with generated R4 index`], key);
  }
});

test('support snapshot pages all 25 rows without skips and validates strictly (items 1, 6)', () => {
  const rows = effectiveSupport({
    advertised: classifiedTypes().map(type => ({ type, interactions: ['read', 'search-type'] })),
    confinementExecutable: new Set(PATIENT_TYPES),
  });
  assert.equal(rows.length, 25);
  const ledger = new RetentionLedger(10 * 1024 * 1024);
  const store = createDiscoveryStore({ ledger });
  const binding: DiscoveryBinding = { sourceAlias: 'local', contextHandle: 'ctx-1', policyRevision: 'synthetic-v1', authEpoch: 0, sourceRevision: 'rev-1' };
  const frozen = freezeSupportSnapshot(store, {
    topic: 'support', revision: SUPPORT_MATRIX_REVISION,
    capturedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:05:00.000Z',
    binding, rows,
  });
  const drained: string[] = [];
  let cursor: string | undefined = frozen.handle;
  let lastExpires = frozen.expires_at;
  for (let guard = 0; guard < 10 && cursor !== undefined; guard++) {
    const readBack: { value: SupportSnapshotValue; expires_at: string } = readDiscoverySnapshot(store, cursor, binding, 'support');
    const { value, expires_at } = readBack;
    lastExpires = expires_at;
    const fitted: { page: SupportRow[]; nextOffset?: number } = fitDiscoveryPage(value.rows, value.offset ?? 0, 10, 131072);
    drained.push(...fitted.page.map(supportRow => supportRow.resource_type));
    const data = {
      workflow: 'recent-labs-v1' as const, matrix_revision: SUPPORT_MATRIX_REVISION, rows: fitted.page,
      snapshot_revision: 'rev-1', captured_at: value.capturedAt, expires_at: new Date(Date.parse(lastExpires)).toISOString(),
      default_policy: 'deny_unclassified' as const, clinical_sections: [], document_support: 'metadata_only' as const,
    };
    assert.equal(supportDataSchema.safeParse(data).success, true);
    cursor = fitted.nextOffset === undefined ? undefined
      : advanceDiscoveryCursor(store, cursor, binding, 'support', fitted.nextOffset).handle;
  }
  assert.deepEqual(drained, classifiedTypes());
  store.close();
});

test('support-matrix:drift: policy-revision drift is detected on an injected matrix (R2-7)', () => {
  const bundled = bundledMatrix();
  assert.deepEqual(supportMatrixDrift(bundled), [], 'positive control: the bundled matrix itself has no drift');
  const staleRevision = supportMatrixDrift({ ...bundled, policy_revision: '1999-01-01.0' });
  assert.ok(staleRevision.some(issue => issue.includes('policy_revision')), 'a stale policy revision is reported');
  const missingTestIds = supportMatrixDrift({
    ...bundled,
    rows: bundled.rows.map(row => row.resource_type === 'Observation' ? { ...row, test_ids: [] } : row),
  });
  assert.ok(missingTestIds.some(issue => issue.includes('Observation: missing test_ids')), 'missing per-row test IDs are reported');
});
