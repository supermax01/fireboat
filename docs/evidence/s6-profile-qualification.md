# S6 qualification run: synthetic-fixture-r4-v1

Private labelled candidate (public id, eligible=false, evidence=null) through the constructor seam; full retrieval corpus, every arm, both eras. Recorded 2026-10-22T16:24:18.119Z.

## modern

- private profile controls: 21 rows (7 tasks × 3 arms), 0 not passing, 0 not labelled as this private candidate; pending_profile_proof rows: 0; public failures by cause: {}; exit code 0

| task | arm | verdict | failures |
|---|---|---|---|
| query-complete-proven | fhir | pass | [] |
| query-complete-proven | compact | pass | [] |
| query-complete-proven | selected | pass | [] |
| query-cross-page-sort | fhir | pass | [] |
| query-cross-page-sort | compact | pass | [] |
| query-cross-page-sort | selected | pass | [] |
| query-empty-page-with-next-proven | fhir | pass | [] |
| query-empty-page-with-next-proven | compact | pass | [] |
| query-empty-page-with-next-proven | selected | pass | [] |
| query-ignore-code | fhir | pass | [] |
| query-ignore-code | compact | pass | [] |
| query-ignore-code | selected | pass | [] |
| query-ignore-date-lower | fhir | pass | [] |
| query-ignore-date-lower | compact | pass | [] |
| query-ignore-date-lower | selected | pass | [] |
| query-ignore-date-upper | fhir | pass | [] |
| query-ignore-date-upper | compact | pass | [] |
| query-ignore-date-upper | selected | pass | [] |
| query-ignore-sort-proven | fhir | pass | [] |
| query-ignore-sort-proven | compact | pass | [] |
| query-ignore-sort-proven | selected | pass | [] |

## legacy

- private profile controls: 21 rows (7 tasks × 3 arms), 0 not passing, 0 not labelled as this private candidate; pending_profile_proof rows: 0; public failures by cause: {}; exit code 0

| task | arm | verdict | failures |
|---|---|---|---|
| query-complete-proven | fhir | pass | [] |
| query-complete-proven | compact | pass | [] |
| query-complete-proven | selected | pass | [] |
| query-cross-page-sort | fhir | pass | [] |
| query-cross-page-sort | compact | pass | [] |
| query-cross-page-sort | selected | pass | [] |
| query-empty-page-with-next-proven | fhir | pass | [] |
| query-empty-page-with-next-proven | compact | pass | [] |
| query-empty-page-with-next-proven | selected | pass | [] |
| query-ignore-code | fhir | pass | [] |
| query-ignore-code | compact | pass | [] |
| query-ignore-code | selected | pass | [] |
| query-ignore-date-lower | fhir | pass | [] |
| query-ignore-date-lower | compact | pass | [] |
| query-ignore-date-lower | selected | pass | [] |
| query-ignore-date-upper | fhir | pass | [] |
| query-ignore-date-upper | compact | pass | [] |
| query-ignore-date-upper | selected | pass | [] |
| query-ignore-sort-proven | fhir | pass | [] |
| query-ignore-sort-proven | compact | pass | [] |
| query-ignore-sort-proven | selected | pass | [] |

## Evidence to record (every control passed in both eras: query-complete-proven, query-cross-page-sort, query-empty-page-with-next-proven, query-ignore-code, query-ignore-date-lower, query-ignore-date-upper, query-ignore-sort-proven)

```json
{
  "evidence": {
    "report_sha256": "d06b6f4818acecaa069cfbffc6d3dc5587d6aa30bd290b42d08154681e1ba960",
    "recorded_at": "2026-10-22T16:24:22.193Z",
    "capability_revision": "d4e500616f35fe24",
    "tasks_sha256": "ce7c9440fac53024ae0cb8454406e014fc6e12216f334ad05faae837a66252ee"
  },
  "source": {
    "fixture_sha256": "c14e170bd47671f357b2ef81338cae6252372bf2dbc5817f4cf814ce8b288f1a",
    "backend_sha256": "763bfddce2221d4432d748a61634c2b65d3ce69a412f24fddeb387324381f4b5"
  }
}
```

Report files: .local/s6-qualification/report-modern.json, .local/s6-qualification/report-legacy.json (hash over the canonical JSON of both reports).
