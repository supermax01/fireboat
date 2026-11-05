import { parseFhirJson, stringifyFhir } from '../../packages/core/src/decimal.js';
import { sanitize } from '../../packages/core/src/privacy.js';
import type { FhirResource } from '../../packages/core/src/contracts.js';
import { transformSyntheaExport, type ExportFile, type SeedResult } from '../quickstart/transform-synthea.js';
import { STUDY, hash, rec, requireS11, type Rec } from './study.js';

export interface Chart {
  patient: string; chartResources: number; chartInventory: { type: string; id: string; sha256: string }[];
  eligibleObservations: number; sanitizedObservationBytes: number; seed: SeedResult;
}
/** Only the living patient's transaction plus its outward reference closure counts as a chart. */
export function naturalChart(files: readonly ExportFile[]): Chart {
  const entries = new Map<string, Rec>(), identifiers = new Map<string, string[]>();
  const groups: { patient: string; resources: string[] }[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  requireS11(files.length > 0 && files.length <= 4096 && new Set(files.map(f => f.name)).size === files.length
    && files.reduce((n, f) => n + f.bytes.length, 0) <= 268435456, 'RAW_INPUT_INVALID');
  for (const file of [...files].sort((a, b) => a.name < b.name ? -1 : 1)) {
    const bundle = rec(parseFhirJson(decoder.decode(file.bytes)));
    requireS11(bundle?.resourceType === 'Bundle' && ['transaction', 'batch'].includes(String(bundle.type)) && Array.isArray(bundle.entry), 'RAW_BUNDLE_INVALID');
    const own: string[] = [], patients: Rec[] = [];
    for (const value of bundle.entry) {
      const e = rec(value), r = rec(e?.resource);
      requireS11(r && typeof r.resourceType === 'string' && /^[A-Z][A-Za-z0-9]+$/.test(r.resourceType)
        && typeof r.id === 'string' && /^[A-Za-z0-9.-]{1,64}$/.test(r.id) && e?.fullUrl === `urn:uuid:${r.id}`, 'RAW_RESOURCE_INVALID');
      const key = String(e.fullUrl);
      requireS11(!entries.has(key), 'RAW_DUPLICATE'); entries.set(key, r); own.push(key);
      if (r.resourceType === 'Patient') patients.push(r);
      for (const identifier of Array.isArray(r.identifier) ? r.identifier : []) {
        const id = rec(identifier);
        if (typeof id?.system === 'string' && typeof id.value === 'string') {
          const query = `${r.resourceType}?identifier=${id.system}|${id.value}`;
          identifiers.set(query, [...(identifiers.get(query) ?? []), key]);
        }
      }
    }
    requireS11(patients.length <= 1, 'RAW_PATIENT_BUNDLE');
    if (patients[0] && patients[0].deceasedBoolean !== true && patients[0].deceasedDateTime === undefined)
      groups.push({ patient: `urn:uuid:${patients[0].id}`, resources: own });
  }
  requireS11(groups.length === 1, 'RAW_LIVING_PATIENT');
  const group = groups[0]!, closure = new Set<string>(), pending = [...group.resources];
  const resolveRef = (text: string): string => {
    if (/^urn:uuid:[A-Za-z0-9.-]+$/.test(text)) return text;
    requireS11(/^[A-Z][A-Za-z0-9]+\?identifier=[^|]+\|[^|]+$/.test(text), 'CHART_REFERENCE_FOREIGN');
    const hits = identifiers.get(text); requireS11(hits?.length === 1, 'CHART_REFERENCE_UNRESOLVED'); return hits[0]!;
  };
  while (pending.length) {
    const key = pending.pop()!; if (closure.has(key)) continue;
    const resource = entries.get(key); requireS11(resource, 'CHART_REFERENCE_UNRESOLVED');
    requireS11(resource.resourceType !== 'Patient' || key === group.patient, 'CHART_FOREIGN_PATIENT');
    closure.add(key); requireS11(closure.size <= 30000, 'CHART_RESOURCE_CAP');
    const visit = (node: unknown, depth = 0): void => {
      requireS11(depth <= 64, 'CHART_DEPTH');
      if (Array.isArray(node)) { node.forEach(v => visit(v, depth + 1)); return; }
      const obj = rec(node); if (!obj) return;
      requireS11(obj.contained === undefined, 'CHART_CONTAINED');
      if (obj.reference !== undefined) {
        requireS11(typeof obj.reference === 'string', 'CHART_REFERENCE_INVALID');
        const target = resolveRef(obj.reference), resolved = entries.get(target);
        requireS11(resolved && (obj.type === undefined || obj.type === resolved.resourceType), 'CHART_REFERENCE_UNRESOLVED');
        pending.push(target);
      } else requireS11(!rec(obj.identifier), 'CHART_REFERENCE_LOGICAL');
      for (const [k, v] of Object.entries(obj)) if (k !== 'reference') visit(v, depth + 1);
    };
    visit(resource);
  }
  // Reuse the reviewed lossless reference/identifier/provider transform, with S11's explicit larger bounds.
  // The full chart stays in the private raw exports; this is its in-window lab measurement view, never an edge merge.
  const seed = transformSyntheaExport(files, { window: STUDY.window, maxResources: 30000, maxBytes: 67108864, maxInputBytes: 268435456 });
  const resources = seed.ndjson.trimEnd().split('\n').map(line => parseFhirJson(line) as FhirResource);
  const observations = resources.filter(r => r.resourceType === 'Observation');
  const chartInventory = [...closure].map(key => { const r = entries.get(key)!;
    return { type: String(r.resourceType), id: String(r.id), sha256: hash(stringifyFhir(r)) }; })
    .sort((a, b) => `${a.type}/${a.id}` < `${b.type}/${b.id}` ? -1 : 1);
  return { patient: seed.manifest.patient, chartResources: closure.size, chartInventory,
    eligibleObservations: observations.length,
    sanitizedObservationBytes: observations.reduce((n, r) => n + Buffer.byteLength(stringifyFhir(sanitize(r).resource)), 0), seed };
}
