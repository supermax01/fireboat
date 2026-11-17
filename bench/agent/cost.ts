// Cost three ways: the CLI's estimate, recomputed from usage with the price table, and uncached-equivalent.
import type { AgentRunRecord } from '../lib/types.js';

/** USD per million tokens, as published on the date below; cache write = 1.25 x input. Update both together. */
export const PRICES: Readonly<Record<string, { input: number; output: number; cache_read: number; cache_write: number }>> = {
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
};
export const PRICE_TABLE_DATE = '2026-11-03';

export interface RunCost { cli_usd: number | null; recomputed_usd: number | null; uncached_equivalent_usd: number | null }

export function runCost(r: Pick<AgentRunRecord, 'usage' | 'total_cost_usd' | 'model_requested'>): RunCost {
  const p = PRICES[r.model_requested];
  const u = r.usage;
  const cli = r.total_cost_usd === null ? null : Number(r.total_cost_usd);
  if (!p || !u) return { cli_usd: cli, recomputed_usd: null, uncached_equivalent_usd: null };
  const m = 1e6;
  return {
    cli_usd: cli,
    recomputed_usd: (u.input * p.input + u.output * p.output + u.cache_read * p.cache_read + u.cache_write * p.cache_write) / m,
    uncached_equivalent_usd: ((u.input + u.cache_read + u.cache_write) * p.input + u.output * p.output) / m,
  };
}
