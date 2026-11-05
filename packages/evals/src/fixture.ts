import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// Golden synthetic FHIR R4 fixture owned by the retrieval eval (v0).
// Every resource below is invented for this eval; no real patient data.
// The trusted gateway patient is eval-patient-a. eval-patient-b exists only
// so denial / non-disclosure checks have something to refuse.

export type GoldenResource = Record<string, unknown> & { resourceType: string; id: string };

export const EVAL_PATIENT_ID = 'eval-patient-a';
export const OTHER_PATIENT_ID = 'eval-patient-b';
export const EVAL_SOURCE_ALIAS = 'eval-fixture';

// Prohibited disclosure sentinels: these literals live only inside withheld
// payloads / signed links / the other patient's records and must never appear
// in any gateway envelope produced during the eval.
export const SECRET_DOC_PAYLOAD = 'EVAL_SECRET_DOC_PAYLOAD_7f3a';
export const SECRET_REPORT_PAYLOAD = 'EVAL_SECRET_REPORT_PAYLOAD_91bc';
export const SECRET_LINK_TOKEN = 'EVAL_SECRET_LINK_TOKEN_44d2';
export const SECRET_OTHER_PATIENT_NOTE = 'EVAL_SECRET_OTHER_PATIENT_NOTE_08e6';
export const GLOBAL_PROHIBITED: readonly string[] = [
  SECRET_DOC_PAYLOAD, SECRET_REPORT_PAYLOAD, SECRET_LINK_TOKEN, SECRET_OTHER_PATIENT_NOTE, OTHER_PATIENT_ID,
];

const META = { versionId: '1', lastUpdated: '2025-01-15T00:00:00.000Z' };
const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const SNOMED = 'http://snomed.info/sct';
const SYNTH = 'http://example.invalid/synthetic-eval';

const cc = (system: string, code: string, display?: string) => ({ coding: [{ system, code, ...(display ? { display } : {}) }] });
const subjectA = { reference: `Patient/${EVAL_PATIENT_ID}` };
const lab = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory', display: 'Laboratory' }] }];
const vitals = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' }] }];

function obs(id: string, extra: Record<string, unknown>): GoldenResource {
  return { resourceType: 'Observation', id, meta: META, status: 'final', subject: subjectA, ...extra };
}
function qtyObs(id: string, code: string, display: string, value: number, unit: string, date: string, extra: Record<string, unknown> = {}): GoldenResource {
  return obs(id, {
    category: lab, code: { ...cc(LOINC, code, display), text: display }, effectiveDateTime: date, issued: date,
    valueQuantity: { value, unit, system: UCUM, code: unit }, ...extra,
  });
}

const heartRates: GoldenResource[] = Array.from({ length: 12 }, (_, i) => obs(`obs-hr-${String(i + 1).padStart(2, '0')}`, {
  category: vitals, code: { ...cc(LOINC, '8867-4', 'Heart rate'), text: 'Heart rate' },
  effectiveDateTime: `2025-02-${String(i + 1).padStart(2, '0')}T09:00:00.000Z`,
  valueQuantity: { value: 60 + i, unit: 'beats/minute', system: UCUM, code: '/min' },
}));
const respRates: GoldenResource[] = Array.from({ length: 4 }, (_, i) => obs(`obs-rr-${i + 1}`, {
  category: vitals, code: { ...cc(LOINC, '9279-1', 'Respiratory rate'), text: 'Respiratory rate' },
  effectiveDateTime: `2025-03-0${i + 1}T09:00:00.000Z`,
  valueQuantity: { value: 12 + i, unit: 'breaths/minute', system: UCUM, code: '/min' },
}));

export const GOLDEN_RESOURCES: GoldenResource[] = [
  {
    resourceType: 'Patient', id: EVAL_PATIENT_ID, meta: META, active: true,
    identifier: [{ system: `${SYNTH}/mrn`, value: 'synthetic-mrn-a' }],
    name: [{ use: 'official', family: 'SyntheticA', given: ['Alpha'] }], gender: 'female', birthDate: '1990-01-15',
  },
  {
    resourceType: 'Patient', id: OTHER_PATIENT_ID, meta: META, active: true,
    identifier: [{ system: `${SYNTH}/mrn`, value: 'synthetic-mrn-b' }],
    name: [{ use: 'official', family: 'SyntheticB', given: ['Beta'] }], gender: 'male', birthDate: '1985-06-20',
  },
  qtyObs('obs-hba1c-1', '4548-4', 'Hemoglobin A1c/Hemoglobin.total in Blood', 5.4, '%', '2025-02-10T08:00:00.000Z', {
    referenceRange: [{ low: { value: 4, unit: '%', system: UCUM, code: '%' }, high: { value: 5.6, unit: '%', system: UCUM, code: '%' } }],
  }),
  qtyObs('obs-glucose-1', '2345-7', 'Glucose [Mass/volume] in Serum or Plasma', 95, 'mg/dL', '2025-01-10T08:00:00.000Z', {
    interpretation: [cc('http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', 'N', 'Normal')],
    referenceRange: [{ low: { value: 70, unit: 'mg/dL', system: UCUM, code: 'mg/dL' }, high: { value: 99, unit: 'mg/dL', system: UCUM, code: 'mg/dL' }, text: 'Fasting synthetic range' }],
  }),
  qtyObs('obs-glucose-2', '2345-7', 'Glucose [Mass/volume] in Serum or Plasma', 102, 'mg/dL', '2025-03-10T08:00:00.000Z', {
    interpretation: [cc('http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', 'H', 'High')],
    referenceRange: [{ low: { value: 70, unit: 'mg/dL', system: UCUM, code: 'mg/dL' }, high: { value: 99, unit: 'mg/dL', system: UCUM, code: 'mg/dL' } }],
  }),
  qtyObs('obs-glucose-3', '2345-7', 'Glucose [Mass/volume] in Serum or Plasma', 88, 'mg/dL', '2025-04-10T08:00:00.000Z'),
  qtyObs('obs-glucose-error', '2345-7', 'Glucose [Mass/volume] in Serum or Plasma', 999, 'mg/dL', '2025-03-11T08:00:00.000Z', { status: 'entered-in-error' }),
  qtyObs('obs-glucose-prelim', '2345-7', 'Glucose [Mass/volume] in Serum or Plasma', 110, 'mg/dL', '2025-05-01T08:00:00.000Z', { status: 'preliminary' }),
  obs('obs-troponin-1', {
    category: lab, code: { ...cc(LOINC, '10839-9', 'Troponin I.cardiac [Mass/volume]'), text: 'Troponin I' },
    effectiveDateTime: '2025-02-11T08:00:00.000Z',
    valueQuantity: { value: 10, comparator: '<', unit: 'ng/L', system: UCUM, code: 'ng/L' },
  }),
  // J-6 raw-lexeme decimal case: this object supplies ids/versions for the harness, while direct reads are
  // served from RAW_READ_BODIES below so the upstream JSON carries non-canonical number lexemes (7.0, 120.00).
  obs('obs-decimal-1', {
    category: lab, code: { ...cc(SYNTH, 'synthetic-decimal', 'Synthetic decimal result'), text: 'Synthetic decimal result' },
    effectiveDateTime: '2025-02-16T08:00:00.000Z',
    valueQuantity: { value: 7, unit: 'mmol/L', system: UCUM, code: 'mmol/L' },
    referenceRange: [{ low: { value: 0.01, unit: 'mmol/L', system: UCUM, code: 'mmol/L' }, high: { value: 120, unit: 'mmol/L', system: UCUM, code: 'mmol/L' } }],
  }),
  obs('obs-codeable-1', {
    category: lab, code: { ...cc(LOINC, '94500-6', 'Synthetic assay panel'), text: 'Synthetic assay' },
    effectiveDateTime: '2025-02-12T08:00:00.000Z',
    valueCodeableConcept: { ...cc(SNOMED, '260415000', 'Not detected'), text: 'Not detected' },
  }),
  obs('obs-string-1', {
    category: lab, code: { ...cc(SYNTH, 'synthetic-string-result', 'Synthetic string result'), text: 'Synthetic string result' },
    effectiveDateTime: '2025-02-13T08:00:00.000Z', valueString: 'Synthetic string result alpha',
  }),
  obs('obs-boolean-1', {
    category: lab, code: { ...cc(SYNTH, 'synthetic-screen', 'Synthetic screen'), text: 'Synthetic screen' },
    effectiveDateTime: '2025-02-14T08:00:00.000Z', valueBoolean: false,
  }),
  obs('obs-integer-1', {
    code: { ...cc(LOINC, '72514-3', 'Pain severity score'), text: 'Pain severity score' },
    effectiveDateTime: '2025-02-15T08:00:00.000Z', valueInteger: 3,
  }),
  obs('obs-bp-1', {
    category: vitals, code: { ...cc(LOINC, '85354-9', 'Blood pressure panel'), text: 'Blood pressure panel' },
    effectiveDateTime: '2025-03-11T09:30:00.000Z',
    component: [
      { code: cc(LOINC, '8480-6', 'Systolic blood pressure'), valueQuantity: { value: 118, unit: 'mmHg', system: UCUM, code: 'mm[Hg]' } },
      { code: cc(LOINC, '8462-4', 'Diastolic blood pressure'), valueQuantity: { value: 76, unit: 'mmHg', system: UCUM, code: 'mm[Hg]' } },
    ],
  }),
  obs('obs-absent-1', {
    category: lab, code: { ...cc(LOINC, '2093-3', 'Cholesterol [Mass/volume]'), text: 'Cholesterol' },
    effectiveDateTime: '2025-06-01T08:00:00.000Z',
    dataAbsentReason: { ...cc('http://terminology.hl7.org/CodeSystem/data-absent-reason', 'not-performed', 'Not Performed'), text: 'Not performed (synthetic)' },
  }),
  obs('obs-period-1', {
    category: lab, code: { ...cc(SYNTH, 'synthetic-24h-volume', 'Synthetic 24h volume'), text: 'Synthetic 24h volume' },
    effectivePeriod: { start: '2025-02-20T08:00:00.000Z', end: '2025-02-21T08:00:00.000Z' },
    valueQuantity: { value: 1500, unit: 'mL', system: UCUM, code: 'mL' },
  }),
  obs('obs-signed-link', {
    category: lab, code: { ...cc(SYNTH, 'synthetic-linked-result', 'Synthetic linked result'), text: 'Synthetic linked result' },
    effectiveDateTime: '2025-02-22T08:00:00.000Z', valueQuantity: { value: 42, unit: 'U/L', system: UCUM, code: 'U/L' },
    extension: [{ url: `${SYNTH}/external-result`, valueUri: `https://files.invalid/result?access_token=${SECRET_LINK_TOKEN}` }],
  }),
  obs('obs-contained-b', {
    code: { ...cc(SYNTH, 'synthetic-contained', 'Synthetic contained'), text: 'Synthetic contained' },
    effectiveDateTime: '2025-02-23T08:00:00.000Z', valueQuantity: { value: 1, unit: 'U/L', system: UCUM, code: 'U/L' },
    contained: [{ resourceType: 'Patient', id: OTHER_PATIENT_ID }],
  }),
  ...heartRates,
  ...respRates,
  obs('obs-b-glucose', {
    category: lab, code: { ...cc(LOINC, '2345-7', 'Glucose'), text: 'Glucose' }, subject: { reference: `Patient/${OTHER_PATIENT_ID}` },
    effectiveDateTime: '2025-01-12T08:00:00.000Z', valueQuantity: { value: 140, unit: 'mg/dL', system: UCUM, code: 'mg/dL' },
    note: [{ text: SECRET_OTHER_PATIENT_NOTE }],
  }),
  {
    resourceType: 'Condition', id: 'cond-diabetes', meta: META,
    clinicalStatus: cc('http://terminology.hl7.org/CodeSystem/condition-clinical', 'active', 'Active'),
    verificationStatus: cc('http://terminology.hl7.org/CodeSystem/condition-ver-status', 'confirmed', 'Confirmed'),
    category: [cc('http://terminology.hl7.org/CodeSystem/condition-category', 'problem-list-item', 'Problem List Item')],
    code: { ...cc(SNOMED, '73211009', 'Diabetes mellitus (disorder)'), text: 'Diabetes mellitus (synthetic)' },
    subject: subjectA, onsetDateTime: '2024-05-01T00:00:00.000Z', recordedDate: '2024-05-03T00:00:00.000Z',
  },
  {
    resourceType: 'Condition', id: 'cond-resolved', meta: META,
    clinicalStatus: cc('http://terminology.hl7.org/CodeSystem/condition-clinical', 'resolved', 'Resolved'),
    verificationStatus: cc('http://terminology.hl7.org/CodeSystem/condition-ver-status', 'confirmed', 'Confirmed'),
    code: { ...cc(SNOMED, '195967001', 'Asthma (disorder)'), text: 'Asthma (synthetic)' },
    subject: subjectA, onsetDateTime: '2020-01-01T00:00:00.000Z', recordedDate: '2020-01-05T00:00:00.000Z',
  },
  {
    resourceType: 'Condition', id: 'cond-error', meta: META,
    clinicalStatus: cc('http://terminology.hl7.org/CodeSystem/condition-clinical', 'inactive', 'Inactive'),
    verificationStatus: cc('http://terminology.hl7.org/CodeSystem/condition-ver-status', 'entered-in-error', 'Entered in Error'),
    code: { ...cc(SYNTH, 'synthetic-erroneous-condition', 'Synthetic erroneous condition'), text: 'Synthetic erroneous condition' },
    subject: subjectA, recordedDate: '2025-01-20T00:00:00.000Z',
  },
  {
    resourceType: 'AllergyIntolerance', id: 'allergy-1', meta: META,
    clinicalStatus: cc('http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', 'active', 'Active'),
    verificationStatus: cc('http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', 'confirmed', 'Confirmed'),
    code: { ...cc(SNOMED, '91935009', 'Allergy to peanut (finding)'), text: 'Peanut allergy (synthetic)' },
    patient: subjectA, recordedDate: '2024-06-01T00:00:00.000Z',
    reaction: [{ manifestation: [{ ...cc(SNOMED, '247472004', 'Hives (disorder)'), text: 'Hives' }], severity: 'moderate' }],
  },
  {
    resourceType: 'MedicationRequest', id: 'medreq-1', meta: META, status: 'active', intent: 'order',
    medicationCodeableConcept: { ...cc(SYNTH, 'synthetic-rx-001', 'Synthetic Medication One'), text: 'Synthetic Medication One' },
    subject: subjectA, authoredOn: '2025-01-20T10:00:00.000Z',
    dosageInstruction: [{ text: 'One tablet twice daily (synthetic)', doseAndRate: [{ doseQuantity: { value: 1, unit: 'tablet', system: UCUM, code: '{tablet}' } }] }],
  },
  {
    resourceType: 'DocumentReference', id: 'doc-1', meta: META, status: 'current', subject: subjectA, date: '2025-02-01T10:00:00.000Z',
    type: { ...cc(SYNTH, 'synthetic-summary', 'Synthetic summary'), text: 'Synthetic summary' },
    content: [{ attachment: { contentType: 'application/pdf', data: SECRET_DOC_PAYLOAD, url: `https://files.invalid/doc?token=${SECRET_LINK_TOKEN}`, size: 1234, hash: 'c3ludGhldGljLWhhc2g=' } }],
  },
  {
    resourceType: 'DiagnosticReport', id: 'report-1', meta: META, status: 'final', subject: subjectA,
    code: { ...cc(SYNTH, 'synthetic-lab-panel', 'Synthetic lab panel'), text: 'Synthetic lab panel' },
    effectiveDateTime: '2025-02-10T09:00:00.000Z', issued: '2025-02-10T10:00:00.000Z',
    result: [{ reference: 'Observation/obs-hba1c-1' }, { reference: 'Observation/obs-glucose-1' }],
    conclusion: 'Synthetic conclusion alpha',
    presentedForm: [{ contentType: 'application/pdf', data: SECRET_REPORT_PAYLOAD, size: 4321 }],
  },
  {
    resourceType: 'Immunization', id: 'imm-1', meta: META, status: 'completed', patient: subjectA,
    vaccineCode: { ...cc(SYNTH, 'synthetic-vaccine-001', 'Synthetic Vaccine One'), text: 'Synthetic Vaccine One' },
    occurrenceDateTime: '2025-01-05T10:00:00.000Z', lotNumber: 'synthetic-lot-1',
  },
];

// Adversarial fixture modes (J-19): the server misbehaves in one named way per mode. Modes serve only the
// adversarial pool below (plus the two Patients), so golden tasks never see these records.
export const ADVERSARIAL_CODE = `${SYNTH}|synthetic-adversarial-target`;
const advObs = (id: string, patient: string, code: string, day: number, value: number, extra: Record<string, unknown> = {}): GoldenResource => ({
  resourceType: 'Observation', id, meta: META, status: 'final', subject: { reference: `Patient/${patient}` },
  code: { ...cc(SYNTH, code, 'Synthetic adversarial observation'), text: 'Synthetic adversarial observation' },
  effectiveDateTime: `2025-07-0${day}T08:00:00.000Z`, valueQuantity: { value, unit: 'U/L', system: UCUM, code: 'U/L' }, ...extra,
});
export const ADVERSARIAL_RESOURCES: GoldenResource[] = [
  advObs('adv-a1', EVAL_PATIENT_ID, 'synthetic-adversarial-target', 1, 11),
  advObs('adv-a-other', EVAL_PATIENT_ID, 'synthetic-adversarial-other', 2, 99),
  advObs('adv-a2', EVAL_PATIENT_ID, 'synthetic-adversarial-target', 3, 12),
  advObs('adv-a3', EVAL_PATIENT_ID, 'synthetic-adversarial-target', 4, 13),
  advObs('adv-b1', OTHER_PATIENT_ID, 'synthetic-adversarial-target', 5, 14, { note: [{ text: SECRET_OTHER_PATIENT_NOTE }] }),
];
/** Appended as `search.mode=include` entries: a same-patient, same-type record and the other patient. */
export const ADVERSARIAL_INCLUDES: GoldenResource[] = [
  advObs('adv-include-a', EVAL_PATIENT_ID, 'synthetic-adversarial-include', 6, 15),
  { resourceType: 'Patient', id: OTHER_PATIENT_ID, meta: META, active: true },
];
export interface AdversarialBehavior {
  description: string;
  /** Serve the adversarial pool instead of the golden resources. */
  adversarialPool?: boolean;
  /** Parameters the server echoes in its self link but silently does not apply. */
  ignoreFilters?: string[];
  /** Parameters the server applies but omits from its self link. */
  selfLinkDrop?: string[];
  /** Parameters removed from every next link. */
  nextLinkDrop?: string[];
  /** Append ADVERSARIAL_INCLUDES as include-mode entries to every searchset. */
  includeEntries?: boolean;
  /** Extra declared Observation search parameters, to place capability results near a byte ceiling. */
  extraObservationSearchParams?: number;
  /** Declare confinement/date parameters with types conflicting with pinned R4 (§9 conflicting-types). */
  conflictingTypes?: boolean;
}
export const ADVERSARIAL_MODES = {
  'self-link-omits-filter': { description: 'Applies every filter but its self link omits the code constraint.', adversarialPool: true, selfLinkDrop: ['code'] },
  'self-link-claims-unapplied-filter': { description: 'Self link echoes the code constraint the server silently ignored.', adversarialPool: true, ignoreFilters: ['code'] },
  'include-entries': { description: 'Searchsets carry include-mode entries: a same-patient Observation and the other Patient.', adversarialPool: true, includeEntries: true },
  'page2-suppression': { description: 'Server ignores the patient filter; the other patient appears on page 2 after page 1 reported a total.', adversarialPool: true, ignoreFilters: ['patient', 'subject'] },
  'continuation-drops-filter': { description: 'Next links silently drop the code constraint.', adversarialPool: true, nextLinkDrop: ['code'] },
  'continuation-drops-patient': { description: 'Next links silently drop the patient constraint.', adversarialPool: true, nextLinkDrop: ['patient', 'subject'] },
  'wide-capability': { description: 'Observation declares 60 extra search parameters.', extraObservationSearchParams: 60 },
  'conflicting-types': { description: 'Confinement and date parameters are declared with types conflicting with pinned R4; resolvers must refuse before searching.', conflictingTypes: true },
} as const satisfies Record<string, AdversarialBehavior>;
export type AdversarialMode = keyof typeof ADVERSARIAL_MODES;

/**
 * Verbatim read bodies for cases ordinary JSON.stringify cannot produce (J-6): the decimal Observation is served
 * with its source number lexemes intact (7.0, 0.0100, 120.00) so the gateway must preserve, not round, them.
 */
export const RAW_READ_BODIES: Record<string, string> = {
  'obs-decimal-1': `{"resourceType":"Observation","id":"obs-decimal-1","meta":{"versionId":"1","lastUpdated":"2025-01-15T00:00:00.000Z"},"status":"final","category":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/observation-category","code":"laboratory","display":"Laboratory"}]}],"code":{"coding":[{"system":"${SYNTH}","code":"synthetic-decimal","display":"Synthetic decimal result"}],"text":"Synthetic decimal result"},"subject":{"reference":"Patient/${EVAL_PATIENT_ID}"},"effectiveDateTime":"2025-02-16T08:00:00.000Z","valueQuantity":{"value":7.0,"unit":"mmol/L","system":"http://unitsofmeasure.org","code":"mmol/L"},"referenceRange":[{"low":{"value":0.0100,"unit":"mmol/L","system":"http://unitsofmeasure.org","code":"mmol/L"},"high":{"value":120.00,"unit":"mmol/L","system":"http://unitsofmeasure.org","code":"mmol/L"}}]}`,
};

export const SEARCH_PARAMS: Record<string, string[]> = {
  Patient: ['_id', 'link', 'identifier', 'name', 'family', 'given', 'birthdate', 'gender', 'active'],
  Observation: ['_id', 'patient', 'subject', 'code', 'category', 'date', 'status', 'value-quantity'],
  Condition: ['_id', 'patient', 'subject', 'code', 'category', 'clinical-status', 'verification-status', 'onset-date', 'recorded-date'],
  AllergyIntolerance: ['_id', 'patient', 'code', 'clinical-status', 'verification-status'],
  MedicationRequest: ['_id', 'patient', 'subject', 'code', 'status', 'intent'],
  DocumentReference: ['_id', 'patient', 'subject', 'status', 'category', 'type', 'date'],
  DiagnosticReport: ['_id', 'patient', 'subject', 'code', 'status', 'date'],
  Immunization: ['_id', 'patient', 'status', 'vaccine-code', 'date'],
};
export const FIXTURE_RESOURCE_TYPES = Object.keys(SEARCH_PARAMS);

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function fixtureSha256(resources: readonly GoldenResource[] = GOLDEN_RESOURCES, searchParams: Record<string, string[]> = SEARCH_PARAMS, rawReadBodies: Record<string, string> = RAW_READ_BODIES, fragmentResources?: readonly unknown[]): string {
  const adversarial = { resources: ADVERSARIAL_RESOURCES, includes: ADVERSARIAL_INCLUDES, modes: ADVERSARIAL_MODES };
  // F-5: raw read bodies override the served decimal response verbatim (value and lexeme), so the
  // fingerprint must cover those strings; normalized golden objects alone cannot see them.
  // Q-2: callers pinning adapter proof pass the seeded fragment resources so
  // the profile hash covers the exact decoy set the proof tasks execute on.
  return createHash('sha256').update(canonicalJson({ resources, searchParams, adversarial, rawReadBodies, ...(fragmentResources !== undefined ? { fragmentResources } : {}) })).digest('hex');
}

/**
 * Per-(resource,name) R4 types + canonical definitions (G-2, spec §9), keyed by
 * `${resourceType}.${name}` and resolved against the pinned hl7.fhir.r4.core
 * 4.0.1 archive (example-named SearchParameters excluded). A blanket name map
 * is wrong: e.g. `subject` is each type's own `*-subject` definition, and
 * `clinical-subject` does not exist in R4. Confinement parameters must match
 * canonically so Q never loosens matching to make the fixture work.
 */
const SP = 'http://hl7.org/fhir/SearchParameter';
export const SEARCH_PARAM_DEFS: Record<string, { type: string; definition: string }> = {
  'Patient.link': { type: 'reference', definition: `${SP}/Patient-link` },
  'Patient._id': { type: 'token', definition: `${SP}/Resource-id` },
  'Patient.identifier': { type: 'token', definition: `${SP}/Patient-identifier` },
  'Patient.name': { type: 'string', definition: `${SP}/Patient-name` },
  'Patient.family': { type: 'string', definition: `${SP}/individual-family` },
  'Patient.given': { type: 'string', definition: `${SP}/individual-given` },
  'Patient.birthdate': { type: 'date', definition: `${SP}/individual-birthdate` },
  'Patient.gender': { type: 'token', definition: `${SP}/individual-gender` },
  'Patient.active': { type: 'token', definition: `${SP}/Patient-active` },
  'Observation._id': { type: 'token', definition: `${SP}/Resource-id` },
  'Observation.patient': { type: 'reference', definition: `${SP}/clinical-patient` },
  'Observation.subject': { type: 'reference', definition: `${SP}/Observation-subject` },
  'Observation.code': { type: 'token', definition: `${SP}/clinical-code` },
  'Observation.category': { type: 'token', definition: `${SP}/Observation-category` },
  'Observation.date': { type: 'date', definition: `${SP}/clinical-date` },
  'Observation.status': { type: 'token', definition: `${SP}/Observation-status` },
  'Observation.value-quantity': { type: 'quantity', definition: `${SP}/Observation-value-quantity` },
  'Condition._id': { type: 'token', definition: `${SP}/Resource-id` },
  'Condition.patient': { type: 'reference', definition: `${SP}/clinical-patient` },
  'Condition.subject': { type: 'reference', definition: `${SP}/Condition-subject` },
  'Condition.code': { type: 'token', definition: `${SP}/clinical-code` },
  'Condition.category': { type: 'token', definition: `${SP}/Condition-category` },
  'Condition.clinical-status': { type: 'token', definition: `${SP}/Condition-clinical-status` },
  'Condition.verification-status': { type: 'token', definition: `${SP}/Condition-verification-status` },
  'Condition.onset-date': { type: 'date', definition: `${SP}/Condition-onset-date` },
  'Condition.recorded-date': { type: 'date', definition: `${SP}/Condition-recorded-date` },
  'AllergyIntolerance._id': { type: 'token', definition: `${SP}/Resource-id` },
  'AllergyIntolerance.patient': { type: 'reference', definition: `${SP}/clinical-patient` },
  'AllergyIntolerance.code': { type: 'token', definition: `${SP}/clinical-code` },
  'AllergyIntolerance.clinical-status': { type: 'token', definition: `${SP}/AllergyIntolerance-clinical-status` },
  'AllergyIntolerance.verification-status': { type: 'token', definition: `${SP}/AllergyIntolerance-verification-status` },
  'MedicationRequest._id': { type: 'token', definition: `${SP}/Resource-id` },
  'MedicationRequest.patient': { type: 'reference', definition: `${SP}/clinical-patient` },
  'MedicationRequest.subject': { type: 'reference', definition: `${SP}/MedicationRequest-subject` },
  'MedicationRequest.code': { type: 'token', definition: `${SP}/clinical-code` },
  'MedicationRequest.status': { type: 'token', definition: `${SP}/medications-status` },
  'MedicationRequest.intent': { type: 'token', definition: `${SP}/MedicationRequest-intent` },
  'DocumentReference._id': { type: 'token', definition: `${SP}/Resource-id` },
  'DocumentReference.patient': { type: 'reference', definition: `${SP}/clinical-patient` },
  'DocumentReference.subject': { type: 'reference', definition: `${SP}/DocumentReference-subject` },
  'DocumentReference.status': { type: 'token', definition: `${SP}/DocumentReference-status` },
  'DocumentReference.category': { type: 'token', definition: `${SP}/DocumentReference-category` },
  'DocumentReference.type': { type: 'token', definition: `${SP}/clinical-type` },
  'DocumentReference.date': { type: 'date', definition: `${SP}/DocumentReference-date` },
  'DiagnosticReport._id': { type: 'token', definition: `${SP}/Resource-id` },
  'DiagnosticReport.patient': { type: 'reference', definition: `${SP}/clinical-patient` },
  'DiagnosticReport.subject': { type: 'reference', definition: `${SP}/DiagnosticReport-subject` },
  'DiagnosticReport.code': { type: 'token', definition: `${SP}/clinical-code` },
  'DiagnosticReport.status': { type: 'token', definition: `${SP}/DiagnosticReport-status` },
  'DiagnosticReport.date': { type: 'date', definition: `${SP}/clinical-date` },
  'Immunization._id': { type: 'token', definition: `${SP}/Resource-id` },
  'Immunization.patient': { type: 'reference', definition: `${SP}/clinical-patient` },
  'Immunization.status': { type: 'token', definition: `${SP}/Immunization-status` },
  'Immunization.vaccine-code': { type: 'token', definition: `${SP}/Immunization-vaccine-code` },
  'Immunization.date': { type: 'date', definition: `${SP}/clinical-date` },
};
export function searchParamDeclaration(resourceType: string, name: string): { name: string; type: string; definition?: string } {
  const def = SEARCH_PARAM_DEFS[`${resourceType}.${name}`];
  return def ? { name, type: def.type, definition: def.definition } : { name, type: 'token' };
}
const wideParams = (count: number) => Array.from({ length: count }, (_, i) => `synthetic-wide-param-${String(i).padStart(2, '0')}`);
function capabilityStatement(behavior?: AdversarialBehavior): Record<string, unknown> {
  return {
    resourceType: 'CapabilityStatement', id: 'eval-fixture-metadata', status: 'active',
    date: '2025-01-15T00:00:00.000Z', kind: 'instance', fhirVersion: '4.0.1',
    format: ['application/fhir+json'],
    software: { name: 'fhir-mcp retrieval eval fixture', version: '0.1.0' },
    implementation: { description: 'Synthetic-only local eval fixture. Not a clinical system.' },
    rest: [{
      mode: 'server',
      resource: FIXTURE_RESOURCE_TYPES.map(type => ({
        type, interaction: [{ code: 'read' }, { code: 'search-type' },
          // Wide-cell size driver uses only valid R4 interaction codes; custom names stay withheld.
          ...(type === 'Observation' && behavior?.extraObservationSearchParams ? Array.from({ length: 100 }, () => ({ code: 'read' })) : [])],
        searchParam: [...(SEARCH_PARAMS[type] ?? []), ...(type === 'Observation' ? wideParams(behavior?.extraObservationSearchParams ?? 0) : [])].map(name => {
          const declared = searchParamDeclaration(type, name);
          // §9 conflicting-types: confinement (patient/subject) and date params lie about their R4 type.
          if (behavior?.conflictingTypes && (declared.type === 'reference' || declared.type === 'date')) return { ...declared, type: 'token' };
          return declared;
        }),
      })),
    }],
  };
}

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Rec : undefined);

function codingsOf(value: unknown): { system?: string; code?: string }[] {
  const out: { system?: string; code?: string }[] = [];
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(collect); return; }
    const r = asRec(v); if (!r) return;
    if (typeof r.code === 'string' || typeof r.system === 'string') out.push({ system: typeof r.system === 'string' ? r.system : undefined, code: typeof r.code === 'string' ? r.code : undefined });
    if (r.coding !== undefined) collect(r.coding);
  };
  collect(value);
  return out;
}
// Q-2/Q-6 fixture execution mirrors R4 escaping exactly once: split on
// unescaped commas, split system/code on the first unescaped pipe, then
// unescape. `|code` means NO system; an escaped comma stays inside a code
// (A.8 `local\,hba1c`). Illegal/overflowing values simply never match.
const FIXTURE_ESCAPABLE = ',|$\\';
function fixtureUnescape(raw: string): string | undefined {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') {
      const next = raw[i + 1];
      if (next === undefined || !FIXTURE_ESCAPABLE.includes(next)) return undefined;
      out += next; i++;
    } else out += raw[i];
  }
  return out;
}
function splitFixtureEscaped(value: string): string[] {
  if (value.length > 2048) return [];
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === '\\') {
      const next = value[i + 1];
      if (next === undefined || !FIXTURE_ESCAPABLE.includes(next)) return [];
      current += next; i++;
    } else if (char === ',') {
      parts.push(current); current = '';
      if (parts.length >= 33) return [];
    } else current += char;
  }
  parts.push(current);
  return parts;
}
function fixtureTokenAlternatives(rawValue: string): { system: string | null | undefined; code?: string }[] {
  if (rawValue.length > 2048) return [];
  const rawParts: string[] = [];
  let current = '';
  for (let i = 0; i < rawValue.length; i++) {
    const char = rawValue[i]!;
    if (char === '\\') {
      const next = rawValue[i + 1];
      if (next === undefined || !FIXTURE_ESCAPABLE.includes(next)) return [];
      current += char + next; i++;
    } else if (char === ',') {
      rawParts.push(current); current = '';
      if (rawParts.length >= 33) return [];
    } else current += char;
  }
  rawParts.push(current);
  const out: { system: string | null | undefined; code?: string }[] = [];
  for (const rawPart of rawParts) {
    let pipe = -1;
    for (let i = 0; i < rawPart.length; i++) {
      if (rawPart[i] === '\\') { i++; continue; }
      if (rawPart[i] === '|') { pipe = i; break; }
    }
    if (pipe === -1) {
      const code = fixtureUnescape(rawPart);
      if (code === undefined) return [];
      out.push(code ? { system: undefined, code } : { system: undefined });
    } else {
      const rawSystem = rawPart.slice(0, pipe);
      const system = fixtureUnescape(rawSystem);
      const code = fixtureUnescape(rawPart.slice(pipe + 1));
      if (system === undefined || code === undefined) return [];
      out.push({ system: rawSystem === '' ? null : system, ...(code ? { code } : {}) });
    }
  }
  return out;
}
function tokenMatches(value: unknown, rawValue: string): boolean {
  const codings = codingsOf(value);
  return fixtureTokenAlternatives(rawValue).some(token => {
    if (token.system === undefined && token.code === undefined) return false;
    return codings.some(c => {
      const systemOk = token.system === undefined ? true
        : token.system === null ? c.system === undefined
          : c.system === token.system;
      return systemOk && (token.code === undefined || c.code === token.code);
    });
  });
}
function referenceId(ref: string): string { return ref.split('/').filter(Boolean).at(-1) ?? ref; }
function linkedPatientId(r: GoldenResource): string | undefined {
  for (const key of ['subject', 'patient', 'beneficiary']) {
    const ref = asRec(r[key])?.reference;
    if (typeof ref === 'string') return referenceId(ref);
  }
  return r.resourceType === 'Patient' ? r.id : undefined;
}
function dateField(r: GoldenResource, name: string): string | undefined {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  if (name === 'birthdate') return str(r.birthDate);
  if (name === 'onset-date') return str(r.onsetDateTime);
  if (name === 'recorded-date') return str(r.recordedDate);
  // Generic `date` uses the per-resource clinical-date expression only
  // (R3-L1): Observation/DiagnosticReport `effective`, Immunization
  // `occurrence`, DocumentReference `date`, Encounter `period`. It never
  // falls back to `issued` or onset dates (spec section 7).
  switch (r.resourceType) {
    // Q-2: effectiveInstant is a clinical date variant, never invisible.
    case 'Observation': case 'DiagnosticReport': return str(r.effectiveDateTime) ?? str(r.effectiveInstant) ?? str(asRec(r.effectivePeriod)?.start);
    case 'Immunization': return str(r.occurrenceDateTime);
    case 'DocumentReference': return str(r.date);
    case 'Encounter': return str(asRec(r.period)?.start);
    default: return undefined;
  }
}
/**
 * FHIR R4 date/dateTime precision-interval parsing (G-12): every value denotes
 * the half-open interval [start,end) at its stated precision (year, month, day,
 * minute, second, fractional). Computed with UTC field arithmetic, never
 * `Date.parse` (which invents precision and local-zone meaning).
 */
export function parseFhirDateInterval(text: string): { start: number; end: number } | undefined {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/.exec(text);
  if (!m) return undefined;
  const year = Number(m[1]); const month = m[2] === undefined ? undefined : Number(m[2]);
  const day = m[3] === undefined ? undefined : Number(m[3]);
  const hour = m[4] === undefined ? undefined : Number(m[4]); const minute = m[5] === undefined ? undefined : Number(m[5]);
  const second = m[6] === undefined ? undefined : Number(m[6]); const fraction = m[7];
  if (month !== undefined && (month < 1 || month > 12)) return undefined;
  if (day !== undefined && (day < 1 || day > 31)) return undefined;
  if (hour !== undefined && (hour > 23 || (minute ?? 0) > 59 || (second ?? 0) > 59)) return undefined;
  let offsetMs = 0;
  const zone = m[8];
  if (zone && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    offsetMs = sign * (Number(zone.slice(1, 3)) * 3600000 + Number(zone.slice(4, 6)) * 60000);
  }
  const fracMs = fraction === undefined ? 0 : Number(`0.${fraction}`) * 1000;
  const start = Date.UTC(year, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0, Math.floor(fracMs)) - offsetMs;
  // Validate round-trip so e.g. Feb 30 cannot silently roll into March.
  const round = new Date(start + offsetMs);
  if (round.getUTCFullYear() !== year || (month !== undefined && round.getUTCMonth() !== month - 1) || (day !== undefined && round.getUTCDate() !== day)) return undefined;
  let end: number;
  if (fraction !== undefined) end = start + Math.max(1, Math.pow(10, 3 - Math.min(3, fraction.length)));
  else if (second !== undefined) end = start + 1000;
  else if (hour !== undefined) end = start + 60000;
  else if (day !== undefined) end = Date.UTC(year, (month ?? 1) - 1, day + 1) - offsetMs;
  else if (month !== undefined) end = Date.UTC(year, month, 1) - offsetMs;
  else end = Date.UTC(year + 1, 0, 1) - offsetMs;
  return { start, end };
}
export function candidateInterval(r: GoldenResource, name: string): { start: number; end: number } | undefined {
  if (name === 'date') {
    // R3-L1: only the resource's own clinical-date period counts.
    const periods = r.resourceType === 'Encounter' ? [asRec(r.period)]
      : r.resourceType === 'Observation' || r.resourceType === 'DiagnosticReport' ? [asRec(r.effectivePeriod)]
        : [];
    for (const period of periods) {
      if (!period) continue;
      const hasStart = typeof period.start === 'string';
      const hasEnd = typeof period.end === 'string';
      if (!hasStart && !hasEnd) continue;
      const lo = hasStart ? parseFhirDateInterval(period.start as string) : undefined;
      const hi = hasEnd ? parseFhirDateInterval(period.end as string) : undefined;
      if ((hasStart && !lo) || (hasEnd && !hi)) return undefined;
      // R2-4: an open Period end is unbounded (+∞), an open start unbounded below;
      // neither collapses to the precision interval of the stated bound.
      return { start: lo ? lo.start : Number.NEGATIVE_INFINITY, end: hi ? hi.end : Number.POSITIVE_INFINITY };
    }
  }
  const text = name === '_lastUpdated' ? (asRec(r.meta)?.lastUpdated as string | undefined) : dateField(r, name);
  return text === undefined ? undefined : parseFhirDateInterval(text);
}
/**
 * R4 date search comparison over precision intervals (R2-4; target T, search S,
 * half-open [start,end)). `gt`/`lt` test whether T extends beyond S — they are
 * NOT `sa`/`eb`, which require T entirely after/before S. `ge`/`le` add `eq`.
 * `ap` stays unsupported in this fixture (§7): it never matches.
 */
export function fhirDateSearchMatches(target: { start: number; end: number } | undefined, raw: string): boolean {
  if (!target) return false;
  const m = /^(eq|ne|lt|le|gt|ge|sa|eb|ap)?(.+)$/.exec(raw);
  if (!m) return false;
  const prefix = m[1] ?? 'eq';
  if (prefix === 'ap') return false;
  const search = parseFhirDateInterval(m[2] ?? '');
  if (!search) return false;
  const eq = search.start <= target.start && target.end <= search.end;
  switch (prefix) {
    case 'eq': return eq;
    case 'ne': return !eq;
    case 'gt': return target.end > search.end;
    case 'lt': return target.start < search.start;
    case 'ge': return target.end > search.end || eq;
    case 'le': return target.start < search.start || eq;
    case 'sa': return target.start >= search.end;
    case 'eb': return target.end <= search.start;
    default: return false;
  }
}
function dateMatches(r: GoldenResource, name: string, raw: string): boolean {
  return fhirDateSearchMatches(candidateInterval(r, name), raw);
}
function quantityMatches(qty: unknown, raw: string): boolean {
  const q = asRec(qty); if (!q || typeof q.value !== 'number') return false;
  const m = /^(eq|ne|lt|le|gt|ge|ap)?(-?\d+(?:\.\d+)?)(?:\|([^|]*)\|([^|]*))?$/.exec(raw);
  if (!m) return false;
  const value = q.value; const target = Number(m[2]);
  if (m[3] && q.system !== m[3]) return false;
  if (m[4] && q.code !== m[4] && q.unit !== m[4]) return false;
  switch (m[1] ?? 'eq') {
    case 'eq': return value === target;
    case 'ap': return false; // R3-L2: refused at the request handler; never an eq alias.
    case 'ne': return value !== target;
    case 'lt': return value < target;
    case 'le': return value <= target;
    case 'gt': return value > target;
    case 'ge': return value >= target;
    default: return false;
  }
}
function filterMatches(r: GoldenResource, name: string, value: string): boolean {
  // Token parameters tokenize the RAW value single-pass (Q-2/Q-6); every
  // other parameter ORs over escape-aware alternatives. Repeated
  // occurrences are ANDed by the caller (FHIR search semantics).
  switch (name) {
    case 'code': return tokenMatches(r.code, value) || tokenMatches(r.medicationCodeableConcept, value);
    case 'category': return tokenMatches(r.category, value);
    case 'type': return tokenMatches(r.type, value);
    case 'vaccine-code': return tokenMatches(r.vaccineCode, value);
    case 'clinical-status': return tokenMatches(r.clinicalStatus, value);
    case 'verification-status': return tokenMatches(r.verificationStatus, value);
    case 'identifier': return (Array.isArray(r.identifier) ? r.identifier : []).some(i => { const x = asRec(i); return x !== undefined && tokenMatches([{ coding: [{ system: x.system, code: x.value }] }], value); });
  }
  return splitFixtureEscaped(value).some(v => {
    switch (name) {
      case '_id': return r.id === v;
      case 'patient': case 'subject': return linkedPatientId(r) === referenceId(v);
      case 'status': return r.status === v.split('|').pop();
      case 'intent': return r.intent === v.split('|').pop();
      case 'gender': return r.gender === v.split('|').pop();
      case 'active': return String(r.active) === v.split('|').pop();
      case 'name': case 'family': case 'given': {
        const names = Array.isArray(r.name) ? r.name : [];
        return names.some(n => { const x = asRec(n); if (!x) return false; const vals = [x.family, ...(Array.isArray(x.given) ? x.given : [])].filter(s => typeof s === 'string') as string[]; return vals.some(s => s.toLowerCase().includes(v.toLowerCase())); });
      }
      case 'date': case 'birthdate': case 'onset-date': case 'recorded-date': case '_lastUpdated':
        return dateMatches(r, name, v);
      case 'value-quantity': return quantityMatches(r.valueQuantity, v);
      default: return false;
    }
  });
}
const DATE_SORT_PARAMS = new Set(['date', 'birthdate', 'onset-date', 'recorded-date', '_lastUpdated']);
function sortResources(list: GoldenResource[], sort: string | null): GoldenResource[] {
  if (!sort) return list;
  const keys = sort.split(',').map(k => k.trim()).filter(Boolean).map(k => ({ desc: k.startsWith('-'), name: k.replace(/^-/, '') }));
  const keyOf = (r: GoldenResource, name: string): string => name === '_id' ? r.id : (dateField(r, name) ?? (typeof r[name] === 'string' ? r[name] as string : ''));
  return [...list].sort((a, b) => {
    for (const k of keys) {
      // G-12: date keys order by numeric instant (precision-interval start), never lexicographically.
      if (DATE_SORT_PARAMS.has(k.name)) {
        const av = candidateInterval(a, k.name)?.start ?? Number.NEGATIVE_INFINITY;
        const bv = candidateInterval(b, k.name)?.start ?? Number.NEGATIVE_INFINITY;
        if (av !== bv) return k.desc ? bv - av : av - bv;
        continue;
      }
      const cmp = keyOf(a, k.name).localeCompare(keyOf(b, k.name)); if (cmp !== 0) return k.desc ? -cmp : cmp;
    }
    return a.id.localeCompare(b.id);
  });
}

const SYSTEM_PARAMS = new Set(['_count', '_offset', '_sort', '_total', '_summary', '_elements', '_format', '_pretty']);

function sendJson(res: ServerResponse, status: number, body: unknown, rawBodies: Readonly<Record<string, string>> = {}): void {
  const serialize = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
    const rec = value as Record<string, unknown>;
    const raw = rawBodies[`${rec.resourceType}/${rec.id}`];
    if (raw) return raw;
    return `{${Object.entries(rec).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`).join(',')}}`;
  };
  const text = serialize(body);
  res.writeHead(status, { 'content-type': 'application/fhir+json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
const outcome = (diagnostics: string, code = 'invalid') => ({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code, diagnostics }] });

export interface EvalFixtureServer {
  baseUrl: string;
  selectScenario(taskId: string): void;
  selectResources(resources: readonly GoldenResource[], rawBodies?: Readonly<Record<string, string>>): void;
  requestCount(): number;
  /** Every request path+query received, in arrival order (the outbound upstream URL log). */
  requests(): string[];
  /** Select an adversarial behavior for subsequent requests; undefined restores golden behavior. */
  setMode(mode?: AdversarialMode): void;
  close(): Promise<void>;
}

const withoutParams = (params: URLSearchParams, names: readonly string[] = []): URLSearchParams => {
  const copy = new URLSearchParams(params);
  for (const name of names) copy.delete(name);
  return copy;
};

export async function startEvalFixtureServer(resources: readonly GoldenResource[] = GOLDEN_RESOURCES, rawBodies: Readonly<Record<string, string>> = {}): Promise<EvalFixtureServer> {
  let baseUrl = 'http://127.0.0.1:0/fhir';
  const log: string[] = [];
  let scenario = '';
  let behavior: AdversarialBehavior | undefined;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    log.push(req.url ?? '/');
    try {
      const url = new URL(req.url ?? '/', baseUrl);
      const pool = behavior?.adversarialPool ? [...resources.filter(r => r.resourceType === 'Patient'), ...ADVERSARIAL_RESOURCES] : resources;
      const segments = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));
      if (segments[0] !== 'fhir' || req.method !== 'GET') { sendJson(res, 404, outcome('Not found', 'not-found')); return; }
      if (segments.length === 2 && segments[1] === 'metadata') { sendJson(res, 200, capabilityStatement(behavior)); return; }
      const type = segments[1] ?? '';
      if (!FIXTURE_RESOURCE_TYPES.includes(type)) { sendJson(res, 404, outcome('Unknown resource type', 'not-found')); return; }
      if (segments.length === 3) {
        const rawBody = rawBodies[`${type}/${segments[2]}`] ?? RAW_READ_BODIES[segments[2]!];
        if (rawBody && type === 'Observation') {
          res.writeHead(200, { 'content-type': 'application/fhir+json; charset=utf-8', 'content-length': Buffer.byteLength(rawBody) });
          res.end(rawBody);
          return;
        }
        const found = pool.find(r => r.resourceType === type && r.id === segments[2]);
        if (found) sendJson(res, 200, found); else sendJson(res, 404, outcome('Resource not found', 'not-found'));
        return;
      }
      if (segments.length !== 2) { sendJson(res, 404, outcome('Not found', 'not-found')); return; }
      const params = url.searchParams;
      const advertised = new Set([...(SEARCH_PARAMS[type] ?? []), ...(type === 'Observation' ? wideParams(behavior?.extraObservationSearchParams ?? 0) : [])]);
      const ignored = new Set<string>(behavior?.ignoreFilters ?? []);
      let matched = pool.filter(r => r.resourceType === type);
      for (const [rawName, value] of params.entries()) {
        if (SYSTEM_PARAMS.has(rawName)) continue;
        const base = rawName.split(':')[0] ?? rawName;
        if (!advertised.has(base)) { sendJson(res, 400, outcome(`Unsupported search parameter: ${rawName}`, 'not-supported')); return; }
        // R3-L2: `ap` is refused, never answered with a silent empty result.
        const declaredType = SEARCH_PARAM_DEFS[`${type}.${base}`]?.type ?? (base === '_lastUpdated' ? 'date' : undefined);
        if (declaredType !== undefined && ['date', 'quantity', 'number'].includes(declaredType)
          && value.split(',').some(part => /^ap[0-9.+-]/.test(part.trim()))) {
          sendJson(res, 400, outcome('Approximate (ap) search is not supported by this fixture', 'not-supported')); return;
        }
        if (!ignored.has(base) && !(scenario === 'query-ignore-code' && base === 'code') && !(base === 'date' && ((scenario === 'query-ignore-date-lower' && value.startsWith('ge')) || (scenario === 'query-ignore-date-upper' && value.startsWith('lt'))))) matched = matched.filter(r => filterMatches(r, base, value));
      }
      matched = sortResources(matched, scenario.startsWith('query-ignore-sort') ? null : params.get('_sort'));
      const total = matched.length;
      const pageCount = params.get('_count') === null ? 20 : Number(params.get('_count'));
      const offset = params.get('_offset') === null ? 0 : Number(params.get('_offset'));
      if (!Number.isInteger(pageCount) || pageCount < 0 || !Number.isInteger(offset) || offset < 0) { sendJson(res, 400, outcome('Invalid paging')); return; }
      const page = scenario.startsWith('query-empty-page-with-next') && offset === 0 ? [] : matched.slice(offset, offset + pageCount);
      const self = withoutParams(params, behavior?.selfLinkDrop);
      const selfUrl = `${baseUrl}/${type}${self.toString() ? `?${self.toString()}` : ''}`;
      const links: { relation: string; url: string }[] = [{ relation: 'self', url: selfUrl }];
      if (pageCount > 0 && offset + page.length < total) {
        const next = withoutParams(params, behavior?.nextLinkDrop);
        next.set('_offset', String(offset + pageCount));
        links.push({ relation: 'next', url: `${baseUrl}/${type}?${next.toString()}` });
      }
      if (scenario === 'query-invalid-next-safe-first-page') { const next = new URL(`${baseUrl}/${type}`); next.search = params.toString(); next.searchParams.set('_sort', 'date'); links.push({ relation: 'next', url: next.href }); }
      const entry = (resource: GoldenResource, mode: 'match' | 'include') => ({ fullUrl: `${baseUrl}/${resource.resourceType}/${resource.id}`, resource, search: { mode } });
      sendJson(res, 200, {
        resourceType: 'Bundle', type: 'searchset', total, link: links,
        entry: [...page.map(resource => entry(resource, 'match')), ...(behavior?.includeEntries ? ADVERSARIAL_INCLUDES.map(resource => entry(resource, 'include')) : [])],
      }, rawBodies);
    } catch {
      if (!res.headersSent) sendJson(res, 500, outcome('Eval fixture error', 'exception'));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}/fhir`;
      resolve();
    });
  });
  return {
    baseUrl,
    selectScenario: id => { scenario = id; },
    selectResources: (next, raw = {}) => { resources = next; rawBodies = raw; },
    requestCount: () => log.length,
    requests: () => log.slice(),
    setMode: mode => { behavior = mode ? ADVERSARIAL_MODES[mode] : undefined; },
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections?.(); server.close(err => (err ? reject(err) : resolve())); }),
  };
}

/**
 * Worker fixture-fragment format (gate F, spec §9). Strict and data-only: no
 * URLs, headers, callbacks or scripts in behaviors. `json_text` preserves raw
 * number lexemes; raw/parsed duplicate identities must agree and be unique.
 */
export interface M3bFixtureFragment {
  schema_version: 'm3b-fixture/1';
  id: string;
  resources: Record<string, unknown>[];
  raw_resources?: { resource_type: string; id: string; json_text: string }[];
  search_parameters: { resource_type: string; name: string; type: string; definition?: string }[];
  behaviors: { id: string; ignore_parameters: string[]; ignore_sort: boolean; lexicographic_date_sort: boolean }[];
}
const FRAGMENT_KEYS = new Set(['schema_version', 'id', 'resources', 'raw_resources', 'search_parameters', 'behaviors']);
export function parseM3bFixtureFragment(jsonText: string): M3bFixtureFragment {
  const bad = (m: string): never => { throw new Error(`m3b fixture fragment: ${m}`); };
  let parsed: unknown;
  try { parsed = JSON.parse(jsonText); } catch { bad('not JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) bad('root must be an object');
  const frag = parsed as Record<string, unknown>;
  if (Object.keys(frag).some(k => !FRAGMENT_KEYS.has(k))) bad('unknown key');
  if (frag.schema_version !== 'm3b-fixture/1' || typeof frag.id !== 'string' || !frag.id) bad('schema_version/id invalid');
  if (!Array.isArray(frag.resources) || frag.resources.length > 500) bad('resources invalid');
  const identities = new Set<string>();
  for (const resource of frag.resources as Record<string, unknown>[]) {
    if (!resource || typeof resource.resourceType !== 'string') bad('resource missing resourceType');
    const key = `${String(resource.resourceType)}/${String(resource.id ?? '')}`;
    if (identities.has(key)) bad(`duplicate identity ${key}`);
    identities.add(key);
  }
  for (const raw of (frag.raw_resources ?? []) as { resource_type: string; id: string; json_text: string }[]) {
    if (typeof raw.json_text !== 'string' || raw.json_text.length > 262144) bad('raw json_text invalid');
    const key = `${raw.resource_type}/${raw.id}`;
    if (identities.has(key)) bad(`raw/parsed duplicate identity ${key}`);
    identities.add(key);
    let body: unknown;
    try { body = JSON.parse(raw.json_text); } catch { bad('raw json_text not JSON'); }
    const rec = body as Record<string, unknown>;
    if (rec.resourceType !== raw.resource_type || rec.id !== raw.id) bad('raw identity mismatch');
  }
  if (!Array.isArray(frag.search_parameters) || frag.search_parameters.length > 500 || !Array.isArray(frag.behaviors) || frag.behaviors.length > 100) bad('search_parameters/behaviors invalid');
  const SP_TYPES = new Set(['number', 'date', 'string', 'token', 'reference', 'composite', 'quantity', 'uri', 'special']);
  for (const param of frag.search_parameters as Record<string, unknown>[]) {
    if (!param || typeof param !== 'object' || Array.isArray(param)) bad('search_parameters entry must be an object');
    if (Object.keys(param).some(k => !['resource_type', 'name', 'type', 'definition'].includes(k))) bad('search_parameters entry has an unknown key');
    if (typeof param.resource_type !== 'string' || !/^[A-Z][A-Za-z0-9]+$/.test(param.resource_type) || param.resource_type.length > 80) bad('search_parameters resource_type invalid');
    if (typeof param.name !== 'string' || !param.name || param.name.length > 160) bad('search_parameters name invalid');
    if (typeof param.type !== 'string' || !SP_TYPES.has(param.type)) bad('search_parameters type invalid');
    if (param.definition !== undefined && (typeof param.definition !== 'string' || param.definition.length > 512)) bad('search_parameters definition invalid');
  }
  for (const behavior of frag.behaviors as Record<string, unknown>[]) {
    if (!behavior || typeof behavior !== 'object' || Array.isArray(behavior)) bad('behavior must be an object');
    if (Object.keys(behavior).some(k => !['id', 'ignore_parameters', 'ignore_sort', 'lexicographic_date_sort'].includes(k))) bad('behavior has an unknown key (URLs/headers/scripts forbidden)');
    if (typeof behavior.id !== 'string' || !behavior.id || behavior.id.length > 120) bad('behavior id invalid');
    if (!Array.isArray(behavior.ignore_parameters) || behavior.ignore_parameters.length > 100 || !behavior.ignore_parameters.every(v => typeof v === 'string' && v.length <= 160)) bad('behavior ignore_parameters invalid');
    if (typeof behavior.ignore_sort !== 'boolean' || typeof behavior.lexicographic_date_sort !== 'boolean') bad('behavior flags must be boolean');
  }
  return frag as unknown as M3bFixtureFragment;
}

/** Q precedes P; every backend body and independent input hash is recorded. */
export function evalDataText(relative: string): string {
  try { return readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'); }
  catch { return readFileSync(resolve('packages/evals', relative), 'utf8'); }
}
export function loadEvalCorpus(base: readonly GoldenResource[] = GOLDEN_RESOURCES) {
  const resources = [...base], rawBodies: Record<string, string> = {}, hashes: Record<string, string> = {};
  const byCorpus: Record<string, GoldenResource[]> = { baseline: [...base], query: [...base], projection: [...base] };
  const identities = new Set(base.map(r => `${r.resourceType}/${r.id}`));
  if (identities.size !== base.length) throw new Error('Duplicate base fixture identity.');
  const fragmentIds = new Set<string>();
  for (const path of ['fixtures/m3b-query/fragment.json', 'fixtures/m3b-projection/lab-fidelity.json']) {
    const text = evalDataText(path), fragment = parseM3bFixtureFragment(text);
    const expectedId = path.includes('m3b-query') ? 'm3b-query-decoys' : 'p-lab-fidelity';
    if (fragment.id !== expectedId) throw new Error('Unrecognized fixture fragment id.');
    if (fragmentIds.has(fragment.id)) throw new Error('Duplicate fixture fragment id.');
    fragmentIds.add(fragment.id); hashes[path] = createHash('sha256').update(text).digest('hex');
    for (const resource of [...fragment.resources, ...(fragment.raw_resources ?? []).map(r => JSON.parse(r.json_text) as Record<string, unknown>)]) {
      const key = `${resource.resourceType}/${resource.id}`;
      if (identities.has(key) || typeof resource.id !== 'string') throw new Error('Duplicate or missing fixture identity.');
      identities.add(key); resources.push(resource as GoldenResource);
      byCorpus[path.includes('m3b-query') ? 'query' : 'projection']!.push(resource as GoldenResource);
    }
    for (const raw of fragment.raw_resources ?? []) rawBodies[`${raw.resource_type}/${raw.id}`] = raw.json_text;
  }
  return { resources, byCorpus, rawBodies, hashes, fragmentIds: [...fragmentIds] };
}

/** Hash the complete backend module actually executing, independent of gateway helpers. */
export const fixtureBackendSha256 = () => createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
