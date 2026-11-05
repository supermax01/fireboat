# M3b S5: status and evidence

- **Date:** 2026-10-22.
- **Contract:** [PLAN.md](../PLAN.md) revision 0.4.1 and [proposals/m3b-spec.md](../proposals/m3b-spec.md) with Addenda A–C; release path in [proposals/release-plan.md](../proposals/release-plan.md).
- **Scope:** the synthetic-only, local stdio, single-trusted-patient, read-only gateway; five tools; the sole v2 (schema 0.2) serving path.
- **Status:** S5 checkpoint, **locally verified; CI-deferred** (owner instruction of 2026-10-21: one CI run on the frozen release candidate). This page replaces [M3A-STATUS](M3A-STATUS.md) as the current status; M3A-STATUS is historical.

## What S5 delivered

| Slice | Content | Commit |
| --- | --- | --- |
| S5.1–S5.6 | Strict 0.2 gate, v2 constructors and admission, coverage and repairs, projection and retained views, discovery and support stores, delivery and accounting pipeline (inert until S5.7) | on `r/s5-candidate` |
| S5.7 + fix round | The sole v2 serving path; migrated evals and examples; meta supplement, shared ledger on page load, trusted proof in the gate | `c792a94`, `0d19c07`, `83f482f` |
| S5.8a | v2 tool listing, release identity `0.2.0-alpha.1` from one source, regenerated contract, round-7 spec text, configured byte floor 8,192 B | `f6d19c0` |
| S5.8b-ci | `catalog-tokens` CI job (pinned image, hash-locked tokenizer wheels, offline reference run, negative control), isolation in the unit job | `be7b521` |
| S5.8b-registry | Mutation registry migration (474 mutants at the time, 491 exact-once edits, 17 compounds, 28 isolation declarations), hardened judge, anchor test, discriminators | `d79a71d`, `7b5e059` |
| S5 review fixes | Independent review of the three unreviewed commits; the fixes below | `6483a92`, `c1a9d68`, the checkpoint commit |

## Verification at the checkpoint

Root-run on Node 24.22.0, macOS arm64, 12 CPUs. The figures below are for the checkpoint commit named in the git log; earlier figures stay with their commits.

| Check | Result |
| --- | --- |
| `npm run check` | typecheck, Node test suite (1,898 tests: 1,896 pass, 2 S6 TODO, 0 fail), build with the compiled-identity check |
| `npm run test:isolation` | 76/76 (68 diagnostic cases; 0 count toward the ≥200-case B2 gate) |
| Retrieval evals, both eras | 207 pass / 15 `pending_profile_proof` / 0 fail per era; 215/221 comparable checks per arm; 0/291 byte-accounting deviations; byte accounting is an exit gate |
| Contract `--check` | in sync |
| Demo and the negative control | pass |
| Official 14-shard mutation aggregate | Passed at `7b5e059` (472 killed, 2 declared survivors, 0 inconclusive, 0 anchor errors, 0 timeout-only kills; record). The re-run on the checkpoint commit `750c611`, after the four gate mutants, also passed (476 killed, 2 declared survivors, 0 inconclusive, 0 anchor errors, 0 timeout-only kills; record). |
| Catalog byte caps | complete 8,399/8,450 B; tools 8,093/8,100 B; `fhir_search` 1,750/1,750 and `fhir_page` 1,100/1,100 exactly at cap; instructions 158/160 |
| Catalog token caps | exploratory only (macOS, tiktoken 0.12.0, o200k worst): complete 2,096/2,500, `fhir_search` 441/500; the pinned container measurement is **unexecuted** (summary) |

## Independent review of the S5.7 fix round, S5.8a and S5.8b-ci (2026-10-22)

Five review passes on the frozen tree `b70e73f`: four Sonnet readers by area and one Opus adversarial pass on the runtime changes (probes, scratch mutants, a store model check), each verified by root. Decisions and the gate before/after table are in root-s5-review-gate-decisions.md.

| Area | Finding | Disposition |
| --- | --- | --- |
| Page load (high) | Two concurrent `fhir_page` calls on one unloaded cursor could skip an upstream page and permanently re-point the cursor (introduced in S2) | Fixed: loaded-cursor re-check after the metadata await, compare-and-set in the load flight; deterministic two-waiter test in both eras |
| Gate (medium) | The trusted proof bound per-constraint executions only when a constraint list was disclosed; an empty material set could be relabelled complete, a shorthand page could claim `tested_adapter` or `exact_id`, and the unverified-filter caveat could be dropped | Fixed: five trusted-proof rules; three registry mutants; real-gateway forgery tests in both eras. Sort-proof binding deferred to S6 (debt below) |
| Gate test | "changed constraint order" reversed executions too, so the order rule was unpinned and an order-insensitive gate survived every test | Fixed in `c1a9d68`: name/value-only swap, exact-reason test, `crossfield02-constraint-order-insensitive` registered |
| Projection | Malformed non-array `meta.tag` array-wrapped with a spurious omission; selecting into a contained resource delivered partial contained `meta` | Both fixed with pinned tests |
| Retention | A refused best-effort `res_` admission left futile evictions behind (a pinned result expired for nothing) | Fixed: ledger checkpoint and restore on `RETENTION_LIMIT`; pinned test |
| Gate test labels | One `m3b-strict-gate` label implied a cross-field rule that does not exist | Labels and a comment name the rejecting layer |
| Evidence | The S5.7 gate before/after tables lived only in `/tmp` | Compact extract committed under `proposals/audit/s5-mutants/s5.7-fix-round/` |
| Evaluator | Byte-accounting deviations not gated; `equals: null` matched absent fields; no zero-clinical-request oracle; only five tasks content-pinned; `warning_codes` declared not observed | All fixed in `6483a92` |
| CI | The capture's "no upstream work" control stubbed `fetch`, which the transport never uses | Fixed in `c1a9d68`: counting loopback sink; capture bound to the commit and the listing pins; isolation report uploaded; no persisted credentials in the bind-mounted workspace; store/identity consistency |
| Build, docs | No test of the compiled CLI identity; stale export list, help block, isolation status, 44-task counts, missing round-7 applied record | Fixed in `6483a92` |

Accepted debts, recorded rather than fixed now:

- **Sort proof is not in the validation context**: a forged `verified_by_adapter` sort with an invented effective order passes the gate. S6 reworks sort proof and adds trusted sort order/effective to the context (`ValidationContext02.query`).
- `limitReached` in `packages/core/src/index.ts` is written but no longer read; a registry mutant anchors that line, so its removal is a registry change for a later slice.
- A shared-flight joiner refused with `UPSTREAM_LIMIT` reports `retryable: false` although its own meter was untouched (root's S5.7 decision stands; revisit with S5b).
- The pending-proof query tasks and their generic-only honesty oracle: resolved by S6 (`candidate/s6`, `proposals/m3b-s6-design.md`, `docs/S6-STATUS.md`); the synthetic profile is qualified and `query-cross-page-sort-generic` joins the existing generic oracles.
- Rule C of the v2 cross-field gate is implied by the surrounding rules; it stays as defence in depth, covered only by the compound mutant `full-trusted-proof-check-removed`.
- Hosted runner timing for the mutation shards and the unit job is unmeasured; the release-candidate workflow measures it before relying on the 25- and 15-minute timeouts.
- The cancellation eviction witness (pre-write render guard, `index.ts` renderV2) remains documented assurance debt from S5.8b-registry.
- The slim-text withheld-line aggregator that merged metadata-free attachment entries by shape is gone: S5b (`candidate/s5b`) replaced it with the origin-classified collapse (`proposals/m3b-s5b-design.md`), one line per delivered entry and `withheld xN:` for counted entries.

## CI-deferred (runs once on the frozen release candidate)

The pinned Linux container token measurement; live HAPI and Medplum in Docker; the Node 24.21.0 and 26.10.0 cells; the Linux mutation shards; the `catalog-tokens` negative control.

## Not claimed

No CI run on any S5 commit; no container token measurement; no live-backend run on the S5 tree; no B2 acceptance (68 diagnostic cases, 0 counted); S5b and S6 are implemented and verified ([S5b record](../proposals/m3b-s5b-design.md), [S6 status](S6-STATUS.md)); S7, packaging and the rename are pending; no SMART, host, vendor, clinical, production or protocol-compatibility readiness; no release or publication of any kind.
