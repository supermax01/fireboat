// Locations. Everything the harness reads or writes outside its own code lives under a git-ignored folder, `.local/`
// at the repository root by default, so no dataset, converted file, question, gold answer or result is ever committed.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository that holds this harness (the checkout `bench/` sits in), found from this file's own location. */
export const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
export const BENCH = join(REPO, 'bench');

/** An optional directory override from the environment. A relative value is resolved against the repository root. */
const envDir = (name: string): string | undefined => {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  return isAbsolute(v) ? v : resolve(REPO, v);
};

/**
 * BENCH_LOCAL_DIR: the folder for all local state (installed servers, temporary files, the local config file, and by
 * default the data and results below). Default `<repo>/.local`, which git ignores.
 */
export const LOCAL = envDir('BENCH_LOCAL_DIR') ?? join(REPO, '.local');
/**
 * BENCH_RESULTS_DIR: converted data, questions, gold answers, run records, scores and manifests. Default
 * `<LOCAL>/bench-results`.
 */
export const RESULTS = envDir('BENCH_RESULTS_DIR') ?? join(LOCAL, 'bench-results');
export const SERVERS_DIR = join(LOCAL, 'bench-servers');
export const TMP_ROOT = join(LOCAL, 'tmp');
/** The checkout whose git HEAD and bench/ tree digest every manifest records (the same checkout as REPO). */
export const CODE_REPO = REPO;
export const CODE_BENCH = BENCH;

/**
 * BENCH_DATA_DIR: the downloaded input datasets, read-only and never copied into the repository. Default
 * `<LOCAL>/bench-data`. Layout: `mimic-iv-fhir-demo-2.1.0/` and `synthea-coherent-100/` (each with `fhir/` and
 * `SHA256SUMS.txt`), and `synthea-holdout/<seed label>/`, which `bench:holdout -- fetch` writes.
 */
export const DATA_ROOT = envDir('BENCH_DATA_DIR') ?? join(LOCAL, 'bench-data');
export const MIMIC_ROOT = join(DATA_ROOT, 'mimic-iv-fhir-demo-2.1.0');
export const MIMIC_FHIR_DIR = join(MIMIC_ROOT, 'fhir'); // *.ndjson.gz
export const MIMIC_SHA256SUMS = join(MIMIC_ROOT, 'SHA256SUMS.txt');
export const SYNTHEA_ROOT = join(DATA_ROOT, 'synthea-coherent-100');
export const SYNTHEA_FHIR_DIR = join(SYNTHEA_ROOT, 'fhir'); // *.json bundles
/**
 * The three Synthea listing files (all-files.txt, selected-files.txt, SHA256SUMS.txt) are synthetic and ship with the
 * harness in bench/data/synthea-coherent-100/ (see the README there). A copy under SYNTHEA_ROOT (BENCH_DATA_DIR) is used
 * instead when present. Either way their digests are checked against the pins in data/checksums.ts and holdout/select.ts.
 */
export const SYNTHEA_LISTS_DIR = join(BENCH, 'data', 'synthea-coherent-100');
const syntheaList = (name: string): string => { const own = join(SYNTHEA_ROOT, name); return existsSync(own) ? own : join(SYNTHEA_LISTS_DIR, name); };
export const SYNTHEA_SHA256SUMS = syntheaList('SHA256SUMS.txt');
export const SYNTHEA_SELECTED_FILES = syntheaList('selected-files.txt');
export const SYNTHEA_ALL_FILES = syntheaList('all-files.txt');

export const HAPI_PORT = 18190;
export const HAPI_BASE = `http://127.0.0.1:${HAPI_PORT}/fhir`;

/** Per-slot loopback ports (slot 0..7). Never 8080, 18080 or 18091. */
export const slotPorts = (slot: number) => {
  if (!Number.isInteger(slot) || slot < 0 || slot > 7) throw new Error(`slot out of range: ${slot}`);
  return {
    recordingProxy: 18210 + slot,
    canary: 18220 + slot,
    tokenShim: 18230 + slot,
    scopeProxy: 18240 + slot,
    /** Recording proxy in front of the HealthLake signing proxy (arms FBh, FBdh; bench/healthlake/). */
    healthlakeProxy: 18250 + slot,
    /** Loopback SigV4 signing proxy to the HealthLake data store (bench/healthlake/proxy.ts). */
    signingProxy: 18270 + slot,
  };
};
export const proxyBase = (slot: number) => `http://127.0.0.1:${slotPorts(slot).recordingProxy}/fhir`;

/** The development datasets: the MIMIC-IV demo (development patients only) and the 99-bundle Synthea development subset. */
export type DevDatasetId = 'mimic' | 'synthea-dev';
/**
 * Every dataset with questions, gold and runs: the development datasets and 'synthea-holdout', the fresh Synthea sample
 * drawn by a public random beacon after development finished (bench/holdout/, converted by `bench:holdout -- convert`).
 */
export type DatasetId = DevDatasetId | 'synthea-holdout';
/**
 * The development datasets with questions. Commands that visit every dataset (the joined dev/ files, bench:score's input
 * digests, setup defaults) iterate over this list; the holdout is not in it, so their outputs stay as they were. Name the
 * holdout explicitly (HOLDOUT_DATASETS, ALL_DATASETS).
 */
export const DATASETS: readonly DevDatasetId[] = ['mimic', 'synthea-dev'];
export const HOLDOUT_DATASETS: readonly DatasetId[] = ['synthea-holdout'];
/** Every dataset `--dataset` accepts (questions, gold, runs, loader, infra). */
export const ALL_DATASETS: readonly DatasetId[] = [...DATASETS, ...HOLDOUT_DATASETS];
export const isDevDataset = (d: DatasetId): d is DevDatasetId => (DATASETS as readonly string[]).includes(d);
/** Datasets the converter, loader and infra accept (the names predate the holdout's questions). */
export type LoadDatasetId = DatasetId;
export const LOAD_DATASETS: readonly LoadDatasetId[] = ALL_DATASETS;

/**
 * Rule families. synthea-dev and synthea-holdout share every Synthea rule: question templates and groups, strata, probes,
 * gold and the arm configurations keyed by dataset. Write per-dataset tables once per family with `byFamily`.
 */
export type DatasetFamily = 'mimic' | 'synthea';
const FAMILY: Readonly<Record<DatasetId, DatasetFamily>> = { mimic: 'mimic', 'synthea-dev': 'synthea', 'synthea-holdout': 'synthea' };
export const familyOf = (d: DatasetId): DatasetFamily => FAMILY[d];
/** A table written once per family, keyed by every dataset: both Synthea datasets get the same entry (the same object). */
export const byFamily = <T>(t: Readonly<Record<DatasetFamily, T>>): Readonly<Record<DatasetId, T>> =>
  Object.fromEntries(ALL_DATASETS.map(d => [d, t[FAMILY[d]]])) as Record<DatasetId, T>;
/** Synthetic datasets: every patient is in scope for loading and checks (no development-patient restriction). */
export const isSyntheaDataset = (d: DatasetId): boolean => familyOf(d) === 'synthea';
/** Where the holdout bundles are downloaded, one folder per seed label. */
export const HOLDOUT_DATA_ROOT = join(DATA_ROOT, 'synthea-holdout');

/**
 * Identifiers taken from the datasets (the MIMIC development patient ids, one known patient per dataset, and the record
 * used to check that the FHIR server keeps decimal text) are never committed. They live in this git-ignored file:
 *
 *   { "mimic_dev_patients": ["<MIMIC Patient.id>", ...],
 *     "known_patient": { "mimic": "<one of mimic_dev_patients>", "synthea-dev": "<Patient.id of the first bundle in name order>",
 *                        "synthea-holdout": "<written by bench:holdout -- convert>" },
 *     "lexeme_probe": { "ref": "Observation/<id>", "lexeme": "<its recorded value, with trailing zeros>" } }
 *
 * bench/README.md says how to choose these values.
 */
export const LOCAL_CONFIG = join(LOCAL, 'bench-config.json');
interface LocalConfig { mimic_dev_patients: string[]; known_patient: Record<DevDatasetId, string> & { 'synthea-holdout'?: string }; lexeme_probe: { ref: string; lexeme: string } }
let localCache: LocalConfig | undefined;
function localConfig(): LocalConfig {
  if (localCache) return localCache;
  let raw: string;
  try { raw = readFileSync(LOCAL_CONFIG, 'utf8'); } catch { throw new Error(`missing ${LOCAL_CONFIG}: create it as bench/README.md describes`); }
  const c = JSON.parse(raw) as LocalConfig;
  const ok = Array.isArray(c.mimic_dev_patients) && c.mimic_dev_patients.length > 0 && c.mimic_dev_patients.every(id => typeof id === 'string' && id.length > 0)
    && DATASETS.every(d => typeof c.known_patient?.[d] === 'string' && c.known_patient[d].length > 0)
    && typeof c.lexeme_probe?.ref === 'string' && typeof c.lexeme_probe?.lexeme === 'string';
  if (!ok) throw new Error(`malformed ${LOCAL_CONFIG}: see bench/README.md`);
  localCache = c;
  return c;
}
/** The only MIMIC patients questions, gold and runs may use. Throws when LOCAL_CONFIG is missing. */
export const mimicDevPatients = (): readonly string[] => localConfig().mimic_dev_patients;
/**
 * One known Patient per dataset, read to confirm HAPI serves that dataset (synthea-dev: the first bundle in name order;
 * synthea-holdout: the first selected bundle in name order, written by `bench:holdout -- convert`).
 */
export const knownPatient = (d: LoadDatasetId): string => {
  const id = localConfig().known_patient[d];
  if (typeof id !== 'string' || id.length === 0) throw new Error(`${LOCAL_CONFIG} has no known_patient.${d} (run bench:holdout -- convert first)`);
  return id;
};
/** A MIMIC Observation whose recorded value has trailing zeros, used to prove HAPI keeps decimal lexemes. */
export const lexemeProbe = (): { ref: string; lexeme: string } => localConfig().lexeme_probe;

export const results = {
  manifests: join(RESULTS, 'manifests'),
  converted: (d: DatasetId) => join(RESULTS, 'converted', d),
  questions: (d: DatasetId) => join(RESULTS, 'questions', d, 'questions.jsonl'),
  gold: (d: DatasetId, impl: 'ts' | 'py' | 'reconciled' = 'reconciled') =>
    join(RESULTS, 'gold', d, impl === 'reconciled' ? 'gold.jsonl' : `gold.${impl}.jsonl`),
  goldDisagreements: (d: DatasetId) => join(RESULTS, 'gold', d, 'disagreements.jsonl'),
  scripted: (campaign: string) => join(RESULTS, 'scripted', campaign),
  scores: (campaign: string) => join(RESULTS, 'scores', campaign),
  agentSmoke: join(RESULTS, 'agent', 'smoke'),
  holdout: (label: string) => join(RESULTS, 'holdout', label),
  fuzz: (campaign: string) => join(RESULTS, 'fuzz', campaign),
  latency: (campaign: string) => join(RESULTS, 'latency', campaign),
};

export const tmpDir = (label: string) => {
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(label)) throw new Error(`bad tmp label: ${label}`);
  return join(TMP_ROOT, label);
};
