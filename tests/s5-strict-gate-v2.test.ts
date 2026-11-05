// Inert S5.1: hand-built envelopes, no execute/listing switch and no network.
import assert from 'node:assert/strict';
import { SERVER_IDENTITY } from '../packages/core/src/identity.js';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  TOOL_NAMES, toolEnvelopeV2Schemas, validateCrossField02, validateDeliverable02,
  validateSpine, validateListedOutput, type ToolName, type ValidationContext02,
} from '../packages/core/src/contracts.js';
import { parseFhirJson, toWireValue } from '../packages/core/src/decimal.js';
import { evidenceRender } from '../packages/core/src/delivery.js';
import { WARNING_MESSAGES } from '../packages/core/src/catalog.js';
import { NO_MATCHES_UNVERIFIED_SUFFIX } from '../packages/core/src/repairs.js';
import { queryDigest } from '../packages/core/src/query.js';
import type { GatewayEnvelope } from '../packages/core/src/contracts.js';

// Deliberately mutable adversarial fixture DTO; strict validation is the subject.
type Fixture = Record<string, any>;
const at = '2026-10-19T12:00:00Z', expires = '2026-10-19T12:05:00Z';
const identity = SERVER_IDENTITY;
const caveat = 'CLINICAL_RECORD_COMPLETENESS_UNKNOWN';
const query = () => ({
  resourceType: 'Observation', sourceRevision: 'cap-v1', policyRevision: 'policy-v1', contextHandle: 'ctx_test',
  orderedPairs: [{ name: 'subject', value: 'Patient/synthetic-a' }, { name: 'date', value: 'ge2020-01-01' }, { name: 'date', value: 'lt2026-01-01' }],
  sort: ['-date'],
  constraintProof: [{ execution: 'gateway_enforced' }, { execution: 'unknown' }, { execution: 'unknown' }] as NonNullable<NonNullable<ValidationContext02['query']>['constraintProof']>,
  // S6: the trusted sort proof matches the clinical() fixture's unverified sort; verified fixtures override it.
  sortProof: { order: 'requested_unverified', effective: null } as NonNullable<NonNullable<ValidationContext02['query']>['sortProof']>,
});
const verifiedSort = { order: 'verified_by_adapter', effective: ['-date'] } as NonNullable<NonNullable<ValidationContext02['query']>['sortProof']>;
// Independent transcription of the frozen digest, never core queryDigest().
function digest(q = query()): string {
  return createHash('sha256').update(JSON.stringify({ v: 1, source_revision: q.sourceRevision,
    policy_revision: q.policyRevision, context_handle: q.contextHandle, resource_type: q.resourceType,
    constraints: q.orderedPairs.map(p => ({ name: p.name, value: p.value })), sort: q.sort }), 'utf8').digest('hex');
}
// Invocation fixtures are registered before any adversarial wire edits. This
// side table describes test inputs; contextFor never reads wire query/action.
const invocations = new WeakMap<Fixture, Partial<ValidationContext02>>();
const binding = () => ({ sourceAlias: 'local', fhirVersion: '4.0.1', sourceRevision: 'cap-v1', policyRevision: 'policy-v1', contextHandle: 'ctx_test' });
function base(): Fixture {
  return { schema_version: '0.3', request_id: 'req_test',
    source: { alias: 'local', fhir_version: '4.0.1', capability_revision: 'cap-v1' },
    context: { handle: 'ctx_test', mode: 'patient-bound', policy_revision: 'policy-v1' },
    data: {}, coverage: { state: 'unknown', scope: 'page', reasons: [caveat], authorization_limited: true,
      query_exhausted: true, pages_observed: 1, query_evidence: 'exact_id_and_subject_linkage' },
    transform: { format: 'fhir', projected: false, withheld_payloads: [], omitted_fields: [], unresolved_fields: [],
      narrative_omitted: false, recipe_ids: [], structural_resource_indices: [], delivery_profile: 'full-text-v1' },
    warnings: [], budget: { bytes_returned: 0, byte_limit: 24576, limit_reached: false, upstream_calls: 1, elapsed_ms: 0 } };
}
function clinical(tool: ToolName = 'fhir_search'): Fixture {
  const e = base();
  e.data = { resources: [
    { resourceType: 'Observation', id: 'synthetic-o1', meta: { versionId: '7' }, status: 'final' },
    { resourceType: 'Observation', id: 'synthetic-o2' },
  ] };
  e.provenance = [{ resource_index: 0, retrieved_at: at }, { resource_index: 1, retrieved_at: at }];
  e.pagination = { has_more: false, returned_matches: 2, returned_includes: 0, requested_page_size: 20 };
  if (tool === 'fhir_read') {
    e.data.resources.pop(); e.provenance.pop(); e.pagination.returned_matches = 1;
    e.coverage.scope = 'resource'; e.coverage.state = 'complete_for_query';
  } else {
    e.coverage.constraints = query().orderedPairs.map((p, i) => ({ ...p, source_reported: 'matched', execution: i === 0 ? 'gateway_enforced' : 'unknown' }));
    e.coverage.query_digest = digest(); e.coverage.query_evidence = 'declared_and_self_link_only';
    e.coverage.sort = { requested: ['-date'], effective: null, evidence: 'unknown', order: 'requested_unverified' };
    e.warnings.push({ code: 'ORDER_UNVERIFIED', message: 'Requested ordering is not verified; do not treat the first record as latest.' });
    e.coverage.reasons.push('FILTER_EXECUTION_UNVERIFIED');
    // The assembler always emits the caveat warning with the reason, and the gate binds both to the trusted proof (S5 review).
    e.warnings.push({ code: 'FILTER_EXECUTION_UNVERIFIED', message: WARNING_MESSAGES.FILTER_EXECUTION_UNVERIFIED! });
  }
  if (tool === 'fhir_result') retained(e);
  invocations.set(e, tool === 'fhir_read' ? { readTarget: { resourceType: 'Observation', id: 'synthetic-o1' } } : { query: query(), requestedPageSize: 20, ...(tool === 'fhir_result' ? { action: 'page', offset: 0, limit: 20 } : {}) });
  return e;
}
function retained(e: Fixture): void {
  Object.assign(e.coverage, { scope: 'retained', state: 'partial', query_exhausted: null, query_evidence: 'retained_snapshot' });
  e.coverage.reasons.push('RETAINED_PAGE_IS_NOT_THE_ENTIRE_QUERY');
}
function inspection(): Fixture {
  const e = clinical('fhir_result');
  e.data = { resource_count: 3, scope: 'retained_upstream_page', upstream_pages_remain: true,
    formats: ['compact', 'fhir'], omissions: [{ resource_index: 0, resource_type: 'Observation', id: 'synthetic-o1', version: '7',
      omitted_fields: [], withheld_reasons: [], interpretation: 'clinical_projection' }], next_offset: 1 };
  delete e.provenance; delete e.pagination;
  invocations.set(e, { query: query(), action: 'inspect', offset: 0, limit: 20 });
  return e;
}
const classification = { network_confinement: 'literal_loopback', data_classification: 'operator_declared_synthetic_unverified' };
const schemaIdentity = { package: 'hl7.fhir.r4.core', version: '4.0.1', source_sha256: 'a'.repeat(64) };
function metadata(topic: NonNullable<ValidationContext02['topic']>): Fixture {
  const e = base();
  e.coverage = { state: 'complete_for_query', scope: 'metadata', reasons: [], authorization_limited: false,
    query_exhausted: true, pages_observed: 0, query_evidence: 'metadata_snapshot' };
  switch (topic) {
    case 'server': e.data = { source: 'local', fhir_version: '4.0.1', patient_id: 'synthetic-a', snapshot_revision: 'cap-v1', captured_at: at, expires_at: expires, ...classification, implemented_tools: [...TOOL_NAMES],
      resources: [{ type: 'Observation', resource_class: 'patient', implemented_interactions: ['read', 'search-type'] }],
      resource_count: 1, definition_limit: 100, workflow: 'recent-labs-v1', support_matrix_revision: 'support-v1',
      required_resources: ['Patient', 'Observation'], document_support: 'metadata_only' }; break;
    case 'resource': e.data = { type: 'Observation', interactions: ['read', 'search-type'], searchParameters: ['subject', 'date'],
      resource_class: 'patient', evidence: 'declared', implemented_interactions: ['read', 'search-type'], instance_policy: 'patient_bound',
      compact_recipe: null, limitations: [], support_matrix_revision: 'support-v1', ...classification }; break;
    case 'context': e.data = { mode: 'patient-bound', context_handle: 'ctx_test', patient_id: 'synthetic-a', ...classification, support_matrix_revision: 'support-v1' }; break;
    case 'schema': e.data = { resource_type: 'Observation', path: '', definition: 'http://hl7.org/fhir/StructureDefinition/Observation',
      schema: { ...schemaIdentity, source_url: 'https://hl7.org/fhir/R4/', definitions: 1 }, evidence: 'pinned_base_definition',
      profile_validation: 'not_performed', total_elements: 1, elements: [{ path: 'Observation', min: 0, max: '*', types: [] }] }; break;
    case 'search_parameter': e.data = { resource_type: 'Observation', search_parameters: [{ name: 'date', type: 'date',
      definition_evidence: 'pinned_r4', targets: [], description: 'Clinical effective date', source_description_present: false,
      evidence: 'declared', executable: true, modifiers: [], comparators: [], repetition: { and: 'unknown', or: 'unknown' },
      joins: { chain: false, has: false, include: false, revinclude: false }, execution_evidence: 'unknown' }],
      total_parameters: 1, snapshot_revision: 'cap-v1', captured_at: at, expires_at: expires, definitions: schemaIdentity }; break;
    case 'support': e.data = { workflow: 'recent-labs-v1', matrix_revision: 'support-v1', rows: [{ resource_type: 'Observation',
      policy_class: 'patient', patient_link: 'subject', source_advertised: true, advertised_interactions: ['read', 'search-type'],
      policy_interactions: ['read', 'search-type'], executable_interactions: ['read', 'search-type'], instance_policy: 'patient_bound',
      compact_recipe: null, workflow_role: 'required', limitations: [] }], snapshot_revision: 'cap-v1', captured_at: at, expires_at: expires,
      default_policy: 'deny_unclassified', clinical_sections: ['labs'], document_support: 'metadata_only' }; break;
  }
  e.coverage.reasons = [topic === 'schema' ? 'R4_BASE_DEFINITION_NOT_ENDPOINT_PROFILE_VALIDATION' : 'DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION'];
  const rows = e.data.resources ?? e.data.search_parameters ?? e.data.rows ?? e.data.elements;
  invocations.set(e, { topic, resourceType: 'Observation', path: '', patientId: 'synthetic-a', ...(rows ? { metadata: {
    topic: topic as NonNullable<ValidationContext02['metadata']>['topic'], rows: structuredClone(rows), start: 0, offset: 0, total: rows.length, limit: 20,
    deliveredCount: rows.length, byteLimited: false, ...(topic !== 'schema' ? { revision: 'cap-v1', capturedAt: at, expiresAt: expires } : {}),
  } } : {}) });
  return e;
}
function error(tool: ToolName): Fixture {
  const e = base();
  e.error = { code: 'INTERNAL_ERROR', safe_message: 'Unable to complete the bounded request.', retryable: false };
  Object.assign(e.coverage, { state: 'unknown', scope: tool === 'fhir_capabilities' ? 'metadata' : 'query',
    reasons: tool === 'fhir_capabilities' ? ['INTERNAL_ERROR'] : [caveat, 'INTERNAL_ERROR'], authorization_limited: tool !== 'fhir_capabilities',
    query_exhausted: null, pages_observed: 0, query_evidence: 'none' });
  return e;
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
function resultFor(e: Fixture, era: 'modern' | 'legacy', profile: ValidationContext02['deliveryProfile'], text?: string): Fixture {
  return { content: [{ type: 'text', text: text ?? (profile === 'full-text-v1' ? JSON.stringify(e) : evidenceRender(e as GatewayEnvelope, invocations.get(e)?.action ? 'fhir_result' : invocations.get(e)?.topic ? 'fhir_capabilities' : 'fhir_search').text) }],
    structuredContent: e, ...(e.error ? { isError: true } : {}),
    ...(era === 'modern' ? { resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': { ...identity } } } : {}) };
}
function contextFor(e: Fixture, options: Partial<ValidationContext02> = {}, fit = true): ValidationContext02 {
  const era = options.era ?? 'modern', deliveryProfile = options.deliveryProfile ?? 'full-text-v1';
  e.transform.delivery_profile = deliveryProfile;
  if (fit) for (let n = 0; n < 5; n++) e.budget.bytes_returned = Buffer.byteLength(JSON.stringify(resultFor(e, era, deliveryProfile)));
  const result = resultFor(e, era, deliveryProfile);
  return freeze({ era, deliveryProfile, renderedText: result.content[0].text, result,
    serverIdentity: { ...identity }, effectiveByteLimit: 24576, binding: binding(), formatSupplied: false,
    ...invocations.get(e), ...options }) as ValidationContext02;
}
function assertValid(tool: ToolName, e: Fixture, context: ValidationContext02): void {
  assert.equal(toolEnvelopeV2Schemas[tool].safeParse(e).success, true, 'strict schema positive control');
  assert.equal(validateSpine(e), true); assert.equal(validateListedOutput(e), true);
  assert.deepEqual(validateCrossField02(tool, e, context), { ok: true });
  assert.deepEqual(validateDeliverable02(tool, e, context), { ok: true });
}

for (const era of ['modern', 'legacy'] as const) {
  for (const tool of TOOL_NAMES) {
    test(`valid error/emergency ${tool} ${era}`, () => { const e = error(tool); assertValid(tool, e, contextFor(e, { era })); });
    if (tool !== 'fhir_capabilities') {
      test(`valid clinical ${tool} ${era}`, () => { const e = clinical(tool); assertValid(tool, e, contextFor(e, { era })); });
    }
  }
  for (const topic of ['server', 'resource', 'context', 'schema', 'search_parameter', 'support'] as const) {
    test(`valid metadata ${topic} ${era}`, () => { const e = metadata(topic); assertValid('fhir_capabilities', e, contextFor(e, { era, topic })); });
  }
  for (const profile of ['full-text-v1', 'structured-evidence-v1'] as const) {
    for (const format of ['fhir', 'compact'] as const) {
      test(`valid ${format} ${profile} inspection ${era}`, () => { const e = inspection(); e.transform.format = format; e.transform.requested_format = format;
        assertValid('fhir_result', e, contextFor(e, { era, deliveryProfile: profile, action: 'inspect', formatSupplied: true, requestedFormat: format })); });
      test(`valid ${format} ${profile} resources ${era}`, () => { const e = clinical(); e.transform.format = format; e.transform.requested_format = format;
        e.transform.projected = format === 'compact'; if (format === 'compact') e.transform.recipe_ids = ['r4-lab-evidence-v1/Observation.2'];
        assertValid('fhir_search', e, contextFor(e, { era, deliveryProfile: profile, formatSupplied: true, requestedFormat: format })); });
    }
  }
  test(`valid unchanged page shorthand ${era}`, () => { const e = clinical('fhir_page'); delete e.coverage.constraints;
    delete e.coverage.sort.requested; e.coverage.constraints_on_first_page = true;
    assertValid('fhir_page', e, contextFor(e, { era, query: { ...query(), constraintProof: undefined } })); });
  test(`valid exhausted empty search ${era}`, () => { const e = clinical(); e.data.resources = []; delete e.provenance; e.pagination.returned_matches = 0;
    assertValid('fhir_search', e, contextFor(e, { era })); });
  test(`valid noncontinuable safe prefix ${era}`, () => { const e = clinical(); e.pagination.has_more = null;
    Object.assign(e.coverage, { state: 'partial', query_exhausted: null }); e.coverage.reasons.push('NON_CONTINUABLE_UPSTREAM_LINK');
    assertValid('fhir_search', e, contextFor(e, { era })); });
  test(`valid cursor and immutable absolute result expiry ${era}`, () => { const e = clinical();
    e.pagination.has_more = true; e.pagination.next_cursor = 'cur_test'; e.coverage.state = 'partial'; e.coverage.query_exhausted = false;
    e.result = { handle: 'res_test', expires_at: expires, formats: ['compact', 'fhir'] };
    assertValid('fhir_search', e, contextFor(e, { era })); });
  test(`valid structural selected output ${era}`, () => { const e = clinical(); e.transform.projected = true; e.transform.omitted_fields = ['/identifier'];
    e.transform.structural_resource_indices = [1]; e.warnings.push({ code: 'UNINTERPRETED_MODIFIER', message: WARNING_MESSAGES.UNINTERPRETED_MODIFIER });
    assertValid('fhir_search', e, contextFor(e, { era })); });
}

// S7a's terminal-unknown rule also rejects the old S6-08 fixture. A next
// cursor isolates the sticky evidence label from terminal exhaustion checks.
for (const era of ['modern', 'legacy'] as const) for (const shorthand of [false, true]) {
  test(`S6 sticky continuation flag binds evidence with a next cursor ${era}/${shorthand ? 'shorthand' : 'full'}`, () => {
    const make = (kind: 'declared_and_self_link_only' | 'unverified_continuation'): Fixture => {
      const e = clinical('fhir_page');
      Object.assign(e.coverage, { state: 'partial', query_exhausted: false, query_evidence: kind });
      Object.assign(e.pagination, { has_more: true, next_cursor: 'cur_next' });
      e.coverage.reasons.push('MORE_PAGES');
      if (shorthand) {
        delete e.coverage.constraints; delete e.coverage.sort.requested;
        e.coverage.constraints_on_first_page = true;
      }
      if (kind === 'unverified_continuation') {
        e.coverage.reasons.push('CONTINUATION_QUERY_UNVERIFIED');
        e.warnings.push({ code: 'CONTINUATION_QUERY_UNVERIFIED', message: WARNING_MESSAGES.CONTINUATION_QUERY_UNVERIFIED! });
      }
      return e;
    };
    const options = (continuationUnverified: boolean) => ({ era, query: { ...query(), fullEvidenceRequired: !shorthand, continuationUnverified } });
    const labelControl = make('declared_and_self_link_only');
    assertValid('fhir_page', labelControl, contextFor(labelControl, options(false)));
    const honest = make('unverified_continuation');
    assertValid('fhir_page', honest, contextFor(honest, options(true)));

    const relabelled = make('declared_and_self_link_only');
    const context = contextFor(relabelled, options(true));
    assert.equal(toolEnvelopeV2Schemas.fhir_page.safeParse(relabelled).success, true);
    assert.deepEqual(validateCrossField02('fhir_page', relabelled, context), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
    assert.deepEqual(validateDeliverable02('fhir_page', relabelled, context), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
  });
}

type Corruption = [string, (e: Fixture) => void];
const corruptions: Corruption[] = [
  ['wrong tool data', e => { e.data = metadata('support').data; }],
  ['missing mandatory control', e => { delete e.transform.narrative_omitted; }],
  ['unknown envelope key', e => { e.extra = 'bad'; }],
  ['old envelope version', e => { e.schema_version = '0.1'; }],
  ['empty success data', e => { e.data = {}; delete e.provenance; delete e.pagination; }],
  ['missing provenance', e => { delete e.provenance; }],
  ['incomplete provenance', e => { e.provenance.pop(); }],
  ['duplicate provenance', e => { e.provenance[1] = { ...e.provenance[0] }; }],
  ['misindexed provenance', e => { e.provenance[1].resource_index = 2; }],
  ['negative provenance', e => { e.provenance[0].resource_index = -1; }],
  ['old identity provenance', e => { e.provenance[0].id = 'bad'; }],
  ['invalid retrieval time', e => { e.provenance[0].retrieved_at = 'bad'; }],
  ['missing pagination', e => { delete e.pagination; }],
  ['wrong count', e => { e.pagination.returned_matches = 1; }],
  ['nonzero includes', e => { e.pagination.returned_includes = 1; }],
  ['fractional count', e => { e.pagination.returned_matches = 1.5; }],
  ['wrong scope', e => { e.coverage.scope = 'metadata'; }],
  ['wrong authorization flag', e => { e.coverage.authorization_limited = false; }],
  ['missing standing caveat', e => { e.coverage.reasons = []; }],
  ['stale metadata evidence', e => { e.coverage.query_evidence = 'metadata_snapshot'; }],
  ['false complete unproved filter', e => { e.coverage.state = 'complete_for_query'; }],
  ['cursor while terminal', e => { e.pagination.next_cursor = 'cur_test'; }],
  ['cursor while unknown', e => { e.pagination.has_more = null; e.pagination.next_cursor = 'cur_test'; }],
  ['has_more without cursor', e => { e.pagination.has_more = true; e.coverage.query_exhausted = false; }],
  ['cursor falsely exhausted', e => { e.pagination.has_more = true; e.pagination.next_cursor = 'cur_test'; }],
  ['unknown continuation falsely exhausted', e => { e.pagination.has_more = null; }],
  ['terminal unexhausted', e => { e.coverage.query_exhausted = false; }],
  ['upstream total', e => { e.pagination.total = { value: 500, precision: 'accurate' }; }],
  ['wrong delivered total', e => { e.pagination.total = { value: 1, precision: 'unknown' }; }],
  ['wrong format', e => { e.transform.format = 'summary'; }],
  ['wrong requested format', e => { e.transform.requested_format = 'selected'; }],
  ['false projected flag', e => { e.transform.format = 'compact'; }],
  ['omission without projection', e => { e.transform.omitted_fields = ['/identifier']; }],
  ['narrative flag without actual omission', e => { e.transform.narrative_omitted = true; }],
  ['duplicate recipes', e => { e.transform.recipe_ids = ['r', 'r']; }],
  ['duplicate omissions', e => { e.transform.omitted_fields = ['/x', '/x']; }],
  ['unsorted omissions', e => { e.transform.omitted_fields = ['/z', '/a']; }],
  ['duplicate warnings', e => { e.warnings.push({ ...e.warnings[0] }); }],
  ['duplicate reasons', e => { e.coverage.reasons.push(caveat); }],
  ['misindexed structural', e => { e.transform.structural_resource_indices = [2]; }],
  ['duplicate structural', e => { e.transform.structural_resource_indices = [0, 0]; }],
  ['structural without label', e => { e.transform.structural_resource_indices = [0]; }],
  ['duplicate formats', e => { e.result = { handle: 'res_test', expires_at: expires, formats: ['fhir', 'fhir'] }; }],
  ['missing delivered format', e => { e.result = { handle: 'res_test', expires_at: expires, formats: ['compact'] }; }],
  ['expiry before retrieval', e => { e.result = { handle: 'res_test', expires_at: '2020-01-01T00:00:00Z', formats: ['fhir'] }; }],
  ['invalid expiry', e => { e.result = { handle: 'res_test', expires_at: 'bad', formats: ['fhir'] }; }],
  ['missing digest', e => { delete e.coverage.query_digest; }],
  ['wrong digest', e => { e.coverage.query_digest = 'f'.repeat(64); }],
  ['wrong digest type', e => { e.coverage.query_digest = 3; }],
  ['lost repeated pair', e => { e.coverage.constraints.pop(); }],
  // Swap only name/value between two same-execution entries: executions and evidence_ref stay at their positions, so the
  // rejection must come from the pair-order comparison itself, not from the proof-alignment rule (S5 review).
  ['changed constraint order', e => { const c = e.coverage.constraints; const [i, j] = c.length > 2 ? [1, 2] : [0, 1]; [c[i].name, c[j].name] = [c[j].name, c[i].name]; [c[i].value, c[j].value] = [c[j].value, c[i].value]; }],
  ['changed constraint value', e => { e.coverage.constraints[1].value = 'ge2021-01-01'; }],
  ['missing full constraints', e => { delete e.coverage.constraints; }],
  ['shorthand on first page', e => { delete e.coverage.constraints; delete e.coverage.sort.requested; e.coverage.constraints_on_first_page = true; }],
  ['full plus shorthand', e => { e.coverage.constraints_on_first_page = true; }],
  ['missing full requested sort', e => { delete e.coverage.sort.requested; }],
  ['changed requested sort', e => { e.coverage.sort.requested = ['date']; }],
  ['missing sort', e => { delete e.coverage.sort; }],
  ['unverified effective sort', e => { e.coverage.sort.effective = ['-date']; }],
  ['unverified sort without warning', e => { e.warnings = []; }],
  ['unbacked sort proof', e => { e.coverage.sort.order = 'verified_by_adapter'; e.coverage.sort.effective = ['-date']; }],
  ['unspecified requested sort', e => { e.coverage.sort.order = 'unspecified'; }],
  ['mixed resource types', e => { e.data.resources[1].resourceType = 'Condition'; }],
];
for (const [name, corrupt] of corruptions) {
  test(`corruption: ${name}`, () => { const e = clinical(); corrupt(e); const ctx = contextFor(e);
    assert.equal(validateCrossField02('fhir_search', e, ctx).ok, false, name);
    assert.equal(validateDeliverable02('fhir_search', e, ctx).ok, false, name); });
}
test('corruption: reordered constraint pairs with aligned executions are a context mismatch (order is pinned)', () => {
  const e = clinical(); const c = e.coverage.constraints; const [i, j] = c.length > 2 ? [1, 2] : [0, 1];
  assert.notDeepEqual([c[i].name, c[i].value], [c[j].name, c[j].value], 'fixture pairs must differ for the swap to reorder');
  assert.equal(c[i].execution, c[j].execution, 'swap must not move executions');
  [c[i].name, c[j].name] = [c[j].name, c[i].name]; [c[i].value, c[j].value] = [c[j].value, c[i].value];
  const ctx = contextFor(e);
  assert.deepEqual(validateCrossField02('fhir_search', e, ctx), { ok: false, reason: 'VALIDATION_CONTEXT_MISMATCH' });
  assert.deepEqual(validateDeliverable02('fhir_search', e, ctx), { ok: false, reason: 'VALIDATION_CONTEXT_MISMATCH' });
});
const staleError: Corruption[] = [
  ['clinical data', e => { e.data = { resources: [] }; }], ['metadata data', e => { e.data = metadata('server').data; }],
  ['provenance', e => { e.provenance = []; }], ['pagination', e => { e.pagination = { has_more: false, returned_matches: 0, returned_includes: 0 }; }],
  ['result', e => { e.result = { handle: 'res_test', expires_at: expires, formats: ['fhir'] }; }],
  ['full query', e => { e.coverage.constraints = []; }], ['digest', e => { e.coverage.query_digest = digest(); }],
  ['shorthand', e => { e.coverage.constraints_on_first_page = true; }], ['sort', e => { e.coverage.sort = clinical().coverage.sort; }],
  ['exhaustion', e => { e.coverage.query_exhausted = true; }], ['pages', e => { e.coverage.pages_observed = 1; }],
  ['complete', e => { e.coverage.state = 'complete_for_query'; }], ['projected', e => { e.transform.projected = true; }],
  ['narrative', e => { e.transform.narrative_omitted = true; }], ['payloads', e => { e.transform.withheld_payloads = [{ path: '/x', reason: 'PROTECTED_LINK' }]; }],
  ['omissions', e => { e.transform.omitted_fields = ['/x']; }], ['unresolved', e => { e.transform.unresolved_fields = ['code']; }],
  ['recipes', e => { e.transform.recipe_ids = ['r']; }], ['structural', e => { e.transform.structural_resource_indices = [0]; }],
];
for (const tool of TOOL_NAMES) for (const [name, corrupt] of staleError) {
  test(`error corruption ${tool}: stale ${name}`, () => { const e = error(tool); corrupt(e);
    assert.equal(validateDeliverable02(tool, e, contextFor(e)).ok, false); });
}

const inspectCorruptions: Corruption[] = [
  ['provenance for nonexistent bodies', e => { e.provenance = []; }],
  ['wrong retained state', e => { e.coverage.state = 'complete_for_query'; }],
  ['wrong retained exhaustion', e => { e.coverage.query_exhausted = true; }],
  ['wrong retained evidence', e => { e.coverage.query_evidence = 'tested_adapter'; }],
  ['missing retained caveat', e => { e.coverage.reasons = [caveat]; }],
  ['shorthand inspection', e => { delete e.coverage.constraints; delete e.coverage.sort.requested; e.coverage.constraints_on_first_page = true; }],
  ['nonlocal row index', e => { e.data.omissions[0].resource_index = 1; }],
  ['wrong row count', e => { e.data.resource_count = 0; }],
  ['wrong row format', e => { e.data.formats = ['compact']; }],
  ['duplicate row formats', e => { e.data.formats = ['fhir', 'fhir']; }],
  ['structural misindex', e => { e.transform.structural_resource_indices = [1]; }],
  ['structural interpretation missing', e => { e.transform.structural_resource_indices = [0]; e.warnings.push({ code: 'UNINTERPRETED_MODIFIER', message: 'Structural.' }); }],
  ['structural index missing', e => { e.data.omissions[0].interpretation = 'structural'; }],
  ['invalid next offset', e => { e.data.next_offset = 3; }],
];
for (const [name, corrupt] of inspectCorruptions) test(`inspection corruption: ${name}`, () => {
  const e = inspection(); corrupt(e); assert.equal(validateDeliverable02('fhir_result', e, contextFor(e, { action: 'inspect' })).ok, false);
});
for (const topic of ['server', 'resource', 'context', 'schema', 'search_parameter', 'support'] as const) {
  for (const [name, corrupt] of [
    ['provenance', (e: Fixture) => { e.provenance = []; }], ['retention', (e: Fixture) => { e.result = { handle: 'res_test', expires_at: expires, formats: ['fhir'] }; }],
    ['authorization', (e: Fixture) => { e.coverage.authorization_limited = true; }], ['scope', (e: Fixture) => { e.coverage.scope = 'page'; }],
    ['query evidence', (e: Fixture) => { e.coverage.constraints = []; }],
  ] as Corruption[]) test(`metadata corruption ${topic}: ${name}`, () => { const e = metadata(topic); corrupt(e);
    assert.equal(validateDeliverable02('fhir_capabilities', e, contextFor(e, { topic })).ok, false); });
}
for (const topic of ['search_parameter', 'support'] as const) {
  test(`valid discovery continuation ${topic}`, () => { const e = metadata(topic); e.data.next_cursor = 'cur_discovery';
    e.coverage.state = 'partial'; e.coverage.query_exhausted = false; e.coverage.reasons.push('MORE_PAGES');
    const m = invocations.get(e)!.metadata!; invocations.set(e, { ...invocations.get(e), metadata: { ...m, rows: [...m.rows, ...m.rows], total: 2, limit: 1, nextCursor: 'cur_discovery', nextOffset: 1 } });
    if (topic === 'search_parameter') e.data.total_parameters = 2;
    assertValid('fhir_capabilities', e, contextFor(e, { topic })); });
  test(`discovery expiry/cursor corruption ${topic}`, () => {
    for (const corrupt of [(e: Fixture) => { e.data.expires_at = at; }, (e: Fixture) => { e.data.next_cursor = 'cur_discovery'; }]) {
      const e = metadata(topic); corrupt(e); assert.equal(validateDeliverable02('fhir_capabilities', e, contextFor(e, { topic })).ok, false);
    }
  });
}

test('context-free semantic checks; final accounting requires explicit context', () => {
  const e = clinical('fhir_read');
  assert.deepEqual(validateCrossField02('fhir_read', e), { ok: true });
  assert.deepEqual(validateDeliverable02('fhir_read', e), { ok: false, reason: 'VALIDATION_CONTEXT_REQUIRED' });
  assert.deepEqual(validateCrossField02('fhir_capabilities', metadata('server')), { ok: false, reason: 'VALIDATION_CONTEXT_MISMATCH' });
  const q = clinical();
  assert.deepEqual(validateCrossField02('fhir_search', q), { ok: false, reason: 'VALIDATION_CONTEXT_REQUIRED' });
  q.pagination.returned_matches = 0;
  assert.deepEqual(validateCrossField02('fhir_search', q), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
});
for (const key of ['era', 'deliveryProfile', 'renderedText', 'result', 'serverIdentity'] as const) {
  test(`missing context field ${key}`, () => { const e = clinical('fhir_read'); const c = { ...contextFor(e) } as Fixture; delete c[key];
    assert.deepEqual(validateDeliverable02('fhir_read', e, freeze(c) as ValidationContext02), { ok: false, reason: 'VALIDATION_CONTEXT_REQUIRED' }); });
}
for (const tool of ['fhir_search', 'fhir_page', 'fhir_result'] as const) test(`missing trusted query context ${tool}`, () => {
  const e = tool === 'fhir_result' ? inspection() : clinical(tool); const c = contextFor(e, { query: undefined });
  assert.deepEqual(validateCrossField02(tool, e, c), { ok: false, reason: 'VALIDATION_CONTEXT_REQUIRED' });
});
for (const [name, mutate] of [
  ['wrong era', (c: Fixture) => { c.era = 'legacy'; }],
  ['stale rendered text', (c: Fixture) => { c.renderedText = 'stale'; }],
  ['wrong identity', (c: Fixture) => { c.serverIdentity = { name: 'other', version: '0' }; }],
  ['wrong profile', (c: Fixture) => { c.deliveryProfile = 'structured-evidence-v1'; }],
  ['wrong topic', (c: Fixture) => { c.topic = 'server'; }],
] as [string, (c: Fixture) => void][]) test(`context mismatch: ${name}`, () => {
  const e = metadata('context'); const c = { ...contextFor(e, { topic: 'context' }) }; mutate(c);
  assert.deepEqual(validateDeliverable02('fhir_capabilities', e, freeze(c) as ValidationContext02), { ok: false, reason: 'VALIDATION_CONTEXT_MISMATCH' });
});
test('wrong result action refuses', () => { const e = inspection(); assert.equal(validateCrossField02('fhir_result', e, contextFor(e, { action: 'page' })).ok, false); });
test('shallow frozen context refuses', () => { const e = clinical('fhir_read'); const c = contextFor(e);
  assert.deepEqual(validateDeliverable02('fhir_read', e, Object.freeze({ ...c, serverIdentity: { ...identity } })), { ok: false, reason: 'VALIDATION_CONTEXT_MISMATCH' }); });
for (const era of ['modern', 'legacy'] as const) for (const delta of [-1, 1]) test(`final bytes ${era} delta ${delta}`, () => {
  const e = clinical('fhir_read'); contextFor(structuredClone(e), { era }); // independent positive covered above
  for (let i = 0; i < 5; i++) e.budget.bytes_returned = Buffer.byteLength(JSON.stringify(resultFor(e, era, 'full-text-v1')));
  e.budget.bytes_returned += delta;
  const c = contextFor(e, { era }, false);
  assert.deepEqual(validateDeliverable02('fhir_read', e, c), { ok: false, reason: 'INVALID_FINAL_BYTES' });
});
test('final byte ceiling refuses even with exact accounting', () => { const e = clinical('fhir_read');
  e.budget.byte_limit = 4096; e.data.resources[0].valueString = 'synthetic'.repeat(1000);
  assert.deepEqual(validateDeliverable02('fhir_read', e, contextFor(e)), { ok: false, reason: 'INVALID_FINAL_BYTES' }); });
test('result/wire mismatch and isError mismatch refuse', () => {
  for (const patch of [(e: Fixture) => { e.request_id = 'changed'; }, (e: Fixture) => { e.error = error('fhir_read').error; }]) {
    const original = clinical('fhir_read'), c = contextFor(original); const changed = structuredClone(original); patch(changed);
    assert.equal(validateDeliverable02('fhir_read', changed, c).ok, false);
  }
});
test('shorthand cannot carry full sort or borrow a foreign query', () => {
  for (const fullSort of [true, false]) {
    const e = clinical('fhir_page'); delete e.coverage.constraints; e.coverage.constraints_on_first_page = true;
    if (!fullSort) delete e.coverage.sort.requested;
    const q = query(); if (!fullSort) q.orderedPairs[0]!.value = 'Patient/other-synthetic';
    assert.equal(validateDeliverable02('fhir_page', e, contextFor(e, { query: q })).ok, false);
  }
});
test('wrong query identity and missing query fields fail closed, including empty/inspection', () => {
  for (const factory of [() => { const e = clinical(); e.data.resources = []; e.provenance = []; e.pagination.returned_matches = 0; return e; }, inspection]) {
    for (const key of ['resourceType', 'sourceRevision', 'policyRevision', 'contextHandle', 'orderedPairs', 'sort']) {
      const e = factory(), q: Fixture = query(); delete q[key];
      assert.deepEqual(validateCrossField02('omissions' in e.data ? 'fhir_result' : 'fhir_search', e, contextFor(e, { query: q as ValidationContext02['query'] })), { ok: false, reason: 'VALIDATION_CONTEXT_REQUIRED' }, key);
    }
  }
});
test('lossless raw numbers survive validation unchanged, including overflow', () => {
  const e = clinical('fhir_read');
  e.data.resources[0] = toWireValue(parseFhirJson('{"resourceType":"Observation","id":"synthetic-o1","valueQuantity":{"value":7.0},"component":[{"valueInteger":9007199254740993},{"valueDecimal":1e400}]}'));
  const c = contextFor(e); const before = JSON.stringify(e), raw = e.data.resources[0].valueQuantity.value;
  assertValid('fhir_read', e, c);
  assert.equal(e.data.resources[0].valueQuantity.value, raw);
  assert.equal(JSON.stringify(e), before);
  assert.ok(before.includes('"value":7.0')); assert.ok(before.includes('9007199254740993')); assert.ok(before.includes('1e400'));
});
test('no validation repairs accounting or mutates failed input', () => { const e = clinical('fhir_read'); e.budget.bytes_returned = 1;
  const c = contextFor(e, {}, false), before = JSON.stringify(e); assert.equal(validateDeliverable02('fhir_read', e, c).ok, false);
  assert.equal(JSON.stringify(e), before); });

for (const era of ['modern', 'legacy'] as const) test(`valid renderer whole-result fallback ${era}`, () => {
  const e = metadata('support');
  let text = '';
  for (let i = 0; i < 5; i++) {
    text = evidenceRender(e as GatewayEnvelope).text;
    e.budget.bytes_returned = Buffer.byteLength(JSON.stringify(resultFor(e, era, 'full-text-v1', text)));
  }
  const rendered = evidenceRender(e as GatewayEnvelope);
  assert.equal(rendered.deliveredProfile, 'full-text-v1');
  const c = freeze({ era, deliveryProfile: rendered.deliveredProfile, renderedText: rendered.text,
    result: resultFor(e, era, 'full-text-v1', rendered.text), serverIdentity: { ...identity }, ...invocations.get(e), topic: 'support', binding: binding(), effectiveByteLimit: 24576, formatSupplied: false }) as ValidationContext02;
  assertValid('fhir_capabilities', e, c);
});
test('complete proven membership remains complete with unverified requested ordering', () => {
  const e = clinical(); e.coverage.state = 'complete_for_query';
  for (const p of e.coverage.constraints.slice(1)) { p.execution = 'tested_adapter'; p.evidence_ref = 'synthetic-proof-v1'; }
  e.coverage.query_evidence = 'tested_adapter'; e.coverage.reasons = [caveat]; e.warnings = e.warnings.filter((w: any) => w.code !== 'FILTER_EXECUTION_UNVERIFIED');
  assertValid('fhir_search', e, contextFor(e, { query: { ...query(), constraintProof: [{ execution: 'gateway_enforced' }, { execution: 'tested_adapter', evidence_ref: 'synthetic-proof-v1' }, { execution: 'tested_adapter', evidence_ref: 'synthetic-proof-v1' }] } }));
});
test('full query without requested ordering and safe delivered total', () => {
  const e = clinical(), q = query(); q.sort = [];
  delete e.coverage.sort; e.warnings = e.warnings.filter((w: any) => w.code !== 'ORDER_UNVERIFIED'); e.coverage.query_digest = digest(q);
  e.pagination.total = { value: 2, precision: 'unknown' };
  assertValid('fhir_search', e, contextFor(e, { query: q }));
});
test('valid reversed provenance order still maps exactly once to every delivered index', () => {
  const e = clinical(); e.provenance.reverse(); assertValid('fhir_search', e, contextFor(e));
});
test('proof references and evidence flags must agree', () => {
  for (const corrupt of [
    (e: Fixture) => { e.coverage.constraints[1].execution = 'tested_adapter'; },
    (e: Fixture) => { e.coverage.query_evidence = 'tested_adapter'; },
    (e: Fixture) => { e.coverage.query_evidence = 'exact_id_and_subject_linkage'; },
  ]) { const e = clinical(); corrupt(e); assert.equal(validateDeliverable02('fhir_search', e, contextFor(e)).ok, false); }
});
test('missing trusted query object on shorthand fails with fixed reason', () => {
  const e = clinical('fhir_page'); delete e.coverage.constraints; delete e.coverage.sort.requested; e.coverage.constraints_on_first_page = true;
  assert.deepEqual(validateCrossField02('fhir_page', e), { ok: false, reason: 'VALIDATION_CONTEXT_REQUIRED' });
});
test('successful read cannot return multiple records or an unlabelled empty delivery', () => {
  for (const count of [0, 2]) { const e = clinical('fhir_read'); e.data.resources = count ? clinical().data.resources : [];
    e.provenance = count ? clinical().provenance : []; e.pagination.returned_matches = count;
    assert.equal(validateDeliverable02('fhir_read', e, contextFor(e)).ok, false); }
});
test('typed context binds both error flag directions and SDK-added fields', () => {
  for (const make of [() => clinical('fhir_read'), () => error('fhir_read')]) {
    const e = make(), original = contextFor(e), result = { ...original.result, isError: !Boolean(e.error) };
    const c = freeze({ ...original, result }); assert.equal(validateDeliverable02('fhir_read', e, c).ok, false);
  }
  for (const era of ['modern', 'legacy'] as const) {
    const e = clinical('fhir_read'), original = contextFor(e, { era });
    const c = freeze({ ...original, result: { ...original.result, extra: true } });
    assert.equal(validateDeliverable02('fhir_read', e, c).ok, false);
  }
});
test('invalid roots and malformed tool names fail without throwing', () => {
  for (const v of [null, false, [], 'bad', 3, {}, { schema_version: '0.3' }]) {
    assert.equal(validateCrossField02('fhir_search', v).ok, false); assert.equal(validateDeliverable02('fhir_search', v).ok, false);
  }
  assert.equal(validateCrossField02('not_a_tool' as ToolName, clinical()).ok, false);
});

test('per-tool parsing refuses otherwise coherent wrong-tool inspection data', () => {
  const e = clinical(); e.data = inspection().data; delete e.provenance; delete e.pagination;
  const c = contextFor(e);
  assert.deepEqual(validateCrossField02('fhir_search', e, c), { ok: false, reason: 'INVALID_SHAPE' });
});
test('a partial known continuation must have a cursor', () => {
  const e = clinical(); e.coverage.state = 'partial'; e.coverage.query_exhausted = false; e.pagination.has_more = true;
  assert.equal(validateDeliverable02('fhir_search', e, contextFor(e)).ok, false);
});

for (const [tool, key] of [['fhir_capabilities', 'topic'], ['fhir_result', 'action']] as const) test(`missing invocation context ${key}`, () => {
  const e = tool === 'fhir_result' ? inspection() : metadata('support');
  const c: Fixture = { ...contextFor(e, tool === 'fhir_capabilities' ? { topic: 'support' } : { action: 'inspect' }) }; delete c[key];
  assert.deepEqual(validateDeliverable02(tool, e, freeze(c) as ValidationContext02), { ok: false, reason: 'VALIDATION_CONTEXT_REQUIRED' });
});
for (const key of ['name', 'version'] as const) test(`incomplete identity context ${key}`, () => {
  const e = clinical('fhir_read'), c = contextFor(e), serverIdentity: Fixture = { ...c.serverIdentity }; delete serverIdentity[key];
  assert.deepEqual(validateDeliverable02('fhir_read', e, freeze({ ...c, serverIdentity }) as ValidationContext02), { ok: false, reason: 'VALIDATION_CONTEXT_REQUIRED' });
});
for (const key of ['content', 'structuredContent'] as const) test(`incomplete result context ${key}`, () => {
  const e = clinical('fhir_read'), c = contextFor(e), result: Fixture = { ...c.result }; delete result[key];
  assert.deepEqual(validateDeliverable02('fhir_read', e, freeze({ ...c, result }) as ValidationContext02), { ok: false, reason: 'VALIDATION_CONTEXT_REQUIRED' });
});
test('error envelopes cannot retain query warnings or claim resource completeness scope', () => {
  for (const patch of [(e: Fixture) => { e.warnings = [{ code: 'NO_MATCHES', message: 'stale' }]; },
    (e: Fixture) => { e.coverage.scope = 'resource'; }]) {
    const e = error('fhir_read'); patch(e); assert.equal(validateCrossField02('fhir_read', e).ok, false);
  }
});
test('unverified order cannot claim observed execution support', () => {
  const e = clinical(); e.coverage.sort.evidence = 'observed_supported';
  assert.equal(validateDeliverable02('fhir_search', e, contextFor(e)).ok, false);
});

test('narrative omission can belong to an authorized contained resource', () => {
  const e = clinical(); e.transform.projected = true; e.transform.narrative_omitted = true; e.transform.omitted_fields = ['/contained/0/text'];
  assertValid('fhir_search', e, contextFor(e));
});
test('captured application error requires literal isError true', () => {
  const e = error('fhir_read'), c = contextFor(e);
  const bad = freeze({ ...c, result: { ...c.result, isError: 'yes' } }) as unknown as ValidationContext02;
  assert.equal(validateDeliverable02('fhir_read', e, bad).ok, false);
});

// Claude's accepted-corruption seeds. Trusted input fixtures are independent of
// the corrupted response; semantic reasons must win over snapshot mismatches.
{
  const ctx = (e: Fixture, options: Partial<ValidationContext02> & { text?: string } = {}) => {
    if (options.text === undefined) return contextFor(e, options);
    const era = options.era ?? 'modern', profile = options.deliveryProfile ?? 'full-text-v1';
    e.transform.delivery_profile = profile;
    for (let i = 0; i < 5; i++) e.budget.bytes_returned = Buffer.byteLength(JSON.stringify(resultFor(e, era, profile, options.text)));
    const c = contextFor(e, options, false), result = resultFor(e, era, profile, options.text);
    return freeze({ ...c, renderedText: options.text, result });
  };
  const fullCtx = (e: Fixture, extra: any = {}) => ctx(e, { query: query(), ...extra });
  const mismatches = new Set(['P08', 'P08b', 'P09', 'P10', 'P10b', 'P45', 'P45b', 'P57', 'P57b', 'C1']);
  function probe(id: string, expected: 'REJECT' | 'ACCEPT', tool: ToolName, build: () => { e: Fixture; c?: any }, note: string) {
    test(`review probe ${id}: ${note}`, () => {
      const { e, c } = build();
      assert.equal(toolEnvelopeV2Schemas[tool].safeParse(e).success, true);
      const result = validateDeliverable02(tool, e, c);
      assert.deepEqual(result, expected === 'ACCEPT' ? { ok: true } : { ok: false, reason: id === 'P07' ? 'INVALID_FINAL_BYTES' : mismatches.has(id) ? 'VALIDATION_CONTEXT_MISMATCH' : 'INVALID_CROSS_FIELDS' });
    });
  }
// Positive controls with explicit trusted context (no wire-derived context)
probe('POS-1', 'ACCEPT', 'fhir_search', () => { const e = clinical(); return { e, c: fullCtx(e) }; }, 'positive: search');
probe('POS-2', 'ACCEPT', 'fhir_result', () => { const e = clinical('fhir_result'); return { e, c: fullCtx(e, { action: 'page' }) }; }, 'positive: retained page of a search with full query');
probe('POS-3', 'ACCEPT', 'fhir_result', () => { const e = inspection(); return { e, c: fullCtx(e, { action: 'inspect' }) }; }, 'positive: retained inspection of a search');
probe('POS-4', 'ACCEPT', 'fhir_read', () => { const e = clinical('fhir_read'); return { e, c: ctx(e) }; }, 'positive: read');

// P01/P02: retained output of a SEARCH with query evidence stripped, trusted query context supplied
const strip = (e: Fixture) => { delete e.coverage.constraints; delete e.coverage.query_digest; delete e.coverage.sort; e.warnings = e.warnings.filter((w: any) => w.code !== 'ORDER_UNVERIFIED'); };
probe('P01', 'REJECT', 'fhir_result', () => { const e = clinical('fhir_result'); strip(e); return { e, c: fullCtx(e, { action: 'page' }) }; }, 'retained page of a search: constraints/digest/sort stripped while trusted query is supplied');
probe('P02', 'REJECT', 'fhir_result', () => { const e = inspection(); strip(e); return { e, c: fullCtx(e, { action: 'inspect' }) }; }, 'retained inspection of a search: query evidence stripped while trusted query is supplied');
probe('P02b', 'REJECT', 'fhir_result', () => { const e = clinical('fhir_result'); strip(e); e.data.resources[0].resourceType = 'Observation'; return { e, c: fullCtx(e, { action: 'page', query: { ...query(), resourceType: 'Condition' } }) }; }, 'retained page: wrong resource type vs trusted query is unchecked once digest stripped');

// P03/P04/P26: false complete_for_query
probe('P03', 'REJECT', 'fhir_page', () => { const e = clinical('fhir_page'); delete e.coverage.constraints; delete e.coverage.sort.requested; e.coverage.constraints_on_first_page = true;
  e.coverage.state = 'complete_for_query'; return { e, c: fullCtx(e) }; }, 'shorthand page: complete_for_query while reasons carry FILTER_EXECUTION_UNVERIFIED and evidence is declared_and_self_link_only');
probe('P04', 'REJECT', 'fhir_search', () => { const e = clinical(); e.coverage.state = 'complete_for_query';
  for (const p of e.coverage.constraints.slice(1)) { p.execution = 'tested_adapter'; p.evidence_ref = 'proof-v1'; }
  return { e, c: fullCtx(e) }; }, 'full: complete_for_query with FILTER_EXECUTION_UNVERIFIED reason and declared_and_self_link_only evidence label');
probe('P26', 'REJECT', 'fhir_page', () => { const e = clinical('fhir_page'); delete e.coverage.constraints; delete e.coverage.sort.requested; e.coverage.constraints_on_first_page = true;
  e.coverage.state = 'complete_for_query'; e.coverage.query_evidence = 'unverified_continuation'; e.coverage.reasons = [caveat];
  e.warnings.push({ code: 'CONTINUATION_QUERY_UNVERIFIED', message: WARNING_MESSAGES.CONTINUATION_QUERY_UNVERIFIED }); return { e, c: fullCtx(e) }; }, 'shorthand page: complete_for_query under unverified_continuation');

// P05/P06: oversized manifest + complete
probe('P05', 'REJECT', 'fhir_read', () => { const e = clinical('fhir_read'); e.data = { resources: [], manifest: { reason: 'RESOURCE_EXCEEDS_INLINE_BUDGET', action: 'Use fhir_result.' } };
  e.provenance = []; e.pagination.returned_matches = 0; e.coverage.reasons.push('OVERSIZED_RESOURCE'); return { e, c: ctx(e) }; }, 'read: resource not delivered (manifest) yet complete_for_query');
probe('P06', 'REJECT', 'fhir_search', () => { const e = clinical(); e.data.manifest = { reason: 'RESOURCE_EXCEEDS_INLINE_BUDGET', action: 'Use fhir_result.' };
  e.coverage.state = 'complete_for_query'; e.coverage.reasons = [caveat];
  for (const p of e.coverage.constraints.slice(1)) { p.execution = 'tested_adapter'; p.evidence_ref = 'proof-v1'; } e.coverage.query_evidence = 'tested_adapter';
  return { e, c: fullCtx(e) }; }, 'search: manifest (delivery loss) with complete_for_query, limit_reached=false');
probe('P05b', 'REJECT', 'fhir_read', () => { const e = clinical('fhir_read'); e.data.manifest = { reason: 'RESOURCE_EXCEEDS_INLINE_BUDGET', action: 'x' }; return { e, c: ctx(e) }; }, 'read: delivered resource AND oversize manifest simultaneously');

// P07: byte_limit inflated
probe('P07', 'REJECT', 'fhir_read', () => { const e = clinical('fhir_read'); e.budget.byte_limit = 131072; e.data.resources[0].valueString = 'synthetic'.repeat(3000); return { e, c: ctx(e) }; }, '~27 KB read accepted: reported byte_limit 131072 is wire-supplied; trusted requested/configured allowance (e.g. 4096 or 24576) absent from context');

// P08/P09/P10/P45: unbound identity outside the search query
probe('P08', 'REJECT', 'fhir_read', () => { const e = clinical('fhir_read'); e.context.handle = 'ctx_other_patient'; e.context.policy_revision = 'policy-old'; return { e, c: ctx(e) }; }, 'read: foreign context handle and stale policy revision');
probe('P08b', 'REJECT', 'fhir_result', () => { const e = clinical('fhir_result'); strip(e); e.context.handle = 'ctx_other'; return { e, c: ctx(e, { action: 'page', query: undefined }) }; }, 'retained page (read-origin path): foreign context handle');
probe('P09', 'REJECT', 'fhir_search', () => { const e = clinical(); e.source.alias = 'other-source'; e.source.fhir_version = '5.0.0'; return { e, c: fullCtx(e) }; }, 'search: source alias/fhir_version not bound to trusted identity');
probe('P10', 'REJECT', 'fhir_read', () => { const e = clinical('fhir_read'); e.data.resources[0].id = 'synthetic-other'; return { e, c: ctx(e) }; }, 'read returns a different id than requested (no trusted read identity in context)');
probe('P10b', 'REJECT', 'fhir_read', () => { const e = clinical('fhir_read'); e.data.resources[0].resourceType = 'Patient'; return { e, c: ctx(e) }; }, 'read returns a different resource type than requested');
probe('P45', 'REJECT', 'fhir_capabilities', () => { const e = metadata('context'); e.data.patient_id = 'synthetic-b'; return { e, c: ctx(e, { topic: 'context' }) }; }, 'context topic: patient_id not bound to trusted binding');
probe('P45b', 'REJECT', 'fhir_capabilities', () => { const e = metadata('resource'); e.data.type = 'Patient'; return { e, c: ctx(e, { topic: 'resource' }) }; }, 'resource topic: requested resource_type not bound');

// Error-path stale evidence
probe('P11', 'REJECT', 'fhir_read', () => { const e = error('fhir_read'); e.error.code = 'TOTALLY_MADE_UP'; e.error.safe_message = 'anything at all'; return { e, c: ctx(e) }; }, 'error: code outside FAULT_CODES, free-form message');
probe('P12', 'REJECT', 'fhir_search', () => { const e = error('fhir_search'); e.coverage.query_evidence = 'tested_adapter'; return { e, c: ctx(e) }; }, 'error: stale tested_adapter query evidence');
probe('P13', 'REJECT', 'fhir_search', () => { const e = error('fhir_search'); e.warnings = [{ code: 'FILTER_EXECUTION_UNVERIFIED', message: WARNING_MESSAGES.UNINTERPRETED_MODIFIER }, { code: 'UNINTERPRETED_MODIFIER', message: WARNING_MESSAGES.UNINTERPRETED_MODIFIER }, { code: 'CONTINUATION_QUERY_UNVERIFIED', message: WARNING_MESSAGES.UNINTERPRETED_MODIFIER }]; return { e, c: ctx(e) }; }, 'error: stale query/transform warnings');
probe('P14', 'REJECT', 'fhir_search', () => { const e = error('fhir_search'); e.coverage.reasons.push('RETAINED_PAGE_IS_NOT_THE_ENTIRE_QUERY', 'MORE_PAGES', 'NON_CONTINUABLE_UPSTREAM_LINK'); return { e, c: ctx(e) }; }, 'error: stale success coverage reasons');
probe('P14b', 'REJECT', 'fhir_capabilities', () => { const e = error('fhir_capabilities'); e.coverage.query_evidence = 'retained_snapshot'; return { e, c: ctx(e) }; }, 'capabilities error: retained_snapshot evidence');

// Transform declarations vs rendered data
probe('P16', 'REJECT', 'fhir_search', () => { const e = clinical(); e.transform.recipe_ids = ['r4-lab-evidence-v1/Observation.2']; return { e, c: fullCtx(e) }; }, 'fhir unprojected output declares a compact recipe');
probe('P17', 'REJECT', 'fhir_search', () => { const e = clinical(); e.transform.format = 'compact'; e.transform.requested_format = 'compact'; e.transform.projected = true; return { e, c: fullCtx(e, { formatSupplied: true, requestedFormat: 'compact' }) }; }, 'compact projected output with no recipe_ids');
probe('P18', 'REJECT', 'fhir_search', () => { const e = clinical(); e.transform.withheld_payloads = [{ path: '/presentedForm/0/data', reason: 'ATTACHMENT_PAYLOAD', data: 'U1lOVEhFVElDLVBBWUxPQUQ=' }]; return { e, c: fullCtx(e) }; }, 'withheld manifest carries the payload itself');
probe('P19', 'REJECT', 'fhir_search', () => { const e = clinical(); e.transform.withheld_payloads = [{}]; return { e, c: fullCtx(e) }; }, 'withheld manifest with no path/reason');
probe('P20', 'REJECT', 'fhir_search', () => { const e = clinical(); e.warnings.push({ code: 'UNINTERPRETED_MODIFIER', message: WARNING_MESSAGES.UNINTERPRETED_MODIFIER }); return { e, c: fullCtx(e) }; }, 'UNINTERPRETED_MODIFIER warning with no structural indices');
probe('P21', 'ACCEPT', 'fhir_search', () => { const e = clinical(); e.transform.projected = true; e.transform.omitted_fields = ['/text']; return { e, c: fullCtx(e) }; }, 'top-level /text omitted but narrative_omitted=false');
probe('P65', 'REJECT', 'fhir_search', () => { const e = clinical(); e.data.resources[1] = { ...e.data.resources[0], meta: { versionId: '7' } }; return { e, c: fullCtx(e) }; }, 'same Observation/synthetic-o1 v7 delivered twice (0.1 R2-2 rejected duplicate type/id)');

// Continuation consistency
probe('P22a', 'REJECT', 'fhir_result', () => { const e = clinical('fhir_result'); e.pagination.has_more = true; return { e, c: fullCtx(e, { action: 'page' }) }; }, 'retained page: has_more=true without next_offset');
probe('P22b', 'REJECT', 'fhir_result', () => { const e = clinical('fhir_result'); e.data.next_offset = 2; e.pagination.has_more = false; return { e, c: fullCtx(e, { action: 'page' }) }; }, 'retained page: next_offset with has_more=false');
probe('P22c', 'REJECT', 'fhir_result', () => { const e = clinical('fhir_result'); e.data.next_offset = 0; e.pagination.has_more = true; return { e, c: fullCtx(e, { action: 'page' }) }; }, 'retained page: next_offset=0 (no progress)');
probe('P41', 'REJECT', 'fhir_read', () => { const e = clinical('fhir_read'); e.pagination.has_more = true; e.pagination.next_cursor = 'cur_x'; e.coverage.state = 'partial'; e.coverage.query_exhausted = false; return { e, c: ctx(e) }; }, 'read with a continuation cursor');
probe('P54', 'REJECT', 'fhir_search', () => { const e = clinical(); e.pagination.requested_page_size = 1; return { e, c: fullCtx(e) }; }, 'returned_matches 2 exceeds requested_page_size 1');
probe('P53', 'REJECT', 'fhir_result', () => { const e = inspection(); e.coverage.reasons.push('NON_CONTINUABLE_UPSTREAM_LINK'); return { e, c: fullCtx(e, { action: 'inspect' }) }; }, 'inspection: upstream_pages_remain=true while NON_CONTINUABLE reason present');
probe('P40', 'REJECT', 'fhir_search', () => { const e = clinical(); e.coverage.pages_observed = 0; return { e, c: fullCtx(e) }; }, 'search delivered records with pages_observed=0');
probe('P69', 'REJECT', 'fhir_capabilities', () => { const e = metadata('schema'); e.data.next_offset = 1; e.data.total_elements = 2; e.coverage.state = 'partial'; return { e, c: ctx(e, { topic: 'schema' }) }; }, 'schema page with next_offset but query_exhausted=true');

// Sort / evidence label contradictions
probe('P23', 'REJECT', 'fhir_search', () => { const e = clinical(); e.coverage.sort = { requested: ['-date'], effective: ['-date'], evidence: 'observed_supported', order: 'verified_by_adapter' }; return { e, c: fullCtx(e) }; }, 'verified_by_adapter sort while ORDER_UNVERIFIED warning still present');
probe('P24', 'REJECT', 'fhir_search', () => { const e = clinical(); e.coverage.constraints[1].execution = 'tested_adapter'; e.coverage.constraints[1].evidence_ref = 'proof-v1'; return { e, c: fullCtx(e) }; }, 'tested_adapter constraint disclosed where the trusted proof says unknown (S6: a declared label alone is not the defect)');
probe('P25', 'REJECT', 'fhir_search', () => { const e = clinical(); e.coverage.constraints[2].evidence_ref = 'proof-v1'; return { e, c: fullCtx(e) }; }, 'evidence_ref on an unknown-execution constraint');
// S6: trusted sort proof and the mixed-proof evidence kind.
const verifiedSortPage = (e: Fixture) => { e.coverage.sort = { requested: ['-date'], effective: ['-date'], evidence: 'observed_supported', order: 'verified_by_adapter' }; e.warnings = e.warnings.filter((w: { code: string }) => w.code !== 'ORDER_UNVERIFIED'); };
probe('S6-01', 'ACCEPT', 'fhir_search', () => { const e = clinical(); verifiedSortPage(e); return { e, c: fullCtx(e, { query: { ...query(), sortProof: verifiedSort } }) }; }, 'verified sort backed by the trusted sort proof, filters still unproved');
probe('S6-02', 'REJECT', 'fhir_search', () => { const e = clinical(); verifiedSortPage(e); return { e, c: fullCtx(e) }; }, 'verified sort (warning removed) while the trusted sort proof says requested_unverified');
probe('S6-03', 'REJECT', 'fhir_page', () => { const e = clinical('fhir_page'); delete e.coverage.constraints; e.coverage.constraints_on_first_page = true; e.coverage.sort = { effective: ['-date'], evidence: 'observed_supported', order: 'verified_by_adapter' }; e.warnings = e.warnings.filter((w: { code: string }) => w.code !== 'ORDER_UNVERIFIED'); return { e, c: fullCtx(e, { query: { ...query(), fullEvidenceRequired: false } }) }; }, 'shorthand page upgrades the sort to verified_by_adapter without a trusted sort proof (S5 review finding 2d)');
test('review probe S6-04: a requested sort without a trusted sort proof in the context is a missing context, not a cross-field verdict', () => {
  const e = clinical();
  assert.deepEqual(validateCrossField02('fhir_search', e, fullCtx(e, { query: { ...query(), sortProof: undefined } }) as ValidationContext02), { ok: false, reason: 'VALIDATION_CONTEXT_REQUIRED' });
  const control = clinical();
  assert.deepEqual(validateCrossField02('fhir_search', control, fullCtx(control) as ValidationContext02), { ok: true });
});
const mixedProof = () => [{ execution: 'gateway_enforced' }, { execution: 'tested_adapter', evidence_ref: 'proof-v1' }, { execution: 'unknown' }] as NonNullable<NonNullable<ValidationContext02['query']>['constraintProof']>;
const fullProof = () => [{ execution: 'gateway_enforced' }, { execution: 'tested_adapter', evidence_ref: 'proof-v1' }, { execution: 'tested_adapter', evidence_ref: 'proof-v1' }] as NonNullable<NonNullable<ValidationContext02['query']>['constraintProof']>;
probe('S6-05', 'ACCEPT', 'fhir_search', () => { const e = clinical(); e.coverage.constraints[1].execution = 'tested_adapter'; e.coverage.constraints[1].evidence_ref = 'proof-v1'; return { e, c: fullCtx(e, { query: { ...query(), constraintProof: mixedProof() } }) }; }, 'mixed proof: a tested_adapter constraint under the declared kind when the trusted proof is itself mixed (S6 option A)');
probe('S6-06', 'REJECT', 'fhir_search', () => { const e = clinical(); for (const i of [1, 2]) { e.coverage.constraints[i].execution = 'tested_adapter'; e.coverage.constraints[i].evidence_ref = 'proof-v1'; } return { e, c: fullCtx(e, { query: { ...query(), constraintProof: fullProof() } }) }; }, 'declared kind on a fully proved non-empty set (must be tested_adapter)');
// S6 review: the sticky unverified-continuation flag and a sort claim outside any query chain.
const shorthandPage = (e: Fixture) => { delete e.coverage.constraints; e.coverage.constraints_on_first_page = true; e.coverage.sort = { effective: null, evidence: 'unknown', order: 'requested_unverified' }; };
probe('S6-08', 'REJECT', 'fhir_page', () => { const e = clinical('fhir_page'); shorthandPage(e); e.coverage.query_evidence = 'tested_adapter'; e.coverage.reasons = e.coverage.reasons.filter((r: string) => r !== 'FILTER_EXECUTION_UNVERIFIED'); e.warnings = e.warnings.filter((w: { code: string }) => w.code !== 'FILTER_EXECUTION_UNVERIFIED'); return { e, c: fullCtx(e, { query: { ...query(), constraintProof: fullProof(), fullEvidenceRequired: false, continuationUnverified: true } }) }; }, 'a later page relabels a chain whose continuation could not be verified (flag set in the trusted context)');
probe('S6-09', 'ACCEPT', 'fhir_page', () => { const e = clinical('fhir_page'); shorthandPage(e); e.coverage.query_evidence = 'unverified_continuation'; e.coverage.state = 'partial'; e.coverage.query_exhausted = null; e.pagination.has_more = null; e.coverage.reasons.push('CONTINUATION_QUERY_UNVERIFIED'); e.warnings.push({ code: 'CONTINUATION_QUERY_UNVERIFIED', message: WARNING_MESSAGES.CONTINUATION_QUERY_UNVERIFIED! }); return { e, c: fullCtx(e, { query: { ...query(), fullEvidenceRequired: false, continuationUnverified: true } }) }; }, 'the honest unverified continuation under the flag');
test('review probe S6-10: a sort claim on an envelope outside any query chain needs the missing context', () => {
  const e = inspection();
  delete e.coverage.constraints; delete e.coverage.query_digest;
  e.coverage.sort = { requested: ['-date'], effective: ['-date'], evidence: 'observed_supported', order: 'verified_by_adapter' };
  e.warnings = e.warnings.filter((w: { code: string }) => w.code !== 'ORDER_UNVERIFIED');
  assert.deepEqual(validateCrossField02('fhir_result', e, contextFor(e, { action: 'inspect', offset: 0, limit: 20, query: undefined }) as ValidationContext02), { ok: false, reason: 'VALIDATION_CONTEXT_REQUIRED' });
  const control = inspection();
  delete control.coverage.constraints; delete control.coverage.query_digest; delete control.coverage.sort;
  control.warnings = control.warnings.filter((w: { code: string }) => w.code !== 'ORDER_UNVERIFIED');
  assert.deepEqual(validateCrossField02('fhir_result', control, contextFor(control, { action: 'inspect', offset: 0, limit: 20, query: undefined }) as ValidationContext02), { ok: true });
});
probe('S6-07', 'REJECT', 'fhir_search', () => { const e = clinical(); e.coverage.constraints[1].execution = 'tested_adapter'; e.coverage.constraints[1].evidence_ref = 'proof-v1'; e.coverage.state = 'complete_for_query'; e.coverage.query_evidence = 'tested_adapter'; e.coverage.reasons = e.coverage.reasons.filter((r: string) => r !== 'FILTER_EXECUTION_UNVERIFIED'); e.warnings = e.warnings.filter((w: { code: string }) => w.code !== 'FILTER_EXECUTION_UNVERIFIED'); return { e, c: fullCtx(e, { query: { ...query(), constraintProof: mixedProof() } }) }; }, 'a partially proved query claims complete_for_query under the tested_adapter kind');

// Metadata
probe('P29', 'ACCEPT', 'fhir_capabilities', () => { const e = metadata('server'); e.data.resource_count = 146; e.data.next_cursor = 'cur_tail'; e.coverage.state = 'partial'; e.coverage.query_exhausted = false; e.coverage.reasons.push('CAPABILITY_SUMMARY_LIMIT');
  const m = invocations.get(e)!.metadata!; invocations.set(e, { ...invocations.get(e), metadata: { ...m, total: 146, limit: 1, rows: Array.from({length:146},()=>m.rows[0]), nextCursor: 'cur_tail', nextOffset: 1 } }); return { e, c: ctx(e, { topic: 'server' }) }; }, 'FALSE REFUSAL check: source advertises 146 types, bounded rows=1 (spec: resource_count counts advertisements)');
probe('P34', 'REJECT', 'fhir_capabilities', () => { const e = metadata('support'); e.warnings = [{ code: 'NO_MATCHES', message: WARNING_MESSAGES.UNINTERPRETED_MODIFIER }]; return { e, c: ctx(e, { topic: 'support' }) }; }, 'metadata success carrying clinical NO_MATCHES warning');
probe('P33', 'REJECT', 'fhir_capabilities', () => { const e = metadata('support'); e.data.next_cursor = 'res_looks_like_result'; e.coverage.state = 'partial'; e.coverage.query_exhausted = false; return { e, c: ctx(e, { topic: 'support' }) }; }, 'metadata continuation uses a res_ handle');

// Final gate text
probe('P57', 'REJECT', 'fhir_search', () => { const e = clinical(); return { e, c: fullCtx(e, { deliveryProfile: 'structured-evidence-v1', text: 'hello' }) }; }, 'structured profile with unlabelled arbitrary text');
probe('P57b', 'REJECT', 'fhir_search', () => { const e = clinical(); return { e, c: fullCtx(e, { deliveryProfile: 'structured-evidence-v1', text: '' }) }; }, 'structured profile with empty text');
probe('P30', 'ACCEPT', 'fhir_capabilities', () => { const e = metadata('search_parameter'); e.data.search_parameters[0].description = 'Clinical date'; e.transform.delivery_profile = 'full-text-v1';
  let text = ''; for (let i = 0; i < 5; i++) { text = evidenceRender(e as any).text; e.budget.bytes_returned = Buffer.byteLength(JSON.stringify(resultFor(e, 'modern', 'full-text-v1', text))); }
  const c = freeze({ ...invocations.get(e), metadata: { ...invocations.get(e)!.metadata!, rows: structuredClone(e.data.search_parameters) }, binding: binding(), effectiveByteLimit: 24576, formatSupplied: false, resourceType: 'Observation', era: 'modern', deliveryProfile: 'full-text-v1', renderedText: text, result: resultFor(e, 'modern', 'full-text-v1', text), serverIdentity: { ...identity }, topic: 'search_parameter' });
  return { e, c }; }, 'FALSE REFUSAL check: renderer whole-result fallback of metadata containing U+2028');
probe('P31', 'REJECT', 'fhir_result', () => { const e = inspection(); e.data.resource_count = 30; e.data.omissions[0].resource_index = 20; e.data.next_offset = 21; return { e, c: fullCtx(e, { action: 'inspect', offset: 20 }) }; }, 'INTERPRETATION check: inspection offset=20 row indexed to the retained slice (20)');

// Context API: accessor properties pass the "deep frozen" check
probe('C1', 'REJECT', 'fhir_read', () => { const e = clinical('fhir_read'); const good = ctx(e) as any; let n = 0;
  const c = Object.freeze({ ...good, get renderedText() { n++; return good.renderedText; } });
  return { e, c }; }, 'context with an accessor (getter) property passes the frozen check');


const nm = { code: 'NO_MATCHES', message: WARNING_MESSAGES.NO_MATCHES };
probe('P70', 'REJECT', 'fhir_search', () => { const e = clinical(); e.warnings.push(nm); return { e, c: fullCtx(e) }; }, 'NO_MATCHES while 2 records delivered');
probe('P71', 'REJECT', 'fhir_result', () => { const e = inspection(); e.warnings.push(nm); return { e, c: fullCtx(e, { action: 'inspect' }) }; }, 'NO_MATCHES on retained inspection');
probe('P72', 'REJECT', 'fhir_search', () => { const e = clinical(); e.data.resources = []; e.provenance = []; e.pagination = { has_more: true, next_cursor: 'cur_x', returned_matches: 0, returned_includes: 0 };
  e.coverage.state = 'partial'; e.coverage.query_exhausted = false; e.warnings.push(nm); return { e, c: fullCtx(e) }; }, 'NO_MATCHES on an intermediate empty page with a next cursor');
probe('P73', 'REJECT', 'fhir_search', () => { const q = { ...query(), orderedPairs: [query().orderedPairs[0]!], sort: [] };
  const e = clinical(); e.data.resources = []; e.provenance = []; e.pagination.returned_matches = 0; e.coverage.constraints = [e.coverage.constraints[0]];
  delete e.coverage.sort; e.warnings = [nm]; e.coverage.query_digest = digest(q); return { e, c: ctx(e, { query: q }) }; }, 'NO_MATCHES on an unfiltered (confinement-only) search');
probe('P74', 'REJECT', 'fhir_search', () => { const e = clinical(); e.warnings[0].message = 'Results are sorted newest first.'; return { e, c: fullCtx(e) }; }, 'ORDER_UNVERIFIED with a drifted, contradictory message (G-16)');
probe('P75', 'REJECT', 'fhir_search', () => { const e = clinical(); e.warnings.push({ code: 'MADE_UP_WARNING', message: 'free text' }); return { e, c: fullCtx(e) }; }, 'warning code absent from WARNING_MESSAGES');

}

test('S51-11 inspection at offset 20 uses response-slice indices', () => {
  const e = inspection(); e.data.resource_count = 30; e.data.next_offset = 21;
  assertValid('fhir_result', e, contextFor(e, { offset: 20 }));
});

test('S51-12 CL-3 mutable trusted query refuses at the semantic gate', () => {
  const e = clinical(), c = contextFor(e);
  const q = query();
  assert.deepEqual(validateCrossField02('fhir_search', e, Object.freeze({ ...c, query: q })), { ok: false, reason: 'VALIDATION_CONTEXT_MISMATCH' });
});
test('S51-12 CL-4 structured profile equality is independently enforced', () => {
  const e = clinical(), c = contextFor(e, { deliveryProfile: 'structured-evidence-v1' });
  const different = { ...e, request_id: 'req_else' };
  const result = { ...c.result, structuredContent: different };
  assert.deepEqual(validateDeliverable02('fhir_search', e, freeze({ ...c, result })), { ok: false, reason: 'VALIDATION_CONTEXT_MISMATCH' });
});
for (const field of ['sourceRevision', 'policyRevision', 'contextHandle'] as const) test(`S51-12 CL-5 trusted binding ${field}`, () => {
  const e = clinical();
  if (field === 'sourceRevision') e.source.capability_revision = 'foreign';
  if (field === 'policyRevision') e.context.policy_revision = 'foreign';
  if (field === 'contextHandle') e.context.handle = 'ctx_foreign';
  assert.deepEqual(validateCrossField02('fhir_search', e, contextFor(e)), { ok: false, reason: 'VALIDATION_CONTEXT_MISMATCH' });
});
test('S51-12 CL-6 uniform wrong resource type against trusted query', () => {
  const e = clinical(); for (const r of e.data.resources) r.resourceType = 'Condition';
  assert.deepEqual(validateCrossField02('fhir_search', e, contextFor(e)), { ok: false, reason: 'VALIDATION_CONTEXT_MISMATCH' });
});
test('S51-12 CL-7 isError false with internally exact bytes', () => {
  const e = error('fhir_read'); let result: Fixture = {};
  for (let i = 0; i < 5; i++) {
    result = { ...resultFor(e, 'modern', 'full-text-v1'), isError: false };
    e.budget.bytes_returned = Buffer.byteLength(JSON.stringify(result));
  }
  result = { ...resultFor(e, 'modern', 'full-text-v1'), isError: false };
  const c = contextFor(e, {}, false);
  assert.equal(Buffer.byteLength(JSON.stringify(result)), e.budget.bytes_returned);
  assert.deepEqual(validateDeliverable02('fhir_read', e, freeze({ ...c, result, renderedText: result.content[0].text }) as ValidationContext02), { ok: false, reason: 'VALIDATION_CONTEXT_MISMATCH' });
});
for (const char of ['\u2028', '\u2029', '\u0085']) test(`S51-04 renderer fallback escaping ${char.charCodeAt(0)}`, () => {
  const e = metadata('search_parameter'); e.data.search_parameters[0].description = `Clinical${char}date`;
  let text = '';
  for (let i = 0; i < 5; i++) { text = evidenceRender(e as GatewayEnvelope).text; e.budget.bytes_returned = Buffer.byteLength(JSON.stringify(resultFor(e, 'modern', 'full-text-v1', text))); }
  invocations.set(e, { ...invocations.get(e), metadata: { ...invocations.get(e)!.metadata!, rows: structuredClone(e.data.search_parameters) } });
  const c = contextFor(e, {}, false), result = resultFor(e, 'modern', 'full-text-v1', text);
  assertValid('fhir_capabilities', e, freeze({ ...c, result, renderedText: text }) as ValidationContext02);
});
for (const sort of [[], ['-date']]) test(`digest equivalence: ${sort}`, () => {
  const q = { ...query(), sort };
  assert.equal(digest(q), queryDigest({ sourceRevision: q.sourceRevision, policyRevision: q.policyRevision, contextHandle: q.contextHandle, resourceType: q.resourceType, constraints: q.orderedPairs, ...(sort.length ? { sort } : {}) }));
});

for (const key of ['binding', 'effectiveByteLimit', 'formatSupplied', 'readTarget'] as const) test(`S51 trusted read context requires ${key}`, () => {
  const e = clinical('fhir_read'), c: Fixture = { ...contextFor(e) }; delete c[key];
  assert.deepEqual(validateDeliverable02('fhir_read', e, freeze(c) as ValidationContext02), { ok: false, reason: 'VALIDATION_CONTEXT_REQUIRED' });
});
test('S51 trusted byte allowance cannot be inflated on the wire', () => {
  const e = clinical('fhir_read');
  assert.deepEqual(validateDeliverable02('fhir_read', e, contextFor(e, { effectiveByteLimit: 4096 })), { ok: false, reason: 'INVALID_FINAL_BYTES' });
});
test('S51 server advertisements exceed 100 while summary rows stay bounded', () => {
  const e = metadata('server'); e.data.resource_count = 146; e.data.next_cursor = 'cur_tail'; e.coverage.state = 'partial'; e.coverage.query_exhausted = false; e.coverage.reasons.push('CAPABILITY_SUMMARY_LIMIT');
  const m = invocations.get(e)!.metadata!; invocations.set(e, { ...invocations.get(e), metadata: { ...m, total: 146, limit: 1, rows: Array.from({length:146},()=>m.rows[0]), nextCursor: 'cur_tail', nextOffset: 1 } });
  const rows = Array.from({ length: 146 }, (_, i) => ({ type: `Resource${i}`, resource_class: 'patient', implemented_interactions: ['read'] }));
  e.data.resources = rows.slice(0,50); invocations.set(e, { ...invocations.get(e), metadata: { ...m, total:146, rows, limit:50, deliveredCount:50, nextCursor:'cur_tail', nextOffset:50 } });
  assertValid('fhir_capabilities', e, contextFor(e));
});
test('S51 changed evidence cannot use shorthand', () => {
  const e = clinical('fhir_page'); delete e.coverage.constraints; delete e.coverage.sort.requested; e.coverage.constraints_on_first_page = true;
  assert.deepEqual(validateCrossField02('fhir_page', e, contextFor(e, { query: { ...query(), fullEvidenceRequired: true } })), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
});
test('S51 shorthand completeness needs independent execution proof', () => {
  const make = () => { const e = clinical('fhir_page'); delete e.coverage.constraints; delete e.coverage.sort.requested; e.coverage.constraints_on_first_page = true;
    e.coverage.state = 'complete_for_query'; e.coverage.query_evidence = 'tested_adapter'; e.coverage.reasons = [caveat]; e.warnings = e.warnings.filter((w: any) => w.code !== 'FILTER_EXECUTION_UNVERIFIED'); return e; };
  const unproved = make();
  assert.deepEqual(validateCrossField02('fhir_page', unproved, contextFor(unproved)), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
  const proved = make();
  assertValid('fhir_page', proved, contextFor(proved, { query: { ...query(), constraintProof: [{ execution: 'gateway_enforced' }, { execution: 'tested_adapter', evidence_ref: 'proof-v1' }, { execution: 'tested_adapter', evidence_ref: 'proof-v1' }] } }));
});
test('S51 NO_MATCHES requires zero chain-wide delivery and accepts the catalog literal', () => {
  const make = () => { const e = clinical(); e.data.resources = []; e.provenance = []; e.pagination.returned_matches = 0;
    e.warnings.push({ code: 'NO_MATCHES', message: WARNING_MESSAGES.NO_MATCHES + NO_MATCHES_UNVERIFIED_SUFFIX }); return e; };
  const nonzero = make();
  assert.deepEqual(validateCrossField02('fhir_search', nonzero, contextFor(nonzero, { chainDeliveredCount: 2 })), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
  const zero = make(); assertValid('fhir_search', zero, contextFor(zero, { chainDeliveredCount: 0 }));
});
for (const era of ['modern', 'legacy'] as const) for (const verified of [false, true]) {
  test(`S53 NO_MATCHES gate accepts only the required canonical variant ${era}/${verified}`, () => {
    const make = () => {
      const e = clinical(); e.data.resources = []; e.provenance = []; e.pagination.returned_matches = 0;
      if (verified) {
        e.coverage.reasons = [caveat]; e.coverage.query_evidence = 'exact_id_and_subject_linkage';
        e.coverage.constraints.forEach((p: Fixture) => { p.execution = 'gateway_enforced'; });
      }
      return e;
    };
    const message = WARNING_MESSAGES.NO_MATCHES + (verified ? '' : NO_MATCHES_UNVERIFIED_SUFFIX);
    const valid = make(); valid.warnings.push({ code: 'NO_MATCHES', message });
    assertValid('fhir_search', valid, contextFor(valid, { era, chainDeliveredCount: 0, ...(verified ? { query: { ...query(), constraintProof: [{ execution: 'gateway_enforced' }, { execution: 'gateway_enforced' }, { execution: 'gateway_enforced' }] } } : {}) }));
    for (const drift of [message + ' ', message + NO_MATCHES_UNVERIFIED_SUFFIX,
      WARNING_MESSAGES.NO_MATCHES + (verified ? NO_MATCHES_UNVERIFIED_SUFFIX : '')]) {
      const invalid = make(); invalid.warnings.push({ code: 'NO_MATCHES', message: drift });
      assert.deepEqual(validateCrossField02('fhir_search', invalid, contextFor(invalid, { era, chainDeliveredCount: 0 })), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
    }
  });
}
test('S51 partial oversize read is accepted; pre-existing complete claim is refused', () => {
  const make = () => { const e = clinical('fhir_read'); e.data = { resources: [], manifest: { reason: 'RESOURCE_EXCEEDS_INLINE_BUDGET', action: 'Repeat the query with a bounded field selection.' } };
    e.provenance = []; e.pagination.returned_matches = 0; e.coverage.reasons.push('OVERSIZED_RESOURCE'); e.budget.limit_reached = true; return e; };
  const complete = make(); assert.deepEqual(validateCrossField02('fhir_read', complete, contextFor(complete)), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
  const partial = make(); partial.coverage.state = 'partial'; assertValid('fhir_read', partial, contextFor(partial));
});
test('S51 semantic corruption after the trusted capture reports its rule first', () => {
  const original = clinical(), c = contextFor(original), changed = structuredClone(original);
  changed.pagination.returned_matches = 1;
  assert.deepEqual(validateDeliverable02('fhir_search', changed, c), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
  const bytes = structuredClone(original); bytes.budget.bytes_returned--;
  assert.deepEqual(validateDeliverable02('fhir_search', bytes, c), { ok: false, reason: 'INVALID_FINAL_BYTES' });
  const snapshotOnly = structuredClone(original); snapshotOnly.request_id = 'req_else';
  assert.deepEqual(validateDeliverable02('fhir_search', snapshotOnly, c), { ok: false, reason: 'VALIDATION_CONTEXT_MISMATCH' });
});

test('S51 error context binding applies even when invocation carries a query', () => {
  const e = error('fhir_search'); e.context.handle = 'ctx_other';
  assert.deepEqual(validateCrossField02('fhir_search', e, contextFor(e, { query: query() })), { ok: false, reason: 'VALIDATION_CONTEXT_MISMATCH' });
});

test('S51 NO_MATCHES refuses unknown continuation even without a warning', () => {
  const e = clinical(); e.data.resources = []; e.provenance = []; e.pagination.returned_matches = 0;
  e.coverage.query_evidence = 'unverified_continuation'; e.coverage.reasons = [caveat];
  e.warnings.push({ code: 'NO_MATCHES', message: WARNING_MESSAGES.NO_MATCHES });
  assert.deepEqual(validateCrossField02('fhir_search', e, contextFor(e, { chainDeliveredCount: 0 })), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
});
test('S51 inspection continuation is required while retained rows remain', () => {
  const e = inspection(); delete e.data.next_offset;
  assert.deepEqual(validateCrossField02('fhir_result', e, contextFor(e)), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
});

test('S51 explicit selection is independent of compact recipe selection', () => {
  const e = clinical(); e.transform.format = 'compact'; e.transform.requested_format = 'compact';
  e.transform.projected = true; e.transform.omitted_fields = ['/identifier'];
  assertValid('fhir_search', e, contextFor(e, { formatSupplied: true, requestedFormat: 'compact', selectedFields: ['status'] }));
});
test('S51 structural compact views do not claim a clinical recipe', () => {
  const e = clinical(); e.transform.format = 'compact'; e.transform.requested_format = 'compact'; e.transform.projected = true;
  e.transform.structural_resource_indices = [0, 1]; e.warnings.push({ code: 'UNINTERPRETED_MODIFIER', message: WARNING_MESSAGES.UNINTERPRETED_MODIFIER });
  assertValid('fhir_search', e, contextFor(e, { formatSupplied: true, requestedFormat: 'compact' }));
});

test('S51 explicit format presence is bound independently of valid wire enums', () => {
  const unrequested = clinical(); unrequested.transform.requested_format = 'fhir';
  assert.deepEqual(validateCrossField02('fhir_search', unrequested, contextFor(unrequested)), { ok: false, reason: 'VALIDATION_CONTEXT_MISMATCH' });
  const missing = clinical();
  assert.deepEqual(validateCrossField02('fhir_search', missing, contextFor(missing, { formatSupplied: true, requestedFormat: 'fhir' })), { ok: false, reason: 'VALIDATION_CONTEXT_MISMATCH' });
});

test('S51 actual delivery profile is independently bound to a labelled capture', () => {
  const e = clinical(); // wire says full-text; trusted call selected structured.
  for (let i = 0; i < 5; i++) e.budget.bytes_returned = Buffer.byteLength(JSON.stringify(resultFor(e, 'modern', 'structured-evidence-v1')));
  const result = resultFor(e, 'modern', 'structured-evidence-v1');
  const c = freeze({ era: 'modern', deliveryProfile: 'structured-evidence-v1', renderedText: result.content[0].text,
    result, serverIdentity: { ...identity }, effectiveByteLimit: 24576, binding: binding(), formatSupplied: false, requestedPageSize: 20, query: query() }) as unknown as ValidationContext02;
  assert.deepEqual(validateDeliverable02('fhir_search', e, c), { ok: false, reason: 'VALIDATION_CONTEXT_MISMATCH' });
});

for (const topic of ['server','resource','context','schema','search_parameter','support'] as const) {
  test(`S56 metadata closed reasons and standing declaration ${topic}`, () => {
    const good = metadata(topic);
    assertValid('fhir_capabilities', good, contextFor(good));
    const bad = metadata(topic); bad.coverage.reasons.push('MORE_METADATA_ROWS');
    assert.deepEqual(validateCrossField02('fhir_capabilities', bad, contextFor(bad)), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
    const missing = metadata(topic); missing.coverage.reasons = [];
    assert.deepEqual(validateCrossField02('fhir_capabilities', missing, contextFor(missing)), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
  });
}

for (const topic of ['server','resource','context','schema','search_parameter','support'] as const) {
  for (const reason of ['DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION','MORE_PAGES','CAPABILITY_SUMMARY_LIMIT','R4_BASE_DEFINITION_NOT_ENDPOINT_PROFILE_VALIDATION','MORE_DEFINITION_ELEMENTS']) {
    test(`S56 R08 topic reasons ${topic} ${reason}`,()=>{
      const e=metadata(topic);if (!e.coverage.reasons.includes(reason)) e.coverage.reasons.push(reason);
      const allowed=topic==='schema' ? ['R4_BASE_DEFINITION_NOT_ENDPOINT_PROFILE_VALIDATION','MORE_DEFINITION_ELEMENTS']
        : topic==='server' ? ['DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION','CAPABILITY_SUMMARY_LIMIT']
        : ['search_parameter','support'].includes(topic) ? ['DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION','MORE_PAGES'] : ['DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION'];
      assert.deepEqual(validateCrossField02('fhir_capabilities',e,contextFor(e)),(allowed.includes(reason) && !['MORE_PAGES','CAPABILITY_SUMMARY_LIMIT','MORE_DEFINITION_ELEMENTS'].includes(reason))?{ok:true}:{ok:false,reason:'INVALID_CROSS_FIELDS'});
    });
  }
}
