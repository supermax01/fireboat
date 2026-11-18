// Gold rules (question templates in templates.ts; shared rules and rulings in bench/GOLD-RULINGS.md). Each rule computes the answer for one question
// from its parameters and the patient's raw records only. A rule throws Excluded when the template's own rules exclude the
// candidate (for example a latest-instant tie with differing values, G-R2). depends_on holds only records the question's
// scripted plan reaches (G-R1).
import { canonicalDecimal, compareDecimal, isDecimalLexeme, lexemeChangedByFloat } from './decimal.js';
import {
  byteCompare, codings, compareInstant, get, get1, getStr, hasCoding, instantMs, isObj, refOf, sortBytes, str, uniqSorted, utcDate,
  type Json, type Res,
} from './fhir.js';
import { BANDS, LL_TYPES, elementCodings, inLLWindow, llDate, llToken, llType, tokenMatches } from './longlist.js';
import type { PatientData, SharedData } from './reader.js';
import type { AnswerForm, AnswerKind, GoldItem, Ref } from '../lib/types.js';

export class Excluded extends Error {}

export interface RuleInput { template_id: string; parameters: Record<string, string>; patient_id: string }
export interface Ctx { data: PatientData; shared: SharedData }

export interface GoldCore {
  answer_form: AnswerForm;
  answer_kind: AnswerKind;
  answer: string | null;
  answer_list: string[] | null;
  value_as_recorded: string | null;
  unit: string | null;
  timestamp: string | null;
  items: GoldItem[];
  provenance: Ref[];
  depends_on: Ref[];
  rule_notes: string[];
}

// ---- Value extraction -----------------------------------------------------------------------------------------

export interface ValueInfo {
  kind: 'quantity' | 'string' | 'concept' | 'datetime' | 'none';
  value: string | null; // canonical decimal (comparator prefixed) or text
  recorded: string | null; // exact lexeme (comparator prefixed) or text
  unit: string | null;
  unit_code: string | null;
  unit_system: string | null;
}

export function quantityInfo(q: unknown): ValueInfo {
  if (!isObj(q)) return { kind: 'none', value: null, recorded: null, unit: null, unit_code: null, unit_system: null };
  const lex = str(q.value);
  const comparator = str(q.comparator) ?? '';
  if (lex !== null && !isDecimalLexeme(lex)) throw new Error(`quantity value is not a number lexeme: ${lex}`);
  return {
    kind: lex === null ? 'none' : 'quantity',
    value: lex === null ? null : comparator + canonicalDecimal(lex),
    recorded: lex === null ? null : comparator + lex,
    unit: str(q.unit) ?? str(q.code),
    unit_code: str(q.code),
    unit_system: str(q.system),
  };
}

const none = (): ValueInfo => ({ kind: 'none', value: null, recorded: null, unit: null, unit_code: null, unit_system: null });

/** Concept name: text, else the first coding's display, else its code. */
export function ccName(cc: unknown): string | null {
  if (!isObj(cc)) return null;
  const text = str(cc.text);
  if (text) return text;
  const c = codings(cc)[0];
  return c?.display ?? c?.code ?? null;
}

/**
 * Answer helpers also read returned copies, and a compact server (fhirHydrant, see servers/items.ts) may give a
 * CodeableConcept or Coding as a plain string (its name) and a Reference as a plain string (the reference). Raw files
 * never use these forms, so the gold is unchanged.
 */
export function conceptName(cc: unknown): string | null {
  const c = Array.isArray(cc) ? cc[0] : cc; // a compact copy may wrap a single concept in a list (servers/items.ts first())
  return typeof c === 'string' ? c : ccName(c);
}
export const refText = (v: unknown): string | null => (typeof v === 'string' ? v : refStr(v));
/** Type/id of a reference, also when written absolute or versioned (as a compact server may write it). */
export const refKey = (ref: string): string => /(?:^|\/)([A-Za-z]+\/[A-Za-z0-9.-]{1,64})(?:\/_history\/[^/]+)?$/.exec(ref)?.[1] ?? ref;

export function obsValue(r: Res): ValueInfo {
  if (r.valueQuantity !== undefined) return quantityInfo(r.valueQuantity);
  const s = str(r.valueString);
  if (s !== null) return { ...none(), kind: 'string', value: s, recorded: s };
  if (r.valueCodeableConcept !== undefined) {
    const n = ccName(r.valueCodeableConcept);
    return { ...none(), kind: 'concept', value: n, recorded: n };
  }
  const dt = str(r.valueDateTime);
  if (dt !== null) return { ...none(), kind: 'datetime', value: dt, recorded: dt };
  for (const k of ['valueBoolean', 'valueInteger']) if (r[k] !== undefined) {
    const v = String(r[k]);
    return { ...none(), kind: 'string', value: v, recorded: v };
  }
  return none();
}

export function goldItem(r: Res, v: ValueInfo | null, time: string | null, display: string | null): GoldItem {
  return {
    ref: refOf(r), value: v?.value ?? null, value_as_recorded: v?.recorded ?? null, unit: v?.unit ?? null,
    unit_code: v?.unit_code ?? null, unit_system: v?.unit_system ?? null, time, display,
  };
}

const sameValue = (a: ValueInfo, b: ValueInfo) => a.recorded === b.recorded && a.unit === b.unit;

/**
 * Latest by parsed instant (G-R2, every "most recent" or "last" template): records tied at the latest instant with equal
 * values are all items (`tied`; the answer is read from the first id in byte order); a tie with differing values excludes
 * the candidate.
 */
export function latest<T extends Res>(records: T[], time: (r: T) => string | null, value: (r: T) => ValueInfo): { r: T; tied: T[]; notes: string[] } {
  const timed = records.filter(r => time(r) !== null);
  if (timed.length === 0) throw new Excluded('no timed record');
  const sorted = [...timed].sort((a, b) => compareInstant(time(a)!, time(b)!) || byteCompare(a.id, b.id));
  const last = sorted[sorted.length - 1]!;
  const tied = sorted.filter(r => compareInstant(time(r)!, time(last)!) === 0);
  if (tied.length > 1) {
    const v0 = value(tied[0]!);
    if (!tied.every(r => sameValue(value(r), v0))) throw new Excluded('latest-instant tie with differing values');
    return { r: tied[0]!, tied, notes: [`G-R2: ${tied.length} records tie at the latest instant with equal values; all are items`] };
  }
  return { r: last, tied: [last], notes: [] };
}

export function earliest<T extends Res>(records: T[], time: (r: T) => string | null): T {
  const timed = records.filter(r => time(r) !== null);
  if (timed.length === 0) throw new Excluded('no timed record');
  return [...timed].sort((a, b) => compareInstant(time(a)!, time(b)!) || byteCompare(a.id, b.id))[0]!;
}

// ---- Record classes -------------------------------------------------------------------------------------------

const catCodes = (r: Res) => get(r, 'category').flatMap(c => codings(c)).map(c => c.code);
const isMicro = (r: Res) => codings(r.code).some(c => (c.system ?? '').includes('microbiology'));
export const isLab = (r: Res) => r.resourceType === 'Observation' && catCodes(r).includes('laboratory') && !isMicro(r);
export const isSurvey = (r: Res) => r.resourceType === 'Observation' && catCodes(r).includes('survey');
export const isVital = (r: Res) => r.resourceType === 'Observation' && catCodes(r).includes('vital-signs');
export const isMicroTest = (r: Res) => codings(r.code).some(c => (c.system ?? '').endsWith('microbiology-test'));
export const isMicroOrg = (r: Res) => codings(r.code).some(c => (c.system ?? '').endsWith('microbiology-organism'));
export const isMicroSusc = (r: Res) => codings(r.code).some(c => (c.system ?? '').endsWith('microbiology-antibiotic'));
export const isIcuEncounter = (r: Res) => get(r, 'identifier').some(i => isObj(i) && (str(i.system) ?? '').endsWith('/encounter-icu'));
export const LOINC = 'http://loinc.org';
export const BP_PANEL = '85354-9', SYSTOLIC = '8480-6', DIASTOLIC = '8462-4';
export const obsTime = (r: Res): string | null => getStr(r, 'effectiveDateTime') ?? getStr(r, 'effectivePeriod.start') ?? getStr(r, 'effectiveInstant') ?? getStr(r, 'issued');
export const refStr = (v: unknown): string | null => (isObj(v) ? str(v.reference) : null);
const encounterOf = (r: Res): string | null => refStr(r.encounter) ?? refStr(r.context);

function byCoding(ctx: Ctx, type: string, field: string, p: Record<string, string>): Res[] {
  return ctx.data.of(type).filter(r => hasCoding(get1(r, field), p.code_system!, p.code!));
}

function resolve(ctx: Ctx, ref: string): Res {
  const r = ctx.data.byRef.get(ref) ?? ctx.shared.byRef.get(ref);
  if (!r) throw new Error(`unresolved reference ${ref}`);
  return r;
}

/** Looks up a referenced record; throws when it cannot be found. */
export type Resolver = (ref: string) => Res;

/** MIMIC keeps a drug's name in identifier (system .../mimic-medication-name); mixes name their ingredients. */
export function medicationNameWith(lookup: Resolver, med: Res): string {
  const named = get(med, 'identifier').find(i => isObj(i) && (str(i.system) ?? '').endsWith('/mimic-medication-name'));
  if (isObj(named) && str(named.value)) return str(named.value)!;
  const ingredients = get(med, 'ingredient.itemReference').map(x => refText(x)).filter((x): x is string => !!x);
  if (ingredients.length > 0) return ingredients.map(ref => medicationNameWith(lookup, lookup(ref))).join(' + ');
  const n = conceptName(med.code);
  if (!n) throw new Excluded(`Medication/${med.id} has no name`);
  return n;
}

export const medicationName = (ctx: Ctx, med: Res): string => medicationNameWith(ref => resolve(ctx, ref), med);

/** Medication refs a name depends on: the product and, for a mix, its ingredients. */
export function medicationRefs(ctx: Ctx, ref: string): string[] {
  const med = resolve(ctx, ref);
  return [ref, ...get(med, 'ingredient.itemReference.reference').map(x => str(x)!).flatMap(r => medicationRefs(ctx, r))];
}

/** Drug name of an order, administration or dispensing: the inline concept's name, else the referenced Medication's name. */
export function drugNameWith(lookup: Resolver, r: Res): string {
  const cc = r.medicationCodeableConcept;
  if (cc !== undefined) {
    const n = conceptName(cc);
    if (!n) throw new Excluded(`${refOf(r)} has an unnamed medication`);
    return n;
  }
  const ref = refText(r.medicationReference);
  if (!ref) throw new Excluded(`${refOf(r)} has no medication`);
  return medicationNameWith(lookup, lookup(ref));
}

export const drugName = (ctx: Ctx, r: Res): string => drugNameWith(ref => resolve(ctx, ref), r);

export function drugDepends(ctx: Ctx, r: Res): string[] {
  const ref = refStr(r.medicationReference);
  return ref ? medicationRefs(ctx, ref) : [];
}

// ---- Result builders ------------------------------------------------------------------------------------------

function valueResult(form: AnswerForm, item: GoldItem, depends: Res[] | Ref[], notes: string[], timestamp = item.time): GoldCore {
  const deps = depends.map(d => (typeof d === 'string' ? d : refOf(d)));
  if (item.value === null) {
    return { answer_form: form, answer_kind: 'none', answer: null, answer_list: null, value_as_recorded: null, unit: null, timestamp: null,
      items: [item], provenance: [item.ref], depends_on: uniqSorted(deps), rule_notes: [...notes, 'gold is an explicit none'] };
  }
  return {
    answer_form: form, answer_kind: 'value', answer: item.value, answer_list: null, value_as_recorded: item.value_as_recorded,
    unit: item.unit, timestamp, items: [item], provenance: [item.ref], depends_on: uniqSorted(deps), rule_notes: notes,
  };
}

/** G-R2: one item per record tied at the latest instant; answer fields are read from the first. */
function latestValueResult(tied: Res[], toItem: (r: Res) => GoldItem, depends: Res[] | Ref[], notes: string[]): GoldCore {
  const items = tied.map(toItem);
  return { ...valueResult('value', items[0]!, depends, notes), items, provenance: uniqSorted(items.map(i => i.ref)) };
}

function listResult(names: string[], items: GoldItem[], provenance: Ref[], depends: Ref[], notes: string[] = []): GoldCore {
  const list = uniqSorted(names);
  return {
    answer_form: 'list', answer_kind: list.length === 0 ? 'none' : 'list', answer: null, answer_list: list.length === 0 ? null : list,
    value_as_recorded: null, unit: null, timestamp: null, items, provenance: uniqSorted(provenance), depends_on: uniqSorted(depends),
    rule_notes: list.length === 0 ? [...notes, 'gold is an explicit none'] : notes,
  };
}

function countResult(records: Res[], item: (r: Res) => GoldItem, notes: string[] = []): GoldCore {
  const refs = records.map(refOf);
  return {
    answer_form: 'count', answer_kind: 'value', answer: String(records.length), answer_list: null, value_as_recorded: null, unit: null,
    timestamp: null, items: records.map(item), provenance: uniqSorted(refs), depends_on: uniqSorted(refs), rule_notes: notes,
  };
}

/** `tied` (G-R2): every record at the answer's instant is an item, each with its own recorded time. */
function datetimeResult(r: Res, time: string, depends: Res[], display: string | null, notes: string[] = [], tied: { r: Res; time: string }[] = [{ r, time }]): GoldCore {
  return {
    answer_form: 'datetime', answer_kind: 'value', answer: time, answer_list: null, value_as_recorded: null, unit: null, timestamp: time,
    items: tied.map(x => goldItem(x.r, null, x.time, display)), provenance: uniqSorted(tied.map(x => refOf(x.r))), depends_on: uniqSorted(depends.map(refOf)), rule_notes: notes,
  };
}

const obsItem = (r: Res) => goldItem(r, obsValue(r), obsTime(r), ccName(r.code));
const inWindow = (t: string | null, a: string, b: string) => t !== null && compareInstant(t, a) >= 0 && compareInstant(t, b) < 0;

/** Hours between two instants, two decimals, rounded half up. */
export function hoursBetween(start: string, end: string): string {
  const ms = BigInt(instantMs(end) - instantMs(start));
  if (ms < 0n) throw new Excluded('period ends before it starts');
  const hundredths = (ms * 100n * 2n + 3_600_000n) / (2n * 3_600_000n);
  const s = hundredths.toString().padStart(3, '0');
  return canonicalDecimal(`${s.slice(0, -2)}.${s.slice(-2)}`);
}

/** Synthea note sections: items in "Patient has a history of A, B." and "Patient is presenting with A, B." */
export function noteConditions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/Patient (?:has a history of|is presenting with) ([^\n]*?)\.(?:\s|$)/g)) {
    out.push(...m[1]!.split(', ').map(s => s.trim()).filter(Boolean));
  }
  return out;
}

export function noteText(doc: Res): string {
  const data = getStr(doc, 'content.attachment.data');
  if (!data) throw new Excluded(`${refOf(doc)} has no inline note`);
  return Buffer.from(data, 'base64').toString('utf8');
}

/** K2 entries of one CareTeam: "<member display> (<role>)" per participant, the reference when there is no display. */
export function careTeamEntries(team: Res): string[] {
  return get(team, 'participant').filter(isObj).map(pt => `${getStr(pt, 'member.display') ?? refText(pt.member) ?? 'unknown'} (${conceptName(get1(pt, 'role')) ?? 'no role'})`);
}

/** O2 item display: the route of an order's first dosage instruction. */
export const orderRoute = (r: Res): string | null => conceptName(get1(r, 'dosageInstruction.route'));

/** C1 item display: the first coding's code. */
export const firstCode = (cc: unknown): string | null => codings(cc)[0]?.code ?? null;

/** E1 item display: the encounter class code. */
export const encounterClass = (r: Res): string | null => (typeof r.class === 'string' ? r.class : getStr(r, 'class.code'));

/**
 * B1 entry of one organism record: "<organism> (<specimen type>)", from the first derivedFrom record that is a
 * microbiology test whose Specimen was collected on `date` (UTC). `find` returns a referenced record or undefined.
 * null when no such test is found.
 */
export function microOrganismEntry(org: Res, find: (ref: string) => Res | undefined, date: string): string | null {
  for (const ref of get(org, 'derivedFrom').map(x => refText(x)).filter((x): x is string => !!x)) {
    const test = find(ref);
    if (!test || test.resourceType !== 'Observation' || !isMicroTest(test)) continue;
    const specRef = refText(test.specimen);
    const spec = specRef ? find(specRef) : undefined;
    const t = spec && spec.resourceType === 'Specimen' ? getStr(spec, 'collection.collectedDateTime') : null;
    if (!spec || t === null || utcDate(t) !== date) continue;
    return `${conceptName(org.code)} (${conceptName(spec.type)})`;
  }
  return null;
}

/** F1: a claim's total (Money: value, currency as the unit). */
export function claimTotal(c: Res): ValueInfo {
  const total = get1(c, 'total');
  return quantityInfo(isObj(total) ? { value: total.value, unit: total.currency } : null);
}

/** L9: the record states a dataAbsentReason and carries no value[x]. */
export const recordedAbsent = (r: Res): boolean => r.dataAbsentReason !== undefined && obsValue(r).kind === 'none';

/** E3 answer: hours from period.start to period.end of a stay. */
export function stayHours(enc: Res): string {
  const start = getStr(enc, 'period.start'), end = getStr(enc, 'period.end');
  if (!start || !end) throw new Excluded('open period');
  return hoursBetween(start, end);
}

/** E4 entries: the names of an encounter's reasonCode concepts. */
export const encounterReasons = (enc: Res): string[] => get(enc, 'reasonCode').map(cc => conceptName(cc)).filter((x): x is string => !!x);

/** K1 entries: the names of a care plan's activity.detail.code concepts. */
export const carePlanActivities = (plan: Res): string[] => get(plan, 'activity.detail.code').map(cc => conceptName(cc)).filter((x): x is string => !!x);

/** M1 entries: "<modality> | <body site>" per series of an imaging study. */
export const imagingSeriesPairs = (s: Res): string[] => get(s, 'series').filter(isObj).map(se => {
  const modality = typeof se.modality === 'string' ? se.modality : getStr(se, 'modality.display') ?? getStr(se, 'modality.code');
  const site = typeof se.bodySite === 'string' ? se.bodySite : getStr(se, 'bodySite.display') ?? getStr(se, 'bodySite.code') ?? 'none';
  return `${modality} | ${site}`;
});

/** M2 entries: "instances: <n>" and "series: <m>", counted from the series and instance arrays. */
export function imagingCounts(s: Res): string[] {
  const series = get(s, 'series').filter(isObj);
  const instances = series.reduce((n, se) => n + get(se, 'instance').length, 0);
  return [`instances: ${instances}`, `series: ${series.length}`];
}

/** D1 entries: "birth_date: ...", "deceased: <date>|yes|alive", "gender: ...". */
export function demographicEntries(pt: Res): string[] {
  const deceased = getStr(pt, 'deceasedDateTime') ?? (pt.deceasedBoolean === true ? 'yes' : 'alive');
  return [`birth_date: ${str(pt.birthDate) ?? 'unknown'}`, `deceased: ${deceased}`, `gender: ${str(pt.gender) ?? 'unknown'}`];
}

/** LS1 entries of one record: system|code of every coding in the type's code element. */
export const llCodeEntries = (r: Res, field: string): string[] => elementCodings(r, field).map(c => `${c.system}|${c.code}`);

const encStart = (r: Res) => getStr(r, 'period.start');
const procTime = (r: Res) => getStr(r, 'performedDateTime') ?? getStr(r, 'performedPeriod.start');
const maTime = (r: Res) => getStr(r, 'effectiveDateTime') ?? getStr(r, 'effectivePeriod.start');
const statusIs = (cc: unknown, code: string) => codings(cc).some(c => c.code === code);

// ---- Rules by template ----------------------------------------------------------------------------------------

type Rule = (p: Record<string, string>, ctx: Ctx) => GoldCore;

const labRecords = (p: Record<string, string>, ctx: Ctx) => byCoding(ctx, 'Observation', 'code', p);

const RULES: Record<string, Rule> = {
  // Latest value, unit and time of lab X.
  L1: (p, ctx) => {
    const recs = labRecords(p, ctx);
    const { r, tied, notes } = latest(recs, obsTime, obsValue);
    if (obsValue(r).kind !== 'quantity') throw new Excluded('latest record is not numeric');
    return latestValueResult(tied, obsItem, recs, notes);
  },
  // All values of lab X in [window_start, window_end).
  L2: (p, ctx) => windowRule(p, ctx),
  L5: (p, ctx) => windowRule(p, ctx),
  // Total count of lab X results.
  L3: (p, ctx) => countResult(labRecords(p, ctx), obsItem),
  // Heart-rate measurements during ICU stay E.
  L4: (p, ctx) => countResult(labRecords(p, ctx).filter(r => refStr(r.encounter) === p.encounter), obsItem),
  // Value and the record's own unit of a named record; also L9 (absent value) and O4 (dose of a named order).
  L6: (p, ctx) => {
    const r = resolve(ctx, p.record!);
    const v = obsValue(r);
    if (v.kind !== 'quantity') throw new Excluded('record is not numeric');
    return valueResult('value', obsItem(r), [r], []);
  },
  // Latest non-numeric result of test X.
  L7: (p, ctx) => {
    const recs = labRecords(p, ctx);
    const { r, tied, notes } = latest(recs, obsTime, obsValue);
    const v = obsValue(r);
    if (v.kind !== 'string' && v.kind !== 'concept') throw new Excluded('latest record is numeric or empty');
    return latestValueResult(tied, obsItem, recs, [...notes, 'text value as recorded, whitespace included']);
  },
  // Latest systolic and diastolic blood pressure (panel with both components valued).
  L8: (p, ctx) => {
    const comp = (r: Res, code: string) => quantityInfo(get1(get(r, 'component').find(c => hasCoding(get1(c, 'code'), LOINC, code)), 'valueQuantity'));
    const panels = labRecords(p, ctx).filter(r => comp(r, SYSTOLIC).kind === 'quantity' && comp(r, DIASTOLIC).kind === 'quantity');
    const pair = (r: Res): ValueInfo => {
      const s = comp(r, SYSTOLIC), d = comp(r, DIASTOLIC);
      return { ...s, value: `${s.value}/${d.value}`, recorded: `${s.recorded}/${d.recorded}`, unit: s.unit === d.unit ? s.unit : `${s.unit}/${d.unit}` };
    };
    const { r, tied, notes } = latest(panels, obsTime, pair);
    const v = pair(r), t = obsTime(r);
    return {
      answer_form: 'value', answer_kind: 'value', answer: v.value, answer_list: null, value_as_recorded: v.recorded, unit: v.unit, timestamp: t,
      items: tied.flatMap(x => [goldItem(x, comp(x, SYSTOLIC), obsTime(x), 'systolic'), goldItem(x, comp(x, DIASTOLIC), obsTime(x), 'diastolic')]),
      provenance: uniqSorted(tied.map(refOf)),
      depends_on: uniqSorted(panels.map(refOf)), rule_notes: [...notes, 'answer is "<systolic>/<diastolic>"; items carry each component'],
    };
  },
  // A vital sign recorded with dataAbsentReason: gold is "not recorded".
  L9: (p, ctx) => {
    const r = resolve(ctx, p.record!);
    if (!recordedAbsent(r)) throw new Excluded('record has a value');
    return valueResult('value', goldItem(r, null, obsTime(r), ccName(r.code)), [r], [`dataAbsentReason: ${ccName(r.dataAbsentReason)}`]);
  },
  // Latest survey score.
  L10: (p, ctx) => {
    const recs = labRecords(p, ctx);
    const { r, tied, notes } = latest(recs, obsTime, obsValue);
    if (obsValue(r).kind !== 'quantity') throw new Excluded('latest record is not numeric');
    return latestValueResult(tied, obsItem, recs, notes);
  },

  // Drugs administered during stay E (MIMIC G1, Synthea O3).
  G1: (p, ctx) => administeredDuring(p, ctx),
  O3: (p, ctx) => administeredDuring(p, ctx),
  // Time and dose of the last administration of drug X.
  G2: (p, ctx) => {
    const recs = byCoding(ctx, 'MedicationAdministration', 'medicationCodeableConcept', p);
    const dose = (r: Res) => quantityInfo(get1(r, 'dosage.dose'));
    const { r, tied, notes } = latest(recs, maTime, dose);
    if (dose(r).value === null) throw new Excluded('last administration has no dose');
    return latestValueResult(tied, x => goldItem(x, dose(x), maTime(x), drugName(ctx, x)), recs, notes);
  },
  // Number of dispensings of drug X.
  G3: (p, ctx) => countResult(byCoding(ctx, 'MedicationDispense', 'medicationCodeableConcept', p),
    r => goldItem(r, null, getStr(r, 'whenHandedOver') ?? getStr(r, 'whenPrepared'), drugName(ctx, r))),

  // Drug names of the orders placed during stay E (MIMIC, via Medication names).
  O1: (p, ctx) => {
    const recs = p.encounter
      ? ctx.data.of('MedicationRequest').filter(r => refStr(r.encounter) === p.encounter)
      : ctx.data.of('MedicationRequest').filter(r => str(r.status) === 'active'); // Synthea O1: active orders
    const items = recs.map(r => goldItem(r, null, getStr(r, 'authoredOn'), drugName(ctx, r)));
    return listResult(items.map(i => i.display!), items, recs.map(refOf), [...recs.map(refOf), ...recs.flatMap(r => drugDepends(ctx, r))],
      p.encounter ? [] : ['status filter is literal: status = active']);
  },
  // Dose and route of the most recent order for drug X.
  O2: (p, ctx) => {
    const recs = ctx.data.of('MedicationRequest').filter(r => p.medication
      ? refStr(r.medicationReference) === p.medication
      : hasCoding(r.medicationCodeableConcept, p.code_system!, p.code!));
    const dose = (r: Res) => quantityInfo(get1(r, 'dosageInstruction.doseAndRate.doseQuantity'));
    const route = orderRoute;
    const { r, tied, notes } = latest(recs, x => getStr(x, 'authoredOn'), x => ({ ...dose(x), unit: `${dose(x).unit}|${route(x)}` }));
    if (dose(r).value === null) throw new Excluded('latest order has no dose');
    // O2 ruling: the Medication the orders reference (with a mix's ingredients, which name it) is in depends_on; the route
    // is answered in answer_list as "route: <route>".
    const core = latestValueResult(tied, x => goldItem(x, dose(x), getStr(x, 'authoredOn'), route(x)),
      [...recs.map(refOf), ...(p.medication ? medicationRefs(ctx, p.medication) : [])], [...notes, 'item display is the route']);
    return { ...core, answer_list: route(r) ? [`route: ${route(r)}`] : null };
  },
  // Dose of a named order (Synthea).
  O4: (p, ctx) => {
    const r = resolve(ctx, p.record!);
    const item = goldItem(r, quantityInfo(get1(r, 'dosageInstruction.doseAndRate.doseQuantity')), getStr(r, 'authoredOn'), drugName(ctx, r));
    if (item.value === null) throw new Excluded('order has no dose');
    return valueResult('value', item, [r], []);
  },

  // Organisms grown from specimens collected on date D (UTC), with the specimen type.
  B1: (p, ctx) => {
    const specimens = ctx.data.of('Specimen').filter(s => { const t = getStr(s, 'collection.collectedDateTime'); return t !== null && utcDate(t) === p.date; });
    const specRefs = new Set(specimens.map(refOf));
    const tests = ctx.data.of('Observation').filter(o => isMicroTest(o) && specRefs.has(refStr(o.specimen) ?? ''));
    const testRefs = new Set(tests.map(refOf));
    const orgs = ctx.data.of('Observation').filter(o => isMicroOrg(o) && get(o, 'derivedFrom.reference').some(x => testRefs.has(str(x) ?? '')));
    const items = orgs.map(o => goldItem(o, null, obsTime(o), microOrganismEntry(o, ref => ctx.data.byRef.get(ref), p.date!)));
    return listResult(items.map(i => i.display!), items, orgs.map(refOf), [...specimens, ...tests, ...orgs].map(refOf),
      ['entries are "<organism> (<specimen type>)"']);
  },
  // Antibiotics to which organism Y (one organism record) was resistant.
  B2: (p, ctx) => {
    const susc = ctx.data.of('Observation').filter(o => isMicroSusc(o) && get(o, 'derivedFrom.reference').some(x => str(x) === p.record));
    const resistant = susc.filter(o => codings(o.valueCodeableConcept).some(c => c.code === 'R'));
    const items = resistant.map(o => goldItem(o, obsValue(o), obsTime(o), ccName(o.code)));
    // The organism record is the question's given (named by the plan's derived-from), not something to retrieve.
    return listResult(items.map(i => i.display!), items, resistant.map(refOf), susc.map(refOf),
      ['resistant means interpretation code R']);
  },

  // Distinct diagnosis codes for stay E.
  C1: (p, ctx) => {
    const recs = ctx.data.of('Condition').filter(r => refStr(r.encounter) === p.encounter);
    const items = recs.map(r => goldItem(r, null, null, firstCode(r.code)));
    return listResult(items.map(i => i.display!).filter(Boolean), items, recs.map(refOf), recs.map(refOf), ['entries are diagnosis codes']);
  },
  // Has the patient ever had diagnosis X?
  C2: (p, ctx) => {
    const recs = byCoding(ctx, 'Condition', 'code', p);
    const refs = recs.map(refOf);
    return {
      answer_form: 'yes_no', answer_kind: 'value', answer: recs.length > 0 ? 'yes' : 'no', answer_list: null, value_as_recorded: null,
      unit: null, timestamp: null, items: recs.map(r => goldItem(r, null, null, ccName(r.code))), provenance: uniqSorted(refs),
      depends_on: uniqSorted(refs), rule_notes: recs.length > 0 ? [] : ['no Condition carries this coding'],
    };
  },
  // Active conditions (Synthea; literal clinicalStatus = active).
  C3: (_p, ctx) => {
    const recs = ctx.data.of('Condition').filter(r => statusIs(r.clinicalStatus, 'active'));
    const items = recs.map(r => goldItem(r, null, getStr(r, 'onsetDateTime'), ccName(r.code)));
    return listResult(items.map(i => i.display!), items, recs.map(refOf), recs.map(refOf), ['status filter is literal: clinicalStatus = active']);
  },

  // Procedures during stay E.
  P1: (p, ctx) => {
    const recs = ctx.data.of('Procedure').filter(r => refStr(r.encounter) === p.encounter);
    const items = recs.map(r => goldItem(r, null, procTime(r), ccName(r.code)));
    return listResult(items.map(i => i.display!), items, recs.map(refOf), recs.map(refOf));
  },
  // Date of the first procedure X.
  P2: (p, ctx) => {
    const recs = byCoding(ctx, 'Procedure', 'code', p);
    const r = earliest(recs, procTime);
    return datetimeResult(r, procTime(r)!, recs, ccName(r.code));
  },

  // Number of encounters by class.
  E1: (_p, ctx) => {
    const recs = ctx.data.of('Encounter');
    const counts = new Map<string, number>();
    for (const r of recs) { const c = encounterClass(r) ?? 'none'; counts.set(c, (counts.get(c) ?? 0) + 1); }
    const items = recs.map(r => goldItem(r, null, encStart(r), encounterClass(r)));
    // E1 ruling: the answer is the total; answer_list is the per-class breakdown.
    const core = listResult([...counts].map(([c, n]) => `${c}: ${n}`), items, recs.map(refOf), recs.map(refOf), ['answer is the total; entries are "<class code>: <count>"']);
    return recs.length > 0 ? { ...core, answer: String(recs.length) } : core;
  },
  // Care unit (Location name) of ICU stay E.
  E2: (p, ctx) => {
    const enc = resolve(ctx, p.encounter!);
    // E2 ruling: the items are the Locations (only Location.name carries the unit name); the Encounter stays in depends_on.
    // An item's time must be one its own record carries (scoring checks it on the returned copy); a Location has none,
    // so the stay start (on the Encounter) is not put on the item.
    const entries = get(enc, 'location').filter(isObj).map(l => ({ ref: refStr(l.location), start: getStr(l, 'period.start') })).filter(e => e.ref);
    const locRefs = entries.map(e => e.ref!);
    const locs = entries.map(e => ({ rec: resolve(ctx, e.ref!), start: e.start }));
    const names = locs.map(l => str(l.rec.name)).filter((x): x is string => !!x);
    return listResult(names, locs.map(l => goldItem(l.rec, null, null, str(l.rec.name))), [p.encounter!, ...locRefs], [p.encounter!, ...locRefs],
      ['items are the Locations; untimed, because a Location carries no time']);
  },
  // Length of stay E in hours.
  E3: (p, ctx) => {
    const enc = resolve(ctx, p.encounter!);
    const h = stayHours(enc);
    const item: GoldItem = { ref: refOf(enc), value: h, value_as_recorded: null, unit: 'h', unit_code: 'h', unit_system: null, time: getStr(enc, 'period.start'), display: null };
    return { ...valueResult('value', item, [enc], ['hours from period.start to period.end, two decimals, half up']), value_as_recorded: null };
  },
  // Reason for the encounter on date D (Synthea).
  E4: (p, ctx) => {
    const encs = encountersOn(ctx, p.date!);
    if (encs.length !== 1) throw new Excluded('not exactly one encounter on that date');
    const enc = encs[0]!;
    const names = encounterReasons(enc);
    return listResult(names, [goldItem(enc, null, encStart(enc), names.join('; '))], [refOf(enc)], ctx.data.of('Encounter').filter(e => overlapsDay(e, p.date!)).map(refOf));
  },
  // Date of the last encounter of type X.
  E5: (p, ctx) => {
    const recs = byCoding(ctx, 'Encounter', 'type', p);
    const { r, tied, notes } = latest(recs, encStart, () => none());
    return datetimeResult(r, encStart(r)!, recs, ccName(get1(r, 'type')), notes, tied.map(x => ({ r: x, time: encStart(x)! })));
  },

  // Total of the claim for encounter E.
  F1: (p, ctx) => {
    const claims = ctx.data.of('Claim').filter(c => get(c, 'item.encounter.reference').some(x => str(x) === p.encounter));
    if (claims.length !== 1) throw new Excluded('not exactly one claim for the encounter');
    const c = claims[0]!;
    const v = claimTotal(c);
    return valueResult('value', goldItem(c, v, getStr(c, 'created'), null), [c], ['unit is total.currency']);
  },
  // Number of claims created in UTC year Y.
  F2: (p, ctx) => countResult(ctx.data.of('Claim').filter(c => { const t = getStr(c, 'created'); return t !== null && utcDate(t).slice(0, 4) === p.year; }),
    c => goldItem(c, null, getStr(c, 'created'), null), ['year is the UTC calendar year of Claim.created']),
  // Payment amount on the benefit for claim C.
  F3: (p, ctx) => {
    const eobs = ctx.data.of('ExplanationOfBenefit').filter(e => refStr(e.claim) === p.claim);
    if (eobs.length !== 1) throw new Excluded('not exactly one ExplanationOfBenefit for the claim');
    const e = eobs[0]!;
    const amt = get1(e, 'payment.amount');
    const v = quantityInfo(isObj(amt) ? { value: amt.value, unit: amt.currency } : null);
    if (v.value === null) throw new Excluded('no payment amount');
    return valueResult('value', goldItem(e, v, getStr(e, 'created'), null), [e], ['unit is payment.amount.currency']);
  },

  // Number of clinical notes.
  N1: (_p, ctx) => countResult(ctx.data.of('DocumentReference'), r => goldItem(r, null, getStr(r, 'date'), ccName(r.type))),
  // Conditions listed in the most recent note's text.
  N2: (_p, ctx) => {
    const docs = ctx.data.of('DocumentReference');
    const { r, tied, notes } = latest(docs, d => getStr(d, 'date'), d => ({ ...none(), recorded: noteText(d) }));
    const names = noteConditions(noteText(r));
    return listResult(names, tied.map(d => goldItem(d, null, getStr(d, 'date'), null)), tied.map(refOf), docs.map(refOf),
      [...notes, 'items of "Patient has a history of ..." and "Patient is presenting with ...", split on ", "']);
  },
  // Result names in the most recent lab report.
  N3: (p, ctx) => {
    const reports = ctx.data.of('DiagnosticReport').filter(r => hasCoding(get1(r, 'category'), p.code_system!, p.code!));
    const { r, tied, notes } = latest(reports, d => getStr(d, 'effectiveDateTime'), d => ({ ...none(), recorded: get(d, 'result.reference').join(',') }));
    const results = get(r, 'result.reference').map(x => resolve(ctx, str(x)!));
    const items = results.map(o => goldItem(o, null, obsTime(o), ccName(o.code)));
    return listResult(items.map(i => i.display!), items, [...tied.map(refOf), ...results.map(refOf)], [...reports.map(refOf), ...results.map(refOf)], notes);
  },

  // Number of immunizations.
  I1: (_p, ctx) => countResult(ctx.data.of('Immunization'), r => goldItem(r, null, getStr(r, 'occurrenceDateTime'), ccName(r.vaccineCode))),
  // Date of the last dose of vaccine X.
  I2: (p, ctx) => {
    const recs = byCoding(ctx, 'Immunization', 'vaccineCode', p);
    const { r, tied, notes } = latest(recs, x => getStr(x, 'occurrenceDateTime'), () => none());
    return datetimeResult(r, getStr(r, 'occurrenceDateTime')!, recs, ccName(r.vaccineCode), notes, tied.map(x => ({ r: x, time: getStr(x, 'occurrenceDateTime')! })));
  },
  // Recorded allergies, or none.
  A1: (_p, ctx) => {
    const recs = ctx.data.of('AllergyIntolerance');
    const items = recs.map(r => goldItem(r, null, getStr(r, 'recordedDate'), ccName(r.code)));
    return listResult(items.map(i => i.display!), items, recs.map(refOf), recs.map(refOf));
  },
  // Activities of the active care plan (one active plan per category).
  K1: (p, ctx) => {
    const plan = resolve(ctx, p.record!);
    if (str(plan.status) !== 'active') throw new Excluded('plan not active');
    const names = carePlanActivities(plan);
    const active = ctx.data.of('CarePlan').filter(c => str(c.status) === 'active');
    return listResult(names, [goldItem(plan, null, getStr(plan, 'period.start'), p.display ?? null)], [refOf(plan)], active.map(refOf),
      ['distinct activity.detail.code names']);
  },
  // Members and roles of the care team.
  K2: (p, ctx) => {
    const team = resolve(ctx, p.record!);
    return listResult(careTeamEntries(team), [goldItem(team, null, getStr(team, 'period.start'), null)], [refOf(team)], [refOf(team)],
      ['entries are "<member display> (<role>)"; member names come from reference displays (shared Practitioner files not loaded)']);
  },
  // Modality and body site of the most recent imaging study.
  M1: (_p, ctx) => {
    const studies = ctx.data.of('ImagingStudy');
    const pairs = imagingSeriesPairs;
    const { r, tied, notes } = latest(studies, s => getStr(s, 'started'), s => ({ ...none(), recorded: sortBytes(pairs(s)).join(',') }));
    return listResult(pairs(r), tied.map(s => goldItem(s, null, getStr(s, 'started'), null)), tied.map(refOf), studies.map(refOf),
      [...notes, 'entries are "<modality> | <body site>" per series']);
  },
  // Number of series and instances in study S.
  M2: (p, ctx) => {
    const s = resolve(ctx, p.record!);
    const series = get(s, 'series').filter(isObj);
    const instances = series.reduce((n, se) => n + get(se, 'instance').length, 0);
    const notes: string[] = ['counted from the series and instance arrays'];
    if (str(s.numberOfSeries) !== String(series.length) || str(s.numberOfInstances) !== String(instances)) notes.push('recorded numberOfSeries/numberOfInstances differ from the arrays');
    return listResult(imagingCounts(s), [goldItem(s, null, getStr(s, 'started'), null)], [refOf(s)], [refOf(s)], notes);
  },
  // Device types recorded for the patient.
  V1: (_p, ctx) => {
    const recs = ctx.data.of('Device');
    const items = recs.map(r => goldItem(r, null, null, ccName(r.type)));
    return listResult(items.map(i => i.display!).filter(Boolean), items, recs.map(refOf), recs.map(refOf));
  },
  // Long-list stratum. The set is every record of one type, optionally narrowed by a token
  // (any coding) and a half-open window on the type's dateTime element.
  // LS1: the distinct system|code pairs in the type's code element across the set.
  LS1: (p, ctx) => {
    const { t, recs, notes } = llSet(p, ctx);
    const time = (r: Res) => (t.date ? getStr(r, t.date.element) : null);
    const codes = recs.flatMap(r => llCodeEntries(r, t.code.field));
    if (codes.length === 0) throw new Excluded('no coded record in the set');
    const items = recs.map(r => goldItem(r, null, time(r), null));
    return listResult(codes, items, recs.map(refOf), recs.map(refOf), [...notes, `entries are system|code from ${t.code.field}, every coding counted`]);
  },
  // LS2: the largest recorded value across the set (Observation valueQuantity of one code, or Claim total), one unit.
  LS2: (p, ctx) => {
    const { t, recs, notes } = llSet(p, ctx);
    const value = (r: Res): ValueInfo => (p.value_kind === 'claim'
      ? quantityInfo(isObj(r.total) ? { value: r.total.value, unit: r.total.currency } : null)
      : quantityInfo(r.valueQuantity));
    const time = (r: Res) => (t.date ? getStr(r, t.date.element) : null);
    const vals = recs.map(r => ({ r, v: value(r) }));
    if (vals.some(x => x.v.kind !== 'quantity' || /^[<>]/.test(x.v.recorded!))) throw new Excluded('a record has no plain numeric value');
    if (new Set(vals.map(x => x.v.unit)).size !== 1) throw new Excluded('values carry more than one unit');
    const max = vals.reduce((m, x) => (compareDecimal(x.v.value!, m.v.value!) > 0 ? x : m));
    const tied = vals.filter(x => compareDecimal(x.v.value!, max.v.value!) === 0).sort((a, b) => byteCompare(a.r.id, b.r.id));
    if (new Set(tied.map(x => x.v.recorded)).size !== 1) throw new Excluded('maximum recorded with differing text');
    const items = tied.map(x => goldItem(x.r, x.v, time(x.r), null));
    return {
      answer_form: 'value', answer_kind: 'value', answer: max.v.value, answer_list: null, value_as_recorded: tied[0]!.v.recorded,
      unit: max.v.unit, timestamp: tied.length === 1 ? items[0]!.time : null, items, provenance: uniqSorted(tied.map(x => refOf(x.r))),
      depends_on: uniqSorted(recs.map(refOf)), rule_notes: [...notes, 'maximum by decimal value; every record holding it is an item', p.value_kind === 'claim' ? 'unit is total.currency' : 'unit is the record unit'],
    };
  },
  // Decimal stratum: net amount of one line (by sequence) of claim C, named by its product or service.
  CL1: (p, ctx) => {
    const c = resolve(ctx, p.claim!);
    const items = get(c, 'item').filter(isObj);
    const line = items.find(i => str(i.sequence) === p.item_sequence);
    if (!line) throw new Excluded('no such claim line');
    const name = ccName(line.productOrService);
    if (!name || items.filter(i => ccName(i.productOrService) === name).length !== 1) throw new Excluded('line name not unique on the claim');
    const net = line.net;
    const v = quantityInfo(isObj(net) ? { value: net.value, unit: net.currency } : null);
    if (v.value === null) throw new Excluded('line has no net amount');
    return valueResult('value', goldItem(c, v, getStr(c, 'created'), name), [c], ['unit is item.net.currency', 'line chosen by item.sequence; named by productOrService']);
  },
  // Birth date, sex, and date of death or alive.
  D1: (_p, ctx) => {
    const pt = ctx.data.patient;
    return listResult(demographicEntries(pt), [goldItem(pt, null, null, null)], [refOf(pt)], [refOf(pt)], ['entries are "birth_date: ...", "deceased: <date>|alive", "gender: ..."']);
  },
};

function windowRule(p: Record<string, string>, ctx: Ctx): GoldCore {
  const all = labRecords(p, ctx);
  const recs = all.filter(r => inWindow(obsTime(r), p.window_start!, p.window_end!))
    .sort((a, b) => compareInstant(obsTime(a)!, obsTime(b)!) || byteCompare(a.id, b.id));
  const items = recs.map(obsItem);
  const list = items.map(i => `${i.value ?? 'none'} ${i.unit ?? ''} @ ${i.time}`.replace('  ', ' '));
  const refs = recs.map(refOf);
  return {
    answer_form: 'list', answer_kind: list.length ? 'list' : 'none', answer: null, answer_list: list.length ? sortBytes(list) : null,
    value_as_recorded: null, unit: null, timestamp: null, items, provenance: uniqSorted(refs), depends_on: uniqSorted(refs),
    rule_notes: ['window is half-open [window_start, window_end)', 'entries are "<value> <unit> @ <time>"'],
  };
}

/** The record set a long-list question is about. A window question is excluded when a matching record lacks a full
 * dateTime in the window element: the date search could still match it (a Period, a coarser precision). */
function llSet(p: Record<string, string>, ctx: Ctx): { t: ReturnType<typeof llType>; recs: Res[]; notes: string[] } {
  const t = llType(p.resource_type!);
  const token = p.search_param ? llToken(t.type, p.search_param) : null;
  const all = ctx.data.of(t.type).filter(r => !token || tokenMatches(r, token, p.code_system!, p.code!));
  const notes = token ? [`token ${token.param} matches any coding with the stated system and code`] : [];
  if (p.window_start === undefined) return { t, recs: all, notes };
  if (!t.date) throw new Error(`${t.type} has no window element`);
  const date = t.date;
  if (all.some(r => llDate(r, date) === null)) throw new Excluded('matching record without a full dateTime in the window element');
  notes.push(`window is half-open [window_start, window_end) on ${date.element}`);
  return { t, recs: all.filter(r => inLLWindow(llDate(r, date)!, p.window_start!, p.window_end!)), notes };
}

function administeredDuring(p: Record<string, string>, ctx: Ctx): GoldCore {
  const recs = ctx.data.of('MedicationAdministration').filter(r => encounterOf(r) === p.encounter);
  const items = recs.map(r => goldItem(r, quantityInfo(get1(r, 'dosage.dose')), maTime(r), drugName(ctx, r)));
  return listResult(items.map(i => i.display!), items, recs.map(refOf), [...recs.map(refOf), ...recs.flatMap(r => drugDepends(ctx, r))],
    ['drug name: concept text, else first coding display, else code; Medication name for references']);
}

export const dayBounds = (date: string): [string, string] => {
  const a = `${date}T00:00:00Z`;
  const b = new Date(instantMs(a) + 86_400_000).toISOString().slice(0, 10) + 'T00:00:00Z';
  return [a, b];
};

function overlapsDay(e: Res, date: string): boolean {
  const [a, b] = dayBounds(date);
  const s = getStr(e, 'period.start'), en = getStr(e, 'period.end') ?? s;
  if (!s || !en) return false;
  return compareInstant(s, b) < 0 && compareInstant(en, a) >= 0;
}

export function encountersOn(ctx: Ctx, date: string): Res[] {
  return ctx.data.of('Encounter').filter(e => overlapsDay(e, date));
}

/** Computes the template gold for one question. Throws Excluded or Error. */
/** Decimal-stratum templates reuse a value template's rule unchanged; banded long-list templates (LS1-B3) share one rule
 * per form. */
export const DEC_PREFIX = 'DEC-';
export const ruleId = (templateId: string): string => {
  const id = templateId.startsWith(DEC_PREFIX) ? templateId.slice(DEC_PREFIX.length) : templateId;
  const band = BANDS.find(b => id.endsWith(`-${b.id}`));
  return band ? id.slice(0, -band.id.length - 1) : id;
};

export function computeCore(q: RuleInput, ctx: Ctx): GoldCore {
  const rule = RULES[ruleId(q.template_id)];
  if (!rule) throw new Error(`no gold rule for template ${q.template_id}`);
  if (ctx.data.patientId !== q.patient_id) throw new Error('patient mismatch');
  const core = rule(q.parameters, ctx);
  for (const ref of core.depends_on) if (!ctx.data.byRef.has(ref) && !ctx.shared.byRef.has(ref)) throw new Error(`gold depends on unknown ${ref}`);
  return core;
}

export function lexemeEligible(core: GoldCore): boolean {
  return core.items.some(i => (i.value_as_recorded ?? '').split('/').some(part => lexemeChangedByFloat(part.replace(/^(<=|>=|<|>)/, ''))));
}

export const hasRule = (id: string) => ruleId(id) in RULES;
export { encounterOf, procTime, encStart };

// ---- Answer entries on returned copies (scoring: run/score-lib.ts) ----------------------------------------------

/** A returned copy of a referenced record is missing (scoring only). */
export class MissingCopy extends Error {}

/** The run's returned copies of one record, in call order. */
export type CopyLookup = (ref: string) => Res[];

/** The first returned copy of a referenced record; throws MissingCopy when none came back. */
export function firstCopy(look: CopyLookup, ref: string): Res {
  const c = look(ref)[0];
  if (!c) throw new MissingCopy(ref);
  return c;
}

/**
 * How a template's answer is read from a record, so that scoring can apply the gold rule's own extraction to a returned
 * copy. `from(copy, look, params)` returns the entries the copy yields, or null when it cannot (a referenced record has
 * no returned copy, the rule would exclude it, or a date in the copy does not parse). `from` reads a referenced record
 * through `look(ref)[0]`; answerOptions supplies each returned copy of it in turn. Scopes:
 * - item: each gold item's copy yields [item.display] ([] when the display is null);
 * - question: the item's copy yields the whole gold answer list (`value`: the item's own value instead, for E3);
 * - set: each item's copy yields a subset of the answer list, and together the items yield all of it (LS1).
 */
export interface AnswerEntry {
  scope: 'item' | 'question' | 'set';
  /** Compare with the item's own value ([] when it is null: the copy must carry no value) instead of its display or the list. */
  value?: true;
  /**
   * The record that names the item (E2's Encounter, N3's report): some returned copy of one of `refs` must reference the
   * item, or the item fails. `refs` reads the gold provenance and the question parameters.
   */
  parent?: { refs: (provenance: readonly string[], params: Record<string, string>) => string[]; links: (parent: Res, itemRef: string) => boolean };
  from: (copy: Res, look: CopyLookup, params: Record<string, string>) => string[] | null;
}

const one = (x: string | null): string[] => (x === null ? [] : [x]);
/**
 * The gold reader's value text of an Observation; null when the copy's value would not parse. A compact copy may write
 * valueCodeableConcept as a plain string (its name, as conceptName reads it); raw files never do, so obsValue is unchanged.
 */
const obsEntry = (c: Res): string[] | null => {
  if (typeof c.valueCodeableConcept === 'string' && c.valueQuantity === undefined && str(c.valueString) === null) return one(c.valueCodeableConcept);
  try { return one(obsValue(c).value); } catch { return null; }
};
/** A dataAbsentReason that is present and not empty: an object with at least one property, or a non-empty string. */
const statedReason = (v: unknown): boolean => (typeof v === 'string' ? v.length > 0 : isObj(v) && Object.keys(v).length > 0);
const linksTo = (refs: Json[], itemRef: string) => refs.some(x => { const t = refText(x); return t !== null && refKey(t) === itemRef; });
const drugEntry = (c: Res, look: CopyLookup) => [drugNameWith(ref => firstCopy(look, ref), c)];

export const ANSWER_ENTRIES: Record<string, AnswerEntry> = {
  // item scope: one entry per record, the item's display.
  C1: { scope: 'item', from: c => one(firstCode(c.code)) },
  C3: { scope: 'item', from: c => one(conceptName(c.code)) },
  P1: { scope: 'item', from: c => one(conceptName(c.code)) },
  A1: { scope: 'item', from: c => one(conceptName(c.code)) },
  B2: { scope: 'item', from: c => one(conceptName(c.code)) },
  N3: { scope: 'item', from: c => one(conceptName(c.code)),
    parent: { refs: prov => prov.filter(r => r.startsWith('DiagnosticReport/')), links: (dr, ref) => linksTo(get(dr, 'result'), ref) } },
  V1: { scope: 'item', from: c => one(conceptName(c.type)) },
  // L9: the copy must state the absence (a dataAbsentReason present and not empty, no value[x]); its entry is the item's name.
  L9: { scope: 'item', from: c => {
    let absent: boolean;
    try { absent = recordedAbsent(c); } catch { return null; } // a value the gold reader would not parse is not an absence
    return absent && statedReason(c.dataAbsentReason) ? one(conceptName(c.code)) : null;
  } },
  // the item's own value as the gold reader reads it: text (L7), or for L2 and L5 also a canonical decimal or no value
  L2: { scope: 'item', value: true, from: obsEntry },
  L5: { scope: 'item', value: true, from: obsEntry },
  L7: { scope: 'item', value: true, from: obsEntry },
  F1: { scope: 'item', value: true, from: c => { try { return one(claimTotal(c).value); } catch { return null; } } },
  E1: { scope: 'item', from: c => one(encounterClass(c)) },
  E2: { scope: 'item', from: c => one(str(c.name)),
    parent: { refs: (_prov, p) => [p.encounter!], links: (enc, ref) => linksTo(get(enc, 'location').filter(isObj).map(l => l.location as Json), ref) } },
  O2: { scope: 'item', from: c => one(orderRoute(c)) },
  O1: { scope: 'item', from: drugEntry },
  G1: { scope: 'item', from: drugEntry },
  O3: { scope: 'item', from: drugEntry },
  B1: { scope: 'item', from: (c, look, p) => {
    let e: string | null;
    try { e = microOrganismEntry(c, ref => look(ref)[0], p.date!); } catch (err) {
      if (err instanceof Excluded || err instanceof MissingCopy) throw err;
      return null; // a collection time the gold reader would not parse (no offset, not a date) cannot place the specimen
    }
    return e === null ? null : [e];
  } },
  // question scope: the item's record holds the whole answer.
  N2: { scope: 'question', from: c => { const d = getStr(c, 'content.attachment.data'); return d ? noteConditions(Buffer.from(d, 'base64').toString('utf8')) : null; } },
  K2: { scope: 'question', from: careTeamEntries },
  E4: { scope: 'question', from: encounterReasons },
  K1: { scope: 'question', from: carePlanActivities },
  M1: { scope: 'question', from: imagingSeriesPairs },
  M2: { scope: 'question', from: imagingCounts },
  D1: { scope: 'question', from: demographicEntries },
  E3: { scope: 'question', value: true, from: c => {
    try { return [stayHours(c)]; } catch { return null; } // an open period, or a time the gold reader would not parse
  } },
  // set scope: the answer is the union over the records.
  LS1: { scope: 'set', from: (c, _look, p) => {
    if (!LL_TYPES.some(t => t.type === p.resource_type)) throw new Excluded('question names no long-list type');
    return llCodeEntries(c, llType(p.resource_type!).code.field);
  } },
};

/** Upper bound on the combinations of referenced copies tried for one copy of an item (copies per record are few). */
export const MAX_COPY_COMBINATIONS = 256;

/**
 * Every distinct entry list one copy of an item can yield, trying each returned copy of each referenced record (a
 * Medication and a mix's ingredients, a test Observation and its Specimen) in turn, up to MAX_COPY_COMBINATIONS
 * combinations. A combination that hits a rule exclusion or a referenced record without a copy yields nothing; an
 * empty result means the copy cannot yield the answer. With one copy per record (raw files) there is at most one list.
 */
export function answerOptions(entry: AnswerEntry, copy: Res, look: CopyLookup, params: Record<string, string>): string[][] {
  const out = new Map<string, string[]>();
  const prefix: number[] = [];
  for (let n = 0; n < MAX_COPY_COMBINATIONS; n++) {
    const counts: number[] = [];
    let k = 0;
    const pick: CopyLookup = ref => {
      const cs = look(ref);
      if (cs.length === 0) return [];
      const i = prefix[k] ?? 0;
      prefix[k] = i;
      counts[k++] = cs.length;
      return [cs[i]!];
    };
    try {
      const got = entry.from(copy, pick, params);
      if (got !== null) out.set(JSON.stringify(got), got);
    } catch (e) { if (!(e instanceof Excluded || e instanceof MissingCopy)) throw e; }
    // next combination: advance the last choice that has another copy, and drop the choices made after it
    prefix.length = k;
    let j = k - 1;
    while (j >= 0 && prefix[j]! + 1 >= counts[j]!) j--;
    if (j < 0) break;
    prefix[j] = prefix[j]! + 1;
    prefix.length = j + 1;
  }
  return [...out.values()];
}
