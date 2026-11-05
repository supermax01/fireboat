/**
 * Packaging slice 6, second half (integration plan A6): merge the hand-reviewed synthetic edge resources
 * (`packages/evals/fixtures/quickstart/edges.json`) into the natural quickstart seed written by
 * `transform-synthea.ts`. Edges cover what a natural chart rarely has and the packaged tasks need: corrected and
 * entered-in-error results, raw trailing-zero lexemes, a second patient for wrong-patient controls and a document
 * whose inline payload must be withheld. Every edge row is labelled `origin: "edge"` and never counts as natural.
 * The natural seed is checked first: hashes, row identities against the parsed bodies, its selection bounds and the
 * transform's own seed contract (`checkSeedContract`). Edges are strict: `qs-edge-*` ids of Patient, Observation or
 * DocumentReference only, each limited to a closed set of reviewed elements and datatypes (no extensions, narrative,
 * identifiers, markdown annotations or other link-bearing elements, and no blank strings); references only to the natural patient
 * (`Patient/$natural`) or to another edge of the same patient, written in dependency order with cycles refused; lab
 * Observations with a status, a code and an `effectiveDateTime` inside the seed's UTC window; documents with an
 * instant date and canonical base64 data and a content type in every attachment; at most one edge Patient; lossless
 * numbers; merged rows within the helper's manifest limits. Every refusal is a fixed code that carries no id, path
 * or value.
 *   node --import tsx scripts/quickstart/edges.ts <seed dir> <edges.json> <new empty out dir>
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cloneFhirValue, isFhirDecimal, parseFhirJson, stringifyFhir } from '../../packages/core/src/decimal.js';
import { SEED_LIMITS, resourceId, resourceType } from '../../examples/quickstart/manifest.js';
import { checkSeedContract, utcInterval, type SeedManifest } from './transform-synthea.js';

export type EdgeFault = 'SEED_INVALID' | 'EDGES_INVALID' | 'EDGE_ID_INVALID' | 'EDGE_TYPE_NOT_ALLOWED' | 'EDGE_DUPLICATE'
  | 'EDGE_REFERENCE_INVALID' | 'EDGE_REFERENCE_CYCLE' | 'EDGE_OWNER_MISMATCH' | 'EDGE_SUBJECT_INVALID' | 'EDGE_SHAPE_INVALID'
  | 'EDGE_DATE_INVALID' | 'EDGE_OUTSIDE_WINDOW' | 'EDGE_PAYLOAD_INVALID' | 'EDGE_PATIENT_INVALID' | 'SEED_LIMIT_EXCEEDED' | 'LEXEME_CHANGED';
/** The message is the code alone. */
export class EdgeError extends Error {
  constructor(readonly code: EdgeFault) { super(code); this.name = 'EdgeError'; }
}
const fault = (code: EdgeFault): never => { throw new EdgeError(code); };

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => !!value && typeof value === 'object' && !Array.isArray(value) && !isFhirDecimal(value);
const exactKeys = (value: Rec, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const EDGE_ID = /^qs-edge-[a-z0-9-]{1,48}$/;
const EDGE_TYPES = ['Patient', 'Observation', 'DocumentReference'] as const;
const NATURAL = 'Patient/$natural';
const OBSERVATION_LAB = { system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' };
const OBSERVATION_STATUS = ['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'];
const DOCUMENT_STATUS = ['current', 'superseded', 'entered-in-error'];
/** FHIR `instant`: a full date and time to the second, with a zone. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// The reviewed edge shapes: closed elements per type, each a closed datatype. Unlisted elements (extensions, narrative,
// identifiers, markdown annotations, links, URLs) refuse. Plain text fields still admit literals such as Patient/example.
type Check = (value: unknown) => boolean;
const text: Check = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
const absoluteUri: Check = value => text(value) && /^(?:https?:\/\/[^\s/]+[^\s]*|urn:(?:oid|uuid):[^\s]+)$/.test(value as string);
const closed = (fields: Readonly<Record<string, Check>>): Check => value => isRecord(value) && Object.keys(value).length > 0
  && Object.entries(value).every(([key, child]) => Object.hasOwn(fields, key) && fields[key]!(child));
const list = (item: Check): Check => value => Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(item);
const coding = closed({ system: absoluteUri, code: text, display: text });
const concept = closed({ coding: list(coding), text });
const reference = closed({ reference: text, type: text, display: text });
const quantity = closed({ value: value => isFhirDecimal(value) || typeof value === 'number', unit: text, system: absoluteUri, code: text,
  comparator: value => ['<', '<=', '>=', '>'].includes(value as string) });
const any: Check = () => true;
const EDGE_SHAPES: Readonly<Record<string, Readonly<Record<string, Check>>>> = {
  Patient: { resourceType: any, id: any, name: list(closed({ family: text, given: list(text) })),
    gender: value => ['male', 'female', 'other', 'unknown'].includes(value as string), birthDate: value => typeof value === 'string' && /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value) },
  Observation: { resourceType: any, id: any, status: text, category: list(concept), code: concept, subject: reference, effectiveDateTime: text,
    valueQuantity: quantity, interpretation: list(concept), hasMember: list(reference), derivedFrom: list(reference) },
  DocumentReference: { resourceType: any, id: any, status: text, type: concept, subject: reference, date: text,
    content: list(closed({ attachment: closed({ contentType: text, title: text, data: value => typeof value === 'string' }) })) },
};

export interface EdgeManifest extends Omit<SeedManifest, 'resources'> {
  resources: { type: string; id: string; bytes: number; sha256: string; origin: 'natural' | 'edge' }[];
  edges: { sha256: string; count: number };
}
export interface SeedFiles { ndjson: string; manifest: SeedManifest }

function numberLexemes(node: unknown, out: string[] = []): string[] {
  if (isFhirDecimal(node)) out.push(node.lexeme);
  else if (typeof node === 'number') out.push(JSON.stringify(node));
  else if (Array.isArray(node)) node.forEach(child => numberLexemes(child, out));
  else if (isRecord(node)) Object.values(node).forEach(child => numberLexemes(child, out));
  return out;
}
/** Reference objects (any object with `reference`); the closed shapes admit them only where a Reference belongs. */
function references(node: unknown, out: Rec[] = []): Rec[] {
  if (Array.isArray(node)) node.forEach(child => references(child, out));
  else if (isRecord(node)) {
    if ('reference' in node) out.push(node);
    for (const [key, child] of Object.entries(node)) if (key !== 'reference') references(child, out);
  }
  return out;
}

/** Checks the seed's hashes, row identities, selection bounds and the transform's seed contract; returns its `Type/id` keys. */
export function validateSeed(seed: SeedFiles): ReadonlySet<string> {
  try { return checkSeed(seed); } catch (error) { if (error instanceof EdgeError) throw error; return fault('SEED_INVALID'); }
}
function checkSeed(seed: SeedFiles): ReadonlySet<string> {
  const m = seed.manifest;
  if (!isRecord(m) || m.schema !== 'fireboat-quickstart-seed/1' || typeof m.patient !== 'string' || !Array.isArray(m.resources)
    || typeof seed.ndjson !== 'string' || sha256(seed.ndjson) !== m.ndjson_sha256) fault('SEED_INVALID');
  const [windowStart] = utcInterval(m.selection.window.start), [windowEnd] = utcInterval(m.selection.window.end);
  if (!(windowStart < windowEnd) || !Number.isSafeInteger(m.selection.maxResources) || !Number.isSafeInteger(m.selection.maxBytes)) fault('SEED_INVALID');
  if (m.resources.length > m.selection.maxResources || Buffer.byteLength(seed.ndjson, 'utf8') > m.selection.maxBytes) fault('SEED_INVALID');
  const lines = seed.ndjson.endsWith('\n') ? seed.ndjson.slice(0, -1).split('\n') : fault('SEED_INVALID');
  if (lines.length !== m.resources.length) fault('SEED_INVALID');
  const keys = new Set<string>(), bodies: Rec[] = [];
  lines.forEach((line, i) => {
    const row = m.resources[i] as unknown;
    if (!isRecord(row) || !exactKeys(row, ['type', 'id', 'bytes', 'sha256', 'origin']) || !resourceType(row.type) || !resourceId(row.id)) fault('SEED_INVALID');
    const r = row as unknown as SeedManifest['resources'][number];
    if (r.sha256 !== sha256(line) || r.bytes !== Buffer.byteLength(line, 'utf8') || r.origin !== 'natural') fault('SEED_INVALID');
    const body = parseFhirJson(line);
    if (!isRecord(body) || body.resourceType !== r.type || body.id !== r.id) fault('SEED_INVALID');
    keys.add(`${r.type}/${r.id}`);
    bodies.push(body as Rec);
  });
  checkSeedContract(bodies, m);
  return keys;
}

export function mergeEdges(seed: SeedFiles, edgesBytes: Uint8Array): { ndjson: string; manifest: EdgeManifest } {
  const natural = validateSeed(seed);
  try { return merge(seed, natural, edgesBytes); } catch (error) { if (error instanceof EdgeError) throw error; return fault('EDGES_INVALID'); }
}
function merge(seed: SeedFiles, natural: ReadonlySet<string>, edgesBytes: Uint8Array): { ndjson: string; manifest: EdgeManifest } {
  let file: unknown;
  try { file = parseFhirJson(new TextDecoder('utf-8', { fatal: true }).decode(edgesBytes)); } catch { fault('EDGES_INVALID'); }
  if (!isRecord(file) || file.schema !== 'fireboat-quickstart-edges/1' || typeof file.note !== 'string' || !Array.isArray(file.resources)
    || Object.keys(file).some(k => !['schema', 'note', 'resources'].includes(k)) || file.resources.length === 0 || file.resources.length > 64) fault('EDGES_INVALID');
  const [windowStart] = utcInterval(seed.manifest.selection.window.start), [windowEnd] = utcInterval(seed.manifest.selection.window.end);
  const edges = new Map<string, Rec>();
  for (const entry of (file as Rec).resources as unknown[]) {
    if (!isRecord(entry) || Object.keys(entry).some(k => !['purpose', 'resource'].includes(k)) || typeof entry.purpose !== 'string'
      || entry.purpose.length < 1 || entry.purpose.length > 200 || !isRecord(entry.resource)) fault('EDGES_INVALID');
    const resource = (entry as Rec).resource as Rec;
    if (typeof resource.id !== 'string' || !EDGE_ID.test(resource.id)) fault('EDGE_ID_INVALID');
    if (!(EDGE_TYPES as readonly unknown[]).includes(resource.resourceType)) fault('EDGE_TYPE_NOT_ALLOWED');
    const key = `${resource.resourceType as string}/${resource.id as string}`;
    if (edges.has(key) || natural.has(key)) fault('EDGE_DUPLICATE');
    if ('contained' in resource || 'meta' in resource) fault('EDGES_INVALID');
    edges.set(key, resource);
  }
  const patients = [...edges.entries()].filter(([, r]) => r.resourceType === 'Patient');
  if (patients.length > 1 || patients.some(([, r]) => 'identifier' in r || 'link' in r)) fault('EDGE_PATIENT_INVALID');
  for (const resource of edges.values()) if (!closed(EDGE_SHAPES[resource.resourceType as string]!)(resource)) fault('EDGE_SHAPE_INVALID');
  const resolveTarget = (target: unknown): string => {
    if (target === NATURAL) return seed.manifest.patient;
    if (typeof target === 'string' && edges.has(target)) return target;
    return fault('EDGE_REFERENCE_INVALID');
  };
  // Each edge belongs to one patient: an edge Patient to itself, any other edge to its subject's patient.
  const owner = new Map<string, string>(patients.map(([key]) => [key, key]));
  for (const [key, resource] of edges) {
    if (resource.resourceType === 'Patient') continue;
    const subject = isRecord(resource.subject) ? resolveTarget(resource.subject.reference) : fault('EDGE_SUBJECT_INVALID');
    if (!subject.startsWith('Patient/')) fault('EDGE_SUBJECT_INVALID');
    owner.set(key, subject);
  }
  const ownerOf = (target: string) => target === seed.manifest.patient ? target : owner.get(target)!;
  const dependsOn = new Map<string, Set<string>>();
  for (const [key, resource] of edges) {
    const targets = new Set<string>();
    for (const ref of references(resource)) {
      const target = resolveTarget(ref.reference);
      if (ref.type !== undefined && ref.type !== target.split('/')[0]) fault('EDGE_REFERENCE_INVALID');
      if (ownerOf(target) !== owner.get(key)) fault('EDGE_OWNER_MISMATCH');
      if (edges.has(target)) targets.add(target);
    }
    dependsOn.set(key, targets);
    if (resource.resourceType === 'Observation') {
      const lab = Array.isArray(resource.category) && resource.category.some(c => isRecord(c) && Array.isArray(c.coding)
        && c.coding.some(x => isRecord(x) && x.system === OBSERVATION_LAB.system && x.code === OBSERVATION_LAB.code));
      const coded = isRecord(resource.code) && Array.isArray(resource.code.coding)
        && resource.code.coding.every(c => isRecord(c) && typeof c.system === 'string' && typeof c.code === 'string');
      if (!lab || !coded || !OBSERVATION_STATUS.includes(resource.status as string)) fault('EDGE_SHAPE_INVALID');
      let lo = 0, hi = 0;
      try { [lo, hi] = utcInterval(resource.effectiveDateTime); } catch { fault('EDGE_DATE_INVALID'); }
      if (lo < windowStart || hi > windowEnd) fault('EDGE_OUTSIDE_WINDOW');
    }
    if (resource.resourceType === 'DocumentReference') {
      if (!DOCUMENT_STATUS.includes(resource.status as string)) fault('EDGE_SHAPE_INVALID');
      if (resource.date !== undefined && !(typeof resource.date === 'string' && INSTANT.test(resource.date))) fault('EDGE_DATE_INVALID');
      if (resource.date !== undefined) try { utcInterval(resource.date); } catch { fault('EDGE_DATE_INVALID'); }
      const content = Array.isArray(resource.content) ? resource.content : [];
      if (!content.length || !content.every(c => isRecord(c) && isRecord(c.attachment) && typeof c.attachment.data === 'string'
        && c.attachment.data.length > 0 && Buffer.from(c.attachment.data, 'base64').toString('base64') === c.attachment.data
        && typeof c.attachment.contentType === 'string')) fault('EDGE_PAYLOAD_INVALID');
    }
  }

  // Dependency order (targets before referrers; the natural seed is already written); ties: the edge Patient, then by key.
  const order: string[] = [], pending = new Map([...dependsOn].map(([key, targets]) => [key, new Set(targets)]));
  while (pending.size) {
    const ready = [...pending].filter(([, targets]) => targets.size === 0).map(([key]) => key)
      .sort((a, b) => (a.startsWith('Patient/') ? 0 : 1) - (b.startsWith('Patient/') ? 0 : 1) || (a < b ? -1 : a > b ? 1 : 0));
    if (!ready.length) fault('EDGE_REFERENCE_CYCLE');
    const next = ready[0]!;
    order.push(next);
    pending.delete(next);
    for (const targets of pending.values()) targets.delete(next);
  }
  const rows: EdgeManifest['resources'] = [...seed.manifest.resources];
  let ndjson = seed.ndjson;
  for (const key of order) {
    const source = edges.get(key)!;
    const resource = cloneFhirValue(source);
    const rewrite = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(rewrite);
      else if (isRecord(node)) for (const [k, child] of Object.entries(node)) {
        if (k === 'reference' && child === NATURAL) node[k] = seed.manifest.patient; else rewrite(child);
      }
    };
    rewrite(resource);
    const body = stringifyFhir(resource);
    if (numberLexemes(parseFhirJson(body)).join('\u0000') !== numberLexemes(source).join('\u0000')) fault('LEXEME_CHANGED');
    rows.push({ type: resource.resourceType as string, id: resource.id as string, bytes: Buffer.byteLength(body, 'utf8'), sha256: sha256(body), origin: 'edge' });
    ndjson += `${body}\n`;
  }
  // The merged rows become the helper manifest's rows (examples/quickstart/manifest.ts): the same per-row and aggregate limits.
  if (rows.length > SEED_LIMITS.resources || new Set(rows.map(r => r.type)).size > SEED_LIMITS.types
    || rows.some(r => r.bytes > SEED_LIMITS.bodyBytes) || rows.reduce((n, r) => n + r.bytes, 0) > SEED_LIMITS.totalBytes) fault('SEED_LIMIT_EXCEEDED');
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.type] = (counts[r.type] ?? 0) + 1;
  return { ndjson, manifest: { ...seed.manifest, counts, resources: rows, ndjson_sha256: sha256(ndjson), edges: { sha256: sha256(edgesBytes), count: edges.size } } };
}

export type EdgeCliFault = EdgeFault | 'USAGE' | 'INPUT_MISSING' | 'INPUT_TOO_LARGE' | 'INPUT_CHANGED' | 'OUT_NOT_EMPTY' | 'IO_FAILED';
class CliFault extends Error { constructor(readonly code: EdgeCliFault) { super(code); } }
/** The file operations the CLI performs; tests substitute them to model a file that changes or is replaced mid-read. */
export interface EdgeIo {
  open(path: string, flags: number): number; fstat(fd: number): { isFile(): boolean; size: number };
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number; close(fd: number): void;
  write(path: string, text: string): void; rename(from: string, to: string): void;
}
const NODE_IO: EdgeIo = { open: (path, flags) => openSync(path, flags), fstat: fd => fstatSync(fd), read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  close: fd => closeSync(fd), write: (path, text) => writeFileSync(path, text), rename: (from, to) => renameSync(from, to) };
/** Each input is sized on its open descriptor before it is read: the natural seed is bounded by the transform, the edge file is small and reviewed. */
const CLI_INPUT_LIMITS = { ndjson: 8_388_608, manifest: 1_048_576, edges: 262_144 } as const;
/** One open, no symlink and no blocking on a special file; the descriptor must be a regular file of at most `limit` bytes that does not change while read. */
function readBounded(path: string, limit: number, io: EdgeIo): Buffer {
  const fd = io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = io.fstat(fd);
    if (!stat.isFile()) throw new CliFault('INPUT_MISSING');
    if (stat.size > limit) throw new CliFault('INPUT_TOO_LARGE');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    for (let n = 1; n > 0 && length <= stat.size; length += n) n = io.read(fd, buffer, length, buffer.length - length, length);
    if (length !== stat.size) throw new CliFault('INPUT_CHANGED');
    return buffer.subarray(0, length);
  } finally { io.close(fd); }
}
/** Writes the files into a staging sibling, then publishes the complete directory in one rename; a failure leaves no output. */
export function publishOutput(outDir: string, files: Readonly<Record<string, string>>, io: EdgeIo = NODE_IO): void {
  const target = resolve(outDir);
  mkdirSync(dirname(target), { recursive: true });
  const stage = mkdtempSync(join(dirname(target), `.${basename(target)}.staging-`));
  try {
    for (const [name, text] of Object.entries(files)) io.write(join(stage, name), text);
    if (existsSync(target)) rmdirSync(target);
    io.rename(stage, target);
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
}
export function runEdgesCli(args: readonly string[], substitutes: Partial<EdgeIo> = {}): { code: 0 | 1; line: string } {
  const failed = (code: EdgeCliFault) => ({ code: 1 as const, line: `quickstart-edges: ${code}` });
  const io: EdgeIo = { ...NODE_IO, ...substitutes };
  try {
    const [seedDir, edgesPath, outDir] = args;
    if (!seedDir || !edgesPath || !outDir || args.length !== 3) return failed('USAGE');
    const ndjsonPath = join(seedDir, 'resources.ndjson'), manifestPath = join(seedDir, 'seed-manifest.json');
    if (![ndjsonPath, manifestPath, edgesPath].every(p => existsSync(p) && lstatSync(p).isFile())) return failed('INPUT_MISSING');
    if (existsSync(outDir) && (!lstatSync(outDir).isDirectory() || readdirSync(outDir).length)) return failed('OUT_NOT_EMPTY');
    const ndjsonBytes = readBounded(ndjsonPath, CLI_INPUT_LIMITS.ndjson, io), manifestBytes = readBounded(manifestPath, CLI_INPUT_LIMITS.manifest, io);
    const edgesBytes = readBounded(edgesPath, CLI_INPUT_LIMITS.edges, io);
    let manifest: SeedManifest, ndjson: string;
    try {
      const utf8 = new TextDecoder('utf-8', { fatal: true });
      manifest = JSON.parse(utf8.decode(manifestBytes)) as SeedManifest;
      ndjson = utf8.decode(ndjsonBytes);
    } catch { return failed('SEED_INVALID'); }
    const merged = mergeEdges({ ndjson, manifest }, edgesBytes);
    publishOutput(outDir, { 'resources.ndjson': merged.ndjson, 'seed-manifest.json': `${JSON.stringify(merged.manifest, null, 2)}\n` }, io);
    return { code: 0, line: `quickstart-edges: ${merged.manifest.resources.length} resources (${merged.manifest.edges.count} edge); ndjson sha256 ${merged.manifest.ndjson_sha256}` };
  } catch (error) {
    return failed(error instanceof EdgeError || error instanceof CliFault ? error.code : 'IO_FAILED');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, line } = runEdgesCli(process.argv.slice(2));
  (code ? process.stderr : process.stdout).write(`${line}\n`);
  process.exitCode = code;
}
