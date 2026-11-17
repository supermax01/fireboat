// FHIR helpers shared by convert and load. Values come from parseLossless, so numbers stay LosslessNumber.
import { LosslessNumber, type LosslessValue } from '../lib/json.js';

export type Obj = { [key: string]: LosslessValue };

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof LosslessNumber);

/** A relative literal reference "Type/id" (R4 id rules). */
export const LITERAL_REF = /^([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})$/;

/** Visits every Reference-shaped object (any object with a string `reference`), including inside contained resources. */
export function visitReferences(node: LosslessValue, visit: (ref: Obj) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) visitReferences(child, visit);
  } else if (isObj(node)) {
    if (typeof node.reference === 'string') visit(node);
    for (const key of Object.keys(node)) visitReferences(node[key]!, visit);
  }
}

export type RefKind = 'literal' | 'local' | 'urn_uuid' | 'conditional' | 'absolute' | 'other';
export const zeroKinds = (): Record<RefKind, number> => ({ literal: 0, local: 0, urn_uuid: 0, conditional: 0, absolute: 0, other: 0 });

export function refKind(reference: string): RefKind {
  if (LITERAL_REF.test(reference)) return 'literal';
  if (reference.startsWith('#')) return 'local';
  if (reference.startsWith('urn:uuid:')) return 'urn_uuid';
  if (/^[A-Z][A-Za-z]+\?/.test(reference)) return 'conditional';
  if (/^https?:\/\//.test(reference)) return 'absolute';
  return 'other';
}

/** The literal "Type/id" references a resource makes (contained resources included, local "#x" excluded). */
export function literalRefs(resource: Obj): string[] {
  const out: string[] = [];
  visitReferences(resource, r => {
    const ref = r.reference as string;
    if (LITERAL_REF.test(ref)) out.push(ref);
  });
  return out;
}

/** Patient linkage used by patients.json, the dev scope and the per-patient count check: top-level subject or patient. */
export function patientLink(resource: Obj): { field: 'self' | 'subject' | 'patient'; patientId: string } | null {
  if (resource.resourceType === 'Patient' && typeof resource.id === 'string') return { field: 'self', patientId: resource.id };
  for (const field of ['subject', 'patient'] as const) {
    const ref = resource[field];
    if (isObj(ref) && typeof ref.reference === 'string') {
      const m = LITERAL_REF.exec(ref.reference);
      if (m && m[1] === 'Patient') return { field, patientId: m[2]! };
    }
  }
  return null;
}

export function typeAndId(resource: LosslessValue, where: string): { type: string; id: string } {
  if (!isObj(resource) || typeof resource.resourceType !== 'string' || typeof resource.id !== 'string') {
    throw new Error(`${where}: not a resource with resourceType and id`);
  }
  return { type: resource.resourceType, id: resource.id };
}
