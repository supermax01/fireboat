# Gold answer rules

Every benchmark question has a gold answer: the answer, the records it is read from, and every record a server must return for the answer to be known to be right. Gold is computed from the raw dataset files only. It never asks a FHIR server or an MCP server.

There are two independent implementations:
- TypeScript, in `bench/gold/` (`rules.ts`, `templates.ts`, `longlist.ts`). Scoring uses this one.
- Python, in `bench/gold/py/src/fbgold/`. It is a cross-check, written from the question templates and the rules below, not from the TypeScript code.

`bench:gold-compare` compares the two question by question. This file states how both resolve the cases the question text leaves open. The tests for these rules use synthetic records only: `bench/tests/gold-rulings.test.ts`, `bench/tests/strata.test.ts` and the tests under `bench/gold/py/tests/`.

The Python implementation writes the tag of each reading it applies into the gold record's `rule_notes` (for example `L1-a`, `G6` or `O2-ruling`), so a difference from the TypeScript gold can be traced to a rule. A note that begins with `unanswerable:` means a rule excluded the question.

## Fields of a gold record

- `answer`, `answer_list`, `value_as_recorded`, `unit` and `timestamp` are strings or null.
- Values are canonical plain decimals with no trailing fractional zeros: `12.3400` becomes `"12.34"`, and the recorded text stays in `value_as_recorded`. A comparator is kept as a prefix (`">300"`).
- `answer_kind` is `value`, `list` or `none`. A "none" answer has null answer fields.
- Counts are decimal integer strings. Yes/no answers are `"yes"` or `"no"`. `answer_list` is sorted by UTF-8 byte order.
- `items`: what a scripted run must return, checked on value, unit, time and identity.
- `provenance`: the records the answer is read from.
- `depends_on`: every record needed to know the answer is right, for example every candidate for "most recent". `completeness.size` is the size of this set, and `completeness.pages_at_100` is the number of pages it takes at page size 100.
- Units are the record's `unit`, else its `code`. Time windows are half-open (start included, end excluded) and compared as instants, offsets included.

## General rules

**G-R1: reachable dependencies.** `depends_on` holds only records that the question's scripted plan can reach. A record the plan never fetches cannot be required of any server.

**G-R2: ties at "most recent".** This applies to every "most recent" or "last" template.
- When several records tie at the latest instant with equal values, all of them are items.
- When they tie with different values, the candidate is excluded and never selected.

**G-R3: item times.** An item's time is one that the item's own record carries, because scoring checks it on the returned copy of that record. A record with no time (a Location, for example) gives an untimed item.

## Shared readings

These tags are general readings. They are not the drug templates G1 to G3, whose readings are tagged `G1-a` and so on.

- **G1, multi-part answers.** Answers with several parts go in `answer_list` as labelled strings, `"<label>: <value>"`, or as `"<a> | <b>"`. Lists are deduplicated, because they are graded as sets.
- **G2, unanswerable questions.** When a rule excludes a question (a latest-instant tie with different values, several claims for one encounter, a named record missing for the patient), the record has `answer_kind: null` and a `rule_notes` entry starting `unanswerable:`.
- **G3, `lexeme_eligible`.** A recorded number is eligible when its text differs from what JavaScript prints after parsing it as a binary float (ECMAScript `Number::toString`). So `1.0`, `0.10` and `1E2` are eligible, while `1.5e-7` and a 17-digit number that is already the shortest double form are not. The question-level flag is true when any item's `value_as_recorded`, with any comparator removed, is eligible.
- **G4, dates without a time.** A bare date (for example a date of death) is its own calendar day and, for ordering, sits at 00:00 UTC.
- **G5, candidates without a time** are left out of "most recent" and "first" choices.
- **G6, latest-instant ties with equal values.** The answer stands and every tied record is listed in `items` and `provenance` (G-R2).
- **G7, `items`, `provenance` and `depends_on`.** `items` has one entry per record the answer is read from. `provenance` lists those records; for a list, every record behind any entry. `depends_on` is every candidate the patient search returns; for "most recent", that is every record of the code, including records without a value. For a "no" answer to C2, `depends_on` is empty.
- **G8, names of coded things.** `CodeableConcept.text`, else the first coding's `display`, else its `code`.
- **G9, comparators** are kept as a prefix in both `answer` and `value_as_recorded`.
- **G10, answer kinds.** Counts, yes/no and date-times use `answer_kind: "value"`. A date-time answer is the recorded text, in both `answer` and `timestamp`. An empty list or no matching record is `answer_kind: "none"`. A "no" to C2 is a value, not "none".
- **G11, status filters** apply only where the template names a status (Synthea O1, C3 and K1: "active").
- **G12, money.** The unit of an amount is the Money `currency`.

## Rulings for individual templates

| Template | Ruling |
| --- | --- |
| E1 (count by class) | The answer is the total; `answer_list` is the per-class breakdown, `"<class>: <n>"`. |
| B1 (organisms from specimens on a date) | `depends_on` is the microbiology tests and organisms of specimens collected that date, as the plan reaches them, plus those Specimen records (the specimen type is read from them). Chemistry results are excluded. Susceptibilities derive from organisms, which the plan does not search on, so by G-R1 they are out. Entries are `"<organism> (<specimen type>)"`. |
| B2 (antibiotics an organism resisted) | By G-R1, the organism Observation stays out of `depends_on`, because the plan does not fetch it. |
| E2 (care unit in an ICU stay) | The item is the Location, because only `Location.name` carries the unit name. The Encounter stays in `depends_on`. Location items are untimed (G-R3). |
| G2 and every other "most recent" template | G-R2. |
| O2 (dose and route of the latest order of a named drug) | `depends_on` includes the Medication the order references, because the question names the drug. For a mix, that includes the ingredient Medications its name is built from, which the plan fetches. The route goes in `answer_list` as `"route: <route>"`. |
| K1 (activities in the active care plan of a given name) | `depends_on` is every CarePlan the plan's search returns, because they are needed to know which one is active and unique. |

## Readings for each template

- **L1-a** "Most recent value": candidates are records of the code that have a value. The most recent is chosen by `effectiveDateTime` (period start, else `issued`). Records without a value stay in `depends_on`.
- **L2-a** Window membership uses the record's effective instant. `answer_list` entries are `"<value> <unit> @ <time>"`.
- **L3-a** Count of all records of the code, any status.
- **L4-a** "During ICU stay E" is read as `Observation.encounter = E`.
- **L5-a** As L2. **L5-b** The window's size bound (51 to 300) is checked and noted, not enforced.
- **L6-a** The named record's own value and unit, even if its code or time differs (noted).
- **L7-a** "Most recent non-numeric result": the most recent among records with a text or coded value (`valueString`, `valueCodeableConcept` and so on), not "the most recent result, if it is non-numeric".
- **L8-a** The most recent panel that has both a systolic (LOINC 8480-6) and a diastolic (LOINC 8462-4) component value, read by code, not by position. Answer `"<systolic>/<diastolic>"`, one item per component.
- **L9-a** "Not recorded" is `answer_kind: "none"`, with an item whose display is the dataAbsentReason.
- **L10-a** As L1.
- **G1-a** (also O3) Drug names as coded on each administration: the `medicationCodeableConcept` name, or the referenced Medication's name. When a record carries only a formulary code, that code is the name. No status filter.
- **G2-a** The time is `effectiveDateTime`, else `effectivePeriod.start`; the dose is `dosage.dose`. **G2-b** A most recent administration without a dose gives "none".
- **G3-a** A dispensing matches on its own coding or on its Medication's code or identifier.
- **O1-a** (MIMIC) Orders with `encounter = E`. A Medication's name is its code text or display, else the identifier whose system ends `medication-name`, else its ingredients' names joined with `" + "`. Medication records are in `depends_on`.
- **O1-b** (Synthea) Orders with `status = active`.
- **O2-a** The most recent order by `authoredOn` for the named Medication. The dose is the first `doseQuantity` and the route the first `route`. The route goes in `answer_list` as `"route: <code>"`, because a value answer has no slot for it.
- **O4-a** The first `doseQuantity` of the named order. When the dose has no unit, `unit` is null.
- **B1-a** Specimens whose `collection.collectedDateTime` falls on the UTC date; tests that name them as `specimen`; organisms `derivedFrom` those tests. Every organism record counts.
- **B2-a** Susceptibility records linked by `hasMember` or `derivedFrom`. Resistant means interpretation code `R`. No resistant result gives "none".
- **C1-a** Codes only (no system), from the first coding of each Condition with `encounter = E`.
- **C2-a** Any Condition with the coding, whatever its clinical or verification status.
- **C3-a** `clinicalStatus` code `active`; names, deduplicated.
- **P1-a** Procedure names, any status, `encounter = E`.
- **P2-a** The earliest `performedDateTime` or `performedPeriod.start`; the answer is its recorded text.
- **E1-a** Class code (not display) with counts, `"<code>: <n>"`; the total goes in `answer`.
- **E2-a** The names of every Location in the stay's `location` list.
- **E3-a** `period.end - period.start` in hours, rounded half up to two places and written canonically (`12.5`, not `12.50`), unit `h`. `value_as_recorded` is null, because the value is computed.
- **E4-a** Encounters whose `period.start` falls on the UTC date; the union of their `reasonCode` names. Encounters without a reason give "none".
- **E5-a** The latest `period.start` among encounters with the type coding.
- **D1-a** `"birth date: <birthDate>"`, `"sex: <gender>"`, and `"date of death: <deceasedDateTime>"` or `"date of death: alive"`.
- **N1-a** Every DocumentReference, any status.
- **N2-a** The most recent DocumentReference by `date`. Conditions are read from the sentences "Patient has a history of ..." and "Patient is presenting with ...", split on `", "`, and joined back where the pieces form one of the patient's condition names (some names contain commas). Names are returned as the note writes them. Chief-complaint symptoms are not conditions.
- **N3-a** The most recent DiagnosticReport whose category has the question's coding, by `effectiveDateTime`. The names are each result Observation's code name.
- **F1-a** Claims whose `item.encounter` names E. Exactly one is required.
- **F2-a** Claims of any type whose `created` falls in the UTC year.
- **F3-a** The `payment.amount` of the one ExplanationOfBenefit whose `claim` names C.
- **I1-a** Every Immunization, any status. **I2-a** The latest `occurrenceDateTime`.
- **A1-a** Every AllergyIntolerance name; none gives "none".
- **K1-a** The activity names of the named care plan, deduplicated.
- **K2-a** Every participant, the patient included, as `"<member display> | <role names>"`.
- **M1-a** The most recent study by `started`; every series modality and body site, by display.
- **M2-a** `numberOfSeries` and `numberOfInstances` as declared. A difference from the listed series and instances would be noted.
- **V1-a** Device type names, deduplicated.

## Strata

The long-list and decimal strata are separate question sets (see `bench/README.md`). Their gold follows the shared rules above, with these readings.

### Decimal stratum

- **DEC-a** `DEC-<id>` returns the gold of template `<id>` unchanged, with its notes, plus `"DEC-a: gold of <id>"`. The allowed bases are MIMIC L1, L6, L8, G2 and O2, and Synthea L1, L6, L8, L10, O4, F1, F3 and CL1. Any other `DEC-<id>` is an error.
- **DEC-b** Candidates are restricted to golds whose `lexeme_eligible` is true (G3). The gold does not refuse an ineligible one; it notes `"DEC-b: gold is not lexeme-eligible ..."` so the selection can be checked. A "none" gold has no recorded text and gets DEC-b.
- **CL1-a** CL1 asks for the net amount of a named line on the patient's claim created at a given time. The claim is the patient's claim whose `created` is the same instant as `claim_created`, after offset normalisation; the `claim` parameter is only cross-checked. The line is the one whose `productOrService` carries the stated system and code on any coding. The answer is that line's `net`: canonical value, recorded text in `value_as_recorded`, unit `net.currency`, timestamp the claim's `created`. The one item is the Claim, with the line's name as display. A matched line without a numeric `net` gives "none". Any claim status counts.
- **CL1-b** The two uniqueness conditions are checked on the data, not assumed. Several patient claims at that instant, several lines with the stated coding, or another line with the same product or service name make the question unanswerable. So does a missing claim, or a line that does not carry the coding.
- **CL1-c** `depends_on` and `provenance` are the one Claim, because the plan is a read of it.
- **CL1-d** CL1 exists only as `DEC-CL1`. A bare `CL1` template id is an error.

### Long-list stratum

The long-list templates are `LS1-B1` to `LS2-B4`: two question forms in four size bands.

- **LS-a, sets.** The set is every record of the type for the patient (`subject` or `patient`), narrowed by one token when `search_param` is given and by a time window when `window_start` and `window_end` are given. The token's element comes from the type table in `bench/gold/longlist.ts` (for example the `code` parameter on MedicationRequest is `medicationCodeableConcept`). A token matches on any coding of the element, whether it is a Coding, a CodeableConcept or a list of either. No status filter. A type or token parameter outside the table is an error.
- **LS-b, bands.** B1 is 21 to 100 records, B2 101 to 200, B3 201 to 1,000 and B4 4,001 to 10,000, both ends inclusive. The band is checked against the gold set size and noted when outside; it is not enforced. The gold is computed the same way in every band.
- **LS-c, windows.** Only the type table's window element counts (Observation `effectiveDateTime`, not `effectivePeriod` or `issued`; Procedure `performedDateTime`; Specimen `collection.collectedDateTime`; Claim and ExplanationOfBenefit `created`; and so on). Every matching record must carry a dateTime to the second with `Z` or a `±hh:mm` offset. If any does not, the window question is unanswerable, even when that record would fall outside the window. Both bounds must have that form. Membership is `start <= t < end` on UTC instants. A type without a window element (Encounter, Condition) cannot take a window.
- **LS1-a, distinct codes.** Every coding of the type's code element on every record in the set, as `"<system>|<code>"`, deduplicated and sorted. `items` and `depends_on` are every record in the set. An item carries no value; its time is the window element (null for types without one) and its display is the code element's name (G8). `provenance` is the records that add at least one pair. An empty set, or one whose records carry no codings, is "none".
- **LS1-b** A question whose token is on the code element it asks about is unanswerable.
- **LS1-c** For medication types the code element is `medicationCodeableConcept`. A record that names its drug by `medicationReference` is in the set and in `depends_on` but adds no code; the Medication is not resolved.
- **LS1-d** A coding without both a `system` and a `code` adds no pair.
- **LS2-a, largest value.** Observation sets use `valueQuantity` only; Claim sets use `total`. Every record must hold a plain number (numeric, no comparator). The maximum is compared as an exact decimal; the answer is its canonical form, with the recorded text in `value_as_recorded`.
- **LS2-b** One record without a plain number, or two different units in the set, makes the question unanswerable. The unit compared is `unit`, else `code`; for claims it is `currency`.
- **LS2-c** If the records holding the maximum write it differently (`7` and `7.0`), the question is unanswerable. Different spellings below the maximum do not matter.
- **LS2-d, ties.** Every record holding the maximum is an item and in `provenance`. `timestamp` is that record's time (Observation effective time, Claim `created`). When tied records differ in time, it is null, because the question asks for no time.
- **LS2-e** A set with no unit on any record has a null gold unit (noted).

## What the two implementations may still differ on

`bench:gold-compare` reports these differences. They do not affect scoring, which uses the TypeScript gold:
- wording inside `answer_list` entries: D1 field labels, M1 series entries, and K2 member and role separators;
- which optional item fields each side fills: values on L3, L4, G1 and N3 items, and onset time on C3 items. Where the TypeScript gold fills a value or time, it is copied from the item's own record.
