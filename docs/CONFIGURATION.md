# Configuration and CLI

fireboat runs from a checkout. The planned npm package is `@fireboat/gateway`, with the CLI binary `fireboat`. It is not published yet, and the core is not exported as a library. Use Node 24.22.0, pinned in [`.nvmrc`](../.nvmrc); see [runtime](TESTING.md#runtime).

## Minimal configuration

The bundled [local configuration](../examples/local.config.json) binds the gateway to one synthetic patient:

```json
{
  "mode": "synthetic",
  "source": {
    "alias": "local-synthetic",
    "baseUrl": "http://127.0.0.1:8080/fhir"
  },
  "patientId": "synthetic-patient-a",
  "privacy": {
    "patientIdentifierSystems": ["http://example.invalid/synthetic-mrn"]
  }
}
```

Configuration is trusted operator input. No tool argument can change the patient, supply a URL or supply credentials.

| Field | Meaning |
| --- | --- |
| `mode` | Must be `"synthetic"`; no other mode is accepted yet. |
| `source.alias` | A configured name, never a URL supplied by the model. |
| `source.baseUrl` | The FHIR base URL; it must use a literal loopback address. |
| `source.auth` | Optional outbound OAuth client credentials: `type: "client_credentials"`, `tokenUrl`, `clientId`, `clientSecretEnv`, and optional `scopes`. The secret comes from the named environment variable, never a tool argument. This is not SMART authorization. |
| `source.searchProfile` | Optional eligible search profile; see [qualified profiles and their limits](QUERY-EVIDENCE.md). |
| `source.selfLinkOptional` | Optional boolean, default `false`. When `true`, a first search page without a self link is judged by its records instead of refused; see [pages without a self link](#pages-without-a-self-link). |
| `source.continuationTokenParameter` | Optional name of the one opaque token a source adds to its next links, for example `"page"`; empty or omitted by default (off). See [pages without a self link](#pages-without-a-self-link). |
| `patientId` | The single trusted patient binding. |
| `privacy.patientIdentifierSystems` | Optional trusted list of absolute Identifier-system URIs; see the matching rules below. |
| `privacy.sharedIdentifierSystems` | Optional trusted list (at most 32) of product identifier systems a shared Medication record may carry; empty by default. See the rules below. |
| `privacy.sharedProfiles` | Optional trusted list (at most 32) of profile canonicals that shared records may declare in `meta.profile`; empty by default. See the rules below. |
| `contextId` | Optional context handle for this configured binding; it does not select another patient. |
| `workflow` | If supplied, must be `"recent-labs-v1"`. |
| `textMode` | Default `"envelope"`; `"summary"` is refused. |
| `delivery` | Optional `profile` and `hostProfileId`. The default is `full-text-v1`; public configuration cannot enable `structured-evidence-v1` without a verified host profile. None is verified. |
| `discovery` | Optional metadata-store settings: `metadataTtlMs`, `snapshotBytes`, `maxHandles`. |
| `limits` | Optional resource and work bounds, listed below. |

Identifier-system matching for withholding is exact: no case folding, prefix matching or URI normalization. Case variants, trailing slashes and suffix variants are distinct. List every spelling the source emits. One check is deliberately looser: when an unverifiable reference carries an identifier, a listed system is compared ignoring ASCII case and after URL serialisation, and a match withholds the whole record instead of removing just that reference (see the [security model](SECURITY-MODEL.md)). The bundled synthetic source emits exactly `http://example.invalid/synthetic-mrn`.

An empty or omitted list is a documented residual: patient identity in unlisted absolute-URI systems is not withheld. The policy for standalone shared-instance responses does not extend into the content of resources linked to the configured patient. See the [security model](SECURITY-MODEL.md).

`privacy.sharedIdentifierSystems` lets a shared Medication record carry identifiers, for example a product code system, and lets `Medication` searches filter on them. Configure `privacy.patientIdentifierSystems` first: `doctor` prints `warning=shared-systems-without-patient-systems` when shared systems are listed and patient systems are not. Rules:

- Each entry is an absolute URI of 1 to 256 characters with a non-empty part after the scheme, no whitespace or control characters, and no query, fragment, user information or `data:`, `javascript:`, `vbscript:`, `file:` or `blob:` scheme. Entries may not repeat.
- No entry may overlap a patient identifier system, compared exactly, ignoring ASCII case, and after URL serialisation (so `http://example.invalid:80/mrn` overlaps `http://example.invalid/mrn`). Matching of record identifiers against the list stays exact.
- No entry may be one of the built-in well-known US person identifier systems (SSN, MBI and Medicare URIs and OIDs, and the passport and driver's licence system families).
- A Medication record is delivered only when every identifier has only `system`, `value` (1 to 256 characters) and optional `use` (`usual`, `official` or `secondary`), at most eight identifiers, and every system is listed. Anything else, and any `batch`, leaves the record unclassified and withheld.
- With the default empty list, every Medication identifier is withheld, and every `Medication` search on `identifier` is refused with `POLICY_DENIED`.
- A listed system also admits reference-only mixes: a Medication with no `code`, at least one identifier, every identifier in a listed system, and 1 to 32 ingredients that each carry only `itemReference: { "reference": "Medication/<id>" }` (relative, unversioned, no `display` or `identifier`), an optional boolean `isActive` and an optional `strength` Ratio of two simple Quantities. List only systems whose values are product descriptions, such as a source's medication-mix system; the identifier value is delivered as written. Any other shape, an `itemCodeableConcept`, an extension, a 33rd ingredient or a reference to another type leaves the mix withheld. With the default empty list no mix is delivered.
- The shared-instance policy version (`2026-11-14.3`) does not encode the operator's list. The `Medication` row of the support topic shows a different summary when the list is non-empty, and `doctor` prints the count.

`privacy.sharedProfiles` lets shared records (Medication, Organization, Location, Practitioner and the conformance types) declare listed profiles. By default a shared record with any `meta.profile` entry is withheld. The list exists because many sources tag catalog records with a profile, for example a national Medication profile or a source-specific one. Rules:

- Each entry is an absolute `http://`, `https://` or `urn:` URI of 1 to 256 characters, with a host straight after `//` for http(s) and a namespace and value for `urn:`. It has no whitespace or control characters and no query, fragment or user information. A canonical version suffix such as `|1.0.0` is allowed. Entries may not repeat.
- A shared record passes the profile check only when every `meta.profile` entry is a string that exactly equals a listed entry. There is no case folding, version matching or prefix matching, so list every spelling the source emits.
- A listed profile only passes the profile check. Every other shared-record check still applies: the field allow-list, no extensions or modifier extensions, no `meta.security`, the per-type constraints (for Medication, for example, no `batch` and fully coded codes), and the identifier rule above. A profiled Medication that also carries identifiers needs those systems listed in `privacy.sharedIdentifierSystems`.
- A contained shared record inside one of the patient's own records follows the same rule.
- `doctor` prints the count as `shared_profiles=N` on its `privacy:` line.

A shared record that is withheld by these rules does not disappear silently from a search: see [shared records withheld with a signal](SECURITY-MODEL.md#shared-records).

## Pages without a self link

Some FHIR servers send search pages with no `self` link, and page with an opaque token in their `next` links, such as `Observation?_count=100&subject=Patient/x&page=<token>`. By default fireboat refuses such a first page with `UNVERIFIED_QUERY` and cannot continue such a link. Two operator settings, both off by default, change that:

- `source.selfLinkOptional: true` accepts a first page without a self link only when every filter is enforced by the gateway (patient confinement) or checked by the gateway on every returned record, and no OperationOutcome on the page reports an ignored or unsupported parameter. The gateway checks a token as `system|code` or a bare `code`, a date with `eq`, `ge`, `le`, `gt` or `lt`, a reference as `Type/id` or a bare id, and `_id`, on parameters whose R4 expression is a simple element path. Any other filter (a modifier, `ne`/`ap`/`sa`/`eb`, `_lastUpdated`, `|code`, `system|`, a string, quantity, uri or composite parameter) still refuses the page. An accepted page is labelled `gateway_checked_records`: it is never reported complete, publishes no total, claims no order, and an empty one never reports `NO_MATCHES`. A page with a self link is unaffected. See the [security model](SECURITY-MODEL.md#pages-without-a-self-link).
- `source.continuationTokenParameter: "<name>"` lets a next link carry one token parameter of that exact name. The link must keep the original path, every original filter with the same decoded value and multiplicity, the same `_count` (and `_sort` unchanged or dropped), and add nothing else; the token value, after decoding, must be 1 to 2,048 characters in all: letters, digits, `-`, `.`, `_` and `~`, optionally followed by one or two `=` (base64 padding). A `=` anywhere else, three or more `=`, `+`, `/` and `%` are refused. Padding may be sent raw or percent-encoded as `%3D`; both decode to the same value. Every page reached this way is checked on its records like a page without a self link, and the chain is labelled `unverified_continuation`. The name must match `^[A-Za-z][A-Za-z0-9-]{0,63}$` and may not be a known search or result parameter, compared without case (for example `code`, `date` or `patient`; names starting with `_` are refused by the pattern); configuration fails with `INVALID_CONFIG` otherwise. An empty string means off.

```json
{
  "source": {
    "alias": "token-paging-source",
    "baseUrl": "http://127.0.0.1:18090/fhir",
    "selfLinkOptional": true,
    "continuationTokenParameter": "page"
  }
}
```

These settings were prompted by one run against a cloud FHIR service through a local signing proxy. fireboat still connects only to loopback and cannot sign such requests itself; no compatibility with any vendor service is claimed.

## Limits fields

| `limits` field | Controls |
| --- | --- |
| `defaultBytes` | Default final MCP tool-result allowance. |
| `maxBytes` | Ceiling on the final MCP tool result. |
| `upstreamBytes` | Upstream body byte bound. |
| `retentionBytes` | In-memory retention byte bound. |
| `ttlMs` | Retained-result and search-cursor lifetime. |
| `timeoutMs` | Transport request timeout. |
| `maxHandles` | Retained handle quota, including search cursors. When it is full, the oldest result handle is evicted first, then the oldest search cursor ([Limits](LIMITS.md)). |
| `deadlineMs` | Overall gateway-call deadline. |
| `maxQueue` | Local admission queue bound. |

`defaultBytes` and `maxBytes` each accept 8–128 KiB. The explicit per-call `output.max_bytes` floor remains 4 KiB. The shipped default is 48 KiB, capped by the configured maximum (128 KiB by default); the reason is recorded in [Limits](LIMITS.md). An explicit default above that maximum is rejected. Since schema 0.4 these bounds count the response once: they bound the model copy, the larger of the text content and the compact JSON of `structuredContent`, for results and errors alike. The complete serialized MCP tool result, which carries both copies, is reported as `budget.wire_bytes` and is always at most 3 × the limit + 4,096 bytes; JSON-RPC framing is measured separately. Schema 0.3 counted the complete result against a 24 KiB default. See [Limits](LIMITS.md) for bounds, measured floors and how a full handle quota evicts cursors.

## CLI and configuration path precedence

The CLI help is authoritative. From a built checkout:

```sh
node dist/packages/server/src/cli.js --help
node dist/packages/server/src/cli.js --version
```

Usage from actual `--help` output:

```text
Usage:
  fireboat --config <path>          Serve MCP over stdio
  fireboat --doctor --config <path> Check config and source metadata
  fireboat --version                Show release, schema and runtime cell
  fireboat --help                   Show this help
```

Config path precedence is `--config` > `FIREBOAT_CONFIG` > `FHIR_MCP_CONFIG`. The last `--config` wins. `FHIR_MCP_CONFIG` remains a deprecated alias for this release; selecting it emits one note on stderr without the path. An invalid higher-priority path fails instead of falling back.

During serving, stdout carries MCP protocol traffic only; diagnostics go to stderr. The compiled `node ...` command is the same stdio server as the `fireboat --config <path>` form.

## Run the synthetic source and server

The source defaults to port 8080. Set `SYNTHETIC_FHIR_PORT` to move it; only that variable is read, and a generic `PORT` is ignored. Keep this running in a separate terminal:

```sh
SYNTHETIC_FHIR_PORT=19001 npm run demo:source
```

Point a copy of the configuration at the same port, then build, check and serve:

```sh
mkdir -p .local
sed 's/8080/19001/' examples/local.config.json > .local/fireboat.config.json
npm run build
npm run doctor -- --config "$PWD/.local/fireboat.config.json"
node dist/packages/server/src/cli.js --config "$PWD/.local/fireboat.config.json"
```

`npm run doctor` alone wraps `--doctor --config examples/local.config.json`, so it checks port 8080. The extra `--config` above overrides it because the last one wins. If doctor prints `METADATA_UNAVAILABLE`, check that the source is running on the port in `source.baseUrl`.

Point an MCP host at `node /absolute/path/to/dist/packages/server/src/cli.js --config /absolute/path/to/config.json`. Use absolute paths for Node, the CLI and configuration. Only Claude Code has been tested; generated configuration does not establish host compatibility.

## Doctor output

Doctor checks configuration and source metadata. It prints:

- the gateway release, schema and catalog revision;
- the runtime cell;
- the source alias, with its loopback check, auth type and data classification;
- the FHIR version and metadata coverage;
- the readiness of the `recent-labs-v1` workflow;
- the search-profile proof state;
- the output limits;
- the configured patient-identifier systems;
- the hashes of the bundled data;
- the ambient-proxy status, faults and scope.

It does not print the source URL or the tool list. Healthy output includes `doctor: ready`, `faults: none` and a fixed `scope:` line. This is a metadata check, not clinical validation or a proof of filter execution.

## Tool inputs

All five tools are read-only, publish input/output schemas, and are exercised through a real MCP SDK client over stdio. There is no request tool, clinical write or placeholder clinical tool.

| Tool | Inputs and behaviour |
| --- | --- |
| `fhir_capabilities` | Discover the source, bound patient and gateway policy without clinical access. `topic`: `server`, `resource`, `context`, `schema`, `search_parameter`, `support`. Server, search-parameter and support views page through `cursor`; the server view names the bound patient and lists workflow types first. |
| `fhir_search` | `resource_type`, `params`, `page_size`. Search patient-linked types with confinement, and Medication, CodeSystem and ValueSet source-wide; Practitioner, Organization and Location only by `_id` alone, on ids the patient's own delivered records name. Predicates over withheld fields are refused. Parameters are ordered and may repeat. |
| `fhir_read` | `resource_type`, `id`, `interaction: "read"`. Read one exact resource, subject to trusted-patient linkage or shared-instance policy. A Practitioner, Organization or Location must also be reachable (named by an own record already delivered); otherwise the read is `NOT_FOUND` and nothing is sent. |
| `fhir_page` | `cursor`. Continue a search with its opaque cursor; every page keeps the original search's page size. |
| `fhir_result` | `handle`, `action`. Inspect, project or page a sanitized retained snapshot without new upstream data. |

`fhir_search.params` is an array of `{ "name", "value" }` objects, at most 30. Use the separate `page_size` field rather than `_count`. `page_size` accepts 1 to 100, default 20. For the synthetic patient's hemoglobin A1c results:

```json
{
  "resource_type": "Observation",
  "params": [{ "name": "code", "value": "http://loinc.org|4548-4" }],
  "page_size": 5
}
```

The patient is fixed by configuration, so no patient parameter is needed or accepted. To narrow a search to one of the patient's own records, name it as an explicit relative reference, for example `{ "name": "encounter", "value": "Encounter/<id>" }` on Observation. If this context has not yet returned that record, fireboat first checks it with the confined search `<Type>?_id=<id>&patient=Patient/<bound>`; another patient's record and one that does not exist are both refused with `POLICY_DENIED`, and the filtered search is not sent. `_id` takes a comma-separated list of at most 100 plain ids within 4,096 bytes; see [limits](LIMITS.md). The [security model](SECURITY-MODEL.md) and [limits](LIMITS.md) give the exact rules. Against the bundled synthetic source, this call returns one Observation. Full schemas and gate rules: [tool contract](contracts/m3b-tools.json). Coverage labels and profile qualification: [query evidence](QUERY-EVIDENCE.md).
