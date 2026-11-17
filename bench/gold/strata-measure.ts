// bench:strata-measure -- --dataset <mimic|synthea-dev|synthea-holdout> [--out <dir>]
// Counts only: long result sets per development patient, and recorded decimal lexemes a
// binary-float round trip would change. Reads the raw files only; prints aggregate counts, never ids or values.
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createGunzip } from 'node:zlib';
import { COMMON_OPTIONS, datasetArg } from '../lib/cli.js';
import { LosslessNumber, parseLossless, type LosslessValue } from '../lib/json.js';
import { familyOf, MIMIC_FHIR_DIR, mimicDevPatients, type DatasetId } from '../lib/paths.js';
import { lexemeChangedByFloat } from './decimal.js';
import { codings, get, isObj, str, type Res } from './fhir.js';
import { patientOf, syntheaSource } from './reader.js';
import { forEachPatient } from './source.js';

/** Coded fields a FHIR token search can select on, by type (the search parameter is in the comment). */
export const CODED_FIELDS: Record<string, string[]> = {
  Observation: ['code', 'category'], // code, category
  Condition: ['code'],
  Procedure: ['code'],
  MedicationRequest: ['medicationCodeableConcept', 'medicationReference'], // code, medication
  MedicationAdministration: ['medicationCodeableConcept', 'medicationReference'],
  MedicationDispense: ['medicationCodeableConcept', 'medicationReference'],
  Encounter: ['type', 'class'], // type, class
  DocumentReference: ['type'],
  DiagnosticReport: ['code', 'category'],
  Immunization: ['vaccineCode'], // vaccine-code
  Specimen: ['type'],
};

const BANDS = [[101, Infinity], [201, Infinity], [101, 1000], [201, 1000], [2001, Infinity]] as const;
const bandName = (b: readonly [number, number]) => (b[1] === Infinity ? `gt${b[0] - 1}` : `${b[0]}-${b[1]}`);

/** Keys a record contributes to under one coded field: every system|code pair, or the reference. */
function groupKeys(r: Res, field: string): string[] {
  const v = r[field];
  if (v === undefined) return [];
  if (field.endsWith('Reference')) { const ref = isObj(v) ? str(v.reference) : null; return ref ? [ref] : []; }
  if (field === 'class') return isObj(v) && str(v.code) ? [`${str(v.system)}|${str(v.code)}`] : [];
  return [...new Set(get(r, field).flatMap(cc => codings(cc)).filter(c => c.code).map(c => `${c.system}|${c.code}`))];
}

export interface LongListCounts {
  patients: number;
  type_totals: Record<string, Record<string, number>>; // type -> band -> patients
  coded_groups: Record<string, Record<string, { groups: number; patients: number }>>; // "Type.field" -> band -> counts
}

export function countLongLists(perPatient: Map<string, Res[]>[]): LongListCounts {
  const type_totals: LongListCounts['type_totals'] = {};
  const coded: Record<string, Record<string, { groups: number; patients: Set<number> }>> = {};
  perPatient.forEach((byType, i) => {
    for (const [type, recs] of byType) {
      for (const b of BANDS) if (recs.length >= b[0] && recs.length <= b[1]) {
        const t = (type_totals[type] ??= {});
        t[bandName(b)] = (t[bandName(b)] ?? 0) + 1;
      }
      for (const field of CODED_FIELDS[type] ?? []) {
        const counts = new Map<string, number>();
        for (const r of recs) for (const k of groupKeys(r, field)) counts.set(k, (counts.get(k) ?? 0) + 1);
        for (const n of counts.values()) for (const b of BANDS) if (n >= b[0] && n <= b[1]) {
          const e = ((coded[`${type}.${field}`] ??= {})[bandName(b)] ??= { groups: 0, patients: new Set() });
          e.groups++; e.patients.add(i);
        }
      }
    }
  });
  const coded_groups: LongListCounts['coded_groups'] = {};
  for (const [k, bands] of Object.entries(coded)) {
    coded_groups[k] = Object.fromEntries(Object.entries(bands).map(([b, e]) => [b, { groups: e.groups, patients: e.patients.size }]));
  }
  return { patients: perPatient.length, type_totals, coded_groups };
}

// ---- Decimals --------------------------------------------------------------------------------------------------

/** Significant digits of a plain or exponent lexeme, trailing zeros of the mantissa excluded. */
export function significantDigits(lexeme: string): number {
  const mantissa = lexeme.replace(/^-/, '').replace(/[eE].*$/, '').replace('.', '');
  return mantissa.replace(/^0+/, '').replace(/0+$/, '').length;
}

/** Why a float round trip changes a lexeme. A lexeme can have several reasons; the first matching one is counted. */
export function floatChangeReason(lexeme: string): 'exponent' | 'over_15_significant_digits' | 'trailing_fraction_zero' | 'other' | null {
  if (!lexemeChangedByFloat(lexeme)) return null;
  if (/[eE]/.test(lexeme)) return 'exponent';
  if (significantDigits(lexeme) > 15) return 'over_15_significant_digits';
  if (/\.[0-9]*0$/.test(lexeme)) return 'trailing_fraction_zero';
  return 'other';
}

export interface DecimalCounts {
  numbers: number; // every JSON number in the development patients' resources
  changed: number;
  by_reason: Record<string, number>;
  zero_valued_trailing: number; // "0.0", "0.00", ...: trailing zeros on a zero value
  unchanged_over_15_digits: number; // more than 15 significant digits, yet already the shortest double form (not eligible)
  by_path: Record<string, { numbers: number; changed: number; by_reason: Record<string, number>; distinct_resources: number }>;
}

export class DecimalCounter {
  readonly c: DecimalCounts = { numbers: 0, changed: 0, by_reason: {}, zero_valued_trailing: 0, unchanged_over_15_digits: 0, by_path: {} };
  private readonly seen = new Map<string, Set<string>>();
  add(r: LosslessValue): void {
    if (!isObj(r)) return;
    const type = str(r.resourceType) ?? '?';
    const id = str(r.id) ?? '?';
    const walk = (v: LosslessValue, path: string) => {
      if (v instanceof LosslessNumber) {
        const p = (this.c.by_path[path] ??= { numbers: 0, changed: 0, by_reason: {}, distinct_resources: 0 });
        this.c.numbers++; p.numbers++;
        const why = floatChangeReason(v.lexeme);
        if (!why && significantDigits(v.lexeme) > 15) this.c.unchanged_over_15_digits++;
        if (why) {
          this.c.changed++; p.changed++;
          this.c.by_reason[why] = (this.c.by_reason[why] ?? 0) + 1;
          p.by_reason[why] = (p.by_reason[why] ?? 0) + 1;
          if (/^-?0\.0+$/.test(v.lexeme)) this.c.zero_valued_trailing++;
          const s = this.seen.get(path) ?? new Set<string>();
          if (!s.has(id)) { s.add(id); p.distinct_resources++; }
          this.seen.set(path, s);
        }
      } else if (Array.isArray(v)) for (const x of v) walk(x, path);
      else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(r, type);
  }
}

// ---- Data passes -----------------------------------------------------------------------------------------------

async function decimalsMimic(): Promise<DecimalCounts> {
  const dev = new Set(mimicDevPatients());
  const counter = new DecimalCounter();
  for (const f of readdirSync(MIMIC_FHIR_DIR).filter(x => x.endsWith('.ndjson.gz')).sort()) {
    const lines = createInterface({ input: createReadStream(join(MIMIC_FHIR_DIR, f)).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line || ![...dev].some(id => line.includes(id))) continue;
      const v = parseLossless(line);
      const owner = patientOf(v as unknown as Res);
      if (owner && dev.has(owner)) counter.add(v);
    }
  }
  return counter.c;
}

async function decimalsSynthea(files: string[]): Promise<DecimalCounts> {
  const counter = new DecimalCounter();
  for (const f of files) {
    const b = parseLossless(readFileSync(f, 'utf8'));
    if (!isObj(b) || !Array.isArray(b.entry)) throw new Error(`${f}: not a Bundle`);
    for (const e of b.entry) {
      const r = isObj(e) ? e.resource ?? null : null;
      // Patient-linked records only (references are still urn:uuid here, so the owner test is "has a patient field").
      if (isObj(r) && (str(r.resourceType) === 'Patient' || patientOf(r as unknown as Res) !== null || hasUrnPatient(r))) counter.add(r);
    }
  }
  return counter.c;
}

function hasUrnPatient(r: Record<string, LosslessValue>): boolean {
  return ['subject', 'patient', 'beneficiary'].some(f => { const v = r[f]; return isObj(v) && typeof v.reference === 'string'; });
}

export async function measure(dataset: DatasetId) {
  const perPatient: Map<string, Res[]>[] = [];
  const files: string[] = [];
  await forEachPatient(dataset, ctx => {
    perPatient.push(new Map(ctx.data.byType));
    if (familyOf(dataset) === 'synthea') files.push(ctx.data.sourceFile);
  });
  const longLists = countLongLists(perPatient);
  const paths = familyOf(dataset) === 'synthea' ? new Map(syntheaSource(dataset).files.map(p => [basename(p), p])) : new Map<string, string>();
  const decimals = dataset === 'mimic' ? await decimalsMimic() : await decimalsSynthea(files.map(f => paths.get(f)!));
  return { schema: 'fbbench.strata-measure/1', dataset, long_lists: longLists, decimals };
}

async function main() {
  const { values } = parseArgs({ options: { ...COMMON_OPTIONS, out: { type: 'string' } }, strict: true });
  const dataset = datasetArg(values.dataset);
  const m = await measure(dataset);
  const text = JSON.stringify(m, null, 2) + '\n';
  if (values.out) {
    await mkdir(values.out, { recursive: true });
    await writeFile(join(values.out, `measure-${dataset}.json`), text, 'utf8');
  }
  process.stdout.write(text);
}

if (process.argv[1]?.endsWith('strata-measure.ts')) main().catch(e => { process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
