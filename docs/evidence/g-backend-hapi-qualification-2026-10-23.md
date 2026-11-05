# G-BACKEND evidence: `hapi-r4-labs-v1` qualified on HAPI FHIR 8.12.0 (2026-10-23)

- **Gate:** G-BACKEND, a search profile proved on a FHIR server this project did not write (`proposals/release-plan.md` A8).
- **Result:** **passed for a narrow profile.** `hapi-r4-labs-v1` proves, on HAPI FHIR Server 8.12.0 only, Observation code tokens with an explicit system and `ge`/`lt` date bounds. It proves **no sort and no continuation**: HAPI's continuation links are opaque, so paged results against HAPI stay `unverified_continuation`. Everything else stays generic (declared syntax, execution unknown).
- **Recorded by:** root, from root's own re-run of the qualification; implemented by GPT-6 Astra in three rounds (`proposals/g-backend-external-qualification.md`).
- **Not established:** any other HAPI version or capability revision; sort or continuation proof on HAPI; any other server; real data; SMART authorization; clinical readiness. The image digest is an operator attestation (FHIR cannot attest which container image is running); the runtime binds the CapabilityStatement software name and version and the capability revision.

## Backend and corpus

| Item | Value |
| --- | --- |
| Server | HAPI FHIR Server 8.12.0 (CapabilityStatement `software`), FHIR 4.0.1, capability revision `0835b8480514fb73` |
| Image | `hapiproject/hapi:v8.12.0-2`, `sha256:0ff86aac4c7bd13a1ee226444a70263bb46ed1c28ef543c30a44f865b80ca04e` (arm64, digest matched Docker Hub's record), Colima 0.10.3 on macOS, port published on `127.0.0.1:18091` only, empty dedicated instance |
| Corpus | 52 synthetic resources across 8 types, loaded with fixed-id PUT transactions, read back exactly (ignoring only server-managed `meta.versionId`, `meta.lastUpdated` and an added `meta.source`) and censused before and after; transaction-body SHA-256 `bbd21aa1ede24de3c3cd59f8db5991e11b343b31f3700a6bdae3bf3e916e1404` |
| Corpus deviations | two fixture sentinels base64-encoded so HAPI accepts them as `base64Binary` (DocumentReference `content[0].attachment.data`, DiagnosticReport `presentedForm[0].data`); four projection-only resources not loaded (no task retrieves them); both recorded with hashes; no task expectation changed |
| Tasks | `packages/evals/data/hapi-profile-tasks.json` (four filter-only controls) plus every baseline, query and projection task classified as meaningful on a real server; task-corpus SHA-256 `8a649af6fda16c203f6e9bb62fcdf3cc7c9236655f1feb98bb0ff236dbf771ff` |

Applicability (`packages/evals/data/external-applicability.json`): baseline 35 real-backend / 9 fixture-simulated; query 22 / 8; projection 2 / 3. Fixture-simulated tasks depend on behaviour only the fixture backend provides (for example a server that ignores a filter, or the fixture's own CapabilityStatement catalogue) and do not run against HAPI; each carries its reason.

## Root re-run (Node 24.22.0, macOS arm64)

| Check | Result |
| --- | --- |
| `FHIR_MCP_HAPI_BASE_URL=http://127.0.0.1:18091/fhir node --import tsx scripts/qualify-hapi-search-profile.ts .local/gbackend-qualification-root` | exit 0; per era 165 public passes and 12 private-control passes (4 controls × 3 arms), 0 failures, 0 pending; identical in both eras |
| Opaque continuations | every opaque `_getpages` request matched exactly one link HAPI issued earlier in the same confined chain (the B2 opaque-token rule, now in the eval invariant) |
| `npm run check` | 1,962 of 1,962 before the eligible-state test update; 1,967 of 1,967 after it |
| Public selection, live | `tests/integration/gbackend-hapi-public.test.ts` with `FHIR_MCP_HAPI_BASE_URL`: 7 of 7 (both eras, every format: exact membership, `tested_adapter` code and date proof, sorts and continuations unverified, systemless codes unknown); skipped cleanly without the variable |
| Fixture evals, both eras | 77 of 77 tasks per arm, unchanged |
| Raw reports | gitignored `.local/gbackend-qualification-root/`: `report-modern.json` `126aab4f1bc587bdc92f6bfe397451bfa46f3ada34bb65655cb96bb9a915803e`, `report-legacy.json` `4266a2a938e821b20aacdbfbbf1d32a6726900d461492ee7696abc9eb39f89bd` |

Recorded evidence (in `packages/core/src/data/search-profiles.json`): `report_sha256 f9f95bde48dd2d29716b89089a54779fb8d4700dbb04e30cfcbfda293996d51e`, `recorded_at 2026-10-23T21:20:40.922Z`, `capability_revision 0835b8480514fb73`, `tasks_sha256 8a649af6fda16c203f6e9bb62fcdf3cc7c9236655f1feb98bb0ff236dbf771ff`.

## What the four controls prove

Each searches Observation code `http://loinc.org|4548-4` and checks the exact member set, `complete_for_query`, `query_exhausted: true`, `execution: tested_adapter` for every constraint, and the absence of decoys: a different code, the same code under another system, a systemless code, and records just before the lower and just after the upper date bound. A server that ignored the system, the code or either bound fails at least one control.

## Root decisions

1. **Opaque paging provenance.** The eval's upstream-confinement invariant accepts a clinical request without a visible patient pair only when it is exactly a link the same source issued earlier in the same confined task chain; forged, foreign-chain or altered links still fail. This is the rule the B2 isolation runner already applies; it changes no task expectation.
2. **Narrow scope.** The full declared scope (sorts and continuations) does not qualify on HAPI and is not claimed. Verifying HAPI's opaque continuations is a follow-up design question.
3. **Evidence from root's run.** The registry records the evidence of root's own re-run, not the implementer's.
