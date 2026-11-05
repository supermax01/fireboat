# Doctor DTO (root decision, 2026-10-24)

- **Status:** frozen by root under `proposals/m3b-s8s9-design.md` D5, after S7a (schema 0.3). It replaces the field proposal in that design's §3. Packaging slice 5 implements it.
- **Boundary:** `packages/server/src/doctor.ts` exports a pure `doctorReport(input: DoctorInput): { lines: string[]; exitCode: 0 | 1 | 2 }`. The CLI builds the input from public gateway calls, the normalized operator policy and the generated release metadata. The formatter performs no I/O, receives no raw configuration, URL, path, credential, patient id, context handle, resource, source software string or exception message, and validates every field before formatting (unknown keys, nested extras and out-of-range values yield exit 2 with `DTO_INVALID`).

## Input

```ts
export type DoctorFault =
  | 'RUNTIME_UNSUPPORTED'      // Node below the admitted floor, or no lossless JSON (JSON.rawJSON / source text)
  | 'CONFIG_INVALID'           // configuration rejected by the gateway constructor
  | 'PROFILE_INVALID'          // configured search profile not eligible or not constructible
  | 'ASSET_MISSING'            // a required runtime JSON asset is absent
  | 'ASSET_INVALID'            // a runtime JSON asset fails its recorded SHA-256
  | 'DTO_INVALID'              // the formatter's own input check failed
  | 'METADATA_UNAVAILABLE'     // the source's CapabilityStatement could not be fetched
  | 'METADATA_INVALID'         // fetched but refused by the gateway
  | 'FHIR_VERSION_UNSUPPORTED' // not FHIR 4.0.1
  | 'WORKFLOW_TYPE_UNAVAILABLE';// Patient read or Observation search-type not executable

export interface DoctorInput {
  release: { name: string; version: string; schema: '0.3'; catalog: 'm3b-catalog/3' };
  runtime: { node: string; platform: string; arch: string; lossless: 'ok' | 'unsupported'; cell: 'recorded' | 'unverified' };
  source: { alias: string; loopback: 'literal-ok'; auth: 'none' | 'client_credentials'; classification: 'operator-declared-synthetic' };
  metadata: { status: 'ready' | 'unavailable' | 'invalid'; fhir: '4.0.1' | 'other' | 'unknown';
    capabilityRevision?: string; summary: 'complete' | 'partial' | 'unknown'; typeCount?: number };
  workflow: { id: 'recent-labs-v1'; patient: 'ready' | 'not-ready'; observation: 'ready' | 'not-ready';
    searchProfile: 'generic-r4' | 'synthetic-fixture-r4-v1' | 'hapi-r4-labs-v1'; proof: 'qualified' | 'unproved' };
  output: { defaultFormat: 'fhir'; delivery: 'full-text-v1' | 'structured-evidence-v1';
    defaultBytes: number; maxBytes: number; ttlMs: number; retentionBytes: number };
  artifacts: { r4IndexSha256: string; r4SearchParametersSha256: string; supportMatrixSha256: string };
  privacy: { patientIdentifierSystems: number };
  proxy: 'present' | 'absent';
  faults: readonly DoctorFault[];
}
```

Lexical rules: `name` and `alias` match the gateway's existing name and source-alias validators; `version` is semver; `node` is `\d+\.\d+\.\d+`; `platform` and `arch` are Node's values; `capabilityRevision` is the gateway's revision format; every SHA-256 is 64 lowercase hex; byte, ttl and count fields are safe non-negative integers within the gateway's configured ranges. `searchProfile` is derived from the registry's eligible ids, not a literal copy (the type above is today's set). `cell` is `recorded` only when this exact Node version, platform and architecture appears in the release metadata's recorded cells.

## How the CLI fills it

- `metadata`: `fhir_capabilities` with `topic: "server"` (no clinical access). Partial summaries are fine.
- `workflow.patient` / `workflow.observation`: `fhir_capabilities` with `topic: "resource"` and `resource_type` `Patient` / `Observation`; ready when `implemented_interactions` includes `read` (Patient) and `search-type` (Observation). Never inferred from the server summary's first page.
- `workflow.searchProfile` / `proof`: the existing public `describeSearchProfile()`.
- `output`: a new read-only public method `FhirGateway.describeOperatorPolicy()` returning exactly the already normalized values (default format, delivery profile, default and maximum bytes, ttl, retention bytes). No second copy of defaults in the CLI.
- `artifacts`: from the generated release metadata, checked by `startup.ts` against the installed assets before serving or doctor runs.
- `source.loopback`: the configuration is only constructible with a literal loopback base URL, so a running doctor always has `literal-ok`; the base URL itself is never printed.

## Output

Fixed labels, one per line, only safe tokens: `doctor: ready|not-ready|fault`, `gateway`, `runtime`, `source`, `metadata`, `workflow`, `search_profile`, `output`, `privacy`, `artifacts` (12-hex prefixes), `proxy`, `faults` (codes or `none`), and a fixed `scope` line. Exit 0 when ready; 1 when the source or workflow is not ready (`METADATA_*`, `FHIR_VERSION_UNSUPPORTED`, `WORKFLOW_TYPE_UNAVAILABLE`); 2 for runtime, configuration, profile, asset or DTO faults. Unproved search semantics are a limitation, not a failure.

## Not printed any more

`source_base_url` and `token_endpoint_origin` (current CLI) are removed: the design's boundary forbids URLs. The alias, the auth kind and `loopback: literal-ok` remain.
