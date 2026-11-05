<p align="center">
  <img src="assets/brand/icon.svg" width="96" alt="fireboat">
</p>

<h1 align="center">fireboat</h1>

<p align="center">A small, read-only MCP gateway for one patient's FHIR R4 records.</p>

> **Status: public source preview of a synthetic-data prototype.** This is not a
> release: there is no npm package, container image or tag yet. Local stdio only.
> Read-only. Not for real patient data. No SMART authorization yet. Not clinically
> validated. Not affiliated with or endorsed by HL7.

## What it is

`fireboat` is an MCP (Model Context Protocol) server that lets an AI agent discover a configured FHIR R4 endpoint, search within one trusted patient, read exact resources (sanitized and projected, with inline payloads withheld), follow bounded pages, and inspect retained results. It returns FHIR-shaped JSON with source references, coverage signals, and a per-call byte budget. The patient binding comes from operator configuration, never from a model argument, and every returned record is checked against it. The planned npm package is `@fireboat/gateway`, with the CLI binary `fireboat`. It is not published yet, and the core is not exported as a library.

## Why it is different

- **The patient is fixed by configuration.** No tool argument can select another patient. The binding is enforced on every outbound query and re-checked on every returned record, including contained resources.
- **Exact decimal values survive.** Source lexemes such as `7.0`, trailing zeros, exponents and unsafe integers are preserved through parsing, projection, retention and final JSON serialization. A resource whose numbers cannot be preserved is refused rather than silently rounded.
- **Coverage and evidence are stated plainly.** Every result carries a coverage state, reasons, each constraint with how it was enforced (by the gateway, by a qualified search profile, or unknown), and a query-evidence label. Exhausting pages is not presented as a complete clinical history, and an error says `query_evidence: "none"`. See [query evidence](docs/QUERY-EVIDENCE.md).
- **Cursors are opaque, and next links are checked before fetching.** Cursors expire and are not model-constructed URLs. An upstream next link is fetched after it is validated against the original query constraints; otherwise the page is returned as non-continuable partial coverage.
- **Final responses have a byte limit.** A configurable ceiling applies to the complete serialized MCP tool result, including the text and structured copies and error results, not just to upstream bodies. JSON-RPC framing is measured separately; see [limits](docs/LIMITS.md).
- **Retrieval is tested deterministically.** Evals assert facts, decimals, ordering, provenance, coverage, denials, outbound patient confinement and independently measured wire bytes. A mutation gate deliberately breaks guarded code to check that the tests notice. The last full official run did not pass; mutants added since were caught in diagnostic runs only.

## What is proven and what is not

This preview is for reading the code and trying the gateway locally. What the evidence supports today:

- **Proven locally:** `npm run check` passes on macOS arm64 with Node 24.22.0; deterministic retrieval evals pass in both protocol eras; the synthetic demo, a helper-owned HAPI FHIR quickstart, the packed npm tarball and a linux/arm64 container image each passed their recorded live runs. See [M3b status](docs/M3B-STATUS.md) and [docs/evidence/](docs/evidence/).
- **Not yet established:**
  - the isolation gate (B2) has 0 counted cases; the suite runs diagnostically only;
  - the last official mutation aggregate did not pass; later mutants were killed in diagnostic runs only;
  - the token-efficiency study (S11) has not run, so no efficiency claim is made;
  - only one real MCP host (Claude Code) has been tested, on an earlier build;
  - Linux x64, Windows, other Node versions and FHIR servers other than the synthetic source and HAPI FHIR 8.12.0 are unverified.
- **Out of scope:** real patient data, clinical writes, remote serving and SMART authorization.

## Scope today

- **One named workflow:** `recent-labs-v1`, recent laboratory evidence for one patient. It is what the evals, the demo and the comparisons centre on.
- **Resource coverage:** 25 of the 147 FHIR R4 resource types are classified, 15 patient-linked and 10 shared. Unclassified types are refused. Documents are metadata-only. See the [support matrix](docs/SUPPORT-MATRIX.md).
- **One patient per configuration,** local stdio, synthetic data, FHIR R4 only.

## Tools

| Tool | Purpose |
| --- | --- |
| `fhir_capabilities` | Discover the source, the bound patient and gateway policy without clinical access (`topic`: `server`, `resource`, `context`, `schema`, `search_parameter`, `support`). Server, search-parameter and support views page through `cursor`; the server view names the bound patient and lists the workflow types first. |
| `fhir_search` | Run a patient-confined search with ordered repeated parameters (`resource_type`, `params`, `page_size`). |
| `fhir_read` | Read one exact resource by type and ID, subject to trusted-patient linkage (`resource_type`, `id`, `interaction: "read"`). |
| `fhir_page` | Continue a previous search with its opaque cursor (`cursor`). Each page keeps the original search's page size. |
| `fhir_result` | Inspect, project or page a sanitized retained snapshot without new upstream data (`handle`, `action`). |

All five are read-only, publish input/output schemas, and are exercised through a real MCP SDK client over stdio. There is no request tool, no clinical write, and no placeholder clinical tool.

## Quick start

Prerequisite: Node.js **24.22.0**, the pinned version in [`.nvmrc`](.nvmrc). Node 24 or newer is required by `package.json`; 24.22.0 on macOS arm64 is the only verified cell. The package is not published yet; these steps run from a checkout. The first path needs no Docker.

```sh
npm ci
npm run check
npm run demo -- --check
```

`npm run demo -- --check` starts a synthetic FHIR source and a real MCP stdio subprocess, then asserts discovery, patient-confined search, paging, an exact read, a denied cross-patient read, and retained-result inspection. It needs no API key, Docker, or real patient data.

### Run the server

The CLI help is authoritative:

```text
Usage:
  fireboat --config <path>          Serve MCP over stdio
  fireboat --doctor --config <path> Check config and source metadata
  fireboat --version                Show release, schema and runtime cell
  fireboat --help                   Show this help
```

From a checkout, start the bundled synthetic source in a second terminal:

```sh
npm run demo:source
```

Then build, check the configuration, and serve:

```sh
npm run build
npm run doctor
node dist/packages/server/src/cli.js --config examples/local.config.json
```

`npm run doctor` wraps `--doctor --config examples/local.config.json`; the compiled `node ...` command is the same stdio server as the `fireboat --config <path>` form. During serving, stdout carries MCP protocol traffic only; diagnostics go to stderr. Config path precedence is `--config` > `FIREBOAT_CONFIG` > `FHIR_MCP_CONFIG`. `FHIR_MCP_CONFIG` remains a deprecated alias for this release; selecting it emits one note on stderr without the path. An invalid higher-priority path fails instead of falling back.

A minimal configuration:

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

Point an MCP host at `node /absolute/path/to/dist/packages/server/src/cli.js --config /absolute/path/to/config.json`. Use absolute paths in host configuration.

## Configuration

- `mode` must be `"synthetic"` in this milestone.
- `source.alias` is a configured name, never a URL supplied by the model. `source.baseUrl` must be a literal loopback address.
- `source.auth` is optional outbound OAuth client credentials: `type: "client_credentials"`, `tokenUrl`, `clientId`, `clientSecretEnv`, and optional `scopes`. The secret is read from the named environment variable, never from a tool argument.
- `patientId` is the single trusted patient binding.
- `privacy.patientIdentifierSystems` is an optional trusted list of absolute Identifier-system URIs. Matching is exact: no case folding, prefix matching or URI normalization, so case variants, trailing slashes and suffix variants are distinct. List every spelling the source emits. The bundled synthetic source emits exactly `http://example.invalid/synthetic-mrn`. An empty or omitted list is a documented residual: patient identity in unlisted absolute-URI systems is not withheld. The standalone shared-response policy does not extend into A-linked resource content.
- `limits` is optional: `defaultBytes`, `maxBytes`, `upstreamBytes`, `retentionBytes`, `ttlMs`, `timeoutMs`, `maxHandles`, `deadlineMs`, `maxQueue`. `defaultBytes` and `maxBytes` each accept 8–128 KiB; the explicit per-call `output.max_bytes` floor remains 4 KiB. The shipped default is 24 KiB, capped by the configured maximum; an explicit default above that maximum is rejected.

Run `npm run doctor` to check a configuration against its source. It prints:

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

It does not print the source URL or the tool list.

## Testing and evidence

```sh
npm run check
```

Runs typecheck, the Node test suite (including real SDK stdio calls), and the emitted build.

```sh
npm run eval:retrieval
npm run eval:retrieval -- --era legacy
```

Runs deterministic retrieval tasks in both protocol eras: modern `2026-07-28` and legacy `2025-11-25`. The harness checks exact facts, codings and quantities, decimal lexemes, ordering, provenance, coverage, withheld data, denials, outbound confinement, and measured wire bytes; a run fails if the gateway's reported bytes ever disagree with the measured wire result. It does not call a model or measure clinical performance.

```sh
npm run mutation:guards
```

Runs the local mutation gate. The official run splits it into 14 shards and an aggregate step that fails on a missing or stale shard, a mutant that ran zero times or more than once, or an undeclared survivor; the official aggregate records are kept outside this preview.

```sh
npm run test:isolation
```

Runs the B2 isolation suite: manifested attack and control cases with independent oracles and a counting aggregate. It currently runs diagnostically and counts nothing. The original target of ≥200 independent counted cases turned out to be unreachable without removing overlapping defences. A corrected, versioned contract (v2) has been adopted, and the original target will be reported as unmet. No isolation count is claimed yet.

Live integration checks run against pinned local containers: HAPI R4 via `npm run test:hapi` after `docker compose up -d`, and authenticated Medplum R4 via `npm run test:medplum` after `docker compose -f compose.medplum.yaml up -d`. Both are loopback-only synthetic stacks. The project uses no hosted CI; verification is local and recorded in [docs/evidence/](docs/evidence/) and [M3b status](docs/M3B-STATUS.md).

## Security model

- No clinical writes. The gateway exposes only read and search-type interactions.
- No arbitrary URLs or headers from tool arguments. `source` is a configured alias, not a URL.
- No redirect following. Redirects, external continuation URLs and unsafe links are denied or turned into labelled partial coverage.
- A controlled transport accepts only literal loopback endpoints, ignores ambient proxy settings, meters compressed and decoded bytes, and applies deadlines and cancellation.
- Ordinary logs do not contain resource bodies, credentials or patient identifiers. The in-memory audit trail stores bounded metadata only; it is not a durable disclosure ledger.
- Inline `Attachment.data`, `Binary.data` and detected protected links are withheld before model output and retention, with labelled manifests. Attachment metadata remains available.

These are prototype boundaries, not a certification. See [docs/M3B-STATUS.md](docs/M3B-STATUS.md) for what is established and what is not, [docs/M3A-STATUS.md](docs/M3A-STATUS.md) for the historical M3a record, and [`proposals/`](proposals/) for the design record.

## Reference

Generated from the code and data by `scripts/generate-m3b-docs.ts` and checked byte for byte by the test suite:

- [Support matrix](docs/SUPPORT-MATRIX.md) ([JSON](docs/support-matrix.json)): which resource types are readable, under which policy.
- [Query evidence](docs/QUERY-EVIDENCE.md): what each evidence label means, the qualified search profiles, metadata paging and continuation sizes.
- [Compact profiles](docs/COMPACT-PROFILES.md): the compact recipes and their efficiency status (no efficiency claim).
- [Host profiles](docs/HOST-PROFILES.md): host delivery cells (none verified) and the outside-host smoke evidence.
- [Query repair](docs/QUERY-REPAIR.md): the repair each fault yields, NO_MATCHES, and the bounded observed-code scan.
- [Tool contract](docs/contracts/m3b-tools.json): the full strict schemas, gate rules and registries behind the minimal listed schemas.
- [Limits](docs/LIMITS.md): byte, request and time bounds.
- [Synthetic quickstart](docs/QUICKSTART.md): prepare a helper-owned HAPI from the synthetic seed, verify the packaged tasks and generate host forms (checkout recipe; not a release).

## Project status and roadmap

- **M3a complete:** synthetic-only, local stdio, single trusted patient, read-only, five tools, hardening and adversarial review closed.
- **M3b in progress:** S0–S7a, packaging, the quickstart and the linux/arm64 container runtime checks are complete; an outside host (Claude Code) and an independent server (HAPI FHIR 8.12.0) have been tested. The isolation gate (B2), a clean official mutation aggregate, the S11 measurement and a human review remain before a pinned alpha; see [M3b status](docs/M3B-STATUS.md) and [proposals/release-plan.md](proposals/release-plan.md).
- **Next:** the external validation gate, then remote serving and a selected SMART authorization path.

M3b and later gates are specified in [PLAN.md](PLAN.md) revision 0.4.1. Synthetic results do not establish production or clinical readiness.

## How it was built

Much of the code, tests and documentation was written with AI coding assistants working under the maintainer's direction. Changes are accepted on the evidence of the local test suite, the deterministic evals, the isolation suite and the mutation gate, with independent AI reviews along the way. No independent human security or clinical review has happened yet; it is planned before a pinned alpha.

## Feedback and contributing

Testing feedback is the point of this preview: open a GitHub issue with your platform, Node version, the command you ran and its output. Report security issues privately as described in [SECURITY.md](SECURITY.md), not in public issues. Issues and pull requests are welcome. Keep the core policy, transport, projection, result store and MCP adapter separate; add tests for authorization, confinement, payload omission, continuations, transport budgets and denials. Run `npm run check` before opening a pull request. Do not add real patient data, credentials, arbitrary HTTP surfaces or unimplemented tools.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Trademarks

HL7® and FHIR® are registered trademarks of Health Level Seven International. Their use here does not constitute endorsement by HL7.
