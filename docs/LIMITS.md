# Synthetic gateway limits and measured floors

Current bounds for application schema 0.3 (S7a). The measured floors further down were taken on schema 0.2 (S5.7b, kept through the S5.8a configuration amendment), Node 24.22.0 / SDK 2.3.1, and have not been re-measured since; the S11 measurement freeze re-measures them. This is a synthetic-only local prototype. Full comparison and evidence: S5 evaluation comparison.

| Bound | Current value |
| --- | --- |
| Final MCP result default / ceiling / per-call minimum allowance | 24,576 / 131,072 / 4,096 B |
| Configured `limits.defaultBytes` and `limits.maxBytes` range | Each 8,192..131,072 B; explicit default must not exceed ceiling |
| Upstream requests per gateway call, including token work | 20; reserve before sending request 21 |
| Overall deadline default / hard ceiling | 45 / 200 s |
| Requested primary matches default / maximum delivered per page | 20 / 100; each `fhir_page` continuation keeps the original search's `page_size` (no page-size input) |
| Metadata rows per `fhir_capabilities` page (`server`, `search_parameter`, `support`) | `limit` default 20, maximum 50; fewer when the byte budget is reached, with `METADATA_BYTE_LIMIT` and a continuation |
| Tool listing (both protocol eras, measured with the actual SDK) | 8,378 B complete (cap 8,450 B); tools 8,080 B (cap 8,100 B); every listed output schema 97 B (cap 100 B) |
| Explicit client observed-code scan | At most 3 clinical MCP pages, 4 MCP calls, 20 upstream requests, 45 s, 24,576 B/call and 73,728 B/task, subject to lower bounds |

Output bytes include the complete tool result, text/structured duplication and era-specific SDK fields; JSON-RPC framing is measured separately. A byte allowance does not promise that a resource fits. Oversize output returns an honest manifest or fitted fault, with safe recovery/continuation controls. The read path preserves its uniform public unavailable response. No configured minimum/default/ceiling changed in the historical S5.7b measurement. S5.8a raises the configured minima to 8,192 B, preserving the 4,096-B per-call floor. The effective default is `min(limits.defaultBytes ?? 24576, limits.maxBytes ?? 131072)`, including ceiling-only configuration.

Measured on schema 0.2; schema 0.3 added freshness, cursor and patient fields to the server metadata view and shortened the error evidence label, so 0.3 minima can differ by tens of bytes and are not restated here.

| Full-text default call / record (schema 0.2) | Modern smallest admitted allowance | Legacy smallest admitted allowance |
| --- | ---: | ---: |
| read / minimal | 4,096 B | 4,096 B |
| search1 / minimal | 4,096 B | 4,096 B |
| page / minimal | 4,331 B | 4,206 B |
| searchQ / minimal | 5,507 B | 5,382 B |
| read / typical | 4,889 B | 4,764 B |
| page / typical | 5,743 B | 5,618 B |
| searchQ / typical | 6,919 B | 6,794 B |
| read / structural | 5,489 B | 5,364 B |
| page / structural | 6,343 B | 6,218 B |
| searchQ / structural | 7,519 B | 7,394 B |

These are fixture-specific measured minima within the public admitted range, not general resource-size guarantees or token counts. At 4,096 B minimal read/search and support succeed in both eras; the support page retains a real continuation. Schema discovery fits one element (modern 4,017 B, legacy 3,892 B), compared with two in the 0.1 baseline. Larger records, metadata rows, selected fields, structural output and filtered queries can require larger allowances. Full-text remains the default; no unverified host is switched to slim text to make a record fit. The default 24 KiB is above every measured floor. Host delivery, live vendor/server compatibility, SMART authorization and clinical deployment readiness are unverified.

The per-call minimum allowance is 4,096 B; the configured `limits.defaultBytes` and `limits.maxBytes` minimum is 8,192 B. On the reviewed synthetic fixtures, the largest measured full-text minimum allowance across formats was 7,585 B in modern and 7,460 B in legacy, leaving at least 607 B below 8,192 B. With omitted/default format, the maxima were 7,519/7,394 B. Minimal read/search delivered 3,271/3,146 B and 3,857/3,732 B respectively at a 4,096-B allowance; those delivered sizes are not minimum allowances. These measurements are fixture-specific, not general fit guarantees. See Round-7 evidence.
