# Typed retrieval batch: implementation evidence

> **Historical record.** This is evidence for revision `655e63c` only and does not verify later code. Its hashes, test counts (76/78), 105-case evaluation table, 349 URI paths, 401/403 behaviour and CI links describe that revision. M3a repaired final-wire byte accounting, decimal precision, primitive-companion URI screening and the 403/generation policy. See [M3A-STATUS.md](M3A-STATUS.md) for the current state.


Date: 2026-10-18. Source revision: `655e63c583a9885b9070bfbc0e2ac4dd203be647`. This record follows the [M1 evidence](M1-STATUS.md); it does not extend M1's independent Muse approval to new code. Muse supplied the auth module, research and initial evaluation work; root completed integration and review after Muse exhausted its quota, as the user requested. Root review and corrected regressions are recorded explicitly.

## Delivered

- Pinned HL7 R4 discovery within the existing five-tool interface: 207 base definitions, 7,460 elements, actual JSON choices, cardinality, reference targets and bindings. Discovery is paged and bounded; endpoint profile validation is explicitly not performed.
- Schema-aware URI screening closes M1 R3-1, including relative canonical metadata and nested/choice fields. Tests exercise all 349 URI-typed base leaf paths, primitive-array alignment, primitive extension preservation and modifier warnings.
- Source-bound, environment-backed outbound OAuth client credentials for controlled loopback backends. Token acquisition is single-flight, bounded and memory-only. Failed acquisition or observed backend 401/403 clears retained data; late resource/metadata responses cannot restore it or the invalidated capability cache.
- A digest-pinned real Medplum/PostgreSQL/Redis stack, plus the existing pinned HAPI R4 stack. Medplum authentication stays enabled and the gateway uses a separate ordinary project client.
- A deterministic retrieval harness: 35 tasks, three output formats, 43 golden synthetic resources. It verifies facts, repeated filters, paging order without hidden deduplication, provenance, coverage, non-disclosure and whole-task budgets. CI publishes its JSON report for 14 days.
- Exa-backed primary-source comparisons and Muse's independent code research. No competitor code is incorporated.

## Verification

The initial batch at `1138ffa` passed all three CI jobs in both push (private development repository) and PR (private development repository) workflows. It had 76 tests. Two subsequently reproduced review findings—duplicate detection in the evaluation harness and a late-metadata invalidation race—were fixed and covered by regression tests at the source revision above.

Final source verification passed in push CI (private development repository) and PR CI (private development repository): the unit/MCP, HAPI and authenticated Medplum jobs are green. The downloadable push-run report (artifact, private development repository) was downloaded and checked for the exact source revision, fixture hash, 105 results and zero reported failure causes. The artifact expires after 14 days; the workflow logs and this record retain the summary.

Local Node 24 checks pass type checking, all **78 tests**, compilation, source/compiled SDK demos, source/compiled evaluation CLIs and the production dependency audit (zero reported vulnerabilities). Docker is unavailable on the development host; actual HAPI/Medplum evidence comes from the isolated GitHub CI jobs, rather than a local mock.

The backend acceptance scenarios are deliberately narrow:

| Backend | Checked behavior |
| --- | --- |
| HAPI FHIR R4.0.1 | Three pages, three authorized observations, repeated filters, wrong-patient denial and inline attachment withholding. |
| Medplum R4.0.1 | Unauthenticated read denied; client-credentials authentication with an ordinary project client; three pages, three authorized observations, repeated filters, wrong-patient denial, and attachment content or protected storage link withholding. |

These runs support those flows on the exact pinned images, not general EHR/vendor or production compatibility. The Medplum client has broad project membership; the gateway supplies its additional trusted-patient confinement and read-only tool surface.

## Evaluation results

The fixture SHA-256 is `bd2a9e1b13e794a8c06796fbb3e721cdf02db8620866cbce4eba82c96e43c8f8`. The source R4 package is `hl7.fhir.r4.core` 4.0.1, SHA-256 `b090bf929e1f665cf2c91583720849695bc38d2892a7c5037c56cb00817fb091`. Regeneration reproduced index SHA-256 `ec9f228fc467e1ee8a42f652f5718f0b47a9350a55645c57e33e35a2070b6f4c` byte-for-byte. [Source and license notices](../THIRD_PARTY_NOTICES.md) explain derivation.

| Format | Tasks passed | Comparable checks passed | Incomparable checks | Full MCP result bytes | FHIR calls / tool calls |
| --- | --- | --- | --- | --- | --- |
| Full sanitized FHIR | 35/35 | 132/132 | 1 | 98,584 | 68 / 39 |
| Compact | 35/35 | 123/123 | 10 | 91,556 | 68 / 39 |
| Selected fields | 35/35 | 132/132 | 1 | 84,361 | 68 / 39 |

Formats have identical per-task budgets and fixture inputs. Byte totals above are observations from the linked push run; serialized elapsed-time fields can change totals slightly across reruns. Different comparable-check denominators are explicit; fewer bytes do not establish a better clinical or agent outcome. There is no LLM, judge model, API key, clinical inference or competitor runtime in these scripted checks. Latency is descriptive only. [The evaluation method](../packages/evals/README.md) documents checks, budgets, limitations and rerun commands.

## Remaining release gates

The gateway remains synthetic-only, local stdio, one configured source and one trusted patient. It does not implement inbound remote MCP authorization, SMART user launch/PKCE, private-key backend services, verified granted scopes, production context/grant lifecycle, immediate opaque-token revocation, durable disclosure audit, profile validation, full numeric precision, terminology workflows, patient composites, or held-out agent/clinical evaluations. The fixed type catalog is R4 base data and does not validate arbitrary extensions. The reviewed long-term contract remains PLAN.md revision 0.2 with its original hash unchanged.

All source and dependency licenses still apply. Private repository status and the synthetic-only boundary remain in effect; no merge, publication or production deployment is part of this batch.
