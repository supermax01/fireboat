// Question generator: written selection rules, determinism, development patients only.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { computeGold } from '../gold/compute.js';
import { generate } from '../gold/generate.js';
import { candidateOrder, makeCandidate, select, splitEvenly, type Candidate } from '../gold/select.js';
import { GROUPS, TEMPLATES, type Proposal } from '../gold/templates.js';
import { DEV_SEED_HEX } from '../lib/hash.js';
import { stringifyLossless } from '../lib/json.js';
import { BENCH, LOCAL_CONFIG, mimicDevPatients, MIMIC_FHIR_DIR } from '../lib/paths.js';

/** MIMIC checks need the downloaded data and the local config; a present but malformed config still fails. */
const mimicSkip = () => (!existsSync(MIMIC_FHIR_DIR) ? 'MIMIC data not downloaded' : !existsSync(LOCAL_CONFIG) ? 'no bench-config.json (see bench/README.md)' : false);

const prop = (key: string, extra: Partial<Proposal> = {}): Proposal => ({ key, dedupe: key, parameters: {}, operations: [], ...extra });

test('allocation tables total 150 questions and every template has a definition', () => {
  for (const groups of Object.values(GROUPS)) {
    assert.equal(groups.reduce((n, g) => n + g.count, 0), 150);
    for (const t of groups.flatMap(g => g.templates)) assert.ok(TEMPLATES.has(t), t);
  }
  assert.deepEqual(splitEvenly(75, 9), [9, 9, 9, 8, 8, 8, 8, 8, 8]);
  assert.deepEqual(splitEvenly(7, 2), [4, 3]);
});

test('selection: hash order, per-patient cap before lifting, shortfall carried forward', () => {
  const pools = new Map<string, Candidate[]>();
  // L1: 20 codes for each of two patients. Every other template is empty.
  pools.set('L1', ['p1', 'p2'].flatMap(p => Array.from({ length: 20 }, (_, i) => makeCandidate('saq', DEV_SEED_HEX, 'L1', p, prop(`c${i}`)))));
  const s = select('mimic', pools);
  assert.equal(s.report.L1!.selected, 9);
  assert.equal(s.report.L1!.cap_lifted, false);
  assert.equal(s.report.L2!.shortfall, 9);
  assert.equal(s.report.L3!.carried_in, 9);
  assert.equal(s.unfilled, 150 - 9);
  const order = [...pools.get('L1')!].sort((a, b) => (a.hash < b.hash ? -1 : 1));
  const counts = new Map<string, number>();
  const expected: Candidate[] = [];
  for (const c of order) { if (expected.length === 9) break; if ((counts.get(c.patientId) ?? 0) >= 6) continue; expected.push(c); counts.set(c.patientId, (counts.get(c.patientId) ?? 0) + 1); }
  assert.deepEqual(s.selected.map(c => c.candidateKey), expected.map(c => c.candidateKey));

  // One patient only: the cap is lifted for that template, in hash order.
  const one = new Map([['L1', Array.from({ length: 20 }, (_, i) => makeCandidate('saq', DEV_SEED_HEX, 'L1', 'p1', prop(`c${i}`)))]]);
  const s1 = select('mimic', one);
  assert.equal(s1.report.L1!.selected, 9);
  assert.equal(s1.report.L1!.cap_lifted, true);

  // The (patient, template, code) constraint: two candidates with the same dedupe key give one question.
  const dup = new Map([['L1', [makeCandidate('saq', DEV_SEED_HEX, 'L1', 'p1', prop('a', { dedupe: 'x' })), makeCandidate('saq', DEV_SEED_HEX, 'L1', 'p1', prop('b', { dedupe: 'x' }))]]]);
  assert.equal(select('mimic', dup).report.L1!.selected, 1);
});

test('stratified templates alternate strata, each in hash order', () => {
  const cands = [
    ...Array.from({ length: 4 }, (_, i) => makeCandidate('saq', DEV_SEED_HEX, 'C2', 'p', prop(`y${i}`, { stratum: 'yes' }))),
    ...Array.from({ length: 2 }, (_, i) => makeCandidate('saq', DEV_SEED_HEX, 'C2', 'p', prop(`n${i}`, { stratum: 'no' }))),
  ];
  const strata = candidateOrder(cands).map(c => c.prop.stratum);
  assert.deepEqual(strata.slice(0, 4).sort(), ['no', 'no', 'yes', 'yes']);
  assert.notEqual(strata[0], strata[1]);
  assert.deepEqual(strata.slice(4), ['yes', 'yes']);
});

test('no randomness and no restricted literal in gold code', () => {
  const dir = join(BENCH, 'gold');
  for (const f of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.ok(!/Math\.random|crypto\.random|randomUUID|randomBytes/.test(src), f);
  }
});

test('MIMIC development generation is deterministic, development-only and has gold for every question', { skip: mimicSkip() }, async () => {
  const a = await generate('mimic');
  const b = await generate('mimic');
  assert.equal(a.questions.map(q => stringifyLossless(q)).join('\n'), b.questions.map(q => stringifyLossless(q)).join('\n'));
  assert.equal(a.probes.map(p => stringifyLossless(p)).join('\n'), b.probes.map(p => stringifyLossless(p)).join('\n'));
  assert.ok(a.questions.length > 100);
  const dev = new Set(mimicDevPatients());
  for (const q of a.questions) {
    assert.ok(dev.has(q.patient_id), q.id);
    assert.equal(q.seed.kind, 'dev');
    assert.equal(q.id, `mimic.${q.template_id}.${q.rank_hash.slice(0, 12)}`);
    for (const v of Object.values(q.parameters)) assert.equal(typeof v, 'string');
  }
  for (const p of a.probes) {
    assert.ok(dev.has(p.patient_id));
    if (p.other_patient_id) assert.ok(dev.has(p.other_patient_id), 'confinement targets must be development patients');
  }
  assert.equal(a.probes.filter(p => p.probe_set === 'confinement').length, 50);
  const g1 = await computeGold('mimic', a.questions);
  const g2 = await computeGold('mimic', a.questions);
  assert.deepEqual(g1.failures, []);
  assert.equal(g1.gold.length, a.questions.length);
  assert.equal(g1.gold.map(g => stringifyLossless(g)).join('\n'), g2.gold.map(g => stringifyLossless(g)).join('\n'));
  for (const g of g1.gold) {
    if (g.answer_kind === 'none') assert.equal(g.answer, null);
    if (g.answer_list) assert.deepEqual(g.answer_list, [...g.answer_list].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))));
    assert.equal(g.completeness.size, g.depends_on.length);
  }
});
