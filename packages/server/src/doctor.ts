import { z } from 'zod';
import { eligibleSearchProfileIds } from '../../core/src/query.js';
import r4Index from '../../core/src/generated/r4-index.json' with { type: 'json' };
import { ARCHITECTURES, NODE_VERSION, PLATFORMS, SEMVER, SHA256, runtimeVersionAdmitted } from './release.js';

export type DoctorFault = 'RUNTIME_UNSUPPORTED' | 'CONFIG_INVALID' | 'PROFILE_INVALID' | 'ASSET_MISSING' | 'ASSET_INVALID'
  | 'DTO_INVALID' | 'SIGN_IN_UNAVAILABLE' | 'METADATA_UNAVAILABLE' | 'METADATA_INVALID' | 'FHIR_VERSION_UNSUPPORTED' | 'WORKFLOW_TYPE_UNAVAILABLE';
export interface DoctorInput {
  release: { name: string; version: string; schema: '0.4'; catalog: 'm3b-catalog/3' };
  runtime: { node: string; platform: string; arch: string; lossless: 'ok' | 'unsupported'; cell: 'recorded' | 'unverified' };
  source: { alias: string; loopback: 'literal-ok'; auth: 'none' | 'client_credentials' | 'smart_backend_services' | 'smart_standalone_launch'; classification: 'operator-declared-synthetic' };
  /** `not-checked`: the outbound sign-in yielded no usable credential, so the metadata could not be read or judged. */
  metadata: { status: 'ready' | 'unavailable' | 'invalid' | 'not-checked'; fhir: '4.0.1' | 'other' | 'unknown';
    capabilityRevision?: string; summary: 'complete' | 'partial' | 'unknown'; typeCount?: number };
  workflow: { id: 'recent-labs-v1'; patient: 'ready' | 'not-ready'; observation: 'ready' | 'not-ready';
    searchProfile: 'generic-r4' | 'synthetic-fixture-r4-v1' | 'hapi-r4-labs-v1'; proof: 'qualified' | 'unproved' };
  output: { defaultFormat: 'fhir'; delivery: 'full-text-v1' | 'structured-evidence-v1'; defaultBytes: number; maxBytes: number; ttlMs: number; retentionBytes: number };
  artifacts: { r4IndexSha256: string; r4SearchParametersSha256: string; supportMatrixSha256: string };
  privacy: { patientIdentifierSystems: number; sharedIdentifierSystems: number; sharedProfiles: number };
  proxy: 'present' | 'absent';
  faults: readonly DoctorFault[];
}
/** The closed SMART summary: present exactly when `source.auth` is a SMART type. */
export interface DoctorSmart {
  discovery: 'ok' | 'unavailable' | 'invalid'; pkce: 'S256' | 'missing' | 'n/a'; grant: 'present' | 'absent' | 'expired' | 'invalid' | 'n/a';
  patientContext: 'match' | 'n/a'; scope: 'exact' | 'broader' | 'narrower' | 'unknown'; grantedTypes?: number; servedTypes: number;
}
export type DoctorReportInput = DoctorInput & { smart?: DoctorSmart };
export interface DoctorReport { lines: string[]; exitCode: 0 | 1 | 2 }
const FAULTS = ['RUNTIME_UNSUPPORTED', 'CONFIG_INVALID', 'PROFILE_INVALID', 'ASSET_MISSING', 'ASSET_INVALID', 'DTO_INVALID',
  'SIGN_IN_UNAVAILABLE', 'METADATA_UNAVAILABLE', 'METADATA_INVALID', 'FHIR_VERSION_UNSUPPORTED', 'WORKFLOW_TYPE_UNAVAILABLE'] as const;
const OPERATOR_FAULTS: readonly DoctorFault[] = FAULTS.slice(0, 6);
const ready = z.enum(['ready', 'not-ready']);
const count = (min: number, max: number) => z.number().int().min(min).max(max);
const resourceTypes = Object.values(r4Index.definitions).filter(definition => definition.kind === 'resource').length;
const doctorSchema = z.strictObject({
  release: z.strictObject({ name: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/), version: z.string().max(128).regex(SEMVER), schema: z.literal('0.4'), catalog: z.literal('m3b-catalog/3') }),
  runtime: z.strictObject({ node: z.string().max(32).regex(NODE_VERSION), platform: z.enum(PLATFORMS), arch: z.enum(ARCHITECTURES), lossless: z.enum(['ok', 'unsupported']), cell: z.enum(['recorded', 'unverified']) }),
  source: z.strictObject({ alias: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), loopback: z.literal('literal-ok'), auth: z.enum(['none', 'client_credentials', 'smart_backend_services', 'smart_standalone_launch']), classification: z.literal('operator-declared-synthetic') }),
  metadata: z.strictObject({ status: z.enum(['ready', 'unavailable', 'invalid', 'not-checked']), fhir: z.enum(['4.0.1', 'other', 'unknown']),
    capabilityRevision: z.string().regex(/^[a-f0-9]{16}$/).optional(), summary: z.enum(['complete', 'partial', 'unknown']), typeCount: count(0, resourceTypes).optional() })
    // Metadata that was never read carries no metadata facts.
    .refine(metadata => metadata.status !== 'not-checked' || (metadata.fhir === 'unknown' && metadata.summary === 'unknown' && metadata.capabilityRevision === undefined && metadata.typeCount === undefined)),
  workflow: z.strictObject({ id: z.literal('recent-labs-v1'), patient: ready, observation: ready,
    searchProfile: z.enum(eligibleSearchProfileIds() as [string, ...string[]]), proof: z.enum(['qualified', 'unproved']) }),
  output: z.strictObject({ defaultFormat: z.literal('fhir'), delivery: z.enum(['full-text-v1', 'structured-evidence-v1']),
    defaultBytes: count(8192, 131072), maxBytes: count(8192, 131072), ttlMs: count(1, 900000), retentionBytes: count(256, 104857600) })
    .refine(output => output.defaultBytes <= output.maxBytes),
  artifacts: z.strictObject({ r4IndexSha256: z.string().regex(SHA256), r4SearchParametersSha256: z.string().regex(SHA256), supportMatrixSha256: z.string().regex(SHA256) }),
  privacy: z.strictObject({ patientIdentifierSystems: count(0, 32), sharedIdentifierSystems: count(0, 32), sharedProfiles: count(0, 32) }), proxy: z.enum(['present', 'absent']),
  smart: z.strictObject({ discovery: z.enum(['ok', 'unavailable', 'invalid']), pkce: z.enum(['S256', 'missing', 'n/a']), grant: z.enum(['present', 'absent', 'expired', 'invalid', 'n/a']),
    patientContext: z.enum(['match', 'n/a']), scope: z.enum(['exact', 'broader', 'narrower', 'unknown']), grantedTypes: count(0, 64).optional(), servedTypes: count(1, 64) })
    .refine(smart => smart.grantedTypes === undefined || smart.grantedTypes <= smart.servedTypes).optional(),
  faults: z.array(z.enum(FAULTS)).max(FAULTS.length).readonly(),
}).refine(input => (input.smart !== undefined) === input.source.auth.startsWith('smart_'));

// Reject non-JSON properties too: strictObject alone does not reject symbols, accessors or hidden extras.
function plainDto(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string' && /[\x00-\x20\x7f]/.test(value)) return false;
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value) || seen.size > 20) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  if (Reflect.ownKeys(value).some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (Array.isArray(value) && key === 'length') return false;
    return typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor) || !plainDto(descriptor.value, seen);
  })) return false;
  if (Array.isArray(value) && Object.keys(value).some((key, i) => key !== String(i))) return false;
  seen.delete(value);
  return true;
}
function closedDoctorInput(input: unknown): input is DoctorReportInput {
  return plainDto(input) && doctorSchema.safeParse(input).success;
}
const SCOPE = 'scope: local-stdio synthetic-only read-only metadata-only; smart=client-flows-not-certified; classification=operator-declared-unverified';
const invalidInput = (): DoctorReport => ({ lines: ['doctor: fault', 'faults: DTO_INVALID', SCOPE], exitCode: 2 });

/** Pure, closed formatter. Neither raw config nor gateway results belong at this boundary. */
export function doctorReport(input: DoctorReportInput): DoctorReport {
  try {
    if (!closedDoctorInput(input)) return invalidInput();
  } catch { return invalidInput(); }
  const faults = new Set<DoctorFault>(input.faults);
  if (input.runtime.lossless !== 'ok' || !runtimeVersionAdmitted(input.runtime.node)) faults.add('RUNTIME_UNSUPPORTED');
  if (input.metadata.status === 'unavailable') faults.add('METADATA_UNAVAILABLE');
  if (input.metadata.status === 'invalid') faults.add('METADATA_INVALID');
  if (input.metadata.status === 'not-checked') faults.add('SIGN_IN_UNAVAILABLE');
  if (input.metadata.status === 'ready' && input.metadata.fhir !== '4.0.1') faults.add('FHIR_VERSION_UNSUPPORTED');
  if (input.workflow.patient !== 'ready' || input.workflow.observation !== 'ready') faults.add('WORKFLOW_TYPE_UNAVAILABLE');
  const exitCode = [...faults].some(fault => OPERATOR_FAULTS.includes(fault)) ? 2 : faults.size ? 1 : 0;
  const codes = FAULTS.filter(fault => faults.has(fault));
  return { exitCode, lines: [
    `doctor: ${exitCode === 2 ? 'fault' : exitCode === 1 ? 'not-ready' : 'ready'}`,
    `gateway: ${input.release.name} ${input.release.version} schema=${input.release.schema} catalog=${input.release.catalog}`,
    `runtime: node=${input.runtime.node} platform=${input.runtime.platform} arch=${input.runtime.arch} lossless=${input.runtime.lossless} cell=${input.runtime.cell}`,
    `source: alias=${input.source.alias} loopback=${input.source.loopback} auth=${input.source.auth} classification=${input.source.classification}`,
    `metadata: ${input.metadata.status} fhir=${input.metadata.fhir} revision=${input.metadata.capabilityRevision ?? 'unknown'} summary=${input.metadata.summary} types=${input.metadata.typeCount ?? 'unknown'}`,
    `workflow: ${input.workflow.id} patient=${input.workflow.patient} observation=${input.workflow.observation}`,
    `search_profile: ${input.workflow.searchProfile} proof=${input.workflow.proof}${input.workflow.proof === 'unproved' ? ' filter-and-sort-execution=unknown' : ''}`,
    `output: default=${input.output.defaultFormat} delivery=${input.output.delivery} default_bytes=${input.output.defaultBytes} max_bytes=${input.output.maxBytes} ttl_ms=${input.output.ttlMs} retention_bytes=${input.output.retentionBytes}`,
    `privacy: patient_identifier_systems=${input.privacy.patientIdentifierSystems}${input.privacy.patientIdentifierSystems === 0 ? ' residual=unlisted-patient-systems' : ''} shared_identifier_systems=${input.privacy.sharedIdentifierSystems}${input.privacy.sharedIdentifierSystems > 0 && input.privacy.patientIdentifierSystems === 0 ? ' warning=shared-systems-without-patient-systems' : ''} shared_profiles=${input.privacy.sharedProfiles}`,
    `artifacts: r4_index=${input.artifacts.r4IndexSha256.slice(0, 12)} r4_search_parameters=${input.artifacts.r4SearchParametersSha256.slice(0, 12)} support_matrix=${input.artifacts.supportMatrixSha256.slice(0, 12)}`,
    `proxy: ${input.proxy}`,
    ...(input.smart ? [`smart: discovery=${input.smart.discovery} pkce=${input.smart.pkce} grant=${input.smart.grant} patient_context=${input.smart.patientContext} scope=${input.smart.scope} granted_types=${input.smart.grantedTypes ?? 'unknown'}/${input.smart.servedTypes}`] : []),
    `faults: ${codes.join(',') || 'none'}`,
    SCOPE,
  ] };
}
