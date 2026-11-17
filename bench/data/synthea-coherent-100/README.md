# Synthea Coherent Data Set: file lists

These three files describe which Synthea bundles the benchmark uses. They hold file names and checksums only, no patient records.

| File | What it is |
| --- | --- |
| `all-files.txt` | Every file name under `s3://synthea-open-data/coherent/unzipped/fhir/` (1,278 patient bundles plus `organizations.json` and `practitioners.json`), one per line, bytewise sorted. |
| `selected-files.txt` | The development subset, every 13th name: `awk 'NR % 13 == 1' all-files.txt` (99 bundles). |
| `SHA256SUMS.txt` | The sha256 of each of those 99 bundles, written in the folder that holds them: `LC_ALL=C shasum -a 256 * > ../SHA256SUMS.txt`. |

The harness pins the sha256 of all three files (`data/checksums.ts`, `holdout/select.ts`). The bundles themselves are not here: download the 99 named in `selected-files.txt` into `$BENCH_DATA_DIR/synthea-coherent-100/fhir/` (see `bench/README.md`). A copy of these lists under `$BENCH_DATA_DIR/synthea-coherent-100/` is used instead of this folder when present.

## Source and licence

The names and checksums come from the Synthea Coherent Data Set, a synthetic data set generated with Synthea and published by The MITRE Corporation in the AWS open data bucket `synthea-open-data` ([registry.opendata.aws/synthea-coherent-data](https://registry.opendata.aws/synthea-coherent-data/)). The data set's own README states:

- licence: Creative Commons Attribution 4.0 International ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/));
- copyright 2021, The MITRE Corporation (MITRE Public Release Case Number 21-1917).

Cite: Walonoski J. et al. (2022). The "Coherent Data Set": Combining Patient Data and Imaging in a Comprehensive, Synthetic Health Record. *Electronics* 11(8):1199.

Change made here: these files list a selection of the data set's file names with their checksums. The benchmark also rewrites the bundles' references before loading them (`data/synthea.ts`).
