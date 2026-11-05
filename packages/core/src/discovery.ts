// Owner: Q (typed discovery, support, query proof).
// Immutable metadata snapshots for search_parameter and support discovery
// (spec sections 1 and 6). Metadata only, never clinical bodies. Cursors
// are high-entropy store handles bound to source, context, policy, auth
// epoch, topic, filter and revision; any mismatch, expiry, eviction or
// wrong-store use reads uniformly as DISCOVERY_EXPIRED.
import { createHash } from 'node:crypto';
import { stringifyFhir } from './decimal.js';
import type { DiscoverySnapshot } from './m3b.js';
import { retainDeclaredName, selectPinnedDefinition, withheldCapabilityNames, type DeclaredSearchParam, type SearchParameterView } from './search-parameters.js';
import type { SupportRow } from './support.js';
import { ResultStore, type RetentionLedger } from './store.js';
import { GatewayFault } from './transport.js';

// Patient-bound clinical routes cannot expose global source-authored conformance prose.
export const UNSUPPORTED_CLINICAL_RESOURCES: ReadonlySet<string> = new Set(['CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition']);
export function assertClinicalResource(type: string): void {
  if (UNSUPPORTED_CLINICAL_RESOURCES.has(type)) {
    throw new GatewayFault('UNSUPPORTED_RESOURCE', 'Resource type is not available to this workload.');
  }
}

export const R4_TYPE_INTERACTIONS: ReadonlySet<string> = new Set([
  'read', 'vread', 'update', 'patch', 'delete', 'history-instance', 'history-type', 'create', 'search-type',
]);

/** Closed catalog names only: grammar-shaped source tokens can still carry patient identifiers. */
export function listedSearchParameters(type: string, declared: readonly DeclaredSearchParam[]): { names: string[]; withheldCount: number } {
  const names = declared.filter(param => selectPinnedDefinition(type, param.name).status === 'selected').map(param => param.name);
  return { names, withheldCount: declared.length - names.length };
}

export interface DiscoveryBinding {
  sourceAlias: string;
  contextHandle: string;
  policyRevision: string;
  authEpoch: number;
  sourceRevision: string;
}

export interface SearchParameterSnapshotValue extends Extract<DiscoverySnapshot, { topic: 'search_parameter' }> {
  binding: DiscoveryBinding;
  filter: { name?: string; query?: string };
  parameters: SearchParameterView[];
  totalParameters: number;
  offset?: number;
}

export interface SupportSnapshotValue extends Extract<DiscoverySnapshot, { topic: 'support' }> {
  binding: DiscoveryBinding;
  resourceType?: string;
  rows: SupportRow[];
  offset?: number;
}

export interface ServerSummaryRow {
  type: string;
  resource_class: 'patient' | 'shared' | 'ambiguous';
  implemented_interactions: ('read' | 'search-type')[];
}
export interface ServerSnapshotValue extends Extract<DiscoverySnapshot, { topic: 'server' }> {
  binding: DiscoveryBinding;
  rows: ServerSummaryRow[];
  offset?: number;
}
export type DiscoverySnapshotValue = SearchParameterSnapshotValue | SupportSnapshotValue | ServerSnapshotValue;

/**
 * Normalized capability revision (CA-3): hashes only gate-relevant identity,
 * sorted deterministically. Cosmetic CapabilityStatement fields and source
 * documentation never enter the hash and are never retained to compute it.
 * R2-4: the withheld-canonical, invalid-type and duplicate-conflict flags
 * participate (booleans only, never the withheld value) because each one
 * changes executability, so a permission change can never outlive a
 * snapshot or cache keyed on this revision.
 */
export function normalizedCapabilityRevision(
  fhirVersion: string,
  capabilities: readonly { type: string; interactions: readonly string[]; declared: readonly DeclaredSearchParam[]; ambiguous?: boolean; withheldNameCount?: number; withheldNameRevision?: number }[],
): string {
  const normalized = {
    fhir_version: fhirVersion,
    resources: [...capabilities]
      .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
      .map(resource => {
        // Also normalize callers supplying pre-filter declarations. The gateway
        // supplies the already-screened count; raw names and private keyed
        // digests never enter the public revision. A local counter tracks replacements.
        const withheld = resource.withheldNameCount === undefined ? withheldCapabilityNames(resource.declared, resource.type) : resource;
        return {
          type: resource.type,
          ...(resource.ambiguous ? { ambiguous: true } : {}),
          ...(withheld.withheldNameCount ? { withheld_name_count: withheld.withheldNameCount } : {}),
          ...(resource.withheldNameRevision ? { withheld_name_revision: resource.withheldNameRevision } : {}),
          interactions: [...new Set(resource.interactions)].sort(),
          search_parameters: [...resource.declared]
            .filter(param => retainDeclaredName(param.name, resource.type))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .map(param => ({ name: param.name, ...(param.type ? { type: param.type } : {}), ...(param.definition ? { definition: param.definition } : {}), ...(param.definition_withheld ? { definition_withheld: true } : {}), ...(param.type_invalid ? { type_invalid: true } : {}), ...(param.duplicate_conflict ? { duplicate_conflict: true } : {}) })),
        };
      }),
  };
  return createHash('sha256').update(stringifyFhir(normalized)).digest('hex').slice(0, 16);
}

export interface DiscoveryStoreOptions {
  ledger: RetentionLedger;
  snapshotBytes?: number;
  maxHandles?: number;
  ttlMs?: number;
  now?: () => number;
}

/** Separate metadata store charging the shared retention ledger as a subquota. */
export function createDiscoveryStore(options: DiscoveryStoreOptions): ResultStore<DiscoverySnapshotValue> {
  return new ResultStore<DiscoverySnapshotValue>(
    options.snapshotBytes ?? 524288,
    options.maxHandles ?? 32,
    options.ttlMs ?? 300000,
    options.now ?? Date.now,
    { ledger: options.ledger, role: 'discovery', evictableKinds: ['cur'], unavailableCode: 'DISCOVERY_EXPIRED' },
  );
}

/** Detach caller-owned arrays before retaining a deeply immutable metadata snapshot. */
function immutableSnapshot<T>(value: T): T {
  const copy = JSON.parse(stringifyFhir(value)) as T;
  const freeze = (node: unknown): void => {
    if (node && typeof node === 'object') { Object.values(node).forEach(freeze); Object.freeze(node); }
  };
  freeze(copy);
  return copy;
}

function bindingsEqual(a: DiscoveryBinding, b: DiscoveryBinding): boolean {
  return a.sourceAlias === b.sourceAlias && a.contextHandle === b.contextHandle
    && a.policyRevision === b.policyRevision && a.authEpoch === b.authEpoch && a.sourceRevision === b.sourceRevision;
}

const expired = (): GatewayFault => new GatewayFault('DISCOVERY_EXPIRED', 'Discovery snapshot is unavailable or expired; repeat the original discovery query.');

export function freezeSearchParameterSnapshot(
  store: ResultStore<DiscoverySnapshotValue>,
  value: Omit<SearchParameterSnapshotValue, 'offset'>,
  originalExpiry?: number,
): { handle: string; expires_at: string } {
  const { offset, ...snapshot } = value as DiscoverySnapshotValue;
  return store.put('cur', immutableSnapshot(snapshot), originalExpiry, { offset });
}

export function freezeSupportSnapshot(
  store: ResultStore<DiscoverySnapshotValue>,
  value: Omit<SupportSnapshotValue, 'offset'>,
  originalExpiry?: number,
): { handle: string; expires_at: string } {
  const { offset, ...snapshot } = value as DiscoverySnapshotValue;
  return store.put('cur', immutableSnapshot(snapshot), originalExpiry, { offset });
}

/** Freeze only metadata rows and binding/freshness; patient_id is injected per response. */
export function freezeServerSnapshot(
  store: ResultStore<DiscoverySnapshotValue>, value: Omit<ServerSnapshotValue, 'offset'>, originalExpiry?: number,
): { handle: string; expires_at: string } {
  const { offset, ...snapshot } = value as ServerSnapshotValue;
  return store.put('cur', immutableSnapshot(snapshot), originalExpiry, { offset });
}

/** Read a snapshot only when topic and every binding field still match. */
export function readDiscoverySnapshot<T extends DiscoverySnapshotValue['topic']>(
  store: ResultStore<DiscoverySnapshotValue>,
  cursor: string,
  binding: DiscoveryBinding,
  topic: T,
): { value: Extract<DiscoverySnapshotValue, { topic: T }>; expires_at: string } {
  let found: { value: DiscoverySnapshotValue; expires_at: string };
  try {
    if (!cursor.startsWith('cur_')) throw expired();
    found = store.get(cursor);
  } catch {
    throw expired();
  }
  if (found.value.topic !== topic || !bindingsEqual(found.value.binding, binding)) throw expired();
  return found as { value: Extract<DiscoverySnapshotValue, { topic: T }>; expires_at: string };
}

/** Continuation handle over the same frozen blob; only the offset overlay differs. */
export function advanceDiscoveryCursor(
  store: ResultStore<DiscoverySnapshotValue>,
  cursor: string,
  binding: DiscoveryBinding,
  topic: DiscoverySnapshotValue['topic'],
  nextOffset: number,
): { handle: string; expires_at: string } {
  const { value, expires_at } = readDiscoverySnapshot(store, cursor, binding, topic);
  const originalExpiry = Date.parse(expires_at);
  return store.putBatch([{
    prefix: 'cur',
    value: { ...value, offset: undefined },
    overlay: { offset: nextOffset },
    originalExpiry,
  }])[0]!;
}

/**
 * Fit one metadata page into a byte budget without skipping rows. The page
 * shrinks from the requested limit; one indivisible oversized row refuses
 * with OUTPUT_LIMIT so the caller can narrow instead of losing evidence.
 */
export function fitDiscoveryPage<T>(rows: readonly T[], offset: number, limit: number, byteBudget: number): { page: T[]; nextOffset?: number } {
  const window = rows.slice(offset, offset + limit);
  let page = [...window];
  const fits = (candidate: T[]): boolean => Buffer.byteLength(stringifyFhir(candidate)) <= byteBudget;
  while (page.length > 1 && !fits(page)) page.pop();
  if (page.length && !fits(page)) {
    throw new GatewayFault('OUTPUT_LIMIT', 'A discovery entry exceeds this budget; narrow the discovery query or request a larger allowed budget.');
  }
  const nextOffset = offset + page.length;
  return { page, ...(nextOffset < rows.length ? { nextOffset } : {}) };
}
