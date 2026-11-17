// Question template table: groups, counts, categories, candidate proposals, question texts and scripted plans
// (abstract operations, lib/types.ts). Code systems come from the data at run time; none is written here literally
// except LOINC and the MIMIC heart-rate item, which the templates name.
import type { AbstractOp, AnswerForm, Category, DatasetId, SearchParams } from '../lib/types.js';
import { byFamily, type DatasetFamily } from '../lib/paths.js';
import { codings, compareInstant, get, get1, getStr, isObj, refOf, str, utcDate, type Res } from './fhir.js';
import {
  BP_PANEL, LOINC, ccName, computeCore, dayBounds, drugDepends, drugName, encStart, encounterOf, encountersOn, isIcuEncounter, isLab,
  isMicroOrg, isMicroSusc, isMicroTest, isSurvey, isVital, medicationRefs, obsTime, obsValue,
  procTime, quantityInfo, refStr, Excluded, type Ctx, DEC_PREFIX, lexemeEligible, type GoldCore,
} from './rules.js';
import { BANDS, LL_TYPES, bandTarget, llDate, llWindow, tokenCodings, type Band, type LLToken, type LLType } from './longlist.js';

export interface Proposal {
  key: string; // candidate key without the patient prefix
  dedupe: string; // key of the "(patient, template, code)" constraint: one question per key
  parameters: Record<string, string>;
  operations: AbstractOp[];
  stratum?: string; // C2: "yes" | "no"
}

export interface TemplateSpec {
  id: string;
  category: Category;
  encounterScoped: boolean;
  answerForm: AnswerForm;
  phrasable: boolean; // the text names a coded concept, so half the instances add system and code
  propose: (ctx: Ctx, dataset: DatasetId, seedHex?: string) => Proposal[]; // seedHex: stratum templates that draw by hash
  text: (p: Record<string, string>, phrasing: 'concept' | 'code') => string;
}

export interface GroupSpec { name: string; count: number; templates: string[] }

/** Allocation tables (questions per group), in table order. One per family: the holdout uses the Synthea table. */
export const GROUPS: Readonly<Record<DatasetId, GroupSpec[]>> = byFamily<GroupSpec[]>({
  mimic: [
    { name: 'Labs and vitals', count: 75, templates: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'] },
    { name: 'Medications given', count: 15, templates: ['G1', 'G2', 'G3'] },
    { name: 'Medications ordered', count: 11, templates: ['O1', 'O2'] },
    { name: 'Microbiology', count: 10, templates: ['B1', 'B2'] },
    { name: 'Diagnoses', count: 10, templates: ['C1', 'C2'] },
    { name: 'Procedures', count: 10, templates: ['P1', 'P2'] },
    { name: 'Stays', count: 10, templates: ['E1', 'E2', 'E3'] },
    { name: 'Demographics', count: 9, templates: ['D1'] },
  ],
  synthea: [
    { name: 'Observations', count: 33, templates: ['L1', 'L2', 'L3', 'L5', 'L6', 'L8', 'L10'] },
    { name: 'Claims and benefits', count: 24, templates: ['F1', 'F2', 'F3'] },
    { name: 'Reports and notes', count: 19, templates: ['N1', 'N2', 'N3'] },
    { name: 'Medications', count: 14, templates: ['O1', 'O3', 'O4'] },
    { name: 'Encounters', count: 12, templates: ['E1', 'E4', 'E5'] },
    { name: 'Procedures', count: 9, templates: ['P1', 'P2'] },
    { name: 'Conditions', count: 7, templates: ['C3', 'C2'] },
    { name: 'Immunizations and allergies', count: 7, templates: ['I1', 'I2', 'A1'] },
    { name: 'Care plans and teams', count: 7, templates: ['K1', 'K2'] },
    { name: 'Imaging', count: 6, templates: ['M1', 'M2'] },
    { name: 'Devices', count: 6, templates: ['V1'] },
    { name: 'Demographics', count: 6, templates: ['D1'] },
  ],
});

export const MAX_PER_PATIENT = 6;
export const DRAIN_CAP = 20;
/** Plans that read referenced records one by one stay within the run cap of 40 calls (run/execute.ts RUN_CAP). */
export const MAX_READS = 30;

// ---- Plan helpers ---------------------------------------------------------------------------------------------

const pat = (ctx: Ctx): [string, string] => ['patient', `Patient/${ctx.data.patientId}`];
const drain = (type: string, params: SearchParams): AbstractOp => ({ op: 'drain', type, params, call_cap: DRAIN_CAP });
const read = (ref: string): AbstractOp => { const [type, id] = ref.split('/'); return { op: 'read', type: type!, id: id! }; };
const tok = (p: Record<string, string>) => `${p.code_system}|${p.code}`;
/** Shared Medication records a drug name depends on, fetched in one search by id (they belong to no patient). */
const medsOp = (refs: string[]): AbstractOp[] => {
  const ids = [...new Set(refs)].map(r => r.split('/')[1]!).sort();
  return ids.length ? [drain('Medication', [['_id', ids.join(',')]])] : [];
};

/** First coding with system and code: the concept a template names. */
function concept(cc: unknown): { code_system: string; code: string; display: string } | null {
  const c = codings(cc).find(x => x.system && x.code);
  if (!c) return null;
  return { code_system: c.system!, code: c.code!, display: (isObj(cc) ? str(cc.text) : null) ?? c.display ?? c.code! };
}

function byConcept(records: Res[], field: string): Map<string, { c: { code_system: string; code: string; display: string }; records: Res[] }> {
  const out = new Map<string, { c: { code_system: string; code: string; display: string }; records: Res[] }>();
  for (const r of records) {
    const c = concept(get1(r, field));
    if (!c) continue;
    const k = `${c.code_system}|${c.code}`;
    const e = out.get(k);
    if (e) e.records.push(r); else out.set(k, { c, records: [r] });
  }
  return out;
}

const name = (p: Record<string, string>, phrasing: 'concept' | 'code') =>
  phrasing === 'code' && p.code ? `${p.display} (code ${p.code} in code system ${p.code_system})` : p.display!;

const safe = <T>(f: () => T): T | null => { try { return f(); } catch (e) { if (e instanceof Excluded) return null; throw e; } };

/** Keeps a proposal only if its gold computes under the template's own rules. */
function valid(ctx: Ctx, id: string, prop: Proposal): boolean {
  try { computeCore({ template_id: id, parameters: prop.parameters, patient_id: ctx.data.patientId }, ctx); return true; }
  catch (e) { if (e instanceof Excluded) return false; throw e; }
}

const monthStart = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const nextMonth = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };
const zulu = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const dateParams = (name: string, a: string, b: string): SearchParams => [[name, `ge${a}`], [name, `lt${b}`]];

function labCodes(ctx: Ctx, pred: (r: Res) => boolean) {
  return byConcept(ctx.data.of('Observation').filter(pred), 'code');
}

function codeProposals(ctx: Ctx, id: string, type: string, records: Res[], field: string, param: string, min = 1): Proposal[] {
  const out: Proposal[] = [];
  for (const [k, { c, records: recs }] of byConcept(records, field)) {
    if (recs.length < min) continue;
    const prop = { key: k, dedupe: k, parameters: { ...c }, operations: [drain(type, [pat(ctx), [param, k]])] };
    if (valid(ctx, id, prop)) out.push(prop);
  }
  return out;
}

const sortedByTime = (recs: Res[]) => [...recs].sort((a, b) => compareInstant(obsTime(a)!, obsTime(b)!) || (a.id < b.id ? -1 : 1));

/** L2: the UTC month holding the median record (lower middle), or its UTC day when the month holds more than 50. */
function l2Window(recs: Res[]): [string, string] {
  const s = sortedByTime(recs.filter(r => obsTime(r)));
  const med = s[Math.floor((s.length - 1) / 2)]!;
  const t = new Date(obsTime(med)!).getTime();
  const a = monthStart(t), b = nextMonth(t);
  const inMonth = s.filter(r => { const x = new Date(obsTime(r)!).getTime(); return x >= a && x < b; }).length;
  if (inMonth <= 50) return [zulu(a), zulu(b)];
  return dayBounds(utcDate(obsTime(med)!));
}

/** L5: whole UTC months from the first record's month until the window holds at least 51 records; at most 300. */
function l5Window(recs: Res[]): [string, string] | null {
  const times = sortedByTime(recs.filter(r => obsTime(r))).map(r => new Date(obsTime(r)!).getTime());
  if (times.length < 51) return null;
  const a = monthStart(times[0]!);
  let b = nextMonth(times[0]!);
  for (;;) {
    const n = times.filter(x => x >= a && x < b).length;
    if (n >= 51) return n <= 300 ? [zulu(a), zulu(b)] : null;
    b = nextMonth(b);
  }
}

function uniqueRecords(recs: Res[], key: (r: Res) => string | null): Res[] {
  const seen = new Map<string, number>();
  for (const r of recs) { const k = key(r); if (k) seen.set(k, (seen.get(k) ?? 0) + 1); }
  return recs.filter(r => { const k = key(r); return k !== null && seen.get(k) === 1; });
}

function encounterProposals(ctx: Ctx, id: string, type: string, param: string, recs: Res[], medRefs: (encRecs: Res[]) => string[] = () => []): Proposal[] {
  const byEnc = new Map<string, Res[]>();
  for (const r of recs) { const e = encounterOf(r); if (e) byEnc.set(e, [...(byEnc.get(e) ?? []), r]); }
  const out: Proposal[] = [];
  for (const [enc, encRecs] of byEnc) {
    const e = ctx.data.byRef.get(enc);
    if (!e || !encStart(e)) continue;
    const prop = { key: enc, dedupe: enc, parameters: { encounter: enc, encounter_start: encStart(e)! },
      operations: [drain(type, [pat(ctx), [param, enc]]), ...medsOp(medRefs(encRecs))] };
    if (valid(ctx, id, prop)) out.push(prop);
  }
  return out;
}

const single = (ctx: Ctx, id: string, operations: AbstractOp[], parameters: Record<string, string> = {}): Proposal[] => {
  const prop = { key: 'patient', dedupe: 'patient', parameters, operations };
  return valid(ctx, id, prop) ? [prop] : [];
};

// ---- Templates ------------------------------------------------------------------------------------------------

const T: TemplateSpec[] = [
  { id: 'L1', category: 'T', encounterScoped: false, answerForm: 'value', phrasable: true,
    propose: ctx => codeProposals(ctx, 'L1', 'Observation', ctx.data.of('Observation').filter(isLab), 'code', 'code'),
    text: (p, ph) => `What is the most recent ${name(p, ph)} result for this patient? Give the value, the unit and the time it was taken.` },
  { id: 'L2', category: 'T', encounterScoped: false, answerForm: 'list', phrasable: true,
    propose: ctx => [...labCodes(ctx, isLab)].flatMap(([k, { c, records }]) => {
      const [a, b] = l2Window(records);
      const prop = { key: k, dedupe: k, parameters: { ...c, window_start: a, window_end: b },
        operations: [drain('Observation', [pat(ctx), ['code', k], ...dateParams('date', a, b)])] };
      return valid(ctx, 'L2', prop) ? [prop] : [];
    }),
    text: (p, ph) => `List every ${name(p, ph)} result for this patient taken from ${p.window_start} (inclusive) to ${p.window_end} (exclusive), with value, unit and time.` },
  { id: 'L3', category: 'C', encounterScoped: false, answerForm: 'count', phrasable: true,
    propose: ctx => codeProposals(ctx, 'L3', 'Observation', ctx.data.of('Observation').filter(isLab), 'code', 'code'),
    text: (p, ph) => `How many ${name(p, ph)} results does this patient have in total?` },
  { id: 'L4', category: 'C', encounterScoped: true, answerForm: 'count', phrasable: true,
    propose: ctx => {
      const hr = ctx.data.of('Observation').map(o => codings(o.code).find(c => c.code === '220045' && (c.system ?? '').endsWith('chartevents-d-items'))).find(Boolean);
      if (!hr) return [];
      return ctx.data.of('Encounter').filter(isIcuEncounter).flatMap(e => {
        const enc = refOf(e);
        const prop = { key: enc, dedupe: hr.code!, parameters: { code_system: hr.system!, code: hr.code!, display: hr.display ?? 'Heart Rate', encounter: enc, encounter_start: encStart(e)! },
          operations: [drain('Observation', [pat(ctx), ['code', `${hr.system}|${hr.code}`], ['encounter', enc]])] };
        return valid(ctx, 'L4', prop) ? [prop] : [];
      });
    },
    text: (p, ph) => `How many ${name(p, ph)} measurements were recorded during this patient's ICU stay that began at ${p.encounter_start}?` },
  { id: 'L5', category: 'C', encounterScoped: false, answerForm: 'list', phrasable: true,
    propose: ctx => [...labCodes(ctx, isLab)].flatMap(([k, { c, records }]) => {
      const w = l5Window(records);
      if (!w) return [];
      const prop = { key: k, dedupe: k, parameters: { ...c, window_start: w[0], window_end: w[1] },
        operations: [drain('Observation', [pat(ctx), ['code', k], ...dateParams('date', w[0], w[1])])] };
      return valid(ctx, 'L5', prop) ? [prop] : [];
    }),
    text: (p, ph) => `List every ${name(p, ph)} result for this patient taken from ${p.window_start} (inclusive) to ${p.window_end} (exclusive), with value, unit and time.` },
  { id: 'L6', category: 'V', encounterScoped: false, answerForm: 'value', phrasable: true,
    propose: ctx => {
      const recs = ctx.data.of('Observation').filter(o => (isLab(o) || isVital(o)) && obsValue(o).kind === 'quantity' && concept(o.code) && obsTime(o));
      return uniqueRecords(recs, o => `${tokOf(o)} ${obsTime(o)}`).flatMap(o => {
        const c = concept(o.code)!;
        const prop = { key: refOf(o), dedupe: `${c.code_system}|${c.code}`, parameters: { ...c, record: refOf(o), record_time: obsTime(o)! }, operations: [read(refOf(o))] };
        return valid(ctx, 'L6', prop) ? [prop] : [];
      });
    },
    text: (p, ph) => `What was this patient's ${name(p, ph)} result recorded at ${p.record_time}? Give the value and the unit exactly as the record states them.` },
  { id: 'L7', category: 'R', encounterScoped: false, answerForm: 'value', phrasable: true,
    propose: ctx => codeProposals(ctx, 'L7', 'Observation', ctx.data.of('Observation').filter(isLab), 'code', 'code'),
    text: (p, ph) => `What was the most recent result of the ${name(p, ph)} test for this patient?` },
  { id: 'L8', category: 'T', encounterScoped: false, answerForm: 'value', phrasable: true,
    propose: ctx => {
      const panel = ctx.data.of('Observation').map(o => codings(o.code).find(c => c.system === LOINC && c.code === BP_PANEL)).find(Boolean);
      if (!panel) return [];
      const p = { code_system: LOINC, code: BP_PANEL, display: panel.display ?? 'Blood pressure panel' };
      return single(ctx, 'L8', [drain('Observation', [pat(ctx), ['code', tok(p)]])], p).map(x => ({ ...x, key: `${LOINC}|${BP_PANEL}`, dedupe: BP_PANEL }));
    },
    text: (p, ph) => `What was this patient's most recent blood pressure, systolic and diastolic, from a ${name(p, ph)} record?` },
  { id: 'L9', category: 'R', encounterScoped: false, answerForm: 'value', phrasable: true,
    propose: ctx => {
      const obs = ctx.data.of('Observation').filter(o => concept(o.code) && obsTime(o));
      const counts = new Map<string, number>();
      for (const o of obs) counts.set(`${tokOf(o)} ${obsTime(o)}`, (counts.get(`${tokOf(o)} ${obsTime(o)}`) ?? 0) + 1);
      return obs.filter(o => o.dataAbsentReason !== undefined && counts.get(`${tokOf(o)} ${obsTime(o)}`) === 1).flatMap(o => {
        const c = concept(o.code)!;
        const prop = { key: refOf(o), dedupe: `${c.code_system}|${c.code}`, parameters: { ...c, record: refOf(o), record_time: obsTime(o)! }, operations: [read(refOf(o))] };
        return valid(ctx, 'L9', prop) ? [prop] : [];
      });
    },
    text: (p, ph) => `What was this patient's ${name(p, ph)} recorded at ${p.record_time}?` },
  { id: 'L10', category: 'T', encounterScoped: false, answerForm: 'value', phrasable: true,
    propose: ctx => codeProposals(ctx, 'L10', 'Observation', ctx.data.of('Observation').filter(o => isSurvey(o) && obsValue(o).kind === 'quantity'), 'code', 'code'),
    text: (p, ph) => `What was this patient's most recent ${name(p, ph)} score?` },

  { id: 'G1', category: 'R', encounterScoped: true, answerForm: 'list', phrasable: false,
    propose: ctx => encounterProposals(ctx, 'G1', 'MedicationAdministration', 'context', ctx.data.of('MedicationAdministration'), rs => rs.flatMap(r => drugDepends(ctx, r))),
    text: p => `Which drugs were administered to this patient during the stay that began at ${p.encounter_start}?` },
  { id: 'G2', category: 'T', encounterScoped: false, answerForm: 'value', phrasable: true,
    propose: ctx => codeProposals(ctx, 'G2', 'MedicationAdministration', ctx.data.of('MedicationAdministration'), 'medicationCodeableConcept', 'code'),
    text: (p, ph) => `When was ${name(p, ph)} last administered to this patient, and what dose was given?` },
  { id: 'G3', category: 'C', encounterScoped: false, answerForm: 'count', phrasable: true,
    propose: ctx => codeProposals(ctx, 'G3', 'MedicationDispense', ctx.data.of('MedicationDispense'), 'medicationCodeableConcept', 'code'),
    text: (p, ph) => `How many times was ${name(p, ph)} dispensed for this patient?` },

  { id: 'O1', category: 'R', encounterScoped: true, answerForm: 'list', phrasable: false,
    propose: (ctx, dataset) => {
      if (dataset === 'mimic') {
        return encounterProposals(ctx, 'O1', 'MedicationRequest', 'encounter', ctx.data.of('MedicationRequest'), rs => rs.flatMap(r => drugDepends(ctx, r)));
      }
      const active = ctx.data.of('MedicationRequest').filter(r => str(r.status) === 'active');
      return single(ctx, 'O1', [drain('MedicationRequest', [pat(ctx), ['status', 'active']]), ...medsOp(active.flatMap(r => drugDepends(ctx, r)))]);
    },
    text: p => p.encounter
      ? `Which drugs were ordered for this patient during the stay that began at ${p.encounter_start}? Give the drug names.`
      : 'Which medications does this patient have active orders for? Give the drug names.' },
  { id: 'O2', category: 'T', encounterScoped: false, answerForm: 'value', phrasable: true,
    propose: ctx => {
      const out: Proposal[] = [];
      const reqs = ctx.data.of('MedicationRequest');
      for (const med of new Set(reqs.map(r => refStr(r.medicationReference)).filter((x): x is string => !!x))) {
        const recs = reqs.filter(r => refStr(r.medicationReference) === med);
        const display = safe(() => drugName(ctx, recs[0]!));
        if (display === null) continue;
        const prop = { key: med, dedupe: med, parameters: { medication: med, display },
          operations: [drain('MedicationRequest', [pat(ctx), ['medication', med]]), ...medsOp(medicationRefs(ctx, med))] };
        if (valid(ctx, 'O2', prop)) out.push(prop);
      }
      return [...out, ...codeProposals(ctx, 'O2', 'MedicationRequest', reqs.filter(r => r.medicationCodeableConcept !== undefined), 'medicationCodeableConcept', 'code')];
    },
    text: (p, ph) => `What dose and route were specified on the most recent order of ${name(p, ph)} for this patient?` },
  { id: 'O3', category: 'R', encounterScoped: true, answerForm: 'list', phrasable: false,
    propose: ctx => encounterProposals(ctx, 'O3', 'MedicationAdministration', 'context', ctx.data.of('MedicationAdministration'), rs => rs.flatMap(r => drugDepends(ctx, r))),
    text: p => `Which drugs were administered to this patient during the encounter that began at ${p.encounter_start}?` },
  { id: 'O4', category: 'V', encounterScoped: false, answerForm: 'value', phrasable: true,
    propose: ctx => {
      const reqs = ctx.data.of('MedicationRequest').filter(r => quantityInfo(get1(r, 'dosageInstruction.doseAndRate.doseQuantity')).kind === 'quantity' && getStr(r, 'authoredOn'));
      const drugKey = (r: Res) => refStr(r.medicationReference) ?? (concept(r.medicationCodeableConcept) ? tokOfCc(r.medicationCodeableConcept) : null);
      return uniqueRecords(reqs, r => { const k = drugKey(r); return k ? `${k} ${getStr(r, 'authoredOn')}` : null; }).flatMap(r => {
        const c = r.medicationCodeableConcept !== undefined ? concept(r.medicationCodeableConcept) : null;
        const display = safe(() => drugName(ctx, r));
        if (display === null) return [];
        const prop = { key: refOf(r), dedupe: drugKey(r)!, parameters: { ...(c ?? {}), display, record: refOf(r), record_time: getStr(r, 'authoredOn')! },
          operations: [read(refOf(r)), ...medsOp(drugDepends(ctx, r))] };
        return valid(ctx, 'O4', prop) ? [prop] : [];
      });
    },
    text: (p, ph) => `What dose was specified on this patient's order of ${name(p, ph)} written at ${p.record_time}?` },

  { id: 'B1', category: 'R', encounterScoped: false, answerForm: 'list', phrasable: false,
    propose: ctx => {
      const obs = ctx.data.of('Observation');
      const orgTests = new Set(obs.filter(isMicroOrg).flatMap(o => get(o, 'derivedFrom.reference').map(x => str(x)!)));
      const tests = obs.filter(o => isMicroTest(o) && orgTests.has(refOf(o)) && refStr(o.specimen));
      const dates = new Set(tests.map(t => getStr(ctx.data.byRef.get(refStr(t.specimen)!), 'collection.collectedDateTime')).filter((x): x is string => !!x).map(utcDate));
      return [...dates].flatMap(date => {
        const [a, b] = dayBounds(date);
        const specs = ctx.data.of('Specimen').filter(s => { const t = getStr(s, 'collection.collectedDateTime'); return t && utcDate(t) === date; }).map(refOf).sort();
        const dayTests = obs.filter(o => isMicroTest(o) && specs.includes(refStr(o.specimen) ?? '')).map(refOf).sort();
        const testSpecs = [...new Set(obs.filter(o => dayTests.includes(refOf(o))).map(o => refStr(o.specimen)!))].sort();
        const ops: AbstractOp[] = [drain('Specimen', [pat(ctx), ...dateParams('collected', a, b)]),
          ...testSpecs.map(s => drain('Observation', [pat(ctx), ['specimen', s]])),
          ...dayTests.map(t => drain('Observation', [pat(ctx), ['derived-from', t]]))];
        if (ops.length > MAX_READS) return [];
        const prop = { key: date, dedupe: date, parameters: { date }, operations: ops };
        return valid(ctx, 'B1', prop) ? [prop] : [];
      });
    },
    text: p => `Which organisms grew from this patient's specimens collected on ${p.date} (UTC date), and from which specimen types?` },
  { id: 'B2', category: 'R', encounterScoped: false, answerForm: 'list', phrasable: false,
    propose: ctx => {
      const obs = ctx.data.of('Observation');
      const withSusc = new Set(obs.filter(isMicroSusc).flatMap(o => get(o, 'derivedFrom.reference').map(x => str(x)!)));
      const orgs = obs.filter(o => isMicroOrg(o) && withSusc.has(refOf(o)) && obsTime(o));
      return uniqueRecords(orgs, o => `${ccName(o.code)} ${utcDate(obsTime(o)!)}`).flatMap(o => {
        const prop = { key: refOf(o), dedupe: tokOf(o) ?? refOf(o), parameters: { record: refOf(o), display: ccName(o.code)!, date: utcDate(obsTime(o)!) },
          operations: [drain('Observation', [pat(ctx), ['derived-from', refOf(o)]])] };
        return valid(ctx, 'B2', prop) ? [prop] : [];
      });
    },
    text: p => `To which antibiotics was the ${p.display} grown from this patient's culture on ${p.date} (UTC date) resistant?` },

  { id: 'C1', category: 'R', encounterScoped: true, answerForm: 'list', phrasable: false,
    propose: ctx => encounterProposals(ctx, 'C1', 'Condition', 'encounter', ctx.data.of('Condition')),
    text: p => `Which diagnosis codes were recorded for this patient's stay that began at ${p.encounter_start}?` },
  { id: 'C2', category: 'R', encounterScoped: false, answerForm: 'yes_no', phrasable: true,
    // "yes" candidates here; "no" candidates come from other patients' codes (questions.ts, after all patients are read).
    propose: ctx => codeProposals(ctx, 'C2', 'Condition', ctx.data.of('Condition'), 'code', 'code').map(p => ({ ...p, stratum: 'yes' })),
    text: (p, ph) => `Has this patient ever had a diagnosis of ${name(p, ph)}?` },
  { id: 'C3', category: 'R', encounterScoped: false, answerForm: 'list', phrasable: false,
    propose: ctx => single(ctx, 'C3', [drain('Condition', [pat(ctx), ['clinical-status', 'active']])]),
    text: () => 'What are this patient\'s active conditions?' },

  { id: 'P1', category: 'R', encounterScoped: true, answerForm: 'list', phrasable: false,
    propose: ctx => encounterProposals(ctx, 'P1', 'Procedure', 'encounter', ctx.data.of('Procedure')),
    text: p => `Which procedures were performed during this patient's encounter that began at ${p.encounter_start}?` },
  { id: 'P2', category: 'T', encounterScoped: false, answerForm: 'datetime', phrasable: true,
    propose: ctx => codeProposals(ctx, 'P2', 'Procedure', ctx.data.of('Procedure').filter(r => procTime(r)), 'code', 'code'),
    text: (p, ph) => `When was ${name(p, ph)} first performed on this patient?` },

  { id: 'E1', category: 'R', encounterScoped: false, answerForm: 'list', phrasable: false,
    propose: ctx => single(ctx, 'E1', [drain('Encounter', [pat(ctx)])]),
    text: () => 'How many encounters does this patient have, broken down by encounter class?' },
  { id: 'E2', category: 'R', encounterScoped: false, answerForm: 'list', phrasable: false,
    propose: ctx => ctx.data.of('Encounter').filter(e => isIcuEncounter(e) && encStart(e)).flatMap(e => {
      const locs = [...new Set(get(e, 'location.location.reference').map(x => str(x)!))].sort();
      if (locs.length === 0) return [];
      const prop = { key: refOf(e), dedupe: refOf(e), parameters: { encounter: refOf(e), encounter_start: encStart(e)! }, operations: [read(refOf(e)), ...locs.map(read)] };
      return valid(ctx, 'E2', prop) ? [prop] : [];
    }),
    text: p => `In which care unit was this patient during the ICU stay that began at ${p.encounter_start}?` },
  { id: 'E3', category: 'V', encounterScoped: false, answerForm: 'value', phrasable: false,
    propose: ctx => ctx.data.of('Encounter').filter(e => encStart(e) && getStr(e, 'period.end')).flatMap(e => {
      const prop = { key: refOf(e), dedupe: refOf(e), parameters: { encounter: refOf(e), encounter_start: encStart(e)! }, operations: [read(refOf(e))] };
      return valid(ctx, 'E3', prop) ? [prop] : [];
    }),
    text: p => `How long, in hours, was this patient's stay that began at ${p.encounter_start}? Round to two decimal places.` },
  { id: 'E4', category: 'R', encounterScoped: false, answerForm: 'list', phrasable: false,
    propose: ctx => {
      const dates = new Set(ctx.data.of('Encounter').filter(e => encStart(e) && get(e, 'reasonCode').length > 0).map(e => utcDate(encStart(e)!)));
      return [...dates].flatMap(date => {
        if (encountersOn(ctx, date).length !== 1) return [];
        const [a, b] = dayBounds(date);
        const prop = { key: date, dedupe: date, parameters: { date }, operations: [drain('Encounter', [pat(ctx), ...dateParams('date', a, b)])] };
        return valid(ctx, 'E4', prop) ? [prop] : [];
      });
    },
    text: p => `What was the reason for this patient's encounter on ${p.date} (UTC date)?` },
  { id: 'E5', category: 'T', encounterScoped: false, answerForm: 'datetime', phrasable: true,
    propose: ctx => codeProposals(ctx, 'E5', 'Encounter', ctx.data.of('Encounter').filter(e => encStart(e)), 'type', 'type'),
    text: (p, ph) => `When did this patient's most recent ${name(p, ph)} encounter begin?` },

  { id: 'F1', category: 'V', encounterScoped: true, answerForm: 'value', phrasable: false,
    propose: ctx => {
      const encs = new Set(ctx.data.of('Claim').flatMap(c => get(c, 'item.encounter.reference').map(x => str(x)!)));
      return [...encs].flatMap(enc => {
        const e = ctx.data.byRef.get(enc);
        if (!e || !encStart(e)) return [];
        const prop = { key: enc, dedupe: enc, parameters: { encounter: enc, encounter_start: encStart(e)! }, operations: [drain('Claim', [pat(ctx), ['encounter', enc]])] };
        return valid(ctx, 'F1', prop) ? [prop] : [];
      });
    },
    text: p => `What was the total amount of the claim for this patient's encounter that began at ${p.encounter_start}?` },
  { id: 'F2', category: 'C', encounterScoped: false, answerForm: 'count', phrasable: false,
    propose: ctx => [...new Set(ctx.data.of('Claim').map(c => getStr(c, 'created')).filter((x): x is string => !!x).map(t => utcDate(t).slice(0, 4)))].flatMap(year => {
      const a = `${year}-01-01T00:00:00Z`, b = `${Number(year) + 1}-01-01T00:00:00Z`;
      const prop = { key: year, dedupe: year, parameters: { year }, operations: [drain('Claim', [pat(ctx), ...dateParams('created', a, b)])] };
      return valid(ctx, 'F2', prop) ? [prop] : [];
    }),
    text: p => `How many claims were created for this patient in ${p.year} (UTC calendar year)?` },
  { id: 'F3', category: 'V', encounterScoped: false, answerForm: 'value', phrasable: false,
    propose: ctx => ctx.data.of('Claim').filter(c => getStr(c, 'created')).flatMap(c => {
      const prop = { key: refOf(c), dedupe: refOf(c), parameters: { claim: refOf(c), claim_created: getStr(c, 'created')! },
        operations: [drain('ExplanationOfBenefit', [pat(ctx), ['claim', refOf(c)]])] };
      return uniqueClaimTime(ctx, c) && valid(ctx, 'F3', prop) ? [prop] : [];
    }),
    text: p => `What payment amount is on the explanation of benefit for this patient's claim created at ${p.claim_created}?` },

  { id: 'N1', category: 'C', encounterScoped: false, answerForm: 'count', phrasable: false,
    propose: ctx => single(ctx, 'N1', [drain('DocumentReference', [pat(ctx)])]),
    text: () => 'How many clinical notes (DocumentReference records) does this patient have?' },
  { id: 'N2', category: 'R', encounterScoped: false, answerForm: 'list', phrasable: false,
    propose: ctx => {
      if (ctx.data.of('DocumentReference').length === 0) return [];
      if (ctx.data.of('Condition').some(c => (ccName(c.code) ?? '').includes(', '))) return []; // the split rule would be ambiguous
      return single(ctx, 'N2', [drain('DocumentReference', [pat(ctx)])]);
    },
    text: () => 'Which conditions are listed in the text of this patient\'s most recent clinical note?' },
  { id: 'N3', category: 'R', encounterScoped: false, answerForm: 'list', phrasable: false,
    propose: ctx => {
      const lab = ctx.data.of('DiagnosticReport').flatMap(r => get(r, 'category').flatMap(cc => codings(cc))).find(c => c.code === 'LAB' && c.system);
      if (!lab) return [];
      const p = { code_system: lab.system!, code: 'LAB', display: lab.display ?? 'Laboratory' };
      const props = single(ctx, 'N3', [], p);
      if (props.length === 0) return [];
      const core = computeCore({ template_id: 'N3', parameters: p, patient_id: ctx.data.patientId }, ctx);
      const reads = core.provenance.filter(r => r.startsWith('Observation/')).sort();
      if (reads.length > MAX_READS) return [];
      return [{ ...props[0]!, key: tok(p), operations: [drain('DiagnosticReport', [pat(ctx), ['category', tok(p)]]), ...reads.map(read)] }];
    },
    text: () => 'Which results are listed in this patient\'s most recent laboratory report?' },

  { id: 'I1', category: 'C', encounterScoped: false, answerForm: 'count', phrasable: false,
    propose: ctx => single(ctx, 'I1', [drain('Immunization', [pat(ctx)])]),
    text: () => 'How many immunizations does this patient have on record?' },
  { id: 'I2', category: 'T', encounterScoped: false, answerForm: 'datetime', phrasable: true,
    propose: ctx => codeProposals(ctx, 'I2', 'Immunization', ctx.data.of('Immunization').filter(r => getStr(r, 'occurrenceDateTime')), 'vaccineCode', 'vaccine-code'),
    text: (p, ph) => `When did this patient receive their most recent dose of ${name(p, ph)}?` },
  { id: 'A1', category: 'R', encounterScoped: false, answerForm: 'list', phrasable: false,
    propose: ctx => single(ctx, 'A1', [drain('AllergyIntolerance', [pat(ctx)])]),
    text: () => 'What allergies are recorded for this patient? Answer none if there are none.' },

  { id: 'K1', category: 'R', encounterScoped: false, answerForm: 'list', phrasable: false,
    propose: ctx => {
      const active = ctx.data.of('CarePlan').filter(c => str(c.status) === 'active');
      const label = (c: Res) => get(c, 'category').map(cc => (isObj(cc) ? str(cc.text) : null)).find(Boolean) ?? get(c, 'category').map(cc => ccName(cc)).find(Boolean) ?? null;
      return uniqueRecords(active, label).flatMap(c => {
        const prop = { key: refOf(c), dedupe: refOf(c), parameters: { record: refOf(c), display: label(c)! }, operations: [drain('CarePlan', [pat(ctx), ['status', 'active']])] };
        return valid(ctx, 'K1', prop) ? [prop] : [];
      });
    },
    text: p => `What activities are in this patient's active "${p.display}" care plan?` },
  { id: 'K2', category: 'R', encounterScoped: false, answerForm: 'list', phrasable: false,
    propose: ctx => uniqueRecords(ctx.data.of('CareTeam'), t => { const s = getStr(t, 'period.start'); return s ? utcDate(s) : null; }).flatMap(t => {
      const prop = { key: refOf(t), dedupe: refOf(t), parameters: { record: refOf(t), date: utcDate(getStr(t, 'period.start')!) }, operations: [drain('CareTeam', [pat(ctx)])] };
      return valid(ctx, 'K2', prop) ? [prop] : [];
    }),
    text: p => `Who are the members of this patient's care team that started on ${p.date} (UTC date), and what are their roles?` },

  { id: 'M1', category: 'R', encounterScoped: false, answerForm: 'list', phrasable: false,
    propose: ctx => ctx.data.of('ImagingStudy').length ? single(ctx, 'M1', [drain('ImagingStudy', [pat(ctx)])]) : [],
    text: () => 'What were the modality and body site of this patient\'s most recent imaging study?' },
  { id: 'M2', category: 'C', encounterScoped: false, answerForm: 'list', phrasable: false,
    propose: ctx => uniqueRecords(ctx.data.of('ImagingStudy'), s => getStr(s, 'started')).flatMap(s => {
      const prop = { key: refOf(s), dedupe: refOf(s), parameters: { record: refOf(s), record_time: getStr(s, 'started')! }, operations: [read(refOf(s))] };
      return valid(ctx, 'M2', prop) ? [prop] : [];
    }),
    text: p => `How many series and how many instances does this patient's imaging study started at ${p.record_time} contain?` },
  { id: 'V1', category: 'R', encounterScoped: false, answerForm: 'list', phrasable: false,
    propose: ctx => ctx.data.of('Device').length ? single(ctx, 'V1', [drain('Device', [pat(ctx)])]) : [],
    text: () => 'What types of devices are recorded for this patient?' },
  { id: 'D1', category: 'R', encounterScoped: false, answerForm: 'list', phrasable: false,
    propose: ctx => single(ctx, 'D1', [read(`Patient/${ctx.data.patientId}`)]),
    text: () => 'What are this patient\'s birth date and sex, and what is their date of death (or are they alive)?' },
];

export const TEMPLATES: Map<string, TemplateSpec> = new Map(T.map(t => [t.id, t]));

// ---- Strata: separate question sets, never mixed into the main allocation ----------------------------------------

export type StratumId = 'long-list' | 'decimal';
export const STRATA: readonly StratumId[] = ['long-list', 'decimal'];

interface LLSet { t: LLType; recs: Res[]; key: string; parameters: Record<string, string>; params: SearchParams }

/** Record sets a long-list question can be about: every record of a type, and every record carrying one token value. */
function llSets(ctx: Ctx): { byType: LLSet[]; byToken: (LLSet & { token: LLToken })[] } {
  const byType: LLSet[] = [];
  const byToken: (LLSet & { token: LLToken })[] = [];
  for (const t of LL_TYPES) {
    const all = ctx.data.of(t.type);
    if (all.length === 0) continue;
    byType.push({ t, recs: all, key: t.type, parameters: { resource_type: t.type }, params: [] });
    for (const token of t.tokens) {
      const groups = new Map<string, { c: { system: string; code: string; display: string | null }; recs: Res[] }>();
      for (const r of all) for (const c of tokenCodings(r, token)) {
        const k = `${c.system}|${c.code}`;
        const g = groups.get(k);
        if (g) g.recs.push(r); else groups.set(k, { c, recs: [r] });
      }
      for (const [k, { c, recs }] of groups) byToken.push({ t, token, recs, key: `${t.type}|${token.param}|${k}`, params: [[token.param, k]],
        parameters: { resource_type: t.type, search_param: token.param, field_label: token.label, code_system: c.system, code: c.code, display: c.display ?? c.code } });
    }
  }
  return { byType, byToken };
}

/** One candidate per set and band: the whole set when its size is in the band, else a window drawn to a hashed target. */
function bandProposal(ctx: Ctx, id: string, band: Band, set: LLSet, extra: Record<string, string>, seedHex: string | undefined): Proposal | null {
  if (!seedHex) throw new Error(`${id} needs the seed`);
  const { t, recs } = set;
  const parameters = { ...set.parameters, ...extra };
  let prop: Proposal;
  if (recs.length >= band.min && recs.length <= band.max) {
    prop = { key: set.key, dedupe: set.key, parameters, operations: [drain(t.type, [pat(ctx), ...set.params])] };
  } else if (recs.length > band.max && t.date) {
    const date = t.date;
    const times = recs.map(r => llDate(r, date));
    if (times.some(x => x === null)) return null;
    const target = bandTarget(seedHex, id, `${ctx.data.patientId}|${set.key}`, band);
    const w = llWindow(times as string[], target, band.max);
    if (!w) return null;
    prop = { key: set.key, dedupe: set.key, parameters: { ...parameters, date_label: date.label, window_start: w[0], window_end: w[1] },
      operations: [drain(t.type, [pat(ctx), ...set.params, ...dateParams(date.param, w[0], w[1])])] };
  } else return null;
  return valid(ctx, id, prop) ? prop : null;
}

const windowText = (p: Record<string, string>) => (p.window_start
  ? ` with ${p.date_label} from ${p.window_start} (inclusive) to ${p.window_end} (exclusive)` : '');

/** LS1 and LS2 for one band. LS1: distinct codes in a type set or a token set on another element. LS2: the largest value. */
function bandTemplates(band: Band): TemplateSpec[] {
  const ls1 = `LS1-${band.id}`, ls2 = `LS2-${band.id}`;
  return [
    { id: ls1, category: 'C', encounterScoped: false, answerForm: 'list', phrasable: true,
      propose: (ctx, _d, seedHex) => {
        const { byType, byToken } = llSets(ctx);
        const sets = [...byType, ...byToken.filter(x => x.token.field !== x.t.code.field)];
        return sets.flatMap(set => bandProposal(ctx, ls1, band, set, { code_label: set.t.code.label }, seedHex) ?? []);
      },
      text: (p, ph) => `Which distinct ${p.code_label} codes appear on this patient's ${p.resource_type} records${p.search_param ? ` with ${p.field_label} ${name(p, ph)}` : ''}${p.search_param && p.window_start ? ',' : ''}${windowText(p)}? Give each as system|code.` },
    { id: ls2, category: 'C', encounterScoped: false, answerForm: 'value', phrasable: true,
      propose: (ctx, _d, seedHex) => {
        const { byType, byToken } = llSets(ctx);
        const sets: [LLSet, string][] = [
          ...byToken.filter(x => x.t.type === 'Observation' && x.token.param === 'code').map(x => [x, 'observation'] as [LLSet, string]),
          ...byType.filter(x => x.t.type === 'Claim').map(x => [x, 'claim'] as [LLSet, string]),
        ];
        return sets.flatMap(([set, kind]) => bandProposal(ctx, ls2, band, set, { value_kind: kind }, seedHex) ?? []);
      },
      text: (p, ph) => (p.value_kind === 'claim'
        ? `What is the largest claim total among this patient's Claim records${windowText(p)}? Give the amount and the currency.`
        : `What is the highest ${name(p, ph)} result recorded for this patient${windowText(p)}? Give the value and the unit.`) },
  ];
}

const LL: TemplateSpec[] = BANDS.flatMap(bandTemplates);

/** CL1 (decimal stratum only): net amount of a named line on a claim, the claim named by its creation time. */
const CL1: TemplateSpec = {
  id: 'CL1', category: 'V', encounterScoped: false, answerForm: 'value', phrasable: true,
  propose: ctx => ctx.data.of('Claim').filter(c => getStr(c, 'created') && uniqueClaimTime(ctx, c)).flatMap(c =>
    get(c, 'item').filter(isObj).flatMap(i => {
      const k = concept(i.productOrService);
      const seq = str(i.sequence);
      if (!k || !seq) return [];
      const prop = { key: `${refOf(c)}#${seq}`, dedupe: `${refOf(c)}#${seq}`,
        parameters: { ...k, claim: refOf(c), claim_created: getStr(c, 'created')!, item_sequence: seq }, operations: [read(refOf(c))] };
      return valid(ctx, 'CL1', prop) ? [prop] : [];
    })),
  text: (p, ph) => `What is the net amount of the ${name(p, ph)} line on this patient's claim created at ${p.claim_created}?`,
};

/** Value templates whose gold carries a recorded quantity, per dataset, in table order, then CL1. */
const DECIMAL_BASE_IDS: Readonly<Record<DatasetFamily, string[]>> = {
  mimic: ['L1', 'L6', 'L8', 'G2', 'O2'],
  synthea: ['L1', 'L6', 'L8', 'L10', 'O4', 'F1', 'F3', 'CL1'],
};
export const DECIMAL_BASES: Readonly<Record<DatasetId, string[]>> = byFamily(DECIMAL_BASE_IDS);

const zeroValued = (core: GoldCore) => core.items.every(i => /^-?0(\.0+)?$/.test(i.value_as_recorded ?? ''));

/**
 * A value template restricted to candidates whose gold is lexeme-eligible (G3: a binary-float round trip changes the
 * recorded text). One question per record or concept (the base key); zero and non-zero values are alternating strata.
 */
function decimalVariant(base: TemplateSpec): TemplateSpec {
  return {
    ...base,
    id: `${DEC_PREFIX}${base.id}`,
    propose: (ctx, dataset) => base.propose(ctx, dataset).flatMap(p => {
      const core = computeCore({ template_id: base.id, parameters: p.parameters, patient_id: ctx.data.patientId }, ctx);
      if (!lexemeEligible(core)) return [];
      return [{ ...p, dedupe: p.key, stratum: zeroValued(core) ? 'zero' : 'nonzero' }];
    }),
  };
}

for (const t of [...LL, CL1]) TEMPLATES.set(t.id, t);
for (const id of new Set(Object.values(DECIMAL_BASES).flat())) TEMPLATES.set(`${DEC_PREFIX}${id}`, decimalVariant(TEMPLATES.get(id)!));

/** One group per band; LS2 first so that LS1 (available for more sets) takes its shortfall under the fill rule. */
function longListGroup(b: Band): GroupSpec {
  return { name: `Long lists ${b.min}-${b.max}`, count: b.count, templates: [`LS2-${b.id}`, `LS1-${b.id}`] };
}

/** Stratum allocation. Every group is selected on its own, independently of the main set and of the other groups. */
export const STRATA_GROUPS: Record<StratumId, Readonly<Record<DatasetId, GroupSpec[]>>> = {
  'long-list': byFamily<GroupSpec[]>({
    mimic: BANDS.map(longListGroup),
    synthea: BANDS.map(longListGroup),
  }),
  decimal: byFamily<GroupSpec[]>({
    mimic: [{ name: 'Decimal lexemes', count: 30, templates: DECIMAL_BASE_IDS.mimic.map(id => `${DEC_PREFIX}${id}`) }],
    synthea: [{ name: 'Decimal lexemes', count: 30, templates: DECIMAL_BASE_IDS.synthea.map(id => `${DEC_PREFIX}${id}`) }],
  }),
};

function tokOf(o: Res): string | null { return tokOfCc(o.code); }
function tokOfCc(cc: unknown): string | null { const c = concept(cc); return c ? `${c.code_system}|${c.code}` : null; }

function uniqueClaimTime(ctx: Ctx, c: Res): boolean {
  const t = getStr(c, 'created');
  return ctx.data.of('Claim').filter(x => getStr(x, 'created') === t).length === 1;
}

/** C2 "no" candidates: a code another patient has and this patient does not. */
export function c2NoProposal(patientId: string, c: { code_system: string; code: string; display: string }): Proposal {
  const k = `${c.code_system}|${c.code}`;
  return { key: k, dedupe: k, parameters: { ...c }, operations: [drain('Condition', [['patient', `Patient/${patientId}`], ['code', k]])], stratum: 'no' };
}

export function conditionConcepts(ctx: Ctx): Map<string, { code_system: string; code: string; display: string }> {
  return new Map([...byConcept(ctx.data.of('Condition'), 'code')].map(([k, v]) => [k, v.c]));
}

export const groupOf = (dataset: DatasetId, templateId: string): string =>
  (GROUPS[dataset].find(g => g.templates.includes(templateId))
    ?? STRATA.flatMap(s => STRATA_GROUPS[s][dataset]).find(g => g.templates.includes(templateId))!).name;

