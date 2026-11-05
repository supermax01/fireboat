# M3a hardening: status and evidence

- **Date:** 2026-10-19.
- **Contract:** [PLAN.md](../PLAN.md) revision 0.4, agreed by Claude and GPT. SHA-256 `1037978d4d59a36f544d314f0c3e46d3dda06b35f5c09bee4222f17d56f95621`.
- **Scope:** the synthetic-only, local stdio, single-trusted-patient, read-only gateway. Five tools: `fhir_capabilities`, `fhir_search`, `fhir_read`, `fhir_page`, `fhir_result`.

This page records what M3a fixed, who did what, and the evidence. It replaced [M2-STATUS](M2-STATUS.md) as the current status on 2026-10-19 and is now a historical record: the repository has moved on to M3b S5 (see [proposals/release-plan.md](../proposals/release-plan.md) §1 for current state until an S5 status page exists). The M1 and M2 records remain as historical evidence for their own revisions.

## How M3a was produced

1. **Joint audit.**
   - Claude and GPT audited the M1/M2 code and plan independently.
   - Claude's audit used eight reviewers, and each finding was verified adversarially.
   - GPT's audit is gpt-audit-r1.
   - The two then reconciled their findings into 46 agreed items (J-1 to J-46) and the PLAN 0.3/0.4 changes. Records are in [proposals/audit/](../proposals/audit/).
2. **Implementation.** Muse Code wrote all M3a code:
   - three isolated work packages;
   - two core integrations;
   - repairs A, B, C and D.
   Claude orchestrated, wrote the specifications, and re-ran every check independently after each step.
3. **Adversarial verification.**
   - After integration, 69 Claude agents verified every M3a item, and each reported gap was re-checked by a skeptic.
   - This found 35 gaps (V-1 to V-35), recorded in m3a-verification. Repairs A–C fixed them.
4. **Final cross-model review.**
   - GPT reviewed the whole M3a diff (gpt-m3a-final-review).
   - It found F-1 (high): an encoded conditional Patient reference could disclose a foreign identifier. It also found F-2 to F-5.
   - Repair D fixed all five. GPT's re-verification is recorded in the same file.

## What M3a fixed (selected)

| Area | Before M3a | Now |
| --- | --- | --- |
| Patient confinement | Lowercase-only reference check, so `HTTP://…/Patient/other` passed. Continuations could drop `patient=`. Encoded conditional references leaked identifiers. | References are parsed once and classified canonically. Conditional references are accepted only for literal, case-exact R4 types; every other conditional reference is denied, and the display and identifier of withheld references are removed. Next links must keep every original constraint before any fetch. Patient-targeting selectors, bare IDs included, are refused before execution. |
| Clinical fidelity | Compact output dropped `doNotPerform` silently. `7.0` failed a whole page. | Every projection keeps `isModifier` elements and choice variants. Types without a reviewed recipe fall back to full view with a warning. Source decimal lexemes are preserved end to end. |
| Agent usability | Text-only hosts saw only "N record(s)". The server locked up after about 125 calls. | Text carries the bounded envelope. The byte ceiling is enforced on the final wire result in both eras, error paths included. Each page is stored once, `res_` handles are best-effort and evicted oldest-first, and an idle purge runs. |
| Non-disclosure | Faults before authorization, 403 handling and page-1 totals could reveal existence or linkage. | Direct-read faults, including redirects and body-stage errors, give a uniform `NOT_FOUND`, with the cause kept only in the metadata-only audit. A plain 403 changes no state. Upstream totals are never published, and the authorization caveat does not depend on suppression. |
| Transport and auth | Ambient proxy settings could capture credentials. Compressed bytes were unmetered. Login races existed. | A controlled loopback client ignores ambient proxies and meters compressed and decoded bytes separately. Invalidation is scoped to a credential generation; late old-generation responses never clear fresh state; transient token faults preserve state. Cancellation and an overall deadline apply, with a fair admission queue. |
| Assurance | Guards could be deleted with tests still green. A test helper could never fail. Evals echoed the fixture. | Discriminating guard tests. A mutation gate in CI applies 36 designated mutants: 33 killed, 3 declared survivors, each with a justification. Evals assert outbound patient confinement on every upstream request, bind facts to responses, measure wire bytes independently, and run adversarial fixture modes in both eras. |

## Evidence at the M3a closing revision

Local results were run on Node 26.10.0. The full suite also passes locally on Node 24.21.0 and 24.22.0.

**Pushed CI at `2fd6b3b`.** All four jobs are green in both the [push run](https://github.com/supermax01/fhir-mcp-gateway/actions/runs/39211637076) and the [PR run](https://github.com/supermax01/fhir-mcp-gateway/actions/runs/39211640135). The jobs are:
- unit and MCP tests, with both eval eras;
- the mutation gate;
- pinned HAPI R4, including the new decoy-predicate checks;
- authenticated Medplum R4.

**What happened before that.** The first push of M3a (`56e8f51`) failed on Linux CI. Node 24.21's `Readable.toWeb` adapter delivers a late chunk after cancel ([nodejs/node#64529](https://github.com/nodejs/node/issues/64529)). This raised an uncaught `ERR_INVALID_STATE`, which made 9 auth-gateway tests fail and caused a later file to hang. Commit `2fd6b3b` replaces the adapter with a guarded bridge and adds deterministic cancel-path tests. Treat the counts below as the M3a closing results; the commit adds 10 cancel and uncaught-guard tests (253 in total).

| Check | Result |
| --- | --- |
| Typecheck and emitted build | Pass |
| Unit, integration and SDK tests | **253 / 253** (243 at repair D plus 10 stream-cancel and uncaught-guard tests) |
| Retrieval evals, modern era (2026-07-28) | 44 / 44 tasks × 3 formats; 157 / 157 comparable checks per arm; 1 incomparable; 0 known-defect |
| Retrieval evals, legacy era (2025-11-25) | Same results |
| Demo `--check` (source and compiled) and compiled `--negative-control` | Pass (8 outcomes; the negative control detects the deliberate mis-trust) |
| Mutation gate (`npm run mutation:guards`) | 33 killed, 3 declared survivors, no undeclared survivors |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |

Hashes:
- Eval fixture SHA-256: `4615f1757b45a4532827f0c5f451a7d2d51583f12c03e45963594360a70b0556`. It now includes the raw read bodies.
- Generated R4 index: `f8cecd47647ffac4e8441eca20fd13cb25aed2b7ea8877e125bd06e21b575c9f`. It has 208 base definitions and 7,462 elements, including `Element`.
- HL7 source package `hl7.fhir.r4.core` 4.0.1: `b090bf929e1f665cf2c91583720849695bc38d2892a7c5037c56cb00817fb091` (unchanged).

Measured result bytes are descriptive only. In the current suite the compact format is **not** smaller than full FHIR: 270,513 B against 266,371 B in the modern era. PLAN amendment A1 therefore forbids any efficiency claim until M3b delivers a measured win.

## Not yet established

The following are not established by M3a:
- any real model or agent task success;
- an unaided outside developer completing the quickstart;
- three independent host stacks;
- SMART user launch or Backend Services;
- remote serving;
- profile validation or clinical validation.

Synthetic results support this prototype's stated checks only.

## Next

M3b follows [proposals/m3b-spec.md](../proposals/m3b-spec.md), including Addendum A (adoptions from the competitor study in research/12). The order is:
1. Contract freeze (gate F).
2. Discovery and query-proof work (Q) in parallel with projection and delivery work (P).
3. Integration and packaging (R).

The validation gate comes before any remote or SMART work.
