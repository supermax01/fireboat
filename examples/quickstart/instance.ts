import { freezeCopy, hasKeys, isRecord, isSha256 } from './manifest.js';
import type { BackendIdentity, SeedManifest } from './manifest.js';

export type OwnedVolume = Readonly<{ name: string; createdAt: string; identitySha256: string }>;
export type InstanceReceipt = Readonly<{
  schema: 1; runId: string; project: string; service: 'hapi'; containerId: string;
  creationNonce: string; createdAt: string; composeSha256: string; volumes: readonly OwnedVolume[];
}>;
export type InstanceEvidence = Readonly<{
  containerId: string; project: string; service: string; runId: string; creationNonce: string;
  createdAt: string; composeSha256: string;
  labels: Readonly<Record<string, string>>;
  publishedPorts: readonly Readonly<{ hostIp: string; hostPort: number; containerPort: number; protocol: string; containerId: string }>[];
  volumes: readonly OwnedVolume[];
  backend: BackendIdentity;
}>;
const utc = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) &&
  Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
export function validReceipt(value: unknown): value is InstanceReceipt {
  if (!isRecord(value) || !hasKeys(value, ['schema', 'runId', 'project', 'service', 'containerId', 'creationNonce', 'createdAt', 'composeSha256', 'volumes']) ||
    value.schema !== 1 || typeof value.runId !== 'string' || !/^[a-f0-9]{16}$/.test(value.runId) ||
    value.project !== `fireboat-qs-${value.runId}` || value.service !== 'hapi' || !isSha256(value.containerId) ||
    !isSha256(value.creationNonce) || !utc(value.createdAt) || !isSha256(value.composeSha256) ||
    !Array.isArray(value.volumes) || value.volumes.length > 4) return false;
  const names = new Set<string>();
  return value.volumes.every(v => {
    if (!isRecord(v) || !hasKeys(v, ['name', 'createdAt', 'identitySha256']) || typeof v.name !== 'string' ||
      !v.name.startsWith(`${value.project}-`) || !/^[a-z0-9-]{1,96}$/.test(v.name) || !utc(v.createdAt) ||
      !isSha256(v.identitySha256) || names.has(v.name)) return false;
    names.add(v.name); return true;
  });
}
export const ownershipLabels = (receipt: InstanceReceipt): Record<string, string> => ({
  'com.docker.compose.project': receipt.project,
  'com.docker.compose.service': receipt.service,
  'io.fireboat.quickstart.run': receipt.runId,
  'io.fireboat.quickstart.creation': receipt.creationNonce,
  'io.fireboat.quickstart.compose': receipt.composeSha256
});
export function sameVolumes(first: readonly OwnedVolume[], second: readonly OwnedVolume[]): boolean {
  return Array.isArray(second) && first.length === second.length && first.every(a => second.some(b =>
    isRecord(b) && a.name === b.name && a.createdAt === b.createdAt && a.identitySha256 === b.identitySha256));
}

// These structures are inspection evidence, not authentication. The outer helper
// creates the receipt and obtains fresh Docker evidence; this leaf invokes no CLI.
export function ownedInstance(evidence: InstanceEvidence, receipt: InstanceReceipt, manifest: SeedManifest): boolean {
  if (!validReceipt(receipt) || !isRecord(evidence) || receipt.composeSha256 !== manifest.composeSha256) return false;
  const equal = ['containerId', 'project', 'service', 'runId', 'creationNonce', 'createdAt', 'composeSha256'] as const;
  if (!equal.every(k => evidence[k] === receipt[k]) || !isRecord(evidence.labels) ||
    !Object.entries(ownershipLabels(receipt)).every(([k, v]) => evidence.labels[k] === v) ||
    !sameVolumes(receipt.volumes, evidence.volumes)) return false;
  const ports = evidence.publishedPorts;
  return Array.isArray(ports) && ports.length === 1 && ports[0]?.hostIp === '127.0.0.1' &&
    ports[0].hostPort === 18080 && ports[0].containerPort === 8080 && ports[0].protocol === 'tcp' &&
    ports[0].containerId === receipt.containerId;
}
export function pinnedBackend(evidence: InstanceEvidence, manifest: SeedManifest): boolean {
  return isRecord(evidence?.backend) && Object.entries(manifest.backend).every(([k, v]) =>
    evidence.backend[k as keyof BackendIdentity] === v);
}
export const snapshotReceipt = (receipt: InstanceReceipt): InstanceReceipt => freezeCopy(receipt);
