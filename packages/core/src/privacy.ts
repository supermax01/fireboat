import type { FhirResource, GatewayConfig } from './contracts.js';
import { cloneFhirValue, integerValue, isFhirDecimal, isPrecisionFault } from './decimal.js';
import { elementNames, isFhirResourceType, isUriElement, resolveElement, resourceTypeContext, type ResolvedElement, type TypeContext } from './schema.js';

const links: Record<string, string> = { Observation: 'subject', Condition: 'subject', AllergyIntolerance: 'patient', MedicationRequest: 'subject', MedicationStatement: 'subject', Encounter: 'subject', DocumentReference: 'subject', DiagnosticReport: 'subject', Immunization: 'patient', Procedure: 'subject', Coverage: 'beneficiary', ExplanationOfBenefit: 'patient', ServiceRequest: 'subject', Claim: 'patient' };
const shared = new Set(['Medication', 'Organization', 'Location', 'Practitioner', 'CodeSystem', 'ValueSet', 'StructureDefinition', 'SearchParameter', 'CapabilityStatement', 'OperationDefinition']);
/** Type-level class used for capability gating. Instance access additionally requires {@link sharedInstanceAllowed}. */
export function resourceClass(type: string): 'patient' | 'shared' | 'ambiguous' { return type === 'Patient' || type in links ? 'patient' : shared.has(type) ? 'shared' : 'ambiguous'; }

/** Enforcement's patient selector; Patient's search `_id` denotes its own resource id. */
export function patientLinkForType(type: string): string | null {
  return type === 'Patient' ? '_id' : Object.hasOwn(links, type) ? links[type]! : null;
}

// ---------------------------------------------------------------------------
// Shared-instance policy (J-10). A type name alone never makes an instance
// shared: each shared class has a versioned field/extension/profile policy.
// ---------------------------------------------------------------------------

/**
 * Documented synthetic catalog policy. It applies to the single configured
 * synthetic loopback source and pinned R4 4.0.1 base definitions. An instance
 * is shared only when its type has a rule, every root element is in that
 * rule's allowlist, it carries no extension/modifierExtension/implicitRules
 * outside contained resources, `meta.security` is absent, every
 * `meta.profile` is listed below (none are in this synthetic policy), and the
 * type-specific constraint holds. Anything else is unclassified and denied.
 */
export const SHARED_INSTANCE_POLICY = {
  id: 'fhir-mcp.synthetic-catalog', version: '2026-10-19.1', release: 'hl7.fhir.r4.core@4.0.1', source: 'configured synthetic loopback source',
  profiles: [] as readonly string[], extensions: [] as readonly string[],
  constraints: {
    Medication: 'Catalog products only: no identifier or batch; a present code must be fully coded (system and code); ingredients require a coded product code. Free-text-only or uncoded compounds are unclassified.',
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
// V-19: shared Locations are affirmed as facilities, never inferred from the absence of a residential code.
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
const SHARED_RULES: Record<string, { fields: Set<string>; check?: (node: Record<string, unknown>) => boolean }> = {
  Medication: { fields: new Set([...directory, 'contained', 'code', 'status', 'manufacturer', 'form', 'amount', 'ingredient']), check: node => (node.code === undefined || coded(node.code)) && (node.ingredient === undefined || coded(node.code)) },
  Organization: { fields: new Set([...directory, 'identifier', 'active', 'type', 'name', 'alias', 'telecom', 'address', 'partOf', 'endpoint']) },
  Location: { fields: new Set([...directory, 'identifier', 'status', 'operationalStatus', 'name', 'alias', 'description', 'mode', 'type', 'telecom', 'address', 'physicalType', 'position', 'managingOrganization', 'partOf', 'hoursOfOperation', 'availabilityExceptions', 'endpoint']), check: facilityLocation },
  Practitioner: { fields: new Set([...directory, 'identifier', 'active', 'name', 'telecom', 'address', 'gender', 'birthDate', 'photo', 'qualification', 'communication']) },
  ...Object.fromEntries(['CodeSystem', 'ValueSet', 'StructureDefinition', 'SearchParameter', 'CapabilityStatement', 'OperationDefinition'].map(type => [type, { fields: new Set(conformance(type)) }])),
};

/** True only when the instance satisfies {@link SHARED_INSTANCE_POLICY}; contained resources are judged separately by `authorized()`. */
export function sharedInstanceAllowed(resource: Record<string, unknown>): boolean {
  const type = resource.resourceType;
  const rule = typeof type === 'string' && Object.hasOwn(SHARED_RULES, type) ? SHARED_RULES[type]! : undefined;
  if (!rule) return false;
  for (const key of Object.keys(resource)) if (key !== 'resourceType' && !rule.fields.has(key.startsWith('_') ? key.slice(1) : key)) return false;
  const meta = resource.meta as Record<string, unknown> | undefined;
  if (meta !== undefined && (typeof meta !== 'object' || meta === null || Array.isArray(meta))) return false;
  if (meta?.security !== undefined) return false;
  if (meta?.profile !== undefined && !(Array.isArray(meta.profile) && meta.profile.every(profile => SHARED_INSTANCE_POLICY.profiles.includes(profile as string)))) return false;
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
  return clean(resource, 0) && (rule.check?.(resource) ?? true);
}

// ---------------------------------------------------------------------------
// Canonical Patient-reference classification (J-3).
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
// F-1: percent-decoding is applied repeatedly (bounded) so double-encoded forms such as
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
 * malformed or unknown conditional types are labelled unsupported (F-1).
 */
export function parseReference(value: string, base: URL): ParsedReference {
  if (value !== value.trim() || !value) return { form: 'unsupported', patientLike: mentionsPatient(value) };
  if (value.startsWith('#')) return FHIR_ID.test(value.slice(1)) ? { form: 'contained', patientLike: false } : { form: 'unsupported', patientLike: mentionsPatient(value) };
  if (/^urn:(?:uuid|oid):/i.test(value)) return { form: 'urn', patientLike: false };
  const conditional = /^([^/?#:]+)\?/.exec(value);
  if (conditional) {
    // F-1: a conditional reference is only ever *labelled* conditional when its type is a literal,
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
    // F-1 (conservative, documented): every remaining conditional Reference in a Reference or
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
 * J-17/V-3: true when a search value could select a Patient other than the trusted one through any reference
 * parameter (for example `performer=Patient/B`), not only `patient`/`subject`. Explicit Patient reference forms
 * are judged for every parameter. When the CapabilityStatement declares the parameter type `reference`, a bare
 * logical id matches every target type (Patient included) on real servers, so anything that is not an explicit
 * local typed reference — bare ids, cross-origin absolutes, conditional/logical/`urn:` forms and unparseable
 * values — is refused rather than resolved. The bound patient is allowed in any form. Undeclared parameter types
 * are not extended here: token/date values match the id pattern, so that judgement waits for typed discovery
 * (J-26, M3b). Comma-separated values are OR, so every part is checked.
 */
export function foreignPatientSelector(value: string, patientId: string, base: URL, searchParamType?: string): boolean {
  return value.split(',').some(part => {
    const candidate = part.trim();
    if (!candidate) return false;
    const parsed = parseReference(candidate, base);
    const bound = (parsed.form === 'relative' || (parsed.form === 'absolute' && parsed.sameSource)) && parsed.type === 'Patient' && parsed.id === patientId;
    if (bound || candidate === patientId) return false;
    if (parsed.type === 'Patient') return true;
    // F-1: an explicit conditional-shaped patient-like selector (including encoded forms, which now
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
 * R1: true for a scalar (string, number, decimal, boolean or null) where the schema declares a Reference, a
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
export function authorized(resource: FhirResource, patientId: string, base: URL): boolean {
  let nodes = 0;
  const visit = (value: unknown, depth: number, element: ResolvedElement | undefined): boolean => {
    if (++nodes > 100000 || depth > 64) return false;
    // R1: a scalar at a Reference/Resource/reference-carrying position would otherwise be a leaf that never
    // reaches the reference decision; the owning resource is refused like any other unverifiable linkage.
    if (malformedLinkage(element, value)) return false;
    // Decimal scalars and precision markers are leaves: linkage is judged without them, and any precision
    // refusal happens only after authorization (J-6/J-15).
    if (!value || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value)) return true;
    if (Array.isArray(value)) return value.every(child => visit(child, depth + 1, element));
    const node = value as Record<string, unknown>;
    let context = element?.context;
    if (typeof node.resourceType === 'string') {
      const type = node.resourceType;
      const classification = resourceClass(type);
      if (classification === 'ambiguous') return false;
      if (type === 'Patient' && (depth > 0 || node.id !== patientId)) return false;
      if (classification === 'shared' && !sharedInstanceAllowed(node)) return false;
      context = resourceTypeContext(type);
      if (classification === 'patient' && type !== 'Patient') {
        const link = node[links[type]!];
        const linkElement = resolveElement(context, links[type]!);
        if (!link || typeof link !== 'object' || Array.isArray(link) || referenceDecision(link as Record<string, unknown>, patientId, base, 'reference', linkElement.targets) !== 'bound') return false;
      }
    }
    const isReference = context?.definition === 'Reference' && context.path === '';
    const referenceLike = typeof node.reference === 'string' || node.reference !== undefined || (node.type !== undefined && (node.identifier !== undefined || node.display !== undefined));
    // V-20: a reference-shaped node smuggled onto a known non-Reference context is "loose" when any of its
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
// Egress screening (J-11, J-13, J-24, J-36).
// ---------------------------------------------------------------------------

/** Where a withheld manifest came from (S5b). Only `policy` entries may collapse across records. */
/**
 * S5b origin of a withheld manifest entry. Only `policy` entries at schema-known sites collapse at
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
    // credentials under arbitrary names, so this milestone withholds them all.
    const url = new URL(text, 'https://fhir.invalid/');
    const containedReference = key === 'reference' && /^#[A-Za-z0-9.-]{1,64}$/.test(text);
    return ['data:', 'javascript:', 'vbscript:', 'file:', 'blob:'].includes(url.protocol) || Boolean(url.username || url.password || url.search || (url.hash && !containedReference));
  } catch { return true; }
}

/** URL spans inside prose: scheme://, protocol-relative //host, www., and data:/javascript:/vbscript:/file:/blob:/mailto: links. */
const LINK_SPAN = /(?<![A-Za-z0-9+.-])(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*|(?:javascript|vbscript):\S+|data:(?:[\w.+-]+\/[\w.+-]+|[;,])\S*|file:[/\\]\S*|blob:\S+|mailto:\S+|www\.[A-Za-z0-9-]+\.\S*)|(?<![A-Za-z])(?:https?|ftp|wss?):\S+|(?<=^|[\s"'(<[{=])\/\/(?=\[|[A-Za-z0-9][^\s/?#]*?(?:[.:@][A-Za-z0-9[]|\/|[?#]\S))\S*/gi;
export const TEXT_LINK_PLACEHOLDER = '[link withheld]';
const CLOSER_OPEN: Record<string, string> = { ')': '(', ']': '[', '>': '<' };
/** Sentence punctuation and unbalanced closing brackets after a span belong to the prose, not the link. Single linear pass (V-6). */
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

// F-1: sanitize has no configured source; reference *form* classification does not depend on the
// base origin, so a fixed loopback base is enough to spot conditional/unsupported references.
const SANITIZE_REFERENCE_BASE = new URL('http://127.0.0.1/fhir/');

// Frozen D1 operator-attested directory residual field list:
// Organization.{name,type.text,type.coding.display,telecom,address}
// Practitioner.{name,telecom,address,gender,birthDate,qualification,communication}
// Location.{name,address,telecom,hoursOfOperation,type.text,type.coding.display,physicalType.text,physicalType.coding.display}
// Medication.{code.coding.display,form,ingredient.itemCodeableConcept}
// CodeSystem.concept.display; ValueSet.{compose.include.concept.display,expansion.contains.display}
// Only structurally permitted scalar content is residual. References and Identifiers
// nested inside those fields still pass the structural rules below. Shared-instance
// rules apply to standalone shared responses and their contained resources, never contained A-linked content.
// G6 Patient-reference companions are screened everywhere. This is not a
// semantic prose classifier: all five named masks apply even to benign text.
const D1_MASKS = new Set(['Organization.alias', 'Location.alias', 'Location.description', 'Location.availabilityExceptions', 'Medication.code.text']);
const SHARED_PERSON_TARGETS = new Set(['Patient', 'RelatedPerson', 'Person']);
const CATALOG_DISPLAY = /^(?:CodeSystem:concept(?:\.concept)*\.display|ValueSet:compose\.include\.concept\.display|ValueSet:expansion\.contains(?:\.contains)*\.display)$/;

// D1/PH-8/PH-9 computable structural string addendum. This is the single exception
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
// Only the frozen D1 paths attest prose. An Identifier nested in an attested
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

// R2: the payload-bearing keys the walk withholds. Withholding depends on key and schema context only, never on
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

export function sanitize(resource: FhirResource, privacy: GatewayConfig['privacy'] = {}): Sanitized {
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
  // schema-declared Attachment context, own or inherited, and drives only the S5b origin classification.
  const walk = (value: unknown, path: string, key: string, parent: Record<string, unknown>, element: ResolvedElement, attachment: boolean, inAttachment: boolean, inModifier: boolean, inherited: Scope): unknown => {
    const metadata = () => attachment ? attachmentMetadata(parent) : {};
    const linkOrigin: ManifestOrigin = inAttachment ? 'attachment' : attachment || !element.types.length ? 'unknown' : 'policy';
    // R2: payload keys and the attachment link are withheld by key and schema context before the value's JSON
    // shape is consulted; an object, array, number, boolean or null carries bytes or a capability as a string does.
    if (payloadPosition(key, element, value)) return withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, metadata(), 'payload');
    // Attachment context comes from the schema (Patient.photo, presentedForm, ...) even without contentType.
    if (key === 'url' && attachment) return withhold(path, 'PROTECTED_LINK', inModifier, metadata(), linkOrigin);
    // R1: a scalar where the schema declares a Reference, a Resource or another reference-carrying structure is
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
      // V-8 hardening: a link span inside a non-prose, non-URI value (a code, an undeclared vendor string)
      // withholds the whole value; such values are never rewritten in place.
      const opaque = !isUriElement(element) && !uriKey(key) && redactTextLinks(value).spans > 0;
      return opaque || protectedLink(value, key, isUriElement(element)) ? withhold(path, 'PROTECTED_LINK', inModifier, metadata(), linkOrigin) : value;
    }
    // Lossless decimal scalars pass through sanitize unchanged (J-6).
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
    // F-1: the display/identifier companions of a reference whose target is unverifiable — a
    // conditional form (never resolved), an unsupported/encoded form, or a reference string the
    // egress screen itself withholds — are withheld with it. Authorization already rejects the
    // owning resource on gateway paths; this keeps sanitize safe as a standalone layer.
    const unverifiableReference = typeof node.reference === 'string'
      && (() => { const parsed = parseReference(node.reference, SANITIZE_REFERENCE_BASE); return parsed.form === 'conditional' || parsed.form === 'unsupported' || protectedLink(node.reference, 'reference'); })();
    const omissionsBefore = omitted.length;
    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(node)) {
      // V-22: raw upstream property names are never echoed into resources, manifest paths or omitted fields.
      if (!/^_?[A-Za-z][A-Za-z0-9]{0,63}$/.test(childKey)) { withhold(`${path}/[undeclared-property]`, 'UNDECLARED_PROPERTY_WITHHELD', inModifier); continue; }
      const pointer = `${path}/${childKey}`;
      const childElement = resolveElement(context, childKey);
      const childOrigin: ManifestOrigin = childElement.types.length ? 'policy' : 'unknown';
      if (['__proto__', 'constructor', 'prototype'].includes(childKey)) { omitted.push(pointer); continue; }
      // V-23: only resource-level narrative sets narrativeOmitted; Bundle link/total omission is separate.
      if (childKey === 'text' && typeof node.resourceType === 'string') { narrativeOmitted = true; omitted.push(pointer); continue; }
      if (node.resourceType === 'Bundle' && ['link', 'total'].includes(childKey)) { omitted.push(pointer); continue; }
      // Patient.link is a modifier whose target is always another person's record.
      if (context?.definition === 'Patient' && context.path === 'link' && childKey === 'other') { withhold(pointer, 'FOREIGN_PATIENT_REFERENCE_WITHHELD', true, {}, childOrigin); continue; }
      if (patientReference && ['display', '_display', 'identifier', 'extension', '_reference', '_type'].includes(childKey)) { withhold(pointer, 'PATIENT_REFERENCE_COMPANION_WITHHELD', inModifier, {}, childOrigin); continue; }
      if (unverifiableReference && (childKey === 'display' || childKey === '_display' || childKey === 'identifier')) { withhold(pointer, 'UNVERIFIED_REFERENCE_COMPANION_WITHHELD', inModifier, {}, childOrigin); continue; }
      const field = `${scope.type}.${pointer.slice(scope.root.length + 1).replaceAll('/', '.').replace(/\._?\d+(?=\.|$)/g, '').replace(/(^|\.)_/g, '$1')}`;
      if (scope.shared && D1_MASKS.has(field)) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }
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
// Projection (J-4, J-12).
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
    const tree: Tree = {};
    const unresolved: string[] = [];
    // A primitive exists when either its value or its `_element` companion does (extension-only primitives).
    const hasPath = (value: unknown, parts: string[]): boolean => {
      if (parts.length === 0) return true;
      if (Array.isArray(value)) return value.some(item => hasPath(item, parts));
      // V-33: decimal scalars and precision markers are opaque leaves; paths into them never resolve.
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
        else { branch[part] ??= {}; branch = branch[part] as Tree; }
      }
    }
    let added = false;
    const pick = (value: unknown, node: Tree, context: TypeContext | undefined): unknown => {
      if (Array.isArray(value)) return value.map(item => pick(item, node, context));
      if (!value || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value)) return value;
      const source = value as Record<string, unknown>;
      // V-13: a nested resource (contained) is picked in its own type context and keeps its identity,
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
  // V-12: a kept element holding a local `#id` reference keeps `contained` (already authorized and
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
