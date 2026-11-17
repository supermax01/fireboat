// Pre-run check: HAPI serves the expected dataset and its per-type totals equal the converted files' counts.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HAPI_BASE, results, type DatasetId } from '../lib/paths.js';
import { assertActiveDataset } from '../infra/active.js';

export interface VerifyResult { dataset: DatasetId; ok: boolean; checked_at: string; types: Record<string, { expected: number; served: number | null }> }

export async function verifyServedCounts(dataset: DatasetId, base = HAPI_BASE): Promise<VerifyResult> {
  await assertActiveDataset(dataset, base);
  const manifest = JSON.parse(await readFile(join(results.converted(dataset), 'manifest.json'), 'utf8')) as { types: Record<string, { count: number }> };
  const types: VerifyResult['types'] = {};
  let ok = true;
  for (const [type, { count }] of Object.entries(manifest.types)) {
    const res = await fetch(`${base}/${type}?_summary=count&_total=accurate`, { headers: { accept: 'application/fhir+json' } });
    const body = await res.json() as { total?: unknown };
    const served = res.status === 200 && typeof body.total === 'number' ? body.total : null;
    types[type] = { expected: count, served };
    if (served !== count) ok = false;
  }
  return { dataset, ok, checked_at: new Date().toISOString(), types };
}
