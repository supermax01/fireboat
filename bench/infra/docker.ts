// colima, docker and compose plumbing for the benchmark backend.
import { COMPOSE_FILE, COMPOSE_PROJECT, HAPI_APPLICATION_YAML, IMAGES } from './pins.js';
import { log, mustRun, run, sha256File } from './manifest.js';

/**
 * The colima VM size every run uses (the published runs used this size). bench:infra:up refuses a running VM of another
 * size so results stay comparable; change it here to run at another size.
 */
export const COLIMA_VM = { cpus: 4, memoryGiB: 8 } as const;

/** Starts colima at COLIMA_VM if it is not running, and refuses to continue on a VM of another size. */
export async function ensureColima(): Promise<{ started: boolean; cpus: number; memory_gib: number }> {
  const st = await run('colima', ['status']);
  let started = false;
  if (st.code !== 0) {
    log(`colima is not running; starting it (colima start --cpu ${COLIMA_VM.cpus} --memory ${COLIMA_VM.memoryGiB})`);
    await mustRun('colima', ['start', '--cpu', String(COLIMA_VM.cpus), '--memory', String(COLIMA_VM.memoryGiB)], { timeoutMs: 600_000 });
    started = true;
  }
  const rows = (await mustRun('colima', ['list', '--json'])).trim().split('\n').filter(Boolean)
    .map(l => JSON.parse(l) as { name?: string; status?: string; cpus?: number; memory?: number }); // colima's own JSON
  const vm = rows.find(r => r.name === 'default' && r.status === 'Running');
  if (!vm) throw new Error('colima default profile is not running');
  const memoryGiB = (vm.memory ?? 0) / 2 ** 30;
  if (vm.cpus !== COLIMA_VM.cpus || memoryGiB !== COLIMA_VM.memoryGiB) {
    throw new Error(`colima runs with ${vm.cpus} CPU and ${memoryGiB} GiB; the bench requires ${COLIMA_VM.cpus} CPU and ${COLIMA_VM.memoryGiB} GiB (colima stop; colima start --cpu ${COLIMA_VM.cpus} --memory ${COLIMA_VM.memoryGiB})`);
  }
  return { started, cpus: vm.cpus, memory_gib: memoryGiB };
}

export async function colimaInfo(): Promise<unknown> {
  const r = await run('colima', ['list', '--json']);
  const version = (await run('colima', ['version'])).stdout.trim().split('\n')[0] ?? '';
  const rows = r.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as unknown); // colima's own JSON, not FHIR data
  return { version, profiles: rows };
}

export async function dockerVersions(): Promise<{ server: string; compose: string }> {
  return {
    server: (await mustRun('docker', ['version', '--format', '{{.Server.Version}}'])).trim(),
    compose: (await mustRun('docker', ['compose', 'version', '--short'])).trim(),
  };
}

/** Makes sure each pinned image is present locally by digest; pulls by digest otherwise. Returns local image ids. */
export async function ensureImages(): Promise<Record<keyof typeof IMAGES, { ref: string; image_id: string; architecture: string }>> {
  const out = {} as Record<keyof typeof IMAGES, { ref: string; image_id: string; architecture: string }>;
  for (const [name, ref] of Object.entries(IMAGES) as [keyof typeof IMAGES, string][]) {
    let inspect = await run('docker', ['image', 'inspect', ref, '--format', '{{.Id}} {{.Architecture}}']);
    if (inspect.code !== 0) {
      log(`pulling ${ref}`);
      await mustRun('docker', ['pull', ref], { timeoutMs: 1_800_000 });
      inspect = await run('docker', ['image', 'inspect', ref, '--format', '{{.Id}} {{.Architecture}}']);
      if (inspect.code !== 0) throw new Error(`image ${ref} not available after pull`);
    }
    const [imageId = '', architecture = ''] = inspect.stdout.trim().split(' ');
    out[name] = { ref, image_id: imageId, architecture };
  }
  return out;
}

export async function compose(args: readonly string[], volume: string | null) {
  const env = { ...process.env, FBBENCH_PG_VOLUME: volume ?? 'fbbench-pg-unset', FBBENCH_HAPI_CONFIG_SHA256: await sha256File(HAPI_APPLICATION_YAML) };
  return run('docker', ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, ...args], { env, timeoutMs: 900_000 });
}

export interface ContainerState { service: string; state: string; health: string; image: string; volume: string | null }

/** State of this project's containers, read from docker (not from compose, so it works without FBBENCH_PG_VOLUME). */
export async function projectContainers(): Promise<ContainerState[]> {
  const ids = (await mustRun('docker', ['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${COMPOSE_PROJECT}`])).trim().split('\n').filter(Boolean);
  const states: ContainerState[] = [];
  for (const id of ids) {
    const fmt = '{{index .Config.Labels "com.docker.compose.service"}}\t{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}\t{{.Config.Image}}\t{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}';
    const [service = '', state = '', health = '', image = '', volume = ''] = (await mustRun('docker', ['inspect', id, '--format', fmt])).trim().split('\t');
    states.push({ service, state, health, image, volume: volume || null });
  }
  return states.sort((a, b) => a.service.localeCompare(b.service));
}

export async function volumeExists(name: string): Promise<boolean> {
  return (await run('docker', ['volume', 'inspect', name])).code === 0;
}
