// The Medplum AccessPolicy of arm Ws (pure; tests/medplum.test.ts). Medplum evaluates it on every read and adds it to
// every search as a filter (repo.ts addAccessPolicyFilters), including _include/_revinclude and $everything targets.

/** Shared types (records that belong to no patient) every patient's client may read: read-only, no criteria. */
export const SHARED_TYPES = ['Medication', 'Location', 'Organization', 'Practitioner'] as const;

/** Read interactions only (Medplum AccessPolicyInteraction codes): no create, update or delete. */
export const READ_INTERACTIONS = ['read', 'vread', 'history', 'search'] as const;

/**
 * One policy per patient: for each patient-compartment type present in the project, only resources in Patient/<id>'s
 * compartment (Medplum `_compartment`, filled on write from the R4 Patient CompartmentDefinition; the Patient resource is
 * in its own compartment), read interactions only; shared types read-only; every other type denied (not listed).
 */
export function patientScopedPolicy(patientId: string, compartmentTypes: readonly string[], projectId: string): Record<string, unknown> {
  const types = [...new Set(['Patient', ...compartmentTypes])].filter(t => !(SHARED_TYPES as readonly string[]).includes(t)).sort();
  return {
    resourceType: 'AccessPolicy',
    meta: { project: projectId },
    name: `fbbench patient scope Patient/${patientId}`,
    resource: [
      ...types.map(t => ({ resourceType: t, criteria: `${t}?_compartment=Patient/${patientId}`, interaction: [...READ_INTERACTIONS] })),
      ...SHARED_TYPES.map(t => ({ resourceType: t, interaction: [...READ_INTERACTIONS] })),
    ],
  };
}

/** Type/id of every resource in a Bundle (entry.resource), or of a single resource. */
export function bundleRefs(body: unknown): string[] {
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  if (!isObj(body)) return [];
  if (body.resourceType === 'Bundle') {
    return (Array.isArray(body.entry) ? body.entry : []).filter(isObj).map(e => e.resource).filter(isObj)
      .filter(r => typeof r.resourceType === 'string' && typeof r.id === 'string').map(r => `${r.resourceType as string}/${r.id as string}`);
  }
  return typeof body.resourceType === 'string' && typeof body.id === 'string' && body.resourceType !== 'OperationOutcome' ? [`${body.resourceType}/${body.id}`] : [];
}
