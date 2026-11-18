# fireboat benchmark harness

This folder holds the harness behind the published benchmark results in [docs/BENCHMARK.md](../docs/BENCHMARK.md). It compares MCP servers that give an AI agent access to one patient's FHIR records. It is not part of the fireboat package, and fireboat's own checks (`npm run check`) do not run it.

The harness drives each server with the same scripted tool calls. No AI model is involved in the scripted track. Answers are checked against gold answers computed from the raw data files.

## What it measures

For each server ("arm") and each question, the harness starts a fresh server process, runs the question's scripted plan of searches, reads and page fetches through the server's own tools, and records every raw response. It then scores:

- **Correctness.** Every gold record must come back with the right value, unit, time and identity. Where the answer is read from a record (a drug, diagnosis or location name, the conditions in a note, the members of a care team, a patient's demographics), the returned copy must still yield it. For list questions, every record the answer depends on must come back too.
- **Completeness labels.** When a result is cut short, did the server say so? Each list question gets a verdict:
  - `complete`: everything was returned;
  - `signalled_partial`: part was returned, and the server said so;
  - `silent_truncation`: part was returned, with no signal;
  - `false_completeness`: part was returned, and the server claimed it was complete.
  A list operation that errored or was refused gets no verdict ("no result").
- **Exact decimal text.** Whether recorded numbers such as `1.0` or `0.10` come back with the same text.
- **Confinement.** Probes ask for another patient's records in different ways (a direct read, another patient's id in a search, includes, chained parameters, a tampered continuation and others). The harness counts other-patient records in the output.
- **Writes.** Probes try create, update, patch, delete and transactions. A recording proxy in front of the FHIR server answers every write with 403, so the data never changes. The probe records whether the server forwarded the write.
- **Size.** Bytes of `content[].text` and `structuredContent`, reported separately.
- **Robustness** (`bench:fuzz`): 100 malformed or adversarial inputs per arm.
- **Latency** (`bench:latency`): one long session per arm, descriptive only.

An agent track (`bench:agent-smoke`) runs Claude Code against an arm. It is a harness check capped at 6 runs, not a result.

## Arms

| Arm | What it is |
| --- | --- |
| FB0 | fireboat as first published (its first public commit), default configuration. That commit is not in the public repository, so FB0 is skipped there (see "Known limits"). |
| FBd | fireboat built from this repository, default privacy configuration: patient identifier systems only. |
| FB | The same build with the operator's general shared-record lists (`privacy.sharedIdentifierSystems`, `privacy.sharedProfiles`). |
| FBt | FB plus one listing written for the MIMIC data (a medication-mix identifier system). It is tuned to one dataset, so it is reported separately. |
| W | WSO2 fhir-mcp-server 0.11.0 over stdio, authorization disabled (the local FHIR server has no sign-in), page size 200. |
| Ws, Wm | W against a local Medplum 5.2.6: Ws with a client confined to the run patient by an AccessPolicy, Wm with a system-level client. Development Synthea data only. |
| M | the-momentum/fhir-mcp-server 0.1.0. |
| H | fhirhydrant 0.17.3. |
| FBh, FBdh | FB and FBd against an AWS HealthLake data store, through a local signing proxy. Holdout data only. |
| AH | The AWS HealthLake MCP server 0.0.21 (`awslabs.healthlake-mcp-server --readonly`) against the same data store. |
| NT | No tools. Agent track only. |

Pins, install steps and exact launch commands are in `servers/arms.ts` and `servers/install.ts`. Third-party arms install from hash-checked artifacts and the lock files in `servers/locks/`.

**Which fireboat is built.** FB, FBd, FBt, FBh and FBdh build fireboat from the repository this harness sits in, at its git HEAD. `bench:install` makes a clean clone at that commit and runs `npm ci` and `npm run build`. Uncommitted changes are not in the build. Every manifest and run record stores the commit and whether the checkout had uncommitted changes (`commitFrom`, `treeDirty` in the arm pin; `versions.arm_pin` and `versions.arm_tree_dirty` in run records). To build another commit of this repository, set `FB_COMMIT` to a hash, tag or branch.

## Datasets

The harness reads three datasets. None of them is in the repository.

- **Synthea development subset.** 99 synthetic patients from the Synthea Coherent Data Set (CC BY 4.0, MITRE): every 13th bundle of the bucket listing (`awk 'NR % 13 == 1' all-files.txt`). fireboat was developed against this data.
- **MIMIC-IV Clinical Database Demo on FHIR, v2.1.0** (ODbL). Real, de-identified records of 100 patients. You download it yourself from [PhysioNet](https://physionet.org/content/mimic-iv-fhir-demo/2.1.0/). It is never committed, and neither is anything derived from it: patient ids, questions, answers, values or per-question results. Questions, gold and runs use only the development patients you list in the local config (see below). fireboat was developed against this data, so treat MIMIC results as optimistic.
- **Synthea holdout.** A fresh sample of 99 Synthea patients that was never used in development. The candidates are the 1,179 Coherent bundles outside the development subset. They are ranked by `sha256` over the public randomness of drand round 6644725 (League of Entropy mainnet), and the first 99 that convert are taken; a bundle that fails its check is replaced by the next in rank order. The same randomness draws the holdout's questions.

Citations and licence terms are in [docs/TESTING.md](../docs/TESTING.md#benchmarks-and-research-data).

## Questions and gold answers

Questions come from fixed templates (`gold/templates.ts`): labs and vitals, medications, microbiology, diagnoses, procedures, encounters, claims, notes, immunizations, care plans, imaging, devices and demographics. Each dataset family has its own table of 150 questions. Candidates are ranked by a canonical hash (`lib/hash.ts`) and taken in that order, at most 6 per patient unless a template's pool is too small. No random-number library is used. The development datasets use a fixed development seed (64 zeros); the holdout uses the drand randomness above.

Each question carries its scripted plan: abstract operations (`capabilities`, `read`, `search`, `next`, `drain`) that each arm's adapter turns into calls to that server's own tools (`servers/adapters.ts`). A `drain` follows pages until there are none, up to 20 calls; a run makes at most 40 calls. These caps are harness rules, the same for every arm.

There are also two separate question sets, the strata. Neither is mixed into the main 150:
- **Long lists:** questions about every record in a set (the distinct codes, or the largest value), in four size bands: B1 21–100 records, B2 101–200, B3 201–1,000 and B4 4,001–10,000. B4 is beyond the call cap for every arm, so it is scored on the verdict: `signalled_partial` passes.
- **Decimals:** value questions whose recorded text a float round trip would change.

Gold answers are computed from the raw files only, never from a FHIR server or an MCP server. There are two independent implementations: TypeScript (`gold/`), which scoring uses, and Python (`gold/py/`), written as a cross-check from the template text and the written rules. `bench:gold-compare` compares them question by question. [GOLD-RULINGS.md](GOLD-RULINGS.md) states how both resolve the cases the question text leaves open.

## Scoring

`bench:score` parses every run with the arm's parser and compares it with gold (`run/score-lib.ts`):

- A value passes if the returned record holds a decimal-equal value with the record's unit. A time passes if it is the same instant at the gold's precision. Identity passes if the gold record's id came back and names the question's patient.
- Where the answer is read from a record, the gold rule's own extraction is applied to the returned copies (`gold/rules.ts` `ANSWER_ENTRIES`), the same for every arm. Where each record gives one entry (drug, diagnosis, procedure, allergy, device, result, antibiotic and organism names, diagnosis codes, encounter classes, a location's name, an order's route), some copy of the record must yield the gold item's entry. Where one record holds the whole answer (a note's conditions, care-team members, an encounter's reasons, care-plan activities, imaging series and counts, a patient's demographics, a stay's length), some copy must yield the whole gold list. Where the answer is the item's own value as text (L7), or a list of values that may include text or no value (L2, L5), or a claim total that may be missing (F1), some copy must yield the item's value as the gold reads it, and a copy of a record recorded without a value must carry none. For a value recorded as absent (L9), the copy must still state a `dataAbsentReason` that is present and not empty, and carry no value. Where a record names the item (an ICU stay's Encounter names its Locations, a lab report names its results), some returned copy of that record must still reference the item (if no copy of it came back, the question already fails on coverage). A record named by reference (a Medication and a mix's ingredients, a microbiology test and its Specimen) is read from its own returned copies, each tried in turn (bounded); if no copy came back or none carries the field, the item fails. Names are read strictly, concept text first and then the first coding's display, so a copy that keeps only the display where the gold used the text fails. A compact copy is read as the parsers read it (`servers/items.ts`) where that does not change the gold's reading: a CodeableConcept given as a plain string is its name (also a value's `valueCodeableConcept`), a concept wrapped in a list is its first element, a Reference given as a plain string is the reference, and a Coding given as a plain string is the field the gold reads. For long-list codes (LS1, bands B1 to B3), some copy of each record must yield only gold codes and those copies together must yield all of them; B4 is scored on the verdict and not checked. A failing check is recorded as `answer_text_missing`.
- A question is correct when every gold item passes, no other-patient record was returned, no read was suppressed, and, for a list question, the returned records cover every record the answer depends on and include nothing outside that set.
- The summary score over list questions counts `complete` 1, `signalled_partial` 0.5, and `silent_truncation`, `false_completeness` and "no result" 0. There is no single combined score across measures.
- Every campaign runs twice (pass 1 and 2). Pass 1 is scored; `consistency.json` lists any difference between the passes.

`bench:scripted-report` writes the tables, the full list of scoring rules and the known limits.

## Requirements

- **macOS.** Every MCP server runs inside a `sandbox-exec` profile that blocks all outbound connections except loopback, and the FHIR servers run in Docker through colima.
- **mise**, with Node 24.22.0, Python 3.12.16 and 3.13.18, and uv 0.13.7. `bench:toolchain` checks them.
- **Docker** (colima and Docker Compose) for HAPI FHIR 8.12.0 with PostgreSQL, and for the optional Medplum stack. Images are pinned by digest. colima runs at 4 CPU and 8 GiB (`infra/docker.ts`).
- **Network** for installing the arms (PyPI, npm and GitHub), pulling images, and fetching the holdout from the public Synthea bucket. The servers under test reach loopback only.

What costs money:
- **AWS HealthLake** (arms FBh, FBdh, AH) creates a billed data store. `bench:healthlake -- plan` prints the resources and a cost estimate first. Every paid step needs its own flag (`--yes-create`, `--yes-load`, `--yes-delete`), and `teardown --yes-delete` deletes everything the harness recorded. It needs the AWS CLI, signed in to a profile named `fireboat` (region us-east-2).
- **The agent track** calls the Anthropic API through Claude Code 2.1.322 and needs `ANTHROPIC_API_KEY`. `--mock` runs the same pipeline against a local stand-in with no model and no cost.

Everything else runs locally at no cost.

## Locations

All state lives under `.local/` at the repository root, which git ignores. You can move it with these environment variables (relative paths are taken from the repository root):

| Variable | Default | Holds |
| --- | --- | --- |
| `BENCH_LOCAL_DIR` | `.local` | Installed servers, temporary files, the local config |
| `BENCH_DATA_DIR` | `$BENCH_LOCAL_DIR/bench-data` | The downloaded datasets (read only) |
| `BENCH_RESULTS_DIR` | `$BENCH_LOCAL_DIR/bench-results` | Converted data, questions, gold, run records, scores, manifests |
| `BENCH_CLAUDE_BIN` | `~/.local/share/claude/versions/2.1.322` | The Claude Code binary for the agent track (its sha256 is checked) |
| `FB_COMMIT` | HEAD of this checkout | The commit the fireboat arms build |

## Setting up

1. Install the toolchain and the dependencies, from the repository root:

   ```sh
   mise install node@24.22.0 python@3.12.16 python@3.13.18 uv@0.13.7
   export PATH="$(mise where node@24.22.0)/bin:$PATH"
   npm ci
   npm --prefix bench ci --ignore-scripts
   npm --prefix bench run bench:toolchain
   ```

2. Put the datasets under `$BENCH_DATA_DIR`:

   ```text
   mimic-iv-fhir-demo-2.1.0/    the PhysioNet download as published: fhir/*.ndjson.gz (30 files) and SHA256SUMS.txt
   synthea-coherent-100/
     fhir/                      the 99 bundles named in bench/data/synthea-coherent-100/selected-files.txt
   ```

   The three Synthea file lists (`all-files.txt`, `selected-files.txt` and `SHA256SUMS.txt`) are included in `bench/data/synthea-coherent-100/`, with their source and licence. The bundles are not: download the 99 named in `selected-files.txt` from `https://synthea-open-data.s3.amazonaws.com/coherent/unzipped/fhir/<name>` (name URL-encoded). A copy of the lists in `$BENCH_DATA_DIR/synthea-coherent-100/` is used instead when present. To rebuild them yourself:
   - `all-files.txt`: every file name under `s3://synthea-open-data/coherent/unzipped/fhir/`, one per line, bytewise sorted;
   - `selected-files.txt`: `awk 'NR % 13 == 1' all-files.txt`;
   - `SHA256SUMS.txt`: in the folder of the 99 bundles, `LC_ALL=C shasum -a 256 * > ../SHA256SUMS.txt`, with file names in Unicode NFC form.

   `bench:convert` checks every file against its `SHA256SUMS.txt`, and the sums files and `selected-files.txt` against the digests pinned in `data/checksums.ts`; `bench:holdout -- plan` checks `all-files.txt` against `holdout/select.ts`. So you know your inputs are the ones the published runs used.

3. Create `$BENCH_LOCAL_DIR/bench-config.json`. It holds identifiers taken from the data, so it is never committed:

   ```json
   { "mimic_dev_patients": ["<MIMIC Patient.id>", "..."],
     "known_patient": { "mimic": "<one of mimic_dev_patients>", "synthea-dev": "<Patient.id of the first selected bundle in name order>" },
     "lexeme_probe": { "ref": "Observation/<id>", "lexeme": "<its recorded value, with trailing zeros>" } }
   ```

   - `mimic_dev_patients`: the MIMIC patients questions may use. The published runs used six patients; their ids are not published, so your MIMIC question set will differ.
   - `known_patient`: one patient per dataset, read to confirm the FHIR server holds that dataset. `bench:holdout -- convert` adds the holdout's.
   - `lexeme_probe`: a MIMIC Observation of a development patient whose `valueQuantity.value` has trailing zeros. The load check confirms that HAPI returns that exact text.

   For a Synthea-only run, the MIMIC entries can be placeholders.

4. Install the arms: `npm --prefix bench run bench:install` installs the defaults, FB and W; add `-- --arm <arms>` for others (comma-separated). FBd, FBt, FBh and FBdh share FB's build.

## Running

Run each command as `npm --prefix bench run <script> -- <flags>`. Commands given no `--arm` use the default arms FB and W, which install from a fresh checkout; name any others explicitly. FB0 is never a default. `run/setup.sh <campaign> [dataset ...]` runs the whole sequence below for FB and W and stops at the first failure. `run/baseline.sh <campaign> <dataset> ["<arms>"]` runs every scripted pass for one dataset, one arm per slot in parallel (default `"FB W"`).

Per dataset (`mimic`, `synthea-dev` or `synthea-holdout`):

| Step | Command |
| --- | --- |
| Start HAPI on the dataset's database volume | `bench:infra:up -- --dataset <d>` |
| Verify and convert the input files | `bench:convert -- --dataset <d>` |
| Load into HAPI; repeat while it exits 3 (time budget spent) | `bench:load -- --dataset <d>` |
| Generate questions and probes | `bench:questions -- --dataset <d>` |
| Compute the TypeScript gold | `bench:gold -- --dataset <d>` |
| Compute the Python gold (in `bench/gold/py`) | `uv run fbgold --dataset <d>` |
| Compare the two | `bench:gold-compare -- --ts $R/gold/<d>/gold.ts.jsonl --py $R/gold-py/<d>/gold.py.jsonl` (`R` is `$BENCH_RESULTS_DIR`) |
| Check that each arm starts and lists its tools | `bench:arms-check -- --dataset <d> --arm <arms>` |
| Run the questions and probes, pass 1 then pass 2 | `bench:scripted -- --campaign <c> --dataset <d> --arm <arms> --set all --pass 1` |

Then, per campaign: `bench:score -- --campaign <c>` and `bench:scripted-report -- --campaign <c>`.

The strata use their own folder, for example `S=$BENCH_RESULTS_DIR/strata`:
- `bench:questions -- --dataset <d> --strata long-list,decimal --out $S/<d>`
- `bench:gold -- --dataset <d> --out $S/<d>`
- `bench:strata-measure -- --dataset <d> --out $S` (counts only)
- `bench:scripted -- ... --set questions --strata $S` and `bench:score -- --campaign <c> --strata $S`

The holdout:
1. `bench:holdout -- plan --seed c4c93bc7fad19f355c6f53a6a67575fdeda9d6c88df7f8eb6ba31c9e0ca4ba51 --seed-kind drand --round 6644725 --chain-hash 8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce` ranks the candidates and prints a label.
2. `bench:holdout -- fetch --label <label> --download` downloads them.
3. `bench:holdout -- convert --label <label>` converts them.
4. `bench:holdout -- load --switch-stack` loads them into HAPI.
5. Continue from `bench:questions -- --dataset synthea-holdout`.

`bench:holdout -- dry-run` runs the same selection on the development bundles without downloading anything.

Other backends and tracks:
- **Medplum** (Ws, Wm): `bench:medplum:up`, `bench:medplum:load -- --dataset synthea-dev`, `bench:medplum:clients -- --dataset synthea-dev`, then `bench:scripted` with `--arm Ws,Wm`.
- **HealthLake** (FBh, FBdh, AH; holdout only): `bench:healthlake -- plan`, `create --yes-create`, `load --yes-load`, `verify`; then `bench:scripted -- --dataset synthea-holdout --arm FBh,FBdh,AH ...`; then `bench:healthlake -- teardown --yes-delete`.
- **Fuzz:** `bench:fuzz -- --campaign <c> --dataset <d> --arm <arms> --slot <s>`.
- **Latency:** `bench:latency -- --campaign <c> --dataset <d> --arm <arms> --slot <s>`.
- **Agent track:** `bench:agent-smoke -- --questions <ids> --arm <arm> --budget-usd <cap>` (add `--mock` for the free self-test), then `bench:agent-score`.

Runs resume where they stopped. Every entry point writes a manifest under `$BENCH_RESULTS_DIR/manifests/` with its arguments, input digests, tool versions, image digests and the git commit of this checkout.

## Checks

```sh
npm --prefix bench run typecheck
npm --prefix bench test
(cd bench/gold/py && uv run pytest)
```

The tests use synthetic data only. A few tests also check the real data or generated files when they are present, and skip with a stated reason when they are not: the MIMIC tests need both the downloaded data and `bench-config.json`. A `bench-config.json` that is present but malformed fails them.

## Known limits

- **FB0 cannot be rebuilt from the public repository.** It builds fireboat's first published commit, which the public repository does not contain. Every entry point skips FB0 with one message when the commit is absent. Its published results come from the development repository.
- **MIMIC question sets differ.** The development patient ids are not published, so a MIMIC run uses patients you choose, and its questions and scores are not the published ones.
- **One maintainer.** fireboat's maintainer wrote the harness, the questions and the gold rules, and developed fireboat against the MIMIC and development Synthea data. Only the holdout is untouched by development.
- **Two FHIR servers.** Results cover HAPI FHIR 8.12.0 and, for the holdout only, AWS HealthLake. Other servers may behave differently.
- **macOS only,** because of the egress sandbox and colima.
- **Unresolved Synthea references.** The shared Organization and Practitioner files are not downloaded, so conditional references to them become logical references.
- **No token counts.** No tokenizer is part of the harness. Bytes are reported instead.
- **Scripted plans, not agents.** The scripted track does not follow next links by hand or retry with other parameters, as an agent might. The agent track is a smoke test, not a result.
- **What the answer-entry check cannot see.**
  - Long-list codes are checked per record against the whole list, so a code stripped from one record but present on another is not detected.
  - Where the gold list is empty because a structured field is absent (no encounter reasons, care-plan activities or imaging series), a copy with the field stripped looks the same and passes.
  - Likewise, where a record's own entry is empty in the gold (a Condition without a code, a Device without a type, an order without a route), a copy with the field stripped looks the same and passes.
  - A patient recorded with `deceasedBoolean: false` and a copy with it stripped both read as `alive`.
  - Count questions stay decided by identity and coverage of the records, not by any field of them.
  - Diagnosis codes (C1) are read from the first coding's code, which needs no system. The microbiology-test class an organism's entry depends on (B1) and long-list codes (LS1, `system|code`) need the coding's system, so a copy whose codings lack a system, or that gives those concepts as plain strings, fails them.
  - A Coding given as a plain string is compared with the one field the gold reads (an encounter class's code; an imaging series' modality and body-site display, else code). The gold does not keep the other field, so a string holding it fails.
- **Latency is descriptive.** Runs share one machine, and arms request different page sizes (fireboat 100, the others 200 against HAPI).

`bench:scripted-report` prints the full list of scoring rules and its own list of known limits with every report, including what the answer-entry check cannot see.
