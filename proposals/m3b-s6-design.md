# M3b S6 design and record: profile proof

- **Author:** Claude (root), 2026-10-22, working solo by owner instruction. Closes the seven S6 obligations (release plan §2.3, GPT §4.4; `proposals/audit/gpt-s58-consensus-position.md` "S6 must reconcile…"): the five pending eval tasks and the two mixed-proof TODOs, by qualifying `synthetic-fixture-r4-v1` through the non-circular order (independent vectors → labelled private candidate → frozen evidence → eligible registry and derived config → ordinary public-selection rerun with no override). `hapi-r4-labs-v1` stays ineligible.
- **Baseline:** the S5 checkpoint `750c611`, branch `candidate/s6` in `.local/worktrees/s6`; merged after S5b.
- **Contract impact:** no new `query_evidence` value and no listing change (`emit-m3b-contract --check` in sync). The strict gate is tightened (trusted sort proof) and one rule is re-expressed against the trusted proof (§5). The spec §7 reading is recorded as a root amendment in `proposals/CONSENSUS.md`.

## 1. Root decisions on the open questions (from the S6 code map)

1. **Mixed-proof evidence kind: option A.** `query_evidence` stays the weakest-link label. A response whose trusted proof contains any `unknown` execution is `declared_and_self_link_only`; its disclosed constraints keep their honest per-constraint executions, so a `tested_adapter` constraint may appear under the declared kind. The frozen-gate rule "declared with any tested_adapter constraint fails" is replaced by a trusted-proof rule: the declared kind is rejected on a non-empty proof with no `unknown` execution (that set is linkage or `tested_adapter`); the per-index rule keeps the disclosed list equal to the proof. `evidenceKindFor` and the force-declared line in `currentQueryEvidence` are unchanged. This follows the consensus text ("a tested code predicate can coexist with an unknown date predicate in partial/unknown coverage"; "do not resolve this by erasing valid pair proof").
2. **A partially proved query is never `complete_for_query`.** Already enforced; pinned by explicit negative controls (full page S6-07, shorthand via the existing proof rules). `NO_MATCHES` stays eligible for mixed states.
3. **Trusted sort proof.** `ValidationContext02.query.sortProof: { order, effective }` is captured from the chain's current evidence in `invocationV2`, next to `constraintProof`. Gate: a chain with a requested sort needs `sortProof` (`VALIDATION_CONTEXT_REQUIRED`); the disclosed `sort.order` and `effective` must equal the proof, on full and shorthand pages (closes S5 review finding 2d). Scope stays sticky per chain (S4 immutable state): a downgrade persists, nothing upgrades. The informational `overlay.sortProof` field is kept (frozen overlay shape); the trusted proof lives in the validation context.
4. **Provable sort result sets.** `q-instant` keeps serving `query-date-instant` under its own LOINC code (17856-6), so the HbA1c 4548-4 pool (baseline `obs-hba1c-1`, `q-match`, `q-decoy-early`, `q-decoy-late`) is a single-precision, timezone-qualified result set; `query-complete-proven` and `query-cross-page-sort` become provable without changing their budgets.
5. **Cross-page task contract.** Four HbA1c records at `page_size 1` drain in one search plus three continuations: exactly the four-call budget, which is not raised (review finding 8 corrected the earlier "three records" count). `query-cross-page-sort` q1 binds to `response_index: 'all'`, so every page carries `verified_by_adapter`; the generic oracle binds its drained-page checks to the fourth page.
6. **Continuation label.** When the proving profile lists `offset-next-link`, the continuation URL is the reviewed numeric-offset form, the requested offset equals the previous page's offset plus the match entries that page returned (`overlay.pageOffset`/`pageEntries`), and the continued page reports a self link that matches the material query and carries exactly this request's offset with no `_getpages`/`_getpagesoffset`/`_cursor`, the page keeps the chain's evidence kind; a drained chain can then be `complete_for_query`. Any failure makes the chain's `continuationUnverified` flag sticky: every later page is `unverified_continuation` (a remainder of unknown extent, state `partial`), the cross-page order claim is dropped, and the trusted context carries the flag so the gate rejects any later relabelling or completion. Opaque HAPI paging and generic sources keep N-06 as before. (Review findings 1–3: the first cut trusted the next link's offset arithmetic and relabelled per page.)
7. **Evidence chain.** `source.fixture_sha256` and `source.backend_sha256` stay where they were and are refreshed by the qualification; `evidence` gains `capability_revision` (the gateway-computed normalized revision of the fixture's CapabilityStatement) and `tasks_sha256` (canonical digest of `m3b-query-tasks.json`). Runtime binding: `CapabilitySourceIdentity` carries the discovered revision and `profileMatchesSource` returns no proof unless it equals a recorded revision (fail closed when none was discovered; review finding 6); a registry invariant refuses to load a shipped eligible claiming profile without a recorded revision. The eval runner refuses (throws) a qualified profile whose recorded fixture, backend or task-corpus digest differs from what it serves. A drift test pins every hash while the profile is eligible, and `--doctor` reports the gateway's own proving status (`describeSearchProfile()`).
8. **Registry and config derivation.** The config enum is `z.enum(eligibleSearchProfileIds())`; `GatewayConfig.source.searchProfile` is a string whose closed set the schema enforces. Selecting an ineligible profile is `INVALID_CONFIG`; `--doctor` prints the selected profile and whether its proof is bound to the discovered capability revision. `hapi-r4-labs-v1` keeps its placeholder; no `testSearchProfileRegistryOverride`.
9. **Claimed versus discriminated variants.** Every claimed variant has a discriminating task: code `token-system-code` (complete-proven, ignore-code, escaped-comma, systemless), date `effective-interval-*` (complete-proven, ignore-date-lower/upper, oracle vectors, date-instant), confinement (complete-proven), sort `descending-timezone-qualified-effectiveDateTime` (`query-ignore-sort-proven`, complete-proven, cross-page-sort, oracle vectors), continuation `offset-next-link` (cross-page-sort). The fixture's `query-ignore-sort*` scenarios ignore `_sort`; the fragment's declared behaviours are unchanged.
10. **Discovery wiring** of `execution_evidence` stays out of S6 (S7 documents it as `unknown`).
11. **Honesty oracles under `generic-r4`:** `query-echo-only-unknown` (never complete, never tested, sort unverified) and `query-ignore-sort` already exist; S6 adds `query-cross-page-sort-generic` (every page `requested_unverified`, first page partial, drained chain partial with `unverified_continuation`, never complete) and, under the profile, the negative control `query-empty-page-with-next-proven` (an empty first page whose next link jumps to offset 20: the drained page stays partial, unverified and unordered, with no completeness claim). The pending machinery stays as the rollback path, reachable through the private `simulateIneligibleProfile` test option.
12. **HAPI and Medplum** remain interoperability-only; binding them needs an out-of-gateway identity capture (later slice).

## 2. Implementation record (branch `candidate/s6`)

- `packages/core/src/contracts.ts`: `sortProof` on `ValidationContext02.query`; the mixed-proof rule inside the trusted-proof block; the two sort-proof rules after the verified-effective rule; `GatewayConfig.source.searchProfile: string`.
- `packages/core/src/index.ts`: `invocationV2` captures `sortProof`; `fetchPage` computes `continuationVerified` and labels the page; `boundedSourceIdentity` carries the capability revision; the config enum derives from `eligibleSearchProfileIds()`.
- `packages/core/src/query.ts`: `SearchProfileEvidence` (`capability_revision`, `tasks_sha256`); `CapabilitySourceIdentity.revision`; `profileMatchesSource` binds the revision.
- `packages/server/src/cli.ts`: `--doctor` prints `search_profile`.
- `packages/evals/src/runner.ts`: `query-ignore-sort-proven` joins the profile-dependency maps; `profileDrift` (exported) and the fail-closed refusal; `simulateIneligibleProfile` on the private test options.
- `packages/evals/src/fixture.ts`: `query-ignore-sort*` scenarios ignore `_sort`.
- `packages/evals/fixtures/m3b-query/fragment.json`: `q-instant` → LOINC 17856-6. `packages/evals/data/m3b-query-tasks.json`: `query-date-instant` searches 17856-6; `query-cross-page-sort` q1 on every page; `query-ignore-sort-proven`; `query-cross-page-sort-generic` (27 tasks, 39 checks).
- `packages/core/src/data/search-profiles.json`: `synthetic-fixture-r4-v1` eligible with recorded evidence and refreshed source digests (§4); test ids updated.
- `scripts/qualify-search-profile.ts`: the root-owned qualification run (private candidate with the public id through the constructor seam, both eras, every arm; prints the evidence block; never edits the registry).
- Tests: `tests/s5-strict-gate-v2.test.ts` (S6-01…S6-07 and the P24 relabel; every search fixture context carries a sort proof), `tests/s4-query-state.test.ts` (the two former TODOs run; S6 continuation tests), `tests/s6-profile-proof.test.ts` (evidence chain, drift refusal, revision binding, derived config enum), `tests/s57-eval-migration.test.ts` (rollback path, private controls all passing, qualified public selection, pinned task hashes), `tests/s53-r2-helpers.ts` (sort proof in the matrix contexts), pins in `tests/eval-corpus-pin.test.ts`, `tests/query-evidence.test.ts`, `tests/s1-self-link-normalization.test.ts`, `tests/s2-capability-invalidation.test.ts`.
- Registry (17 mutants): `crossfield02-sort-proof-not-required`, `crossfield02-sort-proof-unbound`, `crossfield02-declared-with-full-proof`, `crossfield02-continuation-flag-unbound`, `crossfield02-sort-without-chain`, `invocation-sort-proof-dropped`, `continuation-verified-label-dropped`, `continuation-verified-without-self-link`, `continuation-offset-arithmetic-unchecked`, `continuation-self-paging-unchecked`, `continuation-flag-not-sticky`, `identity-revision-dropped`, `profile-revision-unbound`, `registry-revision-invariant-skipped`, `sort-instant-variant-accepted`, `config-enum-not-derived`, `eval-profile-drift-unchecked`; `hashes.mutants` refreshed last. `--only` evidence and A2 rows are recorded with the aggregate (docs/S6-STATUS.md). Mutants in `packages/evals/src/fixture.ts` now also trip the runner's backend-digest refusal, so their named kills include the drift tests.
- Review round additions: `FhirGateway.describeSearchProfile()` (doctor), `assertSearchProfileRegistry` (load-time invariant), `queryFragmentResources`/`profileDrift` with the task-corpus digest, `QueryOverlay.pageOffset`/`pageEntries`/`continuationUnverified`, `ValidationContext02.query.continuationUnverified`, the negative-control task and the re-qualification.
- GPT-6-Astra project review (`proposals/audit/gpt-astra-project-review-2026-10-22.md`): `DateInterval.subMillisecond` (more than three fractional digits); `dateSearchOutcome` is undecidable, `filterVariantProved` false and `validateSortPage` unverifiable (`sub-millisecond-precision`) for such values, so the millisecond arithmetic can no longer call distinct instants equal or order an ascending sub-millisecond pair as descending. Mutants `date-subms-equality-decided`, `date-subms-variant-proved`, `sort-subms-ordered`. The eval fixture's own millisecond truncation (`packages/evals/src/fixture.ts`) is recorded debt: no corpus value uses sub-millisecond precision and no proof claim depends on it.
- Docs: `docs/evidence/s6-profile-qualification.md`, `docs/S6-STATUS.md`, this record, the CONSENSUS amendment.

## 3. Deviations from the design draft

- `overlay.sortProof` is kept (informational), not removed: the overlay shape is frozen for Q and the trusted proof now lives in the validation context.
- The evidence shape keeps the fixture/backend digests in `source` (where the registry and the earlier drift pins already expected them) and adds `capability_revision` and `tasks_sha256` to `evidence`.
- The continuation label additionally requires a reported, matching self link on the continued page (pinned by "a proved continuation form without a reported self link keeps N-06").
- `profileProves` does not require `capability_revision` (private test candidates record none); the drift test requires it on the public qualified profile, and `profileMatchesSource` binds it whenever present.

## 4. Qualification (2026-10-22, re-run after the review round)

`node --import tsx scripts/qualify-search-profile.ts synthetic-fixture-r4-v1 .local/s6-qualification`: 21 private-profile-control rows per era (seven tasks × three arms), 0 not passing, 0 mislabelled, 0 pending, no public failures, exit 0, in both eras. Recorded: `report_sha256 d06b6f48…` (canonical JSON of both raw reports, kept locally), `recorded_at 2026-10-22T16:24:22.193Z`, `capability_revision d4e500616f35fe24`, `tasks_sha256 ce7c9440…`; `source.fixture_sha256 c14e170b…`, `source.backend_sha256 763bfddc…` (the first qualification of the day, `02f19657…`, preceded the review fixes and was replaced). Summary: `docs/evidence/s6-profile-qualification.md`. The public-selection rerun with no override (`tests/s57-eval-migration.test.ts`) passes all seven tasks in both eras with `query_profile.private === false` and no observed `TEST_QUERY_EVIDENCE` warning; the full corpus has no pending row.

### 4.1 Independent review (Opus adversarial pass, 2026-10-22, uncommitted diff on 750c611)

| # | Severity | Finding | Decision |
| --- | --- | --- | --- |
| 1 | High | Proved continuations trusted the next link's offset arithmetic: on the fixture's own empty-first-page scenario the qualified profile completed the chain with a verified `NO_MATCHES` over a skipped window. | **Fixed:** offset arithmetic (`pageOffset` + `pageEntries`), sticky `continuationUnverified`, cross-page order dropped with it; negative-control task `query-empty-page-with-next-proven`; re-qualified. |
| 2 | High | The N-06 label was per page: a later verified continuation relabelled and completed a chain after an unverified one. | **Fixed:** sticky overlay flag carried into the trusted context with a gate rule (S6-08/S6-09); 3-page tests. |
| 3 | Medium | The continuation self-link check ignored paging parameters (another `_offset`, `_getpages`). | **Fixed:** the continued page's self link must carry exactly this request's offset and no opaque mechanics. |
| 4 | Medium | `config-enum-not-derived` did not typecheck (would have failed the aggregate as inconclusive). | **Fixed:** literal-first tuple. |
| 5 | Medium | A `coverage.sort` claim on an envelope outside any query chain was unconstrained. | **Fixed:** rejected without a query context (S6-10). |
| 6 | Medium | Revision binding failed open without a discovered revision; `profileProves` did not require a recorded revision. | **Fixed:** fail closed; load-time registry invariant; gateway test against the `wide-capability` fixture mode. |
| 7 | Medium | The qualification script emitted evidence before checking the result and did not assert the control count or identity. | **Fixed:** evidence only after both eras pass; control count and private identity asserted; FAILED marker. |
| 8 | Low | Four HbA1c records, not three; the generic oracle's drained-page checks bound an intermediate page. | **Fixed:** texts corrected; q3/q4 bound to the fourth page. |
| 9 | Low | Eval-side drift checks narrower than claimed; fragment slice vs `fragment.resources`. | **Fixed:** task-corpus digest checked; `queryFragmentResources` shared with the drift test; CONSENSUS wording made precise. |
| 10 | Low | `--doctor` reported binding from revision equality alone. | **Fixed:** `describeSearchProfile()` from the gateway's trusted state. |
| 11 | Low | Test-strength gaps (observed warnings, wire labels on the former TODOs, effectiveInstant exclusion). | **Fixed:** assertions and `sort-instant-variant-accepted` added. |
| 12 | Low | Stale text. | **Fixed.** |

## 5. Gate before/after

Valid controls (pass before and after): every hand-built valid fixture (`tests/s5-strict-gate-v2.test.ts`), every real-gateway envelope in the unit suite, the 27-state coverage matrix, both eval eras, the demos. Every search-chain fixture context now carries the trusted sort proof; the gate's `VALIDATION_CONTEXT_REQUIRED` branch for a missing proof is pinned (S6-04).

| Control | Before | After |
| --- | --- | --- |
| Mixed proof: tested `code`, unknown `date`, declared kind, caveat present, trusted proof mixed (S6-05) | `INVALID_CROSS_FIELDS` (the frozen rule rejected the honest envelope; the gateway produced it, so the request became `INTERNAL_ERROR`; two S4 TODOs) | accepted |
| Declared kind on a fully proved non-empty set (S6-06) | rejected | rejected (new trusted-proof rule) |
| Partially proved query claiming `complete_for_query` under `tested_adapter` (S6-07) | rejected | rejected |
| Verified sort backed by the trusted sort proof, filters unproved (S6-01) | accepted | accepted |
| Verified sort, warning removed, trusted proof `requested_unverified` (S6-02) | accepted | rejected |
| Shorthand page upgrading the sort to `verified_by_adapter` without proof (S6-03; S5 finding 2d) | accepted | rejected |
| Disclosed `tested_adapter` where the trusted proof says unknown (P24) | rejected | rejected (per-index rule) |
| Later page relabels or completes a chain flagged `continuationUnverified` in the trusted context (S6-08) | accepted (no flag existed) | rejected |
| Honest unverified continuation under the flag (S6-09) | accepted | accepted |
| `coverage.sort` claim on a read-origin retained view with no query context (S6-10) | accepted | `VALIDATION_CONTEXT_REQUIRED` |

The one newly accepted class is exactly the envelope the gateway honestly produces for a partially proved query; no forgery class became acceptable, and the sort rows close a documented S5 debt. At runtime, the review round removed the one new false-claim class the first cut had created (a proved-form continuation over a skipped window) by binding the offset arithmetic and making the label sticky.

## 6. Acceptance

`npm run check` with zero TODO; isolation 76/76; both eval eras with 0 `pending_profile_proof` and the six profile tasks passing on ordinary verdicts under public selection; the drift test; demos; contract `--check`; `--only` evidence for every new mutant; the 14-shard aggregate on the merged commit; the independent review pass. HAPI stays ineligible and no live-backend claim is made.

## 7. Verification before merge (2026-10-22, rebased onto `r/s5-candidate` f486ceb with S5b)

| Check | Result |
| --- | --- |
| Rebase | two conflicts (registry tail, `hashes.mutants`), both additive; `cases-v1.json` regenerated, which also corrected 41 stale scenario anchor lines (`scenarios.ts:223` → `:227`, unchanged since the S5.7 fix round) |
| `tsc --noEmit` | clean |
| `tests/mutation-anchors.test.ts` | every registered anchor (511 entries) matches exactly once |
| `npm run check` | 1,935 node tests: 1,935 pass, 0 fail, 0 TODO; build with the compiled-identity check |
| Retrieval evals, both eras | 77/77 tasks per arm, 0 pending, 0 fail; 231/231 comparable checks per arm; 0 byte-accounting deviations |
| `npm run test:isolation` | 76/76 (68 diagnostic cases, 0 counted) |
| Contract `--check` | in sync |
| `npm run demo` | completes |
| Registry (`--only`, 1 worker × 2, unit baseline 44 s, cap 264 s) | 20/20 S6 mutants killed with named, reproduced failures; no timeout-only kills; the first attempt found the unit baseline red in a clean copy (`tests/f06-source-identity.test.ts` built an identity without the bound capability revision) and that test now carries the bound revision and asserts that a different or missing revision is refused |

Not run on this tree before the merge: the official 14-shard aggregate (launched on the merged commit), CI, any live backend.

