// Long-list stratum (bench/README.md, bench/GOLD-RULINGS.md): the searchable types, their token, code and date elements, the size
// bands and the window rule. General FHIR R4 search parameters only.
import { rankHash } from '../lib/hash.js';
import { codings, get, getStr, instantMs, isObj, str, type Res } from './fhir.js';

/**
 * Size bands of the gold set (records the answer depends on). B1 and B2 are controls; B3 needs at least two pages at the
 * largest page size any arm requests (200) and stays within five; B4 exceeds 20 calls at page size 200, the per-operation
 * per-operation drain cap (run/execute.ts), so every arm is expected to be partial there.
 */
export interface Band { id: string; min: number; max: number; count: number }
export const BANDS: readonly Band[] = [
  { id: 'B1', min: 21, max: 100, count: 10 },
  { id: 'B2', min: 101, max: 200, count: 10 },
  { id: 'B3', min: 201, max: 1000, count: 30 },
  { id: 'B4', min: 4001, max: 10000, count: 10 },
];

export interface LLToken { field: string; param: string; label: string; coding?: true } // coding: the element is a Coding
export interface LLDate { param: string; element: string; label: string }
export interface LLType {
  type: string;
  date: LLDate | null;
  tokens: LLToken[];
  code: { field: string; label: string }; // the element whose distinct codes LS1 asks for
}

const code: LLToken = { field: 'code', param: 'code', label: 'code' };
const category: LLToken = { field: 'category', param: 'category', label: 'category' };
const medCode: LLToken = { field: 'medicationCodeableConcept', param: 'code', label: 'medication code' };
const typeTok: LLToken = { field: 'type', param: 'type', label: 'type' };

/**
 * Patient-linked types, in a fixed order. `date` names a dateTime element and the R4 search parameter over it; types whose
 * date parameter covers a Period (Encounter) or an age/range choice (Condition) get no window.
 */
export const LL_TYPES: LLType[] = [
  { type: 'Observation', date: { param: 'date', element: 'effectiveDateTime', label: 'effective time' }, tokens: [code, category], code: { field: 'code', label: 'code' } },
  { type: 'DiagnosticReport', date: { param: 'date', element: 'effectiveDateTime', label: 'effective time' }, tokens: [code, category], code: { field: 'code', label: 'code' } },
  { type: 'DocumentReference', date: { param: 'date', element: 'date', label: 'date' }, tokens: [typeTok, category], code: { field: 'type', label: 'type' } },
  { type: 'Encounter', date: null, tokens: [typeTok, { field: 'class', param: 'class', label: 'class', coding: true }], code: { field: 'type', label: 'type' } },
  { type: 'Procedure', date: { param: 'date', element: 'performedDateTime', label: 'performed time' }, tokens: [code], code: { field: 'code', label: 'code' } },
  { type: 'Condition', date: null, tokens: [code], code: { field: 'code', label: 'code' } },
  { type: 'MedicationRequest', date: { param: 'authoredon', element: 'authoredOn', label: 'authored time' }, tokens: [medCode], code: { field: 'medicationCodeableConcept', label: 'medication code' } },
  { type: 'MedicationAdministration', date: { param: 'effective-time', element: 'effectiveDateTime', label: 'administration time' }, tokens: [medCode], code: { field: 'medicationCodeableConcept', label: 'medication code' } },
  { type: 'MedicationDispense', date: { param: 'whenhandedover', element: 'whenHandedOver', label: 'hand-over time' }, tokens: [medCode], code: { field: 'medicationCodeableConcept', label: 'medication code' } },
  { type: 'Immunization', date: { param: 'date', element: 'occurrenceDateTime', label: 'occurrence time' }, tokens: [{ field: 'vaccineCode', param: 'vaccine-code', label: 'vaccine code' }], code: { field: 'vaccineCode', label: 'vaccine code' } },
  { type: 'Specimen', date: { param: 'collected', element: 'collection.collectedDateTime', label: 'collection time' }, tokens: [typeTok], code: { field: 'type', label: 'type' } },
  { type: 'Claim', date: { param: 'created', element: 'created', label: 'creation time' }, tokens: [], code: { field: 'type', label: 'type' } },
  { type: 'ExplanationOfBenefit', date: { param: 'created', element: 'created', label: 'creation time' }, tokens: [], code: { field: 'type', label: 'type' } },
];

export const llType = (type: string): LLType => {
  const t = LL_TYPES.find(x => x.type === type);
  if (!t) throw new Error(`no long-list type ${type}`);
  return t;
};

export const llToken = (type: string, param: string): LLToken => {
  const k = llType(type).tokens.find(x => x.param === param);
  if (!k) throw new Error(`no long-list token ${type}.${param}`);
  return k;
};

/** Every system|code pair the record carries in an element (a FHIR token search matches any of them). */
export function elementCodings(r: Res, field: string, coding = false): { system: string; code: string; display: string | null }[] {
  const raw = coding
    ? get(r, field).filter(isObj).map(c => ({ system: str(c.system), code: str(c.code), display: str(c.display) }))
    : get(r, field).flatMap(cc => codings(cc));
  const out = new Map<string, { system: string; code: string; display: string | null }>();
  for (const c of raw) if (c.system && c.code && !out.has(`${c.system}|${c.code}`)) out.set(`${c.system}|${c.code}`, { system: c.system, code: c.code, display: c.display });
  return [...out.values()];
}

export const tokenCodings = (r: Res, token: LLToken) => elementCodings(r, token.field, token.coding);

export const tokenMatches = (r: Res, token: LLToken, system: string, codeValue: string): boolean =>
  tokenCodings(r, token).some(c => c.system === system && c.code === codeValue);

const FULL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The record's dateTime in the type's date element, only when it is stated to the second with an offset. */
export function llDate(r: Res, date: LLDate): string | null {
  const v = getStr(r, date.element);
  return v !== null && FULL_DATETIME.test(v) ? v : null;
}

/** Target window size for a candidate in a band, drawn by the canonical hash, uniform over [min, max]. */
export function bandTarget(seedHex: string, templateId: string, candidateKey: string, band: Band): number {
  const h = BigInt(`0x${rankHash('saq', seedHex, templateId, `${candidateKey}#size`)}`);
  return band.min + Number(h % BigInt(band.max - band.min + 1));
}

const DAY = 86_400_000, HOUR = 3_600_000;
const zulu = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

/**
 * Window for a set larger than the band: it starts at 00:00 UTC on the day of the earliest record and ends at the first
 * UTC day boundary after the `target`-th record (by instant); when that holds more than `max` records, the same rule on
 * UTC hours. Null when neither fits or the set is not larger than `target`. `times` are full dateTimes, any order.
 */
export function llWindow(times: string[], target: number, max: number): [string, string] | null {
  if (times.length <= target) return null;
  const ms = times.map(instantMs).sort((a, b) => a - b);
  const first = ms[0]!, kth = ms[target - 1]!;
  for (const unit of [DAY, HOUR]) {
    const a = Math.floor(first / unit) * unit;
    const b = (Math.floor(kth / unit) + 1) * unit;
    const n = ms.filter(x => x >= a && x < b).length;
    if (n <= max) return [zulu(a), zulu(b)];
  }
  return null;
}

export const inLLWindow = (t: string, a: string, b: string): boolean => { const x = instantMs(t); return x >= instantMs(a) && x < instantMs(b); };

/** Band of a banded long-list template id: `LS1-B3` -> B3. */
export const bandOf = (templateId: string): Band | null => BANDS.find(b => templateId.endsWith(`-${b.id}`)) ?? null;
