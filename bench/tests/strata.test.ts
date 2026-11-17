// Strata: long-list and decimal templates on synthetic records, the selection rules, output
// guards, and that the main question sets regenerate byte for byte with the strata off.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { computeGold } from '../gold/compute.js';
import { generate, strataGroups } from '../gold/generate.js';
import { BANDS, bandTarget, llDate, llType, llWindow, tokenCodings } from '../gold/longlist.js';
import { PatientData, SharedData } from '../gold/reader.js';
import { computeCore, hasRule, lexemeEligible, type Ctx } from '../gold/rules.js';
import { makeCandidate, select, type Candidate } from '../gold/select.js';
import { goldPaths } from '../gold/source.js';
import { floatChangeReason, significantDigits } from '../gold/strata-measure.js';
import { assertSafeOut, strataArg } from '../gold/strata-out.js';
import { GROUPS, STRATA, STRATA_GROUPS, TEMPLATES, type Proposal } from '../gold/templates.js';
import { DEV_SEED_HEX } from '../lib/hash.js';
import { stringifyLossless } from '../lib/json.js';
import { LOCAL, MIMIC_FHIR_DIR, results, SYNTHEA_FHIR_DIR, type DatasetId } from '../lib/paths.js';
import type { Res } from '../gold/fhir.js';

const CS = 'http://example.org/fhir/cs'; // synthetic code system
const PID = 'synthetic-patient-1';

function ctxOf(records: Res[]): Ctx {
  const data = new PatientData('synthea-dev', PID, 'synthetic.json');
  data.add({ resourceType: 'Patient', id: PID, birthDate: '1970-01-01', gender: 'female' });
  for (const r of records) data.add(r);
  return { data, shared: new SharedData() };
}

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const T0 = Date.UTC(2020, 0, 1, 0, 30, 0);
const HOUR = 3_600_000;

/** Observations every `stepMs`, category "cat-a"; code "c1" on every other record, all with a second coding. */
function observations(n: number, stepMs: number, prefix = 'o'): Res[] {
  return Array.from({ length: n }, (_, i) => ({
    resourceType: 'Observation', id: `${prefix}${i}`, status: 'final', subject: { reference: `Patient/${PID}` },
    category: [{ coding: [{ system: CS, code: 'cat-a', display: 'Category A' }] }],
    code: { coding: [{ system: CS, code: i % 2 === 0 ? 'c1' : 'c2', display: 'Code' }, { system: `${CS}/alt`, code: 'x', display: 'Alt' }] },
    effectiveDateTime: iso(T0 + i * stepMs),
    valueQuantity: { value: String(i), unit: 'u' },
  }));
}

const B = (id: string) => BANDS.find(b => b.id === id)!;
const claimsHourly = (n: number, created = (i: number) => iso(T0 + i * HOUR)): Res[] => Array.from({ length: n }, (_, i) => ({
  resourceType: 'Claim', id: `cl${i}`, patient: { reference: `Patient/${PID}` }, created: created(i),
  type: { coding: [{ system: CS, code: i % 2 ? 't1' : 't2' }] }, total: { value: `${i % 10}.25`, currency: 'USD' },
}));

test('long-list window: earliest UTC day to the day after the target-th record, hours when a day is too dense', () => {
  // One record per hour: the 201st record falls on day 9 (index 200 = 8 days 8 hours after T0).
  const hourly = Array.from({ length: 2000 }, (_, i) => iso(T0 + i * HOUR));
  const w = llWindow(hourly, 201, 1000)!;
  assert.deepEqual(w, ['2020-01-01T00:00:00Z', '2020-01-10T00:00:00Z']);
  assert.equal(hourly.filter(t => t >= w[0] && t < w[1]).length, 216);
  // 2,000 records within one day: day granularity gives 2,000 > max, so hours are used.
  const dense = Array.from({ length: 2000 }, (_, i) => iso(T0 + i * 30_000));
  const wh = llWindow(dense, 201, 1000)!;
  assert.equal(wh[0], '2020-01-01T00:00:00Z');
  const inHours = dense.filter(t => Date.parse(t) >= Date.parse(wh[0]) && Date.parse(t) < Date.parse(wh[1])).length;
  assert.ok(inHours >= 201 && inHours <= 1000, String(inHours));
  assert.equal(llWindow(Array.from({ length: 1500 }, () => iso(T0)), 201, 1000), null); // same second: nothing fits
  assert.equal(llWindow(hourly.slice(0, 201), 201, 1000), null); // not larger than the target
});

test('long-list targets are drawn by hash, uniformly within the band, not at its lower edge', () => {
  for (const band of BANDS) {
    const targets = Array.from({ length: 200 }, (_, i) => bandTarget(DEV_SEED_HEX, `LS1-${band.id}`, `p|set${i}`, band));
    assert.ok(targets.every(t => t >= band.min && t <= band.max));
    const mid = (band.min + band.max) / 2;
    assert.ok(targets.filter(t => t > mid).length > 60 && targets.filter(t => t <= mid).length > 60, band.id);
  }
  assert.equal(bandTarget(DEV_SEED_HEX, 'LS1-B3', 'p|x', B('B3')), bandTarget(DEV_SEED_HEX, 'LS1-B3', 'p|x', B('B3')));
  assert.notEqual(bandTarget(DEV_SEED_HEX, 'LS1-B3', 'p|x', B('B3')), bandTarget('1'.repeat(64), 'LS1-B3', 'p|x', B('B3')));
});

test('long-list tokens match any coding; dates need seconds and an offset', () => {
  const [o] = observations(1, HOUR);
  assert.deepEqual(tokenCodings(o!, llType('Observation').tokens[0]!).map(c => `${c.system}|${c.code}`), [`${CS}|c1`, `${CS}/alt|x`]);
  const enc: Res = { resourceType: 'Encounter', id: 'e', class: { system: CS, code: 'AMB' } };
  assert.deepEqual(tokenCodings(enc, llType('Encounter').tokens[1]!).map(c => c.code), ['AMB']);
  const date = llType('Observation').date!;
  assert.equal(llDate({ resourceType: 'Observation', id: 'a', effectiveDateTime: '2020-01-01' }, date), null);
  assert.equal(llDate({ resourceType: 'Observation', id: 'b', effectiveDateTime: '2020-01-01T10:00:00+05:30' }, date), '2020-01-01T10:00:00+05:30');
});

test('LS1: distinct codes of a type set or a token set on another element, per band, gold from the records', () => {
  const procs: Res[] = Array.from({ length: 150 }, (_, i) => ({ resourceType: 'Procedure', id: `pr${i}`, subject: { reference: `Patient/${PID}` }, code: { coding: [{ system: CS, code: `p${i % 3}` }] }, performedDateTime: iso(T0 + i * HOUR) }));
  const ctx = ctxOf([...observations(250, HOUR), ...claimsHourly(1200), ...procs]);
  const b3 = TEMPLATES.get('LS1-B3')!.propose(ctx, 'synthea-dev', DEV_SEED_HEX);
  // Observation codes are not asked within a code set; Procedure (150) belongs to B2.
  assert.deepEqual(b3.map(p => p.key), ['Observation', 'Claim', `Observation|category|${CS}|cat-a`]);
  const obs = computeCore({ template_id: 'LS1-B3', parameters: b3[0]!.parameters, patient_id: PID }, ctx);
  assert.equal(obs.answer_form, 'list');
  assert.deepEqual(obs.answer_list, [`${CS}/alt|x`, `${CS}|c1`, `${CS}|c2`]);
  assert.equal(obs.depends_on.length, 250);
  assert.equal(obs.items.length, 250); // a list question: every record of the set must be returned
  const claim = b3[1]!;
  const target = bandTarget(DEV_SEED_HEX, 'LS1-B3', `${PID}|Claim`, B('B3'));
  assert.equal(claim.parameters.window_start, '2020-01-01T00:00:00Z');
  const g = computeCore({ template_id: 'LS1-B3', parameters: claim.parameters, patient_id: PID }, ctx);
  const n = claimsHourly(1200).filter(c => (c.created as string) >= claim.parameters.window_start! && (c.created as string) < claim.parameters.window_end!).length;
  assert.equal(g.depends_on.length, n);
  assert.ok(n >= target && n < target + 24 && n <= 1000, `${n} vs target ${target}`);
  assert.deepEqual(g.answer_list, [`${CS}|t1`, `${CS}|t2`]);
  assert.deepEqual(claim.operations[0], { op: 'drain', type: 'Claim', call_cap: 20,
    params: [['patient', `Patient/${PID}`], ['created', `ge${claim.parameters.window_start}`], ['created', `lt${claim.parameters.window_end}`]] });
  const cat = b3[2]!;
  assert.equal(TEMPLATES.get('LS1-B3')!.text(cat.parameters, 'concept'), "Which distinct code codes appear on this patient's Observation records with category Category A? Give each as system|code.");
  assert.match(TEMPLATES.get('LS1-B3')!.text(claim.parameters, 'concept'), /^Which distinct type codes appear on this patient's Claim records with creation time from 2020-01-01T00:00:00Z \(inclusive\) to .+ \(exclusive\)\? Give each as system\|code\.$/);
  // B2 holds the Procedure set whole and a hashed window of each larger set.
  const b2 = TEMPLATES.get('LS1-B2')!.propose(ctx, 'synthea-dev', DEV_SEED_HEX);
  assert.ok(b2.some(p => p.key === 'Procedure' && !p.parameters.window_start));
  for (const p of b2) {
    const size = computeCore({ template_id: 'LS1-B2', parameters: p.parameters, patient_id: PID }, ctx).depends_on.length;
    assert.ok(size >= 101 && size <= 200, `${p.key} ${size}`);
  }
  assert.throws(() => TEMPLATES.get('LS1-B2')!.propose(ctx, 'synthea-dev'), /needs the seed/);
});

test('LS2: largest value of one Observation code or of Claim totals; ties keep every record, differing text excludes', () => {
  const tie: Res[] = Array.from({ length: 32 }, (_, i) => ({
    resourceType: 'Observation', id: `d${i}`, status: 'final', subject: { reference: `Patient/${PID}` }, code: { coding: [{ system: CS, code: 'd' }] },
    effectiveDateTime: iso(T0 + i * 60_000), valueQuantity: { value: i === 30 ? '7' : i === 31 ? '7.0' : '1', unit: 'u' },
  }));
  const ctx = ctxOf([...observations(250, HOUR), ...claimsHourly(150), ...tie]);
  const b2 = TEMPLATES.get('LS2-B2')!.propose(ctx, 'synthea-dev', DEV_SEED_HEX);
  assert.deepEqual(b2.map(p => p.key), [`Observation|code|${CS}|c1`, `Observation|code|${CS}/alt|x`, `Observation|code|${CS}|c2`, 'Claim']);
  assert.ok(b2[1]!.parameters.window_start); // 250 records: a hashed window inside the band
  const c1 = computeCore({ template_id: 'LS2-B2', parameters: b2[0]!.parameters, patient_id: PID }, ctx);
  assert.deepEqual([c1.answer_form, c1.answer, c1.unit, c1.depends_on.length, c1.provenance], ['value', '248', 'u', 125, ['Observation/o248']]);
  assert.equal(TEMPLATES.get('LS2-B2')!.text(b2[0]!.parameters, 'concept'), 'What is the highest Code result recorded for this patient? Give the value and the unit.');
  const cl = computeCore({ template_id: 'LS2-B2', parameters: b2[3]!.parameters, patient_id: PID }, ctx);
  assert.deepEqual([cl.answer, cl.value_as_recorded, cl.unit, cl.items.length], ['9.25', '9.25', 'USD', 15]);
  assert.equal(TEMPLATES.get('LS2-B2')!.text(b2[3]!.parameters, 'concept'), "What is the largest claim total among this patient's Claim records? Give the amount and the currency.");
  // Code d: 7 and 7.0 tie as decimals but differ as text, so B1 has no LS2 candidate for it.
  assert.ok(!TEMPLATES.get('LS2-B1')!.propose(ctx, 'synthea-dev', DEV_SEED_HEX).some(p => p.parameters.code === 'd'));
});

test('long-list window questions are excluded when a matching record lacks a full dateTime', () => {
  const ctx = ctxOf(claimsHourly(1200, i => (i === 7 ? '2020-01-01' : iso(T0 + i * HOUR))));
  assert.deepEqual(TEMPLATES.get('LS1-B3')!.propose(ctx, 'synthea-dev', DEV_SEED_HEX), []);
  assert.throws(() => computeCore({ template_id: 'LS1-B3', parameters: { resource_type: 'Claim', code_label: 'type', date_label: 'creation time', window_start: '2020-01-01T00:00:00Z', window_end: '2020-01-10T00:00:00Z' }, patient_id: PID }, ctx), /full dateTime/);
});

test('decimal stratum: value templates keep only lexeme-eligible gold; zero values form their own stratum', () => {
  const vital = (id: string, value: string, minute: number): Res => ({
    resourceType: 'Observation', id, status: 'final', subject: { reference: `Patient/${PID}` },
    category: [{ coding: [{ system: CS, code: 'vital-signs' }] }], code: { coding: [{ system: CS, code: `v${minute}`, display: 'Vital' }] },
    effectiveDateTime: iso(T0 + minute * 60_000), valueQuantity: { value, unit: 'u' },
  });
  const claim: Res = { resourceType: 'Claim', id: 'c1', patient: { reference: `Patient/${PID}` }, created: '2020-02-01T10:00:00Z',
    item: [
      { sequence: '1', productOrService: { coding: [{ system: CS, code: 's1', display: 'Service one' }] }, net: { value: '566.20', currency: 'USD' } },
      { sequence: '2', productOrService: { coding: [{ system: CS, code: 's2', display: 'Service two' }] }, net: { value: '12.5', currency: 'USD' } },
    ] };
  const ctx = ctxOf([vital('a', '7.0', 1), vital('b', '7.5', 2), vital('z', '0.0', 3), vital('e', '1E+2', 4), claim]);
  assert.deepEqual(TEMPLATES.get('L6')!.propose(ctx, 'synthea-dev').map(p => p.key).sort(), ['Observation/a', 'Observation/b', 'Observation/e', 'Observation/z']);
  const dec = TEMPLATES.get('DEC-L6')!.propose(ctx, 'synthea-dev');
  assert.deepEqual(dec.map(p => [p.key, p.stratum]).sort(), [['Observation/a', 'nonzero'], ['Observation/e', 'nonzero'], ['Observation/z', 'zero']]);
  for (const p of dec) assert.equal(p.dedupe, p.key);
  const g = computeCore({ template_id: 'DEC-L6', parameters: dec.find(p => p.key === 'Observation/a')!.parameters, patient_id: PID }, ctx);
  assert.equal(g.answer, '7');
  assert.equal(g.value_as_recorded, '7.0');
  assert.ok(lexemeEligible(g));
  assert.equal(TEMPLATES.get('DEC-L6')!.text, TEMPLATES.get('L6')!.text);

  const cl = TEMPLATES.get('DEC-CL1')!.propose(ctx, 'synthea-dev');
  assert.deepEqual(cl.map(p => p.key), ['Claim/c1#1']);
  assert.deepEqual(cl[0]!.operations, [{ op: 'read', type: 'Claim', id: 'c1' }]);
  const gl = computeCore({ template_id: 'DEC-CL1', parameters: cl[0]!.parameters, patient_id: PID }, ctx);
  assert.deepEqual([gl.answer, gl.value_as_recorded, gl.unit], ['566.2', '566.20', 'USD']);
  assert.ok(hasRule('DEC-F3') && hasRule('LS1-B3') && hasRule('LS2-B4') && hasRule('CL1') && !hasRule('LL1') && !hasRule('DEC-NOPE'));
});

test('float-change reasons and significant digits', () => {
  assert.equal(floatChangeReason('7.0'), 'trailing_fraction_zero');
  assert.equal(floatChangeReason('1E+2'), 'exponent');
  assert.equal(floatChangeReason('9007199254740993'), 'over_15_significant_digits');
  assert.equal(floatChangeReason('112.41600000000001'), null); // already the shortest double form
  assert.equal(floatChangeReason('7.5'), null);
  assert.equal(significantDigits('0.00120'), 2);
  assert.equal(significantDigits('-1.50e3'), 2);
});

test('strata selection: empty pools leave the split, allocation tables stay apart from the main set', () => {
  const prop = (key: string): Proposal => ({ key, dedupe: key, parameters: {}, operations: [] });
  const pools = new Map<string, Candidate[]>([['DEC-O4', Array.from({ length: 40 }, (_, i) => makeCandidate('saq', DEV_SEED_HEX, 'DEC-O4', `p${i % 8}`, prop(`k${i}`)))], ['DEC-F3', []]]);
  const { groups, dropped } = strataGroups(STRATA_GROUPS.decimal['synthea-dev'], pools);
  assert.deepEqual(groups[0]!.templates, ['DEC-O4']);
  assert.deepEqual(dropped, ['DEC-L1', 'DEC-L6', 'DEC-L8', 'DEC-L10', 'DEC-F1', 'DEC-F3', 'DEC-CL1']);
  assert.equal(select('synthea-dev', pools, groups).selected.length, 30);
  // With the default table, select() is unchanged.
  assert.deepEqual(select('synthea-dev', pools), select('synthea-dev', pools, GROUPS['synthea-dev']));
  for (const d of ['mimic', 'synthea-dev'] as const) {
    const base = new Set(GROUPS[d].flatMap(g => g.templates));
    for (const s of STRATA) for (const t of STRATA_GROUPS[s][d].flatMap(g => g.templates)) { assert.ok(!base.has(t), t); assert.ok(TEMPLATES.has(t), t); }
  }
  // Long lists: one group per band, the same two forms in every band.
  for (const d of ['mimic', 'synthea-dev'] as const) {
    assert.deepEqual(STRATA_GROUPS['long-list'][d].map(g => [g.count, g.templates]), BANDS.map(b => [b.count, [`LS2-${b.id}`, `LS1-${b.id}`]]));
  }
  assert.deepEqual(strataArg('long-list,decimal'), ['long-list', 'decimal']);
  assert.throws(() => strataArg('long-list,long-list'));
  assert.throws(() => strataArg('other'));
});

test('stratum output never lands on shared result files', () => {
  assert.ok(assertSafeOut('mimic', join(results.manifests, '..', 'strata-test', 'mimic')).endsWith('strata-test/mimic'));
  assert.throws(() => assertSafeOut('mimic', join(results.questions('mimic'), '..')));
  assert.throws(() => assertSafeOut('synthea-dev', join(results.gold('synthea-dev'), '..', 'sub')));
  assert.throws(() => assertSafeOut('mimic', results.manifests));
  assert.throws(() => assertSafeOut('mimic', goldPaths.dev('')));
  assert.throws(() => assertSafeOut('mimic', LOCAL));
  assert.throws(() => assertSafeOut('mimic', '/tmp/strata'));
});

// The shared main-set files other campaigns use were written by the generator before the strata existed. With the strata
// off, regeneration must reproduce them: questions and probes byte for byte, gold line for line (MIMIC gold was written
// in pool order with --pool, so lines are compared as a set).
for (const d of ['mimic', 'synthea-dev'] as DatasetId[]) {
  const ready = existsSync(d === 'mimic' ? MIMIC_FHIR_DIR : SYNTHEA_FHIR_DIR) && existsSync(results.questions(d)) && existsSync(goldPaths.probes(d)) && existsSync(results.gold(d, 'ts'));
  test(`${d}: main questions, probes and gold regenerate unchanged with the strata off`, { skip: !ready }, async () => {
    const g = await generate(d);
    const jsonl = (rs: readonly unknown[]) => rs.map(r => stringifyLossless(r) + '\n').join('');
    assert.equal(jsonl(g.questions), readFileSync(results.questions(d), 'utf8'), 'questions.jsonl differs');
    assert.equal(jsonl(g.probes), readFileSync(goldPaths.probes(d), 'utf8'), 'probes.jsonl differs');
    const fresh = new Set((await computeGold(d, g.questions)).gold.map(x => stringifyLossless(x)));
    const disk = readFileSync(results.gold(d, 'ts'), 'utf8').split('\n').filter(Boolean);
    assert.equal(disk.length, fresh.size);
    for (const line of disk) assert.ok(fresh.has(line), 'gold line differs');
    for (const q of g.questions) assert.ok(!q.template_id.startsWith('LL') && !q.template_id.startsWith('DEC-'));
  });
}
