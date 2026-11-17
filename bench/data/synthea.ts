// Synthea reference rewriting: urn:uuid references become Type/id. Conditional references to the shared Organization and
// Practitioner files, which are not downloaded, become logical references.
import type { LosslessValue } from '../lib/json.js';
import { refKind, visitReferences, zeroKinds, type Obj, type RefKind } from './fhir.js';

export interface RewriteStats { inputByKind: Record<RefKind, number>; resolvedConditional: number; logical: Map<string, number> }
export const newRewriteStats = (): RewriteStats => ({ inputByKind: zeroKinds(), resolvedConditional: 0, logical: new Map() });

/**
 * In place: urn:uuid:X -> Type/X (Type from the bundle's fullUrl map); "Type?identifier=system|value" -> Type/id when a
 * resource with that identifier is present, else a logical reference: `reference` removed, `type` set to the named
 * target type, identifier {system, value} added, display kept. Local "#x" and relative Type/id references stay. Anything else stops the conversion.
 */
export function rewriteSyntheaReferences(
  resource: Obj,
  ctx: { fullUrlType: Map<string, string>; byIdentifier: Map<string, string>; where: string; stats: RewriteStats },
): void {
  visitReferences(resource as LosslessValue, ref => {
    const value = ref.reference as string;
    const kind = refKind(value);
    ctx.stats.inputByKind[kind]++;
    switch (kind) {
      case 'literal':
      case 'local':
        return;
      case 'urn_uuid': {
        const type = ctx.fullUrlType.get(value);
        if (!type) throw new Error(`${ctx.where}: unresolved ${value}`);
        ref.reference = `${type}/${value.slice('urn:uuid:'.length)}`;
        return;
      }
      case 'conditional': {
        const m = /^([A-Z][A-Za-z]+)\?identifier=([^|&]+)\|([^&]+)$/.exec(value);
        if (!m) throw new Error(`${ctx.where}: unsupported conditional reference ${value}`);
        const [, type, system, idValue] = m as unknown as [string, string, string, string];
        const id = ctx.byIdentifier.get(`${type}|${system}|${idValue}`);
        if (id) {
          ref.reference = `${type}/${id}`;
          ctx.stats.resolvedConditional++;
          return;
        }
        if ('identifier' in ref) throw new Error(`${ctx.where}: reference already has an identifier`);
        if ('type' in ref && ref.type !== type) throw new Error(`${ctx.where}: reference type ${String(ref.type)} != ${type}`);
        delete ref.reference;
        // Reference.type keeps the target type the conditional reference named, so the logical reference carries the same
        // information (an untyped identifier in an element that may point to a Patient reads as possibly a Patient).
        ref.type = type;
        ref.identifier = { system, value: idValue };
        const k = `${type} ${system}`;
        ctx.stats.logical.set(k, (ctx.stats.logical.get(k) ?? 0) + 1);
        return;
      }
      default:
        throw new Error(`${ctx.where}: unsupported reference ${value}`);
    }
  });
}
