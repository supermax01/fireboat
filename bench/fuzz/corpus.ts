// Robustness fuzz corpus: 100 shared, synthetic, server-neutral cases in fuzz/corpus.json.
// Cases are abstract: an operation the arm's adapter expresses (op), a mutation of the adapter's tool call driven by the
// listed tool schema (mutate), a page handle handed to the adapter's next() (cursor), or a read or search of an
// Observation whose value lexeme the mock backend serves (number). Templates are filled at run time.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODE_BENCH } from '../lib/paths.js';
import { sha256Hex } from '../lib/hash.js';
import type { SearchParams } from '../lib/types.js';

export const CORPUS_PATH = join(CODE_BENCH, 'fuzz', 'corpus.json');

export type FuzzCategory =
  | 'malformed_input' | 'unknown_type' | 'unsupported_param' | 'invalid_date' | 'page_size' | 'long_string' | 'non_ascii'
  | 'injection' | 'canary_url' | 'bad_cursor' | 'adversarial_number';
export const CATEGORIES: readonly FuzzCategory[] = [
  'malformed_input', 'unknown_type', 'unsupported_param', 'invalid_date', 'page_size', 'long_string', 'non_ascii',
  'injection', 'canary_url', 'bad_cursor', 'adversarial_number',
];

/** error: a structured error is the right answer. either: a structured error or a clean result. value: preserved or refused. */
export type Expect = 'error' | 'either' | 'value';

export type FuzzOp =
  | { op: 'capabilities'; type: string | null }
  | { op: 'read'; type: string; id: string }
  | { op: 'search'; type: string; params: SearchParams };

export type Mutation =
  | 'drop_all_required' | 'drop_first_required' | 'empty_arguments'
  | 'required_string_to_number' | 'required_string_to_array' | 'required_string_to_object' | 'required_string_to_null' | 'required_string_to_boolean'
  | 'container_to_string' | 'nested_leaf_to_number' | 'unknown_argument' | 'all_strings_to_canary';
export const MUTATIONS: readonly Mutation[] = [
  'drop_all_required', 'drop_first_required', 'empty_arguments', 'required_string_to_number', 'required_string_to_array',
  'required_string_to_object', 'required_string_to_null', 'required_string_to_boolean', 'container_to_string',
  'nested_leaf_to_number', 'unknown_argument', 'all_strings_to_canary',
];

export type CursorTransform = 'truncate' | 'flip' | 'replay' | 'reorigin_backend';

interface Base { id: string; category: FuzzCategory; expect: Expect; note: string }
export type FuzzCase =
  | (Base & { kind: 'op'; op: FuzzOp; page_size?: number })
  | (Base & { kind: 'mutate'; base: FuzzOp | { op: 'next' }; mutation: Mutation; malformed_mcp: boolean })
  | (Base & { kind: 'cursor'; cursor: string | null; transform?: CursorTransform })
  | (Base & { kind: 'number'; lexeme: string; number_id: string; via: 'read' | 'search' });

export interface Corpus {
  schema: 'fbbench.fuzz-corpus/1';
  version: string;
  label: string;
  setup_search: { op: 'search'; type: string; params: SearchParams; page_size: number };
  cases: FuzzCase[];
  sha256: string;
}

/** Loads and validates the corpus (plain JSON: the corpus holds no FHIR numbers; lexemes are strings). */
export function loadCorpus(path = CORPUS_PATH): Corpus {
  const text = readFileSync(path, 'utf8');
  const c = JSON.parse(text) as Corpus;
  if (c.schema !== 'fbbench.fuzz-corpus/1') throw new Error(`${path}: wrong schema`);
  if (c.cases.length !== 100) throw new Error(`${path}: ${c.cases.length} cases, expected 100`);
  const ids = new Set<string>();
  for (const k of c.cases) {
    if (!/^F[0-9]{3}$/.test(k.id) || ids.has(k.id)) throw new Error(`${path}: bad or duplicate id ${k.id}`);
    ids.add(k.id);
    if (!CATEGORIES.includes(k.category)) throw new Error(`${k.id}: unknown category ${k.category}`);
    if (!['error', 'either', 'value'].includes(k.expect)) throw new Error(`${k.id}: bad expect`);
    if (k.kind === 'mutate' && !MUTATIONS.includes(k.mutation)) throw new Error(`${k.id}: unknown mutation ${k.mutation}`);
    if (k.kind === 'number' && (k.expect !== 'value' || !/^fbfuzz-num-[0-9]+$/.test(k.number_id))) throw new Error(`${k.id}: bad number case`);
  }
  return { ...c, sha256: sha256Hex(text) };
}

export interface TemplateVars { patient: string; other_patient: string; canary_port: number; proxy: string; case: string }

/** Fills {{...}} templates in every string of a value. */
export function fill<T>(value: T, v: TemplateVars): T {
  const one = (s: string) => s
    .replace(/\{\{repeat:(.):([0-9]{1,7})\}\}/g, (_, ch: string, n: string) => ch.repeat(Number(n)))
    .replace(/\{\{canary\}\}/g, canaryUrl(v))
    .replace(/\{\{(patient|other_patient|canary_port|proxy|case)\}\}/g, (_, k: keyof TemplateVars) => String(v[k]));
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return one(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [one(k), walk(y)]));
    return x;
  };
  return walk(value) as T;
}

export const canaryUrl = (v: Pick<TemplateVars, 'canary_port' | 'case'>) => `http://127.0.0.1:${v.canary_port}/fbfuzz-canary/${v.case}`;
