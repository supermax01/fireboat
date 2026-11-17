// Descriptive latency statistics: median, p95 and maximum with percentile bootstrap intervals.
// Resampling draws come from sha256 in counter mode (purpose "bootstrap"), never from a random-number library.
import { createHash } from 'node:crypto';
import { HASH_TAG, jcsStringArray } from '../lib/hash.js';
import { quantile } from '../run/summary.js';

export { quantile };

/** Deterministic uniform integers in [0, n) from sha256(JCS([tag, "bootstrap", seed, label, counter])), by rejection. */
export function hashDraws(seedHex: string, label: string): (n: number) => number {
  let counter = 0;
  let buf = Buffer.alloc(0);
  let off = 0;
  const next32 = (): number => {
    if (off + 4 > buf.length) {
      buf = createHash('sha256').update(jcsStringArray([HASH_TAG, 'bootstrap', seedHex, label, String(counter++)])).digest();
      off = 0;
    }
    const v = buf.readUInt32BE(off);
    off += 4;
    return v;
  };
  return (n: number) => {
    if (!Number.isInteger(n) || n <= 0 || n > 2 ** 32) throw new Error('bad range');
    const limit = Math.floor(2 ** 32 / n) * n;
    for (;;) { const v = next32(); if (v < limit) return v % n; }
  };
}

export interface Stat3 { median: number | null; p95: number | null; max: number | null }
export interface Interval { lo: number | null; hi: number | null }

export const stat3 = (xs: readonly number[]): Stat3 => ({ median: quantile(xs, 0.5), p95: quantile(xs, 0.95), max: quantile(xs, 1) });

/**
 * Stratified percentile bootstrap: each resample draws, within every group (one group per probe), as many values as the
 * group has, with replacement; the statistic is taken over the pooled resample. 95% interval: 2.5th and 97.5th
 * percentiles (nearest rank) of B resampled statistics.
 */
export function bootstrap3(groups: readonly (readonly number[])[], o: { seedHex: string; label: string; B?: number }): Record<keyof Stat3, Interval> {
  const B = o.B ?? 2000;
  const draw = hashDraws(o.seedHex, o.label);
  const acc: Record<keyof Stat3, number[]> = { median: [], p95: [], max: [] };
  const nonEmpty = groups.filter(g => g.length > 0);
  if (!nonEmpty.length) return { median: { lo: null, hi: null }, p95: { lo: null, hi: null }, max: { lo: null, hi: null } };
  for (let b = 0; b < B; b++) {
    const sample: number[] = [];
    for (const g of nonEmpty) for (let i = 0; i < g.length; i++) sample.push(g[draw(g.length)]!);
    const s = stat3(sample);
    acc.median.push(s.median!);
    acc.p95.push(s.p95!);
    acc.max.push(s.max!);
  }
  const iv = (xs: number[]): Interval => ({ lo: quantile(xs, 0.025), hi: quantile(xs, 0.975) });
  return { median: iv(acc.median), p95: iv(acc.p95), max: iv(acc.max) };
}
