import { createHash } from 'node:crypto';
import { z } from 'zod';
import { toWireValue } from './decimal.js';
import { WARNING_MESSAGES } from './catalog.js';

export const TOOL_NAMES = ['fhir_capabilities', 'fhir_search', 'fhir_read', 'fhir_page', 'fhir_result'] as const;
export type ToolName = typeof TOOL_NAMES[number];
export type FhirResource = Record<string, unknown> & { resourceType: string; id?: string };

export interface GatewayConfig {
  mode: 'synthetic';
  /** Shipped search-profile allowlist (G-15): the eligible registry profiles (`generic-r4` and, since S6, the qualified synthetic fixture profile). */
  source: { alias: string; baseUrl: string; /** One of `eligibleSearchProfileIds()`; the config schema enforces the closed set (S6). */ searchProfile?: string; auth?: {
    type: 'client_credentials'; tokenUrl: string; clientId: string; clientSecretEnv: string; scopes?: string[];
  } };
  patientId: string;
  /** Trusted operator policy; never supplied by tool arguments. Empty by default. */
  privacy?: { patientIdentifierSystems?: string[] };
  contextId?: string;
  // Gate F/G-10: constructor era selection (`protocolEra`) was removed. Era is
  // supplied per call (`ExecuteOptions.era`, required for adapter calls); direct
  // library calls default conservatively to `modern`, the larger wire shape.
  /** Trusted operator choice (J-5): default `envelope` text is the serialized bounded envelope; `summary` is concise but still carries cursor/handle/expiry/warnings/manifest reasons/error. */
  textMode?: 'envelope' | 'summary';
  /** M3b trusted options (frozen at gate F; behavior lands with Q/P/R). Never model-controlled. */
  workflow?: 'recent-labs-v1';
  delivery?: { profile?: 'full-text-v1' | 'structured-evidence-v1'; hostProfileId?: string };
  discovery?: { metadataTtlMs?: number; snapshotBytes?: number; maxHandles?: number };
  limits?: {
    defaultBytes?: number;
    maxBytes?: number;
    upstreamBytes?: number;
    retentionBytes?: number;
    ttlMs?: number;
    timeoutMs?: number;
    maxHandles?: number;
    /** Overall per-tool deadline (J-22); default 45s, hard-capped at 200s. */
    deadlineMs?: number;
    maxQueue?: number;
  };
}

export type GatewayEnvelope = GatewayEnvelope02;

export interface AuditEvent {
  request_id: string;
  tool: ToolName;
  source: string;
  outcome: 'allowed' | 'denied' | 'failed';
  code?: string;
  /** Precise pre-mapping fault (`CODE` or `CODE:status`) when the public code was uniformized (J-15). Metadata only: never a body, credential, or identifier. */
  cause?: string;
  timestamp: string;
}

export const toMcpToolResult = toMcpToolResult02;

// ===========================================================================
// M3b schema-0.2 serving contracts (S5.8 coordinated listing/artifact switch).
// ===========================================================================

/** Coordinated M3b application schema version (spec §0.3), independent of MCP era. */
export const M3B_SCHEMA_VERSION = '0.3' as const;
/** R-1 planning estimate, retained for history. Superseded by the decision-round measurement below. */
export const BYTES_PER_TOKEN_ASSUMPTION = 3.5;
/**
 * Decision-round tokenizer measurement (Addendum B / gpt-catalog-decision, 2026-10-19):
 * tiktoken 0.12.0 in a temporary environment, cl100k_base + o200k_base, network disabled.
 * The full-spine M3b skeleton measured 16,393 B / 4,056 worst-case tokens, an implied
 * o200k ratio of 4.04 B/token (not the 3.5 B/token planning estimate). No tokenizer is
 * installed in this repo; release token acceptance still needs the checked-in pin (root/R).
 */
export const MEASURED_BYTES_PER_TOKEN_O200K = 4.04;
export const CATALOG_TOKEN_MEASUREMENT = {
  encodings: ['cl100k_base', 'o200k_base'],
  fullSpineSkeletonBytes: 16393, fullSpineWorstTokens: 4056,
  minimalSkeletonBytes: 6933, minimalWorstTokens: 1826,
  bytesPerTokenO200k: MEASURED_BYTES_PER_TOKEN_O200K,
} as const;
export const TOKEN_ACCEPTANCE_STATUS = 'unmeasured' as const;
/** Listed-catalog byte caps (Addendum B.2), complete compact-JSON tool objects. */
export const CATALOG_BYTE_CAPS = { fhir_capabilities: 2200, fhir_search: 1750, fhir_read: 1400, fhir_page: 1100, fhir_result: 1650, toolsTotal: 8100, instructions: 160, instructionsAndWrapper: 350, complete: 8450, outputSpine: 2000, listedOutputSchema: 100 } as const;
/** Per-encoding token caps (Addendum B.2). Frozen; enforced once the pinned tokenizer gate lands (root/R). */
export const CATALOG_TOKEN_CAPS = { fhir_capabilities: 650, fhir_search: 500, fhir_read: 400, fhir_page: 325, fhir_result: 475, toolsTotal: 2350, instructionsAndWrapper: 150, complete: 2500 } as const;
/**
 * Listed output schema (Addendum B.1, option (c)): exactly this 97 B object on each
 * implemented tool. Additional properties stay allowed; the full spine/strict
 * contracts are published and enforced in core, not listed five times.
 */
export const LISTED_OUTPUT_SCHEMA = { type: 'object', required: ['schema_version'], properties: { schema_version: { type: 'string' } } } as const;

export const resourceTypeSchema = z.string().regex(/^[A-Z][A-Za-z0-9]+$/).max(80);
export const handleSchema = z.string().min(1).max(160);
export const sourceAliasSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const nonnegativeIntSchema = z.number().int().min(0);
export const isoDatetimeSchema = z.iso.datetime({ offset: true }).max(40);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const fhirResourceObjectSchema = z.looseObject({ resourceType: resourceTypeSchema, id: z.string().max(64).optional() });
export const fieldPathSchema = z.string().min(1).max(256).regex(/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/)
  .refine(p => p.split('.').length <= 8 && !p.split('.').some(s => ['__proto__', 'prototype', 'constructor'].includes(s)), 'unsafe field path');
export const fieldsSchema = z.array(fieldPathSchema).min(1).max(30);
export const pairSchema = z.strictObject({ name: z.string().min(1).max(160), value: z.string().min(1).max(2048) });
export const evidenceSchema = z.enum(['declared', 'observed_supported', 'observed_unsupported', 'unknown']);
export const outputV2Schema = z.strictObject({
  format: z.enum(['compact', 'fhir']).optional(),
  fields: fieldsSchema.optional(),
  max_bytes: z.number().int().min(4096).max(131072).optional(),
}).optional();
export const repairSchema = z.strictObject({
  action: z.enum(['discover_search_parameter', 'discover_schema', 'inspect_observed_codes', 'choose_supported_resource', 'narrow_query', 'increase_budget', 'repeat_original_query', 'use_current_context']),
  tool: z.enum(TOOL_NAMES).optional(),
  resource_type: resourceTypeSchema.optional(),
  parameter: z.string().regex(/^_?[A-Za-z][A-Za-z0-9_-]{0,79}$/).optional(),
  fields: fieldsSchema.optional(),
  max_bytes: z.number().int().min(4096).max(131072).optional(),
  page_size: z.number().int().min(1).max(100).optional(),
  max_pages: z.number().int().min(1).max(3).optional(),
  max_calls: z.number().int().min(1).max(4).optional(),
});
export type Repair = z.infer<typeof repairSchema>;
export const warningSchema = z.strictObject({ code: z.string().min(1).max(80), message: z.string().max(320), repair: repairSchema.optional() });
export const errorV2Schema = z.strictObject({ code: z.string().min(1).max(80), safe_message: z.string().max(320), retryable: z.boolean(), repair: repairSchema.optional() });

/** Strict M3b capabilities input (spec §1/§6); every listed topic is implemented. */
export const fhirCapabilitiesV2InputSchema = z.strictObject({
  source: sourceAliasSchema.optional(), context_handle: handleSchema.optional(), output: outputV2Schema,
  topic: z.enum(['server', 'resource', 'context', 'schema', 'search_parameter', 'support']).default('server'),
  resource_type: resourceTypeSchema.optional(),
  path: z.union([z.literal(''), fieldPathSchema]).default(''),
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
  name: z.string().regex(/^_?[A-Za-z][A-Za-z0-9_-]{0,79}$/).optional(),
  query: z.string().min(1).max(120).optional(),
  cursor: handleSchema.optional(),
});
/**
 * Strict M3b input schemas for the five implemented tools (spec §0.3/§1).
 * Listing adds guidance through a permissive SDK wrapper; core admission and
 * these schemas/refinements remain the argument-validation authority.
 */
export const toolInputV2Schemas = {
  fhir_capabilities: fhirCapabilitiesV2InputSchema,
  fhir_search: z.strictObject({ source: sourceAliasSchema.optional(), context_handle: handleSchema.optional(), output: outputV2Schema, resource_type: resourceTypeSchema, params: z.array(pairSchema).max(30).default([]), page_size: z.number().int().min(1).max(100).default(20) }),
  fhir_read: z.strictObject({ source: sourceAliasSchema.optional(), context_handle: handleSchema.optional(), output: outputV2Schema, resource_type: resourceTypeSchema, id: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/), interaction: z.literal('read').default('read') }),
  fhir_page: z.strictObject({ cursor: handleSchema, context_handle: handleSchema.optional(), output: outputV2Schema }),
  fhir_result: z.strictObject({ handle: handleSchema, context_handle: handleSchema.optional(), action: z.enum(['inspect', 'project', 'page']).default('inspect'), fields: fieldsSchema.optional(), offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(100).default(20), output: outputV2Schema }),
} as const;

/** Topic/field combination rules (spec §1); returns a fixed reason or undefined. Never echoes values. */
export function capabilitiesCombinationFault(v: { topic?: string; resource_type?: string; path?: string; offset?: number; name?: string; query?: string; cursor?: string }): string | undefined {
  if (v.name !== undefined && v.query !== undefined) return 'name and query are mutually exclusive';
  if (v.topic !== 'schema' && ((v.path ?? '') !== '' || (v.offset ?? 0) !== 0)) return 'path/offset apply only to topic=schema';
  if (v.topic !== 'search_parameter' && (v.name !== undefined || v.query !== undefined)) return 'name/query apply only to topic=search_parameter';
  if (v.cursor !== undefined && v.topic !== 'search_parameter' && v.topic !== 'support' && v.topic !== 'server') return 'cursor applies only to discovery topics';
  if (v.topic === 'search_parameter' && v.cursor === undefined && !v.resource_type) return 'search_parameter requires resource_type on the first call';
  if (v.cursor !== undefined && (v.resource_type !== undefined || v.name !== undefined || v.query !== undefined)) return 'a discovery continuation cannot change its filter';
  return undefined;
}

export const sortEvidenceSchema = z.strictObject({
  requested: z.array(z.string().max(80)).max(4).optional(),
  effective: z.array(z.string().max(80)).max(4).nullable(),
  evidence: evidenceSchema,
  order: z.enum(['unspecified', 'requested_unverified', 'verified_by_adapter']),
});
export const constraintEvidenceSchema = z.strictObject({
  name: z.string().min(1).max(160), value: z.string().min(1).max(2048),
  source_reported: z.enum(['matched', 'not_reported', 'not_checked']),
  execution: z.enum(['gateway_enforced', 'tested_adapter', 'unknown']),
  evidence_ref: z.string().max(120).optional(),
});
export const coverageV2Schema = z.strictObject({
  state: z.enum(['complete_for_query', 'partial', 'unknown']),
  scope: z.enum(['query', 'page', 'metadata', 'resource', 'retained']),
  reasons: z.array(z.string().max(80)).max(32),
  authorization_limited: z.boolean(),
  query_exhausted: z.boolean().nullable(), pages_observed: nonnegativeIntSchema,
  constraints: z.array(constraintEvidenceSchema).max(31).optional(),
  query_digest: sha256Schema.optional(),
  constraints_on_first_page: z.literal(true).optional(),
  sort: sortEvidenceSchema.optional(),
  query_evidence: z.enum(['none', 'metadata_snapshot', 'exact_id_and_subject_linkage', 'declared_and_self_link_only', 'tested_adapter', 'unverified_continuation', 'retained_snapshot']),
});
export type CoverageV2 = z.infer<typeof coverageV2Schema>;

export const resourceDataSchema = z.strictObject({
  resources: z.array(fhirResourceObjectSchema).max(100),
  next_offset: z.number().int().min(0).max(100000).optional(),
  manifest: z.strictObject({ reason: z.literal('RESOURCE_EXCEEDS_INLINE_BUDGET'), action: z.string().max(320) }).optional(),
});
export const retainedInspectionSchema = z.strictObject({
  resource_count: nonnegativeIntSchema,
  scope: z.literal('retained_upstream_page'),
  upstream_pages_remain: z.boolean().nullable(),
  formats: z.array(z.enum(['compact', 'fhir'])).min(1).max(2),
  omissions: z.array(z.strictObject({
    resource_index: nonnegativeIntSchema, resource_type: resourceTypeSchema,
    id: z.string().max(64).optional(), version: z.string().max(64).optional(),
    recipe_id: z.string().max(120).optional(),
    omitted_fields: z.array(z.string().max(512)),
    withheld_reasons: z.array(z.string().max(80)),
    interpretation: z.enum(['clinical_projection', 'structural']),
  })).max(100),
  next_offset: nonnegativeIntSchema.optional(),
});
const classificationShape = { network_confinement: z.literal('literal_loopback'), data_classification: z.literal('operator_declared_synthetic_unverified') };
const classNameSchema = z.enum(['patient', 'shared', 'ambiguous']);
export const schemaDataSchema = z.strictObject({
  resource_type: resourceTypeSchema, path: z.union([z.literal(''), fieldPathSchema]),
  definition: z.string().max(512),
  schema: z.strictObject({ package: z.literal('hl7.fhir.r4.core'), version: z.literal('4.0.1'), source_url: z.string().max(512), source_sha256: sha256Schema, definitions: nonnegativeIntSchema }),
  evidence: z.literal('pinned_base_definition'), profile_validation: z.literal('not_performed'),
  total_elements: nonnegativeIntSchema,
  elements: z.array(z.strictObject({
    path: z.string().max(512), min: nonnegativeIntSchema, max: z.string().max(16),
    types: z.array(z.string().max(80)).max(64), modifier: z.boolean().optional(),
    content_reference: z.string().max(512).optional(), short: z.string().max(240).optional(),
    binding: z.strictObject({ strength: z.string().max(40).optional(), valueSet: z.string().max(512) }).optional(),
    targets: z.array(z.string().max(512)).max(160).optional(),
    json_names: z.array(z.string().max(80)).max(64).optional(),
  })).max(50),
  next_offset: nonnegativeIntSchema.optional(),
});
export const serverDataSchema = z.strictObject({
  source: sourceAliasSchema, fhir_version: z.string().max(40), patient_id: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/), ...classificationShape,
  implemented_tools: z.array(z.enum(TOOL_NAMES)).length(5),
  resources: z.array(z.strictObject({ type: resourceTypeSchema, resource_class: classNameSchema, implemented_interactions: z.array(z.enum(['read', 'search-type'])).max(2) })).max(100),
  resource_count: nonnegativeIntSchema, definition_limit: z.literal(100),
  snapshot_revision: z.string().max(80), captured_at: isoDatetimeSchema, expires_at: isoDatetimeSchema, next_cursor: handleSchema.optional(),
  workflow: z.literal('recent-labs-v1'), support_matrix_revision: z.string().max(80),
  required_resources: z.tuple([z.literal('Patient'), z.literal('Observation')]),
  document_support: z.literal('metadata_only'),
});
export const contextDataSchema = z.strictObject({
  mode: z.literal('patient-bound'), context_handle: handleSchema,
  patient_id: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/), ...classificationShape,
  support_matrix_revision: z.string().max(80),
});
export const resourceCapabilityDataSchema = z.strictObject({
  type: resourceTypeSchema, interactions: z.array(z.string().max(40)).max(16),
  searchParameters: z.array(z.string().max(80)).max(256),
  resource_class: classNameSchema, evidence: z.literal('declared'),
  implemented_interactions: z.array(z.enum(['read', 'search-type'])).max(2),
  instance_policy: z.string().max(120), compact_recipe: z.string().max(120).nullable(),
  limitations: z.array(z.string().max(160)).max(16),
  support_matrix_revision: z.string().max(80), ...classificationShape,
});
const syntaxSupportSchema = z.strictObject({ name: z.string().max(80), evidence: evidenceSchema, executable: z.boolean() });
export const searchParameterSchema = z.strictObject({
  name: z.string().max(80),
  type: z.enum(['number', 'date', 'string', 'token', 'reference', 'composite', 'quantity', 'uri', 'special', 'unknown']),
  definition: z.string().max(512).optional(), definition_version: z.string().max(80).optional(),
  definition_evidence: z.enum(['pinned_r4', 'approved_overlay', 'source_declared', 'unresolved', 'conflict']),
  targets: z.array(resourceTypeSchema).max(32),
  description: z.string().max(240), source_description_present: z.boolean(),
  evidence: evidenceSchema, executable: z.boolean(),
  modifiers: z.array(syntaxSupportSchema).max(16), comparators: z.array(syntaxSupportSchema).max(16),
  repetition: z.strictObject({ and: evidenceSchema, or: evidenceSchema }),
  joins: z.strictObject({ chain: z.literal(false), has: z.literal(false), include: z.literal(false), revinclude: z.literal(false) }),
  execution_evidence: evidenceSchema,
});
export const searchParameterDataSchema = z.strictObject({
  resource_type: resourceTypeSchema, search_parameters: z.array(searchParameterSchema).max(50),
  total_parameters: z.number().int().min(0), snapshot_revision: z.string().max(80),
  captured_at: isoDatetimeSchema, expires_at: isoDatetimeSchema, next_cursor: handleSchema.optional(),
  definitions: z.strictObject({ package: z.literal('hl7.fhir.r4.core'), version: z.literal('4.0.1'), source_sha256: sha256Schema }),
});
export const supportRowSchema = z.strictObject({
  resource_type: resourceTypeSchema,
  policy_class: z.enum(['patient', 'conditional_shared', 'denied']),
  patient_link: z.string().max(80).nullable(), source_advertised: z.boolean(),
  advertised_interactions: z.array(z.string().max(40)).max(16),
  policy_interactions: z.array(z.enum(['read', 'search-type'])).max(2),
  executable_interactions: z.array(z.enum(['read', 'search-type'])).max(2),
  instance_policy: z.string().max(120), compact_recipe: z.string().max(120).nullable(),
  workflow_role: z.enum(['required', 'optional', 'outside_workflow']),
  limitations: z.array(z.string().max(160)).max(16),
});
export const supportDataSchema = z.strictObject({
  workflow: z.literal('recent-labs-v1'), matrix_revision: z.string().max(80),
  rows: z.array(supportRowSchema).max(25), snapshot_revision: z.string().max(80),
  captured_at: isoDatetimeSchema, expires_at: isoDatetimeSchema, next_cursor: handleSchema.optional(),
  default_policy: z.literal('deny_unclassified'),
  clinical_sections: z.array(z.string().max(80)).max(8),
  document_support: z.literal('metadata_only'),
});

export function makeEnvelopeSchema(dataSchema: z.ZodType) {
  return z.strictObject({
    schema_version: z.literal(M3B_SCHEMA_VERSION), request_id: z.string().max(80),
    source: z.strictObject({ alias: sourceAliasSchema, fhir_version: z.string().max(40), capability_revision: z.string().max(80) }),
    context: z.strictObject({ handle: handleSchema, mode: z.literal('patient-bound'), policy_revision: z.string().max(80) }),
    data: dataSchema,
    provenance: z.array(z.strictObject({ resource_index: z.number().int().min(0).max(99), retrieved_at: isoDatetimeSchema })).max(100).optional(),
    coverage: coverageV2Schema,
    pagination: z.strictObject({
      has_more: z.boolean().nullable(), next_cursor: handleSchema.optional(),
      returned_matches: z.number().int().min(0).max(100), returned_includes: z.literal(0),
      requested_page_size: z.number().int().min(1).max(100).optional(),
      total: z.strictObject({ value: nonnegativeIntSchema.optional(), precision: z.enum(['accurate', 'estimate', 'unknown']) }).optional(),
    }).optional(),
    transform: z.strictObject({
      format: z.enum(['compact', 'fhir']), requested_format: z.enum(['compact', 'fhir']).optional(),
      projected: z.boolean(), withheld_payloads: z.array(z.record(z.string(), z.unknown())),
      omitted_fields: z.array(z.string().max(512)), unresolved_fields: z.array(fieldPathSchema),
      narrative_omitted: z.boolean(), recipe_ids: z.array(z.string().max(120)),
      structural_resource_indices: z.array(z.number().int().min(0).max(99)),
      delivery_profile: z.enum(['full-text-v1', 'structured-evidence-v1']),
    }),
    warnings: z.array(warningSchema).max(32),
    budget: z.strictObject({ bytes_returned: nonnegativeIntSchema, byte_limit: z.number().int().min(4096).max(131072), limit_reached: z.boolean(), upstream_calls: nonnegativeIntSchema, elapsed_ms: nonnegativeIntSchema }),
    result: z.strictObject({ handle: handleSchema, expires_at: isoDatetimeSchema, formats: z.array(z.enum(['compact', 'fhir'])).min(1).max(2) }).optional(),
    error: errorV2Schema.optional(),
  }).superRefine((env, ctx) => {
    const data = env.data as { resources?: unknown[] } | undefined;
    if (env.error && (data?.resources?.length || env.provenance || env.result || env.pagination)) ctx.addIssue({ code: 'custom', message: 'error envelope cannot carry resources/provenance/result/pagination' });
    if (env.provenance) {
      const seen = new Set<number>();
      for (const entry of env.provenance) {
        if (seen.has(entry.resource_index) || !data?.resources || entry.resource_index >= data.resources.length) ctx.addIssue({ code: 'custom', message: 'provenance indexes must be unique and in range' });
        seen.add(entry.resource_index);
      }
    }
    if (env.pagination?.next_cursor && env.pagination.has_more !== true) ctx.addIssue({ code: 'custom', message: 'next_cursor requires has_more=true' });
  });
}
const capabilitiesDataSchema = z.union([serverDataSchema, contextDataSchema, resourceCapabilityDataSchema, schemaDataSchema, searchParameterDataSchema, supportDataSchema]);
export const toolEnvelopeV2Schemas = {
  fhir_capabilities: makeEnvelopeSchema(z.union([capabilitiesDataSchema, z.strictObject({})])),
  fhir_search: makeEnvelopeSchema(z.union([resourceDataSchema, z.strictObject({})])),
  fhir_read: makeEnvelopeSchema(z.union([resourceDataSchema, z.strictObject({})])),
  fhir_page: makeEnvelopeSchema(z.union([resourceDataSchema, z.strictObject({})])),
  fhir_result: makeEnvelopeSchema(z.union([resourceDataSchema, retainedInspectionSchema, z.strictObject({})])),
} as const;
export const envelopeV2Schema = z.union([toolEnvelopeV2Schemas.fhir_capabilities, toolEnvelopeV2Schemas.fhir_search, toolEnvelopeV2Schemas.fhir_read, toolEnvelopeV2Schemas.fhir_page, toolEnvelopeV2Schemas.fhir_result]);

/** Schema-0.2 serving aliases; deprecated listing schemas above are independent. */
export const toolSchemas02 = toolInputV2Schemas;
export const envelopeSchema02 = envelopeV2Schema;
export type ToolInput02<T extends ToolName = ToolName> = z.infer<(typeof toolInputV2Schemas)[T]>;
export type ToolEnvelope02<T extends ToolName = ToolName> = z.infer<(typeof toolEnvelopeV2Schemas)[T]>;
export type GatewayEnvelope02 = Omit<z.infer<typeof envelopeV2Schema>, 'data'> & { data: Record<string, unknown> };

/** Inert full-envelope serializer preparation. SDK era additions/accounting and
 * structured rendering belong to S5.6. Never selects a profile or emits summary.
 * The final boundary retains original FHIR numeric lexemes in both channels. */
export function toMcpToolResult02(envelope: GatewayEnvelope02) {
  const wire = toWireValue(envelope) as Record<string, unknown>;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(wire) }],
    structuredContent: wire,
    ...(envelope.error ? { isError: true } : {}),
  };
}

/** Published output spine (spec §0.4 as revised by Addendum B): a correct superset of the enforced
 * contract, never the whole contract. It is no longer listed per tool (the listing carries the
 * 97 B minimal schema); it stays the published/core-validated spine within the 2,000 B cap.
 * Additional properties are allowed everywhere by JSON Schema default. */
export const OUTPUT_SPINE = {
  type: 'object',
  required: ['schema_version', 'request_id', 'source', 'context', 'data', 'coverage', 'transform', 'warnings', 'budget'],
  properties: {
    schema_version: { type: 'string' }, request_id: { type: 'string' },
    source: { type: 'object', properties: { alias: { type: 'string' }, fhir_version: { type: 'string' }, capability_revision: { type: 'string' } } },
    context: { type: 'object', properties: { handle: { type: 'string' }, mode: { type: 'string' }, policy_revision: { type: 'string' } } },
    data: { type: 'object' },
    provenance: { type: 'array', items: { type: 'object', properties: { resource_index: { type: 'integer' }, retrieved_at: { type: 'string' } } } },
    coverage: { type: 'object', properties: { state: { enum: ['complete_for_query', 'partial', 'unknown'] }, scope: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } } } },
    pagination: { type: 'object', properties: { has_more: { type: ['boolean', 'null'] }, next_cursor: { type: 'string' }, returned_matches: { type: 'integer' }, returned_includes: { type: 'integer' }, requested_page_size: { type: 'integer' }, total: { type: 'object', properties: { value: { type: 'integer' }, precision: { enum: ['accurate', 'estimate', 'unknown'] } } } } },
    transform: { type: 'object', properties: { format: { enum: ['compact', 'fhir'] }, projected: { type: 'boolean' }, delivery_profile: { enum: ['full-text-v1', 'structured-evidence-v1'] } } },
    warnings: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } },
    budget: { type: 'object', properties: { bytes_returned: { type: 'integer' }, byte_limit: { type: 'integer' }, limit_reached: { type: 'boolean' }, upstream_calls: { type: 'integer' }, elapsed_ms: { type: 'integer' } } },
    result: { type: 'object', properties: { handle: { type: 'string' }, expires_at: { type: 'string' }, formats: { type: 'array', items: { type: 'string' } } } },
    error: { type: 'object', properties: { code: { type: 'string' }, safe_message: { type: 'string' }, retryable: { type: 'boolean' } } },
  },
} as const;
/**
 * Pure validator for every property/type/enum declared in OUTPUT_SPINE (G-6).
 * Top-level `required` keys must be present; nested declared properties are
 * type/enum-checked whenever present (the spine allows additional properties
 * and does not require nested keys). Interim 0.1 envelopes omit 0.2-only
 * controls such as `transform.delivery_profile`; when present they must match.
 */
export function validateSpine(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const env = value as Record<string, unknown>;
  for (const key of OUTPUT_SPINE.required) if (!(key in env)) return false;
  const obj = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
  const str = (v: unknown) => v === undefined || typeof v === 'string';
  const int = (v: unknown) => v === undefined || Number.isInteger(v);
  if (typeof env.schema_version !== 'string' || typeof env.request_id !== 'string') return false;
  if (!obj(env.source) || !obj(env.context) || !obj(env.data) || !obj(env.coverage) || !obj(env.transform) || !obj(env.budget)) return false;
  if (!str(env.source.alias) || !str(env.source.fhir_version) || !str(env.source.capability_revision)) return false;
  if (!str(env.context.handle) || !str(env.context.mode) || !str(env.context.policy_revision)) return false;
  if (env.provenance !== undefined) {
    if (!Array.isArray(env.provenance)) return false;
    for (const entry of env.provenance) {
      if (!obj(entry) || !int(entry.resource_index) || !str(entry.retrieved_at)) return false;
    }
  }
  const coverage = env.coverage;
  if (!['complete_for_query', 'partial', 'unknown'].includes(String(coverage.state))) return false;
  if (typeof coverage.scope !== 'string' || !Array.isArray(coverage.reasons) || !coverage.reasons.every(r => typeof r === 'string')) return false;
  if (env.pagination !== undefined) {
    if (!obj(env.pagination)) return false;
    const page = env.pagination;
    if (page.has_more !== undefined && typeof page.has_more !== 'boolean' && page.has_more !== null) return false;
    if (!str(page.next_cursor) || !int(page.returned_matches) || !int(page.returned_includes) || !int(page.requested_page_size)) return false;
    if (page.total !== undefined) {
      if (!obj(page.total) || !int(page.total.value)) return false;
      if (page.total.precision !== undefined && !['accurate', 'estimate', 'unknown'].includes(String(page.total.precision))) return false;
    }
  }
  const transform = env.transform;
  if (!['compact', 'fhir'].includes(String(transform.format)) || typeof transform.projected !== 'boolean') return false;
  if (transform.delivery_profile !== undefined && !['full-text-v1', 'structured-evidence-v1'].includes(String(transform.delivery_profile))) return false;
  if (!Array.isArray(env.warnings)) return false;
  for (const warning of env.warnings) {
    if (!obj(warning) || typeof warning.code !== 'string' || typeof warning.message !== 'string') return false;
  }
  const budget = env.budget;
  if (![budget.bytes_returned, budget.byte_limit, budget.upstream_calls, budget.elapsed_ms].every(v => Number.isInteger(v)) || typeof budget.limit_reached !== 'boolean') return false;
  if (env.result !== undefined) {
    if (!obj(env.result) || !str(env.result.handle) || !str(env.result.expires_at)) return false;
    if (env.result.formats !== undefined && (!Array.isArray(env.result.formats) || !env.result.formats.every(f => typeof f === 'string'))) return false;
  }
  if (env.error !== undefined) {
    if (!obj(env.error) || typeof env.error.code !== 'string' || typeof env.error.safe_message !== 'string' || typeof env.error.retryable !== 'boolean') return false;
  }
  return true;
}
/** Trusted snapshot made by execute/render, never reconstructed from a candidate wire value.
 * S5.1 is inert: the producer/wiring lands later. Freeze this object and all
 * nested state (including the captured final SDK result) before validation.
 */
export type ValidationContext02 = Readonly<{
  era: 'modern' | 'legacy';
  deliveryProfile: 'full-text-v1' | 'structured-evidence-v1';
  renderedText: string;
  /** Complete result value, including the era-specific SDK additions, excluding JSON-RPC framing. */
  result: Readonly<{
    content: readonly Readonly<{ type: 'text'; text: string }>[];
    structuredContent: unknown;
    isError?: boolean;
    resultType?: 'complete';
    _meta?: Readonly<{ 'io.modelcontextprotocol/serverInfo': Readonly<{ name: string; version: string }> }>;
  }>;
  serverIdentity: Readonly<{ name: string; version: string }>;
  /** Effective request/config ceiling, resolved by admission, never wire-derived. */
  effectiveByteLimit?: number;
  binding?: Readonly<{ sourceAlias: string; fhirVersion: string; sourceRevision: string; policyRevision: string; contextHandle: string }>;
  readTarget?: Readonly<{ resourceType: string; id: string }>;
  resourceType?: string;
  path?: string;
  patientId?: string;
  formatSupplied?: boolean;
  requestedFormat?: 'compact' | 'fhir';
  /** Explicit selection takes precedence over a compact recipe. */
  selectedFields?: readonly string[];
  offset?: number;
  limit?: number;
  /** Original validated search count; never inferred from reported pagination. */
  requestedPageSize?: number;
  /** Immutable metadata packing authority, captured before candidate validation. */
  metadata?: Readonly<{
    topic: 'server' | 'search_parameter' | 'support' | 'schema';
    rows: readonly unknown[]; start: number; offset: number; total: number; limit: number; deliveredCount: number;
    nextCursor?: string; nextOffset?: number; revision?: string; capturedAt?: string; expiresAt?: string; byteLimited: boolean;
  }>;
  /** Search-chain history from the backing snapshot, not the current page. */
  chainDeliveredCount?: number;
  query?: Readonly<{
    resourceType: string;
    sourceRevision: string;
    policyRevision: string;
    contextHandle: string;
    orderedPairs: readonly Readonly<{ name: string; value: string }>[];
    sort: readonly string[];
    constraintProof?: readonly Readonly<{ execution: 'unknown' | 'gateway_enforced' | 'tested_adapter'; evidence_ref?: string }>[];
    /** S6: the chain's trusted current sort evidence; required whenever a sort was requested, on full and shorthand pages. */
    sortProof?: Readonly<{ order: 'unspecified' | 'requested_unverified' | 'verified_by_adapter'; effective: readonly string[] | null }>;
    /** S6: sticky chain flag; once a continuation could not be verified, no page may relabel or complete the chain. */
    continuationUnverified?: boolean;
    fullEvidenceRequired?: boolean;
  }>;
  /** Binds capabilities/result data to the invoked topic/action when available. */
  topic?: 'server' | 'resource' | 'context' | 'schema' | 'search_parameter' | 'support';
  action?: 'inspect' | 'project' | 'page';
}>;
export type ValidationResult02 = { ok: true } | { ok: false; reason:
  'INVALID_SHAPE' | 'INVALID_CROSS_FIELDS' | 'VALIDATION_CONTEXT_REQUIRED' |
  'VALIDATION_CONTEXT_MISMATCH' | 'INVALID_FINAL_BYTES' };

/** Reject accessors without invoking them; frozen containers alone are insufficient. */
function frozenValidationState02(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return true;
  if (seen.has(value) || !Object.isFrozen(value)) return false;
  seen.add(value);
  const valid = Reflect.ownKeys(value).every(key => {
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    return 'value' in d && !d.writable && frozenValidationState02(d.value, seen);
  });
  seen.delete(value);
  return valid;
}

/** Shared NO_MATCHES rule. `filtered` excludes subject, patient and _id on
 * every resource type. Only the gate's two reviewed reasons are eligible. */
export function noMatchesEligible(coverage: Pick<CoverageV2, 'query_exhausted' | 'query_evidence' | 'reasons'>, deliveredCount: number, filters: boolean | readonly { name: string }[]): boolean {
  // Boolean form is retained for the pure decision-table callers. Both wire
  // assembly and validation pass the actual original constraints.
  const filtered = typeof filters === 'boolean' ? filters : filters.some(pair => !['subject', 'patient', '_id'].includes(pair.name));
  return filtered && deliveredCount === 0 && coverage.query_exhausted === true
    && coverage.query_evidence !== 'none' && coverage.query_evidence !== 'unverified_continuation'
    && coverage.reasons.every(reason => ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN', 'FILTER_EXECUTION_UNVERIFIED'].includes(reason));
}

/** Strict per-tool v2 shape and semantic gate. Does not transform or repair wire.
 * Local invariants run even without context. Query identity cannot be proved
 * from a response alone: those checks fail closed if trusted query state is absent.
 */
export function validateCrossField02(tool: ToolName, wire: unknown, context?: ValidationContext02): ValidationResult02 {
  const fail = (reason: Exclude<ValidationResult02, { ok: true }>['reason'] = 'INVALID_CROSS_FIELDS'): ValidationResult02 => ({ ok: false, reason });
  try {
    const schema = toolEnvelopeV2Schemas[tool];
    if (!schema || !schema.safeParse(wire).success) return fail('INVALID_SHAPE');
    // Use the original value, never Zod's cloned/normalized result. In particular
    // raw JSON numeric leaves in FHIR bodies must retain their exact lexemes.
    const env = wire as z.infer<typeof toolEnvelopeV2Schemas.fhir_result>;
    const data = env.data as Record<string, unknown>;
    const c = env.coverage, t = env.transform, page = env.pagination;
    const unique = (xs: readonly unknown[]) => new Set(xs).size === xs.length;
    if (!unique(c.reasons) || !unique(t.recipe_ids) || !unique(t.omitted_fields) || !unique(t.unresolved_fields) || !unique(env.warnings.map(w => w.code))) return fail();
    if (t.omitted_fields.some((path, i, paths) => i > 0 && paths[i - 1]! > path)) return fail();
    const clinical = tool !== 'fhir_capabilities';
    if (c.authorization_limited !== clinical || (clinical && !c.reasons.includes('CLINICAL_RECORD_COMPLETENESS_UNKNOWN'))) return fail();
    // Spec §3 / integration-plan G-16: the sole reviewed variant is required
    // for unverified filter execution. Keep repairs out of this import graph.
    const noMatchesMessage = WARNING_MESSAGES.NO_MATCHES + (c.reasons.includes('FILTER_EXECUTION_UNVERIFIED') ? ' Filter execution is not verified.' : '');
    if (env.warnings.some(w => !Object.hasOwn(WARNING_MESSAGES, w.code) || w.message !== (w.code === 'NO_MATCHES' ? noMatchesMessage : WARNING_MESSAGES[w.code]))) return fail();
    if (context?.binding) {
      const b = context.binding;
      if (env.source.alias !== b.sourceAlias || env.source.fhir_version !== b.fhirVersion) return fail('VALIDATION_CONTEXT_MISMATCH');
      // Search revision/handle binding is checked against the original query below.
      if ((!context.query || env.error) && (env.source.capability_revision !== b.sourceRevision || env.context.policy_revision !== b.policyRevision || env.context.handle !== b.contextHandle)) return fail('VALIDATION_CONTEXT_MISMATCH');
    }
    if (context?.formatSupplied !== undefined && (t.requested_format !== (context.formatSupplied ? context.requestedFormat : undefined) || t.format !== (context.requestedFormat ?? 'fhir'))) return fail('VALIDATION_CONTEXT_MISMATCH');
    if (env.error) {
      if (!(FAULT_CODES as readonly string[]).includes(env.error.code) || env.warnings.length || c.query_evidence !== 'none' || c.reasons.some(r => r !== 'CLINICAL_RECORD_COMPLETENESS_UNKNOWN' && r !== env.error!.code)) return fail();
      if (c.scope !== (clinical ? 'query' : 'metadata') || env.warnings.some(w => w.code === 'NO_MATCHES' || w.code === 'ORDER_UNVERIFIED')) return fail();
      if (Object.keys(data).length || env.provenance !== undefined || env.result !== undefined || page !== undefined) return fail();
      if (c.state !== 'unknown' || c.query_exhausted !== null || c.pages_observed !== 0 || c.constraints !== undefined || c.query_digest !== undefined || c.sort !== undefined || c.constraints_on_first_page !== undefined) return fail();
      if (t.projected || t.narrative_omitted || t.withheld_payloads.length || t.omitted_fields.length || t.unresolved_fields.length || t.recipe_ids.length || t.structural_resource_indices.length) return fail();
      return { ok: true };
    }
    if (c.query_evidence === 'none') return fail();
    if (!Object.keys(data).length) return fail(); // strict {} is for errors only
    const resources = Array.isArray(data.resources) && tool !== 'fhir_capabilities' ? data.resources as FhirResource[] : undefined;
    if (tool !== 'fhir_capabilities' && env.warnings.some(w => w.code === 'METADATA_BYTE_LIMIT')) return fail();
    const inspection = tool === 'fhir_result' && 'omissions' in data;
    if (!env.result && data.manifest && typeof data.manifest === 'object' && /fhir_result/i.test(String((data.manifest as { action?: unknown }).action ?? ''))) return fail();
    if (inspection && data.upstream_pages_remain === false && c.reasons.some(reason => ['CONTINUATION_QUERY_UNVERIFIED', 'NON_CONTINUABLE_UPSTREAM_LINK', 'SOURCE_REPORTED_INCOMPLETE'].includes(reason))) return fail();
    const count = resources?.length ?? 0;
    if (resources) {
      if ((env.provenance?.length ?? 0) !== count) return fail();
      const indices = env.provenance?.map(p => p.resource_index) ?? [];
      if (!unique(indices) || indices.some(i => i < 0 || i >= count)) return fail();
      if (!page || page.returned_matches !== count || page.returned_includes !== 0) return fail();
      if (resources.some(r => r.resourceType !== resources[0]?.resourceType)) return fail();
      if (!unique(resources.map(r => JSON.stringify([r.resourceType, r.id, r.meta && typeof r.meta === 'object' ? (r.meta as Record<string, unknown>).versionId : undefined])))) return fail();
      if (page.requested_page_size !== undefined && count > page.requested_page_size) return fail();
      if (tool === 'fhir_read' && data.manifest !== undefined && count !== 0) return fail();
      if (tool === 'fhir_read' && context?.readTarget && resources.some(r => r.resourceType !== context.readTarget!.resourceType || r.id !== context.readTarget!.id)) return fail('VALIDATION_CONTEXT_MISMATCH');
      if (tool === 'fhir_read' && (count > 1 || (count === 0 && data.manifest === undefined))) return fail();
    } else if (env.provenance !== undefined || page !== undefined) return fail();
    const structural = t.structural_resource_indices;
    const structuralCount = inspection ? (data.omissions as unknown[]).length : count;
    if (!unique(structural) || structural.some(i => i >= structuralCount)) return fail();
    if ((structural.length > 0) !== env.warnings.some(w => w.code === 'UNINTERPRETED_MODIFIER')) return fail();
    if (t.recipe_ids.length && (!t.projected || t.format !== 'compact')) return fail();
    if (!inspection && resources?.some((_, i) => !structural.includes(i)) && !context?.selectedFields?.length && t.format === 'compact' && t.projected && !t.recipe_ids.length && !env.warnings.some(w => w.code === 'COMPACT_RECIPE_UNAVAILABLE')) return fail();
    const manifestKeys = ['path', 'reason', 'content_type', 'size', 'hash', 'count', 'spans'];
    if (t.withheld_payloads.some(m => typeof m.path !== 'string' || !m.path.startsWith('/') || typeof m.reason !== 'string' || !m.reason || Object.keys(m).some(k => !manifestKeys.includes(k)) ||
      (m.content_type !== undefined && typeof m.content_type !== 'string') || (m.hash !== undefined && typeof m.hash !== 'string') ||
      (m.size !== undefined && (typeof m.size !== 'number' || !Number.isSafeInteger(m.size) || m.size < 0)) ||
      (m.spans !== undefined && (m.reason !== 'PROTECTED_LINK_IN_TEXT' || typeof m.spans !== 'number' || !Number.isSafeInteger(m.spans) || m.spans < 1)) ||
      (m.count !== undefined && (typeof m.count !== 'number' || !Number.isSafeInteger(m.count) || m.count < 1)))) return fail();
    // S5b: a count marks a collapsed policy manifest; it is at least 2 and never travels with metadata, spans or extra keys.
    if (t.withheld_payloads.some(m => m.count !== undefined && ((m.count as number) < 2 || Object.keys(m).length !== 3))) return fail();
    // S5b review: a count never travels with a reason only the payload or in-text-link sites emit, and one
    // collapsed {path, reason} pair is delivered at most once.
    if (t.withheld_payloads.some(m => m.count !== undefined && ['V1_PAYLOAD_WITHHELD', 'PROTECTED_LINK_IN_TEXT'].includes(m.reason as string))) return fail();
    if (!unique(t.withheld_payloads.filter(m => m.count !== undefined).map(m => `${m.path}\u0000${m.reason}`))) return fail();
    if ((t.format === 'compact' && resources?.length || t.omitted_fields.length) && !t.projected) return fail();
    if (t.narrative_omitted && !t.omitted_fields.some(path => /\/text(?:\/|$)/.test(path))) return fail();
    if (tool !== 'fhir_result' && data.next_offset !== undefined && clinical) return fail();
    if (env.result && !unique(env.result.formats)) return fail();
    if (env.result && !env.result.formats.includes(t.format)) return fail();
    if (env.result && env.provenance?.some(p => Date.parse(p.retrieved_at) >= Date.parse(env.result!.expires_at))) return fail();
    if (inspection) {
      const d = data as z.infer<typeof retainedInspectionSchema>;
      if (!unique(d.formats) || !d.formats.includes(t.format) || d.omissions.length > d.resource_count) return fail();
      if (d.omissions.some((row, i) => row.resource_index !== i)) return fail(); // indexes the returned retained slice
      if (structural.some(i => d.omissions[i]?.interpretation !== 'structural') || d.omissions.some((row, i) => row.interpretation === 'structural' && !structural.includes(i))) return fail();
      if (env.result && JSON.stringify(env.result.formats) !== JSON.stringify(d.formats)) return fail();
      const offset = context?.offset ?? 0;
      if ((d.next_offset !== undefined) !== (offset + d.omissions.length < d.resource_count) || offset + d.omissions.length > d.resource_count || (context?.limit !== undefined && d.omissions.length > context.limit)) return fail();
      if (d.next_offset !== undefined && (d.next_offset !== offset + d.omissions.length || d.next_offset <= offset || d.next_offset >= d.resource_count)) return fail();
      if (d.upstream_pages_remain === true && c.reasons.includes('NON_CONTINUABLE_UPSTREAM_LINK')) return fail();
    }
    if (tool === 'fhir_capabilities') {
      if (c.scope !== 'metadata' || c.query_evidence !== 'metadata_snapshot' || c.pages_observed !== 0 || env.result || t.projected || t.withheld_payloads.length || t.omitted_fields.length || t.unresolved_fields.length || t.narrative_omitted || t.recipe_ids.length || structural.length) return fail();
      if (c.constraints !== undefined || c.query_digest !== undefined || c.sort !== undefined || c.constraints_on_first_page !== undefined) return fail();
      const topic = 'search_parameters' in data ? 'search_parameter' : 'rows' in data ? 'support' : 'elements' in data ? 'schema' : 'implemented_tools' in data ? 'server' : 'patient_id' in data ? 'context' : 'resource';
      if (context?.topic !== undefined && topic !== context.topic) return fail('VALIDATION_CONTEXT_MISMATCH');
      if (context?.resourceType !== undefined && (topic === 'resource' ? data.type : data.resource_type) !== context.resourceType && ['resource', 'schema', 'search_parameter'].includes(topic)) return fail('VALIDATION_CONTEXT_MISMATCH');
      const standing = 'DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION';
      const schemaCaveat = 'R4_BASE_DEFINITION_NOT_ENDPOINT_PROFILE_VALIDATION';
      const metadataReasons = topic === 'schema' ? [schemaCaveat, 'MORE_DEFINITION_ELEMENTS']
        : topic === 'server' ? [standing, 'CAPABILITY_SUMMARY_LIMIT']
        : topic === 'search_parameter' || topic === 'support' ? [standing, 'MORE_PAGES'] : [standing];
      if (c.reasons.some(reason => !metadataReasons.includes(reason))) return fail();
      if (!c.reasons.includes(topic === 'schema' ? schemaCaveat : standing)) return fail();
      if ((topic === 'context' || topic === 'server') && (!context?.patientId || data.patient_id !== context.patientId)) return fail('VALIDATION_CONTEXT_MISMATCH');
      if (topic === 'schema' && context?.path !== undefined && data.path !== context.path) return fail('VALIDATION_CONTEXT_MISMATCH');
      if (env.warnings.some(w => w.code === 'NO_MATCHES') || (typeof data.next_cursor === 'string' && data.next_cursor.startsWith('res_'))) return fail();
      if (data.next_offset !== undefined && (c.query_exhausted !== false || c.state !== 'partial')) return fail();
      if (topic === 'context' && data.context_handle !== env.context.handle) return fail();
      if (topic === 'server' && (data.source !== env.source.alias || data.fhir_version !== env.source.fhir_version)) return fail();
      if (topic === 'server' && (Number(data.resource_count) < (data.resources as unknown[]).length || !unique(data.implemented_tools as unknown[]))) return fail();
      if ('captured_at' in data && Date.parse(String(data.expires_at)) <= Date.parse(String(data.captured_at))) return fail();
      if (data.next_cursor !== undefined && (c.query_exhausted !== false || c.state !== 'partial')) return fail();
      if (c.state === 'complete_for_query' && (c.query_exhausted !== true || data.next_cursor !== undefined || data.next_offset !== undefined)) return fail();
      if (topic === 'search_parameter' && (data.search_parameters as unknown[]).length > Number(data.total_parameters)) return fail();
      if (['server', 'search_parameter', 'support', 'schema'].includes(topic)) {
        const m = context?.metadata;
        if (!m) return fail('VALIDATION_CONTEXT_REQUIRED');
        if (!frozenValidationState02(m) || m.topic !== topic || !Number.isSafeInteger(m.deliveredCount) || m.deliveredCount < 0 || m.deliveredCount > Math.min(m.limit, m.rows.length - m.start)) return fail('VALIDATION_CONTEXT_MISMATCH');
        const rows = data[topic === 'server' ? 'resources' : topic === 'search_parameter' ? 'search_parameters' : topic === 'support' ? 'rows' : 'elements'];
        if (JSON.stringify(rows) !== JSON.stringify(m.rows.slice(m.start, m.start + m.deliveredCount))) return fail('VALIDATION_CONTEXT_MISMATCH');
        if (m.total < m.offset + m.deliveredCount || (m.deliveredCount === 0 && m.offset < m.total)) return fail();
        const more = m.offset + m.deliveredCount < m.total;
        if (c.query_exhausted !== !more || c.state !== (more ? 'partial' : 'complete_for_query')) return fail();
        const moreReason = topic === 'schema' ? 'MORE_DEFINITION_ELEMENTS' : topic === 'server' ? 'CAPABILITY_SUMMARY_LIMIT' : 'MORE_PAGES';
        if (c.reasons.includes(moreReason) !== more) return fail();
        if (topic === 'schema') {
          if (data.next_offset !== (more ? m.offset + m.deliveredCount : undefined) || data.total_elements !== m.total) return fail();
        } else {
          if (m.nextOffset !== (more ? m.offset + m.deliveredCount : undefined)) return fail('VALIDATION_CONTEXT_MISMATCH');
          if (data.next_cursor !== m.nextCursor || more !== Boolean(m.nextCursor)) return fail();
          if (data.snapshot_revision !== m.revision || data.captured_at !== m.capturedAt || data.expires_at !== m.expiresAt || m.revision !== env.source.capability_revision) return fail('VALIDATION_CONTEXT_MISMATCH');
          if (topic === 'server' && data.resource_count !== m.total) return fail();
          if (topic === 'search_parameter' && data.total_parameters !== m.total) return fail();
        }
        if (m.byteLimited !== (m.deliveredCount < Math.min(m.limit, m.rows.length - m.start))) return fail();
        if (env.warnings.some(w => w.code === 'METADATA_BYTE_LIMIT') !== m.byteLimited || env.budget.limit_reached !== m.byteLimited) return fail();
      } else if (env.warnings.some(w => w.code === 'METADATA_BYTE_LIMIT')) return fail();
      return { ok: true };
    }
    if (tool === 'fhir_result') {
      if (c.scope !== 'retained' || c.state !== 'partial' || c.query_exhausted !== null || c.query_evidence !== 'retained_snapshot' || !c.reasons.includes('RETAINED_PAGE_IS_NOT_THE_ENTIRE_QUERY')) return fail();
      if (context?.action !== undefined && (context.action === 'inspect') !== inspection) return fail('VALIDATION_CONTEXT_MISMATCH');
      if (page?.next_cursor !== undefined) return fail();
      if (page && ((page.has_more === true) !== (data.next_offset !== undefined) || page.has_more === null)) return fail();
      if (!inspection && data.next_offset !== undefined && (data.next_offset !== (context?.offset ?? 0) + count || Number(data.next_offset) <= (context?.offset ?? 0))) return fail();
    } else if (tool === 'fhir_read') {
      if (page?.has_more !== false || page.next_cursor !== undefined) return fail();
      if (c.scope !== 'resource' || c.query_evidence !== 'exact_id_and_subject_linkage' || c.query_digest !== undefined || c.constraints !== undefined || c.sort !== undefined || c.constraints_on_first_page !== undefined) return fail();
    } else if (c.scope !== 'page' || c.query_evidence === 'metadata_snapshot' || c.query_evidence === 'retained_snapshot') return fail();
    if ((tool === 'fhir_search' || tool === 'fhir_page') && page?.has_more === false && c.reasons.includes('NON_CONTINUABLE_UPSTREAM_LINK')) return fail();
    if (page) {
      if (tool !== 'fhir_result' && (page.has_more === true) !== (page.next_cursor !== undefined)) return fail();
      if (page.next_cursor !== undefined && page.has_more !== true) return fail();
      if (tool !== 'fhir_result' && page.has_more !== false && c.state !== 'partial') return fail();
      if (tool !== 'fhir_result' && ((page.has_more === true && c.query_exhausted !== false) || (page.has_more === null && c.query_exhausted !== null) || (page.has_more === false && c.query_exhausted === false))) return fail();
      if (page.total?.value !== undefined && (page.total.value !== count || page.total.precision !== 'unknown' || page.has_more !== false || c.query_exhausted !== true)) return fail();
    }
    if (c.state === 'complete_for_query' && (c.query_exhausted !== true || page?.has_more !== false || env.budget.limit_reached || c.reasons.some(r => ['NON_CONTINUABLE_UPSTREAM_LINK', 'SOURCE_REPORTED_INCOMPLETE', 'UNSUPPORTED_PRECISION'].includes(r)))) return fail();
    if (c.state === 'complete_for_query' && (data.manifest !== undefined || c.reasons.some(r => ['OVERSIZED_RESOURCE', 'UNSUPPORTED_PRECISION', 'INVALID_RESOURCE_ID', 'ENTRY_ORIGIN_MISMATCH', 'FILTER_EXECUTION_UNVERIFIED'].includes(r)) || env.warnings.some(w => ['UNSUPPORTED_PRECISION', 'FILTER_EXECUTION_UNVERIFIED', 'CONTINUATION_QUERY_UNVERIFIED'].includes(w.code)))) return fail();
    const searchChain = tool === 'fhir_search' || tool === 'fhir_page' || context?.query !== undefined;
    if (!searchChain && (c.query_digest !== undefined || c.constraints !== undefined || c.constraints_on_first_page !== undefined || c.sort !== undefined)) return fail('VALIDATION_CONTEXT_REQUIRED');
    if (env.warnings.some(w => w.code === 'NO_MATCHES')) {
      if (!searchChain || tool === 'fhir_result' || page?.has_more !== false || env.budget.limit_reached || data.manifest !== undefined) return fail();
      if (!noMatchesEligible(c, count, context?.query?.orderedPairs ?? [])) return fail();
      if (context?.chainDeliveredCount === undefined) return fail('VALIDATION_CONTEXT_REQUIRED');
      if (context.chainDeliveredCount !== 0) return fail();
    }
    if (!searchChain) return { ok: true };
    if (count > 0 && c.pages_observed === 0) return fail();
    if (c.state === 'complete_for_query' && !['tested_adapter', 'exact_id_and_subject_linkage'].includes(c.query_evidence)) return fail();
    if (!c.query_digest) return fail();
    const shorthand = c.constraints_on_first_page === true;
    if (shorthand) {
      if (tool !== 'fhir_page' || context?.query?.fullEvidenceRequired === true || c.constraints !== undefined || c.sort?.requested !== undefined) return fail();
    } else if (!c.constraints || (c.sort && c.sort.requested === undefined)) return fail();
    if (c.sort) {
      const sort = c.sort;
      if (sort.order === 'requested_unverified' && (sort.evidence !== 'unknown' || sort.effective !== null || !env.warnings.some(w => w.code === 'ORDER_UNVERIFIED'))) return fail();
      if (sort.order !== 'requested_unverified' && env.warnings.some(w => w.code === 'ORDER_UNVERIFIED')) return fail();
      if (sort.order === 'verified_by_adapter' && (sort.evidence !== 'observed_supported' || !sort.effective?.length)) return fail();
      if (sort.order === 'unspecified' && (sort.evidence !== 'unknown' || sort.effective !== null || (sort.requested?.length ?? 0) > 0)) return fail();
    }
    if (c.constraints?.some(p => (p.execution === 'tested_adapter') !== (p.evidence_ref !== undefined))) return fail();
    if (c.query_evidence === 'exact_id_and_subject_linkage' && c.constraints?.some(p => p.execution !== 'gateway_enforced')) return fail();
    if (c.query_evidence === 'tested_adapter' && c.constraints && (!c.constraints.some(p => p.execution === 'tested_adapter') || c.constraints.some(p => p.execution === 'unknown'))) return fail();
    if (c.state === 'complete_for_query' && c.constraints?.some(p => p.execution === 'unknown')) return fail();
    if (tool === 'fhir_search' || tool === 'fhir_page') {
      if (!Number.isSafeInteger(context?.requestedPageSize) || context!.requestedPageSize! < 1 || context!.requestedPageSize! > 100) return fail('VALIDATION_CONTEXT_REQUIRED');
      if (page?.requested_page_size !== context!.requestedPageSize) return fail('VALIDATION_CONTEXT_MISMATCH');
    }
    if (!context?.query) return fail('VALIDATION_CONTEXT_REQUIRED');
    const q = context.query;
    if (!Array.isArray(q.orderedPairs) || !Array.isArray(q.sort) || typeof q.sourceRevision !== 'string' || typeof q.policyRevision !== 'string' || typeof q.contextHandle !== 'string') return fail('VALIDATION_CONTEXT_REQUIRED');
    if (!Object.isFrozen(context) || !frozenValidationState02(q)) return fail('VALIDATION_CONTEXT_MISMATCH');
    if (shorthand && c.state === 'complete_for_query' && (!q.constraintProof || q.constraintProof.length !== q.orderedPairs.length || q.constraintProof.some(p => p.execution === 'unknown' || (p.execution === 'tested_adapter' && !p.evidence_ref)))) return fail();
    if (c.constraints && (!q.constraintProof || q.constraintProof.length !== q.orderedPairs.length)) return fail('VALIDATION_CONTEXT_REQUIRED');
    if (c.constraints && c.constraints.some((p, index) => p.execution !== q.constraintProof![index]!.execution
      || p.evidence_ref !== q.constraintProof![index]!.evidence_ref)) return fail();
    if (c.state === 'complete_for_query' && (!q.constraintProof || q.constraintProof.length !== q.orderedPairs.length
      || q.constraintProof.some(p => p.execution === 'unknown' || (p.execution === 'tested_adapter' && !p.evidence_ref)))) return fail();
    // The trusted proof binds the evidence kind, completeness and the unverified-filter caveat whether or not
    // the response discloses its constraint list (shorthand pages, empty material sets).
    if (q.constraintProof) {
      const proof = q.constraintProof;
      if (c.query_evidence === 'exact_id_and_subject_linkage' && (!proof.length || proof.some(p => p.execution !== 'gateway_enforced'))) return fail();
      if (c.query_evidence === 'tested_adapter' && (!proof.some(p => p.execution === 'tested_adapter') || proof.some(p => p.execution === 'unknown'))) return fail();
      if (c.state === 'complete_for_query' && proof.some(p => p.execution === 'unknown')) return fail();
      if (proof.some(p => p.execution === 'unknown') && (!c.reasons.includes('FILTER_EXECUTION_UNVERIFIED') || !env.warnings.some(w => w.code === 'FILTER_EXECUTION_UNVERIFIED'))) return fail();
      // S6 mixed proof: the declared kind is the weakest-link label. A non-empty trusted set with no unknown
      // execution is linkage or tested_adapter, never declared; a mixed set keeps its honest per-constraint
      // executions under the declared kind (the per-index rule above binds the disclosed list to the proof).
      if (c.query_evidence === 'declared_and_self_link_only' && proof.length > 0 && !proof.some(p => p.execution === 'unknown')) return fail();
    } else if (c.state === 'complete_for_query' || c.query_evidence !== 'declared_and_self_link_only') return fail('VALIDATION_CONTEXT_REQUIRED');
    if (env.source.capability_revision !== q.sourceRevision || env.context.policy_revision !== q.policyRevision || env.context.handle !== q.contextHandle) return fail('VALIDATION_CONTEXT_MISMATCH');
    if (!resourceTypeSchema.safeParse(q.resourceType).success || q.orderedPairs.length > 31 || q.orderedPairs.some(p => !pairSchema.safeParse(p).success) || q.sort.length > 4) return fail('VALIDATION_CONTEXT_REQUIRED');
    if (resources?.some(r => r.resourceType !== q.resourceType)) return fail('VALIDATION_CONTEXT_MISMATCH');
    const pairs = q.orderedPairs.map(p => ({ name: p.name, value: p.value }));
    if (c.constraints && JSON.stringify(c.constraints.map(p => ({ name: p.name, value: p.value }))) !== JSON.stringify(pairs)) return fail('VALIDATION_CONTEXT_MISMATCH');
    if (!shorthand && JSON.stringify(c.sort?.requested ?? []) !== JSON.stringify(q.sort)) return fail('VALIDATION_CONTEXT_MISMATCH');
    if (q.sort.length && (!c.sort || c.sort.order === 'unspecified')) return fail();
    if (!q.sort.length && c.sort && c.sort.order !== 'unspecified') return fail();
    if (c.sort?.order === 'verified_by_adapter' && JSON.stringify(c.sort.effective) !== JSON.stringify(q.sort)) return fail();
    // S6: the trusted sort proof binds the disclosed order and effective keys on full and shorthand pages
    // (S5 review finding 2d); without it a requested sort cannot be validated.
    if (q.sort.length > 0 && !q.sortProof) return fail('VALIDATION_CONTEXT_REQUIRED');
    if (c.sort && q.sortProof && (c.sort.order !== q.sortProof.order || JSON.stringify(c.sort.effective ?? null) !== JSON.stringify(q.sortProof.effective ?? null))) return fail();
    // S6 review (finding 2): an unverified continuation is sticky for the chain; no later page relabels or completes it.
    if (q.continuationUnverified && c.scope === 'page' && (c.query_evidence !== 'unverified_continuation' || c.state === 'complete_for_query')) return fail();
    if (q.continuationUnverified && c.scope === 'page' && !page?.next_cursor && (page?.has_more !== null || c.query_exhausted !== null)) return fail();
    const digest = createHash('sha256').update(JSON.stringify({ v: 1, source_revision: q.sourceRevision, policy_revision: q.policyRevision, context_handle: q.contextHandle, resource_type: q.resourceType, constraints: pairs, sort: q.sort }), 'utf8').digest('hex');
    if (c.query_digest !== digest) return fail('VALIDATION_CONTEXT_MISMATCH');
    return { ok: true };
  } catch { return fail('INVALID_SHAPE'); }
}

/** Final v2 delivery gate. The complete, immutable SDK result is captured by
 * the caller; no era/profile/identity/query inputs are inferred from wire.
 * Context-free callers can use the semantic gate above, but cannot establish
 * final-result accounting. Never fix an understated count or return parsed data.
 */
export function validateDeliverable02(tool: ToolName, wire: unknown, context?: ValidationContext02): ValidationResult02 {
  const fail = (reason: Exclude<ValidationResult02, { ok: true }>['reason']): ValidationResult02 => ({ ok: false, reason });
  try {
    if (!validateSpine(wire) || !validateListedOutput(wire)) return fail('INVALID_SHAPE');
    const semantic = validateCrossField02(tool, wire, context);
    if (!semantic.ok) return semantic;
    if (!context || !context.result || !context.serverIdentity || typeof context.renderedText !== 'string' || !['modern', 'legacy'].includes(context.era) || !['full-text-v1', 'structured-evidence-v1'].includes(context.deliveryProfile)) return fail('VALIDATION_CONTEXT_REQUIRED');
    if (typeof context.serverIdentity.name !== 'string' || !context.serverIdentity.name || typeof context.serverIdentity.version !== 'string' || !context.serverIdentity.version || !Array.isArray(context.result.content) || !Object.hasOwn(context.result, 'structuredContent')) return fail('VALIDATION_CONTEXT_REQUIRED');
    const env = wire as z.infer<typeof toolEnvelopeV2Schemas.fhir_result>;
    if (!env.error && ((tool === 'fhir_capabilities' && context.topic === undefined) || (tool === 'fhir_result' && context.action === undefined))) return fail('VALIDATION_CONTEXT_REQUIRED');
    if (!context.binding || ['sourceAlias', 'fhirVersion', 'sourceRevision', 'policyRevision', 'contextHandle'].some(key => typeof context.binding![key as keyof NonNullable<ValidationContext02['binding']>] !== 'string' || !context.binding![key as keyof NonNullable<ValidationContext02['binding']>]) || !Number.isSafeInteger(context.effectiveByteLimit) || context.effectiveByteLimit! < 4096 || context.effectiveByteLimit! > 131072 || typeof context.formatSupplied !== 'boolean' || (context.formatSupplied && !['compact', 'fhir'].includes(context.requestedFormat!))) return fail('VALIDATION_CONTEXT_REQUIRED');
    if (!env.error && ((tool === 'fhir_read' && !context.readTarget) || (tool === 'fhir_result' && (context.offset === undefined || context.limit === undefined)) || (tool === 'fhir_capabilities' && ((['resource', 'schema', 'search_parameter'].includes(context.topic!) && !context.resourceType) || (context.topic === 'schema' && context.path === undefined) || (['context', 'server'].includes(context.topic!) && !context.patientId))))) return fail('VALIDATION_CONTEXT_REQUIRED');
    const result = context.result;
    // Freeze is recursive: a shallow-frozen object still admits stale-text or
    // accounting races through its children. rawJSON is already frozen by V8.
    if (!frozenValidationState02(context)) return fail('VALIDATION_CONTEXT_MISMATCH');
    if (env.transform.delivery_profile !== context.deliveryProfile || result.content.length !== 1 || result.content[0]?.type !== 'text' || result.content[0].text !== context.renderedText || result.isError !== (env.error ? true : undefined)) return fail('VALIDATION_CONTEXT_MISMATCH');
    // Diagnose candidate accounting before generic snapshot equality.
    const measured = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (measured !== env.budget.bytes_returned || measured > env.budget.byte_limit || measured > context.effectiveByteLimit! || env.budget.byte_limit > context.effectiveByteLimit!) return fail('INVALID_FINAL_BYTES');
    const serialized = JSON.stringify(wire);
    if (JSON.stringify(result.structuredContent) !== serialized) return fail('VALIDATION_CONTEXT_MISMATCH');
    const jsonLine = serialized.replace(/[\u2028\u2029\u0085]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    if (context.deliveryProfile === 'full-text-v1' && context.renderedText !== serialized && context.renderedText !== `delivery_profile: "full-text-v1"\n${jsonLine}`) return fail('VALIDATION_CONTEXT_MISMATCH');
    if (context.deliveryProfile === 'structured-evidence-v1' && !context.renderedText.startsWith('delivery_profile: "structured-evidence-v1"\n')) return fail('VALIDATION_CONTEXT_MISMATCH');
    const allowed = ['content', 'structuredContent', ...(env.error ? ['isError'] : []), ...(context.era === 'modern' ? ['resultType', '_meta'] : [])];
    if (Object.keys(result).some(key => !allowed.includes(key))) return fail('VALIDATION_CONTEXT_MISMATCH');
    if (context.era === 'modern' && (result.resultType !== 'complete' || JSON.stringify(result._meta) !== JSON.stringify({ 'io.modelcontextprotocol/serverInfo': context.serverIdentity }))) return fail('VALIDATION_CONTEXT_MISMATCH');
    return { ok: true };
  } catch { return fail('INVALID_SHAPE'); }
}
/** Validator for the listed minimal schema (Addendum B.1): object root + required string version. */
export function validateListedOutput(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).schema_version === 'string');
}
/** Custom Standard Schema wrappers for SDK 2.3.1 (spec §0.3/§0.4). */
export function permissiveInputSchema(listedJsonSchema: unknown) {
  return {
    '~standard': {
      version: 1 as const, vendor: 'fireboat',
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => listedJsonSchema, output: () => listedJsonSchema },
    },
  };
}
/** Published-spine wrapper. Retained for differential tests; no longer the listed schema (Addendum B). */
export function spineOutputSchema() {
  return {
    '~standard': {
      version: 1 as const, vendor: 'fireboat',
      validate: (value: unknown) => validateSpine(value) ? { value } : { issues: [{ message: 'output does not satisfy the published spine' }] },
      jsonSchema: { input: () => OUTPUT_SPINE, output: () => OUTPUT_SPINE },
    },
  };
}
/** Listed output wrapper (Addendum B.1): exactly the 97 B minimal schema. Core strict validation is separate. */
export function minimalOutputSchema() {
  return {
    '~standard': {
      version: 1 as const, vendor: 'fireboat',
      validate: (value: unknown) => validateListedOutput(value) ? { value } : { issues: [{ message: 'output does not satisfy the listed schema' }] },
      jsonSchema: { input: () => LISTED_OUTPUT_SCHEMA, output: () => LISTED_OUTPUT_SCHEMA },
    },
  };
}

/** Exhaustive public fault registry (gate-F item 2). New codes must be added here first. */
export const FAULT_CODES = [
  'AMBIGUOUS_PATIENT_SELECTOR', 'CONNECTION_REQUIRED', 'CONTEXT_REQUIRED', 'CREDENTIAL_INVALIDATED', 'CREDENTIAL_UNAVAILABLE',
  'DISCOVERY_EXPIRED', 'GATEWAY_CLOSED', 'INPUT_LIMIT', 'INTERNAL_ERROR', 'INVALID_ARGUMENTS', 'INVALID_CONFIG',
  'INVALID_ELEMENT_PATH', 'INVALID_RESPONSE', 'INVALID_TOKEN_RESPONSE', 'LOOPBACK_ONLY', 'NOT_FOUND', 'OUTPUT_LIMIT', 'POLICY_DENIED',
  'PROVIDER_CLOSED', 'RATE_LIMITED', 'REQUEST_CANCELLED', 'RESULT_EXPIRED', 'RETENTION_LIMIT',
  'SEARCH_PARAMETER_UNRESOLVED', 'TOKEN_ENDPOINT_ERROR', 'TOKEN_EXPIRED', 'TOKEN_RESPONSE_LIMIT', 'TOKEN_TIMEOUT',
  'UNKNOWN_TOOL', 'UNRESOLVED_FIELDS', 'UNSAFE_REDIRECT', 'UNSAFE_URL', 'UNSUPPORTED_COMPARATOR',
  'UNSUPPORTED_CONFINEMENT', 'UNSUPPORTED_CONTENT', 'UNSUPPORTED_DEFINITION', 'UNSUPPORTED_FHIR_VERSION',
  'UNSUPPORTED_INTERACTION', 'UNSUPPORTED_MODIFIER', 'UNSUPPORTED_PRECISION', 'UNSUPPORTED_RESOURCE',
  'UNSUPPORTED_SEARCH', 'UNSUPPORTED_SORT', 'UNVERIFIED_CONTINUATION', 'UNVERIFIED_HOST_PROFILE', 'UNVERIFIED_QUERY',
  'UPSTREAM_ERROR', 'UPSTREAM_LIMIT', 'UPSTREAM_TIMEOUT',
] as const;
export type FaultCode = typeof FAULT_CODES[number];
export interface RepairTemplate {
  action: Repair['action']; tool?: ToolName;
  /** Include meta.resource_type only when the injected reviewed-name check passes. */
  resource?: boolean; parameter?: boolean;
  /** OUTPUT_LIMIT: raise to allowed max when larger, else narrow (R-3: warnings overflow always narrows). */
  budget?: 'increase_or_narrow';
}
const discoverParams: RepairTemplate = { action: 'discover_search_parameter', tool: 'fhir_capabilities', resource: true, parameter: true };
export const REPAIR_TABLE: Record<FaultCode, RepairTemplate | undefined> = {
  AMBIGUOUS_PATIENT_SELECTOR: { action: 'use_current_context' },
  CONNECTION_REQUIRED: undefined, CONTEXT_REQUIRED: { action: 'use_current_context' },
  CREDENTIAL_INVALIDATED: undefined, CREDENTIAL_UNAVAILABLE: undefined,
  DISCOVERY_EXPIRED: { action: 'repeat_original_query', tool: 'fhir_capabilities' },
  GATEWAY_CLOSED: undefined, INPUT_LIMIT: undefined, INTERNAL_ERROR: undefined, INVALID_ARGUMENTS: undefined,
  INVALID_CONFIG: undefined, INVALID_ELEMENT_PATH: { action: 'discover_schema', tool: 'fhir_capabilities', resource: true },
  INVALID_RESPONSE: undefined, INVALID_TOKEN_RESPONSE: undefined, LOOPBACK_ONLY: undefined, NOT_FOUND: undefined,
  OUTPUT_LIMIT: { action: 'increase_budget', budget: 'increase_or_narrow' },
  POLICY_DENIED: undefined, PROVIDER_CLOSED: undefined, RATE_LIMITED: undefined, REQUEST_CANCELLED: undefined,
  RESULT_EXPIRED: { action: 'repeat_original_query' }, RETENTION_LIMIT: { action: 'narrow_query' },
  SEARCH_PARAMETER_UNRESOLVED: discoverParams,
  TOKEN_ENDPOINT_ERROR: undefined, TOKEN_EXPIRED: undefined, TOKEN_RESPONSE_LIMIT: undefined, TOKEN_TIMEOUT: undefined,
  UNKNOWN_TOOL: undefined, UNRESOLVED_FIELDS: { action: 'discover_schema', tool: 'fhir_capabilities', resource: true },
  UNSAFE_REDIRECT: undefined, UNSAFE_URL: undefined, UNSUPPORTED_COMPARATOR: discoverParams,
  UNSUPPORTED_CONFINEMENT: undefined, UNSUPPORTED_CONTENT: undefined, UNSUPPORTED_DEFINITION: undefined,
  UNSUPPORTED_FHIR_VERSION: undefined,
  UNSUPPORTED_INTERACTION: { action: 'choose_supported_resource', tool: 'fhir_capabilities' },
  UNSUPPORTED_MODIFIER: discoverParams, UNSUPPORTED_PRECISION: undefined,
  UNSUPPORTED_RESOURCE: { action: 'choose_supported_resource', tool: 'fhir_capabilities' },
  UNSUPPORTED_SEARCH: discoverParams, UNSUPPORTED_SORT: discoverParams,
  UNVERIFIED_CONTINUATION: { action: 'repeat_original_query' }, UNVERIFIED_HOST_PROFILE: undefined,
  UNVERIFIED_QUERY: { action: 'repeat_original_query' },
  UPSTREAM_ERROR: undefined, UPSTREAM_LIMIT: undefined, UPSTREAM_TIMEOUT: undefined,
};

/** Frozen projection recipe IDs (gate-F item 3). Values must equal privacy.ts exports; tested. */
export const RECIPE_IDS = {
  Patient: 'r4-compact-2026-10-18.1/Patient.compact.1',
  Observation: 'r4-compact-2026-10-18.1/Observation.compact.1',
  Condition: 'r4-compact-2026-10-18.1/Condition.compact.1',
  AllergyIntolerance: 'r4-compact-2026-10-18.1/AllergyIntolerance.compact.1',
  MedicationRequest: 'r4-compact-2026-10-18.1/MedicationRequest.compact.1',
  Immunization: 'r4-compact-2026-10-18.1/Immunization.compact.1',
  DiagnosticReport: 'r4-compact-2026-10-18.1/DiagnosticReport.compact.1',
  DocumentReference: 'r4-compact-2026-10-18.1/DocumentReference.compact.1',
} as const;
/** Frozen for P's lab profile; deliberately not implemented or advertised at gate F. */
export const LAB_EVIDENCE_RECIPE_ID = 'r4-lab-evidence-v1/Observation.2' as const;
export const WORKFLOW_ID = 'recent-labs-v1' as const;
export const OBSERVED_CODE_SCAN_RECIPE_ID = 'observed-code-scan-v1' as const;

/** Injected reviewed-name checks (gate-F item 4). Root wires these from Q; P never imports Q. */
export interface ReviewedNames { resource(type: string): boolean; parameter(type: string, name: string): boolean }
export const NO_REVIEWED_NAMES: ReviewedNames = { resource: () => false, parameter: () => false };
export interface RepairMeta { resource_type?: string; parameter?: string; allowed_max_bytes: number; current_max_bytes: number; cause?: 'warnings_overflow' | 'output_budget' }
export interface ExecuteOptions { signal?: AbortSignal; deadlineMs?: number; era?: 'modern' | 'legacy' }
export interface DeliveryContext { era: 'modern' | 'legacy'; profile: 'full-text-v1' | 'structured-evidence-v1'; serverIdentity?: Readonly<{ name: string; version: string }> }

/** Bounded argument admission (spec §0.3): no getters/toJSON invoked; raw input never echoed. */
export const ADMISSION_LIMITS = { bytes: 256 * 1024, nodes: 4096, depth: 32 } as const;
export function admitArguments(value: unknown): { ok: true } | { ok: false; code: 'INPUT_LIMIT' | 'INVALID_ARGUMENTS' } {
  let nodes = 0;
  const seen = new Set<object>();
  const stack: { v: unknown; depth: number }[] = [{ v: value, depth: 0 }];
  while (stack.length) {
    const { v, depth } = stack.pop()!;
    if (++nodes > ADMISSION_LIMITS.nodes || depth > ADMISSION_LIMITS.depth) return { ok: false, code: 'INPUT_LIMIT' };
    if (v === null || typeof v === 'string' || typeof v === 'boolean') continue;
    if (typeof v === 'number') { if (!Number.isFinite(v)) return { ok: false, code: 'INVALID_ARGUMENTS' }; continue; }
    if (typeof v !== 'object') return { ok: false, code: 'INVALID_ARGUMENTS' };
    if (seen.has(v)) return { ok: false, code: 'INVALID_ARGUMENTS' };
    seen.add(v);
    let descriptors: PropertyDescriptorMap;
    try { descriptors = Object.getOwnPropertyDescriptors(v); } catch { return { ok: false, code: 'INVALID_ARGUMENTS' }; }
    for (const desc of Object.values(descriptors)) {
      if (!('value' in desc)) return { ok: false, code: 'INVALID_ARGUMENTS' };
      stack.push({ v: desc.value, depth: depth + 1 });
    }
  }
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(value) ?? ''); } catch { return { ok: false, code: 'INVALID_ARGUMENTS' }; }
  if (bytes > ADMISSION_LIMITS.bytes) return { ok: false, code: 'INPUT_LIMIT' };
  return { ok: true };
}
/**
 * Pre-parse error allowance (spec §0.3): reads only an own data property output.max_bytes.
 * Total by construction (G-5): hostile inputs (accessors, throwing Proxies) fall back
 * to `min(default,max)` without invoking user code; this runs before admission.
 */
export function resolveErrorAllowance(value: unknown, defaults: { defaultBytes: number; maxBytes: number }): { allowance: number; invalidAllowance: boolean } {
  const fallback = Math.min(defaults.defaultBytes, defaults.maxBytes);
  try {
    if (!value || typeof value !== 'object') return { allowance: fallback, invalidAllowance: false };
    const outputDesc = Object.getOwnPropertyDescriptor(value, 'output');
    if (!outputDesc || !('value' in outputDesc) || !outputDesc.value || typeof outputDesc.value !== 'object') return { allowance: fallback, invalidAllowance: false };
    const maxDesc = Object.getOwnPropertyDescriptor(outputDesc.value as object, 'max_bytes');
    if (!maxDesc || !('value' in maxDesc) || maxDesc.value === undefined) return { allowance: fallback, invalidAllowance: false };
    const requested = maxDesc.value;
    if (typeof requested === 'number' && Number.isInteger(requested) && requested >= 4096 && requested <= 131072) return { allowance: Math.min(requested, defaults.maxBytes), invalidAllowance: false };
    return { allowance: fallback, invalidAllowance: true };
  } catch {
    return { allowance: fallback, invalidAllowance: false };
  }
}
/** At most eight schema-owned paths from Zod issues; unknown keys collapse to fixed guidance. */
export function safeSchemaPaths(issues: readonly { code?: string; path?: readonly PropertyKey[] }[]): string[] {
  const paths: string[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys' || !issue.path?.length) { if (!paths.includes('arguments')) paths.push('arguments'); continue; }
    const segments = issue.path.map(String);
    if (segments.length <= 4 && segments.every(s => /^[A-Za-z_][A-Za-z0-9_]*$|^\d+$/.test(s))) paths.push(segments.join('.'));
    else if (!paths.includes('arguments')) paths.push('arguments');
    if (paths.length >= 8) break;
  }
  return paths.slice(0, 8);
}
/** Dedupe warnings by code; >32 distinct codes is a fail-closed OUTPUT_LIMIT signal (spec §0.4). */
export function dedupeWarnings<T extends { code: string }>(warnings: readonly T[]): { warnings: T[]; overflow: boolean } {
  const byCode = new Map<string, T>();
  for (const warning of warnings) if (!byCode.has(warning.code)) byCode.set(warning.code, warning);
  return { warnings: [...byCode.values()], overflow: byCode.size > 32 };
}
