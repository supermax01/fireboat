/**
 * For pages without a self link: derive the search parameters whose R4 expression is a
 * simple element path the gateway can check on a returned record, from the two pinned R4 indexes that are themselves
 * generated from hl7.fhir.r4.core 4.0.1 (`packages/core/src/generated/r4-search-parameters.json` and
 * `packages/core/src/generated/r4-index.json`). No expression is evaluated here or parsed at run time: the gateway
 * walks only the element steps recorded in the generated module. Anything outside the reviewed shapes is left out,
 * so it stays uncheckable and fails closed.
 *
 * Reviewed shapes, per alternative of one resource type: `Type.a.b`, `Type.a.as(T)` and `(Type.a as T)`. Only
 * definitions whose base names concrete resource types are considered (never `Resource` or `DomainResource`), and
 * only the token, date and reference types. A path must resolve in the pinned type index: intermediate steps are
 * non-choice backbone or complex-datatype elements, the last step may be a choice (`[x]`). Leaf types allowed per
 * parameter type: token on Coding, CodeableConcept, Identifier and code; date on date, dateTime, instant and
 * Period; reference on Reference. Other choice variants are recorded as `other`, so a record carrying one cannot
 * be judged.
 *
 *   node --import tsx scripts/generate-r4-checkable-paths.ts           # write the generated module
 *   node --import tsx scripts/generate-r4-checkable-paths.ts --check   # fail if the generated module is stale
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GENERATOR_REVISION = 'generate-r4-checkable-paths/1';
export const SEARCH_PARAMETERS_PATH = 'packages/core/src/generated/r4-search-parameters.json';
export const TYPE_INDEX_PATH = 'packages/core/src/generated/r4-index.json';
export const OUTPUT_PATH = 'packages/core/src/generated/r4-checkable-paths.ts';

const ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
  token: new Set(['Coding', 'CodeableConcept', 'Identifier', 'code']),
  date: new Set(['date', 'dateTime', 'instant', 'Period']),
  reference: new Set(['Reference']),
};

interface Definition { url: string; code: string; base: string[]; type: string; expression?: string }
interface Element { types?: string[]; content_reference?: string }
interface TypeIndex { definitions: Record<string, { kind: string; elements: Record<string, Element> }> }
export interface GeneratedPath { steps: string[]; leaf: string; choice: boolean; types: string[]; other: string[] }
export interface GeneratedParameter { url: string; type: 'token' | 'date' | 'reference'; paths: GeneratedPath[] }

/** Split on `|` outside parentheses and quotes; undefined when the expression is unbalanced. */
function topLevelAlternatives(expression: string): string[] | undefined {
  const parts: string[] = [];
  let depth = 0, quote = false, current = '';
  for (let i = 0; i < expression.length; i++) {
    const char = expression[i]!;
    if (quote) { current += char; if (char === '\\') { current += expression[i + 1] ?? ''; i++; } else if (char === "'") quote = false; continue; }
    if (char === "'") { quote = true; current += char; continue; }
    if (char === '(') depth++;
    if (char === ')') { depth--; if (depth < 0) return undefined; }
    if (char === '|' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (depth !== 0 || quote) return undefined;
  parts.push(current.trim());
  return parts;
}

const PLAIN = /^([A-Z][A-Za-z]+)((?:\.[a-z][A-Za-z0-9]*)+)$/;
const AS_CALL = /^([A-Z][A-Za-z]+)((?:\.[a-z][A-Za-z0-9]*)+)\.as\(([A-Za-z]+)\)$/;
const AS_OPERATOR = /^\(([A-Z][A-Za-z]+)((?:\.[a-z][A-Za-z0-9]*)+) as ([A-Za-z]+)\)$/;

/** One alternative: its root type, element segments and optional `as` restriction, or undefined when not simple. */
function simpleAlternative(alternative: string): { root: string; segments: string[]; as?: string } | undefined {
  const match = PLAIN.exec(alternative) ?? AS_CALL.exec(alternative) ?? AS_OPERATOR.exec(alternative);
  if (!match) return undefined;
  return { root: match[1]!, segments: match[2]!.slice(1).split('.'), ...(match[3] ? { as: match[3] } : {}) };
}

function resolvePath(index: TypeIndex, root: string, segments: readonly string[], as: string | undefined, parameterType: string): GeneratedPath | undefined {
  let context = root, prefix = '';
  const steps: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const elements = index.definitions[context]?.elements;
    if (!elements) return undefined;
    const segment = segments[i]!, key = `${prefix}${segment}`;
    const plain = elements[key], choiceElement = plain ? undefined : elements[`${key}[x]`];
    const element = plain ?? choiceElement;
    if (!element || element.content_reference !== undefined || !Array.isArray(element.types) || !element.types.length) return undefined;
    const last = i === segments.length - 1;
    if (!last) {
      if (choiceElement || element.types.length !== 1) return undefined;
      const type = element.types[0]!;
      if (type === 'BackboneElement' || type === 'Element') prefix = `${key}.`;
      else if (index.definitions[type]?.kind === 'complex-type') { context = type; prefix = ''; }
      else return undefined;
      steps.push(segment);
      continue;
    }
    let types = [...element.types];
    if (as !== undefined) {
      if (!types.includes(as)) return undefined;
      types = [as];
    }
    if (!choiceElement && types.length !== 1) return undefined;
    const allowed = ALLOWED[parameterType]!;
    const checkable = types.filter(type => allowed.has(type));
    if (!checkable.length) return undefined;
    const other = choiceElement ? element.types.filter(type => !checkable.includes(type)) : [];
    if (!choiceElement && checkable.length !== types.length) return undefined;
    return { steps, leaf: segment, choice: Boolean(choiceElement), types: checkable, other };
  }
  return undefined;
}

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');

export function buildCheckableIndex(catalog: { definitions: Definition[] }, index: TypeIndex): Record<string, Record<string, GeneratedParameter>> {
  const result: Record<string, Record<string, GeneratedParameter>> = {};
  const exact = new Map<string, Definition[]>();
  for (const definition of catalog.definitions) {
    if (!['token', 'date', 'reference'].includes(definition.type)) continue;
    for (const base of definition.base) {
      if (base === 'Resource' || base === 'DomainResource') continue;
      const key = `${base}\u0000${definition.code}`;
      exact.set(key, [...(exact.get(key) ?? []), definition]);
    }
  }
  for (const [key, definitions] of [...exact].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (definitions.length !== 1) continue; // A colliding pair has no single meaning.
    const [type, code] = key.split('\u0000') as [string, string];
    const definition = definitions[0]!;
    if (!definition.expression || !index.definitions[type] || index.definitions[type]!.kind !== 'resource') continue;
    const alternatives = topLevelAlternatives(definition.expression);
    if (!alternatives) continue;
    const parsed = alternatives.map(simpleAlternative);
    // An alternative for this type that is not a simple path makes the whole parameter uncheckable here.
    const own = alternatives.map((text, i) => ({ text, parsed: parsed[i] })).filter(entry => entry.parsed ? entry.parsed.root === type : entry.text.startsWith(`${type}.`) || entry.text.startsWith(`(${type}.`) || entry.text.includes(`${type}.`));
    if (!own.length || own.some(entry => !entry.parsed)) continue;
    const paths: GeneratedPath[] = [];
    let complete = true;
    for (const entry of own) {
      const path = resolvePath(index, type, entry.parsed!.segments, entry.parsed!.as, definition.type);
      if (!path) { complete = false; break; }
      paths.push(path);
    }
    if (!complete) continue;
    (result[type] ??= {})[code] = { url: definition.url, type: definition.type as GeneratedParameter['type'], paths };
  }
  return result;
}

export function renderCheckableModule(): string {
  const catalog = JSON.parse(readFileSync(join(root, SEARCH_PARAMETERS_PATH), 'utf8')) as { definitions: Definition[] };
  const index = JSON.parse(readFileSync(join(root, TYPE_INDEX_PATH), 'utf8')) as TypeIndex;
  const built = buildCheckableIndex(catalog, index);
  const count = Object.values(built).reduce((sum, parameters) => sum + Object.keys(parameters).length, 0);
  const lines = [
    `// Generated by scripts/generate-r4-checkable-paths.ts (${GENERATOR_REVISION}) from \`${SEARCH_PARAMETERS_PATH}\` and \`${TYPE_INDEX_PATH}\`.`,
    '// Do not edit; regenerate with `node --import tsx scripts/generate-r4-checkable-paths.ts`. HL7 FHIR R4 core 4.0.1 derived data (CC0-1.0).',
    '/** One element path: intermediate steps, the leaf element, whether it is a choice (`[x]`), checkable leaf types and other choice variants. */',
    'export interface CheckablePath { readonly steps: readonly string[]; readonly leaf: string; readonly choice: boolean; readonly types: readonly string[]; readonly other: readonly string[] }',
    '/** A search parameter whose every alternative on its resource type is a checkable simple path. */',
    "export interface CheckableParameter { readonly url: string; readonly type: 'token' | 'date' | 'reference'; readonly paths: readonly CheckablePath[] }",
    `export const R4_CHECKABLE_SOURCE = ${JSON.stringify({ generator_revision: GENERATOR_REVISION, search_parameters_sha256: sha256(SEARCH_PARAMETERS_PATH), type_index_sha256: sha256(TYPE_INDEX_PATH), parameters: count })} as const;`,
    // Tuples, not object keys: parameter codes such as `method` must never read as object properties.
    'const ENTRIES: readonly (readonly [string, readonly (readonly [string, CheckableParameter])[]])[] = [',
    ...Object.entries(built).map(([type, parameters]) => `  [${JSON.stringify(type)}, ${JSON.stringify(Object.entries(parameters))}],`),
    '];',
    '/** Resource type, then search parameter code, to its checkable paths. Absent means uncheckable. */',
    'export const R4_CHECKABLE_PARAMETERS: ReadonlyMap<string, ReadonlyMap<string, CheckableParameter>> = new Map(ENTRIES.map(([type, parameters]) => [type, new Map(parameters)]));',
    '',
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const expected = renderCheckableModule();
  const target = join(root, OUTPUT_PATH);
  if (process.argv.includes('--check')) {
    let actual = '';
    try { actual = await readFile(target, 'utf8'); } catch { /* missing reads as stale */ }
    if (actual !== expected) { console.error(`generate-r4-checkable-paths: ${OUTPUT_PATH} is stale; regenerate it.`); process.exit(1); }
    console.log('generate-r4-checkable-paths: in sync');
    return;
  }
  await writeFile(target, expected);
  console.log(`generate-r4-checkable-paths: wrote ${OUTPUT_PATH}`);
}

if (isMainModule(import.meta.url)) main().catch(error => { console.error(`generate-r4-checkable-paths: ${error instanceof Error ? error.message : 'failed'}`); process.exit(2); });
