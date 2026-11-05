import type { ManifestOrigin, Sanitized } from './privacy.js';

/** A delivered withheld manifest: `{path, reason}` plus optional metadata, `spans`, or a collapse `count`. */
export type WithheldManifest = Record<string, unknown>;

const keyOnly = (manifest: WithheldManifest): manifest is { path: string; reason: string } => {
  const keys = Object.keys(manifest);
  return keys.length === 2 && typeof manifest.path === 'string' && typeof manifest.reason === 'string';
};

/**
 * S5b withheld-entry collapse. Identical policy-origin `{path, reason}` manifests across the delivered
 * records (and within one record) collapse into one `{path, reason, count}` entry at the first
 * occurrence's position. Attachment, payload and in-text-link entries, entries carrying metadata, and
 * entries whose origin is unknown (no aligned `manifestOrigins`) are delivered one per occurrence,
 * unchanged. Stored entries are never mutated: a collapsed entry is a new object; singletons keep
 * their shape. Call it from the delivery assembly only, over the finally selected records, so every
 * packing pop recomputes the counts.
 */
export function collapseWithheld(records: readonly Pick<Sanitized, 'manifests' | 'manifestOrigins'>[]): WithheldManifest[] {
  const delivered: WithheldManifest[] = [];
  const collapsed = new Map<string, { index: number; entry: { path: string; reason: string; count: number } | null }>();
  for (const record of records) {
    const origins: readonly ManifestOrigin[] | undefined = record.manifestOrigins;
    const classified = Array.isArray(origins) && origins.length === record.manifests.length;
    record.manifests.forEach((manifest, i) => {
      if (!classified || origins![i] !== 'policy' || !keyOnly(manifest)) { delivered.push(manifest); return; }
      const key = `${manifest.path}\u0000${manifest.reason}`;
      const seen = collapsed.get(key);
      if (!seen) { collapsed.set(key, { index: delivered.length, entry: null }); delivered.push(manifest); return; }
      if (!seen.entry) { seen.entry = { path: manifest.path, reason: manifest.reason, count: 2 }; delivered[seen.index] = seen.entry; return; }
      seen.entry.count += 1;
    });
  }
  return delivered;
}

/** Validated multiplicity of a delivered manifest: a collapse count when well-formed, else one. */
export function withheldMultiplicity(manifest: WithheldManifest): number {
  const count = manifest.count;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 2 && Object.keys(manifest).length === 3 ? count : 1;
}
