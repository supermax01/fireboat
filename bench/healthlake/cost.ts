// Cost estimate for one HealthLake test day (bench:healthlake -- plan). Prices as published on
// https://aws.amazon.com/healthlake/pricing/ (read on the `as_of` date below): the page gives one rate set without a region and its
// worked examples are us-east-1, so confirm us-east-2 in the AWS Pricing Calculator before relying on these figures.
// The load method is REST batch PUT (no S3, no IAM role, no KMS key), so the data store is the only billed resource.

export const PRICES = {
  as_of: '2026-11-15',
  source: 'https://aws.amazon.com/healthlake/pricing/',
  caveat: 'one published rate set, no region named (examples are us-east-1); confirm us-east-2 in the AWS Pricing Calculator',
  datastore_hour_usd: 0.27,
  included_storage_gb: 10, // across all data stores
  storage_gb_month_usd: { standard: 0.25, advanced: 0.37 },
  included_queries_per_hour: 3500, // across data stores, calculated monthly
  queries_per_10k_usd: { standard: 0.015, advanced: 0.048 },
  import_usd: { standard: 0, advanced: 0 }, // advanced: free for the first two months
  hours_per_month: 720,
} as const;

export type Tier = 'standard' | 'advanced';

export interface CostInput {
  /** Data store hours from create to delete (billed from creation until deletion). */
  hours: number;
  /** Stored data, GB (the holdout's converted NDJSON is 0.19 GB). */
  storage_gb: number;
  /** FHIR requests sent: load writes (counted per resource, the upper bound), verify and benchmark reads. */
  requests: number;
  tier: Tier;
}

export interface CostLine { item: string; quantity: string; usd_expected: number; usd_upper: number; note: string }
export interface CostEstimate { lines: CostLine[]; total_expected: number; total_upper: number; prices: typeof PRICES; input: CostInput }

const round = (x: number) => Math.round(x * 100) / 100;

/**
 * Expected: storage under the included 10 GB and requests under the included 3,500 per hour are free. Upper bound: every
 * request billed (as if the account's monthly query allowance were already used) and storage billed for the hours held.
 */
export function estimateCost(i: CostInput): CostEstimate {
  if (!(i.hours > 0) || !(i.storage_gb >= 0) || !(i.requests >= 0)) throw new Error('bad cost input');
  const ds = i.hours * PRICES.datastore_hour_usd;
  const storageBilledGb = Math.ceil(i.storage_gb);
  const storageUpper = storageBilledGb * PRICES.storage_gb_month_usd[i.tier] * (i.hours / PRICES.hours_per_month);
  const storageExpected = i.storage_gb <= PRICES.included_storage_gb ? 0 : Math.ceil(i.storage_gb - PRICES.included_storage_gb) * PRICES.storage_gb_month_usd[i.tier] * (i.hours / PRICES.hours_per_month);
  const queryUnits = Math.ceil(i.requests / 10_000);
  const queriesUpper = queryUnits * PRICES.queries_per_10k_usd[i.tier];
  const included = PRICES.included_queries_per_hour * i.hours;
  const queriesExpected = i.requests <= included ? 0 : Math.ceil((i.requests - included) / 10_000) * PRICES.queries_per_10k_usd[i.tier];
  const lines: CostLine[] = [
    { item: 'data store hours', quantity: `${i.hours} h x $${PRICES.datastore_hour_usd}`, usd_expected: ds, usd_upper: ds, note: 'billed from creation until deletion' },
    { item: 'storage', quantity: `${i.storage_gb.toFixed(2)} GB`, usd_expected: storageExpected, usd_upper: storageUpper, note: `first ${PRICES.included_storage_gb} GB included` },
    { item: 'requests', quantity: `${i.requests} requests (${queryUnits} x 10k)`, usd_expected: queriesExpected, usd_upper: queriesUpper, note: `first ${PRICES.included_queries_per_hour} per hour included; upper bound bills every request` },
    { item: 'load (REST batch PUT)', quantity: 'counted in requests', usd_expected: 0, usd_upper: 0, note: 'no S3, IAM or KMS resources' },
  ];
  const total_expected = round(lines.reduce((a, l) => a + l.usd_expected, 0));
  const total_upper = round(lines.reduce((a, l) => a + l.usd_upper, 0));
  return { lines: lines.map(l => ({ ...l, usd_expected: round(l.usd_expected), usd_upper: round(l.usd_upper) })), total_expected, total_upper, prices: PRICES, input: i };
}

/** Request counts used by `plan` (estimates; the run's proxy logs give the real numbers). */
export function plannedRequests(x: { resources: number; types: number; units: number; arms: number; passes: number; httpPerRun: number }): { load: number; verify: number; runs: number; total: number } {
  const load = x.resources; // each PUT entry counted as a request (upper bound; about resources/100 batch calls)
  const verify = x.types * 2 + 4;
  const runs = x.units * x.arms * x.passes * x.httpPerRun;
  return { load, verify, runs, total: load + verify + runs };
}

export function formatEstimate(e: CostEstimate): string {
  const rows = e.lines.map(l => `  ${l.item.padEnd(24)} ${l.quantity.padEnd(36)} expected $${l.usd_expected.toFixed(2).padStart(6)}  upper $${l.usd_upper.toFixed(2).padStart(6)}  (${l.note})`);
  return [...rows, `  ${'total'.padEnd(24)} ${''.padEnd(36)} expected $${e.total_expected.toFixed(2).padStart(6)}  upper $${e.total_upper.toFixed(2).padStart(6)}`,
    `  prices ${e.prices.as_of} from ${e.prices.source}; tier ${e.input.tier}; ${e.prices.caveat}`].join('\n');
}
