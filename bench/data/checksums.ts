// Input integrity. Every input file must match its SHA256SUMS line, and each sums file its pinned digest.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MIMIC_FHIR_DIR, MIMIC_ROOT, MIMIC_SHA256SUMS, SYNTHEA_FHIR_DIR, SYNTHEA_ROOT, SYNTHEA_SELECTED_FILES, SYNTHEA_SHA256SUMS, type DevDatasetId as DatasetId } from '../lib/paths.js';
import { sha256File } from '../infra/manifest.js';

/** Digests of the two SHA256SUMS.txt files the benchmark was built on: bench:convert refuses a sums file that differs. */
export const SUMS_FILE_SHA256: Record<DatasetId, string> = {
  mimic: '582688e274af7523f4db1cdebcd88395628a0256084bc0cc20b14884a418b69c',
  'synthea-dev': '96bc83934c63d4ff15f5a11c1c923761244b80ff8601f44e9f341de2972eb85c',
};
export const SYNTHEA_SELECTED_FILES_SHA256 = '397cd84e3a8660d0f391bc7455582265411c7c309089c4044af97019020ce577';

export interface InputFile { name: string; path: string; sha256: string }
export interface ChecksumReport {
  dataset: DatasetId;
  sums_file: string;
  sums_file_sha256: string;
  extra_files_sha256: Record<string, string>;
  files: InputFile[]; // the FHIR input files, names in Unicode NFC (macOS may store NFD), sorted by UTF-16 code units
  verified_at: string;
}

/** Throws on any mismatch, missing file or unlisted FHIR file. */
export async function verifyInputs(dataset: DatasetId): Promise<ChecksumReport> {
  const sumsPath = dataset === 'mimic' ? MIMIC_SHA256SUMS : SYNTHEA_SHA256SUMS;
  const root = dataset === 'mimic' ? MIMIC_ROOT : SYNTHEA_ROOT;
  const fhirDir = dataset === 'mimic' ? MIMIC_FHIR_DIR : SYNTHEA_FHIR_DIR;
  const sumsSha = await sha256File(sumsPath);
  if (sumsSha !== SUMS_FILE_SHA256[dataset]) throw new Error(`${sumsPath}: sha256 ${sumsSha}, expected ${SUMS_FILE_SHA256[dataset]}`);

  // MIMIC lists paths relative to the dataset root ("fhir/x.ndjson.gz"), Synthea bare names relative to fhir/.
  const listed = new Map<string, string>();
  for (const line of (await readFile(sumsPath, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) +(\S.*)$/.exec(line);
    if (!m) throw new Error(`${sumsPath}: bad line ${JSON.stringify(line)}`);
    listed.set(m[2]!.normalize('NFC'), m[1]!);
  }
  const extra: Record<string, string> = {};
  const files: InputFile[] = [];
  for (const [rel, expected] of [...listed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const path = dataset === 'mimic' ? join(root, rel) : join(fhirDir, rel);
    const actual = await sha256File(path);
    if (actual !== expected) throw new Error(`${path}: sha256 ${actual}, expected ${expected}`);
    const isFhir = dataset === 'mimic' ? rel.startsWith('fhir/') && rel.endsWith('.ndjson.gz') : rel.endsWith('.json');
    if (isFhir) files.push({ name: rel.replace(/^fhir\//, ''), path, sha256: actual });
    else extra[rel] = actual;
  }
  if (dataset === 'synthea-dev') {
    const selected = await sha256File(SYNTHEA_SELECTED_FILES);
    if (selected !== SYNTHEA_SELECTED_FILES_SHA256) throw new Error(`selected-files.txt: sha256 ${selected}, expected ${SYNTHEA_SELECTED_FILES_SHA256}`);
    extra['selected-files.txt'] = selected;
    const names = (await readFile(SYNTHEA_SELECTED_FILES, 'utf8')).split('\n').filter(Boolean).map(n => n.trim().normalize('NFC')).sort();
    const have = files.map(f => f.name);
    if (names.join('\n') !== have.join('\n')) throw new Error('synthea: SHA256SUMS.txt and selected-files.txt list different bundles');
  }
  const present = (await readdir(fhirDir)).filter(n => !n.startsWith('.')).map(n => n.normalize('NFC')).sort();
  const unlisted = present.filter(n => !files.some(f => f.name === n));
  if (unlisted.length) throw new Error(`${fhirDir}: files not in SHA256SUMS.txt: ${unlisted.join(', ')}`);
  const expectedCount = dataset === 'mimic' ? 30 : 99;
  if (files.length !== expectedCount) throw new Error(`${dataset}: ${files.length} FHIR files, expected ${expectedCount}`);
  return { dataset, sums_file: sumsPath, sums_file_sha256: sumsSha, extra_files_sha256: extra, files, verified_at: new Date().toISOString() };
}
