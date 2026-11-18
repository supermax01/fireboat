# Benchmark results

A scripted, tool-level comparison of fireboat with the WSO2 fhir-mcp-server. No AI model was involved: every server got the same planned tool calls, and its answers were checked against gold answers computed from the raw data files. The methods, the scoring rules and the commands are in the [harness README](../bench/README.md).

**Which version was measured.** The fireboat arms (FBd, FB and FBt) were built from this repository's source tree as it stood when they were measured, with the harness in [`bench/`](../bench/). The main questions, the long-list and decimal question sets, the confinement and write probes, the fuzz cases and the latency sessions were run with that build on 16 and 17 November 2026 (UTC). WSO2 (W) was run again in the same campaign, at the same pinned version. The questions, gold answers and probes were regenerated from the data by this repository's harness and are identical, byte for byte, to those of the earlier published run. The repository has changed since: SMART on FHIR sign-in, which the benchmark did not use, later fixes, and the scoring correction below. The benchmark was not run again on the current tree. Some numbers come from earlier runs and were not repeated; each is labelled where it appears:
- FB0, the first public preview, which cannot be rebuilt from this repository;
- W against Medplum (the two Medplum rows in the confinement table);
- the AWS HealthLake section, measured on an earlier development version of fireboat.

**Correction, 17 November 2026.** An earlier version of this page gave fireboat 148 (default settings) and 149 (operator settings) of 150 on the fresh Synthea sample, and 148 and 149 on AWS HealthLake. Those figures were too high. Six questions ask which conditions the patient's most recent clinical note lists, and three ask who is on a care team. fireboat returns a note's metadata but never its text, and it withholds the patient's name on references to the patient, so its responses to these questions lack the answer. The scorer only checked that the right records came back with the right dates, so it counted fireboat correct on most of them. The scorer now recomputes each of these answers from what the server actually returned. Every question score on this page (main questions, long lists and decimal values, on HAPI and on HealthLake) was recomputed from the stored raw responses of the same runs: no server was run again, and no question or gold answer changed. fireboat's fresh Synthea scores fell to 140 and 141, and its HealthLake scores by the same amount. The WSO2 and AWS servers' scores did not change, and no MIMIC, long-list, decimal, probe, fuzz or latency number changed.

**Read this first.** fireboat's maintainer built both fireboat and this benchmark. The improved fireboat was developed while looking at earlier runs of the same harness. To limit that bias:
- the main results use a fresh sample of Synthea patients that was drawn from a public random beacon after development finished;
- fireboat is reported with default settings as well as tuned ones;
- every known caveat is listed below.

These results describe tool-level behaviour on two datasets served by one local FHIR server (HAPI), plus the separately labelled Medplum and AWS HealthLake rows. They do not measure how well an AI agent answers, clinical usefulness, or behaviour on other servers.

## What was compared

| Arm | What it is |
| --- | --- |
| **FB0** | the first public preview of fireboat (it cannot be rebuilt from this repository, so its numbers come from the earlier run) |
| **FBd** | fireboat built from this repository, with default settings |
| **FB** | the same build with operator settings that apply to any data: patient identifier systems, and drug identifier and profile lists |
| **FBt** | FB plus one setting written for the MIMIC data (a medication-mix identifier system); it was judged not general, so it is reported separately |
| **W** | [WSO2 fhir-mcp-server](https://github.com/wso2/fhir-mcp-server) 0.11.0, run over stdio with authorization disabled (the local FHIR server has no sign-in), page size 200 |

All arms talked to the same local HAPI FHIR server (`hapiproject/hapi:v8.12.0-2`, pinned by digest), over loopback, inside a network sandbox.

## Data

- **Fresh Synthea sample:** 99 patients from the Synthea Coherent Data Set, drawn by drand round 6644725 and never used in development. It has 113,742 records, and 150 questions were drawn by the same beacon value.
- **MIMIC-IV demo:** 100 patients loaded; the 147 questions were drawn from six development patients. fireboat was developed against this data, so treat its MIMIC numbers as optimistic.

Questions come from fixed templates: labs, medications, encounters, conditions, procedures, claims, notes, care plans, imaging and so on. Each question has a scripted plan of searches, reads and page fetches. Gold answers were computed twice, by two independent implementations (TypeScript and Python) written from the template text. They first agreed on 271 of 297 development questions. After seven written rulings they agree on every answer, every answer record and every dependency set.

## Results

### Main questions (default 48 KiB response limit, first pass)

| Arm | Fresh Synthea (150) | MIMIC (147) | Tool calls | Text per correct answer | Silently incomplete |
| --- | --- | --- | --- | --- | --- |
| FB0 | 92 | 93 | 682 | 22.0 KiB | 6 |
| FBd | 140 | 134 | 446 | 23.9 KiB | 0 |
| FB | 141 | 140 | 446 | 23.8 KiB | 0 |
| FBt | 141 | 147 | 447 | 23.3 KiB | 0 |
| W | 148 | 147 | 359 | 36.3 KiB | 0 |

- A second pass gave the same results for every arm.
- The FB0 row comes from the earlier run of 15 November 2026. The FBd, FB, FBt and W rows are from this repository's build, and they are the same as the earlier run on development versions of fireboat, number for number.
- **Shared directory records.** Since that earlier run, fireboat delivers Practitioner, Organization and Location records only when a record of the patient's that it has already delivered names them, and searches them only by `_id`. No score in this document's re-run tables changed with it.
- Text per correct answer counts the text copy only. WSO2's structured copy is smaller than its text copy, and fireboat's two copies are equal. No token or cost claim is made.
- **Silently incomplete** counts list answers that looked complete but were not. It does not count single-record reads that came back empty without a partial signal; FBd has three of those on MIMIC (below), and FB0 three.
- **Larger responses:** raising the response limit to 128 KiB changes no fresh Synthea score (FB 141, FBd 140). W does not use this setting, so its row is unchanged.
- **Where fireboat misses on the fresh Synthea sample:** the six questions about what the latest clinical note says and the three about who is on a care team. fireboat returns notes as metadata only and withholds the patient's name on references to the patient. Its response lists the note text and the name as withheld, so the scripted plan cannot answer those questions with any settings. (An agent could read the patient's name from the Patient record itself; that was not tested.) With default settings it also misses one medication-name question, reported as partial.
- **Where FB and FBd miss on MIMIC:** questions that need drug or location names. By default fireboat withholds shared records whose profile or identifier system the operator has not listed. These misses are reported to the caller as partial, with one exception: with default settings, three questions that need a care unit's name read a Location record, and fireboat answers that read with `NOT_FOUND` and no partial signal, the same answer it gives for a record that does not exist.
- **FB0's misses:** mostly resource types and search parameters that the first public preview did not support.

### Long lists (results that need more than one page)

Questions about every record in a set, for example the distinct codes or the largest value. Counts are correct answers.

| Set size | FB0 | FBd / FB / FBt | W |
| --- | --- | --- | --- |
| 21–100 records (fresh Synthea / MIMIC) | 10 / 9 of 10 | 10 / 10 of 10 | 10 / 10 of 10 |
| 101–200 records | 6 / 9 of 10 | 10 / 10 of 10 | 10 / 10 of 10 |
| 201–1,000 records | 2 / 0 of 30 | **26 / 29 of 30** | 9 / 0 of 30 |
| Over 4,000 records (must report partial) | none drawn / 3 of 3 | none drawn / 3 of 3 | none drawn / 3 of 3 |

- WSO2 0.11.0's recorded tool list has no paging tool, and the scripted plan does not rebuild next links by hand, so here it answered from the first page (200 records). An agent could issue a follow-up search itself; that was not tested.
- fireboat's misses at 201–1,000 records hit the harness's limit of 20 calls per question; each was reported as partial.
- The FB0 column comes from the earlier run. The other columns are the same as in the earlier run.

### Exact decimal values

Values whose text a JavaScript number would change, such as `1.0` or `0.10`:
- FBd, FB, FBt and WSO2 returned all of them exactly: 30 of 30 on fresh Synthea and 19 of 19 on MIMIC;
- FB0 returned 20 of 30 and 19 of 19 (earlier run).

In Synthea, about 5% of numbers are such values, mostly money amounts. The fuzz test below exercises harder cases.

### Other-patient records (confinement probes)

Each probe asks for another patient's data in a different way. Examples: a direct read, a search with another patient's id, an include, a chained parameter, `_has`, `$everything`, and a tampered continuation. There were 50 probes per dataset in each pass.

| Arm | Probes that returned another patient's records | Other-patient records returned |
| --- | --- | --- |
| FBd, FB, FBt | 0 of 100 | 0 |
| FB0 (earlier run) | 0 of 100 | 0 |
| W, authorization disabled | 70 of 100 | 3,591 |
| W against Medplum 5.2.6 with a patient-scoped access policy (development Synthea data; earlier run) | 0 of 50 | 0 |
| W against Medplum with a system-level client (earlier run) | 35 of 50 | 6,560 |

- **How to read the W rows:** WSO2 is a general FHIR client, and it shows what the credential allows. With authorization disabled, as configured here, or with a system-level credential, it returns other patients' records when asked. When the FHIR server enforces a patient scope (the Medplum row), it returns none.
- **Where fireboat differs:** fireboat confines to one patient itself, even when the credential behind it can see every patient.
- **Write probes:** fireboat exposes no write tools. WSO2 lists create, update and delete tools; the harness blocked the 4 write requests it forwarded.

### Robustness (100 fuzz cases, development Synthea data)

| | FB0 | FB | W |
| --- | --- | --- | --- |
| Crashes or timeouts | 0 | 0 | 0 |
| Malformed requests refused before reaching the FHIR server | 19 of 19 | 19 of 19 | 17 of 17 |
| Adversarial numbers returned exactly (for example `1e-3`, long decimals) | 8 of 8 | 8 of 8 | 4 of 8 |
| Queries forwarded that the FHIR server accepted where the harness expected an error | 0 | 0 | 3 |

- The FB and W columns are from this repository's build, and match the earlier run on a development version exactly. The FB0 column comes from the earlier run.
- W passes these 3 queries to the FHIR server, which accepts them; fireboat refuses them before sending.

### Speed and long sessions (MIMIC, one session per arm, 300 timed calls)

| | FB0 (earlier run) | FB | W |
| --- | --- | --- | --- |
| Start-up to ready | 121 ms | 125 ms | 337 ms |
| First call | 155 ms | 169 ms | 7 ms |
| Later calls, median | 6.8 ms | 9.8 ms | 7.5 ms |
| Later calls, 95th percentile | 26 ms | 51 ms | 26 ms |
| Timed calls completed | 270 of 300 | 300 of 300 | 300 of 300 |

- **Which runs.** FB and W were measured with this repository's build, in one campaign, after the machine's other heavy jobs had finished. The FB0 column comes from the earlier run, which measured a development version of fireboat at 100 ms start-up, 135 ms first call, 7.0 ms median and 43 ms 95th percentile, with W at 471 ms, 6 ms, 5.9 ms and 23 ms.
- **Slower than the earlier run, for both arms.** fireboat's later calls were slower than in the earlier run, and so were W's, on the same machine and data. A second session a few minutes later, run only as a check, gave fireboat 8.2 ms median and 44 ms 95th percentile, and W 6.7 ms and 24 ms. So the run-to-run spread on this machine is about as large as the change from the earlier run, and no cause in fireboat's code was isolated. The table reports the first session; the second was run only as a check.
- **The slower first call** is fireboat reading and checking the server's capability statement (1.95 MB on HAPI) once per session.
- **FB0's failed calls** (30 of the 300 timed calls, 35 counting warm-up) are a resource type it does not support.
- **Page sizes differ** between arms: 100 records for fireboat and 200 for W, so their result sizes are not equal.
- **Session length:** an earlier development version stopped accepting searches after about 200 calls in one session, because used search cursors were never released. The versions measured here release the oldest cursor when the quota is full.

## AWS HealthLake

**Measured on an earlier development version; not re-run.** This section was not repeated with this repository's build, because it needs a billed AWS data store.

On 16 November 2026, the same fresh Synthea questions were run against an AWS HealthLake data store in us-east-2. The data store was created, loaded with the 99 patients and deleted the same day, three times. The comparison arm was AWS's own HealthLake MCP server (`awslabs.healthlake-mcp-server` 0.0.21, run with `--readonly`).

**How fireboat reached HealthLake.** fireboat connects only to servers on the same machine and cannot sign AWS requests. A small local proxy, written for the benchmark, signed and forwarded its read-only requests. So these results show fireboat's behaviour on HealthLake's responses. They do not show that fireboat itself can connect to HealthLake.

**What changed between runs.** HealthLake's search results carry no self link, and it pages with a token added to the original query. An earlier development version of fireboat refused both: it answered 18 of 150 and returned no other patient's records. fireboat now has two settings for such servers, both off by default:
- `source.selfLinkOptional`: accept a page without a self link, but only when fireboat checks every returned record against every filter itself;
- `source.continuationTokenParameter`: follow a next link that repeats the original query exactly and adds one opaque token.

The results below use both settings. fireboat was changed twice between runs after seeing its results on these questions (18, then 137, then 141 of 150, under the corrected scoring described at the top; first reported as 18, 144 and 149). The AWS server was run once and not adjusted.

| | fireboat, operator lists | fireboat, default lists | AWS HealthLake MCP server |
| --- | --- | --- | --- |
| Main questions (150) | **141** | **140** | 124 |
| Lists of 21–200 records (20) | 20 | 20 | 8 |
| Lists of 201–1,000 records (30) | 27 | 27 | 3 |
| Exact decimal values (30) | 30 | 30 | 30 |
| Probes that returned another patient's records (50) | 0 | 0 | 30 |

- **fireboat's misses:** the questions about a clinical note's text and a care team's members, whose answers fireboat's responses lack (they list the note text and the patient's name as withheld); each other miss was reported as partial. The three long-list misses hit the harness's limit of 20 calls per question.
- **The AWS server's misses on the main questions:**
  - 13 were date ranges. Its search tool takes each parameter name once, so the harness sent one bound and the answer included extra records; an agent could filter those itself.
  - Most of the rest, and 39 of the 50 list questions, were follow-up pages. On a follow-up page, version 0.0.21 rebuilds the request from the page token and `_count` only, without the original search parameters, and HealthLake answered "Invalid pagination token" every time (55 calls in that run). The harness passed each token back unchanged, as the tool's description asks.
  - One call failed with "Access denied", probably a credential refresh.
- **How to read the probe row:** the AWS server returns what the credential allows. These runs used an account-wide AWS role, so another patient's records were reachable. HealthLake can also enforce patient-level scopes through SMART on FHIR; that configuration was not tested.
- **What HealthLake did not load:** it refused all 99 Media records (a stated attachment size mismatch). No question depends on them.
- **When each arm was run:** the AWS server's results come from the second of the three runs. The data load was identical and the server was unchanged in the third.

## Caveats

- **Conflict of interest.** fireboat's maintainer wrote the benchmark, the questions and the gold rules.
- **AI assistance.** fireboat was built with the help of AI coding assistants, and AI models were used to review parts of the code and the benchmark; the tests and gates described in [docs/TESTING.md](TESTING.md) are the evidence for how it behaves.
- **Developed against MIMIC.** fireboat's improvements were made while looking at results on MIMIC and on development Synthea data. Only the fresh Synthea sample is untouched by development.
- **The improvements, and how general they are:**
  - **General:** honest coverage, narrow redaction, reference searches, the shared-record signal and cursor eviction.
  - **General, with a caveat:** the opt-in identifier and profile lists, which help only when filled in. The lists used here were read from the data's own records.
  - **Not general:** the medication-mix rule, reported only in FBt.
- **Two servers, two datasets.** Results are on HAPI FHIR 8.12.0 and, for the fresh Synthea sample only, AWS HealthLake. Other FHIR servers may behave differently.
- **Scripted, not agentic.** The same plan was sent to every server. A real AI agent might pick other calls, use larger pages, or recover differently from errors.
- **Same generator.** The fresh Synthea patients are new, but they come from the same generator, with the same record shapes, as the development sample.
- **Band design.** The long-list size bands were set around the 200-record page given to WSO2.
- **Size settings.** fireboat's default response limit (48 KiB, counted on one copy of each response) was chosen during this work, partly from a size sweep on development data.
- **Gold fixes.** Seven gold rulings and one later fix were made from the template text and the data, never from server scores. The fix: items on the MIMIC care-unit questions had been stamped with a time their record does not carry, so no server could match them. They are listed in [`bench/GOLD-RULINGS.md`](../bench/GOLD-RULINGS.md). One scoring fix was made after publication (17 November 2026, described at the top). It was found while checking why fireboat scored on questions it cannot answer, and it lowered only fireboat's scores.
- **Notes are metadata only.** By design fireboat withholds note bodies and other attachments, and the patient's name on references to the patient. It scores 0 on questions whose answer is in a note's text, or in the patient's name on a reference, with any settings.
- **Operating mode.** fireboat has only a `synthetic` mode, and the benchmark used it for the de-identified MIMIC data too. The mode is declared by the operator, not verified by fireboat.
- **One unit re-run.** The machine went to sleep during one fireboat run (FBt, first pass, one long-list question on the fresh Synthea sample), and its paging cursor expired. That one question was re-run after the machine woke; the interrupted record is kept beside the results, excluded.
- **WSO2's configuration.** WSO2 was run as its README describes for local use, with authorization disabled because the test server has no sign-in. Its maintainers were not consulted before publication, and neither were AWS's.

## Reproducing

The harness is in [`bench/`](../bench/), and its [README](../bench/README.md) describes the methods, requirements and commands. It pins every server version, downloads the datasets at run time, and regenerates every table from raw logs. The datasets themselves are not in the repository. FB0 cannot be rebuilt from this repository, and the MIMIC development patients are not published, so a MIMIC run from this repository uses other patients and other questions.

## Data credits

- **MIMIC-IV Clinical Database Demo on FHIR, version 2.1.0** (Bennett et al., PhysioNet, 2025), under the Open Data Commons Open Database License v1.0. The aggregate MIMIC scores above are derived from it and carry the ODbL attribution and share-alike terms. Full citations are in [testing and evidence](TESTING.md#benchmarks-and-research-data).
- **Synthea Coherent Data Set** (Walonoski et al., 2022), © 2021 The MITRE Corporation, CC BY 4.0. Before loading, the benchmark rewrote its conditional references to typed logical references.
