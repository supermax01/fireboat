/**
 * Packaging slice 8 (design §7, D7): the three packaged quickstart tasks the helper's `verify` runs through the installed
 * gateway in both protocol eras and all three arms. Pure: the facts come from the checked-in quickstart seed and the
 * run's setup packet (observed versions), the checks from the shared vocabulary; `citedFact` binds every clinical claim
 * to one cited occurrence of one response. Scripted oracle tasks, not an agent: they say nothing about clinical
 * reasoning. Runtime imports: the lossless reader only (for raw seed lexemes), so the helper can load it alone.
 */
import { isFhirDecimal, parseFhirJson } from '../../core/src/decimal.js';
import type { ArmName, Check } from './check-contracts.js';

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => !!value && typeof value === 'object' && !Array.isArray(value) && !isFhirDecimal(value);
const LOINC_HBA1C = 'http://loinc.org|4548-4';
const LAB = { system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' };
/** The window the quickstart seed was cut to (A6): every natural lab and edge lies inside it. */
export const PACKAGE_WINDOW = [{ name: 'date', value: 'ge2020-01-01' }, { name: 'date', value: 'lt2026-01-01' }] as const;
/** The gateway's fixed message for a read it will not serve, whether the resource is absent or another patient's. */
export const NOT_SERVED_MESSAGE = 'Unable to complete the bounded request.';
export const EXPIRED_MESSAGE = 'The retained snapshot expired or is unavailable. Repeat the original query in the trusted context.';
/** Rows of one retained read when no limit is given (the gateway's default page of primary matches, docs/LIMITS.md). */
export const RETAINED_PAGE = 20;

/**
 * One HbA1c result's meaning, as the seed states it: absent optional parts (a coding version, a quantity comparator) are
 * claimed absent, so a reply that adds one (`>7.00`) makes a different claim and fails.
 */
export interface LabFact {
  id: string; status: string; lexeme: string; comparator?: string; unit: string; unitSystem?: string; unitCode?: string; effective: string; version: string;
  /** The index of the HbA1c coding in `code.coding`, its system, code and version. */
  coding: number; system: string; code: string; codingVersion?: string;
}
export interface DocumentFact { id: string; version: string; status: string; typeSystem: string; typeCode: string; date: string; contentType: string; title: string }
export interface SeedFacts {
  patient: string;
  /** The natural patient's HbA1c results in the window, newest first by their recorded dates. */
  hba1c: readonly LabFact[];
  /** Every laboratory Observation of the natural patient (natural and edge), the drain's exact membership. */
  labIds: readonly string[];
  corrected: LabFact; enteredInError: LabFact;
  foreignLab: string; document: DocumentFact;
}
export type PackageTaskId = 'package-latest-hba1c' | 'package-status-sensitive' | 'package-drain-reproject';
export interface PackageStep {
  tool: 'fhir_capabilities' | 'fhir_search' | 'fhir_read' | 'fhir_page' | 'fhir_result';
  input: Rec;
  /** Follow `pagination.next_cursor` with fhir_page until it is gone (bounded by the verifier). */
  drain?: boolean;
  /** Use the `result.handle` of this earlier step's first call as `input.handle`. */
  handleFrom?: number;
  /** Wait this long before the call (the retained result's TTL elapses). */
  waitMs?: number;
  /** The trusted resource type of the step's query chain. */
  resourceType?: string;
}
export interface PackageTask {
  id: PackageTaskId; question: string; steps: readonly PackageStep[]; checks: readonly Check[];
  /** Fields of the `selected` arm. */
  fields: readonly string[];
  /** Per-call output.max_bytes for every arm. */
  perCallBytes: number;
  /** Operator limits for this task's session, where the task demonstrates them (the TTL expiry). */
  limits?: Readonly<{ ttlMs: number }>;
}

/**
 * Facts of the checked-in seed (`packages/evals/fixtures/quickstart/resources.ndjson`) and the observed versions of the
 * setup packet (`target` -> `versionId`). Raw lexemes are read from the seed text itself, never from decoded numbers.
 */
export function seedFacts(ndjson: string, patient: string, versions: ReadonlyMap<string, string>): SeedFacts {
  const resources = ndjson.trimEnd().split('\n').map(line => parseFhirJson(line)).filter(isRecord);
  const version = (type: string, id: string) => versions.get(`${type}/${id}`) ?? fail(`no observed version for ${type}/${id}`);
  const subjectIs = (r: Rec, reference: string) => isRecord(r.subject) && r.subject.reference === reference;
  const coded = (r: Rec, system: string, code: string, key: 'code' | 'category') => {
    const concepts = key === 'code' ? [r.code] : Array.isArray(r.category) ? r.category : [];
    return concepts.some(c => isRecord(c) && Array.isArray(c.coding) && c.coding.some(x => isRecord(x) && x.system === system && x.code === code));
  };
  const labs = resources.filter(r => r.resourceType === 'Observation' && coded(r, LAB.system, LAB.code, 'category'));
  const [system, code] = LOINC_HBA1C.split('|') as [string, string];
  const optional = (value: unknown, key: string): Partial<Record<string, string>> => (typeof value === 'string' ? { [key]: value } : {});
  const fact = (r: Rec): LabFact => {
    const quantity = isRecord(r.valueQuantity) ? r.valueQuantity : {};
    if (!isFhirDecimal(quantity.value) && typeof quantity.value !== 'number') fail(`no numeric value on ${r.id as string}`);
    const codings = isRecord(r.code) && Array.isArray(r.code.coding) ? r.code.coding : [];
    const coding = codings.findIndex(c => isRecord(c) && c.system === system && c.code === code);
    if (coding < 0) fail(`no HbA1c coding on ${r.id as string}`);
    const chosen = codings[coding] as Rec;
    if (typeof quantity.unit !== 'string' || typeof r.status !== 'string' || typeof r.effectiveDateTime !== 'string') fail(`incomplete HbA1c ${r.id as string}`);
    return { id: r.id as string, status: r.status, lexeme: isFhirDecimal(quantity.value) ? quantity.value.lexeme : JSON.stringify(quantity.value),
      ...optional(quantity.comparator, 'comparator'), unit: quantity.unit, ...optional(quantity.system, 'unitSystem'), ...optional(quantity.code, 'unitCode'),
      effective: r.effectiveDateTime, version: version('Observation', r.id as string), coding, system, code, ...optional(chosen.version, 'codingVersion') };
  };
  const mine = labs.filter(r => subjectIs(r, patient));
  const hba1c = mine.filter(r => coded(r, system, code, 'code')).map(fact).sort((a, b) => (a.effective < b.effective ? 1 : a.effective > b.effective ? -1 : 0));
  const byId = (id: string) => hba1c.find(f => f.id === id) ?? fail(`missing edge ${id}`);
  const foreign = labs.find(r => !subjectIs(r, patient) && coded(r, system, code, 'code')) ?? fail('no wrong-patient control');
  const doc = resources.find(r => r.resourceType === 'DocumentReference' && subjectIs(r, patient)) ?? fail('no document');
  const attachment = Array.isArray(doc.content) && isRecord(doc.content[0]) && isRecord(doc.content[0].attachment) ? doc.content[0].attachment : {};
  const type = isRecord(doc.type) && Array.isArray(doc.type.coding) && isRecord(doc.type.coding[0]) ? doc.type.coding[0] : {};
  const text = (value: unknown, what: string): string => (typeof value === 'string' && value ? value : fail(`document ${what} missing`));
  const corrected = byId('qs-edge-hba1c-corrected'), enteredInError = byId('qs-edge-hba1c-entered-in-error');
  if (corrected.status !== 'corrected' || enteredInError.status !== 'entered-in-error') fail('status edges lost their status');
  return { patient, hba1c, labIds: mine.map(r => r.id as string), corrected, enteredInError, foreignLab: foreign.id as string,
    document: { id: doc.id as string, version: version('DocumentReference', doc.id as string), status: text(doc.status, 'status'), typeSystem: text(type.system, 'type system'),
      typeCode: text(type.code, 'type code'), date: text(doc.date, 'date'), contentType: text(attachment.contentType, 'content type'), title: text(attachment.title, 'title') } };
}
function fail(message: string): never { throw new Error(`package tasks: ${message}`); }

/** One clinical claim about one cited occurrence: citation, decoded value or raw token, at one step and response. */
const cited = (id: string, step: number, source: string, type: string, fact: { id: string; version: string }, path: string, claim: { equals?: unknown; lexeme?: string; absent?: true },
  extra: Partial<Check> = {}): Check => ({ kind: 'citedFact', id, step, source, resource_type: type, id_value: fact.id, version: fact.version, path, ...claim, ...extra } as Check);

const PROJECTED = ['status', 'code', 'valueQuantity', 'effectiveDateTime'] as const;

/** The three tasks over `facts`, citing source alias `source`. */
export function packageTasks(facts: SeedFacts, source: string): readonly PackageTask[] {
  const stated = (value: string | undefined) => (value === undefined ? { absent: true as const } : { equals: value });
  const labClaims = (prefix: string, step: number, f: LabFact): Check[] => [
    cited(`${prefix}-status`, step, source, 'Observation', f, 'status', { equals: f.status }),
    cited(`${prefix}-value`, step, source, 'Observation', f, 'valueQuantity.value', { lexeme: f.lexeme }),
    cited(`${prefix}-comparator`, step, source, 'Observation', f, 'valueQuantity.comparator', stated(f.comparator)),
    cited(`${prefix}-unit`, step, source, 'Observation', f, 'valueQuantity.unit', { equals: f.unit }),
    cited(`${prefix}-unit-system`, step, source, 'Observation', f, 'valueQuantity.system', stated(f.unitSystem)),
    cited(`${prefix}-unit-code`, step, source, 'Observation', f, 'valueQuantity.code', stated(f.unitCode)),
    cited(`${prefix}-date`, step, source, 'Observation', f, 'effectiveDateTime', { equals: f.effective }),
    cited(`${prefix}-code-system`, step, source, 'Observation', f, `code.coding.${f.coding}.system`, { equals: f.system }),
    cited(`${prefix}-code`, step, source, 'Observation', f, `code.coding.${f.coding}.code`, { equals: f.code }),
    cited(`${prefix}-code-version`, step, source, 'Observation', f, `code.coding.${f.coding}.version`, stated(f.codingVersion)),
  ];
  /** The requested search parameter, typed and executable, is the step's only row. */
  const parameter = (step: number, name: string, type: string): Check[] => [
    { kind: 'dataPath', id: `${name}-parameter-resource`, step, path: 'resource_type', equals: 'Observation' },
    { kind: 'dataPath', id: `${name}-parameter-only`, step, path: 'total_parameters', equals: 1 },
    { kind: 'dataPath', id: `${name}-parameter-name`, step, path: 'search_parameters.0.name', equals: name },
    { kind: 'dataPath', id: `${name}-parameter-type`, step, path: 'search_parameters.0.type', equals: type },
    { kind: 'dataPath', id: `${name}-parameter-executable`, step, path: 'search_parameters.0.executable', equals: true },
  ];
  const comparator = (name: string): Check => ({ kind: 'dataPathIncludes', id: `date-comparator-${name}`, step: 2, path: 'search_parameters.0.comparators',
    includes: { name, evidence: 'declared', executable: true } });
  const metadataSnapshot = (step: number): Check => ({ kind: 'queryEvidence', id: `metadata-${step}`, step, state: 'complete_for_query', query_exhausted: true,
    reasons_include: ['DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION'] });
  const latest: PackageTask = {
    id: 'package-latest-hba1c', question: 'What is the latest HbA1c, with its value, unit, date and status, and can its order be trusted?',
    fields: ['status', 'code', 'effectiveDateTime', 'valueQuantity'], perCallBytes: 24576,
    steps: [
      { tool: 'fhir_capabilities', input: { topic: 'support', resource_type: 'Observation' } },
      { tool: 'fhir_capabilities', input: { topic: 'search_parameter', resource_type: 'Observation', name: 'code' } },
      { tool: 'fhir_capabilities', input: { topic: 'search_parameter', resource_type: 'Observation', name: 'date' } },
      { tool: 'fhir_search', resourceType: 'Observation', drain: true, input: { resource_type: 'Observation',
        params: [{ name: 'code', value: LOINC_HBA1C }, ...PACKAGE_WINDOW, { name: '_sort', value: '-date' }], page_size: 20 } },
    ],
    checks: [
      metadataSnapshot(0), metadataSnapshot(1), metadataSnapshot(2),
      { kind: 'dataPath', id: 'support-observation', step: 0, path: 'rows.0.resource_type', equals: 'Observation' },
      { kind: 'dataPathIncludes', id: 'support-search-executable', step: 0, path: 'rows.0.executable_interactions', includes: 'search-type' },
      ...parameter(1, 'code', 'token'), ...parameter(2, 'date', 'date'), comparator('ge'), comparator('lt'),
      { kind: 'resourceIdSet', id: 'hba1c-membership', step: 3, equals: facts.hba1c.map(f => f.id) },
      { kind: 'resourceAbsent', id: 'hba1c-wrong-patient-absent', step: 3, resource: facts.foreignLab },
      ...facts.hba1c.flatMap((f, i) => labClaims(`hba1c-${i}`, 3, f)),
      { kind: 'sortEvidence', id: 'hba1c-order-unverified', step: 3, requested: ['-date'], effective: null, order: 'requested_unverified' },
      { kind: 'queryEvidence', id: 'hba1c-query-evidence', step: 3, state: 'unknown', query_exhausted: true, reasons_include: ['FILTER_EXECUTION_UNVERIFIED'] },
      { kind: 'upstreamWork', id: 'hba1c-one-search', step: 3, clinical: 1, metadata: 0 },
    ],
  };
  const status: PackageTask = {
    id: 'package-status-sensitive', question: 'Which HbA1c results were corrected or entered in error, and what does a document show without its payload?',
    fields: ['status', 'code', 'effectiveDateTime', 'valueQuantity', 'content', 'type', 'date'], perCallBytes: 8192,
    steps: [
      { tool: 'fhir_read', resourceType: 'Observation', input: { resource_type: 'Observation', id: facts.corrected.id } },
      { tool: 'fhir_read', resourceType: 'Observation', input: { resource_type: 'Observation', id: facts.enteredInError.id } },
      { tool: 'fhir_read', resourceType: 'Observation', input: { resource_type: 'Observation', id: facts.foreignLab } },
      { tool: 'fhir_read', resourceType: 'Observation', input: { resource_type: 'Observation', id: 'qs-edge-absent' } },
      { tool: 'fhir_read', resourceType: 'DocumentReference', input: { resource_type: 'DocumentReference', id: facts.document.id } },
    ],
    checks: [
      ...labClaims('corrected', 0, facts.corrected), ...labClaims('entered-in-error', 1, facts.enteredInError),
      { kind: 'callOutcome', id: 'wrong-patient-not-found', step: 2, outcome: 'application_error', code: 'NOT_FOUND' },
      { kind: 'envelopePath', id: 'wrong-patient-message', step: 2, path: 'error.safe_message', equals: NOT_SERVED_MESSAGE },
      { kind: 'resourceAbsent', id: 'wrong-patient-absent', step: 2, resource: facts.foreignLab },
      { kind: 'callOutcome', id: 'absent-not-found', step: 3, outcome: 'application_error', code: 'NOT_FOUND' },
      { kind: 'envelopePath', id: 'absent-message', step: 3, path: 'error.safe_message', equals: NOT_SERVED_MESSAGE },
      cited('document-status', 4, source, 'DocumentReference', facts.document, 'status', { equals: facts.document.status }),
      cited('document-type-system', 4, source, 'DocumentReference', facts.document, 'type.coding.0.system', { equals: facts.document.typeSystem }),
      cited('document-type-code', 4, source, 'DocumentReference', facts.document, 'type.coding.0.code', { equals: facts.document.typeCode }),
      cited('document-date', 4, source, 'DocumentReference', facts.document, 'date', { equals: facts.document.date }),
      cited('document-content-type', 4, source, 'DocumentReference', facts.document, 'content.0.attachment.contentType', { equals: facts.document.contentType }),
      cited('document-title', 4, source, 'DocumentReference', facts.document, 'content.0.attachment.title', { equals: facts.document.title }),
      cited('document-payload-absent', 4, source, 'DocumentReference', facts.document, 'content.0.attachment.data', { absent: true }),
      { kind: 'withheld', id: 'document-payload-withheld', step: 4, minCount: 1, reasonsInclude: 'V1_PAYLOAD_WITHHELD' },
      { kind: 'omittedIncludes', id: 'document-payload-omitted', step: 4, path: '/content/0/attachment/data' },
    ],
  };
  const drain: PackageTask = {
    id: 'package-drain-reproject', question: 'Which lab results does the chart hold in the window, and what does the retained page show when inspected, projected and paged?',
    // 64 KiB holds fewer than one upstream page of 100 in every arm (selected rows included), so each first page leaves a local remainder.
    fields: ['status', 'code', 'effectiveDateTime', 'valueQuantity'], perCallBytes: 65536, limits: { ttlMs: 5000 },
    steps: [
      { tool: 'fhir_search', resourceType: 'Observation', drain: true, input: { resource_type: 'Observation', params: [{ name: 'category', value: 'laboratory' }, ...PACKAGE_WINDOW], page_size: 100 } },
      { tool: 'fhir_result', resourceType: 'Observation', handleFrom: 0, input: { action: 'inspect' } },
      { tool: 'fhir_result', resourceType: 'Observation', handleFrom: 0, input: { action: 'project', fields: [...PROJECTED] } },
      { tool: 'fhir_result', resourceType: 'Observation', handleFrom: 0, input: { action: 'page', offset: 0, limit: 5 } },
      { tool: 'fhir_result', resourceType: 'Observation', handleFrom: 0, waitMs: 5500, input: { action: 'inspect' } },
    ],
    checks: [
      { kind: 'resourceIdSet', id: 'labs-exact-membership', step: 0, equals: [...facts.labIds] },
      { kind: 'upstreamWork', id: 'labs-three-upstream-pages', step: 0, clinical: 3, metadata: 1 },
      { kind: 'upstreamPaging', id: 'labs-remainder-before-next-page', step: 0, page_size: 100 },
      { kind: 'queryEvidence', id: 'labs-first-page-partial', step: 0, state: 'partial', query_exhausted: false, reasons_include: ['MORE_PAGES'] },
      { kind: 'totalWithheldWhileMore', id: 'labs-no-total-while-more', step: 0 },
      { kind: 'envelopePath', id: 'labs-continuation-unverified', step: 0, path: 'coverage.query_evidence', equals: 'unverified_continuation' },
      { kind: 'queryEvidence', id: 'retained-partial', step: 1, state: 'partial', query_exhausted: null, reasons_include: ['RETAINED_PAGE_IS_NOT_THE_ENTIRE_QUERY'] },
      { kind: 'dataPath', id: 'retained-scope', step: 1, path: 'scope', equals: 'retained_upstream_page' },
      { kind: 'dataPath', id: 'retained-more-upstream', step: 1, path: 'upstream_pages_remain', equals: true },
      // The retained reads answer from the snapshot of the first response (whose handle they use), with no upstream work.
      { kind: 'retainedSlice', id: 'retained-inventory', step: 1, from_step: 0, view: 'omissions', offset: 0, limit: RETAINED_PAGE, whole_count: true, omissions: [
        { format: 'fhir', omitted_fields: [], withheld_reasons: [] },
        { format: 'compact', omitted_fields: 'issuing_transform', withheld_reasons: [], recipe_id: 'r4-lab-evidence-v1/Observation.2' },
      ] },
      { kind: 'retainedSlice', id: 'projection-inventory', step: 2, action: 'project', from_step: 0, view: 'resources', offset: 0, limit: RETAINED_PAGE, fields: [...PROJECTED] },
      { kind: 'retainedSlice', id: 'page-inventory', step: 3, action: 'page', from_step: 0, view: 'resources', offset: 0, limit: 5, fields: [...PROJECTED] },
      ...[1, 2, 3, 4].map((step): Check => ({ kind: 'upstreamWork', id: `retained-local-${step}`, step, clinical: 0, metadata: 0 })),
      { kind: 'omittedIncludes', id: 'projection-omits-unrequested', step: 2, path: '/subject' },
      { kind: 'queryEvidence', id: 'projection-partial', step: 2, state: 'partial', query_exhausted: null, reasons_include: ['RETAINED_PAGE_IS_NOT_THE_ENTIRE_QUERY'] },
      { kind: 'envelopePath', id: 'page-five', step: 3, path: 'pagination.returned_matches', equals: 5 },
      { kind: 'callOutcome', id: 'retained-expired', step: 4, outcome: 'application_error', code: 'RESULT_EXPIRED' },
      { kind: 'envelopePath', id: 'retained-expired-message', step: 4, path: 'error.safe_message', equals: EXPIRED_MESSAGE },
    ],
  };
  return [latest, status, drain];
}

/** The output view of a step for an arm (the eval runner's rule): fields only where the tool returns resources. */
export function armOutput(task: PackageTask, arm: ArmName, tool: PackageStep['tool']): Rec {
  if (tool === 'fhir_result') return { format: arm === 'compact' ? 'compact' : 'fhir', max_bytes: task.perCallBytes };
  if (arm === 'compact') return { format: 'compact', max_bytes: task.perCallBytes };
  if (arm === 'selected' && ['fhir_search', 'fhir_read', 'fhir_page'].includes(tool)) return { format: 'fhir', fields: [...task.fields], max_bytes: task.perCallBytes };
  return { format: 'fhir', max_bytes: task.perCallBytes };
}
