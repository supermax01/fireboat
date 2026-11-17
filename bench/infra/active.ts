// Which dataset the running HAPI serves (one database volume per dataset; only one runs at a time). Consumers call
// assertActiveDataset before starting.
import { HAPI_BASE, knownPatient, type LoadDatasetId } from '../lib/paths.js';
import { readManifest } from './manifest.js';

export interface ActiveDataset { dataset: LoadDatasetId; volume: string; started_at: string }

export async function readActiveDataset(): Promise<ActiveDataset | null> {
  const m = await readManifest('active-dataset');
  return m ? { dataset: String(m.dataset) as LoadDatasetId, volume: String(m.volume), started_at: String(m.started_at) } : null;
}

/** Throws unless manifests/active-dataset.json names `dataset` and HAPI serves its known Patient. */
export async function assertActiveDataset(dataset: LoadDatasetId, base = HAPI_BASE): Promise<void> {
  const active = await readActiveDataset();
  if (!active) throw new Error('no active dataset: run bench:infra:up -- --dataset <d>');
  if (active.dataset !== dataset) throw new Error(`HAPI serves ${active.dataset}, not ${dataset}: run bench:infra:up -- --dataset ${dataset} --force`);
  const res = await fetch(`${base}/Patient/${knownPatient(dataset)}`, { headers: { accept: 'application/fhir+json' } });
  await res.arrayBuffer();
  if (res.status !== 200) throw new Error(`known ${dataset} Patient/${knownPatient(dataset)} not readable (HTTP ${res.status}); is the dataset loaded?`);
}
