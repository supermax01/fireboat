# Quickstart seed exploration: Synthea → transform → HAPI (2026-10-24)

- **What this is:** root's exploratory run of packaging slice 6 with the owner-approved Synthea v4.0.0 JAR and Temurin 17 image (`docs/evidence/synthea-jdk-acquisition-2026-10-24.md`). It tests the generation recipe, the transform (`scripts/quickstart/transform-synthea.ts`) and HAPI ingestion fidelity on real Synthea output before the helper exists.
- **What it is not:** the frozen quickstart seed or the S8 gate. The recipe is not yet the pinned one (the generator fix below is pending), there are no edge resources yet, and the HAPI instance was started by hand, not by the helper with its ownership receipt. Synthetic data only; loopback only; generation ran with networking disabled.

## Generation

| Item | Value |
| --- | --- |
| Command | `java -jar synthea-with-dependencies.jar -s 42 -cs 42 -p 1 -a 60-85 -r 20260101 -e 20260101 -c quickstart.properties Massachusetts`, JVM `-Duser.timezone=UTC -Duser.language=en -Duser.country=US -Dfile.encoding=UTF-8` |
| Container | `eclipse-temurin@sha256:f6838d4bc55df9a3b03783e04f1d26b3c163b96faf153e3a54468ec3fdcbd7f5`, `--pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges`, JAR mounted read-only after its SHA-256 was re-checked |
| Properties | R4 export on (transaction bundles), other formats off, `exporter.years_of_history = 0`, `exporter.fhir.use_us_core_ig = false`, hospital and practitioner exports on, `exporter.metadata.export = false`, `generate.thread_pool_size = 1`, `generate.log_patients.detail = none` |
| Time | 15–21 s per run on macOS arm64 (Colima) |
| Output | four files: two patient transaction bundles (one living, one deceased; Synthea keeps the deceased record by default), `hospitalInformation1767225600000.json` and `practitionerInformation1767225600000.json` (conditional-create batches; `1767225600000` ms is the pinned end date, 2026-01-01T00:00:00Z) |
| Reproducibility | two runs from identical inputs: **all four files byte-identical** |

Two settings are required for reproducibility, and both were missing from the slice-1 generator as first written: without `-e`, Synthea simulates to the wall clock (a run of that generator wrote `hospitalInformation1792803415328.json`, i.e. 2026-10-24T00:56:55Z, so records extend past the pinned `as_of` and file names change on every run); and the default `exporter.metadata.export = true` writes `metadata/<wall-clock>_<random uuid>.json`. Both are in the slice-1 fix round.

## Transform

| Item | Value |
| --- | --- |
| Selection | the one living Patient; its `laboratory` Observations and `v2-0074 LAB` DiagnosticReports effective in `[2020-01-01, 2026-01-01)`; a report only if every result is in the slice; the reference closure of all of these |
| Result | **277 resources**: Organization 2, Practitioner 2, Patient 1, Encounter 5, Observation 239 (58 distinct lab codes; several codes with 7 results), DiagnosticReport 28; 233,780 bytes |
| Natural HbA1c (LOINC 4548-4) in the window | 1 |
| References | 745 `Type/id` references, all resolving inside the seed; none left as `urn:uuid:` or identifier search; none points at the same or a later PUT |
| Identifiers | the Patient's synthetic SSN, driver's-licence and passport identifiers removed (1 each); none of their values occurs anywhere in the seed |
| Numbers | for every one of the 277 resources, the sequence of number lexemes in the output equals the sequence in the raw source text (checked with an independent text scan, not the transform's parser) |
| Determinism | the seeds from the two runs are byte-identical; NDJSON SHA-256 `77b228eacc398b0ed2607a56177bed226be4fb6b9646c30c0e9daa857272603f` (before provider sanitisation; the current seed is `fbdd9f8f…`, see Provider data below) |
| Time | about 2 s per run |

## Ingestion into HAPI FHIR 8.12.0

A fresh disposable instance from `hapiproject/hapi@sha256:0ff86aac4c7bd13a1ee226444a70263bb46ed1c28ef543c30a44f865b80ca04e`, published on `127.0.0.1:18080` only; every seeded type counted zero first.

| Item | Value |
| --- | --- |
| Writes | 277 individual `PUT Type/id` in the transform's order: all `201`, 4.4 s total; first 154 ms, median 13 ms, slowest 154 ms |
| Read-back | **277 of 277 identical** to the bodies sent, ignoring only the server-managed `meta.versionId`, `meta.lastUpdated` and `meta.source`, with number lexemes compared exactly (18-digit fractions included); every stored `versionId` is `1` |

## Review rounds

GPT-6.1-Sol reviewed the transform adversarially and read-only, twice.

- **Round 1:** 2 high, 8 medium and 2 low findings, no critical one: contained resources and logical references bypassed the type and patient rules; selection compared raw reference strings; invalid UTF-8 was replaced and input hashes covered re-encoded text; the window truncated dates and ignored offsets; the closure could re-add an excluded report; the identifier-residue check depended on encoding; some error paths leaked text; limits were enforced only after the expensive work; and 11 further weakenings passed every test.
- **Round 2 (re-check of the fixes):** 5 findings closed, 7 partly closed, none open, and 7 further issues: logical references could still escape during selection; percent escapes in identifier searches; offsets beyond ±14:00, touching reversed Periods and Date.UTC's shift of years 0–99; residue hidden in XHTML attributes or behind a quoted `>`; an out-of-range character reference threw a native error; the CLI read every file before checking the input bound; and typed identifiers without `Identifier.system` were untested.

- **Round 3 (confirmation):** all closed except two follow-on cases: a Period reversed by less than a millisecond, and an apostrophe inside an XML comment hiding narrative residue.

Root fixed all of them, the round-3 cases included. The transform now refuses contained resources, `#local`, logical (identifier-only) references wherever they appear, a `Reference.type` that disagrees with the target, `urn:uuid` values outside a `reference`, relative `Type/id` and percent-escaped identifier searches; resolves every reference before selection; validates FHIR date/time values (offsets at most ±14:00, years 0–99 kept, any number of fraction digits) and compares UTC intervals, with partial dates and Periods wholly inside the window and reversed Periods refused, comparing every fractional digit; refuses invalid UTF-8 and hashes raw bytes; keeps clinical resources outside the slice and other patients' Encounters out of the closure; checks residue on decoded values, decoded narrative markup and decoded rendered text with token boundaries (comments not rendered, CDATA as text, other markup declarations refused), refusing invalid character references; and enforces every bound as it goes, the CLI checking file sizes before any read (an 8,000-lab oversize case refuses in about 0.1 s). The tests grew from 13 to 19; root's weakening check now applies 64 guard weakenings, including Sol's additional ones, and 63 are caught by named tests (the remaining one, comparing lexemes against the clone rather than the source, is a defence-in-depth check that only matters if cloning is also broken). On the real export the transform produces the same seed after both rounds: 277 resources, NDJSON SHA-256 `77b228eacc398b0ed2607a56177bed226be4fb6b9646c30c0e9daa857272603f`, with byte-identical manifests across the two runs and from the pinned generator's own output.

## Edge resources

Root added the reviewed synthetic edges A6 allows (`packages/evals/fixtures/quickstart/edges.json`), merged into the natural seed by `scripts/quickstart/edges.ts` as rows labelled `origin: "edge"`: a corrected HbA1c `7.00 %`, an entered-in-error HbA1c `6.10 %`, a second Patient without identifiers, that patient's in-window HbA1c, and a DocumentReference with inline base64 text. Edge ids are `qs-edge-*`; references name the natural patient only through the token `Patient/$natural` or another edge of the same patient, and edges are written targets first.

GPT-6.1-Sol reviewed the merge adversarially and read-only: 2 high, 5 medium and 2 low findings, no critical one. The seed check trusted hashes without parsing the bodies, so rebinding `manifest.patient` or a row whose id disagreed with its body passed; edge-to-edge links could cross patients; edges were sorted lexically rather than by dependency and cycles passed; `valueUri`, `valueCanonical` and `urn:uuid` values escaped the reference check; a valid `effectiveDateTime` masked a simultaneous out-of-window `effectivePeriod`; merged rows could exceed the helper's manifest limits; the CLI's size preflight did not bound its reads; minimal Observation and document fields were unchecked; and a failed second write left a partial output. Root fixed all of them. The seed check now parses every natural line, matches each row to its body, requires one natural Patient equal to `manifest.patient`, a closed reference graph and the selection bounds, and turns any malformed structure into `SEED_INVALID`; every edge belongs to one patient and may link only within that patient's graph (`EDGE_OWNER_MISMATCH`), the edge Patient links nothing, edges are written in dependency order with cycles refused (`EDGE_REFERENCE_CYCLE`), resource-addressing primitives refuse, a lab Observation needs a status, a code and exactly the `effectiveDateTime` choice, a document needs a status, a valid date when present and canonical base64 with a nonempty content type, merged rows are checked against the helper's per-body, row, type and total limits (`SEED_LIMIT_EXCEEDED`), the CLI reads each input once from a sized descriptor without following links, and output is staged and published with one rename. On the real seed the merge output is unchanged (282 resources, NDJSON SHA-256 below). Tests: `tests/quickstart-edges.test.ts` (15, including Sol's two further surviving weakenings); root's weakening check applies 68 guard weakenings and each is caught by a named test and compiles.

| Item | Value |
| --- | --- |
| Merged seed | 282 resources (277 natural, 5 edge); NDJSON SHA-256 `5209c70f591f0b78654d1f0c42c4c9c6e691d795cec3bade843f061f37126b7b` from the sanitised natural seed `fbdd9f8f5db89efc73a95c0822e8e323460db0b3a6257a02da36ca430d039b27` (before sanitisation `3bf49413…`) |
| Writes and read-back | a fresh disposable HAPI as above (the sanitised seed on `127.0.0.1:18082`, one CPU): 282 `PUT`s, all `201`; **282 of 282** read back identical |
| Checked-in fixtures | `packages/evals/fixtures/quickstart/`: `generation.properties` (the pinned generator's effective properties), `natural-r4.json` (the natural seed's manifest), `edges.json`, and the merged `resources.ndjson` and `seed-manifest.json`; `tests/quickstart-fixtures.test.ts` rebuilds the merged files byte for byte from the natural prefix and the edges |
| Gateway, bound to the natural patient | HbA1c search (`code=http://loinc.org\|4548-4`, `date=ge2020-01-01`, `date=lt2026-01-01`): the natural result plus the corrected and entered-in-error ones with their statuses, never the other patient's; reading the other patient's HbA1c: `NOT_FOUND` with the same safe message as an absent id; the document read withholds `/content/0/attachment/data` (`V1_PAYLOAD_WITHHELD`) and keeps the title; the `7.00` lexeme survives |

## Provider data and the edge re-check

Sol's re-check of the edge fixes (`b77fdaf`) closed 8 of the 11 items and found 4 medium and 2 low issues. The most important: the natural seed's two Organizations carried the names, street addresses and telephone numbers of real facilities, which Synthea copies from its bundled provider files (one is a real VA clinic), and the two Practitioners carried identifiers in the NPI namespace. The patient data was synthetic throughout, but the project's rule is synthetic data only.

Root changed the transform: organisation and location names become numbered stand-ins (`Synthetic organization 1`), provider telecom, address, position, alias, contact, photo and qualification fields are removed, NPI-namespace identifiers are removed after they have resolved their references, and displays of references to organisations and locations are dropped; a removed name, telephone value or street line found anywhere else refuses the seed (`PROVIDER_RESIDUE`; towns and postcodes are not checked, because patients share them). The manifest records the tally (`providers: { sanitized: 4, npi_identifiers_dropped: 2 }`). The transform now also checks its own output against an exported seed contract (`checkSeedContract`: admitted types, one living Patient without government identifiers, provider stand-ins only, no contained resources, every reference literal, consistent with its `type` and to an earlier row, labs and reports of that Patient inside the window, Encounters and Conditions of that Patient, and the manifest's shapes), which the edge merge applies to a natural seed it did not produce.

The edge merge now admits only a closed set of reviewed elements and datatypes per edge type (no extensions, narrative, identifiers or other link-bearing elements, no blank strings), which closes the remaining address cases and removes the false refusals of ordinary terminology and note text; a document date must be a FHIR instant; a missing output parent is created; and the CLI's file operations are injectable, so tests cover a file that grows or shrinks after its size is read, the no-follow and non-blocking open flags, and that the output appears only complete.

| Item | Value |
| --- | --- |
| Natural seed | 277 resources, unchanged in membership and order; NDJSON SHA-256 `fbdd9f8f5db89efc73a95c0822e8e323460db0b3a6257a02da36ca430d039b27`, identical from both raw exports |
| Content | no facility name, telephone value, street line, NPI or other government-identifier namespace remains (checked independently by `tests/quickstart-fixtures.test.ts`) |
| Tests | transform 20, edges 15, fixtures 4; root's weakening check applies 67 edge and 26 new transform guard weakenings, each caught by a named test and compiling |

## Consequences

- The natural path (pinned generator → transform → HAPI) works and is reproducible; the remaining natural-seed work is the slice-1 generator fix, then a run of the pinned generator itself.
- The natural seed has no decimal with a trailing zero, no corrected or entered-in-error lab, no second patient's lab and no document payload, so the quickstart tasks need the separately labelled edge resources A6 allows (now added; see Edge resources). Seed 42 has one natural HbA1c in the window, enough for the HbA1c task's natural case.
- The seeding client's 3 s per-request deadline is comfortable for this HAPI.
