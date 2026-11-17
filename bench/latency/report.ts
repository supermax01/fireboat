// Report section for the latency protocol (latency/run.ts). Used by bench:latency (report.md) and bench:scripted-report --latency.
import type { ArmLatency } from './run.js';
import type { ProbeSet } from './probes.js';

const ARM_ORDER = ['FB0', 'FBd', 'FB', 'FBt', 'W', 'M', 'H'];
const order = (a: ArmLatency, b: ArmLatency) => a.dataset.localeCompare(b.dataset) || (ARM_ORDER.indexOf(a.arm) - ARM_ORDER.indexOf(b.arm)) || a.arm.localeCompare(b.arm);
const ms = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? '-' : (Math.round(x * 10 ** d) / 10 ** d).toFixed(d));
const ci = (v: number | null, i: { lo: number | null; hi: number | null }) => `${ms(v)} [${ms(i.lo)}, ${ms(i.hi)}]`;

export const LATENCY_RULES = [
  'Descriptive only. Stdio on one machine against one HAPI; other benchmark slots may have been running against the same HAPI at the same time.',
  'One server session per arm and dataset. Cold start: spawn to the initialize result. First call: the session\'s first tool call (the first probe of round 1 in rank-hash order); it pays once-per-session work. "Excess" is the first call minus that probe\'s timed median.',
  'Warm per-call latency: 30 timed rounds after 5 discarded warm-up rounds; each round runs the 10 probes once, in a rank-hash order that changes per round (purpose "order"). Latency is request sent to matching response line on stdio.',
  'Intervals: 95% stratified percentile bootstrap (2,000 resamples within each probe, pooled; draws from sha256 in counter mode, purpose "bootstrap"). Percentiles are nearest-rank. The interval for the maximum is shown as computed; it is not a reliable interval.',
  'Warm statistics use the timed calls that succeeded; failed calls (tool errors, refusals, transport errors) are counted beside them and excluded, because a refusal is answered without the work the probe measures. fireboat\'s documented handle quota (docs/LIMITS.md: maxHandles 128 by default, 15-minute TTL, consumed cursors not reclaimed) makes cursor-issuing searches fail with RETENTION_LIMIT once a session has issued that many; 35 rounds of 7 searches exceed it.',
  'Probes are single calls for one patient (searches return one page at the arm\'s page size: 100 for fireboat, HAPI\'s maximum 200 for the others), so result sizes differ between arms; the median result bytes per probe are shown beside the times.',
];

export function latencySection(arms: readonly ArmLatency[], probeSets: Record<string, ProbeSet>, o: { campaign: string; level?: number }): string[] {
  const h = '#'.repeat(o.level ?? 2);
  const rows = [...arms].sort(order);
  const md = [
    `${h} Latency (descriptive): ${o.campaign}`, '',
    `Protocol as run: ${[...new Set(rows.map(r => `${r.warmups} warm-up and ${r.reps} timed rounds of ${probeSets[r.dataset]?.probes.length ?? '?'} probes`))].join('; ')}, one session per arm.`, '',
    '| dataset | arm | cold start (ms) | first call (ms) | first-call probe | excess over that probe\'s warm median (ms) | warm per-call median [95% CI] (ms) | p95 [95% CI] (ms) | max [95% CI] (ms) | timed calls ok / run | errors (first at call, reason) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    md.push(`| ${r.dataset} | ${r.arm} | ${ms(r.cold_start_ms)} | ${ms(r.first_call?.latency_ms)} | ${r.first_call ? `${r.first_call.probe_id} ${r.first_call.label}` : '-'} | ${ms(r.first_call?.excess_ms)} | ${ci(r.warm.median, r.warm.ci95.median)} | ${ci(r.warm.p95, r.warm.ci95.p95)} | ${ci(r.warm.max, r.warm.ci95.max)} | ${r.warm.n} / ${r.timed_calls} | ${r.errors}${r.first_error ? ` (call ${r.first_error.seq + 1}, ${r.first_error.reason.split(':')[0]})` : ''}${r.start_error ? ' (start failed)' : ''}${r.refused_probes.length ? ` (${r.refused_probes.length} probes not expressible)` : ''} |`);
  }
  for (const d of [...new Set(rows.map(r => r.dataset))]) {
    const set = probeSets[d];
    const ds = rows.filter(r => r.dataset === d);
    if (!set) continue;
    md.push('', `${h}# Per-probe warm median, p95 (ms) and median result bytes: ${d}`, '', `| probe | ${ds.map(r => r.arm).join(' | ')} |`, `| --- | ${ds.map(() => '---').join(' | ')} |`);
    for (const p of set.probes) {
      md.push(`| ${p.id} ${p.label} | ${ds.map(r => { const x = r.per_probe.find(q => q.probe_id === p.id); return x && x.n ? `${ms(x.median)}, ${ms(x.p95)}; ${x.result_bytes_median ?? '-'} B${x.errors ? `; n=${x.n}, ${x.errors} errors` : ''}` : x?.errors ? `all ${x.errors} errored` : '-'; }).join(' | ')} |`);
    }
  }
  md.push('', `${h}# Latency rules`, '', ...LATENCY_RULES.map(x => `- ${x}`), '');
  return md;
}

export function latencyReport(arms: readonly ArmLatency[], probeSets: Record<string, ProbeSet>, o: { campaign: string; raw: string }): string[] {
  return [`# Latency report: ${o.campaign}`, '', ...latencySection(arms, probeSets, { campaign: o.campaign, level: 2 }), '## Raw data', '', `- Probes, calls, sessions and the proxy log: ${o.raw}`, ''];
}
