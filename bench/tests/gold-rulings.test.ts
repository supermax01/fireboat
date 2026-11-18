// Gold rulings (bench/GOLD-RULINGS.md) in the TypeScript gold: G-R1, G-R2 and the per-template rulings. Synthetic records.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PatientData, SharedData } from '../gold/reader.js';
import { ANSWER_ENTRIES, answerOptions, computeCore, Excluded, ruleId, type Ctx } from '../gold/rules.js';
import { uniqSorted, type Json } from '../gold/fhir.js';
import { TEMPLATES } from '../gold/templates.js';
import type { Res } from '../gold/fhir.js';

const PID = 'rule-patient';
const P = { reference: `Patient/${PID}` };
const CS = 'http://example.org/fhir/cs';
const MICRO = 'http://example.org/fhir/CodeSystem/microbiology';
const LAB_CAT = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }];

function ctxOf(records: Res[], shared: Res[] = [], patient: Res = { resourceType: 'Patient', id: PID }): Ctx {
  const data = new PatientData('mimic', PID, 'synthetic');
  data.add(patient);
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

/** The single entry list a copy yields when every record has one copy (raw records), or null when it yields none. */
function oneOption(...args: Parameters<typeof answerOptions>): string[] | null {
  const opts = answerOptions(...args);
  assert.ok(opts.length <= 1, `expected at most one entry list, got ${opts.length}`);
  return opts[0] ?? null;
}
const entries = (id: string, r: Res, ctx: Ctx = ctxOf([]), params: Record<string, string> = {}) => oneOption(ANSWER_ENTRIES[id]!, r, lookIn(ctx), params);

test('N2: the gold answer list equals the N2 answer entries of the latest note; none for a note that lists nothing', () => {
  const latest = note('d2', '2020-02-01T00:00:00Z', 'Note.\n\nPatient has a history of Hypertension, Asthma.\nPatient is presenting with Sprain of ankle.\n');
  const g = gold('N2', {}, ctxOf([note('d1', '2020-01-01T00:00:00Z', 'Patient has a history of Otitis media.\n'), latest]));
  assert.deepEqual(g.answer_list, ['Asthma', 'Hypertension', 'Sprain of ankle']);
  assert.deepEqual([...entries('N2', latest)!].sort(), g.answer_list);
  assert.deepEqual(refs(g.items), ['DocumentReference/d2']);
  const empty = note('d3', '2020-03-01T00:00:00Z', 'Note.\n\nNothing to report.\n');
  const n = gold('N2', {}, ctxOf([empty]));
  assert.equal(n.answer_list, null);
  assert.deepEqual(entries('N2', empty), []);
  // A copy without the note body yields null, never an empty list.
  assert.equal(entries('N2', { ...empty, content: [{ attachment: { contentType: 'text/plain' } }] }), null);
});

test('K2: the gold answer list equals the K2 answer entries of the named CareTeam', () => {
  const team: Res = { resourceType: 'CareTeam', id: 'ct1', status: 'active', subject: P, period: { start: '2020-01-01T00:00:00Z' }, participant: [
    { role: [{ coding: [{ code: '116154003', display: 'Patient' }] }], member: { reference: `Patient/${PID}`, display: 'Ms. Synthetic Person' } },
    { role: [{ coding: [{ code: '223366009', display: 'Healthcare professional' }] }], member: { reference: 'Practitioner/pr1', display: 'Dr. Example Doctor' } },
    { member: { reference: 'Organization/org1' } },
  ] };
  const g = gold('K2', { record: 'CareTeam/ct1' }, ctxOf([team]));
  assert.deepEqual(g.answer_list, ['Dr. Example Doctor (Healthcare professional)', 'Ms. Synthetic Person (Patient)', 'Organization/org1 (no role)']);
  assert.deepEqual([...entries('K2', team)!].sort(), g.answer_list);
});

// ---- answer entries read from records (ANSWER_ENTRIES): the gold rule's own extraction reproduces the gold -----------

/** Raw records by reference, as scoring looks up returned copies. */
const lookIn = (ctx: Ctx) => (ref: string): Res[] => { const r = ctx.data.byRef.get(ref) ?? ctx.shared.byRef.get(ref); return r ? [r] : []; };

/**
 * Applies a template's ANSWER_ENTRIES extraction to the raw record of every gold item and checks it reproduces the gold:
 * item scope, [item.display] per item and the union of displays equals answer_list; question scope, the answer list (E3:
 * the item's value); set scope, a subset per item whose union equals answer_list.
 */
function assertEntriesReproduceGold(id: string, params: Record<string, string>, ctx: Ctx): void {
  const g = gold(id, params, ctx);
  const entry = ANSWER_ENTRIES[ruleId(id)]!;
  const look = lookIn(ctx);
  const list = g.answer_list ?? [];
  assert.ok(g.items.length > 0, `${id}: the fixture must have gold items`);
  const union = new Set<string>();
  for (const it of g.items) {
    const [rec] = look(it.ref);
    assert.ok(rec, `${id}: ${it.ref} not in the fixture`);
    const got = oneOption(entry, rec, look, params);
    assert.ok(got !== null, `${id}: ${it.ref} yields no entries`);
    if (entry.parent) assert.ok(entry.parent.refs(g.provenance, params).some(p => look(p).some(c => entry.parent!.links(c, it.ref))), `${id}: no parent references ${it.ref}`);
    if (entry.value) assert.deepEqual(got, it.value === null ? [] : [it.value], `${id}: ${it.ref}`);
    else if (entry.scope === 'item') assert.deepEqual(got, it.display === null ? [] : [it.display], `${id}: ${it.ref}`);
    else if (entry.scope === 'question') assert.deepEqual(uniqSorted(got), uniqSorted(entry.value ? [it.value!] : list), `${id}: ${it.ref}`);
    else for (const x of got) assert.ok(list.includes(x), `${id}: ${x} is not in the answer list`);
    if (entry.scope !== 'question') for (const x of got) union.add(x);
  }
  if (entry.scope !== 'question' && !entry.value) assert.deepEqual(uniqSorted(listFromEntries(id, g.items.map(i => i.display), union)), uniqSorted(list), `${id}: union of the items' entries`);
}

/**
 * The answer list the item entries make: E1 counts its items' classes, O2 answers its item's route as "route: <route>",
 * and L9's answer is an explicit none (its entry is the name of the record that states the absence).
 */
function listFromEntries(id: string, displays: (string | null)[], union: Set<string>): string[] {
  if (id === 'L9') return [];
  if (id === 'E1') {
    const n = new Map<string, number>();
    for (const d of displays) n.set(d ?? 'none', (n.get(d ?? 'none') ?? 0) + 1);
    return [...n].map(([c, k]) => `${c}: ${k}`);
  }
  if (id === 'O2') return [...union].map(r => `route: ${r}`);
  return [...union];
}

const enc = (id: string, extra: Record<string, unknown> = {}): Res => ({ resourceType: 'Encounter', id, subject: P, period: { start: '2020-01-01T08:00:00Z' }, ...extra }) as Res;
const coded = (code: string, text?: string) => ({ coding: [{ system: CS, code, display: `${code} display` }], ...(text ? { text } : {}) });
const MED_SHARED: Res[] = [
  { resourceType: 'Medication', id: 'named', identifier: [{ system: 'http://example.org/fhir/mimic-medication-name', value: 'Named drug' }] },
  { resourceType: 'Medication', id: 'plain', code: { coding: [{ system: CS, code: 'p', display: 'Plain display' }], text: 'Plain text' } },
  { resourceType: 'Medication', id: 'mix', ingredient: [{ itemReference: { reference: 'Medication/a' } }, { itemReference: { reference: 'Medication/b' } }] },
  { resourceType: 'Medication', id: 'a', code: { text: 'Drug A' } }, { resourceType: 'Medication', id: 'b', code: { coding: [{ system: CS, code: 'b', display: 'Drug B' }] } },
];
const medRef = (id: string) => ({ medicationReference: { reference: `Medication/${id}` } });
const inline = { medicationCodeableConcept: { coding: [{ system: CS, code: 'i', display: 'Inline display' }], text: 'Inline drug' } };
const administrations = (encKey: 'context' | 'encounter'): Res[] => [
  enc('stay'),
  ...[medRef('named'), medRef('plain'), medRef('mix'), inline].map((m, i) => ({ resourceType: 'MedicationAdministration', id: `ma${i}`, status: 'completed', subject: P,
    [encKey]: { reference: 'Encounter/stay' }, effectiveDateTime: '2020-01-01T09:00:00Z', dosage: { dose: { value: '1', unit: 'mg' } }, ...m }) as Res),
];
const microDay = (): Res[] => [
  ...micro().records,
  // the organism also derives from a test on a specimen collected another day; the entry takes the on-date test's specimen
  { resourceType: 'Specimen', id: 's0', subject: P, type: { coding: [{ display: 'BLOOD' }] }, collection: { collectedDateTime: '2133-02-20T10:00:00Z' } },
  { resourceType: 'Observation', id: 'test0', subject: P, code: { coding: [{ system: `${MICRO}-test`, code: 't', display: 'Culture' }] }, specimen: { reference: 'Specimen/s0' }, effectiveDateTime: '2133-02-20T11:00:00Z' },
].map(r => (r.id === 'org' ? { ...r, derivedFrom: [{ reference: 'Observation/test0' }, { reference: 'Observation/test' }] } : r) as Res);

/** An Observation without valueQuantity, with other fields added. */
const unvalued = (r: Res, extra: Record<string, Json> = {}): Res => { const { valueQuantity: _v, ...rest } = r; return { ...rest, ...extra } as Res; };

/** One synthetic fixture per ANSWER_ENTRIES template: [template id, parameters, records]. */
const ENTRY_FIXTURES: Record<string, () => [string, Record<string, string>, Ctx]> = {
  C1: () => ['C1', { encounter: 'Encounter/stay' }, ctxOf([enc('stay'), ...['I10', 'E11', 'I10'].map((c, i) => ({ resourceType: 'Condition', id: `c${i}`, subject: P, encounter: { reference: 'Encounter/stay' }, code: coded(c) }) as Res)])],
  C3: () => ['C3', {}, ctxOf([{ resourceType: 'Condition', id: 'c1', subject: P, clinicalStatus: { coding: [{ code: 'active' }] }, code: coded('x', 'Asthma') },
    { resourceType: 'Condition', id: 'c2', subject: P, clinicalStatus: { coding: [{ code: 'active' }] }, code: coded('y') },
    { resourceType: 'Condition', id: 'c3', subject: P, clinicalStatus: { coding: [{ code: 'resolved' }] }, code: coded('z', 'Old') }])],
  P1: () => ['P1', { encounter: 'Encounter/stay' }, ctxOf([enc('stay'), { resourceType: 'Procedure', id: 'p1', subject: P, encounter: { reference: 'Encounter/stay' }, code: coded('pp', 'Biopsy'), performedDateTime: '2020-01-01T09:00:00Z' }])],
  A1: () => ['A1', {}, ctxOf([{ resourceType: 'AllergyIntolerance', id: 'al1', patient: P, code: coded('nuts', 'Tree nuts') }, { resourceType: 'AllergyIntolerance', id: 'al2', patient: P, code: coded('dust') }])],
  B2: () => ['B2', { record: 'Observation/org', display: 'E. COLI', date: '2133-02-23' }, ctxOf(micro().records)],
  N3: () => ['N3', { code_system: CS, code: 'LAB', display: 'Laboratory' }, ctxOf([
    { resourceType: 'DiagnosticReport', id: 'dr1', subject: P, category: [{ coding: [{ system: CS, code: 'LAB' }] }], effectiveDateTime: '2020-01-01T00:00:00Z', result: [{ reference: 'Observation/o1' }] },
    { resourceType: 'DiagnosticReport', id: 'dr2', subject: P, category: [{ coding: [{ system: CS, code: 'LAB' }] }], effectiveDateTime: '2020-02-01T00:00:00Z', result: [{ reference: 'Observation/o2' }, { reference: 'Observation/o3' }] },
    lab('o1', '2020-01-01T00:00:00Z', '1'), { ...lab('o2', '2020-02-01T00:00:00Z', '2'), code: coded('g', 'Glucose') }, { ...lab('o3', '2020-02-01T00:00:00Z', '3'), code: coded('k') }])],
  L9: () => ['L9', { record: 'Observation/v1' }, ctxOf([{ resourceType: 'Observation', id: 'v1', subject: P, code: coded('hr', 'Heart rate'), effectiveDateTime: '2020-01-01T00:00:00Z',
    dataAbsentReason: { coding: [{ code: 'not-performed' }] } }])],
  L2: () => ['L2', { ...A1, window_start: '2020-01-01T00:00:00Z', window_end: '2020-02-01T00:00:00Z' }, ctxOf([lab('w1', '2020-01-02T00:00:00Z', '5.0'),
    unvalued(lab('w2', '2020-01-03T00:00:00Z', '0'), { valueCodeableConcept: { coding: [{ system: CS, code: 'POS' }] } }),
    unvalued(lab('w3', '2020-01-04T00:00:00Z', '0')), lab('w4', '2020-03-01T00:00:00Z', '9')])],
  L5: () => ['L5', { ...A1, window_start: '2020-01-01T00:00:00Z', window_end: '2020-02-01T00:00:00Z' }, ctxOf([lab('w1', '2020-01-02T00:00:00Z', '5.0'),
    unvalued(lab('w2', '2020-01-03T00:00:00Z', '0'), { valueString: 'see note' })])],
  L7: () => ['L7', A1, ctxOf([unvalued(lab('t1', '2020-01-02T00:00:00Z', '0'), { valueCodeableConcept: { coding: [{ system: CS, code: 'NEG' }, { system: CS, code: 'x', display: 'Negative' }] } })])],
  F1: () => ['F1', { encounter: 'Encounter/e1', encounter_start: '2020-01-01T08:00:00Z' }, ctxOf([enc('e1'),
    { resourceType: 'Claim', id: 'cl1', patient: P, created: '2020-01-02T00:00:00Z', item: [{ encounter: [{ reference: 'Encounter/e1' }] }], total: { value: '100.50', currency: 'USD' } } as Res])],
  V1: () => ['V1', {}, ctxOf([{ resourceType: 'Device', id: 'v1', patient: P, type: coded('pm', 'Pacemaker') }, { resourceType: 'Device', id: 'v2', patient: P, type: coded('st') }])],
  E1: () => ['E1', {}, ctxOf([enc('e1', { class: { code: 'AMB' } }), enc('e2', { class: { code: 'AMB' } }), enc('e3', { class: { code: 'EMER' } })])],
  E2: () => ['E2', { encounter: 'Encounter/icu', encounter_start: '2020-01-01T00:00:00Z' }, ctxOf([enc('icu', { location: [{ location: { reference: 'Location/l1' } }, { location: { reference: 'Location/l2' } }] })],
    [{ resourceType: 'Location', id: 'l1', name: 'MICU' }, { resourceType: 'Location', id: 'l2', name: 'SICU' }])],
  O2: () => ['O2', { medication: 'Medication/mix', display: 'Drug A + Drug B' }, ctxOf([{ resourceType: 'MedicationRequest', id: 'r1', status: 'completed', subject: P, authoredOn: '2020-01-01T00:00:00Z',
    ...medRef('mix'), dosageInstruction: [{ route: { text: 'IV' }, doseAndRate: [{ doseQuantity: { value: '500', unit: 'mg' } }] }] } as Res], MED_SHARED)],
  O1: () => ['O1', { encounter: 'Encounter/stay', encounter_start: '2020-01-01T08:00:00Z' }, ctxOf([enc('stay'),
    ...[medRef('named'), medRef('plain'), medRef('mix'), inline].map((m, i) => ({ resourceType: 'MedicationRequest', id: `r${i}`, status: 'active', subject: P, encounter: { reference: 'Encounter/stay' }, authoredOn: '2020-01-01T09:00:00Z', ...m }) as Res)], MED_SHARED)],
  G1: () => ['G1', { encounter: 'Encounter/stay', encounter_start: '2020-01-01T08:00:00Z' }, ctxOf(administrations('context'), MED_SHARED)],
  O3: () => ['O3', { encounter: 'Encounter/stay', encounter_start: '2020-01-01T08:00:00Z' }, ctxOf(administrations('encounter'), MED_SHARED)],
  B1: () => ['B1', { date: '2133-02-22' }, ctxOf(microDay())],
  N2: () => ['N2', {}, ctxOf([note('d1', '2020-01-01T00:00:00Z', 'Patient has a history of Asthma, Hypertension.\nPatient is presenting with Sprain of ankle.\n')])],
  K2: () => ['K2', { record: 'CareTeam/ct1' }, ctxOf([{ resourceType: 'CareTeam', id: 'ct1', subject: P, period: { start: '2020-01-01T00:00:00Z' },
    participant: [{ role: [{ text: 'Doctor' }], member: { reference: 'Practitioner/p1', display: 'Dr. Example' } }] }])],
  E4: () => ['E4', { date: '2020-01-01' }, ctxOf([enc('e1', { reasonCode: [coded('r1', 'Chest pain'), coded('r2')] })])],
  K1: () => ['K1', { record: 'CarePlan/c1', display: 'Diet' }, ctxOf([{ resourceType: 'CarePlan', id: 'c1', status: 'active', subject: P, category: [{ text: 'Diet' }],
    period: { start: '2020-01-01T00:00:00Z' }, activity: [{ detail: { code: { text: 'Low salt' } } }, { detail: { code: coded('ex') } }] }])],
  M1: () => ['M1', {}, ctxOf([{ resourceType: 'ImagingStudy', id: 'i1', subject: P, started: '2020-01-01T00:00:00Z',
    series: [{ modality: { code: 'CT', display: 'Computed tomography' }, bodySite: { display: 'Chest' } }, { modality: { code: 'DX' } }] }])],
  M2: () => ['M2', { record: 'ImagingStudy/i1' }, ctxOf([{ resourceType: 'ImagingStudy', id: 'i1', subject: P, started: '2020-01-01T00:00:00Z', numberOfSeries: '2', numberOfInstances: '3',
    series: [{ instance: [{ uid: '1' }, { uid: '2' }] }, { instance: [{ uid: '3' }] }] }])],
  D1: () => ['D1', {}, ctxOf([], [], { resourceType: 'Patient', id: PID, birthDate: '1970-01-02', gender: 'female', deceasedDateTime: '2020-01-01T00:00:00Z' })],
  E3: () => ['E3', { encounter: 'Encounter/e1' }, ctxOf([enc('e1', { period: { start: '2020-01-01T08:00:00Z', end: '2020-01-02T09:30:00Z' } })])],
  LS1: () => ['LS1-B1', { resource_type: 'Condition' }, ctxOf([{ resourceType: 'Condition', id: 'c1', subject: P, code: { coding: [{ system: CS, code: 'a' }, { system: 'http://example.org/other', code: 'a2' }] } },
    { resourceType: 'Condition', id: 'c2', subject: P, code: { coding: [{ system: CS, code: 'b' }] } }, { resourceType: 'Condition', id: 'c3', subject: P, code: { text: 'uncoded' } }])],
};

test('ANSWER_ENTRIES: the gold rule\'s own extraction applied to the raw records reproduces every item display or answer list', () => {
  assert.deepEqual(Object.keys(ENTRY_FIXTURES).sort(), Object.keys(ANSWER_ENTRIES).sort());
  for (const make of Object.values(ENTRY_FIXTURES)) {
    const [id, params, ctx] = make();
    assertEntriesReproduceGold(id, params, ctx);
  }
});

test('ANSWER_ENTRIES drug names: a Medication by reference, a mix named by its ingredients, a MIMIC name identifier and an inline concept', () => {
  const [id, params, ctx] = ENTRY_FIXTURES.G1!();
  const g = gold(id, params, ctx);
  assert.deepEqual(g.answer_list, ['Drug A + Drug B', 'Inline drug', 'Named drug', 'Plain text']);
  // A Medication without a returned copy (here: absent from the lookup) gives null, not a partial name.
  const ma = ctx.data.byRef.get('MedicationAdministration/ma2')!;
  const without = (gone: string) => (ref: string) => (ref === gone ? [] : lookIn(ctx)(ref));
  assert.equal(oneOption(ANSWER_ENTRIES.G1!, ma, without('Medication/b'), params), null);
  assert.equal(oneOption(ANSWER_ENTRIES.G1!, ma, without('Medication/mix'), params), null);
  // A Medication whose copy keeps only the coding display is named by the display, which is not the gold's text.
  const plain = ctx.data.byRef.get('MedicationAdministration/ma1')!;
  const displayOnly = (ref: string) => (ref === 'Medication/plain' ? [{ resourceType: 'Medication', id: 'plain', code: { coding: [{ system: CS, code: 'p', display: 'Plain display' }] } } as Res] : lookIn(ctx)(ref));
  assert.deepEqual(oneOption(ANSWER_ENTRIES.G1!, plain, displayOnly, params), ['Plain display']);
});

test('ANSWER_ENTRIES B1: the organism entry uses the on-date test\'s specimen, and null when that test or specimen has no copy', () => {
  const [id, params, ctx] = ENTRY_FIXTURES.B1!();
  assert.deepEqual(gold(id, params, ctx).answer_list, ['E. COLI (URINE)']);
  const org = ctx.data.byRef.get('Observation/org')!;
  assert.deepEqual(entries('B1', org, ctx, params), ['E. COLI (URINE)']);
  for (const gone of ['Observation/test', 'Specimen/s1']) {
    assert.equal(oneOption(ANSWER_ENTRIES.B1!, org, ref => (ref === gone ? [] : lookIn(ctx)(ref)), params), null, gone);
  }
});

/**
 * Every template whose answer is not read from a record by ANSWER_ENTRIES, with the check that decides it (read from
 * gold/rules.ts):
 * - value: the recorded value (and unit) is checked on the returned copy of each item;
 * - time: the answer is an item's own date-time, checked on the returned copy;
 * - count: the answer is the number of gold records, decided by identity and coverage of depends_on.
 * A new template must be put in ANSWER_ENTRIES or here, with its reason.
 */
const DECIDED_BY_VALUE_TIME_COUNT: Record<string, 'value' | 'time' | 'count'> = {
  L1: 'value', L6: 'value', L8: 'value', L10: 'value', G2: 'value', O4: 'value', F3: 'value', CL1: 'value', LS2: 'value',
  P2: 'time', E5: 'time', I2: 'time',
  L3: 'count', L4: 'count', G3: 'count', N1: 'count', I1: 'count', F2: 'count', C2: 'count',
};

test('every template is either read from its record (ANSWER_ENTRIES) or decided by value, time or count', () => {
  const rules = new Set([...TEMPLATES.keys()].map(ruleId));
  for (const id of rules) {
    const inEntries = id in ANSWER_ENTRIES, listed = id in DECIDED_BY_VALUE_TIME_COUNT;
    assert.ok(inEntries !== listed, `${id}: must be in exactly one of ANSWER_ENTRIES and DECIDED_BY_VALUE_TIME_COUNT`);
  }
  for (const id of [...Object.keys(ANSWER_ENTRIES), ...Object.keys(DECIDED_BY_VALUE_TIME_COUNT)]) assert.ok(rules.has(id), `${id}: no such template`);
  assert.deepEqual(Object.keys(ANSWER_ENTRIES).sort(), ['A1', 'B1', 'B2', 'C1', 'C3', 'D1', 'E1', 'E2', 'E3', 'E4', 'F1', 'G1', 'K1', 'K2', 'L2', 'L5', 'L7', 'L9', 'LS1', 'M1', 'M2', 'N2', 'N3', 'O1', 'O2', 'O3', 'P1', 'V1']);
  assert.deepEqual(Object.fromEntries(Object.entries(ANSWER_ENTRIES).map(([k, v]) => [k, v.scope])), {
    C1: 'item', C3: 'item', P1: 'item', A1: 'item', B2: 'item', N3: 'item', V1: 'item', E1: 'item', E2: 'item', O2: 'item', O1: 'item', G1: 'item', O3: 'item', B1: 'item', L9: 'item', L2: 'item', L5: 'item', L7: 'item', F1: 'item',
    N2: 'question', K2: 'question', E4: 'question', K1: 'question', M1: 'question', M2: 'question', D1: 'question', E3: 'question', LS1: 'set',
  });
});

test('ANSWER_ENTRIES L9: a copy passes only while it states the absence and carries no value', () => {
  const [, params, ctx] = ENTRY_FIXTURES.L9!();
  const r = ctx.data.byRef.get('Observation/v1')!;
  assert.deepEqual(entries('L9', r, ctx, params), ['Heart rate']);
  const { dataAbsentReason: _d, ...stripped } = r;
  assert.equal(entries('L9', stripped as Res, ctx, params), null);
  assert.equal(entries('L9', { ...r, valueQuantity: { value: '60', unit: '/min' } }, ctx, params), null);
});

test('compact copies: a CodeableConcept given as a string is its name, a Coding given as a string is the field the gold reads, a Reference given as a string is its reference', () => {
  const look = (rs: Res[]) => (ref: string) => rs.filter(r => `${r.resourceType}/${r.id}` === ref);
  const med = { resourceType: 'Medication', id: 'm1', code: { text: 'Drug X' } } as Res;
  // Reference as a string
  assert.deepEqual(oneOption(ANSWER_ENTRIES.G1!, { resourceType: 'MedicationAdministration', id: 'a', medicationReference: 'Medication/m1' } as Res, look([med]), {}), ['Drug X']);
  assert.deepEqual(oneOption(ANSWER_ENTRIES.K2!, { resourceType: 'CareTeam', id: 't', participant: [{ member: 'Practitioner/p1', role: 'Doctor' }] } as Res, look([]), {}), ['Practitioner/p1 (Doctor)']);
  // CodeableConcept as a string
  assert.deepEqual(oneOption(ANSWER_ENTRIES.C3!, { resourceType: 'Condition', id: 'c', code: 'Asthma' } as Res, look([]), {}), ['Asthma']);
  assert.deepEqual(oneOption(ANSWER_ENTRIES.O3!, { resourceType: 'MedicationAdministration', id: 'a', medicationCodeableConcept: 'Inline drug' } as Res, look([]), {}), ['Inline drug']);
  assert.deepEqual(oneOption(ANSWER_ENTRIES.E4!, { resourceType: 'Encounter', id: 'e', reasonCode: ['Chest pain'] } as Res, look([]), {}), ['Chest pain']);
  assert.deepEqual(oneOption(ANSWER_ENTRIES.O2!, { resourceType: 'MedicationRequest', id: 'r', dosageInstruction: [{ route: 'IV' }] } as Res, look([]), {}), ['IV']);
  // Coding as a string
  assert.deepEqual(oneOption(ANSWER_ENTRIES.E1!, { resourceType: 'Encounter', id: 'e', class: 'AMB' } as Res, look([]), {}), ['AMB']);
  assert.deepEqual(oneOption(ANSWER_ENTRIES.M1!, { resourceType: 'ImagingStudy', id: 'i', series: [{ modality: 'CT', bodySite: 'Chest' }] } as Res, look([]), {}), ['CT | Chest']);
});

test('answerOptions: every returned copy of a referenced record is tried; a thin copy first and a full one later passes', () => {
  const ma = { resourceType: 'MedicationAdministration', id: 'a', medicationReference: { reference: 'Medication/mix' } } as Res;
  const mix = { resourceType: 'Medication', id: 'mix', ingredient: [{ itemReference: { reference: 'Medication/a' } }, { itemReference: { reference: 'Medication/b' } }] } as Res;
  const thin = (id: string) => ({ resourceType: 'Medication', id }) as Res;
  const named = (id: string, text: string) => ({ resourceType: 'Medication', id, code: { text } }) as Res;
  const copies: Record<string, Res[]> = { 'Medication/mix': [thin('mix'), mix], 'Medication/a': [thin('a'), named('a', 'Drug A')], 'Medication/b': [named('b', 'Drug B'), thin('b')] };
  assert.deepEqual(answerOptions(ANSWER_ENTRIES.G1!, ma, ref => copies[ref] ?? [], {}), [['Drug A + Drug B']]);
  // no full copy of ingredient a: nothing yields the name
  assert.deepEqual(answerOptions(ANSWER_ENTRIES.G1!, ma, ref => (ref === 'Medication/a' ? [thin('a'), thin('a')] : copies[ref] ?? []), {}), []);
  // two differing full copies give two candidate names
  assert.deepEqual(answerOptions(ANSWER_ENTRIES.G1!, ma, ref => (ref === 'Medication/a' ? [named('a', 'Drug A'), named('a', 'Drug A2')] : copies[ref] ?? []), {}).map(x => x[0]).sort(),
    ['Drug A + Drug B', 'Drug A2 + Drug B']);
});

test('answerOptions: a date the gold reader would not parse fails the item instead of throwing (B1 collection time, E3 period)', () => {
  const [, params, ctx] = ENTRY_FIXTURES.B1!();
  const org = ctx.data.byRef.get('Observation/org')!;
  const s1 = ctx.data.byRef.get('Specimen/s1')!;
  for (const bad of ['2133-02-22T01:00:00', 'yesterday']) {
    const look = (ref: string) => (ref === 'Specimen/s1' ? [{ ...s1, collection: { collectedDateTime: bad } } as Res] : lookIn(ctx)(ref));
    assert.deepEqual(answerOptions(ANSWER_ENTRIES.B1!, org, look, params), [], bad);
    // a later full copy of the Specimen still passes
    const both = (ref: string) => (ref === 'Specimen/s1' ? [{ ...s1, collection: { collectedDateTime: bad } } as Res, s1] : lookIn(ctx)(ref));
    assert.deepEqual(answerOptions(ANSWER_ENTRIES.B1!, org, both, params), [['E. COLI (URINE)']], bad);
  }
  for (const period of [{ start: '2020-01-01T08:00:00', end: '2020-01-02T09:30:00Z' }, { start: '2020-01-01T08:00:00Z', end: 'later' }]) {
    assert.deepEqual(answerOptions(ANSWER_ENTRIES.E3!, { resourceType: 'Encounter', id: 'e1', period } as Res, () => [], {}), []);
  }
});

test('ANSWER_ENTRIES value entries: L7 reads the value text as gold does (a coding\'s code when nothing else names it); L2 and F1 copies of unvalued records must carry no value', () => {
  const [, p7, c7] = ENTRY_FIXTURES.L7!();
  assert.deepEqual(gold('L7', p7, c7).answer, 'NEG');
  const t1 = c7.data.byRef.get('Observation/t1')!;
  assert.deepEqual(entries('L7', t1, c7, p7), ['NEG']);
  assert.deepEqual(entries('L7', { ...t1, valueCodeableConcept: { text: 'Positive', coding: [{ code: 'NEG' }] } } as Res, c7, p7), ['Positive']);
  const [, p2, c2] = ENTRY_FIXTURES.L2!();
  const w3 = c2.data.byRef.get('Observation/w3')!;
  assert.deepEqual(entries('L2', w3, c2, p2), []);
  assert.deepEqual(entries('L2', { ...w3, valueQuantity: { value: '1', unit: 'mg/dL' } } as Res, c2, p2), ['1']);
  const noTotal = { resourceType: 'Claim', id: 'cl2', patient: P, created: '2020-01-02T00:00:00Z', item: [{ encounter: [{ reference: 'Encounter/e2' }] }], total: { currency: 'USD' } } as Res;
  const g = gold('F1', { encounter: 'Encounter/e2', encounter_start: '2020-01-01T08:00:00Z' }, ctxOf([enc('e2'), noTotal]));
  assert.equal(g.answer_kind, 'none');
  assert.deepEqual(entries('F1', noTotal), []);
  assert.deepEqual(entries('F1', { ...noTotal, total: { value: '5', currency: 'USD' } } as Res), ['5']);
});

test('ANSWER_ENTRIES L9: an empty or null dataAbsentReason on a copy is not an absence', () => {
  const [, params, ctx] = ENTRY_FIXTURES.L9!();
  const r = ctx.data.byRef.get('Observation/v1')!;
  assert.equal(entries('L9', { ...r, dataAbsentReason: {} } as Res, ctx, params), null);
  assert.equal(entries('L9', { ...r, dataAbsentReason: null } as Res, ctx, params), null);
  assert.deepEqual(entries('L9', { ...r, dataAbsentReason: { text: 'asked, declined' } } as Res, ctx, params), ['Heart rate']);
  // a reason that carries only extensions is present and not empty, as the gold rule accepts it on the raw record
  const extOnly = { ...r, dataAbsentReason: { extension: [{ url: 'http://example.org/ext', valueString: 'x' }] } } as Res;
  assert.deepEqual(gold('L9', params, ctxOf([extOnly])).items.map(i => i.display), ['Heart rate']);
  assert.deepEqual(entries('L9', extOnly, ctx, params), ['Heart rate']);
  assert.deepEqual(entries('L9', { ...r, dataAbsentReason: 'not performed' } as Res, ctx, params), ['Heart rate']);
  assert.equal(entries('L9', { ...r, dataAbsentReason: '' } as Res, ctx, params), null);
});

test('compact copies: a valueCodeableConcept written as a plain string is its name (L7 and coded L2/L5 items)', () => {
  const [, p7, c7] = ENTRY_FIXTURES.L7!();
  const t1 = c7.data.byRef.get('Observation/t1')!;
  assert.deepEqual(entries('L7', { ...t1, valueCodeableConcept: 'NEG' } as Res, c7, p7), ['NEG']);
  assert.deepEqual(entries('L7', { ...t1, valueCodeableConcept: 'POS' } as Res, c7, p7), ['POS']);
  const [, p2, c2] = ENTRY_FIXTURES.L2!();
  const w2 = c2.data.byRef.get('Observation/w2')!;
  assert.deepEqual(entries('L2', w2, c2, p2), ['POS']);
  assert.deepEqual(entries('L2', { ...w2, valueCodeableConcept: 'POS' } as Res, c2, p2), ['POS']);
});

test('compact copies: a concept wrapped in a list is its first element; a Coding string passes where it equals what the gold reads', () => {
  const look = () => [];
  assert.deepEqual(oneOption(ANSWER_ENTRIES.V1!, { resourceType: 'Device', id: 'v', type: ['Pacemaker'] } as Res, look, {}), ['Pacemaker']);
  assert.deepEqual(oneOption(ANSWER_ENTRIES.V1!, { resourceType: 'Device', id: 'v', type: [{ text: 'Pacemaker' }] } as Res, look, {}), ['Pacemaker']);
  // G8 stays the reading: text, else the first coding's display, else its code (an empty text is no text)
  assert.deepEqual(oneOption(ANSWER_ENTRIES.C3!, { resourceType: 'Condition', id: 'c', code: { text: '', coding: [{ code: 'x' }, { display: 'Second' }] } } as Res, look, {}), ['x']);
});
