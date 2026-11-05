#!/usr/bin/env node
/**
 * Emits docs/contracts/m3b-tools.json — the frozen M3b tool contract
 * (gate F, Addendum B.1/B.3.4, R2-3). Since the listing now carries only the
 * 97 B minimal schema, this generated file is the public statement of the
 * full control contract: published spine, strict v2 schemas, the actual
 * listed schemas, the active strict core gate (incl. cross-field rules),
 * fault/repair/recipe registries, caps, ownership and migration rules.
 *
 * Deterministic: no timestamps, fixed key order, canonical section hashes.
 * Usage (tsx resolves the TypeScript contract sources):
 *   node --import tsx scripts/emit-m3b-contract.mjs           # write the file
 *   node --import tsx scripts/emit-m3b-contract.mjs --check   # fail if stale
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CATALOG_BYTE_CAPS, CATALOG_TOKEN_CAPS, CATALOG_VERSION, FAULT_CODES,
  LAB_EVIDENCE_RECIPE_ID, LISTED_OUTPUT_SCHEMA, M3B_SCHEMA_VERSION, OBSERVED_CODE_SCAN_RECIPE_ID, OUTPUT_SPINE,
  RECIPE_IDS, REPAIR_TABLE, SERVER_IDENTITY, SERVER_INSTRUCTIONS_V2, TOKEN_ACCEPTANCE_STATUS, TOOL_DESCRIPTIONS_V2, TOOL_NAMES, TOOL_TITLES, WORKFLOW_ID, WARNING_MESSAGES,
  listedInputSchemaV2, toolEnvelopeV2Schemas, toolInputV2Schemas,
} from '../packages/core/src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CONTRACT_PATH = join(root, 'docs', 'contracts', 'm3b-tools.json');
const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Canonical JSON (recursively sorted keys) — the hash basis, independent of file formatting. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function jsonSchema(schema, io) {
  const out = z.toJSONSchema(schema, { target: 'draft-2020-12', ...(io ? { io } : {}) });
  delete out['$schema'];
  return out;
}

export function buildM3bContract() {
  const listed = {
    output_schema: LISTED_OUTPUT_SCHEMA,
    output_schema_bytes: Buffer.byteLength(JSON.stringify(LISTED_OUTPUT_SCHEMA)),
    tools: TOOL_NAMES.map(name => ({
      name,
      title: TOOL_TITLES[name],
      description: TOOL_DESCRIPTIONS_V2[name],
      annotations: ANNOTATIONS,
      input_schema: listedInputSchemaV2(name),
      output_schema: LISTED_OUTPUT_SCHEMA,
    })),
  };
  const enforced = {
    spine: OUTPUT_SPINE,
    core_gate: {
      composition: 'validateDeliverable02(tool, wire, immutableContext): strict per-tool 0.3 schema, cross-field and trusted invocation/query checks, published spine and minimal-schema containment, and exact complete SDK-result bytes; successes, errors and fallback are gated before handle commitment and delivery',
      emergency_template: 'independent fresh 0.3 template, validated at gateway construction for both eras/profiles (INVALID_CONFIG on failure), fitted and separately gated without the failed normal renderer',
    },
    v2_inputs: Object.fromEntries(TOOL_NAMES.map(name => [name, jsonSchema(toolInputV2Schemas[name], 'input')])),
    v2_envelopes: Object.fromEntries(TOOL_NAMES.map(name => [name, jsonSchema(toolEnvelopeV2Schemas[name])])),
    v2_cross_field_refinements: [
      'query_evidence is none iff error; errors carry no query evidence',
      'error envelope has empty data, no provenance/result/pagination/warnings and clean transform arrays',
      'one response-local provenance entry per delivered resource, with unique in-range resource_index and original retrieval time',
      'returned_matches equals delivered resources and returned_includes is 0; no unsafe upstream total',
      'query coverage binds original ordered material pairs, repeated occurrences, sort, digest and current trusted execution proof; completeness requires exhausted proved membership with no delivery loss',
      'initial, retained and changed-evidence responses carry full query evidence; only unchanged continuations may use digest shorthand',
      'next_cursor agrees with has_more; retained next_offset advances by delivered rows; read never has a cursor; retained scope never claims query completeness',
      'fhir_page inherits the original validated search count as its delivery ceiling and requested_page_size, with no override or source URL rewrite',
      'terminal trusted unverified chains require has_more:null and query_exhausted:null; later pages cannot relabel or complete them',
      'server discovery orders only advertised required types, optional workflow types, other executable types in codepoint order, then other advertised types in codepoint order; existing bound discovery cursors advance by delivered rows with absolute expiry',
      'server patient_id equals trusted configured binding; metadata snapshots contain rows and freshness, never patient_id',
      'metadata rows, counts, cursors/offsets and freshness match immutable snapshot and packing state; METADATA_BYTE_LIMIT and limit_reached hold iff eligible rows were removed for bytes, with the warning included during fitting',
      'metadata data union and closed reasons bind the invoked topic; declared-capability and base-definition caveats remain mandatory',
      'actual/requested format, selected fields, recipe ids, structural indices, omissions and delivery fallback agree with trusted invocation and finally delivered records',
      'actual rendered text, structured content, era-specific SDK fields and server identity match the once-captured immutable delivery context',
      'bytes_returned equals the exact complete SDK result excluding separately reported JSON-RPC framing, within the effective request/config allowance',
    ],
  };
  const body = {
    contract: 'm3b-tools/1',
    generated_by: 'scripts/emit-m3b-contract.mjs',
    m3b_schema_version: M3B_SCHEMA_VERSION,
    runtime_schema_version: M3B_SCHEMA_VERSION,
    catalog_version: CATALOG_VERSION,
    server: {
      ...SERVER_IDENTITY,
      capabilities: { tools: { listChanged: false } },
      supported_protocol_versions: ['2026-07-28', '2025-11-25'],
    },
    instructions: SERVER_INSTRUCTIONS_V2,
    catalog_caps: {
      bytes: CATALOG_BYTE_CAPS,
      tokens_per_encoding: CATALOG_TOKEN_CAPS,
      token_acceptance: TOKEN_ACCEPTANCE_STATUS,
    },
    listed,
    enforced,
    fault_codes: FAULT_CODES,
    warning_messages: WARNING_MESSAGES,
    repair_table: Object.fromEntries(Object.entries(REPAIR_TABLE).map(([code, template]) => [code, template ?? null])),
    recipe_ids: RECIPE_IDS,
    lab_evidence_recipe_id: LAB_EVIDENCE_RECIPE_ID,
    workflow_id: WORKFLOW_ID, WARNING_MESSAGES,
    observed_code_scan_recipe_id: OBSERVED_CODE_SCAN_RECIPE_ID,
    ownership: {
      'packages/core/src/m3b.ts': 'F (types only)',
      'packages/core/src/query.ts': 'Q',
      'packages/core/src/projection.ts': 'P',
      'packages/core/src/delivery.ts': 'P',
      'packages/core/src/repairs.ts': 'P',
      'packages/core/src/catalog.ts': 'root',
      'docs/contracts/m3b-tools.json': 'F (generated; regenerate, never hand-edit)',
    },
    migration_rules: [
      'The coordinated schema-0.3 release serves strict 0.3 envelopes with catalog revision 3 in both protocol eras; no schema selector or 0.2 fallback exists. Full strict 0.2 consumers reject 0.3, and current strict consumers reject literal 0.2. The listed minimal output schema accepts either string but does not establish full-contract compatibility. Migrate error evidence, server paging/binding/freshness, inherited size and metadata byte warnings together.',
      'GatewayConfig.protocolEra was removed (INVALID_CONFIG with migration message); era is supplied per call via ExecuteOptions.era and required on adapter calls.',
      "textMode:'summary' fails INVALID_CONFIG with a migration message naming delivery.profile (G-15, assertSummaryAllowed in delivery.ts, unconditional); textMode:'envelope' is a deprecated alias of full-text-v1 and conflicts with structured-evidence-v1.",
      'The listed input schemas are guidance-bearing supersets of enforced.v2_inputs. A permissive Standard Schema wrapper preserves original arguments; strict core admission, schemas and runtime refinements remain authoritative. All six listed capabilities topics are implemented.',
      'Omitted output.format resolves to fhir without requested_format; explicit format is preserved. Configured defaultBytes/maxBytes are each 8192..131072, explicit default > max is invalid, and effective default is min(defaultBytes ?? 24576, maxBytes ?? 131072). The per-call output.max_bytes floor remains 4096 in both eras/profiles.',
    ],
    history: [
      'Schema 0.2 used six query-evidence values, unpaged server summaries and no metadata byte-limit warning; its historical captures remain evidence of that earlier application revision.',
      'Earlier m3b-tools/1 artifacts published the 0.1 interim gate and listing alongside inert 0.2 schemas. Those sections describe historical development and are no longer active enforcement.',
      'The P guidance scratch capture and decision-round tokenizer skeleton measurements are historical preparation, not current release captures or token acceptance. Current token caps remain UNMEASURED until the pinned offline container gate runs.',
    ],
    hashes: {
      spine_sha256: sha256(OUTPUT_SPINE),
      listed_sha256: sha256(listed),
      enforced_sha256: sha256(enforced),
    },
  };
  return { ...body, contract_sha256: sha256(body) };
}

export function serializeM3bContract(contract = buildM3bContract()) {
  return `${JSON.stringify(contract, null, 2)}\n`;
}

async function main() {
  const check = process.argv.includes('--check');
  const expected = serializeM3bContract();
  if (check) {
    let actual;
    try { actual = await readFile(CONTRACT_PATH, 'utf8'); }
    catch { console.error('emit-m3b-contract: docs/contracts/m3b-tools.json is missing; regenerate it.'); process.exit(1); }
    if (actual !== expected) { console.error('emit-m3b-contract: docs/contracts/m3b-tools.json is out of sync with the code; regenerate it.'); process.exit(1); }
    console.log('emit-m3b-contract: in sync');
    return;
  }
  await mkdir(dirname(CONTRACT_PATH), { recursive: true });
  await writeFile(CONTRACT_PATH, expected);
  console.log(`emit-m3b-contract: wrote ${CONTRACT_PATH}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(`emit-m3b-contract: ${error instanceof Error ? error.message : 'failed'}`); process.exit(2); });
}
