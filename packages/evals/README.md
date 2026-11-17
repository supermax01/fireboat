# Retrieval-conformance evaluation

Deterministic, synthetic-only evaluation of the FHIR MCP gateway's **retrieval
conformance**: whether scripted tool calls return the golden facts, with
provenance, coverage labels, bounded bytes/calls, outbound patient confinement,
and no prohibited disclosures. Default tasks assert exact raw decimal lexemes (`7.0`, trailing zeros, negative zero and an exponent) in every arm and both MCP protocol versions (2026-07-28 and 2025-11-25). The selected arm checks its projection flag and excludes unselected top-level fields, while retaining required modifier fields.

The generated report, not this page, is the authority for the results of any run.

## What this is not

- Not an agent benchmark. Task scripts are **deterministic oracle scripts**
  written by hand; no LLM chooses calls, no API keys are used, and no hidden
  model call happens anywhere in this package.
- Not evidence of clinical reasoning, diagnosis, or treatment performance.
- Not a comparison against other FHIR MCP servers, and not evidence that any
  output arm is "better" for a model. The suite holds fixtures and per-task
  budgets identical across arms and makes no superiority claim.

## Denominator

Report results as **N tasks x 3 formats**, with the number of format-sensitive
tasks, never as "3N cases". Task/format runs are not independent: a
format-insensitive task (discovery, denials, refusals) returns the same
response in every format. The harness measures this. A task is
format-sensitive when at least two formats received different normalized
responses (ids, handles, timings and the echoed format label removed). The
default run covers four corpora, 85 tasks in all:

| Corpus | Tasks | Where |
| --- | --- | --- |
| baseline | 45 (36 golden, plus 9 adversarial or byte-accounting) | `src/tasks.ts` |
| query | 28 | `data/m3b-query-tasks.json` |
| projection | 6 | `data/m3b-projection-tasks.json` |
| usability (auxiliary) | 6 | `data/s7a-usability-tasks.json` |

The first three are the 79 **primary** tasks; the six usability tasks are
**auxiliary** and are counted separately in the report
(`primary_tasks`, `auxiliary_usability_tasks`). The report states the
denominator in the form `85 tasks x 3 formats (N format-sensitive)`. The exact
denominator for a run is read from the generated report's `denominator` block
(`statement`), never from this page. The three data files are content-pinned by
`tests/eval-corpus-pin.test.ts`; changing an expectation requires reviewing the change and running `node --import tsx scripts/regenerate-eval-pins.ts`. This also regenerates external task pins without changing applicability decisions.

## Arms

Every task runs under three output arms on a fresh gateway, same fixture,
same per-task global budgets:

| Arm | Request |
| --- | --- |
| `fhir` | `output.format=fhir`, no field selection |
| `compact` | `output.format=compact`, no field selection |
| `selected` | `output.format=fhir` with the task's `fields` as `output.fields` |

Each task declares `fields` that cover all of its comparable facts, so the
`selected` arm is never starved. The compact recipes keep every
workflow-critical fact these tasks check, so compact is held to the same
facts as the other arms; a compact arm never exempts a workflow's critical
fact. The one genuine exclusion is `Patient.identifier`, which the Patient
compact recipe does not include: it is declared per-check with the arms it
applies to and a reason (and separately asserted as an omitted field), and
the verifier reports it as **incomparable** for the compact arm — not as a
failure, and never as a win for another arm. Each arm reports its comparable,
incomparable and pending check counts in the report's `summary.by_arm`; the
skipped check differs by arm (compact skips `Patient.identifier`; the other
arms skip the compact-only omission assertion). Counts describe declared
checks, not independent clinical cases.

## Protocol path and byte measurement

Every task/arm drives the real SDK path: an SDK `Client` talks to the
production `serveStdio` entry and tool adapter over a stdio-shaped in-memory
transport, negotiated in the selected MCP protocol version (`--era modern`, the
default, pins `2026-07-28`; `--era legacy` uses the `2025-11-25` handshake).

Result bytes are **measured independently** from the JSON-RPC `result` value
the SDK server actually emits, including version-specific fields and SDK-added
`_meta`; framing is reported separately. Since envelope schema 0.4 the per-call
ceiling counts the response once: the harness measures the model copy itself
(the larger of the LF-joined text blocks and the raw `structuredContent`
member) and requires `model copy <= requested max_bytes`, and requires the whole
result to stay within the wire invariant (`3 x requested max_bytes + 4096`).
The gateway's own `budget.bytes_returned` and `budget.wire_bytes` are compared
with those two measurements, and the report summarizes how often each under- or
over-reports. Whole-task byte budgets use the measured result bytes.

## Budgets and verification

Budgets (`maxBytes`, `maxUpstreamCalls`, `maxToolCalls`) are enforced by the
harness across the **whole task**, not per tool call. Upstream calls are
counted independently by the fixture server and cross-checked against the
gateway's own `budget.upstream_calls`; a mismatch is a failure. Overage stops
the task with a named failure cause. One in-flight bounded tool call can cross
a byte or upstream-call budget; no further calls are then dispatched.

Per task/arm the verifier checks, deterministically:

- **Response-bound facts.** Every check is bound to the step whose response
  must supply it. The binding is implicit only for single-step tasks; an
  unbound check in a multi-step task is a harness error. Resource facts must
  come from a response whose provenance carries the expected resource version.
  A fact present in an earlier read does not satisfy a later
  retained-projection check.
- Expected absences, exact ordered resource-id sequences for searches and
  paging drains, schema elements, withheld-payload / protected-link markers and
  compact omitted-field markers.
- **Outbound confinement.** Every search request must carry the trusted
  patient constraint (`patient`/`subject`, or `_id` for Patient). An opaque
  continuation can inherit it only by exactly matching a next link observed
  in an earlier source response in the same query chain, whose request was
  itself confined directly or through the same rule. The independent observer
  records the issuing request and exact-link digest. Unissued, cross-chain,
  modified, or first-request tokens fail. Checks for original query constraints
  use the same provenance; this does not prove source filter execution, sort
  order, or continuation completeness.
- **Per-response invariants.** Envelope schema; coverage scope matching the
  tool; one provenance entry per returned resource, with matching
  source/type/id/time and version; page coverage reporting the trusted
  constraint; `has_more`/`next_cursor` agreement and `returned_matches`.
- Prohibited disclosures: a scan of every envelope for global sentinels
  (withheld payload bytes, signed-link tokens, the other patient's id/note)
  plus per-task markers.
- Expected error codes for denial tasks (cross-patient read, conflicting
  patient selector, contained cross-patient resource).
- **Fixture-counted upstream work** (`upstreamWork` checks): a pre-send
  refusal must have made zero clinical requests according to the fixture's
  own request log, independent of the gateway's `budget.upstream_calls`.

## Adversarial fixture modes and known defects

Adversarial tasks switch the fixture into one misbehaving mode:

- a self link that omits a filter;
- a self link that claims an ignored filter;
- include-mode entries;
- the other patient leaking onto page 2 after a page-1 total;
- next links that drop the code filter;
- next links that drop the patient constraint;
- a capability result with 60 extra declared search parameters (near a byte
  ceiling);
- search-parameter types that conflict with the pinned R4 definitions.

Each task declares its expected safe outcome. Some tasks also declare
acceptable refusal codes (`allowedErrors`). The modes are defined in
`src/fixture.ts` (`ADVERSARIAL_MODES`).

The **known defect** mechanism remains for future, explicitly declared
expected failures: a task may declare one with an issue id (`jid`), matching
failures are reported as `known-defect` (never a pass), and a declared defect
that stops reproducing fails as `known_defect_resolved`. No task declares one
today. The mechanism never absorbs new failures automatically.

## Pending profile proof and private profiles

Seven query tasks (`query-complete-proven`, `query-cross-page-sort`,
`query-ignore-code`, `query-ignore-date-lower`, `query-ignore-date-upper`,
`query-ignore-sort-proven`, `query-empty-page-with-next-proven`) assert filter,
sort or continuation execution that only a qualified search profile can prove.
The synthetic fixture profile is qualified (evidence recorded in
`packages/core/src/data/search-profiles.json`, bound to the fixture, backend,
task-corpus and capability-revision digests), so the ordinary runner selects it
through public config and scores those tasks with ordinary verdicts. The `pending_profile_proof`
machinery remains the rollback path: with no eligible
profile their named proof checks are reported as pending while the calls still
run under the generic invariants, prohibited-marker scan and byte/work checks,
the rows stay in every denominator, and they never count as passes.
A pending check is never a mask: a genuine failure on one of these tasks is
reported as `fail`. The pending identities and task contents are pinned by
`tests/s57-eval-migration.test.ts`.

A test-only private profile (`testQueryProfile`) runs the same tasks with
status `private_profile_control` and its own verdict; those rows never
contribute to public pass totals. `selection.query_profiles[].warning_codes`
is the label the harness expects such a profile to carry (declared); each
call's `metrics.observed_warning_codes` records what the envelope actually
carried, and a private-profile success without the `TEST_QUERY_EVIDENCE`
warning fails with `private_profile_label_missing`.

The JSON report schema is `fhir-mcp-retrieval-eval/0.3`.

Failures are reported by cause (`expected_fact_missing`,
`upstream_confinement_missing`, `call_byte_limit_exceeded`, …).
`elapsed_ms` values are descriptive only; nothing asserts wall-clock
stability.

## Running

```sh
npm run eval:retrieval                          # protocol 2026-07-28 (default), all corpora
npm run eval:retrieval -- --era legacy          # protocol 2025-11-25; both must pass
npm run eval:retrieval -- --arm compact --filter glucose --era legacy
npm run eval:retrieval -- --corpus query --out .local/evals/query.json
```

`npm run eval:retrieval` runs `tsx packages/evals/src/cli.ts`, so the same
options work with `npx tsx packages/evals/src/cli.ts`; `--help` lists them all.
The common options are `--out`, `--arm fhir|compact|selected`, `--filter
<task-id-substring>`, `--era modern|legacy` and `--corpus
baseline|query|projection|usability|all`. The remaining flags (`--profile`,
`--host`, `--stratum`, `--packaged-bin`, `--configured-max-bytes`,
`--configured-default-bytes`, `--external-base-url`, `--external-image-digest`)
serve the packaged-install, measurement and live-HAPI runs; you do not need them
for the default run. The live-HAPI options need a local Docker HAPI server. See
[docs/QUICKSTART.md](../../docs/QUICKSTART.md) for the quickstart.

The JSON report defaults to `.local/evals/retrieval-eval-v0.json`
(gitignored). It records:

- fixture SHA-256, including the adversarial modes;
- code revision (derived via `git` by the CLI only);
- the selected protocol (`--era` value) and the negotiated version;
- gateway envelope schema version;
- pinned R4 schema package/version/hash;
- package version;
- denominator and per-call byte metrics;
- stably sorted per-task/arm results.

The process exits non-zero if any comparable check, invariant or budget fails
outside a declared known defect, if a declared known defect no longer
reproduces, if a private-profile control fails, or if the gateway's
`bytes_returned` disagrees with the independently measured model copy, or its
`wire_bytes` with the measured wire result, on any call
(`summary.byte_accounting`). Pending profile proof alone does not fail a run.

Programmatic use (tests; the project uses no hosted CI):

```ts
import { runEvals, exitCodeForReport } from './packages/evals/src/index.js';
const report = await runEvals({ era: 'modern' });
process.exitCode = exitCodeForReport(report);
```

Importing `src/index.ts` or `src/runner.ts` never starts a run or a server;
only `src/cli.ts` executes, and only when invoked directly.

## Layout

- `src/fixture.ts` — golden synthetic resources, adversarial modes, fixture
  SHA-256, the corpus loader and the loopback FHIR fixture server (request log).
- `src/tasks.ts` — the baseline oracle-script tasks (types + definitions); it
  also loads the query, projection and usability tasks from `data/`.
- `src/check-contracts.ts` and `src/evidence-oracle.ts` — the check types and
  the oracle that evaluates them against collected responses.
- `src/upstream-provenance.ts` — the independent observer of upstream requests
  that the confinement and continuation checks rely on.
- `src/runner.ts` — SDK session, arm execution, verifier, budgets and report
  builder.
- `src/cli.ts` — the command-line entry point (options above).
- `src/index.ts` — the programmatic exports.
- `src/catalog.ts` — measurement of the advertised tool catalog.
- `src/external.ts` and `src/external-qualification.ts` — the live-HAPI
  (external backend) support; `data/hapi-profile-tasks.json` and
  `data/external-applicability.json` feed it.
- `src/package-tasks.ts` — the three tasks that the quickstart helper and the
  installed-package check run (3 tasks x 3 arms x 2 protocol versions = 18 runs).
- `data/tokenizers.lock.json` — hash-locked tokenizer pins, used with
  `scripts/requirements-tokenizers.txt` by the catalog measurement scripts.
- `fixtures/` — the `m3b-query` and `m3b-projection` fixture fragments and the
  `quickstart` seed that the helper loads.
- `../../tests/evals.test.ts` — maintained test suite. Its self-tests show
  that each of these fails:
  - wrong or wrongly-bound facts;
  - an emptied retained projection;
  - prohibited disclosures;
  - budget overages;
  - unaccounted adapter bytes;
  - unmarked confinement defects;
  - stale known-defect markers.
