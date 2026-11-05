# M3b S6 status: profile proof

Record of the S6 slice (`candidate/s6`, based on the S5 checkpoint `750c611`, merged after S5b). Design and implementation record: `proposals/m3b-s6-design.md`. Qualification evidence: `docs/evidence/s6-profile-qualification.md`. Root worked solo (owner instruction of 2026-10-22).

## What S6 delivers

- The two mixed-proof S4 TODOs run as ordinary tests: a tested `code` predicate coexists with an unknown `date` predicate under the `declared_and_self_link_only` kind, with per-constraint executions preserved and completeness withheld (consensus text, `proposals/audit/gpt-s58-consensus-position.md`).
- The trusted sort proof in the validation context: the disclosed `sort.order`/`effective` are bound to the chain's current evidence on full and shorthand pages (S5 review finding 2d closed).
- `synthetic-fixture-r4-v1` is qualified: evidence recorded from a private labelled run in both eras (18/18 controls per era, no public failures), eligibility and the derived config enum follow, and the ordinary public selection passes the six profile tasks in both eras with no override. `hapi-r4-labs-v1` stays ineligible.
- Proved continuations (`offset-next-link`, numeric-offset URL whose offset equals the previous page's offset plus returned entries, self link matching the query and carrying exactly that offset) keep the chain's evidence kind; a drained proved chain is `complete_for_query`. Any other continuation makes the chain stickily `unverified_continuation` (gate-bound through the trusted context); generic and opaque continuations keep N-06.
- The evidence chain is bound: fixture, backend and task-corpus digests (drift test; the eval runner refuses a stale profile) and the capability revision (`profileMatchesSource`, fail closed; load-time registry invariant; `--doctor` reports the gateway's own proving status).
- Zero `pending_profile_proof` rows in either era; the pending machinery remains the rollback path (`simulateIneligibleProfile`, tests only).
- Independent review (Opus, 2026-10-22): two High findings in the first cut's continuation labelling (offset arithmetic trusted; label not sticky) and ten lower ones, all applied; the profile was re-qualified afterwards (21/21 controls per era). Dispositions: `proposals/m3b-s6-design.md` §4.1.
- Project review (GPT-6-Astra, 2026-10-22, `proposals/audit/gpt-astra-project-review-2026-10-22.md`): its one confirmed defect, sub-millisecond fractional seconds truncated to the millisecond (distinct instants compared equal; an ascending pair passed the descending check), is fixed here: such values are undecidable for equality, unproved as a date variant and unverifiable for order (three mutants, pinned vectors).

## Verification

| Check | Result | Where |
| --- | --- | --- |
| Unit test files touched by S6 (gate, matrix, chains, losses, S4 state, evidence, identity, evals, migration, release, anchors) | all passing in the s6 worktree | root runs, Node 24.22.0 |
| `npm run check` on the rebased tree (S5b + S6 on `r/s5-candidate`) | typecheck clean; 1,935 node tests: 1,935 pass, 0 fail, 0 TODO (the two S6 TODOs are now real tests); build with the compiled-identity check | root runs, Node 24.22.0, macOS arm64 |
| Retrieval evals, both eras (CLI) | per era 77/77 tasks per arm, 0 `pending_profile_proof`, 0 fail; 231/231 comparable checks per arm (1 incomparable by design); 0 byte-accounting deviations | `packages/evals/src/cli.ts` |
| `npm run test:isolation` | 76/76 (68 diagnostic cases, 0 counted toward B2) | |
| `npm run demo` | completes on synthetic data | |
| Contract `--check` | in sync (no listing change) | |
| `--only` evidence for the twenty S6 mutants | 20/20 killed with named, reproduced failures (full 1,923-test and focused runs; 0 timeouts; anchors exact-once); raw report in the gitignored `.local/s6-only/report.json` | A2 rows in `proposals/audit/a2-anchor-migration.tsv` |
| 14-shard mutation aggregate on the merged commit `5c59cdd` | **passed**: 509 killed, 2 declared survivors, 0 inconclusive, 0 anchor errors, 0 timeout-only kills, 511/511 (shard 14 re-run alone after the driver stopped mid-shard) | record |
| Independent review pass | Opus adversarial pass on the S6 diff; findings and dispositions in `proposals/m3b-s6-design.md` §4.1; all High findings fixed and re-qualified | `proposals/m3b-s6-design.md` |

## Accepted debts carried forward

- Discovery does not surface `execution_evidence` for the qualified profile (S7 documents it as `unknown`).
- `overlay.sortProof` stays as an informational overlay field; the trusted proof is the validation context's `sortProof`.
- HAPI/Medplum profiles need an out-of-gateway identity capture before any qualification (later slice; never claimed).
- The qualification report hash commits to the raw reports kept locally (`.local/s6-qualification/`); the reproducible anchors are the fixture, backend, task-corpus and capability-revision digests.
