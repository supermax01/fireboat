// Owner: P (projection, delivery, repair usability) after gate-F handoff.
// Imports shared frozen types plus schema/decimal/privacy helpers only;
// P must never import Q (query.ts/search/support/generated), even indirectly.
import type { ProjectionMeta, SanitizedProjectionRecord } from './m3b.js';
import { LAB_EVIDENCE_RECIPE_ID, type FhirResource } from './contracts.js';
import { cloneFhirValue, isFhirDecimal, isPrecisionFault } from './decimal.js';
import { projection as sanitizedProjection } from './privacy.js';
import { resolveElement, resourceTypeContext } from './schema.js';

/** Lab-evidence Observation roots (spec §4), complete values and companions kept whole. */
export const LAB_OBSERVATION_ROOTS = [
  'status', 'category', 'code', 'subject', 'focus', 'effective[x]', 'issued', 'value[x]',
  'dataAbsentReason', 'interpretation', 'bodySite', 'method', 'specimen', 'device',
  'referenceRange', 'hasMember', 'derivedFrom', 'component',
] as const;

const STRUCTURAL_WARNING = { code: 'UNINTERPRETED_MODIFIER', message: 'Resource contains modifier semantics; this view is not a clinical interpretation. Inspect the full retained evidence before use.' };

/**
 * Identity/security supplement (spec §4): of `meta`, only versionId, profile,
 * security, SUBSETTED tags and their primitive companions survive compact or
 * selected projection. Returns the filtered meta (or undefined) and the
 * actually-present dropped meta paths.
 */
export function metaSupplement(resource: FhirResource): { meta?: Record<string, unknown>; omitted: string[] } {
  const meta = resource.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { omitted: [] };
  const kept: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    const base = key.startsWith('_') ? key.slice(1) : key;
    if (['versionId', 'profile', 'security'].includes(base)) { kept[key] = cloneFhirValue(value); continue; }
    if (base === 'tag') {
      const tags = Array.isArray(value) ? value : [value];
      const subsetted = tags.filter(tag => Boolean(tag && typeof tag === 'object' && (tag as { code?: unknown }).code === 'SUBSETTED'));
      if (subsetted.length) kept[key] = cloneFhirValue(subsetted);
      if (subsetted.length < tags.length) omitted.push(`/meta/${key}`);
      continue;
    }
    omitted.push(`/meta/${key}`);
  }
  return { ...(Object.keys(kept).length ? { meta: kept } : {}), omitted };
}

function containsModifierSemantics(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value)) return false;
  if (depth > 64) return true; // Fail closed: undecidable depth forces the structural view.
  if (Array.isArray(value)) return value.some(item => containsModifierSemantics(item, depth + 1));
  return Object.entries(value).some(([key, child]) => key === 'modifierExtension' || key === 'implicitRules' || containsModifierSemantics(child, depth + 1));
}

function localReference(value: unknown): boolean {
  let visitedBudget = 0;
  const visit = (value: unknown, depth = 0): boolean => {
  if (!value || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value)) return false;
  if (depth > 64) return true; // Undecidable within bounds: keep contained rather than dangle.
  if (++visitedBudget > 100000) return true; // Undecidable within bounds: keep contained rather than dangle.
  if (Array.isArray(value)) return value.some(item => visit(item, depth + 1));
  return Object.entries(value).some(([key, child]) => (key === 'reference' && typeof child === 'string' && child.startsWith('#')) || (key !== 'contained' && visit(child, depth + 1)));
  };
  return visit(value);
}

/**
 * The lab-evidence projector for one Observation (recipe
 * `r4-lab-evidence-v1/Observation.2`). Kept roots stay whole — codings,
 * Quantity comparators/systems, components and ranges are never pruned or
 * normalized. Root modifier elements are always kept; `contained` is kept
 * when a kept element references it. Callers must not apply this to a
 * resource requiring the structural view.
 */
export function projectLabObservation(resource: FhirResource): { resource: FhirResource; omitted: string[] } {
  const root = resourceTypeContext(resource.resourceType);
  const keptRoots: ReadonlySet<string> = new Set(LAB_OBSERVATION_ROOTS);
  const supplement = metaSupplement(resource);
  const keepRoot = (key: string): boolean => {
    const base = key.startsWith('_') ? key.slice(1) : key;
    if (base === 'resourceType' || base === 'id' || base === 'meta') return true;
    const element = resolveElement(root, base);
    return Boolean(element.name && (keptRoots.has(element.name) || element.modifier));
  };
  const keepContained = Object.entries(resource).some(([key, value]) => key !== 'contained' && keepRoot(key) && localReference(value));
  const keep = (key: string): boolean => ((key === 'contained' || key === '_contained') && keepContained ? true : keepRoot(key));
  const projected: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(resource)) {
    if (key === 'meta') {
      if (supplement.meta) projected.meta = supplement.meta;
      else omitted.push('/meta');
      continue;
    }
    if (keep(key)) projected[key] = cloneFhirValue(value);
    else omitted.push(`/${key}`);
  }
  return { resource: projected as FhirResource, omitted: [...omitted, ...supplement.omitted] };
}

/** Actual selection omissions, including partially selected nested objects.
 * FHIR numeric wrappers are opaque leaves, never traversable object fields. */
function selectedOmissions(source: unknown, selected: unknown, path = ''): string[] {
  if (!source || typeof source !== 'object' || isFhirDecimal(source) || isPrecisionFault(source)) return [];
  const kept = selected && typeof selected === 'object' ? selected as Record<string, unknown> : {};
  return Object.entries(source).flatMap(([key, value]) => {
    if (!path && key === 'meta') return []; // Supplement owns meta omissions, including filtered tag arrays.
    const pointer = Array.isArray(source) ? path : `${path}/${key}`;
    return Object.hasOwn(kept, key) && kept[key] !== undefined ? selectedOmissions(value, kept[key], pointer) : [pointer];
  });
}

/** Re-add the §4 identity supplement that a field selection may have dropped. */
function withSupplement(source: FhirResource, projected: FhirResource): { resource: FhirResource; omitted: string[] } {
  const supplement = metaSupplement(source);
  const result: Record<string, unknown> = { ...projected, resourceType: source.resourceType };
  if (source.id !== undefined) result.id = source.id;
  else delete result.id;
  if (Object.hasOwn(source, '_id')) result._id = cloneFhirValue(source._id);
  // A selected local reference must keep its already-authorized/sanitized
  // contained evidence whole; selection cannot turn it into a dangling fact.
  if (source.contained && Object.entries(result).some(([key, value]) => key !== 'contained' && localReference(value))) {
    result.contained = cloneFhirValue(source.contained);
  }
  // Selecting into a contained resource keeps that contained evidence whole too, so its meta, security
  // labels and versionId never arrive partially (S5 review).
  if (source.contained && Object.hasOwn(result, 'contained')) result.contained = cloneFhirValue(source.contained);
  // Explicit selection adds metadata alongside the protected supplement.
  const existingMeta = (result.meta && typeof result.meta === 'object' && !Array.isArray(result.meta)) ? result.meta as Record<string, unknown> : {};
  if (supplement.meta) result.meta = { ...existingMeta, ...supplement.meta };
  // Selection can add metadata, but partial arrays/objects cannot replace a
  // protected root. Merge tags at their source positions before filtering so
  // SUBSETTED codings and companions stay whole without attaching selected
  // fields from a different coding to them.
  const mergedMeta = result.meta as Record<string, unknown> | undefined;
  const sourceMeta = source.meta as Record<string, unknown> | undefined;
  if (mergedMeta && supplement.meta) {
    if (Array.isArray(sourceMeta?.tag) && Array.isArray(existingMeta.tag)) {
      mergedMeta.tag = sourceMeta.tag.map((tag, index) => tag && typeof tag === 'object' && tag.code === 'SUBSETTED'
        ? cloneFhirValue(tag) : cloneFhirValue((existingMeta.tag as unknown[])[index]));
    }
  }
  const omitted = selectedOmissions(source, result);
  // Compare residual metadata by source position, including unselected tags
  // before a kept SUBSETTED coding. Public paths stay index-free.
  const alignedMeta = { ...mergedMeta };
  // A malformed non-array source meta.tag is kept in its source shape, so the array wrap in
  // metaSupplement neither reshapes the delivered value nor reports a spurious residual omission.
  const resultMeta = result.meta as Record<string, unknown> | undefined;
  if (resultMeta && resultMeta.tag !== undefined && sourceMeta?.tag !== undefined && !Array.isArray(sourceMeta.tag)) {
    resultMeta.tag = cloneFhirValue(sourceMeta.tag);
    alignedMeta.tag = sourceMeta.tag;
  }
  if (Array.isArray(sourceMeta?.tag) && !Array.isArray(existingMeta.tag)) {
    alignedMeta.tag = sourceMeta.tag.map(tag => tag && typeof tag === 'object' && tag.code === 'SUBSETTED' ? tag : undefined);
  }
  const metaOmitted = sourceMeta ? selectedOmissions(sourceMeta, alignedMeta, '/meta') : [];
  return { resource: result as FhirResource, omitted: [...omitted, ...metaOmitted] };
}

export interface ProjectedRecord { resource: FhirResource; meta: ProjectionMeta }

/**
 * Project one neutral sanitized record and describe the result. Structural
 * records always render the full sanitized FHIR view and are never labelled
 * a clinical compact interpretation. Compact Observations use the lab
 * recipe; other compact types keep their integrated recipes via privacy.ts.
 */
export function projectSanitized(record: SanitizedProjectionRecord, format: 'fhir' | 'compact', fields?: readonly string[]): ProjectedRecord {
  const structural = record.requiresStructuralView || containsModifierSemantics(record.resource);
  if (structural) {
    const view = sanitizedProjection(record.resource, 'fhir');
    const supplemented = { resource: view.resource, omitted: view.omitted };
    return {
      resource: supplemented.resource,
      meta: {
        omitted_fields: sortedUnique([...record.policyOmitted, ...supplemented.omitted]),
        unresolved_fields: [...view.unresolved],
        interpretation: 'structural',
        warnings: dedupeWarnings([STRUCTURAL_WARNING, ...(view.warnings ?? [])]),
      },
    };
  }
  if (fields) {
    const view = sanitizedProjection(record.resource, format, [...fields]);
    const supplemented = withSupplement(record.resource, view.resource);
    return {
      resource: supplemented.resource,
      meta: {
        omitted_fields: sortedUnique([...record.policyOmitted, ...supplemented.omitted]),
        unresolved_fields: [...view.unresolved],
        interpretation: 'clinical_projection',
        warnings: dedupeWarnings(view.warnings ?? []),
      },
    };
  }
  if (format === 'compact' && record.resource.resourceType === 'Observation' && resourceTypeContext('Observation')) {
    const lab = projectLabObservation(record.resource);
    return {
      resource: lab.resource,
      meta: {
        recipe_id: LAB_EVIDENCE_RECIPE_ID,
        omitted_fields: sortedUnique([...record.policyOmitted, ...lab.omitted]),
        unresolved_fields: [],
        interpretation: 'clinical_projection',
        warnings: [],
      },
    };
  }
  const view = sanitizedProjection(record.resource, format);
  return {
    resource: view.resource,
    meta: {
      ...(view.recipe ? { recipe_id: view.recipe } : {}),
      omitted_fields: sortedUnique([...record.policyOmitted, ...view.omitted]),
      unresolved_fields: [...view.unresolved],
      interpretation: 'clinical_projection',
      warnings: dedupeWarnings(view.warnings ?? []),
    },
  };
}

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();
function dedupeWarnings<T extends { code: string }>(warnings: readonly T[]): T[] {
  const byCode = new Map<string, T>();
  for (const warning of warnings) if (!byCode.has(warning.code)) byCode.set(warning.code, warning);
  return [...byCode.values()];
}

/** Frozen gate-F API (spec §10.6): projection metadata for one sanitized record. */
export function projectionMeta(record: SanitizedProjectionRecord, format: 'fhir' | 'compact', fields?: readonly string[]): ProjectionMeta {
  return projectSanitized(record, format, fields).meta;
}

/**
 * Response-local indexed provenance (§0.4): identity resolves from the
 * delivered resources themselves. The input MUST be exactly the delivered
 * records, in delivery order (after oversized/precision-refused records are
 * removed); root asserts `records.length` against the delivered page.
 */
export function indexedProvenance(records: readonly SanitizedProjectionRecord[]): { resource_index: number; retrieved_at: string }[] {
  return records.map((record, resource_index) => ({ resource_index, retrieved_at: record.retrievedAt }));
}

/** Deduplicated recipe IDs for one envelope (§4), first-seen order. */
export function collectRecipeIds(metas: readonly ProjectionMeta[]): string[] {
  return [...new Set(metas.flatMap(meta => meta.recipe_id ? [meta.recipe_id] : []))];
}

/** Per-record retained-inspection omission rows (§4); indexes the retained slice, never clinical provenance. */
export function retainedOmissions(records: readonly SanitizedProjectionRecord[], format: 'fhir' | 'compact', fields?: readonly string[]) {
  return records.map((record, resource_index) => {
    const meta = projectionMeta(record, format, fields);
    const version = (record.resource.meta as { versionId?: unknown } | undefined)?.versionId;
    return {
      resource_index,
      resource_type: record.resource.resourceType,
      // P-15: the frozen inspection schema caps id/version at 64 chars;
      // over-long upstream values are omitted from the row, never fatal.
      ...(record.resource.id && record.resource.id.length <= 64 ? { id: record.resource.id } : {}),
      ...(typeof version === 'string' && version.length <= 64 ? { version } : {}),
      ...(meta.recipe_id ? { recipe_id: meta.recipe_id } : {}),
      omitted_fields: meta.omitted_fields,
      withheld_reasons: [...record.withheldReasons],
      interpretation: meta.interpretation,
    };
  });
}
