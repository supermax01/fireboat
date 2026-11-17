import type { FhirResource, GatewayConfig } from './contracts.js';
import { cloneFhirValue, integerValue, isFhirDecimal, isPrecisionFault } from './decimal.js';
import { elementNames, isFhirResourceType, isUriElement, resolveElement, resourceTypeContext, type ResolvedElement, type TypeContext } from './schema.js';

const links: Record<string, string> = { Observation: 'subject', Condition: 'subject', AllergyIntolerance: 'patient', MedicationRequest: 'subject', MedicationStatement: 'subject', Encounter: 'subject', DocumentReference: 'subject', DiagnosticReport: 'subject', Immunization: 'patient', Procedure: 'subject', Coverage: 'beneficiary', ExplanationOfBenefit: 'patient', ServiceRequest: 'subject', Claim: 'patient',
  MedicationAdministration: 'subject', MedicationDispense: 'subject', Specimen: 'subject', CarePlan: 'subject', CareTeam: 'subject', ImagingStudy: 'subject', Device: 'patient' };
const shared = new Set(['Medication', 'Organization', 'Location', 'Practitioner', 'CodeSystem', 'ValueSet', 'StructureDefinition', 'SearchParameter', 'CapabilityStatement', 'OperationDefinition']);
/**
 * Type-level class used for capability gating. Instance access additionally requires {@link sharedInstanceAllowed}.
 * Own keys only: a contained `resourceType` is upstream text, and an inherited Object.prototype name
 * (`__proto__`, `constructor`, `toString`, ...) must stay ambiguous, never a patient-linked class.
 */
export function resourceClass(type: string): 'patient' | 'shared' | 'ambiguous' { return type === 'Patient' || Object.hasOwn(links, type) ? 'patient' : shared.has(type) ? 'shared' : 'ambiguous'; }

/**
 * Shared-directory reachability: the directory types. Practitioner, Organization and Location
 * are delivered only when reachable, that is, named by a literal same-source reference in a record already delivered in this
 * context for the bound patient ({@link deliveredDirectoryReferences}). Medication and the conformance types are catalog data
 * and keep source-wide search.
 */
export const DIRECTORY_TYPES: ReadonlySet<string> = new Set(['Practitioner', 'Organization', 'Location']);
export function isDirectoryType(type: string): boolean { return DIRECTORY_TYPES.has(type); }

/** Enforcement's patient selector; Patient's search `_id` denotes its own resource id. */
export function patientLinkForType(type: string): string | null {
  return type === 'Patient' ? '_id' : Object.hasOwn(links, type) ? links[type]! : null;
}

// ---------------------------------------------------------------------------
// Shared-instance policy. A type name alone never makes an instance
// shared: each shared class has a versioned field/extension/profile policy.
// ---------------------------------------------------------------------------

/**
 * Documented synthetic catalog policy. It applies to the single configured
 * synthetic loopback source and pinned R4 4.0.1 base definitions. An instance
 * is shared only when its type has a rule, every root element is in that
 * rule's allowlist, it carries no extension/modifierExtension/implicitRules
 * outside contained resources, `meta.security` is absent, every
 * `meta.profile` is listed (none are listed in this synthetic policy; an operator
 * may list profiles in `privacy.sharedProfiles`, empty by default), and the
 * type-specific constraint holds. Anything else is unclassified and denied.
 */
export const SHARED_INSTANCE_POLICY = {
  id: 'fhir-mcp.synthetic-catalog', version: '2026-11-14.3', release: 'hl7.fhir.r4.core@4.0.1', source: 'configured synthetic loopback source',
  profiles: [] as readonly string[], extensions: [] as readonly string[],
  constraints: {
    Medication: 'Catalog products only: no batch; identifiers only in operator-listed product identifier systems (privacy.sharedIdentifierSystems, empty by default), as system, value and optional use (usual, official or secondary) only; a present code must be fully coded (system and code); ingredients require a coded product code, except a reference-only mix: no code, at least one identifier, all in listed systems, and 1 to 32 ingredients, each only an itemReference that is exactly Medication/<id> (no display or identifier), an optional boolean isActive and an optional strength Ratio of two simple Quantities. Free-text-only or other uncoded compounds are unclassified.',
    Location: 'Affirmative facility allowlist: at least one coding in type/physicalType; every type coding a reviewed facility v3-RoleCode (URI or OID system); every physicalType coding in {si,bu,wi,wa,lvl,co,ro,bd,area}. Untyped, text-only and residential/work/school instances are unclassified. Name is an operator-attested semantic residual; description, alias and availabilityExceptions are withheld with labels.',
    Organization: 'Directory fields only; contact persons are unclassified.',
    Practitioner: 'Directory fields only.',
    conformance: 'CodeSystem, ValueSet, StructureDefinition, SearchParameter, CapabilityStatement, OperationDefinition: base R4 elements only.',
  },
} as const;
const coded = (concept: unknown): boolean => {
  const coding = (concept as { coding?: unknown } | null)?.coding;
  return Array.isArray(coding) && coding.length > 0 && coding.every(item => typeof item?.system === 'string' && typeof item?.code === 'string');
};
const codingsOf = (value: unknown): { system?: unknown; code?: unknown }[] => (Array.isArray(value) ? value : [value]).flatMap(concept => {
  const coding = (concept as { coding?: unknown } | null)?.coding;
  return Array.isArray(coding) ? coding : [];
});
// Shared Locations are affirmed as facilities, never inferred from the absence of a residential code.
const ROLECODE_SYSTEMS = new Set(['http://terminology.hl7.org/CodeSystem/v3-RoleCode', 'urn:oid:2.16.840.1.113883.5.111']);
const FACILITY_ROLECODES = new Set(['HOSP', 'ER', 'ICU', 'OF', 'PHARM', 'HU', 'RH', 'CHR', 'GACH', 'MHSP', 'PSYCHF', 'RHAB']);
const FACILITY_PHYSICAL_TYPES = new Set(['si', 'bu', 'wi', 'wa', 'lvl', 'co', 'ro', 'bd', 'area']);
const facilityLocation = (node: Record<string, unknown>): boolean => {
  const typeCodings = node.type === undefined ? [] : codingsOf(node.type);
  const physicalCodings = node.physicalType === undefined ? [] : codingsOf(node.physicalType);
  if (node.type !== undefined && typeCodings.length === 0) return false;
  if (node.physicalType !== undefined && physicalCodings.length === 0) return false;
  if (typeCodings.length + physicalCodings.length === 0) return false;
  return typeCodings.every(coding => ROLECODE_SYSTEMS.has(String(coding?.system)) && FACILITY_ROLECODES.has(String(coding?.code)))
    && physicalCodings.every(coding => coding?.system === 'http://terminology.hl7.org/CodeSystem/location-physical-type' && FACILITY_PHYSICAL_TYPES.has(String(coding?.code)));
};
const directory = ['id', 'meta', 'language', 'text'];
const conformance = (type: string) => elementNames(type).filter(name => !['extension', 'modifierExtension', 'implicitRules'].includes(name));
/**
 * The operator-listed product identifier systems a shared record may carry. Empty by default,
 * so a shared Medication with any identifier stays unclassified. Config validation refuses any overlap with the configured
 * patient identifier systems and the well-known person identifier systems below.
 */
/**
 * `profiles` are the operator-listed `meta.profile` canonicals a shared record may declare
 * (privacy.sharedProfiles, empty by default). A listed profile only passes the profile check; every other check still applies.
 */
export interface SharedPolicy { identifierSystems?: ReadonlySet<string>; profiles?: ReadonlySet<string> }
export function sharedPolicyFrom(privacy: GatewayConfig['privacy'] = {}): SharedPolicy {
  return { identifierSystems: new Set(privacy?.sharedIdentifierSystems ?? []), profiles: new Set(privacy?.sharedProfiles ?? []) };
}
/** Every declared profile is a string on the built-in or the operator list. */
const listedProfile = (profile: unknown, shared: SharedPolicy): boolean => typeof profile === 'string'
  && (SHARED_INSTANCE_POLICY.profiles.includes(profile) || Boolean(shared.profiles?.has(profile)));
const SHARED_IDENTIFIER_KEYS = new Set(['system', 'value', 'use']);
const SHARED_IDENTIFIER_USES = new Set(['usual', 'official', 'secondary']);
/** Absent, or 1 to 8 `{system, value, use?}` identifiers, every system on the operator list; nothing else rides along. */
function listedIdentifiers(node: Record<string, unknown>, shared: SharedPolicy): boolean {
  if (node._identifier !== undefined) return false;
  const identifiers = node.identifier;
  if (identifiers === undefined) return true;
  if (!Array.isArray(identifiers) || identifiers.length < 1 || identifiers.length > 8) return false;
  return identifiers.every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const identifier = item as Record<string, unknown>;
    if (Object.keys(identifier).some(key => !SHARED_IDENTIFIER_KEYS.has(key))) return false;
    if (typeof identifier.system !== 'string' || !shared.identifierSystems?.has(identifier.system)) return false;
    if (typeof identifier.value !== 'string' || identifier.value.length < 1 || identifier.value.length > 256) return false;
    return identifier.use === undefined || (typeof identifier.use === 'string' && SHARED_IDENTIFIER_USES.has(identifier.use));
  });
}
/** The most ingredients a reference-only medication mix may carry. */
export const MAX_MIX_INGREDIENTS = 32;
const MIX_INGREDIENT_KEYS = new Set(['itemReference', 'isActive', 'strength']);
const MIX_QUANTITY_KEYS = new Set(['value', 'unit', 'system', 'code']);
const MIX_MEDICATION_REFERENCE = /^Medication\/[A-Za-z0-9.-]{1,64}$/;
const plainNode = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !isFhirDecimal(value) && !isPrecisionFault(value);
/** A simple Quantity: a numeric value and optional unit, system and code strings; no comparator, no extension. */
const mixQuantity = (value: unknown): boolean => plainNode(value) && Object.keys(value).every(key => MIX_QUANTITY_KEYS.has(key))
  && ((typeof value.value === 'number' && Number.isFinite(value.value)) || isFhirDecimal(value.value))
  && ['unit', 'system', 'code'].every(key => value[key] === undefined || typeof value[key] === 'string');
/** One mix ingredient: only itemReference (exactly `Medication/<id>`, nothing else), isActive (boolean) and strength (Ratio of simple Quantities). */
const mixIngredient = (item: unknown): boolean => {
  if (!plainNode(item) || Object.keys(item).some(key => !MIX_INGREDIENT_KEYS.has(key))) return false;
  const reference = item.itemReference;
  if (!plainNode(reference) || Object.keys(reference).some(key => key !== 'reference')) return false;
  if (typeof reference.reference !== 'string' || !MIX_MEDICATION_REFERENCE.test(reference.reference)) return false;
  if (item.isActive !== undefined && typeof item.isActive !== 'boolean') return false;
  const strength = item.strength;
  return strength === undefined || (plainNode(strength) && Object.keys(strength).every(key => key === 'numerator' || key === 'denominator')
    && mixQuantity(strength.numerator) && mixQuantity(strength.denominator));
};
/**
 * An uncoded Medication may carry ingredients only as a reference-only mix: no code (the caller has already refused a
 * present code that is not fully coded), at least one identifier (and
 * {@link listedIdentifiers} requires every identifier to be in an operator-listed system, so with the default empty list no mix
 * passes), and 1 to {@link MAX_MIX_INGREDIENTS} ingredients that each name another shared Medication by relative id.
 */
const referenceOnlyMix = (node: Record<string, unknown>): boolean => node._code === undefined && node.identifier !== undefined
  && node._ingredient === undefined && Array.isArray(node.ingredient) && node.ingredient.length >= 1 && node.ingredient.length <= MAX_MIX_INGREDIENTS
  && node.ingredient.every(mixIngredient);
const SHARED_RULES: Record<string, { fields: Set<string>; check?: (node: Record<string, unknown>, shared: SharedPolicy) => boolean }> = {
  Medication: { fields: new Set([...directory, 'contained', 'identifier', 'code', 'status', 'manufacturer', 'form', 'amount', 'ingredient']), check: (node, shared) => (node.code === undefined || coded(node.code)) && (node.ingredient === undefined || coded(node.code) || referenceOnlyMix(node)) && listedIdentifiers(node, shared) },
  Organization: { fields: new Set([...directory, 'identifier', 'active', 'type', 'name', 'alias', 'telecom', 'address', 'partOf', 'endpoint']) },
  Location: { fields: new Set([...directory, 'identifier', 'status', 'operationalStatus', 'name', 'alias', 'description', 'mode', 'type', 'telecom', 'address', 'physicalType', 'position', 'managingOrganization', 'partOf', 'hoursOfOperation', 'availabilityExceptions', 'endpoint']), check: facilityLocation },
  Practitioner: { fields: new Set([...directory, 'identifier', 'active', 'name', 'telecom', 'address', 'gender', 'birthDate', 'photo', 'qualification', 'communication']) },
  ...Object.fromEntries(['CodeSystem', 'ValueSet', 'StructureDefinition', 'SearchParameter', 'CapabilityStatement', 'OperationDefinition'].map(type => [type, { fields: new Set(conformance(type)) }])),
};

/** True only when the instance satisfies {@link SHARED_INSTANCE_POLICY}; contained resources are judged separately by `authorized()`. */
export function sharedInstanceAllowed(resource: Record<string, unknown>, shared: SharedPolicy = {}): boolean {
  const type = resource.resourceType;
  const rule = typeof type === 'string' && Object.hasOwn(SHARED_RULES, type) ? SHARED_RULES[type]! : undefined;
  if (!rule) return false;
  for (const key of Object.keys(resource)) if (key !== 'resourceType' && !rule.fields.has(key.startsWith('_') ? key.slice(1) : key)) return false;
  const meta = resource.meta as Record<string, unknown> | undefined;
  if (meta !== undefined && (typeof meta !== 'object' || meta === null || Array.isArray(meta))) return false;
  if (meta?.security !== undefined) return false;
  if (meta?.profile !== undefined && !(Array.isArray(meta.profile) && meta.profile.every(profile => listedProfile(profile, shared)))) return false;
  let nodes = 0;
  const clean = (value: unknown, depth: number): boolean => {
    if (++nodes > 100000 || depth > 64) return false;
    if (!value || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value)) return true;
    if (Array.isArray(value)) return value.every(item => clean(item, depth + 1));
    const node = value as Record<string, unknown>;
    if (depth > 0 && typeof node.resourceType === 'string') return true;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'modifierExtension' || key === 'implicitRules') return false;
      if (key === 'extension' && !(Array.isArray(child) && child.every(item => SHARED_INSTANCE_POLICY.extensions.includes(item?.url)))) return false;
      if (!clean(child, depth + 1)) return false;
    }
    return true;
  };
  return clean(resource, 0) && (rule.check?.(resource, shared) ?? true);
}

// ---------------------------------------------------------------------------
// Canonical Patient-reference classification.
// ---------------------------------------------------------------------------

const FHIR_ID = /^[A-Za-z0-9.-]{1,64}$/;
const TYPE_NAME = /^[A-Z][A-Za-z]{1,63}$/;
export type ReferenceForm = 'relative' | 'absolute' | 'contained' | 'urn' | 'conditional' | 'unsupported';
export interface ParsedReference { form: ReferenceForm; type?: string; id?: string; version?: string; sameSource?: boolean; patientLike: boolean }

function relativeParts(path: string): { type: string; id: string; version?: string } | undefined {
  const match = /^([^/?#]+)\/([^/?#]+)(?:\/_history\/([^/?#]+))?$/.exec(path);
  if (!match || !TYPE_NAME.test(match[1]!) || !FHIR_ID.test(match[2]!) || (match[3] !== undefined && !FHIR_ID.test(match[3]))) return undefined;
  return { type: match[1]!, id: match[2]!, ...(match[3] ? { version: match[3] } : {}) };
}
const decode = (text: string) => { try { return decodeURIComponent(text); } catch { return text; } };
// Percent-decoding is applied repeatedly (bounded) so double-encoded forms such as
// `%2550atient` cannot hide a Patient type behind a single decode.
const mentionsPatient = (text: string): boolean => {
  let current = text;
  for (let i = 0; i < 4; i++) {
    if (/(?:^|[^A-Za-z])patient(?:[^A-Za-z]|$)/i.test(current)) return true;
    const next = decode(current);
    if (next === current) return false;
    current = next;
  }
  return /(?:^|[^A-Za-z])patient(?:[^A-Za-z]|$)/i.test(current);
};

/**
 * Parse one `Reference.reference` string. Scheme and host compare
 * case-insensitively through WHATWG URL parsing; the path, and thus the
 * resource type, stays case-sensitive. `/_history/N` is split off. Nothing is
 * resolved or fetched: conditional, `urn:`, contained and unsupported forms are
 * only labelled, and policy decides. A conditional type is accepted as such
 * only when literal, case-exact and a known R4 resource type; encoded,
 * malformed or unknown conditional types are labelled unsupported.
 */
export function parseReference(value: string, base: URL): ParsedReference {
  if (value !== value.trim() || !value) return { form: 'unsupported', patientLike: mentionsPatient(value) };
  if (value.startsWith('#')) return FHIR_ID.test(value.slice(1)) ? { form: 'contained', patientLike: false } : { form: 'unsupported', patientLike: mentionsPatient(value) };
  if (/^urn:(?:uuid|oid):/i.test(value)) return { form: 'urn', patientLike: false };
  const conditional = /^([^/?#:]+)\?/.exec(value);
  if (conditional) {
    // A conditional reference is only ever *labelled* conditional when its type is a literal,
    // case-exact, known R4 resource type name. Encoded (`%50atient`, `Pat%69ent`, double-encoded),
    // malformed (lowercase/mixed-case) or unknown types are unsupported — never an ordinary
    // parsed non-Patient reference.
    if (!TYPE_NAME.test(conditional[1]!) || !isFhirResourceType(conditional[1]!)) return { form: 'unsupported', patientLike: mentionsPatient(value) };
    return { form: 'conditional', type: conditional[1], patientLike: conditional[1]!.toLowerCase() === 'patient' };
  }
  const relative = relativeParts(value);
  if (relative) return { form: 'relative', ...relative, sameSource: true, patientLike: relative.type.toLowerCase() === 'patient' };
  let url: URL | undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) try { url = new URL(value); } catch { /* unsupported */ }
  if (!url) return { form: 'unsupported', patientLike: mentionsPatient(value) };
  // Host names say nothing about the FHIR type; scheme, path, query and fragment can.
  const hostless = `${url.protocol}${url.pathname}${url.search}${url.hash}`;
  if (url.username || url.password || url.search || url.hash) return { form: 'unsupported', patientLike: mentionsPatient(hostless) };
  const root = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const sameSource = url.origin === base.origin && url.pathname.startsWith(root);
  const parts = sameSource ? relativeParts(url.pathname.slice(root.length)) : relativeParts(url.pathname.split('/').slice(-4).join('/')) ?? relativeParts(url.pathname.split('/').slice(-2).join('/'));
  if (!parts) return { form: 'unsupported', patientLike: mentionsPatient(hostless) };
  return { form: 'absolute', ...parts, sameSource, patientLike: parts.type.toLowerCase() === 'patient' || mentionsPatient(url.pathname.slice(0, url.pathname.lastIndexOf(parts.type))) };
}

export interface DirectoryKey { type: string; id: string }
/** One literal same-source directory reference, or undefined. A declared `type` that disagrees with the literal grants nothing. */
function directoryKey(node: Record<string, unknown>, base: URL): DirectoryKey | undefined {
  if (typeof node.reference !== 'string') return undefined;
  const parsed = parseReference(node.reference, base);
  if (!(parsed.form === 'relative' || (parsed.form === 'absolute' && parsed.sameSource))) return undefined;
  if (!parsed.type || !isDirectoryType(parsed.type) || !parsed.id || !FHIR_ID.test(parsed.id) || parsed.id === '.' || parsed.id === '..') return undefined;
  if (node.type !== undefined && node.type !== parsed.type) return undefined;
  return { type: parsed.type, id: parsed.id };
}

/**
 * The directory keys a record grants, read from the record exactly as delivered (after withholding,
 * redaction and `output.fields` or compact selection). Only the bound patient's own records grant: a root of a patient-linked
 * type. A shared root such as a delivered Location grants nothing, and neither does a contained Practitioner, Organization or
 * Location inside an own record (no chains: a directory record's own references never extend reachability). Only
 * schema-declared Reference nodes count, by their literal `reference`; a display-only, identifier-only, contained (`#id`),
 * conditional, `urn:` or other-source reference grants nothing. Bounded like the other walks; past the bound, nothing more.
 */
export function deliveredDirectoryReferences(resource: FhirResource, base: URL): DirectoryKey[] {
  const root = resource.resourceType;
  if (typeof root !== 'string' || resourceClass(root) !== 'patient') return [];
  const found = new Map<string, DirectoryKey>();
  let nodes = 0;
  const visit = (value: unknown, depth: number, context: TypeContext | undefined): void => {
    if (++nodes > 100000 || depth > 64) return;
    if (!value || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value)) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1, context); return; }
    const node = value as Record<string, unknown>;
    if (typeof node.resourceType === 'string') {
      if (depth > 0 && isDirectoryType(node.resourceType)) return;
      context = resourceTypeContext(node.resourceType);
    }
    if (context?.definition === 'Reference' && context.path === '') {
      const key = directoryKey(node, base);
      if (key) found.set(`${key.type}/${key.id}`, key);
    }
    for (const [key, child] of Object.entries(node)) visit(child, depth + 1, context ? resolveElement(context, key).context : undefined);
  };
  visit(resource, 0, undefined);
  return [...found.values()];
}

const declaredType = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const match = /^(?:http:\/\/hl7\.org\/fhir\/StructureDefinition\/)?([A-Za-z]+)$/.exec(value);
  if (match) return match[1]!.toLowerCase() === 'patient' && match[1] !== 'Patient' ? 'patient-like' : match[1];
  return mentionsPatient(value) ? 'patient-like' : 'unknown';
};
export type ReferenceMode = 'reference' | 'unknown' | 'other';
export type ReferenceDecision = 'bound' | 'allow' | 'deny';
/**
 * Decide one reference-bearing node. `bound` is the trusted patient (relative
 * or same-source absolute, optionally versioned). Every other Patient target,
 * case variant, conditional/logical/`urn:` form that could name a Patient, and
 * unparseable value in a Patient-capable element is denied, never resolved.
 * `other` mode is a known non-Reference element (for example Expression.reference):
 * only Patient-shaped strings are judged there.
 */
export function referenceDecision(node: Record<string, unknown>, patientId: string, base: URL, mode: ReferenceMode = 'unknown', targets?: string[]): ReferenceDecision {
  const capable = mode !== 'other' && (!targets || targets.some(target => /\/(?:Patient|Resource)$/.test(target)));
  const declared = mode === 'other' ? undefined : declaredType(node.type);
  const declaredPatient = declared === 'Patient' || declared === 'patient-like';
  const reference = node.reference;
  if (reference !== undefined && typeof reference !== 'string') return capable || declaredPatient ? 'deny' : 'allow';
  if (typeof reference === 'string') {
    const parsed = parseReference(reference, base);
    if (parsed.type === 'Patient' || parsed.patientLike) {
      const local = parsed.form === 'relative' || (parsed.form === 'absolute' && parsed.sameSource);
      return local && parsed.type === 'Patient' && parsed.id === patientId && (!declared || declared === 'Patient' || declared === 'unknown') ? 'bound' : 'deny';
    }
    if (mode === 'other') return 'allow';
    if (declaredPatient) return 'deny';
    // Conservative on purpose: every remaining conditional Reference in a Reference or
    // unknown context is denied, whatever its validated type or declared targets. A conditional
    // target is by construction unverifiable without resolution, which this gateway never does,
    // so its display/identifier companions must never ride along. Encoded/malformed/unknown
    // conditional types already arrive here as `unsupported` (denied below when capable, and
    // denied above whenever patient-like).
    if (parsed.form === 'conditional') return 'deny';
    if (parsed.form === 'urn') return capable && (!declared || declared === 'unknown') ? 'deny' : 'allow';
    if (parsed.form === 'unsupported') return capable ? 'deny' : 'allow';
    return 'allow';
  }
  if (mode === 'other') return 'allow';
  if (declaredPatient) return 'deny';
  if (node.identifier !== undefined) return capable && (!declared || declared === 'unknown') ? 'deny' : 'allow';
  return 'allow';
}

/**
 * True when a search value could select a Patient other than the trusted one through any reference
 * parameter (for example `performer=Patient/B`), not only `patient`/`subject`. Explicit Patient reference forms
 * are judged for every parameter. When the CapabilityStatement declares the parameter type `reference`, a bare
 * logical id matches every target type (Patient included) on real servers, so anything that is not an explicit
 * local typed reference — bare ids, cross-origin absolutes, conditional/logical/`urn:` forms and unparseable
 * values — is refused rather than resolved. The bound patient is allowed in any form. Undeclared parameter types
 * are not extended here: token/date values match the id pattern, so that judgement waits for typed discovery.
 * Comma-separated values are OR, so every part is checked.
 */
export function foreignPatientSelector(value: string, patientId: string, base: URL, searchParamType?: string): boolean {
  return value.split(',').some(part => {
    const candidate = part.trim();
    if (!candidate) return false;
    const parsed = parseReference(candidate, base);
    const bound = (parsed.form === 'relative' || (parsed.form === 'absolute' && parsed.sameSource)) && parsed.type === 'Patient' && parsed.id === patientId;
    if (bound || candidate === patientId) return false;
    if (parsed.type === 'Patient') return true;
    // An explicit conditional-shaped patient-like selector (including encoded forms, which now
    // parse as unsupported) is an explicit Patient reference form and is judged for every parameter.
    if (parsed.patientLike && candidate.includes('?')) return true;
    if (searchParamType !== 'reference') return false;
    // A bare id on a reference parameter matches every target type, Patient included.
    return parsed.patientLike || !(parsed.form === 'relative' || (parsed.form === 'absolute' && parsed.sameSource));
  });
}

/** A JSON scalar: string, number, decimal, precision marker, boolean or null (never an array or object). */
const isScalar = (value: unknown): boolean => value !== undefined && !Array.isArray(value)
  && (value === null || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value));
const linkageContexts = new Map<string, boolean>();
/** True when a definition context directly declares a `reference` member or a Reference/Resource-typed member (choices included). */
function carriesLinkage(context: TypeContext): boolean {
  const key = `${context.definition}\u0000${context.path}`;
  let known = linkageContexts.get(key);
  if (known === undefined) {
    const names = elementNames(context.definition, context.path);
    known = names.includes('reference') || names.some(name => resolveElement(context, name).types.some(type => type === 'Reference' || type === 'Resource' || isFhirResourceType(type)));
    linkageContexts.set(key, known);
  }
  return known;
}

/**
 * True for a scalar (string, number, decimal, boolean or null) where the schema declares a Reference, a
 * Resource (contained, Bundle.entry.resource, Parameters.parameter.resource) or a structure that directly carries
 * linkage: a `reference` member (Expression, Immunization.education, ...) or a Reference/Resource-typed member
 * (Identifier.assigner, so a scalar Reference.identifier; Extension.value[x]; Annotation.author[x]; Signature.who;
 * backbones such as Encounter.participant). The linkage checks judge only objects there, so such a scalar is
 * malformed linkage, never a leaf. Arrays are judged item by item.
 */
function malformedLinkage(element: ResolvedElement | undefined, value: unknown): boolean {
  if (!isScalar(value) || !element?.types.length || element.types.every(type => /^[a-z]/.test(type))) return false;
  return element.types.some(type => type === 'Reference' || type === 'Resource' || isFhirResourceType(type)) || (element.context !== undefined && carriesLinkage(element.context));
}

/**
 * Any other scalar where the schema declares only complex types is malformed structure: sanitize withholds it (the
 * linkage-carrying ones are refused at authorization above). A null is legal only as an alignment hole in a
 * primitive companion array (`_given: [null, {...}]`), so it is exempt at Element positions.
 */
function malformedComplex(element: ResolvedElement, value: unknown): boolean {
  return isScalar(value) && element.types.length > 0 && element.types.every(type => /^[A-Z]/.test(type)) && !(value === null && element.types.includes('Element'));
}

/** Resource-typed objects must identify their type before either privacy layer walks their fields. */
function malformedResource(element: ResolvedElement | undefined, node: Record<string, unknown>): boolean {
  return Boolean(element?.types.some(type => type === 'Resource' || isFhirResourceType(type))) && typeof node.resourceType !== 'string';
}

/**
 * A Reference.reference or Reference.type that is present but not a string cannot be read and may name a Patient.
 * The same holds for those keys on an unknown-context or loose node, where they are not declared elements of their
 * own; a declared non-string member (a CodeableConcept `type`, EOB.related.reference) is not affected.
 */
function unreadableLinkage(node: Record<string, unknown>, context: TypeContext | undefined, isReference: boolean): boolean {
  return (['reference', 'type'] as const).some(key => node[key] !== undefined && typeof node[key] !== 'string'
    && (isReference || !context || !resolveElement(context, key).types.length));
}

/**
 * Patient confinement over the resource and everything nested in it. A
 * contained Patient is never the trusted record. The bound Patient's own
 * `link[].other` is not judged here because {@link sanitize} always withholds
 * it (FOREIGN_PATIENT_REFERENCE_WITHHELD) and marks the modifier uninterpreted.
 *
 * canonical- and uri-typed strings are not linkage and are not judged here, even when they spell `Patient/x`: an R4
 * canonical refers to the canonical `url` of a definitional resource (Patient has no `url` element, and no base
 * canonical element targets Patient), and every Patient-compartment parameter is a reference parameter. Only
 * `reference` members are judged: Reference.reference, and the Patient-shaped screen on uri `reference` members.
 */
export function authorized(resource: FhirResource, patientId: string, base: URL, shared: SharedPolicy = {}): boolean {
  let nodes = 0;
  const visit = (value: unknown, depth: number, element: ResolvedElement | undefined): boolean => {
    if (++nodes > 100000 || depth > 64) return false;
    // A scalar at a Reference/Resource/reference-carrying position would otherwise be a leaf that never
    // reaches the reference decision; the owning resource is refused like any other unverifiable linkage.
    if (malformedLinkage(element, value)) return false;
    // Decimal scalars and precision markers are leaves: linkage is judged without them, and any precision
    // refusal happens only after authorization.
    if (!value || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value)) return true;
    if (Array.isArray(value)) return value.every(child => visit(child, depth + 1, element));
    const node = value as Record<string, unknown>;
    let context = element?.context;
    if (malformedResource(element, node)) return false;
    if (typeof node.resourceType === 'string') {
      const type = node.resourceType;
      const classification = resourceClass(type);
      if (classification === 'ambiguous') return false;
      if (type === 'Patient' && (depth > 0 || node.id !== patientId)) return false;
      if (classification === 'shared' && !sharedInstanceAllowed(node, shared)) return false;
      context = resourceTypeContext(type);
      if (classification === 'patient' && type !== 'Patient') {
        const link = node[links[type]!];
        const linkElement = resolveElement(context, links[type]!);
        if (!link || typeof link !== 'object' || Array.isArray(link) || referenceDecision(link as Record<string, unknown>, patientId, base, 'reference', linkElement.targets) !== 'bound') return false;
      }
    }
    const isReference = context?.definition === 'Reference' && context.path === '';
    const referenceLike = typeof node.reference === 'string' || node.reference !== undefined || (node.type !== undefined && (node.identifier !== undefined || node.display !== undefined));
    // A reference-shaped node smuggled onto a known non-Reference context is "loose" when any of its
    // reference keys is not a declared element there; judge it as an unknown context, not as conformant data.
    const loose = Boolean(context) && !isReference && referenceLike && ['reference', 'type', 'identifier', 'display'].some(key => node[key] !== undefined && !resolveElement(context, key).types.length);
    // An unreadable (non-string) reference or type member is refused before any reference decision.
    if ((isReference || referenceLike) && unreadableLinkage(node, context, isReference)) return false;
    if (isReference || ((!context || loose) && referenceLike) || (context && typeof node.reference === 'string')) {
      if (referenceDecision(node, patientId, base, isReference ? 'reference' : context && !loose ? 'other' : 'unknown', isReference ? element?.targets : undefined) === 'deny') return false;
    }
    for (const [key, child] of Object.entries(node)) {
      if (context?.definition === 'Patient' && context.path === 'link' && key === 'other') continue;
      if (!visit(child, depth + 1, context ? resolveElement(context, key) : undefined)) return false;
    }
    return true;
  };
  return visit(resource, 0, undefined);
}

// ---------------------------------------------------------------------------
// Record judgement for honest coverage and narrow redaction.
// `authorized()` above stays the strict oracle every delivered record must pass.
// ---------------------------------------------------------------------------

/** HL7 v2-0203 identifier type codes that name a person of record (MRN, patient, member, SSN, licence, passport, Medicare/Medicaid). */
const PERSON_IDENTIFIER_TYPES = new Set(['MR', 'PI', 'PT', 'MB', 'SS', 'DL', 'PPN', 'MC', 'MA']);
/** v2-0203 code systems after folding: lower case, no http/https scheme, no trailing slash (the older hl7.org/fhir/v2/0203 form too). */
const V2_0203_SYSTEMS = new Set(['terminology.hl7.org/codesystem/v2-0203', 'hl7.org/fhir/v2/0203', 'urn:oid:2.16.840.1.113883.18.108']);
/** Identifier type text that names a person of record. Matched conservatively: a false match withholds a record silently. */
const PERSON_IDENTIFIER_TEXT = /\b(?:mrn|medical record|patient|member|subscriber|ssn|social security|passport|driver'?s? licen[cs]e|medicare|medicaid)\b/i;
const STRUCTURE = 'http://hl7.org/fhir/StructureDefinition/';
const ACTOR_TARGETS = ['Practitioner', 'PractitionerRole', 'Device'].map(type => `${STRUCTURE}${type}`);
/** Payee slots name who is paid, often a person of record; never redacted-and-delivered. */
const REDACTION_EXCLUDED_SITES = new Set(['Claim.payee.party', 'ExplanationOfBenefit.payee.party']);

/** True for an absent coding system or a v2-0203 system in any case, scheme or trailing-slash spelling. */
function v2IdentifierTypeSystem(system: unknown): boolean {
  if (system === undefined) return true;
  return typeof system === 'string' && V2_0203_SYSTEMS.has(system.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, ''));
}

/**
 * An identifier that may name a person of record is a logical patient reference, so its record is withheld silently instead
 * of being delivered with the node redacted. Conservative on purpose: a configured patient system compared like the shared-identifier overlap
 * check (case and URL spelling folded), a well-known person identifier system, a v2-0203 person type code in any spelling of
 * that system, or person-like type text. None of these depends on whose identity the identifier carries.
 */
function logicalPatientIdentifier(value: unknown, patientSystems: ReadonlySet<string>): boolean {
  return (Array.isArray(value) ? value : [value]).some(item => {
    if (!item || typeof item !== 'object') return false;
    const identifier = item as Record<string, unknown>;
    const system = identifier.system;
    if (typeof system === 'string' && [...patientSystems].some(configured => identifierSystemsOverlap(configured, system))) return true;
    if (typeof system === 'string' && personIdentifierSystem(system)) return true;
    const typeText = identifier.type && typeof identifier.type === 'object' ? (identifier.type as Record<string, unknown>).text : undefined;
    if (typeof typeText === 'string' && PERSON_IDENTIFIER_TEXT.test(typeText)) return true;
    return codingsOf(identifier.type).some(coding => typeof coding?.code === 'string' && PERSON_IDENTIFIER_TYPES.has(coding.code.trim().toUpperCase())
      && v2IdentifierTypeSystem(coding.system));
  });
}

/**
 * Only clinical-actor slots are redactable. The declared targets must include Patient and at least one of Practitioner,
 * PractitionerRole or Device, and never Resource; payee slots are excluded. Patient-only and person-of-record elements
 * (sourcePatientInfo, Coverage.subscriber/policyHolder/payor, Extension.valueReference) never qualify.
 */
function clinicalActorElement(element: ResolvedElement | undefined, site: string): boolean {
  const targets = element?.targets;
  return Boolean(targets?.length) && targets!.includes(`${STRUCTURE}Patient`) && !targets!.includes(`${STRUCTURE}Resource`)
    && ACTOR_TARGETS.some(target => targets!.includes(target)) && !REDACTION_EXCLUDED_SITES.has(site);
}

type DeniedClass = 'foreign' | 'logical_patient' | 'unverifiable' | 'defect';
/**
 * Classify a reference node that `referenceDecision()` denied. Identity-independent: any Patient-shaped string that is
 * not bound is foreign evidence whatever its id, as is a declared Patient type and a conditional query mentioning a patient
 * `unverifiable` is an identifier-only, `urn:` or conditional form that names no patient; the caller decides whether
 * its site makes it redactable. Everything else is a defect.
 */
function classifyDenied(node: Record<string, unknown>, mode: ReferenceMode, base: URL, patientSystems: ReadonlySet<string>): DeniedClass {
  const reference = node.reference;
  const parsed = typeof reference === 'string' ? parseReference(reference, base) : undefined;
  if (parsed && (parsed.type === 'Patient' || parsed.patientLike || (parsed.form === 'conditional' && mentionsPatient(reference as string)))) return 'foreign';
  const declared = mode === 'other' ? undefined : declaredType(node.type);
  if (declared === 'Patient' || declared === 'patient-like') return 'foreign';
  if (logicalPatientIdentifier(node.identifier, patientSystems)) return 'logical_patient';
  if (reference === undefined && node.identifier !== undefined) return 'unverifiable';
  if (parsed && (parsed.form === 'urn' || parsed.form === 'conditional')) return 'unverifiable';
  return 'defect';
}

export interface RecordJudgement {
  /** The record's own primary patient link is the bound patient (root Patient: its id). */
  primaryBound: boolean;
  /** Something `authorized()` denies that does not depend on another patient's identity. */
  ownDefect: boolean;
  /** Explicit evidence of another patient: a foreign reference, a contained Patient, a foreign primary link or a logical patient identifier. */
  foreignEvidence: boolean;
  /** Sanitize-format JSON pointers of unverifiable clinical-actor references to withhold whole. */
  withholdReferences: string[];
}

/**
 * Walk a record with the same contexts, ordering and budgets as `authorized()`, collecting findings instead of stopping at the
 * first denial. Invariant: the verdict equals the verdict on the same record with every foreign identity replaced by
 * the bound one. So foreign reference nodes are not pruned: their children are walked exactly as `authorized()` walks a bound
 * reference's children. Only a contained Patient (any id) and a logical patient identifier are pruned whole, and a
 * redactable node is pruned because it is removed whole; none of those depends on whose identity is carried.
 */
export function judgeRecord(resource: FhirResource, patientId: string, base: URL, privacy: GatewayConfig['privacy'] = {}): RecordJudgement {
  const shared = sharedPolicyFrom(privacy);
  const patientSystems = new Set(privacy?.patientIdentifierSystems ?? []);
  const judgement: RecordJudgement = { primaryBound: false, ownDefect: false, foreignEvidence: false, withholdReferences: [] };
  const rootType = resource.resourceType;
  if (rootType === 'Patient') judgement.primaryBound = resource.id === patientId;
  else if (typeof rootType === 'string' && resourceClass(rootType) === 'patient') {
    const link = resource[links[rootType]!];
    judgement.primaryBound = Boolean(link) && typeof link === 'object' && !Array.isArray(link)
      && referenceDecision(link as Record<string, unknown>, patientId, base, 'reference', resolveElement(resourceTypeContext(rootType), links[rootType]!).targets) === 'bound';
  }
  let nodes = 0;
  let stopped = false;
  const defect = () => { judgement.ownDefect = true; stopped = true; };
  const visit = (value: unknown, depth: number, element: ResolvedElement | undefined, path: string, site: string, primary: boolean): void => {
    if (stopped) return;
    if (++nodes > 100000 || depth > 64) return defect();
    if (malformedLinkage(element, value)) return defect();
    if (!value || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value)) return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length && !stopped; i++) visit(value[i], depth + 1, element, `${path}/${i}`, site, primary);
      return;
    }
    const node = value as Record<string, unknown>;
    let context = element?.context;
    if (malformedResource(element, node)) return defect();
    let primaryKey: string | undefined;
    if (typeof node.resourceType === 'string') {
      const type = node.resourceType;
      const classification = resourceClass(type);
      if (classification === 'ambiguous') return defect();
      // A contained Patient is never the trusted record, whatever its id.
      if (type === 'Patient' && depth > 0) { judgement.foreignEvidence = true; return; }
      if (classification === 'shared' && !sharedInstanceAllowed(node, shared)) return defect();
      context = resourceTypeContext(type);
      if (classification === 'patient' && type !== 'Patient') {
        primaryKey = links[type]!;
        const link = node[primaryKey];
        if (!link || typeof link !== 'object' || Array.isArray(link)) return defect();
        const linkNode = link as Record<string, unknown>;
        if (referenceDecision(linkNode, patientId, base, 'reference', resolveElement(context, primaryKey).targets) !== 'bound') {
          const kind = classifyDenied(linkNode, 'reference', base, patientSystems);
          // A primary link explicitly naming another patient is foreign evidence; an unverifiable one is a defect.
          if (kind === 'foreign' || kind === 'logical_patient') judgement.foreignEvidence = true;
          else return defect();
        }
      }
    }
    const isReference = context?.definition === 'Reference' && context.path === '';
    const referenceLike = typeof node.reference === 'string' || node.reference !== undefined || (node.type !== undefined && (node.identifier !== undefined || node.display !== undefined));
    const loose = Boolean(context) && !isReference && referenceLike && ['reference', 'type', 'identifier', 'display'].some(key => node[key] !== undefined && !resolveElement(context, key).types.length);
    if ((isReference || referenceLike) && unreadableLinkage(node, context, isReference)) return defect();
    if (isReference || ((!context || loose) && referenceLike) || (context && typeof node.reference === 'string')) {
      const mode: ReferenceMode = isReference ? 'reference' : context && !loose ? 'other' : 'unknown';
      if (referenceDecision(node, patientId, base, mode, isReference ? element?.targets : undefined) === 'deny') {
        const kind = classifyDenied(node, mode, base, patientSystems);
        if (kind === 'foreign') judgement.foreignEvidence = true;
        else if (kind === 'logical_patient') { judgement.foreignEvidence = true; return; }
        else if (kind === 'unverifiable' && isReference && !primary && clinicalActorElement(element, site)) { judgement.withholdReferences.push(path); return; }
        else return defect();
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (context?.definition === 'Patient' && context.path === 'link' && key === 'other') continue;
      const childSite = context ? `${context.definition}${context.path ? `.${context.path}` : ''}.${key}` : '';
      visit(child, depth + 1, context ? resolveElement(context, key) : undefined, `${path}/${key}`, childSite, key === primaryKey);
      if (stopped) return;
    }
  };
  visit(resource, 0, undefined, '', '', false);
  return judgement;
}

/** A structural copy without the nodes at `pointers` (array items are dropped, object members deleted); undefined if a pointer does not resolve to an object node. */
function removeNodes(resource: FhirResource, pointers: readonly string[]): FhirResource | undefined {
  const targets = new Set(pointers);
  const found = new Set<string>();
  const copy = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.flatMap((item, i) => {
      const pointer = `${path}/${i}`;
      if (targets.has(pointer) && item && typeof item === 'object' && !Array.isArray(item)) { found.add(pointer); return []; }
      return [copy(item, pointer)];
    });
    if (!value || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value)) return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      const pointer = `${path}/${key}`;
      if (targets.has(pointer) && child && typeof child === 'object' && !Array.isArray(child)) { found.add(pointer); return []; }
      return [[key, copy(child, pointer)]];
    }));
  };
  const reduced = copy(resource, '') as FhirResource;
  return found.size === targets.size && targets.size === pointers.length ? reduced : undefined;
}

/** Redaction self-check on the raw record: the plan's nodes all exist, and the record without them passes the strict oracle. */
function redactionPlanHolds(resource: FhirResource, pointers: readonly string[], patientId: string, base: URL, shared: SharedPolicy): boolean {
  const reduced = removeNodes(resource, pointers);
  return reduced !== undefined && authorized(reduced, patientId, base, shared);
}

/**
 * Check a proposed redaction plan against the raw record: every pointer must be one the judge itself marks redactable, and the
 * record without those nodes must pass `authorized()`. Exported for tests; the gateway never passes plans in from outside.
 */
export function verifyRedactionPlan(resource: FhirResource, pointers: readonly string[], patientId: string, base: URL, privacy: GatewayConfig['privacy'] = {}): boolean {
  if (!pointers.length) return false;
  const redactable = new Set(judgeRecord(resource, patientId, base, privacy).withholdReferences);
  return pointers.every(pointer => redactable.has(pointer)) && redactionPlanHolds(resource, pointers, patientId, base, sharedPolicyFrom(privacy));
}

/**
 * A withheld shared record whose content may describe a person, so it is dropped silently, never with the shared signal: a
 * Location that is not an affirmed facility (residential, work, school, untyped: it can be a person's home), an Organization
 * with contact persons, or a record whose own identifiers may name a person of record (a configured patient identifier
 * system, a well-known person identifier system, or a person identifier type). The signal confirms that an admitted predicate
 * such as `address` or `identifier` matched a withheld record, so for these records it would confirm guesses about a person's
 * address or identifier. None of these tests depends on whose identity the record carries, or on any identifier value.
 */
export function personShapedSharedRecord(resource: Record<string, unknown>, privacy: GatewayConfig['privacy'] = {}): boolean {
  if (resource.resourceType === 'Location' && !facilityLocation(resource)) return true;
  if (resource.resourceType === 'Organization' && (resource.contact !== undefined || resource._contact !== undefined)) return true;
  return resource.identifier !== undefined && logicalPatientIdentifier(resource.identifier, new Set(privacy?.patientIdentifierSystems ?? []));
}

export type RecordAuthorization =
  | { kind: 'deliver'; withhold: readonly string[] }
  | { kind: 'own_withheld' }
  | { kind: 'shared_withheld' }
  | { kind: 'silent'; selfCheckFailed?: true };

/**
 * One decision per record. `deliver` (with an empty plan on the strict path, unchanged from `authorized()`), `own_withheld` (the
 * bound patient's own record withheld for a reason that does not depend on another patient's data: coverage must become
 * partial), `shared_withheld` (a shared record withheld by the shared-instance policy or another check that does not depend on
 * another patient's data: coverage must become partial too), or `silent` (dropped with no signal: another patient's record,
 * explicit other-patient evidence such as a contained Patient or a Patient reference that is not the bound patient, or a
 * person-shaped shared record, see {@link personShapedSharedRecord}).
 */
export function authorizeRecord(resource: FhirResource, patientId: string, base: URL, privacy: GatewayConfig['privacy'] = {}): RecordAuthorization {
  const shared = sharedPolicyFrom(privacy);
  if (authorized(resource, patientId, base, shared)) return { kind: 'deliver', withhold: [] };
  const judgement = judgeRecord(resource, patientId, base, privacy);
  // A shared root record follows the same order as an own record. The judge walks foreign
  // references like bound ones, so whether it finds a defect never depends on whose identity a reference carries.
  if (typeof resource.resourceType === 'string' && resourceClass(resource.resourceType) === 'shared') {
    // A person-shaped record stays silent: the signal would confirm admitted predicates (address, identifier) against it.
    if (personShapedSharedRecord(resource, privacy)) return { kind: 'silent' };
    if (judgement.ownDefect) return { kind: 'shared_withheld' };
    if (judgement.foreignEvidence) return { kind: 'silent' };
    // Shared roots are never redacted, so unverifiable clinical-actor references in a contained record withhold it whole.
    if (judgement.withholdReferences.length) return { kind: 'shared_withheld' };
    return { kind: 'silent', selfCheckFailed: true };
  }
  if (!judgement.primaryBound) return { kind: 'silent' };
  if (judgement.ownDefect) return { kind: 'own_withheld' };
  if (judgement.foreignEvidence) return { kind: 'silent' };
  if (!judgement.withholdReferences.length) return { kind: 'silent', selfCheckFailed: true };
  if (!redactionPlanHolds(resource, judgement.withholdReferences, patientId, base, shared)) return { kind: 'silent', selfCheckFailed: true };
  return { kind: 'deliver', withhold: judgement.withholdReferences };
}

/**
 * Authorize and sanitize one record for delivery. Redacted records must also pass `authorized()` after sanitizing; otherwise
 * nothing is delivered (privacy wins over honesty on a judge bug path). Returns the authorization when nothing is delivered.
 */
export function sanitizeForDelivery(resource: FhirResource, patientId: string, base: URL, privacy: GatewayConfig['privacy'] = {}): { sanitized: Sanitized } | { refused: RecordAuthorization } {
  const decision = authorizeRecord(resource, patientId, base, privacy);
  if (decision.kind !== 'deliver') return { refused: decision };
  if (!decision.withhold.length) return { sanitized: sanitize(resource, privacy) };
  const sanitized = sanitize(resource, privacy, { withholdReferences: new Set(decision.withhold) });
  return authorized(sanitized.resource, patientId, base, sharedPolicyFrom(privacy)) ? { sanitized } : { refused: { kind: 'silent', selfCheckFailed: true } };
}

// ---------------------------------------------------------------------------
// Egress screening.
// ---------------------------------------------------------------------------

/** Where a withheld manifest came from. Only `policy` entries may collapse across records. */
/**
 * Origin of a withheld manifest entry. Only `policy` entries at schema-known sites collapse at
 * delivery. `unknown` is ineligible: a site with no schema element, or an attachment context inferred
 * from shape or path spelling alone (the walk still withholds there; it just never classifies).
 */
export type ManifestOrigin = 'policy' | 'attachment' | 'payload' | 'link_text' | 'unknown';
export interface Sanitized { resource: FhirResource; manifests: Record<string, unknown>[]; /** Aligned with `manifests`; a missing or short array makes every entry ineligible for collapse. */ manifestOrigins: ManifestOrigin[]; omitted: string[]; retrievedAt: string; requiresStructuralView: boolean; /** V-23: a resource-level narrative (`text` on a node with resourceType) was omitted; redacted prose never sets this. */ narrativeOmitted: boolean }

const uriKey = (key: string) => /^(?:url|uri|reference|system|source|profile|targetProfile)$/i.test(key) || /(?:Url|Uri|Canonical)$/i.test(key);
// WHATWG URL preprocessing: strip leading/trailing C0 controls and spaces, drop tab/newline anywhere.
const urlText = (value: string) => value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '').replace(/[\t\n\r]/g, '');

function protectedLink(value: string, key: string, typedUri = false): boolean {
  const text = urlText(value);
  if (!typedUri && !uriKey(key) && !/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(text)) return false;
  try {
    // Resolve syntax only; this base is never fetched. Relative URLs must pass
    // the same screen as absolute URLs. Opaque query/fragment values can carry
    // credentials under arbitrary names, so they are all withheld.
    const url = new URL(text, 'https://fhir.invalid/');
    const containedReference = key === 'reference' && /^#[A-Za-z0-9.-]{1,64}$/.test(text);
    return ['data:', 'javascript:', 'vbscript:', 'file:', 'blob:'].includes(url.protocol) || Boolean(url.username || url.password || url.search || (url.hash && !containedReference));
  } catch { return true; }
}

/** URL spans inside prose: scheme://, protocol-relative //host, www., and data:/javascript:/vbscript:/file:/blob:/mailto: links. */
const LINK_SPAN = /(?<![A-Za-z0-9+.-])(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*|(?:javascript|vbscript):\S+|data:(?:[\w.+-]+\/[\w.+-]+|[;,])\S*|file:[/\\]\S*|blob:\S+|mailto:\S+|www\.[A-Za-z0-9-]+\.\S*)|(?<![A-Za-z])(?:https?|ftp|wss?):\S+|(?<=^|[\s"'(<[{=])\/\/(?=\[|[A-Za-z0-9][^\s/?#]*?(?:[.:@][A-Za-z0-9[]|\/|[?#]\S))\S*/gi;
export const TEXT_LINK_PLACEHOLDER = '[link withheld]';
const CLOSER_OPEN: Record<string, string> = { ')': '(', ']': '[', '>': '<' };
/** Sentence punctuation and unbalanced closing brackets after a span belong to the prose, not the link. Single linear pass. */
function trailingProse(span: string): string {
  const depth: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0, '<': 0, '>': 0 };
  for (let i = 0; i < span.length; i++) { const c = span[i]!; if (c in depth) depth[c]!++; }
  let end = span.length;
  while (end > 1) {
    const char = span[end - 1]!, open = CLOSER_OPEN[char];
    if ('.,;:!?'.includes(char)) end--;
    else if (open && depth[char]! > depth[open]!) { depth[char]!--; end--; }
    else break;
  }
  return span.slice(end);
}
/** Redact only the URL spans in string/markdown prose, leaving clinical shorthand such as `Sig:` or `#1` intact. */
export function redactTextLinks(text: string): { text: string; spans: number } {
  let spans = 0;
  const redacted = text.replace(LINK_SPAN, span => { spans++; return TEXT_LINK_PLACEHOLDER + trailingProse(span); });
  return { text: redacted, spans };
}

const MIME = /^([A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63})\/([A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63})((?:\s*;\s*[A-Za-z0-9!#$&^_.+-]{1,32}=[A-Za-z0-9!#$&^_.+-]{1,64}){0,4})\s*$/;
/**
 * Manifest metadata is rebuilt from independently validated values only:
 * a syntactically valid MIME type (plus a validated charset), a non-negative
 * unsignedInt size, and a canonical base64 SHA-1 (20 bytes) hash. Raw values
 * are never copied, so a screened or malformed field cannot reappear here.
 */
export function attachmentMetadata(parent: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const type = typeof parent.contentType === 'string' && parent.contentType.length <= 256 ? MIME.exec(parent.contentType.trim()) : null;
  if (type) {
    const charset = /;\s*charset=([A-Za-z0-9._-]{1,40})(?:\s*;|\s*$)/i.exec(type[3]!)?.[1];
    result.content_type = `${type[1]!.toLowerCase()}/${type[2]!.toLowerCase()}${charset ? `; charset=${charset.toLowerCase()}` : ''}`;
  }
  const size = integerValue(parent.size);
  if (size !== undefined && size <= 2147483647) result.size = size;
  if (typeof parent.hash === 'string' && /^[A-Za-z0-9+/]{27}=$/.test(parent.hash)) {
    const bytes = Buffer.from(parent.hash, 'base64');
    if (bytes.length === 20 && bytes.toString('base64') === parent.hash) result.hash = bytes.toString('base64');
  }
  return result;
}

// Sanitize has no configured source; reference *form* classification does not depend on the
// base origin, so a fixed loopback base is enough to spot conditional/unsupported references.
const SANITIZE_REFERENCE_BASE = new URL('http://127.0.0.1/fhir/');

// Operator-attested directory residual field list (D1_RESIDUAL below):
// Organization.{name,type.text,type.coding.display,telecom,address}
// Practitioner.{name,telecom,address,gender,birthDate,qualification,communication}
// Location.{name,address,telecom,hoursOfOperation,type.text,type.coding.display,physicalType.text,physicalType.coding.display}
// Medication.{code.coding.display,form,ingredient.itemCodeableConcept}
// CodeSystem.concept.display; ValueSet.{compose.include.concept.display,expansion.contains.display}
// Only structurally permitted scalar content is residual. References and Identifiers
// nested inside those fields still pass the structural rules below. Shared-instance
// rules apply to standalone shared responses and their contained resources, never contained patient-linked content.
// Patient-reference companions are screened everywhere. This is not a
// semantic prose classifier: all five named masks apply even to benign text.
const D1_MASKS = new Set(['Organization.alias', 'Location.alias', 'Location.description', 'Location.availabilityExceptions', 'Medication.code.text']);
/**
 * Withheld fields of patient-linked records, keyed like D1_MASKS (`Type.path`, array positions removed, primitive `_x`
 * companions folded onto `x`). They apply wherever a resource of that type appears, root or contained.
 * - Device production identifiers single out one physical device, and so one person. `udiCarrier.carrierAIDC` is not
 *   listed: it is base64Binary and always withheld as a payload. The model-level `udiCarrier.deviceIdentifier`,
 *   `issuer`, `jurisdiction`, `deviceName`, `modelNumber`, `type`, `status` and `manufacturer` stay.
 * - A device's network address is a capability, not clinical content; its contact can name a responsible person.
 * - `Device.parent` keeps its literal reference, but its identifier and display can carry the parent device's serial number.
 * - DICOM UIDs are global instance identifiers and retrieval keys for image systems; some UID roots embed site,
 *   device or date data.
 * Search predicates over these fields are refused at admission (search-parameters.ts, maskedPatientPredicate).
 */
export const PATIENT_RECORD_MASKS: ReadonlyMap<string, string> = new Map([
  ...['identifier', 'serialNumber', 'lotNumber', 'distinctIdentifier', 'manufactureDate', 'expirationDate', 'udiCarrier.carrierHRF', 'parent.identifier', 'parent.display']
    .map(field => [`Device.${field}`, 'DEVICE_PRODUCTION_IDENTIFIER_WITHHELD'] as const),
  ['Device.url', 'DEVICE_NETWORK_ADDRESS_WITHHELD'],
  ['Device.contact', 'DEVICE_CONTACT_WITHHELD'],
  ...['identifier', 'series.uid', 'series.instance.uid'].map(field => [`ImagingStudy.${field}`, 'DICOM_UID_WITHHELD'] as const),
]);
/**
 * Types whose `extension` entries are withheld at every depth: their extension content is unreviewed and can repeat a masked
 * identifier (for example the R4 Device DIN extension, or a vendor serial-number extension). This matches the search side,
 * which refuses every extension predicate on these types. `modifierExtension` is never withheld here.
 */
const UNREVIEWED_EXTENSION_TYPES: ReadonlySet<string> = new Set(['Device', 'ImagingStudy']);
const SHARED_PERSON_TARGETS = new Set(['Patient', 'RelatedPerson', 'Person']);
const CATALOG_DISPLAY = /^(?:CodeSystem:concept(?:\.concept)*\.display|ValueSet:compose\.include\.concept\.display|ValueSet:expansion\.contains(?:\.contains)*\.display)$/;

// Computable structural string exceptions. This is the single exception
// list: CodeSystem/ValueSet.name; ValueSet.compose.include/exclude.filter.value;
// ValueSet.expansion.parameter.name; Identifier.value with a non-blank absolute
// URI, non-patient system; conformance version and url; Resource.id; Coding.version; and ValueSet
// compose.include/exclude.version and recursive expansion.contains.version; guarded
// Reference.reference. Reference companions never inherit this exception.
// Identifier prose is never attested by this list.
const SHARED_STRUCTURAL_STRING_EXCEPTIONS: readonly {
  fields: RegExp;
  allows: (node: Record<string, unknown>, patientSystems: ReadonlySet<string>) => boolean;
}[] = [
  { fields: /^Resource\.id$/, allows: node => typeof node.id !== 'string' || FHIR_ID.test(node.id) },
  { fields: /^(?:CodeSystem|ValueSet)\.name$/, allows: () => true },
  { fields: /^ValueSet\.(?:compose\.(?:include|exclude)\.filter\.value|expansion\.parameter\.name)$/, allows: () => true },
  { fields: /^(?:CodeSystem|ValueSet|CapabilityStatement|SearchParameter|StructureDefinition|OperationDefinition)\.(?:version|url)$/, allows: () => true },
  { fields: /^Reference\.reference$/, allows: () => true },
  { fields: /^Coding\.version$/, allows: () => true },
  { fields: /^ValueSet\.(?:compose\.(?:include|exclude)\.version|expansion\.contains(?:\.contains)*\.version)$/, allows: () => true },
  { fields: /^Identifier\.value$/, allows: (node, patientSystems) => typeof node.system === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:\S/.test(node.system) && !patientSystems.has(node.system) },
];
// Only the D1_RESIDUAL paths attest prose. An Identifier nested in an attested
// subtree still needs its own system classification and never attests type.text.
const D1_RESIDUAL = /^(?:Organization:(?:name|type\.(?:text|coding\.display)|telecom(?:\..+)?|address(?:\..+)?)|Practitioner:(?:name(?:\..+)?|telecom(?:\..+)?|address(?:\..+)?|gender|birthDate|qualification(?:\..+)?|communication(?:\..+)?)|Location:(?:name|address(?:\..+)?|telecom(?:\..+)?|hoursOfOperation(?:\..+)?|type\.(?:text|coding\.display)|physicalType\.(?:text|coding\.display))|Medication:(?:code\.coding\.display|form(?:\..+)?|ingredient\.itemCodeableConcept(?:\..+)?))$/;

/** Shared references are never resolved; both literal and declared target types must be legal. */
function sharedReferenceReason(node: Record<string, unknown>, element: ResolvedElement): string | undefined {
  const parsed = typeof node.reference === 'string' ? parseReference(node.reference, SANITIZE_REFERENCE_BASE) : undefined;
  const declared = declaredType(node.type);
  const types = [parsed?.type, declared].filter((type): type is string => type !== undefined);
  if (types.some(type => SHARED_PERSON_TARGETS.has(type)) || parsed?.patientLike || declared === 'patient-like') return 'SHARED_PERSON_REFERENCE_WITHHELD';
  if (parsed?.form === 'unsupported') return 'REFERENCE_TARGET_TYPE_WITHHELD';
  if (element.targets?.length && !element.targets.includes('http://hl7.org/fhir/StructureDefinition/Resource')
      && types.some(type => !element.targets!.includes(`http://hl7.org/fhir/StructureDefinition/${type}`))) return 'REFERENCE_TARGET_TYPE_WITHHELD';
  return undefined;
}

// The payload-bearing keys the walk withholds. Withholding depends on key and schema context only, never on
// the value's JSON shape. Only a schema-declared complex element of the same name (Consent.provision.data,
// TriggerDefinition.data) is walked as structure, and a string there is still withheld.
const PAYLOAD_KEYS = new Set(['data', 'valueBase64Binary']);
function payloadPosition(key: string, element: ResolvedElement, value: unknown): boolean {
  if (value === undefined) return false;
  // base64Binary content is a payload by type wherever it is declared (ElementDefinition fixed/pattern/defaultValue/example
  // values, Device.udiCarrier.carrierAIDC, AuditEvent.entity.query, every *Base64Binary choice), and an undeclared
  // *Base64Binary key is one by name. Attachment.hash, the only base64Binary element named `hash`, is manifest metadata.
  if ((element.types.includes('base64Binary') && element.name !== 'hash') || (!element.types.length && /Base64Binary$/.test(key))) return true;
  return PAYLOAD_KEYS.has(key) && (typeof value === 'string' || !element.types.length || element.types.some(type => /^[a-z]/.test(type)));
}

/** Sanitize-format pointers of whole reference nodes to withhold (`UNVERIFIED_REFERENCE_WITHHELD`); set only by {@link sanitizeForDelivery}. */
export interface SanitizeOptions { withholdReferences?: ReadonlySet<string> }
export function sanitize(resource: FhirResource, privacy: GatewayConfig['privacy'] = {}, options: SanitizeOptions = {}): Sanitized {
  const patientIdentifierSystems = new Set(privacy.patientIdentifierSystems ?? []);
  const structuralStringAllowed = (field: string, node: Record<string, unknown>) => SHARED_STRUCTURAL_STRING_EXCEPTIONS.some(rule => rule.fields.test(field) && rule.allows(node, patientIdentifierSystems));
  const manifests: Record<string, unknown>[] = [];
  const manifestOrigins: ManifestOrigin[] = [];
  const omitted: string[] = [];
  let requiresStructuralView = false;
  let narrativeOmitted = false;
  const withheld = Symbol('withheld');
  const withhold = (path: string, reason: string, inModifier: boolean, metadata: Record<string, unknown> = {}, origin: ManifestOrigin = 'policy') => {
    manifests.push({ path, reason, ...metadata });
    manifestOrigins.push(origin);
    omitted.push(path);
    // A policy-withheld modifier prohibits a confident clinical interpretation.
    if (inModifier) requiresStructuralView = true;
    return withheld;
  };
  interface Scope { type: string; root: string; shared: boolean; identifier?: boolean }
  // `attachment` drives withholding (schema, shape or path spelling: conservative). `inAttachment` is the
  // schema-declared Attachment context, own or inherited, and drives only the manifest origin classification.
  const walk = (value: unknown, path: string, key: string, parent: Record<string, unknown>, element: ResolvedElement, attachment: boolean, inAttachment: boolean, inModifier: boolean, inherited: Scope): unknown => {
    const metadata = () => attachment ? attachmentMetadata(parent) : {};
    const linkOrigin: ManifestOrigin = inAttachment ? 'attachment' : attachment || !element.types.length ? 'unknown' : 'policy';
    // An unverifiable clinical-actor reference chosen by the judge is withheld whole, with every child and companion.
    if (options.withholdReferences?.has(path) && value && typeof value === 'object' && !Array.isArray(value)) return withhold(path, 'UNVERIFIED_REFERENCE_WITHHELD', inModifier, {}, element.types.length ? 'policy' : 'unknown');
    // Payload keys and the attachment link are withheld by key and schema context before the value's JSON
    // shape is consulted; an object, array, number, boolean or null carries bytes or a capability as a string does.
    if (payloadPosition(key, element, value)) return withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, metadata(), 'payload');
    // Attachment context comes from the schema (Patient.photo, presentedForm, ...) even without contentType.
    if (key === 'url' && attachment) return withhold(path, 'PROTECTED_LINK', inModifier, metadata(), linkOrigin);
    // A scalar where the schema declares a Reference, a Resource or another reference-carrying structure is
    // malformed linkage: withheld, never screened as prose or passed through as a leaf.
    if (malformedLinkage(element, value)) return withhold(path, 'MALFORMED_LINKAGE_WITHHELD', inModifier);
    // Any other scalar where the schema declares only complex types is malformed structure; one standing for an
    // Attachment is withheld as a payload.
    if (malformedComplex(element, value)) return element.types.includes('Attachment') ? withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, {}, 'payload') : withhold(path, 'MALFORMED_STRUCTURE_WITHHELD', inModifier);
    if (typeof value === 'string') {
      const prose = element.types.length === 1 && ['string', 'markdown'].includes(element.types[0]!) && !uriKey(key);
      if (prose) {
        const redacted = redactTextLinks(value);
        if (!redacted.spans) return value;
        manifests.push({ path, reason: 'PROTECTED_LINK_IN_TEXT', spans: redacted.spans });
        manifestOrigins.push('link_text');
        omitted.push(path);
        if (inModifier) requiresStructuralView = true;
        return redacted.text;
      }
      // Hardening: a link span inside a non-prose, non-URI value (a code, an undeclared vendor string)
      // withholds the whole value; such values are never rewritten in place.
      const opaque = !isUriElement(element) && !uriKey(key) && redactTextLinks(value).spans > 0;
      return opaque || protectedLink(value, key, isUriElement(element)) ? withhold(path, 'PROTECTED_LINK', inModifier, metadata(), linkOrigin) : value;
    }
    // Lossless decimal scalars pass through sanitize unchanged.
    if (isFhirDecimal(value) || isPrecisionFault(value)) return value;
    // Keep primitive-array positions aligned with their FHIR _element metadata.
    if (Array.isArray(value)) {
      const primitive = element.types.some(type => /^[a-z]/.test(type));
      return value.flatMap((item, i) => {
        const result = walk(item, `${path}/${i}`, key, parent, element, attachment, inAttachment, inModifier, inherited);
        return result === withheld ? (primitive ? [null] : []) : [result];
      });
    }
    if (!value || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    // Only a schema-declared contained Resource can inherit its parent's scope.
    if (malformedResource(element, node)) return withhold(path, 'MALFORMED_LINKAGE_WITHHELD', inModifier);
    // A resourceType smuggled onto a shared scalar/datatype is unclassified.
    if (inherited.shared && typeof node.resourceType === 'string' && !(key === 'contained' && element.types.includes('Resource'))) return withhold(path, 'UNDECLARED_PROPERTY_WITHHELD', inModifier, {}, 'unknown');
    let scope: Scope = typeof node.resourceType === 'string' ? { type: node.resourceType, root: path, shared: path === '' ? resourceClass(node.resourceType) === 'shared' : inherited.shared } : inherited;
    if (node.modifierExtension || node.implicitRules) requiresStructuralView = true;
    const context: TypeContext | undefined = typeof node.resourceType === 'string' ? resourceTypeContext(node.resourceType) : element.context;
    if (context?.definition === 'Identifier' && context.path === '') scope = { ...scope, identifier: true };
    const isReference = context?.definition === 'Reference' && context.path === '';
    // Resource.type (for example StructureDefinition.type) is not Reference.type.
    const referenceLike = typeof node.resourceType !== 'string' && (isReference || node.reference !== undefined || (node.type !== undefined && (node.identifier !== undefined || node.display !== undefined || node._display !== undefined)));
    // A reference whose reference or type member cannot be read is malformed linkage as a whole.
    if (referenceLike && unreadableLinkage(node, context, isReference)) return withhold(path, 'MALFORMED_LINKAGE_WITHHELD', inModifier);
    if (scope.shared && context?.definition === 'Identifier' && context.path === '' && typeof node.system === 'string' && patientIdentifierSystems.has(node.system)) return withhold(path, 'PATIENT_IDENTIFIER_SYSTEM_WITHHELD', inModifier);
    if (scope.shared && context?.definition === 'Identifier' && context.path === '' && !structuralStringAllowed('Identifier.value', node)) return withhold(path, 'UNCLASSIFIED_IDENTIFIER_WITHHELD', inModifier);
    if (scope.shared && referenceLike) {
      const reason = sharedReferenceReason(node, element);
      if (reason) return withhold(path, reason, inModifier, {}, element.types.length ? 'policy' : 'unknown');
    }
    const patientReference = referenceLike && ((isReference && element.targets?.length === 1 && element.targets[0] === 'http://hl7.org/fhir/StructureDefinition/Patient') || declaredType(node.type) === 'Patient' || declaredType(node.type) === 'patient-like'
      || (typeof node.reference === 'string' && parseReference(node.reference, SANITIZE_REFERENCE_BASE).patientLike));
    const isAttachment = (context?.definition === 'Attachment' && context.path === '') || node.contentType !== undefined || (node.data !== undefined && payloadPosition('data', resolveElement(context, 'data'), node.data)) || path.toLowerCase().includes('attachment');
    const schemaAttachment = inAttachment || (context?.definition === 'Attachment' && context.path === '');
    // The display/identifier companions of a reference whose target is unverifiable — a
    // conditional form (never resolved), an unsupported/encoded form, or a reference string the
    // egress screen itself withholds — are withheld with it. Authorization already rejects the
    // owning resource on gateway paths; this keeps sanitize safe as a standalone layer.
    const unverifiableReference = typeof node.reference === 'string'
      && (() => { const parsed = parseReference(node.reference, SANITIZE_REFERENCE_BASE); return parsed.form === 'conditional' || parsed.form === 'unsupported' || protectedLink(node.reference, 'reference'); })();
    const omissionsBefore = omitted.length;
    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(node)) {
      // Raw upstream property names are never echoed into resources, manifest paths or omitted fields.
      if (!/^_?[A-Za-z][A-Za-z0-9]{0,63}$/.test(childKey)) { withhold(`${path}/[undeclared-property]`, 'UNDECLARED_PROPERTY_WITHHELD', inModifier); continue; }
      const pointer = `${path}/${childKey}`;
      const childElement = resolveElement(context, childKey);
      const childOrigin: ManifestOrigin = childElement.types.length ? 'policy' : 'unknown';
      if (['__proto__', 'constructor', 'prototype'].includes(childKey)) { omitted.push(pointer); continue; }
      // Only resource-level narrative sets narrativeOmitted; Bundle link/total omission is separate.
      if (childKey === 'text' && typeof node.resourceType === 'string') { narrativeOmitted = true; omitted.push(pointer); continue; }
      if (node.resourceType === 'Bundle' && ['link', 'total'].includes(childKey)) { omitted.push(pointer); continue; }
      // Patient.link is a modifier whose target is always another person's record.
      if (context?.definition === 'Patient' && context.path === 'link' && childKey === 'other') { withhold(pointer, 'FOREIGN_PATIENT_REFERENCE_WITHHELD', true, {}, childOrigin); continue; }
      if (patientReference && ['display', '_display', 'identifier', 'extension', '_reference', '_type'].includes(childKey)) { withhold(pointer, 'PATIENT_REFERENCE_COMPANION_WITHHELD', inModifier, {}, childOrigin); continue; }
      if (unverifiableReference && (childKey === 'display' || childKey === '_display' || childKey === 'identifier')) { withhold(pointer, 'UNVERIFIED_REFERENCE_COMPANION_WITHHELD', inModifier, {}, childOrigin); continue; }
      const field = `${scope.type}.${pointer.slice(scope.root.length + 1).replaceAll('/', '.').replace(/\._?\d+(?=\.|$)/g, '').replace(/(^|\.)_/g, '$1')}`;
      if (scope.shared && D1_MASKS.has(field)) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }
      const recordMask = PATIENT_RECORD_MASKS.get(field);
      if (recordMask) { withhold(pointer, recordMask, inModifier); continue; }
      if (childKey === 'extension' && !scope.shared && UNREVIEWED_EXTENSION_TYPES.has(scope.type)) { withhold(pointer, 'UNREVIEWED_EXTENSION_WITHHELD', inModifier); continue; }
      const catalog = ['CodeSystem', 'ValueSet', 'CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition'].includes(scope.type);
      const scalar = resolveElement(context, childKey.startsWith('_') ? childKey.slice(1) : childKey);
      const residualDisplay = CATALOG_DISPLAY.test(`${scope.type}:${field.slice(scope.type.length + 1)}`);
      const structuralString = structuralStringAllowed(typeof node.resourceType === 'string' && childKey.replace(/^_/, '') === 'id' ? 'Resource.id' : isReference ? `Reference.${childKey.replace(/^_/, '')}` : context?.definition === 'Coding' && context.path === '' ? `Coding.${childKey.replace(/^_/, '')}` : context?.definition === 'Identifier' && context.path === '' ? `Identifier.${childKey.replace(/^_/, '')}` : field, node);
      if (catalog && (['contact', 'publisher'].includes(childKey.replace(/^_/, ''))
          || (scalar.types.some(type => type === 'string' || type === 'markdown') && !structuralString && !residualDisplay))) { withhold(pointer, 'SOURCE_PROSE_WITHHELD', inModifier); continue; }
      if (scope.shared && childKey !== 'resourceType' && !childElement.types.length) { withhold(`${path}/[undeclared-property]`, 'UNDECLARED_PROPERTY_WITHHELD', inModifier, {}, 'unknown'); continue; }
      const residual = !scope.identifier && D1_RESIDUAL.test(`${scope.type}:${field.slice(scope.type.length + 1)}`);
      if (scope.shared && scalar.types.some(type => type === 'string' || type === 'markdown') && !structuralString && !residual && !residualDisplay) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }
      if (scope.shared && isReference && ['display', '_display', 'identifier'].includes(childKey)) {
        if (childKey !== 'identifier' || walk(child, pointer, childKey, node, childElement, isAttachment, schemaAttachment, inModifier, scope) !== withheld) withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier);
        continue;
      }
      const transformed = walk(child, pointer, childKey, node, childElement, isAttachment, schemaAttachment, inModifier || Boolean(childElement.modifier), scope);
      if (transformed !== withheld) result[childKey] = transformed;
    }
    // Drop newly emptied complex entries; leaf omissions already carry their labels.
    if (path && Object.keys(result).length === 0 && omitted.length > omissionsBefore) return withheld;
    return result;
  };
  const sanitized = walk(resource, '', '', {}, { types: [] }, false, false, false, { type: resource.resourceType, root: '', shared: false }) as FhirResource;
  return { resource: sanitized, manifests, manifestOrigins, omitted, retrievedAt: new Date().toISOString(), requiresStructuralView, narrativeOmitted };
}

// ---------------------------------------------------------------------------
// Projection.
// ---------------------------------------------------------------------------

export interface ProjectionWarning { code: string; message: string }
export interface Projection { resource: FhirResource; omitted: string[]; unresolved: string[]; warnings?: ProjectionWarning[]; recipe?: string }

/**
 * Reviewed compact recipes, versioned against R4 4.0.1. Field names are
 * declared element names; choice elements (`[x]`) are kept whole through
 * resolveElement. Every root isModifier element, `id`, `meta` (versionId,
 * profile, security) and primitive companions are always added, `contained`
 * is kept when a kept element references it (`#id`), and each kept
 * element keeps its codings and code systems. Types without a recipe fall back
 * to the sanitized full view with COMPACT_RECIPE_UNAVAILABLE.
 */
export const COMPACT_RECIPE_SET = 'r4-compact-2026-10-18.1';
export const COMPACT_RECIPES: Readonly<Record<string, { id: string; fields: readonly string[] }>> = {
  Patient: { id: 'Patient.compact.1', fields: ['active', 'name', 'gender', 'birthDate', 'deceased[x]'] },
  Observation: { id: 'Observation.compact.1', fields: ['status', 'category', 'code', 'subject', 'focus', 'effective[x]', 'issued', 'value[x]', 'dataAbsentReason', 'interpretation', 'bodySite', 'method', 'referenceRange', 'hasMember', 'component'] },
  Condition: { id: 'Condition.compact.1', fields: ['clinicalStatus', 'verificationStatus', 'category', 'severity', 'code', 'bodySite', 'subject', 'onset[x]', 'abatement[x]', 'recordedDate'] },
  AllergyIntolerance: { id: 'AllergyIntolerance.compact.1', fields: ['clinicalStatus', 'verificationStatus', 'type', 'category', 'criticality', 'code', 'patient', 'onset[x]', 'recordedDate', 'lastOccurrence', 'reaction'] },
  MedicationRequest: { id: 'MedicationRequest.compact.1', fields: ['status', 'statusReason', 'intent', 'category', 'priority', 'doNotPerform', 'reported[x]', 'medication[x]', 'subject', 'authoredOn', 'requester', 'reasonCode', 'courseOfTherapyType', 'dosageInstruction', 'dispenseRequest'] },
  Immunization: { id: 'Immunization.compact.1', fields: ['status', 'statusReason', 'vaccineCode', 'patient', 'occurrence[x]', 'primarySource', 'lotNumber', 'site', 'route', 'doseQuantity', 'isSubpotent', 'subpotentReason', 'reasonCode', 'protocolApplied'] },
  DiagnosticReport: { id: 'DiagnosticReport.compact.1', fields: ['status', 'category', 'code', 'subject', 'effective[x]', 'issued', 'result', 'conclusion', 'conclusionCode', 'presentedForm'] },
  DocumentReference: { id: 'DocumentReference.compact.1', fields: ['status', 'docStatus', 'type', 'category', 'subject', 'date', 'author', 'description', 'securityLabel', 'relatesTo', 'content', 'context'] },
};
const RECIPE_UNAVAILABLE: ProjectionWarning = { code: 'COMPACT_RECIPE_UNAVAILABLE', message: 'No reviewed compact recipe exists for this resource type; the full sanitized view is returned instead.' };
const MODIFIERS_ADDED: ProjectionWarning = { code: 'MODIFIER_FIELDS_ADDED', message: 'Modifier elements needed to interpret the selected fields were added to the projection.' };

function containsModifierExtension(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 64) return false;
  if (Array.isArray(value)) return value.some(item => containsModifierExtension(item, depth + 1));
  return Object.entries(value).some(([key, child]) => key === 'modifierExtension' || containsModifierExtension(child, depth + 1));
}

export function project(resource: FhirResource, format: 'compact' | 'fhir', fields?: string[]): FhirResource {
  return projection(resource, format, fields).resource;
}

export function projection(resource: FhirResource, format: 'compact' | 'fhir', fields?: string[]): Projection {
  const root = resourceTypeContext(resource.resourceType);
  if (fields) {
    type Tree = { [key: string]: Tree | true };
    // Null-prototype nodes: field segments are caller text, and a plain-object lookup of `toString`, `hasOwnProperty`,
    // ... would descend into the inherited builtin and write the next segment onto it, process-wide.
    const tree: Tree = Object.create(null) as Tree;
    const unresolved: string[] = [];
    // A primitive exists when either its value or its `_element` companion does (extension-only primitives).
    const hasPath = (value: unknown, parts: string[]): boolean => {
      if (parts.length === 0) return true;
      if (Array.isArray(value)) return value.some(item => hasPath(item, parts));
      // Decimal scalars and precision markers are opaque leaves; paths into them never resolve.
      if (!value || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value)) return false;
      const [head, ...rest] = parts as [string, ...string[]];
      const node = value as Record<string, unknown>;
      if (!rest.length) return Object.hasOwn(node, head) || Object.hasOwn(node, `_${head}`);
      return (Object.hasOwn(node, head) && hasPath(node[head], rest)) || (Object.hasOwn(node, `_${head}`) && hasPath(node[`_${head}`], rest));
    };
    for (const path of fields) {
      const parts = path.split('.');
      if (parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part)) || !hasPath(resource, parts)) { unresolved.push(path); continue; }
      let branch = tree;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if (branch[part] === true) break;
        if (i === parts.length - 1) branch[part] = true;
        else { branch[part] ??= Object.create(null) as Tree; branch = branch[part] as Tree; }
      }
    }
    let added = false;
    const pick = (value: unknown, node: Tree, context: TypeContext | undefined): unknown => {
      if (Array.isArray(value)) return value.map(item => pick(item, node, context));
      if (!value || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value)) return value;
      const source = value as Record<string, unknown>;
      // A nested resource (contained) is picked in its own type context and keeps its identity,
      // so its modifier elements are resolved and added like a root resource's.
      const nested = typeof source.resourceType === 'string' ? source.resourceType : undefined;
      if (nested) context = resourceTypeContext(nested);
      const result: Record<string, unknown> = nested ? { resourceType: nested, ...(Object.hasOwn(source, 'id') ? { id: source.id } : {}) } : {};
      for (const [key, sub] of Object.entries(node)) {
        for (const name of [key, `_${key}`]) {
          if (!Object.hasOwn(source, name)) continue;
          const child = source[name];
          if (sub === true) result[name] = cloneFhirValue(child);
          else if (child && typeof child === 'object' && !isFhirDecimal(child) && !isPrecisionFault(child)) result[name] = pick(child, sub, resolveElement(context, name).context);
        }
      }
      // Any returned object keeps its modifier children whole, so a selection can never drop a negation.
      for (const key of Object.keys(source)) if (!Object.hasOwn(result, key) && resolveElement(context, key).modifier) { result[key] = cloneFhirValue(source[key]); added = true; }
      return result;
    };
    const selected = { resourceType: resource.resourceType, ...(resource.id ? { id: resource.id } : {}), ...pick(resource, tree, root) as Record<string, unknown> } as FhirResource;
    return { resource: selected, omitted: Object.keys(resource).filter(key => !Object.hasOwn(selected, key)).map(key => `/${key}`), unresolved, ...(added ? { warnings: [MODIFIERS_ADDED] } : {}) };
  }
  if (format === 'fhir' || resource.implicitRules || containsModifierExtension(resource)) return { resource: cloneFhirValue(resource), omitted: [], unresolved: [] };
  const recipe = Object.hasOwn(COMPACT_RECIPES, resource.resourceType) ? COMPACT_RECIPES[resource.resourceType]! : undefined;
  if (!recipe || !root) return { resource: cloneFhirValue(resource), omitted: [], unresolved: [], warnings: [RECIPE_UNAVAILABLE] };
  const fieldsKept = new Set(recipe.fields);
  const recipeKeep = (key: string) => {
    const base = key.startsWith('_') ? key.slice(1) : key;
    if (base === 'resourceType' || base === 'id' || base === 'meta') return true;
    const element = resolveElement(root, base);
    return Boolean(element.name && (fieldsKept.has(element.name) || element.modifier));
  };
  // A kept element holding a local `#id` reference keeps `contained` (already authorized and
  // sanitized, modifiers included); otherwise the reference would dangle and its facts would be lost.
  let visited = 0;
  const localReference = (value: unknown, depth = 0): boolean => {
    if (!value || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value) || depth > 64) return false;
    if (++visited > 100000) return true; // Undecidable within bounds: keep contained rather than dangle.
    if (Array.isArray(value)) return value.some(item => localReference(item, depth + 1));
    return Object.entries(value).some(([key, child]) => (key === 'reference' && typeof child === 'string' && child.startsWith('#')) || (key !== 'contained' && localReference(child, depth + 1)));
  };
  const keepContained = Object.entries(resource).some(([key, value]) => key !== 'contained' && recipeKeep(key) && localReference(value));
  const keep = (key: string) => (key === 'contained' || key === '_contained') && keepContained ? true : recipeKeep(key);
  return { resource: Object.fromEntries(Object.entries(resource).filter(([key]) => keep(key)).map(([key, value]) => [key, cloneFhirValue(value)])) as FhirResource, omitted: Object.keys(resource).filter(key => !keep(key)).map(key => `/${key}`), unresolved: [], recipe: `${COMPACT_RECIPE_SET}/${recipe.id}` };
}

// ---------------------------------------------------------------------------
// Configuration checks for privacy.sharedIdentifierSystems.
// ---------------------------------------------------------------------------

/**
 * Well-known person identifier systems a shared record may never carry, refused even when no patient identifier systems are
 * configured. This is a small, US-centred floor, not a complete registry: operators still list their own patient systems.
 */
const PERSON_IDENTIFIER_SYSTEMS = new Set([
  'http://hl7.org/fhir/sid/us-ssn', 'urn:oid:2.16.840.1.113883.4.1',
  'http://hl7.org/fhir/sid/us-mbi', 'urn:oid:2.16.840.1.113883.4.927',
  'http://hl7.org/fhir/sid/us-medicare', 'urn:oid:2.16.840.1.113883.4.572',
]);
const PERSON_IDENTIFIER_SYSTEM_PREFIXES = ['http://hl7.org/fhir/sid/passport-', 'urn:oid:2.16.840.1.113883.4.3.'];
const normalizedSystem = (value: string): string => {
  try { return new URL(value).href.toLowerCase(); } catch { return value.toLowerCase(); }
};

/** A listable shared identifier system: an absolute URI with a non-empty body and nothing the egress link screen would withhold. */
export function safeSharedIdentifierSystem(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && value === value.trim() && !/[\x00-\x20\x7f]/.test(value)
    && /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(value) && URL.canParse(value) && !protectedLink(value, 'system', true);
}

/**
 * A listable shared profile canonical: 1 to 256 characters, an absolute `http://`, `https://` or
 * `urn:` URI with no whitespace or control characters, nothing the egress link screen would withhold (no userinfo, query or
 * fragment), and a host right after `//` for http(s). A canonical version suffix (`|1.0`) is allowed; matching is exact.
 */
export function safeSharedProfile(value: string): boolean {
  if (value.length < 1 || value.length > 256 || /[\x00-\x20\x7f]/.test(value) || !/^(?:https?:\/\/[^/?#]|urn:[A-Za-z0-9][A-Za-z0-9-]*:\S)/.test(value)) return false;
  return URL.canParse(value) && !protectedLink(value, 'profile', true);
}

/** True when `value` is a well-known person identifier system (exactly, case-insensitively or after URL serialisation). */
export function personIdentifierSystem(value: string): boolean {
  const lower = value.toLowerCase(), normal = normalizedSystem(value);
  return [...PERSON_IDENTIFIER_SYSTEMS].some(system => system === value || system.toLowerCase() === lower || normalizedSystem(system) === normal)
    || PERSON_IDENTIFIER_SYSTEM_PREFIXES.some(prefix => lower.startsWith(prefix.toLowerCase()) || normal.startsWith(prefix.toLowerCase()));
}

/** Conservative overlap: exact, ASCII case-insensitive, or equal after WHATWG URL serialisation. Matching itself stays exact. */
export function identifierSystemsOverlap(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase() || normalizedSystem(a) === normalizedSystem(b);
}
