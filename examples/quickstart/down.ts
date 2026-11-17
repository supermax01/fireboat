import { fault, freezeCopy, validateSeedManifest } from './manifest.js';
import type { SeedManifest } from './manifest.js';
import { ownedInstance, validReceipt } from './instance.js';
import type { InstanceEvidence, InstanceReceipt } from './instance.js';
import { join } from 'node:path';
import { createDockerAdapter } from './docker.js';
import type { DockerAdapter } from './docker.js';
import { atomicPrivateWrite, jsonBytes, lockRun, readRunReceipt } from './run-state.js';
import { sha256 } from './manifest.js';

export type CleanupAction = Readonly<
  { kind: 'stop-container' | 'remove-container'; containerId: string } |
  { kind: 'remove-network'; project: string } |
  { kind: 'remove-volume'; name: string; identitySha256: string }
>;
export const ownsCleanupTargets = (state: InstanceReceipt, inspected: InstanceEvidence, manifest: SeedManifest): boolean =>
  ownedInstance(inspected, state, manifest);
export function cleanupPlan(state: InstanceReceipt, inspected: InstanceEvidence, manifest: SeedManifest, volumes = false): readonly CleanupAction[] {
  if (!ownsCleanupTargets(state, inspected, manifest)) throw fault('CLEANUP_FOREIGN');
  return freezeCopy<CleanupAction[]>([
    { kind: 'stop-container', containerId: state.containerId },
    { kind: 'remove-container', containerId: state.containerId },
    // The run's own Compose default network, after its container is gone; the executor binds the exact network ID.
    { kind: 'remove-network', project: state.project },
    ...(volumes ? state.volumes.map(v => ({ kind: 'remove-volume' as const, name: v.name, identitySha256: v.identitySha256 })) : [])
  ]);
}
export type CleanupExecutor = Readonly<{
  inspect: () => Promise<InstanceEvidence>;
  execute: (action: CleanupAction) => Promise<void>;
}>;
export async function down(input: SeedManifest, receipt: InstanceReceipt, executor: CleanupExecutor, volumes = false): Promise<{ actions: number }> {
  const manifest = validateSeedManifest(input);
  if (!validReceipt(receipt)) throw fault('CLEANUP_FOREIGN');
  const state = freezeCopy(receipt);
  let inspected: InstanceEvidence;
  try { inspected = await executor.inspect(); } catch { throw fault('CLEANUP_FOREIGN'); }
  const actions = cleanupPlan(state, inspected, manifest, volumes);
  try { for (const action of actions) await executor.execute(action); }
  catch { throw fault('CLEANUP_FAILED'); }
  return { actions: actions.length };
}

export async function downRun(manifestBytes: Uint8Array, directory: string, volumes = false,
  inputDocker?: DockerAdapter): Promise<{ actions: number; receiptSha256: string }> {
  // Validate directory/mode before creating any lock in it.
  await readRunReceipt(directory);
  const release = await lockRun(directory);
  try {
    let receipt = await readRunReceipt(directory);
    let input: unknown;
    try { input = JSON.parse(Buffer.from(manifestBytes).toString('utf8')); } catch { throw fault('MANIFEST_INVALID'); }
    const manifest = validateSeedManifest(input);
    if (receipt.manifestSha256 !== sha256(manifestBytes) || receipt.composeSha256 !== manifest.composeSha256 ||
      receipt.phase === 'down' || receipt.containerId === null) throw fault('CLEANUP_FOREIGN');
    const docker = inputDocker ?? await createDockerAdapter();
    if (receipt.instance === null) {
      const inspected = await docker.inspect(receipt.containerId, manifest, true);
      const instance: InstanceReceipt = { schema: 1, runId: receipt.runId, project: receipt.project, service: 'hapi',
        containerId: receipt.containerId, creationNonce: receipt.creationNonce, createdAt: inspected.createdAt,
        composeSha256: receipt.composeSha256, volumes: inspected.volumes };
      if (!ownedInstance(inspected, instance, manifest)) throw fault('CLEANUP_FOREIGN');
      receipt = { ...receipt, instance };
      await atomicPrivateWrite(join(directory, 'receipt.json'), jsonBytes(receipt));
    }
    const instance = receipt.instance!;
    const result = await down(manifest, instance, docker.cleanup(instance, manifest), volumes);
    const bytes = jsonBytes({ ...receipt, phase: 'down' });
    await atomicPrivateWrite(join(directory, 'receipt.json'), bytes);
    return { ...result, receiptSha256: sha256(bytes) };
  } finally { await release(); }
}
