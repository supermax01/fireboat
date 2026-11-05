# G-HOST evidence: Claude Code as the MCP host (2026-10-23)

- **Gate:** G-HOST, the outside-host smoke test (`proposals/release-plan.md` A8).
- **Result:** **passed for Claude Code 2.1.309 in the 2026-07-28 era.** The host listed exactly the five tools, accepted their schemas, completed every scripted step and showed the foreign-patient read as a flagged tool error. No protocol or rendering error occurred. Usability findings are listed below; none is a correctness defect.
- **Second run, same day:** the same host and task list against HAPI FHIR 8.12.0 (an independent server, local container, synthetic data); see the addendum. It also passed.
- **Not covered:** the 2025-11-25 era through a real host (Claude Code negotiated the modern era); hosts other than Claude Code (Claude Desktop, other MCP clients); a non-synthetic source. G-HOST stays open for those as the owner arranges.

## Setup

| Item | Value |
| --- | --- |
| Gateway | fhir-mcp-gateway 0.2.0-alpha.1, built CLI `dist/packages/server/src/cli.js` from `cffddc7` (B2-0 on `r/s5-candidate`), Node 24.22.0, macOS arm64 |
| Source | `examples/synthetic-server.ts` on loopback port 18080, synthetic data only; `--doctor`: ok, FHIR 4.0.1, profile `generic-r4`, metadata coverage `complete_for_query` |
| Gateway config | mode `synthetic`, source alias `local-synthetic`, base URL `http://127.0.0.1:18080/fhir`, bound patient `synthetic-patient-a` |
| Host | Claude Code 2.1.309, headless (`claude -p`), model `claude-opus-5-5`, `--strict-mcp-config` with only this server, built-in tools disabled (`--tools ""`), only the five `mcp__fireboat__*` tools allowed, no session persistence |
| Capture | a `tee` wrapper recorded every JSON-RPC frame in both directions; raw frames and the host transcript are in the gitignored `.local/host-tests/claude-code-2026-10-23/` |
| Task list | seven steps: list tools; `fhir_capabilities`; a laboratory `fhir_search` with a small page; `fhir_read` of a returned id; `fhir_page` on the cursor; `fhir_result` on a handle; read of `synthetic-obs-b1`, which belongs to the other synthetic patient |

Raw evidence SHA-256: `frames-in.jsonl` `b62896e2e4d9208683049e8b2d737281317aef45a1fffdbe4160b699901e989d`, `frames-out.jsonl` `ee761954d8a3be12940660231a737260e30110efb538d97f0e3e1b22675a7e81`, host transcript `run1.jsonl` `e7d53b27a02845b3e863fd47aede4bda26b4a3f06d75d882b9c26de630f7b218`, task prompt `prompt.md` `5c7f07aea285c5c65b3528517eadd1b723868ec9ba9e27daca49cd7f14dea212`. The host session took 8 turns and 42 s.

## Protocol

Claude Code probed with `server/discover` (protocol 2026-07-28, client `claude-code` 2.1.309) on the same process, then sent `tools/list` and seven `tools/call` requests statelessly, each carrying the protocol version in `_meta`; there was no `initialize`. The server answered `supportedVersions: ["2026-07-28"]`. Every tool result carried both the text content and `structuredContent`.

## Steps

| # | Tool and arguments | Outcome | Size |
| --- | --- | --- | --- |
| 1 | `tools/list` | the five tools | 8,936 B |
| 2 | `fhir_capabilities` (default), then `topic=context` | success; source, types and workflow; the bound patient appears only with `topic=context` | 3,785 B; 2,706 B |
| 3 | `fhir_search` Observation, `category=laboratory`, `page_size=2` | 2 matches, cursor and handle; `partial`, patient `gateway_enforced`, category `execution: unknown`, `FILTER_EXECUTION_UNVERIFIED` | 7,082 B |
| 4 | `fhir_read` Observation `synthetic-obs-a1` | success, `exact_id_and_subject_linkage` | 4,268 B |
| 5 | `fhir_page` with the cursor | 1 match; `unverified_continuation`, `has_more: null`, no cursor | 5,358 B |
| 6 | `fhir_result` project, four fields | success; modifier fields added with `MODIFIER_FIELDS_ADDED` | 5,552 B |
| 7 | `fhir_read` Observation `synthetic-obs-b1` (other patient) | tool error `NOT_FOUND`, "Unable to complete the bounded request.", `retryable: false` | 2,364 B |

## Findings

By design (no change):

- **Uniform NOT_FOUND for the other patient's record.** The host could not tell "refused" from "does not exist". That is the uniform-read rule, so a caller cannot probe which records exist.
- **The foreign read made one upstream call.** The gateway must fetch a resource to judge its subject linkage; the result is suppressed before delivery.
- **Handles from `fhir_page` inherit the original expiry.** S2 rule: no lifetime renewal.

Usability, for S7 (documentation) or a later contract revision:

1. **Error envelopes carry `query_evidence: "unverified_continuation"`.** The 0.2 contract requires that value on every clinical error because the enum has no "none"; a host reads it as a claim about a continuation. Candidate contract change: a `none` value for errors.
2. **`fhir_page` does not inherit the search's `page_size`.** It has its own (default 100) and reports `requested_page_size: 100`; the host expected the search's size. Document, or inherit unless given.
3. **`has_more: null` with no cursor after an unverified continuation.** Honest (exhaustion cannot be confirmed) but reads as neither "more" nor "done". Document, or report `has_more: false` with `query_exhausted: null`.
4. **`pagination` and `coverage` describe different scopes.** A retained projection shows `pagination.has_more: false` next to `coverage.reasons: MORE_PAGES`. Document that pagination describes this response and coverage the query.
5. **The bound patient is visible only with `topic=context`.** Consider naming it in the default capabilities view.
6. **`context_handle` is described only as "Trusted".** Hosts cannot tell whether to pass it.
7. **Tool descriptions are terse.** The catalog byte budget (A3) is at its cap; any wording change must stay within it.

## Addendum: the same host against HAPI FHIR 8.12.0

| Item | Value |
| --- | --- |
| Source | `hapiproject/hapi:v8.12.0-2` (`sha256:0ff86aac4c7bd13a1ee226444a70263bb46ed1c28ef543c30a44f865b80ca04e`, arm64) in Colima 0.10.3, port published on `127.0.0.1:18090` only (host listener verified), default in-container database; the ten resources of `examples/synthetic-server.ts` loaded with one PUT transaction (two synthetic patients, six Observations, two Medications) |
| Gateway | the same build; source alias `local-hapi`; `--doctor`: ok, `generic-r4`, metadata coverage `partial` (HAPI's CapabilityStatement exceeds the bounded summary) |
| Host | Claude Code 2.1.309, same flags and task list; 9 turns |
| Raw evidence | `.local/host-tests/claude-code-hapi-2026-10-23/`: `frames-in.jsonl` `0d6f96f80807168a76034be4ff8466e7f42e4ad72f7816c25cff99ce183836b1`, `frames-out.jsonl` `81acefa91bfaf8db135736f8cb566834bc7d97e5dc1bfbfd94d1af2d4aa7e4cb`, `run1.jsonl` `6c37cf23b87fd527a263285b01bcabd7cc0e01e9f97c7b19aecafefe3633bc48` |

Every step succeeded against HAPI's own paging. The search returned two matches and a cursor, `fhir_page` followed HAPI's server-side continuation (one more match, `unverified_continuation`), the projection worked, and the other patient's Observation was a flagged `NOT_FOUND`. Response sizes ranged from 2.4 KB to 24.5 KB; the default capabilities view was 22.6 KB of the 24 KB limit.

New usability findings that only a real server exposed:

8. **The capability summary is truncated.** The default view lists 100 of HAPI's 146 resource types and stops before `Patient`, a required type; the reason is `CAPABILITY_SUMMARY_LIMIT`, but there is no visible way to get the rest.
9. **The byte cap silently lowers `limit`.** A `search_parameter` request with `limit: 50` returned 17 entries; only `budget.limit_reached` and a cursor signal it.
10. **Field paths use two notations.** Fields go in dotted (`meta.versionId`) and come back in `omitted_fields` as JSON pointers (`/meta/lastUpdated`).
11. **HAPI's search-parameter metadata reads as contradictory.** `_sort` shows `executable: true` with `evidence: "unknown"`, and `_filter` shows `definition_evidence: "conflict"`; the gateway reports HAPI's declarations faithfully, but a host cannot tell what to trust.

