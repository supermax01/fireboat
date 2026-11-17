// bench:infra:up -- --dataset <mimic|synthea-dev|synthea-holdout> [--force]
// Starts colima if needed, then PostgreSQL + HAPI on the dataset's volume, waits for /metadata and writes
// manifests/infra.json and manifests/active-dataset.json. --force switches a stack that serves another dataset.
import { loadDatasetArg, parseCommon } from '../lib/cli.js';
import { HAPI_BASE, HAPI_PORT } from '../lib/paths.js';
import { parseLossless } from '../lib/json.js';
import { readActiveDataset } from './active.js';
import { colimaInfo, compose, dockerVersions, ensureColima, ensureImages, projectContainers, volumeExists } from './docker.js';
import { probeEgressSandbox } from './egress.js';
import { log, mustRun, sha256File, writeManifest } from './manifest.js';
import { COMPOSE_FILE, COMPOSE_PROJECT, HAPI_APPLICATION_YAML, HAPI_SETTINGS, JVM_OPTIONS, POSTGRES_ARGS, pgVolume } from './pins.js';

const { values } = parseCommon();
const dataset = loadDatasetArg(values.dataset);
const volume = pgVolume(dataset);

const colima = await ensureColima();
const images = await ensureImages();

const running = (await projectContainers()).filter(c => c.state === 'running');
const runningVolume = running.find(c => c.service === 'db')?.volume ?? null;
if (running.length > 0 && runningVolume !== volume) {
  const active = await readActiveDataset();
  if (!values.force) {
    process.stderr.write(`the stack is running on ${runningVolume ?? 'an unknown volume'} (active dataset: ${active?.dataset ?? 'unknown'}); pass --force to switch to ${dataset}\n`);
    process.exit(1);
  }
  log(`stopping the stack on ${runningVolume} to switch to ${volume}`);
  const down = await compose(['down'], runningVolume);
  if (down.code !== 0) throw new Error(`compose down failed: ${down.stderr}`);
}

if (!(await volumeExists(volume))) {
  log(`creating volume ${volume}`);
  await mustRun('docker', ['volume', 'create', '--label', `io.fbbench.dataset=${dataset}`, volume]);
}

const up = await compose(['up', '-d'], volume);
if (up.code !== 0) throw new Error(`compose up failed: ${up.stderr}`);

const startedAt = new Date().toISOString();
const t0 = Date.now();
const metadata = await waitForMetadata(900_000);
const readyMs = Date.now() - t0;
log(`HAPI ready on ${HAPI_BASE} after ${readyMs} ms`);

const software = metadata.software as Record<string, unknown> | undefined;
const egress = await probeEgressSandbox(); // needs HAPI up: the loopback half connects to it
log(`egress sandbox ${egress.works ? 'works' : 'does NOT work'} (loopback ${egress.loopback}, external ${egress.external})`);
await writeManifest('infra', {
  dataset,
  compose_project: COMPOSE_PROJECT,
  compose_file: { path: COMPOSE_FILE, sha256: await sha256File(COMPOSE_FILE) },
  hapi_application_yaml: { path: HAPI_APPLICATION_YAML, sha256: await sha256File(HAPI_APPLICATION_YAML) },
  images,
  containers: await projectContainers(),
  volume,
  hapi_base: HAPI_BASE,
  published: { hapi: `127.0.0.1:${HAPI_PORT}`, postgres: null },
  hapi: {
    default_page_size: HAPI_SETTINGS['hapi.fhir.default_page_size'],
    max_page_size: HAPI_SETTINGS['hapi.fhir.max_page_size'],
    reuse_cached_search_results_millis: HAPI_SETTINGS['hapi.fhir.reuse_cached_search_results_millis'],
    expire_search_results_after_millis: HAPI_SETTINGS['expire_search_results_after_millis (derived)'],
    server_address: null,
    jvm_options: JVM_OPTIONS,
    software: software ? { name: software.name ?? null, version: software.version ?? null } : null,
    fhir_version: metadata.fhirVersion ?? null,
    ready_ms: readyMs,
  },
  hapi_settings: HAPI_SETTINGS,
  postgres_args: POSTGRES_ARGS,
  egress_sandbox: egress,
  docker: await dockerVersions(),
  colima: { ...(await colimaInfo() as object), started_by_this_command: colima.started },
});
await writeManifest('active-dataset', { dataset, volume, started_at: startedAt });
log(`active dataset: ${dataset} (volume ${volume})`);

async function waitForMetadata(timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${HAPI_BASE}/metadata`, { headers: { accept: 'application/fhir+json' }, signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      if (res.status === 200) return parseLossless(text) as Record<string, unknown>;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`HAPI did not become ready within ${timeoutMs} ms (last: ${last})`);
}
