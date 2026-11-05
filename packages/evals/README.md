# Retrieval-conformance evaluation

Deterministic, synthetic-only evaluation of the FHIR MCP gateway's **retrieval
conformance**: whether scripted tool calls return the golden facts, with
provenance, coverage labels, bounded bytes/calls, outbound patient confinement,
and no prohibited disclosures.

## What this is not

- Not an agent benchmark. Task scripts are **deterministic oracle scripts**
  written by hand; no LLM chooses calls, no API keys are used, and no hidden
  model call happens anywhere in this package.
- Not evidence of clinical reasoning, diagnosis, or treatment performance.
- Not a comparison against other FHIR MCP servers, and not evidence that any
  output arm is "better" for a model. Published competitor evaluations
  (e.g. coralehr/fhir-mcp-eval) found no reliable tool-count superiority and
  are confounded by differing budgets; this suite therefore holds fixtures
  and per-task budgets identical across arms and makes no superiority claim.

## Denominator

Report results as **N tasks x 3 formats**, with the number of format-sensitive
tasks, never as "3N cases". Task/format runs are not independent: a
format-insensitive task (discovery, denials, refusals) returns the same
response in every format. The harness measures this. A task is
format-sensitive when at least two formats received different normalized
responses (ids, handles, timings and the echoed format label removed). The
suite has three corpora: 44 baseline tasks defined in `src/tasks.ts` (36
golden plus 8 adversarial/byte-accounting), 25 M3b query tasks in
`data/m3b-query-tasks.json` and 5 M3b projection tasks in
`data/m3b-projection-tasks.json`, 74 tasks in all. The exact denominator for
a run, including the format-sensitive count, is read from the generated
report's `denominator` block (`statement`, for example `74 tasks x 3 formats
(61 format-sensitive)`), never from this page. Both M3b corpora are
content-pinned by `tests/eval-corpus-pin.test.ts`; changing an expectation
means updating that pin deliberately.

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
transport, negotiated in the selected protocol era (`--era modern`, the
default, pins `2026-07-28`; `--era legacy` uses the 2025 handshake).

Result bytes are **measured independently** from the JSON-RPC `result` value
the SDK server actually emits, including era-specific fields and SDK-added
`_meta`; framing is reported separately. The gateway's own
`budget.bytes_returned` is recorded only for comparison, and the report
summarizes how often it under- or over-reports. Whole-task byte budgets and the
per-call ceiling (`measured result <= requested max_bytes`) both use the
measured bytes.

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
- a capability result near a byte ceiling.

Each task declares its expected safe outcome. Some tasks also declare
acceptable refusal codes (`allowedErrors`).

The **known defect** mechanism remains for future, explicitly declared
expected failures: a task may declare one with its joint-audit id, matching
failures are reported as `known-defect` (never a pass), and a declared defect
that stops reproducing fails as `known_defect_resolved`. The current 44-task
suite declares none; the earlier J-5, J-9, J-17 and J-35 markers were removed
when M3a fixed them, and both eras report zero known-defect runs. The
mechanism never absorbs new review findings automatically.

## Pending profile proof and private profiles

Seven query tasks (`query-complete-proven`, `query-cross-page-sort`,
`query-ignore-code`, `query-ignore-date-lower`, `query-ignore-date-upper`,
`query-ignore-sort-proven`, `query-empty-page-with-next-proven`) assert filter,
sort or continuation execution that only a qualified search profile can prove.
Since S6 the synthetic fixture profile is qualified (evidence recorded in
`packages/core/src/data/search-profiles.json`, bound to the fixture, backend,
task-corpus and capability-revision digests), so the ordinary runner selects it
through public config and scores those tasks with ordinary verdicts. The
`pending_profile_proof` machinery remains the rollback path: with no eligible
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
npx tsx packages/evals/src/cli.ts
# options:
npx tsx packages/evals/src/cli.ts --out .local/evals/retrieval-eval-v0.json
npx tsx packages/evals/src/cli.ts --arm compact --filter glucose --era legacy
```

The JSON report defaults to `.local/evals/retrieval-eval-v0.json`
(gitignored). It records:

- fixture SHA-256, including the adversarial modes;
- code revision (derived via `git` by the CLI only);
- protocol era and negotiated version;
- gateway envelope schema version;
- pinned R4 schema package/version/hash;
- package version;
- denominator and per-call byte metrics;
- stably sorted per-task/arm results.

The process exits non-zero if any comparable check, invariant or budget fails
outside a declared known defect, if a declared known defect no longer
reproduces, if a private-profile control fails, or if the gateway's reported
bytes disagree with the independently measured wire bytes on any call
(`summary.byte_accounting`). Pending profile proof alone does not fail a run.

Programmatic use (tests, CI):

```ts
import { runEvals, exitCodeForReport } from './packages/evals/src/index.js';
const report = await runEvals({ era: 'modern' });
process.exitCode = exitCodeForReport(report);
```

Importing `src/index.ts` or `src/runner.ts` never starts a run or a server;
only `src/cli.ts` executes, and only when invoked directly.

## Layout

- `src/fixture.ts` — golden synthetic resources, adversarial modes, fixture
  SHA-256, and the loopback FHIR fixture server (request log).
- `src/tasks.ts` — the oracle-script tasks (types + definitions).
- `src/runner.ts` — SDK session, arm execution, verifier, budgets and report
  builder.
- `src/cli.ts` — `--out/--arm/--filter/--era` CLI.
- `../../tests/evals.test.ts` — maintained test suite. Its self-tests show
  that each of these fails:
  - wrong or wrongly-bound facts;
  - an emptied retained projection;
  - prohibited disclosures;
  - budget overages;
  - unaccounted adapter bytes;
  - unmarked confinement defects;
  - stale known-defect markers.
