import { fault, isRecord, QUICKSTART_TARGET, seedTypes } from './manifest.js';
import type { SeedManifest } from './manifest.js';
import { ownedInstance, pinnedBackend } from './instance.js';
import type { InstanceEvidence, InstanceReceipt } from './instance.js';

export type SeedTarget = Readonly<{ origin: string; basePath: string }>;
export type FreshState = Readonly<{
  phase: 'pre-seed' | 'seeding' | 'partial' | 'complete' | 'unknown';
  counts: Readonly<Record<string, number>>;
  sentinel?: Readonly<{ phase: 'pre-seed'; owned: true }>;
}>;
export function exactLoopbackTarget(target: SeedTarget, manifest: SeedManifest): boolean {
  // Deliberately compare the original spelling, before any URL normalization.
  return isRecord(target) && Object.keys(target).length === 2 &&
    target.origin === QUICKSTART_TARGET.origin && target.basePath === QUICKSTART_TARGET.basePath &&
    target.origin === manifest.target.origin && target.basePath === manifest.target.basePath;
}
export const patientAndObservationEmpty = (counts: Readonly<Record<string, number>>): boolean =>
  counts.Patient === 0 && counts.Observation === 0;
export function allSeedTypesEmpty(counts: Readonly<Record<string, number>>, manifest: SeedManifest): boolean {
  return isRecord(counts) && seedTypes(manifest).every(type => Object.hasOwn(counts, type) && counts[type] === 0);
}
export function assertPrepare(target: SeedTarget, manifest: SeedManifest, receipt: InstanceReceipt,
  evidence: InstanceEvidence, state: FreshState): void {
  if (!exactLoopbackTarget(target, manifest)) throw fault('TARGET_MISMATCH');
  if (!ownedInstance(evidence, receipt, manifest)) throw fault('INSTANCE_FOREIGN');
  if (!pinnedBackend(evidence, manifest)) throw fault('BACKEND_MISMATCH');
  if (!isRecord(state) || state.phase !== 'pre-seed' || !isRecord(state.counts) ||
    Object.keys(state).some(k => !['phase', 'counts', 'sentinel'].includes(k)) ||
    (state.sentinel !== undefined && (!isRecord(state.sentinel) || Object.keys(state.sentinel).length !== 2 ||
      state.sentinel.phase !== 'pre-seed' || state.sentinel.owned !== true))) throw fault('TARGET_NOT_FRESH');
  if (!allSeedTypesEmpty(state.counts, manifest)) throw fault('TARGET_NOT_FRESH');
}
