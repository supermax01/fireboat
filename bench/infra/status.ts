// bench:infra:status: containers, active dataset, HAPI reachability and per-type totals (exit 1 if HAPI is down).
import { HAPI_BASE } from '../lib/paths.js';
import { parseLossless } from '../lib/json.js';
import { readActiveDataset } from './active.js';
import { knownPatient } from '../lib/paths.js';
import { run } from './manifest.js';
import { projectContainers } from './docker.js';

const colima = await run('colima', ['status']);
const containers = colima.code === 0 ? await projectContainers() : [];
const active = await readActiveDataset();
let hapi: Record<string, unknown> = { reachable: false };
try {
  const res = await fetch(`${HAPI_BASE}/metadata`, { headers: { accept: 'application/fhir+json' }, signal: AbortSignal.timeout(10_000) });
  await res.arrayBuffer();
  hapi = { reachable: res.status === 200, status: res.status };
  if (res.status === 200 && active) {
    const known = await fetch(`${HAPI_BASE}/Patient/${knownPatient(active.dataset)}`, { headers: { accept: 'application/fhir+json' } });
    await known.arrayBuffer();
    const totals: Record<string, string> = {};
    for (const type of ['Patient', 'Observation', 'Encounter']) {
      const r = await fetch(`${HAPI_BASE}/${type}?_summary=count`, { headers: { accept: 'application/fhir+json' } });
      const b = parseLossless(await r.text()) as { total?: unknown };
      totals[type] = String(b.total ?? `HTTP ${r.status}`);
    }
    hapi = { ...hapi, known_patient_status: known.status, totals };
  }
} catch (e) {
  hapi = { reachable: false, error: (e as Error).message };
}
process.stdout.write(JSON.stringify({ colima_running: colima.code === 0, containers, active_dataset: active, hapi_base: HAPI_BASE, hapi }, null, 2) + '\n');
process.exit(hapi.reachable ? 0 : 1);
