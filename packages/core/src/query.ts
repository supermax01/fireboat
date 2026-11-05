// Owner: Q (typed discovery, support, query proof).
// Query evidence, digest identity, R4 date/sort semantics and the coverage
// decision table (spec section 7). Pure helpers: no transport, no fetching,
// no patient credential. Self links are source-reported evidence only and
// never promote execution proof; only a closed, approved adapter profile or
// gateway enforcement can do that.
//
// ROOT WIRING (ORDERED — do not reorder; see claude-q-review.md W0..W7):
// W0 FIRST, before any swap: Q-1 overflow refusal (this file) is live only
//   once wired. KEEP privacy.ts foreignPatientSelector IN ADDITION to
//   validatePatientSelectors until CA-ISO-01 passes on the integrated
//   gateway. ALWAYS append the gateway-built confinement pair from
//   confinementFor; delete index.ts's rule that skips confinement when the
//   caller supplies a same-named parameter. Without W0 the Q-1 bypass and
//   caller-patient substitution become live.
// W1 capability state (declaredFromCapability + normalized revision before
//   discovery stores). W2 pre-send pipeline entirely before any URL exists.
// W3 evidence (confinement index, self-link sort, predicate/sort checks,
//   ProfileState invalidation, sticky downgradeEvidence, coverage). Root
//   approves the extend-only QueryOverlay.sortBoundary?: number AND
//   QueryOverlay.sortBoundaryPrecision (F-owned) so validateSortPage
//   boundaries persist across pages without bodies.
// W4 discovery topics; advertise ONLY inside the single atomic 0.2
//   commit (S5) — no intermediate commit advertises them.
// W5 reviewedNamesFor injection.
// W6 eval migration lands in S5; the fixture proof run happens inside
//   S6 before eligibility, and the documents are regenerated after S6
//   (S7). W7 LAST: widen searchProfile config from
//   eligibleSearchProfileIds() only after evidence is recorded.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { GatewayFault } from './transport.js';
import type { CoverageV2, FhirResource } from './contracts.js';
import type { QueryChainView, QueryEvidence } from './m3b.js';
import profilesFile from './data/search-profiles.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// FHIR escaped-list handling. A backslash escapes , $ | and backslash itself;
// unescaped commas separate OR alternatives. Splitting is bounded and never
// guesses. Q-1/Q-6: overflow, overlength and an R4-illegal lone backslash
// (e.g. `xx\xx`, trailing `\`) yield `undefined` — an explicit refusal
// signal. Callers MUST fail closed on undefined; an empty array must never
// mean "nothing to check".
// ---------------------------------------------------------------------------

const ESCAPABLE = ',|$\\';
export const MAX_OR_ALTERNATIVES = 33;

/** Unescape one raw segment exactly once; undefined on a lone backslash. */
export function unescapeFhir(raw: string): string | undefined {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === '\\') {
      const next = raw[i + 1];
      if (next === undefined || !ESCAPABLE.includes(next)) return undefined;
      out += next;
      i++;
    } else out += char;
  }
  return out;
}

export function splitEscapedList(value: string): string[] | undefined {
  if (value.length > 2048) return undefined;
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === '\\') {
      const next = value[i + 1];
      if (next === undefined || !ESCAPABLE.includes(next)) return undefined;
      current += next;
      i++;
    } else if (char === ',') {
      parts.push(current);
      current = '';
      if (parts.length >= MAX_OR_ALTERNATIVES) return undefined;
    } else current += char;
  }
  parts.push(current);
  return parts;
}

export interface TokenAlternative {
  /** undefined: any system (bare code). null: no system (`|code`). string: exact system. */
  system: string | null | undefined;
  /** undefined: any code (`system|`). */
  code?: string;
}

/**
 * Single-pass R4 token tokenization over the RAW value (Q-6): split on
 * unescaped commas, split system/code on the first unescaped pipe, then
 * unescape each part exactly once. Undefined on overflow or lone backslash.
 */
export function tokenAlternatives(rawValue: string): TokenAlternative[] | undefined {
  if (rawValue.length > 2048) return undefined;
  // First split into raw (still-escaped) alternatives on unescaped commas.
  const rawParts: string[] = [];
  let current = '';
  for (let i = 0; i < rawValue.length; i++) {
    const char = rawValue[i]!;
    if (char === '\\') {
      const next = rawValue[i + 1];
      if (next === undefined || !ESCAPABLE.includes(next)) return undefined;
      current += char + next;
      i++;
    } else if (char === ',') {
      rawParts.push(current);
      current = '';
      if (rawParts.length >= MAX_OR_ALTERNATIVES) return undefined;
    } else current += char;
  }
  rawParts.push(current);
  const alternatives: TokenAlternative[] = [];
  for (const rawPart of rawParts) {
    // Find the first unescaped pipe.
    let pipe = -1;
    for (let i = 0; i < rawPart.length; i++) {
      if (rawPart[i] === '\\') { i++; continue; }
      if (rawPart[i] === '|') { pipe = i; break; }
    }
    if (pipe === -1) {
      const code = unescapeFhir(rawPart);
      if (code === undefined) return undefined;
      alternatives.push(code ? { system: undefined, code } : { system: undefined });
    } else {
      const rawSystem = rawPart.slice(0, pipe);
      const rawCode = rawPart.slice(pipe + 1);
      const system = unescapeFhir(rawSystem);
      const code = unescapeFhir(rawCode);
      if (system === undefined || code === undefined) return undefined;
      alternatives.push({
        system: rawSystem === '' ? null : system,
        ...(code ? { code } : {}),
      });
    }
  }
  return alternatives;
}

/** Parse one RAW (still-escaped) token alternative; undefined when illegal. */
export function splitToken(alternative: string): TokenAlternative | undefined {
  let pipe = -1;
  for (let i = 0; i < alternative.length; i++) {
    if (alternative[i] === '\\') { i++; continue; }
    if (alternative[i] === '|') { pipe = i; break; }
  }
  if (pipe === -1) {
    const code = unescapeFhir(alternative);
    return code === undefined ? undefined : code ? { system: undefined, code } : { system: undefined };
  }
  const rawSystem = alternative.slice(0, pipe);
  const system = unescapeFhir(rawSystem);
  const code = unescapeFhir(alternative.slice(pipe + 1));
  if (system === undefined || code === undefined) return undefined;
  return { system: rawSystem === '' ? null : system, ...(code ? { code } : {}) };
}

// ---------------------------------------------------------------------------
// R4 date/dateTime precision intervals (spec section 7 fixture contract).
// Every value denotes the half-open interval at its stated precision.
// Timezone-free values use explicit UTC. No Date.parse instant equality.
// ---------------------------------------------------------------------------

export interface DateInterval {
  start: number; end: number; precision: 'year' | 'month' | 'day' | 'minute' | 'second' | 'fraction'; timezoneQualified: boolean;
  /** More fractional digits than the millisecond arithmetic preserves: lexically valid, but never compared, proved or ordered (Astra review, 2026-10-22). */
  subMillisecond: boolean;
}

export function parseFhirDateInterval(text: string): DateInterval | undefined {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/.exec(text);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = match[2] === undefined ? undefined : Number(match[2]);
  const day = match[3] === undefined ? undefined : Number(match[3]);
  const hour = match[4] === undefined ? undefined : Number(match[4]);
  const minute = match[5] === undefined ? undefined : Number(match[5]);
  const second = match[6] === undefined ? undefined : Number(match[6]);
  const fraction = match[7];
  const zone = match[8];
  if (month !== undefined && (month < 1 || month > 12)) return undefined;
  if (day !== undefined && (day < 1 || day > 31)) return undefined;
  if (hour !== undefined && (hour > 23 || (minute ?? 0) > 59 || (second ?? 0) > 59)) return undefined;
  let offsetMs = 0;
  if (zone && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 14 || zoneMinute > 59) return undefined;
    offsetMs = sign * (zoneHour * 3600000 + zoneMinute * 60000);
  }
  const fractionMs = fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * 1000);
  const start = Date.UTC(year, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0, fractionMs) - offsetMs;
  const round = new Date(start + offsetMs);
  if (round.getUTCFullYear() !== year || (month !== undefined && round.getUTCMonth() !== month - 1) || (day !== undefined && round.getUTCDate() !== day)) return undefined;
  let end: number;
  let precision: DateInterval['precision'];
  if (fraction !== undefined) { end = start + Math.max(1, 10 ** (3 - Math.min(3, fraction.length))); precision = 'fraction'; }
  else if (second !== undefined) { end = start + 1000; precision = 'second'; }
  else if (hour !== undefined) { end = start + 60000; precision = 'minute'; }
  else if (day !== undefined) { end = Date.UTC(year, (month ?? 1) - 1, day + 1) - offsetMs; precision = 'day'; }
  else if (month !== undefined) { end = Date.UTC(year, month, 1) - offsetMs; precision = 'month'; }
  else { end = Date.UTC(year + 1, 0, 1) - offsetMs; precision = 'year'; }
  return { start, end, precision, timezoneQualified: zone !== undefined, subMillisecond: fraction !== undefined && fraction.length > 3 };
}

export const DATE_PREFIXES = ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'sa', 'eb', 'ap'] as const;
export type DatePrefix = typeof DATE_PREFIXES[number];

export function splitComparatorPrefix(raw: string): { prefix: DatePrefix; rest: string } {
  for (const prefix of DATE_PREFIXES) if (raw.startsWith(prefix) && raw.length > 2 && /^[0-9-]/.test(raw.slice(2))) return { prefix, rest: raw.slice(2) };
  return { prefix: 'eq', rest: raw };
}

/**
 * R4 date comparison of target interval T against search interval S.
 * eq: S contains T. gt/lt: T extends above/below S. ge/le add eq.
 * sa/eb: T entirely after/before S. `ap` has no frozen rule and is
 * undecidable here (undefined), never an alias for eq.
 */
export function dateSearchOutcome(target: { start: number; end: number; subMillisecond?: boolean } | undefined, raw: string): boolean | undefined {
  if (!target) return undefined;
  const { prefix, rest } = splitComparatorPrefix(raw);
  if (prefix === 'ap') return undefined;
  const search = parseFhirDateInterval(rest);
  if (!search) return undefined;
  // Sub-millisecond precision on either side is undecidable here: the arithmetic would call distinct instants equal.
  if (search.subMillisecond || target.subMillisecond) return undefined;
  const eq = search.start <= target.start && target.end <= search.end;
  switch (prefix) {
    case 'eq': return eq;
    case 'ne': return !eq;
    case 'gt': return target.end > search.end;
    case 'lt': return target.start < search.start;
    case 'ge': return target.end > search.end || eq;
    case 'le': return target.start < search.start || eq;
    case 'sa': return target.start >= search.end;
    case 'eb': return target.end <= search.start;
  }
}

/** Lexical FHIR date/dateTime validity for one search alternative (CA-3). */
export function isLexicalFhirDate(raw: string): boolean {
  return parseFhirDateInterval(splitComparatorPrefix(raw).rest) !== undefined;
}

export type EffectiveResult =
  | { kind: 'interval'; start: number; end: number; variant: 'dateTime' | 'period' | 'instant'; timezoneQualified: boolean; instantPrecision: boolean; precision?: DateInterval['precision']; subMillisecond: boolean }
  | { kind: 'missing' }
  | { kind: 'unsupported'; variant: string };

/**
 * Observation clinical date from effective[x] only, never issued (R3-L1).
 * Timing and extension-only values are unsupported variants, not dates.
 */
export function observationEffective(resource: FhirResource): EffectiveResult {
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
  for (const key of ['effectiveDateTime', 'effectiveInstant'] as const) {
    const value = text(resource[key]);
    if (value !== undefined) {
      const interval = parseFhirDateInterval(value);
      if (!interval) return { kind: 'unsupported', variant: 'unparsable-effective' };
      return { kind: 'interval', start: interval.start, end: interval.end, variant: key === 'effectiveInstant' ? 'instant' : 'dateTime', timezoneQualified: interval.timezoneQualified, instantPrecision: interval.precision === 'second' || interval.precision === 'fraction', precision: interval.precision, subMillisecond: interval.subMillisecond };
    }
  }
  const period = resource.effectivePeriod;
  if (period && typeof period === 'object' && !Array.isArray(period)) {
    const record = period as Record<string, unknown>;
    const startText = text(record.start);
    const endText = text(record.end);
    if (startText === undefined && endText === undefined) return { kind: 'missing' };
    const lo = startText === undefined ? undefined : parseFhirDateInterval(startText);
    const hi = endText === undefined ? undefined : parseFhirDateInterval(endText);
    if ((startText !== undefined && !lo) || (endText !== undefined && !hi)) return { kind: 'unsupported', variant: 'unparsable-effective' };
    return { kind: 'interval', start: lo ? lo.start : Number.NEGATIVE_INFINITY, end: hi ? hi.end : Number.POSITIVE_INFINITY, variant: 'period', timezoneQualified: Boolean(lo?.timezoneQualified || hi?.timezoneQualified), instantPrecision: false, subMillisecond: Boolean(lo?.subMillisecond || hi?.subMillisecond) };
  }
  if (resource.effectiveTiming !== undefined) return { kind: 'unsupported', variant: 'effectiveTiming' };
  if (Object.keys(resource).some(key => key.startsWith('_effective'))) return { kind: 'unsupported', variant: 'extension-only-effective' };
  return { kind: 'missing' };
}

// ---------------------------------------------------------------------------
// Approved adapter profiles. Generic R4 proves nothing. A profile proves
// only its listed variants, for its exact source applicability.
// ---------------------------------------------------------------------------

export interface SearchProfileSource {
  /** Absent on the original synthetic registry; external pins are measured by the qualification harness. */
  kind?: 'external';
  software: string;
  software_version?: string;
  fhir_version: string;
  fixture_sha256?: string;
  backend_sha256?: string;
  image_digest?: string;
  corpus_sha256?: string;
}

/**
 * Recorded proof run; root writes this only after the listed tasks pass (Q-2). S6 adds the normalized
 * capability revision the run was proved on (bound at runtime) and the digest of the task corpus it ran.
 */
export interface SearchProfileEvidence { report_sha256: string; recorded_at: string; capability_revision?: string; tasks_sha256?: string }

export interface SearchProfile {
  id: string;
  version: string;
  eligible: boolean;
  source: SearchProfileSource;
  evidence?: SearchProfileEvidence | null;
  testIds: readonly string[];
  testedFilters: readonly { resource_type: string; parameter: string; variant: string; test_ids?: string[] }[];
  testedSorts: readonly { resource_type: string; parameter: string; variant: string; test_ids?: string[] }[];
  testedContinuations: readonly string[];
}

interface ProfilesFile {
  revision: string;
  gateway_controls: { name: string; type: string; definition?: string; description: string }[];
  denied_parameters: string[];
  profiles: {
    id: string; version: string; eligible: boolean;
    source: SearchProfileSource;
    evidence?: SearchProfileEvidence | null;
    test_ids: string[];
    tested_filters: { resource_type: string; parameter: string; variant: string; test_ids?: string[] }[];
    tested_sorts: { resource_type: string; parameter: string; variant: string; test_ids?: string[] }[];
    tested_continuations: string[];
  }[];
}

const profilesData = profilesFile as unknown as ProfilesFile;
export const SEARCH_PROFILES_REVISION = profilesData.revision;
export const GATEWAY_CONTROLS: readonly { name: string; type: string; definition?: string; description: string }[] = profilesData.gateway_controls;
/** Reviewed deny set (Q-8): named/operation-like parameters, never executable. */
export const DENIED_SEARCH_PARAMETERS: ReadonlySet<string> = new Set(profilesData.denied_parameters);

const PROFILES: ReadonlyMap<string, SearchProfile> = new Map(profilesData.profiles.map(profile => [profile.id, {
  id: profile.id, version: profile.version, eligible: profile.eligible,
  source: profile.source, evidence: profile.evidence ?? null, testIds: profile.test_ids ?? [],
  testedFilters: profile.tested_filters, testedSorts: profile.tested_sorts, testedContinuations: profile.tested_continuations,
}]));
assertSearchProfileRegistry([...PROFILES.values()]);

/**
 * A profile proves execution only when it is eligible AND (for any profile
 * claiming tested filters/sorts) carries a recorded evidence block (Q-2).
 * The generic profile claims nothing and needs no evidence.
 */
function profileProves(profile: SearchProfile): boolean {
  if (!profile.eligible) return false;
  const claimsProof = profile.testedFilters.length > 0 || profile.testedSorts.length > 0;
  if (!claimsProof) return true;
  // S6: a shipped qualified profile also records the capability revision it was proved on (registry invariant
  // below); profileMatchesSource binds the runtime to a recorded revision and fails closed without a discovered one.
  return Boolean(profile.evidence && /^[a-f0-9]{64}$/.test(profile.evidence.report_sha256) && profile.evidence.recorded_at);
}

/**
 * S6 registry invariant (review finding 6): a shipped profile that claims tested filters or sorts and is eligible
 * must record the capability revision it was proved on, so the runtime binding can never be skipped for it.
 * Labelled private test candidates are not registry profiles and are exempt.
 */
export function assertSearchProfileRegistry(profiles: readonly Pick<SearchProfile, 'id' | 'eligible' | 'source' | 'evidence' | 'testedFilters' | 'testedSorts'>[]): void {
  for (const profile of profiles) {
    const claimsProof = profile.testedFilters.length > 0 || profile.testedSorts.length > 0;
    if (profile.eligible && claimsProof && !(typeof profile.evidence?.capability_revision === 'string' && profile.evidence.capability_revision.length > 0)) {
      throw new Error(`search profile ${profile.id} is eligible and claims proof but records no capability revision`);
    }
    if (profile.eligible && profile.source.kind === 'external') {
      if (!profile.source.software || !profile.source.software_version || profile.source.fhir_version !== '4.0.1') throw new Error('External profile requires exact software, version and FHIR identity.');
      if (!/^sha256:[a-f0-9]{64}$/.test(profile.source.image_digest ?? '')) throw new Error('External profile requires image_digest.');
      if (!/^[a-f0-9]{64}$/.test(profile.source.corpus_sha256 ?? '')) throw new Error('External profile requires corpus_sha256.');
      if (!/^[a-f0-9]{64}$/.test(profile.evidence?.tasks_sha256 ?? '')) throw new Error('External profile requires tasks_sha256.');
      if (!profile.evidence?.capability_revision || !/^[a-f0-9]{64}$/.test(profile.evidence?.report_sha256 ?? '') || !Number.isFinite(Date.parse(profile.evidence?.recorded_at ?? ''))) throw new Error('External profile requires complete recorded evidence.');
    }
  }
}

// R2-2 brand: only profiles returned by the selection functions below (or
// the labelled test seam) are proof-capable. Evidence builders consult
// this module-private set, so a raw declared/ineligible object — or any
// hand-cloned profile-shaped value — can never prove execution.
const PROVING_PROFILES = new WeakSet<SearchProfile>();

/** Clone before freezing: caller-owned nested arrays/objects must never widen registered proof. */
function frozenProfile(profile: SearchProfile): SearchProfile {
  const copy = structuredClone(profile);
  const freeze = (value: object): void => {
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') freeze(child);
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
}
function brandProfile(profile: SearchProfile): SearchProfile {
  const frozen = frozenProfile(profile);
  PROVING_PROFILES.add(frozen);
  return frozen;
}

function lookupProfile(id: string): SearchProfile | undefined {
  return PROFILES.get(id);
}

/** True only for branded, proof-capable profiles (R2-2). */
export function isProvingSearchProfile(profile: SearchProfile | undefined): profile is SearchProfile {
  return profile !== undefined && PROVING_PROFILES.has(profile);
}

/** Unknown, ineligible or unevidenced profile ids resolve to no proof. */
export function searchProfile(id: string | undefined): SearchProfile | undefined {
  const profile = lookupProfile(id === undefined ? 'generic-r4' : id);
  return profile && profileProves(profile) ? brandProfile(profile) : undefined;
}

/**
 * Raw declared profile regardless of eligibility/evidence (tests, doctor).
 * R2-2: returns a frozen copy that is NEVER branded, so it cannot prove.
 */
export function declaredSearchProfile(id: string): SearchProfile | undefined {
  const profile = lookupProfile(id);
  if (!profile) return undefined;
  return frozenProfile(profile);
}

export function eligibleSearchProfileIds(): string[] {
  return [...PROFILES.values()].filter(profileProves).map(profile => profile.id).sort();
}

// Module-private process key: source identity tokens never become retained state.
const SOURCE_IDENTITY_KEY = randomBytes(32);
export const sourceIdentityDigest = (value: string): string => createHmac('sha256', SOURCE_IDENTITY_KEY).update(value).digest('hex');

export interface CapabilitySourceIdentity {
  digested?: true;
  software?: string;
  softwareVersion?: string;
  fhirVersion?: string;
  /** Normalized capability revision of the discovered source (S6 profile binding). */
  revision?: string;
}

/**
 * Source-bound profile selection (Q-3): a closed profile applies only to the
 * exact source software/version and FHIR version it was tested on. Returns
 * undefined on any mismatch; the caller fails INVALID_CONFIG at doctor/
 * startup or downgrades to generic-r4 with a warning — never silent proof.
 */
export function profileForSource(id: string | undefined, capability: CapabilitySourceIdentity): SearchProfile | undefined {
  const profile = searchProfile(id);
  if (!profile) return undefined;
  if (profile.id === 'generic-r4') {
    if (capability.fhirVersion !== undefined && capability.fhirVersion !== profile.source.fhir_version) return undefined;
    return profile;
  }
  return profileMatchesSource(profile, capability) ? profile : undefined;
}

function profileMatchesSource(profile: SearchProfile, capability: CapabilitySourceIdentity): SearchProfile | undefined {
  // External software versions are mandatory even on the private constructor seam; no wildcard version proof.
  if (profile.source.kind === 'external' && (!profile.source.software_version || (profile.eligible && !profile.evidence?.capability_revision))) return undefined;
  // Normalize only the trusted profile operand; preserve exact equality and mutation anchors.
  if (capability.digested) profile = { ...profile, source: { ...profile.source,
    software: sourceIdentityDigest(profile.source.software),
    software_version: profile.source.software_version === undefined ? undefined : sourceIdentityDigest(profile.source.software_version),
  } };
  if (capability.software !== profile.source.software) return undefined;
  if (profile.source.software_version !== undefined && capability.softwareVersion !== profile.source.software_version) return undefined;
  if (capability.fhirVersion !== profile.source.fhir_version) return undefined;
  // S6: a recorded proof binds to the exact normalized capability contract; a missing or different discovered
  // revision is no proof (fail closed; review finding 6).
  if (profile.evidence?.capability_revision !== undefined && capability.revision !== profile.evidence.capability_revision) return undefined;
  return profile;
}

/**
 * Per-gateway profile invalidation registry (Q-11). A contradicted predicate
 * invalidates the profile for the current process; searchProfile() itself
 * stays stateless, root consults this wrapper on every search.
 */
export class ProfileState {
  private readonly invalidated = new Set<string>();
  // Private constructor dependency, never a process-global registry or public config.
  private candidate?: SearchProfile;
  private setCandidateForTest(candidate: SearchProfile, privateCandidate = false): void {
    // The private gateway test channel exercises candidate semantics without inventing a proof report.
    this.candidate = candidate && (privateCandidate || profileProves(candidate)) ? brandProfile(candidate) : undefined;
  }
  invalidate(id: string): void { this.invalidated.add(id); }
  isInvalidated(id: string): boolean { return this.invalidated.has(id); }
  profile(id: string | undefined, capability?: CapabilitySourceIdentity): SearchProfile | undefined {
    const candidate = this.candidate?.id === id ? this.candidate : undefined;
    const resolved = candidate ? (capability && !profileMatchesSource(candidate, capability) ? undefined : candidate)
      : capability ? profileForSource(id, capability) : searchProfile(id);
    if (!resolved || this.invalidated.has(resolved.id)) return undefined;
    return resolved;
  }
}

function dateVariantProved(value: string, allowedPrefixes: ReadonlySet<string>): boolean {
  const alternatives = splitEscapedList(value);
  if (!alternatives || !alternatives.length) return false;
  return alternatives.every(alternative => {
    const { prefix, rest } = splitComparatorPrefix(alternative);
    const interval = parseFhirDateInterval(rest);
    // A sub-millisecond search value is outside the proved interval arithmetic: the variant stays unproved.
    return prefix !== 'ap' && allowedPrefixes.has(prefix) && interval !== undefined && !interval.subMillisecond;
  });
}

function allowedDatePrefixes(variant: string): ReadonlySet<string> {
  // Variant form: effective-interval-eq-ne-gt-lt-ge-le-sa-eb (dash list).
  return new Set(variant.split('-').filter(part => (DATE_PREFIXES as readonly string[]).includes(part)));
}

/**
 * Variant-exact proof check (Q-2): the parameter name alone never proves a
 * value. Modifier names, code-only / `|code` / `system|` token forms, `ap`
 * dates and every unlisted variant stay unproved.
 */
export function filterVariantProved(profile: SearchProfile | undefined, resourceType: string, name: string, value: string): boolean {
  if (!isProvingSearchProfile(profile)) return false;
  if (name.includes(':')) return false;
  const entries = profile.testedFilters.filter(entry => entry.resource_type === resourceType && entry.parameter === name);
  if (!entries.length) return false;
  return entries.some(entry => {
    if (entry.variant === 'token-system-code') {
      const alternatives = tokenAlternatives(value);
      if (!alternatives || !alternatives.length) return false;
      return alternatives.every(token => typeof token.system === 'string' && token.system.length > 0 && token.code !== undefined && token.code.length > 0);
    }
    if (entry.variant.startsWith('effective-interval-')) {
      return dateVariantProved(value, allowedDatePrefixes(entry.variant));
    }
    if (entry.variant === 'reference-confinement') {
      const alternatives = splitEscapedList(value);
      return Boolean(alternatives && alternatives.length === 1 && /^Patient\/[A-Za-z0-9.-]{1,64}$/.test(alternatives[0]!));
    }
    return false;
  });
}

export function sortVariantListed(profile: SearchProfile | undefined, resourceType: string, requested: readonly string[]): boolean {
  if (!isProvingSearchProfile(profile) || requested.length !== 1) return false;
  const rawKey = requested[0]!;
  const descending = rawKey.startsWith('-');
  const key = descending ? rawKey.slice(1) : rawKey;
  return profile.testedSorts.some(entry => {
    if (entry.resource_type !== resourceType || entry.parameter !== key) return false;
    if (entry.variant.startsWith('descending')) return descending;
    if (entry.variant.startsWith('ascending')) return !descending;
    return false;
  });
}

// ---------------------------------------------------------------------------
// Query identity, self-link accounting and evidence construction.
// ---------------------------------------------------------------------------

export type QueryPair = { name: string; value: string };

/** Exact digest formula (spec section 7): fixed key order, no whitespace. */
export function queryDigest(input: {
  sourceRevision: string; policyRevision: string; contextHandle: string;
  resourceType: string; constraints: readonly QueryPair[]; sort?: readonly string[];
}): string {
  const body = JSON.stringify({
    v: 1,
    source_revision: input.sourceRevision,
    policy_revision: input.policyRevision,
    context_handle: input.contextHandle,
    resource_type: input.resourceType,
    constraints: input.constraints.map(pair => ({ name: pair.name, value: pair.value })),
    sort: [...(input.sort ?? [])],
  });
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export interface SelfLinkMatch {
  /** One flag per requested occurrence, in order. */
  flags: ('matched' | 'not_reported' | 'not_checked')[];
  /** True when the self link contradicts a requested pair or adds a material pair. */
  materialMismatch: boolean;
  /** Q-4: echoed `_sort` handling — sort reporting never refuses membership. */
  sortReported: 'matched' | 'dropped' | 'different' | 'not_checked' | 'not_requested';
}

const PAGING_NAMES = new Set(['_count', '_offset', '_getpages', '_getpagesoffset', '_bundletype', '_format', '_pretty', '_cursor', '_total', '_summary', '_elements']);

/**
 * Compare already-decoded source query evidence. Only identical predicates
 * are idempotent: every distinct exact name/value must still agree. Requested
 * sort/paging controls retain their full value multisets; unsolicited mechanics
 * are ignored here, leaving URL/form admission to the existing transport guards.
 * This never rewrites the requested/outbound sequence or establishes execution.
 */
export function queryEvidencePairsMatch(requested: readonly QueryPair[], reported: readonly QueryPair[]): boolean {
  const mechanics = (name: string) => name === '_sort' || PAGING_NAMES.has(name);
  // The two implemented underscore predicates are explicit. Other underscore
  // controls never gain idempotence merely by reaching this comparison seam.
  const predicate = (name: string) => !name.startsWith('_') || name === '_id' || name === '_lastUpdated';
  const names = new Set([...requested.map(pair => pair.name), ...reported.filter(pair => !mechanics(pair.name)).map(pair => pair.name)]);
  for (const name of names) {
    const expected = requested.filter(pair => pair.name === name).map(pair => pair.value);
    const actual = reported.filter(pair => pair.name === name).map(pair => pair.value);
    const left = (predicate(name) ? [...new Set(expected)] : expected).sort();
    const right = (predicate(name) ? [...new Set(actual)] : actual).sort();
    if (left.length !== right.length || left.some((value, index) => value !== right[index])) return false;
  }
  return true;
}

/**
 * Validate every requested occurrence against distinct exact source predicates.
 * Missing self evidence is reported, never fabricated. Extra material
 * pairs in the self link are a mismatch; paging mechanics are ignored.
 * `_sort` is compared separately (Q-4): an echoed, dropped or different
 * `_sort` only downgrades order evidence, never material membership.
 * No mismatched source value is echoed by this helper.
 */
export function matchSelfLink(requested: readonly QueryPair[], selfPairs: readonly QueryPair[] | null | undefined, sortRequested: readonly string[] = []): SelfLinkMatch {
  if (selfPairs === undefined) return { flags: requested.map(() => 'not_checked' as const), materialMismatch: false, sortReported: sortRequested.length ? 'not_checked' : 'not_requested' };
  if (selfPairs === null) return { flags: requested.map(() => 'not_reported' as const), materialMismatch: false, sortReported: sortRequested.length ? 'dropped' : 'not_requested' };
  const selfSorts = selfPairs.filter(pair => pair.name === '_sort').map(pair => pair.value);
  let sortReported: SelfLinkMatch['sortReported'];
  if (!sortRequested.length) sortReported = 'not_requested';
  else if (!selfSorts.length) sortReported = 'dropped';
  else sortReported = selfSorts.length === 1 && selfSorts[0] === sortRequested.join(',') ? 'matched' : 'different';
  const pool = selfPairs.filter(pair => pair.name !== '_sort' && !PAGING_NAMES.has(pair.name));
  const flags = requested.map(pair => pool.some(entry => entry.name === pair.name && entry.value === pair.value) ? 'matched' as const : 'not_reported' as const);
  return { flags, materialMismatch: !queryEvidencePairsMatch(requested, pool), sortReported };
}

export interface BuildQueryEvidenceInput {
  resourceType: string;
  /** Ordered outbound material pairs including confinement; paging and sort excluded. */
  pairs: readonly QueryPair[];
  sortRequested?: readonly string[];
  /** True only after validateSortOrder accepted the observed pages. */
  sortVerified?: boolean;
  selfPairs?: readonly QueryPair[] | null;
  /** Pass ONLY a searchProfile()/ProfileState/profileForSource result. R2-2: unbranded objects are treated as unproved. */
  profile?: SearchProfile;
  /**
   * Occurrence indices the gateway itself enforces (Q-5): the appended
   * confinement pair plus any caller occurrence proved bound by
   * gatewayEnforcedIndicesFor(). A shared parameter NAME never suffices.
   */
  gatewayEnforcedIndices: ReadonlySet<number>;
  sourceRevision: string;
  policyRevision: string;
  contextHandle: string;
  evidenceKind?: QueryEvidence['evidenceKind'];
}

function evidenceKindFor(constraints: QueryEvidence['constraints'], materialFilterProved: boolean): QueryEvidence['evidenceKind'] {
  // Q-13: confinement-only proof is linkage, not a self-link claim.
  if (constraints.length > 0 && constraints.every(entry => entry.execution === 'gateway_enforced')) return 'exact_id_and_subject_linkage';
  if (materialFilterProved && constraints.some(entry => entry.execution === 'tested_adapter')) return 'tested_adapter';
  return 'declared_and_self_link_only';
}

export function buildQueryEvidence(input: BuildQueryEvidenceInput): QueryEvidence {
  const sortRequested = [...(input.sortRequested ?? [])];
  const self = matchSelfLink(input.pairs, input.selfPairs, sortRequested);
  const constraints = input.pairs.map((pair, index) => {
    const enforced = input.gatewayEnforcedIndices.has(index);
    const tested = !enforced && filterVariantProved(input.profile, input.resourceType, pair.name, pair.value);
    return {
      name: pair.name, value: pair.value,
      source_reported: self.flags[index]!,
      execution: enforced ? 'gateway_enforced' as const : tested ? 'tested_adapter' as const : 'unknown' as const,
      ...(tested && input.profile ? { evidence_ref: `${input.profile.id}@${input.profile.version}` } : {}),
    };
  });
  const materialFilterProved = constraints.every(entry => entry.execution !== 'unknown');
  // Q-4: a dropped/different self-link _sort never yields verified order.
  const sortProved = Boolean(input.sortVerified) && sortVariantListed(input.profile, input.resourceType, sortRequested) && self.sortReported === 'matched';
  return {
    constraints,
    query_digest: queryDigest({ sourceRevision: input.sourceRevision, policyRevision: input.policyRevision, contextHandle: input.contextHandle, resourceType: input.resourceType, constraints: input.pairs, sort: sortRequested }),
    ...(sortRequested.length ? {
      sort: {
        requested: sortRequested,
        effective: sortProved ? sortRequested : null,
        order: sortProved ? 'verified_by_adapter' as const : 'requested_unverified' as const,
      },
    } : {}),
    materialFilterProved,
    evidenceKind: input.evidenceKind ?? evidenceKindFor(constraints, materialFilterProved),
  };
}

/**
 * Sticky evidence downgrade (Q-11): an unverifiable returned variant strips
 * proof for that parameter without recomputing query identity. Pure.
 */
export function downgradeEvidence(evidence: QueryEvidence, parameter: string): QueryEvidence {
  const constraints = evidence.constraints.map(entry => {
    if (entry.name !== parameter || entry.execution === 'gateway_enforced') return { ...entry };
    const { evidence_ref: _dropped, ...rest } = entry;
    return { ...rest, execution: 'unknown' as const };
  });
  const materialFilterProved = constraints.every(entry => entry.execution !== 'unknown');
  return { ...evidence, constraints, materialFilterProved, evidenceKind: evidenceKindFor(constraints, materialFilterProved) };
}

/** Continuation shorthand: digest identity without repeating full constraints. */
export function shorthandEvidence(evidence: QueryEvidence): QueryEvidence {
  return { ...evidence, constraints: [] };
}

/** Derived requested / source-reported / executed views over one structure. */
export function evidenceViews(evidence: QueryEvidence): {
  requested: QueryPair[];
  sourceReported: QueryPair[];
  executed: QueryPair[];
} {
  const pair = (entry: QueryEvidence['constraints'][number]): QueryPair => ({ name: entry.name, value: entry.value });
  return {
    requested: evidence.constraints.map(pair),
    sourceReported: evidence.constraints.filter(entry => entry.source_reported === 'matched').map(pair),
    executed: evidence.constraints.filter(entry => entry.execution !== 'unknown').map(pair),
  };
}

// ---------------------------------------------------------------------------
// Returned-predicate and sort-order contradiction detection. These helpers
// run over authorized raw records before projection. A contradiction of an
// allegedly enforced predicate refuses the candidate page; an unverifiable
// variant only downgrades proof. Nothing here post-filters or re-sorts.
// ---------------------------------------------------------------------------

export type ValidationOutcome =
  | { status: 'ok' }
  | { status: 'contradicted'; parameter: string }
  | { status: 'unverifiable'; parameter: string; variant: string };

function codingsOf(value: unknown): { system?: unknown; code?: unknown }[] {
  const out: { system?: unknown; code?: unknown }[] = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if ('coding' in record) collect(record.coding);
    if ('code' in record || 'system' in record) out.push({ system: record.system, code: record.code });
  };
  collect(value);
  return out;
}

/**
 * R4 token match over single-pass alternatives (Q-6): `|code` requires a
 * coding with NO system; `system|` allows any code; bare code allows any
 * system. Same code in a different system never matches `system|code`.
 * Undefined when the raw value is illegal or overflows (Q-1: not proved).
 */
export function tokenMatches(concept: unknown, rawValue: string): boolean | undefined {
  const alternatives = tokenAlternatives(rawValue);
  if (!alternatives || !alternatives.length) return undefined;
  const codings = codingsOf(concept);
  if (!codings.length) return false;
  return alternatives.some(token => {
    if (token.system === undefined && token.code === undefined) return false;
    return codings.some(coding => {
      const systemOk = token.system === undefined ? true
        : token.system === null ? coding.system === undefined
          : coding.system === token.system;
      const codeOk = token.code === undefined || coding.code === token.code;
      return systemOk && codeOk;
    });
  });
}

export function validateReturnedPredicates(
  records: readonly FhirResource[],
  evidence: QueryEvidence,
  resourceType: string,
): ValidationOutcome {
  for (const constraint of evidence.constraints) {
    if (constraint.execution !== 'tested_adapter') continue;
    const base = constraint.name.split(':')[0]!;
    if (base === 'code' && resourceType === 'Observation') {
      for (const record of records) {
        const outcome = tokenMatches(record.code, constraint.value);
        if (outcome === undefined) return { status: 'unverifiable', parameter: base, variant: 'unparsable-token' };
        if (!outcome) return { status: 'contradicted', parameter: base };
      }
    } else if (base === 'date' && resourceType === 'Observation') {
      for (const record of records) {
        const effective = observationEffective(record);
        if (effective.kind === 'unsupported') return { status: 'unverifiable', parameter: base, variant: effective.variant };
        if (effective.kind === 'missing') return { status: 'contradicted', parameter: base };
        // Repeated date pairs are ANDed by the query; comma alternatives inside one pair are ORed.
        const alternatives = splitEscapedList(constraint.value);
        if (!alternatives) return { status: 'unverifiable', parameter: base, variant: 'undecidable-date' };
        const outcomes = alternatives.map(alternative => dateSearchOutcome(effective, alternative));
        if (outcomes.some(outcome => outcome === undefined)) return { status: 'unverifiable', parameter: base, variant: 'undecidable-date' };
        if (!outcomes.some(outcome => outcome === true)) return { status: 'contradicted', parameter: base };
      }
    } else if (base === 'patient' || base === 'subject') {
      continue; // Confinement is gateway-enforced per record by authorization, not re-proved here.
    } else {
      return { status: 'unverifiable', parameter: base, variant: 'unreviewed-predicate' };
    }
  }
  return { status: 'ok' };
}

/** Opaque cross-page sort boundary: last proved instant start (epoch ms). */
export type SortBoundary = number;

export interface SortPageResult { outcome: ValidationOutcome; boundary?: SortBoundary; boundaryPrecision?: DateInterval['precision'] }

/**
 * Incremental one-page order check (Q-11): root stores only the returned
 * numeric boundary in the overlay — never clinical bodies. Mixed instant
 * precisions are unverifiable (Q-14): overlapping precision intervals carry
 * no order proof and must never read as a contradiction.
 */
export function validateSortPage(
  page: readonly FhirResource[],
  requested: readonly string[],
  resourceType: string,
  previousBoundary?: SortBoundary,
  previousPrecision?: DateInterval['precision'],
): SortPageResult {
  if (!requested.length) return { outcome: { status: 'ok' }, ...(previousBoundary !== undefined ? { boundary: previousBoundary } : {}) };
  if (requested.length !== 1 || resourceType !== 'Observation') return { outcome: { status: 'unverifiable', parameter: requested[0] ?? '_sort', variant: 'unreviewed-sort' } };
  const rawKey = requested[0]!;
  const descending = rawKey.startsWith('-');
  const key = descending ? rawKey.slice(1) : rawKey;
  if (key !== 'date') return { outcome: { status: 'unverifiable', parameter: key, variant: 'unreviewed-sort' } };
  if (previousBoundary !== undefined && previousPrecision === undefined) return { outcome: { status: 'unverifiable', parameter: 'date', variant: 'missing-boundary-precision' } };
  let previous = previousBoundary;
  let previousPrec = previousPrecision;
  // Cross-page: only the boundary start+precision survive, so the previous
  // interval end is the widest end that precision allows (Q-14). Within the
  // page the exact interval ends are known.
  let previousEnd = previousBoundary === undefined ? undefined
    : previousPrecision === 'second' ? previousBoundary + 1000
      : previousPrecision === 'fraction' ? previousBoundary + 100 : undefined;
  for (const record of page) {
    const effective = observationEffective(record);
    if (effective.kind !== 'interval' || effective.variant !== 'dateTime' || !effective.timezoneQualified || !effective.instantPrecision) {
      return { outcome: { status: 'unverifiable', parameter: 'date', variant: effective.kind === 'interval' ? 'partial-or-unqualified-date' : effective.kind === 'unsupported' ? effective.variant : 'missing-date' } };
    }
    // Sub-millisecond instants would tie at the millisecond and let an ascending pair pass a descending check.
    if (effective.subMillisecond) return { outcome: { status: 'unverifiable', parameter: 'date', variant: 'sub-millisecond-precision' } };
    if (previous !== undefined && previousPrec !== undefined && effective.precision !== previousPrec) {
      return { outcome: { status: 'unverifiable', parameter: 'date', variant: 'mixed-precision-sort' } };
    }
    // Overlapping precision intervals (e.g. .5 vs .55) carry no order proof:
    // unverifiable, never a false contradiction (Q-14). Equal starts tie.
    if (previous !== undefined && previousEnd !== undefined && effective.start !== previous
      && effective.start < previousEnd && previous < effective.end) {
      return { outcome: { status: 'unverifiable', parameter: 'date', variant: 'overlapping-precision-sort' } };
    }
    if (previous !== undefined && (descending ? effective.start > previous : effective.start < previous)) return { outcome: { status: 'contradicted', parameter: 'date' } };
    previous = effective.start;
    previousEnd = effective.end;
    previousPrec = effective.precision;
  }
  return { outcome: { status: 'ok' }, ...(previous !== undefined ? { boundary: previous, ...(previousPrec ? { boundaryPrecision: previousPrec } : {}) } : {}) };
}

/**
 * Within-page and cross-page order check for the single proved sort variant:
 * timezone-qualified effectiveDateTime instants, compared numerically.
 * Partial dates, Periods, Timing and missing keys are unverifiable.
 */
export function validateSortOrder(pages: readonly (readonly FhirResource[])[], requested: readonly string[], resourceType: string): ValidationOutcome {
  let boundary: SortBoundary | undefined;
  let precision: DateInterval['precision'] | undefined;
  for (const page of pages) {
    const result = validateSortPage(page, requested, resourceType, boundary, precision);
    if (result.outcome.status !== 'ok') return result.outcome;
    boundary = result.boundary ?? boundary;
    precision = result.boundaryPrecision ?? precision;
  }
  return { status: 'ok' };
}

/** Back-compatible narrow name used by the spec text. */
export const validateSortBoundary = validateSortOrder;

// ---------------------------------------------------------------------------
// Coverage decision table (spec section 7, priority order) and NO_MATCHES
// eligibility. Sort never changes set completeness.
// ---------------------------------------------------------------------------

export function coverageForSnapshot(evidence: QueryEvidence, chain: QueryChainView): CoverageV2 {
  if ((evidence.evidenceKind as string) === 'none') throw new GatewayFault('INTERNAL_ERROR', 'Error evidence cannot describe a successful snapshot.');
  const reasons: string[] = [];
  const add = (reason: string): void => { if (!reasons.includes(reason) && reasons.length < 32) reasons.push(reason); };
  const retained = chain.scope === 'retained';
  const metadata = chain.scope === 'metadata';
  if (!metadata) add('CLINICAL_RECORD_COMPLETENESS_UNKNOWN');
  if (retained) add('RETAINED_PAGE_IS_NOT_THE_ENTIRE_QUERY');
  if (chain.remainder === 'local' || chain.remainder === 'upstream') add('MORE_PAGES');
  if (chain.remainder === 'rejected_link' || chain.nonContinuable) add('NON_CONTINUABLE_UPSTREAM_LINK');
  if (chain.remainder === 'unknown' && !chain.refusalReasons?.includes('SOURCE_REPORTED_INCOMPLETE')) add('CONTINUATION_QUERY_UNVERIFIED');
  if (chain.refused) (chain.refusalReasons ?? ['DELIVERY_REFUSED']).forEach(add);
  if (!evidence.materialFilterProved && !metadata) add('FILTER_EXECUTION_UNVERIFIED');
  if (metadata) add('DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION');
  const hasRemainder = chain.remainder !== 'none' || Boolean(chain.nonContinuable) || Boolean(chain.refused);
  const state: CoverageV2['state'] = retained || hasRemainder
    ? 'partial'
    : metadata
      ? (chain.exhausted ? 'complete_for_query' : 'unknown')
      : chain.exhausted && evidence.materialFilterProved ? 'complete_for_query' : 'unknown';
  const shorthand = evidence.constraints.length === 0 && Boolean(evidence.query_digest) && !retained && !metadata;
  // Known continuable remainders decide first; a rejected upstream link
  // cannot erase a locally retained slice. Retained views stay unknown.
  const knownRemainder = chain.remainder === 'local' || chain.remainder === 'upstream';
  const queryExhausted: boolean | null = retained || chain.nonContinuable
    ? !retained && knownRemainder ? false : null
    : knownRemainder
      ? false
      : chain.refused || chain.remainder === 'unknown' || chain.remainder === 'rejected_link'
        ? null : chain.exhausted;
  return {
    state, scope: chain.scope, reasons,
    authorization_limited: metadata ? false : chain.authorizationLimited,
    query_exhausted: queryExhausted,
    pages_observed: chain.pagesObserved,
    ...(evidence.constraints.length ? { constraints: evidence.constraints.map(entry => ({ ...entry })) } : {}),
    ...(evidence.query_digest ? { query_digest: evidence.query_digest } : {}),
    ...(shorthand ? { constraints_on_first_page: true as const } : {}),
    ...(evidence.sort ? {
      sort: {
        ...(shorthand ? {} : { requested: [...evidence.sort.requested] }),
        effective: evidence.sort.effective ? [...evidence.sort.effective] : null,
        evidence: evidence.sort.order === 'verified_by_adapter' ? 'observed_supported' as const : 'unknown' as const,
        order: evidence.sort.order,
      },
    } : {}),
    query_evidence: retained ? 'retained_snapshot' : metadata ? 'metadata_snapshot' : evidence.evidenceKind,
  };
}

/** True when the ORDER_UNVERIFIED warning must accompany this evidence. */
export function orderUnverified(evidence: QueryEvidence): boolean {
  return evidence.sort !== undefined && evidence.sort.order === 'requested_unverified';
}

/** Shared with the strict gate; the gate's accepted set is authoritative. */
export { noMatchesEligible } from './contracts.js';
