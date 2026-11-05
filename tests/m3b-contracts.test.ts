// Gate-F contract tests (M3b spec §2/§9/§10, Addendum CA-1/CA-2/CA-6 + Addendum B, R-1/R-3/N-1/N-2).
// Gate-F fix round: frozen values are asserted against independent literals so
// REPAIR_TABLE / OUTPUT_SPINE / cap / limit mutants cannot survive silently (G-4).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import {
  CATALOG_BYTE_CAPS, CATALOG_TOKEN_CAPS, CATALOG_TOKEN_MEASUREMENT, FAULT_CODES, LAB_EVIDENCE_RECIPE_ID,
  LISTED_OUTPUT_SCHEMA, MEASURED_BYTES_PER_TOKEN_O200K, SERVER_IDENTITY, CATALOG_VERSION, listedInputSchemaV2,
  NO_REVIEWED_NAMES, OUTPUT_SPINE, RECIPE_IDS, REPAIR_TABLE, SERVER_INSTRUCTIONS,
  TOKEN_ACCEPTANCE_STATUS, TOOL_DESCRIPTIONS, TOOL_NAMES, WARNING_MESSAGES,
  FhirGateway,
  admitArguments, capabilitiesCombinationFault, coverageForSnapshot, dedupeWarnings, envelopeV2Schema,
  fhirCapabilitiesV2InputSchema, noMatchesEligible, repairForFault, repairForNoMatches, resolveErrorAllowance,
  safeSchemaPaths, toolEnvelopeV2Schemas, toolInputV2Schemas, validateListedOutput, validateSpine, type FaultCode,
} from '../packages/core/src/index.js';
import { ADMISSION_LIMITS } from '../packages/core/src/contracts.js';
import { HOST_PROFILE_REGISTRY, selectHostProfileEntry, type HostProfileEntry } from '../packages/core/src/delivery.js';
import { COMPACT_RECIPES, COMPACT_RECIPE_SET } from '../packages/core/src/privacy.js';
import { ResultStore, RetentionLedger } from '../packages/core/src/store.js';
import {
  SEARCH_PARAMS, SEARCH_PARAM_DEFS, candidateInterval, collectEvidence, createDigestResolver, evaluateBoundCheck, evaluateCheck,
  fhirDateSearchMatches, measureCatalog, parseFhirDateInterval, parseM3bFixtureFragment, parseM3bOracleFile,
  parseM3bTaskFile, searchParamDeclaration,
} from '../packages/evals/src/index.js';
import type { GatewayEnvelope } from '../packages/core/src/index.js';

test('fault registry is exhaustive and every code has a defined-or-undefined repair (CA-6)', () => {
  assert.equal(new Set(FAULT_CODES).size, FAULT_CODES.length);
  for (const code of FAULT_CODES) assert.ok(code in REPAIR_TABLE, code);
  assert.deepEqual(Object.keys(REPAIR_TABLE).sort(), [...FAULT_CODES].sort());
  assert.ok((FAULT_CODES as readonly string[]).includes('INVALID_TOKEN_RESPONSE'));
  for (const code of ['SEARCH_PARAMETER_UNRESOLVED', 'UNSUPPORTED_SEARCH', 'UNSUPPORTED_MODIFIER', 'UNSUPPORTED_COMPARATOR', 'UNSUPPORTED_SORT'] as FaultCode[]) {
    assert.equal(REPAIR_TABLE[code]?.action, 'discover_search_parameter', code);
  }
});

test('REPAIR_TABLE equals the §10 frozen literal (G-4: every entry discriminates)', () => {
  const discover = { action: 'discover_search_parameter', tool: 'fhir_capabilities', resource: true, parameter: true };
  const schema = { action: 'discover_schema', tool: 'fhir_capabilities', resource: true };
  assert.deepEqual(REPAIR_TABLE, {
    AMBIGUOUS_PATIENT_SELECTOR: { action: 'use_current_context' },
    CONNECTION_REQUIRED: undefined, CONTEXT_REQUIRED: { action: 'use_current_context' },
    CREDENTIAL_INVALIDATED: undefined, CREDENTIAL_UNAVAILABLE: undefined,
    DISCOVERY_EXPIRED: { action: 'repeat_original_query', tool: 'fhir_capabilities' },
    GATEWAY_CLOSED: undefined, INPUT_LIMIT: undefined, INTERNAL_ERROR: undefined, INVALID_ARGUMENTS: undefined,
    INVALID_CONFIG: undefined, INVALID_ELEMENT_PATH: schema,
    INVALID_RESPONSE: undefined, INVALID_TOKEN_RESPONSE: undefined, LOOPBACK_ONLY: undefined, NOT_FOUND: undefined,
    OUTPUT_LIMIT: { action: 'increase_budget', budget: 'increase_or_narrow' },
    POLICY_DENIED: undefined, PROVIDER_CLOSED: undefined, RATE_LIMITED: undefined, REQUEST_CANCELLED: undefined,
    RESULT_EXPIRED: { action: 'repeat_original_query' }, RETENTION_LIMIT: { action: 'narrow_query' },
    SEARCH_PARAMETER_UNRESOLVED: discover,
    TOKEN_ENDPOINT_ERROR: undefined, TOKEN_EXPIRED: undefined, TOKEN_RESPONSE_LIMIT: undefined, TOKEN_TIMEOUT: undefined,
    UNKNOWN_TOOL: undefined, UNRESOLVED_FIELDS: schema,
    UNSAFE_REDIRECT: undefined, UNSAFE_URL: undefined, UNSUPPORTED_COMPARATOR: discover,
    UNSUPPORTED_CONFINEMENT: undefined, UNSUPPORTED_CONTENT: undefined, UNSUPPORTED_DEFINITION: undefined,
    UNSUPPORTED_FHIR_VERSION: undefined,
    UNSUPPORTED_INTERACTION: { action: 'choose_supported_resource', tool: 'fhir_capabilities' },
    UNSUPPORTED_MODIFIER: discover, UNSUPPORTED_PRECISION: undefined,
    UNSUPPORTED_RESOURCE: { action: 'choose_supported_resource', tool: 'fhir_capabilities' },
    UNSUPPORTED_SEARCH: discover, UNSUPPORTED_SORT: discover,
    UNVERIFIED_CONTINUATION: { action: 'repeat_original_query' }, UNVERIFIED_HOST_PROFILE: undefined,
    UNVERIFIED_QUERY: { action: 'repeat_original_query' },
    UPSTREAM_ERROR: undefined, UPSTREAM_LIMIT: undefined, UPSTREAM_TIMEOUT: undefined,
  });
});

test('every source-emitted fault literal is in the integrated registry (G-8 source scan)', () => {
  const roots = [join(process.cwd(), 'packages/core/src'), join(process.cwd(), 'packages/auth/src')];
  const found = new Set<string>();
  for (const root of roots) {
    for (const file of readdirSync(root)) {
      if (!file.endsWith('.ts')) continue;
      const text = readFileSync(join(root, file), 'utf8');
      for (const match of text.matchAll(/(?:GatewayFault|\bfault)\(\s*'([A-Z][A-Z_]*)'/g)) found.add(match[1]!);
    }
  }
  assert.ok(found.has('INVALID_TOKEN_RESPONSE'), 'scan must actually see the auth passthrough code');
  assert.ok(found.size > 30, `scan found only ${found.size} codes`);
  for (const code of found) assert.ok((FAULT_CODES as readonly string[]).includes(code), `unregistered fault code ${code}`);
  // Admission codes are registry members too.
  for (const code of ['INPUT_LIMIT', 'INVALID_ARGUMENTS']) assert.ok((FAULT_CODES as readonly string[]).includes(code), code);
});

test('emitted warning codes stay inside the reviewed message table (G-16, codes subset)', () => {
  const indexText = readFileSync(join(process.cwd(), 'packages/core/src/index.ts'), 'utf8');
  const codes = new Set([...indexText.matchAll(/code: '([A-Z_]+)'|WARNING_MESSAGES\.([A-Z_]+)/g)].map(m => (m[1] ?? m[2])!));
  codes.delete('INTERNAL_ERROR'); // emergency fault code, not a warning producer
  assert.ok(codes.size >= 4);
  assert.ok(indexText.includes('!Object.hasOwn(WARNING_MESSAGES, warning.code)'), 'dynamic source warnings pass the canonical vocabulary guard');
  for (const code of codes) assert.ok(WARNING_MESSAGES[code], `warning ${code} missing from WARNING_MESSAGES`);
  assert.ok(WARNING_MESSAGES.UNVERIFIED_DELIVERY_PROFILE);
});

test('repair advice never names an unlisted topic field (G-17)', () => {
  const reviewed = { resource: () => true, parameter: () => true };
  const meta = { resource_type: 'Observation', parameter: 'code', allowed_max_bytes: 131072, current_max_bytes: 24576 };
  for (const code of FAULT_CODES) {
    const repair = repairForFault(code, meta, reviewed);
    if (repair) assert.ok(!('topic' in repair), `${code} repair must not carry a topic`);
  }
});

test('repair helper honors reviewed names, budget rule and R-3 warnings overflow', () => {
  const reviewed = { resource: (t: string) => t === 'Observation', parameter: (t: string, n: string) => t === 'Observation' && n === 'code' };
  const meta = { resource_type: 'Observation', parameter: 'code', allowed_max_bytes: 131072, current_max_bytes: 24576 };
  assert.deepEqual(repairForFault('UNSUPPORTED_SEARCH', meta, reviewed), { action: 'discover_search_parameter', tool: 'fhir_capabilities', resource_type: 'Observation', parameter: 'code' });
  // Source-only/unreviewed names never enter advice.
  assert.deepEqual(repairForFault('UNSUPPORTED_SEARCH', { ...meta, resource_type: 'Specimen', parameter: 'x' }, reviewed), { action: 'discover_search_parameter', tool: 'fhir_capabilities' });
  assert.equal(repairForFault('NOT_FOUND', meta, reviewed), undefined);
  assert.equal(repairForFault('WHATEVER', meta, reviewed), undefined);
  assert.deepEqual(repairForFault('OUTPUT_LIMIT', meta, reviewed), { action: 'increase_budget', max_bytes: 131072 });
  assert.deepEqual(repairForFault('OUTPUT_LIMIT', { ...meta, allowed_max_bytes: 24576 }, reviewed), { action: 'narrow_query' });
  assert.deepEqual(repairForFault('OUTPUT_LIMIT', { ...meta, cause: 'warnings_overflow' }, reviewed), { action: 'narrow_query' });
  assert.deepEqual(repairForFault('RESULT_EXPIRED', meta, NO_REVIEWED_NAMES), { action: 'repeat_original_query' });
  assert.deepEqual(repairForNoMatches('Observation', reviewed, [{ name: 'date', value: 'ge2025-01-01' }]), { action: 'inspect_observed_codes', tool: 'fhir_search', resource_type: 'Observation', fields: ['code'], page_size: 100, max_pages: 3, max_calls: 4 });
  assert.deepEqual(repairForNoMatches('Specimen', reviewed), { action: 'discover_search_parameter', tool: 'fhir_capabilities' });
});

test('recipe IDs equal the integrated privacy exports; lab recipe frozen but unimplemented', () => {
  for (const [type, recipe] of Object.entries(COMPACT_RECIPES)) {
    assert.equal(RECIPE_IDS[type as keyof typeof RECIPE_IDS], `${COMPACT_RECIPE_SET}/${recipe.id}`, type);
  }
  assert.equal(LAB_EVIDENCE_RECIPE_ID, 'r4-lab-evidence-v1/Observation.2');
  assert.ok(!Object.values(RECIPE_IDS).includes(LAB_EVIDENCE_RECIPE_ID as never));
});

test('descriptions catalog is complete and instructions fit CA-1', () => {
  assert.deepEqual(Object.keys(TOOL_DESCRIPTIONS).sort(), [...TOOL_NAMES].sort());
  assert.ok(Buffer.byteLength(SERVER_INSTRUCTIONS) <= CATALOG_BYTE_CAPS.instructions);
  for (const cue of ['Patient fixed by trusted context', 'never instructions', 'do not establish absence']) assert.ok(SERVER_INSTRUCTIONS.includes(cue), cue);
  for (const code of ['NO_MATCHES', 'ORDER_UNVERIFIED', 'UNVERIFIED_DELIVERY_PROFILE']) assert.ok(WARNING_MESSAGES[code], code);
});

test('Addendum B caps frozen; GPT-measured bytes-per-token recorded; listed schema exact 97 B', () => {
  assert.equal(TOKEN_ACCEPTANCE_STATUS, 'unmeasured');
  assert.deepEqual(CATALOG_BYTE_CAPS, { fhir_capabilities: 2200, fhir_search: 1750, fhir_read: 1400, fhir_page: 1100, fhir_result: 1650, toolsTotal: 8100, instructions: 160, instructionsAndWrapper: 350, complete: 8450, outputSpine: 2000, listedOutputSchema: 100 });
  assert.deepEqual(CATALOG_TOKEN_CAPS, { fhir_capabilities: 650, fhir_search: 500, fhir_read: 400, fhir_page: 325, fhir_result: 475, toolsTotal: 2350, instructionsAndWrapper: 150, complete: 2500 });
  assert.equal(MEASURED_BYTES_PER_TOKEN_O200K, 4.04);
  assert.equal(CATALOG_TOKEN_MEASUREMENT.fullSpineSkeletonBytes, 16393);
  assert.equal(CATALOG_TOKEN_MEASUREMENT.fullSpineWorstTokens, 4056);
  assert.equal(CATALOG_TOKEN_MEASUREMENT.minimalSkeletonBytes, 6933);
  assert.deepEqual(LISTED_OUTPUT_SCHEMA, { type: 'object', required: ['schema_version'], properties: { schema_version: { type: 'string' } } });
  assert.equal(Buffer.byteLength(JSON.stringify(LISTED_OUTPUT_SCHEMA)), 97);
  assert.ok(Buffer.byteLength(JSON.stringify(OUTPUT_SPINE)) <= CATALOG_BYTE_CAPS.outputSpine);
});

test('OUTPUT_SPINE declares every §0.4 control with its type/enum (G-4)', () => {
  const props = OUTPUT_SPINE.properties as unknown as Record<string, Record<string, unknown>>;
  assert.deepEqual([...OUTPUT_SPINE.required].sort(), ['budget', 'context', 'coverage', 'data', 'request_id', 'schema_version', 'source', 'transform', 'warnings']);
  const nested = (path: string): Record<string, unknown> => {
    const [head, tail] = [path.split('.')[0]!, path.split('.').slice(1).join('.')];
    const container = (props[head]!.properties ?? props[head]!.items as Record<string, unknown>) as Record<string, Record<string, unknown>>;
    const inner = props[head]!.items ? ((props[head]!.items as Record<string, unknown>).properties as Record<string, Record<string, unknown>>) : container;
    return inner[tail]!;
  };
  assert.deepEqual(props.schema_version, { type: 'string' });
  assert.deepEqual(props.request_id, { type: 'string' });
  for (const field of ['source.alias', 'source.fhir_version', 'source.capability_revision', 'context.handle', 'context.mode', 'context.policy_revision']) assert.deepEqual(nested(field), { type: 'string' }, field);
  assert.deepEqual(props.data, { type: 'object' });
  assert.deepEqual(nested('provenance.resource_index'), { type: 'integer' });
  assert.deepEqual(nested('provenance.retrieved_at'), { type: 'string' });
  assert.deepEqual(nested('coverage.state'), { enum: ['complete_for_query', 'partial', 'unknown'] });
  assert.deepEqual(nested('coverage.scope'), { type: 'string' });
  assert.deepEqual(nested('coverage.reasons'), { type: 'array', items: { type: 'string' } });
  assert.deepEqual(nested('pagination.has_more'), { type: ['boolean', 'null'] });
  assert.deepEqual(nested('pagination.next_cursor'), { type: 'string' });
  for (const field of ['pagination.returned_matches', 'pagination.returned_includes', 'pagination.requested_page_size']) assert.deepEqual(nested(field), { type: 'integer' }, field);
  assert.deepEqual((nested('pagination.total').properties as Record<string, unknown>).value, { type: 'integer' });
  assert.deepEqual((nested('pagination.total').properties as Record<string, unknown>).precision, { enum: ['accurate', 'estimate', 'unknown'] });
  assert.deepEqual(nested('transform.format'), { enum: ['compact', 'fhir'] });
  assert.deepEqual(nested('transform.projected'), { type: 'boolean' });
  assert.deepEqual(nested('transform.delivery_profile'), { enum: ['full-text-v1', 'structured-evidence-v1'] });
  assert.deepEqual(nested('warnings.code'), { type: 'string' });
  assert.deepEqual(nested('warnings.message'), { type: 'string' });
  for (const field of ['budget.bytes_returned', 'budget.byte_limit', 'budget.upstream_calls', 'budget.elapsed_ms']) assert.deepEqual(nested(field), { type: 'integer' }, field);
  assert.deepEqual(nested('budget.limit_reached'), { type: 'boolean' });
  assert.deepEqual(nested('result.handle'), { type: 'string' });
  assert.deepEqual(nested('result.expires_at'), { type: 'string' });
  assert.deepEqual(nested('result.formats'), { type: 'array', items: { type: 'string' } });
  assert.deepEqual(nested('error.code'), { type: 'string' });
  assert.deepEqual(nested('error.safe_message'), { type: 'string' });
  assert.deepEqual(nested('error.retryable'), { type: 'boolean' });
});

const v2Success = {
  schema_version: '0.3', request_id: 'req-1',
  source: { alias: 'local', fhir_version: '4.0.1', capability_revision: 'rev1' },
  context: { handle: 'ctx_1', mode: 'patient-bound', policy_revision: 'synthetic-v1' },
  data: { resources: [{ resourceType: 'Observation', id: 'o1', status: 'final' }] },
  provenance: [{ resource_index: 0, retrieved_at: '2025-01-01T00:00:00Z' }],
  coverage: { state: 'unknown', scope: 'page', reasons: ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN'], authorization_limited: true, query_exhausted: true, pages_observed: 1, query_evidence: 'declared_and_self_link_only' },
  pagination: { has_more: false, returned_matches: 1, returned_includes: 0 },
  transform: { format: 'fhir', projected: false, withheld_payloads: [], omitted_fields: [], unresolved_fields: [], narrative_omitted: false, recipe_ids: [], structural_resource_indices: [], delivery_profile: 'full-text-v1' },
  warnings: [], budget: { bytes_returned: 1000, byte_limit: 24576, limit_reached: false, upstream_calls: 1, elapsed_ms: 5 },
};

test('strict v2 envelopes validate; strict-valid implies spine-valid (CA-2)', () => {
  assert.equal(toolEnvelopeV2Schemas.fhir_search.safeParse(v2Success).success, true);
  assert.equal(envelopeV2Schema.safeParse(v2Success).success, true);
  assert.equal(validateSpine(v2Success), true);
  const errorEnv = { ...v2Success, data: {}, provenance: undefined, pagination: undefined, error: { code: 'NOT_FOUND', safe_message: 'Requested resource is not available.', retryable: false } };
  assert.equal(toolEnvelopeV2Schemas.fhir_read.safeParse(errorEnv).success, true);
  assert.equal(validateSpine(errorEnv), true);
  // Cross-field: an error cannot carry resources; provenance must be in range.
  assert.equal(toolEnvelopeV2Schemas.fhir_read.safeParse({ ...errorEnv, data: v2Success.data }).success, false);
  assert.equal(toolEnvelopeV2Schemas.fhir_search.safeParse({ ...v2Success, provenance: [{ resource_index: 9, retrieved_at: '2025-01-01T00:00:00Z' }] }).success, false);
  // Current 0.1 runtime envelopes also satisfy the spine superset.
  assert.equal(validateSpine({ ...v2Success, schema_version: '0.1' }), true);
  assert.equal(validateSpine({ ...v2Success, coverage: { state: 'bogus', scope: 'page', reasons: [] } }), false);
  // Strict-valid implies listed-minimal-valid (Addendum B.3.1).
  assert.equal(validateListedOutput(v2Success), true);
  assert.equal(validateListedOutput({ ...v2Success, schema_version: 2 }), false);
  assert.equal(validateListedOutput({}), false);
});

test('validateSpine rejects every declared-control corruption (G-6 corpus)', () => {
  assert.equal(validateSpine(v2Success), true);
  const corrupt = (patch: Record<string, unknown>) => ({ ...v2Success, ...patch });
  assert.equal(validateSpine(corrupt({ transform: { ...v2Success.transform, delivery_profile: 'slim' } })), false, 'bad delivery_profile');
  assert.equal(validateSpine(corrupt({ pagination: { has_more: 'yes', returned_matches: 0, returned_includes: 0 } })), false, 'has_more string');
  assert.equal(validateSpine(corrupt({ provenance: [{ resource_index: 'zero', retrieved_at: '2025-01-01T00:00:00Z' }] })), false, 'resource_index string');
  assert.equal(validateSpine(corrupt({ error: { code: 'X', safe_message: 'm', retryable: 'no' } })), false, 'retryable string');
  assert.equal(validateSpine(corrupt({ coverage: { ...v2Success.coverage, scope: 7 } })), false, 'scope number');
  assert.equal(validateSpine(corrupt({ pagination: { has_more: false, returned_matches: 1, returned_includes: 0, total: { value: 1, precision: 'sure' } } })), false, 'bad precision');
  assert.equal(validateSpine(corrupt({ warnings: [{ code: 7, message: 'm' }] })), false, 'warning code number');
  assert.equal(validateSpine(corrupt({ result: { handle: 'res_x', expires_at: '2025-01-01T00:00:00Z', formats: [7] } })), false, 'formats non-string');
  assert.equal(validateSpine(corrupt({ source: { alias: 7, fhir_version: '4.0.1' } })), false, 'alias number');
  assert.equal(validateSpine(corrupt({ budget: { ...v2Success.budget, bytes_returned: 1.5 } })), false, 'non-integer bytes');
  assert.equal(validateSpine({}), false, 'empty');
});

test('bounded admission rejects cycles, accessors, deep and oversized input without getters', () => {
  assert.deepEqual(ADMISSION_LIMITS, { bytes: 256 * 1024, nodes: 4096, depth: 32 });
  assert.deepEqual(admitArguments({ a: [1, { b: 'x' }] }), { ok: true });
  // Node-count limit discriminates (G-4): >4,096 nodes is INPUT_LIMIT, a small tree passes.
  assert.deepEqual(admitArguments({ a: Array.from({ length: 5000 }, () => 0) }), { ok: false, code: 'INPUT_LIMIT' });
  assert.equal(admitArguments({ a: Array.from({ length: 100 }, () => 0) }).ok, true);
  // Throwing Proxy descriptor trap refuses safely (G-5), never propagates raw text.
  const proxy = new Proxy({ a: 1 }, { getOwnPropertyDescriptor() { throw new Error('proxy-canary'); } });
  assert.deepEqual(admitArguments(proxy), { ok: false, code: 'INVALID_ARGUMENTS' });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.equal(admitArguments(cyclic).ok, false);
  let getterHit = false;
  const accessor = Object.defineProperty({}, 'x', { enumerable: true, get() { getterHit = true; return 1; } });
  assert.equal(admitArguments(accessor).ok, false);
  assert.equal(getterHit, false);
  let deep: unknown = 0; for (let i = 0; i < 40; i++) deep = { n: deep };
  assert.equal(admitArguments(deep).ok, false);
  assert.equal(admitArguments({ big: 'x'.repeat(300 * 1024) }).ok, false);
  assert.equal(admitArguments({ fn: () => 1 }).ok, false);
});

test('error allowance resolves pre-parse from own data properties only', () => {
  const defaults = { defaultBytes: 24576, maxBytes: 65536 };
  assert.deepEqual(resolveErrorAllowance({}, defaults), { allowance: 24576, invalidAllowance: false });
  assert.deepEqual(resolveErrorAllowance({ output: { max_bytes: 131072 } }, defaults), { allowance: 65536, invalidAllowance: false });
  assert.deepEqual(resolveErrorAllowance({ output: { max_bytes: 100 } }, defaults), { allowance: 24576, invalidAllowance: true });
  let getterHit = false;
  const sneaky = Object.defineProperty({}, 'output', { enumerable: true, get() { getterHit = true; return { max_bytes: 4096 }; } });
  assert.deepEqual(resolveErrorAllowance(sneaky, defaults), { allowance: 24576, invalidAllowance: false });
  assert.equal(getterHit, false);
  // Total on throwing Proxies (G-5): falls back, never throws.
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('proxy-canary'); } });
  assert.deepEqual(resolveErrorAllowance(proxy, defaults), { allowance: 24576, invalidAllowance: false });
});

test('safe schema paths never echo unknown keys and cap at eight', () => {
  const paths = safeSchemaPaths([
    { code: 'unrecognized_keys', path: [] },
    { code: 'invalid_type', path: ['output', 'max_bytes'] },
    { code: 'x', path: ['secret-canary-key', 'deep', 'a', 'b', 'c', 'd'] },
  ]);
  assert.ok(paths.includes('arguments'));
  assert.ok(paths.includes('output.max_bytes'));
  assert.ok(!paths.some(p => p.includes('canary')));
  assert.ok(paths.length <= 8);
});

test('warnings dedupe and overflow signal at 33 distinct codes', () => {
  assert.equal(dedupeWarnings([{ code: 'A' }, { code: 'A' }, { code: 'B' }]).overflow, false);
  assert.equal(dedupeWarnings([{ code: 'A' }, { code: 'A' }]).warnings.length, 1);
  assert.equal(dedupeWarnings(Array.from({ length: 33 }, (_, i) => ({ code: `W${i}` }))).overflow, true);
});

test('active v2 capabilities listing retains strict combination rules', () => {
  const topics = toolInputV2Schemas.fhir_capabilities.shape.topic.unwrap().options;
  assert.ok(topics.includes('search_parameter') && topics.includes('support'), 'both implemented discovery topics are advertised');
  assert.equal(fhirCapabilitiesV2InputSchema.safeParse({ topic: 'search_parameter', resource_type: 'Observation' }).success, true);
  // Every §1 combination rule discriminates (G-4).
  assert.equal(capabilitiesCombinationFault({ topic: 'search_parameter', resource_type: 'Observation', name: 'a', query: 'b' }), 'name and query are mutually exclusive');
  assert.equal(capabilitiesCombinationFault({ topic: 'server', path: 'valueQuantity' }), 'path/offset apply only to topic=schema');
  assert.equal(capabilitiesCombinationFault({ topic: 'server', offset: 5 }), 'path/offset apply only to topic=schema');
  assert.equal(capabilitiesCombinationFault({ topic: 'server', name: 'code' }), 'name/query apply only to topic=search_parameter');
  assert.equal(capabilitiesCombinationFault({ topic: 'server', cursor: 'cur_x' }), undefined);
  assert.equal(capabilitiesCombinationFault({ topic: 'search_parameter' }), 'search_parameter requires resource_type on the first call');
  assert.equal(capabilitiesCombinationFault({ topic: 'search_parameter', cursor: 'cur_x', resource_type: 'Observation' }), 'a discovery continuation cannot change its filter');
  assert.equal(capabilitiesCombinationFault({ topic: 'search_parameter', cursor: 'cur_x', name: 'code' }), 'a discovery continuation cannot change its filter');
  assert.equal(capabilitiesCombinationFault({ topic: 'search_parameter', cursor: 'cur_x', query: 'x' }), 'a discovery continuation cannot change its filter');
  assert.equal(capabilitiesCombinationFault({ topic: 'schema', path: 'valueQuantity' }), undefined);
  assert.equal(capabilitiesCombinationFault({ topic: 'search_parameter', cursor: 'cur_x' }), undefined);
  assert.equal(capabilitiesCombinationFault({ topic: 'support', cursor: 'cur_x' }), undefined);
});

test('v2 input shapes freeze §0.3 exactly (no format default, alias/handle/field bounds)', () => {
  const parsed = toolInputV2Schemas.fhir_search.safeParse({ resource_type: 'Observation' });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.output, undefined, 'omitted output stays omitted (no Zod format default)');
    assert.deepEqual(parsed.data.params, []);
    assert.equal(parsed.data.page_size, 20);
  }
  assert.equal(toolInputV2Schemas.fhir_search.safeParse({ resource_type: 'Observation', output: { format: 'fhir' } }).success, true);
  assert.equal(toolInputV2Schemas.fhir_search.safeParse({ resource_type: 'Observation', source: 'bad alias!' }).success, false, 'sourceAlias regex');
  assert.equal(toolInputV2Schemas.fhir_page.safeParse({ cursor: '' }).success, false, 'handle min length 1');
  assert.equal(toolInputV2Schemas.fhir_result.safeParse({ handle: '' }).success, false, 'handle min length 1');
  assert.equal(toolInputV2Schemas.fhir_search.safeParse({ resource_type: 'Observation', output: { fields: ['a.b.c.d.e.f.g.h.i'] } }).success, false, 'fieldPath segment limit');
  assert.equal(toolInputV2Schemas.fhir_search.safeParse({ resource_type: 'Observation', output: { fields: ['__proto__'] } }).success, false, 'fieldPath refine');
  assert.deepEqual(Object.keys(toolInputV2Schemas).sort(), [...TOOL_NAMES].sort());
});

test('noMatchesEligible truth table and coverage stub stay conservative (G-4)', () => {
  const base = { state: 'unknown' as const, scope: 'query' as const, reasons: [] as string[], authorization_limited: true, query_exhausted: true, pages_observed: 1, query_evidence: 'declared_and_self_link_only' as const };
  assert.equal(noMatchesEligible(base, 0, true), true);
  assert.equal(noMatchesEligible(base, 0, false), false, 'unfiltered zero is not eligible');
  assert.equal(noMatchesEligible(base, 1, true), false);
  assert.equal(noMatchesEligible({ ...base, query_exhausted: false }, 0, true), false);
  assert.equal(noMatchesEligible({ ...base, query_exhausted: null }, 0, true), false);
  const coverage = coverageForSnapshot(
    { constraints: [], materialFilterProved: false, evidenceKind: 'declared_and_self_link_only' },
    { deliveredCount: 0, pagesObserved: 1, queryEvidence: { constraints: [], materialFilterProved: false, evidenceKind: 'declared_and_self_link_only' }, sortProof: 'none', remainder: 'none', exhausted: true, scope: 'query', authorizationLimited: true },
  );
  assert.equal(coverage.state, 'unknown', 'unproved filter can never claim completeness');
});

test('G-9: a discovery store evicts its own oldest cursors under its own quotas', () => {
  // Byte subquota (probe case A).
  const ledger = new RetentionLedger(100000);
  const disc = new ResultStore<{ b: string }>(1000, 10, 60000, Date.now, { ledger, role: 'discovery', evictableKinds: ['cur'], unavailableCode: 'DISCOVERY_EXPIRED' });
  const first = disc.put('cur', { b: 'a'.repeat(400) });
  disc.put('cur', { b: 'b'.repeat(400) });
  disc.put('cur', { b: 'c'.repeat(400) });
  assert.throws(() => disc.get(first.handle), (e: unknown) => (e as { code?: string }).code === 'DISCOVERY_EXPIRED');
  disc.close();
  // maxHandles (probe case C).
  const small = new ResultStore<{ b: number }>(100000, 1, 60000, Date.now, { role: 'discovery', evictableKinds: ['cur'], unavailableCode: 'DISCOVERY_EXPIRED' });
  const only = small.put('cur', { b: 1 });
  small.put('cur', { b: 2 });
  assert.throws(() => small.get(only.handle), (e: unknown) => (e as { code?: string }).code === 'DISCOVERY_EXPIRED');
  small.close();
});

test('N-1 precedence: discovery admission never evicts clinical res_ state (G-4 ledger mutant)', () => {
  const ledger = new RetentionLedger(700);
  const clinical = new ResultStore<{ blob: string }>(100000, 10, 60000, Date.now, { ledger, role: 'clinical' });
  const discovery = new ResultStore<{ blob: string }>(100000, 10, 60000, Date.now, { ledger, role: 'discovery', evictableKinds: ['cur'], unavailableCode: 'DISCOVERY_EXPIRED' });
  const retained = clinical.put('res', { blob: 'c'.repeat(400) });
  // No discovery cursor exists to evict, so the shared ceiling refuses rather than touching clinical state.
  assert.throws(() => discovery.put('cur', { blob: 'd'.repeat(400) }), (e: unknown) => (e as { code?: string }).code === 'RETENTION_LIMIT');
  assert.equal(clinical.get(retained.handle).value.blob.length, 400, 'clinical res_ survives ledger pressure from discovery');
  clinical.close(); discovery.close();
});

test('N-2 selector: unverified entries need the override; verified do not (G-14)', () => {
  const entry = (verification: HostProfileEntry['verification']): HostProfileEntry => ({
    id: 'fixture-host', version: '1', host: { name: 'fixture', version: '1', client_stack: 'sdk', client_stack_version: '2.3.1' },
    era: 'modern', transport: 'stdio', workflow: 'recent-labs-v1', delivery_profile: 'structured-evidence-v1', verification,
  });
  assert.equal(selectHostProfileEntry([entry('unverified')], 'fixture-host', 'modern', false), undefined);
  assert.equal(selectHostProfileEntry([entry('fixture_only')], 'fixture-host', 'modern', false), undefined);
  assert.equal(selectHostProfileEntry([entry('unverified')], 'fixture-host', 'modern', true)?.id, 'fixture-host');
  assert.equal(selectHostProfileEntry([entry('verified')], 'fixture-host', 'modern', false)?.id, 'fixture-host');
  assert.equal(selectHostProfileEntry([entry('verified')], 'fixture-host', 'legacy', false), undefined, 'era must match');
});

test('N-1: shared ledger evicts discovery cursors for clinical admission, never clinical cursors', () => {
  const ledger = new RetentionLedger(1200);
  const clinical = new ResultStore<{ blob: string }>(100000, 10, 60000, Date.now, { ledger, role: 'clinical' });
  const discovery = new ResultStore<{ blob: string }>(100000, 10, 60000, Date.now, { ledger, role: 'discovery', evictableKinds: ['cur'], unavailableCode: 'DISCOVERY_EXPIRED' });
  const d1 = discovery.put('cur', { blob: 'd'.repeat(400) });
  const c1 = clinical.put('cur', { blob: 'c'.repeat(400) });
  clinical.put('cur', { blob: 'e'.repeat(400) });
  assert.throws(() => discovery.get(d1.handle), (e: unknown) => (e as { code?: string }).code === 'DISCOVERY_EXPIRED');
  assert.equal(clinical.get(c1.handle).value.blob.length, 400, 'clinical cursor survives');
  clinical.close(); discovery.close();
});

test('eval JSON formats are strict (spec §9)', () => {
  const task = { id: 't1', category: 'x', question: 'q', steps: [{ tool: 'fhir_read', input: { resource_type: 'Observation', id: 'o1' } }], checks: [{ kind: 'decimalLexeme', id: 'c1', step: 0, resource_type: 'Observation', id_value: 'o1', path: 'valueQuantity.value', equals: '7.0' }], budget: { maxBytes: 6000, maxUpstreamCalls: 2, maxToolCalls: 2 } };
  assert.equal(parseM3bTaskFile(JSON.stringify({ schema_version: 'm3b-tasks/1', tasks: [task] })).length, 1);
  assert.throws(() => parseM3bTaskFile(JSON.stringify({ schema_version: 'm3b-tasks/1', tasks: [task, task] })), /duplicate/);
  assert.throws(() => parseM3bTaskFile(JSON.stringify({ schema_version: 'x', tasks: [] })), /schema_version/);
  assert.throws(() => parseM3bTaskFile(JSON.stringify({ schema_version: 'm3b-tasks/1', tasks: [{ ...task, evil: 1 }] })), /unknown key/);
  const frag = { schema_version: 'm3b-fixture/1', id: 'f1', resources: [{ resourceType: 'Observation', id: 'o1' }], search_parameters: [], behaviors: [{ id: 'b1', ignore_parameters: ['code'], ignore_sort: false, lexicographic_date_sort: false }] };
  assert.equal(parseM3bFixtureFragment(JSON.stringify(frag)).id, 'f1');
  assert.throws(() => parseM3bFixtureFragment(JSON.stringify({ ...frag, behaviors: [{ id: 'b', url: 'http://x' }] })), /unknown key/);
  assert.throws(() => parseM3bFixtureFragment(JSON.stringify({ ...frag, raw_resources: [{ resource_type: 'Observation', id: 'o1', json_text: '{"resourceType":"Observation","id":"o1"}' }] })), /duplicate/);
});

test('task loader rejects typo keys, missing M3b step and malformed fields (G-3 negatives)', () => {
  const wrap = (checks: unknown[]) => JSON.stringify({ schema_version: 'm3b-tasks/1', tasks: [{ id: 't', category: 'x', question: 'q', steps: [{ tool: 'fhir_search', input: { resource_type: 'Observation' } }], checks, budget: { maxBytes: 6000, maxUpstreamCalls: 1, maxToolCalls: 1 } }] });
  // Typo key (reasons_includes for reasons_include) must fail loading, never vacuously pass.
  assert.throws(() => parseM3bTaskFile(wrap([{ kind: 'queryEvidence', id: 'q', step: 0, state: 'unknown', query_exhausted: null, reasons_includes: ['X'] }])), /unknown key/);
  // M3b checks require an explicit step.
  assert.throws(() => parseM3bTaskFile(wrap([{ kind: 'sortEvidence', id: 's', requested: [], effective: null, order: 'unspecified' }])), /explicit step/);
  assert.throws(() => parseM3bTaskFile(wrap([{ kind: 'callOutcome', id: 'c', outcome: 'application_error', code: 'X' }])), /explicit step/);
  // Quoted (JSON-string) lexeme text is not a raw numeric token.
  assert.throws(() => parseM3bTaskFile(wrap([{ kind: 'decimalLexeme', id: 'd', step: 0, resource_type: 'Observation', id_value: 'o1', path: 'valueQuantity.value', equals: '"7.0"' }])), /raw numeric/);
  assert.throws(() => parseM3bTaskFile(wrap([{ kind: 'citationTuple', id: 'c', step: 0, resource_type: 'Observation', id_value: 'o1', source: 'eval', version: 3 }])), /version/);
  assert.throws(() => parseM3bTaskFile(wrap([{ kind: 'fact', id: 'f', step: 0, resource: 'o1', path: 'a..b', equals: 1 }])), /path invalid/);
  assert.throws(() => parseM3bTaskFile(wrap([{ kind: 'fact', id: 'f', step: 0, resource: 'o1', path: 'a.b', equals: 1 }, { kind: 'fact', id: 'f', step: 0, resource: 'o1', path: 'a.c', equals: 2 }])), /duplicate check id/);
  assert.throws(() => parseM3bTaskFile(JSON.stringify({ schema_version: 'm3b-tasks/1', tasks: [{ id: 't', category: 'x', question: 'q', steps: [{ tool: 'fhir_search', input: {} }], checks: [], budget: { maxBytes: 1, maxUpstreamCalls: 1, maxToolCalls: 1 }, fixtureMode: 'no-such-mode' }] })), /fixtureMode/);
  // Valid M3b forms load.
  assert.equal(parseM3bTaskFile(wrap([{ kind: 'queryEvidence', id: 'q', step: 0, state: 'unknown', query_exhausted: null, reasons_include: ['X'], constraints: [{ name: 'code', value: 'v', source_reported: 'matched', execution: 'unknown' }] }])).length, 1);
  // Oracle + fragment negatives.
  const oracle = parseM3bOracleFile(JSON.stringify({ schema_version: 'm3b-oracle/1', vectors: [{ id: 'v1', resource_type: 'Observation', parameter: 'code', value: 'x', resource: { resourceType: 'Observation' }, matches: true }] }));
  assert.match(oracle.sha256, /^[a-f0-9]{64}$/);
  assert.equal(createDigestResolver({ ['a'.repeat(64)]: { constraints: [] } })('a'.repeat(64))?.constraints.length, 0);
  assert.equal(createDigestResolver({})('not-a-digest'), undefined);
  assert.throws(() => parseM3bOracleFile(JSON.stringify({ schema_version: 'm3b-oracle/1', vectors: [{ id: 'v', evil: 1 }] })), /unknown key/);
  const frag = { schema_version: 'm3b-fixture/1', id: 'f1', resources: [], search_parameters: [{ resource_type: 'Observation', name: 'code', type: 'bogus' }], behaviors: [] };
  assert.throws(() => parseM3bFixtureFragment(JSON.stringify(frag)), /type invalid/);
  assert.throws(() => parseM3bFixtureFragment(JSON.stringify({ ...frag, search_parameters: [], behaviors: [{ id: 'b', ignore_parameters: 'code', ignore_sort: false, lexicographic_date_sort: false }] })), /ignore_parameters/);
});

test('fixture declarations resolve per (type,name) to the pinned R4 canonicals (G-2)', () => {
  // Transcribed from hl7.fhir.r4.core 4.0.1 (example-named definitions excluded).
  const SP = 'http://hl7.org/fhir/SearchParameter';
  const expected: Record<string, [string, string]> = {
    'Patient._id': ['token', `${SP}/Resource-id`], 'Patient.identifier': ['token', `${SP}/Patient-identifier`],
    'Patient.name': ['string', `${SP}/Patient-name`], 'Patient.family': ['string', `${SP}/individual-family`],
    'Patient.given': ['string', `${SP}/individual-given`], 'Patient.birthdate': ['date', `${SP}/individual-birthdate`],
    'Patient.gender': ['token', `${SP}/individual-gender`], 'Patient.active': ['token', `${SP}/Patient-active`],
    'Observation.subject': ['reference', `${SP}/Observation-subject`], 'Observation.patient': ['reference', `${SP}/clinical-patient`],
    'Observation.code': ['token', `${SP}/clinical-code`], 'Observation.category': ['token', `${SP}/Observation-category`],
    'Observation.date': ['date', `${SP}/clinical-date`], 'Observation.status': ['token', `${SP}/Observation-status`],
    'Observation.value-quantity': ['quantity', `${SP}/Observation-value-quantity`],
    'Condition.subject': ['reference', `${SP}/Condition-subject`], 'Condition.category': ['token', `${SP}/Condition-category`],
    'Condition.clinical-status': ['token', `${SP}/Condition-clinical-status`], 'Condition.verification-status': ['token', `${SP}/Condition-verification-status`],
    'AllergyIntolerance.clinical-status': ['token', `${SP}/AllergyIntolerance-clinical-status`],
    'AllergyIntolerance.verification-status': ['token', `${SP}/AllergyIntolerance-verification-status`],
    'MedicationRequest.subject': ['reference', `${SP}/MedicationRequest-subject`], 'MedicationRequest.status': ['token', `${SP}/medications-status`],
    'DocumentReference.subject': ['reference', `${SP}/DocumentReference-subject`], 'DocumentReference.status': ['token', `${SP}/DocumentReference-status`],
    'DocumentReference.category': ['token', `${SP}/DocumentReference-category`], 'DocumentReference.type': ['token', `${SP}/clinical-type`],
    'DocumentReference.date': ['date', `${SP}/DocumentReference-date`],
    'DiagnosticReport.subject': ['reference', `${SP}/DiagnosticReport-subject`], 'DiagnosticReport.status': ['token', `${SP}/DiagnosticReport-status`],
    'DiagnosticReport.date': ['date', `${SP}/clinical-date`],
    'Immunization.status': ['token', `${SP}/Immunization-status`], 'Immunization.date': ['date', `${SP}/clinical-date`],
  };
  for (const [key, [type, definition]] of Object.entries(expected)) {
    assert.deepEqual(SEARCH_PARAM_DEFS[key], { type, definition }, key);
  }
  // Every advertised (type,name) resolves; no example-named or invented canonical survives.
  for (const [type, names] of Object.entries(SEARCH_PARAMS)) {
    for (const name of names) {
      const declared = searchParamDeclaration(type, name);
      assert.ok(declared.definition, `${type}.${name} must declare a canonical definition`);
      assert.ok(!declared.definition!.includes('/example'), `${type}.${name} uses an example definition`);
      assert.notEqual(declared.definition, `${SP}/clinical-subject`, 'clinical-subject does not exist in R4');
    }
  }
  assert.equal(searchParamDeclaration('Observation', 'subject').type, 'reference');
});

test('M3b eval checks evaluate against bound evidence only', () => {
  const env = {
    schema_version: '0.3', request_id: 'r', source: { alias: 'eval', fhir_version: '4.0.1', capability_revision: 'x' },
    context: { handle: 'ctx', mode: 'patient-bound', policy_revision: 'synthetic-v1' },
    data: { resources: [{ resourceType: 'Observation', id: 'o1', meta: { versionId: '3' }, valueQuantity: { value: 7 } }] },
    provenance: [{ resource_index: 0, retrieved_at: '2025-01-01T00:00:00Z' }],
    coverage: { state: 'unknown', scope: 'page', reasons: ['FILTER_EXECUTION_UNVERIFIED'], query_exhausted: null, sort: { requested: ['-date'], effective: null, order: 'requested_unverified' } },
    transform: { format: 'fhir', projected: false, withheld_payloads: [] }, warnings: [],
    budget: { bytes_returned: 10, byte_limit: 24576, limit_reached: false, upstream_calls: 1, elapsed_ms: 1 },
  } as unknown as GatewayEnvelope;
  const evidence = collectEvidence([env]);
  assert.equal(evaluateCheck({ kind: 'citationTuple', id: 'c', step: 0, resource_type: 'Observation', id_value: 'o1', source: 'eval', version: '3' }, 'fhir', evidence).status, 'pass');
  assert.equal(evaluateCheck({ kind: 'citationTuple', id: 'c', step: 0, resource_type: 'Observation', id_value: 'o1', source: 'eval', version: '9' }, 'fhir', evidence).status, 'fail');
  assert.equal(evaluateCheck({ kind: 'sortEvidence', id: 's', step: 0, requested: ['-date'], effective: null, order: 'requested_unverified' }, 'fhir', evidence).status, 'pass');
  assert.equal(evaluateCheck({ kind: 'queryEvidence', id: 'q', step: 0, state: 'unknown', query_exhausted: null, reasons_include: ['FILTER_EXECUTION_UNVERIFIED'] }, 'fhir', evidence).status, 'pass');
  const measured = measureCatalog([{ name: 'fhir_read' }], SERVER_INSTRUCTIONS, OUTPUT_SPINE);
  assert.equal(measured.tokenAcceptance, 'unmeasured');
  assert.equal(measured.listedSchemaBytes, 97);
  assert.match(measured.completeSha256, /^[a-f0-9]{64}$/);
});

test('decimalLexeme reads raw wire text bound to resource and path (G-3 negatives)', () => {
  const base = {
    schema_version: '0.1', request_id: 'r', source: { alias: 'eval', fhir_version: '4.0.1', capability_revision: 'x' },
    context: { handle: 'ctx', mode: 'patient-bound', policy_revision: 'synthetic-v1' },
    coverage: { state: 'unknown', scope: 'page', reasons: [] },
    transform: { format: 'fhir', projected: false, withheld_payloads: [] }, warnings: [],
    budget: { bytes_returned: 10, byte_limit: 24576, limit_reached: false, upstream_calls: 1, elapsed_ms: 1 },
  };
  const env = { ...base, data: { resources: [{ resourceType: 'Observation', id: 'o1', valueQuantity: { value: 5 } }, { resourceType: 'Observation', id: 'o2', valueQuantity: { value: 7 } }] } } as unknown as GatewayEnvelope;
  const raw = JSON.stringify({ structuredContent: { data: { resources: [{ resourceType: 'Observation', id: 'o1', valueQuantity: { value: 5 } }, { resourceType: 'Observation', id: 'o2', valueQuantity: { value: 7 } }] } } });
  const withRaw = collectEvidence([env], [], { rawResults: [raw] });
  const check = { kind: 'decimalLexeme' as const, id: 'd', step: 0, resource_type: 'Observation', id_value: 'o1', path: 'valueQuantity.value', equals: '7' };
  assert.equal(evaluateCheck(check, 'fhir', withRaw).status, 'fail', 'o2 lexeme must not satisfy o1');
  assert.equal(evaluateCheck({ ...check, equals: '5' }, 'fhir', withRaw).status, 'pass');
  // Genuine 7.0 lexeme survives only in raw text; decoded evidence alone must fail, raw must pass.
  const raw70 = '{"structuredContent":{"data":{"resources":[{"resourceType":"Observation","id":"o3","valueQuantity":{"value":7.0}}]}}}';
  const env70 = { ...base, data: { resources: [{ resourceType: 'Observation', id: 'o3', valueQuantity: { value: 7 } }] } } as unknown as GatewayEnvelope;
  const check70 = { kind: 'decimalLexeme' as const, id: 'd', step: 0, resource_type: 'Observation', id_value: 'o3', path: 'valueQuantity.value', equals: '7.0' };
  assert.equal(evaluateCheck(check70, 'fhir', collectEvidence([env70], [], { rawResults: [raw70] })).status, 'pass');
  assert.equal(evaluateCheck(check70, 'fhir', collectEvidence([env70])).status, 'fail', 'no raw capture, no pass');
  assert.equal(evaluateCheck({ ...check70, equals: '7' }, 'fhir', collectEvidence([env70], [], { rawResults: [raw70] })).status, 'fail', 'rounded token must not match');
});

test('citationTuple accepts valid 0.2 envelopes; response_index follows §9 (G-3)', () => {
  const v2 = {
    schema_version: '0.3', request_id: 'r', source: { alias: 'eval', fhir_version: '4.0.1', capability_revision: 'x' },
    context: { handle: 'ctx', mode: 'patient-bound', policy_revision: 'synthetic-v1' },
    data: { resources: [{ resourceType: 'Observation', id: 'o1', meta: { versionId: '3' } }] },
    provenance: [{ resource_index: 0, retrieved_at: '2025-01-01T00:00:00Z' }],
    coverage: { state: 'unknown', scope: 'page', reasons: [] },
    transform: { format: 'fhir', projected: false, withheld_payloads: [] }, warnings: [],
    budget: { bytes_returned: 10, byte_limit: 24576, limit_reached: false, upstream_calls: 1, elapsed_ms: 1 },
  } as unknown as GatewayEnvelope;
  const evidence = collectEvidence([v2]);
  assert.equal(evaluateCheck({ kind: 'citationTuple', id: 'c', step: 0, resource_type: 'Observation', id_value: 'o1', source: 'eval', version: '3' }, 'fhir', evidence).status, 'pass');
  assert.equal(evaluateCheck({ kind: 'citationTuple', id: 'c', step: 0, resource_type: 'Observation', id_value: 'o1', source: 'eval', version: null }, 'fhir', evidence).status, 'fail', 'version null requires explicit absence');
  // R2-6: the 0.2 citation must be backed by a provenance entry pointing at the cited resource.
  const cite = { kind: 'citationTuple' as const, id: 'c', step: 0, resource_type: 'Observation', id_value: 'o1', source: 'eval', version: '3' as string | null };
  const omitted = { ...v2, provenance: [] } as unknown as GatewayEnvelope;
  assert.equal(evaluateCheck(cite, 'fhir', collectEvidence([omitted])).status, 'fail', 'provenance omitting the cited resource must fail');
  const away = {
    ...v2,
    data: { resources: [{ resourceType: 'Observation', id: 'o1', meta: { versionId: '3' } }, { resourceType: 'Observation', id: 'o2', meta: { versionId: '3' } }] },
    provenance: [{ resource_index: 1, retrieved_at: '2025-01-01T00:00:00Z' }],
  } as unknown as GatewayEnvelope;
  assert.equal(evaluateCheck(cite, 'fhir', collectEvidence([away])).status, 'fail', 'provenance pointing at another resource must fail');
  assert.equal(evaluateCheck({ ...cite, id_value: 'o2' }, 'fhir', collectEvidence([away])).status, 'pass', 'control: the pointed-at resource passes');
  const outOfRange = { ...v2, provenance: [{ resource_index: 5, retrieved_at: '2025-01-01T00:00:00Z' }] } as unknown as GatewayEnvelope;
  assert.equal(evaluateCheck(cite, 'fhir', collectEvidence([outOfRange])).status, 'fail', 'out-of-range resource_index must fail');
  // response_index: omitted = first response only for M3b kinds; 'all' = each must pass.
  const empty = { ...v2, data: { resources: [] }, provenance: [] } as unknown as GatewayEnvelope;
  const citation = { kind: 'citationTuple' as const, id: 'c', step: 0, resource_type: 'Observation', id_value: 'o1', source: 'eval', version: '3' as string | null };
  assert.equal(evaluateBoundCheck(citation, 'fhir', [empty, v2], []).status, 'fail', 'omitted index must not search later responses');
  assert.equal(evaluateBoundCheck({ ...citation, response_index: 1 }, 'fhir', [empty, v2], []).status, 'pass');
  assert.equal(evaluateBoundCheck({ ...citation, response_index: 'all' }, 'fhir', [v2, empty], []).status, 'fail', "'all' requires every response");
  assert.equal(evaluateBoundCheck({ ...citation, response_index: 'all' }, 'fhir', [v2, v2], []).status, 'pass');
  assert.equal(evaluateBoundCheck({ ...citation, response_index: 'all' }, 'fhir', [], []).status, 'fail', "'all' requires at least one response");
  // callOutcome protocol classes come from recorded outcomes.
  const outcomeCheck = { kind: 'callOutcome' as const, id: 'o', step: 0, outcome: 'json_rpc_error' as const, code: -32602 };
  assert.equal(evaluateBoundCheck(outcomeCheck, 'fhir', [], [], { callOutcomes: [{ class: 'json_rpc_error', code: -32602 }] }).status, 'pass');
  assert.equal(evaluateBoundCheck(outcomeCheck, 'fhir', [v2], []).status, 'fail');
});

test('FHIR date precision intervals follow R4, not Date.parse (G-12)', () => {
  const day = parseFhirDateInterval('2025-02-10')!;
  assert.equal(day.end - day.start, 86400000);
  assert.equal(parseFhirDateInterval('2025-02')!.end - parseFhirDateInterval('2025-02')!.start, 28 * 86400000);
  assert.equal(parseFhirDateInterval('2025-02-30'), undefined, 'impossible dates rejected');
  assert.equal(parseFhirDateInterval('2025-13-01'), undefined);
  assert.equal(parseFhirDateInterval('not-a-date'), undefined);
  const instant = parseFhirDateInterval('2025-02-10T08:00:00.000Z')!;
  assert.equal(instant.end - instant.start, 1);
  assert.equal(fhirDateSearchMatches(instant, '2025-02-10'), true, 'eq day contains the instant');
  assert.equal(fhirDateSearchMatches(instant, 'eq2025-02-11'), false);
  assert.equal(fhirDateSearchMatches(instant, 'ge2025-02-10'), true);
  assert.equal(fhirDateSearchMatches(instant, 'ge2025-02-11'), false);
  assert.equal(fhirDateSearchMatches(instant, 'lt2025-02-11'), true);
  assert.equal(fhirDateSearchMatches(instant, 'lt2025-02-10'), false, 'same-day instant is not before the day');
  assert.equal(fhirDateSearchMatches(day, '2025-02'), true, 'month eq contains the day');
  assert.equal(fhirDateSearchMatches(day, 'ne2025-02'), false);
  // Zone offsets shift the interval, not the wall-clock text.
  const zoned = parseFhirDateInterval('2025-02-10T00:30:00+01:00')!;
  assert.equal(fhirDateSearchMatches(zoned, '2025-02-09'), true);
  assert.equal(fhirDateSearchMatches(zoned, '2025-02-10'), false);
});

test('FHIR date prefixes follow R4 gt/lt vs sa/eb semantics (R2-4 reviewer vectors)', () => {
  const period = (start: string, end: string) => ({ start: parseFhirDateInterval(start)!.start, end: parseFhirDateInterval(end)!.end });
  const year2020 = parseFhirDateInterval('2020')!;
  // Reviewer probe vectors (probe-dates): gt/lt test extension beyond S, not entirety.
  assert.equal(fhirDateSearchMatches(period('2020-06', '2021-03'), 'gt2020'), true, 'Period 2020-06..2021-03 extends above 2020');
  assert.equal(fhirDateSearchMatches(period('2020-06', '2021-03'), 'sa2020'), false, 'same Period does not start after 2020');
  assert.equal(fhirDateSearchMatches(year2020, 'gt2020-06-01'), true, 'year 2020 extends above 2020-06-01');
  assert.equal(fhirDateSearchMatches(year2020, 'lt2020-06-01'), true, 'year 2020 extends below 2020-06-01');
  assert.equal(fhirDateSearchMatches(year2020, 'sa2020-06-01'), false);
  assert.equal(fhirDateSearchMatches(year2020, 'eb2020-06-01'), false);
  assert.equal(fhirDateSearchMatches(period('2019-06', '2020-06'), 'ge2020'), false, 'straddling Period is neither gt nor eq for 2020');
  assert.equal(fhirDateSearchMatches(period('2020-06', '2021-06'), 'le2020'), false, 'straddling Period is neither lt nor eq for 2020');
  // R4-derived: ge/le are exactly gt/lt plus eq; sa/eb are the strict entirety forms.
  const day = parseFhirDateInterval('2020-06-15')!;
  assert.equal(fhirDateSearchMatches(day, 'ge2020-06'), true, 'eq inside the month makes ge');
  assert.equal(fhirDateSearchMatches(day, 'le2020-06'), true, 'eq inside the month makes le');
  assert.equal(fhirDateSearchMatches(day, 'gt2020-06'), false, 'contained day does not extend above the month');
  assert.equal(fhirDateSearchMatches(day, 'lt2020-06'), false, 'contained day does not extend below the month');
  assert.equal(fhirDateSearchMatches(day, 'sa2020-06-14'), true, 'starts at the end of the prior day');
  assert.equal(fhirDateSearchMatches(day, 'eb2020-06-16'), true, 'ends at the start of the next day');
  assert.equal(fhirDateSearchMatches(day, 'sa2020-06-15'), false);
  assert.equal(fhirDateSearchMatches(day, 'eb2020-06-15'), false);
  assert.equal(fhirDateSearchMatches(day, 'gt2020-06-15'), false, 'identical intervals: not gt');
  assert.equal(fhirDateSearchMatches(day, 'ge2020-06-15'), true, 'identical intervals: eq makes ge');
  assert.equal(fhirDateSearchMatches(day, 'le2020-06-15'), true, 'identical intervals: eq makes le');
  assert.equal(fhirDateSearchMatches(day, 'ne2020-06-15'), false);
  assert.equal(fhirDateSearchMatches(day, 'ne2020-06-16'), true);
  // ap stays unsupported (§7): refused (never matches), even on exact overlap.
  assert.equal(fhirDateSearchMatches(day, 'ap2020-06-15'), false, 'ap unsupported');
  assert.equal(fhirDateSearchMatches(day, 'ap2020-06'), false, 'ap unsupported at coarse precision');
  // Open-ended Periods are unbounded (R2-4), via the fixture candidate interval.
  const openEnd = candidateInterval({ resourceType: 'Observation', id: 'p1', effectivePeriod: { start: '2020-06-01' } }, 'date')!;
  assert.equal(openEnd.end, Number.POSITIVE_INFINITY);
  assert.equal(fhirDateSearchMatches(openEnd, 'gt2030'), true, 'open end extends above any finite bound');
  assert.equal(fhirDateSearchMatches(openEnd, 'lt2019'), false);
  assert.equal(fhirDateSearchMatches(openEnd, 'sa2020-01-01'), true);
  const openStart = candidateInterval({ resourceType: 'Observation', id: 'p2', effectivePeriod: { end: '2020-06-01' } }, 'date')!;
  assert.equal(openStart.start, Number.NEGATIVE_INFINITY);
  assert.equal(fhirDateSearchMatches(openStart, 'lt2019'), true, 'open start extends below any finite bound');
  assert.equal(fhirDateSearchMatches(openStart, 'eb2020-06-02'), true);
});

// --- Import graph (G-11/R2-5): every relative module/data load form counts. ---
function extractRelativeSpecifiers(text: string): string[] {
  const specs: string[] = [];
  const push = (spec: string | undefined) => { if (spec && (spec.startsWith('./') || spec.startsWith('../'))) specs.push(spec); };
  // import ... from 'x' | import type ... from 'x' | bare side-effect import 'x'
  for (const m of text.matchAll(/\bimport\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?(['"`])(\.\.?\/[^'"`]+)\1/g)) push(m[2]);
  // export * from 'x' | export {..} from 'x' | export type .. from 'x'
  for (const m of text.matchAll(/\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+(['"`])(\.\.?\/[^'"`]+)\1/g)) push(m[2]);
  // dynamic import('x') and require('x')
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*(['"`])(\.\.?\/[^'"`]+)\1\s*\)/g)) push(m[2]);
  // fs reads and URL-relative data loads on relative paths (incl. subdirectories/.json)
  for (const m of text.matchAll(/\b(?:readFileSync|readFile|createReadStream)\s*\(\s*(['"`])(\.\.?\/[^'"`]+)\1/g)) push(m[2]);
  for (const m of text.matchAll(/\bnew\s+URL\s*\(\s*(['"`])(\.\.?\/[^'"`]+)\1/g)) push(m[2]);
  // R3-L7: computed paths (path.join segments, fileURLToPath, cwd-relative
  // reads) hide the './' prefix, so any quoted literal naming a Q-owned
  // basename — alone or as the last path segment — also counts as a load.
  const qBasenames: ReadonlySet<string> = new Set(Q_OWNED_BASENAMES_SCAN);
  for (const m of text.matchAll(/(['"`])([^'"`\n]+)\1/g)) {
    const literal = m[2]!;
    const basename = literal.split('/').at(-1)!;
    if (qBasenames.has(basename)) push(basename.endsWith('.json') ? `./data/${basename}` : `./${basename}`);
  }
  return specs;
}
const Q_OWNED_BASENAMES_SCAN = ['query.ts', 'query.js', 'search-parameters.ts', 'search-parameters.js', 'discovery.ts', 'discovery.js', 'support.ts', 'support.js', 'r4-search-parameters.json', 'search-profiles.json', 'support-matrix.json'] as const;
function resolveSpecifier(fromFile: string, spec: string): string {
  const parts = fromFile.split('/').slice(0, -1);
  for (const segment of spec.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') { if (parts.length) parts.pop(); else parts.push('..'); }
    else parts.push(segment);
  }
  const joined = parts.join('/');
  if (joined.endsWith('.js')) return `${joined.slice(0, -3)}.ts`;
  if (joined.endsWith('.mjs')) return `${joined.slice(0, -4)}.mts`;
  if (!/\.[A-Za-z0-9]+$/.test(joined)) return `${joined}.ts`;
  return joined;
}
function buildImportGraph(sources: ReadonlyMap<string, string>): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const [file, text] of sources) {
    graph.set(file, file.endsWith('.json') ? [] : extractRelativeSpecifiers(text).map(spec => resolveSpecifier(file, spec)));
  }
  return graph;
}
const Q_OWNED_FILES = new Set(['query.ts', 'search-parameters.ts', 'discovery.ts', 'support.ts', 'generated/r4-search-parameters.json']);
const Q_OWNED_BASENAMES = new Set(['r4-search-parameters.json', 'search-profiles.json', 'support-matrix.json']);
const isQOwned = (path: string): boolean => Q_OWNED_FILES.has(path) || Q_OWNED_BASENAMES.has(path.split('/').at(-1)!);
const P_OWNED_FILES = ['projection.ts', 'delivery.ts', 'repairs.ts'];
const P_OWNED_DATA_BASENAMES = new Set(['delivery-profiles.json', 'host-profiles.json']);
function pImportViolations(graph: ReadonlyMap<string, string[]>, pSources: readonly string[]): string[] {
  const violations: string[] = [];
  const closure = (start: string): Set<string> => {
    const seen = new Set<string>(); const stack = [start];
    while (stack.length) { const next = stack.pop()!; if (seen.has(next)) continue; seen.add(next); for (const dep of graph.get(next) ?? []) stack.push(dep); }
    return seen;
  };
  for (const file of pSources) {
    for (const reached of closure(file)) if (isQOwned(reached)) violations.push(`${file} transitively imports Q-owned ${reached}`);
  }
  return violations;
}

test('import-graph detector catches every P->Q bypass form (R2-5 self-tests)', () => {
  const base = (): Map<string, string> => new Map([
    ['projection.ts', ''], ['query.ts', ''], ['catalog.ts', ''], ['contracts.ts', ''],
    ['generated/r4-search-parameters.json', '{}'], ['data/support-matrix.json', '{}'],
  ]);
  const caught = (label: string, source: string, extra?: [string, string]) => {
    const sources = base();
    sources.set('projection.ts', source);
    if (extra) sources.set(extra[0], extra[1]);
    assert.ok(pImportViolations(buildImportGraph(sources), ['projection.ts']).length > 0, label);
  };
  caught('side-effect import', `import './query.js';`);
  caught('named import', `import { x } from './query.js';`);
  caught('type import', `import type { T } from "./query.js";`);
  caught('export star', `export * from './query.js';`);
  caught('export named', `export { x } from './query.js';`);
  caught('dynamic import', `const m = await import('./query.js');`);
  caught('dynamic import template', 'const m = await import(`./query.js`);');
  caught('require', `const m = require('./query.js');`);
  caught('JSON import in subdirectory', `import d from './generated/r4-search-parameters.json' with { type: 'json' };`);
  caught('JSON data import', `import d from './data/support-matrix.json' with { type: 'json' };`);
  caught('path traversal normalization', `import { x } from './sub/../query.js';`);
  caught('extensionless import', `import { x } from './query';`);
  caught('fs read of Q data', `import { readFileSync } from 'node:fs';\nconst d = readFileSync('./data/support-matrix.json', 'utf8');`);
  caught('path.join segments naming Q data (R3-L7)', `import { join } from 'node:path';\nconst d = readFileSync(join(dir, 'data', 'support-matrix.json'), 'utf8');`);
  caught('fileURLToPath + join naming Q module (R3-L7)', `import { fileURLToPath } from 'node:url';\nconst p = join(dirname(fileURLToPath(import.meta.url)), 'query.js');`);
  caught('cwd-relative read without ./ prefix (R3-L7)', `const d = readFileSync('packages/core/src/data/search-profiles.json', 'utf8');`);
  caught('transitive through shared file', `import './catalog.js';`, ['catalog.ts', `import './query.js';`]);
  const clean = base();
  clean.set('projection.ts', `import type { T } from './contracts.js';`);
  clean.set('contracts.ts', `import { x } from './decimal.js';`);
  clean.set('decimal.ts', '');
  assert.deepEqual(pImportViolations(buildImportGraph(clean), ['projection.ts']), [], 'shared contracts imports stay clean');
});

test('P never imports Q, even transitively (G-11/R2-5 import graph)', () => {
  const dir = join(process.cwd(), 'packages/core/src');
  const sources = new Map<string, string>();
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.json')) sources.set(child, entry.name.endsWith('.json') ? '' : readFileSync(join(dir, child), 'utf8'));
    }
  };
  walk('');
  const graph = buildImportGraph(sources);
  for (const file of P_OWNED_FILES) assert.ok(graph.has(file), `${file} must exist`);
  // P-owned sources include P data files when present on disk.
  const pSources = [...P_OWNED_FILES, ...[...graph.keys()].filter(f => P_OWNED_DATA_BASENAMES.has(f.split('/').at(-1)!))];
  assert.deepEqual(pImportViolations(graph, pSources), []);
  // m3b.ts is types-only after the split.
  const m3bText = readFileSync(join(dir, 'm3b.ts'), 'utf8');
  assert.ok(!/export\s+function/.test(m3bText), 'm3b.ts must stay types-only');
  assert.ok(m3bText.includes('nonContinuable') && m3bText.includes('refused'), '§7 flags frozen');
});

// --- R2-3: the generated public contract must stay in sync with the code. ---
test('docs/contracts/m3b-tools.json is generator-synced and matches the code (R2-3)', () => {
  const root = process.cwd();
  const out = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/emit-m3b-contract.mjs', '--check'], { cwd: root, encoding: 'utf8', timeout: 120000 });
  assert.match(out, /in sync/);
  const contract = JSON.parse(readFileSync(join(root, 'docs/contracts/m3b-tools.json'), 'utf8')) as Record<string, any>;
  assert.equal(contract.contract, 'm3b-tools/1');
  assert.equal(contract.m3b_schema_version, '0.3');
  assert.equal(contract.runtime_schema_version, '0.3');
  assert.equal(contract.catalog_version, CATALOG_VERSION);
  assert.deepEqual({ name: contract.server.name, version: contract.server.version }, SERVER_IDENTITY);
  assert.ok(!('current_01_envelope_schema' in contract.enforced));
  assert.ok(!('interim_core_gate' in contract.enforced));
  assert.equal(contract.instructions, SERVER_INSTRUCTIONS);
  assert.deepEqual(contract.catalog_caps.bytes, CATALOG_BYTE_CAPS);
  assert.deepEqual(contract.catalog_caps.tokens_per_encoding, CATALOG_TOKEN_CAPS);
  assert.deepEqual(contract.enforced.spine, OUTPUT_SPINE, 'published spine equals the code');
  assert.deepEqual(contract.listed.output_schema, LISTED_OUTPUT_SCHEMA);
  assert.equal(contract.listed.output_schema_bytes, 97);
  assert.deepEqual(contract.fault_codes, FAULT_CODES);
  assert.deepEqual(Object.keys(contract.repair_table).sort(), [...FAULT_CODES].sort());
  for (const code of FAULT_CODES) assert.deepEqual(contract.repair_table[code], REPAIR_TABLE[code] ?? null, `repair ${code}`);
  assert.deepEqual(contract.listed.tools.map((t: any) => t.name), TOOL_NAMES);
  for (const name of TOOL_NAMES) {
    const entry = contract.listed.tools.find((t: any) => t.name === name);
    assert.equal(entry.title, TOOL_DESCRIPTIONS[name].title, name);
    assert.equal(entry.description, TOOL_DESCRIPTIONS[name].description, name);
    assert.deepEqual(entry.output_schema, LISTED_OUTPUT_SCHEMA, name);
    const listedInput = listedInputSchemaV2(name);
    assert.deepEqual(entry.input_schema, listedInput, `${name} listed input schema equals the code`);
    assert.ok(contract.enforced.v2_inputs[name] && contract.enforced.v2_envelopes[name], `${name} v2 schemas published`);
  }
  assert.ok(contract.enforced.v2_cross_field_refinements.length >= 10, 'active cross-field rules published');
  assert.match(contract.enforced.core_gate.composition, /validateDeliverable02/);
  assert.ok(contract.history.every((r: unknown) => typeof r === 'string'), 'history is prose only');
  assert.ok(contract.migration_rules.some((r: string) => r.includes('protocolEra')), 'migration rules published');
  // Section hashes recompute from the file content (canonical sorted-key JSON).
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  };
  const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
  assert.equal(contract.hashes.spine_sha256, sha(OUTPUT_SPINE), 'spine hash matches the code');
  assert.equal(contract.hashes.listed_sha256, sha(contract.listed), 'listed hash matches the file');
  assert.equal(contract.hashes.enforced_sha256, sha(contract.enforced), 'enforced hash matches the file');
  const { contract_sha256, ...body } = contract;
  assert.equal(contract_sha256, sha(body), 'whole-contract hash matches the file');
});

// --- G-15: textMode:'summary' is rejected unconditionally (P fix round). ---
test('G-15 contract: summary always rejected; envelope always conflicts with structured delivery', () => {
  assert.ok(!readFileSync(join(process.cwd(), 'packages/core/src/delivery.ts'), 'utf8').includes('TODO(G-15'), 'deferral TODO removed');
  assert.equal(HOST_PROFILE_REGISTRY.filter(e => e.verification === 'verified' && e.delivery_profile === 'structured-evidence-v1').length, 0, 'shipped registry still has zero verified cells');
  const base = { mode: 'synthetic', source: { alias: 'local', baseUrl: 'http://127.0.0.1:9/fhir' }, patientId: 'synthetic-patient-a' } as const;
  // Unconditional: summary alone is refused even with zero verified shipped cells.
  assert.throws(() => new FhirGateway({ ...base, textMode: 'summary' }), /delivery\.profile/);
  assert.throws(() => new FhirGateway({ ...base, textMode: 'summary', delivery: { profile: 'full-text-v1' } }), /delivery\.profile/);
  const verifiedEntry: HostProfileEntry = {
    id: 'fixture-host', version: '1', host: { name: 'fixture', version: '1', client_stack: 'sdk', client_stack_version: '2.3.1' },
    era: 'modern', transport: 'stdio', workflow: 'recent-labs-v1', delivery_profile: 'structured-evidence-v1', verification: 'verified',
  };
  assert.throws(
    () => new FhirGateway({ ...base, textMode: 'summary' }, { testDeliveryRegistryOverride: { profileId: 'fixture-host', entries: [verifiedEntry] } }),
    /delivery\.profile/,
  );
  // R2-2: envelope + structured is ALWAYS a conflict, with or without a
  // verified cell. The no-cell case may surface either the conflict or the
  // unverified-profile refusal; the verified-cell case below discriminates
  // the conflict rule itself (K28): without it, construction would succeed.
  assert.throws(() => new FhirGateway({ ...base, textMode: 'envelope', delivery: { profile: 'structured-evidence-v1', hostProfileId: 'fixture-host' } }), /delivery\.profile|verified host profile/);
  assert.throws(
    () => new FhirGateway(
      { ...base, textMode: 'envelope', delivery: { profile: 'structured-evidence-v1', hostProfileId: 'fixture-host' } },
      { testDeliveryRegistryOverride: { profileId: 'fixture-host', entries: [verifiedEntry] } },
    ),
    /textMode:'envelope' conflicts/,
    'R2-2/K28: a verified cell never exempts the envelope+structured conflict',
  );
  // The same verified structured setup without textMode still constructs:
  // only the conflicting old/new combination is refused.
  const verifiedGateway = new FhirGateway(
    { ...base, delivery: { profile: 'structured-evidence-v1', hostProfileId: 'fixture-host' } },
    { testDeliveryRegistryOverride: { profileId: 'fixture-host', entries: [verifiedEntry] } },
  );
  try { assert.equal(verifiedGateway.deliveryProfile, 'structured-evidence-v1'); } finally { verifiedGateway.close(); }
  // Plain envelope (the deprecated full-text alias) still constructs.
  const envelopeGateway = new FhirGateway({ ...base, textMode: 'envelope' });
  try { assert.equal(envelopeGateway.textMode, 'envelope'); } finally { envelopeGateway.close(); }
});
