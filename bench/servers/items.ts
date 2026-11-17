// Shape-only extraction of answer fields from a FHIR resource as a server returned it.
// Works on lossless-parsed JSON: numbers stay LosslessNumber and are reported as their exact lexemes.
// Tolerates fhirHydrant's compact form (references as strings, codings without system, quantities without code).
import { LosslessNumber, type LosslessValue } from '../lib/json.js';
import type { ParsedItem } from '../lib/types.js';

export type Obj = { [k: string]: LosslessValue };
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof LosslessNumber);
const arr = (v: LosslessValue | undefined): LosslessValue[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const first = (v: LosslessValue | undefined): LosslessValue | undefined => arr(v)[0];

/** A primitive as text: strings as-is, numbers as their lexeme, booleans as "true"/"false". */
export function lexeme(v: LosslessValue | undefined): string | null {
  if (typeof v === 'string') return v;
  if (v instanceof LosslessNumber) return v.lexeme;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return null;
}

/** Walks a dotted path; arrays are flattened. */
export function at(v: LosslessValue | undefined, path: string): LosslessValue[] {
  let cur: LosslessValue[] = v === undefined ? [] : [v];
  for (const key of path.split('.')) {
    const next: LosslessValue[] = [];
    for (const c of cur) for (const x of arr(c)) if (isObj(x) && x[key] !== undefined) next.push(...arr(x[key]));
    cur = next;
  }
  return cur;
}
const atStr = (v: LosslessValue | undefined, path: string): string | null => lexeme(at(v, path)[0]);

/** Reference text: `{reference: "Type/id"}` or a compact string. */
export function referenceOf(v: LosslessValue | undefined): string | null {
  if (typeof v === 'string') return v;
  if (isObj(v) && typeof v.reference === 'string') return v.reference;
  return null;
}

/** Patient.id named by a reference string such as "Patient/x", ".../fhir/Patient/x" or "urn:uuid:x" is not resolved. */
export function patientIdOf(ref: string | null): string | null {
  if (!ref) return null;
  const m = /(?:^|\/)Patient\/([A-Za-z0-9.-]{1,64})(?:\/_history\/[^/]+)?$/.exec(ref);
  return m ? m[1]! : null;
}

function conceptText(cc: LosslessValue | undefined): string | null {
  const c = first(cc);
  if (typeof c === 'string') return c;
  if (!isObj(c)) return null;
  if (typeof c.text === 'string') return c.text;
  for (const coding of arr(c.coding)) if (isObj(coding) && typeof coding.display === 'string') return coding.display;
  for (const coding of arr(c.coding)) if (isObj(coding) && typeof coding.code === 'string') return coding.code;
  return null;
}

/** The subject patient a record names (subject, patient, beneficiary, individual); the Patient itself for Patient. */
export function recordPatient(r: Obj): string | null {
  if (r.resourceType === 'Patient' && typeof r.id === 'string') return r.id;
  for (const key of ['subject', 'patient', 'beneficiary']) {
    const id = patientIdOf(referenceOf(first(r[key])));
    if (id) return id;
  }
  for (const p of at(r, 'participant.individual')) {
    const id = patientIdOf(referenceOf(p));
    if (id) return id;
  }
  return null;
}

/** Same order as the effective-time rule used for gold (gold/fhir.ts), restated here so parsers do not import gold code. */
const TIME_PATHS = ['effectiveDateTime', 'effectivePeriod.start', 'effectiveInstant', 'performedDateTime', 'performedPeriod.start',
  'authoredOn', 'occurrenceDateTime', 'recordedDate', 'onsetDateTime', 'whenHandedOver', 'collection.collectedDateTime', 'date', 'issued',
  'period.start', 'billablePeriod.start', 'created', 'started', 'birthDate'];

interface Quantity { value: string | null; comparator: string | null; unit: string | null; unit_code: string | null; unit_system: string | null }
function quantity(q: LosslessValue | undefined): Quantity | null {
  if (!isObj(q)) return null;
  const value = lexeme(q.value);
  const unit = typeof q.unit === 'string' ? q.unit : typeof q.code === 'string' ? q.code : typeof q.currency === 'string' ? q.currency : null;
  return { value, comparator: typeof q.comparator === 'string' ? q.comparator : null, unit,
    unit_code: typeof q.code === 'string' ? q.code : null, unit_system: typeof q.system === 'string' ? q.system : null };
}

/** Value of a record: value[x] for observations, else the dose, quantity or total the resource type carries. */
function valueOf(r: Obj): Quantity & { text: string | null } {
  const none = { value: null, comparator: null, unit: null, unit_code: null, unit_system: null, text: null };
  const q = quantity(r.valueQuantity) ?? quantity(r.valueMoney)
    ?? quantity(at(r, 'dosage.dose')[0]) // MedicationAdministration
    ?? quantity(at(r, 'dosageInstruction.doseAndRate.doseQuantity')[0]) // MedicationRequest
    ?? quantity(r.quantity) // MedicationDispense, SupplyDelivery
    ?? quantity(first(r.total)) // Claim (Money)
    ?? quantity(at(r, 'total.amount')[0]); // ExplanationOfBenefit
  if (q) return { ...q, text: null };
  for (const key of ['valueString', 'valueInteger', 'valueBoolean', 'valueDateTime', 'valueTime', 'valueDecimal']) {
    const v = lexeme(r[key]);
    if (v !== null) return { ...none, value: v, text: v };
  }
  if (r.valueCodeableConcept !== undefined) {
    const t = conceptText(r.valueCodeableConcept);
    return { ...none, value: t, text: t };
  }
  return none;
}

function displayOf(r: Obj): string | null {
  for (const key of ['code', 'medicationCodeableConcept', 'vaccineCode', 'type', 'category', 'class']) {
    const t = conceptText(r[key]);
    if (t) return t;
  }
  if (r.resourceType === 'Patient') {
    const name = first(r.name);
    if (isObj(name)) return typeof name.text === 'string' ? name.text : [...at(name, 'given'), ...at(name, 'family')].map(lexeme).filter(Boolean).join(' ') || null;
  }
  return typeof r.description === 'string' ? r.description : null;
}

export function itemOf(r: Obj): ParsedItem | null {
  if (typeof r.resourceType !== 'string' || typeof r.id !== 'string') return null;
  const v = valueOf(r);
  let time: string | null = null;
  for (const p of TIME_PATHS) if ((time = atStr(r, p))) break;
  return {
    ref: `${r.resourceType}/${r.id}`,
    patient: recordPatient(r),
    value: v.value,
    comparator: v.comparator,
    unit: v.unit,
    unit_code: v.unit_code,
    unit_system: v.unit_system,
    time,
    display: displayOf(r),
  };
}

/** Resources of a searchset Bundle (entry[].resource) or a single resource. */
export function resourcesOf(payload: LosslessValue | undefined): Obj[] {
  if (!isObj(payload)) return [];
  if (payload.resourceType === 'Bundle') {
    return arr(payload.entry).map(e => (isObj(e) && isObj(e.resource) ? e.resource : isObj(e) && typeof e.resourceType === 'string' ? e : null))
      .filter((x): x is Obj => x !== null);
  }
  return typeof payload.resourceType === 'string' && payload.resourceType !== 'OperationOutcome' ? [payload] : [];
}

export function bundleLink(bundle: LosslessValue | undefined, relation: string): string | null {
  if (!isObj(bundle)) return null;
  for (const l of arr(bundle.link)) if (isObj(l) && l.relation === relation && typeof l.url === 'string') return l.url;
  return null;
}

export function bundleTotal(bundle: LosslessValue | undefined): number | null {
  if (!isObj(bundle) || !(bundle.total instanceof LosslessNumber)) return null;
  const n = Number(bundle.total.lexeme);
  return Number.isSafeInteger(n) ? n : null;
}

/** OperationOutcome as a refusal: first issue's code and diagnostics/details text. */
export function outcomeRefusal(oo: LosslessValue | undefined): { code: string; message: string } | null {
  const issues = isObj(oo) && oo.resourceType === 'OperationOutcome' ? arr(oo.issue) : Array.isArray(oo) ? oo : [];
  const i = issues.find(isObj);
  if (!i) return null;
  const sev = typeof i.severity === 'string' ? i.severity : '';
  if (sev === 'information' || sev === 'warning') return null;
  return { code: typeof i.code === 'string' ? i.code : 'unknown',
    message: typeof i.diagnostics === 'string' ? i.diagnostics : conceptText(i.details) ?? '' };
}
