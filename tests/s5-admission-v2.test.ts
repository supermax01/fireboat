import { SERVER_IDENTITY } from '../packages/core/src/identity.js';
// S5.2 private helpers only. No public candidate execution/configuration seam.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as contracts from '../packages/core/src/contracts.js';
import * as core from '../packages/core/src/index.js';
import { FhirGateway } from '../packages/core/src/index.js';
import { parseFhirJson } from '../packages/core/src/decimal.js';
import { evidenceRender } from '../packages/core/src/delivery.js';
import type { DeliveryContext, GatewayEnvelope, GatewayEnvelope02, ToolName, ValidationContext02 } from '../packages/core/src/contracts.js';

// Type-only reflection keeps the test seam out of production exports/config.
type Candidate = { admitV2: FhirGateway['admitV2']; envelopeV2: FhirGateway['envelopeV2'];
  errorV2: FhirGateway['errorV2']; minimalV2: FhirGateway['minimalV2']; makeEmergencyEnvelopeV2: FhirGateway['makeEmergencyEnvelopeV2'] };
const candidate = (gateway: FhirGateway) => gateway as unknown as Candidate;
const config = { mode: 'synthetic', source: { alias: 'local', baseUrl: 'http://127.0.0.1:9/fhir' },
  patientId: 'synthetic-a', contextId: 'ctx_test' } as const;
const gateway = () => new FhirGateway(config);
const invalid = (fn: () => unknown) => assert.throws(fn, (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENTS');
const topics = ['server', 'resource', 'context', 'schema', 'search_parameter', 'support'] as const;
const args = {
  fhir_capabilities: {}, fhir_search: { resource_type: 'Observation' },
  fhir_read: { resource_type: 'Observation', id: 'synthetic-o1' },
  fhir_page: { cursor: 'cur_test' }, fhir_result: { handle: 'res_test' },
};

for (const topic of topics) test(`v2 admission: capabilities ${topic} valid first call`, () => {
  const g = gateway();
  try {
    const input = { topic, ...(topic === 'search_parameter' || topic === 'resource' || topic === 'schema' ? { resource_type: 'Observation' } : {}),
      ...(topic === 'schema' ? { path: 'Observation.code', offset: 2 } : {}),
      ...(topic === 'search_parameter' ? { name: 'code' } : {}) };
    const a = candidate(g).admitV2('fhir_capabilities', input);
    assert.equal(a.input.topic, topic);
    assert.equal(a.format, 'fhir');
    if (topic === 'search_parameter') assert.equal(candidate(g).admitV2('fhir_capabilities', { topic, resource_type: 'Observation', query: 'literal.*' }).input.query, 'literal.*');
  } finally { g.close(); }
});

for (const tool of contracts.TOOL_NAMES) test(`v2 admission: ${tool} strict keys, defaults and formats`, () => {
  const g = gateway(), c = candidate(g);
  try {
    const a = c.admitV2(tool, args[tool]);
    assert.equal(a.format, 'fhir'); assert.equal(Object.hasOwn(a, 'requestedFormat'), false);
    assert.equal(Object.hasOwn(a.input.output ?? {}, 'format'), false);
    for (const format of ['fhir', 'compact'] as const) {
      const explicit = c.admitV2(tool, { ...args[tool], output: { format } });
      assert.equal(explicit.requestedFormat, format); assert.equal(explicit.format, format);
    }
    for (const output of [{ fields: [] }, { fields: ['__proto__'] }, { format: 'summary' }, { max_bytes: 4095 }, { surprise: true }]) {
      invalid(() => c.admitV2(tool, { ...args[tool], output }));
    }
    invalid(() => c.admitV2(tool, { ...args[tool], arbitrary_url: 'http://example.invalid' }));
    invalid(() => c.admitV2(tool, null));
    invalid(() => c.admitV2(tool, []));
  } finally { g.close(); }
});

for (const topic of topics) test(`v2 admission: capabilities ${topic} rejected combinations`, () => {
  const g = gateway(), c = candidate(g);
  const base = { topic, ...(topic === 'search_parameter' ? { resource_type: 'Observation' } : {}) };
  try {
    invalid(() => c.admitV2('fhir_capabilities', { ...base, name: 'code', query: 'code' }));
    if (topic !== 'schema') for (const extra of [{ path: 'Observation' }, { offset: 1 }]) invalid(() => c.admitV2('fhir_capabilities', { ...base, ...extra }));
    if (topic !== 'search_parameter') for (const extra of [{ name: 'code' }, { query: 'code' }]) invalid(() => c.admitV2('fhir_capabilities', { ...base, ...extra }));
    if (topic !== 'search_parameter' && topic !== 'support' && topic !== 'server') invalid(() => c.admitV2('fhir_capabilities', { ...base, cursor: 'cur_test' }));
    if (topic === 'search_parameter') invalid(() => c.admitV2('fhir_capabilities', { topic }));
  } finally { g.close(); }
});

for (const topic of ['server', 'search_parameter', 'support'] as const) test(`v2 continuation ${topic}: original own keys survive defaults`, () => {
  const g = gateway(), c = candidate(g);
  try {
    const a = c.admitV2('fhir_capabilities', { topic, cursor: 'cur_test', context_handle: 'ctx_test', limit: 3, output: { format: 'fhir' } });
    assert.equal(a.input.path, ''); assert.equal(a.input.offset, 0);
    assert.equal(a.ownKeys.includes('path'), false); assert.equal(a.ownKeys.includes('offset'), false);
    assert.equal(Object.isFrozen(a.ownKeys), true);
    for (const extra of [{ source: 'local' }, { resource_type: 'Observation' }, { name: 'code' }, { query: 'code' }, { path: '' }, { offset: 0 }]) {
      invalid(() => c.admitV2('fhir_capabilities', { topic, cursor: 'cur_test', ...extra }));
    }
    // Own-key presence includes non-enumerable data properties in direct calls.
    for (const key of ['path', 'offset']) {
      const raw = Object.defineProperty({ topic, cursor: 'cur_test' }, key, { value: key === 'path' ? '' : 0 });
      invalid(() => c.admitV2('fhir_capabilities', raw));
    }
  } finally { g.close(); }
});

test('v2 retained actions: identical fields accepted, conflicts and inspect fields refused; selection independent of format', () => {
  const g = gateway(), c = candidate(g);
  try {
    for (const action of ['project', 'page'] as const) for (const format of [undefined, 'fhir', 'compact'] as const) {
      for (const shape of [{ fields: ['code'] }, { output: { fields: ['code'] } }, { fields: ['code'], output: { fields: ['code'] } }]) {
        const a = c.admitV2('fhir_result', { handle: 'res_test', action, ...shape, output: { ...shape.output, ...(format ? { format } : {}) } });
        assert.deepEqual(a.fields, ['code']); assert.equal(a.format, format ?? 'fhir');
      }
      invalid(() => c.admitV2('fhir_result', { handle: 'res_test', action, fields: ['code', 'status'], output: { fields: ['status', 'code'] } }));
    }
    for (const action of [undefined, 'inspect']) for (const shape of [{ fields: ['code'] }, { output: { fields: ['code'] } }]) {
      invalid(() => c.admitV2('fhir_result', { handle: 'res_test', ...(action ? { action } : {}), ...shape }));
    }
    for (const tool of ['fhir_search', 'fhir_read', 'fhir_page'] as const) {
      const a = c.admitV2(tool, { ...args[tool], output: { fields: ['code'] } });
      assert.deepEqual(a.fields, ['code']); assert.equal(a.format, 'fhir'); assert.equal(a.requestedFormat, undefined);
    }
  } finally { g.close(); }
});

test('v2 admission refuses accessors/limits before parsing; safe messages do not echo arguments', () => {
  const g = gateway(), c = candidate(g); let getterCalls = 0;
  try {
    invalid(() => c.admitV2('fhir_search', Object.defineProperty({}, 'resource_type', { get() { getterCalls++; return 'Observation'; } })));
    assert.equal(getterCalls, 0);
    assert.throws(() => c.admitV2('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'x'.repeat(270000) }] }), (e: unknown) => (e as { code?: string }).code === 'INPUT_LIMIT');
    assert.throws(() => c.admitV2('invented' as ToolName, {}), (e: unknown) => (e as { code?: string }).code === 'UNKNOWN_TOOL');
    assert.throws(() => c.admitV2('fhir_capabilities', { topic: 'secret-selector' }), (e: unknown) => !String(e).includes('secret-selector'));
  } finally { g.close(); }
});

const at = '2026-10-19T12:00:00Z', expires = '2026-10-19T12:05:00Z';
const caveat = 'CLINICAL_RECORD_COMPLETENESS_UNKNOWN';
const query = { resourceType: 'Observation', sourceRevision: 'unknown', policyRevision: 'synthetic-v2', contextHandle: 'ctx_test',
  orderedPairs: [{ name: 'subject', value: 'Patient/synthetic-a' }], sort: [], constraintProof: [{ execution: 'gateway_enforced' as const }] };
const digest = createHash('sha256').update(JSON.stringify({ v: 1, source_revision: query.sourceRevision, policy_revision: query.policyRevision,
  context_handle: query.contextHandle, resource_type: query.resourceType, constraints: query.orderedPairs, sort: query.sort })).digest('hex');
function body(tool: ToolName): Parameters<Candidate['envelopeV2']>[1] {
  const retained = tool === 'fhir_result', read = tool === 'fhir_read';
  return { data: { resources: [{ resourceType: 'Observation', id: 'synthetic-o1', valueQuantity: { value: 7 } }] },
    provenance: [{ resource_index: 0, retrieved_at: at }], pagination: { has_more: false, returned_matches: 1, returned_includes: 0, requested_page_size: 20 },
    coverage: { state: retained ? 'partial' : read ? 'complete_for_query' : 'unknown', scope: retained ? 'retained' : read ? 'resource' : 'page',
      reasons: [caveat, ...(retained ? ['RETAINED_PAGE_IS_NOT_THE_ENTIRE_QUERY'] : [])], authorization_limited: true,
      query_exhausted: retained ? null : true, pages_observed: 1, query_evidence: retained ? 'retained_snapshot' : 'exact_id_and_subject_linkage',
      ...(!read && !retained ? { constraints: [{ ...query.orderedPairs[0]!, source_reported: 'not_checked', execution: 'gateway_enforced' }], query_digest: digest } : {}) } };
}
const classification = { network_confinement: 'literal_loopback', data_classification: 'operator_declared_synthetic_unverified' } as const;
function metadata(topic: typeof topics[number]): Parameters<Candidate['envelopeV2']>[1] {
  const definitions = { package: 'hl7.fhir.r4.core', version: '4.0.1', source_sha256: 'a'.repeat(64) };
  const data = {
    server: { source: 'local', fhir_version: 'unknown', patient_id: config.patientId, snapshot_revision: query.sourceRevision, captured_at: at, expires_at: expires, ...classification, implemented_tools: [...contracts.TOOL_NAMES], resources: [], resource_count: 0,
      definition_limit: 100, workflow: 'recent-labs-v1', support_matrix_revision: 'support-v1', required_resources: ['Patient', 'Observation'], document_support: 'metadata_only' },
    resource: { type: 'Observation', interactions: ['read'], searchParameters: [], resource_class: 'patient', evidence: 'declared', implemented_interactions: ['read'],
      instance_policy: 'patient_bound', compact_recipe: null, limitations: [], support_matrix_revision: 'support-v1', ...classification },
    context: { mode: 'patient-bound', context_handle: 'ctx_test', patient_id: 'synthetic-a', ...classification, support_matrix_revision: 'support-v1' },
    schema: { resource_type: 'Observation', path: '', definition: 'http://hl7.org/fhir/StructureDefinition/Observation', schema: { ...definitions, source_url: 'https://hl7.org/fhir/R4/', definitions: 1 },
      evidence: 'pinned_base_definition', profile_validation: 'not_performed', total_elements: 0, elements: [] },
    search_parameter: { resource_type: 'Observation', search_parameters: [], total_parameters: 0, snapshot_revision: query.sourceRevision, captured_at: at, expires_at: expires, definitions },
    support: { workflow: 'recent-labs-v1', matrix_revision: 'support-v1', rows: [], snapshot_revision: query.sourceRevision, captured_at: at, expires_at: expires,
      default_policy: 'deny_unclassified', clinical_sections: [], document_support: 'metadata_only' },
  }[topic] as GatewayEnvelope02['data'];
  return { data, coverage: { state: 'complete_for_query', scope: 'metadata', reasons: [topic === 'schema' ? 'R4_BASE_DEFINITION_NOT_ENDPOINT_PROFILE_VALIDATION' : 'DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION'], authorization_limited: false,
    query_exhausted: true, pages_observed: 0, query_evidence: 'metadata_snapshot' } };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
// Test-side complete SDK capture/accounting, independent of the inert builders.
function contextFor(env: GatewayEnvelope02, era: DeliveryContext['era'], tool: ToolName, topic?: typeof topics[number],
  admission?: ReturnType<Candidate['admitV2']>, effectiveByteLimit = 24576,
  deliveryProfile: DeliveryContext['profile'] = 'full-text-v1'): ValidationContext02 {
  const identity = SERVER_IDENTITY;
  const result = () => {
    const serialized = contracts.toMcpToolResult02(env);
    return { ...serialized, ...(deliveryProfile === 'structured-evidence-v1'
      ? { content: [{ type: 'text' as const, text: evidenceRender(env as unknown as GatewayEnvelope).text }] } : {}),
      ...(era === 'modern' ? { resultType: 'complete' as const, _meta: { 'io.modelcontextprotocol/serverInfo': identity } } : {}) };
  };
  for (let i = 0; i < 5; i++) env.budget.bytes_returned = Buffer.byteLength(JSON.stringify(result()));
  const captured = result();
  return freeze({ era, deliveryProfile, renderedText: captured.content[0]!.text, result: captured, serverIdentity: identity,
    // Trusted fixture config/request and envelopeV2 defaults; never read env binding.
    effectiveByteLimit, formatSupplied: admission?.requestedFormat !== undefined,
    ...(admission?.requestedFormat !== undefined ? { requestedFormat: admission.requestedFormat } : {}),
    ...(admission?.fields ? { selectedFields: [...admission.fields] } : {}),
    binding: { sourceAlias: config.source.alias, fhirVersion: 'unknown', sourceRevision: query.sourceRevision,
      policyRevision: query.policyRevision, contextHandle: config.contextId },
    readTarget: { resourceType: args.fhir_read.resource_type, id: args.fhir_read.id },
    resourceType: 'Observation', path: '', patientId: config.patientId, offset: 0, limit: 20,
    ...(tool === 'fhir_search' || tool === 'fhir_page' ? { query: structuredClone(query), requestedPageSize: 20 } : {}), ...(topic ? { topic } : {}),
    ...(topic && ['server','schema','support','search_parameter'].includes(topic) ? { metadata: { topic: topic as NonNullable<ValidationContext02['metadata']>['topic'], rows: [], start: 0, offset: 0, total: 0, limit: 20, deliveredCount: 0, byteLimited: false, ...(topic !== 'schema' ? {revision:query.sourceRevision,capturedAt:at,expiresAt:expires} : {}) } } : {}),
    ...(tool === 'fhir_result' ? { action: 'project' as const } : {}) });
}

for (const era of ['modern', 'legacy'] as const) for (const profile of ['full-text-v1', 'structured-evidence-v1'] as const) {
  test(`v2 clean registered faults and emergency ${era}/${profile} pass final admission`, () => {
    const g = gateway(), c = candidate(g), delivery = { era, profile };
    try {
      for (const tool of contracts.TOOL_NAMES) for (const format of ['fhir', 'compact'] as const) {
        const a = c.admitV2(tool, { ...args[tool], output: { format } });
        for (const code of [...contracts.FAULT_CODES, 'UNREGISTERED_FAULT']) for (const build of [c.errorV2.bind(c), c.minimalV2.bind(c)]) {
          const env = build(tool, { code, retryable: true, message: 'untrusted fault text' }, a, delivery);
          const registered = code !== 'UNREGISTERED_FAULT';
          assert.equal(env.error!.code, registered ? code : 'INTERNAL_ERROR');
          assert.equal(env.error!.retryable, registered);
          assert.equal(env.budget.limit_reached, code === 'OUTPUT_LIMIT');
          assert.deepEqual(env.coverage.reasons, [...(tool === 'fhir_capabilities' ? [] : [caveat]), registered ? code : 'INTERNAL_ERROR']);
          const context = contextFor(env, era, tool, undefined, a, 24576, profile);
          assert.deepEqual(contracts.validateDeliverable02(tool, env, context), { ok: true }, `${tool}/${format}/${code}`);
        }
        const emergency = c.makeEmergencyEnvelopeV2(tool, 'req_emergency', 4096, 2, 5, delivery, a);
        assert.deepEqual(contracts.validateDeliverable02(tool, emergency, contextFor(emergency, era, tool, undefined, a, 4096, profile)), { ok: true });
      }
    } finally { g.close(); }
  });
}

test('v2 warning builders reject unregistered and inherited catalog keys', () => {
  const g = gateway(), c = candidate(g);
  try {
    for (const code of ['UNREGISTERED_WARNING', 'toString', '__proto__', 'constructor']) {
      const b = body('fhir_read'); b.warnings = [{ code, message: 'untrusted warning text' }];
      assert.throws(() => c.envelopeV2('fhir_read', b), (e: unknown) => (e as { code: string }).code === 'INTERNAL_ERROR');
    }
  } finally { g.close(); }
});

for (const era of ['modern', 'legacy'] as const) for (const tool of contracts.TOOL_NAMES) {
  test(`v2 constructors ${era}/${tool}: success, error, minimal and emergency pass S5.1`, () => {
    const g = gateway(), c = candidate(g), delivery = { era, profile: 'full-text-v1' } as const;
    try {
      for (const topic of tool === 'fhir_capabilities' ? topics : [undefined]) {
        const success = c.envelopeV2(tool, topic ? metadata(topic) : body(tool), undefined, delivery);
        const context = contextFor(success, era, tool, topic);
        assert.deepEqual(contracts.validateCrossField02(tool, success, context), { ok: true });
        assert.deepEqual(contracts.validateDeliverable02(tool, success, context), { ok: true });
      }
      for (const build of [c.errorV2.bind(c), c.minimalV2.bind(c)]) {
        const env = build(tool, { code: 'OUTPUT_LIMIT', retryable: false }, undefined, delivery);
        const context = contextFor(env, era, tool);
        assert.deepEqual(contracts.validateCrossField02(tool, env, context), { ok: true });
        assert.deepEqual(contracts.validateDeliverable02(tool, env, context), { ok: true });
      }
      const emergency = c.makeEmergencyEnvelopeV2(tool, 'req_emergency', 4096, 2, 5, delivery);
      const context = contextFor(emergency, era, tool, undefined, undefined, 4096);
      assert.deepEqual(contracts.validateCrossField02(tool, emergency, context), { ok: true });
      assert.deepEqual(contracts.validateDeliverable02(tool, emergency, context), { ok: true });
      assert.equal(emergency.budget.upstream_calls, 2); assert.equal(emergency.budget.elapsed_ms, 5);
    } finally { g.close(); }
  });
}

for (const era of ['modern', 'legacy'] as const) test(`v2 retained inspect/page constructors ${era} bind the trusted action`, () => {
  const g = gateway(), c = candidate(g);
  try {
    for (const action of ['inspect', 'page'] as const) {
      const b = body('fhir_result');
      if (action === 'inspect') {
        b.data = { resource_count: 1, scope: 'retained_upstream_page', upstream_pages_remain: null, formats: ['fhir'],
          omissions: [{ resource_index: 0, resource_type: 'Observation', omitted_fields: [], withheld_reasons: [], interpretation: 'clinical_projection' }] };
        delete b.provenance; delete b.pagination;
      }
      const env = c.envelopeV2('fhir_result', b, c.admitV2('fhir_result', { handle: 'res_test', action }), { era, profile: 'full-text-v1' });
      // Use a fresh trusted context for the action; no response-derived action/query.
      const base = contextFor(env, era, 'fhir_result');
      const context = freeze({ ...base, action });
      assert.deepEqual(contracts.validateCrossField02('fhir_result', env, context), { ok: true });
      assert.deepEqual(contracts.validateDeliverable02('fhir_result', env, context), { ok: true });
    }
  } finally { g.close(); }
});

test('v2 constructors preserve explicit format only, leave selected views independent, and clear failed render state', () => {
  const g = gateway(), c = candidate(g);
  try {
    const dirty = body('fhir_read');
    dirty.warnings = [{ code: 'UNINTERPRETED_MODIFIER', message: 'Structural resource; interpretation unavailable.' }];
    dirty.transform = { projected: true, withheld_payloads: [{ reason: 'ATTACHMENT' }], omitted_fields: ['/text'], unresolved_fields: ['code'],
      narrative_omitted: true, recipe_ids: ['recipe'], structural_resource_indices: [0], requested_format: 'compact' };
    const failed = c.envelopeV2('fhir_read', dirty);
    assert.equal(Object.hasOwn(failed.transform, 'requested_format'), false, 'handler state cannot invent a request');
    // This deliberately dirty success is invalid: a manifest needs a path,
    // and a FHIR view cannot claim a compact recipe. The gate must reject it.
    assert.deepEqual(contracts.validateCrossField02('fhir_read', failed), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
    const validBody = body('fhir_read');
    validBody.warnings = dirty.warnings;
    validBody.transform = { ...dirty.transform, withheld_payloads: [{ path: '/presentedForm/0/data', reason: 'ATTACHMENT' }], recipe_ids: [] };
    const valid = c.envelopeV2('fhir_read', validBody);
    assert.equal(Object.hasOwn(valid.transform, 'requested_format'), false);
    assert.deepEqual(contracts.validateDeliverable02('fhir_read', valid, contextFor(valid, 'modern', 'fhir_read')), { ok: true });
    for (const format of [undefined, 'fhir', 'compact'] as const) {
      const a = c.admitV2('fhir_read', { ...args.fhir_read, output: { fields: ['code'], ...(format ? { format } : {}) } });
      const successBody = body('fhir_read'); successBody.transform = { projected: true, omitted_fields: ['/status'] };
      const env = c.envelopeV2('fhir_read', successBody, a);
      assert.equal(env.transform.format, format ?? 'fhir'); assert.equal(env.transform.requested_format, format);
      assert.equal(Object.hasOwn(env.transform, 'requested_format'), format !== undefined);
      const context = contextFor(env, 'modern', 'fhir_read', undefined, a);
      assert.deepEqual(contracts.validateCrossField02('fhir_read', env, context), { ok: true });
      assert.deepEqual(contracts.validateDeliverable02('fhir_read', env, context), { ok: true });
      const emergency = c.makeEmergencyEnvelopeV2('fhir_read', 'req_emergency', 4096, 0, 0, { era: 'modern', profile: 'full-text-v1' }, a);
      assert.equal(emergency.transform.format, format ?? 'fhir');
      assert.equal(emergency.transform.requested_format, format);
      assert.equal(Object.hasOwn(emergency.transform, 'requested_format'), format !== undefined);
      assert.deepEqual(contracts.validateCrossField02('fhir_read', emergency), { ok: true });
      for (const build of [c.errorV2.bind(c), c.minimalV2.bind(c)]) {
        const clean = build('fhir_read', { code: 'INTERNAL_ERROR', retryable: false }, a);
        assert.equal(clean.transform.format, format ?? 'fhir'); assert.equal(clean.transform.requested_format, format);
        assert.deepEqual(contracts.validateCrossField02('fhir_read', clean), { ok: true });
        assert.deepEqual(clean.transform.withheld_payloads, []); assert.deepEqual(clean.transform.omitted_fields, []);
        assert.deepEqual(clean.transform.unresolved_fields, []); assert.deepEqual(clean.transform.recipe_ids, []);
        assert.deepEqual(clean.transform.structural_resource_indices, []);
      }
    }
    const fallbackBody = body('fhir_read'); fallbackBody.transform = { format: 'fhir' };
    const fallback = c.envelopeV2('fhir_read', fallbackBody, c.admitV2('fhir_read', { ...args.fhir_read, output: { format: 'compact' } }));
    assert.equal(fallback.transform.format, 'fhir'); assert.equal(fallback.transform.requested_format, 'compact');
    assert.deepEqual(contracts.validateCrossField02('fhir_read', fallback), { ok: true });
    assert.equal(c.errorV2('fhir_read', { code: 'OUTPUT_LIMIT', retryable: false }).budget.limit_reached, true);
    const second = c.errorV2('fhir_read', { code: 'INTERNAL_ERROR', retryable: false });
    second.transform.omitted_fields.push('/mutated');
    assert.deepEqual(c.errorV2('fhir_read', { code: 'INTERNAL_ERROR', retryable: false }).transform.omitted_fields, []);
    for (const tool of contracts.TOOL_NAMES) {
      const env = c.errorV2(tool, { code: 'INTERNAL_ERROR', retryable: false }, undefined, { era: 'modern', profile: 'structured-evidence-v1' });
      assert.equal(env.transform.delivery_profile, 'structured-evidence-v1');
      assert.deepEqual(contracts.validateCrossField02(tool, env), { ok: true });
    }
  } finally { g.close(); }
});

test('v2 serialization preserves numeric lexemes in both full-envelope channels', () => {
  const g = gateway(), c = candidate(g);
  try {
    const b = body('fhir_read');
    b.data = { resources: [parseFhirJson('{"resourceType":"Observation","id":"synthetic-o1","valueQuantity":{"value":7.0},"unsafe":9007199254740993,"overflow":1e400}')] } as GatewayEnvelope02['data'];
    const envelope = c.envelopeV2('fhir_read', b);
    const result = contracts.toMcpToolResult02(envelope);
    assert.deepEqual(contracts.validateCrossField02('fhir_read', result.structuredContent), { ok: true });
    for (const text of [result.content[0]!.text, JSON.stringify(result.structuredContent)]) {
      assert.ok(text.includes('"value":7.0')); assert.ok(text.includes('9007199254740993')); assert.ok(text.includes('1e400'));
    }
  } finally { g.close(); }
});

test('v2 path remains private and removed configuration still refuses explicitly', () => {
  assert.equal(contracts.toolSchemas02, contracts.toolInputV2Schemas);
  assert.equal(contracts.envelopeSchema02, contracts.envelopeV2Schema);
  for (const name of ['admitV2', 'envelopeV2', 'errorV2', 'minimalV2', 'makeEmergencyEnvelopeV2', 'toMcpToolResult02']) assert.equal(name in core, false, name);
  assert.throws(() => new FhirGateway({ ...config, protocolEra: 'legacy' } as unknown as ConstructorParameters<typeof FhirGateway>[0]), /protocolEra was removed/);
  assert.throws(() => new FhirGateway({ ...config, textMode: 'summary' }), /summary.*removed.*delivery.profile/);
  const g = new FhirGateway({ ...config, textMode: 'envelope' }); g.close();
  assert.equal('toolSchemas' in contracts, false);
  assert.equal('envelopeSchema' in contracts, false);
  assert.equal(contracts.toolInputV2Schemas.fhir_capabilities.safeParse({ topic: 'support' }).success, true);
  const source = readFileSync(new URL('../packages/core/src/index.ts', import.meta.url), 'utf8');
  const serving = source.slice(source.indexOf('  async execute('), source.indexOf('  /** S5.2 inert admission boundary.'));
  assert.equal(/admitV2|envelopeV2|validateCrossField02|validateDeliverable02/.test(serving), true);
});

test('v2 admission does zero auth, metadata and clinical work; independently recorded serving control exercises all counters', async () => {
  const counts = { auth: 0, metadata: 0, clinical: 0 };
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/fhir+json');
    if (req.url === '/token') { counts.auth++; res.end(JSON.stringify({ access_token: 'synthetic-test-token', token_type: 'Bearer', expires_in: 3600 })); }
    else if (req.url === '/fhir/metadata') { counts.metadata++; res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [{ type: 'Observation', interaction: [{ code: 'read' }] }] }] })); }
    else { counts.clinical++; res.end(JSON.stringify({ resourceType: 'Observation', id: 'synthetic-o1', status: 'final', subject: { reference: 'Patient/synthetic-a' } })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`;
  const envKey = 'FHIR_S52_SYNTHETIC_SECRET'; const previous = process.env[envKey]; process.env[envKey] = 'synthetic-secret';
  const g = new FhirGateway({ ...config, source: { alias: 'local', baseUrl: `${base}/fhir`, auth: { type: 'client_credentials', tokenUrl: `${base}/token`, clientId: 'synthetic-client', clientSecretEnv: envKey } } });
  try {
    const c = candidate(g);
    invalid(() => c.admitV2('fhir_capabilities', { topic: 'support', cursor: 'cur_test', offset: 0 }));
    invalid(() => c.admitV2('fhir_result', { handle: 'res_test', action: 'inspect', fields: ['code'] }));
    invalid(() => c.admitV2('fhir_search', { resource_type: 'Observation', surprise: true }));
    for (const tool of contracts.TOOL_NAMES) c.admitV2(tool, args[tool]);
    assert.deepEqual(counts, { auth: 0, metadata: 0, clinical: 0 });
    // Positive control uses the existing serving path; inert admission itself has no dispatcher yet.
    const env = await g.execute('fhir_read', args.fhir_read);
    assert.equal(env.error, undefined); assert.equal(env.schema_version, '0.3');
    assert.deepEqual(counts, { auth: 1, metadata: 1, clinical: 1 });
  } finally {
    g.close(); if (previous === undefined) delete process.env[envKey]; else process.env[envKey] = previous;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
