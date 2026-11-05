# S7a usability revision: design and root decisions

- **Status:** decided by root (Claude), 2026-10-24. Design proposal by GPT-6.1-Sol (standard mode, maximum reasoning), 2026-10-23, on `candidate/build` at `e893599`; reproduced unchanged below the decisions. Its measurement and probe files stayed in the design job's scratch directory and are not in the repository; the report SHA-256 in §3 identifies the recommended capture.
- **Inputs:** the outside-host usability findings in `docs/evidence/g-host-claude-code-2026-10-23.md` (items 1–7 against the synthetic source, addendum items 8–11 against HAPI FHIR 8.12.0).
- **Contract:** PLAN 0.4.1 stays the product contract. This revision changes the application schema (0.2 → 0.3) and the catalog revision (`m3b-catalog/2` → `m3b-catalog/3`); it changes no PLAN rule, cap, confinement boundary or release scope. It is recorded as `proposals/m3b-spec.md` Addendum D and release-plan amendment A9.

## Root decisions

Checked against PLAN 0.4.1 and the strict delivery gate before adoption (root rule: review-fix decisions are verified against the contract before dispatch).

| # | Decision | Contract check |
| --- | --- | --- |
| R1 | **Adopt schema 0.3 as proposed in §4**, amended by R2 and R3: error-only `query_evidence: "none"` (required iff an error, rejected on every success); server capabilities paged through the existing discovery cursor, with freshness fields; the configured `patient_id` in server data; the registered `METADATA_BYTE_LIMIT` warning; `fhir_page` inherits the original search's `_count` as its delivery ceiling, with no new input; catalog revision 3. | PLAN's capabilities row asks for "evidence, version, and freshness" (`PLAN.md:89`); the new `snapshot_revision`, `captured_at` and `expires_at` supply freshness. PLAN's discovery-cursor rule (`PLAN.md:120`) keeps non-patient-specific metadata snapshots unbound to a patient: the server snapshot stores rows and metadata only, and `patient_id` is injected from trusted configuration when each response is built, never stored in the snapshot or taken from source content or tool input. The patient id is already disclosed to the same caller by `topic=context`; no selection, enumeration or switching is added (PLAN §5). |
| R2 | **Server row order.** Required types in required-resource order (`Patient`, `Observation`); then the optional workflow types (today `DiagnosticReport`); then every other advertised type the gateway can execute (non-empty `implemented_interactions`) in codepoint order; then the remaining advertised types in codepoint order. Never invent a row for a type the source does not advertise. | Ordering only; with the default `limit` of 20 the first page shows the workflow types and the types a caller can actually use. |
| R3 | **Catalog wording.** §4.5's strings are a measured starting point, not frozen text. Keep A3 (fresh capture; every changed tool equal or smaller; no cap change). Two of the proposed strings lose meaning and must be fixed within the caps: `fhir_read` must still say what `result.handle` is for (as today's "Recover via result.handle"), and `fhir_search` `params` must keep "repetition evidence may be unknown". No description may drop an action it states today. Fund any shortfall from the `context_handle` wording (preferred: `Optional; omit=fixed binding`; shorter acceptable if it still says the handle may be omitted only for the fixed binding). Report the exact final strings and bytes. | A3 (`proposals/release-plan.md`), Addendum B caps unchanged. |
| R4 | **Terminal unverified continuations keep `has_more: null`** with `query_exhausted: null`, and the gate is tightened so `false` cannot replace `null` on a terminal chain whose trusted state is unverified. | S6 meaning (`proposals/m3b-s6-design.md`, `proposals/CONSENSUS.md`). |
| R5 | **Documentation only** for findings 4 (pagination versus coverage scope), 10 (dotted selectors versus slash omission paths) and 11 (metadata dimensions); S7 docs carry them. | No oracle or gate change. |
| R6 | **Isolation.** Extend the existing CUR/MET/ERR coverage to the new server-cursor route and the `none` label, with authorized positive controls and exact refusals; refresh only the affected pins (`generate-manifest.mjs --hashes-only`, mutants last). No counted-case credit is earned by this work; B2-1 remains the counted expansion. | B2-0 machinery unchanged. |
| R7 | **One implementation job** in its own worktree (`candidate/s7a`), followed by root review, root verification and an official 14-shard aggregate on the integrated tree. The packaging leaf slices run in parallel in a separate worktree on disjoint files (`proposals/m3b-s8s9-design.md`). | AGENTS.md: one writer per file. |

Owner decisions needed: none. The revision keeps every cap, confinement rule, disclosure boundary and the release scope.

---

## Proposal (GPT-6.1-Sol, 2026-10-23)

**Recommendation:** make one coordinated application revision, **schema 0.3, the S7a usability revision**. Add error evidence `none`; page the server capability summary through existing discovery-cursor machinery; disclose the existing patient binding in that summary; register a metadata byte-limit warning; inherit the original search size when delivering continuations; and rebalance catalog wording within the existing caps. Keep unknown-continuation and retained-coverage semantics, dotted selectors, omission disclosures, and the search-evidence labels.

This is a proposal for Claude/root to decide and brief. Baseline: `candidate/build`, `e893599730ac43403630331e02bb4511db271fd1`, 2026-10-23. `AGENTS.md` was read. No tracked worktree files or git state were changed. All experiments and this document are under the requested `scratchpad/sol/s7a/`. The initial untracked `node_modules` symlink is unchanged. The scratch programs are measurement/probe prototypes, **not an implementation of the proposed release**.

All repository `file:line` citations below refer to that baseline. `contracts.ts`, `index.ts`, `catalog.ts`, `query.ts`, `discovery.ts`, `privacy.ts`, `projection.ts`, `search-parameters.ts`, and `m3b.ts` mean files under `packages/core/src/`; “spec” means `proposals/m3b-spec.md`. The input findings are `docs/evidence/g-host-claude-code-2026-10-23.md:47–71`.

## 1. Findings: present behavior and its authority

| Finding | What the code does today | Contract/decision that requires it, or the implementation choice where none does |
| --- | --- | --- |
| **1. Error evidence** | Clinical errors use `unverified_continuation`; capabilities errors use `metadata_snapshot`. Both ordinary and emergency constructors do so (`index.ts:634–637,668–680`). The enum lacks `none` (`contracts.ts:182`); the gate explicitly requires those error labels (`contracts.ts:540–546`). | Spec §7’s six-value enum (`spec:626–629`) and the frozen serving gate require this representation. The error decision is nevertheless “unknown; no resources” (`spec:665–670`); no actual continuation or successful metadata snapshot is established by an error. |
| **2. Page size** | **`fhir_page` has no public `page_size` argument**, and supplying one is an argument fault (`contracts.ts:143–146`). Its renderer falls back to 100 (`index.ts:928`), including `requested_page_size` (`index.ts:964–967`). The frozen outbound query still contains the search’s `_count` (`index.ts:1465–1484`); following a next URL does not replace it with 100. | Spec §0.3 explicitly omits the argument (`spec:110–125`). §2 defines initial upstream match requests and smaller wire deliveries (`spec:360–362`); §7 excludes paging mechanics from material query identity (`spec:632,636`). **No normative text requires the renderer’s 100 fallback or a separately configurable continuation size.** The continuation validator permits source paging mechanics, including count, to vary (`index.ts:1685–1686`). |
| **3. Terminal unverified continuation** | Without retained remainder or next URL, an unverified chain produces `has_more:null`, `query_exhausted:null`, partial coverage, and an unverified-continuation warning (`index.ts:566–591,954–967`; `query.ts:901–922`). | Spec §7 says exhaustion is null for unknown/rejected continuation (`spec:640`) and explicitly requires null for an unsafe next link (`spec:663`). S6 calls an unverified continuation “a remainder of unknown extent,” sticky for the rest of the chain (`proposals/CONSENSUS.md:173`; `proposals/m3b-s6-design.md:14`). It does **not** redefine `has_more` as merely “a cursor is available.” |
| **4. Pagination versus coverage scopes** | `fhir_result` pages its retained slice with local `next_offset` and boolean `has_more`; coverage remains partial/retained with null query exhaustion and may retain query/remainder limitations (`contracts.ts:627–632`; `index.ts:548–577,960–967`; `query.ts:897–922`). | Spec §2 distinguishes the retained upstream-page slice from chart/query (`spec:362`). §7 expressly requires retained partial coverage, null exhaustion, and `retained_snapshot` (`spec:642`). Thus a fully delivered retained slice does not clear the originating query’s `MORE_PAGES` limitation. |
| **5. Binding in default capabilities** | Only `topic=context` puts the configured `patient_id` in `data` (`index.ts:1284–1285`). Every envelope already carries the context handle. Server data has no patient field (`contracts.ts:224–237`). | The strict server/context data shapes specify those placements (`spec:206–233`); `spec:233` permits patient-id disclosure within the existing trusted binding. PLAN §5 (`PLAN.md:83–85`) allows omission only for the immutable trusted binding. There is no rule requiring that an authorized caller discover the same binding through a second call; adding it to server data does require a shape amendment. |
| **6. “Trusted” context guidance** | Four tools say only `Trusted.`; capabilities has the more useful omission rule (`catalog.ts:75–136`). Admission compares any supplied handle to the configured one (`index.ts:848–849`). | PLAN §5 (`PLAN.md:83–85`) and spec §2 (`spec:358`) require the immutable-binding rule. The exact terse copy is the measured catalog choice, not an authorization requirement. |
| **7. Terse descriptions** | Locally compiled tool/property text is emitted by the production adapter (`catalog.ts:60–136`; `packages/server/src/index.ts:48–56`). | Spec §2 and A.6 require concrete guidance (`spec:356–369,904–914`). Addendum B fixes the minimal output schema and catalog caps (`spec:965–1005`); release-plan A3 requires fresh capture/measurement and equal-or-lower bytes for each changed tool (`proposals/release-plan.md:51`). Brevity alone is not a guarantee to preserve. |
| **8. Truncated server summary** | Source entries are taken in their current order, sliced to 100, then reduced further if needed. `resource_count` retains the total; incomplete summaries get `CAPABILITY_SUMMARY_LIMIT`, but no continuation (`index.ts:1295–1307`). Resources are capped at 100 and `definition_limit` is literally 100 (`contracts.ts:224–232`). | The bounded summary and literal limit are specified (`spec:206–233,577`). Current cursor combinations allow only search-parameter/support discovery (`spec:259`; `contracts.ts:152–156`). These require a bounded summary, **not source order or permanent inaccessibility of the tail**. Server paging needs an explicit amendment. |
| **9. Byte-limited metadata rows** | The packer decrements returned rows, sets `budget.limit_reached`, and advances a cursor by the actual returned count (`index.ts:1236–1265`). Schema discovery similarly reduces elements and recomputes `next_offset` (`index.ts:1270–1281`). No warning explains the reduction. | Shrinking without skipping, with `OUTPUT_LIMIT` for an indivisible oversized row, is required (`spec:348,548`). The missing warning is not required. **Warning codes are strings in Zod** (`contracts.ts:121`), but the strict gate accepts only codes and exact messages in `WARNING_MESSAGES` (`contracts.ts:531–532`; `catalog.ts:20–36`). The effective serving warning vocabulary is closed. |
| **10. Two path notations** | Selectors use bounded dotted paths (`contracts.ts:99–101`; `privacy.ts:578–615`). Omission disclosures use resource-relative slash paths (`projection.ts:98–107,140–155`; `privacy.ts:455–459,493–498`). Some policy paths include indices/primitive companions or `[undeclared-property]`; some projection array paths intentionally omit indices. | Dotted selector syntax and modifier/companion preservation are normative (`spec:55–59,361`). Actual omission disclosure is normative (`spec:158`). The string output schema does not mandate a new dotted output grammar. Calling every existing omission path a fully round-trippable RFC 6901 pointer would overstate what the implementation provides. |
| **11. Metadata “contradictions”** | `executable` means locally permitted syntax. Source support, definition provenance, and execution proof are separate (`search-parameters.ts:258–292`). `_sort` can be an approved gateway control without a source declaration. Type/duplicate/canonical conflicts mark a definition conflict and prevent execution. Discovery currently passes no proving profile (`index.ts:1232`), so `execution_evidence` stays unknown. | Spec §1 explicitly separates these labels and defines “Executable” as permission to send syntax, not proof of enforcement (`spec:298–312`). S6 deliberately leaves discovery execution-proof wiring out (`proposals/m3b-s6-design.md:18`). The captured HAPI rows show `_sort`: `approved_overlay`, `evidence:unknown`, `executable:true`, `execution_evidence:unknown`; `_filter`: `conflict`, `executable:false`, `execution_evidence:unknown`. Those are consistent dimensions, not permission to trust a filter. |

## 2. Options and compatibility

“Strict 0.2 host” below means a consumer enforcing the published full contract, including its semantic gate. A host using only the **listed 97-byte output schema** merely checks an object with string `schema_version`; it will accept a 0.3 string. SDK 2.3.1 also skips output validation on `isError` results (`spec:975`). Those weaker checks must not be confused with full-contract compatibility.

Measurements named **M0–M14** are in §3. Documentation alone uses the captured unchanged baseline, M0. Every option affecting a listed shape or text has a corresponding capture; output-only options are also captured, rather than charging their full schema bytes to the minimal listing.

| Finding | Documentation only / behavior within 0.2 / contract alternative | Recommendation and version effect |
| --- | --- | --- |
| **1** | **D:** explain the historical labels; M0. **B:** no honest new label can be emitted inside the frozen enum/gate. **C:** add `coverage.query_evidence=none`, error-only, for **all five tools**, and replace the old error gate rule; M1. Old strict schemas reject the value, and the old gate rejects it even if its enum is enlarged alone. | **C, in 0.3.** Keep every other error invariant and reject `none` on success. Both clinical and metadata failures have no delivered query evidence. |
| **2** | **D:** document the 100 delivery fallback; M0. **B:** derive the per-delivery ceiling from the original validated `_count`; M2. Existing successful 0.2 shapes/gate accept it. **C:** add optional `fhir_page.page_size` with a per-response override, changing strict/listed input schemas and its description; M3. A strict old host rejects that new argument; the old gateway returns `INVALID_ARGUMENTS`. | **B; no standalone schema bump needed.** Ship in the coordinated 0.3 release. Keep `fhir_page` without an override. It drains at most the original search size per result, potentially fewer for bytes, without rewriting a source continuation URL. |
| **3** | **D:** explain unknown remainder and “stop when no cursor”; M0. **B:** no semantic change is needed. **C:** redefine `has_more:false` to mean no currently usable continuation while keeping exhaustion null; M4. The current shape **and cross-field gate already accept this pair**, but it changes the S6 meaning. `stopReasonFor` would classify it as exhausted (`delivery.ts:154–158`), although the structured-text restatement suppresses that claim (`delivery.ts:167–173`). | **D plus a gate tightening**, no standalone bump. Keep null; explicitly reject false on terminal chains whose trusted continuation flag is unverified. If root chooses false instead, record a 0.3 semantic amendment and change stop-state consumers/oracles; do not relax rejected-link or completeness rules. |
| **4** | **D:** explain local retained pagination versus originating-query coverage; M0. **B:** wording/examples may improve without changing either truth claim. **C:** add `pagination.scope` (`query_chain`, `resource`, `retained_slice`) to the strict output shape; M5. Old strict objects reject the extra field; the existing gate would need explicit scope binding. | **D, no bump.** Current `coverage.scope`, retained inspection’s scope, and `next_offset` already convey the distinction. Do not clear `MORE_PAGES` merely because this retained response has no local remainder. |
| **5** | **D:** point hosts to context discovery; M0. **B:** there is no place to add `patient_id` inside today’s strict server-data shape. **C:** add required `serverData.patient_id` with the existing context-discovery bounds and bind it to trusted configuration; M6. Old strict server-data schemas reject the field. | **C, in 0.3.** Put the existing ID in server `data`, not in tool listing/instructions, a new selector, or a new top-level context field. No extra patient lookup. |
| **6** | **D:** explain omission and how to echo `context.handle`; M0. **B:** change trusted descriptions only; isolated copy change M7, then funded package M14. Validators/defaults stay identical. **C:** making the argument required or introducing a patient selector changes input schemas and would contradict the fixed-local-binding workflow. | **B plus docs; no standalone bump.** Use `Optional; omit=fixed binding` on all five tools, with full conditional rules in docs. Do not add an authorization mechanism. |
| **7** | **D:** put longer workflows/examples in S7 docs; M0. **B:** reallocate existing description bytes, including useful context and dotted-path guidance; M14. Strict input/output validators remain compatible, but listing hashes change. **C:** enlarging the listed output schema or caps reopens Addendum B/A3; it is unnecessary. | **B plus docs; catalog revision 3, no standalone envelope bump.** Keep the 97-byte schema, all tools, annotations, limits and caps. The complete new wording is enumerated in §4. |
| **8** | **D:** advertise truncation and the already available `topic=support`/per-resource views; M0. These do not enumerate the source’s tail. **B:** put advertised required/workflow types first; M8, compatible with 0.2 but still not a complete enumeration. **C:** add protected server discovery cursors and freshness fields, M9; or allow server offsets and add `next_offset`, M10. Both extend contract semantics/output shapes; old gates reject new server keys. Combining cursor and offset adds two ways to page the same list. | **Priority order plus cursor, in 0.3.** Priority alone is the smallest visibility fix; **priority plus one existing cursor mechanism is the smallest complete fix**. Reuse `limit`, honor its default 20/max 50, and keep offsets schema-only. No new input property. |
| **9** | **D:** explain `limit_reached` and the returned continuation; M0. **B:** retain those existing controls; no registered warning currently means “gateway reduced metadata rows for bytes.” **C:** register `METADATA_BYTE_LIMIT` and emit it only on actual byte-driven reduction; M11. A schema-only 0.2 validator accepts its string code; the old strict gate rejects the unregistered code. Reusing `SOURCE_OUTCOME` would falsely attribute the event to the source. | **C, grouped into 0.3.** There is no Zod enum to enlarge, but this is an extension of the gate’s closed warning catalog. It does not independently require an enum-driven bump; co-version it so a full-contract consumer receives the new allowed message table. |
| **10** | **D:** distinguish dotted selectors from slash omission locations, including array and companion examples; M0. **B:** no safe universal conversion exists within unchanged selector/omission semantics. **C:** migrate omissions to a new dotted output grammar, M12, or selectors/schema paths/repairs to JSON pointers, M13. Dotted-output strings might pass an old schema while silently changing their meaning; new pointer inputs fail old selector validation. Either needs a versioned parser/projection/omission migration, not a formatting substitution. | **D, no bump.** Keep dotted input and unresolved selectors; keep existing omission paths. A single notation is not worth losing location/placeholder information or changing array selection. Do not imply that omitted/withheld fields are all recoverable. |
| **11** | **D:** provide a trust table and the two HAPI examples; M0. **B:** preserve correct labels and fail-closed conflicts; do not promote discovery proof from mere executable syntax or from S6’s profile existence. **C:** rename `executable` to `syntax_permitted` in parameter/modifier/comparator output rows, M0-sized measured variant, or add another explanatory field. Old strict objects reject a rename/addition; evals need new paths and proof oracles. | **D, no bump.** Explain the four dimensions. Keep `execution_evidence:unknown` in discovery unless a separately scoped proof integration is designed and verified. Do not erase `conflict`, enable `_filter`, or advertise sort proof. |

For alternatives that are **not recommended**, the additional verification cost is explicit:

| Alternative | Gate, eval, isolation and registry effect beyond ordinary version migration |
| --- | --- |
| Page-size override (#2 C) | Admit and bind an explicit per-call ceiling; distinguish it from original `_count` and source next-link count. Add override/default/replay tests, unknown-key compatibility controls and a wrong-override mutant. Existing query/source/context restrictions and CUR selectors remain closed. Resolve its measured catalog breaches before considering it. |
| Terminal false/null (#3 C) | Amend S6 semantics, update `stopReasonFor` and every stop-state metric/oracle so false alone never means exhausted. Change only the opaque-terminal expectations, not unsafe-link null expectations; retain sticky unverified proof/partial coverage. Add a false-implies-complete mutant and new positive unknown-stop controls. Merely making an old test accept either boolean/null would weaken it. |
| Pagination scope field (#4 C) | Require and bind the field per tool/action, migrate all pagination-bearing fixtures, add wrong-scope/missing-scope gate negatives and corresponding mutants. Existing retained offset/query-coverage oracles and isolation guarantees do not disappear. |
| Priority only / server offset (#8 B/C) | Priority alone changes order pins and needs a dropped-priority discriminator but leaves tail truncation honest and unresolved. Offset paging changes the topic/offset admission oracle, server strict output and freshness semantics; add revision-between-offset-pages, skip/duplicate, terminal-before-tail and offset-admission mutants. It must disclose invalidation rather than silently combine two source revisions. Existing cursor protections still apply to the other topics. |
| Dotted omissions / pointer selectors (#10 C) | Rewrite selector/schema-path/repair parsing or omission grammar deliberately; migrate omission equality checks, nested/array/companion/placeholder fixtures, generated examples and field-safety mutants. Old omission strings may remain shape-valid while semantically incompatible. Preserve exact actual-omission disclosure, modifier/companion protection and non-recoverable withholding; do not simplify a sanitizer or relax unsafe-path tests to get notation agreement. |
| Rename/add metadata explanation (#11 C) | Change parameter and nested syntax-support strict outputs and all corresponding eval paths/fixtures. Add alias-drift/permission-proof-confusion mutants; preserve conflict refusal, unknown execution and metadata canary tests. An additional safe fixed conflict-reason enum would need its own gate binding and negative controls, not source diagnostics. |

Documentation-only choices change none of the runtime gate, eval or isolation oracles or mutation intents. Catalog-copy choices additionally require listing/artifact/hash and guidance-guard updates; they do not alter authorization fixtures. Every chosen runtime extension requires fresh candidate-bound verification even if its schema-only listing delta is zero.

## 3. Measured catalog impact

I copied tracked source files without creating/copying `.git`, reused the installed pinned dependencies read-only, built each candidate with **Node 24.22.0**, and ran the existing `scripts/capture-tool-catalog.ts` followed by the unchanged `scripts/measure-tool-catalog.py --exploratory`. The capture script’s sole instrumentation change makes its **read-only git provenance queries** use the original worktree with `GIT_OPTIONAL_LOCKS=0`; its actual source hashes, compiled imports, SDK factory, capture boundary and measurements still use the scratch tree.

Every capture includes actual SDK listings in **2026-07-28 and 2025-11-25**, every currently public/selectable delivery profile (full-text only), zero upstream connections, list-result/frame metadata, and both locked tokenizer encodings. No new dependency was installed. Existing tokenizer environment: `/tmp/fireboat-s58b-ci/venv`, verified `cache` and `wheels`. These are **exploratory macOS measurements**, not the deferred pinned Linux-container gate or outside-host acceptance. Shape-only alternatives measure listing cost; they do not implement their proposed runtime semantics.

Per-tool order in the following table is **capabilities/search/read/page/result**. Bytes are identical across the two captured eras; token ordering differences are included in each report.

| ID / experiment directory under `measurements/` | Per-tool bytes | Tools total | Complete catalog | Result |
| --- | --- | ---: | ---: | --- |
| **M0** `baseline` | 2199 / 1750 / 1397 / 1100 / 1647 | 8093 | 8399 | Pass; 7 B tools headroom |
| **M1** `error-none` | same as M0 | 8093 | 8399 | Pass; **0 B listing delta** |
| **M2** `page-inherit` | same as M0 | 8093 | 8399 | Pass; **0 B** |
| **M3** `page-size-argument` | 2199 / 1750 / 1397 / **1201** / 1647 | **8194** | **8500** | Fails page cap by 101 B, tools cap by 94 B, complete cap by 50 B |
| **M4** `terminal-unverified-false` | same as M0 | 8093 | 8399 | Pass; **0 B** |
| **M5** `pagination-scope-with-resource` | same as M0 | 8093 | 8399 | Pass; **0 B**; full output shapes are not listed |
| **M6** `server-binding` | same as M0 | 8093 | 8399 | Pass; **0 B** |
| **M7** `context-guidance-alone` | 2191 / **1771 / 1418 / 1121 / 1668** | **8169** | **8475** | Fails; longer guidance must be funded elsewhere. This isolated variant includes a terminal period |
| **M8** `server-priority` | same as M0 | 8093 | 8399 | Pass; **0 B** |
| **M9** `server-cursor-alone` | **2206** / 1750 / 1397 / 1100 / 1647 | 8100 | 8406 | Fails capabilities cap by 6 B; +7 B is cursor guidance, not the output fields |
| **M10** `server-offset-alone` | **2201** / 1750 / 1397 / 1100 / 1647 | 8095 | 8401 | Fails capabilities cap by 1 B; +2 B is offset guidance |
| **M11** `metadata-byte-warning` | same as M0 | 8093 | 8399 | Pass; **0 B** |
| **M12** `dotted-omissions` | same as M0 | 8093 | 8399 | Pass; **0 B**. The schema-only trial is intentionally insufficient for real companion/index/placeholder paths |
| **M13** `pointer-inputs-with-guidance` | 2187 / 1738 / 1378 / 1088 / 1600 | 7991 | 8297 | Pass; −102 B total; input grammar plus guidance only, not a runtime migration |
| **M14** `recommended` | **2192 / 1750 / 1397 / 1099 / 1646** | **8084** | **8390** | **Pass, including A3: every changed tool is equal or smaller** |

The measured `syntax-permitted-rename` output-schema alternative also has exactly M0’s listing bytes. Documentation-only options emit exactly M0’s listing. The unlisted strict enum/output additions do not grow the five minimal listed schemas.

| Recommended boundary | Before → proposed | Cap | Proposed headroom |
| --- | ---: | ---: | ---: |
| Capabilities | 2199 → 2192 B | 2200 B | 8 B |
| Search | 1750 → 1750 B | 1750 B | 0 B |
| Read | 1397 → 1397 B | 1400 B | 3 B |
| Page | 1100 → 1099 B | 1100 B | 1 B |
| Result | 1647 → 1646 B | 1650 B | 4 B |
| Tools total | 8093 → 8084 B | 8100 B | 16 B |
| Instructions | 158 → 158 B | 160 B | 2 B |
| Context plus separators, including instructions | 306 → 306 B | 350 B | 44 B |
| Complete catalog | 8399 → 8390 B | 8450 B | 60 B |
| Published output spine | 1989 → 1989 B | 2000 B | 11 B |
| Each listed output schema | 97 → 97 B | 100 B | 3 B |

Recommended maximum tokens across eras/encodings: per tool **543/444/368/271/405**; tools sum **2031/2350**; context **76/150**; complete **2103/2500**; conservative segment sum **2107/2500**. Complete/conservative counts are modern cl100k **2054/2059**, legacy cl100k **2059/2064**, and both eras o200k **2103/2107**. This is a 9-byte saving, not a token-saving claim: baseline maximum complete/conservative counts were 2096/2100.

Evidence: `measure_variants.py`, `measurement-notes.txt`, per-variant `source.patch`, capture manifests and source/compiled hashes, `tokens/report.json`, and `MEASUREMENTS.json`. Recommended report SHA-256: `07605b3e8109141a236214d8f0a80d8e268d1a3047bd045ed8fcbfa1aabd6cf4`.

## 4. Proposed schema 0.3 revision, in full

This is the **entire public delta**. All other 0.2 field shapes, confinement rules, omission guarantees, query/sort proofs, uniform-read behavior, budgets, absolute expiries and delivery gates remain requirements. Record this as a root amendment to the spec and consensus record before implementation.

### 4.1 Version and evidence

All emitted envelopes, including admission faults, ordinary errors, fitted errors, and the independent startup-validated emergency template, carry `schema_version:'0.3'`.

`coverage.query_evidence` becomes this closed enum:

```ts
z.enum([
  'none', 'metadata_snapshot', 'exact_id_and_subject_linkage',
  'declared_and_self_link_only', 'tested_adapter',
  'unverified_continuation', 'retained_snapshot',
])
```

`none` means **this error response delivers no query evidence**; it does not claim that no upstream work occurred. It is required iff an application `error` is present. For every tool, errors retain empty data, no provenance/result/pagination/warnings, clean transform arrays, unknown coverage, null exhaustion, zero observed pages, and no constraints/digest/sort/shorthand. Clinical scope/caveats and uniform `NOT_FOUND` messages/repairs stay as today. A failed metadata call also uses `none`, rather than claiming a metadata snapshot.

Reject `none` on every success, including empty successful searches. Restrict internal successful `QueryEvidence.evidenceKind` to exclude `none`, and keep `NO_MATCHES` ineligible for it. Change the rule at `contracts.ts:541` to require `none`; enlarging the enum alone is insufficient. Keep all subsequent error checks.

### 4.2 Server capabilities and binding

Successful server/default capabilities use this strict data shape, expressed with the existing named validators:

```ts
z.strictObject({
  source: sourceAliasSchema,
  fhir_version: z.string().max(40),
  patient_id: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/), // NEW
  network_confinement: z.literal('literal_loopback'),
  data_classification: z.literal('operator_declared_synthetic_unverified'),
  implemented_tools: z.array(z.enum(TOOL_NAMES)).length(5),
  resources: z.array(z.strictObject({
    type: resourceTypeSchema,
    resource_class: z.enum(['patient', 'shared', 'ambiguous']),
    implemented_interactions: z.array(z.enum(['read', 'search-type'])).max(2),
  })).max(100),
  resource_count: nonnegativeIntSchema,
  definition_limit: z.literal(100),
  snapshot_revision: z.string().max(80),                   // NEW
  captured_at: isoDatetimeSchema,                        // NEW
  expires_at: isoDatetimeSchema,                         // NEW
  next_cursor: handleSchema.optional(),                  // NEW
  workflow: z.literal('recent-labs-v1'),
  support_matrix_revision: z.string().max(80),
  required_resources: z.tuple([z.literal('Patient'), z.literal('Observation')]),
  document_support: z.literal('metadata_only'),
})
```

`patient_id` is exactly the already configured, immutable binding disclosed by context discovery. Inject it at response construction, compare it to trusted invocation state, and never derive it from source prose or tool input. Do not put it in globally reusable source metadata, tool listings, instructions, audit logs, doctor output, or ordinary diagnostics. The server response is now explicitly binding-specific. No patient read, enumeration, switching, or permission inference is introduced. This amends the server data shape; it does not add a new patient-selection mechanism to `context`.

Server pagination rules:

1. Extend **existing** `fhir_capabilities.cursor` applicability to `topic=server`. Search-parameter/support behavior remains unchanged; `offset` remains schema-only. A continuation accepts exactly its topic/cursor and optional context handle, limit and output, as today’s discovery continuation admission already requires. Other selectors are refused before clinical work.
2. Apply the existing `limit` default **20**, range **1..50**, to server rows. The strict row-array upper bound and `definition_limit:100` remain the absolute summary ceiling; they are not a promise to return 100 rows per call. `resource_count` remains the total source-advertised resource count, not this page’s length.
3. Freeze one deterministic ordered list: advertised required types in required-resource order (`Patient`, `Observation`), advertised optional workflow types next (currently `DiagnosticReport`), then the remainder in codepoint type order. Derive roles from the support manifest. Do not invent an advertised row for a required type absent from the source, or turn source advertisement into executable support.
4. Reuse immutable discovery snapshots, source/context/policy/auth-epoch/revision binding, quotas, pending-handle rollback, absolute expiry, and wrong-store/topic rejection. Store rows and metadata, not clinical bodies or source descriptions. Cursor advancement uses the **actual delivered row count**, including byte-driven shrinkage. Replay cannot skip rows or renew expiry.
5. `snapshot_revision` equals the frozen capability revision; captured/expiry values describe that frozen snapshot. Existing source revision invalidation rules apply. More rows require a usable `data.next_cursor`, partial metadata coverage, false query exhaustion, and `CAPABILITY_SUMMARY_LIMIT` alongside the standing metadata caveat. A terminal page has no cursor, true metadata exhaustion, and complete-for-query **metadata** coverage. No clinical completeness follows.
6. Reserve cursor/freshness/warning overhead while fitting the exact final SDK result. An indivisible row that cannot fit returns fitted `OUTPUT_LIMIT`; do not issue a cursor that skips it. Storage failure is an existing typed failure, not permission to return a misleading complete summary.

### 4.3 Continuation delivery size and stop state

`fhir_page` keeps its existing strict input shape: **no new `page_size` field**. For every search-chain delivery, use the original validated frozen search `_count` as the requested row ceiling, including local remainders, loaded-cursor replay, and newly fetched pages. A missing/invalid original count is invalid internal state, not a reason to fall back to 100.

`pagination.requested_page_size` reports that inherited **application request ceiling**. It does not assert that a server honored `_count`, or that a server-generated opaque next URL uses the same count. A page can return fewer because of bytes or fewer source matches. Do not modify the URL to enforce the local ceiling; retain its excess authorized records and drain them first. Count stays outside material query identity/digest. Bind the reported size to trusted invocation/snapshot state in the strict gate.

Preserve the existing meanings:

- A usable continuation or local remainder: `has_more:true`, cursor, `query_exhausted:false`.
- A terminal **unverified** chain: `has_more:null`, no cursor, `query_exhausted:null`, partial coverage and unverified-continuation disclosure.
- Proven/observed exhaustion under the existing rules: `has_more:false`; query completeness still separately requires proved membership and no loss.
- Retained result: `has_more` addresses its local slice/offset; coverage stays retained/partial with null query exhaustion.

Tighten the gate for terminal trusted `continuationUnverified` chains so false cannot replace null. Do not weaken unsafe-link checks, sticky proof downgrade, `NO_MATCHES` eligibility, total suppression, or completeness checks. Document that a caller stops when no safe cursor is supplied, including the unknown case. No additional stop-state field is proposed.

### 4.4 Metadata byte warning

Register this fixed warning:

```json
{
  "code": "METADATA_BYTE_LIMIT",
  "message": "Metadata rows were reduced to fit the byte budget; follow the returned continuation."
}
```

Emit it on successful server/search-parameter/support/schema row pages **iff** the wire packer removed at least one otherwise eligible row to fit the byte allowance. Set `budget.limit_reached:true`. Do not warn for natural end-of-list, an explicitly smaller caller limit, the normal logical page boundary, or an indivisible-row error. Preserve existing coverage reasons and the cursor or schema offset.

Include the warning in fitting as soon as shrinkage is necessary; repack with its full text/structured duplication, cursor, and worst-case elapsed allowance. Never append it after a page has been declared to fit. The gate must bind warning presence and `limit_reached` to a trusted packer outcome, reject omission/false assertion and use on clinical or non-row metadata responses, and retain the exact-message allowlist. No Zod warning-code enum is introduced and no source-authored message is accepted.

### 4.5 Catalog and emitted artifact

Use `catalog_version:'m3b-catalog/3'`. Keep the server instructions byte-for-byte, all strict/listed input **JSON shapes**, five tools, titles, annotations, the 97-byte listed output schema and 1,989-byte spine. Cursor/topic applicability changes through the documented core refinement, not a new input property. Do not add an output-schema version `const` or relax the core gate.

The five proposed tool descriptions are:

| Tool | Exact description |
| --- | --- |
| `fhir_capabilities` | `Discover bounded metadata; definitions/support are not execution/profile proof. Follow data.next_cursor.` |
| `fhir_search` | `Search bound type; latest needs sort proof; use pagination.next_cursor.` |
| `fhir_read` | `Read bound type/id; search IDs; result.handle` |
| `fhir_page` | `Continue fixed query/source; inherit size; retained first.` |
| `fhir_result` | `Inspect/project/page retained slice, not chart/query; no fetch/TTL renewal; next_offset.` |

Every changed property description is listed here; all others stay byte-identical:

| Tool/property | Exact replacement |
| --- | --- |
| All five `context_handle` properties | `Optional; omit=fixed binding` |
| capabilities/search/page `output.fields` | `Dotted paths.` |
| capabilities `cursor` | `server/search_parameter/support; same topic; no selectors.` |
| search `params` | `AND pairs in order; comma OR; escaped commas literal; repetition may be unknown.` |
| search `page_size` | `Upstream count: default 20/max 100; fewer may fit.` |
| read `output.format` | `compact=reviewed; fhir=sanitized; payloads omitted.` |
| read `id` | `ID` |
| read `interaction` | `read only` |
| page `cursor` | `pagination.next_cursor.` |
| page `output.max_bytes` | `Wire cap.` |
| result `handle` | `result.handle; expiry=redo query.` |
| result `output.max_bytes` | `MCP bytes incl. SDK/duplication; not tokens` |

`GUIDANCE-CHANGES.json` independently enumerates these 23 emitted changes. Full docs must explain that omitted handles are valid only for this immutable fixed-local-binding deployment; otherwise echo the returned handle, and a conflicting handle never selects a patient. IDs/handles are not authorization. Longer path/byte/retained/evidence examples belong in docs, not source-provided descriptions.

Regenerate `docs/contracts/m3b-tools.json` through its emitter: schema literals, strict server data, listed text/hashes, migration rules, error-only `none`, inherited size, server paging/binding and byte-warning refinements. Add a generated top-level `warning_messages` table from the authoritative catalog so full-contract consumers can reproduce the gate’s closed message vocabulary. Retain artifact container identifier `m3b-tools/1`; its application-version fields distinguish 0.3. Retain the historical 0.1/0.2 records as history. Update the emitter’s hardcoded “0.2” descriptions; changing only the constant would leave its published semantic prose wrong.

### 4.6 Compatibility, protocol eras and pinned fixtures

Ship 0.3 as a coordinated pre-release application change, independent of the package rename/version work and **independent of MCP protocol era**. Both eras serve the same 0.3 semantics. Their SDK metadata/result accounting remains era-specific. No era-based fallback to 0.2, public schema-selection argument, dual serving mode, or compatibility claim is proposed.

An old **full strict 0.2 consumer** rejects 0.3 envelopes at the literal version even on unchanged successes. If someone strips that check, old enums reject error `none`; strict server objects reject the five new fields; the old gate rejects the new warning and new server cursor semantics. An updated strict 0.3 consumer likewise rejects literal 0.2 fixtures. This is a deliberate application migration, not a protocol-negotiation failure. Hosts validating only the listed minimal schema accept either string, subject to actual host verification; no new outside-host pass is claimed.

Regenerate active literal examples from actual calls in both eras, including new error/binding/paging results; do not merely edit their version text. Update active strict fixtures and catalog/hash pins together. Raw 2026-10-23 host traces and historical qualification reports remain original 0.2 evidence, not retroactively claimed 0.3 evidence. In-process cursor state is ephemeral; a new binary does not import old result/discovery handles, and no persistence migration or TTL renewal is added.

## 5. Implementation changes per file

Root should assign these files explicitly in its implementation brief. This proposal makes no tracked edits or assignments to another active implementation agent.

| File(s) | Change |
| --- | --- |
| `proposals/m3b-spec.md`, `proposals/CONSENSUS.md`, `proposals/release-plan.md` | Record the root-approved 0.3 delta, server cursor applicability/order/limit, error evidence, inherited delivery size, byte warning, unchanged S6 unknown semantics, and S7a before S7. Correct stale stage/count statements only through dated records. |
| `packages/core/src/contracts.ts` | Bump application version; add `none`, strict server fields and warning/gate requirements; allow server discovery cursors in the combination refinement; require `none` iff error; bind patient, inherited size, metadata snapshot rows/freshness/cursor and byte-warning truth to immutable validation context. Require null for terminal trusted unverified chains. Preserve error cleaning, budgets and all proof/confinement checks. Existing `02`/`V2` symbol names can remain historical internal names for this slice; the authoritative version constant is 0.3, not a promise of dual serving. |
| `packages/core/src/m3b.ts` | Add the server discovery snapshot kind and typed summary row metadata; exclude error-only `none` from successful query evidence. Keep clinical query identity/overlay semantics. |
| `packages/core/src/discovery.ts` | Add the server snapshot value/freezer, reuse binding/expiry/store checks and shared backing/offset machinery; no new store, URL access or permission source. |
| `packages/core/src/index.ts` | Update every normal/minimal/emergency version/evidence producer; derive validated original count for continuation packing; capture trusted requested size. Replace the unpageable server branch with ordered snapshot paging, freshness, pending cursor commitment and configured patient disclosure. Generalize metadata packing to reserve the warning and capture a trusted byte-shrink outcome. Keep clinical/metadata stores and all pre-fetch checks separate. |
| `packages/core/src/catalog.ts` | Apply the exact measured guidance, catalog revision and fixed warning message. No cap changes. |
| `packages/core/src/query.ts` | Keep coverage/proof decisions. Make error-only evidence ineligible for successful helper paths/`NO_MATCHES`; do not change S6 labels, HAPI continuation eligibility, sort proof, or digest inputs. |
| `packages/core/src/delivery.ts`, `packages/server/src/index.ts` | No new rendering/profile/registration behavior is needed for the recommendation. Existing serialized envelopes carry the new fields/warning; existing adapter supplies the era. Verify stop-state behavior and actual SDK accounting. Do not add a new delivery profile or extra text outside the permitted rendering contract. |
| `scripts/emit-m3b-contract.mjs`, generated `docs/contracts/m3b-tools.json` | Emit all changed shapes/text, the warning table, refined semantics and migration rules; regenerate hashes, run `--check`. |
| `tests/s7a-usability.test.ts` (new), `tests/s5-discovery-v2.test.ts`, `tests/s5-strict-gate-v2.test.ts`, `tests/s4-query-state.test.ts`, `tests/s5-coverage-repairs-v2.test.ts` | Add the discriminating controls below; migrate active strict fixtures, server data/context and errors. Add all-tool/era/profile emergency tests, metadata snapshot/gate corruption tests, original-size local/loaded/upstream/replay tests, and no false stop/exhaustion tests. |
| `tests/m3b-contracts.test.ts`, `tests/m3b-catalog-v2.test.ts`, `tests/fixtures/s58-release-catalog.json`, active version fixtures identified by the version-literal audit | Regenerate artifact/listing pins and exact guidance assertions, including the old terminal-period expectation. Update serving assertions deliberately; retain intentional old-version rejection/minimal-schema acceptance controls. Do not mechanically rewrite historical or negative literals. |
| `packages/evals/src/runner.ts`, `packages/evals/src/tasks.ts` | Report the authoritative schema version instead of hardcoded `0.2` (`runner.ts:1129`). Add independent error-evidence, metadata-page, byte-warning and binding oracles. For auxiliary metadata continuation tasks add explicit `{{discovery_cursor:n}}` resolution from `data.next_cursor`, with the same no-forward-reference validation as other placeholders. Today `{{cursor:n}}` reads only clinical pagination (`runner.ts:533–540`); do not silently conflate stores or reuse clinical auto-drain. |
| `packages/evals/data/s7a-usability-tasks.json` (new), `tests/eval-corpus-pin.test.ts` | Load and pin a separate auxiliary usability task file with explicit corpus assignment, response-bound checks and measured budgets. Cover error `none`, default binding, prioritized server pages, inherited size and byte warnings using existing fixture behaviors where possible. Keep primary benchmark task identities/denominators explicit. Put the large 146-type and ignored-count fixtures in the new SDK test harness rather than modifying the qualified backend merely to test metadata UX. |
| `examples/capture-tool-calls.ts`, generated `examples/tool-calls.json`, `examples/observed-code-scan.ts` | Regenerate active literal examples with actual 0.3 results. Update the scan’s serving-version guard; do not change its independent scan budgets, query matching, or exhaustion requirements. |
| `tests/isolation/scenarios.ts`, applicable CUR/MET/ERR family tests and `tests/isolation/kill-matrix.json` | Extend existing applicable boundaries to cover the new server cursor route and `none`, preserving authorized positive controls, exact refusals, all channels and budgets. Add named predicates/kill mappings when needed. No automatic increase in counted independent cases. |
| `scripts/mutation-guards.mjs`, `tests/mutation-discriminators.test.ts`, affected strict/gate suites, `tests/isolation/cases-v1.json` | Add the new fault intents below; audit every changed existing anchor. Refresh only reviewed affected pins, with `hashes.mutants` last. Use the hashes-only manifest path; the full generator currently resets cases to `counted:false`. |
| S7 generated docs, README, LIMITS, IMPLEMENTATION, query/host/repair/contract migration docs | Explain the stable notation/scope/evidence meanings and new server/size/warning behavior, generate warning/help tables from authoritative data, validate examples and docs links. Preserve original outside-host evidence as historical evidence. |

The trusted metadata validation context should reference the immutable ordered snapshot and its binding/freshness, admitted limit and offset, finally packed slice/cursor, and an independently captured `byteLimited` flag. The gate compares disclosed rows to that slice, counts/cursor advancement to the actual delivery, and patient/freshness to trusted values. It must **not** reconstruct this context from the envelope it is validating. The same rule applies to the inherited requested page size. Sharing immutable metadata references avoids adding wire fields or duplicating clinical bodies.

## 6. Tests, evals, isolation and mutation consequences

| Finding | Required tests / eval effect | Isolation and mutation consequence |
| --- | --- | --- |
| **1** | All five error envelopes, including admission, upstream, expired handle, normal fitting and emergency fallback, require `none`; successful/empty/retained responses reject it. Exercise both eras and full-text plus fixture-structured paths. Independent eval error checks must run **before** today’s early return on error (`runner.ts:750`). | Keep foreign/absent reads indistinguishable apart from approved randomness. Assert no stale facts/digest/pagination/repair leaks. Add producer-reversion, stale metadata/error-evidence, success-`none`, and omitted error-only gate mutants. Do not make every rejection pass merely because it has `none`. |
| **2** | Search size 1 followed through local remainder, upstream page, loaded replay and ignored/different upstream `_count` returns at most 1 per response, reports 1, drains all rows without duplication, performs no premature fetch and preserves expiry. Explicit page-size input stays invalid. Eval call/byte budgets stay independently enforced; smaller deliveries can increase calls on an overproducing server. | Existing clinical cursor/source/type confinement tests remain. Add size-fallback-100, wrong reported size and gate-size-unbound mutants. Keep original-query validation and proof identity unchanged. Do not raise existing task budgets to hide a regression. |
| **3** | Pin terminal opaque/generic and HAPI-style continuations to null/null, partial, no cursor, sticky evidence; test a later page cannot relabel or complete the chain. Add a false/null gate-corruption negative control and preserve the positive verified-offset terminal case. | Retain CUR opaque/rebound and unsafe-link checks. Add terminal-false and trusted-unknown-gate-disabled mutants; preserve current S6 continuation/ordering mutants. No relabeling of old null expectations is needed. |
| **4** | A retained slice with local `has_more:false` still has retained partial coverage and may carry the originating query’s `MORE_PAGES`; inspection distinguishes upstream remainder. No query completion or additional fetch follows. | Existing retained/local-offset and no-TTL-renewal mutants remain required. Documentation option changes no oracle or isolation pin by itself. |
| **5** | Default and explicit server views expose exactly the configured binding; source-supplied foreign IDs/prose cannot change it. Missing/wrong trusted patient context and altered output ID fail the final gate. Context discovery still agrees. | Test outputs versus ordinary logs/doctor/source cache/snapshots separately: authorized binding output is permitted, log or foreign-ID disclosure is not. Add wrong-patient-output, patient-binding-gate-disabled and source-derived-patient mutants; extend applicable metadata/ERR checks without weakening scanners. |
| **6** | Strip descriptions/expand refs and compare to unchanged input validators; test omitted valid handle, echoed handle and conflicting forged handle through actual SDK calls. | Existing context-handle rejection mutant/control must still kill/pass. Guidance/hash changes alone do not alter security-case identity or count. |
| **7** | Actual SDK listing/artifact equality, all listing pages/fields, exact minimal output schema, both-era bytes and locked tokens. Keep locally compiled descriptions and mandatory caveats. | Retain listing/schema/guidance mutants; refresh catalog pins rather than deleting equality checks or raising caps. No isolation-count credit for wording variants. |
| **8** | Independently authored 146-type source fixture: required/optional advertised types first; drain all 146 exactly once under logical and byte limits; replay unchanged; source revision refresh, expiry, quota, wrong topic/store/context and selector forgery refuse safely. Test missing required source types are not invented. Auxiliary evals follow `data.next_cursor` explicitly and perform metadata-only work. | Extend relevant CUR/MET cases to server cursors. Add skip/duplicate-row, terminal-before-tail, priority-dropped, false executable intersection, binding/topic/revision bypass, expiry-renewal and rollback mutants. Source prose/names may not bypass existing metadata sanitization. |
| **9** | Force shrink from requested available rows: warning iff byte reduction, exact message, `limit_reached`, exact final bytes, and correct advancing control. Natural short final page and caller-limited page are warning-free; oversized indivisible row remains error. Exercise all four metadata row topics at minimum/default budgets in both eras. | Add warning-dropped, warning-for-natural-end, append-after-fit/overflow, skipped-row and trusted-byte-flag-unbound mutants. Unknown warning codes/messages must still fail; do not loosen the allowlist to admit the new code. |
| **10** | Existing dotted selector, nested omission, array, primitive companion, modifier, withheld payload and structural fallback tests stay. Add documentation examples mapping a simple `/meta/lastUpdated` location to selector `meta.lastUpdated`, and showing why a withheld/placeholder path is not recoverable. | Preserve omission-disclosure, selector-safety, protected-payload and modifier mutants. No parser/omission migration, pin change or new disclosure grammar is justified by the recommended documentation fix. |
| **11** | Pin gateway `_sort` permission with unknown source/execution evidence; pinned/overlay typing alone is not execution proof. Test source type/canonical/duplicate conflicts remain unexecutable and generic/HAPI unknown sort stays unknown. Explain that emitted `type` can be the pinned resolved type while conflict concerns the source declaration. | Retain conflict, source-description canary, generic-proof and sort-proof mutants; no new proof profile or source fetch. A documentation-only fix changes neither eligibility nor isolation oracles. |

**Profile pins:** leave the qualified query task JSON, independent vectors, fragment, backend module and HAPI identity/seed inputs byte-identical where this design does not require a change. Synthetic proof is bound to backend/fixture/query-task hashes (`runner.ts:710–729`; `tests/s6-profile-proof.test.ts:31–48`); an incidental edit to those inputs requires the ordinary qualification route, not a digest replacement. Auxiliary usability tasks and their separate pins avoid gratuitously invalidating the frozen query corpus. Rerun the public-selection proof tasks against the new gateway in both eras regardless. If any bound input actually changes, requalify and freeze fresh evidence for the affected profile. A 0.3 application version alone does not qualify or disqualify a backend profile.

**Isolation pins:** application/source changes alter candidate/build evidence, but do not automatically change every manifest hash. The precise dependencies are `tests/isolation/report.ts:267–280`: fixture hash includes canaries/backend/scenarios/registry/stubs/drivers; harness hash includes its named machinery and family test files; scanner, matrix, ledger and kill-matrix hashes track their corresponding files. The mutant pin includes only isolation-suite or kill-matrix-referenced registry entries. A new unit-only mutant does not itself require that pin to change. Changed scenarios/predicates/kill mappings do. Review those changes, then refresh affected hashes with `generate-manifest.mjs --hashes-only`, **mutants last**, and rerun isolation. Preserve current counted/diagnostic status; no 200-case gate is earned by adding formats, descriptions or new copies of the same boundary.

**Registry audit:** I ran the existing pure sequential anchor applicator against the recommended listing/shape prototype. All **654 registered mutants** still had matching anchors (`anchor-impact.json`). This is an anchor observation, **not mutation kills or acceptance**. The complete implementation will change additional metadata/control code and must repeat the audit. Preserve surviving faults’ intent and discriminators; retarget stale anchors as needed. Register each new guard above with a positive control, correct suites and reproduced named failures. Keep the registry’s generated-artifact preparation path for contract changes. Root then runs diagnostic subsets followed by the required fresh official 14-shard aggregate; old aggregate evidence cannot certify changed code/tests/registry.

Root’s final S7a verification remains the release plan’s local gate set: typecheck/tests/build, contract and docs/example checks, isolation and controls, both eval eras/all relevant arms, demos/negative controls, fresh actual catalog capture and both encodings, independent review, and the official mutation aggregate on its bound candidate. Deferred Linux/CI, untested real-host cells, and package/rename measurements stay deferred; exploratory design measurements do not close them.

## 7. What was exercised here, and remaining decisions

Design probes used the existing production factory/SDK harness in both eras:

- Baseline: search requested 1; page reported 100; both upstream requests still carried `_count=1`. Terminal unverified page was null/null. Changing only `has_more` to false passed the current semantic gate. `none` failed the old strict shape; the minimal listed schema accepted it.
- Inheritance prototype: page reported 1. An upstream page deliberately returning three records at requested size 1 drained as **1/1/1**, versus baseline **1/2**, with exactly one clinical fetch and unchanged result expiry.
- Error-only 0.3 prototype: clinical and metadata errors used `none` and passed actual final SDK delivery validation; `none` on a success failed the semantic gate. Unknown warning codes remained rejected.

Artifacts: `behavior-baseline.jsonl`, `behavior-page-inherit.jsonl`, `behavior-local-baseline.jsonl`, `behavior-local-inherit.jsonl`, `behavior-error-none.jsonl`, and the scratch probe sources. These are small synthetic probes, not the full proposed metadata implementation or a release test run. No host, SMART, clinical readiness, vendor, or expanded protocol-compatibility claim follows.

**Root decisions requested by this proposal:** adopt the coordinated 0.3 delta and exact catalog; use priority plus server cursors, with default 20/max 50; inherit size without an override; retain and tighten terminal unknown semantics; keep separate selector/omission notations and current metadata evidence dimensions. Then root can issue explicit file briefs and run the implementation review/verification.

**Owner decisions needed for this recommendation: none.** It keeps existing caps, confinement, disclosure boundaries and release scope, and the brief assigns design approval to root. Raising catalog caps, adding patient selection, widening support/proof, publishing artifacts or changing release policy would need separate authority; none is proposed. Existing owner-dependent publication, CI and human-review gates remain open on their own terms.
