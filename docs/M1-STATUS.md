# First milestone: ready for synthetic preview

> **Historical record.** This is evidence for revision `e9872bc` only. M2's claimed R3-1 closure was incomplete; M3a added the primitive-companion repairs. The current sequence is PLAN 0.4 → M3a → M3b → validation gate → one selected remote/SMART path, and Claude–GPT plan agreement is complete. See [M3A-STATUS.md](M3A-STATUS.md) for current state; the counts and decisions below are preserved as originally recorded.


Reviewed implementation: `e9872bcabb97f8fb9b6524418b2564b7e51a3722`, 2026-10-18. The final documentation commit adds the review and this evidence record without changing implementation, dependencies, fixtures, tests, or CI.

The local stdio gateway implements five tools: capabilities, patient-bound search, exact-ID read, bounded continuation, and retained-result inspection/projection. It accepts one trusted synthetic patient and one configured literal-loopback FHIR source. The package and GitHub repository remain private; this is a development preview.

## Acceptance evidence

| Check | Evidence at the reviewed implementation |
| --- | --- |
| Type checking, build, and regression suite | 39/39 tests pass on Node 24 and Node 26; CI uses Node 24. |
| Actual MCP clients | In-memory and stdio subprocess clients, modern `2026-07-28` negotiation, exactly five tools, schemas and structured results. |
| Runnable examples | Source and compiled SDK demos pass and clean up their processes. |
| Real FHIR backend | Pinned HAPI R4.0.1 container: three pages, three authorized observations, wrong-patient denial, inline-payload withholding. |
| CI | Push run 39157010653 (private development repository) and PR run 39157014483 (private development repository), both successful at the exact reviewed commit. |
| Dependency check | Production dependency audit passes in those CI runs. |
| Independent implementation review | Muse round 3: **READY_FOR_SYNTHETIC_PREVIEW**, F1–F5 and R2-1 resolved. Original findings and responses remain preserved beside it. |

Actual HAPI evidence comes from GitHub CI; Docker is not installed in the local development environment. These checks cover the recorded flows on the pinned image, not general vendor compatibility or clinical history completeness.

## Accepted limitations and next gates

R3-1 is a known, non-blocking limitation for this trusted synthetic preview: relative query/fragment links in some canonical metadata elements, including `valueSet`, `baseDefinition`, `supportedProfile`, `implicitRules`, and `contentReference`, can pass the element-name heuristic. Absolute URI forms are screened. README now states the exact boundary. Replace this heuristic with schema-based URI classification and add these cases before accepting non-synthetic, authenticated, or untrusted sources. Merely connecting a production URL is not supported by the current loopback-only configuration.

Cursor replay can allocate additional handles within the same quota and absolute expiry. Non-Patient references remain opaque data and are never hydrated. Metadata and audit records are process-local. These limits are explicit in README and remain follow-up work.

The next implementation milestone must establish separate inbound MCP and outbound SMART authorization, source/grant/context binding and revocation, and authenticated integration evidence. Medplum is the next backend target; an actual test endpoint and credentials must be configured before claiming support. HTTP serving, terminology, clinical context composites, reviewed operations, history/vread, and multi-tenant deployment remain later gates in [PLAN.md](../PLAN.md). Claude architecture sign-off remains pending availability; no three-model consensus is claimed.
