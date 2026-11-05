import { createHash } from 'node:crypto';
import pinsFile from './generator-pins.json' with { type: 'json' };

export type QuickstartFaultCode =
  | 'PIN_MISSING' | 'PIN_UNSTABLE' | 'PIN_INVALID' | 'PIN_MISMATCH'
  | 'MANIFEST_INVALID' | 'TARGET_MISMATCH' | 'INSTANCE_FOREIGN' | 'BACKEND_MISMATCH'
  | 'TARGET_NOT_FRESH' | 'SEED_NOT_LISTED' | 'SEED_ALREADY_ATTEMPTED'
  | 'PROXY_REFUSED' | 'REDIRECT_REFUSED' | 'HTTP_FAILED' | 'HTTP_STATUS'
  | 'HTTP_LIMIT' | 'HTTP_TIMEOUT' | 'HTTP_RESPONSE_INVALID'
  | 'LAUNCH_NOT_ABSOLUTE' | 'LAUNCH_INVALID' | 'CLEANUP_FOREIGN' | 'CLEANUP_FAILED'
  | 'DOCKER_MISSING' | 'DOCKER_FAILED' | 'DOCKER_TIMEOUT' | 'DOCKER_LIMIT' | 'DOCKER_EVIDENCE_INVALID'
  | 'DOCKER_ENDPOINT_REFUSED' | 'PORT_IN_USE'
  | 'RUN_LOCKED' | 'RUN_INVALID' | 'RUN_IO' | 'HELPER_ASSET_MISMATCH' | 'HELPER_MANIFEST_DRIFT'
  | 'SETUP_ORACLE_FAILED' | 'READINESS_FAILED' | 'CLI_USAGE' | 'HELPER_FAILED'
  | 'VERIFY_RUN_INVALID' | 'VERIFY_CONFIG_INVALID' | 'VERIFY_DOCTOR' | 'VERIFY_HANDLE_MISSING' | 'VERIFY_DRAIN_LIMIT';

export class QuickstartFault extends Error {
  readonly code: QuickstartFaultCode;
  constructor(code: QuickstartFaultCode) { super(code); this.name = 'QuickstartFault'; this.code = code; }
}
export const fault = (code: QuickstartFaultCode): QuickstartFault => new QuickstartFault(code);
export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const hasKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
export function freezeCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); }
  };
  freeze(copy);
  return copy;
}

export type GeneratorPins = typeof pinsFile;
export const GENERATOR_PINS: GeneratorPins = freezeCopy(pinsFile);
// Bind the schema reference itself to the adopted pins/inputs. A damaged or
// edited JSON file must not redefine which fields and values are required.
export const GENERATOR_PINS_SHA256 = 'cf62b40b41ae24b80f3dc3e11980f5c10725c3729cca71e49d0612648121867d';
const complete = (actual: unknown, expected: unknown): boolean => {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((v, i) => complete(actual[i], v));
  if (isRecord(expected)) return isRecord(actual) && Object.entries(expected).every(([k, v]) =>
    Object.hasOwn(actual, k) && complete(actual[k], v));
  return actual !== undefined;
};
export const pinsComplete = (value: unknown): value is GeneratorPins => complete(value, GENERATOR_PINS);
export const stableTag = (value: unknown): boolean => typeof value === 'string' && /^v\d+\.\d+\.\d+$/.test(value);

// Completeness and value validation are separate obligations. Present leaves must
// match the adopted contract; absent leaves are rejected by pinsComplete.
function comparePresent(actual: unknown, expected: unknown): void {
  if (Array.isArray(actual)) {
    if (!Array.isArray(expected) || actual.length !== expected.length) throw fault('PIN_INVALID');
    actual.forEach((v, i) => comparePresent(v, expected[i]));
  } else if (isRecord(actual)) {
    if (!isRecord(expected)) throw fault('PIN_INVALID');
    for (const [key, value] of Object.entries(actual)) {
      if (!Object.hasOwn(expected, key)) throw fault('PIN_INVALID');
      comparePresent(value, expected[key]);
    }
  } else if (actual !== expected) throw fault('PIN_MISMATCH');
}
export function validateGeneratorPins(value: unknown): GeneratorPins {
  pinsSha256();
  if (!pinsComplete(value)) throw fault('PIN_MISSING');
  const pins = value as GeneratorPins;
  if (!stableTag(pins.synthea.tag)) throw fault('PIN_UNSTABLE');
  if (typeof pins.generation.asOf !== 'string' ||
    pins.generation.endDate !== pins.generation.asOf.slice(0, 10).replaceAll('-', '')) throw fault('PIN_MISMATCH');
  comparePresent(pins, GENERATOR_PINS);
  return freezeCopy(pins);
}

export const QUICKSTART_TARGET = Object.freeze({ origin: 'http://127.0.0.1:18080', basePath: '/fhir' });
export const SEED_LIMITS = Object.freeze({ resources: 2048, types: 32, bodyBytes: 1_048_576, totalBytes: 8_388_608 });
export type SeedResource = Readonly<{
  type: string; id: string; bytes: number; sha256: string; origin: 'natural' | 'edge';
}>;
export type BackendIdentity = Readonly<{
  imageIndexDigest: string; imageManifestDigest: string; imageConfigDigest: string;
  softwareName: 'HAPI FHIR Server'; softwareVersion: '8.12.0'; fhirVersion: '4.0.1';
}>;
export type SeedManifest = Readonly<{
  schema: 1;
  target: Readonly<{ origin: string; basePath: string }>;
  pinsSha256: string;
  composeSha256: string;
  artifacts: Readonly<{ generatorSha256: string; configSha256: string; rawExportsSha256: string; transformSha256: string }>;
  backend: BackendIdentity;
  resources: readonly SeedResource[];
}>;
export const resourceType = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z][A-Za-z0-9]{0,63}$/.test(value);
export const resourceId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9.-]{1,64}$/.test(value) && value !== '.' && value !== '..';
export const pinsSha256 = (): string => {
  const actual = sha256(JSON.stringify(GENERATOR_PINS));
  if (actual !== GENERATOR_PINS_SHA256) throw fault('PIN_MISMATCH');
  return actual;
};

export function validateSeedManifest(value: unknown): SeedManifest {
  const invalid = (): never => { throw fault('MANIFEST_INVALID'); };
  if (!isRecord(value) || !hasKeys(value, ['schema', 'target', 'pinsSha256', 'composeSha256', 'artifacts', 'backend', 'resources'])) invalid();
  const m = value as Record<string, unknown>;
  if (m.schema !== 1 || !isRecord(m.target) || !hasKeys(m.target, ['origin', 'basePath']) ||
    m.target.origin !== QUICKSTART_TARGET.origin || m.target.basePath !== QUICKSTART_TARGET.basePath ||
    m.pinsSha256 !== pinsSha256() || !isSha256(m.composeSha256)) invalid();
  if (!isRecord(m.artifacts) || !hasKeys(m.artifacts, ['generatorSha256', 'configSha256', 'rawExportsSha256', 'transformSha256']) ||
    !Object.values(m.artifacts).every(isSha256)) invalid();
  if (!isRecord(m.backend) || !hasKeys(m.backend, ['imageIndexDigest', 'imageManifestDigest', 'imageConfigDigest', 'softwareName', 'softwareVersion', 'fhirVersion']) ||
    m.backend.imageIndexDigest !== GENERATOR_PINS.hapi.indexDigest || !isDigest(m.backend.imageManifestDigest) ||
    !isDigest(m.backend.imageConfigDigest) || m.backend.softwareName !== 'HAPI FHIR Server' ||
    m.backend.softwareVersion !== '8.12.0' || m.backend.fhirVersion !== '4.0.1') invalid();
  if (!Array.isArray(m.resources) || m.resources.length === 0 || m.resources.length > SEED_LIMITS.resources) invalid();
  const seen = new Set<string>(), types = new Set<string>();
  let bytes = 0;
  for (const r of m.resources as unknown[]) {
    if (!isRecord(r) || !hasKeys(r, ['type', 'id', 'bytes', 'sha256', 'origin']) || !resourceType(r.type) ||
      !resourceId(r.id) || !Number.isSafeInteger(r.bytes) || (r.bytes as number) < 1 ||
      (r.bytes as number) > SEED_LIMITS.bodyBytes || !isSha256(r.sha256) || !['natural', 'edge'].includes(r.origin as string)) invalid();
    const row = r as unknown as SeedResource, key = `${row.type}/${row.id}`;
    if (seen.has(key)) invalid();
    seen.add(key); types.add(row.type); bytes += row.bytes;
  }
  if (types.size > SEED_LIMITS.types || bytes > SEED_LIMITS.totalBytes) invalid();
  return freezeCopy(value as SeedManifest);
}
export const seedTypes = (manifest: SeedManifest): string[] =>
  [...new Set(['Patient', 'Observation', ...manifest.resources.map(r => r.type)])].sort();
