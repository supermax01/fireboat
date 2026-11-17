// Pre-run check for arms FBh, FBdh and AH: the recorded data store is ACTIVE (read-only describe through the local AWS
// CLI) and the per-type counts it serves, read through the running signing proxy, equal the converted source counts.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { results, type DatasetId } from '../lib/paths.js';
import { awsCli } from '../healthlake/aws.js';
import { healthlakeDir } from '../healthlake/state.js';
import { servedCounts } from '../healthlake/served.js';
import { sha256Text } from '../infra/manifest.js';
import type { VerifyResult } from './verify.js';

export interface HealthLakeVerifyResult extends VerifyResult {
  backend: 'healthlake'; datastore_id_sha256: string; datastore_status: string;
  /** Per-type resources HealthLake refused at load (load/rejections.jsonl, this data store), excluded from expected. */
  rejected_at_load: Record<string, number>;
}

/** Rejections the loader recorded for this data store, by type. A rejected record is reported, never silently expected. */
export async function loadRejections(dataset: DatasetId, datastoreId: string): Promise<Record<string, number>> {
  const path = join(healthlakeDir(dataset), 'load', 'rejections.jsonl');
  const out: Record<string, number> = {};
  if (!existsSync(path)) return out;
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { datastore_id?: string; type?: string };
    if (r.datastore_id === datastoreId && typeof r.type === 'string') out[r.type] = (out[r.type] ?? 0) + 1;
  }
  return out;
}

export async function datastoreStatus(datastoreId: string): Promise<string> {
  const r = await awsCli(['healthlake', 'describe-fhir-datastore', '--datastore-id', datastoreId]) as { DatastoreProperties?: { DatastoreStatus?: string } };
  return r.DatastoreProperties?.DatastoreStatus ?? 'UNKNOWN';
}

export async function verifyHealthLakeServed(dataset: DatasetId, datastoreId: string, signingProxyBase: string): Promise<HealthLakeVerifyResult> {
  const status = await datastoreStatus(datastoreId);
  const manifest = JSON.parse(await readFile(join(results.converted(dataset), 'manifest.json'), 'utf8')) as { types: Record<string, { count: number }> };
  const types: VerifyResult['types'] = {};
  const rejected = await loadRejections(dataset, datastoreId);
  let ok = status === 'ACTIVE';
  if (ok) {
    const counts = await servedCounts(signingProxyBase, Object.keys(manifest.types));
    for (const [type, { count }] of Object.entries(manifest.types)) {
      const served = counts[type]?.served ?? null;
      const expected = count - (rejected[type] ?? 0);
      types[type] = { expected, served };
      if (served !== expected) ok = false;
    }
  }
  return { dataset, ok, checked_at: new Date().toISOString(), types, backend: 'healthlake', datastore_id_sha256: sha256Text(datastoreId), datastore_status: status, rejected_at_load: rejected };
}
