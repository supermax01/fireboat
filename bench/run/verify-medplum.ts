// Pre-run check for arms Ws and Wm: Medplum is healthy, the dataset's project is loaded, and the per-type counts the
// project's system-level client is served equal the accepted counts of the load (reconcile.json, bench:medplum:load).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatasetId } from '../lib/paths.js';
import { MEDPLUM_EXPECTED_VERSION, MEDPLUM_FHIR_BASE, MEDPLUM_FHIR_PATH, clientCredentialsToken, medplumHealth, medplumRequest } from '../infra/medplum.js';
import { medplumDir, type ReconcileRow } from '../data/medplum-lib.js';
import { loadMedplumClients } from '../servers/medplum.js';
import type { VerifyResult } from './verify.js';

export interface MedplumVerifyResult extends VerifyResult {
  backend: 'medplum'; fhir_base: string; medplum_version: string; project_id: string;
  types: Record<string, { expected: number; served: number | null; source?: number }>;
}

export async function verifyMedplumServed(dataset: DatasetId): Promise<MedplumVerifyResult> {
  const health = await medplumHealth();
  if (health?.ok !== true || !String(health.version).startsWith(MEDPLUM_EXPECTED_VERSION)) throw new Error(`Medplum is not healthy at ${MEDPLUM_FHIR_BASE}: run bench:medplum:up`);
  const recPath = join(medplumDir(dataset), 'reconcile.json');
  if (!existsSync(recPath)) throw new Error(`missing ${recPath}: run bench:medplum:load -- --dataset ${dataset}`);
  const rec = JSON.parse(readFileSync(recPath, 'utf8')) as { project_id: string; ok: boolean; rows: ReconcileRow[] };
  const clients = loadMedplumClients(dataset);
  if (clients.project_id !== rec.project_id) throw new Error(`clients.json project ${clients.project_id} != loaded project ${rec.project_id}`);
  const token = (await clientCredentialsToken(clients.system.client_id, clients.system.secret)).access_token;
  const types: MedplumVerifyResult['types'] = {};
  let ok = rec.ok;
  for (const row of rec.rows) {
    const r = await medplumRequest(`${MEDPLUM_FHIR_PATH}/${row.type}?_summary=count&_total=accurate`, token);
    const total = r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? (r.body as Record<string, unknown>).total : undefined;
    const served = r.status === 200 && total !== undefined ? Number(String(total)) : null;
    types[row.type] = { expected: row.accepted, served, source: row.source };
    if (served !== row.accepted) ok = false;
  }
  return { dataset, ok, checked_at: new Date().toISOString(), types, backend: 'medplum', fhir_base: MEDPLUM_FHIR_BASE, medplum_version: String(health.version), project_id: rec.project_id };
}
