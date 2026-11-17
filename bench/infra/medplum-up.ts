// bench:medplum:up
// Starts the Medplum stack (compose project fbbench-medplum, 127.0.0.1:18195) next to, never instead of, the HAPI stack.
// Images must already be present by digest (pull_policy: never); they are pulled by digest only if missing.
// Waits for /healthcheck, checks the Medplum version and writes manifests/medplum-infra.json.
import { colimaInfo, dockerVersions, ensureColima } from './docker.js';
import { log, mustRun, run, sha256File, writeManifest } from './manifest.js';
import {
  MEDPLUM_COMPOSE_FILE, MEDPLUM_COMPOSE_PROJECT, MEDPLUM_EXPECTED_VERSION, MEDPLUM_FHIR_BASE, MEDPLUM_IMAGES, MEDPLUM_PORT,
  MEDPLUM_SETTINGS, MEDPLUM_VOLUME, medplumCompose, medplumHealth,
} from './medplum.js';

await ensureColima();
const images: Record<string, { ref: string; image_id: string; architecture: string }> = {};
for (const [name, ref] of Object.entries(MEDPLUM_IMAGES)) {
  let inspect = await run('docker', ['image', 'inspect', ref, '--format', '{{.Id}} {{.Architecture}}']);
  if (inspect.code !== 0) {
    log(`pulling ${ref}`);
    await mustRun('docker', ['pull', ref], { timeoutMs: 1_800_000 });
    inspect = await run('docker', ['image', 'inspect', ref, '--format', '{{.Id}} {{.Architecture}}']);
    if (inspect.code !== 0) throw new Error(`image ${ref} not available after pull`);
  }
  const [imageId = '', architecture = ''] = inspect.stdout.trim().split(' ');
  images[name] = { ref, image_id: imageId, architecture };
}

const up = await medplumCompose(['up', '-d']);
if (up.code !== 0) throw new Error(`compose up failed: ${up.stderr}`);
const t0 = Date.now();
let health: Record<string, unknown> | null = null;
while (Date.now() - t0 < 600_000) {
  health = await medplumHealth();
  if (health?.ok === true) break;
  await new Promise(r => setTimeout(r, 2000));
}
if (health?.ok !== true) throw new Error('Medplum did not become healthy within 10 minutes');
const version = String(health.version ?? '');
if (!version.startsWith(MEDPLUM_EXPECTED_VERSION)) throw new Error(`Medplum reports version ${version}, expected ${MEDPLUM_EXPECTED_VERSION}`);
log(`Medplum ${version} healthy on ${MEDPLUM_FHIR_BASE} after ${Date.now() - t0} ms`);

const ps = await mustRun('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${MEDPLUM_COMPOSE_PROJECT}`, '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']);
await writeManifest('medplum-infra', {
  compose_project: MEDPLUM_COMPOSE_PROJECT,
  compose_file: { path: MEDPLUM_COMPOSE_FILE, sha256: await sha256File(MEDPLUM_COMPOSE_FILE) },
  images,
  medplum_version: version,
  healthcheck: health,
  fhir_base: MEDPLUM_FHIR_BASE,
  published: { medplum: `127.0.0.1:${MEDPLUM_PORT}`, postgres: null, redis: null },
  volume: MEDPLUM_VOLUME,
  non_default_settings: MEDPLUM_SETTINGS,
  containers: ps.trim().split('\n').filter(Boolean),
  ready_ms: Date.now() - t0,
  docker: await dockerVersions(),
  colima: await colimaInfo(),
});
