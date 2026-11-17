import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { HAPI_IMAGE, HAPI_PLATFORM, HELPER_BACKEND } from './backend.js';
import { fault, freezeCopy, isRecord, isSha256, QuickstartFault, sha256 } from './manifest.js';
import type { SeedManifest } from './manifest.js';
import { ownedInstance, ownershipLabels, validReceipt } from './instance.js';
import type { InstanceEvidence, InstanceReceipt, OwnedVolume } from './instance.js';
import type { CleanupAction, CleanupExecutor } from './down.js';

export const DOCKER_LIMITS = Object.freeze({ bytes: 262_144, deadlineMs: 30_000 });
export type DockerOptions = Readonly<{
  env: Readonly<Record<string, string>>; cwd: string; encoding: 'utf8';
  timeout: number; maxBuffer: number; shell: false; killSignal: 'SIGKILL';
}>;
export type DockerExecutor = (file: string, argv: readonly string[], options: DockerOptions) =>
  Promise<Readonly<{ stdout: string; stderr: string }>>;
export type RunIntent = Readonly<{
  runId: string; project: string; creationNonce: string; composeSha256: string;
}>;
export type DockerRun = RunIntent & Readonly<{ directory: string }>;
export type DockerAdapter = Readonly<{
  up: (run: DockerRun, recordContainer?: (id: string) => Promise<void>) => Promise<string>;
  inspect: (containerId: string, manifest: SeedManifest, allowStopped?: boolean) => Promise<InstanceEvidence>;
  cleanup: (receipt: InstanceReceipt, manifest: SeedManifest) => CleanupExecutor;
}>;

/**
 * The only supported endpoint is a local daemon socket. A tcp:// or ssh:// daemon (or any other scheme) publishes
 * 127.0.0.1:18080 on its own host, not necessarily on this one, so the inspected container need not be the HTTP
 * server that would receive the seed writes.
 */
export const isLocalDockerEndpoint = (value: unknown): value is string =>
  typeof value === 'string' && /^unix:\/\/\/[^\x00-\x1f\x7f]+$/.test(value);
/** Fixed Docker faults raised after a command was dispatched; the daemon may already have acted on it. */
export const POST_DISPATCH_FAULTS: readonly string[] = Object.freeze(['DOCKER_FAILED', 'DOCKER_TIMEOUT', 'DOCKER_LIMIT']);
export function dockerEnvironment(input: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'])
    if (input[key] !== undefined) result[key] = input[key];
  return result;
}
export async function resolveDockerBinary(environment: Readonly<Record<string, string | undefined>>): Promise<string> {
  for (const directory of (environment.PATH ?? '').split(':').filter(isAbsolute)) {
    try {
      const file = await realpath(join(directory, 'docker'));
      await access(file, constants.X_OK);
      if (isAbsolute(file)) return file;
    } catch { /* continue the bounded PATH search, never invoke a shell */ }
  }
  throw fault('DOCKER_MISSING');
}
const executeFile: DockerExecutor = (file, argv, options) => new Promise((accept, reject) => {
  execFile(file, [...argv], options, (error, stdout, stderr) => {
    if (error) {
      const e = error as NodeJS.ErrnoException & { killed?: boolean };
      reject(fault(e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'DOCKER_LIMIT' :
        e.killed ? 'DOCKER_TIMEOUT' : e.code === 'ENOENT' ? 'DOCKER_MISSING' : 'DOCKER_FAILED'));
    } else accept({ stdout, stderr });
  });
});
const invalid = (): never => { throw fault('DOCKER_EVIDENCE_INVALID'); };
function single(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value) && value.length === 1 && isRecord(value[0])) return value[0];
  } catch { /* fixed fault below */ }
  return invalid();
}
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : invalid();
const string = (value: unknown): string => typeof value === 'string' ? value : invalid();
const stable = (value: unknown): string => JSON.stringify(value && typeof value === 'object' ?
  Array.isArray(value) ? value.map(v => JSON.parse(stable(v))) :
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, JSON.parse(stable(v))])) : value);
export function dockerUtc(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))) return invalid();
  return new Date(value).toISOString();
}
export function validIntent(value: RunIntent): boolean {
  return /^[a-f0-9]{16}$/.test(value.runId) && value.project === `fireboat-qs-${value.runId}` &&
    isSha256(value.creationNonce) && isSha256(value.composeSha256);
}
function labelsMatch(labels: Record<string, unknown>, intent: RunIntent): boolean {
  return Object.entries(ownershipLabels({ ...intent, service: 'hapi' } as InstanceReceipt)).every(([k, v]) => labels[k] === v);
}

// A volume has no Docker UUID. Bind the full inspected local identity (including
// creation timestamp and ownership labels), then re-inspect it before removal.
export function parseOwnedVolume(text: string, intent: RunIntent): OwnedVolume {
  const v = single(text), labels = record(v.Labels), name = string(v.Name);
  if (!validIntent(intent) || !name.startsWith(`${intent.project}-`) || !/^[a-z0-9-]{1,96}$/.test(name) ||
    !labelsMatch(labels, intent) || v.Driver !== 'local' || v.Scope !== 'local' ||
    (v.Options != null && Object.keys(record(v.Options)).length !== 0)) return invalid();
  const createdAt = dockerUtc(v.CreatedAt);
  return freezeCopy({ name, createdAt, identitySha256: sha256(stable({ name, createdAt,
    driver: v.Driver, scope: v.Scope, labels, options: v.Options ?? null, mountpoint: string(v.Mountpoint) })) });
}

/** The NetworkID of this project's Compose default network as recorded on the owned container, when Docker reports one. */
export function composeNetworkId(text: string, project: string): string | undefined {
  const settings = record(single(text).NetworkSettings);
  if (settings.Networks == null) return undefined;
  const entry = record(settings.Networks)[`${project}_default`];
  if (entry == null) return undefined;
  const id = record(entry).NetworkID;
  if (id == null || id === '') return undefined;
  return isSha256(id) ? id : invalid();
}
/** A Compose default network of exactly this run's project, local bridge driver, with no endpoint still attached. */
export function ownedNetworkId(text: string, intent: RunIntent): string {
  const n = single(text), labels = record(n.Labels), id = string(n.Id);
  if (!validIntent(intent) || !isSha256(id)) return invalid();
  if (n.Name !== `${intent.project}_default` || labels['com.docker.compose.project'] !== intent.project ||
    labels['com.docker.compose.network'] !== 'default' || n.Driver !== 'bridge' || n.Scope !== 'local' ||
    (n.Containers != null && Object.keys(record(n.Containers)).length !== 0)) throw fault('CLEANUP_FOREIGN');
  return id;
}

export function parseImageEvidence(indexText: string, platformText: string, manifest: SeedManifest): void {
  const index = single(indexText), child = single(platformText), b = manifest.backend;
  if (stable(b) !== stable(HELPER_BACKEND)) throw fault('BACKEND_MISMATCH');
  if (!Array.isArray(index.RepoDigests) || !index.RepoDigests.includes(HAPI_IMAGE) ||
    ![b.imageIndexDigest, b.imageManifestDigest, b.imageConfigDigest].includes(string(index.Id)) ||
    child.Os !== 'linux' || child.Architecture !== 'arm64' ||
    ![b.imageManifestDigest, b.imageConfigDigest].includes(string(child.Id))) return invalid();
  // On classic stores Id is the config digest. On containerd stores the selected
  // Descriptor is the child; its checked-in content binds the config digest.
  if (child.Id !== b.imageConfigDigest && record(child.Descriptor).digest !== b.imageManifestDigest) return invalid();
  const config = record(child.Config);
  if (config.WorkingDir !== '/app' || config.User !== '65532:65532' ||
    (config.Volumes != null && Object.keys(record(config.Volumes)).length !== 0)) return invalid();
}

export function parseInstanceEvidence(text: string, manifest: SeedManifest, allowStopped = false): InstanceEvidence {
  const c = single(text), config = record(c.Config), host = record(c.HostConfig), network = record(c.NetworkSettings);
  const labels = record(config.Labels), id = string(c.Id), runId = string(labels['io.fireboat.quickstart.run']);
  const intent: RunIntent = { runId, project: string(labels['com.docker.compose.project']),
    creationNonce: string(labels['io.fireboat.quickstart.creation']), composeSha256: string(labels['io.fireboat.quickstart.compose']) };
  const b = manifest.backend;
  const port = { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] };
  if (!isSha256(id) || !validIntent(intent) || !labelsMatch(labels, intent) ||
    config.Image !== HAPI_IMAGE || ![b.imageIndexDigest, b.imageManifestDigest, b.imageConfigDigest].includes(string(c.Image)) ||
    (c.Image !== b.imageConfigDigest && record(c.ImageManifestDescriptor).digest !== b.imageManifestDigest) ||
    !Array.isArray(c.Mounts) || c.Mounts.length !== 0 ||
    (host.Binds != null && (!Array.isArray(host.Binds) || host.Binds.length !== 0)) ||
    host.Privileged !== false || host.PublishAllPorts !== false || host.NetworkMode === 'host' ||
    !['no', ''].includes(string(record(host.RestartPolicy).Name)) ||
    record(host.LogConfig).Type !== 'none' ||
    stable(host.PortBindings) !== stable(port) ||
    (record(c.State).Running === true ? stable(network.Ports) !== stable(port) : !allowStopped)) return invalid();
  const env = config.Env;
  if (!Array.isArray(env) || ![
    'SPRING_DATASOURCE_URL=jdbc:h2:mem:test_mem', 'SPRING_DATASOURCE_DRIVERCLASSNAME=org.h2.Driver',
    'SPRING_DATASOURCE_USERNAME=sa', 'HIBERNATE_DIALECT=ca.uhn.fhir.jpa.model.dialect.HapiFhirH2Dialect'
  ].every(entry => env.includes(entry))) return invalid();
  return freezeCopy({ containerId: id, ...intent, service: 'hapi', createdAt: dockerUtc(c.Created),
    labels: Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, string(v)])), volumes: [],
    publishedPorts: [{ hostIp: '127.0.0.1', hostPort: 18080, containerPort: 8080, protocol: 'tcp', containerId: id }],
    backend: b });
}

export async function createDockerAdapter(options: Readonly<{
  binary?: string; environment?: Readonly<Record<string, string | undefined>>; execute?: DockerExecutor;
}> = {}): Promise<DockerAdapter> {
  const environment = dockerEnvironment(options.environment ?? process.env);
  // An explicit remote daemon refuses before any Docker command; saved contexts are resolved before provisioning.
  if (environment.DOCKER_HOST !== undefined && environment.DOCKER_HOST !== '' && !isLocalDockerEndpoint(environment.DOCKER_HOST))
    throw fault('DOCKER_ENDPOINT_REFUSED');
  const binary = options.binary ?? await resolveDockerBinary(environment);
  if (!isAbsolute(binary) || binary.includes('\0')) throw fault('DOCKER_MISSING');
  const execute = options.execute ?? executeFile;
  const invoke = async (argv: readonly string[], cwd: string): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        execute(binary, argv, { env: { ...environment }, cwd, encoding: 'utf8', timeout: DOCKER_LIMITS.deadlineMs,
          maxBuffer: DOCKER_LIMITS.bytes, shell: false, killSignal: 'SIGKILL' }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(fault('DOCKER_TIMEOUT')), DOCKER_LIMITS.deadlineMs); })
      ]);
      if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string' ||
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > DOCKER_LIMITS.bytes) throw fault('DOCKER_LIMIT');
      return result.stdout;
    } catch (error) { throw error instanceof QuickstartFault ? error : fault('DOCKER_FAILED'); }
    finally { clearTimeout(timer); }
  };
  const inspectInstance = async (id: string, manifest: SeedManifest, allowStopped = false): Promise<{ evidence: InstanceEvidence; text: string }> => {
    if (!isSha256(id)) return invalid();
    const index = await invoke(['image', 'inspect', HAPI_IMAGE], '/');
    const child = await invoke(['image', 'inspect', '--platform', HAPI_PLATFORM, HAPI_IMAGE], '/');
    parseImageEvidence(index, child, manifest);
    const text = await invoke(['container', 'inspect', id], '/');
    const evidence = parseInstanceEvidence(text, manifest, allowStopped);
    if (evidence.containerId !== id) return invalid();
    return { evidence, text };
  };
  const inspect = async (id: string, manifest: SeedManifest, allowStopped = false): Promise<InstanceEvidence> =>
    (await inspectInstance(id, manifest, allowStopped)).evidence;
  return Object.freeze({
    async up(run: DockerRun, recordContainer?: (id: string) => Promise<void>): Promise<string> {
      if (!validIntent(run) || !isAbsolute(run.directory)) throw fault('RUN_INVALID');
      const args = ['compose', '--project-directory', run.directory, '--env-file', join(run.directory, 'compose.env'),
        '-f', join(run.directory, 'compose.yaml'), '--project-name', run.project];
      // Resolve the effective endpoint exactly as the following commands will: DOCKER_HOST, then DOCKER_CONTEXT, then the
      // saved current context. Only a local daemon socket may provision the instance that receives the seed writes.
      const context = single(await invoke(['context', 'inspect'], '/'));
      if (!isLocalDockerEndpoint(record(record(context.Endpoints).docker).Host)) throw fault('DOCKER_ENDPOINT_REFUSED');
      // No implicit image acquisition, build, restart, dependency or other service.
      let failure: unknown;
      try { await invoke([...args, 'up', '--detach', '--pull', 'never', '--no-build', '--no-deps', 'hapi'], run.directory); }
      catch (error) {
        if (!(error instanceof QuickstartFault) || !POST_DISPATCH_FAULTS.includes(error.code)) throw error;
        failure = error;
      }
      // Compose can create a container and then fail to start it, exceed the deadline or overflow its output bound.
      // Save the exact discovered ID on every such path so down never needs label search; down then validates its
      // ownership before any action. If discovery itself fails, the original fault stands.
      let id: string;
      try { id = (await invoke([...args, 'ps', '--all', '--quiet', 'hapi'], run.directory)).trim(); }
      catch (error) { throw failure ?? error; }
      if (failure && id === '') throw failure;
      if (!isSha256(id)) return invalid();
      await recordContainer?.(id);
      if (failure) throw failure;
      return id;
    },
    inspect,
    cleanup(receipt: InstanceReceipt, manifest: SeedManifest): CleanupExecutor {
      if (!validReceipt(receipt)) throw fault('CLEANUP_FOREIGN');
      const saved = freezeCopy(receipt);
      // The project network ID as recorded on the owned container during this cleanup (absent before first start).
      let network: string | undefined;
      const observe = (text: string): void => {
        const id = composeNetworkId(text, saved.project);
        if (id === undefined) return;
        if (network !== undefined && network !== id) throw fault('CLEANUP_FOREIGN');
        network = id;
      };
      const inspectOwned = async (): Promise<InstanceEvidence> => {
        const { evidence, text } = await inspectInstance(saved.containerId, manifest, true);
        observe(text); return evidence;
      };
      return Object.freeze({
        inspect: inspectOwned,
        async execute(action: CleanupAction): Promise<void> {
          if (action.kind === 'remove-network') {
            if (action.project !== saved.project) throw fault('CLEANUP_FOREIGN');
            // The label listing only nominates; removal binds the exact inspected ID, this project's Compose ownership,
            // no remaining endpoint and the network recorded on the owned container. Never a prune.
            const listed = (await invoke(['network', 'ls', '--no-trunc', '--quiet', '--filter', `label=com.docker.compose.project=${saved.project}`,
              '--filter', 'label=com.docker.compose.network=default'], '/')).split('\n').map(line => line.trim()).filter(Boolean);
            if (listed.length === 0) return; // Compose never created it, or it is already gone.
            if (listed.length !== 1 || !isSha256(listed[0])) throw fault('CLEANUP_FOREIGN');
            const id = ownedNetworkId(await invoke(['network', 'inspect', listed[0]], '/'), saved);
            if (id !== listed[0] || (network !== undefined && network !== id)) throw fault('CLEANUP_FOREIGN');
            await invoke(['network', 'rm', id], '/');
          } else if (action.kind === 'remove-volume') {
            const expected = saved.volumes.find(v => v.name === action.name && v.identitySha256 === action.identitySha256);
            if (!expected) throw fault('CLEANUP_FOREIGN');
            const actual = parseOwnedVolume(await invoke(['volume', 'inspect', expected.name], '/'), saved);
            if (actual.identitySha256 !== expected.identitySha256) throw fault('CLEANUP_FOREIGN');
            await invoke(['volume', 'rm', expected.name], '/');
          } else {
            if (action.containerId !== saved.containerId) throw fault('CLEANUP_FOREIGN');
            // Re-inspect at each destructive boundary, including after stop.
            const actual = await inspectOwned();
            if (!ownedInstance(actual, saved, manifest)) throw fault('CLEANUP_FOREIGN');
            await invoke(action.kind === 'stop-container' ? ['container', 'stop', '--time', '10', saved.containerId] :
              ['container', 'rm', saved.containerId], '/');
          }
        }
      });
    }
  });
}
