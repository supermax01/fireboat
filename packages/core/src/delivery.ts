// Gate-F delivery freeze (spec §5). P owns this file after handoff.
// N-2: the test-only override type lives here and is deliberately NOT
// re-exported from the package public surface (core index). The CLI cannot
// pass it; public config cannot select fixture_only entries.
//
// G-15 (P fix round, unconditional): `textMode:'summary'` always fails
// INVALID_CONFIG with a migration message naming `delivery.profile`;
// `textMode:'envelope'` is a deprecated alias of full-text-v1 and conflicts
// with `structured-evidence-v1`. Conflicting old/new config is always
// invalid; no verified-cell exemption applies.
import type { GatewayEnvelope, ToolName } from './contracts.js';
import { stringifyFhir } from './decimal.js';
import { TEST_CORRUPTOR_WARNING, UNVERIFIED_DELIVERY_WARNING } from './repairs.js';
import { modifierElements, resourceTypeContext } from './schema.js';

export type DeliveryProfile = 'full-text-v1' | 'structured-evidence-v1';

export interface HostProfileEntry {
  id: string; version: string;
  host: { name: string; version: string; client_stack: string; client_stack_version: string };
  era: 'modern' | 'legacy'; transport: 'stdio'; workflow: 'recent-labs-v1';
  delivery_profile: DeliveryProfile;
  verification: 'verified' | 'unverified' | 'fixture_only';
  trace_sha256?: string; model_input_sha256?: string; tests?: string[]; checked_at?: string;
}

/** Shipped registry: zero verified cells until real host captures exist. */
export const HOST_PROFILE_REGISTRY: readonly HostProfileEntry[] = [];

/** Test-harness-only constructor dependency. Keep out of public exports (N-2). */
export interface TestDeliveryRegistryOverride {
  entries: readonly HostProfileEntry[];
  profileId: string;
}

export interface GatewayTestOptions {
  testDeliveryRegistryOverride?: TestDeliveryRegistryOverride;
  /**
   * Test-only corruption seam (R2-1): invoked inside `execute` immediately
   * before each strict core gate (`success` after fit, `error` after error
   * shaping) and once on the construction-time emergency template sample
   * (`construction`), so tests can prove corrupted envelopes are discarded
   * to fitted INTERNAL_ERROR envelopes. The gate always runs after the hook;
   * the hook can only make delivery fail closed. Like the registry override
   * this type is never re-exported publicly and no config/CLI path can set it.
   * R3-L5: every envelope from such a gateway carries TEST_CORRUPTOR_WARNING.
   */
  testEnvelopeCorruptor?: (envelope: GatewayEnvelope, phase: 'construction' | 'success' | 'error') => void;
}

/**
 * Pure entry selector (G-14): without a test override only `verified` entries
 * are selectable; with one, the override pool is authoritative (and labelled).
 */
export function selectHostProfileEntry(
  pool: readonly HostProfileEntry[],
  id: string | undefined,
  era: 'modern' | 'legacy',
  overridePresent: boolean,
): HostProfileEntry | undefined {
  const entry = pool.find(e => e.id === id && e.era === era && e.delivery_profile === 'structured-evidence-v1');
  if (!entry || (!overridePresent && entry.verification !== 'verified')) return undefined;
  return entry;
}

export function resolveDeliveryProfile(
  config: { profile?: DeliveryProfile; hostProfileId?: string } | undefined,
  era: 'modern' | 'legacy',
  override?: TestDeliveryRegistryOverride,
): { profile: DeliveryProfile; verified: boolean } {
  const wanted = config?.profile ?? 'full-text-v1';
  if (wanted === 'full-text-v1') return { profile: 'full-text-v1', verified: true };
  const id = override?.profileId ?? config?.hostProfileId;
  const pool = override ? override.entries : HOST_PROFILE_REGISTRY;
  const entry = selectHostProfileEntry(pool, id, era, Boolean(override));
  if (!entry) {
    throw Object.assign(new Error('Structured delivery requires a verified host profile; use full-text-v1.'), { code: 'UNVERIFIED_HOST_PROFILE' });
  }
  return { profile: 'structured-evidence-v1', verified: entry.verification === 'verified' };
}

/**
 * Per-call era resolution (P-7c): structured delivery needs a host cell for
 * the exact era of the call. When no cell exists for that era the call is
 * delivered as full-text-v1 (labelled in the rendered text), never upgraded.
 */
export function deliveryProfileForEra(
  config: { profile?: DeliveryProfile; hostProfileId?: string } | undefined,
  era: 'modern' | 'legacy',
  override?: TestDeliveryRegistryOverride,
): DeliveryProfile {
  if ((config?.profile ?? 'full-text-v1') === 'full-text-v1') return 'full-text-v1';
  try { return resolveDeliveryProfile(config, era, override).profile; } catch { return 'full-text-v1'; }
}

/** True when the pool holds any verified structured-evidence entry. */
export function hasVerifiedStructuredProfile(pool: readonly HostProfileEntry[]): boolean {
  return pool.some(entry => entry.verification === 'verified' && entry.delivery_profile === 'structured-evidence-v1');
}

/**
 * G-15 config migration guard (unconditional). `textMode:'summary'` always
 * throws INVALID_CONFIG naming `delivery.profile`. `textMode:'envelope'`
 * combined with `structured-evidence-v1` always throws: conflicting
 * old/new config is invalid, with no verified-cell exemption. The
 * `override` parameter is retained for the frozen signature; it never
 * exempts the conflict.
 */
export function assertSummaryAllowed(
  config: { textMode?: 'envelope' | 'summary'; delivery?: { profile?: DeliveryProfile; hostProfileId?: string } },
  override?: TestDeliveryRegistryOverride,
): void {
  void override;
  if (config.textMode === 'summary') {
    throw Object.assign(
      new Error("textMode:'summary' was removed; use delivery.profile ('full-text-v1', or 'structured-evidence-v1' with a verified hostProfileId)."),
      { code: 'INVALID_CONFIG' },
    );
  }
  if (config.textMode === 'envelope' && config.delivery?.profile === 'structured-evidence-v1') {
    throw Object.assign(
      new Error("textMode:'envelope' conflicts with delivery.profile 'structured-evidence-v1'; remove textMode and use delivery.profile ('full-text-v1', or 'structured-evidence-v1' with a verified hostProfileId)."),
      { code: 'INVALID_CONFIG' },
    );
  }
}

// ---------------------------------------------------------------------------
// Structured-evidence slim text (spec §5). The complete envelope always
// remains in structuredContent; this text carries actual evidence lines and
// every continuation/error control, never a factless record count.
//
// Injection safety (P-2): every upstream-derived value is rendered as a
// JSON-quoted literal on a fixed key (or as single-line JSON). JSON quoting
// escapes newlines, carriage returns and C0 controls; U+2028/U+2029/U+0085
// are additionally escaped, so no upstream string can forge a control line
// or a same-line field. Gateway-generated tokens (cursors, handles) are
// quoted the same way for uniformity. The one dynamic key — a
// choice-modifier JSON name taken from the resource in a direct renderer
// call — is validated and JSON-quoted when it is not a plain element name
// (R2-3); sanitize normally withholds such names (V-22).
// ---------------------------------------------------------------------------

export type StopReason = 'exhausted' | 'more_pages' | 'non_continuable' | 'retention_limit' | 'timeout' | 'upstream_error' | 'error';

/** Stop-state taxonomy over existing envelope controls only (Addendum A.8); introduces no public code. */
export function stopReasonFor(envelope: GatewayEnvelope): StopReason {
  if (envelope.error) {
    if (envelope.error.code === 'UPSTREAM_TIMEOUT' || envelope.error.code === 'TOKEN_TIMEOUT') return 'timeout';
    if (envelope.error.code === 'RETENTION_LIMIT') return 'retention_limit';
    if (envelope.error.code.startsWith('UPSTREAM_')) return 'upstream_error';
    return 'error';
  }
  if (envelope.coverage.reasons.includes('NON_CONTINUABLE_UPSTREAM_LINK') && !envelope.pagination?.next_cursor) return 'non_continuable';
  if (envelope.pagination?.has_more === true || envelope.pagination?.next_cursor) return 'more_pages';
  if (typeof (envelope.data as { next_offset?: unknown }).next_offset === 'number') return 'more_pages';
  if (envelope.pagination?.has_more === null) return 'non_continuable';
  return 'exhausted';
}

/**
 * The `stop:` control line is printed only as a restatement of controls
 * already on the page (P-6): exhaustion requires `has_more:false` plus
 * `query_exhausted:true` (or a complete-for-query state), and
 * non-continuable requires the NON_CONTINUABLE_UPSTREAM_LINK reason.
 */
function restatedStop(envelope: GatewayEnvelope): StopReason | undefined {
  const stop = stopReasonFor(envelope);
  if (stop === 'exhausted') {
    const exhausted = (envelope.coverage as { query_exhausted?: unknown }).query_exhausted;
    return envelope.pagination?.has_more === false && (exhausted === true || envelope.coverage.state === 'complete_for_query') ? stop : undefined;
  }
  if (stop === 'non_continuable' && !envelope.coverage.reasons.includes('NON_CONTINUABLE_UPSTREAM_LINK')) return undefined;
  return stop;
}

/** JSON-quoted literal for one untrusted string; line separators beyond C0 are escaped too. */
const quoteText = (value: string): string => JSON.stringify(value).replace(/[\u2028\u2029\u0085]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
/** Single-line JSON for a composite value (repairs, manifests, ranges, full-record fallbacks). */
const jsonLine = (value: unknown): string => stringifyFhir(value).replace(/[\u2028\u2029\u0085]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const asRecord = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
/** Primitive field: strings JSON-quoted; numbers keep their source lexeme; anything else as JSON. */
const scalarField = (value: unknown): string => (typeof value === 'string' ? quoteText(value) : jsonLine(value));

function conceptParts(key: string, concept: unknown): string[] {
  const record = asRecord(concept);
  if (!record) return [];
  const parts: string[] = [];
  const codings = record.coding;
  if (Array.isArray(codings) && codings.length) {
    const tuples = codings.slice(0, 4).map(coding => {
      const entry = asRecord(coding) ?? {};
      return [
        typeof entry.system === 'string' ? entry.system : null,
        typeof entry.version === 'string' ? entry.version : null,
        typeof entry.code === 'string' ? entry.code : null,
        typeof entry.display === 'string' ? entry.display : null,
      ];
    });
    parts.push(`${key}=${jsonLine(tuples)}`);
    if (codings.length > 4) parts.push(`(+${codings.length - 4} more codings)`);
  }
  if (typeof record.text === 'string') parts.push(`${key}_text=${quoteText(record.text)}`);
  return parts;
}

function quantityParts(key: string, quantity: Record<string, unknown>): string[] {
  const parts: string[] = [];
  const comparator = typeof quantity.comparator === 'string' && ['<', '<=', '>=', '>'].includes(quantity.comparator) ? quantity.comparator : '';
  if (quantity.value !== undefined) parts.push(`${key}=${comparator}${scalarField(quantity.value)}`);
  if (typeof quantity.comparator === 'string' && !comparator) parts.push(`comparator=${quoteText(quantity.comparator)}`);
  const unit = [quantity.system, quantity.code, quantity.unit].map(part => (typeof part === 'string' ? part : null));
  if (unit.some(part => part !== null)) parts.push(`unit=${jsonLine(unit)}`);
  return parts;
}

function referenceParts(key: string, value: unknown): string[] {
  const record = asRecord(value);
  if (!record || typeof record.reference !== 'string') return [];
  const parts = [`${key}=${quoteText(record.reference)}`];
  if (typeof record.display === 'string') parts.push(`${key}_display=${quoteText(record.display)}`);
  return parts;
}

function valueParts(key: string, resource: Record<string, unknown>, prefix: string): string[] {
  let extensionOnly = false;
  for (const name of Object.keys(resource)) {
    if (name === `_${prefix}` || (name.startsWith(`_${prefix}`) && name.length > prefix.length + 1)) extensionOnly = true;
    if (!name.startsWith(prefix) || name === prefix || name.startsWith('_')) continue;
    const value = resource[name];
    if (name === `${prefix}Quantity`) { const quantity = asRecord(value); if (quantity) return quantityParts(key, quantity); }
    if (name === `${prefix}CodeableConcept`) return conceptParts(key, value);
    if (name === `${prefix}Period`) { const period = asRecord(value); if (period) return [`${key}=${jsonLine([period.start ?? null, period.end ?? null])}`]; }
    if (name === `${prefix}Reference`) return referenceParts(key, value);
    if (value && typeof value === 'object') return [`${key}=${jsonLine(value)}`];
    return [`${key}=${scalarField(value)}`];
  }
  return extensionOnly ? [`${key}=[extension-only]`] : [];
}

function hasModifierSemantics(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object') return false;
  if (depth > 32) return true; // Fail closed: undecidable depth is structural, never interpretable.
  if (Array.isArray(value)) return value.some(item => hasModifierSemantics(item, depth + 1));
  return Object.entries(value).some(([key, child]) => key === 'modifierExtension' || key === 'implicitRules' || hasModifierSemantics(child, depth + 1));
}

/** Present root modifier facts (negation etc.), one key each; choice elements resolve to their JSON name. */
function modifierParts(resource: Record<string, unknown>, type: string, rendered: Set<string>): string[] {
  const parts: string[] = [];
  for (const name of modifierElements(type)) {
    if (name === 'modifierExtension' || name === 'implicitRules') continue;
    const keys = name.endsWith('[x]')
      ? Object.keys(resource).filter(key => key.startsWith(name.slice(0, -3)) && !key.startsWith('_'))
      : (Object.hasOwn(resource, name) ? [name] : []);
    for (const key of keys) {
      if (rendered.has(key)) continue;
      rendered.add(key);
      const value = resource[key];
      // R2-3: this is the one key that could print unquoted in a direct
      // renderer call. Quote any non-element-name key and keep its value
      // as single-line JSON so it cannot forge a line or field.
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) { parts.push(`${quoteText(key)}=${jsonLine(value)}`); continue; }
      const concept = conceptParts(key, value);
      if (concept.length) { parts.push(...concept); continue; }
      const reference = referenceParts(key, value);
      if (reference.length) { parts.push(...reference); continue; }
      parts.push(`${key}=${value && typeof value === 'object' ? jsonLine(value) : scalarField(value)}`);
    }
  }
  return parts;
}

function recordLines(envelope: GatewayEnvelope, resource: Record<string, unknown>, structural: boolean): string[] {
  const type = typeof resource.resourceType === 'string' ? resource.resourceType : undefined;
  const version = asRecord(resource.meta)?.versionId;
  const citation = [
    'record',
    `source=${quoteText(envelope.source.alias)}`,
    `type=${type === undefined ? '<unknown>' : quoteText(type)}`,
    `id=${typeof resource.id === 'string' ? quoteText(resource.id) : '<absent>'}`,
    ...(version === undefined ? [] : [`version=${scalarField(version)}`]),
  ];
  if (structural || type === undefined || !resourceTypeContext(type)) {
    const parts = [...citation];
    parts.push('[structural/uninterpreted]');
    return [parts.join(' '), `  full-text-v1: ${jsonLine(resource)}`];
  }
  const rendered = new Set<string>();
  const facts: string[] = [];
  if (resource.status !== undefined) { rendered.add('status'); facts.push(`status=${scalarField(resource.status)}`); }
  facts.push(...modifierParts(resource, type, rendered));
  for (const key of ['code', 'medicationCodeableConcept', 'medicationReference', 'vaccineCode', 'type'] as const) {
    if (resource[key] === undefined || rendered.has(key)) continue;
    rendered.add(key);
    facts.push(...(key === 'medicationReference' ? referenceParts(key, resource[key]) : conceptParts(key, resource[key])));
  }
  facts.push(...valueParts('value', resource, 'value'));
  facts.push(...valueParts('effective', resource, 'effective'));
  facts.push(...valueParts('occurrence', resource, 'occurrence'));
  for (const key of ['gender', 'birthDate', 'date', 'issued'] as const) {
    const value = resource[key];
    if (value !== undefined && (typeof value === 'string' || typeof value === 'boolean')) facts.push(`${key}=${scalarField(value)}`);
  }
  if (Array.isArray(resource.interpretation)) for (const concept of resource.interpretation) facts.push(...conceptParts('interpretation', concept));
  else facts.push(...conceptParts('interpretation', resource.interpretation));
  facts.push(...conceptParts('dataAbsentReason', resource.dataAbsentReason));
  facts.push(...conceptParts('statusReason', resource.statusReason));
  if (!facts.length) {
    const parts = [...citation];
    parts.push('[structural]');
    return [parts.join(' '), `  full-text-v1: ${jsonLine(resource)}`];
  }
  const lines = [[...citation, ...facts].join(' ')];
  if (Array.isArray(resource.component)) {
    for (const component of resource.component.slice(0, 32)) {
      const entry = asRecord(component) ?? {};
      const componentParts = [...conceptParts('code', entry.code), ...valueParts('value', entry, 'value'), ...conceptParts('dataAbsentReason', entry.dataAbsentReason)];
      lines.push(`  component ${componentParts.length ? componentParts.join(' ') : jsonLine(entry)}`);
    }
    if (resource.component.length > 32) lines.push(`  (+${resource.component.length - 32} more components)`);
  }
  if (Array.isArray(resource.referenceRange) && resource.referenceRange.length) lines.push(`  referenceRange=${jsonLine(resource.referenceRange)}`);
  return lines;
}

/** One line per delivered withheld manifest, in array order. A collapsed policy entry (S5b) prints its
 * multiplicity as `withheld xN:` with the count removed from the quoted JSON, so both channels disclose
 * it exactly once; the text never re-aggregates entries by shape. */
function withheldLines(envelope: GatewayEnvelope): string[] {
  return envelope.transform.withheld_payloads.map(manifest => {
    const { count, ...rest } = manifest as { count?: unknown } & Record<string, unknown>;
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 2 && Object.keys(manifest).length === 3
      ? `withheld x${count}: ${jsonLine(rest)}` : `withheld: ${jsonLine(manifest)}`;
  });
}

function controlLines(envelope: GatewayEnvelope): string[] {
  const coverage = envelope.coverage as unknown as Record<string, unknown>;
  const transform = envelope.transform as unknown as Record<string, unknown>;
  const lines = [
    `source: ${quoteText(envelope.source.alias)}`,
    `context: ${quoteText(envelope.context.handle)}`,
    `coverage: ${quoteText(envelope.coverage.state)} scope=${quoteText(envelope.coverage.scope)} reasons=${jsonLine(envelope.coverage.reasons)}`,
  ];
  const stop = restatedStop(envelope);
  if (stop) lines.push(`stop: ${stop}`);
  const sort = asRecord(coverage.sort);
  const order = typeof sort?.order === 'string' ? sort.order : (typeof coverage.order === 'string' ? coverage.order : undefined);
  if (order !== undefined) lines.push(`order: ${quoteText(order)}`);
  if (sort) {
    if (Array.isArray(sort.requested)) lines.push(`sort_requested: ${jsonLine(sort.requested)}`);
    if ('effective' in sort) lines.push(`sort_effective: ${jsonLine(sort.effective ?? null)}`);
  }
  if ('query_exhausted' in coverage) lines.push(`query_exhausted: ${jsonLine(coverage.query_exhausted ?? null)}`);
  if ('authorization_limited' in coverage) lines.push(`authorization_limited: ${jsonLine(coverage.authorization_limited ?? null)}`);
  if (Array.isArray(coverage.constraints)) lines.push(`constraints: ${jsonLine(coverage.constraints.map(entry => { const c = asRecord(entry) ?? {}; return [typeof c.name === 'string' ? c.name : null, typeof c.execution === 'string' ? c.execution : null]; }))}`);
  if (Array.isArray(coverage.executed_constraints) && coverage.executed_constraints.length) lines.push(`executed_constraints: ${jsonLine(coverage.executed_constraints)}`);
  lines.push(`format: ${typeof transform.requested_format === 'string' ? `requested=${quoteText(transform.requested_format)} ` : ''}actual=${quoteText(envelope.transform.format)}`);
  if (Array.isArray(transform.recipe_ids) && transform.recipe_ids.length) lines.push(`recipe_ids: ${jsonLine(transform.recipe_ids)}`);
  if (Array.isArray(transform.structural_resource_indices) && transform.structural_resource_indices.length) lines.push(`structural: ${jsonLine(transform.structural_resource_indices)}`);
  if (typeof transform.delivery_profile === 'string') lines.push(`transform_delivery_profile: ${quoteText(transform.delivery_profile)}`);
  lines.push(`limit_reached: ${envelope.budget.limit_reached}`);
  if (envelope.pagination) {
    lines.push(`has_more: ${envelope.pagination.has_more}`);
    lines.push(`returned_matches: ${envelope.pagination.returned_matches}`);
    if (envelope.pagination.next_cursor) lines.push(`next_cursor: ${quoteText(envelope.pagination.next_cursor)}`);
    if (envelope.pagination.total) lines.push(`total: ${jsonLine(envelope.pagination.total)}`);
  }
  const nextOffset = (envelope.data as { next_offset?: unknown }).next_offset;
  if (typeof nextOffset === 'number') lines.push(`next_offset: ${nextOffset}`);
  if (envelope.result) lines.push(`result_handle: ${quoteText(envelope.result.handle)}`, `result_expires_at: ${quoteText(envelope.result.expires_at)}`);
  const provenance = (envelope as { provenance?: unknown }).provenance;
  if (Array.isArray(provenance)) lines.push(`provenance: count=${provenance.length} retrieved_at=${jsonLine(provenance.map(entry => { const p = asRecord(entry); return typeof p?.retrieved_at === 'string' ? p.retrieved_at : null; }))}`);
  for (const warning of envelope.warnings) lines.push(`warning ${quoteText(warning.code)}: ${quoteText(warning.message)}${warning.repair ? ` repair=${jsonLine(warning.repair)}` : ''}`);
  lines.push(...withheldLines(envelope));
  const manifest = (envelope.data as { manifest?: unknown }).manifest;
  if (manifest) lines.push(`manifest: ${jsonLine(manifest)}`);
  const omitted = (envelope.transform as { omitted_fields?: unknown }).omitted_fields;
  if (Array.isArray(omitted) && omitted.length) lines.push(`omitted_fields: ${jsonLine(omitted)}`);
  const unresolved = (envelope.transform as { unresolved_fields?: unknown }).unresolved_fields;
  if (Array.isArray(unresolved) && unresolved.length) lines.push(`unresolved_fields: ${jsonLine(unresolved)}`);
  if (envelope.error) lines.push(`error ${quoteText(envelope.error.code)}: ${quoteText(envelope.error.safe_message)} retryable=${envelope.error.retryable}${envelope.error.repair ? ` repair=${jsonLine(envelope.error.repair)}` : ''}`);
  return lines;
}

export interface EvidenceRender { text: string; fellBack: boolean; deliveredProfile: DeliveryProfile }

/**
 * Render the slim evidence text. Resource pages, errors and retained
 * inspection shapes summarize safely; any other result kind falls back to
 * full-envelope text for that result, labelled full-text-v1 (`fellBack:true`
 * and `deliveredProfile:'full-text-v1'`, for root to copy into
 * `transform.delivery_profile` before fitting at the 0.2 flip). A record
 * that cannot be summarized faithfully (structural/withheld modifier,
 * unknown type, no interpretable facts) falls back per record, labelled.
 * Structural status comes from 0.2 `transform.structural_resource_indices`
 * when present; on 0.1 envelopes an UNINTERPRETED_MODIFIER warning without
 * indices conservatively marks every record structural, since a
 * policy-withheld modifier leaves no per-record trace in the resource.
 */
export function evidenceRender(envelope: GatewayEnvelope, tool: ToolName = 'fhir_result'): EvidenceRender {
  if (tool === 'fhir_capabilities') return { text: `delivery_profile: "full-text-v1"\n${jsonLine(envelope)}`, fellBack: true, deliveredProfile: 'full-text-v1' };
  const resources = (envelope.data as { resources?: unknown }).resources;
  const inspection = tool === 'fhir_result' && typeof (envelope.data as { resource_count?: unknown }).resource_count === 'number';
  if (!envelope.error && !Array.isArray(resources) && !inspection) return { text: `delivery_profile: "full-text-v1"\n${jsonLine(envelope)}`, fellBack: true, deliveredProfile: 'full-text-v1' };
  const lines = ['delivery_profile: "structured-evidence-v1"', ...controlLines(envelope)];
  if (Array.isArray(resources)) {
    const rawIndices = (envelope.transform as { structural_resource_indices?: unknown }).structural_resource_indices;
    const indices = Array.isArray(rawIndices) ? new Set(rawIndices.filter((index): index is number => typeof index === 'number')) : undefined;
    const suspected = envelope.warnings.some(warning => warning.code === 'UNINTERPRETED_MODIFIER');
    resources.forEach((resource, index) => {
      const record = asRecord(resource);
      if (!record) return;
      const structural = indices ? (indices.has(index) || hasModifierSemantics(record)) : (suspected || hasModifierSemantics(record));
      lines.push(...recordLines(envelope, record, structural));
    });
  }
  if (inspection) {
    lines.push(`retained_resource_count: ${(envelope.data as { resource_count?: number }).resource_count}`);
    const omissions = (envelope.data as { omissions?: unknown }).omissions;
    if (Array.isArray(omissions)) {
      for (const row of omissions.slice(0, 100)) lines.push(`omission: ${jsonLine(row)}`);
      if (omissions.length > 100) lines.push(`(+${omissions.length - 100} more omissions)`);
    }
  }
  return { text: lines.join('\n'), fellBack: false, deliveredProfile: 'structured-evidence-v1' };
}

/** Frozen gate-F signature: slim evidence text for the structured profile. */
export function evidenceText(envelope: GatewayEnvelope): string {
  return evidenceRender(envelope).text;
}

export function withUnverifiedDeliveryWarning(envelope: GatewayEnvelope): GatewayEnvelope {
  if (!envelope.warnings.some(w => w.code === UNVERIFIED_DELIVERY_WARNING.code)) envelope.warnings = [...envelope.warnings, { ...UNVERIFIED_DELIVERY_WARNING }];
  return envelope;
}

/** R3-L5: label every envelope produced while the test-only corruptor seam is installed. */
export function withTestCorruptorWarning(envelope: GatewayEnvelope): GatewayEnvelope {
  if (!envelope.warnings.some(w => w.code === TEST_CORRUPTOR_WARNING.code)) envelope.warnings = [...envelope.warnings, { ...TEST_CORRUPTOR_WARNING }];
  return envelope;
}

