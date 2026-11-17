/**
 * Quickstart seed terminology step: the pinned step between the Synthea
 * transform (`transform-synthea.ts`) and the edge merge (`edges.ts`). It replaces the licence-restricted SNOMED CT
 * codings that Synthea writes into Encounters with synthetic `http://example.invalid/` codings, so the seed carries no
 * SNOMED CT content. Pure and deterministic.
 * Scope: Encounter.type and Encounter.reasonCode, where a pinned Synthea quickstart seed holds them. Each coding whose
 * system is the SNOMED CT URI or its OID becomes a numbered synthetic coding. N is the order of first appearance of its
 * source code in seed row order, counted separately for type and for reason, so a repeated source code keeps one
 * synthetic code; no source code or description is written anywhere. A concept that had a replaced coding and carries
 * text gets the synthetic display as its text. Concepts are closed (`coding`, `text`) and codings are closed (`system`,
 * `code`, `display`). Restricted terminology anywhere else refuses (TERMINOLOGY_UNMAPPED); a removed code, display or
 * text that survives anywhere refuses (TERMINOLOGY_RESIDUE); number lexemes may not change. Rows the step does not change
 * are copied byte for byte. The input is a natural seed as the transform writes it, checked with the edge merge's
 * structure checks; the output is checked as the merge checks it and records the input hash, this script's own sha256
 * (so an edit to the step shows in the seed's provenance) and its tallies in `terminology`. Every refusal is a fixed
 * code that carries no id, path or value.
 *   node --import tsx scripts/quickstart/terminology.ts <natural seed dir> <new empty out dir>
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isFhirDecimal, parseFhirJson, stringifyFhir } from '../../packages/core/src/decimal.js';
import { CLI_INPUT_LIMITS, CliFault, EdgeError, NODE_IO, RESTRICTED_SYSTEMS, publishOutput, readBounded, restrictedTerminology, validateSeed,
  validateSeedStructure, type EdgeCliFault, type EdgeIo, type SeedFiles } from './edges.js';
import type { SeedManifest } from './transform-synthea.js';

export type TerminologyFault = 'TERMINOLOGY_SHAPE_INVALID' | 'TERMINOLOGY_UNMAPPED' | 'TERMINOLOGY_RESIDUE' | 'LEXEME_CHANGED';
/** The message is the code alone. */
export class TerminologyError extends Error {
  constructor(readonly code: TerminologyFault) { super(code); this.name = 'TerminologyError'; }
}
const fault = (code: TerminologyFault): never => { throw new TerminologyError(code); };

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => !!value && typeof value === 'object' && !Array.isArray(value) && !isFhirDecimal(value);
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const closedKeys = (value: Rec, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const optionalText = (value: unknown) => value === undefined || typeof value === 'string';

export const TERMINOLOGY_SCHEMA = 'fireboat-quickstart-terminology/1';
export const TERMINOLOGY_SCRIPT = 'scripts/quickstart/terminology.ts';
/** The sha256 of this script's bytes, recorded with the step so the seed's provenance binds the exact step that ran. */
export const TERMINOLOGY_SCRIPT_SHA256 = sha256(readFileSync(new URL(import.meta.url)));
/** The replaced Encounter fields and their synthetic stand-ins (N is appended to the code and the display). */
export const SYNTHETIC_ENCOUNTER_CODINGS = {
  type: { system: 'http://example.invalid/synthetic-encounter-type', code: 'encounter-type-', display: 'Synthetic encounter type ' },
  reasonCode: { system: 'http://example.invalid/synthetic-encounter-reason', code: 'encounter-reason-', display: 'Synthetic encounter reason ' },
} as const;
const [SYSTEM_URI, SYSTEM_OID] = RESTRICTED_SYSTEMS;
const restricted = (system: unknown) => system === SYSTEM_URI || system === SYSTEM_OID;

function strings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach(child => strings(child, out));
  else if (isRecord(node)) for (const [key, child] of Object.entries(node)) { out.push(key); strings(child, out); }
  return out;
}
function numberLexemes(node: unknown, out: string[] = []): string[] {
  if (isFhirDecimal(node)) out.push(node.lexeme);
  else if (typeof node === 'number') out.push(JSON.stringify(node));
  else if (Array.isArray(node)) node.forEach(child => numberLexemes(child, out));
  else if (isRecord(node)) Object.values(node).forEach(child => numberLexemes(child, out));
  return out;
}

export interface TerminologyResult { resources: Rec[]; replacedCodings: number; replacedTexts: number }
/**
 * The pure core: returns the resources with restricted Encounter codings replaced. Unchanged resources are returned as
 * the same objects; a changed Encounter is a shallow copy whose replaced concepts keep their key order.
 */
export function replaceEncounterTerminology(resources: readonly Rec[]): TerminologyResult {
  const numbering = { type: new Map<string, number>(), reasonCode: new Map<string, number>() };
  const removed = new Set<string>();
  let replacedCodings = 0, replacedTexts = 0;
  const out = resources.map(resource => {
    if (resource.resourceType !== 'Encounter') return resource;
    let copy: Rec | undefined;
    for (const field of ['type', 'reasonCode'] as const) {
      const concepts = resource[field];
      if (concepts === undefined) continue;
      if (!Array.isArray(concepts)) return fault('TERMINOLOGY_SHAPE_INVALID');
      const synthetic = SYNTHETIC_ENCOUNTER_CODINGS[field];
      const next = concepts.map(concept => {
        if (!isRecord(concept) || !closedKeys(concept, ['coding', 'text']) || !optionalText(concept.text)) return fault('TERMINOLOGY_SHAPE_INVALID');
        if (concept.coding === undefined) return concept;
        if (!Array.isArray(concept.coding)) return fault('TERMINOLOGY_SHAPE_INVALID');
        let first: string | undefined;
        const coding = concept.coding.map(c => {
          if (!isRecord(c) || !closedKeys(c, ['system', 'code', 'display']) || ![c.system, c.code, c.display].every(optionalText)) return fault('TERMINOLOGY_SHAPE_INVALID');
          if (!restricted(c.system)) return c;
          if (typeof c.code !== 'string' || c.code.length === 0) return fault('TERMINOLOGY_SHAPE_INVALID');
          let n = numbering[field].get(c.code);
          if (n === undefined) numbering[field].set(c.code, n = numbering[field].size + 1);
          removed.add(c.code);
          if (typeof c.display === 'string') removed.add(c.display);
          replacedCodings++;
          const display = `${synthetic.display}${n}`;
          first ??= display;
          return { system: synthetic.system, code: `${synthetic.code}${n}`, display };
        });
        if (first === undefined) return concept;
        const replaced: Rec = { ...concept, coding };
        if (typeof concept.text === 'string') { removed.add(concept.text); replaced.text = first; replacedTexts++; }
        return replaced;
      });
      if (next.some((concept, i) => concept !== concepts[i])) (copy ??= { ...resource })[field] = next;
    }
    return copy ?? resource;
  });
  if (out.some(resource => restrictedTerminology(resource))) fault('TERMINOLOGY_UNMAPPED');
  const escaped = [...removed].filter(value => value.trim().length > 0).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escaped.length) {
    const residue = new RegExp(`(?<![A-Za-z0-9])(?:${escaped.join('|')})(?![A-Za-z0-9])`, 'i');
    if (out.some(resource => strings(resource).some(value => residue.test(value)))) fault('TERMINOLOGY_RESIDUE');
  }
  return { resources: out, replacedCodings, replacedTexts };
}

export interface TerminologyRecord {
  schema: typeof TERMINOLOGY_SCHEMA; script: typeof TERMINOLOGY_SCRIPT; script_sha256: string; input_ndjson_sha256: string; replaced_codings: number; replaced_texts: number;
}
export interface TerminologyManifest extends SeedManifest { terminology: TerminologyRecord }
/**
 * The seed-level step: a natural seed in (structure-checked; a seed that already records the step refuses), the same
 * rows out with changed rows re-serialized, row and file hashes recomputed and the step recorded, checked as the edge
 * merge will check it.
 */
export function replaceSeedTerminology(seed: SeedFiles): { ndjson: string; manifest: TerminologyManifest } {
  validateSeedStructure(seed);
  if (Object.hasOwn(seed.manifest, 'terminology')) throw new EdgeError('SEED_INVALID');
  const lines = seed.ndjson.slice(0, -1).split('\n');
  const bodies = lines.map(line => parseFhirJson(line) as Rec);
  const result = replaceEncounterTerminology(bodies);
  const written = result.resources.map((resource, i) => {
    if (resource === bodies[i]) return lines[i]!;
    const body = stringifyFhir(resource);
    if (numberLexemes(parseFhirJson(body)).join('\u0000') !== numberLexemes(bodies[i]).join('\u0000')) fault('LEXEME_CHANGED');
    return body;
  });
  const ndjson = written.map(line => `${line}\n`).join('');
  const resources = seed.manifest.resources.map((row, i) => ({ ...row, bytes: Buffer.byteLength(written[i]!, 'utf8'), sha256: sha256(written[i]!) }));
  const manifest: TerminologyManifest = { ...seed.manifest, resources, ndjson_sha256: sha256(ndjson),
    terminology: { schema: TERMINOLOGY_SCHEMA, script: TERMINOLOGY_SCRIPT, script_sha256: TERMINOLOGY_SCRIPT_SHA256, input_ndjson_sha256: seed.manifest.ndjson_sha256,
      replaced_codings: result.replacedCodings, replaced_texts: result.replacedTexts } };
  validateSeed({ ndjson, manifest });
  return { ndjson, manifest };
}

export type TerminologyCliFault = TerminologyFault | EdgeCliFault;
/** Reads `resources.ndjson` and `seed-manifest.json` from the natural seed directory and publishes the step's output into a new or empty directory. */
export function runTerminologyCli(args: readonly string[], substitutes: Partial<EdgeIo> = {}): { code: 0 | 1; line: string } {
  const failed = (code: TerminologyCliFault) => ({ code: 1 as const, line: `quickstart-terminology: ${code}` });
  const io: EdgeIo = { ...NODE_IO, ...substitutes };
  try {
    const [seedDir, outDir] = args;
    if (!seedDir || !outDir || args.length !== 2) return failed('USAGE');
    const ndjsonPath = join(seedDir, 'resources.ndjson'), manifestPath = join(seedDir, 'seed-manifest.json');
    if (![ndjsonPath, manifestPath].every(p => existsSync(p) && lstatSync(p).isFile())) return failed('INPUT_MISSING');
    if (existsSync(outDir) && (!lstatSync(outDir).isDirectory() || readdirSync(outDir).length)) return failed('OUT_NOT_EMPTY');
    const ndjsonBytes = readBounded(ndjsonPath, CLI_INPUT_LIMITS.ndjson, io), manifestBytes = readBounded(manifestPath, CLI_INPUT_LIMITS.manifest, io);
    let manifest: SeedManifest, ndjson: string;
    try {
      const utf8 = new TextDecoder('utf-8', { fatal: true });
      manifest = JSON.parse(utf8.decode(manifestBytes)) as SeedManifest;
      ndjson = utf8.decode(ndjsonBytes);
    } catch { return failed('SEED_INVALID'); }
    const result = replaceSeedTerminology({ ndjson, manifest });
    publishOutput(outDir, { 'resources.ndjson': result.ndjson, 'seed-manifest.json': `${JSON.stringify(result.manifest, null, 2)}\n` }, io);
    const { replaced_codings: codings, replaced_texts: texts } = result.manifest.terminology;
    return { code: 0, line: `quickstart-terminology: ${result.manifest.resources.length} resources; ${codings} codings and ${texts} texts replaced; ndjson sha256 ${result.manifest.ndjson_sha256}` };
  } catch (error) {
    return failed(error instanceof TerminologyError || error instanceof EdgeError || error instanceof CliFault ? error.code : 'IO_FAILED');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, line } = runTerminologyCli(process.argv.slice(2));
  (code ? process.stderr : process.stdout).write(`${line}\n`);
  process.exitCode = code;
}
