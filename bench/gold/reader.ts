// Independent raw-file reader for gold. Reads the downloaded files directly, never the converter's output,
// HAPI or an MCP server. Numbers keep their exact source lexemes as strings (parseNumbersAsStrings).
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { parseNumbersAsStrings } from '../lib/json.js';
import { MIMIC_FHIR_DIR, MIMIC_SHA256SUMS, results, SYNTHEA_FHIR_DIR, SYNTHEA_SHA256SUMS, type DatasetId } from '../lib/paths.js';
import { asArray, isObj, refOf, str, type Json, type Res } from './fhir.js';

/** Parses one resource's raw JSON text. Numbers become their lexeme strings. */
export function parseResource(text: string): Res {
  const v = parseNumbersAsStrings(text);
  if (!isObj(v) || typeof v.resourceType !== 'string' || typeof v.id !== 'string') throw new Error('not a FHIR resource with id');
  return v as Res;
}

/** Reference fields that tie a resource to its patient, by type. Patient itself is its own owner. */
const PATIENT_FIELDS = ['subject', 'patient', 'beneficiary'] as const;

export function patientOf(r: Res): string | null {
  if (r.resourceType === 'Patient') return r.id;
  for (const f of PATIENT_FIELDS) {
    const ref = isObj(r[f]) ? str((r[f] as Record<string, Json>).reference) : null;
    if (ref?.startsWith('Patient/')) return ref.slice('Patient/'.length);
  }
  return null;
}

export class PatientData {
  readonly byType = new Map<string, Res[]>();
  readonly byRef = new Map<string, Res>();
  constructor(readonly dataset: DatasetId, readonly patientId: string, readonly sourceFile: string) {}
  add(r: Res): void {
    const ref = refOf(r);
    if (this.byRef.has(ref)) throw new Error(`duplicate resource ${ref}`);
    this.byRef.set(ref, r);
    let list = this.byType.get(r.resourceType);
    if (!list) this.byType.set(r.resourceType, (list = []));
    list.push(r);
  }
  of(type: string): Res[] { return this.byType.get(type) ?? []; }
  get patient(): Res {
    const p = this.byRef.get(`Patient/${this.patientId}`);
    if (!p) throw new Error(`Patient/${this.patientId} missing`);
    return p;
  }
}

/** Resources that belong to no patient (MIMIC Medication, Location, Organization; Synthea Medication). */
export class SharedData {
  readonly byRef = new Map<string, Res>();
  add(r: Res): void { this.byRef.set(refOf(r), r); }
  of(type: string): Res[] { return [...this.byRef.values()].filter(r => r.resourceType === type); }
}

export interface InputFile { path: string; sha256: string; expected: string | null }

function readSums(path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m) out.set(basename(m[2]!).normalize('NFC'), m[1]!);
  }
  return out;
}

function checkSum(file: InputFile): void {
  if (file.expected !== file.sha256) throw new Error(`checksum mismatch for ${file.path}: ${file.sha256} != ${file.expected}`);
}

// ---- MIMIC ---------------------------------------------------------------------------------------------------

export interface MimicData { patients: Map<string, PatientData>; shared: SharedData; inputs: InputFile[]; resourceCounts: Record<string, number> }

const MIMIC_SHARED_TYPES = new Set(['Medication', 'Location', 'Organization']);

/** Loads every resource of the given MIMIC patients plus all shared resources. Verifies each file's sha256. */
export async function readMimic(patientIds: readonly string[]): Promise<MimicData> {
  const sums = readSums(MIMIC_SHA256SUMS);
  const wanted = new Set(patientIds);
  const patients = new Map(patientIds.map(id => [id, new PatientData('mimic', id, '')]));
  const shared = new SharedData();
  const inputs: InputFile[] = [];
  const resourceCounts: Record<string, number> = {};
  const files = readdirSync(MIMIC_FHIR_DIR).filter(f => f.endsWith('.ndjson.gz')).sort();
  for (const f of files) {
    const path = join(MIMIC_FHIR_DIR, f);
    const hash = createHash('sha256');
    const raw = createReadStream(path);
    raw.on('data', chunk => hash.update(chunk as Buffer));
    const lines = createInterface({ input: raw.pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length === 0) continue;
      const type = /"resourceType":\s*"([A-Za-z]+)"/.exec(line)?.[1];
      if (!type) throw new Error(`${f}: line without resourceType`);
      resourceCounts[type] = (resourceCounts[type] ?? 0) + 1;
      if (MIMIC_SHARED_TYPES.has(type)) { shared.add(parseResource(line)); continue; }
      if (!patientIds.some(id => line.includes(id))) continue; // cheap prefilter, confirmed below
      const r = parseResource(line);
      const owner = patientOf(r);
      if (owner && wanted.has(owner)) patients.get(owner)!.add(r);
    }
    const file = { path, sha256: hash.digest('hex'), expected: sums.get(f.normalize('NFC')) ?? null };
    checkSum(file);
    inputs.push(file);
  }
  return { patients, shared, inputs, resourceCounts };
}

// ---- Synthea -------------------------------------------------------------------------------------------------

export function syntheaFiles(): string[] {
  return readdirSync(SYNTHEA_FHIR_DIR).filter(f => f.endsWith('.json')).sort().map(f => join(SYNTHEA_FHIR_DIR, f));
}

interface HoldoutConvertManifest {
  dataset?: string;
  inputs?: { sums_file?: string; sums_file_sha256?: string; files?: { name: string; path: string; sha256: string }[] };
  seed?: { kind?: string; hex?: string; round?: string; chain_hash?: string };
}
/** manifests/convert-synthea-holdout.json, written by `bench:holdout -- convert`. */
export function holdoutConvertManifest(): { path: string; m: HoldoutConvertManifest } {
  const path = join(results.manifests, 'convert-synthea-holdout.json');
  try { return { path, m: JSON.parse(readFileSync(path, 'utf8')) as HoldoutConvertManifest }; } // our own file
  catch { throw new Error(`missing ${path}: run bench:holdout -- convert first`); }
}

/** The raw bundles of a Synthea dataset (absolute paths, file name order) and their expected sha256 by file name. */
export interface SyntheaSource { files: string[]; sums: Map<string, string> }

/**
 * synthea-dev: every bundle in the development download. synthea-holdout: exactly the bundles `bench:holdout -- convert`
 * converted (manifests/convert-synthea-holdout.json), not the downloaded reserves, checked against the holdout's
 * SHA256SUMS.txt, whose own digest must match the one recorded at conversion.
 */
export function syntheaSource(dataset: DatasetId): SyntheaSource {
  if (dataset === 'synthea-dev') return { files: syntheaFiles(), sums: readSums(SYNTHEA_SHA256SUMS) };
  if (dataset !== 'synthea-holdout') throw new Error(`${dataset} is not a Synthea dataset`);
  const { path, m } = holdoutConvertManifest();
  const inputs = m.inputs;
  if (m.dataset !== 'synthea-holdout' || !inputs?.sums_file || !inputs.sums_file_sha256 || !Array.isArray(inputs.files) || inputs.files.length === 0) throw new Error(`malformed ${path}`);
  const sumsSha = createHash('sha256').update(readFileSync(inputs.sums_file)).digest('hex');
  if (sumsSha !== inputs.sums_file_sha256) throw new Error(`${inputs.sums_file} changed since conversion (${sumsSha} != ${inputs.sums_file_sha256})`);
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return { files: inputs.files.map(f => f.path).sort((a, b) => byName(basename(a), basename(b))), sums: readSums(inputs.sums_file) };
}

export interface SyntheaBundle { data: PatientData; shared: SharedData; input: InputFile; conditionalRefs: number }

/**
 * Reads one Synthea transaction bundle. `urn:uuid:X` references become `Type/X` from the bundle's own
 * fullUrls. Conditional references (`Practitioner?identifier=...`) are kept as written: the shared files that would
 * resolve them are not downloaded, and no gold rule reads through them.
 */
export async function readSyntheaBundle(path: string, sums = readSums(SYNTHEA_SHA256SUMS), dataset: DatasetId = 'synthea-dev'): Promise<SyntheaBundle> {
  const buf = await readFile(path);
  const input = { path, sha256: createHash('sha256').update(buf).digest('hex'), expected: sums.get(basename(path).normalize('NFC')) ?? null };
  checkSum(input);
  const bundle = parseNumbersAsStrings(buf.toString('utf8'));
  if (!isObj(bundle) || bundle.resourceType !== 'Bundle') throw new Error(`${path}: not a Bundle`);
  const entries = asArray(bundle.entry as Json[]).filter(isObj);
  const urn = new Map<string, string>();
  for (const e of entries) {
    const r = e.resource as Res;
    const full = str(e.fullUrl);
    if (full?.startsWith('urn:uuid:')) urn.set(full, refOf(r));
  }
  let conditionalRefs = 0;
  const rewrite = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(rewrite);
    if (!isObj(v)) return v;
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'reference' && typeof x === 'string') {
        if (x.startsWith('urn:uuid:')) {
          const target = urn.get(x);
          if (!target) throw new Error(`${path}: dangling ${x}`);
          out[k] = target;
        } else {
          if (/^[A-Za-z]+\?/.test(x)) conditionalRefs++;
          out[k] = x;
        }
      } else out[k] = rewrite(x);
    }
    return out;
  };
  const resources = entries.map(e => rewrite(e.resource as Json) as Res);
  const patient = resources.find(r => r.resourceType === 'Patient');
  if (!patient) throw new Error(`${path}: no Patient`);
  const data = new PatientData(dataset, patient.id, basename(path));
  const shared = new SharedData();
  for (const r of resources) {
    const owner = patientOf(r);
    if (owner === patient.id) data.add(r);
    else if (owner === null) shared.add(r);
    else throw new Error(`${path}: ${refOf(r)} belongs to another patient`);
  }
  return { data, shared, input, conditionalRefs };
}

export const syntheaSums = (): Map<string, string> => readSums(SYNTHEA_SHA256SUMS);
