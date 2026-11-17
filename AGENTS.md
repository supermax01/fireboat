# AGENTS.md

This guide is for coding agents and for the people who run them or contribute by hand. Any tool that reads `AGENTS.md` picks it up. [CONTRIBUTING.md](.github/CONTRIBUTING.md) covers the same ground for human contributors.

## What this project is

fireboat is a small, **read-only** MCP (Model Context Protocol) gateway that gives an AI agent safe access to **one patient's** FHIR R4 records. It is served over local stdio and uses synthetic data by default (see "Synthetic data by default" below). Behaviour and evidence are described in:
- [README.md](README.md): what it does and what works today;
- [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md): patient confinement, transport, withholding, exact values and the non-claims;
- [docs/TESTING.md](docs/TESTING.md): what is tested, what is not, and the current results;
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): configuration, the CLI and tool inputs;
- [docs/LIMITS.md](docs/LIMITS.md): the byte, request and time bounds;
- [docs/BENCHMARK.md](docs/BENCHMARK.md): the benchmark results and their caveats.

It is a prototype, not a release: there is no SMART authorization, no remote serving and no use with identifiable or live patient records.

## Non-negotiable boundaries

Breaking any of these is a bug, whatever a task asks for.

- **Read-only.** No clinical writes, no FHIR create, update, delete, patch or `$operation` that mutates.
- **One trusted patient, fixed by configuration.** No tool argument may select another patient. Patient-linked searches carry the confinement pair.
  - There are exactly two paging exceptions, and a page reached through either is labelled `unverified_continuation`: (1) a server-root next link carrying `_getpages` may omit original constraints, but never change or add one; (2) a next link on the original resource path may add one opaque token under the operator-declared `source.continuationTokenParameter` name (off unless configured; never a known search or result parameter). It must keep every original constraint with the same decoded value and multiplicity, never omit, change or add one, keep `_count`, add no other paging mechanic, and every page it reaches must pass the record checks.
  - A first page without a self link is refused unless the operator sets `source.selfLinkOptional`; it is then accepted only when every material constraint is gateway-enforced or gateway-checked (`record-predicates.ts`) on every authorized record, and it never claims completeness.
  - Practitioner, Organization and Location are delivered only when reachable: named by a literal same-source reference in one of the bound patient's own records already delivered in this context, read as delivered, with no chains. They are searched only by `_id` alone on reachable ids, and an unreachable read is the uniform `NOT_FOUND` with nothing sent. Medication, CodeSystem and ValueSet are searched source-wide without a patient pair.
  - Predicates over withheld fields are refused at admission. Every returned record, including contained resources, is re-checked under the patient or shared-instance policy.
  - These boundaries are pinned by tests and mutants; do not widen them.
- **No arbitrary network surface.** No tool accepts a URL, host, header or raw request. `source` is a configured alias. Redirects are not followed. Next links are validated before fetching.
- **Synthetic data by default.** Fixtures, tests, examples, the demo, issues and logs use synthetic data only.
  - Openly licensed de-identified research data (currently the MIMIC-IV Clinical Database Demo on FHIR v2.1.0, ODbL) may be used for benchmarks only. It is downloaded at run time, cited (see [docs/TESTING.md](docs/TESTING.md#benchmarks-and-research-data)), kept outside the repository (for example under the git-ignored `.local/`), and never committed to the repository or included in fixtures, tests, examples, issues or logs. The same applies to anything derived from it, such as questions, answers, transcripts and per-question results.
  - Aggregate benchmark scores, such as "140 of 147 correct", may be published in [docs/BENCHMARK.md](docs/BENCHMARK.md) with the ODbL attribution, never with patient ids, questions, values or records.
  - Never add any other real or de-identified patient data.
- **No secrets** in code, tests, configuration examples or commits. Outbound credentials come from environment variables named in configuration. Build fake credentials in tests at run time instead of writing credential-shaped literals.
- **No hidden model calls, no remote unauthenticated serving, no placeholder tools.** Expose only the five implemented tools.
- **Ordinary logs never contain** resource bodies, credentials or patient identifiers.
- **Exact values survive.** FHIR decimal lexemes (`7.0`, exponents, unsafe integers) are preserved end to end. A value that cannot be preserved is refused, never rounded.
- **No overclaiming.** Never claim any of the following without the separate recorded check that supports it:
  - SMART authorization or certification, enterprise-managed auth, or an authenticated remote MCP service (the optional client-secret OAuth is none of these);
  - clinical or production readiness, HIPAA, GDPR, CMS or ONC compliance, regulatory clearance, clinical validation or a validated diagnostic or treatment outcome;
  - general Epic, Oracle, Azure, AWS, Google or other vendor compatibility, R4B, R5 or R6 support, US Core conformance, profile validation, or every search and sort variant because a server returned a generic R4 response or CapabilityStatement;
  - full protocol conformance, support for every MCP client or host, verified model-input behaviour, or three independent clients, on the strength of tests in two SDK eras or generated configuration;
  - complete clinical history, clinically proven absence, a verified latest result when the sort is unknown, complete retained results, or "full FHIR" meaning unmodified, complete source content;
  - clinical writes, arbitrary operations, graph traversal, general terminology coverage, document or note retrieval, or artifact delivery: the five tools do not supply them;
  - zero possible leaks, prompt-injection immunity, universal identifier redaction, a durable disclosure ledger or a security certification, from zero failures observed on synthetic data;
  - "all tests passed" while required gates are pending or unrun, a green CI from historical runs, all mutation guards killed from diagnostic runs or stale anchors, or 200 independent isolation cases by counting one case in several formats;
  - lowest tokens, fastest workflow, latency figures such as under 100 ms p95, percentage savings, "best FHIR MCP server", a universal one-line install or a ten-minute result, without the exact matching measurement or study and its limits;
  - availability on npm, as a container image or in a registry, before the published artifact exists and its installation and metadata have been checked;
  - agreement between several AI models, or AI reviews presented as human clinical or security review;
  - vulnerabilities, security observations or missing capabilities of other projects.

## Repository map

| Path | What lives there |
| --- | --- |
| `packages/core/src/` | The gateway, as separate layers. `query.ts`, `discovery.ts` and `search-parameters.ts`: admission and strict search. `transport.ts`: budgets, redirects, loopback only. `privacy.ts`, `identity.ts` and `withheld.ts`: patient confinement and withholding. `projection.ts`, `decimal.ts` and `schema.ts`: output projection and exact decimals. `store.ts`: retained results, handles and cursors. `delivery.ts` and `support.ts`: profile resolution, evidence labels and the support matrix; the byte ceiling is measured and enforced in `index.ts` (`bytesV2`, `finish`) and checked again by `contracts.ts`, and coverage is decided in `query.ts` and assembled in `index.ts`. `catalog.ts` and `contracts.ts`: the tool catalog. `record-predicates.ts`: the gateway-checked filters for pages without a self link. `generated/`: the R4 indexes and the checkable-path table derived from them. Do not hand-edit those. |
| `packages/server/src/` | The MCP adapter, CLI (`cli.ts`, `main.ts`), `doctor.ts` and release identity. |
| `packages/auth/src/` | Optional outbound OAuth client credentials. |
| `packages/evals/` | The deterministic retrieval eval harness and its fixtures. |
| `tests/` | The Node test suite (`*.test.ts`), the isolation suite and its pinned design specification in `tests/isolation/`, and the installed-package tests in `tests/package/`. `tests/package-inventory-drift.test.ts` fails when a shipped document or licence file no longer matches the approved npm inventory. |
| `scripts/` | The mutation gate, generators, packaging and staging (`stage-package.ts`) and qualification tools. |
| `examples/` | The demo, the synthetic FHIR source, example configs and the HAPI quickstart helper (`examples/quickstart/`). |
| `docs/` | Testing ([TESTING.md](docs/TESTING.md)), benchmark results ([BENCHMARK.md](docs/BENCHMARK.md)), the security model, configuration, limits, the HAPI quickstart, generated reference docs, the tool contract (`docs/contracts/m3b-tools.json`), the README diagrams (`docs/assets/`) and the logo and brand assets (`docs/assets/brand/`). |
| `docker/` | Compose files: `compose.yaml` (HAPI for `npm run test:hapi`), `compose.medplum.yaml` (Medplum for `npm run test:medplum`) and `compose.quickstart.yaml` (the quickstart helper's HAPI recipe, pinned by hash in the seed manifest). |
| `bench/` | The benchmark harness behind docs/BENCHMARK.md: a separate package with its own `package.json`, not shipped and not run by `npm run check`. See [bench/README.md](bench/README.md). |
| `packaging/` | The approved npm inventories (`packaging/npm-files.json`, `packaging/helper-files.json`), the production shrinkwrap (staged as `npm-shrinkwrap.json`), `THIRD_PARTY_NOTICES.md`, and `licenses/` with the dependency licence texts, the seed notices and the licence inventory (`licenses/inventory.json`). The package ships `THIRD_PARTY_NOTICES.md` and `licenses/` at its root; paths inside `licenses/inventory.json` are those package paths. |
| `.github/` | `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` (GitHub reads them from here) and the issue and pull request templates. |
| Repository root | `README.md`, `AGENTS.md`, `NOTICE` and `LICENSE`, plus the npm and TypeScript configuration and `.nvmrc`. |

**Keep the layers separate:** core policy, HTTP transport, output projection, the result store and the MCP adapter. A change that couples them needs a design reason in the pull request. In practice `packages/core/src/index.ts` still orchestrates admission, paging, retention and delivery in one place. Move logic out of it into the layer modules, not into it.

## Setup and everyday commands

Use Node **24.22.0**, the version in `.nvmrc`. It is the only verified runtime. If `node --version` in the checkout does not print v24.22.0, put the 24.22.0 binary first on `PATH` before running any gate: a version manager's global install can sit ahead of its per-project shims. Do not run `npm run build` or `npm run check` while `npm run test:isolation` is running in the same checkout: the suite binds the build output, and a rebuild under it fails the run. Then run:

```sh
npm ci
npm run check            # typecheck + full test suite (real MCP SDK stdio calls) + build
npm run demo -- --check  # no Docker, no keys: synthetic source + real stdio server, asserts 8 outcomes
```

| Command | Use |
| --- | --- |
| `npm run check` | Required before every commit that touches code, tests, schemas or data. It takes a few minutes. |
| `npm run test:package` | Staging, licence and inventory-drift tests. Run it after any change to a shipped document. |
| `node --import tsx --test tests/<file>.test.ts` | Run one test file while iterating. |
| `npm run eval:retrieval` and `npm run eval:retrieval -- --era legacy` | Deterministic retrieval evals in both MCP protocol eras. Both must pass. |
| `npm run test:isolation` | The patient-isolation suite. It currently runs diagnostically: `status=DIAGNOSTIC earned=0` is expected. |
| `npm run doctor` | Validate `examples/local.config.json` against the synthetic source on port 8080. To check another config, add `-- --config <path>` (the last `--config` wins). |
| `node --import tsx scripts/generate-m3b-docs.ts --check` | Check that generated docs match the code and data. |
| `node --import tsx scripts/emit-m3b-contract.mjs --check` | Check that the tool contract is current. |
| `node --import tsx scripts/generate-r4-checkable-paths.ts --check` | Check that the checkable-path table matches the pinned R4 indexes. |
| `node --import tsx --test tests/mutation-anchors.test.ts` | Check that every mutation anchor still applies. |
| `node scripts/mutation-guards.mjs --list` | List the mutation registry (1,541 entries in this tree; the output's `count` field gives the current number). |

Give long or parallel test runs their own `TMPDIR` and delete it afterwards. Some suites leave temporary folders behind when they are stopped early.

The synthetic FHIR source listens on port 8080 by default. Set `SYNTHETIC_FHIR_PORT` (only that variable is read) to move it, for example when 8080 is busy, and point a copy of the config at the same port.

Shipped documents (`README.md`, `LICENSE`, `NOTICE`, `.github/SECURITY.md`, `packaging/THIRD_PARTY_NOTICES.md`, `docs/QUICKSTART.md`, `docs/LIMITS.md`, the generated reference docs, `docs/contracts/m3b-tools.json` and `packaging/licenses/*`; the package stages the `.github/` and `packaging/` ones at its root as `SECURITY.md`, `THIRD_PARTY_NOTICES.md` and `licenses/*`) are hash-bound in `packaging/npm-files.json`; after an intended change, run `npm run build`, re-approve with `npm run stage:package -- --approve-inventory <dir>` (a new absolute directory, deleted afterwards), then run `npm run test:package`.

## How changes are judged

The evidence is local and deterministic. **The project uses no hosted CI.**

1. **Tests that pin behaviour.** Add tests for anything touching authorization, confinement, payload withholding, continuations, strict search, transport budgets, redirects or denials. Prefer tests that use a real MCP SDK client over stdio.
2. **The mutation gate.** Guarded code has mutants in `scripts/mutation-guards.mjs`. Each mutant is a deliberate weakening that a named test must catch. If you change guarded code, keep its mutants killed, or update their anchors with the same meaning. The registry names killing tests by their titles, so do not rename a test without updating the registry.
3. **The evals,** in both eras.
4. **The isolation suite.**
5. **Byte caps.** Tool descriptions, schemas and server instructions are measured against caps in `docs/contracts/m3b-tools.json`. A wording change needs a fresh capture, and must stay within each tool's cap.

**Never weaken a guard, oracle, budget, gate or test to make something pass.** If a test looks wrong, say so in the pull request instead of editing it.

## Files you must not hand-edit

- `docs/SUPPORT-MATRIX.md`, `docs/support-matrix.json`, `docs/QUERY-EVIDENCE.md`, `docs/COMPACT-PROFILES.md`, `docs/HOST-PROFILES.md` and `docs/QUERY-REPAIR.md`. These are generated by `scripts/generate-m3b-docs.ts`; change the generator's inputs and regenerate.
- `docs/contracts/m3b-tools.json`. Regenerate it with `scripts/emit-m3b-contract.mjs`.
- `packages/core/src/generated/*`. The two R4 indexes are regenerated from the pinned HL7 FHIR R4 package by the `scripts/generate-r4-*.py` scripts; `r4-checkable-paths.ts` is derived from those two indexes by `scripts/generate-r4-checkable-paths.ts` (`--check` fails on drift).
- `tests/isolation/design-spec.md`, the pinned isolation design specification. The isolation ledger binds its exact bytes; editing it breaks the suite.
- `packaging/licenses/inventory.json` and `packaging/*.json`. These are approved inventories, updated only by their own tools during packaging.

## Ports and live services

- The HAPI quickstart owns `127.0.0.1:18080`. Never run the unit suite or the mutation gate while a live quickstart run is using that port.
- Live checks (`npm run test:hapi`, `npm run test:medplum`) need local Docker and pinned images. They are loopback only.

## Commits and pull requests

- Small, focused commits with a subject that says what changed. Explain why in the body.
- State the tests that pin the change and the gates you ran. Update generated artifacts in the same change when their inputs changed.
- No unrelated reformatting.
- Open a pull request from a fork or branch. Tags, releases, package publishing and repository settings are handled by the maintainer.
- Never commit personal files, such as editor or agent settings folders and `*.local.md` notes. `.gitignore` covers the common ones; keep personal instructions in those local files, not in this one.
- Security issues go to the private channel in [SECURITY.md](.github/SECURITY.md), never to a public issue.
