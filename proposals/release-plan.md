# fireboat release plan

- **Status:** decided by root (Claude), 2026-10-22. Revision 1.
- **Inputs:** GPT-6.1-Sol's independent proposal and Claude's round-1 response, both in `docs/handoff/2026-10-21/planning/`. The owner ended the Claude–GPT consensus process on 2026-10-22 ("from now on you work individually"), so this plan is root's reconciliation of those two documents rather than a further consensus round. Where it adopts a section of either input by reference, that section applies as written there.
- **Contract:** PLAN.md 0.4.1 stays the product contract. This plan executes PLAN §9–§10; it does not amend PLAN. It records two process amendments to the M3b integration plan (A1 and A2 below), which the owner directed.
- **Publication acts** (repository visibility, tag, npm, OCI, Registry, rename, announcement) each need explicit owner approval against concrete final inputs. Nothing in this plan authorizes one.

## 1. Where the repository is (2026-10-22, `r/s5-candidate` at `f5e7478`)

| Item | State | Evidence |
| --- | --- | --- |
| M1, M2, M3a | Closed | `docs/M1-STATUS.md`, `docs/M2-STATUS.md`, `docs/M3A-STATUS.md` |
| M3b S0–S4 | Landed on `feat/read-only-prototype` with full CI at the time | `docs/reports/2026-10-19-overnight-report.md` |
| S5.1–S5.7 + fix round | On `r/s5-candidate` (`83f482f`) | review record in `proposals/audit/claude-s5*`, `root-s57-*` |
| S5.8a (v2 listing, 0.2.0-alpha.1), S5.8b-ci, S5.7 fix round | On `r/s5-candidate` (`f6d19c0`, `be7b521`, `83f482f`) | independently reviewed 2026-10-22; fixes in `6483a92`, `c1a9d68` and the checkpoint commit (`docs/S5-STATUS.md`) |
| S5.8b-registry | Done: `d79a71d`, `7b5e059` | `proposals/audit/root-s58b-registry-decisions.md`, `s5-mutants/s5.8b-registry/` |
| Official 14-shard mutation aggregate | **Passed** at `7b5e059`: 472 killed, 2 declared survivors, 0 inconclusive, 0 anchor errors, 0 timeout-only kills, 474/474; **passed** again at the checkpoint `750c611`: 476 killed, 2 declared survivors, 0 inconclusive, 0 anchor errors, 0 timeout-only kills, 478/478; **passed** on the merged S5b + S6 candidate `5c59cdd`: 509 killed, 2 declared survivors, 0 inconclusive, 0 anchor errors, 0 timeout-only kills, 511/511 | `proposals/audit/s5-mutants/s5.8b-registry/official-aggregate-{7b5e059,750c611,5c59cdd}.md` |
| Local gates at `7b5e059` | `npm run check` 1,887 tests / 1,885 pass / 2 S6 TODO; isolation 76/76; both eval eras 207 pass / 15 pending; W-01; contract `--check` | root runs, Node 24.22.0, macOS |
| Local gates at the S6 merge (S5b + S6 on `r/s5-candidate`) | `npm run check` 1,935 tests / 1,935 pass / 0 TODO; isolation 76/76; both eval eras 77/77 tasks per arm, 0 pending; contract `--check`; demo | `docs/S6-STATUS.md`, `proposals/m3b-s6-design.md` §7 |
| CI | Manual-only (`workflow_dispatch`) since `d79a71d`; no CI run on any S5 commit | owner instruction, 2026-10-21 |
| Engines floor `>=24.21.0` | **Not applied** (owner rejected the edit; pending owner decision) | `package.json` says `>=24` |
| Token caps | Unmeasured in the pinned container; exploratory macOS o200k 2,096/2,500 | `docs/contracts/m3b-tools.json` `token_acceptance` |
| Isolation gate | B2-0 counting machinery landed (ledger, kill and coverage matrices, validated evidence, bound runs, 99 machinery mutants); 68 diagnostic cases, 0 counted toward B2's ≥200 | `docs/B2-STATUS.md`, `tests/isolation/cases-v1.json`, `artifacts/b2/<run>/report.json` |

## 2. Decisions adopted from the inputs

1. **First distributable: a pinned synthetic local-stdio alpha**, published as source + tag first, npm second, a verified OCI subset third, Registry entry last. SMART and remote serving come only after the external validation gate (GPT §2, §4.2 P7–P9; Claude agreement 1).
2. **Hard gates for the first accepted alpha** (GPT §2(a) items 1–8; Claude agreement 2):
   - S5.8 accepted with the official mutation aggregate (**done**, see §1) and the S5 checkpoint recorded (§4 below);
   - S5b and S6, all seven named obligations, with no gate loosening (GPT §4.4);
   - B2: ≥200 independent applicable isolation cases, all critical mutants killed, no uncovered applicable cell;
   - S7 truthful generated docs;
   - S8/S9 packaging with the rename;
   - rights, notices and trademark wording resolved;
   - public-history review;
   - `SECURITY.md`, contribution terms, issue templates;
   - owner approval for every publication act.
3. **Acceptance details adopted verbatim:** GPT §4.3 (S5.8), §4.4 (S6), §4.5 (S5b, S7, S8–S10), §4.6 (real-server and SMART beta).
4. **Differentiation thesis:** "the best-evidenced patient-bound read-only FHIR retrieval gateway for a named workflow." Every claim in GPT §5 is published only at its stated evidence level, with denominators and failures alongside.
5. **Non-claims list** (GPT §7): adopted in full. Reproduced in §8 so it travels with the repository.
6. **Owner decisions** (GPT §6): adopted, reordered in §9.

## 3. Amendments (root decisions)

**A1. CI is a release-time step, not a development gate.** Owner-directed on 2026-10-21. Intermediate checkpoints (S5, S5b, S6, B2, S7, S8–S9) are accepted on full local verification: `npm run check`, isolation, both eval eras, demos and controls, contract and docs `--check`, the root-run local 14-shard mutation aggregate, and exploratory catalog measurement. Each is recorded as "locally verified; CI-deferred". Commits stay on `r/s5-candidate` until the release candidate. **CI runs once, on the frozen release candidate**, for everything local verification cannot supply: the pinned Linux container token measurement, live HAPI and Medplum in Docker, the Node 24.21/26.10 cells and the Linux shards. The workflow is `workflow_dispatch`-only until then (**applied in `d79a71d`**). The release-time CI route (restore billing, or make the repository public so hosted runners are free) is the owner's choice.

This amends `proposals/m3b-integration-plan.md` A3/A4 and the "exact-tree full CI before landing" sentence of `proposals/m3b-s5-workplan.md`. The exact-tree CI requirement moves from "before S5 lands" to "before any publication act".

**A2. Landing procedure.** The workplan called for squashing S5 into one commit before landing on the PR branch. Root recommends landing the reviewed series with a single merge commit and no history rewrite: the review trail (slice commits, fix rounds, decision records) is part of the evidence, and `r/s5-candidate` is already pushed at `f6d19c0`, so a squash would require a force-push. A merge commit still gives one tree for the release-candidate CI run to bind to. **Owner decision pending** (§9, item 1); until then nothing lands and the branch is not rewritten.

**A3. The catalog byte budget is a constrained resource.** `fhir_search` (1,750/1,750 B) and `fhir_page` (1,100/1,100 B) are exactly at cap; tools total is 7 B under. Any change to a description, schema or instructions, including S7 doc-driven wording, lands with a fresh capture, the byte and token measurement, and equal-or-lower bytes per changed tool unless a recorded cap revision has a measured, task-linked reason. The rename changes `serverInfo` and must be measured the same way.

**A4. Publish the evaluator as a product.** At the accepted alpha, publish the deterministic harness (74 tasks × 3 arms × 2 eras, exact byte accounting, `validateDeliverable02`) and the isolation suite as a documented, reproducible evaluation kit that third parties can run against their own servers. We run no competitor code without owner approval and publish no competitor security observations.

**A5. Injection-evaluation slice.** The synthetic injection evaluation (GPT §3.5) is a named deliverable: a soft gate for the alpha announcement (may be absent if stated as not yet measured) and a hard gate for any "safer"/"security" positioning and for the beta.

**A6. Working model.** From 2026-10-22 root (Claude) implemented, reviewed and planned. From 2026-10-23 (owner instruction) GPT-6 Astra at maximum reasoning wrote the code; later that day the owner switched code writing to GPT-6.1-Sol in standard (not fast) mode at maximum reasoning. Root plans, writes the briefs, reviews the diffs, runs the verification, keeps the records and does all git work. Independent review of each slice is kept as a separate pass on the frozen tree, recorded in `proposals/audit/`. From 2026-10-24 (owner instruction) root also implements disjoint pieces in parallel with Sol instead of waiting, and the two review each other's work: Sol reviews root's code read-only, root reviews Sol's diffs. From 2026-10-25 (owner instruction) GPT is no longer involved: root writes, reviews, verifies and commits everything end to end, runs independent work in parallel, and uses Claude subagents for the independent review passes.

**A8. User-evidence gates (owner decision, 2026-10-23).** Three gates answer the outside review's finding that the project had invested in internal assurance more than in evidence from outside its own harness (`proposals/audit/gpt-astra-project-review-2026-10-22.md`). Each records its exact inputs (versions, configuration, data set) and transcript in `docs/evidence/`, with synthetic data only.

- **G-HOST, outside-host smoke test.** A real MCP host, not our SDK harness, connects to the built CLI over stdio and completes a scripted task list: the tool listing (exactly the five tools, schemas accepted), `fhir_capabilities`, a confined `fhir_search`, `fhir_read`, `fhir_page` on a returned cursor, `fhir_result` on a returned handle, and one refused foreign-patient request whose refusal the host shows intelligibly. Records the host and version, the negotiated protocol era and any host-side errors. Claude Code first (root can run it); further hosts as the owner arranges. **Gate:** before the packaging freeze (S8–S9 exit). **Status:** passed for Claude Code 2.1.309 in the 2026-07-28 era on 2026-10-23 ([evidence](../docs/evidence/g-host-claude-code-2026-10-23.md)); a legacy-era host and further hosts remain open. Its seven usability findings feed S7.
- **G-BACKEND, a profile proved on an independent backend.** At least one narrow search profile qualified through the S6 qualification route against a FHIR server this project did not write (for example HAPI FHIR run locally with synthetic Synthea data), with its evidence recorded like `synthetic-fixture-r4-v1`. Until then, the alpha claims proved query evidence only on the synthetic fixture and generic search everywhere else. **Gate:** before the first alpha (S12 release packet). **Status:** passed 2026-10-23 for a narrow profile: `hapi-r4-labs-v1` proves Observation code tokens with an explicit system and `ge`/`lt` date bounds on HAPI FHIR Server 8.12.0 only; no sorts and no continuations (HAPI's opaque continuations stay unverified). Evidence: `docs/evidence/g-backend-hapi-qualification-2026-10-23.md` (on branch `candidate/g-backend`, merged with this branch).
- **G-HUMAN, human review.** A person (the owner or an engineer the owner names) reviews a named file list of the isolation core (policy, confinement, projection, privacy, delivery gate) and the final claims manifest, with findings recorded and dispositioned like the model reviews. **Gate:** before the release packet; scoped to about one working day.

**A9. S7a usability revision, schema 0.3 (root decision, 2026-10-24).** The outside-host test findings (`docs/evidence/g-host-claude-code-2026-10-23.md`) are fixed before S7 in one coordinated application revision: error-only `query_evidence: "none"`; server capabilities paged through the existing discovery cursor with freshness fields and a fixed priority order; the configured patient id in server data; a registered `METADATA_BYTE_LIMIT` warning; `fhir_page` inheriting the search's page size; catalog revision 3 within the existing caps (A3). Unknown continuations keep `has_more: null`. Design and decisions: `proposals/m3b-s7a-design.md`; spec record: `proposals/m3b-spec.md` Addendum D. The 2026-10-23 host and backend evidence stays recorded as 0.2 evidence; G-HOST is repeated on the final installed artifact.

**A10. S8–S9 packaging design (root decision, 2026-10-24).** `proposals/m3b-s8s9-design.md` slices the packaging work. The leaf slices (pins and manifest schema, `prepare` guards, host configuration forms and timer, tarball-inventory primitives) run in parallel with S7a on new files only; doctor, the shared oracle and the helper follow S7; the rename follows S7; staging, shrinkwrap, inventory, fresh-install tasks and the supply-chain design follow the rename. The natural Synthea corpus waits for the owner's approval to download the pinned Synthea JAR and JDK image.

**A11. Source preview first; no GitHub Actions (owner decisions, 2026-10-31 and 2026-11-05).**
- **First public step:** the owner chose the Stage A public source preview (§4) on 2026-10-31, after independent read-only planning reviews by GPT-6 Astra and Muse wonder-full that Claude verified. The repository, or a curated export of it, is made public so people can read, clone and run it locally. It is not a release: there is no tag, npm package, OCI image or Registry entry, and the README says so. The pinned alpha (§2.1, §2.2) follows later and keeps every gate in §2.2.
- **No GitHub Actions at any stage.** The owner said on 2026-11-05: "lets not use github actions ci man, they are charging me money". This replaces A1's single release-candidate CI run.
  - Every pushed branch keeps its workflows `workflow_dispatch`-only. The preview export ships with no workflow that triggers on push, pull request or schedule.
  - What CI was to supply is verified locally and recorded: the full local gates (A1), plus the same suite in a pinned linux/arm64 container on the local colima VM. linux/amd64, Windows and other Node versions stay unverified and are stated as such.
  - At the alpha, an owner-run local publish procedure, designed with S12, replaces `release-npm.yml`.
- **Preview gates.** All are required, on the exact commit that is made public:
  1. owner approval of the exact content and the visibility change;
  2. the public history: a curated export, or a reviewed full history, decided from the §6 inventory. The inventory currently lists the personal email on every commit, absolute home-directory paths in 39 tracked files, ten `research/` notes with competitor security observations, and three tracked local logs;
  3. a seed decision: redistribution rights for the LOINC and SNOMED CT coded seed confirmed, or that seed left out of the export, with a stated fallback for the quickstart;
  4. records that agree with the evidence: `AGENTS.md`, `docs/M3B-STATUS.md`, `docs/HANDOFF.md`, and the packaged `README.md` and `docs/QUICKSTART.md`. The packaged files are corrected at the export re-pack, because editing them changes the approved package inventory;
  5. truthful public text, with the §8 non-claims intact. It must say that B2 is unmet with 0 cases earned, that the last official mutation aggregate did not pass, that S11 has not run, that only arm64 is verified, and that the project uses synthetic data only and has no SMART authorization;
  6. a tester path that needs no Docker (`npm run demo`), shown before the arm64-only HAPI quickstart;
  7. `npm run check`, isolation, both eval eras and docs `--check` passing locally on that commit, with the run recorded.
- **Deferred for the preview,** and stated as pending in the README: B2 ≥200, a passing official aggregate on the final tree, S11, G-HUMAN (recommended before the preview, not required), npm, OCI, Registry and the paper. These remain gates for the alpha and for the paper release.
- **Amends** §2.1 (the source preview comes before any tag), A1 (no CI run) and §9 items 5 and 6. §2.2 does not apply to Stage A.

**A12. B2 contract and first workflow (owner decisions, 2026-11-05).**
- **B2:** the owner adopted a **corrected, versioned v2** contract on 2026-11-05, after two independent reviews that both recommended it. B2 v1 (≥200 counted of 216) stays reported as **unmet**, never relabelled.
  - Before v2 is used for counting, its §12 item 1 is fixed: equivalence needs an independent semantic justification, survival only supports it, and no disposition is allowed once a mutant is critical.
  - §12 item 2 is **decided by the owner on 2026-11-05: no 90% share.** Every counted obligation must be earned under v2, as under v1. The corrected v2 changes how obligations are defined and counted, not whether a counted case must earn its credit.
  - The corrected contract is committed as its own file, and both versions are reported side by side.
- **First workflow:** `recent-labs-v1`. Release claims, eval emphasis, the README walkthrough and the head-to-head comparisons centre on it.
- **Consequence:** the alpha's B2 gate (§2.2) is read as "B2 v2 satisfied; v1 reported unmet".

**A7. Small items.**
- Engines floor: the `>=24.21.0` edit stays pending the owner's decision (§9, item 2). 24.21.0 is the known `Readable.toWeb` regression cell, so the floor is recommended.
- Runner pinning: `catalog-tokens` is pinned to `ubuntu-24.04` (applied in `d79a71d`). The other jobs are pinned when the release-candidate workflow is prepared, as one reviewed change.
- Hosted shard timing is unmeasured; a local shard takes 575–707 s on 12 CPUs. The release-candidate workflow measures the first hosted shard before relying on the 25-minute job timeout, and raises it or adds shards if needed.

## 4. Stages and exit gates

| Stage | Contents | Exit gate | Status |
| --- | --- | --- | --- |
| S5.8 close | S5.8b-registry; official 14-shard aggregate; independent review of S5.7-fix, S5.8a, S5.8b-ci; fixes | all local gates in GPT §4.3 except exact-tree CI and the container token run | done 2026-10-22 |
| S5 checkpoint | Full local verification of the complete S5 series; checkpoint record in `docs/S5-STATUS.md`; 14-shard aggregate re-run on the checkpoint commit | "locally verified; CI-deferred"; stays on `r/s5-candidate` | done 2026-10-22 (`750c611`; aggregate record `9cb4c0f`) |
| S5b | Withheld-entry collapse per GPT §4.5 | §4.5 plus full local gates; measured savings reported without assuming the ≤15% target | done 2026-10-22 (`f486ceb`; policy-only pages −22.0/−25.7%, attachment-heavy −14.9/−16.8% full-text; `proposals/m3b-s5b-design.md`) |
| S6 | Profile proof: the five pending eval tasks and the two mixed-proof TODOs (GPT §4.4), with the mixed-proof rule for `evidenceKindFor` recorded and tested | zero pending or TODO rows; real verdicts in both eras; no gate loosening | done 2026-10-22 (0 pending, 0 TODO; `docs/S6-STATUS.md`); official aggregate on the merged commit `5c59cdd` passed 2026-10-23 (509 killed, 2 declared survivors, 511/511) |
| B2 ≥200 | Manifest expansion to ≥200 independent applicable cases; templated fields (fault intent, source anchor, budgets) made per-case; budgets enforced by the runner | no uncovered applicable cell; all critical mutants killed; positive controls pass | B2-0 (counting machinery) done 2026-10-23, reviewed in two rounds; official aggregate on `cffddc7` passed (608 killed, 2 declared survivors, 610/610); B2-1 (the first 61 counted cases) next; touches only `tests/isolation/**` and the design doc |
| S7a | Usability fixes from the outside-host tests as schema 0.3 (A9) | strict gate, contract `--check`, fresh catalog capture within A3, both eval eras, isolation, official aggregate | done 2026-10-24 (`19bfcb5`; root-verified check 1,996/1,996, evals 83/83 both eras, HAPI 7/7) |
| S7 | Generated docs (support, query evidence, compact, host, repair, status) from final data; README, LIMITS, IMPLEMENTATION regenerated; byte-budget rule A3 | docs `--check`; listing equality | done 2026-10-24 (`scripts/generate-m3b-docs.ts` with byte-exact and semantic sync tests; support matrix `support-matrix/2`; drafts retired; README, LIMITS, `docs/M3B-STATUS.md`, `docs/P-WIRING.md`) |
| Stage A (optional, owner) | "Public source preview": rename or interim name, corrected attribution and `THIRD_PARTY_NOTICES.md`, history inventory and curated-vs-full decision, SECURITY/CONTRIBUTING/templates, truthful README, no competitor-security or internal-only material; repository made public | owner approval of exact content and visibility; not a release | chosen by the owner 2026-10-31 as the first public step; gates in A11 |
| S8–S9 | Packaging and the rename (`fireboat`, `@fireboat/gateway`, CLI `fireboat`, with owner confirmation); shrinkwrap; fresh-install tests; three tasks in both eras; `files` allowlist; provenance workflow design; SBOM | GPT §2(b) hard list; **G-HOST passed** (A8) | in progress: slices 1–4 and 6 done 2026-10-24 (`proposals/m3b-s8s9-design.md`) |
| S10–S11 | OCI subset on tested cells only; measurement freeze; C.1–C.3 reported honestly | GPT §2(c); preregistered measurements | pending |
| S12 + release packet | **The single CI run on the frozen candidate**; final claims manifest; owner packet listing each publication act separately | owner approves each act (tag, npm `alpha` dist-tag, OCI push, Registry); **G-BACKEND and G-HUMAN passed** (A8) | pending |
| P8 validation | Unaided-developer tasks, two-family baseline, partner and workflow choice; evaluation kit (A4); injection slice (A5) | PLAN validation gate | owner-dependent |
| Beta | One real-server SMART path per GPT §4.6 | §4.6 | later |

Order of work from here: S5 checkpoint → S5b → S6, with B2 expansion and release hygiene (L3) interleaved as root's time allows. Nothing in L3 touches runtime source, so it can land in docs-only commits at any time.

## 5. S5 checkpoint record (what "accepted" will mean)

The S5 checkpoint is recorded when all of these hold on one commit of `r/s5-candidate`:
- the three unreviewed commits have an independent review record and every confirmed finding is fixed or recorded as accepted debt;
- `npm run check`, isolation, both eval eras, demos and the negative control, contract `--check` and the anchor test are green on that commit, run by root;
- the official 14-shard aggregate has passed on that commit or on an ancestor whose registry, runtime source and tests are byte-identical (the judge's candidate binding proves this);
- `docs/S5-STATUS.md` records the counts, the commit, what is CI-deferred and what is not claimed.

## 6. Release hygiene checklist (L3, docs-only, any time)

- `THIRD_PARTY_NOTICES.md`: replace "used with the permission of HL7" with accurate descriptive-use wording; no permission is on record.
- `SECURITY.md` (private reporting, supported versions, synthetic-only scope), `CONTRIBUTING.md` (no PHI, no secrets, test expectations), issue templates.
- `NOTICE`/copyright holder named; dependency license inventory; GitHub license detection fixed.
- Public-history inventory script: personal email on all commits, absolute home-directory paths in 22 tracked files, retired-name commit subjects, the four unreproduced competitor vulnerability notes in `research/12*`, `.local`/handoff material. Output feeds the curated-vs-full decision.
- README: isolation status, tool-table topics, `--version`, the `fhir-mcp-gateway` naming note; the A3 banner stays until S7.
- Status docs: `docs/M3A-STATUS.md` marked historical; `docs/S5-STATUS.md` becomes current at the S5 checkpoint.

## 7. Claims matrix

GPT §5's table is adopted as the claims register. Today only the "current engineering statement" row is supported, and only at the stated commit. Each later row names its gate; none is published before its gate passes.

## 8. Non-claims (adopted in full)

Never claim at the first launch, absent the separately required evidence:
- SMART authorization, SMART certification, enterprise-managed auth or an authenticated remote MCP service, because client-secret OAuth exists.
- Clinical or production readiness, HIPAA/GDPR/CMS/ONC compliance, regulatory clearance, clinical validation or a validated diagnostic/treatment outcome.
- General Epic/Oracle/Azure/AWS/Google/vendor compatibility, R4B/R5/R6 support, US Core conformance, profile validation, or every search/sort variant from a generic R4 response or CapabilityStatement.
- Full protocol conformance, every MCP client/host, verified model-input behaviour, or three independent clients from two SDK-era tests or generated configuration.
- Complete clinical history, clinically proven absence, a verified latest result when sort is unknown, complete retained results, or "full FHIR" meaning unmodified/complete source content.
- Clinical writes, arbitrary operations, graph traversal, general terminology coverage, document/note retrieval or artifact delivery that the five implemented tools do not supply.
- Zero possible leaks, prompt-injection immunity, universal identifier redaction, a durable disclosure ledger or a security certification from zero observed synthetic failures.
- "All tests passed" while required TODO/pending/unrun gates remain; current CI green from historical runs; all mutation guards killed from diagnostics or stale anchors; 200 independent isolation cases by multiplying formats.
- Lowest tokens, fastest workflow, <100 ms p95, 50% savings, "best FHIR MCP server", universal one-line install or a ten-minute result without the exact matched measurement or study and its limits.
- npm/image/Registry availability before the owner-approved artifact exists and installation/metadata retrieval has been checked.
- Three-model agreement, or human clinical/security review supplied by additional AI reviewers.
- Competitor vulnerabilities, competitor security observations or inferred absence of competitor capabilities.

## 9. Owner decisions, in the order they unblock work

1. **Landing procedure:** merge commit with preserved history (root's recommendation) or squash as the workplan said.
2. **Engines floor** `>=24.21.0` in `package.json` and the lock: apply or keep `>=24`.
3. **Name and namespace:** **decided 2026-10-22** — `fireboat` (repository), `@fireboat/gateway` (npm), `fireboat` (CLI); the rename is prepared in `proposals/rename-plan.md` and applied at the packaging step, with no publish or push without approval. The HL7® FHIR® attribution wording in `THIRD_PARTY_NOTICES.md` is descriptive-use only.
4. **Public history:** full reviewed history, or a curated export, after the inventory in §6.
5. **Release-time CI route:** **decided 2026-11-05**: no GitHub Actions; local verification only (A11).
6. **First public step:** **decided 2026-10-31**: the Stage A source preview, with the pinned alpha after S12 (A11).
7. **First workflow:** **decided 2026-11-05**: `recent-labs-v1`, the recent laboratory evidence workflow that `doctor` already reports, is the named workflow that the alpha's claims, evals and comparisons centre on (A12). Partner and **first SMART path** are still open: SMART backend first, after the npm alpha.
8. **Comparative benchmark permission** (keep the current prohibition for now).
9. **Maintenance, rights and review budget** before the public alpha.

## 10. Risks

The largest risk is publishing a well-tested candidate as if it were an accepted release. S5b, S6, the ≥200-case manifest, the container token measurement and the single CI run are still missing forms of proof. Packaging and the rename invalidate earlier artifact identity, size and provenance evidence, so measurements freeze after those changes, not before. Scope residuals (unlisted identifier systems, authorized prose, timing and topology signals, host-side data sharing) stay as documented limits; a local stdio gateway does not mean data stays on the device.
