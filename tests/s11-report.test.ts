import assert from 'node:assert/strict';
import test from 'node:test';
import { STUDY, compactResult, quantile, xorshift32, type Pair } from '../scripts/s11/study.js';
import { analyze, type Tokens } from '../scripts/s11/report.js';
import type { Attempt } from '../scripts/s11/measure.js';

function pairs(ratio = 0.8): Pair[] {
  return Array.from({ length: 8 }, (_, i) => STUDY.templates.map(template => ({ patient: `heldout-large-${i + 1}`, template, fhir: 1000, compact: Math.round(1000 * ratio), success: true }))).flat();
}
test('S11 exact quantiles, unsigned xorshift and patient-cluster bootstrap keep all three tasks together', () => {
  assert.equal(quantile([0, 10], 0.025), 0.25); assert.equal(quantile([30, 0, 10, 20], 0.9), 27);
  assert.throws(() => quantile([], 0.5), /QUANTILE_INVALID/); assert.throws(() => xorshift32(0), /PRNG_ZERO/);
  const random = xorshift32(1);
  assert.deepEqual(Array.from({ length: 5 }, random), [270369, 67634689, 2647435461, 307599695, 2398689233]);
  assert.equal(STUDY.bootstrap.seed, 0x4d336231); assert.equal(STUDY.bootstrap.resamples, 10000);
  const xs = pairs().map((p, i) => ({ ...p, compact: 500 + Math.floor(i / 3) * 100 }));
  const result = compactResult(xs, true, true);
  assert.ok(result.interval);
  assert.ok(result.interval[0]! <= 0.65 && result.interval[1]! >= 1.05, 'eight patient clusters must retain between-patient uncertainty');
  assert.deepEqual(compactResult(xs, true, true), result, 'bootstrap is reproducible');
});
test('S11 C.1 distinguishes point target, statistical smaller, null/negative results and missing fidelity evidence', () => {
  const exact = compactResult(pairs(0.9), true, true);
  assert.equal(exact.status, 'smaller'); assert.equal(exact.target_met, true);
  assert.equal(exact.default, 'eligible_for_root_review');
  const miss = compactResult(pairs(0.901), true, true);
  assert.equal(miss.status, 'smaller'); assert.equal(miss.target_met, false); assert.equal(miss.default, 'fhir');
  const nullResult = compactResult(pairs(1), true, true);
  assert.equal(nullResult.status, 'not_smaller'); assert.equal(nullResult.target_met, false); assert.equal(nullResult.default, 'fhir');
  assert.equal(compactResult(pairs(1.1), true, true).status, 'not_smaller');
  const mixed = pairs().map((p, i) => ({ ...p, compact: i < 12 ? 800 : 1200 }));
  assert.equal(compactResult(mixed, true, true).status, 'indeterminate');
  assert.equal(compactResult(pairs(), true, false).default, 'fhir');
});
test('S11 incomplete, failed, zero-token and duplicated pairs cannot produce an efficiency win', () => {
  const good = pairs();
  for (const [sample, fulfilled] of [[good.slice(1), true], [good, false], [good.map((p, i) => i ? p : { ...p, success: false }), true],
    [good.map((p, i) => i ? p : { ...p, fhir: 0 }), true], [good.map((p, i) => i ? p : { ...p, compact: 0 }), true],
    [[...good.slice(1), good[1]!], true]] as [Pair[], boolean][]) {
    const result = compactResult(sample, fulfilled, true); assert.equal(result.status, 'unmeasured'); assert.equal(result.target_met, false); assert.equal(result.default, 'fhir');
  }
});
test('S11 uses median paired task ratios rather than a ratio of aggregate tokens', () => {
  const xs = pairs().map((p, i) => ({ ...p, fhir: i % 3 === 2 ? 1000000 : 1000, compact: i % 3 === 2 ? 1400000 : i % 3 === 1 ? 800 : 500 }));
  const result = compactResult(xs, true, true); assert.ok('median' in result); assert.equal(result.median, 0.8);
  assert.ok(xs.reduce((n, p) => n + p.compact, 0) / xs.reduce((n, p) => n + p.fhir, 0) > 1.39);
});
function fixture() {
  const attempts: Attempt[] = pairs().flatMap(p => STUDY.arms.map(arm => ({ id: `${p.patient}-${p.template}-modern-${arm}`, patient: p.patient,
    split: 'heldout' as const, stratum: 'large' as const, template: p.template, era: 'modern' as const, arm, delivery: 'full-text-v1' as const,
    status: 'pass' as const, fidelity: { checked: 50, failed: 0 }, wire_result_bytes: 500, frame_bytes: 540, model_bytes: 250,
    envelope: { structured: 100, provenance: 10, withheld: 0, coverage: 5, resources: 50, remaining: 35 }, segments: [], resource_root_bytes: {} })));
  const tokens: Tokens = { schema: 'fireboat-s11-tokens/1', status: 'measured', attempts: attempts.map(a => ({ id: a.id, tokens: Object.fromEntries(STUDY.encodings.map(e => [e,
    { catalog: 2000, request: 20, model: a.arm === 'compact' ? 800 : 1000, wire: 1200, combined_task: a.arm === 'compact' ? 2820 : 3020 }])) })) };
  return { attempts, tokens };
}
test('S11 reports exploratory/reference and mutation gaps honestly while retaining every failed/unsupported attempt', () => {
  const f = fixture(), report = analyze(f.attempts, f.tokens, true, true);
  assert.equal(report.c1[0]!.acceptance, 'target-met'); assert.equal(report.c1[0]!.runtime_default, 'fhir');
  assert.equal(report.c1[2]!.status, 'unmeasured', 'unrun legacy cell stays unmeasured');
  assert.equal(report.structured_delivery.status, 'unmeasured'); assert.equal(report.defaults.changed, false);
  const exploratory = analyze(f.attempts, { ...f.tokens, status: 'exploratory' }, true, true);
  assert.equal(exploratory.c1[0]!.status, 'unmeasured'); assert.equal(exploratory.c1[0]!.descriptive_statistics.status, 'smaller');
  assert.equal(analyze(f.attempts, f.tokens, true).c1[0]!.acceptance, 'unmeasured-fidelity-mutation-gate');
  f.attempts[0]!.status = 'unsupported'; f.attempts[0]!.model_bytes = 0;
  const failed = analyze(f.attempts, f.tokens, true, true);
  assert.equal(failed.c1[0]!.status, 'unmeasured'); assert.equal(failed.attempts.length, 72);
  const c2 = failed.c2.find(c => c.era === 'modern' && c.arm === 'fhir' && c.split === 'heldout')!;
  assert.equal(c2.attempted, 24); assert.equal(c2.correct, 23); assert.equal(c2.unsupported, 1); assert.equal(c2.model_bytes_per_correct_answer.n, 23);
  assert.throws(() => analyze([...f.attempts, f.attempts[0]!], f.tokens, true), /ATTEMPT_DUPLICATE/);
  const invalid = structuredClone(f.tokens); invalid.attempts[0]!.tokens.cl100k_base!.model = -1;
  assert.throws(() => analyze(f.attempts, invalid, true), /TOKEN_COUNTS_INVALID/);
});
test('S11 C.3 uses complete tasks, separate formats and the inclusive 15% threshold', () => {
  const f = fixture(), report = analyze(f.attempts, f.tokens, true, true);
  const full = report.c3.find(c => c.era === 'modern' && c.arm === 'fhir')!;
  assert.equal(full.status, 'measured'); assert.equal(full.target_met, true); assert.equal(full.combined_share_all_attempts.median, 0.15);
  for (const a of f.attempts) if (a.arm === 'compact') { a.envelope.withheld = 1; a.envelope.remaining--; }
  const changed = analyze(f.attempts, f.tokens, true, true);
  assert.equal(changed.c3.find(c => c.era === 'modern' && c.arm === 'compact')!.target_met, false);
  assert.equal(changed.c3.find(c => c.era === 'modern' && c.arm === 'fhir')!.target_met, true);
  f.attempts[0]!.status = 'fail';
  assert.equal(analyze(f.attempts, f.tokens, true, true).c3[0]!.status, 'unmeasured');
  const wrongCohort = fixture();
  wrongCohort.attempts.forEach((a, i) => { a.patient = `distinct-${i}`; });
  assert.equal(analyze(wrongCohort.attempts, wrongCohort.tokens, true, true).c3[0]!.status, 'unmeasured');
});
