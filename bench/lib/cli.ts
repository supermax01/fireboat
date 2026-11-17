// Shared CLI conventions: --dataset, --campaign, --arm, --pass, --cell, --slot, --limit, --force.
import { parseArgs } from 'node:util';
import { ALL_DATASETS, DATASETS, LOAD_DATASETS, type DatasetId, type DevDatasetId, type LoadDatasetId } from './paths.js';

export const COMMON_OPTIONS = {
  dataset: { type: 'string' },
  campaign: { type: 'string' },
  arm: { type: 'string' }, // comma-separated ArmIds
  pass: { type: 'string' },
  cell: { type: 'string' },
  slot: { type: 'string' },
  limit: { type: 'string' },
  force: { type: 'boolean' },
} as const;

export function parseCommon(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true, strict: true });
  return { values, positionals };
}

/** --dataset: any dataset with questions, the Synthea holdout included. */
export function datasetArg(value: string | undefined): DatasetId {
  if (!value || !(ALL_DATASETS as readonly string[]).includes(value)) throw new Error(`--dataset must be one of ${ALL_DATASETS.join(', ')}`);
  return value as DatasetId;
}

/** --dataset for steps that exist only for the development datasets (bench:convert; the holdout is converted by bench:holdout). */
export function devDatasetArg(value: string | undefined): DevDatasetId {
  if (!value || !(DATASETS as readonly string[]).includes(value)) throw new Error(`--dataset must be one of ${DATASETS.join(', ')}`);
  return value as DevDatasetId;
}

/** --dataset for the converter, loader and infra, which also accept the Synthea holdout. */
export function loadDatasetArg(value: string | undefined): LoadDatasetId {
  if (!value || !(LOAD_DATASETS as readonly string[]).includes(value)) throw new Error(`--dataset must be one of ${LOAD_DATASETS.join(', ')}`);
  return value as LoadDatasetId;
}
