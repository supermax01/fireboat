# M3b implementation specification — patient-bound lab evidence

**Status:** revised after Claude round-2 review, 2026-10-18; implementation contract for Muse, design only. Review dispositions: `proposals/audit/gpt-m3b-spec-response.md`. **Contract:** PLAN.md revision 0.4, including A1–A7. **Scope:** items 1–8 of research/11-best-in-class-benchmark-2026-10-19.md §8. The selected workflow is **recent-labs-v1**: retrieve one configured synthetic patient's lab evidence over an explicit window, inspect status and interpretation context, and drain or reproject bounded evidence with exact source/version citations.

The user's selection of revision 0.4 governs this M3b task. Before implementation dispatch, root must update AGENTS.md's stale 0.2 reference or deliver a dated explicit 0.4 handoff to Muse; this design task cannot edit AGENTS.md. Read this specification alongside PLAN §5–§9, research/11 §7 and §10, and proposals/audit/m3a-verification.md §4. B1–B5 are hypotheses with measurement gates, not achieved properties.

## 0. Baseline, boundaries, and implementation rules

### 0.1 Start from the repaired M3a end state

Assume **V-1 through V-35 are fixed**, including the optional performance repair. Muse finishes repairs A and C and the root agent records M3a integration evidence before merging M3b implementation. Do not reimplement their old defective snapshots. The observed source was changing during this design review: for example, repair-A tests already refer to store overlays while the read copy of store.ts still charged whole Snapshot objects. Resolve names against the integrated baseline; preserve the repaired behavior.

The existing seams are:

| Responsibility | Existing implementation to extend |
| --- | --- |
| Contracts/serialization | `packages/core/src/contracts.ts`: `toolSchemas`, `envelopeSchema`, `GatewayConfig`, `GatewayEnvelope`, `summaryText`, `toMcpToolResult` |
| Coordination | `packages/core/src/index.ts`: unexported `configSchema`, `FhirGateway.execute`, `discover`, `describe`, `capability`, `search`, `fetchPage`, `continuation`, `read`, `page`, `result`, `render`, `bytes`, `fit`; internal `Input`, `ResourceCapability`, `Snapshot` |
| Policy and projection | `privacy.ts`: `resourceClass`, `referenceDecision`, `foreignPatientSelector`, `authorized`, `sharedInstanceAllowed`, `sanitize`, `projection`, `COMPACT_RECIPES`, `COMPACT_RECIPE_SET` |
| Protected state | `store.ts`: `ResultStore`, `putBatch`, `get`, `update`, expiry, repaired backing-page/overlay accounting, eviction, rollback and release |
| HTTP | `transport.ts`: `GatewayFault`, `RequestBudget`, `FhirTransport.get/url/validate`, `controlledFetch` |
| R4 typing | `schema.ts`: `R4_SCHEMA`, `schemaPage`, `resolveElement`, `resourceTypeContext`, `modifierElements`; `generated/r4-index.json`; `decimal.ts` lossless scalar/serialization helpers |
| MCP/CLI | `packages/server/src/index.ts`: `createMcpServer`, `TOOL_DESCRIPTIONS`; `cli.ts`: `loadConfig`, `runDoctor`, `main`, repaired SDK-era guard |
| Eval | `packages/evals/src/tasks.ts`: `EvalTask`, `EvalStep`, `Check`, `TASKS`; `runner.ts`: `openSession`, `evaluateCheck`, `responseInvariants`, `collectEvidence`, `runEvals`; `fixture.ts`: internal (not exported) `capabilityStatement`, `filterMatches`, `sortResources`; exported `ADVERSARIAL_MODES`, `startEvalFixtureServer` |

Keep policy, transport, projection, storage, and adapter separate. New pure modules named below are intentional seams, not a second gateway. The adapter never decides authorization, query completeness, or projection. No unrequested root manifest/dependency changes belong to an implementation worker.

### 0.2 M3b must not do these things

- No remote MCP serving, HTTP listener, inbound authentication service, SMART launch or SMART Backend Services claim. Outbound configured loopback client credentials remain their existing, separately labelled feature.
- No note bytes, Attachment/Binary bytes, waveform exception, attachment fetching, OCR, document conversion, or generic binary access. Document support means **document metadata only**. `output.format=fhir` and retained projection cannot bypass omission.
- No arbitrary request tool, model-supplied URL/header, raw host-token passthrough, automatic external canonical-definition fetch, external terminology call, or reference hydration.
- No clinical writes, transactions, mutations, population/unbound access, inferred current patient, patient switching by model input, hidden LLM, embedding/index service, or paid model call in ordinary CI.
- No `fhir_terminology`, `codes_in_record`, `fhir_patient_context`, history/vread, operation, table/FHIRPath tool, or placeholder action. The tool list remains the five implemented tools.
- No blanket type-policy widening, CarePlan/Goal support, automatic includes/chains, arbitrary overlays/plugins, or unauthenticated publicly exposed demo backend.
- No new dependency without a written justification and root-agent approval. This design proposes **zero new runtime dependencies**. The optional reference-tokenizer tooling below needs explicit root approval before installation; neither a worker nor this specification grants it.
- No claim of clinical readiness, vendor support, host portability, protocol compatibility beyond tested cells, ten-minute onboarding, or superiority from source inspection or scripted synthetic results alone. No public package/image publication or GitHub operation is part of M3b implementation unless separately authorized.

### 0.3 Shared contract conventions

Use application `schema_version: '0.2'` for the coordinated M3b envelope change. This is a pre-release application change, independent of MCP era. Ship its schemas, examples and migration note together; do not silently mix 0.1 provenance with 0.2. Keep exact SDK/runtime pins unless the root approves a separately tested change.

The following are normative Zod shapes. All objects here are `z.strictObject` unless stated otherwise. Reuse named shapes rather than recopying validators. `.describe()` text is specified in item 2. Numbers used as limits/counts/indices are finite integers. Dynamic FHIR bodies are objects, never unchecked envelope metadata.

```ts
const resourceType = z.string().regex(/^[A-Z][A-Za-z0-9]+$/).max(80);
const handle = z.string().min(1).max(160);
const sourceAlias = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const nonnegativeInt = z.number().int().min(0);
const isoDatetime = z.iso.datetime({ offset: true }).max(40);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const fhirResourceObject = z.looseObject({
  resourceType, id: z.string().max(64).optional(),
}); // arbitrary FHIR fields, bounded before construction; NOT an R4 validator
const fieldPath = z.string().min(1).max(256)
  .regex(/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/)
  .refine(p => p.split('.').length <= 8 &&
    !p.split('.').some(s => ['__proto__', 'prototype', 'constructor'].includes(s)));
const fields = z.array(fieldPath).min(1).max(30);
const pair = z.strictObject({
  name: z.string().min(1).max(160), value: z.string().min(1).max(2048),
});
const pairs = z.array(pair).max(32); // outbound validation; coverage omits paging mechanics
const evidence = z.enum(['declared', 'observed_supported',
  'observed_unsupported', 'unknown']);
const output = z.strictObject({
  format: z.enum(['compact', 'fhir']).optional(),
  fields: fields.optional(),
  max_bytes: z.number().int().min(4096).max(131072).optional(),
}).optional();
const common = {
  source: sourceAlias.optional(), context_handle: handle.optional(), output,
};
const repair = z.strictObject({
  action: z.enum(['discover_search_parameter', 'discover_schema',
    'inspect_observed_codes', 'choose_supported_resource', 'narrow_query',
    'increase_budget', 'repeat_original_query', 'use_current_context']),
  tool: z.enum(TOOL_NAMES).optional(),
  resource_type: resourceType.optional(),
  parameter: z.string().regex(/^_?[A-Za-z][A-Za-z0-9_-]{0,79}$/).optional(),
  fields: fields.optional(),
  max_bytes: z.number().int().min(4096).max(131072).optional(),
  page_size: z.number().int().min(1).max(100).optional(),
  max_pages: z.number().int().min(1).max(3).optional(),
  max_calls: z.number().int().min(1).max(4).optional(),
});
const warning = z.strictObject({
  code: z.string().min(1).max(80), message: z.string().max(320),
  repair: repair.optional(),
});
const error = z.strictObject({
  code: z.string().min(1).max(80), safe_message: z.string().max(320),
  retryable: z.boolean(), repair: repair.optional(),
});
```

Use the repaired M3a budget-floor behavior as the migration baseline. The M3b per-call public input floor for `output.max_bytes` remains uniformly 4,096 B in both delivery profiles and protocol eras. When supplied, `configSchema.limits.defaultBytes` and `configSchema.limits.maxBytes` are integers in 8,192..131,072 B; reject an explicitly configured `defaultBytes > maxBytes`. The shipped default remains 24,576 B and the shipped ceiling remains 131,072 B. Resolve the effective default as `min(limits.defaultBytes ?? 24576, limits.maxBytes ?? 131072)`, including when only the ceiling is configured. Administrators may lower these configured values only within their configured bounds. The 8,192-B configuration minimum covers the measured synthetic workflow cases; it is not a guarantee that every resource, query, or metadata row fits. Other existing limit options retain their repaired ranges. Resolve omitted `output.format` in the gateway using the release's measured workflow defaults (item 4), rather than a Zod default that erases whether the caller selected a format. `output.fields` always selects fields regardless of requested format; it never selects a host profile.

`repair` is bounded advice, not executable authority or an automatic retry. It contains only locally reviewed names/paths/limits. Never copy a rejected value, cursor, ID, URL, diagnostics, arbitrary upstream name, credential or full replacement query into it. A forbidden/absent direct read has identical public error and repair shape. `FhirGateway.execute` is the single strict argument-validation boundary for MCP and non-MCP callers. SDK 2.3.1 catches input-schema exceptions and returns raw `isError` text, not a JSON-RPC error; it also skips output validation for `isError` results. Consequently:

- Register a custom Standard Schema input wrapper: `~standard.jsonSchema.input()` returns the strict, object-root listed schema; `~standard.validate(value)` returns `{value}` without stripping keys, applying defaults, coercing or rejecting. Keep SDK `maxToolInputElements` unset; its rejection would bypass the gateway. Do not replace protocol-level JSON-RPC framing validation.
- Inside `execute`, perform bounded argument admission (256 KiB serialized input, 4,096 nodes, depth 32) before strict Zod parsing and topic/path refinements, then source/context checks, then discovery/clinical work. Reject cyclic/non-JSON/accessor-bearing direct-call inputs safely without invoking getters or toJSON hooks. Raw rejected input never enters audit metadata. The parser has bounded work and emits at most eight **schema-owned** field paths; unknown object-key strings become fixed `arguments` guidance. Never serialize Zod issues or rejected values.
- Resolve an error allowance before strict parsing: inspect only an own data property `output.max_bytes` with a bounded shape check. A valid integer in 4096..131072 is capped by configured maximum; missing/invalid/too-small values use `min(defaultBytes,maxBytes)`. An invalid allowance is itself `INVALID_ARGUMENTS` and reports the actual viable allowance, never a promise to fit below the 4096 floor. Other invalid arguments with a valid allowance still honor it.
- Every admitted argument fault becomes a fitted application envelope. Strict-schema faults are `INVALID_ARGUMENTS`; input-size/work admission is `INPUT_LIMIT`; semantic source/context/interaction faults keep their public codes. Admission/schema/source/context faults make no discovery or clinical request; a valid interaction rejected from source capabilities may require metadata discovery only. Unknown tool names and invalid JSON-RPC remain protocol failures outside this path.
- Run full strict tool-envelope and cross-field validation on successes, errors and fallback envelopes **before** delivery and before final handle commitment. On construction failure, discard pending handles and construct a separately validated, fitted `INTERNAL_ERROR` envelope. Do not let SDK output-schema validation become the ordinary error shaper. The emergency constant template is validated at startup and in tests; do not recurse into the failed renderer.

The unchanged input fields have these exact shapes:

```ts
fhir_search: z.strictObject({ ...common, resource_type: resourceType,
  params: z.array(pair).max(30).default([]),
  page_size: z.number().int().min(1).max(100).default(20) });
fhir_read: z.strictObject({ ...common, resource_type: resourceType,
  id: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/),
  interaction: z.literal('read').default('read') });
fhir_page: z.strictObject({ cursor: handle,
  context_handle: handle.optional(), output });
fhir_result: z.strictObject({ handle, context_handle: handle.optional(),
  action: z.enum(['inspect', 'project', 'page']).default('inspect'),
  fields: fields.optional(),
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(100).default(20), output });
```

Reject `.`/`..` IDs through the existing non-disclosing read path. Conflicting `fhir_result.fields` and `output.fields` return `INVALID_ARGUMENTS`; equal arrays are allowed. An inspect action with either fields argument is invalid. `fhir_page` cannot change the original query/source/context and cannot accept a metadata-discovery cursor.

### 0.4 Envelope and output schemas

Replace the loose internal envelope schema with `makeEnvelopeSchema(dataSchema)` and export full strict `toolEnvelopeSchemas`; retain their exported union `envelopeSchema` for internal validation/evals. A successful call has one of the tool data shapes below; an application error has `data: {}`. Dynamic FHIR resource values remain objects refined to have `resourceType`; this is not a complete R4 validator.

**Separate listing from enforcement.** The listed schema is a correct superset of the enforced contract; the enforced contract is published separately and validated in core and evals. Each tool lists the same compact object-root **spine**. It explicitly types every common control field in the table below, but `data` is `{type:'object'}` and additional properties are allowed at the root and within metadata objects. Only `schema_version,request_id,source,context,data,coverage,transform,warnings,budget` are required by the spine; nested fields and optional control objects are fully required/bounded only by the strict contract. The spine declares:

- source alias/version/revision, context handle/mode/revision; coverage state/scope/reasons;
- pagination has_more (boolean/null), next_cursor, returned_matches/includes, requested_page_size, total value/precision;
- provenance resource_index/retrieved_at; transform format/projected/delivery_profile;
- warnings code/message; budget bytes_returned/byte_limit/limit_reached/upstream_calls/elapsed_ms;
- result handle/expires_at/formats; error code/safe_message/retryable.

Use string/integer/boolean/array types and the small state/format enums, without duplicating strict bounds or tool data unions. Register output through a custom Standard Schema whose `jsonSchema.output()` returns exactly this spine and whose `validate` checks it using a pure spine validator. SDK 2.3.1 supports `~standard.jsonSchema` directly. Full strict validation remains inside core even on errors (which the SDK skips). Publish both schemas and their relationship, never describe the spine as the entire enforced schema. Gate F freezes/SDK-tests the actual spine; its serialized cap is 2,000 B, not an assumed 900 B.

Required common fields:

| Field | Exact shape and meaning |
| --- | --- |
| `schema_version`, `request_id` | `z.literal('0.2')`; opaque bounded string, max 80 |
| `source` | `{alias: sourceAlias, fhir_version: string(max 40), capability_revision: string(max 80)}` |
| `context` | `{handle, mode: literal('patient-bound'), policy_revision: string(max 80)}`; no new patient label/selection mechanism in M3b |
| `data` | Tool data union below, or strict empty object only when `error` exists |
| `provenance?` | Array, max 100, of `{resource_index: int(0..99), retrieved_at: ISO datetime}`. Source/type/id/version are obtained from **this response's** `source.alias` and `data.resources[resource_index].{resourceType,id,meta.versionId}`. Each delivered resource has exactly one entry; preserve original retrieval time. No positional reference into another response. Missing upstream version stays missing, never invented. |
| `coverage` | Item 7's exact shape; state/scope/reasons always present |
| `pagination?` | `{has_more: boolean|null, next_cursor?: handle, returned_matches: int(0..100), returned_includes: literal(0), requested_page_size?: int(1..100), total?: {value?: nonnegative int, precision: enum('accurate','estimate','unknown')}}`; M3b continues to withhold upstream total values under patient-bound policy; any value is a safely delivered count under M3a's repaired rule, labelled accordingly, never an upstream total |
| `transform` | `{format: enum('compact','fhir'), requested_format?: enum('compact','fhir'), projected: boolean, withheld_payloads: array(record(string,unknown)), omitted_fields: array(string(max 512)), unresolved_fields: array(fieldPath), narrative_omitted: boolean, recipe_ids: array(string(max 120)), structural_resource_indices: array(int(0..99)), delivery_profile: enum('full-text-v1','structured-evidence-v1')}` |
| `warnings` | Array of `warning`, max 32 after code deduplication. All material warning codes must remain represented; see the overflow rule below |
| `budget` | `{bytes_returned: nonnegative int, byte_limit: int(4096..131072), limit_reached: boolean, upstream_calls: nonnegative int, elapsed_ms: nonnegative int}` |
| `result?` | `{handle, expires_at: ISO datetime, formats: array(enum('compact','fhir')).min(1).max(2)}` |
| `error?` | `error` above. Application faults, including gateway argument validation, set MCP `isError:true`; JSON-RPC failures have no application envelope. |

`transform.omitted_fields` is the sorted union of **actually present fields omitted** in delivered records, as in the present contract; describe that scope, not an exact per-record absence claim. `withheld_payloads` retains the existing bounded, sanitized path/reason/metadata manifests. Recipe IDs are deduplicated once per envelope. Item 4 adds an omission-only per-record inspection form without requiring the original clinical body. Structural fallback indices identify records for which compact clinical interpretation is unavailable. All fallback/error envelopes remain within the independent final-result ceiling; their unused arrays are empty, not stale state from a failed render.

Successful data schemas (all properties explicit, optional only where marked):

```ts
const resourceData = z.strictObject({
  resources: z.array(fhirResourceObject).max(100),
  next_offset: z.number().int().min(0).max(100000).optional(),
  manifest: z.strictObject({
    reason: z.literal('RESOURCE_EXCEEDS_INLINE_BUDGET'),
    action: z.string().max(320),
  }).optional(),
});
// fhir_search/read/page: resourceData
// fhir_result: resourceData | retainedInspection (item 4)
// fhir_capabilities: serverData | contextData | resourceCapabilityData |
//                   schemaData | searchParameterData | supportData
```

The remaining metadata data contracts are explicit below. They retain `schemaPage()`'s existing field names and source-advertisement fields while adding the policy intersection. `synthetic_only` is removed. Bounds here are output limits, not permission to truncate a clinically material value; refuse an oversized definition or paginate metadata safely.

```ts
const classification = {
  network_confinement: z.literal('literal_loopback'),
  data_classification: z.literal('operator_declared_synthetic_unverified'),
};
const className = z.enum(['patient','shared','ambiguous']);
const schemaElement = z.strictObject({
  path: z.string().max(512), min: nonnegativeInt, max: z.string().max(16),
  types: z.array(z.string().max(80)).max(64), modifier: z.boolean().optional(),
  content_reference: z.string().max(512).optional(),
  short: z.string().max(240).optional(),
  binding: z.strictObject({ strength: z.string().max(40).optional(),
    valueSet: z.string().max(512) }).optional(),
  targets: z.array(z.string().max(512)).max(160).optional(),
  json_names: z.array(z.string().max(80)).max(64).optional(),
});
const schemaData = z.strictObject({
  resource_type: resourceType, path: z.union([z.literal(''),fieldPath]),
  definition: z.string().max(512),
  schema: z.strictObject({ package: z.literal('hl7.fhir.r4.core'),
    version: z.literal('4.0.1'), source_url: z.string().max(512),
    source_sha256: sha256, definitions: nonnegativeInt }),
  evidence: z.literal('pinned_base_definition'),
  profile_validation: z.literal('not_performed'), total_elements: nonnegativeInt,
  elements: z.array(schemaElement).max(50), next_offset: nonnegativeInt.optional(),
});
const serverData = z.strictObject({
  source: sourceAlias, fhir_version: z.string().max(40), ...classification,
  implemented_tools: z.array(z.enum(TOOL_NAMES)).length(5),
  resources: z.array(z.strictObject({ type: resourceType,
    resource_class: className,
    implemented_interactions: z.array(z.enum(['read','search-type'])).max(2),
  })).max(100),
  resource_count: nonnegativeInt, definition_limit: z.literal(100),
  workflow: z.literal('recent-labs-v1'), support_matrix_revision: z.string().max(80),
  required_resources: z.tuple([z.literal('Patient'),z.literal('Observation')]),
  document_support: z.literal('metadata_only'),
});
const contextData = z.strictObject({
  mode: z.literal('patient-bound'), context_handle: handle,
  patient_id: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/), ...classification,
  support_matrix_revision: z.string().max(80),
});
const resourceCapabilityData = z.strictObject({
  type: resourceType, interactions: z.array(z.string().max(40)).max(16),
  searchParameters: z.array(z.string().max(80)).max(256),
  resource_class: className, evidence: z.literal('declared'),
  implemented_interactions: z.array(z.enum(['read','search-type'])).max(2),
  instance_policy: z.string().max(120), compact_recipe: z.string().max(120).nullable(),
  limitations: z.array(z.string().max(160)).max(16),
  support_matrix_revision: z.string().max(80), ...classification,
});
```

Context discovery's `patient_id` is permitted only within the existing trusted binding. No ordinary logs print its body. If the resource capability name list cannot fit, return OUTPUT_LIMIT with typed-discovery repair rather than silently dropping supported names. `serverData.resource_count` counts source advertisements, and its bounded summary rows distinguish policy support; `definition_limit` retains its existing summary-cap meaning. Server/resource discovery must expose the item-6 intersection, not source advertisement as executable support.

Warning overflow is fail-closed: after deduplication, more than 32 distinct warning codes yields a fitted `OUTPUT_LIMIT` envelope. Do not truncate or add a 33rd code to `coverage.reasons` (also capped at 32). A successful result never silently loses a material warning; `WARNINGS_TRUNCATED` is not introduced. This preserves both bounds without suggesting a 32-element array can hold more than 32 codes.

Cross-field validation runs after construction: an error cannot carry resources, provenance, result or pagination; provenance indexes are unique/in range; next cursor agrees with `has_more`; complete coverage satisfies item 7; transform/recipe declarations match rendered data. Share pure schema definitions, but the independent eval oracle must not reuse core accounting, selector or projection logic.

## 1. Typed, bounded SearchParameter discovery — M

### Interfaces

Extend only `fhir_capabilities`:

```ts
z.strictObject({ ...common,
  topic: z.enum(['server','resource','context','schema','search_parameter','support'])
    .default('server'),
  resource_type: resourceType.optional(),
  path: z.union([z.literal(''), fieldPath]).default(''),
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
  name: z.string().regex(/^_?[A-Za-z][A-Za-z0-9_-]{0,79}$/).optional(),
  query: z.string().min(1).max(120).optional(),
  cursor: handle.optional(),
});
```

`search_parameter` requires `resource_type` on the first call. `name` means exact base parameter name; `query` is case-insensitive literal substring matching on reviewed name/description, never regex/FHIRPath. They are mutually exclusive. Sort by `(name, definition-or-empty)` using codepoint order. `path` and nonzero `offset` apply only to `schema`; `name/query` apply only to `search_parameter`; `cursor` applies only to `search_parameter` or `support`; other combinations return `INVALID_ARGUMENTS` before a clinical request. A continuation supplies only its original topic, `cursor`, optional `context_handle`, `limit`, and `output`; any conflicting resource/filter/selector is invalid. Discovery cursors are not clinical search cursors.

`data.search_parameters` is a bounded array of:

```ts
const parameterType = z.enum(['number','date','string','token','reference',
  'composite','quantity','uri','special','unknown']);
const syntaxSupport = z.strictObject({
  name: z.string().max(80), evidence, executable: z.boolean(),
});
const searchParameter = z.strictObject({
  name: z.string().max(80), type: parameterType,
  definition: z.string().max(512).optional(), // canonical identifier; NEVER fetched
  definition_version: z.string().max(80).optional(),
  definition_evidence: z.enum(['pinned_r4','approved_overlay','source_declared',
    'unresolved','conflict']),
  targets: z.array(resourceType).max(32),
  description: z.string().max(240),
  source_description_present: z.boolean(),
  evidence, executable: z.boolean(),
  modifiers: z.array(syntaxSupport).max(16),
  comparators: z.array(syntaxSupport).max(16),
  repetition: z.strictObject({ and: evidence, or: evidence }),
  joins: z.strictObject({ chain: z.literal(false), has: z.literal(false),
    include: z.literal(false), revinclude: z.literal(false) }),
  execution_evidence: evidence,
});
const searchParameterData = z.strictObject({
  resource_type: resourceType,
  search_parameters: z.array(searchParameter).max(50),
  total_parameters: z.number().int().min(0),
  snapshot_revision: z.string().max(80),
  captured_at: isoDatetime, expires_at: isoDatetime,
  next_cursor: handle.optional(),
  definitions: z.strictObject({ package: z.literal('hl7.fhir.r4.core'),
    version: z.literal('4.0.1'), source_sha256: sha256 }),
});
```

`targets:[]` with reference type means target knowledge is unresolved, not unrestricted. `evidence` describes source support; `definition_evidence` describes typing provenance; `execution_evidence` concerns filter semantics. A pinned definition is never `observed_supported` merely because it exists. List source-declared parameters even when unexecutable, with unknown/conflict labels. Ordinary source discovery does not advertise every pinned parameter as source-supported. General controls `_id`, `_lastUpdated`, `_sort` are reviewed gateway controls, explicitly represented even if absent in source metadata; missing execution evidence remains unknown. “Reviewed name” means a name selected from the pinned collision-resolution ledger or a release-approved overlay, applicable to this resource base; a source declaration alone is not review. “Executable” means the gateway permits that syntax to be sent, not that the source is proven to enforce it.

Normative **executable search parameter decision table** (authorization and resource-policy checks always precede permission to fetch):

| Input/evidence | Outcome before clinical fetch |
| --- | --- |
| Resource type policy-denied or unadvertised | `UNSUPPORTED_RESOURCE`, `choose_supported_resource`; no pinned parameters listed for that type |
| Name neither source-declared nor `_id`/`_lastUpdated`/`_sort` | `UNSUPPORTED_SEARCH`, discover repair |
| Source-declared, exactly one selected pinned definition by canonical URL + code/base, else unambiguous name/base; declared type matches or is missing | Executable at reviewed base syntax; missing source type may use pinned type; execution remains unknown without a tested profile |
| Source type conflicts with selected pinned definition, or supplied canonical is unresolved/conflicting | `SEARCH_PARAMETER_UNRESOLVED`; no fallback from a conflicting canonical to a convenient name |
| Source-only/vendor parameter without a pinned selection or approved overlay | Listed `executable:false`; `SEARCH_PARAMETER_UNRESOLVED` in patient-bound execution |
| `:modifier` suffix | Requires a parameter-specific approved syntax overlay; otherwise `UNSUPPORTED_MODIFIER`. M3b ships none, including `code:text` |
| Comparator prefix on date/number/quantity | Allow only a pinned comparator or approved overlay comparator; absent list permits only unprefixed syntax. Otherwise `UNSUPPORTED_COMPARATOR`. Never parse prefixes on token/string/reference/uri |
| Repeated names (AND) or unescaped comma OR, with escaped commas preserved literally | Allow for executable parameters with bounded escaped-list parsing. Missing repetition declarations mean unknown execution evidence, not rejection; explicit unsupported declarations/overlays refuse the unsupported form |
| `_sort` | One occurrence, at most four distinct keys, optional `-`; each key an executable source-declared date/token/string/number parameter or `_id`/`_lastUpdated`. Otherwise `UNSUPPORTED_SORT`. No expressions/chains. Unknown order proof does not refuse syntax |
| Reference type with Patient-capable or unknown targets | Patient-selector rules run first; unresolved confinement fails closed. Unknown targets never mean unrestricted references |
| Composite/special syntax or joins | Require a specific implemented overlay/parser. M3b implements no composites/specials/joins; `UNSUPPORTED_SEARCH` |

**Default HbA1c outcome:** on `generic-r4`, source-declared Observation `code`/`date` with nonconflicting pinned resolutions permits ordered pairs `code=http://loinc.org|4548-4`, `date=ge2020-01-01`, `date=lt2026-01-01`, `_sort=-date`, plus trusted confinement and generated `_count`. Pinned clinical-date permits ge/lt; unknown AND/OR/filter/order execution is not a syntax rejection. Return safe evidence with `FILTER_EXECUTION_UNVERIFIED` and `ORDER_UNVERIFIED`; terminal exhaustion gives unknown coverage, while actual remainder gives partial. Never claim latest. A discriminating regression test sends this exact query under the default profile, asserts its encoded pairs and allowed fetch, and checks unknown/partial evidence rather than requiring a refusal.

Trusted configuration additions, validated in `configSchema` and `GatewayConfig`:

```ts
source.searchProfile?: 'generic-r4' | 'synthetic-fixture-r4-v1' | 'hapi-r4-labs-v1';
discovery?: {
  metadataTtlMs?: number;       // int 1..900000, default 300000
  snapshotBytes?: number;     // int 4096..2097152, default 524288
  maxHandles?: number;        // int 1..128, default 32
};
```

The registry contains only profiles whose evidence ships in this release. Reject an absent/unverified profile ID with startup `INVALID_CONFIG`; do not accept inline JSON overlays, files/URLs supplied by an agent, or arbitrary profile names. `hapi-r4-labs-v1` is eligible only after item 7's exact pinned-backend suite passes. Default is `generic-r4`. No automatic synthetic probe runs during a tool call.

New application faults: `SEARCH_PARAMETER_UNRESOLVED` for missing/conflicting typing needed for safe execution (`repair:{action:'discover_search_parameter',tool:'fhir_capabilities',resource_type}`); `UNSUPPORTED_MODIFIER`/`UNSUPPORTED_COMPARATOR` for unreviewed syntax (same repair, with reviewed base parameter only); `DISCOVERY_EXPIRED` for absent, expired, wrong-store or invalidated discovery cursors (`repair:{action:'repeat_original_query',tool:'fhir_capabilities'}`; repeat the original metadata topic). All are non-retryable without changed input/fresh discovery. Existing `UNSUPPORTED_SEARCH` handles unavailable names and joins with discovery repair. `AMBIGUOUS_PATIENT_SELECTOR` is retained as a reserved public fault/repair code (`repair:{action:'use_current_context'}`). The internal typed-selector validator may use it, but implemented gateway tools translate these selector refusals to uniform `POLICY_DENIED` without echoing the rejected selector value; no implemented tool currently emits the reserved code. Policy denial and direct-read uniformization remain unchanged.

### Changes and data

- Add `search-parameters.ts`: `resolveSearchParameters`, `resolveSearchParameter`, `validateSearchSyntax`, `validatePatientSelectors`. Extend `ResourceCapability` to retain bounded declared `name/type/definition` and `source_description_present`, not source documentation bytes. `description` comes only from pinned reviewed R4 text or an approved overlay; source-only parameters use the fixed text “Source-declared parameter; no reviewed definition.” Drop source documentation before caching/snapshot creation, output or logging; substring search never examines it.
- Add `discovery.ts`: immutable `DiscoverySnapshot` discriminated by `topic:'search_parameter'|'support'`, bounded page fitting, cursor bindings and TTL. Reuse a separate `ResultStore<DiscoverySnapshot>` for metadata only, with the explicit discovery subquota above, the repaired backing-data/overlay mechanism, and no clinical bodies. Both stores charge one caller-wide retention ledger (default 10 MiB total, or the configured retentionBytes ceiling); discovery is not an extra 512 KiB allowance. Discovery cursors alone may be evicted oldest-first to admit fresh metadata, then return uniform `DISCOVERY_EXPIRED` if reused; regeneration is safe. Never evict a live clinical cursor under this metadata rule. Test repeated creation past maxHandles and byte limits, recovery and absolute TTL. Keep cursor values protected, high entropy and source/context/policy/auth-epoch/topic/filter/revision bound. Publicly use the existing `cur_` locator encoding, but resolve only in this metadata store; a cursor from the wrong store gives the same unavailable response. No clinical `res_` handle is issued for metadata.
- `FhirGateway.discover/describe/execute`: refresh private source metadata after TTL, compute normalized capability revision, freeze a discovery snapshot, page it without refetching or reordering mid-scan, and clear snapshots on close/auth or policy/source revision change. A non-evicted cursor remains stable until expiry; eviction or a revision invalidation returns `DISCOVERY_EXPIRED`, never a silently different page. Metadata scope can be complete for this bounded catalog query, with the standing “declarations are not execution proof” reason.
- `search`: resolve/validate before constructing any clinical request; preserve ordered pairs, escapes and repeated-value multisets. A source-declared type conflicting with a canonical pinned definition is unexecutable. Match canonical definition + code + applicable base; only use a name fallback when one reviewed definition is unambiguous. Vendor definitions require the approved registry.
- Extend `foreignPatientSelector` to receive resolved type **and targets**, and use a bounded FHIR escaped-list splitter instead of raw `split(',')`. For Patient-capable or unknown-target reference parameters, bare IDs are ambiguous and denied unless the parameter is the reviewed confinement alias and the value is exactly the trusted ID. A polymorphic `Patient.link` bare ID is rejected even when it equals the bound ID; explicit `RelatedPerson/id` may proceed only when syntax and type policy permit. Explicit foreign Patient forms remain denied for every parameter. After syntax and required typing have been admitted, these selector policy denials return the uniform public `POLICY_DENIED`, without echoing rejected selector values and without any clinical request or target lookup. Bounded metadata discovery needed to resolve search declarations may precede refusal; zero total upstream requests is not promised for a cold metadata cache. Unknown parameter typing never guesses “token” from the value's spelling. Missing confinement typing/predicate fails closed before clinical fetch.
- `transport.ts` continues to provide only controlled FHIR requests. It never fetches a definition URL. `privacy.ts` continues authorizing every returned resource independently; typed request validation cannot replace it.

Add `scripts/generate-r4-search-parameters.py` and `packages/core/src/generated/r4-search-parameters.json`. Input is the existing `.local/hl7.fhir.r4.core-4.0.1.tgz`, SHA-256 **`b090bf929e1f665cf2c91583720849695bc38d2892a7c5037c56cb00817fb091`**, the same pin used by `generate-r4-index.py`. The archive contains 1,400 SearchParameter JSON members, including exactly three example-named members. The remaining 1,397 are not automatically executable: source declaration, selected definition, syntax and policy still govern. Iterate members without extracting paths or executing package code; bound archive/member/JSON sizes. Deterministically sort output; record package/version/license/source URL/archive digest/member digest and generator revision. Store original `url,version,code,base,type,target,comparator,modifier,chain,multipleAnd,multipleOr,expression,description` after bounded normalization. Do not execute expressions.

Generate a collision ledger and reviewed selection table. In particular, `_id` must resolve to `Resource-id`, not `SearchParameter-example`; resolve multi-base `clinical-code/date/patient` deliberately. Missing modifiers/targets/repetition declarations remain unknown; absence does not mean permission. Keep approved syntax/execution overlays separately in `packages/core/src/data/search-profiles.json`, versioned and hash-pinned with test IDs and source/version applicability. The generator must not manufacture source-execution evidence. Update `THIRD_PARTY_NOTICES.md` during implementation.

### Acceptance, eval additions, and risks

Fail-before tests in new `tests/search-parameters.test.ts`: the new topic currently fails schema validation; after implementation it returns Observation `code:token`, `date:date`, `subject:reference` with Patient among targets and separate evidence/freshness. Patient `link` with omitted source type resolves from R4 and rejects bare foreign IDs **before any clinical request**. Positive controls accept the bound confinement alias and token system `http://loinc.org|4548-4`. Repeated `ge`/`lt` dates survive encoding and all pages. Missing type/targets, conflicting definitions, unknown vendor names, escaped token commas, unsupported `code:text`, comparator and joins have discriminating failures. Freeze snapshot order, shrink to byte budget, drain a metadata cursor, invalidate it, and test wrong store/context, quota recovery and absolute expiry.

Add response-bound eval tasks `discover-observation-search-types`, `discover-unknown-and-conflicting-definition`, `repair-code-text-discovery`, `patient-link-bare-id-denied`, and `discovery-snapshot-drain`. Assertions bind to their discovery/repair step; a prior resource read cannot satisfy them. Inspect independent upstream requests to prove no SearchParameter canonical URL, Patient enumeration or clinical request was made by discovery. Mutants that trust a declared conflicting type, allow a bare foreign ID, enable joins from discovery, or fetch canonical URLs must fail. Source documentation is never emitted or stored. Decidable canary tests insert a synthetic marker in source documentation and assert its absence from output, logs, cached metadata and snapshots. Source definition URLs with credentials/query/fragment are withheld using protectedLink; reviewed pinned descriptions remain bounded data. This item advances B2/B3/B5, not terminology coverage.

## 2. Schemas, descriptions, examples, repair errors — M

### Interfaces and changes

Implement §0's full contracts, `toolEnvelopeSchemas`, and the item-specific data shapes. `createMcpServer` keeps all five read-only/non-destructive annotations; no new tool appears. Descriptions and field `.describe()` text must state these concrete rules:

- `source` is a configured alias; omitted context uses only the immutable local binding. IDs/handles are not authorization.
- `params` is an **ordered array**, with AND repetition and unescaped comma OR (escaped commas are literal) according to item 1's executable-syntax table; unknown repetition evidence is reported separately. Example pairs use distinct array entries for the two dates. `_sort` requires separate ordering evidence; filtering alone does not justify “latest.”
- `page_size` requests upstream matches (default 20, maximum 100), while wire limits can return fewer and a protected continuation. `max_bytes` includes final MCP duplication and SDK fields. It is not a resource-body budget or a token budget.
- `format=fhir` is sanitized FHIR-shaped evidence, still subject to payload/policy omissions. Field paths are bounded dotted JSON paths, traverse arrays, and preserve required modifiers/primitive companions/identity. They are not FHIRPath, expressions or numeric indices.
- `fhir_page` drains retained remainder before upstream work; query/source cannot be changed. `fhir_result.inspect/project/page` sees only its retained upstream-page slice, not an entire chart/query; offset paging is local and cannot renew TTL. `fields` may recover useful evidence, never withheld payloads.
- Discovery metadata describes definitions, advertised support and approved execution evidence separately. “Supported” is the item-6 intersection, not arbitrary resources from the R4 package.

Implement `repairs.ts` with the gate-F injected-review signatures in §10, `repairForFault(code, safeMetadata, reviewed): Repair | undefined` and `repairForNoMatches(type, reviewed): Repair | undefined`. `Repair` is `z.infer<typeof repair>`. `safeMetadata` is `{resource_type?: string, parameter?: string, allowed_max_bytes: number, current_max_bytes: number}`: the helper checks names through the injected reviewed-name interface before returning them. P imports contracts only and never imports Q's search/support/generated modules. Root builds this interface from Q's completed reviewed metadata; source-only names cannot enter advice. The transport's `GatewayFault` constructor remains unchanged; `execute` attaches advice through this core helper after mapping public faults. It never serializes raw Zod issues/arguments/upstream diagnostics into error advice, and uniformized NOT_FOUND has no repair regardless of the internal cause.

Besides item 1/7's new codes, add advice to existing codes: `INVALID_ARGUMENTS` → schema guidance through safe_message with no repair object; `UNSUPPORTED_SEARCH` → discover parameters; `INVALID_ELEMENT_PATH`/`UNRESOLVED_FIELDS` → discover schema; `OUTPUT_LIMIT` → increase allowed budget or narrow fields; `RESULT_EXPIRED` → repeat original query; `CONTEXT_REQUIRED` → use trusted current context; `RETENTION_LIMIT` → narrow query, never promise an expiry when the request cannot fit; `UNSUPPORTED_RESOURCE`/`UNSUPPORTED_INTERACTION` → inspect support matrix. `NOT_FOUND` deliberately has no resource-specific advice. `repair.retryable` is not a new field: retryability remains on the error and never means permission to drop constraints.

No new config is required for examples or schema selection. The universal listing profile is an object-root input/output schema; never emit a top-level union or a schema for an unimplemented action. The successful/error data union is nested under an object envelope. Keep lists deterministic. Descriptions are instructions; source-provided descriptions are data and cannot become trusted tool instructions.

### Data and catalog budget

Add `examples/tool-calls.json` with literal synthetic input/result pairs for: typed discovery; HbA1c search with `code`, two date pairs and `_sort=-date`; unsupported `code:text` and discovery repair; no-match plus a separate bounded code scan; cursor drain; retained inspect then selected-field recovery; expired handle; non-continuable partial; status-sensitive structural fallback. Every example must validate against the shipped schemas. Use a fixed synthetic source/context and declared fixture versions; never fabricate a full FHIR response or use ellipsis inside executable JSON.

Keep complete machine-readable contracts in `docs/contracts/m3b-tools.json`, generated from the same Zod shapes and release ID. Runtime refinement invariants and dynamic FHIR bodies are documented explicitly. This artifact contains both `enforced` strict schemas and `listed` spine/input schemas, with hashes and the refinement/migration rules. Its `listed` entries must match actual SDK listing; its `enforced` entries match core validation. Do not assert equality between the spine and the full contract.

**Full-tool-catalog target: ≤5,000 pinned reference tokens.** The byte planning assumption is **3.5 UTF-8 bytes/reference token**; this is an estimate, not a tokenizer bound. Freeze the following enforceable byte caps over each **entire compact-JSON listed tool** (name/title/description/input/output/annotations/metadata together):

| Tool | Complete listed-tool byte cap |
| --- | ---: |
| `fhir_capabilities` | 3,850 |
| `fhir_search` | 3,550 |
| `fhir_read` | 3,250 |
| `fhir_page` | 3,000 |
| `fhir_result` | 3,500 |
| All tools | 17,150 |
| Server instructions + catalog wrapper/separators/other advertised context | 350 |
| **Complete reference catalog** | **17,500 B = 5,000 estimated tokens at 3.5 B/token** |

Server instructions alone are ≤160 B; wrapper/other advertised context must fit the remaining 190 B. Each output spine is ≤2,000 B; input schemas retain strict field/property bounds, and runtime-only topic/path refinements are documented. Concise property descriptions and local refs must fit the whole-tool cap. Executable examples remain in the file, not duplicated into listing metadata. Do not omit emitted metadata or paginate a tool out of the measurement. A throwaway design skeleton with a 1,937 B spine and all five proposed input shapes totals 16,369 B for tools before final property descriptions, leaving 781 B tool headroom; this is feasibility evidence, not the integrated catalog acceptance result. Real SDK capture of that throwaway skeleton measured 16,697 B modern / 16,563 B legacy including 160 B instructions and decoded advertised metadata; final property descriptions are still an integration obligation. The current baseline tools array is 15,071 B in both eras (wire list results 15,239 B modern / 15,081 B legacy). The rejected full-output design was independently measured at 61,599 B for output schemas alone.

Add `scripts/measure-tool-catalog.py` plus SDK capture helper `packages/evals/src/catalog.ts`. Capture actual modern/legacy listings, reconstruct all listing pages, and serialize `{instructions,tools,...otherAdvertisedContext}` as compact UTF-8 JSON in declared property order. Hash it and tokenize with both `o200k_base` and `cl100k_base`; publish the maximum across eras/profiles. Separately report list-result/frame bytes and SDK-added fields. Both per-tool byte caps and the **actual ≤5,000 token count in each encoding** must pass for a catalog-target claim. Passing the estimate does not establish token acceptance.

Proposed dev-only tokenizer is `tiktoken==0.12.0`, installed only by root with explicit approval, in a separate measurement environment. Record wheel/encoding-table hashes in `packages/evals/data/tokenizers.lock.json`; use a prepopulated hash-verified `TIKTOKEN_CACHE_DIR` and network-disabled measurement. A cache miss fails measurement, never downloads. Root may freeze an equivalent exact local tokenizer before baseline; no tokenizer switch after unsealing. No tokenizer was installed for this design revision. When unavailable, label token acceptance **unmeasured** while still enforcing byte caps.

Gate F must capture and pass the byte-bounded skeleton before contracts freeze. `$defs`/`$ref` resolve within each schema and are both-era SDK-tested; no cross-tool registry or remote ref. Overflow requires a reviewed schema/description revision **before dispatch**, not a knowingly over-budget frozen contract. If later actual token measurement misses despite passing byte caps, publish the count/unmet status and revise the listing at root review; never imply the estimate passed B5.

### Acceptance, eval additions, risks

`tests/m3b-contracts.test.ts` and `tests/m3b-mcp.test.ts` must exercise real SDK listing/calls in both eras, plus raw malformed JSON-RPC. Reject unknown object keys, invalid topic combinations, unsafe/deep/overlong paths on **both** field arguments and schema.path, too-small budgets, an unsupported interaction and source/context forgery. Classify outcomes as (a) JSON-RPC error with no result, (b) SDK `isError` text with no structuredContent, or (c) application envelope with `isError` and structuredContent. Expected cases: malformed JSON-RPC/unknown tool/era mismatch → (a); unknown keys, invalid topic combinations, unsafe/deep/overlong paths on both fields arguments and schema.path, too-small budget → (c), `INVALID_ARGUMENTS`; an interaction argument other than literal read → (c), `INVALID_ARGUMENTS`; a valid read when that interaction is unsupported by the source → (c), `UNSUPPORTED_INTERACTION`; source alias forgery → (c), `POLICY_DENIED`; context forgery → (c), `CONTEXT_REQUIRED`. Preserve direct-read uniformization. Class (b) is a pinned-SDK baseline/regression observation and is forbidden for admitted gateway argument faults after the wrapper change. Oversized argument admission → (c), `INPUT_LIMIT`. Test a 200-unknown-key argument with valid max_bytes: class (c), within the allowance, zero echoed key/value canaries. Mutate an error envelope to violate its strict schema and require safe INTERNAL_ERROR despite the SDK skipping error-output validation. Validate success, pagination, oversize manifest, retained inspect, error and fallback shapes; fail-before examples include currently undeclared pagination/result/error/provenance fields and missing descriptions/repair.

Eval tasks `schema-catalog-and-examples`, `repair-invalid-search`, `repair-expired-retained`, `selected-path-bounds`, `sdk-errors-versus-tool-errors` bind checks to the exact result/error step. Add a harness representation for protocol errors, not a fabricated application envelope. Validate repairs contain only allowed keys and safe reviewed metadata. Guard mutants: echo Zod input, put source text in tool descriptions, permit `constructor`/deep paths, remove output declarations, misclassify protocol errors, or omit a catalog page must fail. Synthetic markers in IDs/URLs/diagnostics cannot appear in ordinary logs, schemas, or repair messages.

## 3. NO_MATCHES and observed-code repair — S

### Interfaces and behavior

No new tool/action/config. Return a warning, **not an error**, with exactly `code:'NO_MATCHES'`, a non-diagnostic message (“No matches were delivered for this executed query; this does not establish absence of the clinical concept.”), and:

```ts
repair: { action: 'inspect_observed_codes', tool: 'fhir_search',
  resource_type: 'Observation', fields: ['code'], page_size: 100, max_pages: 3, max_calls: 4 }
```

Use the queried supported resource type when it has a reviewed coded field; otherwise offer `discover_search_parameter`. The warning is emitted only for a supported **filtered** query whose chain has delivered zero matches, whose observed query is terminal and exhausted, including generic-r4 with unknown filter execution. `params:[]`/confinement-only empty results remain a normal empty resource array without NO_MATCHES. A zero-record page with more work, output/precision refusal, non-continuable link, unsupported filter, denial or upstream fault cannot produce this hint. For terminal unverified zero results, retain `coverage.state:'unknown'` and `FILTER_EXECUTION_UNVERIFIED`, and append the fixed sentence “Filter execution is not verified.” to the hint. NO_MATCHES describes delivered evidence only; it is not a verified clinical negative.

Track the cumulative **delivered authorized match** count privately in the search chain overlay; never the number of suppressed entries or the upstream total. Derive it from the delivered prefix/position of each chain branch, rather than incrementing mutable shared counters: cursor replay must reproduce the same count/hint and local remainder delivery must not double count a backing page. Give the same public response for an actually empty authorized result and one that contains only undisclosable matches. Do not introduce a suppression-dependent warning, count or repair.

Observed-code inspection uses an explicit new `fhir_search` with `output:{format:'fhir',fields:['code']}`, `page_size:100`, the same trusted binding and original date window, and ordinary safe continuation. It is a **separate exploratory query**, not a replacement answer or an automatic broadened retry. It may omit the original code constraint to inspect alternatives, but must never rewrite the original query, weaken patient/policy/date restrictions, or claim the discovered code is equivalent. No records/denials/unsupported query/failure remain distinguishable outcomes; no fabricated code/display and no “no diabetes” statement.

Client recipe `observed-code-scan-v1`: at most 3 clinical MCP result pages (the initial search plus at most two fhir_page calls, including local remainder pages), 4 MCP calls including discovery if needed, 20 upstream requests as an absolute outer cap, 45 seconds, 24 KiB final result/call and 72 KiB result/task. Stop earlier on any lower host/operator/task limit. Count discovery/auth/upstream work, not only selected output bytes. No prefetch. Larger upstream pages do not increase these work/result ceilings; fields=[code] may still require local remainder pages. With ≥300 Observations the scan is expected to be partial, not a complete code inventory. The gateway does not secretly scan more pages. If the caller stops with a cursor, record the workflow scan as partial (`SCAN_LIMIT_REACHED` in the **eval/client recipe** outcome); the last gateway page still reports its honest MORE_PAGES state. A stateless tool cannot know a caller has abandoned a scan. Distinct observed system/code/version/display tuples are computed only from returned evidence and retain their exact citations; do not advertise a new server-side deduplication action.

### Changes, data, acceptance, eval, risks

`FhirGateway.search/page/render` adds the delivered-count chain overlay and warning after item 7's coverage decision; `repairs.ts` supplies static advice. `store.ts` receives no new scan loop or TTL behavior. Add the bounded recipe and examples to `docs/QUERY-REPAIR.md` and `examples/tool-calls.json`; pin the recipe version and limits in `packages/evals/data/workflows.json`.

Fail-before tests in `tests/no-matches.test.ts`: successful verified filtered empty query gains the hint; unfiltered empty query does not; an empty intermediate authorized page retains its cursor without the hint; prior delivered matches suppress the terminal hint; upstream failure/unsupported code:text cannot turn into NO_MATCHES; a terminal empty generic-r4 filtered query does carry NO_MATCHES plus unknown coverage and the fixed uncertainty sentence. Positive code scan returns observed system/code/display with source/version and carries original window/confinement through every page. Capped scan shows a remaining cursor and partial client outcome, not complete code inventory. Wrong-patient input is denied before fetch; inferred context remains the immutable local binding.

Eval tasks `zero-filtered-match`, `zero-records`, `zero-unverified-filter`, `zero-page-with-next`, `observed-codes-capped`, `observed-codes-repair-success`, `observed-codes-wrong-patient` assert result-bound code tuples/citations and executed constraints. A step that reads a code before the scan cannot satisfy the scan's fact check. Kill mutations that mark empty page as exhaustion, drop dates/patient during the scan, derive the hint from suppressed counts, fetch all pages before selecting code, or call a terminology endpoint. The main risk is an absence claim/count side channel hidden inside “helpful” recovery; the second is an unbounded clinical scan disguised as metadata. This item advances B3 and supports later B1 task-cost measurement.

## 4. Useful and measurably smaller compact lab profile — M

### Interfaces and projection contract

Do not add an output format or clinical tool. Introduce recipe ID **`r4-lab-evidence-v1/Observation.2`**, plus reviewed Patient/DiagnosticReport dependencies only where the workflow uses them. Explicit compact requests remain possible; omitted format uses the measured release default. Add trusted `workflow?: 'recent-labs-v1'` (default that value) to `GatewayConfig/configSchema`; it selects documentation/defaults, never permission. New source types retain sanitized FHIR fallback and cannot inherit a lab recipe by resemblance.

Every resource, including selected/retained output, keeps `resourceType`, source `id` when present, and `meta.versionId` when present, so §0.4's indexed provenance always resolves within the same response. Missing identity/version is explicit in inspection and never replaced with a generated value. Compact metadata retains `versionId`, `profile`, `security`, upstream SUBSETTED tags and their primitive companions; other metadata may be omitted with paths. Preserve all modifier semantics at every kept depth. Selected projections retain the same identity/security/profile/subset supplement; they are not a claim to reconstruct a full resource.

The Observation recipe retains complete values and companions for these declared roots:

```text
status, category, code, subject, focus, effective[x], issued, value[x],
dataAbsentReason, interpretation, bodySite, method, specimen, device,
referenceRange, hasMember, derivedFrom, component
```

Keep `component` association and its nested codes/values/dataAbsentReason/interpretation/ranges intact. Keep every Coding's `system`, `version`, `code`, `display`, `userSelected`, and relevant concept text; no display-only code normalization. Preserve Quantity `value` lexeme, `comparator`, `system`, `code`, `unit`, all value choices, Ratio/Range bounds, date precision/timezone and Period boundaries. No unit/assay conversion, component flattening, status exclusion or clinical inference. The noncompact fields removed are, for example, ancillary identifiers and redundant administrative prose after policy review; do not invent padding to create a win. Ordinary clinical text is not fetched or interpreted to compensate for omitted facts.

An unknown modifier/implicitRules/policy-withheld modifier forces an explicitly structural sanitized view using repaired `requiresStructuralView`; mark its resource index and warning `UNINTERPRETED_MODIFIER`. Never relabel that fallback as a successful clinical compact interpretation. Retained field selection cannot defeat this rule. Referenced authorized contained resources remain whole enough to preserve the returned fact; unknown contained dependencies retain the item-6 deny boundary.

Replace repeated provenance identity with §0.4's response-local index; keep original retrieval time. Replace the comma-concatenated `transform.recipe` with deduplicated `recipe_ids`. Keep actual projection and policy omission paths, including narrative distinction; no recipe ID alone hides an actual omission. `fhir_result.inspect` gains this exact data shape, with optional offset pagination using the existing input offset/limit:

```ts
const retainedInspection = z.strictObject({
  resource_count: nonnegativeInt,
  scope: z.literal('retained_upstream_page'),
  upstream_pages_remain: z.boolean().nullable(),
  formats: z.array(z.enum(['compact','fhir'])).min(1).max(2),
  omissions: z.array(z.strictObject({
    resource_index: nonnegativeInt, resource_type: resourceType,
    id: z.string().max(64).optional(), version: z.string().max(64).optional(),
    recipe_id: z.string().max(120).optional(),
    omitted_fields: z.array(z.string().max(512)),
    withheld_reasons: z.array(z.string().max(80)),
    interpretation: z.enum(['clinical_projection','structural']),
  })).max(100),
  next_offset: nonnegativeInt.optional(),
});
```

Inspection returns only authorized omission metadata, not an original resource body, and fits the same wire budget. It computes the candidate projection selected by `output.format` (or the release default) against the neutral sanitized retained slice, merges its policy/payload omission metadata, and identifies that format in `transform.format`; it does not pretend to recall a different historical projection. `upstream_pages_remain` is null for an unverified/rejected continuation, otherwise reflects the retained snapshot's known upstream state. Paths/reasons have passed sanitization. The returned `resource_index` here indexes the retained slice; document this explicitly and do not confuse it with clinical provenance. Inspection does not issue provenance for nonexistent resource bodies. A missing/evicted handle has the existing uniform `RESULT_EXPIRED` behavior. The delivered envelope remains self-describing through recipe IDs, actual omitted path union, structural indices and payload manifests even when retention is unavailable.

### Changes and data

Move recipes and projection-specific helpers from `privacy.ts` into `projection.ts` in the root-owned foundation split, retaining re-exports of `project`, `projection`, `COMPACT_RECIPES`, `COMPACT_RECIPE_SET` to avoid accidental import breakage. `privacy.ts` remains owner of authorization and sanitization. `projection.ts` may import schema/decimal/contracts, but not transport or a patient credential. The root approves this mechanical move before workers diverge.

`projection` returns the existing resource/omitted/unresolved/warnings plus a single `recipe_id` and actual structural status; `render` collects recipe IDs once, builds indexed provenance, and renders metadata for inspection from the sanitized backing snapshot. Do not store a second clinical body for each format/cursor. Retain `FhirDecimal`/precision-fault leaves through every copy. `bytes/fit` account for the final new shape and repaired fallback variants before committing handles; cancellation/epoch checks and orphan rollback remain unchanged. Do not reinstate the V-35 quadratic packing path.

Keep replayable cursors until their inherited absolute expiry in M3b; do not release a predecessor merely because one branch advanced. The existing handle quota and task work limits can stop a long chain, so document that boundary and return its explicit partial/failure outcome. This spec does not promise unlimited replay/continuation or add a cursor-release protocol. Benchmark 100-resource pages near 128 KiB after integration and report p50/p95 gateway-only projection/packing overhead against PLAN's under-100 ms p95 target separately from upstream/host latency; deterministic tests assert equality and exact budgets, not flaky wall-clock ceilings.

Add `packages/core/src/data/compact-profiles.json` (recipe version, kept roots, meaning supplement, omission policy, source release, intended workflow, benchmark reference, measured efficiency status and default) and `docs/COMPACT-PROFILES.md` generated from it. `schemaPage` remains a field-definition facility, not a recipe validator. Tests compare recipe roots against pinned R4 and every supported value choice. No new runtime dependency.

### Paired measurement and A1 decision rule

Freeze the integrated repaired-M3a **raw / sanitized-FHIR / compact / selected** baseline before optimizing. Raw is an upstream synthetic diagnostic baseline, not an MCP output arm. Final comparison uses the same immutable evidence/query/window, task critical facts, source versions, per-call/whole-task budget and delivery profile. Restore the same seeded backend for each arm; independently verify seed versions/lexemes after HAPI ingestion. Count all discovery, error repair, pages, retained inspection/reprojection and retries, including duplicates actually delivered.

Use `fhir` = explicit format=fhir without fields; `compact` = explicit format=compact without fields; `selected` = explicit format=fhir with a frozen task-selected field set sufficient for every critical fact. Do not pick selected fields after reading compact failures or exempt compact critical facts. Selected is a useful comparison, not the denominator of the 50% target. Freeze query semantics and complete fact set even when pagination yields different call counts.

M3b's efficiency corpus follows research/11 §10's patient split: 30 synthetic charts, 10 development / 20 held out by patient; small/medium/large around 30/300/3,000 total resources. Allocate heldout patients 6/6/8. **Declare the target large-lab stratum before holdout:** those eight large patients, each with at least 300 eligible Observations and at least 128 KiB of sanitized upstream Observation evidence over the fixed window; tasks are (1) bounded multi-page lab trend, (2) recent HbA1c evidence over an explicit wide window, (3) panel/component evidence with field recovery. Thus 24 heldout task instances from three templates, not 24 independent clinical concepts. Use **natural pinned Synthea charts only** for A1: freeze seed, age/module selection and hashes before any compact measurement. No augmentation contributes to the primary ratio or default decision. Handcrafted edge fixtures remain separate fidelity cases. No padding, duplicated administrative roots or post-hoc workload exclusions. If charts cannot meet those declared properties, record the stratum unfulfilled before measuring, rather than silently shrinking it.

Pin an `as_of` instant and dates in the manifest. Initial operating point: 24 KiB/call, 20 MCP calls/task, 20 independently counted upstream requests/task including discovery/auth, 45 seconds/task; report a separate 128 KiB/call diagnostic run. Do not mix the two points. All arms must obtain all task-required evidence within the same task ceilings. A failed/refused task is not a cheap success.

For each era and delivery profile report wire-result bytes, frame bytes, actual model-visible input tokens, catalog tokens, request tokens, total result tokens and combined task tokens separately with both pinned reference tokenizers. Full-text-host lane exposes the serialized text envelope; structured lane counts the **captured actual host model input**, not a guessed JSON view. Independently report the complete wire duplication even when a host delivers only one representation. Sum per-message tokenizations, with renderer separators included; do not concatenate messages to exploit tokenizer boundary effects.

**Target:** on the predeclared heldout large-lab stratum, median paired `Tcompact/Tfhir ≤ 0.50` for total model-visible result tokens in each advertised delivery profile/reference tokenizer, with 100% critical fact/citation/meaning checks and no deterministic task-success loss. Report p90 ratios and patient-clustered uncertainty; do not substitute ratio-of-aggregate-bytes for median paired task ratios. Report paired comparable successes and all attempted failures/unsupported/capped tasks together; a failed arm prevents an efficiency success claim for that pair. Deterministic conformance cannot establish no material loss in autonomous model task success; the later opt-in two-model-family gate remains unmet until run with a preregistered margin.

**A1 statistical/default rule:** for each era × eligible delivery profile × tokenizer at the primary operating point, calculate the median of all 24 paired task ratios. Bootstrap the eight patients, carrying all three paired tasks together for each sampled patient: 10,000 resamples, xorshift32 PRNG (shifts 13/17/5, unsigned 32-bit state; index=floor(8*state/2^32)) with seed 0x4d336231 recorded in the manifest, percentile interval [2.5th,97.5th] (linear quantiles, Hyndman–Fan type 7). “Smaller” means the 95% interval upper endpoint is <1.0; “not_smaller” means its lower endpoint is ≥1.0; otherwise “indeterminate.” Fewer than the declared complete paired successes, unfulfilled stratum, or missing capture/tokenizer gives “unmeasured” and prevents an efficiency/default win. Report point estimate/interval, p90 and all failed attempts; eight clusters give limited precision. A workflow/type may default to compact in a measured cell only if **every advertised measured cell is smaller** and fidelity/task success is perfect; a release-wide compact default additionally requires every applicable advertised cell to be measured. All not_smaller/indeterminate/unmeasured cells default to `fhir`; label not_smaller as structural projection. If smaller but the 50% point target is missed, publish target-unmet and actual distributions; no 50%/superiority claim.

Before holdout unsealing, `compact-profiles.json` must freeze recipe/corpus/query hashes, development per-root byte contributions, the numerical expected ratio range derived from development data, and the prior expectation “50% target expected unmet.” The new recipe retains more clinical roots than the baseline; it is not credible to assume a 50% win. No recipe, field-frequency, corpus, tokenizer or default-rule edits between development freeze and holdout. An invalidated study gets a new preregistration/holdout, not a selective rerun. Never use a per-record runtime size contest as an undisclosed default policy. Publish explicit requested and actual format/fallback labels. A release may record an unmet efficiency target honestly; it must not describe item 4's size objective as achieved.

These are within-product measurements; B1's WSO2/fhirHydrant median/p90 targets require item 13's separately pinned competitor runs. No comparative winner follows from M3b.

### Acceptance, eval additions, risks

Fail-before tests in `tests/compact-labs.test.ts`: current provenance repeats identity, recipe metadata is not the new format, inspection lacks omission detail, and lab recipe omits specimen/device/derivedFrom. Test the repaired clinical baseline first, then exact unchanged fact tuples across fhir/compact/selected/read/search/page/retained. Cover 7.0, 120.00, exponent/negative-zero lexemes; Quantity comparator/UCUM/version; all `value[x]` choices; extension-only dates/values; effective Period/partial dates/timezones; status/corrected/entered-in-error; range/comparator; components; SUBSETTED; referenced contained data; nested modifiers and interpretation refusal. No critical fact gets a NONCOMPACT exemption.

Add tasks `lab-quantity-version-comparator`, `lab-value-choices-and-precision`, `lab-component-association`, `lab-contained-meaning`, `lab-structural-fallback`, `lab-retained-omission-inspection`, plus the 24 heldout measurement instances. Extend `Check` with response-bound `decimalLexeme` and `citationTuple`, and update `collectEvidence/evaluateCheck/responseInvariants` to resolve indexed provenance **within the required response**. Parse the **server-emitted serialized JSON-RPC frame text** losslessly using an independent lexical-number reader in eval code (the existing serverSide.send hook must capture the string before forwarding; real stdio byte capture also qualifies). InMemoryTransport client-decoded objects/JSON.rawJSON wrappers are not lexical evidence. Use this capture, not core decimal/projection helpers; ordinary JSON.parse would erase 7.0 before checking. A metadata field in another response cannot repair a missing clinical fact/citation.

Guard mutations drop a unit system/comparator/coding version, detach a component label, round decimals, omit a modifier, change an index, omit version identity in selected output, or discard an omission when retention fails. Every mutation must fail a critical fact or invariant. The primary risks are semantic loss in nested projection and false savings obtained through missing evidence/fewer successful tasks. Preserve payload/prose screening before any format and independently scan both text and structured output/retained state for forbidden markers.

## 5. Structured-host slim-text profile — M

### Interfaces and activation

Trusted config adds:

```ts
delivery?: {
  profile?: 'full-text-v1' | 'structured-evidence-v1'; // default full-text-v1
  hostProfileId?: string; // bounded registry ID, regex /^[a-z0-9][a-z0-9.-]{0,79}$/
};
```

`hostProfileId` is required for structured-evidence-v1 and must resolve to a release-pinned **verified** registry entry covering that exact host/client version, era, transport and workflow. An unknown/unverified combination fails startup with `UNVERIFIED_HOST_PROFILE` and advice to use full-text-v1. No `output` argument, clientInfo string, MCP capability claim, tool result or model assertion can enable it. The shipped registry has zero verified cells unless real host captures exist; renderer-only M3b may ship with every named-host cell unmet. Omitted profile uses full bounded envelope text. The old operator `textMode:'envelope'` is a deprecated alias for full-text-v1; `textMode:'summary'` fails `INVALID_CONFIG` with a migration message. Conflicting old/new config is invalid. Do not preserve the old evidence-free summary as a public validated profile.

Full-text-v1 preserves the §0.4 envelope as serialized text plus structuredContent. Structured-evidence-v1 preserves the **same complete envelope** in structuredContent and emits concise evidence text via new `evidenceText(envelope)` in `delivery.ts`. Keep `summaryText` only as a compatibility helper if tests/imports need it, never as the structured profile implementation.

The text has actual evidence, not “N records”: source alias/context handle; one bounded record line with type/ID/version, code system/code and value/unit/time/status where those are safely interpretable; explicit structural/uninterpreted markers otherwise. Include exact necessary continuation/error controls: coverage state/scope/reasons and ordering limitations, has_more including null, cursor, data.next_offset, result handle/expiry, warnings with repairs, payload/oversize manifests, error code/message/retryability/repair. Clinical scalar serialization uses lossless helpers; render text as untrusted evidence, with escaped controls and no new clinical interpretation. The registered host trace must prove all additional critical component/range/modifier facts and citations in structuredContent reach model input. If the renderer cannot safely summarize a result kind, use full-envelope text **for that result**, label the actual delivery profile full-text-v1, and recompute the whole byte allowance; no silent factless fallback.

No new error is needed for downstream delivery loss: the gateway cannot detect a host silently discarding structuredContent after sending the result. A failed capture disables that registry cell and requires full-text configuration. Do not claim runtime automatic detection of a downstream loss. Pre-send unresolved profile/version/era is rejected or conservatively full-text before clinical disclosure, never repaired by an agent's host claim.

### Changes, data, acceptance, eval, risks

Add `delivery.ts`: versioned `DeliveryProfile`, `resolveDeliveryProfile`, `evidenceText`, final `toMcpToolResult`; re-export the existing serialization entry from contracts/core. `FhirGateway.toToolResult/bytes/fit` use the exact resolved profile and negotiated era, including full-text fallback cases. The repaired SDK factory supplies actual protocolEra rather than leaving legacy on modern accounting. Store neutral sanitized evidence; do not retain a host-specific rendered copy or let a cursor rebind to a different context through a profile change. Adapter/CLI choose trusted configuration, not policy or clinical projection.

Add `packages/core/src/data/host-profiles.json` and `docs/HOST-PROFILES.md`. Each entry has `{id,version,host:{name,version,client_stack,client_stack_version},era,transport:'stdio',workflow:'recent-labs-v1',delivery_profile,verification:'verified'|'unverified'|'fixture_only',trace_sha256,model_input_sha256,tests,checked_at}`. Only `verified` entries can enable public config. Store sanitized synthetic wire and model-input captures under `packages/evals/fixtures/host-traces/<id>/` with their generator/capture instructions; hash files and exclude secrets. A renderer fixture is `fixture_only`, not a named-host result or a third independent client. Do not invent a real-host version or verified cell in code to pass tests. Capturing a host's actual pre-inference model-input messages can verify delivery without a hidden model call; when that boundary is unavailable, leave the cell unverified until an explicit validation run can capture it.

Tests enable the renderer through a second **programmatic test-only constructor dependency**, `FhirGateway(config, { testDeliveryRegistryOverride })`, whose exact type is frozen at F. It accepts immutable fixture registry/capture data only in test harness construction; it is absent from `GatewayConfig`, `configSchema`, environment and CLI flags. It never changes authorization or budgets. The CLI factory cannot pass it, shipped public config cannot select fixture_only entries, and package startup tests reject attempts to supply an override/config bypass. Production resolver accepts verified release entries only; fixture-only enablement is labelled in eval reports and does not count as host verification.

`tests/delivery-profiles.test.ts` and both-era real SDK tests cover success, rich component/negation facts, zero results, unknown ordering, local remainder, next_cursor, retained next_offset, expiry, warning/repair, withheld payload, oversized resource, quota failure, cancellation, deadline, non-continuable link and error fallback. Compare independently captured final result bytes to **requested** max_bytes, configured ceiling and reported byte_limit, including SDK metadata/resultType; tests must not reuse `bytes()` to decide pass. Exact guards must discriminate omission of each control line. Unknown profile and forged client claims cannot reduce text; drop-structured simulation fails the named-host contract. No identifiers or clinical bodies in CLI logs.

Eval adds a separate delivery-profile dimension without renaming the three format arms: `delivery-success-rich`, `delivery-partial-controls`, `delivery-retained-offset`, `delivery-error-and-repair`, `delivery-structured-dropped`, `delivery-host-unverified`. Score response-bound critical facts on the host's captured model input as well as on the wire. The drop test must fail clinical delivery even if structuredContent was perfect on the wire. Capture error text as well as success text. Report wire and model-visible tokens separately for A2/B1/B5; do not count two wrappers around the official SDK as two independent stacks. The main risk is saving bytes while starving the model of evidence/control state; the guard is a host-bound trace plus the default full-text policy.

## 6. Support matrix and workflow linkage — M

### Interfaces

Implement `fhir_capabilities(topic:'support', resource_type?, limit, output)` before the first clinical query. Page the 25-class matrix through the same immutable metadata-snapshot mechanism as item 1, with at most `limit` rows and a topic-bound `next_cursor`; follow with topic/cursor only. Shrink to the wire allowance without skipping rows; an indivisible oversized row returns `OUTPUT_LIMIT` with a resource_type narrowing repair. `resource_type` filters one policy row; unknown/unclassified types return a row showing denied-by-default, not a clinical lookup. `source`/context remain trusted selectors.

```ts
const supportRow = z.strictObject({
  resource_type: resourceType,
  policy_class: z.enum(['patient','conditional_shared','denied']),
  patient_link: z.string().max(80).nullable(),
  source_advertised: z.boolean(),
  advertised_interactions: z.array(z.string().max(40)).max(16),
  policy_interactions: z.array(z.enum(['read','search-type'])).max(2),
  executable_interactions: z.array(z.enum(['read','search-type'])).max(2),
  instance_policy: z.string().max(120),
  compact_recipe: z.string().max(120).nullable(),
  workflow_role: z.enum(['required','optional','outside_workflow']),
  limitations: z.array(z.string().max(160)).max(16),
});
const supportData = z.strictObject({
  workflow: z.literal('recent-labs-v1'),
  matrix_revision: z.string().max(80),
  rows: z.array(supportRow).max(25),
  snapshot_revision: z.string().max(80),
  captured_at: isoDatetime, expires_at: isoDatetime,
  next_cursor: handle.optional(),
  default_policy: z.literal('deny_unclassified'),
  clinical_sections: z.array(z.string().max(80)).max(8), // [] in M3b
  document_support: z.literal('metadata_only'),
});
```

`serverData` gains `{workflow:'recent-labs-v1',support_matrix_revision,required_resources:['Patient','Observation'],document_support:'metadata_only'}` and a bounded policy-intersected summary. `resourceCapabilityData` keeps `type`, source `interactions/searchParameters`, `resource_class`, `evidence:'declared'` for source claims, but calculates `implemented_interactions` from the matrix + resolved confinement predicate + source interaction; it adds `instance_policy`, `compact_recipe` and limitations. Shared class membership is conditional instance access, never a permit-all. Metadata enumeration is not a clinical endpoint lookup or a statement that a particular instance exists.

No config can widen the matrix. `workflow` is the one trusted option introduced in item 4; it cannot alter access rights. Unsupported resources still fail the existing capability/policy checks. Errors carry `choose_supported_resource` repair without probing for related records.

### Data and selected dependency decision

Add `packages/core/src/data/support-matrix.json` as the authoritative versioned policy/workflow manifest, read through new `support.ts` (`supportForType`, `effectiveSupport`, `workflowSupport`). Generate `docs/SUPPORT-MATRIX.md` and a distributable copy `support-matrix.json` from the same file. Record package revision, R4/schema digest, policy revision, recipe IDs and test IDs. Validate equality with policy/recipe exports; never derive permission from the documentation artifact alone. Dynamic source-advertised fields are computed at discovery, not baked into the static package.

Explicitly publish the current **15 patient-linked types** and linkage: Patient exact configured ID; Observation.subject; Condition.subject; AllergyIntolerance.patient; MedicationRequest.subject; MedicationStatement.subject; Encounter.subject; DocumentReference.subject; DiagnosticReport.subject; Immunization.patient; Procedure.subject; Coverage.beneficiary; ExplanationOfBenefit.patient; ServiceRequest.subject; Claim.patient. Publish the **10 conditional shared types**: Medication, Organization, Location, Practitioner, CodeSystem, ValueSet, StructureDefinition, SearchParameter, CapabilityStatement, OperationDefinition, with `SHARED_INSTANCE_POLICY`'s exact release/profile/extension/field constraints. Reviewed compact recipes currently exist for eight types; list actual integrated IDs and their limitations, not eight clinical sections. All other R4 types, including Specimen, CarePlan and Goal, remain denied.

**M3b decision:** recent-labs-v1 requires Patient/Observation. DiagnosticReport is an optional linked evidence leg already classified; Specimen contents are not required by its advertised three acceptance tasks. Preserve safe `Observation.specimen`/device/derivedFrom references as provenance/context, but do not resolve them. Do not add standalone or contained Specimen support in this work. Unknown/unclassified contained dependencies continue to deny the enclosing resource uniformly when meaning cannot be preserved; do not strip a specimen/modifier child and then interpret the parent as complete. Document that limitation in the matrix and lab workflow. If the selected partner later needs specimen facts, that is a separately reviewed policy/workflow increment with explicit file assignment and complete fixtures, not an “optional implementation detail” in M3b.

### Changes, acceptance, eval, risks

`resourceClass/authorized/sharedInstanceAllowed` remain enforcement authorities, validated against the manifest. `capability/describe` use `effectiveSupport` instead of equating non-ambiguous class with all advertised interactions. No includes are enabled: published `executable_interactions` never implies `_include`. Preserve the fail-closed contained checks and modifier-safe projection. Correct `synthetic_only` labelling in `examples/demo.ts`, `tasks.ts`, CLI help/doctor, README and status docs: literal loopback is enforced; synthetic classification is an operator obligation; no data classifier verifies it. Preserve historical reports, adding dated current status rather than rewriting old results. Do not copy the stale “78 tests”/era/vendor statements as current evidence.

Fail-before `tests/support-matrix.test.ts`: discovery now exposes the exact policy/source/recipe intersection and selected minimum before a clinical query. Table-driven own/foreign/absent/ambiguous/modifier/contained fixtures must cover each patient predicate and each shared-instance rule through read/search, selected/compact, retained and malicious include responses. Include-mode resources remain undelivered with delivered-only counts and no suppression signal; their presence cannot enable a type. Positive controls are mandatory: a deny-all policy cannot pass. Test missing patient search predicate, declared unsupported resource, residential/untyped Location, uncoded Medication, Coverage dependent/subscriber default denial, foreign contained resources and authorized shared contained dependencies. Unknown Specimen/CarePlan/Goal remain denied without new upstream lookups.

Eval tasks `support-before-first-query`, `support-source-policy-intersection`, `lab-reference-no-hydration`, `contained-unclassified-parent-denied`, `shared-instance-positive-negative` bind facts/limits to the exact discovery/read/retained response and independently assert no hydration request. The support artifact must match tested interactions/recipes and mark real hosts/backends unverified where appropriate. Guard mutants: permit all source-advertised types, treat shared type as sufficient, strip an interpretation-critical child, or advertise a nonexistent clinical section. The risk is turning a useful matrix into an authorization shortcut or overstating breadth. B2/B5 and A3/A5/A6 require explicit unsupported cells rather than invented support.

## 7. complete_for_query and query/sort evidence — M

### Interfaces

No new query argument or model-controlled verification flag. Introduce `query.ts` with `QueryEvidence` and the following exact coverage schema, used for every call:

```ts
const sortEvidence = z.strictObject({
  requested: z.array(z.string().max(80)).max(4).optional(), // full evidence responses only
  effective: z.array(z.string().max(80)).max(4).nullable(),
  evidence,
  order: z.enum(['unspecified','requested_unverified','verified_by_adapter']),
});
const constraintEvidence = z.strictObject({
  name: z.string().min(1).max(160), value: z.string().min(1).max(2048),
  source_reported: z.enum(['matched','not_reported','not_checked']),
  execution: z.enum(['gateway_enforced','tested_adapter','unknown']),
  evidence_ref: z.string().max(120).optional(),
});
const coverage = z.strictObject({
  state: z.enum(['complete_for_query','partial','unknown']),
  scope: z.enum(['query','page','metadata','resource','retained']),
  reasons: z.array(z.string().max(80)).max(32),
  authorization_limited: z.boolean(),
  query_exhausted: z.boolean().nullable(), pages_observed: nonnegativeInt,
  constraints: z.array(constraintEvidence).max(31).optional(),
  query_digest: sha256.optional(),
  constraints_on_first_page: z.literal(true).optional(),
  sort: sortEvidence.optional(),
  query_evidence: z.enum(['metadata_snapshot','exact_id_and_subject_linkage',
    'declared_and_self_link_only','tested_adapter',
    'unverified_continuation','retained_snapshot']),
});
```

Emit each ordered outbound material pair, including trusted confinement, **once** in `constraints`; remove `requested_constraints`, `source_reported_constraints`, `executed_constraints` and the old grouped values array from wire schema 0.2. `_count`/paging offsets are mechanics, represented by `pagination.requested_page_size`; `_sort` is represented once by `sort.requested`. At most 30 caller pairs plus confinement remain after excluding those controls. Repeated equal pairs retain separate positions and multiset cardinality. Under the [reviewed duplicate-predicate amendment](m3b-exact-duplicate-compatibility-amendment.md), `source_reported:'matched'` means that occurrence's distinct exact decoded predicate was present in source self evidence; identical requested occurrences may share that source assertion while their original positions/cardinality remain frozen; missing self-link evidence is not_reported/not_checked, never fabricated. A material mismatch or extra unsafe/material pair refuses the candidate page; no mismatched source value is echoed.

Requested, source-reported and executed remain distinguishable **derived views**: all entries; entries with source_reported=matched; entries with execution≠unknown. PLAN §5's `executed_constraints` concept maps to the last view in application schema 0.2, not a fourth repeated payload. `constraintNotClaimed` and other legacy eval invariants must use this view.

`query_digest = SHA256(UTF8(JSON.stringify({v:1,source_revision,policy_revision,context_handle,resource_type,constraints:orderedPairsWithoutPagingOrSort,sort:requestedSort})))`, with precisely that key order and no whitespace; each pair has keys name then value, source_revision is the frozen source.capability_revision, policy_revision is context.policy_revision, and context_handle is context.handle (requestedSort is [] when absent). It is protected query identity, never a locator or a log field. Include it on every search-chain response. Full constraints appear on the initial search response, retained inspection/projection, and the first response whose evidence flags/proof references change. On an unchanged continuation emit only the digest plus `constraints_on_first_page:true`, omitting constraints and `sort.requested` while retaining current effective/evidence/order controls. `sort.requested` is required when constraints are present on a query with sort; omission is legal only with the digest shorthand. If an evidence-change response needs flags, resend the bounded full structure and original sort; the query digest stays stable because flags are not query identity. A replay of the original response still contains its original full structure. Inspection remains self-contained. If an indivisible full structure cannot fit, return fitted OUTPUT_LIMIT; do not silently abbreviate values.

Freeze the query and evidence records once in backing metadata and reference them from overlays. The eval verifier resolves the digest within the **same chain/step** from the first/full response or retained inspection, carries the most recent evidence flags forward, checks every outgoing original-pair multiset independently, and fails on a missing/foreign/mismatched digest or illegal evidence upgrade. It cannot borrow clinical facts/citations from another response. Consumers starting from a saved cursor without its initial response must inspect the retained slice for the full query metadata; no new arbitrary query lookup is added.

`pages_observed` counts upstream pages in this query chain, not local remainder deliveries or replay; inherited overlays do not double count shared fetches. `query_exhausted` is false with retained remainder or a valid advertised next page; null for unknown/rejected continuation; true only after the observed authorized query is drained. `scope:'page'` is still correct for a search result: terminal complete_for_query describes observed query exhaustion, not that all query records are in this one response. Keep that distinction in text.

Always carry the standing authorization/source caveat, independent of suppression: `authorization_limited:true` and `CLINICAL_RECORD_COMPLETENESS_UNKNOWN` on clinical calls. Empty, exhausted, complete-for-query and entire-chart-complete are different concepts. Retained projection/inspection is never an entire-query completeness assertion; its state remains partial with `RETAINED_PAGE_IS_NOT_THE_ENTIRE_QUERY`, `query_exhausted:null`, and `query_evidence:'retained_snapshot'`. An authorized exact read can be complete_for_query for that resource only. Metadata completeness concerns that snapshot query, with `authorization_limited:false`, not clinical coverage.

New fault `UNSUPPORTED_SORT` for invalid/unreviewed sort syntax/name, non-retryable, with discovery repair. `_sort` is at most four reviewed names, optional `-` direction, no expressions/chains. New warning `ORDER_UNVERIFIED` labels valid requested but unproven ordering. Existing `UNVERIFIED_QUERY` is used for contradictory verified filters or sort; repair points to discovery/repeating the original query, never removing material constraints. `FILTER_EXECUTION_UNVERIFIED`, `CONTINUATION_QUERY_UNVERIFIED`, `NON_CONTINUABLE_UPSTREAM_LINK` retain repaired semantics; no raw outcome text is echoed.

### Proof rule and changes

Extend `Snapshot` with immutable `queryEvidence` and overlay `deliveredCount`, `pagesObserved`, `sortProof`, non-continuable/refusal flags; freeze their exact types at F. Query values are shared once, evidence flags are small overlays, and the digest does not replace validation. Keep these small in overlays; do not duplicate backing bodies or extend absolute TTL. `discover/search/fetchPage/continuation/page/render` call `query.ts` helpers `buildQueryEvidence`, `validateReturnedPredicates`, `validateSortBoundary`, `coverageForSnapshot`.

Use two evidence sources only:

1. Gateway-enforced binding and exact read identity/linkage, with existing authorization on every delivered record. Uncertain confinement typing is denied **before** clinical fetch; a material authorization constraint is never merely labelled unknown and allowed.
2. An approved, versioned adapter conformance profile, constrained to its exact source software/version, normalized capability contract, query syntax, resource paths, match modes and continuation form. A profile has fixture/seed/backend/config digests, required positive/negative tests, evidence timestamp and immutable report hash. Generic R4 defaults to unknown clinical filter/sort execution. Runtime self links or one matching result never promote generic support to tested evidence.

For the recent-lab profile, prove code/system matching, repeated date windows and descending `date` on the reviewed Observation effective-time choices. An independent controlled-backend suite must test AND dates, escaped token OR/system/code, date precision/timezone/interval semantics, clinical date versus `meta.lastUpdated`, tie behavior and pagination. F must migrate the eval fixture as specified below before synthetic-fixture-r4-v1 can supply proof; the current fixture implementation is not an oracle. Unsupported effective Timing/interval/sort semantics remain unverified for that query or refuse clinical projection; no ad hoc lexicographic date comparison. The profile records exactly which precision/choice/comparator variants it proves. `_lastUpdated` is never renamed to clinical date.

**FHIR date and sort fixture contract.** F owns upgrading fixture execution; Q owns independent expected match/order vectors. Freeze vectors from [FHIR R4 date/range search](https://hl7.org/fhir/R4/search.html#date), not by running fixture functions. Dates represent precision intervals; normalize offsets, use explicit UTC for timezone-free fixture dates, and allow unbounded Period endpoints. For search interval S and resource interval T: eq means S contains T; ne is its complement for a present value; gt/lt test T extending above/below S; ge/le add eq; sa/eb require T entirely after/before S. No `Date.parse` instant equality for partial dates, no `ap=eq`; fixture ap remains explicitly unsupported/unproved until a frozen approximation rule exists. Observation date uses `effective[x]`, never issued. Q's vectors include year/month/day/fractional instants, equivalent/mixed offsets, Period boundaries/overlap/open ends, missing/extension-only values, and issued/effective disagreement.

Sort normalized instants numerically, using the [R4 priority/direction rules](https://hl7.org/fhir/R4/search.html#sort); never localeCompare dates. The initial verified descending-date profile is limited to timezone-qualified effectiveDateTime instants of the tested precision. Partial dates, Period/Timing, missing keys and overlapping/tied ranges lack recency proof unless separately tested; retain unknown order for those variants. A stable fixture identity tie-break is deterministic paging only, not a claim of a unique latest event. An independent lexicographic-offset-sort mutant and each boundary mutant must fail profile registration. Proof records filter and sort variants separately, so a valid filter can remain proved when ordering is unknown.

`validateReturnedPredicates` provides contradiction detection over **authorized raw records before projection**, limited to the profile's reviewed semantics. If an allegedly enforced code/date predicate contradicts a returned record, or allegedly sorted pages contradict within-page/cross-page order, refuse the candidate page with `UNVERIFIED_QUERY`, invalidate that source profile's observed execution evidence for the current process, and preserve no new disclosed handle. Do not silently discard mismatches and claim complete; post-filtering cannot prove omitted upstream records or safely replace confinement. Do not locally sort one page and claim globally latest. A matching page is not new proof against upstream false negatives; completeness remains relative to the source's observed query and tested adapter scope.

Keep the requested/source-reported/executed **views** distinct within the single constraint structure/digest contract above, including opaque continuations; never reintroduce repeated arrays. Opaque query-bound paging is eligible only under its reviewed profile/form, with preserved query identity and binding; it never obtains evidence merely because `_getpages` exists. Do not broaden the repaired M3a accepted forms. A continuation outside that tested form must retain all original material pairs or be rejected before fetch. Reject conflicting repeats, extra material constraints, dropped code/date/patient/sort and unsafe URL forms. A safe completed page with an unsafe/unsupported next link returns partial, `has_more:null`, no cursor and explicit non-continuable reason, never total query failure or exhaustion.

Coverage decision table, in priority order:

| Condition | State |
| --- | --- |
| Tool failure/contradiction/unproven authorization | Safe error envelope, unknown; no resources |
| Retained scope | Partial retained-snapshot limitation |
| Useful safe evidence but local/upstream remainder, precision refusal, output cap or rejected next link | Partial, with non-suppression-dependent reasons and correct continuation/null |
| Observed exhausted clinical query but any material membership filter execution is unknown | Unknown, query_exhausted=true, explicit filter reason; order reported separately |
| Observed exhausted query; every material membership filter proved; no delivery loss | Complete_for_query, standing clinical-history/authorization caveat; requested sort may be unverified |

Sort never changes set completeness. An exhausted, filter-proven query with unproved sort remains complete_for_query, with `sort.order:'requested_unverified'`, `effective:null` and `ORDER_UNVERIFIED`. If a profile claimed sort proof and the candidate contradicts it, the existing contradiction refusal still applies. Test ignored sort once without proof (complete set, unknown order) and once under a claimed proof (UNVERIFIED_QUERY); neither can answer “latest.”

OperationOutcome classification from repaired V-9 remains in effect: severity/code/expression/tested semantics all matter; benign informational issues differ from filter uncertainty; hard errors cannot be downgraded because diagnostics mention a parameter. Evidence downgrade is sticky across the query chain, including remainders and replay. Counters/coverage/total presence must never depend publicly on suppressed foreign entries. Leave M3a's safe delivered-count total rule intact.

### Data, acceptance, eval, risks

`packages/core/src/data/search-profiles.json` is shared with item 1. Include declared syntax separately from independently tested execution and continuation forms. Generate `docs/QUERY-EVIDENCE.md` from profile evidence and explicitly list generic limitations. No arbitrary trusted URL or deployment-supplied “verified:true” bit. If HAPI's exact version/profile tests fail, leave its execution unknown and do not register `hapi-r4-labs-v1` as eligible.

Fail-before `tests/query-evidence.test.ts`: the baseline terminal search stays unknown even on a controlled fully proven adapter; new code may return complete_for_query **only** with all proof conditions. Controlled backends independently ignore code, either date bound and sort while echoing perfect self links. Same-patient decoys excluded by exactly one predicate must be seeded and readable positive controls. Reverse pages/cross-page boundary violations fail; missing proof only downgrades. Test partial precision dates, Period overlap/ties, no date/sort, unknown comparator, empty verified filter, empty unverified filter, outcomes at each severity, empty authorized page with next, budget remainder, invalid next, opaque page and retained view. Test original repeated multisets and no new upstream request on rejected next links. Replay does not increment pages_observed or claim exhaustion prematurely.

Eval tasks `query-complete-proven`, `query-echo-only-unknown`, `query-ignore-code`, `query-ignore-date-lower`, `query-ignore-date-upper`, `query-ignore-sort`, `query-cross-page-sort`, `query-empty-page-with-next`, `query-invalid-next-safe-first-page`, `query-opaque-evidence`, `retained-not-query-complete` bind constraints/sort/citations to the exact step/page. Extend `Check` with `queryEvidence` and `sortEvidence` predicates over the captured response, while the fixture independently records actual requests and configured ignore behavior. An earlier correctly sorted read cannot satisfy a later search. Kill mutations that promote a self link, drop a date/code/sort on continuation, use first-page local sorting as global proof, or publish upstream totals/suppression-dependent reasons. This is a principal B3 risk: confident false completeness/recency can be worse than a clear refusal.

## 8. Pinned package, OCI candidate, and ten-minute quickstart — M

### Interfaces and release content

Keep `fhir-mcp-gateway --config <path>`, `--doctor --config <path>`, `--help` and `FHIR_MCP_CONFIG`. Add read-only CLI `--version` with exact package/runtime contract version; no server/URL/header flags. `--doctor` validates runtime lossless JSON support, config/profile registry, literal-loopback confinement, source FHIR release/capability revision, workflow minimum/effective support, output profile/default/limits, schema/parameter/support digests and declared synthetic classification. It performs metadata/discovery only, never a test clinical read or hidden seed. Exit 0 on these checks passing, 1 on source/workflow readiness failure, 2 on config/runtime/unsupported-profile error. Print safe fixed labels/counts/codes, no patient ID, body, credential or token URL query. Normal stdout remains MCP traffic only.

No new clinical tool schema or envelope field beyond the earlier items. Packaging exports the same five tools/contracts/support artifacts. Exact Node patch/image/package versions and digests must be chosen and recorded by root from the integrated test environment; `>=24` alone is not an exact test pin. V-34 runtime enforcement remains mandatory. Keep the npm package private during candidate creation; publishing is a separate owner decision. Use a proposed next pre-release version selected by root once, consistently in package/lock/SDK serverInfo/byte accounting/artifact names; do not hard-code a second divergent version.

### Data and generation

Root owns package manifests/lock, build include paths, package file allowlist, `.npmignore` if needed, root `Dockerfile`, compose inputs, release scripts and dependency installation. `npm pack --ignore-scripts` must use a previously checked built tree; an explicit build step precedes it. Candidate includes dist CLI/core/auth and required generated JSON, license/notices, contract/support/profile artifacts, README/quickstart, synthetic configuration, pinned seed manifest and runnable SDK quickstart client. It excludes `.local`, credentials/env files, research/audit raw traces, tests/working trees, node_modules and clinical data. Audit `npm pack --json` file list and tar contents. Test installation into a fresh directory without repository source, tsx or working-directory-relative imports. Add source maps only if their sources/content are deliberately included and reviewed.

Add `examples/quickstart/` with `client.ts` (build to packaged JS), `config.json`, `host-config.example.json`, `seed-manifest.json`, and three workflow scripts/fact expectations; `docs/QUICKSTART.md`; `scripts/verify-package.ts`. `client.ts` uses the pinned official SDK and stdio subprocess, is an explicit developer/test client, and does not call a model. Root decides whether its SDK dependency is a separate pinned quickstart install or a packaged development helper; it must not accidentally turn the client SDK into an unapproved runtime dependency. A missing helper dependency is a clear prerequisite, not a claim that a clean install worked.

Pin HAPI **image digest**, FHIR/R4 version, platform, database/compose inputs, Synthea generator commit/version, seed, generator config, fixed dates/as_of, source export hashes and license/provenance. Store reviewed synthetic export/edge fixtures under `packages/evals/fixtures/quickstart/` with `fixtures-manifest.json`; large measurement charts may be generated from pinned inputs into restricted local artifacts. Do not vendor an arbitrary licensed terminology dataset. Seed tooling is isolated from the MCP process and guarded to the disposable literal-loopback target. Seed PUTs are setup actions, not gateway write support. Preserve raw decimal lexemes when seeding and independently inspect stored responses before treating them as precision fixtures.

Build an OCI **local candidate** from the reviewed tarball/lock and exact runtime base-image digest, non-root, stdio entrypoint, no exposed MCP port. Record image manifest/content digest and platform; distinguish a local image ID from a registry digest. Do not invent a tag/digest or push to obtain one. Verify source connectivity through an explicit isolated loopback/shared network namespace arrangement: container `127.0.0.1` must reach the synthetic backend without replacing the config with `host.docker.internal` or weakening loopback checks. For example, on Linux/Docker use a seed/source namespace shared by the gateway sidecar and publish only the FHIR port to host loopback; test the exact compose topology on supported Docker Desktop too. If this cannot work on a platform, mark that OCI quickstart cell unsupported and retain the tested host npm route. Do not claim host-network semantics on macOS without testing them.

Add generated `artifacts/m3b-release/manifest.json` during implementation, with tarball sha256/integrity, unpacked package inventory hash, local OCI manifest digest/platform, runtime/dependency/backend/data pins, contract/support/recipe/search-profile/tokenizer hashes, test report references and gate statuses `met|unmet|deferred`. Artifacts are local review outputs; publication is outside this spec. Package immutable documents cannot contain their own final tarball hash; put that in the external manifest to avoid a circular hash. Human docs name a concrete candidate and hash only after generation.

### Ten-minute path and acceptance tasks

Document prerequisites-ready timing separately from a cold-cache/prerequisite-install run. In the prerequisites-ready lane, supported Node, Docker (for HAPI), the chosen host, and hash-verified artifact files/images may be preinstalled or cached; disclose exactly which. Start in a fresh directory **before package installation, configuration, backend startup, seeding, doctor and task execution** and include all those steps in the ten minutes. Report image/dependency download and runtime/host prerequisite installation time separately for the cold run, and also its total elapsed time. Do not stop the clock around errors, assistance or retries, or exclude backend startup/seed time from the declared prerequisites-ready task. A maintained in-process synthetic demo remains useful but cannot substitute for the packaged HAPI/Synthea lane.

The fresh-directory client must pass all three tasks with no model key:

1. **Recent HbA1c:** doctor/support/typed parameter discovery, search `code=http://loinc.org|4548-4` with two explicit date bounds and reviewed descending clinical-date sort, output exact system/code/version, value lexeme/unit/comparator/date/status and source/type/id/version citations. If sort is unknown, state that and do not answer “latest.”
2. **Status/negation:** inspect a seeded status-sensitive lab or already supported negated MedicationRequest; distinguish corrected/entered-in-error or doNotPerform from an affirmative current finding. The chosen record must be an explicit manifest entry, with expected critical facts and citation. Metadata-only document output cannot masquerade as a note.
3. **Bounded continuation/reprojection:** request a deliberately bounded result, drain protected cursors through authorized evidence without loss, inspect/reproject a retained slice with sufficient selected fields, and show expiry/partial/omission limits honestly. No new query URL is accepted and no payload/secret link is returned.

`tests/package-quickstart.test.ts` plus `verify-package.ts` test the installed compiled bin, `--version`, help/doctor/stdout discipline, actual SDK modern/legacy calls, required JSON artifacts, unknown working directory, runtime rejection, both output profiles where verified, fresh package file inventory, no source fallback and three task facts. Run Linux and macOS-supported runtime assumptions on actual available platforms; unrun cells are unverified. Verify pinned HAPI and Medplum regressions separately, without turning the old client-credentials result into SMART/vendor certification.

Fail-before: private source-oriented checkout has no complete packaged quickstart/Synthea manifest/OCI candidate, and fresh install cannot rely on `npm run dev` or repo files. Test that deleting a generated JSON from tarball or running against an unsupported runtime fails clearly; detecting failure counts as a guard pass, not successful onboarding.

Eval tasks `package-latest-hba1c`, `package-status-sensitive`, `package-drain-reproject` run against the packaged CLI, using response-bound fact/citation checks from the common oracle; invoke with an explicit packaged-bin path. Log all calls/errors and requested budgets. Assert no direct FHIR read by the evaluated client except isolated seed/oracle setup. Keep seed/oracle authority outside the MCP tool loop. An unaided external developer's timing and at least two model-family/text/structured baseline remain the later validation gate. B4's 9/10 external developers within ten minutes is **not** met by our scripts; record failures/assistance/abandonments when that study runs.

Risks: leaking files/secrets in artifacts, weakening loopback for Docker convenience, stale advertised support/runtime pins, and calling scripted timing an unaided usability result. Guard package file lists, secret markers, container-network negative cases, stdout/doctor output and clean-machine tests. No public artifact/upload/GitHub operation is performed by a worker.

## 9. Eval integration and evidence packet

Extend the current harness rather than adding a privileged answer path. Keep `ArmName`/`ARM_ORDER` as fhir/compact/selected and add separate `deliveryProfile`, `hostProfileId`, `era`, corpus/size stratum and packaged-bin dimensions in `RunEvalsOptions/EvalReport`; do not call these independent clinical cases. Version `EVAL_REPORT_SCHEMA` to `fhir-mcp-retrieval-eval/0.3` with explicit application-schema migration. `CallMetrics` gains requested max_bytes, configured ceiling, profile ID, tokenizer counts, captured-model-input hash and independently observed upstream work; all budget assertions derive from captured inputs/results and fixture counts, not gateway claims. Keep original reports reproducible; update README denominators from generated output rather than hardcoding stale counts.

Every new `Check` has `step` and, when a step drains pages, an optional explicit `response_index` selector; a multi-page assertion may quantify all responses or their declared sequence. Critical fact tuples include source/type/id/version, code system/code/version, value choice/lexeme, unit system/code/display/comparator, effective time precision and status. The same response must provide the fact and its indexed provenance. No old read/transcript can satisfy a later retained/repair response. The verifier must reject corrupted indices/versions/step bindings and numeric rounding. Run self-tests/mutants against the verifier itself.

Gate F freezes the serializable check/fixture/task-file contracts before Q/P author data. New checks extend the existing union with **required** `id` and zero-based `step`, and `response_index?: number|'all'` (integer≥0 or all; omitted=0). `all` requires at least one response and checks each; multi-page sequence checks enumerate indexes explicitly. Existing single-step shorthand is migrated by F, not copied into new files.

```ts
type M3bCheck = { id: string; step: number;
  response_index?: number | 'all'; arms?: ArmName[] } & (
  | { kind:'decimalLexeme'; resource_type:string; id_value:string;
      path:string; equals:string }
  | { kind:'citationTuple'; resource_type:string; id_value:string;
      source:string; version:string|null }
  | { kind:'queryEvidence'; state:'complete_for_query'|'partial'|'unknown';
      query_exhausted:boolean|null; reasons_include?:string[];
      constraints?:{name:string;value:string;
        source_reported:'matched'|'not_reported'|'not_checked';
        execution:'gateway_enforced'|'tested_adapter'|'unknown'}[] }
  | { kind:'sortEvidence'; requested:string[]; effective:string[]|null;
      order:'unspecified'|'requested_unverified'|'verified_by_adapter' }
  | { kind:'callOutcome'; outcome:'json_rpc_error'|'sdk_text_error'|'application_error';
      code:number|string }
);
```

`path` is a bounded dotted eval JSON path with explicit numeric array indices (not the public field-selector syntax); equals for decimalLexeme is the **raw numeric token text**, not a parsed number or quoted JSON string. Citation version=null requires no version in the returned resource and explicit absence, not a wildcard. Requested query/sort assertions resolve digest metadata only as described in §7; resource facts/provenance remain response-local.

JSON task files are strict `{schema_version:'m3b-tasks/1',tasks:EvalTask[]}`; F exports the validated EvalTask/Check JSON schema and loader in the existing tasks/runner modules. Load Q and P files explicitly in fixed order, reject duplicate IDs/unknown kinds/unknown keys, out-of-range steps/indexes, invalid paths, nonpositive budgets or unrecognized fixture IDs. Do not execute imports/code from task JSON. Every allowedError remains an explicit expected outcome, never a generic pass.

Worker fixture fragments are strict `{schema_version:'m3b-fixture/1',id,resources:[FHIR objects],raw_resources?:[{resource_type,id,json_text}],search_parameters:[{resource_type,name,type,definition}],behaviors:[{id,ignore_parameters:string[],ignore_sort:boolean,lexicographic_date_sort:boolean}]}` with bounded arrays/strings frozen by F. `json_text` preserves number lexemes; raw/parsed duplicate identities must agree and be unique. No URLs, headers, callbacks, scripts or network destinations in behaviors. Q's independent semantic-oracle vectors are a separate hashed artifact, never generated from filterMatches/sortResources. F owns fragment loading/fixture routing. Worker helper tests may use private fragments; integration tests remain explicitly pending until wired.

F also migrates fixture CapabilityStatements to correct selected R4 types **and canonical definitions** before enabling the resolver: patient/subject→reference; date/birthdate/onset-date/recorded-date/_lastUpdated→date; value-quantity→quantity; name/family/given→string; code/category/status/identifier/_id and other reviewed coded fields→token. Resolve each (resource,name) against the selected ledger rather than a blanket map (including noncanonical legacy aliases). Unresolved aliases are removed or separately reviewed; wide source-only names stay unexecutable. Add `conflicting-types` modes for confinement and date declarations and assert pre-search refusal with zero clinical fetches. Before F freeze, validate captured synthetic HAPI/Medplum metadata against this resolver if captures are available; conflicts become unsupported cells, missing captures unverified cells, never silently fixed source claims.

Initial report output includes `benchmark-manifest.json`, `fixtures-manifest.json`, development task definitions, sealed holdout hashes before run, per-call restricted synthetic traces/model-input captures, `report.json` and a readable report. Record code/artifact revisions, exact pins, all task denominators, failed/unsupported/unmeasured cells, paired size distributions, coverage violations and byte accounting. No golden answers enter an evaluated host's context. Root can later use research/11 §10's native competitor adapters, matched-authority/native-boundary lanes and opt-in model trials; they are outside items 1–8. Do not claim B1/B2's full 200-case gate, B3's 60-case gate or B5's three independent client stacks until the actual case manifest and results meet those denominators. Multiplying formats/profiles is not additional independent cases.

## 10. Execution order, ownership, and integration gates

Sizes are relative implementation/review slices, not schedule promises. Two Muse tasks may run concurrently **only after the root freezes shared contracts and assigns disjoint paths**. Neither task commits/pushes, installs dependencies or edits the other's active files. Shared test fixture/runner edits are integrated by root; workers supply isolated fixture fragments and new tests in their assigned files. No second agent should discover its own incompatible envelope/config contract. This split is a future root dispatch plan, not permission for this design task to touch implementation files.

| Work package | Backlog items / size | Exclusive file ownership | Dependencies and safe parallelism |
| --- | --- | --- | --- |
| **F — root foundation/integration** | Shared parts of 1/2/4/5/6/7; M | `packages/core/src/contracts.ts`, `index.ts`, `transport.ts`, `store.ts`, `privacy.ts`, `schema.ts`, `decimal.ts`; mechanical creation of `projection.ts`/`delivery.ts` stubs then handoff; `packages/server/src/index.ts`, `cli.ts`; existing tests; root manifests/lock/build config; `packages/evals/src/{tasks,fixture,runner,cli,index,catalog}.ts`; `docs/contracts/m3b-tools.json`; `tests/{m3b-contracts,m3b-mcp}.test.ts`; final `examples/tool-calls.json`; dependency installation and final package operations | Begins after repaired M3a. Freeze §10's complete F checklist, 0.2 strict contracts/listed spine, config and ownership; pass catalog byte skeleton; migrate fixture typing/date execution and eval formats. Root alone wires/merges helpers into gateway/adapter and migrates existing tests/harness. |
| **Q — typed discovery, support, query proof** | 1 M + 6 M + 7 M | New `packages/core/src/{search-parameters,discovery,query,support}.ts`; `generated/r4-search-parameters.json`; `data/{search-profiles,support-matrix}.json`; `scripts/generate-r4-search-parameters.py`; new `tests/{search-parameters,support-matrix,query-evidence}.test.ts`; `packages/evals/fixtures/m3b-query/**`; `packages/evals/data/m3b-query-tasks.json`; `docs/{SUPPORT-MATRIX,QUERY-EVIDENCE}.md`; `examples/drafts/q-*.json`; helper tests plus integration-test drafts | Start with F's frozen types/recipe IDs; Q never waits for P's recipe implementation. 1 resolves definition/confinement metadata; 6 freezes permitted workflow/dependencies; 7 uses both and owns execution-profile evidence. May run in parallel with P. Worker supplies patch instructions for root-owned gateway/transport/harness, not edits to those files. |
| **P — projection, delivery, repair usability** | 2 M (descriptions/examples preparation) + 3 S + 4 M + 5 M | Handed-off `packages/core/src/{projection,delivery}.ts`; new `repairs.ts`; `data/compact-profiles.json`; `packages/core/src/data/host-profiles.json`; new `tests/{no-matches,compact-labs,delivery-profiles}.test.ts`; `examples/drafts/p-*.json`; `packages/evals/fixtures/{m3b-projection,host-traces}/**`; `packages/evals/data/m3b-projection-tasks.json`; `docs/{QUERY-REPAIR,COMPACT-PROFILES,HOST-PROFILES}.md` | Baseline/profile work runs alongside Q after F. 3's final NO_MATCHES hook waits for 7; 4's default decision waits for integrated paired measurement; 5's eligibility waits for host trace. P does not edit server adapter, shared schema/gateway or eval runner. |
| **R — root packaging/evidence closure** | 8 M; measurement/integration of all | Root `Dockerfile`/compose/package allowlist/release scripts; `examples/quickstart/**`; `scripts/{verify-package.ts,measure-tool-catalog.py}`; `packages/evals/data/{tokenizers.lock,workflows}.json`; `packages/evals/fixtures/quickstart/**`; `tests/package-quickstart.test.ts`; README, docs/QUICKSTART.md, notices/status/current claims; generated release artifacts | Docs/container/package skeleton can be prepared during Q/P without touching their paths. Final build/pack/OCI/quickstart uses only completed integrated helpers and evidence. Root handles dependency approval and all version/pin decisions. |

Root can reassign an entire completed file with an explicit handoff; never split concurrent ownership of `index.ts`, `privacy.ts`, `contracts.ts`, server files or the shared eval runner. Pure-module signatures must be agreed before Q/P run. New helper tests use local fixtures under their own ownership; neither worker silently extends another's fixture server.

**Gate F freeze list (root-owned; required before Q/P start):**

1. Application 0.2 strict schemas, listed ≤2,000 B spine, strict input JSON schemas/permissive SDK wrappers, byte-floor/error admission, config migration and file handoffs. Server declares `capabilities:{tools:{listChanged:false}}`; both-era initialize/discovery assertions verify it. Never advertise a notification that is not emitted.
2. Exhaustive `FAULT_CODES` and `REPAIR_TABLE:Record<FaultCode,RepairTemplate|undefined>` in contracts. Freeze the following code→action semantics, with every remaining existing fault explicitly undefined (no guessed repair). Q only uses these codes; P implements templates. Root tests table completeness against the integrated fault registry.

| Public code(s) | Frozen advice |
| --- | --- |
| SEARCH_PARAMETER_UNRESOLVED, UNSUPPORTED_SEARCH, UNSUPPORTED_MODIFIER, UNSUPPORTED_COMPARATOR, UNSUPPORTED_SORT | discover_search_parameter / fhir_capabilities; only injected reviewed type/base name |
| DISCOVERY_EXPIRED | repeat_original_query / fhir_capabilities; caller repeats original metadata topic, no cursor/query echo |
| INVALID_ELEMENT_PATH, UNRESOLVED_FIELDS | discover_schema / fhir_capabilities; reviewed resource only |
| OUTPUT_LIMIT | increase_budget to allowed_max_bytes only when it exceeds current_max_bytes, otherwise narrow_query; no unconstrained larger allowance |
| RESULT_EXPIRED | repeat_original_query; no stored ID/query echo |
| CONTEXT_REQUIRED, AMBIGUOUS_PATIENT_SELECTOR | use_current_context; no selector echo |
| RETENTION_LIMIT | narrow_query; no fabricated expiry/retry promise |
| UNSUPPORTED_RESOURCE, UNSUPPORTED_INTERACTION | choose_supported_resource / fhir_capabilities(topic support in instructions) |
| UNVERIFIED_QUERY, UNVERIFIED_CONTINUATION | repeat_original_query; never drop constraints |
| INVALID_ARGUMENTS | undefined; safe_message uses schema-owned paths |
| NOT_FOUND, POLICY_DENIED, INPUT_LIMIT, INTERNAL_ERROR and all other baseline faults | undefined; retain safe public code/message/retryability behavior |

3. `RECIPE_IDS` in contracts contains all integrated existing IDs plus `r4-lab-evidence-v1/Observation.2`; freeze exact values after baseline, no independently generated strings. Q's support manifest and P's compact manifest consume these constants; root tests equality and that documented IDs have implementations. Also freeze workflow/client recipe IDs `recent-labs-v1` and `observed-code-scan-v1`, distinct from projection recipe IDs.
4. Inject reviewed-name checks: `ReviewedNames={resource(type:string):boolean;parameter(type:string,name:string):boolean}`. Root wires it from Q's selected definitions/support intersection; denial/unadvertised/source-only names return false. `repairForFault(code:FaultCode,meta:{resource_type?:string;parameter?:string;allowed_max_bytes:number;current_max_bytes:number},reviewed:ReviewedNames):Repair|undefined` and `repairForNoMatches(type:string,reviewed:ReviewedNames):Repair|undefined` belong to P. P must not import Q, even indirectly through data files.
5. **Per-call era/profile:** `execute(tool,input,{signal?,deadlineMs?,era})`; era is required for adapter calls, with conservative modern default for direct library calls. `toToolResult(envelope,{era,profile})`; `createMcpServer(gateway,{era})` constructed inside `serveStdio(({era})=>...)`. The eval openSession and compiled CLI use that factory. Remove constructor-only `protocolEra`/GatewayConfig era selection. Resolve trusted delivery profile once for the actual era; bytes/fit/final adapter projection use that same immutable context, including fallback. No mutable gateway-wide last-era or cross-session race. Exact helper types include optional signal/deadlineMs in one exported call-options contract. execute passes an immutable local DeliveryContext through render/bytes/fit; the adapter supplies the same era and the final transform.delivery_profile to toToolResult. No constructor setting or mutable last-call profile supplies accounting.
6. Pure APIs and overlays: Q owns `coverageForSnapshot(evidence:QueryEvidence,chain:QueryChainView):Coverage`, `noMatchesEligible(coverage:Coverage,deliveredCount:number,filtered:boolean):boolean` (called only for successful clinical queries, true only with terminal exhaustion, zero delivered count and a material filter; unknown execution is eligible); QueryChainView freezes `deliveredCount,pagesObserved,queryEvidence,sortProof` plus remainder/continuation/refusal states. P owns `projectionMeta(record:SanitizedProjectionRecord,format:'fhir'|'compact',fields?:readonly string[]):ProjectionMeta`, where the record is neutral sanitized resource plus policy/payload omission metadata and retrieval time; ProjectionMeta includes recipe_id, actual omitted/unresolved paths, structural status and bounded warnings. F defines/exports these shared types; no worker invents private variants across the boundary.
7. Serializable eval Check/response_index/task loader/fixture-fragment formats from §9, independent oracle vectors, protocol/SDK/application outcome classes, and digest resolution. F owns contract/MCP tests and fixture migrations. Test-only delivery-registry dependency and CLI exclusion are frozen here too.

**Worker test delivery:** helper-level tests must compile/run with assigned pure modules before handoff. Gateway acceptance tests are authored in worker-owned test files and explicitly marked `todo` with integration dependency until F wiring; they do not count as passing acceptance. Root removes all such TODOs and runs them before closure. Each worker supplies a wiring patch/instructions, not concurrent edits to root files. Private wiring may be exercised only in a root-assigned isolated worktree starting from the committed F baseline; uncommitted shared edits are never assumed copied. Worktree creation/setup/git belongs to root, so no mandatory private fork blocks helper work. Root owns the final combined examples after Q/P drafts and tests them against both strict contracts and actual adapter results.

Execution checkpoints:

1. **M3a baseline gate:** root integrates repairs A/C, compiles and runs relevant full suites, both-era evals and scoped mutation gate. Record baseline code/artifact/data hashes and raw/FHIR/compact/selected output sizes. A green M3b task cannot conceal an unfixed V-row.
2. **Contract gate F:** complete all seven freeze groups above, validate strict/spine containment and fixture metadata/semantics, and pass the per-tool/full byte skeleton before dispatch. Final integrated examples come later; stub examples cannot be counted as implementation. Token gate may remain explicitly unmeasured, but a known byte overflow cannot be frozen.
3. **Parallel Q/P development:** Q implements item 1 then 6/7 proof; P implements 4 and profile renderers plus 2/3 data/tests. Packaging text may be drafted separately. NO_MATCHES needs terminal delivered-count/coverage wiring, not verified-filter proof; completeness and efficiency/default claims still require their respective proof/measurement.
4. **Root integration:** wire Q into discover/search/fetchPage/continuation and P into render/serialization/repairs; update existing eval oracle once for indexed provenance and new evidence fields; run item-specific fail-before/mutation tests, both-era real SDK flows, retention/epoch/cancellation/strict-search/payload regression suite. Finish item 3, approved host cells and measured defaults only now.
5. **Measurement gate:** freeze development choices and heldout stratum/limits/tokenizers before unsealing; run paired formats × delivery × era and publish all attempts. Check fidelity, independent final bytes, catalog ≤5,000 target, ≥50% compact target and honest fallback/disclosure. Unmet/unmeasured host/efficiency cells remain visibly unmet; no selective rerun/exclusion to obtain a claim.
6. **Package gate R:** `npm run typecheck`, relevant tests then full `npm test`, `npm run build`, both-era retrieval evals, compiled packaged SDK quickstart, pinned HAPI/Medplum regressions where applicable, Linux/macOS/OCI cells as actually available. Verify tar/image inventories/digests and no orphan state/forbidden logging. Root stages only completed deliverables; public release/commit operations need their own authorization and are outside this design task.
7. **Validation handoff:** publish local evidence/gate statuses and unsupported cells for review. Unaided external quickstart, selected partner/interviews, two-model-family text/structured baseline, three independent client stacks and competitor head-to-head remain explicit later gates. Any development-sequencing waiver leaves them unmet. A4's trusted patient-selection/control UI is a remote/SMART-path requirement, not authorization to add a model-selected patient picker to M3b.

## 11. Three highest risks to review first

1. **False query/recency assurance:** typed definitions and echoed self links can look like execution proof. Prevent it with closed adapter profiles, independent decoys/faults, explicit unknown order, exact continuation constraints and sticky evidence downgrades; never weaken patient confinement to make a query work.
2. **Fidelity/delivery loss disguised as efficiency:** compact/selected projection or slim-host text can remove modifiers, precision, components, citations or continuation/error controls. Preserve response-bound critical tuples, test the host's actual model-input boundary, keep full text as the default, and disclose missed size targets with the A1 default change.
3. **A useful discovery/support surface widening clinical access:** unknown Patient reference typing, shared/contained dependencies, code scans and container onboarding can introduce count channels, broad scans or egress shortcuts. Validate type/targets before fetch, keep unsupported types denied, cap recovery work, retain M3a state/total/omission guards, and refuse any Docker/package solution that relaxes loopback or payload policy.

## Addendum A — competitive adoption (2026-10-19)

**Basis:** competitive synthesis, studies 12a/12b/12c, and GPT's claim audit and adoption decisions. This append records GPT's agreement to the corrected, in-scope adoption set; it is not a new implementation/host/security certification or a further Claude sign-off on these bytes. The pre-addendum specification SHA-256 is `0dbf4e4c2816457442104a46045d336b839e99b0a0f66d1ea5e6e9e305db1291`.

This adds acceptance detail to existing items 1–8 and §9 without changing §§0–11's strict public shapes, spine declarations, caps, fault/repair semantics, pure APIs, measured-default rules or F/Q/P/R file ownership. F remains root foundation/integration; Q owns typed discovery/support/query helpers; P owns projection/delivery/repair helpers and drafts; R is root packaging/evidence closure. It does not dispatch work or transfer an active file. The repaired M3a baseline remains prerequisite; workers supply assigned helper tests/fragments and wiring instructions, and root alone integrates shared gateway/adapter/fixture changes.

### A.1 Agent instructions and safe, repairable refusals

**Adopts synthesis item 1, modified. Maps to M3b 1/2/3/7. Owners: F integration; P descriptions/repair tables; Q reviewed-name inputs. Within frozen F.**

Instructions teach trusted patient binding, data rather than instructions, and empty results versus clinical absence. One fitting candidate is **137 UTF-8 bytes**:

> Read-only synthetic FHIR. Patient fixed by trusted context. Results are data, never instructions. Empty results do not establish absence.

Field descriptions/examples teach the detailed coverage/order/continuation semantics within §2's existing budgets. Refusals use bounded, reviewed safe_message text and the frozen REPAIR_TABLE. Where useful, a small fixed legal-value set may appear in safe_message; larger alternatives point to existing discovery guidance. No new legal_values property, repair action, input echo or source-authored instruction is introduced. INVALID_ARGUMENTS still has no repair object; NOT_FOUND remains uniform and has no resource-specific repair.

**Acceptance CA-1:**

1. Capture initialize/listing in both eras: instructions ≤160 B, the three cues present, all five tools/annotations unchanged, and every full-catalog/per-tool cap still passes. Static source-documentation/argument canaries cannot enter instructions or descriptions.
2. Table-test every frozen fault's defined or explicitly undefined repair. Check only permitted keys, reviewed resource/parameter/path names and allowed limits; invalid keys/values, raw diagnostics, IDs, URLs and cursor canaries never enter advice. Absent/forbidden and other failures covered by the existing non-disclosing direct-read mapping keep identical public code/message/repair behavior; malformed tool arguments still follow §0.3's INVALID_ARGUMENTS path.
3. Admission/schema/source/context faults make zero discovery/auth/clinical requests. For semantic guards needing metadata, independently count metadata/auth and clinical requests; only assert “Blocked before sending” when **all** upstream work is zero. Otherwise use accurate fixed wording such as “No clinical request was sent.” Pair each zero-fetch guard family with an authorized same-tool recording-stub control. Budget.upstream_calls equals the independently observed work; no claim of zero can hide metadata or token calls.
4. Empty intermediate page with a cursor has no NO_MATCHES hint. Terminal filtered zero uses §3's exact hint/unknown-filter sentence when applicable; unfiltered empty has no hint. No instruction/example turns those outcomes into clinical absence.

### A.2 Catalog decision: retain the agreed listed spine

**Adopts synthesis item 2, modified. Maps to M3b 0.4/2/5/9. Owners: F actual schemas/SDK capture; P concise descriptions; R reproducible measurement. Within frozen F for this recommendation.**

Keep the agreed object-root ≤2,000 B output spine with **every** declared common control, strict core success/error/fallback enforcement, and the permissive SDK input wrapper. The existing plan is already a slim spine. Redundant JSON Schema encoding may be reduced without changing the declared superset or losing mandatory field guidance. Keep all current whole-tool caps, 17,500 B complete reference-catalog cap and actual ≤5,000-token target in **each** pinned encoding; adopt no new hard/stretch cap after freeze.

Historical evidence: baseline tools array 15,071 B, including five 1,827 B output schemas (9,135 B); real-SDK M3b prototype spine 1,937 B and tools 16,369 B; 12c's separate JSON model spine 1,966 B and complete {instructions,tools} 16,862 B. These are different artifacts/boundaries, not final implementation results. AWS's ~1.15k read-only and Last EHR's ~1.1k read-tool + ~0.3k instruction token estimates are not matched tokenizer/host measurements.

The installed TS SDK 2.3.1 server and client use outputSchema to validate successful structuredContent; isError bypasses SDK output validation, so core remains responsible for errors. No supplied study establishes which Claude Desktop/Claude Code/Cursor/VS Code versions validate or send outputSchema to their models. Generated host config is not that evidence. Removing a schema may retain structuredContent, but removes those SDK schema checks and the published common-control type contract.

**Acceptance CA-2:**

1. Capture all actual tools/list pages, instructions and other advertised context in each supported era. Measure each entire tool, the complete reference catalog, wire list/frame bytes and SDK-added fields separately. Hash the capture; listed artifact entries equal actual listings. No omitted field/page, cross-tool reference or remote ref; all local refs resolve and both eras accept them.
2. For the success/error/fallback/oversize/inspection/pagination example corpus, **strict-valid implies spine-valid**. Intentionally corrupt a required common control (e.g. coverage.state) in an isolated SDK fixture and omit structuredContent on a successful result: after listing, the real client must reject each. Separately corrupt a strict-only data/cross-field invariant and an isError envelope: core must reject and fit a validated INTERNAL_ERROR before commitment, even though the SDK spine/error paths are insufficient. Removing output declarations must fail the existing §2 guard test. No intentionally malformed fixture bypass enters production registration.
3. Preserve output floor/ceiling/final-result accounting and admitted-argument application errors in both eras. Listing changes cannot reintroduce raw SDK validation text for admitted faults.
4. With root-approved, pinned offline tokenizer tooling, report both o200k_base/cl100k_base counts and maximum across eras/profiles. Without it, enforce bytes and label token acceptance unmeasured. Record host version/era/transport and actual schema/model-input treatment only when captured; absent cells stay unverified. Catalog savings alone cannot establish B1, B5 or host compatibility.

**GATE-F CHANGE — NOT ADOPTED:** removing outputSchema, dropping/weakening declared spine controls, changing SDK wrappers, or changing frozen byte/token caps requires an explicit root contract revision and revalidation before affected dispatch. This addendum selects none of those alternatives. Root may commission a labelled offline ablation; it cannot silently become the shipped contract.

### A.3 Pre-send syntax checks, stable capability identity and recipe preconditions

**Adopts synthesis item 3, modified. Maps to M3b 1, with client recipes under 2/3/8 and workflow linkage under 6. Owners: Q syntax/revision helpers; F wiring; P recipe drafts; R quickstart. Within frozen F as scoped.**

Implement lexical date/prefix checks and the already specified normalized capability revision. Hash sorted gate-relevant FHIR version, resource types, interactions and search name/type/canonical-definition data; preserve all fields used by permission/proof decisions. Cosmetic CapabilityStatement id/date/meta/narrative/documentation and array order do not invalidate state. Policy/source/auth changes retain their independent invalidation rules. Never retain source documentation bytes merely to hash them.

The recent-labs client recipe checks its explicit code/category and date-window prerequisites before clinical calls. Its HbA1c task retains the precise code and two date pairs. These are **recipe preconditions**, not a new generic fhir_search minimum-filter rule. The observed-code recipe deliberately permits omission of the original code filter under §3 while preserving patient/window/ceilings.

**Acceptance CA-3:**

1. Malformed lexical date (e.g. ge2026-13-01) returns INVALID_ARGUMENTS without a clinical fetch or value echo; a comparator outside the selected pinned/approved list returns UNSUPPORTED_COMPARATOR. Do not interpret prefixes on token/string/reference/uri values. Valid ge/lt repeated dates and escaped code tokens survive exact outbound encoding, including continuations. Code/text/vendor/composite/join admission stays exactly §1's table.
2. Shuffle metadata arrays and alter only id/date/meta/documentation/text: normalized capability revision remains equal and an existing unexpired snapshot cursor retains its original contents/order/absolute expiry. Material type/definition/interaction/FHIR-version changes change the revision and invalidate affected state. Source-documentation canaries remain absent from output, logs, cache and snapshots.
3. A recipe missing its required explicit window/filter stops locally before clinical work with actionable client guidance. Direct schema-valid generic searches with params:[], code-only filters, and §1's exact default generic-r4 HbA1c query still follow the agreed admission rules. The valid generic query fetches and reports unknown filter/order execution; it is not refused solely for lacking proof. The separate observed-code query still works without a code constraint.

**GATE-F CHANGE — NOT ADOPTED:** mandatory workflow filter sets on generic fhir_search, a new admission language or changed fault/repair semantics. Those change accepted execution behavior and require root decision; §6's required-resource matrix does not authorize them.

### A.4 Named support denominator and drift guards

**Adopts synthesis item 4, modified. Maps to M3b 2/6/8. Owners: Q support manifest/docs; F contract/catalog integration; R release/package checks. Within frozen F without a new field.**

Name **hl7.fhir.r4.core 4.0.1** as the pinned resource-definition denominator, deriving its type list/count from the bundled index. Separately enumerate the 15 patient-linked and 10 conditional shared policy classes, their effective source/interaction intersection, actual recipes and zero M3b clinical sections. Unsupported/deferred/decided-against types have explicit reasons in generated docs and the existing limitations/interaction fields. A US Core mapping, if supplied, names its exact source/version and remains documentation rather than a conformance claim; it does not enlarge the support schema or executable set.

**Acceptance CA-4:**

1. Generate docs/distributable support artifact from the authoritative manifest; compare types/linkage/instance rules/recipe IDs/digests/version against integrated policy and RECIPE_IDS. Denied or unadvertised types cannot become executable through metadata or documentation. Preserve the explicit Specimen/CarePlan/Goal and unknown-contained limitations; no hydration or new clinical lookup.
2. Regenerate the pinned R4 denominator/excluded list and assert exact agreement with the bundled index. Do not report 25 classified types as 25 fully supported clinical sections or as US Core conformance. Mutating a supported count, predicate, recipe, executable interaction or exclusion must fail a drift/positive-negative test.
3. Cross-check the five SDK-listed names/annotations/schema hashes, docs/contracts artifact, package/lock/serverInfo release ID, support artifact and **any shipped Registry manifest**. If none is shipped, report that fact; do not invent a validated/published Registry entry. R validates candidate manifests locally with pinned tooling when available; no network publication is implied.

**GATE-F CHANGE — NOT ADOPTED:** a public supportRow.gate enum (even optional) is absent from §6's strict shape and would require root schema/data/example/eval review. Use existing limitations and interaction fields; a gate label never grants permission.

### A.5 Packaged first result and generated host registration

**Adopts synthesis item 5. Maps to M3b 8, with 5/9 evidence limits. Owner: R; F supplies integrated SDK contracts, Q/P completed artifacts. Within frozen F.**

Produce the already scoped pinned local npm/OCI candidates and package inventory checks. Print host-specific Claude Desktop/Cursor JSON, Claude Code command and VS Code servers/type:stdio JSON from one resolved absolute executable/config launch definition. Give each placement/restart/connection instructions. Do not overwrite host settings, embed credentials or silently download/use @latest. Print generation status separately from actual host support/delivery status.

**Acceptance CA-5:**

1. Build, inspect npm pack --json plus extracted tar inventory, install in a fresh directory and launch compiled CLI/quickstart without repo source, tsx or working-directory fallbacks. Required generated artifacts/licenses/client exist; secret/env/research/raw-trace/working-tree files do not. Removing a required JSON artifact fails clearly. Package/lock/bin/serverInfo/version reports agree.
2. Compare each generated host form against the same absolute launch tuple; VS Code uses its own servers/type keys. Doctor emits safe codes/counts and performs metadata only. Host/model-input/version/era cells without actual verification remain unverified; full-text remains default and fixture-only delivery overrides remain unavailable through packaged public config.
3. Complete all three §8 tasks through real packaged SDK calls in both eras: exact cited HbA1c evidence with order limitation where necessary; status/negation; bounded drain plus retained inspect/reprojection/expiry. No evaluated-client direct FHIR read beyond isolated seed/oracle setup. No model key or hidden model call.
4. Record prerequisites-ready elapsed time from **before installation/configuration/startup/seeding/doctor**, counting assistance/retries/failures. Publish cold-cache/prerequisite time and total separately. This is scripted evidence; B4's 9/10 unaided external developers remains a later gate.
5. OCI runs as non-root from the exact base digest, stdio only, with inventoried local image/platform identity. Verify literal-loopback/shared-namespace backend connectivity and negative network cases on each actually available platform. An unavailable/failed macOS or Linux topology is unsupported/unverified, never repaired by weakening loopback or exposing MCP. No tarball/image/Registry publication.

### A.6 Intent-routing descriptions, examples and complete local message tables

**Adopts synthesis item 6. Maps to M3b 2 and recipe linkage in 1/3/8. Owners: P drafts/repair tables; F final adapter/descriptions/examples/contracts; R packages them. Within frozen F.**

Use “action, when to choose, bounded scope, next control” descriptions, with 12c §8's five descriptions as sizing inputs. Keep full examples in examples/tool-calls.json and workflow docs, not tools/list. Maintain locally compiled, versioned description/message tables in assigned files; descriptions are trusted instructions, never runtime overrides/source text. Any separate new data-file path requires root assignment, without altering public contracts.

**Acceptance CA-6:**

1. A completeness check covers exactly the five implemented tools, required input/property guidance and every FAULT_CODES entry's defined/explicitly undefined repair. Delete a required table key or swap a tool message: fail compilation/startup validation or the completeness test before serving. Explicitly undefined repairs remain legal; no fabricated generic repair is generated.
2. Validate shipped literal input/result examples against strict contracts and actual corresponding adapter behavior in both eras, including typed discovery, repeated date pairs, unsupported code:text, zero-match/separate scan, safe cursor, retained slice/expiry and structural fallback. Placeholder/ellipsis/fake cursor examples cannot count as executable acceptance.
3. Listings/field guidance distinguish configured alias, trusted binding, ordered AND pairs/escaped OR, sanitized FHIR, bounded dotted paths, final MCP byte allowance, local retained offset/absolute expiry and query versus ordering proof. No new next_step field/tool/action. Catalog CA-2 still passes; selected 12c property descriptions alone are not proof of completeness.

### A.7 Fidelity mutants and honest compact efficiency

**Adopts synthesis item 7, modified. Maps to M3b 4/5/9. Owners: P projection/fidelity cases; F integration/independent serialized oracle; R measurement/default evidence. Within frozen F with actual omission paths retained.**

Adapt fhirHydrant's dropped-field list into discriminating tests for our contract. Keep response-local indexed provenance and deduplicated recipe_ids **alongside** actual transform.omitted_fields and per-record retained inspection. A recipe ID cannot substitute for actual omission disclosure. Preserve §4's A1 stratum/pre-registration/default/uncertainty rules and expectation that the 50% target may be unmet; no smaller-at-equal-fidelity or competitor ranking follows without the required measurements.

**Acceptance CA-7:**

1. Guard mutants remove Coding.system/version, Quantity.comparator/system/code, identity/meta.versionId/security/profile/SUBSETTED, primitive companions, component association or interpretation-critical modifiers. Each must fail a response-bound critical fact/invariant on an authorized fixture that proves the original field was present and required. Lexical checks read independently captured serialized frames (7.0, 120.00, exponent/negative zero), not client-decoded numbers.
2. An indiscriminate every-depth text drop must fail on required code/referenceRange text. Dosage.text/Annotation.text cases apply only where the existing supported sanitized projection/task actually promises them. Intentional policy/projection omission requires accurate paths/inspection; forbidden note/payload bytes are never restored to satisfy a mutant. For an unknown contained dependency or modifier, verify the already agreed denial/structural fallback rather than demanding new contained types or unsafe clinical interpretation.
3. Across fhir/compact/selected, direct/search/page/retained output, compare exact required value/code/unit/status/time/component/citation tuples within the same required response. Wrong provenance index/version, lost omission metadata when retention fails, or lost structural warning must fail. No per-format exemption for a critical fact.
4. Run the frozen paired corpus/limits and report catalog/request/result/combined model-input tokens separately from duplicated wire bytes, including errors/recovery/pages. All failures/unsupported/capped cells remain visible. Missed/unmeasured/indeterminate targets trigger the exact §4 default/disclosure rule, not a new default or selective rerun.

**GATE-F CHANGE — NOT ADOPTED:** removing actual omission paths/inspection or changing provenance/recipe shapes in pursuit of size. No new note access, projection policy, default-selection algorithm or critical-fact exemption is authorized.

### A.8 Stop-state clarity and bounded escaped-OR code repair

**Adopts synthesis item 8, modified. Maps to M3b 7 for query/stop evidence and 1/2/3 for syntax/recipes. Owners: Q query/syntax cases; P repair docs/delivery controls; F wiring/examples; R workflow manifests. Within frozen F using existing vocabulary.**

Explain stopping causes using the existing combinations of coverage reasons, pagination, budget and typed faults. Distinguish retained wire remainder, rejected next link, retention limit, timeout/deadline and upstream failure; do not introduce server-side coalescing/prefetch or make a failure a successful exhausted query. A prior delivered prefix remains useful evidence when a later call fails, but the failing call follows the existing fitted-error contract.

**Acceptance CA-8:**

1. Independently force: (a) low output budget with retained remainder → partial/MORE_PAGES and working protected continuation; (b) unsafe/broadened next link → safe-prefix partial/NON_CONTINUABLE_UPSTREAM_LINK, has_more:null and no cursor/fetch; (c) retention admission failure → existing RETENTION_LIMIT/fallback behavior with no orphan or promise of unlimited continuation; (d) deadline while a pending fetch is unresolved → existing UPSTREAM_TIMEOUT error, no late handle commitment; (e) next-page upstream error → existing typed fault, no false complete/NO_MATCHES or diagnostic echo. Independently count work; safe earlier results never become entire-chart completeness. Test full-text and fixture-enabled delivery with existing controls intact.
2. A separate observed-code scan retains the trusted binding and original explicit date window, with ≤3 clinical MCP pages (including local remainders), ≤4 MCP calls including needed discovery, ≤20 upstream calls, ≤45 s, ≤24 KiB/call and ≤72 KiB/task, or lower limits. At cap, the client reports partial/SCAN_LIMIT_REACHED; the gateway's last honest cursor/reasons are unchanged. No hidden retry, terminology request or inventory-complete claim.
3. From explicitly cited returned system/code tuples, show one subsequent code query combining candidates with **FHIR escaping of literal comma/pipe/backslash as applicable, then one URL encoding**. For a synthetic fixture returning `(http://loinc.org,4548-4)` and `(http://example.test/codes,local,hba1c)` where the second code is the single literal string `local,hba1c`, the code-pair value is `http://loinc.org|4548-4,http://example.test/codes|local\,hba1c`; after URL decoding exactly once, the request recorder must observe that exact value, representing two alternatives, not three. Separate literal-pipe/backslash vectors prove their escaping without splitting a token's system/code boundary. Confirm ordered date pairs, the same binding/window, and ordinary continuation. Same code in different systems is not normalized away. This is a separate exploratory query, not code-equivalence evidence or an automatic replacement for the original answer. Count any later query in its declared task budget, never as free work inside the scan.

**GATE-F CHANGE — NOT ADOPTED:** new public stop/fault/warning/repair codes or changed success/error semantics. If existing controls cannot express a proposed distinction, report that gap for root decision rather than extending the frozen registry independently.

### A.9 Isolation acceptance derived from unverified competitor observations

**Cross-cutting tests for existing M3b 1/2/6/7/9 and repaired M3a. Owners: F shared fixtures/SDK integration; Q selector/query vectors; P delivery/retained checks. Within frozen F; no remote transport implementation.**

Require the exact CA-ISO-01–05 cases in the review:

- **CA-ISO-01:** comma-OR/escaped-list/encoded separator patient substitution; foreign/ambiguous selectors refused before clinical fetch, with valid bound-reference/token-escaping positive controls.
- **CA-ISO-02:** clinical/result/discovery locator substitution across independent contexts/stores/auth epochs; existing uniform unavailable/context faults, no disclosure or late commitment, valid same-store/new-generation controls. These are local-state tests and do not claim SSE session security.
- **CA-ISO-03:** direct/model path traversal and same-origin next-link base escape, including encoded dot segments; strict admission or labelled safe-prefix partial, zero escape requests, safe in-base positive control.
- **CA-ISO-04:** attempted source/patient/query/type injection into fhir_page and tampered/expired/cross-store cursor replay; strict failure, unchanged binding/query, repeated-pair/sort preservation and correct replay counters on valid controls.
- **CA-ISO-05:** model URL/header/ingestion requests, data-carried attachment URLs/inline payloads and redirects; no arbitrary fetch/upload, payload/secret-link disclosure or credential forwarding to a local recording sink; manifests and safe metadata retained.

Use only isolated synthetic backends/recorders/canaries; prime metadata/auth as needed and record clinical versus total work honestly. Run each applicable case through both-era real SDK calls, direct core validation where relevant, all pertinent projection/retained surfaces and independent serialized text/structured/log/state checks. Every zero-fetch denial needs a positive control; a deny-all stub cannot pass. Count only manifested executed cases and designated mutant kills. Multiplying formats/eras does not satisfy benchmark B2's 200-case denominator.

The competitor observations remain unverified. No public vulnerability claims or upstream reports follow from these tests; competitor reproduction/reporting needs a separate safe synthetic reproduction and explicit owner approval, using the project's security channel. Remote/SMART authentication (synthesis item 9), terminology/operations and the conditional A-8 note slice (item 10) remain outside M3b and are not adopted here.

## Addendum B — catalog decision (2026-10-19)

**Decision: adopt option (c), a minimal listed output schema.** GPT's decision and measurements record the read-only Claude–GPT exchange and agreement. This is an explicit revision of the listing/cap requirements in §0.4, §2, §10's freeze checklist and Addendum A.2, including CA-2.2. Where those passages require the complete ≤2,000 B spine to be listed, the old 17,500 B catalog/whole-tool caps or the old ≤5,000-token M3b target, this addendum supersedes them. Prior measurements remain historical. PLAN 0.4, strict input/output contracts, policy boundaries, A1/A2, CA-1, A.6 and F/Q/P/R ownership remain unchanged. This amendment does not pass gate F or dispatch implementation work.

### B.1 Listed schema and enforcement

Each of the five implemented tools lists exactly this schema (97 B compact JSON; additional properties allowed):

```json
{"type":"object","required":["schema_version"],"properties":{"schema_version":{"type":"string"}}}
```

Freeze these keys and values, allowing only the SDK's recorded property ordering by era; the serialized schema must be ≤100 B. No additionalProperties:false, extra control declarations, remote/cross-tool refs or automatic schema-version const is adopted. The permissive SDK **input** wrapper and strict listed input bounds/refinements are unchanged. Full evidence and controls remain in structuredContent and the full-text fallback. Publish the full spine separately, alongside the complete strict schemas and actual listed schemas in docs/contracts/m3b-tools.json, with version/hash and refinement/migration rules.

**Accepted loss:** the real SDK client now checks successful structured-content presence, object root and required string schema_version; it no longer validates the full spine's coverage, delivery, pagination, provenance or other control types. Unknown version strings pass. SDK 2.3.1 skips isError output validation under either design. The minimal schema does not replace strict enforcement or establish named-host acceptance.

**Sequencing requirement:** root/F must wire and test full strict success/error/fallback and cross-field validation, fitted separately validated INTERNAL_ERROR, pending-handle rollback and final byte accounting **before weakening the listed schema**. During the 0.1 interim, preserve the full published-spine validator and 0.1 envelope validation; the coordinated 0.2 flip must validate actual gateway outputs against the strict 0.2 per-tool contracts. G-6 is not closed by this design decision. Do not expose raw SDK validation text as an admitted application fault.

### B.2 Replacement catalog caps

Caps cover every emitted field of each entire compact-JSON listed tool. Token caps apply independently in both pinned cl100k_base and o200k_base encodings, taking the maximum across supported eras/profiles.

| Tool | Whole-tool byte cap | Whole-tool token cap, each encoding |
| --- | ---: | ---: |
| fhir_capabilities | 2,200 | 650 |
| fhir_search | 1,750 | 500 |
| fhir_read | 1,400 | 400 |
| fhir_page | 1,100 | 325 |
| fhir_result | 1,650 | 475 |
| Sum of separately serialized tools | **8,100** | **2,350** |
| Instructions, wrapper/separators and other advertised context | **350** | **150** |
| **Complete reference catalog** | **8,450** | **2,500** |

Instructions alone remain ≤160 B **inside** the 350 B allowance. Include server identity/capabilities and any other advertised context, including any later resources/prompts; report protocol discovery/framing metadata separately. Measure complete serialization independently as well as the conservative sum of separately tokenized tools and remaining context. Neither may exceed its applicable caps; do not merge separate model messages for tokenizer savings. No bytes-per-token estimate substitutes for either measured encoding. Preserve §2's capture-all-pages, SDK-added-fields, artifact-equality, hashing and offline-tokenizer rules. Record actual host model-input treatment/tokens separately and leave uncaptured cells unverified.

Decision-round measurements with temporary tiktoken 0.12.0, verified encoding tables and network-disabled tokenization reproduced the review's {instructions,tools} boundary: full-spine M3b skeleton **16,393 B / 4,056 maximum tokens**; minimal-schema skeleton **6,933 B / 1,826 maximum tokens**. Adding observed server identity/capabilities gives **7,047 B / 1,861 maximum tokens** for the minimal schema. The old full-spine skeleton therefore **passed** the old 5,000-token target; that target was not a known miss. Final guidance and release acceptance still need actual integrated captures. No repo dependency was installed by this design task, and its temporary environment was removed; release tokenizer pins/locks remain root/R work.

The minimal-schema tools currently measure 1,838/1,425/1,200/940/1,359 B, leaving **362/325/200/160/291 B** of whole-tool edit headroom. These are skeleton budgets, not proof that A.6 guidance fits. Root must capture the required v2 guidance skeleton, preserve all guidance/bounds and pass the replacement caps **before refreezing and affected P dispatch**. A further overflow needs an explicit reviewed revision.

### B.3 Replacement CA-2.2 and host gates

1. Preserve strict-valid implies published-spine-valid, and add strict-valid implies minimal-listed-schema-valid, across success/error/fallback/oversize/inspection/pagination examples.
2. After real SDK listing in both eras, an isolated test-only fixture must show client rejection of missing successful structuredContent (−32600), and missing/non-string schema_version (−32602). Inject malformed responses after server output validation so the test isolates the client; no production registration or transport can expose that bypass.
3. Explicitly record that the minimal-schema client **accepts** invalid coverage/delivery controls, and that isError skips SDK output validation. Corrupt those controls, strict-only data/cross-field invariants and error envelopes at core; require fitted, strictly valid INTERNAL_ERROR before handle commitment and no SDK-only text escape. Strict output enforcement is required independently of the listed schema.
4. Listing/guard mutants must reject removing the minimal schema, adding control declarations or other schema drift, dropping required guidance/bounds, and omitting listing pages/metadata. Freeze and revalidate the actual both-era v2 listings, budgets and published artifacts before affected dispatch. Other CA-2 requirements continue with these replacement schema/cap rules.
5. Preserve the A2/§5 verified-host registry and full-text default. OpenAI's primary Apps documentation directs structured-result tools to declare outputSchema and describe their returned object; (c) satisfies declaration presence but is not proof of exact-object guidance, admission or runtime acceptance. No target host's output-schema injection or schema-dependent evidence delivery was captured here. If a host rejects/degrades this schema, or Apps becomes an actual release compatibility target, reopen the schema decision and test a reviewed alternative. No catalog savings alone enable slim text or establish B1/B5, host compatibility, SMART/vendor support or clinical readiness.

## Addendum C — compact efficiency target (2026-10-19)

**Decision:** adopt Claude's proposal to separate compact fidelity, delivery efficiency and envelope overhead, with the exact targets below. GPT's decision checks Claude's P byte breakdown against the frozen contract. This addendum supersedes §4's within-product ≥50% reduction / compact:fhir ≤0.50 objective and corresponding wording in §10's measurement gate and A.7. It also supersedes §4's permission to default to compact when statistically smaller but missing the point target. Other corpus, measurement, fidelity, policy and host gates remain in force. This is a design amendment, not an achieved result or authorization to change frozen contracts or dispatch implementation.

### C.1 Compact fidelity profile

On §4's predeclared natural heldout large-lab stratum, the target is **median paired total model-visible result tokens `Tcompact/Tfhir ≤0.90`**, independently in each advertised era × eligible delivery profile × pinned reference tokenizer at the primary operating point. Require **100% critical fact/citation/meaning checks, no deterministic task-success loss, and every applicable required fidelity mutant killed**. All §4/A.7 response-bound tuples, numeric lexemes, text, meaning supplements, actual omission paths and structural/denial behavior remain mandatory; no critical-fact exemption or new contained-type support is adopted.

Preserve the 24 paired task instances clustered by eight patients, both reference tokenizers, all recovery/pages/inspection/retries, independent final-result and actual model-input captures, per-call/task limits, and §4's exact bootstrap/uncertainty algorithm. The point target is ≤0.90; the separate evidence-of-smaller requirement remains a **95% interval upper endpoint <1.0**, not ≤0.90. Report median/p90 ratios, intervals, absolute bytes/tokens and every failure/unsupported/capped attempt. Resource bytes, aggregate envelope-byte ratios and bytes-per-token estimates cannot establish this token target. A failed pair cannot count as an efficiency success.

The current eval-byte ratio 1.0155, resource-only lab ratio 0.9277 and simulated v2 full-text ratio about 0.88 are distinct descriptive evidence, not qualifying heldout token results. The simulated slim ratio about 0.91 illustrates why each delivery profile must be reported separately; if its measured token ratio exceeds 0.90, that cell misses this target even when delivery reduces absolute cost.

### C.2 Delivery efficiency

For each format × delivery profile report **absolute model-visible bytes and tokens per correctly answered lab question**, median/p90 distributions and every attempted outcome; report complete wire-result bytes and framing separately. Include all discovery, errors, recovery, pages, retained work and duplicates actually delivered. Report same-format full-text versus verified-slim paired absolute savings separately from within-profile compact/fhir ratios. Failed answers are failures, not cheap successes.

**No numerical delivery-reduction threshold is adopted from the current evidence.** The approximately 38–40% wire and 37% model-visible byte savings are simulated, host-dependent estimates, not measured token savings. Full-text remains the delivery default. Slim activation requires §5's release-pinned verified host/client/version/era/transport/workflow captures proving model receipt of all critical facts and controls; fixture-only cells remain labelled and ineligible. No missing capture may be replaced by an assumed structuredContent view.

### C.3 Envelope overhead

The engineering target is **median per-task combined provenance + withheld-entry + coverage bytes ≤15% of structuredContent bytes**, measured separately for the fhir and compact arms on the same complete primary tasks. For each task sum UTF-8 compact-JSON bytes across all its result messages, then divide the combined component sum by the summed complete structuredContent bytes; take the median across the 24 tasks. The numerator is the disjoint serialized values of `provenance`, `transform.withheld_payloads` when present, and `coverage`; absent components contribute zero. Count each present component's object/array delimiters, exclude its enclosing property name/separator, and freeze this accounting in the measurement manifest. Denominators include the complete structuredContent serialization. Report each component, the combined share, remaining non-resource envelope bytes, distributions and all attempts so a share cannot conceal absolute growth or failure.

This is an envelope engineering target, not a token or delivery target. The review's approximate 17% combined share on one page and possible roughly 12% after safe collapse motivate it; task-level attainment is unmeasured. Indexed provenance, omissions, coverage, controls and attachment metadata remain required. Any deduplication must preserve disclosure/inspection and pass applicable guards within the frozen contract; this target does not itself authorize new shapes, merging distinct attachment manifests or suppressing metadata. A miss is published as target-unmet independently of C.1/C.2; it does not change authorization or the compact-default rule.

### C.4 Defaults, preregistration and external claims

**Default stays fhir until C.1 is met on measured data.** In addition to §4's existing eligibility and release-wide cell-coverage rules, every advertised measured cell used to justify a workflow/type compact default must meet the ≤0.90 point target, be statistically smaller and pass fidelity/task success/mutation gates. Not-smaller, indeterminate, unmeasured or target-unmet cells retain fhir; preserve structural-projection labels and explicit requested/actual format/fallback disclosures. An unmet C.3 target is reported separately; delivery savings cannot stand in for C.1.

Before holdout unsealing, freeze recipe/corpus/query hashes, natural stratum eligibility, per-root development byte contributions, expected byte and token ranges supported by actual development measurements, all three metric definitions/targets, host eligibility and default rules. Replace the old required prior “50% target expected unmet” with **“within-product target ≤0.90; attainment unmeasured until the frozen heldout run”**, alongside the measured development expectations. If token evidence is absent, label that expected token range unmeasured; no fabricated range or efficiency/default win follows. Preserve no-padding/no-augmentation/no-post-hoc-exclusion and no-selective-rerun rules. A previously unsealed or invalidated study requires a new preregistration and valid holdout; this amendment cannot retroactively make its observations confirmatory.

**B1 remains the external headline bet:** on the declared heldout large-chart workload, median total model-visible result tokens **≤50% of both WSO2 and fhirHydrant**, p90 **≤75%**, with all deterministic critical facts preserved and no material task-success loss. Measure it only in the separately pinned head-to-head harness under research/11 §10 and PLAN A7, including supported-task denominators, failures, independent byte/token accounting, equal authority/fidelity and the applicable model-task-success gate. Internal efficiency or renderer measurements establish neither B1 nor competitor superiority. No change is made to §5 host verification, §6 support/confinement, Addendum A.7 fidelity or later clinical/SMART/vendor validation gates.

## Addendum D — S7a usability revision, schema 0.3 (2026-10-24)

**Decision (root):** wire schema 0.3 and catalog revision `m3b-catalog/3`, as specified in [the S7a design](m3b-s7a-design.md) §4 with root decisions R1–R7. In summary: §7's `query_evidence` enum gains `none`, required on every error envelope and rejected on every success; the server capabilities view gains `patient_id` (the configured binding, injected at response time), `snapshot_revision`, `captured_at`, `expires_at` and an optional `next_cursor`, and pages through the existing `fhir_capabilities.cursor` with `limit` default 20, maximum 50, in the fixed order of decision R2; the gate's closed warning catalogue gains `METADATA_BYTE_LIMIT`, emitted only when the packer removed an eligible metadata row for bytes; `fhir_page` keeps its input shape and delivers at most the original search's `_count` per response; terminal unverified continuations keep `has_more: null`, now enforced by the gate. §0.3's omission of a `fhir_page.page_size` argument, the caps of Addendum B and every confinement, disclosure, uniform-`NOT_FOUND`, proof and budget rule remain unchanged. Wire schema 0.2 evidence recorded before this addendum stays 0.2 evidence.

