// Latency protocol pieces: hash-driven draws and bootstrap, round order, probe construction, per-arm summary.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { DEV_SEED_HEX } from '../lib/hash.js';
import { results } from '../lib/paths.js';
import { bootstrap3, hashDraws, stat3 } from '../latency/stats.js';
import { buildProbes, roundOrder, type ProbeSet } from '../latency/probes.js';
import { summariseArm, type LatencyCall, type LatencySession } from '../latency/run.js';

test('hash draws are deterministic, in range and roughly uniform', () => {
  const a = hashDraws(DEV_SEED_HEX, 'x');
  const b = hashDraws(DEV_SEED_HEX, 'x');
  const xs = Array.from({ length: 3000 }, () => a(3));
  assert.deepEqual(xs.slice(0, 50), Array.from({ length: 50 }, () => b(3)));
  assert.ok(xs.every(v => v >= 0 && v < 3));
  for (const k of [0, 1, 2]) { const n = xs.filter(v => v === k).length; assert.ok(n > 850 && n < 1150, `${k}: ${n}`); }
  assert.notDeepEqual(Array.from({ length: 20 }, () => hashDraws(DEV_SEED_HEX, 'y')(1000)), xs.slice(0, 20));
});

test('stratified bootstrap: deterministic, intervals bracket the estimate', () => {
  const groups = [Array.from({ length: 30 }, (_, i) => 10 + (i % 7)), Array.from({ length: 30 }, (_, i) => 40 + (i % 5))];
  const ci1 = bootstrap3(groups, { seedHex: DEV_SEED_HEX, label: 't', B: 300 });
  const ci2 = bootstrap3(groups, { seedHex: DEV_SEED_HEX, label: 't', B: 300 });
  assert.deepEqual(ci1, ci2);
  const s = stat3(groups.flat());
  assert.ok(ci1.median.lo! <= s.median! && s.median! <= ci1.median.hi!);
  assert.ok(ci1.p95.lo! <= s.p95! && s.p95! <= ci1.p95.hi!);
  assert.equal(ci1.max.hi, s.max);
});

const SET: ProbeSet = {
  schema: 'fbbench.latency-probes/1', dataset: 'synthea-dev', seed_hex: DEV_SEED_HEX, patient_id: 'p',
  probes: Array.from({ length: 10 }, (_, i) => ({ id: `P${String(i + 1).padStart(2, '0')}`, label: `probe ${i}`, op: { op: 'read' as const, type: 'Patient', id: 'p' } })),
};

test('round order: a permutation per round, fixed by the hash, different between rounds', () => {
  const r0 = roundOrder(SET.probes, DEV_SEED_HEX, 'synthea-dev', 0).map(p => p.id);
  assert.deepEqual([...r0].sort(), SET.probes.map(p => p.id));
  assert.deepEqual(roundOrder(SET.probes, DEV_SEED_HEX, 'synthea-dev', 0).map(p => p.id), r0);
  assert.notDeepEqual(roundOrder(SET.probes, DEV_SEED_HEX, 'synthea-dev', 1).map(p => p.id), r0);
});

test('summary: first call apart, warm-ups dropped, failed calls excluded and reported', () => {
  const session = { arm: 'FB0', dataset: 'synthea-dev', patient_id: 'p', warmups: 1, reps: 2, cold_start_ms: 100, tools_list_bytes: 5, refused_probes: [], start_error: null } as unknown as LatencySession;
  const calls: LatencyCall[] = [];
  let seq = 0;
  for (let round = 0; round < 3; round++) {
    for (const p of SET.probes) {
      const refused = round === 2 && p.id === 'P10' ? 'RETENTION_LIMIT: x' : null;
      calls.push({ schema: 'fbbench.latency-call/1', arm: 'FB0', dataset: 'synthea-dev', round, position: 0, seq, probe_id: p.id, phase: seq === 0 ? 'first' : round < 1 ? 'warmup' : 'timed', tool: 't', latency_ms: seq === 0 ? 500 : round === 0 ? 99 : 10 + Number(p.id.slice(1)), bytes: null, is_error: false, error: null, items: 1, refused });
      seq++;
    }
  }
  const s = summariseArm(session, calls, SET);
  assert.equal(s.first_call?.latency_ms, 500);
  assert.equal(s.first_call?.excess_ms, 500 - 11);
  assert.equal(s.timed_calls, 20);
  assert.equal(s.timed_errors, 1);
  assert.equal(s.warm.n, 19);
  assert.ok((s.warm.max ?? 0) <= 20, 'warm-up latencies are not in the warm statistics');
  assert.equal(s.first_error?.probe_id, 'P10');
  assert.equal(s.per_probe.find(p => p.probe_id === 'P10')?.errors, 1);
});

test('probes from converted data (when present): 10 single calls for one patient, deterministic', async () => {
  if (!existsSync(join(results.converted('synthea-dev'), 'patients.json'))) return;
  const a = await buildProbes('synthea-dev', DEV_SEED_HEX);
  const b = await buildProbes('synthea-dev', DEV_SEED_HEX);
  assert.deepEqual(a, b);
  assert.equal(a.probes.length, 10);
  for (const p of a.probes) {
    if (p.op.op === 'search') assert.deepEqual(p.op.params[0], ['patient', `Patient/${a.patient_id}`]);
  }
  assert.equal(new Set(a.probes.map(p => p.label)).size, 10);
});
