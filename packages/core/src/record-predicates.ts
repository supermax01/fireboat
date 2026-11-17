// Gateway-checked filters: one record-level meaning per search
// parameter type, used to accept a search page that carries no self link. Pure helpers over authorized raw records:
// no transport, no fetching, nothing is post-filtered. A predicate is checkable only when this module can parse it
// AND the pinned R4 index classifies its parameter as a simple element path (generated, never parsed at run time).
// Everything else is uncheckable and fails closed at the caller.
//
// Semantics are contradiction-only: a record FAILS a predicate only when no reading of its value can match, allowing
// for a missing timezone (14 hours either way) and lower precision, so a correct server is never refused at a
// boundary. A record that cannot be judged (an unsupported choice variant, an extension-only or malformed value, a
// reference this gateway cannot resolve to a same-source `Type/id`) is uncheckable, and the caller refuses the page.
import type { FhirResource } from './contracts.js';
import { parseReference } from './privacy.js';
import { DENIED_SEARCH_PARAMETERS, GATEWAY_CONTROLS, parseFhirDateInterval, splitEscapedList, splitIdList, tokenAlternatives, type QueryPair } from './query.js';
import { R4_CHECKABLE_PARAMETERS, type CheckablePath } from './generated/r4-checkable-paths.js';
import catalogFile from './generated/r4-search-parameters.json' with { type: 'json' };

/** Widening applied to each side of a value written without a timezone (UTC-12:00 to UTC+14:00, rounded up). */
export const ZONELESS_SLACK_MS = 14 * 60 * 60 * 1000;
/** Date prefixes the checker understands; `ne`, `ap`, `sa` and `eb` stay uncheckable. */
export const CHECKABLE_DATE_PREFIXES: readonly string[] = ['eq', 'ge', 'le', 'gt', 'lt'];

const FHIR_ID = /^[A-Za-z0-9.-]{1,64}$/;
const TYPED_ID = /^([A-Z][A-Za-z]{1,63})\/([A-Za-z0-9.-]{1,64})$/;
const isId = (value: string): boolean => FHIR_ID.test(value) && value !== '.' && value !== '..';

/** A record value as its widest reading: the earliest possible start and the latest possible end. */
export interface RecordRange { lo: number; hi: number }
/** A search value's start and end, each at its earliest and latest reading. */
export interface SearchRange { startMin: number; startMax: number; endMin: number; endMax: number }
type TokenAlt = { system?: string; code: string };
type ReferenceAlt = { type?: string; id: string };
export type CheckablePredicate =
  | { name: string; kind: 'id'; ids: readonly string[] }
  | { name: string; kind: 'token'; alternatives: readonly TokenAlt[]; paths: readonly CheckablePath[] }
  | { name: string; kind: 'date'; alternatives: readonly { prefix: string; range: SearchRange }[]; paths: readonly CheckablePath[] }
  | { name: string; kind: 'reference'; alternatives: readonly ReferenceAlt[]; paths: readonly CheckablePath[] };

/** One FHIR date/dateTime/instant lexeme at its precision, with the slack its missing timezone allows; undefined when it cannot be compared. */
function dateInterval(text: unknown): { start: number; end: number; slack: number } | undefined {
  if (typeof text !== 'string') return undefined;
  const interval = parseFhirDateInterval(text);
  if (!interval || interval.subMillisecond) return undefined;
  return { start: interval.start, end: interval.end, slack: interval.timezoneQualified ? 0 : ZONELESS_SLACK_MS };
}

/** A search date alternative: an explicit or implicit `eq`, `ge`, `le`, `gt` or `lt` prefix and a comparable value. */
function dateAlternative(raw: string): { prefix: string; range: SearchRange } | undefined {
  const explicit = /^[a-z]{2}/.test(raw) ? raw.slice(0, 2) : undefined;
  const prefix = explicit ?? 'eq';
  if (!CHECKABLE_DATE_PREFIXES.includes(prefix)) return undefined;
  const interval = dateInterval(explicit ? raw.slice(2) : raw);
  if (!interval) return undefined;
  const { start, end, slack } = interval;
  return { prefix, range: { startMin: start - slack, startMax: start + slack, endMin: end - slack, endMax: end + slack } };
}

/**
 * Parse one material pair into a gateway-checkable predicate, or undefined when the gateway cannot check it.
 * `definitionUrl` is the pinned definition the gateway resolved for this name; it must be the classified one.
 */
export function checkablePredicate(resourceType: string, pair: QueryPair, definitionUrl: string | undefined): CheckablePredicate | undefined {
  if (pair.name.includes(':')) return undefined; // Every modifier stays uncheckable.
  if (pair.name === '_id') {
    const ids = splitIdList(pair.value);
    return ids && ids.length && ids.every(isId) ? { name: pair.name, kind: 'id', ids } : undefined;
  }
  const parameter = R4_CHECKABLE_PARAMETERS.get(resourceType)?.get(pair.name);
  if (!parameter || definitionUrl !== parameter.url) return undefined;
  if (parameter.type === 'token') {
    const tokens = tokenAlternatives(pair.value);
    if (!tokens?.length) return undefined;
    const alternatives: TokenAlt[] = [];
    for (const token of tokens) {
      // `system|code` and a bare `code` only: `|code` (no system) and `system|` (any code) stay uncheckable.
      if (token.system === null || token.code === undefined || token.code === '') return undefined;
      if (token.system !== undefined && token.system === '') return undefined;
      alternatives.push(token.system === undefined ? { code: token.code } : { system: token.system, code: token.code });
    }
    return { name: pair.name, kind: 'token', alternatives, paths: parameter.paths };
  }
  const raw = splitEscapedList(pair.value);
  if (!raw?.length) return undefined;
  if (parameter.type === 'date') {
    const alternatives = raw.map(dateAlternative);
    return alternatives.every(Boolean) ? { name: pair.name, kind: 'date', alternatives: alternatives as { prefix: string; range: SearchRange }[], paths: parameter.paths } : undefined;
  }
  const alternatives: ReferenceAlt[] = [];
  for (const value of raw) {
    // `Type/id` or a bare id only: absolute, versioned, conditional, chained and contained forms stay uncheckable.
    const typed = TYPED_ID.exec(value);
    if (typed && isId(typed[2]!)) alternatives.push({ type: typed[1]!, id: typed[2]! });
    else if (isId(value)) alternatives.push({ id: value });
    else return undefined;
  }
  return { name: pair.name, kind: 'reference', alternatives, paths: parameter.paths };
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [value];
const choiceKey = (leaf: string, type: string): string => `${leaf}${type[0]!.toUpperCase()}${type.slice(1)}`;

/** Leaf values of one path with their declared type; `unjudgeable` when the record holds a value this path cannot read. */
function collect(record: FhirResource, path: CheckablePath): { values: { type: string; value: unknown }[]; unjudgeable: boolean } {
  let nodes: Record<string, unknown>[] = [record];
  let unjudgeable = false;
  for (const step of path.steps) {
    const next: Record<string, unknown>[] = [];
    for (const node of nodes) {
      if (node[step] === undefined) continue;
      for (const item of asArray(node[step])) if (isObject(item)) next.push(item); else unjudgeable = true;
    }
    nodes = next;
  }
  const values: { type: string; value: unknown }[] = [];
  const read = (node: Record<string, unknown>, key: string, type: string, checkable: boolean) => {
    const value = node[key], companion = node[`_${key}`];
    // An extension-only primitive (a companion without a value, or a null slot in an array) cannot be judged.
    if (companion !== undefined && (value === undefined || (Array.isArray(value) && value.some(item => item === null)))) unjudgeable = true;
    if (value === undefined) return;
    if (!checkable) { unjudgeable = true; return; }
    for (const item of asArray(value)) if (item !== null) values.push({ type, value: item });
  };
  for (const node of nodes) {
    if (path.choice) {
      for (const type of path.types) read(node, choiceKey(path.leaf, type), type, true);
      for (const type of path.other) read(node, choiceKey(path.leaf, type), type, false);
    } else read(node, path.leaf, path.types[0]!, true);
  }
  return { values, unjudgeable };
}

const sameCode = (a: string, b: string): boolean => a === b || a.toLowerCase() === b.toLowerCase();

/** Codings carried by one token value; `undefined` when the value is malformed for its type. */
function codings(type: string, value: unknown): { system?: string; code: string; implicitSystem?: true }[] | undefined {
  const text = (field: unknown): string | undefined | null => field === undefined ? undefined : typeof field === 'string' ? field : null;
  if (type === 'code') return typeof value === 'string' ? [{ code: value, implicitSystem: true }] : undefined;
  if (!isObject(value)) return undefined;
  const coding = (node: Record<string, unknown>, codeField: string) => {
    const system = text(node.system), code = text(node[codeField]);
    if (system === null || code === null) return undefined;
    return code === undefined ? [] : [{ ...(system !== undefined ? { system } : {}), code }];
  };
  if (type === 'Coding') return coding(value, 'code');
  if (type === 'Identifier') return coding(value, 'value');
  // CodeableConcept: its codings only; text never matches a token.
  if (value.coding === undefined) return [];
  const out: { system?: string; code: string }[] = [];
  for (const item of asArray(value.coding)) {
    if (!isObject(item)) return undefined;
    const parsed = coding(item, 'code');
    if (!parsed) return undefined;
    out.push(...parsed);
  }
  return out;
}

function tokenMatch(alternative: TokenAlt, coding: { system?: string; code: string; implicitSystem?: true }): boolean {
  if (!sameCode(coding.code, alternative.code)) return false;
  // A `code` element's system is implied by its binding, so only the code can contradict.
  if (alternative.system === undefined || coding.implicitSystem) return true;
  return coding.system === alternative.system;
}

/** The widest reading of one date-typed value; `missing` for an empty Period, undefined when it cannot be compared. */
function valueRange(type: string, value: unknown): RecordRange | 'missing' | undefined {
  if (type !== 'Period') {
    const interval = dateInterval(value);
    return interval && { lo: interval.start - interval.slack, hi: interval.end + interval.slack };
  }
  if (!isObject(value)) return undefined;
  if (value.start === undefined && value.end === undefined) return 'missing';
  const lo = value.start === undefined ? undefined : dateInterval(value.start);
  const hi = value.end === undefined ? undefined : dateInterval(value.end);
  if ((value.start !== undefined && !lo) || (value.end !== undefined && !hi)) return undefined;
  // An open Period end extends without limit.
  return { lo: lo ? lo.start - lo.slack : Number.NEGATIVE_INFINITY, hi: hi ? hi.end + hi.slack : Number.POSITIVE_INFINITY };
}

/**
 * Whether some reading of the record range can satisfy the prefix against some reading of the search value.
 * eq: the ranges can overlap. gt/ge: the record can extend past the search end/start. lt/le: the record can begin
 * before the search start/end. These contain the R4 rules (containment for eq), so a correct server always passes.
 */
export function dateCanMatch(prefix: string, record: RecordRange, search: SearchRange): boolean {
  switch (prefix) {
    case 'eq': return record.lo < search.endMax && search.startMin < record.hi;
    case 'gt': return record.hi > search.endMin;
    case 'ge': return record.hi > search.startMin;
    case 'lt': return record.lo < search.startMax;
    case 'le': return record.lo < search.endMax;
    default: return false;
  }
}

/**
 * One record against one predicate: true when some reading can match, false when none can (a contradiction),
 * undefined when the record cannot be judged.
 */
export function recordMatches(predicate: CheckablePredicate, record: FhirResource, base: URL): boolean | undefined {
  if (predicate.kind === 'id') return typeof record.id === 'string' && predicate.ids.includes(record.id);
  let unjudgeable = false;
  for (const path of predicate.paths) {
    const collected = collect(record, path);
    unjudgeable ||= collected.unjudgeable;
    for (const { type, value } of collected.values) {
      if (predicate.kind === 'token') {
        const found = codings(type, value);
        if (!found) { unjudgeable = true; continue; }
        if (predicate.alternatives.some(alternative => found.some(coding => tokenMatch(alternative, coding)))) return true;
      } else if (predicate.kind === 'date') {
        const range = valueRange(type, value);
        if (range === 'missing') continue;
        if (!range) { unjudgeable = true; continue; }
        if (predicate.alternatives.some(alternative => dateCanMatch(alternative.prefix, range, alternative.range))) return true;
      } else {
        const reference = isObject(value) ? value.reference : undefined;
        if (typeof reference !== 'string') { unjudgeable = true; continue; }
        const parsed = parseReference(reference, base);
        // Only a relative or same-source absolute `Type/id` can be compared with the search value.
        if (!(parsed.form === 'relative' || (parsed.form === 'absolute' && parsed.sameSource)) || !parsed.type || !parsed.id) { unjudgeable = true; continue; }
        if (predicate.alternatives.some(alternative => alternative.id === parsed.id && (alternative.type === undefined || alternative.type === parsed.type))) return true;
      }
    }
  }
  return unjudgeable ? undefined : false;
}

export type RecordCheck = { status: 'ok' } | { status: 'uncheckable'; parameter: string } | { status: 'contradicted'; parameter: string };

/**
 * Every predicate (repeated parameters are each checked; alternatives within one are ORed) against every record.
 * A contradiction anywhere refuses the page; an unjudgeable record refuses it too, as uncheckable.
 */
export function checkReturnedRecords(predicates: readonly CheckablePredicate[], records: readonly FhirResource[], base: URL): RecordCheck {
  let uncheckable: string | undefined;
  for (const predicate of predicates) {
    for (const record of records) {
      const outcome = recordMatches(predicate, record, base);
      if (outcome === false) return { status: 'contradicted', parameter: predicate.name };
      if (outcome === undefined) uncheckable ??= predicate.name;
    }
  }
  return uncheckable === undefined ? { status: 'ok' } : { status: 'uncheckable', parameter: uncheckable };
}

const KNOWN_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  ...(catalogFile as unknown as { definitions: { code: string }[] }).definitions.map(definition => definition.code),
  ...GATEWAY_CONTROLS.map(control => control.name), ...DENIED_SEARCH_PARAMETERS,
].map(name => name.toLowerCase()));

/** True when `name`, compared without case, is a pinned R4 search parameter code or a gateway control or denied name. */
export function isKnownParameterName(name: string): boolean {
  return name.startsWith('_') || KNOWN_PARAMETER_NAMES.has(name.toLowerCase());
}
