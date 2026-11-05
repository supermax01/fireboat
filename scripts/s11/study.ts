import { createHash } from 'node:crypto';

/** S11/1 is a prospective protocol. Changing any choice invalidates an existing freeze. */
export const STUDY = {
  schema: 'fireboat-s11/1',
  population: 30, development: [3, 3, 4], heldout: [6, 6, 8],
  strata: ['small', 'medium', 'large'],
  bands: [[1, 99], [100, 999], [1000, 30000]],
  ages: [[0, 5], [20, 40], [60, 85]],
  pools: { development: [100000, 101000, 102000], heldout: [200000, 201000, 202000] },
  poolSize: 128,
  window: { start: '2020-01-01', end: '2026-01-01' },
  large: { observations: 300, sanitizedObservationBytes: 131072 },
  templates: ['lab-trend', 'recent-hba1c', 'panel-recovery'],
  arms: ['fhir', 'compact', 'selected'], eras: ['modern', 'legacy'],
  delivery: 'full-text-v1', encodings: ['cl100k_base', 'o200k_base'],
  operatingPoint: { pageSize: 20, perCallBytes: 24576, configuredMaxBytes: 131072,
    taskBytes: 16777216, toolCalls: 256, upstreamCalls: 128, automaticPageLimit: 50, retries: 0 },
  bootstrap: { seed: 0x4d336231, resamples: 10000, clusters: 8, tasksPerCluster: 3, quantile: 'Hyndman-Fan type 7' },
  thresholds: { compactMedian: 0.90, smallerUpperExclusive: 1, overheadMedian: 0.15 },
} as const;
export type Split = keyof typeof STUDY.pools;
export type Stratum = typeof STUDY.strata[number];
export type Rec = Record<string, unknown>;
export const rec = (v: unknown): Rec | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Rec : undefined;
export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export function requireS11(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
export interface Screening {
  split: Split; stratum: Stratum; seed: number; chartResources: number | null;
  eligibleObservations: number | null; sanitizedObservationBytes: number | null; failure?: string;
}
export function pool(split: Split, stratum: Stratum): number[] {
  const index = STUDY.strata.indexOf(stratum), start = STUDY.pools[split][index];
  requireS11(start !== undefined, 'STRATUM_INVALID');
  return Array.from({ length: STUDY.poolSize }, (_, i) => start + i);
}
export function exclusion(row: Screening): string | undefined {
  if (row.failure) return row.failure;
  const band = STUDY.bands[STUDY.strata.indexOf(row.stratum)];
  requireS11(band && row.chartResources !== null && row.eligibleObservations !== null && row.sanitizedObservationBytes !== null
    && [row.chartResources, row.eligibleObservations, row.sanitizedObservationBytes].every(n => Number.isSafeInteger(n) && n >= 0), 'SCREEN_INVALID');
  if (row.chartResources < band[0] || row.chartResources > band[1]) return 'SIZE_BAND';
  if (row.stratum === 'large' && row.eligibleObservations < STUDY.large.observations) return 'OBSERVATION_MINIMUM';
  if (row.stratum === 'large' && row.sanitizedObservationBytes < STUDY.large.sanitizedObservationBytes) return 'OBSERVATION_BYTE_MINIMUM';
  return undefined;
}
/** Complete prefix only: no skipped seeds, reordered screening, substitutions or extra selected patients. */
export function selectPrefix(rows: readonly Screening[], split: Split, stratum: Stratum): { selected: number[]; fulfilled: boolean } {
  const order = pool(split, stratum), count = STUDY[split][STUDY.strata.indexOf(stratum)]!;
  requireS11(rows.length <= order.length && rows.every((r, i) => r.split === split && r.stratum === stratum && r.seed === order[i]), 'SCREEN_ORDER');
  const selected = rows.filter(r => !exclusion(r)).slice(0, count).map(r => r.seed);
  return { selected, fulfilled: selected.length === count };
}
export function completeCohort(rows: readonly (Screening & { patient: string })[]): boolean {
  return rows.length === STUDY.population && new Set(rows.map(r => r.patient)).size === STUDY.population
    && new Set(rows.map(r => r.seed)).size === STUDY.population
    && rows.every(r => pool(r.split, r.stratum).includes(r.seed) && !exclusion(r))
    && (['development', 'heldout'] as const).every(split => STUDY.strata.every((stratum, i) =>
      rows.filter(r => r.split === split && r.stratum === stratum).length === STUDY[split][i]));
}
export function quantile(values: readonly number[], q: number): number {
  requireS11(values.length && values.every(Number.isFinite) && q >= 0 && q <= 1, 'QUANTILE_INVALID');
  const xs = [...values].sort((a, b) => a - b), at = (xs.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (at - lo);
}
export function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  requireS11(state !== 0, 'PRNG_ZERO');
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state; };
}
export interface Pair { patient: string; template: string; fhir: number; compact: number; success: boolean }
export function compactResult(pairs: readonly Pair[], fulfilled: boolean, mutations: boolean) {
  const patients = [...new Set(pairs.map(p => p.patient))].sort();
  const complete = fulfilled && patients.length === STUDY.bootstrap.clusters && pairs.length === 24
    && patients.every(p => STUDY.templates.every(t => pairs.filter(x => x.patient === p && x.template === t).length === 1))
    && pairs.every(p => p.success && Number.isSafeInteger(p.fhir) && p.fhir > 0 && Number.isSafeInteger(p.compact) && p.compact > 0);
  if (!complete) return { status: 'unmeasured' as const, target_met: false, default: 'fhir' as const, attempted_pairs: pairs.length };
  const ratio = (p: Pair) => p.compact / p.fhir, ratios = pairs.map(ratio), random = xorshift32(STUDY.bootstrap.seed), medians: number[] = [];
  const clusters = patients.map(p => pairs.filter(x => x.patient === p).sort((a, b) => STUDY.templates.indexOf(a.template as typeof STUDY.templates[number]) - STUDY.templates.indexOf(b.template as typeof STUDY.templates[number])));
  for (let b = 0; b < STUDY.bootstrap.resamples; b++) {
    const sample: number[] = [];
    for (let i = 0; i < patients.length; i++) sample.push(...clusters[Math.floor(patients.length * random() / 2 ** 32)]!.map(ratio));
    medians.push(quantile(sample, 0.5));
  }
  const median = quantile(ratios, 0.5), interval = [quantile(medians, 0.025), quantile(medians, 0.975)];
  const status = interval[1]! < 1 ? 'smaller' : interval[0]! >= 1 ? 'not_smaller' : 'indeterminate';
  const targetMet = median <= STUDY.thresholds.compactMedian;
  return { status, median, p90: quantile(ratios, 0.9), interval, target_met: targetMet,
    fidelity_mutations: mutations ? 'passed' : 'unmeasured', default: status === 'smaller' && targetMet && mutations ? 'eligible_for_root_review' : 'fhir', attempted_pairs: pairs.length };
}
export interface EnvelopeBytes { structured: number; provenance: number; withheld: number; coverage: number; resources: number; remaining: number }
/** Serialized VALUES are disjoint; property names/separators stay only in the complete denominator. */
export function envelopeBytes(rawResult: string): EnvelopeBytes {
  const result = rec(JSON.parse(rawResult)), e = rec(result?.structuredContent);
  if (!e) return { structured: 0, provenance: 0, withheld: 0, coverage: 0, resources: 0, remaining: 0 };
  // rawMember avoids JS number reserialization (7.0, 1e2, unsafe integers) in these byte counts.
  const structured = rawJsonMember(rawResult, 'structuredContent')!;
  const data = rawJsonMember(structured, 'data'), transform = rawJsonMember(structured, 'transform');
  const size = (s: string | undefined) => s === undefined ? 0 : Buffer.byteLength(s);
  const provenance = size(rawJsonMember(structured, 'provenance')), coverage = size(rawJsonMember(structured, 'coverage'));
  const withheld = size(transform === undefined ? undefined : rawJsonMember(transform, 'withheld_payloads'));
  const resources = size(data === undefined ? undefined : rawJsonMember(data, 'resources'));
  const bytes = size(structured);
  return { structured: bytes, provenance, coverage, withheld, resources, remaining: bytes - resources - provenance - coverage - withheld };
}
// A lexical JSON member reader, independent of gateway serialization and safe for quoted braces/escaped keys.
export function rawJsonMember(text: string, name: string): string | undefined {
  let at = 0;
  const ws = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const string = () => { const start = at++; while (at < text.length) { if (text[at++] === '"') return text.slice(start, at); if (text[at - 1] === '\\') at++; } throw new Error('JSON_INVALID'); };
  const value = (): string => {
    ws(); const start = at, c = text[at];
    if (c === '"') return string();
    if (c === '{' || c === '[') { const end = c === '{' ? '}' : ']'; at++; while (at < text.length) { ws(); if (text[at] === end) { at++; return text.slice(start, at); } if (text[at] === ',' || text[at] === ':') at++; else value(); } throw new Error('JSON_INVALID'); }
    while (at < text.length && !/[\s,}\]]/.test(text[at]!)) at++;
    requireS11(at > start, 'JSON_INVALID'); return text.slice(start, at);
  };
  ws(); requireS11(text[at++] === '{', 'JSON_INVALID'); ws();
  while (text[at] !== '}') { const key = JSON.parse(string()); ws(); requireS11(text[at++] === ':', 'JSON_INVALID'); const raw = value(); if (key === name) return raw; ws(); if (text[at] === '}') break; requireS11(text[at++] === ',', 'JSON_INVALID'); ws(); }
  return undefined;
}
export function rawArrayValues(text: string): string[] {
  requireS11(Array.isArray(JSON.parse(text)), 'JSON_ARRAY_REQUIRED');
  const values: string[] = []; let start = 1, depth = 0, quoted = false;
  for (let at = 1; at < text.length; at++) {
    const c = text[at];
    if (quoted) { if (c === '\\') at++; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') { if (depth > 0) depth--; else { const value = text.slice(start, at).trim(); if (value) values.push(value); break; } }
    if (c === ',' && depth === 0) { values.push(text.slice(start, at).trim()); start = at + 1; }
  }
  return values;
}
export function resourceRootBytes(rawResult: string): Record<string, number> {
  const e = rawJsonMember(rawResult, 'structuredContent'), data = e && rawJsonMember(e, 'data'), resources = data && rawJsonMember(data, 'resources');
  const totals: Record<string, number> = {};
  for (const raw of resources ? rawArrayValues(resources) : []) {
    const resource = rec(JSON.parse(raw)); requireS11(resource, 'RESOURCE_INVALID');
    for (const key of Object.keys(resource)) {
      const label = `${resource.resourceType}.${key}`;
      totals[label] = (totals[label] ?? 0) + Buffer.byteLength(rawJsonMember(raw, key)!);
    }
  }
  return totals;
}
