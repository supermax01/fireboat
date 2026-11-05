# B2 isolation suite: status

- **Slice:** B2-0 counting machinery, against [the agreed design](../proposals/b2-isolation-suite-design.md) and PLAN revision 0.4.1.
- **Implementation:** B2-0 on `candidate/b2`, rebased onto `r/s5-candidate` (S5b + S6). Written in two rounds, each independently reviewed, re-run and committed after review.
- **Scope:** 68 executable diagnostic cases; **0 of 216 design cases counted**. B2-1 supplies counted per-case evidence. This is not B2 acceptance, a qualifying installed-package run, clinical readiness or a production release.
- **Evidence boundary:** local consistency and freshness checks; no authentication claim against an operator who can rewrite artifacts and source.

## Implemented machinery

| Area | Current behavior |
| --- | --- |
| Design ledger | 287 records: 216 counted design obligations, 29 non-counted, 42 aliases, 61 first-slice IDs. Every identity/class/alias/first-slice flag is compared with the design extractor, not only the totals or digest. |
| Loader | Exact executable controls/assertions/eras; authored intent/twin tokens; changed production anchors; TypeScript-parsed case-owned oracles; distinct canonical mutant edits and discriminating family/body/anchor spares. |
| Coverage | Frozen 18,900-tuple universe; 60 listed cells and four reviewed covers. N/A rules need two constrained axes, at most 1,000 matching tuples, and per-rule/reviewer counts. The unlisted obligations remain incomplete. |
| Runner | Stack-owned stream capture and fixture clocks, registered half-open teardown, cancellation checks, LIFO child cleanup, pre-close and post-stub/teardown scans, non-throwing prohibited checks, and protected observable-work repeat digests. Stub replays remain outside budget counts. |
| Reports | Strict cell/case schemas; verdicts, eras, controls, stub kinds, capture hashes, counts/budgets and repeat agreement checked against the manifest. Standing and aggregation use the same validation. |
| Bindings/build | Fresh random attempt per entry run; start/end candidate/build/pin/environment/dependency bindings; emitted-tree attestation; shard case digests; source assets and tsconfig-chain coverage. |
| Kill evidence | 24 seeded matrix rows / 42 declared kills, three excluded runtime mutants. Credit derives from exact anchors, compiled-mutant evidence, passing baseline, all designated six-cell oracle failures and passing spares. Historical six-row kills are not re-credited from summaries. |
| Budget provenance | Current DIAGNOSTIC report, verified pins/build, six valid distinct cells, complete captures/controls/stubs, exact maxima and report-owned binding digest. |
| Gate | Every counted case earned, no counted known failure, no unproven budget, every manifested case PASS, all prior conjuncts, and scenario-level cross-patient prohibited predicates. |
| Machinery proof | 99 genuine weakening mutants in both unit and isolation suites, all registered in `verifier_challenges`; exact anchors and named observing tests below. |

## Reviews

| Round | Review | Disposition record |
| --- | --- | --- |
| 1 | Adversarial review of `f701071` | table below |
| 2 | Re-verification of the round-1 fixes (N1–N14) and a second independent review (A-H1…A-L3) | internal review record |

Root decisions for round 2: the evidence boundary above (consistency, freshness and derivation from recorded execution; no authentication against a writer of `artifacts/` and the source); every finding of both reviews fixed except the deliberate one below; the remaining Low limits accepted, with B2-0 review closed after round 2 (time-boxed: further effort goes to B2-1 and to user-facing evidence).

### Round 1 dispositions (Opus adversarial pass on f701071)

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| H1 | High | The gate passed while counted cases failed on mutation, sink or confinement oracles: two literal predicates only, blocking cases not a conjunct. | **Fixed:** `no_blocking_counted_cases` conjunct; `PROHIBITED_PREDICATES` registry (disclosure, foreign selector, confinement, clinical mutation, sink) over every cell of every case, with a test that each entry is a literal check predicate; mutants `b2m-prohibited-classes-narrowed`, `b2m-blocking-conjunct-dropped`. |
| H2 | High | Case verdicts were not bound to the candidate the kills were bound to; kill files were trusted; `B2_SKIP_BUILD` qualified. | **Fixed:** start/end run bindings in every shard and the prerequisites, recomputed and compared by the aggregator; `readKills` checks run id, six cells, candidate digest and every record; `B2_SKIP_BUILD` is a non-qualifying reason; mutants `b2m-shard-binding-unchecked`, `b2m-prerequisites-binding-unchecked`, `b2m-kills-lanes-unchecked`, `b2m-kills-run-unbound`, `b2m-skip-build-qualifies`. |
| M1 | Medium | The watchdog abandoned the body, which kept writing into the returned report (INCONCLUSIVE could become FAIL after return). | **Fixed:** private body result, deadline copy published, all drivers closed, the body settled before the next cell; two tests (held control, held stub replay) assert the report is final at return and stable afterwards; mutant `b2m-watchdog-late-writes`. |
| M2 | Medium | Channel coverage was self-declared; a zero-cell PASS report or an empty critical set could earn. | **Fixed:** `cellCoverageProblem` against the manifest lane in `validateAggregate` (`cell-coverage`) and in the standing (`counted_incomplete`); six cells and a PASS CLI view required; an empty critical set never earns; mutant `b2m-coverage-self-declared`. |
| M3 | Medium | `kill-indistinct` compared cases only within one scenario body. | **Fixed:** no shared critical sets across counted records, plus the discriminating-row rule with body and anchor siblings as spares; mutant `b2m-discriminating-row-unchecked`. |
| M4 | Medium | Templated intents and oracles were exact strings or substrings. | **Fixed:** token comparison for intents and twins; an exact oracle registry; mutants `b2m-fault-tokens-unnormalized`, `b2m-oracle-substring`. |
| M5 | Medium | Anchors: cross-file mutant edits, non-production files and overlapping matches were accepted. | **Fixed:** same-file edit required, shipped-runtime paths only, overlap-safe counting; mutants `b2m-anchor-cross-file`, `b2m-anchor-nonproduction`. |
| M6 | Medium | Budget provenance was claimed, never checked. | **Fixed:** `verifyBudgetProvenance` in the aggregator, `counted_unproven_budget` standing; mutant `b2m-budget-provenance-unverified`. |
| M7 | Medium | Kill-matrix rows were schema-checked only unless a case was counted. | **Fixed:** every row and the challenges validated at load (six new codes); mutant `b2m-kill-rows-unvalidated`. |
| M8 | Medium | An empty selection aggregated; a subset run was refused for empty shards; unknown ids were dropped. | **Fixed:** `selection-empty`, `selection-unknown`, a set selection variable is always a selection, unselected families write no shard; mutant `b2m-empty-selection-accepted`. |
| M9 | Medium | `b2m-ledger-alias-counted` was killed only through an import crash. | **Fixed:** the counting tests build the semantic context lazily, so the ledger test fails by name; the mutant now fails every test that loads the real ledger, which is the behaviour it weakens (it is no longer described as a single-test kill); `counts.aliases` is also checked field by field in the declared block. |
| M10 | Medium | Ledger gaps: disguised aliases, alias of a B3 record, missing family keys, swapped id/family, `first_slice` compared with itself, `design_sha256` unverified. | **Fixed:** `ledger-alias-shape`, `ledger-family`, alias targets must be counted, families keys equal the counted families, field-by-field counts, design digest verified; mutant `b2m-ledger-shape-unchecked`. |
| L1 | Low | Undefined digest made kills without a digest count. | **Fixed:** every kill count requires a defined, equal digest. |
| L2 | Low | `frozen-class`, `count-inflation`, `signature-collision` unreachable. | **Fixed:** the first two removed (carried by `ledger-mismatch`); `signature-collision` now precedes the contract check and is tested. |
| L3 | Low | A stale known failure was silent. | **Fixed:** listed in the aggregate problems; mutant `b2m-stale-known-failure-silent`. |
| L4 | Low | The aggregate pinned less than the dead `writeReport`. | **Fixed:** lock, installed tree, SDK, OS and per-file hashes in the report; `writeReport` deleted. |
| L5 | Low | Pins concatenated without separators; prerequisites, counting and shard files unpinned; shards recorded no pins. | **Fixed:** separator-safe digests, those files pinned, pins in every binding. |
| L6 | Low | node:test could time out before the watchdog decided. | **Fixed:** per-case timeout `6 × (deadline_ms + 15 s) + 30 s`. The registry judge treats an INCONCLUSIVE case as a named failure of its case test; D10 holds in the report and in `mutants.mjs`. |
| L7 | Low | The counting tests failed under the focused-debugging variables. | **Fixed:** the file clears them on load. |
| L8 | Low | A scenario's secondary gateway escaped the tool-call and byte budgets. | **Fixed:** the driver registry counts and closes every driver of the cell; the fingerprint covers them; mutant `b2m-secondary-driver-uncounted`. Their outputs are not scanned for B markers: that gateway is bound to B by design. |
| L9 | Low | The coverage matrix was a sparse list. | **Fixed:** reviewed N/A rules and the full cross product; `matrix_complete` conjunct; mutant `b2m-matrix-complete-ignored`. |
| L10 | Low | Stale documentation and uncoded aggregate errors; a slow build could lose its lock. | **Fixed:** `INTEGRATION.txt`, comment references and this record corrected; `validateAggregate` codes; the lock heartbeat. |

The round-1 table is kept as written; round 2 replaced several of those mechanisms (see the round-two record).

## Root verification of round 2 (Node 24.22.0, macOS arm64, 12 CPUs, 2026-10-23)

| Check | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `tests/isolation/counting.test.ts` | 62 of 62 (62 declared) |
| `tests/mutation-anchors.test.ts` | every registered anchor exact-once (610 entries: 511 + 99 machinery) |
| Manifest pins | `verifyPins` empty |
| `npm run test:isolation` (`b2-0-round2-root`) | 138 of 138 node tests (4 prerequisites, 62 counting, 4 oracles, 68 cases, every case by name); aggregate DIAGNOSTIC, earned 0, 68 cases; tests and aggregate exit 0 |
| `npm run check` | 1,935 of 1,935, 0 TODO; build with the compiled-identity check |
| Machinery mutants | Implementer self-check: 99 of 99 killed with named observing tests; root spot-check of 18 (the replaced or redefined ones and a sample of the new ones): 18 of 18 killed, each by the test its `machinery-witnesses.json` entry names (the redefined `b2m-aggregate-missing-shard` and `b2m-empty-selection-accepted` by the admission-witness test, not an alternate refusal); every anchor exact-once, every mutant typechecks |
| Official 14-shard mutation aggregate on `cffddc7` (2026-10-23T18:55Z to 2026-10-24T00:13Z) | 608 killed, 2 declared survivors, 0 inconclusive, 0 anchor errors, 0 timeout-only kills, 610 of 610 mutants each judged exactly once (unit suite first, then isolation, for every mutant); record `proposals/audit/s5-mutants/s5.8b-registry/official-aggregate-cffddc7.md` |

Accepted trade-offs recorded by the root:

- **SDK lanes and version negotiation.** The installed SDK negotiates the modern era on a disposable sibling process for its stock stdio transport and in place for a subclass. The SDK lanes now use a subclass, so the negotiation exchange is captured and scanned; they no longer exercise the stock sibling path, which the planned outside-host smoke test covers.
- **TypeScript 7 native API.** The build stamp and the oracle registry use `typescript/unstable/sync`, the only programmatic API of the installed TypeScript 7.0.2, pinned by the lockfile; a TypeScript upgrade must re-run these tests.
- **Judge cost.** The judge runs the unit suite before the isolation suite for every mutant (S5.8b rule: unit is mandatory). With 99 machinery mutants an official 14-shard aggregate takes roughly twice as long as before; the rule is kept.
- **Seeded row oracle.** `outbound-confinement-dropped` fails on `request:caller bound pair plus independently appended trusted pair`, not on the frozen row's `output_structured:b2.sel-01.terminal`; the reader credits nothing. B2-1 authors and reviews executable per-case oracles before anything counts.

The round-two record maps every N1–N14 and A-prefixed finding to changed files, probes and dispositions, and explains the corrected machinery mutants and implementation choices.

## Implementer verification (round 2)

The acceptance commands below use Node 24.22.0. The final diagnostic run is labelled `astra-b2-r2-final-20261023`; `B2_CORE_ONLY`, `B2_CASE_IDS`, `B2_SKIP_BUILD`, `B2_QUALIFY` and `B2_ATTEMPT_ID` are unset. `run.mjs` generates its attempt ID. The hashes-only generator is the last worktree edit, before these commands.

| Command | Result |
| --- | --- |
| `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | Exit 0, no diagnostics |
| `node --import tsx --test --test-reporter=tap tests/isolation/counting.test.ts` | 62 declarations, 62 tests, 62 pass, 0 fail |
| `node --import tsx --test --test-reporter=tap tests/mutation-anchors.test.ts` | 1 test, 1 pass, 0 fail |
| `node tests/isolation/run.mjs` | Tests exit 0, aggregate exit 0, all 68 cases reported by name and PASS |

Exact counting summary:

```text
# tests 62
# pass 62
# fail 0
```

Exact anchor summary:

```text
# tests 1
# pass 1
# fail 0
```

Exact aggregate/run lines:

```text
# B2 AGGREGATE run=astra-b2-r2-final-20261023 status=DIAGNOSTIC earned=0 cases=68 families={"ADM":{"PASS":1},"BAS":{"PASS":1},"CLS":{"PASS":7},"CNT":{"PASS":7},"CUR":{"PASS":5},"DIR":{"PASS":1},"ERR":{"PASS":4},"HND":{"PASS":2},"HPP":{"PASS":2},"INJ":{"PASS":2},"LOG":{"PASS":2},"MET":{"PASS":2},"NUM":{"PASS":3},"OUT":{"PASS":1},"PAY":{"PASS":1},"PTH":{"PASS":7},"REF":{"PASS":3},"SEL":{"PASS":13},"SHR":{"PASS":3},"XRF":{"PASS":1}}
# B2 RUN astra-b2-r2-final-20261023: tests exit 0, aggregate exit 0
```

The report is `artifacts/b2/astra-b2-r2-final-20261023/report.json`. All 68 named case results and their six cells are recorded there. This is a diagnostic run: earned remains zero and the B2 acceptance gate remains false.

## Machinery mutants and their observing tests

Final supplied self-check: `DONE 99 mutants; survivors or unjudged: none`. The named observing test fails on the intended wrong admission, credit, capture or teardown; pins and incidental failures are not used as the witness.

| Mutant | Anchor matches | tsc exit | Tests pass/fail | Observing counting test |
| --- | --- | --- | --- | --- |
| `b2m-aggregate-missing-shard` | 1 | 0 | 60/2 | aggregate admission witnesses: complete empty selection and an unselected empty shard are refused |
| `b2m-alias-chain-unchecked` | 1 | 0 | 61/1 | ledger: counts, families, alias shape and targets, recycled ids, the design digest and inflated counts are rejected |
| `b2m-anchor-cross-file` | 1 | 0 | 61/1 | a counted record needs a one-match shipped-runtime anchor that a killing mutant edits in the same file |
| `b2m-anchor-multi-match` | 1 | 0 | 61/1 | a counted record needs a one-match shipped-runtime anchor that a killing mutant edits in the same file |
| `b2m-anchor-nonproduction` | 1/1/1 | 0 | 60/2 | nonproduction anchor admission witness: exact matching edits in an eval fixture are still not runtime decisions |
| `b2m-anchor-siblings-unchecked` | 1 | 0 | 61/1 | loader independence: identical edit sets, family spares and overlapping or shared-window anchors are refused |
| `b2m-anchor-unchanged` | 1 | 0 | 61/1 | anchor edit evidence: a preserved anchor or an unchanged anchor span is not an edited decision |
| `b2m-assertions-unknown` | 1 | 0 | 61/1 | executable contracts: exactly one control, exact assertion and challenge ids, known expected assertions and two eras |
| `b2m-attempt-unbound` | 1 | 0 | 61/1 | attempt provenance: missing attempts and copying old evidence into a relabelled run are refused |
| `b2m-blocking-conjunct-dropped` | 1/1/1 | 0 | 60/2 | gate admission witnesses: 200 greens cannot conceal a counted annotation, unproven budget or failing manifest case |
| `b2m-budget-post-stub` | 1 | 0 | 59/3 | budget enforcement: the exact measured ceiling passes, one below fails under the named predicate, and stub replays never count |
| `b2m-budget-provenance-skipped` | 1 | 0 | 61/1 | budgets must carry measured provenance and equal exact-max/1 within the shipped limits |
| `b2m-budget-provenance-unverified` | 1 | 0 | 61/1 | budget provenance names a real full run report with that digest whose per-cell maxima equal the declared measurements |
| `b2m-build-assets-ignored` | 1 | 0 | 61/1 | build attestation: JSON assets, inherited config and emitted bytes describe the executable |
| `b2m-build-config-chain-ignored` | 1 | 0 | 61/1 | build attestation: JSON assets, inherited config and emitted bytes describe the executable |
| `b2m-build-output-unchecked` | 1 | 0 | 61/1 | build attestation: JSON assets, inherited config and emitted bytes describe the executable |
| `b2m-build-unverified-admitted` | 1 | 0 | 61/1 | build evidence admission witness: an unverified executable cannot supply otherwise complete shard evidence |
| `b2m-capture-hash-invalid` | 1 | 0 | 61/1 | cell evidence: strict shapes, eras, passing facts, stub identities, budgets and repeat agreement are derived |
| `b2m-capture-stack-unwound` | 1 | 0 | 61/1 | capture stack: closing a live older frame preserves the newer capture and original functions |
| `b2m-capture-version-ignored` | 1 | 0 | 61/1 | disclosure scans: stub replay, destructive deadline close and teardown cannot erase a marker |
| `b2m-case-repeat-unchecked` | 1 | 0 | 60/2 | cell evidence: strict shapes, eras, passing facts, stub identities, budgets and repeat agreement are derived |
| `b2m-case-verdict-trusted` | 1 | 0 | 61/1 | cell evidence: strict shapes, eras, passing facts, stub identities, budgets and repeat agreement are derived |
| `b2m-cell-budget-unchecked` | 1 | 0 | 60/2 | cell evidence: strict shapes, eras, passing facts, stub identities, budgets and repeat agreement are derived |
| `b2m-cell-counts-unchecked` | 1 | 0 | 61/1 | cell evidence: strict shapes, eras, passing facts, stub identities, budgets and repeat agreement are derived |
| `b2m-cell-era-unchecked` | 1 | 0 | 58/4 | cell evidence: strict shapes, eras, passing facts, stub identities, budgets and repeat agreement are derived |
| `b2m-cell-pass-failures` | 1 | 0 | 61/1 | cell evidence: strict shapes, eras, passing facts, stub identities, budgets and repeat agreement are derived |
| `b2m-cell-repeat-digest-unchecked` | 1 | 0 | 61/1 | cell evidence: strict shapes, eras, passing facts, stub identities, budgets and repeat agreement are derived |
| `b2m-channel-scan-short-circuited` | 1 | 0 | 61/1 | channel scan isolation: an unreadable audit cannot mask a forbidden marker in state |
| `b2m-child-reference-forgotten` | 1 | 0 | 61/1 | child ownership: failed SDK startup reaps its child even after SDK bookkeeping is cleared |
| `b2m-cli-verdict-trusted` | 1 | 0 | 60/2 | cell evidence: strict shapes, eras, passing facts, stub identities, budgets and repeat agreement are derived |
| `b2m-control-contract-unchecked` | 1 | 0 | 61/1 | executable contracts: exactly one control, exact assertion and challenge ids, known expected assertions and two eras |
| `b2m-count-condition-dropped` | 1 | 0 | 61/1 | count condition: classification, boundary, applicability, required controls and a present mutant_intent reject a counted record |
| `b2m-coverage-self-declared` | 1 | 0 | 59/3 | cell evidence: strict shapes, eras, passing facts, stub identities, budgets and repeat agreement are derived |
| `b2m-dependency-binding-unchecked` | 1 | 0 | 61/1 | shard content and dependency bindings: changed reports or installed input hashes cannot reuse evidence |
| `b2m-discriminating-row-unchecked` | 1 | 0 | 60/2 | loader independence: identical edit sets, family spares and overlapping or shared-window anchors are refused |
| `b2m-earned-counts-inconclusive` | 1 | 0 | 60/2 | computeStanding: earned needs counted PASS in six covered cells, no known failure, proven budgets, a non-empty critical set and bound kills |
| `b2m-earned-ignores-qualifying` | 1 | 0 | 61/1 | computeStanding: earned needs counted PASS in six covered cells, no known failure, proven budgets, a non-empty critical set and bound kills |
| `b2m-empty-selection-accepted` | 1/1 | 0 | 60/2 | aggregate admission witnesses: complete empty selection and an unselected empty shard are refused |
| `b2m-eras-duplicated` | 1/1 | 0 | 61/1 | executable contracts: exactly one control, exact assertion and challenge ids, known expected assertions and two eras |
| `b2m-excluded-survivor-admitted` | 1 | 0 | 60/2 | kill matrix rows are validated at load whether or not a case is counted: mutants, case ids, oracles, duplicates and challenges |
| `b2m-extra-control-unexecuted` | 1/1 | 0 | 61/1 | executable contracts: exactly one control, exact assertion and challenge ids, known expected assertions and two eras |
| `b2m-family-spares-unchecked` | 1 | 0 | 61/1 | loader independence: identical edit sets, family spares and overlapping or shared-window anchors are refused |
| `b2m-fault-tokens-unnormalized` | 1 | 0 | 59/3 | templated fault intents are rejected after punctuation and spacing are normalized: decision, goal, Bypass <decision>, the case id, short text and a duplicate |
| `b2m-gate-known-failure-admitted` | 1/1 | 0 | 60/2 | gate admission witnesses: 200 greens cannot conceal a counted annotation, unproven budget or failing manifest case |
| `b2m-gate-matrix-conjunct-dropped` | 1 | 0 | 59/3 | gate matrix admission witnesses: an uncovered cell or an unlisted tuple blocks an otherwise passing gate |
| `b2m-gate-noncounted-failure-admitted` | 1 | 0 | 61/1 | gate admission witnesses: 200 greens cannot conceal a counted annotation, unproven budget or failing manifest case |
| `b2m-gate-unproven-budget-admitted` | 1/1 | 0 | 60/2 | gate admission witnesses: 200 greens cannot conceal a counted annotation, unproven budget or failing manifest case |
| `b2m-half-open-driver-unregistered` | 1/1 | 0 | 61/1 | startup deadline: a silent SDK initialize is inconclusive, reaps its child, restores captures, and cannot blind the next cell |
| `b2m-identical-edits-independent` | 1 | 0 | 61/1 | loader independence: identical edit sets, family spares and overlapping or shared-window anchors are refused |
| `b2m-intent-nonascii-admitted` | 1 | 0 | 61/1 | authored content: novel tokens, ASCII letters, stopword duplicates and tokenized transitions are enforced |
| `b2m-intent-novelty-weakened` | 1 | 0 | 61/1 | authored content: novel tokens, ASCII letters, stopword duplicates and tokenized transitions are enforced |
| `b2m-intent-stopword-duplicates` | 1 | 0 | 61/1 | authored content: novel tokens, ASCII letters, stopword duplicates and tokenized transitions are enforced |
| `b2m-kill-anchors-unchecked` | 1 | 0 | 61/1 | kill row evidence: summaries, contradictory rows, anchors, compilation, baseline, oracle and spares cannot earn credit |
| `b2m-kill-baseline-unchecked` | 1 | 0 | 61/1 | kill row evidence: summaries, contradictory rows, anchors, compilation, baseline, oracle and spares cannot earn credit |
| `b2m-kill-compile-unchecked` | 1 | 0 | 61/1 | kill row evidence: summaries, contradictory rows, anchors, compilation, baseline, oracle and spares cannot earn credit |
| `b2m-kill-oracle-unchecked` | 1 | 0 | 61/1 | kill row evidence: summaries, contradictory rows, anchors, compilation, baseline, oracle and spares cannot earn credit |
| `b2m-kill-ref-unchecked` | 1 | 0 | 61/1 | kill matrix: counted records bind to the rows that kill them, and each needs a discriminating row |
| `b2m-kill-rows-unvalidated` | 1/1 | 0 | 61/1 | kill matrix rows are validated at load whether or not a case is counted: mutants, case ids, oracles, duplicates and challenges |
| `b2m-kill-spares-unchecked` | 1 | 0 | 61/1 | kill row evidence: summaries, contradictory rows, anchors, compilation, baseline, oracle and spares cannot earn credit |
| `b2m-kill-summary-trusted` | 1 | 0 | 61/1 | kill row evidence: summaries, contradictory rows, anchors, compilation, baseline, oracle and spares cannot earn credit |
| `b2m-kills-lanes-unchecked` | 1 | 0 | 61/1 | kill evidence is credited only from this run, a full six-cell run, and the same candidate digest as every record |
| `b2m-kills-run-unbound` | 1 | 0 | 61/1 | kill evidence is credited only from this run, a full six-cell run, and the same candidate digest as every record |
| `b2m-ledger-declared-counts-unchecked` | 1 | 0 | 61/1 | ledger: counts, families, alias shape and targets, recycled ids, the design digest and inflated counts are rejected |
| `b2m-ledger-design-unchecked` | 1 | 0 | 61/1 | design ledger identity: swapping counted and B3 labels or moving first-slice flags is refused |
| `b2m-ledger-shape-unchecked` | 1 | 0 | 61/1 | ledger: counts, families, alias shape and targets, recycled ids, the design digest and inflated counts are rejected |
| `b2m-malformed-json-admitted` | 1 | 0 | 60/2 | parser admission witnesses: malformed JSON and invalid shapes are never returned as validated data |
| `b2m-malformed-shape-admitted` | 1 | 0 | 59/3 | parser admission witnesses: malformed JSON and invalid shapes are never returned as validated data |
| `b2m-matrix-alias-cover` | 1 | 0 | 61/1 | coverage matrix: duplicate ids, repeated tuples, unknown axes, alias cover, missing subjects, N/A rules and the full cross product |
| `b2m-matrix-complete-ignored` | 1 | 0 | 60/2 | gate matrix admission witnesses: an uncovered cell or an unlisted tuple blocks an otherwise passing gate |
| `b2m-matrix-universe-shrunk` | 1 | 0 | 61/1 | coverage universe: deleting axes and overly broad N/A rules cannot erase obligations |
| `b2m-na-single-axis` | 1 | 0 | 61/1 | coverage universe: deleting axes and overly broad N/A rules cannot erase obligations |
| `b2m-na-unbounded` | 1 | 0 | 61/1 | coverage universe: deleting axes and overly broad N/A rules cannot erase obligations |
| `b2m-oracle-case-unbound` | 1 | 0 | 61/1 | oracle syntax and ownership: parse literal calls and evidence, ignore comments and variables, accept spaces and scanner hits |
| `b2m-oracle-late-arguments` | 1 | 0 | 61/1 | oracle syntax and ownership: parse literal calls and evidence, ignore comments and variables, accept spaces and scanner hits |
| `b2m-oracle-substring` | 1/1 | 0 | 60/2 | kill matrix rows are validated at load whether or not a case is counted: mutants, case ids, oracles, duplicates and challenges |
| `b2m-outer-skip-build-ignored` | 1 | 0 | 61/1 | outer skip-build admission witness: the build-stamp child leaves a stale executable untouched |
| `b2m-pre-close-scan-skipped` | 1 | 0 | 61/1 | disclosure scans: stub replay, destructive deadline close and teardown cannot erase a marker |
| `b2m-prerequisites-binding-unchecked` | 1 | 0 | 60/2 | aggregate: binds every shard and the prerequisites to this candidate, build, pins and environment, validates the selection and coverage, and refuses each defect with its code |
| `b2m-prohibited-checks-masked` | 1 | 0 | 61/1 | prohibited collectors: byte-count failure cannot mask sink traffic, mutation, GET or confinement failures |
| `b2m-prohibited-classes-narrowed` | 1/1 | 0 | 60/2 | gate admission witnesses: 200 greens cannot conceal a counted annotation, unproven budget or failing manifest case |
| `b2m-provenance-binding-unchecked` | 1 | 0 | 61/1 | budget measurement evidence: schema, readiness, pins, build, distinct cells, captures and binding are necessary |
| `b2m-provenance-cells-unchecked` | 1 | 0 | 61/1 | budget measurement evidence: schema, readiness, pins, build, distinct cells, captures and binding are necessary |
| `b2m-provenance-status-unchecked` | 1 | 0 | 61/1 | budget measurement evidence: schema, readiness, pins, build, distinct cells, captures and binding are necessary |
| `b2m-repeat-work-ignored` | 1/1 | 0 | 60/2 | repeat evidence: an extra recorded metadata request changes the observable-work digest |
| `b2m-report-shape-open` | 1/1 | 0 | 61/1 | cell evidence: strict shapes, eras, passing facts, stub identities, budgets and repeat agreement are derived |
| `b2m-secondary-driver-uncounted` | 1 | 0 | 60/2 | secondary budget admission witness: primary-only ceiling refuses combined primary and foreign work |
| `b2m-shard-binding-unchecked` | 1 | 0 | 60/2 | aggregate: binds every shard and the prerequisites to this candidate, build, pins and environment, validates the selection and coverage, and refuses each defect with its code |
| `b2m-shard-content-unbound` | 1 | 0 | 61/1 | shard content and dependency bindings: changed reports or installed input hashes cannot reuse evidence |
| `b2m-skip-build-qualifies` | 1 | 0 | 61/1 | run context: qualifying needs B2_QUALIFY, no selection (even an empty one), no lane filter, a fresh build, a clean tree, matching pins and the installed lane |
| `b2m-stale-known-failure-silent` | 1 | 0 | 61/1 | aggregate problems name stale known failures, unproven budgets, prohibited failures and rejected kill evidence |
| `b2m-startup-after-cancel` | 1/1/1 | 0 | 61/1 | startup cancellation: a backend hook released after the deadline cannot open a driver |
| `b2m-stub-kinds-duplicated` | 1 | 0 | 61/1 | cell evidence: strict shapes, eras, passing facts, stub identities, budgets and repeat agreement are derived |
| `b2m-teardown-scan-skipped` | 1/1 | 0 | 61/1 | disclosure scans: stub replay, destructive deadline close and teardown cannot erase a marker |
| `b2m-template-fault-accepted` | 1 | 0 | 60/2 | templated fault intents are rejected after punctuation and spacing are normalized: decision, goal, Bypass <decision>, the case id, short text and a duplicate |
| `b2m-total-upstream-unenforced` | 1 | 0 | 61/1 | budget enforcement: the exact measured ceiling passes, one below fails under the named predicate, and stub replays never count |
| `b2m-transition-punctuation` | 1 | 0 | 61/1 | authored content: novel tokens, ASCII letters, stopword duplicates and tokenized transitions are enforced |
| `b2m-watchdog-expiry-passes` | 1 | 0 | 58/4 | watchdog: a held clinical request yields INCONCLUSIVE under the deadline predicate alone, and the returned report never changes |
| `b2m-watchdog-late-completion-credited` | 1/1 | 0 | 56/6 | watchdog: a held clinical request yields INCONCLUSIVE under the deadline predicate alone, and the returned report never changes |
| `b2m-watchdog-scan-skipped` | 1/1/1 | 0 | 60/2 | watchdog with a captured disclosure: FAIL outranks INCONCLUSIVE |

## Decisions carried from the B2-0 plan

| # | Decision |
| --- | --- |
| D1 | The live "pins match" check runs in the aggregator (readiness INCONCLUSIVE on drift), not in node:test, so a harness mutant is killed by its named test rather than by every pin assertion. |
| D2 | `ensureBuilt()` builds once per run under a directory lock with a source stamp; no tsx fallback for the SDK lanes. |
| D3 | A `known_failure` runs as a node:test TODO; the report records FAIL and the gate stays blocked. |
| D4 | Production anchors are `{file, find}` objects in shipped runtime source (one match, no path escape). |
| D5 | Budgets are exact-max/1 of the measured provenance within the shipped limits; `max_task_bytes` stays null. |
| D6 | Diagnostic transitions are a classification, never counted. |
| D7 | The mutants pin covers only isolation-relevant and kill-matrix mutants (a unit-only registration never forces a refresh). |
| D8 | B2-0 lands after S5b/S6; its registry tail is merged after theirs with the pins refreshed last. |
| D9 | `kills.json` records bind to `candidateBinding().inputsSha256`, the aggregate's run and attempt IDs, build/dependencies and validated six-cell row executions; anything else never counts. |
| D10 | Watchdog expiry is INCONCLUSIVE; a captured disclosure outranks it as FAIL; the deadline snapshot is protected from abandoned work; teardown disclosures are added before return. |
| D11 | Stub replays are excluded from every enforced count. |
| D12 | Case test titles stay `<id> <family> diagnostic attack/control matrix` so historical judge kill names remain valid. |
| D13 | `render-cancel-guard`, `outcome-execution-failure` and `credential-reinvalidate` are excluded from the kill matrix. |
| D14 | Every aggregate refusal is a coded `AggregateError`. |
| D15 | `counts_toward_b2` is never stored on a case report. |
| D16 | `PendingObligation` is left in place (never thrown); `INTEGRATION.txt` corrected. |

## Next (B2-1)

Fill the first slice's 61 counted-case records with authored intents, changed production anchors, retained measurement reports, independent per-type mutants and sibling spares. Complete coverage or review bounded N/A rules, then widen toward at least 200 earned cases with every critical kill on one candidate. The installed-package qualification lane remains S9. The official mutation aggregate and Linux egress-enforcement check remain root-owned.
