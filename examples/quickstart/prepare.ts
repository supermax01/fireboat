import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertPrepare } from './guards.js';
import type { FreshState } from './guards.js';
import { createDockerAdapter } from './docker.js';
import type { DockerAdapter } from './docker.js';
import { ownedInstance, pinnedBackend } from './instance.js';
import type { InstanceEvidence, InstanceReceipt } from './instance.js';
import { fault, isRecord, QUICKSTART_TARGET, QuickstartFault, seedTypes, sha256, validateSeedManifest } from './manifest.js';
import type { SeedManifest } from './manifest.js';
import { createSeedHttpClient, HTTP_LIMITS, seedPortOccupied } from './seed-http.js';
import { approvedSeedPuts, parseResource, setupOracle } from './setup-oracle.js';
import { atomicPrivateWrite, jsonBytes, lockRun, newRunDirectory } from './run-state.js';
import type { AtomicWriter, RunReceipt, SetupPacket } from './run-state.js';

export type HelperAssets = Readonly<{ manifest: Uint8Array; compose: Uint8Array; resources: Uint8Array }>;
export type SeedClient = ReturnType<typeof createSeedHttpClient>;
export type PrepareResult = Readonly<{
  resources: number; types: number; manifestSha256: string; receiptSha256: string; packetSha256: string;
}>;
// HAPI's cold start on a local VM takes about a minute; the seeding client budgets exactly these polls besides its other requests.
export const READINESS = Object.freeze({ attempts: HTTP_LIMITS.readinessRequests, delayMs: 500, deadlineMs: 120_000 });
export function validateHelperAssets(input: HelperAssets) {
  const manifestBytes = Buffer.from(input.manifest), compose = Buffer.from(input.compose), resources = Buffer.from(input.resources);
  let value: unknown;
  try { value = JSON.parse(manifestBytes.toString('utf8')); } catch { throw fault('MANIFEST_INVALID'); }
  const manifest = validateSeedManifest(value);
  if (sha256(compose) !== manifest.composeSha256) throw fault('HELPER_ASSET_MISMATCH');
  const puts = approvedSeedPuts(manifest, resources);
  return { manifest, manifestSha256: sha256(manifestBytes), compose, puts };
}
async function ready(client: SeedClient, manifest: SeedManifest, wait: (ms: number) => Promise<void>): Promise<void> {
  const start = performance.now();
  for (let attempt = 0; attempt < READINESS.attempts && performance.now() - start < READINESS.deadlineMs; attempt++) {
    try {
      const metadata = parseResource(await client.metadata());
      if (metadata.resourceType !== 'CapabilityStatement' || metadata.fhirVersion !== manifest.backend.fhirVersion ||
        !isRecord(metadata.software) || metadata.software.name !== manifest.backend.softwareName ||
        metadata.software.version !== manifest.backend.softwareVersion) throw fault('BACKEND_MISMATCH');
      return;
    } catch (error) {
      if (!(error instanceof QuickstartFault) || !['HTTP_FAILED', 'HTTP_TIMEOUT', 'HTTP_STATUS'].includes(error.code)) throw error;
      if (attempt + 1 < READINESS.attempts) await wait(READINESS.delayMs);
    }
  }
  throw fault('READINESS_FAILED');
}
export function receiptForEvidence(receipt: RunReceipt, containerId: string, evidence: InstanceEvidence): InstanceReceipt {
  // Adopt only observed timestamps/volumes; all ownership identity originates in
  // the new local receipt, rather than being learned from an arbitrary listener.
  const instance: InstanceReceipt = { schema: 1, runId: receipt.runId, project: receipt.project, service: 'hapi', containerId,
    creationNonce: receipt.creationNonce, createdAt: evidence.createdAt, composeSha256: receipt.composeSha256, volumes: evidence.volumes };
  return instance;
}
export async function prepare(input: HelperAssets & Readonly<{ runDirectory: string }>, options: Readonly<{
  docker?: DockerAdapter; client?: (manifest: SeedManifest) => SeedClient; write?: AtomicWriter; wait?: (ms: number) => Promise<void>;
  /** Trusted test seam for the pre-provisioning listener check; true means the seed target is occupied. */
  probe?: () => Promise<boolean>;
}> = {}): Promise<PrepareResult> {
  const assets = validateHelperAssets(input), { manifest, manifestSha256, puts } = assets;
  if (!isAbsolute(input.runDirectory)) throw fault('RUN_INVALID');
  const directory = input.runDirectory, write = options.write ?? atomicPrivateWrite;
  await newRunDirectory(directory);
  const release = await lockRun(directory);
  const runId = randomBytes(8).toString('hex'), creationNonce = randomBytes(32).toString('hex');
  let receipt: RunReceipt = { schema: 'fireboat-quickstart-run/1', runId, project: `fireboat-qs-${runId}`, creationNonce,
    startedAt: new Date().toISOString(), phase: 'preparing', manifestSha256, composeSha256: manifest.composeSha256,
    containerId: null, instance: null, attemptSha256: null, packetSha256: null };
  let client: SeedClient | undefined;
  try {
    await write(join(directory, 'receipt.json'), jsonBytes(receipt));
    await write(join(directory, 'compose.yaml'), assets.compose);
    await write(join(directory, 'compose.env'), Buffer.from(`FIREBOAT_QS_RUN=${runId}\nFIREBOAT_QS_CREATION=${creationNonce}\nFIREBOAT_QS_COMPOSE=${manifest.composeSha256}\n`));
    const docker = options.docker ?? await createDockerAdapter();
    // Construct the bounded HTTP client before provisioning so proxy/runtime
    // refusal cannot leave a newly provisioned instance behind.
    client = options.client ? options.client(manifest) : createSeedHttpClient(manifest, QUICKSTART_TARGET);
    // Docker evidence identifies a container, not the HTTP server at the seed target. Refuse before provisioning when
    // anything already listens there: that listener, not the new container, would otherwise receive the writes
    // whenever the daemon's published 127.0.0.1:18080 is not this host's (for example a VM forwarder that cannot bind).
    if (await (options.probe ?? (() => seedPortOccupied()))()) throw fault('PORT_IN_USE');
    const recordContainer = async (id: string) => {
      receipt = { ...receipt, containerId: id };
      await write(join(directory, 'receipt.json'), jsonBytes(receipt));
    };
    const containerId = await docker.up({ ...receipt, directory }, recordContainer);
    if (receipt.containerId === null) await recordContainer(containerId);
    const evidence = await docker.inspect(containerId, manifest);
    const instance = receiptForEvidence(receipt, containerId, evidence);
    receipt = { ...receipt, instance };
    await write(join(directory, 'receipt.json'), jsonBytes(receipt));
    if (!ownedInstance(evidence, instance, manifest)) throw fault('INSTANCE_FOREIGN');
    if (!pinnedBackend(evidence, manifest)) throw fault('BACKEND_MISMATCH');
    await ready(client, manifest, options.wait ?? (async ms => { await delay(ms); }));
    const counts: Record<string, number> = {};
    for (const type of seedTypes(manifest)) counts[type] = await client.count(type);
    const state: FreshState = { phase: 'pre-seed', counts };
    assertPrepare(QUICKSTART_TARGET, manifest, instance, evidence, state);
    const attempt = jsonBytes({ ...receipt, phase: 'seeding' });
    await write(join(directory, 'attempt.json'), attempt);
    receipt = { ...receipt, phase: 'seeding', attemptSha256: sha256(attempt) };
    await write(join(directory, 'receipt.json'), jsonBytes(receipt));
    await client.seed({ receipt: instance, evidence, state, inspect: async () => {
      const inspected = await docker.inspect(containerId, manifest);
      assertPrepare(QUICKSTART_TARGET, manifest, instance, inspected, state);
      return inspected;
    } }, puts);
    const observations = await setupOracle(manifest, puts, client);
    const finalEvidence = await docker.inspect(containerId, manifest);
    if (!ownedInstance(finalEvidence, instance, manifest) || !pinnedBackend(finalEvidence, manifest)) throw fault('INSTANCE_FOREIGN');
    const packet: SetupPacket = { schema: 'fireboat-quickstart-setup/1', runId, creationNonce,
      receiptSha256: receipt.attemptSha256!, manifestSha256, instanceSha256: sha256(jsonBytes(instance)), resources: observations };
    const packetBytes = jsonBytes(packet), packetSha256 = sha256(packetBytes);
    await write(join(directory, 'setup-packet.json'), packetBytes);
    receipt = { ...receipt, phase: 'complete', packetSha256 };
    const receiptBytes = jsonBytes(receipt);
    await write(join(directory, 'receipt.json'), receiptBytes);
    return { resources: manifest.resources.length, types: seedTypes(manifest).length, manifestSha256,
      receiptSha256: sha256(receiptBytes), packetSha256 };
  } catch (error) {
    receipt = { ...receipt, phase: 'failed', packetSha256: null };
    await write(join(directory, 'receipt.json'), jsonBytes(receipt)).catch(() => {});
    await rm(join(directory, 'setup-packet.json'), { force: true }).catch(() => {});
    throw error instanceof QuickstartFault ? error : fault('HELPER_FAILED');
  } finally { client?.close(); await release(); }
}
