# Testing

This page explains how fireboat is tested: what each gate is, what it proves, how to run it and what output to expect. It also lists what the gates do not prove.

All evidence is local and deterministic. The project uses no hosted CI. No gate calls an AI model. Passing a gate does not establish clinical readiness, vendor compatibility or a release.

## Runtime

Use Node **24.22.0**, pinned in [`.nvmrc`](../.nvmrc). `package.json` accepts Node 24 or newer, but 24.22.0 is the only runtime the gates are verified on. Check `node --version` inside the checkout before running a gate: a version manager's global install can sit ahead of its per-project shims on `PATH`.

```sh
npm ci
npm run check
```

Some practical rules:

- Give long or parallel runs their own `TMPDIR`, outside the checkout, and delete it afterwards. Suites that are stopped early can leave temporary folders behind, and tests that copy the repository can otherwise meet their own output.
- Do not run `npm run build` or `npm run check` while the isolation suite runs, and do not edit tracked files during an isolation run. The suite binds its result to the exact source tree and build output, and fails with a `shard-binding` error if `dist/` changes under it.
- The HAPI quickstart and the HAPI live check both use `127.0.0.1:18080`. Do not run the unit suite or the mutation gate while a live stack is using that port.

## The gates at a glance

| Gate | Command | What it proves | Expected output |
| --- | --- | --- | --- |
| Unit and integration suite | `npm run check` | The typecheck passes, every test passes, and the build is emitted | `fail 0` in the Node test runner's summary, then a clean build |
| Demo | `npm run demo -- --check` | An end-to-end session over real stdio behaves as described | `demo check passed (8 outcomes)` |
| Retrieval evals, modern | `npm run eval:retrieval` | Scripted tasks return the golden facts within budget, protocol version 2026-07-28 | Every arm `85/85 passed`, exit 0 |
| Retrieval evals, legacy | `npm run eval:retrieval -- --era legacy` | The same, protocol version 2025-11-25 | Every arm `85/85 passed`, exit 0 |
| Isolation suite | `npm run test:isolation` | Every listed attack and control case passes its independent checks | `status=DIAGNOSTIC earned=0 cases=68`, exit 0 |
| Mutation gate | `npm run mutation:guards` | Every registered weakening of guarded code is caught by a named test | `0 inconclusive`, only declared survivors, exit 0 |
| Generator and contract checks | three `--check` commands, below | Generated docs, the contract and the checkable-path table match their inputs | `in sync` lines, exit 0 |
| Package checks | `npm run test:package` | Shipped documents and licence files match the approved inventory | `fail 0` |
| Live checks | `npm run test:hapi`, `npm run test:medplum` | The gateway behaves the same against a real local FHIR server | One JSON summary line, exit 0 |
| Benchmark harness | `npm --prefix bench test` | The harness's own scoring and parsing tests pass | `fail 0` |

The sections below describe each gate.

## Unit and integration suite

```sh
npm run check                                   # typecheck, the full suite, then the build
node --import tsx --test tests/<file>.test.ts   # one file while iterating
```

`npm run check` runs `tsc --noEmit`, then every `tests/*.test.ts` file with the Node test runner, then the build. The suite runs for a few minutes. It ends with the runner's summary (`tests`, `pass`, `fail 0` and so on); any failure names the test and exits non-zero.

The tests work at several levels:

- **Unit tests** of each layer: admission and strict search, transport budgets and redirects, patient confinement and withholding, projection and exact decimals, the result store, delivery and the tool catalog.
- **Gateway tests** against synthetic FHIR sources started inside the test. They assert what is sent upstream as well as what is returned.
- **Real MCP SDK clients over stdio.** Many tests start the server CLI as a subprocess and talk to it with the official MCP SDK client, in both supported MCP protocol versions: `2026-07-28` (called modern) and `2025-11-25` (called legacy).
- **Twin tests.** A pair of runs that differ only in another patient's records must give identical output, so that a refusal, a caveat or a page count never reveals that another patient's data exists.
- **Byte accounting.** SDK helpers check every result's `budget.bytes_returned` against an independently measured model copy and `budget.wire_bytes` against the measured complete result. See [limits](LIMITS.md).

The suite also pins artifacts that must not drift:

- the generated reference docs, byte for byte (`tests/m3b-docs-sync.test.ts`);
- the tool listing, captured from a real SDK session in both protocol eras and measured against the byte caps that the [tool contract](contracts/m3b-tools.json) records (`tests/m3b-catalog-v2.test.ts`, `tests/m3b-mcp.test.ts` and `tests/m3b-contracts.test.ts`);
- the content of the three eval task files (`tests/eval-corpus-pin.test.ts`);
- every mutation anchor, which must still match the source exactly once (`tests/mutation-anchors.test.ts`).

Some behaviours have their own test files and their own mutants in the mutation registry:

| Behaviour | Test file | Mutant ids |
| --- | --- | --- |
| Counting each response once, and the wire invariant | `tests/count-once.test.ts` | `count-once-*` |
| Cursor eviction when the handle quota is full | `tests/cursor-eviction.test.ts` | `evict-*` |
| Pages without a self link, and operator-declared continuation tokens | `tests/no-self-link.test.ts` | `nsl-*` |
| Directory records delivered only when reachable | `tests/shared-reachability.test.ts` | `reach-*` |
| Reference-only medication mixes | `tests/medication-mix.test.ts` | `w1c-*` |
| Shared profile lists, `_id` lists, the shared-record signal, confined reference-target checks | `tests/shared-records-and-id-lists.test.ts`, `tests/reference-search.test.ts` | |
| MedicationAdministration, MedicationDispense, Specimen, CarePlan, CareTeam, ImagingStudy and Device | `tests/added-patient-linked-types.test.ts` | |

## Demo

```sh
npm run demo -- --check
npm run demo -- --negative-control
```

The demo starts the bundled synthetic FHIR source and the gateway as a real MCP stdio subprocess, then drives it with an MCP SDK client. With `--check` it asserts eight outcomes: the five tools are listed, capabilities describe the source, a search returns records, the page carries only the trusted patient's records, paging continues, an exact read succeeds, a read of the other synthetic patient's record is denied, and a retained result can be inspected. It ends with `demo check passed (8 outcomes)`.

`--negative-control` runs the same check with the trusted patient deliberately set to the other synthetic patient. It succeeds only when the check detects the confinement deviations, which shows that the check can fail.

The demo needs no API key, Docker or real patient data, and calls no model.

## Retrieval evals

```sh
npm run eval:retrieval
npm run eval:retrieval -- --era legacy
```

The evals run scripted tasks through a real MCP client against a fresh gateway and a synthetic fixture. Both protocol eras must pass. The default run covers four task sets, 85 tasks in all: 45 baseline tasks in `packages/evals/src/tasks.ts`, 28 query tasks, 6 projection tasks and 6 auxiliary usability tasks, the last three in `packages/evals/data/`. Every task runs under three output arms: `fhir`, `compact` and `selected` (field selection). Task and arm runs are not independent cases, so results are reported as "N tasks x 3 formats", never as 3N cases.

Each task asserts exact facts, codings and quantities, ordering, provenance, coverage labels, withheld data, denials, outbound patient confinement and byte counts. Default tasks also assert exact decimal lexemes, such as `7.0`, trailing zeros, negative zero and an exponent, from the raw MCP wire result in every arm. A run fails if `budget.bytes_returned` disagrees with the measured model copy, or `budget.wire_bytes` with the measured wire result.

The run prints one line per arm, for example `arm=fhir tasks 85/85 passed, ... 0 failed; checks N/N comparable passed`, then two byte-accounting lines that should report `0/N calls under-reported`. It writes the full report to `.local/evals/retrieval-eval-v0.json` (git-ignored). The exit code is non-zero on any failure.

The named workflow is `recent-labs-v1`, recent laboratory evidence for one patient. Details: [eval harness](../packages/evals/README.md), [query evidence](QUERY-EVIDENCE.md), [compact profiles](COMPACT-PROFILES.md) and [query repair](QUERY-REPAIR.md). The evals do not call a model and do not measure clinical performance.

## Patient-isolation suite

```sh
npm run test:isolation
```

The isolation suite is a stricter, separately designed test of patient confinement. Its internal name, B2, appears in case ids (`B2-SEL-01` and so on), environment variables and output.

**What it runs.** 68 cases in 20 families, listed in [`tests/isolation/cases-v1.json`](../tests/isolation/cases-v1.json). Families cover patient selectors, parameter injection, paths, continuations, cursors, handles, uniform answers for foreign and missing records, match counts, errors, references, payloads, logs, upstream outcomes, metadata, instruction-shaped text in records, server-induced requests, base URLs, cross-references, shared records and directory records. Each case runs an attack, and a control that must still succeed, through four lanes: the core gateway, an SDK client in each protocol era, and the CLI. A synthetic backend with two patients serves the records. Independent scanners look for the other patient's data in nine channels: the text and structured output, the raw protocol frames, stderr, the operational and audit logs, gateway state, upstream requests and the backend. Prerequisite checks show that the scanners, recorders and sinks are live, that a gateway which refuses everything is caught by the controls, and that two runs are deterministic.

**What the output means.** The last lines look like this:

```text
# B2 AGGREGATE run=<id> status=DIAGNOSTIC earned=0 cases=68 families={...}
# B2 RUN <id>: tests exit 0, aggregate exit 0
```

The full report goes to `artifacts/b2/<run>/report.json` (git-ignored). Exit code 0 means every case passed its checks and every prerequisite passed.

- `status=DIAGNOSTIC` means the prerequisites passed and every pinned file matched its recorded hash. Otherwise the status is `INCONCLUSIVE`.
- `earned=0` is by construction. The suite can count a case toward its acceptance target only in a qualifying run: `B2_QUALIFY=1`, no case selection, a fresh build, a clean tree, matching pins, and a lane that tests the installed npm package. This repository has no installed-package lane, and no case in `cases-v1.json` is marked as counted, so every run is diagnostic.

**What it does not prove.** A diagnostic pass is not isolation proof. The suite was designed to reach at least 200 independent counted cases (`B2_REQUIRED_EARNED`). That target is not met, and no isolation count is claimed. The original design is pinned in [`tests/isolation/design-spec.md`](../tests/isolation/design-spec.md); the suite checks its exact bytes.

**Scope.** The suite's coverage matrix names the 25 resource types classified when it was designed. MedicationAdministration, MedicationDispense, Specimen, CarePlan, CareTeam, ImagingStudy and Device are not isolation subjects. Their confinement, withholding and masks are covered by unit, gateway and real-SDK stdio tests in `tests/added-patient-linked-types.test.ts` only. The other behaviours in the table above are also covered by their own tests, not by isolation cases. The suite runs with its default configuration, so the opt-in behaviours for pages without a self link do not apply in it.

**Directory records.** Practitioner, Organization and Location records are delivered only when a record of the bound patient names them (see the [security model](SECURITY-MODEL.md#patient-and-shared-instance-checks)). The eight cases that read or search a directory record directly (B2-SHR-05, B2-SHR-06, B2-SHR-17, B2-DIR-01, B2-SEL-23, B2-SEL-24, B2-SEL-25 and B2-SEL-33) therefore first deliver an own record that names it, and their controls are `_id` lookups. The checker lets a directory `_id` lookup pass only for ids that an earlier served record of the trusted patient named, on a request that carried that patient's confinement pair. It flags every other request on a directory path.

`node tests/isolation/run.mjs --with-kills` also runs the isolation mutants in `tests/isolation/mutants.mjs` against the cases named in `tests/isolation/kill-matrix.json`.

## Mutation gate

```sh
npm run mutation:guards                                         # full run in one invocation
node scripts/mutation-guards.mjs --shard 1/2 --out <dir>        # one shard of a full run
node scripts/mutation-guards.mjs --aggregate <dir> --shards 2   # combine the shard reports
node scripts/mutation-guards.mjs --only id1,id2                 # diagnostic subset
node scripts/mutation-guards.mjs --list                         # the registry: count, list hash and ids
```

**What a mutant is.** Each entry in `scripts/mutation-guards.mjs` is an exact `{id, file, find, replace}` edit, or a list of such edits, that disables or weakens one named guard. Its comment names the test or tests expected to kill it (`// Killing test(s):`). The gate applies each mutant to a temporary copy of the tree, never the real checkout, and asks whether the tests notice. The gate runs offline.

**How a mutant is judged.** A failure is never trusted on first sight:

- A typecheck or build failure is inconclusive, never a kill.
- A failing test is recorded, and the mutant is judged a second time. It is killed only when the failure reproduces: at least one of the same tests (or the same eval era) fails again, or both runs time out in the same suite or era. A failure that does not reproduce is inconclusive, and the gate fails and names the flaky tests.

**The targeted first pass.** After the typecheck and build pass, the gate first runs a small set of candidate test files, most likely first:

1. the files that hold the tests named in the mutant's comment;
2. hints from earlier shard reports (`--hints <dir>`), which change only the order in which tests are tried;
3. files that killed other mutants of the same source file;
4. files that mention the identifiers the mutation removes;
5. the rest of the unit suite, in small batches.

It stops at the first batch that kills. This pass can only kill, and only on a named behavioural test failure that reproduces when the same candidates run a second time. It never credits a timeout, a file-level failure or a pin-only test. It never produces a survivor or an inconclusive result.

**The full path.** A mutant that the targeted pass does not kill is judged on the full path: the full unit suite, then the full isolation suite when the mutant declares it (`suites: ['unit', 'isolation']`), then the retrieval evals in both protocol eras, with the same second judgement of any failure. `--no-targeted` judges every mutant on the full path. Each result records which path decided it (`decided_by`: `targeted`, `full`, or `precheck` for anchor, preparation and compilation problems).

**When the gate fails.** The gate fails on an inconclusive result, an anchor that no longer matches exactly once, a surviving mutant without a reviewed entry in `scripts/mutation-survivors.json`, or a declared survivor that is in fact killed (a stale justification). Each declared survivor carries a written reason why the mutation cannot change behaviour today.

**Sharding.** `--shard i/n` judges a fixed partition of the mutant list and writes one report. `--aggregate` is the authority for a sharded run. It fails on a missing or stale shard, a mutant judged zero times or more than once, an inconclusive result or an undeclared survivor. `--only` cannot be combined with `--shard` or `--aggregate`, so a diagnostic subset can never pass for a full run.

**Expected output.** A passing run ends with a line such as `mutation-guards: N killed, 3 survived, 0 inconclusive (declared survivors: 3)`, or for an aggregate, `mutation-guards aggregate: N killed, 3 survived, 0 inconclusive, 0 anchor-errors (...)`, and exits 0. A full run is long, so sharding lets it run in pieces. Parallelism is bounded across all workers (`--workers`, `--test-concurrency`) so that copies of the suite do not overload the machine.

A passing run covers the guards that have registered mutants, not every line, and holds only for the tree it ran on. A change to guarded code needs its mutants judged again.

## Generator and contract checks

```sh
node --import tsx scripts/generate-m3b-docs.ts --check
node --import tsx scripts/emit-m3b-contract.mjs --check
node --import tsx scripts/generate-r4-checkable-paths.ts --check
```

Expected output: `generate-m3b-docs: 6 files in sync`, `emit-m3b-contract: in sync` and `generate-r4-checkable-paths: in sync`, each with exit 0.

- `generate-m3b-docs.ts` generates the [support matrix](SUPPORT-MATRIX.md) (and its [JSON](support-matrix.json)), [query evidence](QUERY-EVIDENCE.md), [compact profiles](COMPACT-PROFILES.md), [host profiles](HOST-PROFILES.md) and [query repair](QUERY-REPAIR.md) from code and data. Its fixed sentences are checked against runtime behaviour by `tests/m3b-docs-sync.test.ts`.
- `emit-m3b-contract.mjs` writes the [tool contract](contracts/m3b-tools.json): the full strict schemas, gate rules and registries behind the minimal listed schemas, and the byte caps for the tool listing.
- `generate-r4-checkable-paths.ts` derives the table of search parameters the gateway can check on returned records (`packages/core/src/generated/r4-checkable-paths.ts`) from the two pinned HL7 FHIR R4 indexes.

Never hand-edit these outputs: change the inputs and regenerate. [Limits](LIMITS.md) records the byte, request and time bounds.

## Package and licence checks

```sh
npm run test:package
```

This runs three test files. `package-stage.test.ts` checks the staging tool. `package-licenses.test.ts` checks that every locked dependency ships its verbatim licence texts. `package-inventory-drift.test.ts` checks that every shipped document and licence file matches its hash in the approved inventory (`packaging/npm-files.json`). It needs no build, and its summary ends with `fail 0`.

Related tools:

- `npm run build`, then `npm run stage:package -- <absolute-new-dir>` stages the package and checks it against the approved inventory. A maintainer who has reviewed an intended change re-approves with `npm run stage:package -- --approve-inventory <absolute-new-dir>` and reviews the `git diff` of `packaging/*.json`. Never hand-edit those inventories. See [contributing](../CONTRIBUTING.md).
- `npm run licenses:release` checks the licence inventory against the installed dependencies.
- `npm run verify:package -- --tar <file>` checks a packed tarball against the approved inventory.
- `npm run test:package-installed` installs a packed tarball and the quickstart helper into a fresh scratch directory and runs the packaged tasks. It needs the `FIREBOAT_PACKAGE_*` inputs (the tarball, a scratch directory outside the checkout and others), is deliberately outside `tests/*.test.ts`, and never skips when an input is missing.

fireboat is not published to npm. These checks show that a staged package matches its inventory, not that a package is available.

## Live checks

These optional checks need Docker and pinned local images. They run against loopback-only synthetic stacks:

```sh
docker compose up -d
npm run test:hapi
docker compose down --volumes

docker compose -f compose.medplum.yaml up -d
npm run test:medplum
docker compose -f compose.medplum.yaml down --volumes
```

- **HAPI.** `compose.yaml` runs HAPI FHIR 8.12.0, pinned by digest, on `127.0.0.1:18080`. `scripts/test-hapi.ts` seeds two synthetic patients and checks paging, patient confinement, decoys that a single predicate excludes, the denial of the other patient's read and payload withholding. It prints one JSON line (`"target":"local-hapi"`, with request counts and pages) and exits 0.
- **Medplum.** `compose.medplum.yaml` runs a self-hosted Medplum R4 stack on `127.0.0.1:18103`. `scripts/test-medplum.ts` adds authenticated client credentials, a denied unauthenticated read and attachment withholding. It prints one JSON line (`"target":"local-medplum"`). See [Medplum testing](MEDPLUM-TESTING.md).
- **HAPI quickstart.** The [quickstart](QUICKSTART.md) prepares a helper-owned HAPI server from the synthetic seed, verifies the packaged tasks and generates host configurations. It is a checkout recipe, not a release.

A live check covers that script and its synthetic seed only. Query proof is limited to the synthetic fixture and the narrow HAPI FHIR 8.12.0 search profile described in [query evidence](QUERY-EVIDENCE.md), with no HAPI sort or continuation proof.

## Benchmark harness

The harness in [`bench/`](../bench/) compares fireboat with other FHIR MCP servers on scripted questions. It is a separate package. `npm run check` does not run it, and it is not part of the npm package. Its own checks:

```sh
npm --prefix bench ci --ignore-scripts
npm --prefix bench run typecheck
npm --prefix bench test
(cd bench/gold/py && uv run pytest)
```

The tests use synthetic data only; a few also check real data or generated files when they are present and skip when they are not. Running the benchmark itself needs Docker, downloaded datasets and, for some arms, paid cloud services. Methods, requirements and commands are in the [harness README](../bench/README.md). Published results are in [benchmark results](BENCHMARK.md).

## Results on this tree

The table below records the gate results for this tree, run on 17 November 2026 (UTC) with Node 24.22.0 on an Apple-silicon Mac. A gate that has not been run on this tree is not claimed.

| Gate | Result |
| --- | --- |
| `npm run check` | Passed, 2,597 of 2,597 tests (typecheck, suite and build). |
| `npm run demo -- --check` | Passed, 8 outcomes. |
| `npm run eval:retrieval` (modern) | Passed: each arm (fhir, compact, selected) 85/85 tasks and 301/301 comparable checks. |
| `npm run eval:retrieval -- --era legacy` | Passed, with the same counts as the modern era. |
| `npm run test:isolation` | Passed: 139 of 139 tests, all 68 cases; `status=DIAGNOSTIC earned=0`, as designed. |
| `npm run mutation:guards` (full, aggregated) | Passed: 1,541 mutants in two shards, each run exactly once. 1,538 killed and 3 declared survivors, with 0 inconclusive, 0 anchor errors and 0 timeout-only kills. The targeted pass decided 1,534 and the full path 7. The run was on the source tree before the last documentation-only edits, after one shard was repeated on a quiet machine because a loaded first attempt left one mutant inconclusive. |
| Generator and contract checks | Passed: generated docs, tool contract and R4 checkable-path table in sync; every mutation anchor applies. |
| `npm run test:package` | Passed, 19 of 19; `npm run licenses:release` passed. |
| `npm run test:hapi` | Not run on this tree. |
| `npm run test:medplum` | Not run on this tree. |
| Benchmark harness checks | Passed: typecheck; `npm test` 159 passed, 6 skipped (they need downloaded benchmark data), 0 failed; Python gold tests 127 passed. |

## What is not proven

The gates above are the evidence for how fireboat behaves. They do not establish any of the following.

- **Platforms.** The verified runtime is Node 24.22.0 on macOS arm64. Linux, Windows, x64 and other Node versions are not verified.
- **FHIR servers.** Only the bundled synthetic source and HAPI FHIR 8.12.0 (with the Medplum stack as a separate script) are exercised. No compatibility with any vendor service is claimed, and a generic R4 response or CapabilityStatement does not show support for every search or sort variant. R4B, R5 and R6, US Core conformance and profile validation are not claimed.
- **MCP hosts.** Claude Code is the only MCP host fireboat has been run with, on an earlier build. No host run is recorded for this tree or for an installed package, and no host run with protocol version 2025-11-25 is established. Generated host configuration does not verify a host. No structured-delivery profile is verified, and which copy of a result a host gives its model is not verified. See [host profiles](HOST-PROFILES.md). Tests in two SDK eras do not establish support for every MCP client or full protocol conformance.
- **Isolation.** The isolation suite counts no cases (`earned=0`), and its target of 200 independent counted cases is not met. Zero failures on synthetic data do not establish zero possible leaks, prompt-injection immunity or universal identifier redaction.
- **Mutation coverage.** A passing mutation run covers only the guards with registered mutants, and only on the tree it ran on.
- **Clinical use.** No clinical validation, clinical or production readiness, or regulatory compliance (HIPAA, GDPR, CMS, ONC) is claimed. Exhausting pages is not a complete clinical history, and an empty result is not clinically proven absence.
- **Authorization and serving.** There is no SMART authorization, no enterprise-managed auth and no authenticated remote MCP service. The optional client-credentials OAuth is none of these.
- **Efficiency.** No token, speed or cost saving is claimed. No token-efficiency study has been run, and the size of the tool catalog in tokens has not been measured.
- **Distribution.** fireboat is not published to npm, as a container image or in a registry.
- **Review.** No independent human security or clinical review has happened. Review by AI models is not human review.

The [security model](SECURITY-MODEL.md#residuals-and-non-claims) lists the residuals and the remaining non-claims.

## Benchmarks and research data

Fixtures, tests, examples and the demo use synthetic data only. Openly licensed de-identified research data, currently the MIMIC-IV Clinical Database Demo on FHIR v2.1.0 (ODbL), may be used for benchmarks only. It is downloaded at run time, cited below, kept outside the repository (for example under the git-ignored `.local/`), and never committed to the repository or included in fixtures, tests, examples or logs. The same applies to anything derived from it, such as questions, answers, transcripts and per-question results. The one exception: aggregate benchmark scores (counts such as "140 of 147 correct") are published in [the benchmark results](BENCHMARK.md) with the ODbL attribution, never with patient ids, questions, values or records. No other real or de-identified patient data may be used.

Benchmark harness code is kept apart from the product: it is not part of `npm run check` or the npm package. Scripted benchmark runs are local. A run with a real AI host sends tool results, and so the benchmark data in them, to that host's model provider.

Datasets:

- **MIMIC-IV Clinical Database Demo on FHIR, version 2.1.0.** Real, de-identified patient data for 100 patients, under the Open Data Commons Open Database License (ODbL) v1.0. Source: [physionet.org/content/mimic-iv-fhir-demo/2.1.0](https://physionet.org/content/mimic-iv-fhir-demo/2.1.0/). Cite:
  - Bennett A., Ulrich H., Wiedekopf J., Szul P., Grimes J., Johnson A. (2025). *MIMIC-IV Clinical Database Demo on FHIR* (version 2.1.0). PhysioNet. RRID:SCR_007345.
  - Bennett A. M., Ulrich H., van Damme P., Wiedekopf J., Johnson A. E. (2023). MIMIC-IV on FHIR: converting a decade of in-patient data into an exchangeable, interoperable format. *Journal of the American Medical Informatics Association* 30(4):718-725. [doi:10.1093/jamia/ocad002](https://doi.org/10.1093/jamia/ocad002).
  - Pollard T., Moody B. E., Lehman L., Gow B., Fernandes C., Xie C., Johnson A., Mark R. G., Heldt T. (2026). PhysioNet as a global platform for biomedical research. *Nature Health*. [doi:10.1038/s44360-026-00096-z](https://doi.org/10.1038/s44360-026-00096-z).

  The aggregate scores published from it carry the ODbL attribution and share-alike terms.
- **Synthea Coherent Data Set.** Synthetic patient data, Copyright 2021 The MITRE Corporation, under Creative Commons Attribution 4.0 (CC BY 4.0). Source: [registry.opendata.aws/synthea-coherent-data](https://registry.opendata.aws/synthea-coherent-data/). The benchmark rewrites its references before loading; CC BY 4.0 asks that such changes be stated. Cite:
  - Walonoski J. et al. (2022). The "Coherent Data Set": Combining Patient Data and Imaging in a Comprehensive, Synthetic Health Record. *Electronics* 11(8):1199. [mdpi.com/2079-9292/11/8/1199](https://www.mdpi.com/2079-9292/11/8/1199).

## Reporting results

Testing feedback is welcome. Include your platform, Node version, the command and its output in an issue. Never include real or de-identified patient data (benchmark data included) or credentials. Issues and pull requests are welcome under [contributing](../CONTRIBUTING.md) and the [code of conduct](../CODE_OF_CONDUCT.md). Report security issues privately under the [security policy](../SECURITY.md).
