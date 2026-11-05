// Deterministic oracle-script task definitions for retrieval-conformance eval v0.
// These are scripted tool-call plans with golden expected facts. They are NOT
// agents: no model chooses the calls, and results say nothing about clinical
// reasoning or agent performance (see README.md).

import { createHash } from 'node:crypto';
import { ADVERSARIAL_CODE, ADVERSARIAL_MODES, canonicalJson, evalDataText, type AdversarialMode } from './fixture.js';
import { M3B_CHECK_KINDS, type ArmName, type Check, type M3bCheckKind } from './check-contracts.js';
export { M3B_CHECK_KINDS, type ArmName, type Check, type M3bCheckKind };

export const ARM_ORDER: readonly ArmName[] = ['fhir', 'compact', 'selected'];
export type ProtocolEra = 'modern' | 'legacy';

export interface EvalStep {
  tool: 'fhir_capabilities' | 'fhir_search' | 'fhir_read' | 'fhir_page' | 'fhir_result';
  input: Record<string, unknown>;
  /** Follow pagination.next_cursor with fhir_page until exhausted. Default true for fhir_search. */
  drainPages?: boolean;
  /**
   * Per-call output.max_bytes override (same for every arm). `{{bytes:N}}` resolves to the gateway-reported
   * bytes_returned of envelope N plus a 16-byte slack: the tightest ceiling the gateway itself claims to meet.
   */
  maxBytes?: number | string;
}

export const M3B_TASKS_SCHEMA_VERSION = 'm3b-tasks/1' as const;
export const M3B_FIXTURE_SCHEMA_VERSION = 'm3b-fixture/1' as const;

/**
 * An agreed, not-yet-fixed gateway defect. Matching failures are reported as `known-defect` (an expected failure)
 * rather than weakening the check. If none of its failures reproduce, the task fails with `known_defect_resolved` so
 * the marker is removed when integration lands the fix.
 */
export interface KnownDefect { jid: string; summary: string; match: { cause?: string; checkId?: string }[]; eras?: ProtocolEra[] }

export interface TaskBudget { maxBytes: number; maxUpstreamCalls: number; maxToolCalls: number }

export interface EvalTask {
  id: string;
  category: string;
  question: string;
  steps: EvalStep[];
  /** Question-selected fields for the `selected` arm; must cover every comparable fact. */
  fields?: string[];
  checks: Check[];
  budget: TaskBudget;
  /** Per-tool-call output.max_bytes applied identically to every arm. */
  perCallBytes?: number;
  /** When set, every arm must fail with exactly this gateway error code and return no resources. */
  expectedError?: string;
  /** Gateway error codes that are an acceptable safe outcome (a refusal instead of partial evidence). */
  allowedErrors?: string[];
  prohibited?: string[];
  /** Adversarial fixture behavior active for this task only. */
  fixtureMode?: AdversarialMode;
  knownDefects?: KnownDefect[];
  corpus?: 'baseline' | 'query' | 'projection' | 'usability';
}

const read = (resource_type: string, id: string): EvalStep => ({ tool: 'fhir_read', input: { resource_type, id } });
const search = (resource_type: string, params: [string, string][], page_size?: number): EvalStep => ({
  tool: 'fhir_search',
  input: { resource_type, params: params.map(([name, value]) => ({ name, value })), ...(page_size ? { page_size } : {}) },
});
const fact = (id: string, resource: string, path: string, equals: unknown, extra?: Partial<Extract<Check, { kind: 'fact' }>>): Check => ({ kind: 'fact', id, resource, path, equals, ...extra });
const NONCOMPACT = (field: string) => ({ arms: ['fhir', 'selected'] as ArmName[], incomparableReason: `compact projection does not include ${field}` });
// Byte ceilings carry roughly 2-3x headroom over the largest (fhir) arm on
// the golden fixture; call ceilings are the exact expected counts.
const READ_BUDGET: TaskBudget = { maxBytes: 6000, maxUpstreamCalls: 2, maxToolCalls: 2 };
const SEARCH_BUDGET: TaskBudget = { maxBytes: 16000, maxUpstreamCalls: 2, maxToolCalls: 4 };
const SMALL_SEARCH_BUDGET: TaskBudget = { maxBytes: 6000, maxUpstreamCalls: 2, maxToolCalls: 3 };
const DENY_BUDGET: TaskBudget = { maxBytes: 4096, maxUpstreamCalls: 2, maxToolCalls: 2 };

export const TASKS: EvalTask[] = [
  {
    id: 'allergy-verification-reaction', category: 'status-verification',
    question: 'Read the synthetic peanut allergy: clinical/verification status, code, reaction manifestation and severity.',
    steps: [read('AllergyIntolerance', 'allergy-1')],
    fields: ['clinicalStatus', 'verificationStatus', 'code', 'patient', 'reaction'],
    checks: [
      fact('clinical', 'allergy-1', 'clinicalStatus.coding.0.code', 'active'),
      fact('verification', 'allergy-1', 'verificationStatus.coding.0.code', 'confirmed'),
      fact('code', 'allergy-1', 'code.coding.0.code', '91935009'),
      fact('patient', 'allergy-1', 'patient.reference', 'Patient/eval-patient-a'),
      fact('reaction', 'allergy-1', 'reaction.0.manifestation.0.coding.0.code', '247472004'),
      fact('severity', 'allergy-1', 'reaction.0.severity', 'moderate'),
    ],
    budget: READ_BUDGET,
  },
  {
    id: 'bp-components', category: 'components',
    question: 'Read the blood-pressure panel: systolic and diastolic component values, UCUM codes, and effective time.',
    steps: [read('Observation', 'obs-bp-1')],
    fields: ['code', 'status', 'effectiveDateTime', 'component'],
    checks: [
      fact('panel-code', 'obs-bp-1', 'code.coding.0.code', '85354-9'),
      fact('systolic-code', 'obs-bp-1', 'component.0.code.coding.0.code', '8480-6'),
      fact('systolic', 'obs-bp-1', 'component.0.valueQuantity.value', 118),
      fact('systolic-ucum', 'obs-bp-1', 'component.0.valueQuantity.code', 'mm[Hg]'),
      fact('diastolic-code', 'obs-bp-1', 'component.1.code.coding.0.code', '8462-4'),
      fact('diastolic', 'obs-bp-1', 'component.1.valueQuantity.value', 76),
      fact('when', 'obs-bp-1', 'effectiveDateTime', '2025-03-11T09:30:00.000Z'),
      { kind: 'factAbsent', id: 'no-top-value', resource: 'obs-bp-1', path: 'valueQuantity' },
    ],
    budget: READ_BUDGET,
  },
  {
    // V-32: a tight per-call ceiling at the schema minimum. The BP panel's natural size exceeds 4096 in every
    // arm, so the read must answer with the retained-manifest shape inside the ceiling, and the facts must be
    // recoverable from the retained handle at a larger ceiling. The harness measures the ceiling itself.
    id: 'bp-components-tight-ceiling', category: 'byte-accounting',
    question: 'Read the blood-pressure panel under a 4096-byte per-call ceiling, then recover its components from the retained result.',
    steps: [
      read('Observation', 'obs-bp-1'),
      { tool: 'fhir_result', input: { handle: '{{handle:0}}', action: 'project', fields: ['code', 'component', 'effectiveDateTime'] }, maxBytes: 24576 },
    ],
    fields: ['code', 'status', 'effectiveDateTime', 'component'],
    perCallBytes: 4096,
    checks: [
      { kind: 'dataPath', id: 'manifest-reason', step: 0, path: 'manifest.reason', equals: 'RESOURCE_EXCEEDS_INLINE_BUDGET' },
      { kind: 'envelopePath', id: 'nothing-inline', step: 0, path: 'pagination.returned_matches', equals: 0 },
      fact('systolic', 'obs-bp-1', 'component.0.valueQuantity.value', 118, { step: 1 }),
      fact('diastolic', 'obs-bp-1', 'component.1.valueQuantity.value', 76, { step: 1 }),
      fact('when', 'obs-bp-1', 'effectiveDateTime', '2025-03-11T09:30:00.000Z', { step: 1 }),
    ],
    budget: { maxBytes: 12000, maxUpstreamCalls: 2, maxToolCalls: 3 },
  },
  {
    id: 'capabilities-resource-observation', category: 'discovery',
    question: 'What does the source declare for Observation: interactions, search parameters, resource class?',
    steps: [{ tool: 'fhir_capabilities', input: { topic: 'resource', resource_type: 'Observation' } }],
    checks: [
      { kind: 'dataPath', id: 'type', path: 'type', equals: 'Observation' },
      { kind: 'dataPath', id: 'class', path: 'resource_class', equals: 'patient' },
      { kind: 'dataPathIncludes', id: 'search-code', path: 'searchParameters', includes: 'code' },
      { kind: 'dataPathIncludes', id: 'search-date', path: 'searchParameters', includes: 'date' },
      { kind: 'dataPathIncludes', id: 'interaction-read', path: 'implemented_interactions', includes: 'read' },
      { kind: 'dataPathIncludes', id: 'interaction-search', path: 'implemented_interactions', includes: 'search-type' },
    ],
    budget: { maxBytes: 20000, maxUpstreamCalls: 1, maxToolCalls: 2 },
  },
  {
    id: 'capabilities-server', category: 'discovery',
    question: 'Server discovery: FHIR version, synthetic-only flag, implemented tools, declared resource count.',
    steps: [{ tool: 'fhir_capabilities', input: { topic: 'server' } }],
    checks: [
      { kind: 'dataPath', id: 'fhir-version', path: 'fhir_version', equals: '4.0.1' },
      { kind: 'dataPath', id: 'synthetic', path: 'data_classification', equals: 'operator_declared_synthetic_unverified' },
      { kind: 'dataPath', id: 'tools', path: 'implemented_tools', equals: ['fhir_capabilities', 'fhir_search', 'fhir_read', 'fhir_page', 'fhir_result'] },
      { kind: 'dataPath', id: 'resource-count', path: 'resource_count', equals: 8 },
      { kind: 'envelopePath', id: 'coverage-state', path: 'coverage.state', equals: 'complete_for_query' },
    ],
    budget: { maxBytes: 20000, maxUpstreamCalls: 1, maxToolCalls: 2 },
  },
  {
    id: 'condition-active-confirmed', category: 'status-verification',
    question: 'Read the synthetic diabetes condition: clinical status, verification status, code, onset and recorded dates.',
    steps: [read('Condition', 'cond-diabetes')],
    fields: ['clinicalStatus', 'verificationStatus', 'code', 'subject', 'onsetDateTime', 'recordedDate'],
    checks: [
      fact('clinical', 'cond-diabetes', 'clinicalStatus.coding.0.code', 'active'),
      fact('verification', 'cond-diabetes', 'verificationStatus.coding.0.code', 'confirmed'),
      fact('code', 'cond-diabetes', 'code.coding.0.code', '73211009'),
      fact('onset', 'cond-diabetes', 'onsetDateTime', '2024-05-01T00:00:00.000Z'),
      fact('recorded', 'cond-diabetes', 'recordedDate', '2024-05-03T00:00:00.000Z'),
    ],
    budget: READ_BUDGET,
  },
  {
    id: 'condition-entered-in-error-search', category: 'status-verification',
    question: 'Find Conditions whose verification status is entered-in-error, and only those.',
    steps: [search('Condition', [['verification-status', 'entered-in-error']])],
    fields: ['clinicalStatus', 'verificationStatus', 'code', 'subject'],
    checks: [
      { kind: 'resourceIds', id: 'ids', equals: ['cond-error'] },
      fact('verification', 'cond-error', 'verificationStatus.coding.0.code', 'entered-in-error'),
      fact('clinical', 'cond-error', 'clinicalStatus.coding.0.code', 'inactive'),
    ],
    budget: { maxBytes: 30000, maxUpstreamCalls: 2, maxToolCalls: 6 },
  },
  {
    id: 'contained-cross-patient-denied', category: 'denial',
    question: 'An Observation for the trusted patient containing the other Patient resource must not be readable.',
    steps: [read('Observation', 'obs-contained-b')],
    expectedError: 'NOT_FOUND',
    checks: [],
    budget: DENY_BUDGET,
  },
  {
    id: 'cross-patient-read-denied', category: 'denial',
    question: 'Directly reading the other patient\'s glucose Observation must be indistinguishable from not-found.',
    steps: [read('Observation', 'obs-b-glucose')],
    expectedError: 'NOT_FOUND',
    checks: [],
    budget: DENY_BUDGET,
  },
  {
    id: 'cross-patient-selector-denied', category: 'denial',
    question: 'Searching with a patient selector for the other patient must be policy-denied, not widened.',
    steps: [search('Observation', [['patient', 'Patient/eval-patient-b']])],
    expectedError: 'POLICY_DENIED',
    checks: [],
    budget: { maxBytes: 8000, maxUpstreamCalls: 1, maxToolCalls: 3 },
  },
  {
    id: 'data-absent-reason', category: 'missingness',
    question: 'Read the cholesterol Observation that was not performed: dataAbsentReason present, no value[x].',
    steps: [read('Observation', 'obs-absent-1')],
    fields: ['code', 'status', 'effectiveDateTime', 'dataAbsentReason'],
    checks: [
      fact('code', 'obs-absent-1', 'code.coding.0.code', '2093-3'),
      fact('reason', 'obs-absent-1', 'dataAbsentReason.coding.0.code', 'not-performed'),
      fact('reason-system', 'obs-absent-1', 'dataAbsentReason.coding.0.system', 'http://terminology.hl7.org/CodeSystem/data-absent-reason'),
      { kind: 'factAbsent', id: 'no-value', resource: 'obs-absent-1', path: 'valueQuantity' },
    ],
    budget: READ_BUDGET,
  },
  {
    // J-6: the fixture serves this read with raw lexemes 7.0 / 0.0100 / 120.00. Delivery itself is the eval-level
    // assertion (a precision refusal fails the task); exact lexeme fidelity on the wire is pinned by unit tests.
    id: 'decimal-lexeme-preserved', category: 'quantities',
    question: 'Read the Observation whose source numbers use decimal lexemes (7.0, 120.00): it must be delivered losslessly, never refused or rounded away.',
    steps: [read('Observation', 'obs-decimal-1')],
    fields: ['code', 'status', 'effectiveDateTime', 'valueQuantity', 'referenceRange'],
    checks: [
      { kind: 'resourceIds', id: 'ids', equals: ['obs-decimal-1'] },
      fact('code', 'obs-decimal-1', 'code.coding.0.code', 'synthetic-decimal'),
      fact('unit', 'obs-decimal-1', 'valueQuantity.unit', 'mmol/L'),
      fact('ucum', 'obs-decimal-1', 'valueQuantity.code', 'mmol/L'),
      { kind: 'envelopePath', id: 'coverage-state', path: 'coverage.state', equals: 'complete_for_query' },
    ],
    budget: READ_BUDGET,
  },
  {
    id: 'diagnostic-report-conclusion', category: 'withheld-payload',
    question: 'Read the lab DiagnosticReport: status, result references, conclusion; presented-form payload withheld.',
    steps: [read('DiagnosticReport', 'report-1')],
    fields: ['status', 'code', 'subject', 'effectiveDateTime', 'result', 'conclusion'],
    checks: [
      fact('status', 'report-1', 'status', 'final'),
      fact('result-0', 'report-1', 'result.0.reference', 'Observation/obs-hba1c-1'),
      fact('result-1', 'report-1', 'result.1.reference', 'Observation/obs-glucose-1'),
      fact('conclusion', 'report-1', 'conclusion', 'Synthetic conclusion alpha'),
      { kind: 'withheld', id: 'presented-form-withheld', minCount: 1, reasonsInclude: 'V1_PAYLOAD_WITHHELD' },
      { kind: 'factAbsent', id: 'no-inline-form', resource: 'report-1', path: 'presentedForm.0.data' },
    ],
    budget: READ_BUDGET,
  },
  {
    id: 'document-withheld-payload', category: 'withheld-payload',
    question: 'Read the DocumentReference: attachment metadata survives, inline data and capability URL are withheld with markers.',
    steps: [read('DocumentReference', 'doc-1')],
    fields: ['status', 'subject', 'content'],
    checks: [
      fact('status', 'doc-1', 'status', 'current'),
      fact('content-type', 'doc-1', 'content.0.attachment.contentType', 'application/pdf'),
      fact('size', 'doc-1', 'content.0.attachment.size', 1234),
      { kind: 'factAbsent', id: 'no-data', resource: 'doc-1', path: 'content.0.attachment.data' },
      { kind: 'factAbsent', id: 'no-url', resource: 'doc-1', path: 'content.0.attachment.url' },
      { kind: 'withheld', id: 'withheld-markers', minCount: 2 },
    ],
    budget: READ_BUDGET,
  },
  {
    id: 'effective-period-observation', category: 'dates',
    question: 'Read the 24-hour volume Observation: effectivePeriod bounds and quantity, not an effectiveDateTime.',
    steps: [read('Observation', 'obs-period-1')],
    fields: ['code', 'status', 'effectivePeriod', 'valueQuantity'],
    checks: [
      fact('start', 'obs-period-1', 'effectivePeriod.start', '2025-02-20T08:00:00.000Z'),
      fact('end', 'obs-period-1', 'effectivePeriod.end', '2025-02-21T08:00:00.000Z'),
      fact('value', 'obs-period-1', 'valueQuantity.value', 1500),
      fact('ucum', 'obs-period-1', 'valueQuantity.code', 'mL'),
      { kind: 'factAbsent', id: 'no-instant', resource: 'obs-period-1', path: 'effectiveDateTime' },
    ],
    budget: READ_BUDGET,
  },
  {
    id: 'hba1c-quantity-ucum', category: 'quantities',
    question: 'Read the HbA1c Observation: exact value, UCUM unit/code/system, LOINC code, status, effective time.',
    steps: [read('Observation', 'obs-hba1c-1')],
    fields: ['code', 'status', 'effectiveDateTime', 'valueQuantity'],
    checks: [
      fact('loinc', 'obs-hba1c-1', 'code.coding.0.code', '4548-4'),
      fact('loinc-system', 'obs-hba1c-1', 'code.coding.0.system', 'http://loinc.org'),
      fact('value', 'obs-hba1c-1', 'valueQuantity.value', 5.4),
      fact('unit', 'obs-hba1c-1', 'valueQuantity.unit', '%'),
      fact('ucum-code', 'obs-hba1c-1', 'valueQuantity.code', '%'),
      fact('ucum-system', 'obs-hba1c-1', 'valueQuantity.system', 'http://unitsofmeasure.org'),
      fact('status', 'obs-hba1c-1', 'status', 'final'),
      fact('when', 'obs-hba1c-1', 'effectiveDateTime', '2025-02-10T08:00:00.000Z'),
      { kind: 'envelopePath', id: 'coverage-state', path: 'coverage.state', equals: 'complete_for_query' },
    ],
    budget: READ_BUDGET,
  },
  {
    id: 'heart-rate-paging-drain', category: 'paging',
    question: 'Retrieve all 12 heart-rate Observations across upstream pages of 5: every id exactly once, first and last values.',
    steps: [search('Observation', [['code', 'http://loinc.org|8867-4']], 5)],
    fields: ['code', 'status', 'effectiveDateTime', 'valueQuantity'],
    checks: [
      { kind: 'resourceIds', id: 'ids', equals: Array.from({ length: 12 }, (_, i) => `obs-hr-${String(i + 1).padStart(2, '0')}`) },
      fact('first-value', 'obs-hr-01', 'valueQuantity.value', 60),
      fact('last-value', 'obs-hr-12', 'valueQuantity.value', 71),
      fact('last-when', 'obs-hr-12', 'effectiveDateTime', '2025-02-12T09:00:00.000Z'),
    ],
    budget: { maxBytes: 120000, maxUpstreamCalls: 4, maxToolCalls: 16 },
  },
  {
    id: 'immunization-vaccine-code', category: 'status-verification',
    question: 'Read the Immunization: status, vaccine code and occurrence time for every arm.',
    steps: [read('Immunization', 'imm-1')],
    fields: ['status', 'patient', 'vaccineCode', 'occurrenceDateTime'],
    checks: [
      fact('status', 'imm-1', 'status', 'completed'),
      fact('patient', 'imm-1', 'patient.reference', 'Patient/eval-patient-a'),
      fact('vaccine', 'imm-1', 'vaccineCode.coding.0.code', 'synthetic-vaccine-001'),
      fact('when', 'imm-1', 'occurrenceDateTime', '2025-01-05T10:00:00.000Z'),
    ],
    budget: READ_BUDGET,
  },
  {
    id: 'medication-request-dosage', category: 'quantities',
    question: 'Read the MedicationRequest: medication code, status/intent, dosage text, dose quantity and authoredOn.',
    steps: [read('MedicationRequest', 'medreq-1')],
    fields: ['status', 'intent', 'medicationCodeableConcept', 'subject', 'dosageInstruction', 'authoredOn'],
    checks: [
      fact('status', 'medreq-1', 'status', 'active'),
      fact('intent', 'medreq-1', 'intent', 'order'),
      fact('med-code', 'medreq-1', 'medicationCodeableConcept.coding.0.code', 'synthetic-rx-001'),
      fact('dose-value', 'medreq-1', 'dosageInstruction.0.doseAndRate.0.doseQuantity.value', 1),
      fact('dose-ucum', 'medreq-1', 'dosageInstruction.0.doseAndRate.0.doseQuantity.code', '{tablet}'),
      fact('authored', 'medreq-1', 'authoredOn', '2025-01-20T10:00:00.000Z'),
    ],
    budget: READ_BUDGET,
  },
  {
    id: 'observation-category-search', category: 'search',
    question: 'Search laboratory-category glucose Observations: exact id set and the category coding itself.',
    steps: [search('Observation', [['category', 'laboratory'], ['code', 'http://loinc.org|2345-7']])],
    fields: ['category', 'code', 'status', 'effectiveDateTime', 'valueQuantity'],
    checks: [
      { kind: 'resourceIds', id: 'ids', equals: ['obs-glucose-1', 'obs-glucose-2', 'obs-glucose-3', 'obs-glucose-error', 'obs-glucose-prelim'] },
      fact('category', 'obs-glucose-1', 'category.0.coding.0.code', 'laboratory'),
      fact('error-status', 'obs-glucose-error', 'status', 'entered-in-error'),
    ],
    budget: { maxBytes: 60000, maxUpstreamCalls: 2, maxToolCalls: 8 },
  },
  {
    id: 'paging-exact-boundary', category: 'paging',
    question: 'Respiratory-rate search with page size exactly equal to the match count: all 4, no further page, total reported.',
    steps: [search('Observation', [['code', 'http://loinc.org|9279-1']], 4)],
    fields: ['code', 'status', 'effectiveDateTime', 'valueQuantity'],
    checks: [
      { kind: 'resourceIds', id: 'ids', equals: ['obs-rr-1', 'obs-rr-2', 'obs-rr-3', 'obs-rr-4'] },
      { kind: 'envelopePath', id: 'has-more', path: 'pagination.has_more', equals: false },
      { kind: 'envelopePath', id: 'total', path: 'pagination.total.value', equals: 4 },
      fact('last-value', 'obs-rr-4', 'valueQuantity.value', 15),
    ],
    budget: { maxBytes: 60000, maxUpstreamCalls: 2, maxToolCalls: 8 },
  },
  {
    id: 'patient-identity-fields', category: 'incomparable-fields',
    question: 'Read the trusted Patient: name, birth date, gender for every arm; identifier where representable.',
    steps: [read('Patient', 'eval-patient-a')],
    fields: ['name', 'birthDate', 'gender', 'identifier'],
    checks: [
      fact('family', 'eval-patient-a', 'name.0.family', 'SyntheticA'),
      fact('given', 'eval-patient-a', 'name.0.given.0', 'Alpha'),
      fact('birth', 'eval-patient-a', 'birthDate', '1990-01-15'),
      fact('gender', 'eval-patient-a', 'gender', 'female'),
      fact('identifier', 'eval-patient-a', 'identifier.0.value', 'synthetic-mrn-a', NONCOMPACT('identifier')),
      { kind: 'omittedIncludes', id: 'compact-omits-identifier', path: '/identifier', arms: ['compact'] },
    ],
    budget: READ_BUDGET,
  },
  {
    id: 'quantity-comparator', category: 'quantities',
    question: 'Read the troponin Observation: the quantity comparator must survive alongside value and UCUM code.',
    steps: [read('Observation', 'obs-troponin-1')],
    fields: ['code', 'status', 'effectiveDateTime', 'valueQuantity'],
    checks: [
      fact('value', 'obs-troponin-1', 'valueQuantity.value', 10),
      fact('comparator', 'obs-troponin-1', 'valueQuantity.comparator', '<'),
      fact('ucum', 'obs-troponin-1', 'valueQuantity.code', 'ng/L'),
      fact('loinc', 'obs-troponin-1', 'code.coding.0.code', '10839-9'),
    ],
    budget: READ_BUDGET,
  },
  {
    id: 'reference-range-interpretation', category: 'reference-ranges',
    question: 'Read glucose #1 and #2: reference-range bounds with UCUM codes and differing interpretations.',
    steps: [read('Observation', 'obs-glucose-1'), read('Observation', 'obs-glucose-2')],
    fields: ['code', 'status', 'effectiveDateTime', 'valueQuantity', 'referenceRange', 'interpretation'],
    checks: [
      fact('low', 'obs-glucose-1', 'referenceRange.0.low.value', 70, { step: 0 }),
      fact('high', 'obs-glucose-1', 'referenceRange.0.high.value', 99, { step: 0 }),
      fact('range-ucum', 'obs-glucose-1', 'referenceRange.0.high.code', 'mg/dL', { step: 0 }),
      fact('interp-normal', 'obs-glucose-1', 'interpretation.0.coding.0.code', 'N', { step: 0 }),
      fact('interp-high', 'obs-glucose-2', 'interpretation.0.coding.0.code', 'H', { step: 1 }),
      fact('value-2', 'obs-glucose-2', 'valueQuantity.value', 102, { step: 1 }),
    ],
    budget: { maxBytes: 40000, maxUpstreamCalls: 3, maxToolCalls: 8 },
  },
  {
    id: 'result-project-compact-omitted', category: 'retained-results',
    question: 'Read the Patient, then project identifier+name from the retained result handle (the repair path for compact omissions).',
    steps: [
      read('Patient', 'eval-patient-a'),
      { tool: 'fhir_result', input: { handle: '{{handle:0}}', action: 'project', fields: ['identifier', 'name'] } },
    ],
    fields: ['name', 'birthDate', 'gender', 'identifier'],
    // Bound to step 1: the retained projection itself must supply the facts; the earlier read cannot (G-11).
    checks: [
      fact('identifier', 'eval-patient-a', 'identifier.0.value', 'synthetic-mrn-a', { step: 1 }),
      fact('family', 'eval-patient-a', 'name.0.family', 'SyntheticA', { step: 1 }),
      { kind: 'envelopePath', id: 'retained-scope', step: 1, path: 'coverage.scope', equals: 'retained' },
    ],
    budget: { maxBytes: 40000, maxUpstreamCalls: 2, maxToolCalls: 6 },
  },
  {
    id: 'schema-observation-root', category: 'discovery',
    question: 'Schema discovery for Observation root elements: status cardinality/types and value[x] JSON names, labelled as base definition.',
    steps: [{ tool: 'fhir_capabilities', input: { topic: 'schema', resource_type: 'Observation', path: '', limit: 50 } }],
    perCallBytes: 60000,
    checks: [
      { kind: 'dataPath', id: 'evidence', path: 'evidence', equals: 'pinned_base_definition' },
      { kind: 'dataPath', id: 'profile-validation', path: 'profile_validation', equals: 'not_performed' },
      { kind: 'schemaElement', id: 'status-element', elementPath: 'status', types: ['code'], min: 1, max: '1' },
      { kind: 'schemaElement', id: 'valuex-element', elementPath: 'value[x]', jsonNamesInclude: 'valueQuantity' },
    ],
    budget: { maxBytes: 90000, maxUpstreamCalls: 1, maxToolCalls: 3 },
  },
  {
    id: 'schema-observation-value-quantity', category: 'discovery',
    question: 'Schema discovery under Observation.valueQuantity: value/comparator/system/code element types.',
    steps: [{ tool: 'fhir_capabilities', input: { topic: 'schema', resource_type: 'Observation', path: 'valueQuantity', limit: 50 } }],
    perCallBytes: 60000,
    checks: [
      { kind: 'schemaElement', id: 'value', elementPath: 'valueQuantity.value', types: ['decimal'] },
      { kind: 'schemaElement', id: 'comparator', elementPath: 'valueQuantity.comparator', types: ['code'] },
      { kind: 'schemaElement', id: 'system', elementPath: 'valueQuantity.system', types: ['uri'] },
      { kind: 'schemaElement', id: 'code', elementPath: 'valueQuantity.code', types: ['code'] },
    ],
    budget: { maxBytes: 90000, maxUpstreamCalls: 1, maxToolCalls: 3 },
  },
  {
    id: 'search-no-match', category: 'search',
    question: 'Search a LOINC code with no synthetic matches: empty result is a success with zero returned matches, not an error.',
    steps: [search('Observation', [['code', 'http://loinc.org|9999-9']])],
    fields: ['code', 'status', 'valueQuantity'],
    checks: [
      { kind: 'resourceIds', id: 'ids', equals: [] },
      { kind: 'envelopePath', id: 'returned', path: 'pagination.returned_matches', equals: 0 },
    ],
    budget: { maxBytes: 20000, maxUpstreamCalls: 2, maxToolCalls: 4 },
  },
  {
    id: 'search-repeated-date-range', category: 'dates',
    question: 'Glucose between 2025-01-01 and 2025-04-01 using repeated date parameters (ge + lt): exact ids and boundary values.',
    steps: [search('Observation', [['code', 'http://loinc.org|2345-7'], ['date', 'ge2025-01-01'], ['date', 'lt2025-04-01']])],
    fields: ['code', 'status', 'effectiveDateTime', 'valueQuantity'],
    checks: [
      { kind: 'resourceIds', id: 'ids', equals: ['obs-glucose-1', 'obs-glucose-2', 'obs-glucose-error'] },
      fact('first', 'obs-glucose-1', 'valueQuantity.value', 95),
      fact('error-value-still-labelled', 'obs-glucose-error', 'status', 'entered-in-error'),
    ],
    budget: { maxBytes: 60000, maxUpstreamCalls: 2, maxToolCalls: 8 },
  },
  {
    id: 'search-sort-desc', category: 'search',
    question: 'Glucose sorted by descending date: exact ordered id sequence.',
    steps: [search('Observation', [['code', 'http://loinc.org|2345-7'], ['_sort', '-date']])],
    fields: ['code', 'status', 'effectiveDateTime', 'valueQuantity'],
    checks: [
      { kind: 'resourceIds', id: 'ids', equals: ['obs-glucose-prelim', 'obs-glucose-3', 'obs-glucose-error', 'obs-glucose-2', 'obs-glucose-1'] },
      fact('newest', 'obs-glucose-prelim', 'effectiveDateTime', '2025-05-01T08:00:00.000Z'),
    ],
    budget: { maxBytes: 60000, maxUpstreamCalls: 2, maxToolCalls: 8 },
  },
  {
    id: 'search-status-entered-in-error', category: 'status-verification',
    question: 'Search Observations by status=entered-in-error: only the erroneous glucose, with its (wrong) value still labelled by status.',
    steps: [search('Observation', [['status', 'entered-in-error']])],
    fields: ['code', 'status', 'effectiveDateTime', 'valueQuantity'],
    checks: [
      { kind: 'resourceIds', id: 'ids', equals: ['obs-glucose-error'] },
      fact('status', 'obs-glucose-error', 'status', 'entered-in-error'),
      fact('value', 'obs-glucose-error', 'valueQuantity.value', 999),
    ],
    budget: { maxBytes: 30000, maxUpstreamCalls: 2, maxToolCalls: 6 },
  },
  {
    id: 'search-value-quantity', category: 'quantities',
    question: 'Glucose with value-quantity greater than 100 mg/dL (UCUM-qualified search): exact ids.',
    steps: [search('Observation', [['code', 'http://loinc.org|2345-7'], ['value-quantity', 'gt100|http://unitsofmeasure.org|mg/dL']])],
    fields: ['code', 'status', 'effectiveDateTime', 'valueQuantity'],
    checks: [
      { kind: 'resourceIds', id: 'ids', equals: ['obs-glucose-2', 'obs-glucose-error', 'obs-glucose-prelim'] },
      fact('boundary-excluded-below', 'obs-glucose-2', 'valueQuantity.value', 102),
    ],
    budget: { maxBytes: 60000, maxUpstreamCalls: 2, maxToolCalls: 8 },
  },
  {
    id: 'signed-link-withheld', category: 'withheld-payload',
    question: 'Read an Observation carrying a signed external link in an extension: value survives, link token never appears, withheld marker present.',
    steps: [read('Observation', 'obs-signed-link')],
    fields: ['code', 'status', 'effectiveDateTime', 'valueQuantity', 'extension'],
    checks: [
      fact('value', 'obs-signed-link', 'valueQuantity.value', 42),
      { kind: 'withheld', id: 'link-withheld', minCount: 1, reasonsInclude: 'PROTECTED_LINK' },
    ],
    budget: READ_BUDGET,
  },
  {
    id: 'value-boolean', category: 'value-x',
    question: 'Read the synthetic screening Observation: valueBoolean false must not be confused with absent.',
    steps: [read('Observation', 'obs-boolean-1')],
    fields: ['code', 'status', 'effectiveDateTime', 'valueBoolean'],
    checks: [
      fact('value', 'obs-boolean-1', 'valueBoolean', false),
      { kind: 'factAbsent', id: 'no-quantity', resource: 'obs-boolean-1', path: 'valueQuantity' },
    ],
    budget: READ_BUDGET,
  },
  {
    id: 'value-codeable-concept', category: 'value-x',
    question: 'Read the assay Observation: valueCodeableConcept coding system/code/display preserved.',
    steps: [read('Observation', 'obs-codeable-1')],
    fields: ['code', 'status', 'effectiveDateTime', 'valueCodeableConcept'],
    checks: [
      fact('code', 'obs-codeable-1', 'valueCodeableConcept.coding.0.code', '260415000'),
      fact('system', 'obs-codeable-1', 'valueCodeableConcept.coding.0.system', 'http://snomed.info/sct'),
      fact('display', 'obs-codeable-1', 'valueCodeableConcept.coding.0.display', 'Not detected'),
    ],
    budget: READ_BUDGET,
  },
  {
    id: 'value-integer', category: 'value-x',
    question: 'Read the pain-score Observation: valueInteger exact, no quantity invented.',
    steps: [read('Observation', 'obs-integer-1')],
    fields: ['code', 'status', 'effectiveDateTime', 'valueInteger'],
    checks: [
      fact('value', 'obs-integer-1', 'valueInteger', 3),
      { kind: 'factAbsent', id: 'no-quantity', resource: 'obs-integer-1', path: 'valueQuantity' },
    ],
    budget: READ_BUDGET,
  },
  {
    id: 'value-string', category: 'value-x',
    question: 'Read the string-result Observation: valueString exact text preserved.',
    steps: [read('Observation', 'obs-string-1')],
    fields: ['code', 'status', 'effectiveDateTime', 'valueString'],
    checks: [
      fact('value', 'obs-string-1', 'valueString', 'Synthetic string result alpha'),
      { kind: 'factAbsent', id: 'no-quantity', resource: 'obs-string-1', path: 'valueQuantity' },
    ],
    budget: READ_BUDGET,
  },
  ...adversarialTasks(),
];

// Adversarial fixture modes (J-19, C-15, G-4, C-7, C-13). Each declares its expected safe outcome at the full
// strictness of the agreed contract; nothing is relaxed to make it pass.
function adversarialTasks(): EvalTask[] {
  const target = search('Observation', [['code', ADVERSARIAL_CODE]]);
  const paged = (size: number) => search('Observation', [['code', ADVERSARIAL_CODE]], size);
  const fields = ['code', 'subject', 'status', 'effectiveDateTime', 'valueQuantity'];
  const CONTINUATION_BUDGET: TaskBudget = { maxBytes: 40000, maxUpstreamCalls: 6, maxToolCalls: 6 };
  return [
    {
      id: 'adversarial-self-link-omits-filter', category: 'adversarial', fixtureMode: 'self-link-omits-filter',
      question: 'The source applies the code filter but its self link does not confirm it: the page must be refused, not certified.',
      steps: [target], fields, expectedError: 'UNVERIFIED_QUERY', checks: [],
      budget: { maxBytes: 8000, maxUpstreamCalls: 2, maxToolCalls: 2 },
    },
    {
      id: 'adversarial-self-link-claims-unapplied-filter', category: 'adversarial', fixtureMode: 'self-link-claims-unapplied-filter',
      question: 'The self link echoes a code filter the source ignored: patient confinement must hold and the code constraint must not be reported as executed.',
      steps: [target], fields,
      checks: [
        { kind: 'resourceAbsent', id: 'no-foreign-record', resource: 'adv-b1' },
        { kind: 'constraintNotClaimed', id: 'code-not-claimed-executed', name: 'code' },
      ],
      budget: { maxBytes: 30000, maxUpstreamCalls: 2, maxToolCalls: 2 },
    },
    {
      id: 'adversarial-include-entries', category: 'adversarial', fixtureMode: 'include-entries',
      question: 'Include-mode entries (a same-patient Observation and the other Patient) must never be delivered as matches.',
      steps: [target], fields,
      checks: [
        { kind: 'resourceIds', id: 'matches-only', equals: ['adv-a1', 'adv-a2', 'adv-a3'] },
        { kind: 'resourceAbsent', id: 'no-same-patient-include', resource: 'adv-include-a' },
        { kind: 'envelopePath', id: 'returned-includes', path: 'pagination.returned_includes', equals: 0 },
      ],
      budget: { maxBytes: 20000, maxUpstreamCalls: 2, maxToolCalls: 2 },
    },
    {
      id: 'adversarial-page2-suppression', category: 'adversarial', fixtureMode: 'page2-suppression',
      question: 'The source leaks the other patient onto page 2 after reporting total=4 on page 1: only authorized records, no premature total, and an authorization caveat that does not depend on what was suppressed.',
      steps: [paged(2)], fields,
      checks: [
        { kind: 'resourceIds', id: 'authorized-only', equals: ['adv-a1', 'adv-a2', 'adv-a3'] },
        { kind: 'resourceAbsent', id: 'no-foreign-record', resource: 'adv-b1' },
        { kind: 'totalWithheldWhileMore', id: 'no-total-before-exhaustion' },
        { kind: 'consistentAcross', id: 'caveat-independent-of-suppression', path: 'coverage.authorization_limited' },
      ],
      budget: { maxBytes: 30000, maxUpstreamCalls: 3, maxToolCalls: 3 },
    },
    {
      id: 'adversarial-continuation-drops-filter', category: 'adversarial', fixtureMode: 'continuation-drops-filter',
      question: 'Next links silently drop the code filter: no continuation may be fetched without it and no wrong-code record may be delivered under the requested constraint.',
      steps: [paged(1)], fields, allowedErrors: ['UNVERIFIED_CONTINUATION'],
      checks: [
        { kind: 'upstreamConstraint', id: 'code-on-every-request', name: 'code', value: ADVERSARIAL_CODE },
        { kind: 'resourceAbsent', id: 'no-wrong-code-record', resource: 'adv-a-other' },
      ],
      budget: CONTINUATION_BUDGET,
    },
    {
      id: 'adversarial-continuation-drops-patient', category: 'adversarial', fixtureMode: 'continuation-drops-patient',
      question: 'Next links silently drop the patient constraint: every upstream page request must still carry it, and the other patient is never delivered.',
      steps: [paged(1)], fields, allowedErrors: ['UNVERIFIED_CONTINUATION'],
      checks: [{ kind: 'resourceAbsent', id: 'no-foreign-record', resource: 'adv-b1' }],
      budget: CONTINUATION_BUDGET,
    },
    {
      id: 'byte-ceiling-wire-boundary', category: 'byte-accounting', fixtureMode: 'wide-capability',
      prohibited: ['synthetic-wide-param-59'],
      question: 'Request a capability result at the tightest byte ceiling the gateway claims to meet; the independently measured MCP result must fit it.',
      steps: [
        { tool: 'fhir_capabilities', input: { topic: 'resource', resource_type: 'Observation' }, maxBytes: 131072 },
        { tool: 'fhir_capabilities', input: { topic: 'resource', resource_type: 'Observation' }, maxBytes: '{{bytes:0}}' },
      ],
      checks: [
        { kind: 'dataPath', id: 'custom-params-withheld', step: 0, path: 'searchParameters', equals: ['_id', 'patient', 'subject', 'code', 'category', 'date', 'status', 'value-quantity'] },
        { kind: 'dataPathIncludes', id: 'pinned-param-retained', step: 0, path: 'searchParameters', includes: 'code' },
        { kind: 'dataPath', id: 'boundary-size-driver', step: 0, path: 'interactions', equals: ['read', 'search-type', ...Array.from({ length: 14 }, () => 'read')] },
        { kind: 'dataPath', id: 'boundary-call-succeeded', step: 1, path: 'type', equals: 'Observation' },
      ],
      budget: { maxBytes: 12000, maxUpstreamCalls: 1, maxToolCalls: 2 },
    },
  ];
}

/**
 * Strict JSON task-file loader (gate F, spec §9): `{schema_version:'m3b-tasks/1',tasks:[...]}`.
 * Rejects unknown keys/kinds, duplicate ids, out-of-range steps/indexes and
 * nonpositive budgets. Executes no code from the file. Q/P author data only.
 */
const TASK_KEYS = new Set(['id', 'category', 'question', 'steps', 'fields', 'checks', 'budget', 'perCallBytes', 'expectedError', 'allowedErrors', 'prohibited', 'fixtureMode', 'knownDefects', 'corpus']);
const STEP_KEYS = new Set(['tool', 'input', 'drainPages', 'maxBytes']);
const CHECK_KINDS = new Set(['fact', 'factAbsent', 'resourceIds', 'resourceIdSet', 'resourceAbsent', 'dataPath', 'dataPathIncludes', 'envelopePath', 'schemaElement', 'withheld', 'omittedIncludes', 'upstreamConstraint', 'totalWithheldWhileMore', 'consistentAcross', 'constraintNotClaimed', 'decimalLexeme', 'citationTuple', 'queryEvidence', 'sortEvidence', 'callOutcome', 'upstreamWork']);
const TOOLS = new Set(['fhir_capabilities', 'fhir_search', 'fhir_read', 'fhir_page', 'fhir_result']);
const ADVERSARIAL_MODES_REF: Record<string, unknown> = ADVERSARIAL_MODES;
/** Exact allowed keys per check kind (G-3): a typo key must fail loading, never vacuously pass. */
const CHECK_KEYS: Record<string, readonly string[]> = {
  fact: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'resource', 'path', 'equals', 'version'],
  factAbsent: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'resource', 'path', 'version'],
  resourceIds: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'equals'],
  resourceIdSet: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'equals'],
  resourceAbsent: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'resource'],
  dataPath: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'path', 'equals'],
  dataPathIncludes: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'path', 'includes'],
  envelopePath: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'path', 'equals'],
  schemaElement: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'elementPath', 'types', 'min', 'max', 'jsonNamesInclude'],
  withheld: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'minCount', 'reasonsInclude'],
  omittedIncludes: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'path'],
  upstreamConstraint: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'name', 'value'],
  totalWithheldWhileMore: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index'],
  consistentAcross: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'path'],
  constraintNotClaimed: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'name'],
  decimalLexeme: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'resource_type', 'id_value', 'path', 'equals'],
  citationTuple: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'resource_type', 'id_value', 'source', 'version'],
  queryEvidence: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'state', 'query_exhausted', 'reasons_include', 'constraints'],
  sortEvidence: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'requested', 'effective', 'order'],
  callOutcome: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'outcome', 'code'],
  upstreamWork: ['kind', 'id', 'step', 'arms', 'incomparableReason', 'response_index', 'clinical', 'metadata'],
};
const EVAL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
function isRecord(v: unknown): v is Record<string, unknown> { return Boolean(v && typeof v === 'object' && !Array.isArray(v)); }
function bad(message: string): never { throw new Error(`m3b task file: ${message}`); }
function validateCheckRecord(check: unknown, taskId: string, stepCount: number, seenIds: Set<string>): void {
  if (!isRecord(check) || typeof check.id !== 'string' || !check.id || check.id.length > 120 || !CHECK_KINDS.has(String(check.kind))) bad(`task ${taskId} has an unknown check kind/id`);
  if (seenIds.has(check.id as string)) bad(`task ${taskId} has a duplicate check id`);
  seenIds.add(check.id as string);
  const kind = String(check.kind);
  const allowed = new Set(CHECK_KEYS[kind] ?? []);
  if (Object.keys(check).some(k => !allowed.has(k))) bad(`task ${taskId} check ${String(check.id)} has an unknown key`);
  const isM3b = M3B_CHECK_KINDS.has(kind);
  if (isM3b && check.step === undefined) bad(`task ${taskId} M3b check ${String(check.id)} requires an explicit step`);
  const step = check.step === undefined ? 0 : check.step;
  if (!Number.isInteger(step) || (step as number) < 0 || (step as number) >= stepCount) bad(`task ${taskId} check step out of range`);
  const ri = check.response_index;
  if (ri !== undefined && ri !== 'all' && (!Number.isInteger(ri) || (ri as number) < 0)) bad(`task ${taskId} check response_index invalid`);
  if (check.arms !== undefined && (!Array.isArray(check.arms) || !check.arms.every(a => a === 'fhir' || a === 'compact' || a === 'selected'))) bad(`task ${taskId} check arms invalid`);
  const str = (key: string, required = true): void => { const v = check[key]; if (v === undefined && !required) return; if (typeof v !== 'string' || !v || v.length > 512) bad(`task ${taskId} check ${String(check.id)} field ${key} invalid`); };
  const path = (key: string): void => { str(key); if (!EVAL_PATH.test(String(check[key])) || String(check[key]).split('.').length > 16) bad(`task ${taskId} check ${String(check.id)} path invalid`); };
  switch (kind) {
    case 'fact': str('resource'); path('path'); if (!('equals' in check)) bad(`task ${taskId} fact check needs equals`); if (check.version !== undefined) str('version'); break;
    case 'factAbsent': str('resource'); path('path'); if (check.version !== undefined) str('version'); break;
    case 'resourceIds': if (!Array.isArray(check.equals) || !check.equals.every(v => typeof v === 'string')) bad(`task ${taskId} resourceIds equals invalid`); break;
    case 'resourceIdSet': if (!Array.isArray(check.equals) || !check.equals.every(v => typeof v === 'string') || new Set(check.equals).size !== check.equals.length) bad(`task ${taskId} resourceIdSet equals invalid or duplicated`); break;
    case 'resourceAbsent': str('resource'); break;
    case 'dataPath': case 'envelopePath': path('path'); if (!('equals' in check)) bad(`task ${taskId} path check needs equals`); break;
    case 'dataPathIncludes': path('path'); if (!('includes' in check)) bad(`task ${taskId} dataPathIncludes needs includes`); break;
    case 'schemaElement': if (typeof check.elementPath !== 'string' || check.elementPath.length > 512 || !EVAL_PATH.test(check.elementPath.replace(/\[x\]/g, ''))) bad('invalid FHIR element path'); break;
    case 'withheld': if (!Number.isInteger(check.minCount) || (check.minCount as number) < 0) bad(`task ${taskId} withheld minCount invalid`); if (check.reasonsInclude !== undefined) str('reasonsInclude'); break;
    case 'omittedIncludes': if (typeof check.path !== 'string' || !/^\/(?:[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z0-9_]+)*)$/.test(check.path)) bad('omission path must be a bounded JSON pointer'); break;
    case 'consistentAcross': path('path'); break;
    case 'upstreamConstraint': str('name'); str('value'); break;
    case 'constraintNotClaimed': str('name'); break;
    case 'totalWithheldWhileMore': break;
    case 'decimalLexeme': str('resource_type'); str('id_value'); path('path'); if (typeof check.equals !== 'string' || !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(check.equals)) bad(`task ${taskId} decimalLexeme equals must be raw numeric token text`); break;
    case 'citationTuple': str('resource_type'); str('id_value'); str('source'); if (check.version !== null && typeof check.version !== 'string') bad(`task ${taskId} citationTuple version must be a string or null`); break;
    case 'queryEvidence': {
      if (!['complete_for_query', 'partial', 'unknown'].includes(String(check.state))) bad(`task ${taskId} queryEvidence state invalid`);
      if (check.query_exhausted !== null && typeof check.query_exhausted !== 'boolean') bad(`task ${taskId} queryEvidence query_exhausted invalid`);
      if (check.reasons_include !== undefined && (!Array.isArray(check.reasons_include) || check.reasons_include.length > 32 || !check.reasons_include.every(v => typeof v === 'string' && v.length <= 80))) bad(`task ${taskId} queryEvidence reasons_include invalid`);
      if (check.constraints !== undefined) {
        if (!Array.isArray(check.constraints) || check.constraints.length > 31) bad(`task ${taskId} queryEvidence constraints invalid`);
        for (const c of check.constraints as unknown[]) {
          if (!isRecord(c) || Object.keys(c).some(k => !['name', 'value', 'source_reported', 'execution'].includes(k))) bad(`task ${taskId} queryEvidence constraint has an unknown key`);
          if (typeof c.name !== 'string' || typeof c.value !== 'string' || !['matched', 'not_reported', 'not_checked'].includes(String(c.source_reported)) || !['gateway_enforced', 'tested_adapter', 'unknown'].includes(String(c.execution))) bad(`task ${taskId} queryEvidence constraint invalid`);
        }
      }
      break;
    }
    case 'sortEvidence': {
      if (!Array.isArray(check.requested) || check.requested.length > 4 || !check.requested.every(v => typeof v === 'string' && v.length <= 80)) bad(`task ${taskId} sortEvidence requested invalid`);
      if (check.effective !== null && (!Array.isArray(check.effective) || check.effective.length > 4 || !check.effective.every(v => typeof v === 'string' && v.length <= 80))) bad(`task ${taskId} sortEvidence effective invalid`);
      if (!['unspecified', 'requested_unverified', 'verified_by_adapter'].includes(String(check.order))) bad(`task ${taskId} sortEvidence order invalid`);
      break;
    }
    case 'callOutcome': if (!['json_rpc_error', 'sdk_text_error', 'application_error'].includes(String(check.outcome)) || (typeof check.code !== 'number' && typeof check.code !== 'string') || (typeof check.code === 'string' && (!check.code || /[*?]/.test(check.code)))) bad(`task ${taskId} callOutcome invalid`); break;
    case 'upstreamWork': {
      const count = (key: string): void => { const v = check[key]; if (v !== undefined && (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 1000)) bad(`task ${taskId} upstreamWork ${key} invalid`); };
      count('clinical'); count('metadata');
      if (check.clinical === undefined && check.metadata === undefined) bad(`task ${taskId} upstreamWork needs clinical or metadata`);
      break;
    }
    default: bad(`task ${taskId} has an unknown check kind`);
  }
}
export function parseM3bTaskFile(jsonText: string): EvalTask[] {
  let parsed: unknown;
  try { parsed = JSON.parse(jsonText); } catch { bad('not JSON'); }
  if (!isRecord(parsed)) bad('root must be an object');
  if (Object.keys(parsed!).some(k => !['schema_version', 'tasks'].includes(k))) bad('unknown root key');
  if (parsed!.schema_version !== M3B_TASKS_SCHEMA_VERSION) bad('schema_version must be m3b-tasks/1');
  if (!Array.isArray(parsed!.tasks)) bad('tasks must be an array');
  const ids = new Set<string>();
  const tasks = (parsed!.tasks as unknown[]).map((raw, i) => {
    if (!isRecord(raw)) bad(`task ${i} must be an object`);
    if (Object.keys(raw).some(k => !TASK_KEYS.has(k))) bad(`task ${i} has an unknown key`);
    const task = raw as unknown as EvalTask;
    if (task.corpus !== undefined && !['baseline','query','projection','usability'].includes(task.corpus)) bad('unknown task corpus');
    if (typeof task.id !== 'string' || !task.id || ids.has(task.id)) bad(`task ${i} has a missing/duplicate id`);
    ids.add(task.id);
    if (!Array.isArray(task.steps) || !task.steps.length) bad(`task ${task.id} needs steps`);
    for (const step of task.steps as unknown[]) {
      if (!isRecord(step) || Object.keys(step).some(k => !STEP_KEYS.has(k))) bad(`task ${task.id} has a malformed step`);
      if (!TOOLS.has(String(step.tool)) || !isRecord(step.input)) bad(`task ${task.id} has an unknown tool/input`);
    }
    if (!isRecord(task.budget) || !(Number(task.budget.maxBytes) > 0) || !(Number(task.budget.maxUpstreamCalls) >= 0) || !(Number(task.budget.maxToolCalls) > 0)) bad(`task ${task.id} has a nonpositive budget`);
    if (task.fixtureMode !== undefined && !(String(task.fixtureMode) in ADVERSARIAL_MODES_REF)) bad(`task ${task.id} has an unrecognized fixtureMode`);
    const checkReference = (value: unknown, step: number): void => {
      if (typeof value === 'string') {
        const match = /^\{\{(handle|cursor|discovery_cursor|bytes):(\d+)\}\}$/.exec(value);
        if (match && Number(match[2]) >= step) bad(`task ${task.id} contains a forward or missing response reference`);
      } else if (Array.isArray(value)) value.forEach(v => checkReference(v, step));
      else if (isRecord(value)) Object.values(value).forEach(v => checkReference(v, step));
    };
    task.steps.forEach((step, index) => { checkReference(step.input, index); checkReference(step.maxBytes, index); });
    if (!Array.isArray(task.checks)) bad(`task ${task.id} needs checks`);
    const checkIds = new Set<string>();
    for (const check of task.checks as unknown[]) {
      validateCheckRecord(check, task.id, task.steps.length, checkIds);
    }
    return task;
  });
  return tasks;
}

/**
 * Independent semantic-oracle vector format (freeze item 7, G-3f): strict
 * `{schema_version:'m3b-oracle/1', vectors:[...]}`, hashed over canonical JSON.
 * Vectors are authored independently of fixture execution code; the loader
 * only validates shape/bounds and returns the content hash.
 */
export const M3B_ORACLE_SCHEMA_VERSION = 'm3b-oracle/1' as const;
export interface OracleVector { id: string; resource_type: string; parameter: string; value: string; resource: Record<string, unknown>; matches: boolean }
export function parseM3bOracleFile(jsonText: string): { vectors: OracleVector[]; sha256: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(jsonText); } catch { bad('oracle file is not JSON'); }
  if (!isRecord(parsed)) bad('oracle root must be an object');
  if (Object.keys(parsed!).some(k => !['schema_version', 'vectors'].includes(k))) bad('oracle file has an unknown root key');
  if (parsed!.schema_version !== M3B_ORACLE_SCHEMA_VERSION) bad('oracle schema_version must be m3b-oracle/1');
  if (!Array.isArray(parsed!.vectors) || parsed!.vectors.length > 1000) bad('oracle vectors invalid');
  const ids = new Set<string>();
  const vectors = (parsed!.vectors as unknown[]).map(raw => {
    if (!isRecord(raw) || Object.keys(raw).some(k => !['id', 'resource_type', 'parameter', 'value', 'resource', 'matches'].includes(k))) bad('oracle vector has an unknown key');
    const v = raw as unknown as OracleVector;
    if (typeof v.id !== 'string' || !v.id || ids.has(v.id)) bad('oracle vector id missing/duplicate');
    ids.add(v.id);
    if (typeof v.resource_type !== 'string' || typeof v.parameter !== 'string' || typeof v.value !== 'string' || typeof v.matches !== 'boolean' || !isRecord(v.resource)) bad(`oracle vector ${v.id} invalid`);
    return v;
  });
  return { vectors, sha256: createHash('sha256').update(canonicalJson(vectors)).digest('hex') };
}

/**
 * Digest-resolution signature (freeze item 7): resolves a coverage query_digest
 * to the requested constraints/sort recorded when the digest was minted.
 * Resource facts/provenance always stay response-local; digests never do.
 */
export interface DigestEntry { constraints: readonly { name: string; value: string }[]; sort?: readonly string[] }
export type DigestResolver = (digest: string) => DigestEntry | undefined;
export function createDigestResolver(entries: Readonly<Record<string, DigestEntry>>): DigestResolver {
  const map = new Map(Object.entries(entries));
  return digest => (/^[a-f0-9]{64}$/.test(digest) ? map.get(digest) : undefined);
}

// Auxiliary tasks stay outside TASKS so the qualified external task identity remains byte-for-byte stable.
export const USABILITY_TASKS: EvalTask[] = [];

// Keep source order deterministic: established tasks, Q, then P. Strict loaders
// reject duplicate task/check identities and unknown behavior IDs before serving.
for (const file of ['data/m3b-query-tasks.json', 'data/m3b-projection-tasks.json', 'data/s7a-usability-tasks.json']) {
  const loaded = parseM3bTaskFile(evalDataText(file));
  for (const task of loaded) {
    if ([...TASKS, ...USABILITY_TASKS].some(t => t.id === task.id)) throw new Error('Duplicate eval task identity.');
    task.corpus = file.includes('usability') ? 'usability' : file.includes('query') ? 'query' : 'projection';
    (task.corpus === 'usability' ? USABILITY_TASKS : TASKS).push(task);
  }
}
