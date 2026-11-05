// Owner: Q (typed discovery, support, query proof).
// Typed, bounded SearchParameter resolution and pre-send syntax/selector
// validation (spec section 1). Discovery never widens access: a source
// declaration becomes executable only through an unambiguous pinned R4
// selection (or an approved gateway control), canonical definitions are
// identifiers that are never fetched, and Patient-targeting reference
// parameters fail closed while their type or targets are unknown.
import { createHmac, randomBytes } from 'node:crypto';
import type { ReviewedNames } from './contracts.js';
import { parseReference, resourceClass } from './privacy.js';
import { GatewayFault } from './transport.js';
import {
  DENIED_SEARCH_PARAMETERS, GATEWAY_CONTROLS, isLexicalFhirDate, isProvingSearchProfile, splitEscapedList,
  type QueryPair, type SearchProfile,
} from './query.js';
import { supportForType } from './support.js';
import catalogFile from './generated/r4-search-parameters.json' with { type: 'json' };

export interface DeclaredSearchParam {
  name: string;
  type?: string;
  definition?: string;
  /** True when the source supplied documentation text. The text itself is dropped before caching. */
  source_description_present: boolean;
  /** Internal: a supplied canonical was withheld (protected or malformed). Never disclosed. */
  definition_withheld?: boolean;
  /** Internal: a supplied type was present but invalid (Q-7). Never disclosed as a type. */
  type_invalid?: boolean;
  /** Internal: a duplicate name declared a differing type/definition (Q-7). */
  duplicate_conflict?: boolean;
}

export interface PinnedDefinition {
  url: string; code: string; base: string[]; type: string;
  version?: string; target?: string[]; comparator?: string[]; modifier?: string[];
  chain?: string[]; multipleAnd?: boolean; multipleOr?: boolean;
  expression?: string; description?: string;
}

interface SearchParameterCatalog {
  package: string; version: string; source_sha256: string; generator_revision: string;
  definitions: PinnedDefinition[];
}

const catalog = catalogFile as unknown as SearchParameterCatalog;
export const SEARCH_PARAMETER_DEFINITIONS = { package: 'hl7.fhir.r4.core', version: '4.0.1', source_sha256: catalog.source_sha256 } as const;
export const PINNED_SEARCH_PARAMETER_COUNT = catalog.definitions.length;

// Selection scans the 1,397-entry pinned catalog directly (discovery-time
// only); one implementation keeps the ambiguity guard in exactly one place.

const PARAMETER_TYPES = new Set(['number', 'date', 'string', 'token', 'reference', 'composite', 'quantity', 'uri', 'special', 'unknown']);
const SOURCE_ONLY_DESCRIPTION = 'Source-declared parameter; no reviewed definition.';
const NAME_SHAPE = /^_?[A-Za-z][A-Za-z0-9_-]{0,79}$/;
// S2 revision identity is local to this process. A keyed digest prevents a
// retained fingerprint from becoming a cross-process dictionary of raw names.
const withheldNameKey = randomBytes(32);

export function retainDeclaredName(name: string, resourceType?: string): boolean {
  return GATEWAY_CONTROLS.some(control => control.name === name)
    || (resourceType === undefined
      ? catalog.definitions.some(definition => definition.code === name)
      : selectPinnedDefinition(resourceType, name).status === 'selected');
}

/** Declarations resolved per resource type; discovery treats a longer list as ambiguous (R5). */
export const MAX_SEARCH_PARAM_DECLARATIONS = 1024;

/** Only this count and keyed set digest survive ingress for source-only names. */
export function withheldCapabilityNames(searchParam: unknown, resourceType: string): { withheldNameCount: number; withheldNameDigest?: string } {
  const names = new Set<string>();
  for (const raw of Array.isArray(searchParam) ? searchParam.slice(0, MAX_SEARCH_PARAM_DECLARATIONS) : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const name = (raw as Record<string, unknown>).name;
    if (typeof name === 'string' && NAME_SHAPE.test(name) && !retainDeclaredName(name, resourceType)) names.add(name);
  }
  return {
    withheldNameCount: names.size,
    ...(names.size ? { withheldNameDigest: createHmac('sha256', withheldNameKey).update(JSON.stringify([...names].sort())).digest('hex') } : {}),
  };
}

function isProtectedDefinitionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['data:', 'javascript:', 'vbscript:', 'file:', 'blob:'].includes(url.protocol)
      || Boolean(url.username || url.password || url.search || url.hash);
  } catch { return true; }
}

/**
 * Retain only pinned/control declared names and bounded type/definition plus a documentation
 * presence flag. Source documentation bytes are dropped here, before any
 * caching, snapshot, output or logging, and are never substring-searched.
 */
export function declaredFromCapability(searchParam: unknown, resourceType?: string): DeclaredSearchParam[] {
  if (!Array.isArray(searchParam)) return [];
  const declared: DeclaredSearchParam[] = [];
  const byDeclaredName = new Map<string, DeclaredSearchParam>();
  // Q-7: resolve up to 1024 declarations so a late confinement parameter is
  // never silently dropped; listing bounds belong to discovery paging.
  for (const raw of searchParam.slice(0, MAX_SEARCH_PARAM_DECLARATIONS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.name !== 'string' || !NAME_SHAPE.test(entry.name)) continue;
    if (!retainDeclaredName(entry.name, resourceType)) continue;
    // A present-but-invalid canonical/type fails closed (Q-7): it must never
    // read as "absent" and fall back to a convenient name selection.
    const definitionPresent = 'definition' in entry && entry.definition !== undefined;
    const definitionValid = typeof entry.definition === 'string' && entry.definition.length <= 512;
    const definition = definitionValid ? entry.definition as string : undefined;
    const withheld = definitionPresent && (!definitionValid || isProtectedDefinitionUrl(definition!));
    const typePresent = 'type' in entry && entry.type !== undefined;
    const typeValid = typeof entry.type === 'string' && entry.type.length <= 80;
    const candidate: DeclaredSearchParam = {
      name: entry.name,
      ...(typeValid ? { type: entry.type as string } : {}),
      ...(definition !== undefined && !withheld ? { definition } : {}),
      source_description_present: typeof entry.documentation === 'string' && entry.documentation.length > 0,
      ...(withheld ? { definition_withheld: true } : {}),
      ...(typePresent && !typeValid ? { type_invalid: true } : {}),
    };
    const existing = byDeclaredName.get(entry.name);
    if (existing) {
      // Keep the conflict flag for typed resolution and a deterministic representative.
      const identity = (param: DeclaredSearchParam): string => JSON.stringify([param.type ?? null, param.definition ?? null, Boolean(param.definition_withheld), Boolean(param.type_invalid)]);
      const existingIdentity = identity(existing);
      const candidateIdentity = identity(candidate);
      const conflict = existing.duplicate_conflict || existingIdentity !== candidateIdentity;
      const descriptionPresent = existing.source_description_present || candidate.source_description_present;
      if (candidateIdentity < existingIdentity) {
        delete existing.type; delete existing.definition;
        delete existing.definition_withheld; delete existing.type_invalid;
        Object.assign(existing, candidate);
      }
      existing.source_description_present = descriptionPresent;
      if (conflict) existing.duplicate_conflict = true;
      continue;
    }
    byDeclaredName.set(entry.name, candidate);
    declared.push(candidate);
  }
  return declared;
}

function appliesTo(definition: PinnedDefinition, resourceType: string): boolean {
  // Q-18c: a DomainResource base (e.g. _text) is conservatively never
  // applicable; only exact-type and Resource bases apply. Also recorded
  // in the generated catalog selection_rules.
  return definition.base.includes(resourceType) || definition.base.includes('Resource');
}

export type PinnedSelection =
  | { status: 'selected'; definition: PinnedDefinition }
  | { status: 'none' }
  | { status: 'unresolved' }
  | { status: 'conflict' };

const PINNED_VERSION = '4.0.1';

function normalizeCanonical(definitionUrl: string): string | undefined {
  const bar = definitionUrl.lastIndexOf('|');
  if (bar === -1) return definitionUrl;
  // Q-7: only the pinned version suffix is accepted; any other version is
  // unresolved (fail closed), never stripped-and-trusted.
  return definitionUrl.slice(bar + 1) === PINNED_VERSION ? definitionUrl.slice(0, bar) : undefined;
}

/** Pure selection over an explicit catalog (testable with injected collisions). */
export function selectFromCatalog(
  definitions: readonly PinnedDefinition[],
  resourceType: string,
  name: string,
  definitionUrl?: string,
  definitionWithheld = false,
): PinnedSelection {
  if (definitionWithheld) return { status: 'unresolved' };
  if (definitionUrl !== undefined) {
    const normalized = normalizeCanonical(definitionUrl);
    if (normalized === undefined) return { status: 'unresolved' };
    const found = definitions.find(definition => definition.url === normalized);
    if (!found) return { status: 'unresolved' };
    if (found.code !== name || !appliesTo(found, resourceType)) return { status: 'conflict' };
    return { status: 'selected', definition: found };
  }
  const candidates = definitions.filter(definition => definition.code === name && appliesTo(definition, resourceType));
  if (!candidates.length) return { status: 'none' };
  const exact = candidates.filter(definition => definition.base.includes(resourceType));
  const chosen = exact.length ? exact : candidates;
  return chosen.length === 1 ? { status: 'selected', definition: chosen[0]! } : { status: 'conflict' };
}

/**
 * Select the pinned definition for (resourceType, name). A supplied
 * canonical must match exactly by URL, code and applicable base; a
 * conflicting or withheld canonical never falls back to a convenient name.
 * Without a canonical, name selection must be unambiguous, preferring an
 * exact-base definition over a Resource-base definition.
 */
export function selectPinnedDefinition(resourceType: string, name: string, definitionUrl?: string, definitionWithheld = false): PinnedSelection {
  return selectFromCatalog(catalog.definitions, resourceType, name, definitionUrl, definitionWithheld);
}

function reviewedDescription(definition: PinnedDefinition, resourceType: string): string {
  const raw = definition.description ?? '';
  let text = raw;
  if (raw.startsWith('Multiple Resources:')) {
    const line = raw.split(/\r?\n/).find(candidate => candidate.includes(`[${resourceType}]`));
    if (line) text = line.replace(/^\*\s*\[[^\]]+\]\([^)]*\):\s*/, '');
  }
  text = text.replace(/\s+/g, ' ').trim();
  return (text || SOURCE_ONLY_DESCRIPTION).slice(0, 240);
}

function cappedTargets(definition: PinnedDefinition | undefined): string[] {
  const targets = [...(definition?.target ?? [])].filter(target => /^[A-Z][A-Za-z0-9]+$/.test(target));
  targets.sort();
  if (targets.length <= 32) return targets;
  const kept = targets.slice(0, 32);
  if (targets.includes('Patient') && !kept.includes('Patient')) kept[31] = 'Patient';
  return kept.sort();
}

export type EvidenceLabel = 'declared' | 'observed_supported' | 'observed_unsupported' | 'unknown';
export interface SyntaxSupportView { name: string; evidence: EvidenceLabel; executable: boolean }
export interface SearchParameterView {
  name: string;
  type: string;
  definition?: string;
  definition_version?: string;
  definition_evidence: 'pinned_r4' | 'approved_overlay' | 'source_declared' | 'unresolved' | 'conflict';
  targets: string[];
  description: string;
  source_description_present: boolean;
  evidence: EvidenceLabel;
  executable: boolean;
  modifiers: SyntaxSupportView[];
  comparators: SyntaxSupportView[];
  repetition: { and: EvidenceLabel; or: EvidenceLabel };
  joins: { chain: false; has: false; include: false; revinclude: false };
  execution_evidence: EvidenceLabel;
}

/** Internal resolution detail the syntax and selector validators need. */
export interface ResolvedEntry {
  view: SearchParameterView;
  pinnedType?: string;
  pinnedBase?: readonly string[];
  /** Full uncapped pinned targets; empty with a reference type means unresolved. */
  targetsFull: string[];
  comparators?: readonly string[];
  multipleAnd?: boolean;
  multipleOr?: boolean;
  control: boolean;
}

function repetitionEvidence(flag: boolean | undefined): EvidenceLabel {
  return flag === undefined ? 'unknown' : flag ? 'declared' : 'observed_unsupported';
}

function resolveOne(resourceType: string, declared: DeclaredSearchParam | undefined, name: string, profile: SearchProfile | undefined): ResolvedEntry {
  const control = GATEWAY_CONTROLS.find(entry => entry.name === name);
  const selection = declared || control
    ? selectPinnedDefinition(resourceType, name, declared?.definition ?? control?.definition, declared?.definition_withheld ?? false)
    : ({ status: 'none' } as PinnedSelection);
  const pinned = selection.status === 'selected' ? selection.definition : undefined;
  const declaredType = declared?.type;
  const denied = DENIED_SEARCH_PARAMETERS.has(name);
  const typeConflict = Boolean(declared?.type_invalid || declared?.duplicate_conflict || (pinned && declaredType !== undefined && declaredType !== pinned.type));
  const definitionEvidence: SearchParameterView['definition_evidence'] = typeConflict || selection.status === 'conflict'
    ? 'conflict'
    : selection.status === 'unresolved' ? 'unresolved'
      : pinned ? 'pinned_r4'
        : control ? 'approved_overlay'
          : declared ? 'source_declared' : 'unresolved';
  const resolvedType = pinned?.type ?? control?.type ?? (declaredType && PARAMETER_TYPES.has(declaredType) ? declaredType : 'unknown');
  const compositeOrSpecial = resolvedType === 'composite' || (resolvedType === 'special' && name !== '_sort');
  const executable = Boolean(!denied && !typeConflict && !compositeOrSpecial && (pinned ?? (control && name === '_sort')));
  // Q-18a: comparators of an unexecutable parameter are never executable.
  const comparatorExecutable = executable && ['date', 'number', 'quantity'].includes(resolvedType);
  const view: SearchParameterView = {
    name,
    type: resolvedType,
    ...(pinned ? { definition: pinned.url, ...(pinned.version ? { definition_version: pinned.version } : {}) } : {}),
    definition_evidence: definitionEvidence,
    targets: cappedTargets(pinned),
    description: pinned ? reviewedDescription(pinned, resourceType) : control ? control.description.slice(0, 240) : SOURCE_ONLY_DESCRIPTION,
    source_description_present: declared?.source_description_present ?? false,
    evidence: declared ? 'declared' : 'unknown',
    executable,
    modifiers: (pinned?.modifier ?? []).slice(0, 16).map(modifier => ({ name: modifier, evidence: 'declared' as const, executable: false })),
    comparators: (pinned?.comparator ?? []).slice(0, 16).map(comparator => ({ name: comparator, evidence: 'declared' as const, executable: comparatorExecutable })),
    repetition: { and: repetitionEvidence(pinned?.multipleAnd), or: repetitionEvidence(pinned?.multipleOr) },
    joins: { chain: false, has: false, include: false, revinclude: false },
    execution_evidence: executable && isProvingSearchProfile(profile) && profile.testedFilters.some(entry => entry.resource_type === resourceType && entry.parameter === name) ? 'observed_supported' : 'unknown',
  };
  return {
    view,
    ...(pinned ? { pinnedType: pinned.type, pinnedBase: pinned.base } : {}),
    targetsFull: [...(pinned?.target ?? [])],
    ...(pinned?.comparator ? { comparators: pinned.comparator } : {}),
    ...(pinned?.multipleAnd !== undefined ? { multipleAnd: pinned.multipleAnd } : {}),
    ...(pinned?.multipleOr !== undefined ? { multipleOr: pinned.multipleOr } : {}),
    control: Boolean(control),
  };
}

export interface ResolveSearchParametersInput {
  resourceType: string;
  declared: readonly DeclaredSearchParam[];
  /** Whether the source advertises this resource type at all. */
  advertised: boolean;
  profile?: SearchProfile;
}

export interface ResolvedSearchParameters {
  parameters: SearchParameterView[];
  byName: ReadonlyMap<string, ResolvedEntry>;
  totalParameters: number;
}

const codepointOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Resolve every source-declared parameter plus the reviewed gateway
 * controls for one advertised, policy-supported resource type. A denied
 * or unadvertised type lists no pinned parameters.
 */
export function resolveSearchParameters(input: ResolveSearchParametersInput): ResolvedSearchParameters {
  if (!input.advertised || resourceClass(input.resourceType) === 'ambiguous') {
    throw new GatewayFault('UNSUPPORTED_RESOURCE', 'Resource type is not available to this workload.');
  }
  const names = new Set<string>([...input.declared.map(entry => entry.name), ...GATEWAY_CONTROLS.map(control => control.name)]);
  const byName = new Map<string, ResolvedEntry>();
  for (const name of names) {
    byName.set(name, resolveOne(input.resourceType, input.declared.find(entry => entry.name === name), name, input.profile));
  }
  const parameters = [...byName.values()].map(entry => entry.view)
    .sort((a, b) => codepointOrder(a.name, b.name) || codepointOrder(a.definition ?? '', b.definition ?? ''));
  return { parameters, byName, totalParameters: parameters.length };
}

export function resolveSearchParameter(
  input: ResolveSearchParametersInput & { name: string },
): ResolvedEntry | undefined {
  return resolveSearchParameters(input).byName.get(input.name);
}

/** Exact-name or case-insensitive literal substring filtering over reviewed name/description only. */
export function filterSearchParameters(parameters: readonly SearchParameterView[], filter: { name?: string; query?: string }): SearchParameterView[] {
  if (filter.name !== undefined) return parameters.filter(parameter => parameter.name === filter.name);
  if (filter.query !== undefined) {
    const needle = filter.query.toLowerCase();
    return parameters.filter(parameter => parameter.name.toLowerCase().includes(needle) || parameter.description.toLowerCase().includes(needle));
  }
  return [...parameters];
}

// ---------------------------------------------------------------------------
// Pre-send syntax validation: the executable decision table. Runs before any
// clinical request is constructed. Ordered pairs, escapes and repeated-value
// multisets are preserved; nothing is rewritten.
// ---------------------------------------------------------------------------

const JOIN_NAMES = new Set(['_include', '_revinclude', '_has']);
const NUMBER_SHAPE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function explicitPrefix(alternative: string): string | undefined {
  const candidate = alternative.slice(0, 2);
  return ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'sa', 'eb', 'ap'].includes(candidate) && /^[0-9+-]/.test(alternative.slice(2)) ? candidate : undefined;
}

function validateComparatorAndLexical(entry: ResolvedEntry, pair: QueryPair, alternatives: readonly string[]): void {
  const type = entry.view.type;
  if (!['date', 'number', 'quantity'].includes(type)) return;
  if (!alternatives.length) throw new GatewayFault('INVALID_ARGUMENTS', 'Invalid tool arguments; use the declared tool schema.');
  for (const alternative of alternatives) {
    const prefix = explicitPrefix(alternative);
    if (prefix !== undefined) {
      if (!entry.comparators || !entry.comparators.includes(prefix)) {
        throw new GatewayFault('UNSUPPORTED_COMPARATOR', 'Search comparator is not supported by the declared prototype contract.');
      }
    }
    const rest = prefix === undefined ? alternative : alternative.slice(2);
    if (type === 'date') {
      if (!isLexicalFhirDate(alternative)) throw new GatewayFault('INVALID_ARGUMENTS', 'Invalid tool arguments; use the declared tool schema.');
    } else if (type === 'number') {
      if (!NUMBER_SHAPE.test(rest)) throw new GatewayFault('INVALID_ARGUMENTS', 'Invalid tool arguments; use the declared tool schema.');
    } else {
      const segments = rest.split('|');
      if (segments.length > 3 || !NUMBER_SHAPE.test(segments[0]!)) throw new GatewayFault('INVALID_ARGUMENTS', 'Invalid tool arguments; use the declared tool schema.');
    }
  }
}

function validateSort(sortPairs: QueryPair[], byName: ReadonlyMap<string, ResolvedEntry>): string[] {
  if (!sortPairs.length) return [];
  if (sortPairs.length > 1) throw new GatewayFault('UNSUPPORTED_SORT', 'Sort is not supported by the declared prototype contract.');
  // Q-18b: never validate a trimmed key while sending the raw value.
  if (/\s/.test(sortPairs[0]!.value)) throw new GatewayFault('UNSUPPORTED_SORT', 'Sort is not supported by the declared prototype contract.');
  const keys = sortPairs[0]!.value.split(',');
  if (!keys.length || keys.length > 4 || keys.some(key => !key) || new Set(keys.map(key => key.replace(/^-/, ''))).size !== keys.length) {
    throw new GatewayFault('UNSUPPORTED_SORT', 'Sort is not supported by the declared prototype contract.');
  }
  for (const rawKey of keys) {
    const key = rawKey.replace(/^-/, '');
    if (key.includes('.') || key.includes(':')) throw new GatewayFault('UNSUPPORTED_SORT', 'Sort is not supported by the declared prototype contract.');
    const entry = byName.get(key);
    const allowed = Boolean(entry?.view.executable && ['date', 'token', 'string', 'number'].includes(entry.view.type));
    if (!allowed) throw new GatewayFault('UNSUPPORTED_SORT', 'Sort is not supported by the declared prototype contract.');
  }
  return keys;
}

export interface ValidatedSearch {
  /** Material pairs in original order, sort excluded. */
  materialPairs: QueryPair[];
  sortRequested: string[];
}

export function validateSearchSyntax(input: {
  resourceType: string;
  pairs: readonly QueryPair[];
  resolved: ResolvedSearchParameters;
  /** Source-only declarations were dropped; never retain their names to refine a refusal. */
  withheldNamesPresent?: boolean;
}): ValidatedSearch {
  const byName = input.resolved.byName;
  const sortPairs: QueryPair[] = [];
  const materialPairs: QueryPair[] = [];
  const counts = new Map<string, number>();
  for (const pair of input.pairs) {
    if (pair.name.includes('.') || JOIN_NAMES.has(pair.name) || JOIN_NAMES.has(pair.name.split(':')[0]!)) {
      throw new GatewayFault('UNSUPPORTED_SEARCH', 'Search parameter is not supported by the declared prototype contract.');
    }
    if (pair.name.includes(':')) {
      throw new GatewayFault('UNSUPPORTED_MODIFIER', 'Search modifier is not supported by the declared prototype contract.');
    }
    // Q-1: split every pair once, before any repetition or selector logic.
    // Overflow / lone backslash refuses here — no request is ever built.
    const alternatives = splitEscapedList(pair.value);
    if (alternatives === undefined) {
      throw new GatewayFault('INVALID_ARGUMENTS', 'Invalid tool arguments; use the declared tool schema.');
    }
    if (pair.name === '_sort') { sortPairs.push(pair); continue; }
    if (DENIED_SEARCH_PARAMETERS.has(pair.name)) {
      throw new GatewayFault('UNSUPPORTED_SEARCH', 'Search parameter is not supported by the declared prototype contract.');
    }
    const entry = byName.get(pair.name);
    if (!entry) {
      if (input.withheldNamesPresent) throw new GatewayFault('SEARCH_PARAMETER_UNRESOLVED', 'Search parameter typing cannot be resolved for safe execution.');
      throw new GatewayFault('UNSUPPORTED_SEARCH', 'Search parameter is not supported by the declared prototype contract.');
    }
    if (entry.view.type === 'composite' || entry.view.type === 'special') {
      throw new GatewayFault('UNSUPPORTED_SEARCH', 'Search parameter is not supported by the declared prototype contract.');
    }
    if (!entry.view.executable) {
      throw new GatewayFault('SEARCH_PARAMETER_UNRESOLVED', 'Search parameter typing cannot be resolved for safe execution.');
    }
    if (entry.multipleOr === false && alternatives.length > 1) {
      throw new GatewayFault('UNSUPPORTED_SEARCH', 'Search parameter is not supported by the declared prototype contract.');
    }
    counts.set(pair.name, (counts.get(pair.name) ?? 0) + 1);
    if (entry.multipleAnd === false && counts.get(pair.name)! > 1) {
      throw new GatewayFault('UNSUPPORTED_SEARCH', 'Search parameter is not supported by the declared prototype contract.');
    }
    validateComparatorAndLexical(entry, pair, alternatives);
    materialPairs.push({ name: pair.name, value: pair.value });
  }
  return { materialPairs, sortRequested: validateSort(sortPairs, byName) };
}

// ---------------------------------------------------------------------------
// Confinement and Patient-selector validation. Authorization precedes any
// clinical fetch; missing confinement typing fails closed.
// ---------------------------------------------------------------------------

export function confinementFor(resourceType: string, resolved: ResolvedSearchParameters, patientId: string): QueryPair | undefined {
  if (resourceType === 'Patient') return { name: '_id', value: patientId };
  if (resourceClass(resourceType) !== 'patient') return undefined;
  for (const candidate of ['patient', 'subject']) {
    const entry = resolved.byName.get(candidate);
    if (!entry) continue;
    if (!entry.view.executable || entry.view.type !== 'reference' || !entry.targetsFull.includes('Patient')) {
      throw new GatewayFault('SEARCH_PARAMETER_UNRESOLVED', 'Patient confinement typing cannot be resolved for safe execution.');
    }
    return { name: candidate, value: `Patient/${patientId}` };
  }
  throw new GatewayFault('UNSUPPORTED_CONFINEMENT', 'Source has no declared patient search predicate for this type.');
}

const BARE_ID = /^[A-Za-z0-9.-]{1,64}$/;

function isBoundPatient(alternative: string, patientId: string, base: URL): boolean {
  const parsed = parseReference(alternative, base);
  return (parsed.form === 'relative' || (parsed.form === 'absolute' && Boolean(parsed.sameSource))) && parsed.type === 'Patient' && parsed.id === patientId;
}

function isExplicitForeignPatient(alternative: string, patientId: string, base: URL): boolean {
  const parsed = parseReference(alternative, base);
  if (parsed.type === 'Patient') return !isBoundPatient(alternative, patientId, base);
  return parsed.patientLike && alternative.includes('?');
}

function patientCapable(entry: ResolvedEntry): boolean {
  if (entry.view.type !== 'reference') return false;
  // Unknown targets never mean unrestricted references.
  return entry.targetsFull.length === 0 || entry.targetsFull.includes('Patient') || entry.targetsFull.includes('Resource');
}

export function validatePatientSelectors(input: {
  resourceType: string;
  pairs: readonly QueryPair[];
  resolved: ResolvedSearchParameters;
  patientId: string;
  base: URL;
  confinementName?: string;
}): void {
  for (const pair of input.pairs) {
    const entry = input.resolved.byName.get(pair.name);
    if (!entry) throw new GatewayFault('SEARCH_PARAMETER_UNRESOLVED', 'Search parameter typing cannot be resolved for safe execution.');
    // Q-1 defence in depth: an unsplittable selector is ambiguous, never skipped.
    const alternatives = splitEscapedList(pair.value);
    if (!alternatives) throw new GatewayFault('AMBIGUOUS_PATIENT_SELECTOR', 'Patient selector is ambiguous; use the trusted current context.');
    const capable = patientCapable(entry);
    for (const alternative of alternatives) {
      if (isBoundPatient(alternative, input.patientId, input.base)) continue;
      if (isExplicitForeignPatient(alternative, input.patientId, input.base)) {
        throw new GatewayFault('POLICY_DENIED', 'Patient selector conflicts with the trusted context.');
      }
      if (!capable) continue;
      const bare = BARE_ID.test(alternative) && !alternative.includes('/');
      if (bare) {
        const polymorphicLink = input.resourceType === 'Patient' && pair.name === 'link';
        const confinementAlias = pair.name === input.confinementName && alternative === input.patientId && !polymorphicLink;
        if (!confinementAlias) throw new GatewayFault('AMBIGUOUS_PATIENT_SELECTOR', 'Patient selector is ambiguous; use the trusted current context.');
        continue;
      }
      const parsed = parseReference(alternative, input.base);
      const explicitTypedLocal = parsed.type !== undefined && parsed.type !== 'Patient'
        && (parsed.form === 'relative' || (parsed.form === 'absolute' && parsed.sameSource));
      if (explicitTypedLocal) continue;
      throw new GatewayFault('AMBIGUOUS_PATIENT_SELECTOR', 'Patient selector is ambiguous; use the trusted current context.');
    }
  }
}

/** Patient-bound admission is narrower than source-declared FHIR syntax. No target hydration. */
export function validateSearchAdmission(input: {
  resourceType: string;
  pairs: readonly QueryPair[];
  resolved: ResolvedSearchParameters;
  patientId: string;
  confinementName?: string;
}): void {
  const classification = resourceClass(input.resourceType);
  for (const pair of input.pairs) {
    const entry = input.resolved.byName.get(pair.name)!;
    if (classification === 'shared') {
      const directoryIntrinsic = entry.view.definition_evidence === 'pinned_r4'
        && (entry.pinnedBase?.includes(input.resourceType) || ['_id', '_lastUpdated'].includes(pair.name))
        && (entry.pinnedType !== 'reference' || (entry.targetsFull.length > 0 && entry.targetsFull.every(target => resourceClass(target) === 'shared')));
      if (!directoryIntrinsic) throw new GatewayFault('UNSUPPORTED_SEARCH', 'Search parameter is not supported by the declared prototype contract.');
    }
    if (classification !== 'patient' || entry.pinnedType !== 'reference') continue;
    // Retain the reviewed bare bound confinement alias, but never bare polymorphic references.
    if (pair.name === input.confinementName && pair.value === input.patientId) continue;
    if (pair.value === `Patient/${input.patientId}`) continue;
    // Deliberately exclude absolute/versioned/conditional references, OR and FHIR escapes.
    const explicit = /^([A-Z][A-Za-z0-9]+)\/([A-Za-z0-9.-]{1,64})$/.exec(pair.value);
    const targetType = explicit?.[1];
    if (!targetType || resourceClass(targetType) !== 'shared' || !entry.targetsFull.includes(targetType)) {
      throw new GatewayFault('POLICY_DENIED', 'Patient selector conflicts with the trusted context.');
    }
  }
}

/**
 * Occurrence indices the gateway enforces (Q-5/R2-1), for
 * buildQueryEvidence: the appended confinement pair index, plus any
 * caller occurrence whose NAME is in the type's reviewed patient-linkage
 * set {confinementName, supportForType(type).patient_link} AND whose
 * every alternative is the bound Patient (or the bare bound id on the
 * confinement alias). A bound-Patient value on any other parameter
 * (performer, focus, a token code, …) is NEVER gateway-enforced: the
 * gateway enforces subject/patient linkage only. A Group/mixed
 * occurrence sharing the confinement name is NEVER enforced by name alone.
 */
export function gatewayEnforcedIndicesFor(input: {
  pairs: readonly QueryPair[];
  confinementIndex: number;
  patientId: string;
  base: URL;
  confinementName?: string;
  resourceType: string;
}): ReadonlySet<number> {
  const enforced = new Set<number>([input.confinementIndex]);
  const linkageNames = new Set<string>();
  if (input.confinementName) linkageNames.add(input.confinementName);
  const patientLink = supportForType(input.resourceType).patient_link;
  if (patientLink) linkageNames.add(patientLink);
  input.pairs.forEach((pair, index) => {
    if (index === input.confinementIndex) return;
    if (!linkageNames.has(pair.name)) return;
    const alternatives = splitEscapedList(pair.value);
    if (!alternatives || !alternatives.length) return;
    const allBound = alternatives.every(alternative =>
      isBoundPatient(alternative, input.patientId, input.base)
      || (pair.name === input.confinementName && alternative === input.patientId && !(input.resourceType === 'Patient' && pair.name === 'link')));
    if (allBound) enforced.add(index);
  });
  return enforced;
}

/**
 * Build the injected reviewed-name checks from completed Q metadata.
 * Denied, unadvertised and source-only names return false, so repair
 * advice can never echo an unresolved vendor name.
 */
export function reviewedNamesFor(
  resolvedByType: ReadonlyMap<string, ResolvedSearchParameters>,
  supportedTypes: ReadonlySet<string>,
): ReviewedNames {
  return {
    resource: type => supportedTypes.has(type) && resolvedByType.has(type),
    parameter: (type, name) => {
      const entry = resolvedByType.get(type)?.byName.get(name);
      return Boolean(entry && (entry.view.definition_evidence === 'pinned_r4' || entry.view.definition_evidence === 'approved_overlay'));
    },
  };
}
