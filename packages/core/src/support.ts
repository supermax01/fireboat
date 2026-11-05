// Owner: Q (typed discovery, support, query proof).
// Exact supported-type list and workflow linkage (spec section 6). The
// manifest is documentation of the enforcement authorities, never a
// permission source by itself: privacy.ts resourceClass / authorized /
// sharedInstanceAllowed stay authoritative and tests pin equality.
import { WORKFLOW_ID } from './contracts.js';
import { SHARED_INSTANCE_POLICY, patientLinkForType, resourceClass } from './privacy.js';
import { projectionMeta } from './projection.js';
import r4Index from './generated/r4-index.json' with { type: 'json' };
import matrixFile from './data/support-matrix.json' with { type: 'json' };

export interface SupportMatrixRow {
  resource_type: string;
  policy_class: 'patient' | 'conditional_shared' | 'denied';
  patient_link: string | null;
  instance_policy: string;
  compact_recipe: string | null;
  workflow_role: 'required' | 'optional' | 'outside_workflow';
  limitations: string[];
}

export interface SupportRow extends SupportMatrixRow {
  source_advertised: boolean;
  advertised_interactions: string[];
  policy_interactions: ('read' | 'search-type')[];
  executable_interactions: ('read' | 'search-type')[];
}

interface MatrixFile {
  revision: string;
  policy_revision: string;
  workflow: string;
  denominator: { package: string; version: string; source_sha256: string; resource_type_count: number };
  document_support: string;
  clinical_sections: string[];
  // instance_policy is the <=120-char wire summary (frozen schema cap);
  // instance_policy_full retains the exact SHARED_INSTANCE_POLICY text for
  // drift checking and generated docs. See the contract note in the Q report.
  rows: (SupportMatrixRow & { instance_policy_full?: string; test_ids?: string[] })[];
  decided_against: { resource_type: string; reason: string }[];
}

const matrix = matrixFile as unknown as MatrixFile;
export const SUPPORT_MATRIX_REVISION = matrix.revision;
export const SUPPORT_POLICY_REVISION = matrix.policy_revision;
export const SUPPORT_DENOMINATOR = matrix.denominator;
export const CLINICAL_SECTIONS: readonly string[] = matrix.clinical_sections;
export const REQUIRED_RESOURCES = ['Patient', 'Observation'] as const;
export const DECIDED_AGAINST: ReadonlyMap<string, string> = new Map(matrix.decided_against.map(entry => [entry.resource_type, entry.reason]));

const wireRow = (row: MatrixFile['rows'][number]): SupportMatrixRow => ({
  resource_type: row.resource_type, policy_class: row.policy_class, patient_link: row.patient_link,
  instance_policy: row.instance_policy, compact_recipe: row.compact_recipe,
  workflow_role: row.workflow_role, limitations: [...row.limitations],
});
const STATIC_ROWS: ReadonlyMap<string, SupportMatrixRow> = new Map(matrix.rows.map(row => [row.resource_type, wireRow(row)]));

/** The 25 classified types in manifest order: 15 patient-linked, then 10 conditional shared. */
export function classifiedTypes(): string[] {
  return matrix.rows.map(row => row.resource_type);
}

/** Static policy row for one type. Unknown types are denied by default, never probed. */
export function supportForType(resourceType: string): SupportMatrixRow {
  const known = STATIC_ROWS.get(resourceType);
  if (known) return { ...known, limitations: [...known.limitations] };
  const reason = DECIDED_AGAINST.get(resourceType);
  return {
    resource_type: resourceType,
    policy_class: 'denied',
    patient_link: null,
    instance_policy: 'Unclassified types are denied by default.',
    compact_recipe: null,
    workflow_role: 'outside_workflow',
    limitations: [reason ?? 'No tested patient-linkage or shared-instance policy exists for this type.'],
  };
}

export interface SourceAdvertisement {
  type: string;
  interactions: readonly string[];
}

export interface EffectiveSupportInput {
  /** Source-advertised resource entries from discovery. */
  advertised: readonly SourceAdvertisement[];
  /** Patient types whose confinement predicate resolved as executable. */
  confinementExecutable: ReadonlySet<string>;
  /** Optional single-type filter; unknown types still return their denied row. */
  resourceType?: string;
}

const IMPLEMENTABLE = ['read', 'search-type'] as const;

/**
 * Intersect manifest policy, source advertisement and resolved confinement.
 * Source advertisement alone never makes a type executable, and shared
 * membership stays conditional on per-instance policy.
 */
export function effectiveSupport(input: EffectiveSupportInput): SupportRow[] {
  const advertisedByType = new Map(input.advertised.map(entry => [entry.type, entry]));
  const types = input.resourceType !== undefined ? [input.resourceType] : classifiedTypes();
  return types.map(type => {
    const base = supportForType(type);
    const advertised = advertisedByType.get(type);
    const advertisedInteractions = advertised ? [...advertised.interactions].slice(0, 16) : [];
    const policyInteractions = base.policy_class === 'denied' ? [] : [...IMPLEMENTABLE];
    const executableInteractions = policyInteractions.filter(interaction => {
      if (!advertisedInteractions.includes(interaction)) return false;
      if (interaction === 'search-type' && base.policy_class === 'patient' && type !== 'Patient') {
        return input.confinementExecutable.has(type);
      }
      return true;
    });
    return {
      ...base,
      source_advertised: advertised !== undefined,
      advertised_interactions: advertisedInteractions,
      policy_interactions: policyInteractions,
      executable_interactions: executableInteractions,
    };
  });
}

export function workflowSupport(): {
  workflow: typeof WORKFLOW_ID;
  matrix_revision: string;
  required_resources: readonly ['Patient', 'Observation'];
  document_support: 'metadata_only';
  clinical_sections: readonly string[];
} {
  return {
    workflow: WORKFLOW_ID,
    matrix_revision: SUPPORT_MATRIX_REVISION,
    required_resources: REQUIRED_RESOURCES,
    document_support: 'metadata_only',
    clinical_sections: CLINICAL_SECTIONS,
  };
}

export type SupportMatrixFile = MatrixFile;

/**
 * Drift guard: every manifest claim must equal the enforcement exports.
 * Returns human-readable mismatches; empty means the matrix is honest.
 * R2-7: accepts an injected matrix so the negative (drift) cases are
 * testable; production callers use the bundled manifest.
 */
export function supportMatrixDrift(candidate: SupportMatrixFile = matrix): string[] {
  const issues: string[] = [];
  // Q-15: the manifest records the enforcement policy revision and test IDs.
  if (candidate.policy_revision !== SHARED_INSTANCE_POLICY.version) issues.push('policy_revision disagrees with SHARED_INSTANCE_POLICY.version');
  if (candidate.rows.length !== 25) issues.push(`expected 25 classified rows, found ${candidate.rows.length}`);
  const denominator = {
    package: r4Index.package, version: r4Index.version, source_sha256: r4Index.source_sha256,
    resource_type_count: Object.values(r4Index.definitions).filter(definition => definition.kind === 'resource').length,
  };
  for (const key of ['package', 'version', 'source_sha256', 'resource_type_count'] as const) {
    if (candidate.denominator[key] !== denominator[key]) issues.push(`denominator.${key} disagrees with generated R4 index`);
  }
  for (const row of candidate.rows) {
    if (!row.test_ids?.length) issues.push(`${row.resource_type}: missing test_ids`);
    const expectedClass = row.policy_class === 'patient' ? 'patient' : 'shared';
    if (resourceClass(row.resource_type) !== expectedClass) issues.push(`${row.resource_type}: policy_class disagrees with resourceClass`);
    if (row.patient_link !== patientLinkForType(row.resource_type)) issues.push(`${row.resource_type}: patient_link disagrees with privacy enforcement`);
    // Probe the gateway's actual projector with an eligible, unselected type,
    // so its lab override and fallback rules remain the recipe authority.
    const expectedRecipe = projectionMeta({
      resource: { resourceType: row.resource_type }, retrievedAt: '', policyOmitted: [],
      withheldReasons: [], requiresStructuralView: false,
    }, 'compact').recipe_id ?? null;
    if (row.compact_recipe !== expectedRecipe) issues.push(`${row.resource_type}: compact_recipe disagrees with gateway projection`);
    if (row.policy_class === 'conditional_shared') {
      const constraint = row.resource_type === 'Medication' ? SHARED_INSTANCE_POLICY.constraints.Medication
        : row.resource_type === 'Location' ? SHARED_INSTANCE_POLICY.constraints.Location
          : row.resource_type === 'Organization' ? SHARED_INSTANCE_POLICY.constraints.Organization
            : row.resource_type === 'Practitioner' ? SHARED_INSTANCE_POLICY.constraints.Practitioner
              : SHARED_INSTANCE_POLICY.constraints.conformance;
      if ((row.instance_policy_full ?? row.instance_policy) !== constraint) issues.push(`${row.resource_type}: instance_policy disagrees with SHARED_INSTANCE_POLICY`);
      if (row.instance_policy.length > 120) issues.push(`${row.resource_type}: wire instance_policy exceeds the frozen 120-char cap`);
    }
  }
  for (const required of REQUIRED_RESOURCES) {
    if (candidate.rows.find(row => row.resource_type === required)?.workflow_role !== 'required') issues.push(`${required} must be workflow-required`);
  }
  if (candidate.clinical_sections.length !== 0) issues.push('M3b declares zero clinical sections');
  return issues;
}
