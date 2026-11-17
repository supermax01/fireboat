# Synthetic gateway limits and measured floors

Current bounds for application schema 0.4. The measured floors further down were measured on schema 0.4 with Node 24.22.0 and MCP SDK 2.3.1. This is a synthetic-only local prototype. Modern means MCP protocol version 2026-07-28 and legacy means 2025-11-25.

| Bound | Current value |
| --- | --- |
| Model copy default / ceiling / per-call minimum allowance | 49,152 / 131,072 / 4,096 B, counted once (see below) |
| Complete MCP tool result (`budget.wire_bytes`) | At most 3 × the effective allowance + 4,096 B; typically about twice the model copy |
| Configured `limits.defaultBytes` and `limits.maxBytes` range | Each 8,192..131,072 B; explicit default must not exceed ceiling |
| Upstream requests per gateway call, including token work | 20; reserve before sending request 21 |
| Overall deadline default / hard ceiling | 45 / 200 s |
| Search parameters per `fhir_search` call; value bytes per parameter; OR alternatives per value | 30; 2,048 B; 33. These apply to every parameter except `_id`, including patient selectors |
| `_id` lists | At most 100 ids in one `_id` value, within 4,096 B (enough for 100 UUID ids). Each id must be a plain FHIR id (letters, digits, `-` and `.`, 1 to 64 characters, not `.` or `..`), or the call is refused with `INVALID_ARGUMENTS` before anything is sent. A `Patient` search still takes only the bound patient's id |
| Patient-linked reference targets per search (for example `encounter=Encounter/<id>`) | 4 distinct targets. A target not yet authorized in this context as the bound patient's own record (delivered, or confirmed by an earlier check) is first checked with one confined search, `<Type>?_id=<id>&patient=Patient/<bound>` (or `subject=`), which counts as an upstream request. Five or more targets are refused before anything is sent |
| Own records remembered per context as allowed reference targets, and reachable directory records | 2,048 entries in all, in one list (least recently used first out, whichever kind). The list is cleared whenever retained results are cleared (source, credential or policy change); a new search naming a forgotten target checks it again with a confined search. A `fhir_page` continuation does not run the check: if its target has been forgotten, it is refused with `POLICY_DENIED` and the search must be repeated. A forgotten Practitioner, Organization or Location is unreachable again (reads `NOT_FOUND`, `_id` searches refused) until an own record that names it is delivered again |
| Operator-declared continuation token (`source.continuationTokenParameter`, off by default) | Exactly one token per next link, 1 to 2,048 characters in all after decoding: letters, digits, `-`, `.`, `_`, `~`, then at most two `=` of base64 padding at the end; the configured name is 1 to 64 characters and is never a known search or result parameter |
| Date checks on pages without a self link (`source.selfLinkOptional`, off by default) | A date value without a timezone, on the record or in the search, is read with 14 hours of slack either way, so a record within 14 hours of such a boundary can pass |
| Requested primary matches default / maximum delivered per page | 20 / 100; each `fhir_page` continuation keeps the original search's `page_size` (no page-size input) |
| Metadata rows per `fhir_capabilities` page (`server`, `search_parameter`, `support`) | `limit` default 20, maximum 50 (25 for `support`); fewer when the byte budget is reached, with `METADATA_BYTE_LIMIT` and a continuation. The 32 support rows take two pages even at the maximum, so follow `next_cursor` |
| Tool listing (both MCP protocol versions, measured with the actual SDK) | 8,367 B complete (cap 8,450 B); tools 8,069 B (cap 8,100 B): capabilities / search / read / page / result 2,198 / 1,750 / 1,399 / 1,099 / 1,623 B (caps 2,200 / 1,750 / 1,400 / 1,100 / 1,650 B); every listed output schema 97 B (cap 100 B) |
| Explicit client observed-code scan | At most 3 clinical MCP pages, 4 MCP calls, 20 upstream requests, 45 s, 24,576 model-copy B/call and 73,728 B/task (each complete result within the wire invariant), subject to lower bounds |

## How the response is counted

Every tool result carries the same JSON twice: once as a text block and once as `structuredContent`. Since schema 0.4 the allowance counts it once:

- **Model copy bytes** are the larger of the UTF-8 bytes of the text content (LF-joined if there are several text blocks) and the UTF-8 bytes of the compact JSON serialization of `structuredContent`. In `full-text-v1` the two are equal. `limits.defaultBytes`, `limits.maxBytes` and the per-call `output.max_bytes` bound this number, and `budget.bytes_returned` reports it; `budget.byte_limit` is the allowance it is measured against.
- **Wire bytes** are the complete serialized MCP tool result: both copies, JSON escaping of the text copy and the protocol-version-specific SDK fields. `budget.wire_bytes` reports it. A fixed invariant keeps it at most 3 × `byte_limit` + 4,096 B, enforced by the same fitting as the allowance and by the final delivery gate. JSON-RPC framing is measured separately.

A host that passes both copies to a model would therefore see about twice the allowance. Which copy a host gives a model has not been verified for any host. Schema 0.3 counted the complete result against a 24,576-B default.

The default is 49,152 B, not a larger round number such as 65,536 B, because of Claude Code's MCP documentation (code.claude.com/docs/en/mcp.md): Claude Code warns when MCP tool output exceeds 10,000 tokens, limits it to 25,000 tokens by default (`MAX_MCP_OUTPUT_TOKENS`), and, unless the server raises a tool's own limit, saves successful text results longer than 50,000 characters to a file instead of showing them inline. A text copy of at most 49,152 UTF-8 bytes has at most 49,152 characters. This is not a claim about how Claude Code counts characters or tokens, or about which copy it gives the model; no token count is measured here, and responses of tens of thousands of bytes can exceed 10,000 tokens.

A byte allowance does not promise that a resource fits. Oversize output returns an honest manifest or fitted fault, with safe recovery/continuation controls. The read path preserves its uniform public unavailable response. The configured minima are 8,192 B, preserving the 4,096-B per-call floor. The effective default is `min(limits.defaultBytes ?? 49152, limits.maxBytes ?? 131072)`, including ceiling-only configuration.

Search cursors and retained result handles share the gateway-wide handle quota (`maxHandles`, default 128) and the retention-byte limit (`retentionBytes`, default 10 MiB). A cursor can become unavailable before its stated `expires_at` when the quota is full. A full quota does not refuse the next call. Result handles are evicted first, oldest first. When no result handle can be evicted, the oldest search cursor is evicted. A cursor issued by the same call is never evicted, and neither is a cursor that an active `fhir_page` call is serving, from the start of the call until its response is rendered, including while its next page loads and when several calls serve the same cursor at once. With `maxHandles` 1, a page call therefore cannot hold both the cursor it serves and its successor, and is refused as retryable. An evicted cursor then gives the same refusal as an expired one: `RESULT_EXPIRED`, repeat the original query. Consumed cursors are not reclaimed when they are used, because replaying a recent cursor returns the same page without upstream work.

`RETENTION_LIMIT` remains in three cases. A search or page whose retained state could not fit even in an empty store is refused and is not retryable; narrow the query, lower `page_size` or select fewer fields. A write that still does not fit after every evictable handle is gone, because the rest are cursors being served by active `fhir_page` calls, is refused as retryable and names the earliest expiry. A discovery snapshot that does not fit beside the clinical state is refused, because discovery never evicts clinical state. A result handle that cannot be retained is never a refusal: the call succeeds without it and carries the `RESULT_NOT_RETAINED` warning.

## Measured floors (schema 0.4)

Each cell is the smallest `max_bytes` in [4,096, 131,072] at which the call delivers at least one record, found by a binary search where every probe starts a fresh gateway and a real MCP SDK session, and every call's `bytes_returned` and `wire_bytes` are checked against independent measurements. A 4,096 cell means "fits at the public floor", not an intrinsic minimum. The fixture records are this measurement's own (a minimal Observation, a typical lab Observation with coding, quantity, reference range and one component, and the same lab with a modifier extension).

| Default-format call / record | Modern smallest admitted allowance | Legacy smallest admitted allowance | Model copy / wire bytes at 4,096 (modern; legacy wire) |
| --- | ---: | ---: | ---: |
| read / minimal | 4,096 B | 4,096 B | 1,243 / 2,813 B (2,696) |
| search1 / minimal | 4,096 B | 4,096 B | 1,512 / 3,383 B (3,266) |
| page / minimal | 4,096 B | 4,096 B | 1,410 / 3,161 B (3,044) |
| searchQ / minimal | 4,096 B | 4,096 B | 2,135 / 4,711 B (4,594) |
| read / typical | 4,096 B | 4,096 B | 2,109 / 4,691 B (4,574) |
| search1 / typical | 4,096 B | 4,096 B | 2,378 / 5,261 B (5,144) |
| page / typical | 4,096 B | 4,096 B | 2,276 / 5,039 B (4,922) |
| searchQ / typical | 4,096 B | 4,096 B | 3,001 / 6,589 B (6,472) |
| read / structural | 4,096 B | 4,096 B | 2,375 / 5,239 B (5,122) |
| search1 / structural | 4,096 B | 4,096 B | 2,644 / 5,809 B (5,692) |
| page / structural | 4,096 B | 4,096 B | 2,542 / 5,587 B (5,470) |
| searchQ / structural | 4,096 B | 4,096 B | 3,268 / 7,139 B (7,022) |

searchQ carries a four-pair code, date and sort query; page uses a cursor issued by a `page_size: 1` search. With explicit `fhir` and `compact` formats the largest floor was also 4,096 B in both protocol versions. The model copy does not depend on the protocol version; only the wire bytes do. At 4,096 B, schema discovery for `Observation` fits 11 elements (model copy 4,036 B; wire 8,699 / 8,582 B) and the support topic delivers 6 rows with a real continuation (model copy 3,926 B; wire 8,425 / 8,308 B).

These are fixture-specific measured minima within the public admitted range, not general resource-size guarantees or token counts. Larger records, metadata rows, selected fields, structural output and filtered queries can require larger allowances. Full-text remains the default; no unverified host is switched to slim text to make a record fit. The 48 KiB default is above every measured floor. Host delivery, live vendor/server compatibility, SMART authorization and clinical deployment readiness are unverified.
