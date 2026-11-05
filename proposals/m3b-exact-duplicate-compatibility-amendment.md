# M3b compatibility amendment: exact duplicate query predicates

2026-10-19. Status: **Claude–GPT agreed semantics after review A-1–A-4; checkpoint acceptance pending**. Claude approved the runtime and concrete V-18 migration, conditional on the wording revisions recorded here. Root accepts those revisions and applies the consequent contract edits in this isolated candidate. This does not retroactively accept the failed S1 runs, establish Medplum compatibility or authorize a PR-branch landing before A3/A4 gates.

## Problem and scope

Medplum's observed source self links collapse identical repeated query pairs. S1 deliberately appends a trusted patient predicate independently of caller input; requiring the source to echo both identical occurrences therefore causes a fail-closed functional gap. See the root diagnosis and response in the main checkout's `proposals/audit/{claude-s1-medplum-diagnosis,gpt-s1-medplum-response}.md`. Equal result counts alone establish neither record equality nor filter execution.

For source-reported initial self-link evidence and ordinary resource-path continuation evidence, admitted material search predicates are equivalent when their sets of distinct exact decoded `(name,value)` pairs are identical. Source ordering and multiplicity of an already-present identical predicate do not change that equivalence. Every distinct requested predicate must remain present, and no new distinct predicate may appear. Decode URL query syntax exactly once; do not normalize parameter spelling or case, predicate values, FHIR token escapes, numeric lexemes, reference aliases or other representations.

Preserve the gateway's complete ordered initial outbound sequence, including every caller occurrence and the independently appended trusted confinement occurrence. Preserve that original sequence and multiplicity in frozen requested evidence and query identity. This amendment changes only source-evidence comparison. It supplies no filter/sort execution proof, enables no profile, admits no new query syntax, and changes no authorization, transport, response, budget, generation or expiry guard.

Exact-duplicate equivalence applies only to (a) non-underscore parameter names that the gateway admitted because the source declared them as search parameters for the resource type, and (b) `_id` and `_lastUpdated`. A source that declares a name as a search parameter is treated as having declared a search predicate, and FHIR's rule that repeated parameters are combined with AND applies to it. Equivalence never admits a changed or new value, or an undeclared name. All other underscore names, including `_sort`, paging mechanics and any other underscore control, keep exact multiset comparison. Reported-only `_sort` and the `PAGING_NAMES` set are ignored in self evidence, as before. Preserve the usable initial self-link requirement, separate Q sort downgrades, rejected-continuation safe-prefix behavior, and the reviewed HAPI root `_getpages` form with unknown execution labels.

## Consequent contract edits in this candidate

- PLAN §6's ordinary-continuation rule and §9's query test row: distinct exact decoded material predicates replace the multiplicity requirement for source-reported evidence. Keep the complete original outbound/requested sequence and every distinct value.
- M3b §7: repeated requested pairs keep their positions and cardinality in `constraints` and the query digest. A requested occurrence is source-reported matched when its distinct exact predicate is present. Multiple identical requested occurrences may share that source assertion. Execution remains independently determined; this does not turn an echo into proof.
- Integration S4/A3: ordinary self/continuation source evidence follows the rule above; requested sequence, sort/control rules, confinement and opaque-form limits remain intact. Backend acceptance records the observed normalization, rather than requiring every source to reproduce identical-pair multiplicity.

Do not silently replace historical reports or treat their earlier failure as a pass. Record any remaining backend failure as unmet. The contract edits are prepared together in this candidate; the PR branch remains unchanged until the complete checkpoint gates pass.


### Reviewed boundary and legacy tightening

A source-advertised vendor name such as `ct` or `pageContext` follows the non-underscore class above, even if that vendor uses the name for an opaque control. Reviewer probes P4/P5 demonstrated that identical-value multiplicity may change for such an admitted name. This is an explicitly reviewed residual; its exact value cannot change, no undeclared name is admitted, and execution remains unknown. It does not establish that a particular vendor implements standard AND semantics. S3/S4 typed admission and adapter evidence remain separate requirements.

The initial 0.1 self check previously ignored unrequested reported names. It now refuses any unrequested reported name outside `_sort`/`PAGING_NAMES`. This fail-closed tightening matches M3b §7, but a backend echoing an additional non-mechanic name may fail; both live backend jobs must confirm the candidate. Unsolicited `_summary`/`_elements` remain ignored as before; their content-shaping semantics remain an explicit S3/S4 issue, not a new proof or support claim.

Equal result counts and AND-idempotence are definitional arguments for comparing evidence, not evidence that the backend executed any filter. The [FHIR R4 search rules](https://hl7.org/fhir/R4/search.html#combining) describe repeated-parameter conjunction; [SearchParameter.multipleAnd](https://hl7.org/fhir/R4/searchparameter.html) separately describes repetition support. Neither standard verifies a vendor. Live cells compare complete private record sequences against the independently seeded oracle.

Exact pre-amendment anchors (line numbers refer to `a2e16f2`) are PLAN.md:162 “identical repeated-value multisets”; PLAN.md:320 “exact material constraint multisets”; m3b-spec.md:632 “validated against the source self-link multiset”; integration-plan.md:65 “its material confinement multiset”; :67 “Validate material-pair multisets”; :71 “multiset/self-sort handling”; and A3 :362 “both self-link occurrences” / “A backend collapsing duplicates must produce a recorded fail-closed compatibility gap”. This amendment is A3's explicitly reviewed compatibility-boundary decision. It does not waive actual functional acceptance.

## Concrete test migration in this candidate

The original `V-18` test has three negative controls. Keep the upper-bound-loss and upper-bound-replaced-by-duplicate-lower-bound controls. Replace “extra duplicate added” with “extra distinct value added” and update its name to distinct exact constraint preservation. The replacement still refuses an extra requested predicate and performs zero continuation fetches. New executed HTTP-chain control `S1-N33` accepts only identical repetition, preserves the frozen query, and drains the complete independently known authorized sequence. `S1-N15`/`N16` separately test distinct-value loss/addition; confinement, origin, base-path, resource-path and sort controls remain negative.

The original three-file implementer candidate leaves V-18 failing and is preserved untouched. The root's isolated candidate contains the now agreed migration. Its local green result remains preparation evidence; live and complete candidate gates are still required for checkpoint acceptance.

## Required acceptance evidence

Independently record actual outbound pairs and actual source self links on HAPI and authenticated Medplum. Retain the trusted append and compare complete authorized record sequences privately across multiple upstream Observation pages and the single logical Patient `_id` control. Diagnostics contain only fixed codes, counts and booleans. A local retained remainder and replay must not cause extra fetches or alter query identity.

The backend-script instrumentation and mutation succession are applied in candidate `6e656eb` (S0+S1, branch `candidate/s1-on-s0`), with integration review. Retain all 121 existing mutant IDs, migrate `continuation-multiset` and `q2-sort-echo-mismatch`, add the three names-only/confinement mutants plus the two reviewer controls for underscore-control idempotence and ignored unrequested names, and retire none (126 prospective IDs). Apply those changes after the S0 handoff and require a complete exact-candidate sharded aggregate. Diagnostic mutant kills do not satisfy it.

Runtime/amendment review is complete under A-1–A-4. Integrated script/mutant review, all local/eval/demo gates, actual backend jobs and complete candidate CI are still required before accepting this checkpoint. The PR branch is unchanged. This remains a synthetic-only read-only prototype, with no SMART, vendor, clinical, production or general filter-execution claim.
