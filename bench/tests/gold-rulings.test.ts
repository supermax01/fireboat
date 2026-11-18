// Gold rulings (bench/GOLD-RULINGS.md) in the TypeScript gold: G-R1, G-R2 and the per-template rulings. Synthetic records.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PatientData, SharedData } from '../gold/reader.js';
import { ANSWER_FROM_COPY, computeCore, Excluded, ruleId, type Ctx } from '../gold/rules.js';
import { TEMPLATES } from '../gold/templates.js';
import type { Res } from '../gold/fhir.js';

const PID = 'rule-patient';
const P = { reference: `Patient/${PID}` };
const CS = 'http://example.org/fhir/cs';
const MICRO = 'http://example.org/fhir/CodeSystem/microbiology';
const LAB_CAT = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }];

function ctxOf(records: Res[], shared: Res[] = []): Ctx {
  const data = new PatientData('mimic', PID, 'synthetic');
  data.add({ resourceType: 'Patient', id: PID });
  for (const r of records) data.add(r);
  const s = new SharedData();
  for (const r of shared) s.add(r);
  return { data, shared: s };
}
const gold = (template_id: string, parameters: Record<string, string>, ctx: Ctx) => computeCore({ template_id, parameters, patient_id: PID }, ctx);
const lab = (id: string, time: string, value: string, unit = 'mg/dL'): Res => ({
  resourceType: 'Observation', id, status: 'final', subject: P, category: LAB_CAT, code: { coding: [{ system: CS, code: 'a1', display: 'A1' }] },
  effectiveDateTime: time, valueQuantity: { value, unit },
});
const refs = (items: { ref: string }[]) => items.map(i => i.ref).sort();
const A1 = { code_system: CS, code: 'a1', display: 'A1' };

test('G-R2: a latest-instant tie with equal values makes every tied record an item', () => {
  const ctx = ctxOf([lab('o1', '2020-01-01T00:00:00Z', '5.0'), lab('o3', '2020-02-01T00:00:00Z', '7.0'), lab('o2', '2020-02-01T00:00:00+00:00', '7.0')]);
  const g = gold('L1', A1, ctx);
  assert.equal(g.answer, '7');
  assert.deepEqual(refs(g.items), ['Observation/o2', 'Observation/o3']);
  assert.deepEqual(g.provenance, ['Observation/o2', 'Observation/o3']);
  assert.deepEqual(g.depends_on, ['Observation/o1', 'Observation/o2', 'Observation/o3']);
  assert.equal(TEMPLATES.get('L1')!.propose(ctx, 'mimic').length, 1);
});

test('G-R2: a latest-instant tie with differing values excludes the candidate, so it is never selected', () => {
  const ctx = ctxOf([lab('o1', '2020-02-01T00:00:00Z', '7.0'), lab('o2', '2020-02-01T00:00:00Z', '7.5')]);
  assert.throws(() => gold('L1', A1, ctx), Excluded);
  assert.equal(TEMPLATES.get('L1')!.propose(ctx, 'mimic').length, 0);
  // Every "most recent" or "last" template uses the rule: E5 and I2 (date-time answers) list every tied record.
  const enc = (id: string, start: string): Res => ({ resourceType: 'Encounter', id, subject: P, type: [{ coding: [{ system: CS, code: 'chk', display: 'Check' }] }], period: { start } });
  const e = gold('E5', { code_system: CS, code: 'chk', display: 'Check' }, ctxOf([enc('e1', '2020-01-01T08:00:00Z'), enc('e2', '2020-01-01T08:00:00Z'), enc('e0', '2019-01-01T08:00:00Z')]));
  assert.equal(e.answer, '2020-01-01T08:00:00Z');
  assert.deepEqual(refs(e.items), ['Encounter/e1', 'Encounter/e2']);
});

test('G2 (G-R2): administrations tied at the last instant with equal doses are all items; differing doses exclude', () => {
  const ma = (id: string, time: string, dose: string): Res => ({
    resourceType: 'MedicationAdministration', id, status: 'completed', subject: P, effectiveDateTime: time,
    medicationCodeableConcept: { coding: [{ system: CS, code: 'd1', display: 'Drug 1' }] }, dosage: { dose: { value: dose, unit: 'mg' } },
  });
  const D1 = { code_system: CS, code: 'd1', display: 'Drug 1' };
  const g = gold('G2', D1, ctxOf([ma('m1', '2020-01-01T00:00:00Z', '1'), ma('m2', '2020-03-01T00:00:00Z', '2'), ma('m3', '2020-03-01T00:00:00Z', '2')]));
  assert.equal(g.answer, '2');
  assert.deepEqual(refs(g.items), ['MedicationAdministration/m2', 'MedicationAdministration/m3']);
  assert.throws(() => gold('G2', D1, ctxOf([ma('m2', '2020-03-01T00:00:00Z', '2'), ma('m3', '2020-03-01T00:00:00Z', '3')])), Excluded);
});

test('E1: the answer is the total; answer_list is the per-class breakdown', () => {
  const enc = (id: string, cls: string): Res => ({ resourceType: 'Encounter', id, subject: P, class: { code: cls }, period: { start: '2020-01-01T00:00:00Z' } });
  const g = gold('E1', {}, ctxOf([enc('e1', 'AMB'), enc('e2', 'AMB'), enc('e3', 'EMER')]));
  assert.equal(g.answer, '3');
  assert.deepEqual(g.answer_list, ['AMB: 2', 'EMER: 1']);
  assert.equal(g.answer_kind, 'list');
});

/** A specimen collected 2133-02-22 (UTC) with a chemistry result, a micro test, an organism and two susceptibilities. */
function micro(): { records: Res[] } {
  return { records: [
    { resourceType: 'Specimen', id: 's1', subject: P, type: { coding: [{ display: 'URINE' }] }, collection: { collectedDateTime: '2133-02-21T20:00:00-05:00' } },
    { ...lab('chem', '2133-02-22T01:00:00Z', '1.0'), specimen: { reference: 'Specimen/s1' } },
    { resourceType: 'Observation', id: 'test', subject: P, code: { coding: [{ system: `${MICRO}-test`, code: 't', display: 'Culture' }] }, specimen: { reference: 'Specimen/s1' }, effectiveDateTime: '2133-02-22T01:00:00Z' },
    { resourceType: 'Observation', id: 'org', subject: P, code: { coding: [{ system: `${MICRO}-organism`, code: 'o', display: 'E. COLI' }] }, derivedFrom: [{ reference: 'Observation/test' }], effectiveDateTime: '2133-02-23T00:00:00Z' },
    { resourceType: 'Observation', id: 'sr', subject: P, code: { coding: [{ system: `${MICRO}-antibiotic`, code: 'a', display: 'ABX-R' }] }, derivedFrom: [{ reference: 'Observation/org' }], valueCodeableConcept: { coding: [{ code: 'R' }] }, effectiveDateTime: '2133-02-24T00:00:00Z' },
    { resourceType: 'Observation', id: 'ss', subject: P, code: { coding: [{ system: `${MICRO}-antibiotic`, code: 'b', display: 'ABX-S' }] }, derivedFrom: [{ reference: 'Observation/org' }], valueCodeableConcept: { coding: [{ code: 'S' }] }, effectiveDateTime: '2133-02-24T00:00:00Z' },
  ] };
}

test('B1 (with G-R1): microbiology records the plan reaches; chemistry and susceptibilities stay out; "<organism> (<specimen type>)"', () => {
  const g = gold('B1', { date: '2133-02-22' }, ctxOf(micro().records));
  assert.deepEqual(g.answer_list, ['E. COLI (URINE)']);
  assert.deepEqual(g.depends_on, ['Observation/org', 'Observation/test', 'Specimen/s1']);
});

test('B2 (G-R1): the organism record is not fetched by the plan, so it stays out of depends_on', () => {
  const g = gold('B2', { record: 'Observation/org', display: 'E. COLI', date: '2133-02-23' }, ctxOf(micro().records));
  assert.deepEqual(g.answer_list, ['ABX-R']);
  assert.deepEqual(g.depends_on, ['Observation/sr', 'Observation/ss']);
});

test('E2: the items are the Locations; the Encounter stays in depends_on', () => {
  const enc: Res = { resourceType: 'Encounter', id: 'icu', subject: P, period: { start: '2020-01-01T00:00:00Z' },
    location: [{ location: { reference: 'Location/l1' }, period: { start: '2020-01-01T01:00:00Z' } }, { location: { reference: 'Location/l2' }, period: { start: '2020-01-02T01:00:00Z' } }] };
  const g = gold('E2', { encounter: 'Encounter/icu', encounter_start: '2020-01-01T00:00:00Z' },
    ctxOf([enc], [{ resourceType: 'Location', id: 'l1', name: 'MICU' }, { resourceType: 'Location', id: 'l2', name: 'SICU' }]));
  assert.deepEqual(g.answer_list, ['MICU', 'SICU']);
  // G-R3: a Location carries no time, so its item is untimed (the stay start lives on the Encounter in depends_on).
  assert.deepEqual(g.items.map(i => [i.ref, i.time, i.display]), [['Location/l1', null, 'MICU'], ['Location/l2', null, 'SICU']]);
  assert.deepEqual(g.depends_on, ['Encounter/icu', 'Location/l1', 'Location/l2']);
});

test('O2: the referenced Medication (and a mix\'s ingredients) is in depends_on; the route is answered as "route: <route>"', () => {
  const mr = (id: string, time: string): Res => ({ resourceType: 'MedicationRequest', id, status: 'completed', subject: P, authoredOn: time,
    medicationReference: { reference: 'Medication/mix' }, dosageInstruction: [{ route: { text: 'IV' }, doseAndRate: [{ doseQuantity: { value: '500', unit: 'mg' } }] }] });
  const shared: Res[] = [
    { resourceType: 'Medication', id: 'mix', ingredient: [{ itemReference: { reference: 'Medication/a' } }, { itemReference: { reference: 'Medication/b' } }] },
    { resourceType: 'Medication', id: 'a', code: { text: 'Drug A' } }, { resourceType: 'Medication', id: 'b', code: { text: 'Drug B' } },
  ];
  const g = gold('O2', { medication: 'Medication/mix', display: 'Drug A + Drug B' }, ctxOf([mr('r1', '2020-01-01T00:00:00Z'), mr('r2', '2020-02-01T00:00:00Z')], shared));
  assert.equal(g.answer, '500');
  assert.deepEqual(g.answer_list, ['route: IV']);
  assert.deepEqual(refs(g.items), ['MedicationRequest/r2']);
  assert.deepEqual(g.depends_on, ['Medication/a', 'Medication/b', 'Medication/mix', 'MedicationRequest/r1', 'MedicationRequest/r2']);
});

test('K1: depends_on is every CarePlan the search for active plans returns', () => {
  const plan = (id: string, status: string, cat: string): Res => ({ resourceType: 'CarePlan', id, status, subject: P, category: [{ text: cat }],
    period: { start: '2020-01-01T00:00:00Z' }, activity: [{ detail: { code: { text: `${cat} activity` } } }] });
  const g = gold('K1', { record: 'CarePlan/c1', display: 'Diet' }, ctxOf([plan('c1', 'active', 'Diet'), plan('c2', 'active', 'Exercise'), plan('c3', 'completed', 'Diet')]));
  assert.deepEqual(g.answer_list, ['Diet activity']);
  assert.deepEqual(g.depends_on, ['CarePlan/c1', 'CarePlan/c2']);
});

// ---- answer text in the gold record itself (scoring: run/score-lib.ts checkItem) --------------------------------

const b64 = (t: string) => Buffer.from(t, 'utf8').toString('base64');
const note = (id: string, date: string, text: string): Res => ({ resourceType: 'DocumentReference', id, status: 'current', subject: P, date,
  type: { text: 'Note' }, content: [{ attachment: { contentType: 'text/plain', data: b64(text) } }] });

test('N2: the gold answer list equals ANSWER_FROM_COPY.N2 on the latest note; none for a note that lists nothing', () => {
  const latest = note('d2', '2020-02-01T00:00:00Z', 'Note.\n\nPatient has a history of Hypertension, Asthma.\nPatient is presenting with Sprain of ankle.\n');
  const g = gold('N2', {}, ctxOf([note('d1', '2020-01-01T00:00:00Z', 'Patient has a history of Otitis media.\n'), latest]));
  assert.deepEqual(g.answer_list, ['Asthma', 'Hypertension', 'Sprain of ankle']);
  assert.deepEqual([...ANSWER_FROM_COPY.N2!(latest)!].sort(), g.answer_list);
  assert.deepEqual(refs(g.items), ['DocumentReference/d2']);
  const empty = note('d3', '2020-03-01T00:00:00Z', 'Note.\n\nNothing to report.\n');
  const n = gold('N2', {}, ctxOf([empty]));
  assert.equal(n.answer_list, null);
  assert.deepEqual(ANSWER_FROM_COPY.N2!(empty), []);
  // A copy without the note body yields null, never an empty list.
  assert.equal(ANSWER_FROM_COPY.N2!({ ...empty, content: [{ attachment: { contentType: 'text/plain' } }] }), null);
});

test('K2: the gold answer list equals ANSWER_FROM_COPY.K2 on the named CareTeam', () => {
  const team: Res = { resourceType: 'CareTeam', id: 'ct1', status: 'active', subject: P, period: { start: '2020-01-01T00:00:00Z' }, participant: [
    { role: [{ coding: [{ code: '116154003', display: 'Patient' }] }], member: { reference: `Patient/${PID}`, display: 'Ms. Synthetic Person' } },
    { role: [{ coding: [{ code: '223366009', display: 'Healthcare professional' }] }], member: { reference: 'Practitioner/pr1', display: 'Dr. Example Doctor' } },
    { member: { reference: 'Organization/org1' } },
  ] };
  const g = gold('K2', { record: 'CareTeam/ct1' }, ctxOf([team]));
  assert.deepEqual(g.answer_list, ['Dr. Example Doctor (Healthcare professional)', 'Ms. Synthetic Person (Patient)', 'Organization/org1 (no role)']);
  assert.deepEqual([...ANSWER_FROM_COPY.K2!(team)!].sort(), g.answer_list);
});

/**
 * Every template whose answer is not text in its own record, with the check that decides it (read from gold/rules.ts):
 * - value: the recorded value (and unit) is checked on the returned copy of each item;
 * - time: the answer is an item's own date-time, checked on the returned copy;
 * - count: the answer is the number of gold records, decided by identity and coverage of depends_on;
 * - records: the answer names the gold records themselves (one entry per record, from its code), decided by identity and coverage;
 * - record fields: the answer is read from a structured field of the item's record (E2 Location.name, E4 Encounter.reasonCode,
 *   K1 CarePlan activity codes, M1 ImagingStudy series modality and body site, M2 its series and instance arrays, D1 Patient
 *   birthDate, gender and deceased), not checked against the returned copy; each belongs in ANSWER_FROM_COPY if an arm
 *   withholds its field. Nothing detects that automatically: compare these fields across arms by hand for each new campaign or arm.
 * A new template must be put in ANSWER_FROM_COPY or here, with its reason.
 */
const DECIDED_WITHOUT_ANSWER_TEXT: Record<string, 'value' | 'time' | 'count' | 'records' | 'record fields'> = {
  L1: 'value', L2: 'value', L5: 'value', L6: 'value', L7: 'value', L8: 'value', L9: 'value', L10: 'value', G2: 'value', O2: 'value', O4: 'value',
  E3: 'time', F1: 'value', F3: 'value', CL1: 'value', LS2: 'value', B2: 'value',
  P2: 'time', E5: 'time', I2: 'time',
  L3: 'count', L4: 'count', G3: 'count', N1: 'count', I1: 'count', F2: 'count', C2: 'count', E1: 'count',
  G1: 'records', O3: 'records', O1: 'records', B1: 'records', C1: 'records', C3: 'records', P1: 'records', A1: 'records', V1: 'records', N3: 'records', LS1: 'records',
  E2: 'record fields', E4: 'record fields', K1: 'record fields', M1: 'record fields', M2: 'record fields', D1: 'record fields',
};

test('every template is either answered from its record\'s text (ANSWER_FROM_COPY) or listed with the check that decides it', () => {
  const rules = new Set([...TEMPLATES.keys()].map(ruleId));
  for (const id of rules) {
    const inCopy = id in ANSWER_FROM_COPY, listed = id in DECIDED_WITHOUT_ANSWER_TEXT;
    assert.ok(inCopy !== listed, `${id}: must be in exactly one of ANSWER_FROM_COPY and DECIDED_WITHOUT_ANSWER_TEXT`);
  }
  for (const id of [...Object.keys(ANSWER_FROM_COPY), ...Object.keys(DECIDED_WITHOUT_ANSWER_TEXT)]) assert.ok(rules.has(id), `${id}: no such template`);
  assert.deepEqual(Object.keys(ANSWER_FROM_COPY).sort(), ['K2', 'N2']);
});
