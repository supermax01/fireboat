# G-BACKEND: external qualification design and result

Draft for root review under PLAN 0.4.1, S6, and the supplied release-plan A8.
The follow-up adopts root's issued-link provenance rule for opaque paging and
declares a narrower filter-only HAPI candidate. `hapi-r4-labs-v1` remains
`eligible: false` with `evidence: null`; qualification evidence is emitted for
root review only.

## Backend and corpus

The independent backend is the operator-supplied HAPI FHIR Server 8.12.0 at
`http://127.0.0.1:18091/fhir`, image `hapiproject/hapi:v8.12.0-2`, arm64 digest
`sha256:0ff86aac4c7bd13a1ee226444a70263bb46ed1c28ef543c30a44f865b80ca04e`.
Discovery confirms software name/version and FHIR 4.0.1. The image digest is an
operator attestation; FHIR does not attest the running container image.

The eval-only loader uses the gateway's literal-loopback validation, bounded
HTTP without ambient proxies, disabled redirects, and same-origin/base-path
validation for census continuations. It performs fixed-id transaction PUTs,
reads every resource back, and enumerates every evaluated type before and after
loading. Extra, missing, duplicate, changed, incompletely enumerated, or
inconsistently counted resources prevent a run. No gateway write tool is added.

The fixed external corpus contains 52 baseline-plus-query resources across
eight types. Four raw projection-only resources are omitted because no current
task retrieves them and their inclusion would change query pools. Their hash
and omission reason are recorded. No per-task backend mutation simulates a
scenario or changes this corpus.

The first transaction exposed two invalid `base64Binary` fixture sentinels:
DocumentReference `content[0].attachment.data` and DiagnosticReport
`presentedForm[0].data`. The external input builder now explicitly base64-encodes
their exact UTF-8 bytes and hashes the resulting input. Original fixtures and
task expectations are unchanged. The two initial records were reconciled once
through a scratch transaction after exact prior-content verification. The
reusable loader has no mismatch-repair exception.

Readback ignores only top-level `meta.versionId`, `meta.lastUpdated`, and a
server-added `meta.source` absent from the input. All other fields remain exact.
Readback versions supply provenance checks that derive their version from the
corpus; explicitly asserted versions are never rewritten.

## Binding and fail-closed rules

External sources use `kind: external`, `image_digest`, and `corpus_sha256`
instead of the fixture/backend-module hash pair. Eligible external registry
entries require these pins, exact software/version/FHIR identity, a capability
revision, task hash, report hash, and recording time.

| Binding | Enforcement |
| --- | --- |
| Software name/version | Exact runtime comparison through the existing process-keyed digests; external versions cannot be wildcards |
| FHIR version and capability revision | Runtime source comparison; external evals also check discovered envelope revisions during calls |
| Image digest | Operator-supplied pinned identity checked by the external harness |
| Corpus hash | Exact transaction-input bodies, strict readback/census, and external `profileDrift` |
| Task hash | Full task definitions plus reviewed applicability, checked by external `profileDrift` |

Prepared state is an immutable owned snapshot. Metadata and census are checked
at run boundaries. The synthetic profile's bindings, evidence, fixture backend,
and ordinary behavior remain unchanged.

## Opaque paging provenance

The eval observer captures actual HTTP requests and complete source response
bytes, with bounded compressed and decoded bodies. A request without visible
patient confinement can inherit it only through an exact next link issued by
the same source in response to an earlier confined request in the same task,
arm, and query chain. The rule recurses through accepted continuations. Each
search invocation gets a distinct harness-owned chain, even for identical
queries; explicit cursor calls inherit only their recorded chain.

Matching binds the origin, path, and every ordered parameter occurrence.
Unissued links, other-chain or other-query tokens, modified links, and opaque
first requests fail. Conflicting visible predicates and resource-type changes
cannot be rescued by an issued link. Only successful searchset responses with
a unique next link can add a link to the ledger. Original code/date constraint
checks inherit absent pairs through the same verified ancestry.

Each accepted request records its request index, issuing request index,
confined root request index, chain/query hashes, and exact issued-link hash.
The report contains no raw paging token, patient identifier, or request URL.
Fixture mode uses the same observer; its transparent links continue to satisfy
the visible-predicate rule. Packaged fixture calls are observed at the source
server boundary.

This rule concerns observable outbound confinement. It grants no source filter
execution, sort, or continuation-completeness proof. Gateway continuation
labels and strict gates are unchanged.

## Applicability and qualification

The reviewed table pins every task's definition and its classification; unknown
or changed definitions/assignments fail closed. A failing real task stays real.

| Corpus | Real backend | Fixture-dependent | Outside profile claims |
| --- | ---: | ---: | ---: |
| Baseline | 35 | 9 | 0 |
| Original query | 18 | 8 | 2 |
| Projection | 2 | 3 | 0 |
| New HAPI controls | 4 | 0 | 0 |
| Total | 59 | 20 | 2 |

Exclusions require fixture misbehavior, a fixed capability catalog, a per-task
data view, or hard-coded fixture versions. Every excluded task and reason is
listed in `packages/evals/data/external-applicability.json` and the generated
summary. The executable conflicting-definition task only checks resource-type
discovery; the report explicitly avoids claiming conflict evidence from it.

`query-complete-proven` and `query-cross-page-sort` require tested sorting,
which the narrow profile does not claim. They are explicitly
`profile-inapplicable` for HAPI qualification, with their unchanged synthetic
regression task IDs recorded. They are not fixture simulations. The three
public paging tasks remain applicable to HAPI.

Four external-only controls qualify exact system-qualified-code membership,
the combined code/`ge`/`lt` window, and each date bound independently. They
check exact unordered resource sets, reject duplicates and decoys, and assert
the per-constraint execution evidence and aggregate label. The code control
also exercises escaped-comma OR alternatives. Original task definitions and
the synthetic task hash are unchanged.

Qualification independently expects 59 tasks × three arms per era, including
four private profile tasks × three arms. All controls, labels, public results,
pending counts, identities, and byte accounting must pass before evidence can
be emitted. The candidate uses the declared public id/version, source pins,
and filter claims, with `eligible=false` and `evidence=null`. A measured source
that differs from the declaration is refused. The script never edits the
registry.

## Qualification result

The root rerun passed on 2026-10-23 in both eras, all three arms: 55 public
tasks plus four passing private controls per arm. Across both eras this is
330 public rows and 24 private rows, with zero failed or pending rows and zero
byte-accounting deviations across 468 tool calls. The modern protocol is
`2026-07-28`; legacy negotiated `2025-11-25`.

The three prior public failures were transparent-paging eval assumptions,
resolved by the approved provenance rule. All their original task assertions
pass. Source-issued opaque paging still carries unverified continuation and
sort labels in the gateway, as the generic cross-page honesty task requires.

| Task | Accepted opaque requests per arm/era | Request ← issuer (confined root is 2) | All six task runs |
| --- | ---: | --- | --- |
| `heart-rate-paging-drain` | 2 | 3 ← 2; 4 ← 3 | pass |
| `p-guidance-cursor-drain` | 5 | 3 ← 2; 4 ← 3; 5 ← 4; 6 ← 5; 7 ← 6 | pass |
| `query-cross-page-sort-generic` | 3 | 3 ← 2; 4 ← 3; 5 ← 4 | pass |

All 60 accepted-link records include exact issued-link, chain, and query
digests in the generated summary and raw reports. The profile's only filter
variants are `token-system-code` and `effective-interval-ge-lt` on Observation.
All tested sorts and continuations remain empty; confinement remains a gateway
rule. No existing task expectation or gateway proof rule changed.

Evidence candidate emitted by the successful run, not recorded in the registry:

```json
{
  "report_sha256": "d7673117fe3e81898f30934d5e44543c107296992759c11d564225ef6667d9cd",
  "recorded_at": "2026-10-23T21:15:32.097Z",
  "capability_revision": "0835b8480514fb73",
  "tasks_sha256": "8a649af6fda16c203f6e9bb62fcdf3cc7c9236655f1feb98bb0ff236dbf771ff"
}
```

The source corpus hash remains
`bbd21aa1ede24de3c3cd59f8db5991e11b343b31f3700a6bdae3bf3e916e1404`.
The complete source identity accompanies the evidence in the generated summary.
Recording eligibility and rerunning ordinary public selection remain root work.

Verification: explicit typecheck passed; `npm run check` passed all 1,962 tests
and the build; anchors passed; both fixture eval eras passed 77/77 tasks and
231/231 comparable checks per arm. The new unit mutant
`gbackend-opaque-getpages-unissued-accepted` compiles and builds, then reproduces
the named forged-token assertion failure twice. This focused witness is not an
official mutation aggregate. The previous 43 mutants' witnesses are retained;
their full mutation runs were not repeated for this follow-up.

The complete 81-row applicability table, all 354 arm/era rows, all 60 accepted
opaque links, and evidence block are in
`.local/gbackend-qualification/qualification.md`, beside the raw reports.
Exact commands, file-by-file changes, logs, the mutant witness, and a compact
per-task table are under `.local/gbackend-followup-verification/`, including
`handoff.md`. Previous qualification artifacts are preserved there under
`prior-qualification/`.

The opt-in command uses `FHIR_MCP_HAPI_BASE_URL` and
`scripts/qualify-hapi-search-profile.ts`; unset, it skips without requests.
It is not part of `npm run check`. No git writes, dependency changes, container
operations, synthetic-evidence edits, or isolation-file edits occurred. Root
owns eligibility review, the isolation-manifest refresh, official aggregation,
and all git work. This result makes no SMART, clinical-readiness,
vendor-support, or general protocol-compatibility claim.
