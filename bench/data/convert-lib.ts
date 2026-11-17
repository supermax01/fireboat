// Converter core, shared by bench:convert and bench:holdout. Every resource keeps its file id; every reference becomes a
// relative Type/id.
// Writes <outDir>/:
//   <ResourceType>.ndjson   every resource keeps its file id; every reference is relative Type/id (or logical, see below)
//   manifest.json           per-type counts, bytes and sha256
//   patients.json           [{patient_id, source_file, resources, by_type}]
//   patient-counts.json     {Type: {subject|patient: {patient_id: n}}}: expected per-patient counts for the load check
//   load-plan.json          dependency level of every line (one base-36 char per line, per type) and cycle groups
// MIMIC: decompression only (each line is written byte for byte). Synthea: urn:uuid:X -> Type/X; conditional references
// resolved from resources present in the converted bundles, else turned into logical references (reference removed, type
// set to the named target type, identifier {system, value} and display kept), counted per target type and identifier
// system (the shared Organization and Practitioner files are not downloaded).
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { createHash, type Hash } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { parseLossless, stringifyLossless } from '../lib/json.js';
import type { LoadDatasetId } from '../lib/paths.js';
import { log, writeJsonAtomic } from '../infra/manifest.js';
import type { InputFile } from './checksums.js';
import { isObj, LITERAL_REF, patientLink, refKind, typeAndId, visitReferences, zeroKinds, type Obj } from './fhir.js';
import { newRewriteStats, rewriteSyntheaReferences } from './synthea.js';
import { DependencyGraph, encodeLevel } from './plan.js';

export interface ConvertOptions {
  dataset: LoadDatasetId;
  files: InputFile[];
  /** Replaced whole (written to a sibling temporary directory first). */
  outDir: string;
  /** Per-file progress lines on stderr (default true). */
  verbose?: boolean;
}

/** Entries of one Synthea bundle file, each with a resource and a fullUrl. */
export async function readBundle(file: InputFile): Promise<Obj[]> {
  const bundle = parseLossless(await readFile(file.path, 'utf8'));
  if (!isObj(bundle) || bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry)) throw new Error(`${file.name}: not a Bundle`);
  return bundle.entry.map((e, i) => {
    if (!isObj(e) || !isObj(e.resource) || typeof e.fullUrl !== 'string') throw new Error(`${file.name}: entry ${i} has no resource or fullUrl`);
    return e;
  });
}

/** Converts the input files and returns the body of the convert manifest (without the common manifest fields). */
export async function convertDataset(o: ConvertOptions): Promise<Record<string, unknown>> {
  const dataset = o.dataset;
  const started = Date.now();
  const verbose = o.verbose ?? true;
  const outDir = o.outDir;
  const tmpOut = `${outDir}.tmp-${process.pid}`;
  await rm(tmpOut, { recursive: true, force: true });
  await mkdir(tmpOut, { recursive: true });

  interface TypeOut { stream: WriteStream; hash: Hash; count: number; bytes: number; keys: string[] }
  const outputs = new Map<string, TypeOut>();
  const graph = new DependencyGraph();
  const refCounts = zeroKinds(); // references as written to converted/
  const patients = new Map<string, { source_file: string; resources: number; by_type: Record<string, number> }>();
  const patientCounts: Record<string, Record<string, Record<string, number>>> = {};

  async function emit(resource: Obj, line: string, where: string, owner: { patientId: string; sourceFile: string } | null): Promise<void> {
    const { type, id } = typeAndId(resource, where);
    const key = `${type}/${id}`;
    if (!graph.define(key)) throw new Error(`${where}: duplicate resource ${key}`);
    visitReferences(resource, r => {
      const ref = r.reference as string;
      refCounts[refKind(ref)]++;
      if (LITERAL_REF.test(ref)) graph.addEdge(key, ref);
    });
    const link = patientLink(resource);
    if (link && link.field !== 'self') {
      ((patientCounts[type] ??= {})[link.field] ??= {})[link.patientId] = (patientCounts[type]![link.field]![link.patientId] ?? 0) + 1;
    }
    const ownerId = owner?.patientId ?? link?.patientId ?? null;
    if (ownerId !== null) {
      const p = patients.get(ownerId) ?? { source_file: owner?.sourceFile ?? '', resources: 0, by_type: {} };
      if (type === 'Patient' && !owner) p.source_file = where.split(':')[0]!;
      p.resources++;
      p.by_type[type] = (p.by_type[type] ?? 0) + 1;
      patients.set(ownerId, p);
    }
    let out = outputs.get(type);
    if (!out) {
      out = { stream: createWriteStream(join(tmpOut, `${type}.ndjson`), { encoding: 'utf8' }), hash: createHash('sha256'), count: 0, bytes: 0, keys: [] };
      outputs.set(type, out);
    }
    const text = line + '\n';
    out.hash.update(text, 'utf8');
    out.count++;
    out.bytes += Buffer.byteLength(text, 'utf8');
    out.keys.push(key);
    if (!out.stream.write(text)) await new Promise<void>(r => out!.stream.once('drain', () => r()));
  }

  const syntheaStats = newRewriteStats();

  if (dataset === 'mimic') await convertMimic(o.files);
  else await convertSynthea(o.files);

  for (const out of outputs.values()) await new Promise<void>((res, rej) => out.stream.end((e?: Error | null) => (e ? rej(e) : res())));

  const dangling = graph.dangling();
  if (dangling.size > 0) {
    const sample = [...dangling.keys()].slice(0, 5).join(', ');
    throw new Error(`${dangling.size} referenced resources are not in the dataset, e.g. ${sample}`);
  }
  const { level: levels, group: groups, groupSizes } = graph.plan();
  const MAX_BATCH = 500;
  if (groupSizes.some(n => n > MAX_BATCH)) throw new Error(`a reference cycle has more than ${MAX_BATCH} members`);
  const types = [...outputs.keys()].sort();
  const planLevels: Record<string, string> = {};
  const planGroups: Record<string, [line: number, group: number][]> = {};
  const countsByLevel: Record<string, Record<string, number>> = {};
  let maxLevel = 0;
  for (const type of types) {
    const chars: string[] = [];
    for (const [line, key] of outputs.get(type)!.keys.entries()) {
      const level = levels.get(key)!;
      const group = groups.get(key);
      if (group !== undefined) (planGroups[type] ??= []).push([line, group]);
      maxLevel = Math.max(maxLevel, level);
      chars.push(encodeLevel(level));
      (countsByLevel[String(level)] ??= {})[type] = (countsByLevel[String(level)]![type] ?? 0) + 1;
    }
    planLevels[type] = chars.join('');
  }

  const typeSummary = Object.fromEntries(types.map(t => {
    const o = outputs.get(t)!;
    return [t, { count: o.count, bytes: o.bytes, sha256: o.hash.digest('hex') }];
  }));
  const total = types.reduce((n, t) => n + outputs.get(t)!.count, 0);
  const patientList = [...patients].map(([patient_id, p]) => ({ patient_id, ...p }))
    .sort((a, b) => (a.patient_id < b.patient_id ? -1 : a.patient_id > b.patient_id ? 1 : 0));
  const logicalReport = Object.fromEntries([...syntheaStats.logical].sort());

  await writeJsonAtomic(join(tmpOut, 'manifest.json'), { schema: 'fbbench.converted/1', dataset, total, types: typeSummary });
  await writeJsonAtomic(join(tmpOut, 'patients.json'), patientList);
  await writeJsonAtomic(join(tmpOut, 'patient-counts.json'), patientCounts, false);
  await writeJsonAtomic(join(tmpOut, 'load-plan.json'), { schema: 'fbbench.load-plan/1', dataset, max_level: maxLevel, counts_by_level: countsByLevel, group_sizes: groupSizes, levels: planLevels, groups: planGroups }, false);
  await rm(outDir, { recursive: true, force: true });
  await rename(tmpOut, outDir);

  const manifestBody: Record<string, unknown> = {
    dataset,
    output_dir: outDir,
    total,
    types: typeSummary,
    patients: patientList.length,
    references: { input_by_kind: dataset === 'mimic' ? refCounts : syntheaStats.inputByKind, output_by_kind: refCounts, dangling: 0, resolved_conditional: syntheaStats.resolvedConditional, logical: logicalReport },
    deviations: dataset !== 'mimic'
      ? ['organizations.json and practitioners.json are not downloaded; unresolved conditional references became logical references with type, identifier and display']
      : [],
    max_level: maxLevel,
    counts_by_level: countsByLevel,
    cycles: { groups: groupSizes.length, resources: groupSizes.reduce((a, b) => a + b, 0), largest: Math.max(0, ...groupSizes) },
    wall_ms: Date.now() - started,
  };
  if (verbose) log(`${dataset}: ${total} resources in ${types.length} types, ${patientList.length} patients, max level ${maxLevel}`);
  return manifestBody;

  // ---- MIMIC ---------------------------------------------------------------------------------------------------

  async function convertMimic(files: InputFile[]): Promise<void> {
    for (const file of files) {
      const lines = createInterface({ input: createReadStream(file.path).pipe(createGunzip()), crlfDelay: Infinity });
      let n = 0;
      for await (const line of lines) {
        n++;
        if (line.length === 0 || line.endsWith('\r')) throw new Error(`${file.name}:${n}: empty line or CR`);
        const resource = parseLossless(line);
        if (!isObj(resource)) throw new Error(`${file.name}:${n}: not an object`);
        await emit(resource, line, `${file.name}:${n}`, null);
      }
      if (verbose) log(`  ${file.name}: ${n} lines`);
    }
  }

  // ---- Synthea -------------------------------------------------------------------------------------------------

  async function convertSynthea(files: InputFile[]): Promise<void> {
    // Pass 1: identifiers of every resource present, for conditional references "Type?identifier=system|value".
    const byIdentifier = new Map<string, string>();
    for (const file of files) {
      for (const e of await readBundle(file)) {
        const r = e.resource as Obj;
        if (!Array.isArray(r.identifier)) continue;
        for (const ident of r.identifier) {
          if (isObj(ident) && typeof ident.system === 'string' && typeof ident.value === 'string') {
            byIdentifier.set(`${r.resourceType as string}|${ident.system}|${ident.value}`, r.id as string);
          }
        }
      }
    }
    // Pass 2: rewrite and emit, bundle by bundle in name order, entries in bundle order.
    for (const file of files) {
      const entries = await readBundle(file);
      const fullUrlType = new Map<string, string>();
      for (const e of entries) {
        const r = e.resource as Obj;
        const { type, id } = typeAndId(r, file.name);
        if (e.fullUrl !== `urn:uuid:${id}`) throw new Error(`${file.name}: fullUrl ${String(e.fullUrl)} does not match ${type}/${id}`);
        fullUrlType.set(e.fullUrl, type);
      }
      const patient = entries.map(e => e.resource as Obj).filter(r => r.resourceType === 'Patient');
      if (patient.length !== 1) throw new Error(`${file.name}: ${patient.length} Patient resources`);
      const owner = { patientId: patient[0]!.id as string, sourceFile: file.name };
      for (const [i, e] of entries.entries()) {
        const r = e.resource as Obj;
        rewriteSyntheaReferences(r, { fullUrlType, byIdentifier, where: `${file.name}#${i}`, stats: syntheaStats });
        await emit(r, stringifyLossless(r), `${file.name}#${i}`, owner);
      }
      if (verbose) log(`  ${file.name}: ${entries.length} resources`);
    }
  }
}
