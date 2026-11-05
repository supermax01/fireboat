// Gate-F repair helpers (spec §2/§10). P owns this file after handoff and may
// replace internals, but the signatures and REPAIR_TABLE semantics are frozen.
// Imports shared contracts and fixed catalog text, never Q's search/support/generated modules.
import { REPAIR_TABLE, type FaultCode, type Repair, type RepairMeta, type ReviewedNames } from './contracts.js';

import { WARNING_MESSAGES } from './catalog.js';

const KNOWN: ReadonlySet<string> = new Set(Object.keys(REPAIR_TABLE));

export function repairForFault(code: FaultCode | string, meta: RepairMeta, reviewed: ReviewedNames): Repair | undefined {
  if (!KNOWN.has(code)) return undefined;
  const template = REPAIR_TABLE[code as FaultCode];
  if (!template) return undefined;
  // Uniformized direct-read absence never carries advice, whatever the table says.
  if (code === 'NOT_FOUND') return undefined;
  if (template.budget === 'increase_or_narrow') {
    // R-3: a larger budget cannot fix warning overflow.
    if (meta.cause === 'warnings_overflow') return { action: 'narrow_query' };
    if (meta.allowed_max_bytes > meta.current_max_bytes) return { action: 'increase_budget', max_bytes: Math.min(Math.max(meta.allowed_max_bytes, 4096), 131072) };
    return { action: 'narrow_query' };
  }
  const repair: Repair = { action: template.action, ...(template.tool ? { tool: template.tool } : {}) };
  if (template.resource && meta.resource_type && reviewed.resource(meta.resource_type)) repair.resource_type = meta.resource_type as Repair['resource_type'];
  if (template.parameter && meta.resource_type && meta.parameter && reviewed.parameter(meta.resource_type, meta.parameter)) repair.parameter = meta.parameter;
  return repair;
}

/**
 * Reviewed per-type observed-code fields (P-11): types whose pinned R4
 * `code` element is a CodeableConcept. A `code` search parameter alone does
 * not imply a `code` element (MedicationRequest searches `medication[x]`),
 * so types outside this map get discovery advice, never an unresolvable
 * field. Tests verify every entry against the pinned schema.
 */
export const OBSERVED_CODE_FIELDS: Readonly<Record<string, string>> = {
  Observation: 'code', Condition: 'code', AllergyIntolerance: 'code', DiagnosticReport: 'code', Procedure: 'code',
};

/** Reviewed date-typed names from the pinned R4 search definitions. Keep the
 * original occurrences; this map grants no execution proof or source support. */
export const OBSERVED_CODE_DATE_PARAMETERS: Readonly<Record<string, readonly string[]>> = {
  Observation: ['date', 'value-date'],
  Condition: ['abatement-date', 'onset-date', 'recorded-date'],
  AllergyIntolerance: ['date', 'last-date', 'onset'],
  DiagnosticReport: ['date', 'issued'],
  Procedure: ['date'],
};

export function repairForNoMatches(type: string, reviewed: ReviewedNames, dateWindow: readonly { name: string; value: string }[] = []): Repair | undefined {
  if (!reviewed.resource(type)) return { action: 'discover_search_parameter', tool: 'fhir_capabilities' };
  const field = OBSERVED_CODE_FIELDS[type];
  if (field && dateWindow.length > 0 && dateWindow.every(pair => OBSERVED_CODE_DATE_PARAMETERS[type]?.includes(pair.name) && Boolean(pair.value)) && reviewed.parameter(type, 'code')) {
    return { action: 'inspect_observed_codes', tool: 'fhir_search', resource_type: type as Repair['resource_type'], fields: [field], page_size: 100, max_pages: 3, max_calls: 4 };
  }
  return { action: 'discover_search_parameter', tool: 'fhir_capabilities', resource_type: type as Repair['resource_type'] };
}

/** Fixed NO_MATCHES text (spec §3). The uncertainty sentence is appended only for unverified filters. */
export const NO_MATCHES_MESSAGE = WARNING_MESSAGES.NO_MATCHES!;
export const NO_MATCHES_UNVERIFIED_SUFFIX = ' Filter execution is not verified.';
/** N-2: fixed warning carried by every envelope rendered under a test-only delivery override. */
export const UNVERIFIED_DELIVERY_WARNING = { code: 'UNVERIFIED_DELIVERY_PROFILE', message: WARNING_MESSAGES.UNVERIFIED_DELIVERY_PROFILE! } as const;
/** R3-L5: fixed warning carried by every envelope from a gateway constructed with the test-only corruptor seam. */
export const TEST_CORRUPTOR_WARNING = { code: 'TEST_ENVELOPE_CORRUPTOR_ACTIVE', message: WARNING_MESSAGES.TEST_ENVELOPE_CORRUPTOR_ACTIVE! } as const;

/**
 * NO_MATCHES warning (spec §3), pure P helper. Eligibility mirrors the frozen
 * rule without importing Q: a supported filtered query, zero delivered
 * authorized matches, and an exhausted (terminal) observed chain. Unknown
 * filter execution stays eligible and gains the fixed uncertainty sentence;
 * the hint never describes suppressed entries, upstream totals, or absence.
 * Root wires this after Q's coverage decision at integration.
 */
export function noMatchesWarning(
  input: { resourceType: string; deliveredCount: number; queryExhausted: boolean | null; filtered: boolean; filterExecutionVerified: boolean; dateWindow?: readonly { name: string; value: string }[] },
  reviewed: ReviewedNames,
): { code: 'NO_MATCHES'; message: string; repair?: Repair } | undefined {
  if (!input.filtered || input.deliveredCount !== 0 || input.queryExhausted !== true) return undefined;
  const repair = repairForNoMatches(input.resourceType, reviewed, input.dateWindow);
  return {
    code: 'NO_MATCHES',
    message: input.filterExecutionVerified ? NO_MATCHES_MESSAGE : `${NO_MATCHES_MESSAGE}${NO_MATCHES_UNVERIFIED_SUFFIX}`,
    ...(repair ? { repair } : {}),
  };
}

/** Bounded observed-code scan recipe (spec §3, `observed-code-scan-v1`). Client-side recipe limits, never a hidden gateway loop. */
export const OBSERVED_CODE_SCAN_LIMITS = {
  recipe: 'observed-code-scan-v1',
  maxClinicalPages: 3,
  maxMcpCalls: 4,
  maxUpstreamCalls: 20,
  maxSeconds: 45,
  maxBytesPerCall: 24576,
  maxBytesPerTask: 73728,
} as const;

/** FHIR escaped-list escaping (Addendum A.8): backslash first, then comma and pipe, per literal part. */
export function escapeFhirTokenPart(part: string): string {
  return part.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/\|/g, '\\|');
}

/**
 * Detailed observed-code OR value (P-10). Each system and code is
 * FHIR-escaped first; a missing system uses the faithful no-system form
 * `|code` (a bare code would match that code in ANY system and broaden the
 * query). The caller URL-encodes the resulting value exactly once. Tuples
 * are deduplicated in first-seen order on a collision-free key; the same
 * code in different systems is kept. At most 32 tuples are considered;
 * `truncated` reports whether input remained beyond that bound. Callers
 * that need completeness must refuse or narrow when `truncated` is set
 * rather than issuing a silently partial OR value.
 */
export function observedCodeOrValueDetailed(tuples: readonly { system?: string; code: string }[]): { value: string; truncated: boolean } {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const tuple of tuples.slice(0, 32)) {
    const key = JSON.stringify([tuple.system ?? null, tuple.code]);
    if (seen.has(key) || !tuple.code) continue;
    seen.add(key);
    parts.push(tuple.system ? `${escapeFhirTokenPart(tuple.system)}|${escapeFhirTokenPart(tuple.code)}` : `|${escapeFhirTokenPart(tuple.code)}`);
  }
  return { value: parts.join(','), truncated: tuples.length > 32 };
}

/** Frozen string form of {@link observedCodeOrValueDetailed}. */
export function observedCodeOrValue(tuples: readonly { system?: string; code: string }[]): string {
  return observedCodeOrValueDetailed(tuples).value;
}

/**
 * Detailed bounded split on unescaped commas only (P-10). Only `\,` is
 * unescaped: `\|` and `\\` keep their escaped form so the system/code
 * boundary inside each alternative survives (A.8). When more than
 * `maxParts` alternatives exist, the remainder stays joined in the final
 * part (never dropped, never a fabricated empty part) and `truncated` is set.
 * Callers MUST refuse a truncated result (R2-3): the joined remainder still
 * contains separator commas and is not a valid single alternative, so
 * treating `parts` as the complete alternative list would silently change
 * query meaning. Refuse or re-issue with a larger bound; never consume a
 * truncated `parts` array as if it were complete.
 */
export function splitEscapedCommaOrDetailed(value: string, maxParts = 32): { parts: string[]; truncated: boolean } {
  const parts: string[] = [];
  let current = '';
  let truncated = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === '\\' && i + 1 < value.length) {
      const next = value[i + 1]!;
      if (next === ',') { current += ','; i++; continue; }
      if (next === '|' || next === '\\') { current += `\\${next}`; i++; continue; }
    }
    if (char === ',') {
      if (parts.length + 1 < maxParts) { parts.push(current); current = ''; continue; }
      truncated = true;
      current += ',';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return { parts, truncated };
}

/** Frozen array form of {@link splitEscapedCommaOrDetailed}. It drops the `truncated` signal; callers that need completeness must use the Detailed form and refuse when truncated. */
export function splitEscapedCommaOr(value: string, maxParts = 32): string[] {
  return splitEscapedCommaOrDetailed(value, maxParts).parts;
}
