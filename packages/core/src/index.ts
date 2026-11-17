import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { SERVER_IDENTITY } from './identity.js';
import { TOOL_NAMES, toMcpToolResult, admitArguments, resolveErrorAllowance, safeSchemaPaths, NO_REVIEWED_NAMES, type AuditEvent, type DeliveryContext, type ExecuteOptions, type FhirResource, type GatewayConfig, type GatewayEnvelope, type ToolName } from './contracts.js';
import { toolInputV2Schemas, capabilitiesCombinationFault, FAULT_CODES, M3B_SCHEMA_VERSION, toMcpToolResult02, validateDeliverable02, modelCopyBytes, exceedsByteBudget, type ValidationContext02, type ToolInput02, type GatewayEnvelope02 } from './contracts.js';
import { assertLosslessJsonRuntime, containsPrecisionFault, stringifyFhir, toWireValue, cloneFhirValue, isFhirDecimal } from './decimal.js';
import { repairForFault, repairForNoMatches, noMatchesWarning, OBSERVED_CODE_DATE_PARAMETERS, OBSERVED_CODE_FIELDS, NO_MATCHES_UNVERIFIED_SUFFIX, TEST_CORRUPTOR_WARNING, UNVERIFIED_DELIVERY_WARNING } from './repairs.js';
import { assertSummaryAllowed, deliveryProfileForEra, evidenceRender, resolveDeliveryProfile, type GatewayTestOptions } from './delivery.js';
import { authorizeRecord, deliveredDirectoryReferences, foreignPatientSelector, identifierSystemsOverlap, isDirectoryType, personIdentifierSystem, projection, resourceClass, safeSharedIdentifierSystem, safeSharedProfile, sanitizeForDelivery, type DirectoryKey, type Sanitized } from './privacy.js';
import { collapseWithheld } from './withheld.js';
import { ResultStore, RetentionLedger, VerifiedTargetLedger, type StoreEntry } from './store.js';
import { FhirTransport, GatewayFault, invalidatesCredential, type RequestBudget as TransportRequestBudget } from './transport.js';
import { isFhirResourceType, schemaPage } from './schema.js';
import { coverageForSnapshot, noMatchesEligible, shorthandEvidence, orderUnverified, queryEvidencePairsMatch, matchSelfLink, buildQueryEvidence, downgradeEvidence, validateReturnedPredicates, validateSortPage, sortVariantListed, ProfileState, sourceIdentityDigest, carriesContinuationToken, validateTokenContinuation, RECORD_CHECKED_EVIDENCE_KIND, type SearchProfile, type CapabilitySourceIdentity } from './query.js';
import { checkablePredicate, checkReturnedRecords, isKnownParameterName, type CheckablePredicate } from './record-predicates.js';
import { WARNING_MESSAGES, REFUSAL_MESSAGES, MODIFIER_NO_CLINICAL_MESSAGE, OVERSIZE_RECOVERY_MESSAGES } from './catalog.js';
import { projectSanitized, indexedProvenance, collectRecipeIds, retainedOmissions } from './projection.js';
import type { QueryEvidence, QueryChainView, QueryOverlay, SanitizedProjectionRecord } from './m3b.js';
import { createDiscoveryStore, freezeSearchParameterSnapshot, freezeSupportSnapshot, freezeServerSnapshot, readDiscoverySnapshot, type DiscoveryBinding, type DiscoverySnapshotValue, normalizedCapabilityRevision, UNSUPPORTED_CLINICAL_RESOURCES, R4_TYPE_INTERACTIONS, assertClinicalResource, listedSearchParameters } from './discovery.js';
import { classifiedTypes, effectiveSupport, workflowSupport, withSharedIdentifierSummary, SUPPORT_MATRIX_REVISION } from './support.js';
import { filterSearchParameters, SEARCH_PARAMETER_DEFINITIONS, reviewedNamesFor, confinementFor, gatewayEnforcedIndicesFor, declaredFromCapability, withheldCapabilityNames, MAX_SEARCH_PARAM_DECLARATIONS, resolveSearchParameters, validatePatientSelectors, validateSearchSyntax, validateSearchAdmission, type DeclaredSearchParam, type VerifiedTargetCheck, type ResolvedSearchParameters } from './search-parameters.js';
import { CredentialFault, LocalWorkRefusal, type SmartDoctorStatus, type TokenProvider } from '../../auth/src/token-provider.js';
import { createCredentialProvider } from '../../auth/src/index.js';
import { SmartStandaloneProvider, type LoginIo, type LoginResult } from '../../auth/src/smart-standalone.js';
export { TOOL_NAMES, toMcpToolResult };
export { SERVER_IDENTITY } from './identity.js';
export {
  M3B_SCHEMA_VERSION, BYTES_PER_TOKEN_ASSUMPTION, MEASURED_BYTES_PER_TOKEN_O200K, CATALOG_TOKEN_MEASUREMENT, TOKEN_ACCEPTANCE_STATUS, CATALOG_BYTE_CAPS, CATALOG_TOKEN_CAPS, LISTED_OUTPUT_SCHEMA,
  FAULT_CODES, REPAIR_TABLE, RECIPE_IDS, LAB_EVIDENCE_RECIPE_ID, WORKFLOW_ID, OBSERVED_CODE_SCAN_RECIPE_ID,
  OUTPUT_SPINE, validateCrossField02, validateSpine, validateListedOutput, permissiveInputSchema, spineOutputSchema, minimalOutputSchema,
  admitArguments, resolveErrorAllowance, safeSchemaPaths, dedupeWarnings, capabilitiesCombinationFault,
  repairSchema, warningSchema, coverageV2Schema, toolEnvelopeV2Schemas, envelopeV2Schema, fhirCapabilitiesV2InputSchema, toolInputV2Schemas,
  NO_REVIEWED_NAMES,
} from './contracts.js';
export type { FaultCode, Repair, RepairMeta, RepairTemplate, ReviewedNames, ExecuteOptions, DeliveryContext, CoverageV2 } from './contracts.js';
export { repairForFault, repairForNoMatches, noMatchesWarning, NO_MATCHES_MESSAGE, NO_MATCHES_UNVERIFIED_SUFFIX, OBSERVED_CODE_SCAN_LIMITS, OBSERVED_CODE_FIELDS, escapeFhirTokenPart, observedCodeOrValue, observedCodeOrValueDetailed, splitEscapedCommaOr, splitEscapedCommaOrDetailed } from './repairs.js';
import { eligibleSearchProfileIds } from './query.js';
export { coverageForSnapshot, noMatchesEligible } from './query.js';
export { projectionMeta, projectSanitized, projectLabObservation, LAB_OBSERVATION_ROOTS, metaSupplement, indexedProvenance, collectRecipeIds, retainedOmissions } from './projection.js';
export type { ProjectedRecord } from './projection.js';
export type { QueryEvidence, QueryChainView, QueryOverlay, SanitizedProjectionRecord, ProjectionMeta, DiscoverySnapshot } from './m3b.js';
export { CATALOG_VERSION, SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS, WARNING_MESSAGES, CATALOG_V2_VERSION, SERVER_INSTRUCTIONS_V2, TOOL_DESCRIPTIONS_V2, TOOL_TITLES, PROPERTY_DESCRIPTIONS_V2, REFUSAL_MESSAGES, listedInputSchemaV2 } from './catalog.js';
export { ResultStore, RetentionLedger } from './store.js';
export { collapseWithheld, withheldMultiplicity } from './withheld.js';
export type { ResultStoreOptions } from './store.js';
// Delivery override types (delivery.ts) are intentionally not re-exported here.
export { ambientProxyRisk } from './transport.js';
export type { GatewayConfig, GatewayEnvelope, ToolName };

// State generation is internal to the gateway; transport still owns only HTTP/auth budgets.
interface RequestBudget extends TransportRequestBudget { stateGeneration?: number }

type UnionKeys<T> = T extends unknown ? keyof T : never;
type UnionField<T, K extends PropertyKey> = T extends unknown ? K extends keyof T ? T[K] : never : never;
/** Neutral dispatch view; strict admission has already selected the tool. */
type DispatchInput = { [K in UnionKeys<ToolInput02>]?: UnionField<ToolInput02, K> };
// Strict v2 Input: the schema-inferred union preserves required fields and enums.

type Input<T extends ToolName = ToolName> = ToolInput02<T>;
interface Admission02<T extends ToolName = ToolName> {
  input: Input<T>;
  /** Original own keys, captured before schema defaults add path/offset/topic. */
  ownKeys: readonly string[];
  format: 'compact' | 'fhir';
  requestedFormat?: 'compact' | 'fhir';
  fields?: string[];
}
type EnvelopeBody02 = Pick<GatewayEnvelope02, 'data' | 'coverage'> &
  Partial<Pick<GatewayEnvelope02, 'provenance' | 'pagination' | 'result' | 'warnings'>> &
  { transform?: Partial<GatewayEnvelope02['transform']> };

function freezeDeliveryState<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeliveryState); Object.freeze(value);
  }
  return value;
}
function assertDeliveryJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || seen.has(value)) throw new Error('Invalid delivery construction.');
  if (!Array.isArray(value) && !isFhirDecimal(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Invalid delivery container.');
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !('value' in descriptor)) throw new Error('Invalid delivery property.');
    if (descriptor.value === undefined && !Array.isArray(value)) continue; // absent optional object member
    assertDeliveryJson(descriptor.value, seen);
  }
  seen.delete(value);
}

interface CoverageAssembly02 {
  tool: 'fhir_search' | 'fhir_page' | 'fhir_read' | 'fhir_result';
  /** Finally packed deliveries in THIS response, after all exclusions. */
  deliveredCount: number;
  /** Trusted prior delivered evidence; absent means full disclosure. */
  previousEvidence?: QueryEvidence;
  localRemainder?: boolean;
  unknownContinuation?: boolean;
  capped?: boolean;
  refused?: boolean;
  reasons?: readonly string[];
  /** Admission establishes a supported material filter, excluding confinement/sort. */
  filtered: boolean;
}

// Deliberately not exported, parsed from config or reachable through CLI/MCP.
interface PrivateGatewayTestOptions extends GatewayTestOptions { testQueryProfile?: SearchProfile }
const TEST_QUERY_WARNING = { code: 'TEST_QUERY_EVIDENCE', message: 'Private candidate query profile: synthetic test evidence only; no public profile eligibility is implied.' };
interface Snapshot {
  records: Sanitized[]; offset: number; nextUrl?: string; type: string;
  suppressed: boolean; query: { name: string; value: string }[];
  total?: number; loaded?: boolean;
  /** Immutable original evidence, shared with the ordered query in store metadata. */
  queryEvidence?: QueryEvidence;
  queryBinding?: Readonly<{ sourceRevision: string; policyRevision: string; contextHandle: string }>;
  queryOverlay?: QueryOverlay;
  partialReasons?: ('ENTRY_ORIGIN_MISMATCH' | 'INVALID_RESOURCE_ID' | 'RECORDS_WITHHELD_BY_POLICY' | 'SHARED_RECORDS_WITHHELD_BY_POLICY')[];
  /** Range of the shared page blob a `res_` handle covers (handle overlay); absent means the whole page. */
  sliceStart?: number; sliceEnd?: number;
  expiresAt?: number;
  queryEvidenceKind?: 'declared_and_self_link_only' | 'unverified_continuation';
  /** The upstream next link was unsupported or unsafe; delivered evidence is partial and cannot continue. */
  nonContinuable?: boolean;
  /** At least one authorized resource was refused for an unpreservable numeric value (per resource). */
  precisionRefused?: boolean;
  /** Query parameter names whose execution an upstream OperationOutcome called into question. */
  unverifiedFilters?: string[];
  /** The source itself reported the result incomplete at warning/information severity: partial, never exhaustion, no total. */
  sourceIncomplete?: boolean;
  /** Sanitized IssueType codes from other warning/information outcomes, surfaced as SOURCE_OUTCOME. */
  outcomeCodes?: string[];
}
interface ResourceCapability {
  type: string; interactions: string[]; searchParameters: string[]; searchParamTypes: Record<string, string>;
  /** Repeated resource types have no authority; retain only this revision marker. */
  ambiguous?: boolean;
  declared: DeclaredSearchParam[];
  withheldNameCount?: number;
  withheldNameDigest?: string;
  withheldNameRevision?: number;
  /** Metadata-only generic resolution; discarded with the capability revision. */
  resolvedParameters: Map<string, ResolvedSearchParameters>;
}

/** Retain only keyed process-local digests of exact bounded source identity tokens. */
function boundedSourceIdentity(metadata: Record<string, unknown>, fhirVersion: string, revision: string): CapabilitySourceIdentity {
  const software = metadata.software as { name?: unknown; version?: unknown } | undefined;
  const bounded = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? sourceIdentityDigest(value) : undefined;
  // The normalized capability revision binds a qualified profile to the exact capability contract it was proved on.
  return { digested: true, software: bounded(software?.name), softwareVersion: bounded(software?.version), fhirVersion, revision };
}
function sameSourceIdentity(a: CapabilitySourceIdentity, b: CapabilitySourceIdentity): boolean {
  return a.software === b.software && a.softwareVersion === b.softwareVersion && a.fhirVersion === b.fhirVersion;
}
const configSchema = z.strictObject({
  mode: z.literal('synthetic'),
  source: z.strictObject({ alias: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), baseUrl: z.string().max(2048), searchProfile: z.enum(eligibleSearchProfileIds() as [string, ...string[]]).optional(),
    // Both off by default. A page without a self link may be judged by its records, and a
    // continuation may carry one operator-named opaque token (never a known search or result parameter name).
    selfLinkOptional: z.boolean().optional(), continuationTokenParameter: z.union([z.literal(''), z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)]).optional(), auth: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('client_credentials'), tokenUrl: z.string().max(2048), clientId: z.string().min(1).max(256), clientSecretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128), scopes: z.array(z.string().min(1).max(128)).max(20).optional() }),
      // SMART Backend Services: exactly one key source (an environment variable name or an absolute file path), never the key itself.
      z.strictObject({ type: z.literal('smart_backend_services'), clientId: z.string().min(1).max(256), keyId: z.string().min(1).max(256),
        privateKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128).optional(), privateKeyFile: z.string().min(1).max(4096).optional(),
        scopes: z.array(z.string().min(1).max(128)).min(1).max(64).optional(), scopeSyntax: z.enum(['v1', 'v2']).optional(),
        endpoints: z.strictObject({ token: z.string().max(2048).optional() }).optional() })
        .refine(auth => (auth.privateKeyEnv === undefined) !== (auth.privateKeyFile === undefined)),
      // SMART standalone patient launch: a public client by default; a private_key_jwt client names exactly one key source.
      z.strictObject({ type: z.literal('smart_standalone_launch'), clientId: z.string().min(1).max(256), clientAuth: z.enum(['public', 'private_key_jwt']).optional(),
        keyId: z.string().min(1).max(256).optional(), privateKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128).optional(), privateKeyFile: z.string().min(1).max(4096).optional(),
        redirectPort: z.number().int().min(0).max(65535).optional(), offlineAccess: z.boolean().optional(), tokenFile: z.string().min(1).max(4096).optional(),
        scopes: z.array(z.string().min(1).max(128)).min(1).max(64).optional(), scopeSyntax: z.enum(['v1', 'v2']).optional(),
        endpoints: z.strictObject({ authorization: z.string().max(2048).optional(), token: z.string().max(2048).optional() }).optional() })
        .refine(auth => (auth.clientAuth ?? 'public') === 'public'
          ? auth.keyId === undefined && auth.privateKeyEnv === undefined && auth.privateKeyFile === undefined
          : auth.keyId !== undefined && (auth.privateKeyEnv === undefined) !== (auth.privateKeyFile === undefined)),
    ]).optional() }),
  patientId: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/).refine(id => !['.', '..'].includes(id)),
  privacy: z.strictObject({ patientIdentifierSystems: z.array(z.string().min(1).max(256).refine(value => value === value.trim() && !/[\x00-\x20\x7f]/.test(value) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && URL.canParse(value))).max(32).optional(),
    // Operator-listed product identifier systems a shared record (Medication) may carry; empty by default.
    sharedIdentifierSystems: z.array(z.string().min(1).max(256).refine(safeSharedIdentifierSystem)).max(32).optional(),
    // Operator-listed meta.profile canonicals a shared record may declare; empty by default.
    sharedProfiles: z.array(z.string().min(1).max(256).refine(safeSharedProfile)).max(32).optional() }).optional(),
  // An escape-free charset, so JSON encoding can never grow the handle past its accounted size.
  contextId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/).optional(),
  textMode: z.enum(['envelope', 'summary']).optional(),
  workflow: z.literal('recent-labs-v1').optional(),
  delivery: z.strictObject({ profile: z.enum(['full-text-v1', 'structured-evidence-v1']).optional(), hostProfileId: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/).optional() }).optional(),
  discovery: z.strictObject({ metadataTtlMs: z.number().int().min(1).max(900000).optional(), snapshotBytes: z.number().int().min(4096).max(2097152).optional(), maxHandles: z.number().int().min(1).max(128).optional() }).optional(),
  limits: z.strictObject({
    // Configured workflow minima; the per-call output.max_bytes floor stays 4096.
    defaultBytes: z.number().int().min(8192).max(131072).optional(), maxBytes: z.number().int().min(8192).max(131072).optional(),
    upstreamBytes: z.number().int().min(256).max(20 * 1024 * 1024).optional(), retentionBytes: z.number().int().min(256).max(100 * 1024 * 1024).optional(),
    ttlMs: z.number().int().min(1).max(15 * 60 * 1000).optional(), timeoutMs: z.number().int().min(1).max(30000).optional(), maxHandles: z.number().int().min(1).max(1000).optional(),
    deadlineMs: z.number().int().min(1).max(200000).optional(), maxQueue: z.number().int().min(0).max(256).optional(),
  }).optional(),
}).superRefine((cfg, ctx) => {
  // A deployment cannot expose a default below its viable floor or above its ceiling.
  if (cfg.limits?.defaultBytes !== undefined && cfg.limits?.maxBytes !== undefined && cfg.limits.defaultBytes > cfg.limits.maxBytes) ctx.addIssue({ code: 'custom', message: 'defaultBytes must not exceed maxBytes' });
  if (cfg.delivery?.profile === 'structured-evidence-v1' && !cfg.delivery.hostProfileId) ctx.addIssue({ code: 'custom', message: 'structured-evidence-v1 requires hostProfileId' });
  // A shared identifier system is never a patient or well-known person identifier system, and is listed once.
  const sharedSystems = cfg.privacy?.sharedIdentifierSystems ?? [];
  if (new Set(sharedSystems).size !== sharedSystems.length) ctx.addIssue({ code: 'custom', message: 'sharedIdentifierSystems must not repeat a system' });
  if (sharedSystems.some(system => (cfg.privacy?.patientIdentifierSystems ?? []).some(patient => identifierSystemsOverlap(system, patient)))) ctx.addIssue({ code: 'custom', message: 'sharedIdentifierSystems must not overlap patientIdentifierSystems' });
  if (sharedSystems.some(personIdentifierSystem)) ctx.addIssue({ code: 'custom', message: 'sharedIdentifierSystems must not list a person identifier system' });
  const sharedProfiles = cfg.privacy?.sharedProfiles ?? [];
  if (new Set(sharedProfiles).size !== sharedProfiles.length) ctx.addIssue({ code: 'custom', message: 'sharedProfiles must not repeat a profile' });
  if (cfg.source.continuationTokenParameter && isKnownParameterName(cfg.source.continuationTokenParameter)) ctx.addIssue({ code: 'custom', message: 'continuationTokenParameter must not be a known search or result parameter' });
});

type QueryPair = { name: string; value: string };
/**
 * Constraints the gateway itself enforces on every delivered record (patient confinement via `authorized()`),
 * as opposed to constraints the source merely claims in a self link. Only these may be reported as executed.
 */
function enforcedConstraints(type: string, query: QueryPair[]): QueryPair[] {
  if (type === 'Patient') return query.filter(pair => pair.name === '_id');
  if (resourceClass(type) !== 'patient') return [];
  const confinement = query.some(pair => pair.name === 'patient') ? 'patient' : 'subject';
  return query.filter(pair => pair.name === confinement);
}
interface OutcomeIssue { severity?: string; code?: string; diagnostics?: string; expression?: string[] }
const REGEX_SPECIALS = new Set('.*+?^${}()|[]\\'.split(''));
const escapeRegExp = (text: string): string => [...text].map(char => REGEX_SPECIALS.has(char) ? `\\${char}` : char).join('');
/** Query parameter names an OperationOutcome issue implicates by free text (code/expression/diagnostics). Warning/information severity only: free text never downgrades an error. */
function filterRelatedNames(issue: OutcomeIssue, query: QueryPair[]): string[] {
  const text = [issue.code ?? '', issue.diagnostics ?? '', ...(Array.isArray(issue.expression) ? issue.expression : [])].join(' ');
  const names = [...new Set(query.map(pair => pair.name))];
  const mentioned = names.filter(name => new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(name)}([^A-Za-z0-9_-]|$)`).test(text));
  if (mentioned.length) return mentioned;
  // An unspecified not-supported complaint from a search outcome is about some requested parameter.
  return issue.code === 'not-supported' ? names : [];
}
/** Query parameter names implicated by the structured `issue.expression` only (last path segment), never free text. */
function expressedNames(issue: OutcomeIssue, query: QueryPair[]): string[] {
  const names = new Set(query.map(pair => pair.name));
  const related = new Set<string>();
  for (const expression of Array.isArray(issue.expression) ? issue.expression : []) {
    if (typeof expression !== 'string') continue;
    const segment = expression.split('.').at(-1)?.replace(/\[\d+\]$/, '');
    if (segment && names.has(segment)) related.add(segment);
  }
  return [...related];
}
const FILTER_CLASS_CODES = new Set(['not-supported', 'value', 'invalid', 'structure', 'required', 'invariant', 'code-invalid']);
const EXECUTION_FAILURE_CODES = new Set(['exception', 'timeout', 'incomplete', 'too-costly', 'throttled', 'transient', 'lock-error', 'no-store']);
const INCOMPLETENESS_CODES = new Set(['incomplete', 'too-costly', 'suppressed', 'throttled', 'timeout', 'transient', 'exception']);
/** FHIR IssueType vocabulary (R4): the only outcome codes ever surfaced publicly, so diagnostics text cannot leak through a code field. */
const ISSUE_TYPE_CODES = new Set(['invalid', 'structure', 'required', 'value', 'invariant', 'security', 'login', 'unknown', 'expired', 'forbidden', 'suppressed', 'processing', 'not-supported', 'duplicate', 'multiple-matches', 'not-found', 'deleted', 'too-long', 'code-invalid', 'extension', 'too-costly', 'business-rule', 'conflict', 'transient', 'lock-error', 'no-store', 'exception', 'timeout', 'incomplete', 'throttled', 'informational']);
interface OutcomeClassification { unverifiedFilters: string[]; sourceIncomplete: boolean; outcomeCodes: string[] }
/**
 * Classify searchset OperationOutcome issues. Error and fatal issues fail the query closed unless the
 * code is filter-class and the implicated filters come from the structured `expression` (a bare `not-supported`
 * still unverifies every filter); execution-failure codes always fail at error severity. Free-text mentions of
 * parameter names (the injected `patient` matches almost any diagnostics prose) may only label filters unverified
 * at warning/information severity. Warning/information incompleteness codes mark the page source-incomplete;
 * `processing` (the Epic 4101 empty-result shape) stays a plain success; any other vocabulary code is surfaced
 * sanitized as SOURCE_OUTCOME. Diagnostics text is never copied out.
 */
function classifyOutcomeIssues(issues: OutcomeIssue[], query: QueryPair[]): OutcomeClassification {
  const unverified = new Set<string>();
  const outcomeCodes = new Set<string>();
  let sourceIncomplete = false;
  for (const issue of issues) {
    const code = typeof issue.code === 'string' ? issue.code : undefined;
    if (issue.severity === 'fatal' || issue.severity === 'error') {
      if (code !== undefined && EXECUTION_FAILURE_CODES.has(code)) throw new GatewayFault('UNVERIFIED_QUERY', 'Source returned a warning/error outcome; query completeness cannot be verified.');
      if (code !== undefined && FILTER_CLASS_CODES.has(code)) {
        const expressed = expressedNames(issue, query);
        if (expressed.length) { expressed.forEach(name => unverified.add(name)); continue; }
        const hasExpression = Array.isArray(issue.expression) && issue.expression.some(entry => typeof entry === 'string' && entry.length > 0);
        if (code === 'not-supported' && !hasExpression) { query.forEach(pair => unverified.add(pair.name)); continue; }
      }
      throw new GatewayFault('UNVERIFIED_QUERY', 'Source returned a warning/error outcome; query completeness cannot be verified.');
    }
    if (code !== undefined && INCOMPLETENESS_CODES.has(code)) sourceIncomplete = true;
    const related = filterRelatedNames(issue, query);
    related.forEach(name => unverified.add(name));
    // Codes that neither implicate a filter nor report incompleteness still surface, sanitized to the vocabulary.
    if (!related.length && !(code !== undefined && INCOMPLETENESS_CODES.has(code)) && code !== undefined && code !== 'processing' && ISSUE_TYPE_CODES.has(code)) outcomeCodes.add(code);
  }
  return { unverifiedFilters: [...unverified], sourceIncomplete, outcomeCodes: [...outcomeCodes].sort() };
}
/** Direct-read faults that arise before patient linkage can be established; publicly indistinguishable from absence. */
/** Own-record keys remembered per context for reference-target admission, and the reachable
 * directory keys, in one bounded ledger (docs/LIMITS.md). */
const VERIFIED_TARGET_CAPACITY = 2048;
const PRE_AUTHORIZATION_READ_CODES = new Set(['INVALID_RESPONSE', 'UPSTREAM_LIMIT', 'UNSUPPORTED_PRECISION', 'UNSUPPORTED_CONTENT']);
function nonDisclosingReadFault(fault: GatewayFault): GatewayFault {
  const cause = fault.status !== undefined ? `${fault.code}:${fault.status}` : fault.code;
  return new GatewayFault('NOT_FOUND', 'Requested resource is not available.', false, fault.status, cause);
}

export class FhirGateway {
  readonly auditEvents: AuditEvent[] = [];
  private readonly config: GatewayConfig;
  private readonly transport: FhirTransport;
  private readonly store: ResultStore<Snapshot>;
  private readonly retentionLedger: RetentionLedger;
  /** Own records already authorized in this state generation; the only evidence a patient-linked reference target may rest on. */
  private readonly verifiedTargets = new VerifiedTargetLedger(VERIFIED_TARGET_CAPACITY);
  /** Directory keys granted by the records a rendered envelope delivers; added to the ledger only when that envelope commits. */
  private readonly pendingReachable = new WeakMap<GatewayEnvelope02, readonly DirectoryKey[]>();
  private readonly discoveryStore: ResultStore<DiscoverySnapshotValue>;
  private readonly credentials?: TokenProvider;
  private readonly candidateWorkV2 = new AsyncLocalStorage<{ authCalls: number; metadataCalls: number; clinicalCalls: number; upstreamCalls: number; limitReached?: boolean; redactionSelfCheckFailed?: boolean }>();
  private authEpoch = 0;
  private readonly contextId: string;
  private readonly maxBytes: number;
  private readonly defaultBytes: number;
  private readonly operatorPolicy: Readonly<{ defaultFormat: 'fhir'; delivery: 'full-text-v1' | 'structured-evidence-v1'; defaultBytes: number; maxBytes: number; ttlMs: number; retentionBytes: number }>;
  private capabilities?: Map<string, ResourceCapability>;
  private metadataLoading?: { epoch: number; generation: number; promise: Promise<number> };
  private metadataExpiresAt = 0;
  private readonly policyRevision = 'synthetic-v3';
  private capabilityPolicyRevision?: string;
  private sourceIdentity: CapabilitySourceIdentity = {};
  private stateGeneration = 0;
  private fhirVersion = 'unknown';
  private capabilityRevision = 'unknown';
  private active = 0;
  private closed = false;
  /** Shared page loads: each flight runs on its own controller/timeout; waiters race their own budgets. */
  private readonly pageLoads = new Map<string, { controller: AbortController; promise: Promise<void>; waiters: number }>();
  /** Cursors served by active fhir_page calls, counted per call from entry until the render finishes. Never evicted. */
  private readonly servingCursors = new Map<string, number>();
  /** Handles stored while building an envelope: released again if the request fails before delivery. */
  private readonly reserved = new WeakMap<GatewayEnvelope, string[]>();
  /** Immutable per-call delivery context per in-flight envelope: era+profile fixed at execute entry. */
  private readonly waiters: { resolve: () => void; reject: (e: GatewayFault) => void; transferred?: boolean }[] = [];
  readonly textMode: 'envelope' | 'summary';
  /** Configured delivery profile for every call on this gateway (the adapter forwards it to toToolResult). */
  readonly deliveryProfile: 'full-text-v1' | 'structured-evidence-v1';

  private readonly testOptions?: PrivateGatewayTestOptions;
  private readonly profileState: ProfileState;
  private readonly capturesV2 = new WeakMap<GatewayEnvelope02, ValidationContext02>();
  constructor(config: GatewayConfig, testOptions?: PrivateGatewayTestOptions) {
    this.testOptions = testOptions;
    this.profileState = new ProfileState();
    this.installQueryCandidate(testOptions?.testQueryProfile);
    // Without ES2025 JSON source text, number lexemes cannot be preserved; refuse to serve at all.
    try { assertLosslessJsonRuntime(); } catch (error) { throw new GatewayFault('INVALID_CONFIG', (error as Error).message); }
    // Migration: the removed constructor era key gets a named migration message, not a generic refusal.
    if (config && typeof config === 'object' && 'protocolEra' in (config as unknown as Record<string, unknown>)) {
      throw new GatewayFault('INVALID_CONFIG', 'GatewayConfig.protocolEra was removed; pass era per call via ExecuteOptions.era (adapter calls) instead.');
    }
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new GatewayFault('INVALID_CONFIG', 'Invalid synthetic gateway configuration.');
    this.config = parsed.data;
    this.contextId = config.contextId ?? `ctx_${randomUUID()}`;
    this.maxBytes = config.limits?.maxBytes ?? 131072;
    this.defaultBytes = Math.min(config.limits?.defaultBytes ?? 49152, this.maxBytes);
    // One caller-wide retention ledger; the discovery store registers as a subquota of it.
    const retentionBytes = config.limits?.retentionBytes ?? 10 * 1024 * 1024;
    const ttlMs = config.limits?.ttlMs ?? 15 * 60 * 1000;
    this.retentionLedger = new RetentionLedger(retentionBytes);
    // A full quota evicts res_ first, then the oldest cursor, instead of refusing
    // every later call. A cursor that an active fhir_page call is serving is never evicted; that covers an
    // in-flight page load, which lives only while a call waits on it. An evicted cursor reads as expired.
    this.store = new ResultStore(retentionBytes, config.limits?.maxHandles ?? 128, ttlMs, Date.now, { ledger: this.retentionLedger, role: 'clinical', sharedFields: ['query', 'queryEvidence'],
      evictableKinds: ['res', 'cur'], protectedHandles: handle => this.servingCursors.has(handle) });
    this.discoveryStore = createDiscoveryStore({ ledger: this.retentionLedger, snapshotBytes: config.discovery?.snapshotBytes, maxHandles: config.discovery?.maxHandles, ttlMs: config.discovery?.metadataTtlMs });
    // Structured delivery stays unreachable without a verified host profile.
    // Era is per call; construction validates against the conservative modern default.
    if (this.config.delivery?.profile === 'structured-evidence-v1') {
      try { resolveDeliveryProfile(this.config.delivery, 'modern', testOptions?.testDeliveryRegistryOverride); }
      catch { throw new GatewayFault('UNVERIFIED_HOST_PROFILE', 'Structured delivery requires a verified host profile; use full-text-v1.'); }
    }
    // Unconditional: summary text mode always fails INVALID_CONFIG;
    // envelope + structured-evidence-v1 always conflicts (no exemption).
    try { assertSummaryAllowed(this.config, testOptions?.testDeliveryRegistryOverride); }
    catch (error) { throw new GatewayFault('INVALID_CONFIG', (error as Error).message); }
    this.textMode = config.textMode ?? 'envelope';
    this.deliveryProfile = this.config.delivery?.profile ?? 'full-text-v1';
    this.operatorPolicy = Object.freeze({ defaultFormat: 'fhir', delivery: this.deliveryProfile, defaultBytes: this.defaultBytes, maxBytes: this.maxBytes, ttlMs, retentionBytes });
    // A changed SMART grant starts a new authorization epoch: results retained under the old grant are dropped.
    if (this.config.source.auth) this.credentials = createCredentialProvider(this.config.source.baseUrl, this.config.source.auth, { timeoutMs: config.limits?.timeoutMs, onRequest: () => { this.reserveUpstreamWorkV2(); const work = this.candidateWorkV2.getStore(); if (work) work.authCalls++; },
      patientId: this.config.patientId, servedTypes: classifiedTypes().filter(type => !UNSUPPORTED_CLINICAL_RESOURCES.has(type)), alias: this.config.source.alias,
      onGrantChanged: () => { this.authEpoch++; this.invalidateState(); } });
    this.transport = new FhirTransport(config.source.baseUrl, config.limits?.upstreamBytes ?? 5 * 1024 * 1024, config.limits?.timeoutMs ?? 10000, this.credentials ? {
      authorizationFor: (url, budget) => this.authorizationFor(url, budget),
      allows: (type, interaction) => this.credentials!.allows(type, interaction),
      authorizationWithGeneration: async (url, budget) => {
        try { return await this.credentials!.authorizationWithGeneration(url, budget); }
        catch (error) { throw this.credentialFault(error); }
      },
      // Only a 401 or validated invalid_token invalidates, and only the generation that made the
      // rejected request. A plain (even metadata) 403 changes no state; a late rejection of a superseded
      // generation cannot wipe a fresh token's retained results or discovery. That superseded case is
      // reported back so the transport can label the fault retryable.
      onRejected: info => {
        if (!invalidatesCredential(info)) return false;
        if (this.credentials!.invalidate(info?.generation)) { this.authEpoch++; this.invalidateState(); return false; }
        return info?.generation !== undefined;
      },
    } : undefined);
    for (const era of ['modern', 'legacy'] as const) for (const profile of ['full-text-v1', 'structured-evidence-v1'] as const) {
      const delivery = { era, profile, serverIdentity: SERVER_IDENTITY };
      const { env: emergency, capture } = this.emergencyDeliveryV2('fhir_search', 4096, 0, 0, delivery, undefined, this.invocationV2(undefined, 4096), 'ctor-v2-emergency');
      this.testOptions?.testEnvelopeCorruptor?.(emergency, 'construction');
      if (!validateDeliverable02('fhir_search', toWireValue(emergency), capture).ok) {
        throw new GatewayFault('INVALID_CONFIG', 'Emergency error template does not satisfy the strict envelope contract.');
      }
    }
  }
  /** One invalidation boundary for metadata, credentials and shutdown. Auth epochs remain caller-owned. */
  private invalidateState(): void {
    this.stateGeneration++;
    this.store.clear();
    this.verifiedTargets.clear();
    this.discoveryStore.clear();
    this.capabilities = undefined;
    this.metadataExpiresAt = 0;
    // Flights keep their starting generation. Discovery will start a fresh flight instead of
    // joining one from before this boundary; late cleanup is checked by flight identity.
  }
  close(): void {
    this.closed = true; this.authEpoch++; this.invalidateState(); this.credentials?.close(); this.store.close(); this.discoveryStore.close();
    // Closing aborts every in-flight shared page load so its upstream socket does not linger.
    for (const flight of this.pageLoads.values()) flight.controller.abort();
    this.pageLoads.clear();
    for (const waiter of this.waiters.splice(0)) waiter.reject(new GatewayFault('GATEWAY_CLOSED', 'Gateway is closed.'));
  }
  private credentialFault(error: unknown): GatewayFault {
    // The token provider normalizes transport size faults. Our pre-send work
    // refusal is local admission, not evidence that a credential failed.
    if (error instanceof LocalWorkRefusal) return new GatewayFault('UPSTREAM_LIMIT', error.message);
    // Superseded-flight, closed-provider, caller-cancellation and token-timeout faults prove nothing
    // about the current grant, so they never re-invalidate or epoch-bump shared state. Epoch-race faults are
    // retryable; the provider already retries a superseded flight once before surfacing CREDENTIAL_INVALIDATED.
    const code = error instanceof CredentialFault ? error.code : undefined;
    if (code && ['CREDENTIAL_INVALIDATED', 'PROVIDER_CLOSED', 'REQUEST_CANCELLED', 'TOKEN_TIMEOUT'].includes(code)) {
      return new GatewayFault(code, (error as Error).message, code === 'CREDENTIAL_INVALIDATED' ? true : (error as CredentialFault).retryable);
    }
    // A transient token-endpoint fault (429/5xx/network, an already-expired token) is retryable and
    // proves nothing about the grant, so retained handles and discovery survive it. Only non-retryable
    // credential faults (endpoint 400/401/403, unavailable secret, invalid/oversized/redirected response)
    // invalidate the generation and its retained state.
    if (error instanceof CredentialFault && error.retryable) return new GatewayFault(error.code, error.message, true);
    if (this.credentials!.invalidate()) { this.authEpoch++; this.invalidateState(); }
    if (error instanceof CredentialFault) return new GatewayFault(error.code, error.message, error.retryable);
    return new GatewayFault('CONNECTION_REQUIRED', 'The configured source connection is unavailable.');
  }
  private async authorizationFor(url: URL, budget?: RequestBudget): Promise<string> {
    try { return await this.credentials!.authorizationFor(url, budget); }
    catch (error) { throw this.credentialFault(error); }
  }

  /** Bounded fair admission: FIFO queue; each waiter races its own signal/deadline. */
  private async admit(budget: RequestBudget): Promise<void> {
    if (this.active < 4) { this.active++; return; }
    const maxQueue = this.config.limits?.maxQueue ?? 16;
    if (this.waiters.length >= maxQueue) throw new GatewayFault('RATE_LIMITED', 'Local gateway admission queue is full.', true);
    let transferred = false;
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve: () => { cleanup(); resolve(); }, reject: (e: GatewayFault) => { cleanup(); reject(e); }, set transferred(v: boolean) { transferred = v; }, get transferred() { return transferred; } };
      const onAbort = () => { const i = this.waiters.indexOf(waiter); if (i >= 0) this.waiters.splice(i, 1); waiter.reject(new GatewayFault('REQUEST_CANCELLED', 'The request was cancelled.')); };
      const remaining = budget.deadline === undefined ? undefined : budget.deadline - Date.now();
      const timer = remaining === undefined ? undefined : setTimeout(() => { const i = this.waiters.indexOf(waiter); if (i >= 0) this.waiters.splice(i, 1); waiter.reject(new GatewayFault('UPSTREAM_TIMEOUT', 'The request deadline was reached while queued.', true)); }, Math.max(remaining, 0));
      const cleanup = () => { budget.signal?.removeEventListener('abort', onAbort); if (timer) clearTimeout(timer); };
      if (budget.signal?.aborted) { waiter.reject(new GatewayFault('REQUEST_CANCELLED', 'The request was cancelled.')); return; }
      budget.signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
    if (!transferred) this.active++;
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) { next.transferred = true; next.resolve(); } else this.active--;
  }
  private throwIfCancelled(budget: RequestBudget): void {
    if (budget.signal?.aborted) throw new GatewayFault('REQUEST_CANCELLED', 'The request was cancelled.');
    // A request whose credential generation was superseded mid-flight must not publish or retain
    // anything. render() calls this synchronously before any store write, so a stale request can neither
    // store its own handles nor evict a fresh generation's res_ handles.
    if (budget.epoch !== undefined && budget.epoch !== this.authEpoch) throw new GatewayFault('CONNECTION_REQUIRED', 'The source connection changed during this request; repeat it after reconnecting.', true);
    if (budget.stateGeneration !== undefined && budget.stateGeneration !== this.stateGeneration) throw new GatewayFault('CONNECTION_REQUIRED', 'The source state changed during this request; repeat it.', true);
    if (budget.deadline !== undefined && Date.now() >= budget.deadline) throw new GatewayFault('UPSTREAM_TIMEOUT', 'The request deadline was reached.', true);
  }

  private admitV2<T extends ToolName>(tool: T, unknownInput: unknown): Admission02<T> {
    if (!TOOL_NAMES.includes(tool)) throw new GatewayFault('UNKNOWN_TOOL', 'Tool is not implemented in this prototype.');
    const admission = admitArguments(unknownInput);
    if (!admission.ok) throw new GatewayFault(admission.code, 'Tool arguments failed admission.');
    const ownKeys = Object.freeze(unknownInput && typeof unknownInput === 'object' ? Object.getOwnPropertyNames(unknownInput) : []);
    const parsed = toolInputV2Schemas[tool].safeParse(unknownInput);
    if (!parsed.success) {
      const raw = unknownInput as Record<string, unknown>;
      const output = raw?.output as Record<string, unknown> | undefined;
      const invalidEnum = (value: unknown, values: readonly string[]) => value !== undefined && !values.includes(value as string);
      const message = invalidEnum(output?.format, ['compact', 'fhir']) ? REFUSAL_MESSAGES.invalid_format
        : tool === 'fhir_capabilities' && invalidEnum(raw?.topic, ['server', 'resource', 'context', 'schema', 'search_parameter', 'support']) ? REFUSAL_MESSAGES.invalid_topic
        : tool === 'fhir_read' && invalidEnum(raw?.interaction, ['read']) ? REFUSAL_MESSAGES.invalid_interaction
        : tool === 'fhir_result' && invalidEnum(raw?.action, ['inspect', 'project', 'page']) ? REFUSAL_MESSAGES.invalid_action
        : 'Invalid tool arguments; use the declared tool schema.';
      throw new GatewayFault('INVALID_ARGUMENTS', message!);
    }
    const input = parsed.data as Input<T>;
    if (tool === 'fhir_capabilities') {
      const caps = input as Input<'fhir_capabilities'>;
      if (capabilitiesCombinationFault(caps)) throw new GatewayFault('INVALID_ARGUMENTS', 'Invalid capabilities argument combination.');
      // Defaults erase explicit path:''/offset:0 presence. Continuations accept
      // only this allowlist; even a matching source/filter is a changed selector.
      if (caps.cursor !== undefined && ownKeys.some(key => !['topic', 'cursor', 'context_handle', 'limit', 'output'].includes(key))) {
        throw new GatewayFault('INVALID_ARGUMENTS', 'A discovery continuation accepts only topic, cursor, context_handle, limit and output.');
      }
    }
    let fields = input.output?.fields;
    if (tool === 'fhir_result') {
      const retained = input as Input<'fhir_result'>;
      const top = retained.fields, nested = retained.output?.fields;
      if (top && nested && JSON.stringify(top) !== JSON.stringify(nested)) throw new GatewayFault('INVALID_ARGUMENTS', 'Conflicting retained field selections.');
      if (retained.action === 'inspect' && (top || nested)) throw new GatewayFault('INVALID_ARGUMENTS', 'Inspection does not accept fields.');
      fields = top ?? nested;
    }
    const requestedFormat = input.output?.format;
    return { input, ownKeys, format: requestedFormat ?? 'fhir',
      ...(requestedFormat !== undefined ? { requestedFormat } : {}), ...(fields ? { fields: [...fields] } : {}) };
  }

  /** Reviewed-name checks for repair advice. Repair code receives names and never imports the query layer. */
  private reviewedNamesV2() {
    const resolved = new Map<string, ResolvedSearchParameters>();
    for (const [type, capability] of this.capabilities ?? []) {
      if (capability.ambiguous || resourceClass(type) === 'ambiguous' || UNSUPPORTED_CLINICAL_RESOURCES.has(type)) continue;
      const parameters = resolveSearchParameters({ resourceType: type, declared: capability.declared, advertised: true });
      if (parameters) resolved.set(type, parameters);
    }
    return reviewedNamesFor(resolved, new Set(this.capabilities?.keys() ?? []));
  }

  /** Identify the syntax validator's first refusing pair without changing the
   * query. Advice names only the base accepted by the reviewed-name interface. */
  private repairParameterV2(code: string, admission?: Admission02): string | undefined {
    if (!admission || !('params' in admission.input) || !['UNSUPPORTED_MODIFIER', 'UNSUPPORTED_COMPARATOR'].includes(code)) return undefined;
    const input = admission.input as Input<'fhir_search'>;
    const capability = this.capabilities?.get(input.resource_type);
    if (!capability) return undefined;
    const resolved = resolveSearchParameters({ resourceType: input.resource_type, declared: capability.declared, advertised: true });
    for (let length = 1; length <= input.params.length; length++) {
      try { validateSearchSyntax({ resourceType: input.resource_type, pairs: input.params.slice(0, length).filter(pair => pair.name !== '_sort'), resolved,
        withheldNamesPresent: (capability.withheldNameCount ?? 0) > 0 }); }
      catch (error) {
        const base = input.params[length - 1]!.name.split(':')[0]!;
        return error instanceof GatewayFault && error.code === code && this.reviewedNamesV2().parameter(input.resource_type, base) ? base : undefined;
      }
    }
    return undefined;
  }

  /** Canonicalize at the candidate boundary, including source/fixture variants.
   * Unknown warning codes fail closed; no source prose survives this boundary. */
  private warningsV2(warnings: GatewayEnvelope02['warnings']): GatewayEnvelope02['warnings'] {
    const result = new Map<string, GatewayEnvelope02['warnings'][number]>();
    if (this.testOptions) {
      warnings = [...warnings,
        ...(this.testOptions?.testEnvelopeCorruptor ? [{ ...TEST_CORRUPTOR_WARNING }] : []),
        ...(this.testOptions?.testDeliveryRegistryOverride ? [{ ...UNVERIFIED_DELIVERY_WARNING }] : []),
        ...(this.testOptions?.testQueryProfile ? [{ ...TEST_QUERY_WARNING }] : [])];
    }
    for (const warning of warnings) {
      const base = WARNING_MESSAGES[warning.code];
      if (!Object.hasOwn(WARNING_MESSAGES, warning.code) || !base) throw new GatewayFault('INTERNAL_ERROR', 'Unable to complete the bounded request.');
      const message = warning.code === 'NO_MATCHES' && warning.message === base + NO_MATCHES_UNVERIFIED_SUFFIX
        ? base + NO_MATCHES_UNVERIFIED_SUFFIX : base;
      const repair = warning.code === 'NO_MATCHES' && warning.repair
        ? warning.repair.action === 'inspect_observed_codes' && OBSERVED_CODE_FIELDS[warning.repair.resource_type ?? '']
          && this.reviewedNamesV2().resource(warning.repair.resource_type ?? '') && this.reviewedNamesV2().parameter(warning.repair.resource_type ?? '', 'code')
          // Eligibility (including the original window) belongs to coverageV2.
          // This boundary only compares the already-built advice to fixed text.
          ? { action: 'inspect_observed_codes' as const, tool: 'fhir_search' as const, resource_type: warning.repair.resource_type,
            fields: [OBSERVED_CODE_FIELDS[warning.repair.resource_type!]!], page_size: 100, max_pages: 3, max_calls: 4 }
          : repairForNoMatches(warning.repair.resource_type ?? '', this.reviewedNamesV2()) : undefined;
      result.set(warning.code, { code: warning.code, message,
        ...(repair && JSON.stringify(repair) === JSON.stringify(warning.repair) ? { repair } : {}) });
    }
    if (result.size > 32) throw new GatewayFault('OUTPUT_LIMIT', 'Result carries too many distinct warnings.');
    return [...result.values()];
  }

  /** Fixed candidate refusals. Work counters are trusted, never request fields.
   * The pre-send wording requires zero TOTAL work, including auth/metadata. */
  private refusalV2(tool: ToolName, kind: keyof typeof REFUSAL_MESSAGES, work: { upstreamCalls: number; clinicalCalls: number },
    admission?: Admission02, meta?: { resource_type?: string; parameter?: string }): GatewayEnvelope02 {
    if (kind === 'unsupported_modifier' && work.clinicalCalls !== 0) throw new GatewayFault('INTERNAL_ERROR', 'Unable to complete the bounded request.');
    const code = kind === 'expired_result' ? 'RESULT_EXPIRED' : kind === 'unsupported_modifier' ? 'UNSUPPORTED_MODIFIER' : 'INVALID_ARGUMENTS';
    const env = this.errorV2(tool, { code, retryable: false }, admission);
    env.error!.safe_message = kind === 'unsupported_modifier' && work.upstreamCalls !== 0 ? MODIFIER_NO_CLINICAL_MESSAGE : REFUSAL_MESSAGES[kind]!;
    env.budget.upstream_calls = work.upstreamCalls;
    const repair = repairForFault(code, { ...meta, allowed_max_bytes: this.maxBytes, current_max_bytes: env.budget.byte_limit }, this.reviewedNamesV2());
    if (repair) env.error!.repair = repair;
    return env;
  }

  /** Pure coverage assembly over the immutable query identity and sticky overlay.
   * Never writes shorthand back to the backing evidence or advances counters.
   * Call after packing; previousEvidence is the preceding delivery, not self links. */
  private coverageV2(snapshot: Snapshot, call: CoverageAssembly02): Pick<EnvelopeBody02, 'coverage' | 'warnings'> & { evidence?: QueryEvidence } {
    const retained = call.tool === 'fhir_result', read = call.tool === 'fhir_read';
    const resourceOrigin = read || (retained && !snapshot.queryEvidence);
    const evidence = (read ? undefined : this.currentQueryEvidence(snapshot)) ?? {
      constraints: [], materialFilterProved: resourceOrigin, evidenceKind: resourceOrigin ? 'exact_id_and_subject_linkage' as const : 'unverified_continuation' as const,
    };
    if (!resourceOrigin && snapshot.unverifiedFilters?.length) evidence.materialFilterProved = false;
    const overlay = snapshot.queryOverlay;
    const reasons = [...new Set([...(overlay?.refusalReasons ?? []), ...(snapshot.partialReasons ?? []), ...(call.reasons ?? []),
      ...(snapshot.precisionRefused ? ['UNSUPPORTED_PRECISION'] : []),
      ...(snapshot.sourceIncomplete ? ['SOURCE_REPORTED_INCOMPLETE'] : []),
      ...(snapshot.outcomeCodes?.length ? ['SOURCE_OUTCOME'] : []),
      ...(snapshot.unverifiedFilters?.length ? ['FILTER_EXECUTION_UNVERIFIED'] : []),
      ...(call.capped ? ['OUTPUT_LIMIT'] : [])])];
    if (!resourceOrigin && reasons.includes('FILTER_EXECUTION_UNVERIFIED')) evidence.materialFilterProved = false;
    const nonContinuable = Boolean(snapshot.nonContinuable || overlay?.nonContinuable);
    // Only reviewed informational reasons may accompany a complete delivery.
    const informationalReasons = ['SOURCE_OUTCOME', 'FILTER_EXECUTION_UNVERIFIED'];
    const refused = Boolean(call.refused || call.capped || overlay?.refused || snapshot.precisionRefused || snapshot.sourceIncomplete || snapshot.partialReasons?.length || reasons.some(reason => !informationalReasons.includes(reason)));
    const unverifiedContinuation = !resourceOrigin && snapshot.queryEvidenceKind === 'unverified_continuation';
    const remainder: QueryChainView['remainder'] = call.localRemainder ? 'local' : snapshot.nextUrl ? 'upstream'
      : nonContinuable ? 'rejected_link' : unverifiedContinuation || call.unknownContinuation || snapshot.sourceIncomplete ? 'unknown' : 'none';
    const chain: QueryChainView = { deliveredCount: (overlay?.deliveredCount ?? 0) + call.deliveredCount,
      pagesObserved: read ? 1 : overlay?.pagesObserved ?? 1, queryEvidence: evidence, sortProof: overlay?.sortProof ?? 'none',
      remainder, exhausted: !refused && remainder === 'none', scope: retained ? 'retained' : read ? 'resource' : 'page',
      authorizationLimited: true, nonContinuable, refused, refusalReasons: reasons.length ? reasons : undefined };
    const changed = !call.previousEvidence || !isDeepStrictEqual(evidence, call.previousEvidence);
    const disclosed = call.tool === 'fhir_page' && !changed ? shorthandEvidence(evidence) : evidence;
    // Merge caller reasons outside the bounded coverage helper, so derived reasons
    // cannot be displaced by a full refusal list. The full union is capped below.
    const coverage = coverageForSnapshot(disclosed, { ...chain, refusalReasons: reasons.includes('SOURCE_REPORTED_INCOMPLETE') ? ['SOURCE_REPORTED_INCOMPLETE'] : reasons.length ? [] : undefined });
    // Declarations and self links cannot establish
    // completeness, even when a shared search has no material constraints.
    // Exhaustion is an independent observation and remains true when drained.
    if (coverage.state === 'complete_for_query' && coverage.query_evidence === 'declared_and_self_link_only') coverage.state = 'unknown';
    if (snapshot.queryEvidence && !read && (call.tool !== 'fhir_page' || changed)) {
      // Empty material sets still disclose the full identity on a first or
      // changed page; the helper's empty-constraints heuristic is not authority.
      coverage.constraints = evidence.constraints.map(entry => ({ ...entry }));
      delete coverage.constraints_on_first_page;
      if (coverage.sort && evidence.sort) coverage.sort.requested = [...evidence.sort.requested];
    }
    // The bounded coverage helper is not an excuse to silently lose material reasons.
    coverage.reasons = [...new Set([...coverage.reasons, ...reasons])];
    if (unverifiedContinuation && !retained) coverage.query_evidence = 'unverified_continuation';
    if (coverage.reasons.length > 32) throw new GatewayFault('OUTPUT_LIMIT', 'Coverage evidence exceeds the bounded envelope; narrow the query.');
    const warnings: GatewayEnvelope02['warnings'] = [];
    const add = (code: string) => warnings.push({ code, message: WARNING_MESSAGES[code]! });
    if (coverage.reasons.includes('FILTER_EXECUTION_UNVERIFIED')) add('FILTER_EXECUTION_UNVERIFIED');
    if (unverifiedContinuation) add('CONTINUATION_QUERY_UNVERIFIED');
    if (orderUnverified(evidence)) add('ORDER_UNVERIFIED');
    for (const code of ['UNSUPPORTED_PRECISION', 'SOURCE_REPORTED_INCOMPLETE', 'SOURCE_OUTCOME']) if (reasons.includes(code)) add(code);
    if (reasons.includes('RECORDS_WITHHELD_BY_POLICY')) add('RECORDS_WITHHELD_BY_POLICY');
    if (reasons.includes('SHARED_RECORDS_WITHHELD_BY_POLICY')) add('SHARED_RECORDS_WITHHELD_BY_POLICY');
    const noMatches = !retained && !read && !refused && !nonContinuable && (call.tool !== 'fhir_page' || Boolean(overlay)) && noMatchesEligible(coverage, chain.deliveredCount, evidence.constraints) ? noMatchesWarning({ resourceType: snapshot.type,
      deliveredCount: chain.deliveredCount, queryExhausted: coverage.query_exhausted, filtered: true,
      filterExecutionVerified: evidence.materialFilterProved,
      dateWindow: evidence.constraints.filter(entry => OBSERVED_CODE_DATE_PARAMETERS[snapshot.type]?.includes(entry.name)) }, this.reviewedNamesV2()) : undefined;
    if (noMatches) warnings.push(noMatches);
    return { coverage, warnings: this.warningsV2(warnings), ...(snapshot.queryEvidence && !read ? { evidence } : {}) };
  }

  /** Success envelope constructor: evidence comes from trusted handlers, not input.
   * Only assembly happens here; evidence, projection and final gating happen
   * later. Every mandatory v2 control has a fresh initial value. */
  private envelopeV2(tool: ToolName, body: EnvelopeBody02, admission?: Admission02,
    delivery: DeliveryContext = { era: 'modern', profile: 'full-text-v1' }): GatewayEnvelope02 {
    void tool; // Reserved for a per-tool final gate.
    const format = body.transform?.format ?? admission?.format ?? 'fhir';
    const { requested_format: _requestedFormat, ...transform } = body.transform ?? {};
    return { schema_version: M3B_SCHEMA_VERSION, request_id: randomUUID(), source: this.source(),
      context: { handle: this.contextId, mode: 'patient-bound', policy_revision: this.policyRevision },
      data: body.data, coverage: { ...body.coverage, reasons: [...body.coverage.reasons] },
      ...(body.provenance !== undefined ? { provenance: body.provenance } : {}),
      ...(body.pagination !== undefined ? { pagination: body.pagination } : {}),
      ...(body.result !== undefined ? { result: body.result } : {}),
      transform: { projected: false, withheld_payloads: [], omitted_fields: [], unresolved_fields: [],
        narrative_omitted: false, recipe_ids: [], structural_resource_indices: [], ...transform,
        format, ...(admission?.requestedFormat !== undefined ? { requested_format: admission.requestedFormat } : {}),
        delivery_profile: delivery.profile },
      warnings: this.warningsV2(body.warnings ?? []), budget: { bytes_returned: 0, byte_limit: Math.min(admission?.input.output?.max_bytes ?? this.defaultBytes, this.maxBytes),
        wire_bytes: 0, limit_reached: false, upstream_calls: 0, elapsed_ms: 0 } };
  }

  /** Metadata/error controls share the query layer's coverage decision table. No query or
   * records are inferred for these paths, and metadata never gets NO_MATCHES. */
  private controlCoverageV2(clinical: boolean, faultCode?: string): GatewayEnvelope02['coverage'] {
    // A failed call has no delivered query evidence. The snapshot decision table
    // adds success-path filter/metadata caveats that do not describe an error.
    if (faultCode) return { state: 'unknown', scope: clinical ? 'query' : 'metadata',
      reasons: [...(clinical ? ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN'] : []), faultCode],
      authorization_limited: clinical, query_exhausted: null, pages_observed: 0,
      query_evidence: 'none' };
    if (clinical) throw new GatewayFault('INTERNAL_ERROR', 'Clinical control coverage requires a fault.');
    const evidence: QueryEvidence = { constraints: [], materialFilterProved: !clinical,
      evidenceKind: clinical ? 'unverified_continuation' : 'metadata_snapshot' };
    const coverage = coverageForSnapshot(evidence, { deliveredCount: 0, pagesObserved: 0, queryEvidence: evidence,
      sortProof: 'none', remainder: 'none', exhausted: !faultCode, scope: clinical ? 'query' : 'metadata',
      authorizationLimited: clinical, refused: Boolean(faultCode), refusalReasons: faultCode ? [faultCode] : [] });
    return coverage;
  }

  /** Fresh error controls, never inherited from a failed success/render. */
  private errorV2(tool: ToolName, fault: Pick<GatewayFault, 'code' | 'retryable'> & { message?: string },
    admission?: Admission02, delivery?: DeliveryContext): GatewayEnvelope02 {
    // Internal/unregistered faults must never become public wire codes/reasons.
    const code = (FAULT_CODES as readonly string[]).includes(fault.code) ? fault.code : 'INTERNAL_ERROR';
    const clinical = tool !== 'fhir_capabilities';
    const envelope = this.envelopeV2(tool, { data: {}, coverage: this.controlCoverageV2(clinical, code) }, admission, delivery);
    envelope.warnings = [];
    envelope.error = { code, safe_message: ((code === 'POLICY_DENIED' && fault.message === 'Source is not available to this workload.') || (code === 'CONTEXT_REQUIRED' && fault.message === 'Context does not match the trusted configured patient.')) ? fault.message! : code === 'INVALID_ARGUMENTS' && fault.message && ['invalid_topic', 'invalid_format', 'invalid_interaction', 'invalid_action'].some(key => REFUSAL_MESSAGES[key] === fault.message)
      ? fault.message : 'Unable to complete the bounded request.', retryable: code === fault.code && fault.retryable };
    envelope.budget.limit_reached = code === 'OUTPUT_LIMIT';
    return envelope;
  }

  private minimalV2(tool: ToolName, fault: Pick<GatewayFault, 'code' | 'retryable'> & { message?: string },
    admission?: Admission02, delivery?: DeliveryContext): GatewayEnvelope02 {
    const envelope = this.errorV2(tool, fault, admission, delivery);
    envelope.error!.safe_message = 'Request failed.';
    return envelope;
  }

  private makeEmergencyEnvelopeV2(tool: ToolName, requestId: string, byteLimit: number,
    upstreamCalls: number, elapsedMs: number, delivery: DeliveryContext, admission?: Admission02): GatewayEnvelope02 {
    return { schema_version: M3B_SCHEMA_VERSION, request_id: requestId, source: this.source(),
      context: { handle: this.contextId, mode: 'patient-bound', policy_revision: this.policyRevision },
      data: {}, coverage: { state: 'unknown', scope: tool === 'fhir_capabilities' ? 'metadata' : 'query',
        reasons: [...(tool === 'fhir_capabilities' ? [] : ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN']), 'INTERNAL_ERROR'],
        authorization_limited: tool !== 'fhir_capabilities', query_exhausted: null, pages_observed: 0,
        query_evidence: 'none' },
      transform: { format: admission?.format ?? 'fhir', ...(admission?.requestedFormat ? { requested_format: admission.requestedFormat } : {}),
        projected: false, withheld_payloads: [], omitted_fields: [], unresolved_fields: [], narrative_omitted: false,
        recipe_ids: [], structural_resource_indices: [], delivery_profile: delivery.profile },
      warnings: [], error: { code: 'INTERNAL_ERROR', safe_message: 'Unable to complete the bounded request.', retryable: false },
      budget: { bytes_returned: 0, byte_limit: byteLimit, wire_bytes: 0, limit_reached: false, upstream_calls: upstreamCalls, elapsed_ms: elapsedMs } };
  }

  /** Neutral candidate adapter; no retrieval, re-sanitization or fabricated identity. */
  private projectionRecordV2(record: Sanitized): SanitizedProjectionRecord {
    return { resource: record.resource, policyOmitted: record.omitted,
      withheldReasons: [...new Set(record.manifests.map(manifest => manifest.reason)
        .filter((reason): reason is string => typeof reason === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(reason)))],
      retrievedAt: record.retrievedAt, requiresStructuralView: record.requiresStructuralView };
  }

  /** Render from the selected per-call authority. Fallback is labelled BEFORE
   * rendering the complete result, so the text and structured labels agree. */
  private sdkResultV2(envelope: GatewayEnvelope02, delivery: DeliveryContext & { tool?: ToolName }) {
    let text: string;
    envelope.transform.delivery_profile = delivery.profile;
    if (delivery.profile === 'structured-evidence-v1') {
      const first = evidenceRender(envelope as unknown as GatewayEnvelope, delivery.tool);
      envelope.transform.delivery_profile = first.deliveredProfile;
      text = evidenceRender(envelope as unknown as GatewayEnvelope, delivery.tool).text;
    } else text = stringifyFhir(envelope);
    const result = toMcpToolResult02(envelope);
    result.content[0]!.text = text;
    return { ...result, ...(delivery.era === 'modern' ? { resultType: 'complete' as const,
      _meta: { 'io.modelcontextprotocol/serverInfo': delivery.serverIdentity ?? SERVER_IDENTITY } } : {}) };
  }

  /** Count once: converge both self-referential size fields, bytes_returned (model copy bytes) and
   * wire_bytes (the complete serialized result), on the exact final render. */
  private bytesV2(envelope: GatewayEnvelope02, delivery: DeliveryContext): void {
    assertDeliveryJson(envelope);
    for (let n = 0; n < 8; n++) {
      const result = this.sdkResultV2(envelope, delivery);
      const bytes = modelCopyBytes(result), wire = Buffer.byteLength(JSON.stringify(result));
      if (bytes === envelope.budget.bytes_returned && wire === envelope.budget.wire_bytes) return;
      envelope.budget.bytes_returned = bytes;
      envelope.budget.wire_bytes = wire;
    }
    throw new GatewayFault('INTERNAL_ERROR', 'Final result accounting did not converge.');
  }

  /** Trusted invocation state contains no data read back from an envelope. */
  private invocationV2(admission: Admission02 | undefined, allowance: number, snapshot?: Snapshot,
    previousEvidence?: QueryEvidence): Omit<ValidationContext02, 'era' | 'deliveryProfile' | 'renderedText' | 'result' | 'serverIdentity'> {
    const input = admission?.input as DispatchInput | undefined, original = snapshot?.queryEvidence;
    const evidence = snapshot && original ? this.currentQueryEvidence(snapshot) : undefined;
    const queryBinding = snapshot?.queryBinding ?? { sourceRevision: this.capabilityRevision, policyRevision: this.policyRevision, contextHandle: this.contextId };
    return freezeDeliveryState({ effectiveByteLimit: allowance,
      binding: { sourceAlias: this.config.source.alias, fhirVersion: this.fhirVersion,
        sourceRevision: this.capabilityRevision, policyRevision: this.policyRevision, contextHandle: this.contextId },
      formatSupplied: admission?.requestedFormat !== undefined,
      ...(admission?.requestedFormat !== undefined ? { requestedFormat: admission.requestedFormat } : {}),
      ...(admission?.fields ? { selectedFields: [...admission.fields] } : {}),
      ...(input?.topic ? { topic: input.topic as ValidationContext02['topic'] } : {}),
      ...(input?.action ? { action: input.action as ValidationContext02['action'] } : {}),
      resourceType: snapshot?.type ?? input?.resource_type, path: input?.path, patientId: this.config.patientId,
      ...(input?.id ? { readTarget: { resourceType: input.resource_type!, id: input.id } } : {}),
      offset: input?.offset, limit: input?.limit,
      ...(snapshot?.queryEvidence ? { requestedPageSize: this.requestedPageSizeV2(snapshot) } : {}),
      ...(evidence ? { chainDeliveredCount: snapshot?.queryOverlay?.deliveredCount ?? 0,
        query: { resourceType: snapshot!.type, ...queryBinding,
          orderedPairs: original!.constraints.map(({ name, value }) => ({ name, value })),
          sort: [...(original!.sort?.requested ?? [])],
          constraintProof: evidence.constraints.map(({ execution, evidence_ref }) => ({ execution, ...(evidence_ref ? { evidence_ref } : {}) })),
          ...(evidence.sort ? { sortProof: { order: evidence.sort.order, effective: evidence.sort.effective ? [...evidence.sort.effective] : null } } : {}),
          continuationUnverified: snapshot!.queryOverlay?.continuationUnverified === true,
          fullEvidenceRequired: !previousEvidence || !isDeepStrictEqual(previousEvidence, evidence) } } : {}) });
  }

  private captureV2(envelope: GatewayEnvelope02, delivery: DeliveryContext,
    invocation: ReturnType<FhirGateway['invocationV2']>): ValidationContext02 {
    // Validate construction before conversion: accessors, cycles and non-JSON
    // leaves cannot silently disappear or become null at the commitment edge.
    assertDeliveryJson(envelope);
    const result = this.sdkResultV2(cloneFhirValue(envelope), delivery);
    return freezeDeliveryState({ ...invocation, era: delivery.era,
      deliveryProfile: envelope.transform.delivery_profile, renderedText: result.content[0]!.text,
      result, serverIdentity: delivery.serverIdentity ?? SERVER_IDENTITY });
  }

  /** Clean emergency fitting is independent of the normal render/bytes/capture
   * helpers. Even a broken slim renderer can only produce full-text fallback. */
  private emergencyDeliveryV2(tool: ToolName, allowance: number, calls: number, elapsed: number,
    delivery: DeliveryContext, admission: Admission02 | undefined, invocation: ReturnType<FhirGateway['invocationV2']>, requestId: string = randomUUID()) {
    const env = this.makeEmergencyEnvelopeV2(tool, requestId, allowance, calls, elapsed, delivery, admission);
    env.transform.delivery_profile = 'full-text-v1';
    const resultFor = () => {
      const result = toMcpToolResult02(env);
      if (delivery.profile === 'structured-evidence-v1') result.content[0]!.text = `delivery_profile: "full-text-v1"\n${stringifyFhir(env).replace(/[\u2028\u2029\u0085]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}`;
      return { ...result, ...(delivery.era === 'modern' ? { resultType: 'complete' as const,
        _meta: { 'io.modelcontextprotocol/serverInfo': delivery.serverIdentity ?? SERVER_IDENTITY } } : {}) };
    };
    for (let n = 0; n < 8; n++) {
      const emergencyResult = resultFor();
      const bytes = modelCopyBytes(emergencyResult), wire = Buffer.byteLength(JSON.stringify(emergencyResult));
      if (bytes === env.budget.bytes_returned && wire === env.budget.wire_bytes) break;
      env.budget.bytes_returned = bytes;
      env.budget.wire_bytes = wire;
    }
    const result = resultFor();
    const capture = freezeDeliveryState({ ...invocation, era: delivery.era, deliveryProfile: 'full-text-v1' as const,
      renderedText: result.content[0]!.text, result, serverIdentity: delivery.serverIdentity ?? SERVER_IDENTITY });
    return { env, capture };
  }

  private isDeliverableV2(tool: ToolName, candidate: GatewayEnvelope02, capture: ValidationContext02) {
    return validateDeliverable02(tool, toWireValue(candidate), capture);
  }

  /** Adapter returns the original immutable capture, never a second render. */
  toToolResult(envelope: GatewayEnvelope02, _options?: { era?: 'modern' | 'legacy'; profile?: 'full-text-v1' | 'structured-evidence-v1' }) {
    const capture = this.capturesV2.get(envelope);
    if (!capture) throw new GatewayFault('INTERNAL_ERROR', 'Missing final delivery capture.');
    const { resultType: _type, _meta: _meta, ...result } = capture.result;
    return { ...result, content: result.content as { type: 'text'; text: string }[] };
  }

  /** At most twenty upstream requests per tool call, including auth.
   * Reserve before the socket edge; an attempted twenty-first request is not
   * counted as sent. Shared flights retain their creator's bounded meter. */
  private reserveUpstreamWorkV2(): void {
    const work = this.candidateWorkV2.getStore();
    if (!work) return;
    if (work.upstreamCalls >= 20) { work.limitReached = true; throw new LocalWorkRefusal(); }
    work.upstreamCalls++;
  }

  /** Sole serving pipeline only. No public mode, export or registration selects it. */
  async execute(tool: ToolName, raw: unknown, options: ExecuteOptions = {}): Promise<GatewayEnvelope02> {
    if (!TOOL_NAMES.includes(tool)) throw new GatewayFault('UNKNOWN_TOOL', 'Tool is not implemented in this prototype.');
    const start = Date.now();
    let calls = 0;
    const reserve = () => this.reserveUpstreamWorkV2();
    // FhirTransport increments stats immediately before each actual request.
    // Meter that edge here, including any repeated attempt, without changing
    // transport policy. Auth uses the same per-call reservation above.
    const stats = { get calls() { return calls; }, set calls(next: number) { reserve(); calls = next; } };
    const era = options.era ?? 'modern';
    const delivery: DeliveryContext & { tool: ToolName } = Object.freeze({ tool, era,
      profile: deliveryProfileForEra(this.config.delivery, era, this.testOptions?.testDeliveryRegistryOverride), serverIdentity: SERVER_IDENTITY });
    const allowance = resolveErrorAllowance(raw, { defaultBytes: this.defaultBytes, maxBytes: this.maxBytes });
    let admission: Admission02 | undefined, admitted = false;
    const budget: RequestBudget = { signal: options.signal,
      deadline: start + Math.min(options.deadlineMs ?? this.config.limits?.deadlineMs ?? 45000, 200000) };
    const work = { authCalls: 0, metadataCalls: 0, clinicalCalls: 0, upstreamCalls: 0 };
    return this.candidateWorkV2.run(work, async () => {
      const finish = (build: () => GatewayEnvelope02, invocation: ReturnType<FhirGateway['invocationV2']>, phase: 'success' | 'error', cause?: string) => {
        const restoreClinical = this.store.reservationCheckpoint(), restoreDiscovery = this.discoveryStore.reservationCheckpoint();
        let committed = false;
        try {
          const env = build();
          env.budget.upstream_calls = stats.calls + work.authCalls;
          env.budget.elapsed_ms = Date.now() - start;
          this.bytesV2(env, delivery);
          if (exceedsByteBudget(env.budget)) throw new GatewayFault('OUTPUT_LIMIT', 'Result cannot fit the requested allowance.');
          const capture = this.captureV2(env, delivery, invocation);
          const candidate = cloneFhirValue(env);
          this.testOptions?.testEnvelopeCorruptor?.(candidate as unknown as GatewayEnvelope, phase);
          assertDeliveryJson(candidate);
          const verdict = this.isDeliverableV2(tool, candidate, capture);
          if (!verdict.ok) throw new GatewayFault('INTERNAL_ERROR', 'Unable to complete the bounded request.');
          if (phase === 'success') this.throwIfCancelled(budget);
          this.capturesV2.set(candidate, capture);
          this.audit(tool, candidate as unknown as GatewayEnvelope, phase === 'success' ? 'allowed'
            : ['NOT_FOUND', 'POLICY_DENIED', 'CONTEXT_REQUIRED'].includes(candidate.error?.code ?? '') ? 'denied' : 'failed', cause);
          // The last step before commit: an envelope that fails anywhere above (audit included) grants no reachability.
          if (phase === 'success') this.noteReachable(env);
          committed = true;
          return candidate;
        } finally { if (!committed) { restoreClinical(); restoreDiscovery(); } }
      };
      try {
        if (this.closed) throw new GatewayFault('GATEWAY_CLOSED', 'Gateway is closed.');
        admission = freezeDeliveryState(this.admitV2(tool, raw));
        if (allowance.invalidAllowance) throw new GatewayFault('INVALID_ARGUMENTS', 'Invalid output allowance.');
        const input = admission.input as DispatchInput;
        if (input.source !== this.config.source.alias && input.source !== undefined) throw new GatewayFault('POLICY_DENIED', 'Source is not available to this workload.');
        if (input.context_handle !== undefined && input.context_handle !== this.contextId) throw new GatewayFault(tool === 'fhir_capabilities' && input.cursor ? 'DISCOVERY_EXPIRED' : 'CONTEXT_REQUIRED', 'Context does not match the trusted configured patient.');
        if (tool === 'fhir_read' || tool === 'fhir_search') assertClinicalResource(input.resource_type!);
        await this.admit(budget); admitted = true; this.throwIfCancelled(budget);
        if (this.credentials) await this.authorizationFor(this.transport.base, budget);
        // A type the current grant does not permit for this interaction is refused before any FHIR request.
        if ((tool === 'fhir_read' || tool === 'fhir_search') && this.credentials && !this.credentials.allows(input.resource_type!, tool === 'fhir_read' ? 'read' : 'search')) throw new GatewayFault('POLICY_DENIED', 'The granted scope does not permit this resource type.', false, undefined, 'SCOPE_NOT_GRANTED');
        if (this.capabilities && this.capabilityPolicyRevision !== this.policyRevision) this.invalidateState();
        budget.epoch = this.authEpoch; budget.stateGeneration = this.stateGeneration;
        if (tool === 'fhir_capabilities') {
          return await this.capabilitiesV2(raw, delivery, (resourceType, metadata) => {
            const invocation = freezeDeliveryState({ ...this.invocationV2(admission, allowance.allowance), resourceType, metadata });
            return env => finish(() => env, invocation, 'success');
          }, budget, stats);
        }
        if (tool === 'fhir_result') {
          const found = this.store.get(input.handle!);
          const invocation = this.invocationV2(admission, allowance.allowance, found.value);
          return finish(() => this.resultV2(admission as Admission02<'fhir_result'>, delivery), invocation, 'success');
        }
        const render = (snapshot: Snapshot, previous?: QueryEvidence) => {
          if (tool === 'fhir_search') snapshot = { ...snapshot, queryBinding: Object.freeze({ sourceRevision: this.capabilityRevision, policyRevision: this.policyRevision, contextHandle: this.contextId }) };
          const invocation = this.invocationV2(admission, allowance.allowance, snapshot, previous);
          return finish(() => this.renderV2(snapshot, admission!, tool as CoverageAssembly02['tool'], delivery, previous, undefined, budget), invocation, 'success');
        };
            if (tool === 'fhir_page') return await this.page(input, stats, budget, render) as GatewayEnvelope02;
        await this.discover(stats, budget);
        if (tool === 'fhir_read') return await this.read(input, stats, budget, render) as GatewayEnvelope02;
        return await this.search(input, stats, budget, render) as GatewayEnvelope02;
      } catch (error) {
        const fault = error instanceof LocalWorkRefusal ? new GatewayFault('UPSTREAM_LIMIT', error.message)
          : error instanceof GatewayFault ? error : new GatewayFault('INTERNAL_ERROR', 'Unable to complete the bounded request.');
        const invocation = this.invocationV2(admission, allowance.allowance);
        try {
          return finish(() => {
            const kind = fault.code === 'RESULT_EXPIRED' ? 'expired_result'
              : fault.code === 'UNSUPPORTED_MODIFIER' ? 'unsupported_modifier' : undefined;
            // These faults originate in local handle/query admission, before
            // this call's clinical fetch. Count metadata/auth independently.
            const env = kind ? this.refusalV2(tool, kind, { upstreamCalls: stats.calls + work.authCalls, clinicalCalls: work.clinicalCalls }, admission,
              { resource_type: (admission?.input as DispatchInput | undefined)?.resource_type, parameter: this.repairParameterV2(fault.code, admission) }) : this.errorV2(tool, fault, admission, delivery);
            env.budget.byte_limit = allowance.allowance;
            const repair = repairForFault(fault.code, { resource_type: (admission?.input as DispatchInput | undefined)?.resource_type,
              parameter: this.repairParameterV2(fault.code, admission),
              allowed_max_bytes: this.maxBytes, current_max_bytes: allowance.allowance }, this.reviewedNamesV2());
            if (repair) env.error!.repair = repair;
            return env;
          }, invocation, 'error', fault.cause);
        } catch {
          // Independent clean emergency: no corruptor and no recursive renderer.
          const { env, capture } = this.emergencyDeliveryV2(tool, allowance.allowance, stats.calls + work.authCalls, Date.now() - start, delivery, admission, invocation);
          if (!validateDeliverable02(tool, toWireValue(env), capture).ok) throw new GatewayFault('INTERNAL_ERROR', 'Emergency validation failed.');
          this.capturesV2.set(env, capture); this.audit(tool, env as unknown as GatewayEnvelope, 'failed', fault.cause); return env;
        }
      } finally { if (admitted) this.release(); }
    });
  }

  /** Sole clinical renderer.
   * Store neutral sanitized records, project once, and derive ALL response-local
   * metadata from the final packed sequence. The withheld-entry collapse runs inside assemble(),
   * over the finally selected records only, so every packing pop recomputes the counts.
   */
  private renderV2(original: Snapshot, admission: Admission02, tool: CoverageAssembly02['tool'],
    delivery: DeliveryContext = { era: 'modern', profile: 'full-text-v1' },
    previousEvidence?: QueryEvidence, retainedResult?: NonNullable<GatewayEnvelope02['result']>, budget: RequestBudget = {}): GatewayEnvelope02 {
    const read = tool === 'fhir_read', retained = tool === 'fhir_result';
    const input = admission.input as DispatchInput;
    const reasons: string[] = [];
    const records = original.records.filter(record => {
      const id = record.resource.id;
      if (id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(id) || id === '.' || id === '..')) {
        if (read) throw new GatewayFault('NOT_FOUND', 'Resource unavailable in the authorized context.');
        reasons.push('INVALID_RESOURCE_ID'); return false;
      }
      if (containsPrecisionFault(record.resource)) {
        if (read) throw new GatewayFault('UNSUPPORTED_PRECISION', 'Source numeric representation cannot be preserved.');
        reasons.push('UNSUPPORTED_PRECISION'); return false;
      }
      return true;
    });
    const snapshot: Snapshot = { ...original, records,
      expiresAt: original.expiresAt ?? Date.now() + (this.config.limits?.ttlMs ?? 15 * 60 * 1000) };
    const limit = retained ? input.limit ?? 20 : read ? 1 : this.requestedPageSizeV2(snapshot);
    const end = Math.min(records.length, snapshot.offset + limit);
    const selected: { record: Sanitized; neutral: SanitizedProjectionRecord; view: ReturnType<typeof projectSanitized> }[] = [];
    let position = snapshot.offset, oversized = false;
    let recovery: { structural: boolean; needed?: number; unrecoverable: boolean } | undefined;
    const env = this.envelopeV2(tool, { data: {}, coverage: this.controlCoverageV2(true, 'INTERNAL_ERROR') }, admission, delivery);
    const notRetainedAction = OVERSIZE_RECOVERY_MESSAGES.notRetained;
    const recoveryAction = (stored: boolean): string => {
      if (!recovery?.structural) return retained ? OVERSIZE_RECOVERY_MESSAGES.selectedRetained
        : stored ? OVERSIZE_RECOVERY_MESSAGES.selectedStored : notRetainedAction;
      if (recovery.unrecoverable) return stored ? OVERSIZE_RECOVERY_MESSAGES.structuralStoredRefusal
        : OVERSIZE_RECOVERY_MESSAGES.structuralRefusal;
      return (retained ? OVERSIZE_RECOVERY_MESSAGES.structuralRetained : OVERSIZE_RECOVERY_MESSAGES.structuralRetry)
        .replace('{max_bytes}', String(recovery.needed));
    };
    const placeholder = (prefix: string) => `${prefix}_${'x'.repeat(32)}`;
    const assemble = () => {
      const neutral = selected.map(item => item.neutral), metas = selected.map(item => item.view.meta);
      const resources = selected.map(item => item.view.resource);
      const provenance = indexedProvenance(neutral);
      const versionOf = (resource: FhirResource) => (resource.meta as { versionId?: unknown } | undefined)?.versionId;
      if (provenance.length !== resources.length || provenance.some((entry, i) => entry.resource_index !== i
        || entry.retrieved_at !== selected[i]!.record.retrievedAt
        || resources[i]!.resourceType !== selected[i]!.record.resource.resourceType
        || resources[i]!.id !== selected[i]!.record.resource.id
        || versionOf(resources[i]!) !== versionOf(selected[i]!.record.resource))) throw new GatewayFault('INTERNAL_ERROR', 'Invalid candidate provenance sequence.');
      const localMore = position < records.length;
      const more = !recovery?.unrecoverable && !read && ((localMore && (!retained || selected.length > 0)) || (!retained && Boolean(snapshot.nextUrl)));
      const unknown = !more && !read && !retained && Boolean(recovery?.unrecoverable || snapshot.nonContinuable || snapshot.queryOverlay?.nonContinuable || snapshot.sourceIncomplete || snapshot.queryEvidenceKind === 'unverified_continuation');
      const assembled = this.coverageV2(snapshot, { tool, deliveredCount: resources.length, previousEvidence,
        localRemainder: !read && localMore && (!recovery?.unrecoverable || retained), filtered: false, reasons: [...new Set([...reasons, ...(oversized ? ['OVERSIZED_RESOURCE'] : [])])] });
      env.coverage = assembled.coverage;
      env.data = { resources, ...(retained && localMore && selected.length ? { next_offset: position } : {}),
        ...(oversized && !resources.length ? { manifest: { reason: 'RESOURCE_EXCEEDS_INLINE_BUDGET',
          action: recoveryAction(true) } } : {}) };
      env.provenance = provenance;
      env.pagination = { has_more: more ? true : unknown ? null : false, returned_matches: resources.length, returned_includes: 0,
        ...(!read && !retained && more ? { next_cursor: placeholder('cur') } : {}),
        ...(!retained && !read ? { requested_page_size: limit, total: { precision: 'unknown' as const,
          ...(snapshot.total !== undefined && snapshot.offset === 0 && !localMore && assembled.coverage.query_exhausted === true ? { value: snapshot.total } : {}) } } : {}) };
      env.transform = { ...env.transform, projected: Boolean(admission.fields) || (admission.format === 'compact' && resources.length > 0)
          || metas.some(meta => meta.omitted_fields.length > 0),
        withheld_payloads: collapseWithheld(selected.map(item => item.record)),
        omitted_fields: [...new Set(metas.flatMap(meta => meta.omitted_fields))].sort(),
        unresolved_fields: [...new Set(metas.flatMap(meta => meta.unresolved_fields))],
        narrative_omitted: selected.some(item => item.record.narrativeOmitted), recipe_ids: collectRecipeIds(metas),
        structural_resource_indices: metas.flatMap((meta, i) => meta.interpretation === 'structural' ? [i] : []) };
      env.warnings = this.warningsV2([...(assembled.warnings ?? []), ...metas.flatMap(meta => meta.warnings),
        ...(env.transform.unresolved_fields.length ? [{ code: 'UNRESOLVED_FIELDS', message: WARNING_MESSAGES.UNRESOLVED_FIELDS! }] : [])]);
      env.budget.limit_reached = localMore;
      if (retainedResult) env.result = retainedResult;
      else if (resources.length || oversized) env.result = { handle: placeholder('res'), expires_at: new Date(snapshot.expiresAt!).toISOString(), formats: ['compact', 'fhir'] };
      else delete env.result;
      this.bytesV2(env, delivery);
      // Reserve the exact best-effort retention-failure shape before selecting
      // records; failure must not erase disclosures or overflow the byte cap.
      if (!retainedResult && env.result) {
        const result = env.result, warnings = env.warnings, bytes = env.budget.bytes_returned, wire = env.budget.wire_bytes;
        const data = env.data as { manifest?: { reason: string; action: string } }, manifest = data.manifest;
        delete env.result;
        if (manifest) data.manifest = { ...manifest, action: recoveryAction(false) };
        env.warnings = this.warningsV2([...warnings, { code: 'RESULT_NOT_RETAINED', message: WARNING_MESSAGES.RESULT_NOT_RETAINED! }]);
        this.bytesV2(env, delivery);
        const worst = env.budget.bytes_returned, worstWire = env.budget.wire_bytes;
        if (manifest) data.manifest = manifest;
        env.result = result; env.warnings = warnings; env.budget.bytes_returned = Math.max(bytes, worst);
        env.budget.wire_bytes = Math.max(wire, worstWire);
      }
    };
    assemble();
    let exact = env.budget.bytes_returned, pendingBound = 0;
    let packed = false;
    for (; position < end;) {
      const record = records[position]!, neutral = this.projectionRecordV2(record);
      const view = projectSanitized(neutral, admission.format, admission.fields);
      selected.push({ record, neutral, view }); position++;
      // Estimate model copy growth (conservatively, as escaped text) to bound batching work.
      // Exact edge checks below also handle unusually escape-dense text and the wire invariant.
      pendingBound += 4 * Buffer.byteLength(stringifyFhir({ resource: view.resource, meta: view.meta, manifests: record.manifests })) + 512;
      if (exact + pendingBound + 2048 <= env.budget.byte_limit - 128) continue;
      assemble();
      if (exceedsByteBudget(env.budget, 128)) {
        do { selected.pop(); position--; oversized = selected.length === 0; assemble(); }
        while (selected.length && exceedsByteBudget(env.budget, 128));
        packed = true; break;
      }
      exact = env.budget.bytes_returned; pendingBound = 0;
    }
    if (!packed) assemble();
    while (selected.length && exceedsByteBudget(env.budget, 128)) {
      selected.pop(); position--; oversized = selected.length === 0; assemble();
    }
    if (oversized) {
      // Measure the model copy of the actual single-record envelope at the configured
      // ceiling, including the retention-failure reservation. No writes.
      const record = records[position]!, neutral = this.projectionRecordV2(record);
      const view = projectSanitized(neutral, admission.format, admission.fields);
      if (view.meta.interpretation === 'structural') {
        const savedPosition = position, savedLimit = env.budget.byte_limit;
        selected.push({ record, neutral, view }); position++; oversized = false;
        env.budget.byte_limit = this.maxBytes; assemble();
        const needed = env.budget.bytes_returned + 128;
        selected.pop(); position = savedPosition; oversized = true; env.budget.byte_limit = savedLimit;
        recovery = { structural: true, needed, unrecoverable: needed > this.maxBytes };
      } else recovery = { structural: false, unrecoverable: false };
      if (recovery.unrecoverable && !retained && !read) {
        snapshot.nextUrl = undefined;
        snapshot.nonContinuable = true;
        if (snapshot.queryOverlay) snapshot.queryOverlay = { ...snapshot.queryOverlay, nonContinuable: true };
      }
      assemble();
    }
    if (exceedsByteBudget(env.budget, 128)) throw new GatewayFault('OUTPUT_LIMIT', 'Result cannot fit the requested budget.');
    this.throwIfCancelled(budget);
    const restoreReservations = this.store.reservationCheckpoint();
    const restoreDiscovery = this.discoveryStore.reservationCheckpoint();
    let completed = false;
    try {
    if (!retained) {
      const page: Snapshot = { ...snapshot, queryOverlay: undefined, offset: 0, sliceStart: undefined, sliceEnd: undefined };
      const overlay = snapshot.queryOverlay ? { ...snapshot.queryOverlay, deliveredCount: snapshot.queryOverlay.deliveredCount + selected.length } : undefined;
      const reserve = (handle: string) => { const list = this.reserved.get(env as unknown as GatewayEnvelope) ?? [];
        list.push(handle); this.reserved.set(env as unknown as GatewayEnvelope, list); };
      if (env.pagination?.next_cursor) {
        const local = position < records.length;
        const stored = this.store.putBatch([{ prefix: 'cur', value: local ? page : { ...page, records: [], loaded: false },
          overlay: { offset: local ? position : 0, queryOverlay: overlay }, originalExpiry: snapshot.expiresAt }])[0]!;
        env.pagination.next_cursor = stored.handle; reserve(stored.handle);
      }
      if (env.result) {
        // A refused best-effort retention must not leave behind evictions that freed nothing.
        const restoreRetention = this.retentionLedger.reservationCheckpoint();
        try {
          const stored = this.store.putBatch([{ prefix: 'res', value: page,
            overlay: { sliceStart: selected.length ? snapshot.offset : 0, sliceEnd: selected.length ? position : records.length, queryOverlay: overlay },
            originalExpiry: snapshot.expiresAt }], this.reserved.get(env as unknown as GatewayEnvelope) ?? [])[0]!;
          env.result = { ...stored, formats: ['compact', 'fhir'] }; reserve(stored.handle);
        } catch (error) {
          if (!(error instanceof GatewayFault && error.code === 'RETENTION_LIMIT')) throw error;
          restoreRetention();
          delete env.result;
          const data = env.data as { manifest?: { reason: string; action: string } };
          if (data.manifest) data.manifest = { ...data.manifest, action: recoveryAction(false) };
          env.warnings = this.warningsV2([...env.warnings, { code: 'RESULT_NOT_RETAINED', message: WARNING_MESSAGES.RESULT_NOT_RETAINED! }]);
        }
      }
    }
    this.bytesV2(env, delivery);
    // Only the records this envelope finally delivers, as delivered (view), grant reachability.
    this.pendingReachable.set(env, selected.flatMap(item => deliveredDirectoryReferences(item.view.resource, this.transport.base)));
    completed = true;
    return env;
    } finally {
      if (!completed) { restoreReservations(); restoreDiscovery(); this.reserved.delete(env as unknown as GatewayEnvelope); }
    }
  }

  /** Retained-result handler: reads only the process-local snapshot, and uses
   * the store's original absolute expiry. Inspect never writes or renews it. */
  private resultV2(admission: Admission02<'fhir_result'>,
    delivery: DeliveryContext = { era: 'modern', profile: 'full-text-v1' }): GatewayEnvelope02 {
    const input = admission.input;
    if (!input.handle.startsWith('res_')) throw new GatewayFault('RESULT_EXPIRED', 'Result is unavailable or expired; repeat the original query.');
    const found = this.store.get(input.handle);
    const snapshot: Snapshot = { ...found.value, records: found.value.records.slice(found.value.sliceStart ?? 0, found.value.sliceEnd ?? found.value.records.length),
      offset: input.offset, sliceStart: undefined, sliceEnd: undefined, expiresAt: Date.parse(found.expires_at) };
    if (input.offset > snapshot.records.length) throw new GatewayFault('INVALID_ARGUMENTS', 'Retained offset exceeds the snapshot.');
    const result: NonNullable<GatewayEnvelope02['result']> = { handle: input.handle, expires_at: found.expires_at, formats: ['compact', 'fhir'] };
    if (input.action !== 'inspect') return this.renderV2(snapshot, admission, 'fhir_result', delivery, undefined, result);
    const assembled = this.coverageV2(snapshot, { tool: 'fhir_result', deliveredCount: 0, filtered: false });
    const env = this.envelopeV2('fhir_result', { data: {}, ...assembled, result }, admission, delivery);
    const rows = retainedOmissions(snapshot.records.slice(input.offset, input.offset + input.limit).map(record => this.projectionRecordV2(record)), admission.format);
    const pack = () => {
      const next = input.offset + rows.length;
      env.data = { resource_count: snapshot.records.length, scope: 'retained_upstream_page',
        upstream_pages_remain: snapshot.nextUrl ? true : snapshot.queryEvidenceKind === 'unverified_continuation' || snapshot.nonContinuable || snapshot.queryOverlay?.nonContinuable || snapshot.sourceIncomplete ? null : false,
        formats: ['compact', 'fhir'], omissions: rows, ...(next < snapshot.records.length ? { next_offset: next } : {}) };
      // Inspection is metadata only: no bodies, manifests, narrative or clinical provenance.
      env.transform.structural_resource_indices = rows.flatMap((row, i) => row.interpretation === 'structural' ? [i] : []);
      env.warnings = this.warningsV2([...(assembled.warnings ?? []), ...(env.transform.structural_resource_indices.length
        ? [{ code: 'UNINTERPRETED_MODIFIER', message: WARNING_MESSAGES.UNINTERPRETED_MODIFIER! }] : [])]);
      env.budget.limit_reached = next < snapshot.records.length;
      this.bytesV2(env, delivery);
    };
    pack();
    while (rows.length && exceedsByteBudget(env.budget, 128)) { rows.pop(); pack(); }
    if (exceedsByteBudget(env.budget, 128) || (!rows.length && input.offset < snapshot.records.length)) throw new GatewayFault('OUTPUT_LIMIT', 'Inspection cannot fit the requested budget.');
    return env;
  }

  /** Metadata dispatch. No clinical fetch occurs. */
  private async capabilitiesV2(raw: unknown,
    delivery: DeliveryContext = { era: 'modern', profile: 'full-text-v1' },
    prepare?: (resourceType?: string, metadata?: ValidationContext02['metadata']) => (env: GatewayEnvelope02) => GatewayEnvelope02, requestBudget: RequestBudget = {}, requestStats = { calls: 0 }): Promise<GatewayEnvelope02> {
    const admission = this.admitV2('fhir_capabilities', raw);
    const input = admission.input;
    const stats = requestStats;
    const work = this.candidateWorkV2.getStore() ?? { authCalls: 0, metadataCalls: 0, clinicalCalls: 0, upstreamCalls: 0 };
    const pending = { clinical: [] as string[], discovery: [] as string[] };
    const budget: RequestBudget = requestBudget;
    return this.candidateWorkV2.run(work, async () => {
      try {
        if (this.closed) throw new GatewayFault('GATEWAY_CLOSED', 'Gateway is closed.');
        if (input.source && input.source !== this.config.source.alias) throw new GatewayFault('POLICY_DENIED', 'Source is not available to this workload.');
        if (input.context_handle !== undefined && input.context_handle !== this.contextId) {
          if (input.cursor) throw new GatewayFault('DISCOVERY_EXPIRED', 'Discovery snapshot is unavailable or expired; repeat the original discovery query.');
          throw new GatewayFault('CONTEXT_REQUIRED', 'Context does not match the trusted configured patient.');
        }
        if (this.credentials) await this.authorizationFor(this.transport.base, budget);
        budget.epoch = this.authEpoch; budget.stateGeneration = this.stateGeneration;
        // A continuation uses its frozen local snapshot. Expired metadata does not
        // trigger a refresh, renew the snapshot or consume upstream work.
        if (!input.cursor) {
          try {
            const ttl = this.config.discovery?.metadataTtlMs ?? 300000;
            if (['search_parameter', 'support'].includes(input.topic) && this.metadataExpiresAt - Date.now() < Math.min(60000, ttl / 2)) this.metadataExpiresAt = 0;
            await this.discover(stats, budget);
          }
          finally { work.metadataCalls += stats.calls; }
        }
        const env = this.envelopeV2('fhir_capabilities', { data: {}, coverage: this.controlCoverageV2(false), warnings: [] }, admission, delivery);
        env.budget.upstream_calls = work.authCalls + work.metadataCalls + work.clinicalCalls;
        // No await may occur inside this reservation window. Both authorities
        // restore prior evictions on any later shaping/generation failure.
        const restoreClinical = this.store.reservationCheckpoint();
        const restoreDiscovery = this.discoveryStore.reservationCheckpoint();
        try {
          this.throwIfCancelled(budget);
          const resourceType = input.cursor && input.topic === 'search_parameter'
            ? (readDiscoverySnapshot(this.discoveryStore, input.cursor, this.discoveryBindingV2(), input.topic).value as Extract<DiscoverySnapshotValue, { topic: 'search_parameter' }>).resourceType : input.resource_type;
          const metadata = this.describeV2(admission, env, delivery, pending);
          const finalize = prepare?.(resourceType, metadata);
          this.throwIfCancelled(budget);
          if (finalize) return finalize(env);
        } catch (error) {
          this.rollbackDiscoveryV2(pending);
          restoreClinical(); restoreDiscovery();
          if (!input.cursor && error instanceof GatewayFault && error.code === 'DISCOVERY_EXPIRED') {
            throw new GatewayFault('CONNECTION_REQUIRED', 'The source connection changed during discovery; repeat it after reconnecting.', true);
          }
          throw error;
        }
        return env;
      } catch (error) {
        this.rollbackDiscoveryV2(pending);
        throw error;
      }
    });
  }

  /** Release the handles a failed admitted call stored. Uniform admission and
   * final-delivery gating happen elsewhere; this retains trusted work on faults. */
  private rollbackDiscoveryV2(pending: { clinical: string[]; discovery: string[] }): void {
    for (const handle of pending.clinical) this.store.release(handle);
    for (const handle of pending.discovery) this.discoveryStore.release(handle);
  }

  private discoveryBindingV2(): DiscoveryBinding {
    return { sourceAlias: this.config.source.alias, contextHandle: this.contextId,
      policyRevision: this.policyRevision, authEpoch: this.authEpoch,
      sourceRevision: `${this.capabilityRevision}:${this.stateGeneration}` };
  }

  private supportV2(resourceType?: string) {
    const capabilities = [...(this.capabilities?.values() ?? [])].filter(c => !c.ambiguous);
    const confinementExecutable = new Set<string>();
    for (const c of capabilities) {
      if (resourceClass(c.type) !== 'patient' || c.type === 'Patient') continue;
      const resolved = resolveSearchParameters({ resourceType: c.type, declared: c.declared, advertised: true });
      try { if (confinementFor(c.type, resolved, this.config.patientId)) confinementExecutable.add(c.type); }
      catch (error) { if (!(error instanceof GatewayFault) || !['SEARCH_PARAMETER_UNRESOLVED', 'UNSUPPORTED_CONFINEMENT'].includes(error.code)) throw error; }
    }
    return effectiveSupport({ advertised: capabilities, confinementExecutable, resourceType }).map(row => withSharedIdentifierSummary({ ...row,
      executable_interactions: UNSUPPORTED_CLINICAL_RESOURCES.has(row.resource_type) ? [] : row.executable_interactions }, this.config.privacy?.sharedIdentifierSystems?.length ?? 0));
  }

  private describeV2(admission: Admission02<'fhir_capabilities'>, env: GatewayEnvelope02,
    delivery: DeliveryContext, pending: { clinical: string[]; discovery: string[] }): ValidationContext02['metadata'] {
    const input = admission.input;
    const metadataDelivery = { ...delivery, tool: 'fhir_capabilities' as const };
    const classification = { network_confinement: 'literal_loopback' as const,
      data_classification: 'operator_declared_synthetic_unverified' as const };
    const workflow = workflowSupport();
    const binding = this.discoveryBindingV2();
    const metadataCoverage = (more: boolean) => {
      const evidence: QueryEvidence = { constraints: [], materialFilterProved: true, evidenceKind: 'metadata_snapshot' };
      return coverageForSnapshot(evidence, { deliveredCount: 0, pagesObserved: 0, queryEvidence: evidence,
        sortProof: 'none', remainder: more ? 'local' : 'none', exhausted: !more, scope: 'metadata', authorizationLimited: false });
    };
    const fit = () => {
      // Fit against the largest safe elapsed integer, in the model copy and on the wire.
      // finish writes the actual elapsed value only after metadata packing.
      const elapsed = env.budget.elapsed_ms;
      try { env.budget.elapsed_ms = Number.MAX_SAFE_INTEGER; this.bytesV2(env, metadataDelivery); return !exceedsByteBudget(env.budget); }
      finally { env.budget.elapsed_ms = elapsed; this.bytesV2(env, metadataDelivery); }
    };
    const failFit = () => { throw new GatewayFault('OUTPUT_LIMIT', 'Metadata cannot fit this budget; narrow discovery or request a larger allowed budget.'); };
    let byteLimited = false;
    const markByteLimited = () => {
      byteLimited = true;
      env.budget.limit_reached = true;
      env.warnings = this.warningsV2([...env.warnings, { code: 'METADATA_BYTE_LIMIT', message: WARNING_MESSAGES.METADATA_BYTE_LIMIT! }]);
    };
    if (input.topic === 'server' || input.topic === 'search_parameter' || input.topic === 'support') {
      const topic = input.topic;
      let snapshot: DiscoverySnapshotValue;
      if (input.cursor) snapshot = readDiscoverySnapshot(this.discoveryStore, input.cursor, binding, topic).value;
      else {
        const capturedAt = new Date().toISOString(), expiresAt = new Date(this.metadataExpiresAt).toISOString();
        const common = { binding, revision: this.capabilityRevision, capturedAt, expiresAt };
        if (topic === 'search_parameter') {
          const c = this.capabilities?.get(input.resource_type!);
          if (!c || c.ambiguous || UNSUPPORTED_CLINICAL_RESOURCES.has(c.type)) throw new GatewayFault('UNSUPPORTED_RESOURCE', 'Resource type is not available to this workload.');
          const parameters = filterSearchParameters(resolveSearchParameters({ resourceType: c.type, declared: c.declared, advertised: true }).parameters, input);
          snapshot = { ...common, topic, resourceType: c.type, filter: { name: input.name, query: input.query }, parameters, totalParameters: parameters.length };
        } else if (topic === 'support') snapshot = { ...common, topic, resourceType: input.resource_type, rows: this.supportV2(input.resource_type) };
        else {
          const supported = new Map(this.supportV2().map(row => [row.resource_type, row]));
          const rows = [...(this.capabilities?.values() ?? [])].map(c => ({ type: c.type, resource_class: resourceClass(c.type),
            implemented_interactions: c.ambiguous ? [] : supported.get(c.type)?.executable_interactions ?? [] }));
          const priority = (type: string, executable: boolean) => {
            const required = workflow.required_resources.indexOf(type as 'Patient' | 'Observation');
            return required >= 0 ? required : supported.get(type)?.workflow_role === 'optional' ? 2 : executable ? 3 : 4;
          };
          rows.sort((a, b) => priority(a.type, a.implemented_interactions.length > 0) - priority(b.type, b.implemented_interactions.length > 0)
            || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
          snapshot = { ...common, topic, rows };
        }
      }
      const offset = snapshot.offset ?? 0;
      const rows = snapshot.topic === 'search_parameter' ? snapshot.parameters : snapshot.rows;
      const limit = Math.min(input.limit, topic === 'support' ? 25 : 50);
      let count = Math.min(limit, rows.length - offset);
      const makeData = (cursor?: string) => {
        const common = { snapshot_revision: snapshot.revision, captured_at: snapshot.capturedAt, expires_at: snapshot.expiresAt,
          ...(cursor ? { next_cursor: cursor } : {}) };
        return snapshot.topic === 'search_parameter'
          ? { ...common, resource_type: snapshot.resourceType, search_parameters: snapshot.parameters.slice(offset, offset + count),
            total_parameters: snapshot.totalParameters, definitions: { ...SEARCH_PARAMETER_DEFINITIONS } }
          : snapshot.topic === 'support'
          ? { ...common, workflow: workflow.workflow, matrix_revision: workflow.matrix_revision, clinical_sections: [...workflow.clinical_sections],
            document_support: workflow.document_support, rows: snapshot.rows.slice(offset, offset + count), default_policy: 'deny_unclassified' as const }
          : { ...common, ...classification, source: this.config.source.alias, fhir_version: this.fhirVersion, patient_id: this.config.patientId,
            implemented_tools: [...TOOL_NAMES], resources: snapshot.rows.slice(offset, offset + count), resource_count: snapshot.rows.length,
            definition_limit: 100, workflow: workflow.workflow, support_matrix_revision: SUPPORT_MATRIX_REVISION,
            required_resources: [...workflow.required_resources], document_support: workflow.document_support };
      };
      // Reserve cursor, freshness and warning costs before allocation; advancement uses the fitted count.
      while (true) {
        const more = offset + count < rows.length;
        env.data = makeData(more ? `cur_${'x'.repeat(32)}` : undefined);
        env.coverage = metadataCoverage(more);
        if (topic === 'server' && more) env.coverage.reasons = ['DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION', 'CAPABILITY_SUMMARY_LIMIT'];
        if (fit()) break;
        if (count <= 1) failFit();
        count--; markByteLimited();
      }
      let nextCursor: string | undefined, nextOffset: number | undefined;
      if (offset + count < rows.length) {
        const next = { ...snapshot, offset: offset + count };
        const retained = next.topic === 'search_parameter'
          ? freezeSearchParameterSnapshot(this.discoveryStore, next, Date.parse(next.expiresAt))
          : next.topic === 'support' ? freezeSupportSnapshot(this.discoveryStore, next, Date.parse(next.expiresAt))
          : freezeServerSnapshot(this.discoveryStore, next, Date.parse(next.expiresAt));
        pending.discovery.push(retained.handle);
        nextCursor = retained.handle;
        nextOffset = readDiscoverySnapshot(this.discoveryStore, nextCursor, binding, topic).value.offset;
        env.data = makeData(nextCursor);
        if (!fit()) failFit();
      }
      return freezeDeliveryState({ topic, rows: cloneFhirValue(rows), start: offset, offset, total: rows.length, limit,
        deliveredCount: count, nextCursor, nextOffset, revision: snapshot.revision, capturedAt: snapshot.capturedAt, expiresAt: snapshot.expiresAt, byteLimited });
    }
    if (input.resource_type && this.capabilities?.get(input.resource_type)?.ambiguous) throw new GatewayFault('INVALID_RESPONSE', 'Source capability declarations for this resource are ambiguous.');
    if (input.topic === 'schema') {
      if (!input.resource_type || !this.capabilities?.has(input.resource_type)) throw new GatewayFault('UNSUPPORTED_RESOURCE', 'Resource type is not advertised by this source.');
      const page = JSON.parse(JSON.stringify(schemaPage(input.resource_type, input.path, input.offset, input.limit))) as ReturnType<typeof schemaPage>;
      const rows = cloneFhirValue(page.elements);
      while (true) {
        const next = input.offset + page.elements.length, more = next < page.total_elements;
        env.data = { ...page, ...(more ? { next_offset: next } : {}) };
        env.coverage.state = more ? 'partial' : 'complete_for_query';
        env.coverage.query_exhausted = !more;
        env.coverage.reasons = ['R4_BASE_DEFINITION_NOT_ENDPOINT_PROFILE_VALIDATION', ...(more ? ['MORE_DEFINITION_ELEMENTS'] : [])];
        if (fit()) return freezeDeliveryState({ topic: 'schema' as const, rows, start: 0, offset: input.offset, total: page.total_elements,
          limit: input.limit, deliveredCount: page.elements.length, byteLimited });
        if (page.elements.length <= 1) failFit();
        page.elements.pop(); markByteLimited();
      }
    }
    if (input.topic === 'context') env.data = { ...classification, mode: 'patient-bound', context_handle: this.contextId,
      patient_id: this.config.patientId, support_matrix_revision: SUPPORT_MATRIX_REVISION };
    else if (input.topic === 'resource') {
      const c = this.capabilities?.get(input.resource_type!);
      if (!c) throw new GatewayFault('UNSUPPORTED_RESOURCE', 'Resource type is not advertised by this source.');
      const support = this.supportV2(c.type)[0]!;
      env.data = { ...classification, type: c.type, interactions: c.interactions.slice(0, 16),
        searchParameters: listedSearchParameters(c.type, c.declared).names.slice(0, 256), resource_class: resourceClass(c.type), evidence: 'declared',
        implemented_interactions: support.executable_interactions, instance_policy: support.instance_policy,
        compact_recipe: support.compact_recipe, limitations: support.limitations, support_matrix_revision: SUPPORT_MATRIX_REVISION };
    }
    if (!fit()) failFit();
  }

  private source() { return { alias: this.config.source.alias, fhir_version: this.fhirVersion, capability_revision: this.capabilityRevision }; }
  private audit(tool: ToolName, envelope: GatewayEnvelope, outcome: AuditEvent['outcome'], cause?: string) {
    cause ??= [...envelope.coverage.reasons.filter(reason => reason === 'ENTRY_ORIGIN_MISMATCH' || reason === 'INVALID_RESOURCE_ID' || reason === 'RECORDS_WITHHELD_BY_POLICY' || reason === 'SHARED_RECORDS_WITHHELD_BY_POLICY'),
      ...(this.candidateWorkV2.getStore()?.redactionSelfCheckFailed ? ['REDACTION_SELF_CHECK_FAILED'] : [])].join(',') || undefined;
    this.auditEvents.push({ request_id: envelope.request_id, tool, source: this.config.source.alias, outcome, ...(envelope.error ? { code: envelope.error.code } : {}), ...(cause ? { cause } : {}), timestamp: new Date().toISOString() });
    if (this.auditEvents.length > 200) this.auditEvents.splice(0, this.auditEvents.length - 200);
  }

  /** Race a shared flight against this caller's own signal/deadline; the flight itself is never cancelled by one waiter. */
  private async raceBudget<T>(promise: Promise<T>, budget: RequestBudget): Promise<T> {
    if (!budget.signal && budget.deadline === undefined) return promise;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => { cleanup(); reject(new GatewayFault('REQUEST_CANCELLED', 'The request was cancelled.')); };
      const remaining = budget.deadline === undefined ? undefined : budget.deadline - Date.now();
      const timer = remaining === undefined ? undefined : setTimeout(() => { cleanup(); reject(new GatewayFault('UPSTREAM_TIMEOUT', 'The request deadline was reached.', true)); }, Math.max(remaining, 0));
      const cleanup = () => { budget.signal?.removeEventListener('abort', onAbort); if (timer) clearTimeout(timer); };
      if (budget.signal?.aborted) { onAbort(); return; }
      budget.signal?.addEventListener('abort', onAbort, { once: true });
      promise.then(value => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error as Error); });
    });
  }
  private async discover(stats: { calls: number }, budget: RequestBudget = {}): Promise<void> {
    this.throwIfCancelled(budget);
    // A failed refresh installs/evicts nothing. Stale metadata cannot authorize new upstream work;
    // retained local views remain usable without discovery, under their existing absolute expiry.
    if (this.capabilities && this.capabilityPolicyRevision === this.policyRevision && Date.now() < this.metadataExpiresAt) return;
    // Key flights by both credential epoch and state generation. A late old flight
    // must neither attract new waiters nor detach a newer flight when it completes.
    if (!this.metadataLoading || this.metadataLoading.epoch !== this.authEpoch || this.metadataLoading.generation !== this.stateGeneration) {
      const epoch = this.authEpoch;
      const generation = this.stateGeneration;
      const policyRevision = this.policyRevision;
      const promise = (async () => {
        const metadata = await this.transport.get(this.transport.url('metadata'), stats, {});
        if (epoch !== this.authEpoch || generation !== this.stateGeneration || policyRevision !== this.policyRevision || this.closed) throw new GatewayFault('CONNECTION_REQUIRED', 'The source connection changed during discovery; repeat it after reconnecting.', true);
        // The version is echoed into every envelope, so it must be strictly bounded before it is cached.
        if (metadata.resourceType !== 'CapabilityStatement' || typeof metadata.fhirVersion !== 'string' || !/^4\.0\.\d{1,3}$/.test(metadata.fhirVersion)) throw new GatewayFault('UNSUPPORTED_FHIR_VERSION', 'This prototype requires a FHIR R4 CapabilityStatement.');
        if (metadata.rest !== undefined && !Array.isArray(metadata.rest)) throw new GatewayFault('INVALID_RESPONSE', 'Source capability REST declarations are malformed.');
        const servers = (metadata.rest ?? []).filter((rest: unknown) => rest && typeof rest === 'object' && (rest as { mode?: unknown }).mode === 'server');
        if (servers.length > 1) throw new GatewayFault('INVALID_RESPONSE', 'Source capability server declarations are ambiguous.');
        const resource = servers[0]?.resource;
        if (resource !== undefined && !Array.isArray(resource)) throw new GatewayFault('INVALID_RESPONSE', 'Source capability resource declarations are malformed.');
        const entries = (resource ?? []) as { type: string; interaction?: { code: string }[]; searchParam?: unknown }[];
        const capabilities = new Map<string, ResourceCapability>();
        for (const entry of entries) {
          if (typeof entry.type !== 'string' || !isFhirResourceType(entry.type)) continue;
          // Refuse only the repeated type, independently of declaration order/count.
          // The marker makes entering/leaving ambiguity material even for an empty declaration.
          if (capabilities.has(entry.type)) {
            capabilities.set(entry.type, { type: entry.type, ambiguous: true, interactions: [], searchParameters: [], searchParamTypes: {}, declared: [], resolvedParameters: new Map() });
            continue;
          }
          // Only the first MAX_SEARCH_PARAM_DECLARATIONS declarations are resolved, so a longer list cannot be
          // judged whole (a conflicting duplicate could sit past the bound). The type is ambiguous, never prefix-trusted;
          // the marker makes crossing the bound revision-material.
          if (Array.isArray(entry.searchParam) && entry.searchParam.length > MAX_SEARCH_PARAM_DECLARATIONS) {
            capabilities.set(entry.type, { type: entry.type, ambiguous: true, interactions: [], searchParameters: [], searchParamTypes: {}, declared: [], resolvedParameters: new Map() });
            continue;
          }
          const declared = declaredFromCapability(entry.searchParam, entry.type);
          const withheld = withheldCapabilityNames(entry.searchParam, entry.type);
          const previous = this.capabilities?.get(entry.type);
          // Keep the keyed digest private: public revisions must be repeatable
          // across fresh processes. Only a local set-change counter is hashed.
          const withheldNameRevision = (previous?.withheldNameRevision ?? 0)
            + (previous && previous.withheldNameDigest !== withheld.withheldNameDigest ? 1 : 0);
          capabilities.set(entry.type, {
            type: entry.type, interactions: (entry.interaction ?? []).map(i => i.code).filter(code => R4_TYPE_INTERACTIONS.has(code)),
            searchParameters: declared.map(param => param.name),
            searchParamTypes: Object.fromEntries(declared.filter(param => param.type !== undefined).map(param => [param.name, param.type!])),
            declared, ...withheld, withheldNameRevision, resolvedParameters: new Map(),
          });
        }
        const revision = normalizedCapabilityRevision(metadata.fhirVersion, [...capabilities.values()]);
        const identity = boundedSourceIdentity(metadata, metadata.fhirVersion, revision);
        const changed = this.capabilities && (revision !== this.capabilityRevision || !sameSourceIdentity(identity, this.sourceIdentity) || this.capabilityPolicyRevision !== policyRevision);
        if (changed) this.invalidateState();
        this.fhirVersion = metadata.fhirVersion;
        this.capabilityRevision = revision;
        this.sourceIdentity = identity;
        this.capabilities = capabilities;
        this.capabilityPolicyRevision = policyRevision;
        this.metadataExpiresAt = Date.now() + (this.config.discovery?.metadataTtlMs ?? 300000);
        return this.stateGeneration;
      })();
      const entry = { epoch, generation, promise };
      this.metadataLoading = entry;
      const settled = () => { if (this.metadataLoading === entry) this.metadataLoading = undefined; };
      promise.then(settled, settled);
    }
    const flight = this.metadataLoading;
    const installedGeneration = await this.raceBudget(flight.promise, budget);
    // Only callers of this exact refresh adopt its generation. An unrelated invalidation after
    // the flight settled must still refuse the waiter; never repin it to whatever is current.
    if (flight.epoch !== this.authEpoch || installedGeneration !== this.stateGeneration || this.closed
      || (budget.stateGeneration !== undefined && budget.stateGeneration !== flight.generation)) throw new GatewayFault('CONNECTION_REQUIRED', 'The source state changed during discovery; repeat it.', true);
    budget.stateGeneration = installedGeneration;
    this.throwIfCancelled(budget);
  }
  private capability(type: string, interaction: string) {
    assertClinicalResource(type);
    const capability = this.capabilities?.get(type);
    if (capability?.ambiguous) throw new GatewayFault('INVALID_RESPONSE', 'Source capability declarations for this resource are ambiguous.');
    if (!capability || !capability.interactions.includes(interaction)) throw new GatewayFault('UNSUPPORTED_INTERACTION', 'Requested resource interaction is not advertised.');
    if (resourceClass(type) === 'ambiguous') throw new GatewayFault('POLICY_DENIED', 'This resource class has no tested patient-linkage policy.');
    return capability;
  }
  private async read(input: DispatchInput, stats: { calls: number }, budget: RequestBudget, render: (snapshot: Snapshot, previous?: QueryEvidence) => GatewayEnvelope02) {
    const type = input.resource_type!;
    const id = input.id!;
    this.capability(type, 'read');
    if (['.', '..'].includes(id) || (type === 'Patient' && id !== this.config.patientId)) throw new GatewayFault('NOT_FOUND', 'Requested resource is not available.');
    // An unreachable directory record is the uniform NOT_FOUND, existing or not, and nothing is sent.
    if (isDirectoryType(type) && !this.verifiedTargets.reachable(type, id)) throw new GatewayFault('NOT_FOUND', 'Requested resource is not available.');
    let raw: FhirResource;
    try {
      const work = this.candidateWorkV2.getStore(); if (work) work.clinicalCalls++;
      raw = await this.transport.get(this.transport.url(`${type}/${encodeURIComponent(id)}`), stats, { ...budget, permission: { type, interaction: 'read' } }) as FhirResource;
    } catch (error) {
      // Until linkage is established, a direct read must not disclose existence through distinguishable
      // failures (410/other 4xx, oversized, malformed, decode/precision, redirects, and 2xx body-stage faults such
      // as truncation or bad content-encoding). Oversized bodies are denied uniformly rather than probed. The
      // precise cause survives only in the metadata-only audit. Timeouts (latency is already public via
      // elapsed_ms), cancellations and 5xx are not mapped: 5xx stays retryable.
      if (error instanceof GatewayFault && (PRE_AUTHORIZATION_READ_CODES.has(error.code)
        || error.code === 'UNSAFE_REDIRECT'
        || (error.code === 'UPSTREAM_ERROR' && error.status !== undefined && error.status >= 200 && error.status < 300)
        || (error.status !== undefined && error.status >= 400 && error.status < 500 && error.code !== 'CONNECTION_REQUIRED' && error.code !== 'RATE_LIMITED'))) {
        throw nonDisclosingReadFault(error);
      }
      throw error;
    }
    // An own record withheld by policy stays the uniform NOT_FOUND, like a foreign or missing one.
    if (raw.resourceType !== type || raw.id !== id || !/^[A-Za-z0-9.-]{1,64}$/.test(raw.id)) throw new GatewayFault('NOT_FOUND', 'Requested resource is not available.');
    const decision = authorizeRecord(raw, this.config.patientId, this.transport.base, this.config.privacy);
    if (decision.kind === 'silent' && decision.selfCheckFailed) this.noteRedactionSelfCheckFailed();
    if (decision.kind !== 'deliver') throw new GatewayFault('NOT_FOUND', 'Requested resource is not available.');
    // Precision faults surface only after authorization has established linkage.
    if (containsPrecisionFault(raw)) throw new GatewayFault('UNSUPPORTED_PRECISION', 'This prototype cannot preserve the source numeric representation; no rounded value was returned.');
    const record = this.sanitizeRecord(raw);
    if (!record) throw new GatewayFault('NOT_FOUND', 'Requested resource is not available.');
    this.noteVerifiedTarget(raw, budget);
    return render({ records: [record], offset: 0, type, suppressed: false, query: [] });
  }
  /**
   * Remember a patient-linked record that was just authorized (deliver) and sanitized as the bound patient's own
   * record, so a later search may name it as a reference target. Work begun before a state boundary records nothing.
   */
  private noteVerifiedTarget(raw: FhirResource, budget: RequestBudget): void {
    if (raw.resourceType === 'Patient' || resourceClass(raw.resourceType) !== 'patient' || typeof raw.id !== 'string') return;
    if ((budget.epoch ?? this.authEpoch) !== this.authEpoch || (budget.stateGeneration ?? this.stateGeneration) !== this.stateGeneration) return;
    this.verifiedTargets.add(raw.resourceType, raw.id);
  }
  /**
   * Commit the directory keys granted by an envelope that is being delivered. Called from
   * finish as its last step before commit, after the delivery checks, the state-boundary check and the audit, so a failed
   * or stale render grants nothing.
   */
  private noteReachable(env: GatewayEnvelope02): void {
    for (const key of this.pendingReachable.get(env) ?? []) this.verifiedTargets.addReachable(key.type, key.id);
  }
  /** All guards precede clinical URL construction; caller order and token escapes are untouched. */
  private prepareSearch(type: string, pairs: readonly QueryPair[], pageSize: number, verifiedTarget: VerifiedTargetCheck = (targetType, targetId) => this.verifiedTargets.has(targetType, targetId)): QueryPair[] {
    const capability = this.capability(type, 'search-type');
    let resolved = capability.resolvedParameters.get('generic-r4');
    if (!resolved) {
      resolved = resolveSearchParameters({ resourceType: type, declared: capability.declared, advertised: true });
      capability.resolvedParameters.set('generic-r4', resolved);
    }
    const { materialPairs, sortRequested } = validateSearchSyntax({ resourceType: type, pairs, resolved, withheldNamesPresent: (capability.withheldNameCount ?? 0) > 0 });
    const confinement = confinementFor(type, resolved, this.config.patientId);
    try {
      validatePatientSelectors({ resourceType: type, pairs: materialPairs, resolved, patientId: this.config.patientId, base: this.transport.base, confinementName: confinement?.name });
    } catch (error) {
      // Ambiguous reference probes share one public denial with known/missing foreign targets.
      if (error instanceof GatewayFault && error.code === 'AMBIGUOUS_PATIENT_SELECTOR') throw new GatewayFault('POLICY_DENIED', 'Patient selector conflicts with the trusted context.');
      throw error;
    }
    validateSearchAdmission({ resourceType: type, pairs: materialPairs, resolved, patientId: this.config.patientId, confinementName: confinement?.name, privacy: this.config.privacy, sort: sortRequested,
      verifiedTarget, reachable: (targetType, targetId) => this.verifiedTargets.reachable(targetType, targetId) });
    for (const pair of materialPairs) {
      if ((pair.name === 'patient' || pair.name === 'subject') && ![this.config.patientId, `Patient/${this.config.patientId}`].includes(pair.value)) throw new GatewayFault('POLICY_DENIED', 'Patient selector conflicts with the trusted context.');
      if (type === 'Patient' && pair.name === '_id' && pair.value !== this.config.patientId) throw new GatewayFault('POLICY_DENIED', 'Patient selector conflicts with the trusted context.');
      // Keep the old veto as an additional guard. Source declarations never choose its type.
      const selectionType = resolved.byName.get(pair.name)?.pinnedType ?? 'reference';
      if (foreignPatientSelector(pair.value, this.config.patientId, this.transport.base, selectionType)) throw new GatewayFault('POLICY_DENIED', 'Patient selector conflicts with the trusted context.');
    }
    return [
      ...materialPairs,
      ...(confinement ? [confinement] : []),
      ...(sortRequested.length ? [{ name: '_sort', value: sortRequested.join(',') }] : []),
      { name: '_count', value: String(pageSize) },
    ];
  }
  /** Validated original application ceiling, independent of opaque source page mechanics. */
  private requestedPageSizeV2(snapshot: Snapshot): number {
    const count = snapshot.query.at(-1);
    if (count?.name !== '_count' || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(count.value)) throw new GatewayFault('UNVERIFIED_CONTINUATION', 'Frozen search state is invalid.');
    return Number(count.value);
  }
  /** Replay the ORIGINAL frozen query, never next-link values as new caller predicates. */
  private validateFrozenSearch(type: string, query: readonly QueryPair[]): void {
    const caller = query.map(pair => ({ ...pair }));
    const count = caller.pop();
    if (count?.name !== '_count' || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(count.value)) throw new GatewayFault('UNVERIFIED_CONTINUATION', 'Frozen search state is invalid.');
    // Initial outbound order is material, trusted latch, optional rebuilt sort, count.
    if (resourceClass(type) === 'patient') {
      const latchIndex = caller.length - (caller.at(-1)?.name === '_sort' ? 2 : 1);
      if (latchIndex < 0) throw new GatewayFault('UNVERIFIED_CONTINUATION', 'Frozen search state is invalid.');
      caller.splice(latchIndex, 1);
    }
    const rebuilt = this.prepareSearch(type, caller, Number(count.value));
    if (stringifyFhir(rebuilt) !== stringifyFhir(query)) throw new GatewayFault('UNVERIFIED_CONTINUATION', 'Frozen search state is invalid.');
  }
  private async search(input: DispatchInput, stats: { calls: number }, budget: RequestBudget, render: (snapshot: Snapshot, previous?: QueryEvidence) => GatewayEnvelope02) {
    const type = input.resource_type!;
    await this.confirmReferenceTargets(type, input.params ?? [], input.page_size ?? 20, stats, budget);
    const params = this.prepareSearch(type, input.params ?? [], input.page_size ?? 20).map(pair => Object.freeze({ ...pair }));
    Object.freeze(params);
    const url = this.transport.url(type);
    url.search = new URLSearchParams(params.map(pair => [pair.name, pair.value])).toString();
    const snapshot = await this.fetchPage(url, type, params, stats, true, budget);
    return render(snapshot);
  }
  /**
   * A patient-linked reference target that is not yet in the delivered ledger is checked with the
   * confined search `<Type>?_id=<id>&<confinement>=Patient/<bound>`, through the same admission, transport, authorization and
   * sanitize path as any agent search (never a direct read). It is exactly a search the agent could run itself. Admission first
   * runs with unverified targets provisionally accepted, so every other refusal still comes first and sends nothing. A target
   * enters the ledger only when that search delivers exactly the requested record as the bound patient's own. Any other outcome
   * (foreign, missing, withheld, unsupported type, upstream error) is one POLICY_DENIED, and the original search is never sent.
   */
  private async confirmReferenceTargets(type: string, pairs: readonly QueryPair[], pageSize: number, stats: { calls: number }, budget: RequestBudget): Promise<void> {
    const pending = new Map<string, { type: string; id: string }>();
    this.prepareSearch(type, pairs, pageSize, (targetType, targetId) => {
      if (!this.verifiedTargets.has(targetType, targetId)) pending.set(`${targetType}/${targetId}`, { type: targetType, id: targetId });
      return true;
    });
    for (const target of pending.values()) {
      let confirmed = false;
      try { confirmed = await this.confirmOwnTarget(target.type, target.id, stats, budget); }
      catch (error) {
        // A target type outside the SMART grant keeps its own cause; nothing was sent.
        if (error instanceof GatewayFault && error.cause === 'SCOPE_NOT_GRANTED') throw error;
        confirmed = false;
      }
      if (!confirmed) throw new GatewayFault('POLICY_DENIED', 'Patient selector conflicts with the trusted context.');
    }
  }
  /**
   * One confined `_id` search. The requested key enters the ledger only when the search delivered exactly one record and it is
   * the requested one (the page's records were already authorized and sanitized as the bound patient's own); the page itself
   * records nothing. True only when the key is then in the ledger (a state boundary during the search records nothing).
   */
  private async confirmOwnTarget(type: string, id: string, stats: { calls: number }, budget: RequestBudget): Promise<boolean> {
    const params = this.prepareSearch(type, [{ name: '_id', value: id }], 1);
    const url = this.transport.url(type);
    url.search = new URLSearchParams(params.map(pair => [pair.name, pair.value])).toString();
    const snapshot = await this.fetchPage(url, type, params, stats, true, budget, undefined, false);
    if (snapshot.records.length !== 1) return false;
    if (snapshot.records[0]!.resource.resourceType !== type || snapshot.records[0]!.resource.id !== id) return false;
    this.noteVerifiedTarget({ resourceType: type, id }, budget);
    return this.verifiedTargets.has(type, id);
  }
  /** Only the non-exported gateway constructor test-options channel calls this bridge. */
  private installQueryCandidate(candidate?: SearchProfile): void {
    if (candidate) (this.profileState as unknown as { setCandidateForTest(profile: SearchProfile, privateCandidate: boolean): void }).setCandidateForTest(candidate, true);
  }
  private selectedProfile(): SearchProfile | undefined {
    return this.profileState.profile(this.testOptions?.testQueryProfile?.id ?? this.config.source.searchProfile, this.sourceIdentity);
  }
  /** `fireboat login` only: the standalone-launch sign-in. Never called by the serving process. */
  async smartLogin(io: LoginIo): Promise<LoginResult> {
    if (!(this.credentials instanceof SmartStandaloneProvider)) throw new GatewayFault('INVALID_CONFIG', 'Sign-in needs smart_standalone_launch auth.');
    return this.credentials.signIn(io);
  }
  /** `fireboat logout` only: the stored standalone grant's file path. */
  smartTokenFile(): string | undefined {
    return this.credentials instanceof SmartStandaloneProvider ? this.credentials.tokenFile : undefined;
  }
  /** For doctor: whether the current grant permits `interaction` on `type`. Sends nothing; always true without a SMART grant. */
  grantPermits(type: string, interaction: 'read' | 'search'): boolean {
    return this.credentials ? this.credentials.allows(type, interaction) : true;
  }
  /** Closed SMART discovery and grant summary for doctor (enumerations and counts only); undefined without SMART auth. */
  async describeSmartStatus(): Promise<SmartDoctorStatus | undefined> {
    return this.credentials ? this.credentials.doctorStatus() : undefined;
  }
  /** Read-only operator values, taken from the same normalized policy used for execution. */
  describeOperatorPolicy(): Readonly<{ defaultFormat: 'fhir'; delivery: 'full-text-v1' | 'structured-evidence-v1'; defaultBytes: number; maxBytes: number; ttlMs: number; retentionBytes: number }> {
    return this.operatorPolicy;
  }
  /** Whether the selected search profile proves execution against the discovered source (doctor; trusted state only). */
  describeSearchProfile(): { id: string; eligible: boolean; proving: boolean; private: boolean } {
    const id = this.testOptions?.testQueryProfile?.id ?? this.config.source.searchProfile ?? 'generic-r4';
    return { id, eligible: eligibleSearchProfileIds().includes(id), proving: this.selectedProfile() !== undefined, private: this.testOptions?.testQueryProfile !== undefined };
  }
  /** Reconstruct current proof from immutable evidence plus small per-branch flags. Never upgrade. */
  private currentQueryEvidence(snapshot: Snapshot): QueryEvidence | undefined {
    const original = snapshot.queryEvidence;
    if (!original) return undefined;
    const overlay = snapshot.queryOverlay;
    const profile = this.selectedProfile();
    let evidence: QueryEvidence = { ...original, ...overlay?.queryEvidence, constraints: original.constraints.map((entry, index) => {
      const current = { ...entry, ...overlay?.constraintProof?.[index] };
      if (current.execution === 'tested_adapter' && (!profile || current.evidence_ref !== `${profile.id}@${profile.version}`)) {
        return { ...current, execution: 'unknown' as const, evidence_ref: undefined };
      }
      return current.execution === 'tested_adapter' ? current : { ...current, evidence_ref: undefined };
    }) };
    // An invalidated profile cannot be resurrected by a loaded cursor or retained result replay.
    if (!profile && evidence.sort) evidence = { ...evidence, sort: { ...evidence.sort, effective: null, order: 'requested_unverified' } };
    evidence.materialFilterProved = evidence.constraints.every(entry => entry.execution !== 'unknown');
    if (!evidence.materialFilterProved && evidence.evidenceKind !== RECORD_CHECKED_EVIDENCE_KIND) evidence.evidenceKind = 'declared_and_self_link_only';
    return evidence;
  }
  private queryOverlay(evidence: QueryEvidence, previous?: QueryOverlay): QueryOverlay {
    return { deliveredCount: previous?.deliveredCount ?? 0, pagesObserved: (previous?.pagesObserved ?? 0) + 1,
      queryEvidence: { ...evidence, constraints: [] },
      constraintProof: evidence.constraints.map(({ source_reported, execution }) => ({ source_reported, execution })),
      sortProof: evidence.sort?.order === 'verified_by_adapter' ? 'claimed' : 'none',
      ...(previous?.refused ? { refused: true, refusalReasons: previous.refusalReasons } : {}),
      ...(previous?.sortBoundary !== undefined ? { sortBoundary: previous.sortBoundary } : {}),
      ...(previous?.sortBoundaryPrecision ? { sortBoundaryPrecision: previous.sortBoundaryPrecision } : {}) };
  }
  /** Uses exactly transport URL normalization and confinement; never fetches or resolves an entry. */
  private entryOriginMatches(fullUrl: unknown, resource: FhirResource | undefined): boolean {
    if (!resource) return false;
    if (typeof fullUrl !== 'string' || typeof resource.id !== 'string') return false;
    try { return this.transport.validate(fullUrl).href === this.transport.url(`${resource.resourceType}/${resource.id}`).href; }
    catch { return false; }
  }
  private async fetchPage(url: URL, type: string, query: Snapshot['query'], stats: { calls: number }, verifySelf: boolean, budget: RequestBudget = {}, previous?: Snapshot, noteTargets = true): Promise<Snapshot> {
    // Every search (agent searches, reference-target confirmations and continuations) needs `s` on its type under a
    // SMART grant; it is refused before sending. Other credentials have no grant to check (allows() is always true).
    if (this.credentials && !this.credentials.allows(type, 'search')) throw new GatewayFault('POLICY_DENIED', 'The granted scope does not permit this resource type.', false, undefined, 'SCOPE_NOT_GRANTED');
    const work = this.candidateWorkV2.getStore(); if (work) work.clinicalCalls++;
    const bundle = await this.transport.get(url, stats, { ...budget, permission: { type, interaction: 'search' } });
    this.throwIfCancelled(budget);
    if (bundle.resourceType !== 'Bundle' || bundle.type !== 'searchset') throw new GatewayFault('INVALID_RESPONSE', 'Search did not return a searchset Bundle.');
    // Only an absent entry or link list is absent. A list that is an object, a string or null, or that holds a
    // non-object, is a malformed response: refused, never read as an empty, complete or exhausted page.
    const jsonObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
    if ((bundle.entry !== undefined && !Array.isArray(bundle.entry)) || (bundle.link !== undefined && !(Array.isArray(bundle.link) && bundle.link.every(jsonObject)))) throw new GatewayFault('INVALID_RESPONSE', 'Search returned malformed Bundle entries or links.');
    const links = Array.isArray(bundle.link) ? bundle.link as { relation?: string; url?: string }[] : [];
    // Link relations compare case-insensitively (RFC 8288). Anything other than exactly one usable next
    // relation is non-continuable, never exhaustion.
    const nextLinks = links.filter(link => typeof link?.relation === 'string' && link.relation.toLowerCase() === 'next');
    const records: Sanitized[] = [];
    const rawMatches: FhirResource[] = [];
    // Authorized source order includes per-record refusals: withholding cannot hide false proof.
    const checked: FhirResource[] = [];
    const partialReasons = new Set<NonNullable<Snapshot['partialReasons']>[number]>(previous?.partialReasons);
    let suppressed = false;
    let precisionRefused = false;
    let sourceIncomplete = false;
    const unverifiedFilters = new Set<string>();
    const outcomeCodes = new Set<string>();
    // Match entries the source returned on this page (suppressed or not), for the continuation offset arithmetic.
    let returnedMatches = 0;
    for (const entry of (Array.isArray(bundle.entry) ? bundle.entry : []) as { fullUrl?: unknown; resource?: FhirResource; search?: { mode?: string } }[]) {
      if (!jsonObject(entry) || (entry.resource !== undefined && !(jsonObject(entry.resource) && typeof entry.resource.resourceType === 'string'))) throw new GatewayFault('INVALID_RESPONSE', 'Search returned a malformed Bundle entry.');
      if (entry.search?.mode !== 'include' && entry.resource?.resourceType !== 'OperationOutcome') returnedMatches++;
      if (!entry.resource) {
        // A resourceless entry is undeliverable whether or not it names a fullUrl; it is never silently dropped.
        suppressed = true; partialReasons.add('ENTRY_ORIGIN_MISMATCH');
        continue;
      }
      if (entry.resource.resourceType === 'OperationOutcome') {
        // Classify by code/expression/severity; hard errors throw, benign warnings label the page.
        const issues = (Array.isArray(entry.resource.issue) ? entry.resource.issue : []) as OutcomeIssue[];
        const classified = classifyOutcomeIssues(issues, query);
        classified.unverifiedFilters.forEach(name => unverifiedFilters.add(name));
        classified.outcomeCodes.forEach(code => outcomeCodes.add(code));
        sourceIncomplete ||= classified.sourceIncomplete;
        continue;
      }
      // Denied entries are suppressed first; the origin label then judges only entries that would otherwise be
      // deliverable, so a denied entry's fullUrl cannot change public diagnostics. Withholding the bound patient's
      // own record makes the page partial; another patient's record, or explicit other-patient evidence, stays silent.
      if (entry.search?.mode === 'include' || entry.resource.resourceType !== type) { suppressed = true; continue; }
      // A directory record that is not reachable is dropped silently before it is judged, even when a
      // source ignores the `_id` filter, so neither its body nor a withheld signal can reach the agent.
      if (isDirectoryType(type) && !(typeof entry.resource.id === 'string' && this.verifiedTargets.reachable(type, entry.resource.id))) { suppressed = true; continue; }
      const decision = authorizeRecord(entry.resource, this.config.patientId, this.transport.base, this.config.privacy);
      if (decision.kind === 'own_withheld') partialReasons.add('RECORDS_WITHHELD_BY_POLICY');
      if (decision.kind === 'shared_withheld') partialReasons.add('SHARED_RECORDS_WITHHELD_BY_POLICY');
      if (decision.kind === 'silent' && decision.selfCheckFailed) this.noteRedactionSelfCheckFailed();
      if (decision.kind !== 'deliver') { suppressed = true; continue; }
      if (Object.hasOwn(entry, 'fullUrl') && !this.entryOriginMatches(entry.fullUrl, entry.resource)) { suppressed = true; partialReasons.add('ENTRY_ORIGIN_MISMATCH'); continue; }
      checked.push(entry.resource);
      if (Object.hasOwn(entry.resource, 'id') && (typeof entry.resource.id !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(entry.resource.id))) { suppressed = true; partialReasons.add('INVALID_RESOURCE_ID'); continue; }
      rawMatches.push(entry.resource);
      // Unpreservable numbers refuse that one authorized resource, never the whole page, and only post-authorization.
      if (containsPrecisionFault(entry.resource)) { precisionRefused = true; continue; }

    }
    const material = query.filter(pair => pair.name !== '_count' && pair.name !== '_sort');
    const sortRequested = query.find(pair => pair.name === '_sort')?.value.split(',') ?? [];
    const opaque = url.pathname !== this.transport.url(type).pathname && url.searchParams.has('_getpages');
    const self = links.find(link => link.relation === 'self')?.url;
    // A first page without a self link is judged by its records only when the operator
    // allows it; a page reached through the operator-declared continuation token, and every later page of a chain whose
    // first page was record-checked, is always judged by its records, so the inherited gateway_checked label stays true.
    const selfAbsent = verifySelf && !self;
    if (selfAbsent && !this.config.source.selfLinkOptional) throw new GatewayFault('UNVERIFIED_QUERY', 'Source did not provide effective-query evidence.');
    const recordChecked = selfAbsent || (Boolean(previous) && (carriesContinuationToken(url, this.config.source.continuationTokenParameter) || previous!.queryEvidence?.evidenceKind === RECORD_CHECKED_EVIDENCE_KIND));
    const selfUrl = self ? this.transport.validate(self) : undefined;
    const reported = selfUrl ? [...selfUrl.searchParams].map(([name, value]) => ({ name, value })) : null;
    if (verifySelf && reported && !queryEvidencePairsMatch(query.filter(pair => pair.name === '_count'), reported.filter(pair => pair.name === '_count'))) throw new GatewayFault('UNVERIFIED_QUERY', 'Source changed an exact query control.');
    const matched = matchSelfLink(material, reported, sortRequested);
    if (reported && !opaque && matched.materialMismatch) throw new GatewayFault('UNVERIFIED_QUERY', 'Source did not confirm the requested search constraints.');
    const profile = this.selectedProfile();
    const confinementIndex = resourceClass(type) === 'patient' ? material.length - 1 : -1;
    const enforcedIndices = gatewayEnforcedIndicesFor({ pairs: material, confinementIndex, confinementName: material[confinementIndex]?.name,
      resourceType: type, patientId: this.config.patientId, base: this.transport.base });
    const checkedPredicates = recordChecked ? this.recordPredicates(type, material, enforcedIndices, unverifiedFilters) : undefined;
    // A record-checked first page claims no profile execution and no order; an empty one checked nothing.
    const original = previous?.queryEvidence ?? buildQueryEvidence({ resourceType: type, pairs: material, sortRequested,
      sortVerified: !selfAbsent, selfPairs: reported, profile: selfAbsent ? undefined : profile,
      gatewayEnforcedIndices: enforcedIndices,
      ...(selfAbsent ? { gatewayCheckedIndices: new Set(checked.length ? checkedPredicates!.keys() : []), evidenceKind: RECORD_CHECKED_EVIDENCE_KIND } : {}),
      sourceRevision: this.capabilityRevision, policyRevision: this.policyRevision, contextHandle: this.contextId });
    if (!previous) {
      original.constraints.forEach(Object.freeze); Object.freeze(original.constraints);
      if (original.sort) { Object.freeze(original.sort.requested); if (original.sort.effective) Object.freeze(original.sort.effective); Object.freeze(original.sort); }
      Object.freeze(original);
    }
    let evidence = this.currentQueryEvidence({ ...previous, queryEvidence: original } as Snapshot)!;
    const continuationProved = !previous || (!opaque && url.searchParams.getAll('_offset').length === 1 && /^[0-9]+$/.test(url.searchParams.get('_offset')!) && !url.searchParams.has('_getpagesoffset') && !url.searchParams.has('_cursor') && !url.searchParams.has('_getpages') && Boolean(profile?.testedContinuations.includes('offset-next-link')));
    // A continuation page keeps the chain's evidence kind only when the proving profile
    // lists the continuation form, the requested offset equals the previous page's offset plus the match entries
    // that page returned (a skipped or repeated window is no proof), and the page reported a self link that
    // matched the material query AND carries exactly this request's offset with no other paging mechanics.
    // Once a chain has one unverified continuation the label is sticky: later pages never relabel or complete it.
    const pageOffset = previous ? Number(url.searchParams.get('_offset') ?? Number.NaN) : 0;
    const offsetConsistent = !previous || pageOffset === (previous.queryOverlay?.pageOffset ?? 0) + (previous.queryOverlay?.pageEntries ?? 0);
    const selfOffsets = reported?.filter(pair => pair.name === '_offset') ?? [];
    const selfPagingMatches = !previous || (reported !== null && selfOffsets.length === 1 && selfOffsets[0]!.value === url.searchParams.get('_offset')
      && !reported.some(pair => ['_getpages', '_getpagesoffset', '_cursor'].includes(pair.name)));
    const continuationVerified = continuationProved && offsetConsistent && selfPagingMatches;
    const chainUnverified = Boolean(previous) && (Boolean(previous!.queryOverlay?.continuationUnverified) || !continuationVerified);
    if (!continuationProved) for (const entry of evidence.constraints) if (entry.execution === 'tested_adapter') evidence = downgradeEvidence(evidence, entry.name);
    // A cross-page order proof needs a verified continuation: a skipped or repeated window, or a sticky unverified chain, carries no order.
    if (evidence.sort && (!continuationProved || chainUnverified || matched.sortReported !== 'matched')) evidence = { ...evidence, sort: { ...evidence.sort, effective: null, order: 'requested_unverified' } };
    const contradict = (): never => {
      if (profile) this.profileState.invalidate(profile.id);
      throw new GatewayFault('UNVERIFIED_QUERY', 'Returned evidence contradicted the claimed query execution.');
    };
    if (checkedPredicates) {
      const outcome = checkReturnedRecords([...checkedPredicates.values()], checked, this.transport.base);
      if (outcome.status === 'contradicted') contradict();
      if (outcome.status === 'uncheckable') throw new GatewayFault('UNVERIFIED_QUERY', 'Source did not provide effective-query evidence.');
      // An empty page proves nothing without a self link: an ignored or rejected filter looks the same as no match.
      if (selfAbsent && !checked.length) for (const pair of material) unverifiedFilters.add(pair.name);
    }
    // Each iteration removes all claims for the affected parameter, then checks the rest.
    for (;;) {
      const validation = validateReturnedPredicates(checked, evidence, type);
      if (validation.status === 'ok') break;
      if (validation.status === 'contradicted') contradict();
      evidence = downgradeEvidence(evidence, validation.parameter);
    }
    for (const name of unverifiedFilters) evidence = downgradeEvidence(evidence, name);
    const overlay = this.queryOverlay(evidence, previous?.queryOverlay);
    const sorted = validateSortPage(checked, sortRequested, type, previous?.queryOverlay?.sortBoundary, previous?.queryOverlay?.sortBoundaryPrecision);
    // Generic/previously downgraded semantics cannot assert a contradiction.
    if (evidence.sort?.order === 'verified_by_adapter' && sortVariantListed(profile, type, sortRequested)) {
      if (sorted.outcome.status === 'contradicted') contradict();
      if (sorted.outcome.status === 'unverifiable') {
        evidence = { ...evidence, sort: { ...evidence.sort, effective: null, order: 'requested_unverified' } };
        overlay.queryEvidence = { ...evidence, constraints: [] };
        overlay.sortProof = 'none';
      } else {
        overlay.sortBoundary = sorted.boundary;
        overlay.sortBoundaryPrecision = sorted.boundaryPrecision;
      }
    }
    // Projection/sanitization cannot hide a contradiction from the proof checks above.
    for (const raw of rawMatches) {
      if (containsPrecisionFault(raw)) continue;
      const record = this.sanitizeRecord(raw);
      if (record) { records.push(record); if (noteTargets) this.noteVerifiedTarget(raw, budget); } else suppressed = true;
    }
    // The next link is judged before it is ever fetched, but a bad link does not discard a page that
    // was independently validated and sanitized; it makes the delivered evidence non-continuable instead.
    let nextUrl: string | undefined;
    let nonContinuable = false;
    if (nextLinks.length === 1 && typeof nextLinks[0]!.url === 'string' && nextLinks[0]!.url) {
      try { nextUrl = this.continuation(nextLinks[0]!.url, type, query).href; }
      catch { nonContinuable = true; }
    } else if (nextLinks.length) nonContinuable = true;
    // In patient-bound mode the upstream `bundle.total` is never read — its presence/value would be a
    // suppression oracle. A verified first page with no next relation, no id/precision refusal and no source-reported
    // incompleteness publishes the gateway-delivered count instead, which has the same shape whether or not
    // anything was suppressed. Continuation-page totals are never taken.
    overlay.nonContinuable = nonContinuable;
    overlay.pageOffset = Number.isNaN(pageOffset) ? -1 : pageOffset;
    overlay.pageEntries = returnedMatches;
    overlay.continuationUnverified = chainUnverified;
    if (partialReasons.size || precisionRefused || sourceIncomplete) {
      overlay.refused = true;
      overlay.refusalReasons = [...new Set([...(previous?.queryOverlay?.refusalReasons ?? []), ...partialReasons, ...(precisionRefused ? ['UNSUPPORTED_PRECISION'] : []), ...(sourceIncomplete ? ['SOURCE_REPORTED_INCOMPLETE'] : [])])];
    }
    const publishTotal = verifySelf && !selfAbsent && !partialReasons.has('INVALID_RESOURCE_ID') && !precisionRefused && !sourceIncomplete && nextLinks.length === 0;
    return { records, offset: 0, type, suppressed, query, queryEvidence: original, queryOverlay: overlay, ...(partialReasons.size ? { partialReasons: [...partialReasons] } : {}), nextUrl, loaded: true, queryEvidenceKind: verifySelf || !chainUnverified ? 'declared_and_self_link_only' : 'unverified_continuation', ...(nonContinuable ? { nonContinuable } : {}), ...(precisionRefused ? { precisionRefused } : {}), ...(sourceIncomplete ? { sourceIncomplete } : {}), ...(outcomeCodes.size ? { outcomeCodes: [...outcomeCodes].sort() } : {}), ...(unverifiedFilters.size ? { unverifiedFilters: [...unverifiedFilters] } : {}), ...(publishTotal ? { total: records.length } : {}) };
  }
  /**
   * Pages without a self link: a record-checked page is accepted only when no
   * OperationOutcome questioned a parameter and every material occurrence is either gateway-enforced or a
   * gateway-checkable predicate (record-predicates.ts), keyed by occurrence index. Anything else refuses exactly as a
   * missing self link always has. The caller then checks every predicate on every authorized record.
   */
  private recordPredicates(type: string, material: readonly QueryPair[], enforced: ReadonlySet<number>, questioned: ReadonlySet<string>): Map<number, CheckablePredicate> {
    if (questioned.size) throw new GatewayFault('UNVERIFIED_QUERY', 'Source did not provide effective-query evidence.');
    const resolved = this.capabilities?.get(type)?.resolvedParameters.get('generic-r4');
    const predicates = new Map<number, CheckablePredicate>();
    material.forEach((pair, index) => {
      if (enforced.has(index)) return;
      const predicate = checkablePredicate(type, pair, resolved?.byName.get(pair.name)?.view.definition);
      if (!predicate) throw new GatewayFault('UNVERIFIED_QUERY', 'Source did not provide effective-query evidence.');
      predicates.set(index, predicate);
    });
    return predicates;
  }
  private continuation(link: string, type: string, query: Snapshot['query']): URL {
    this.validateFrozenSearch(type, query);
    const url = this.transport.validate(link);
    const resourcePath = this.transport.url(type).pathname;
    // The operator-declared token is the second, narrower paging exception (query.ts).
    const tokenName = this.config.source.continuationTokenParameter;
    if (carriesContinuationToken(url, tokenName)) { validateTokenContinuation({ url, resourcePath, tokenName: tokenName!, query }); return url; }
    const root = this.transport.base.pathname.replace(/\/$/, '');
    // The one tested query-bound opaque form (HAPI root _getpages) may omit the original constraints.
    const opaque = (url.pathname === root || url.pathname === `${root}/`) && url.searchParams.has('_getpages');
    if (url.pathname !== resourcePath && !opaque) throw new GatewayFault('UNSAFE_URL', 'Continuation must target the original resource or a supported opaque FHIR paging endpoint.');
    // Paging mechanics may vary (page size included); _cursor is accepted only under the same full-constraint rule.
    const paging = new Set(['_getpages', '_getpagesoffset', '_offset', '_count', '_bundletype', '_format', '_pretty', '_cursor']);
    const material = query.filter(pair => !paging.has(pair.name));
    for (const name of new Set(url.searchParams.keys())) {
      const original = material.filter(pair => pair.name === name);
      const reported = url.searchParams.getAll(name).map(value => ({ name, value }));
      if (original.length && !queryEvidencePairsMatch(original, reported)) throw new GatewayFault('UNVERIFIED_CONTINUATION', 'Continuation conflicts with the original requested constraints.');
      if (!original.length && !paging.has(name)) throw new GatewayFault('UNVERIFIED_CONTINUATION', 'Continuation introduces an unverified search constraint.');
    }
    // An ordinary resource-path link must retain every original material constraint; a dropped
    // patient/code/_id constraint rejects the link here, before any fetch could send the broadened query.
    if (!opaque) {
      for (const name of new Set(material.map(pair => pair.name))) {
        if (!url.searchParams.has(name)) throw new GatewayFault('UNVERIFIED_CONTINUATION', 'Continuation drops an original requested constraint.');
      }
    }
    return url;
  }
  private async page(input: DispatchInput, stats: { calls: number }, budget: RequestBudget, render: (snapshot: Snapshot, previous?: QueryEvidence) => GatewayEnvelope02) {
    if (!input.cursor?.startsWith('cur_')) throw new GatewayFault('RESULT_EXPIRED', 'Result is unavailable or expired; repeat the original query.');
    const cursor = input.cursor;
    // The served cursor stays protected from eviction until this call's render (which mints its successor) finishes,
    // including while it waits on a shared page load; a counter, because concurrent calls may serve the same cursor.
    this.servingCursors.set(cursor, (this.servingCursors.get(cursor) ?? 0) + 1);
    try { return await this.servePage(cursor, stats, budget, render); }
    finally {
      const left = (this.servingCursors.get(cursor) ?? 1) - 1;
      if (left > 0) this.servingCursors.set(cursor, left); else this.servingCursors.delete(cursor);
    }
  }
  private async servePage(cursor: string, stats: { calls: number }, budget: RequestBudget, render: (snapshot: Snapshot, previous?: QueryEvidence) => GatewayEnvelope02) {
    let { value } = this.store.get(cursor);
    if (!value.loaded && value.nextUrl) {
      const unloaded = value;
      await this.discover(stats, budget);
      // A material refresh destroyed the old cursor. Never fetch its frozen old query.
      value = this.store.get(cursor).value;
      this.validateFrozenSearch(value.type, value.query);
      // Another waiter's flight may have loaded this cursor during the await. Render that page; starting a
      // flight from the loaded page's next link would skip a page and re-point the cursor.
      if (value.loaded || !value.nextUrl) return render(value, this.currentQueryEvidence(unloaded));
      // The shared load runs on its own AbortController and the transport's own timeout, never on a
      // single waiter's signal/deadline. Each waiter races its own budget around the flight; the flight is
      // aborted only when its last waiter leaves (or on close()), so one waiter's cancellation cannot
      // cancel work another waiter still needs, and a sole waiter's abort still closes the upstream socket.
      let flight = this.pageLoads.get(cursor);
      if (!flight) {
        const controller = new AbortController();
        const created: { controller: AbortController; promise: Promise<void>; waiters: number } = { controller, waiters: 0, promise: Promise.resolve() };
        created.promise = (async () => {
          const flightBudget: RequestBudget = { signal: controller.signal, epoch: budget.epoch, stateGeneration: budget.stateGeneration };
          const snapshot = await this.fetchPage(this.transport.validate(value.nextUrl!), value.type, value.query, stats, false, flightBudget, value);
          this.throwIfCancelled(flightBudget);
          if (controller.signal.aborted) throw new GatewayFault('REQUEST_CANCELLED', 'The request was cancelled.');
          // Compare-and-set: install only onto the same unloaded snapshot this flight was started from.
          const current = this.store.get(cursor).value;
          if (current.loaded || current.nextUrl !== value.nextUrl) return;
          this.store.update(cursor, { ...snapshot, queryBinding: value.queryBinding, queryOverlay: undefined, expiresAt: value.expiresAt, suppressed: value.suppressed || snapshot.suppressed, precisionRefused: Boolean(value.precisionRefused || snapshot.precisionRefused), sourceIncomplete: Boolean(value.sourceIncomplete || snapshot.sourceIncomplete), outcomeCodes: [...new Set([...(value.outcomeCodes ?? []), ...(snapshot.outcomeCodes ?? [])])].sort(), unverifiedFilters: [...new Set([...(value.unverifiedFilters ?? []), ...(snapshot.unverifiedFilters ?? [])])], total: undefined }, { queryOverlay: snapshot.queryOverlay });
        })().finally(() => { if (this.pageLoads.get(cursor) === created) this.pageLoads.delete(cursor); });
        // Waiters observe the flight through raceBudget; this sink only keeps a flight whose waiters have
        // all left from surfacing as an unhandled rejection.
        created.promise.catch(() => undefined);
        flight = created;
        this.pageLoads.set(cursor, flight);
      }
      flight.waiters++;
      try { await this.raceBudget(flight.promise, budget); }
      finally {
        if (--flight.waiters === 0) {
          if (this.pageLoads.get(cursor) === flight) this.pageLoads.delete(cursor);
          flight.controller.abort();
        }
      }
    }
    return render(this.store.get(cursor).value, this.currentQueryEvidence(value));
  }
  /** Fail-safe: a judge/strict disagreement is dropped silently but leaves a metadata-only audit cause (no ids). */
  private noteRedactionSelfCheckFailed(): void {
    const work = this.candidateWorkV2.getStore();
    if (work) work.redactionSelfCheckFailed = true;
  }
  /** Undefined only when a redacted record fails its post-sanitize self-check (a judge bug path): it is then dropped silently and audited. */
  private sanitizeRecord(raw: FhirResource): Sanitized | undefined {
    const meta = raw.meta as Record<string, unknown> | undefined;
    const invalidVersion = meta !== null && typeof meta === 'object' && Object.hasOwn(meta, 'versionId')
      && (typeof meta.versionId !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(meta.versionId));
    let resource = raw;
    if (invalidVersion) {
      const { versionId: _invalidVersion, ...rest } = meta;
      resource = { ...raw, meta: rest };
    }
    const delivery = sanitizeForDelivery(resource, this.config.patientId, this.transport.base, this.config.privacy);
    if ('refused' in delivery) {
      if (delivery.refused.kind === 'silent' && delivery.refused.selfCheckFailed) this.noteRedactionSelfCheckFailed();
      return undefined;
    }
    const record = delivery.sanitized;
    if (invalidVersion) record.omitted.push('/meta/versionId');
    return record;
  }

}
