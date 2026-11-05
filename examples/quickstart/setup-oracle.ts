import { assertLosslessJsonRuntime, containsPrecisionFault, isFhirDecimal, parseFhirJson } from '../../packages/core/src/decimal.js';
import { fault, isRecord, resourceId, seedTypes, sha256 } from './manifest.js';
import type { SeedManifest } from './manifest.js';
import { HTTP_LIMITS, listedPut } from './seed-http.js';
import type { SeedPut } from './seed-http.js';

export type NumberLexeme = Readonly<{ pointer: string; lexeme: string }>;
export type StoredObservation = Readonly<{
  target: string; versionId: string; rawSha256: string; numbers: readonly NumberLexeme[];
}>;
export type OracleReader = Readonly<{ read: (target: string) => Promise<Buffer>; count: (type: string) => Promise<number> }>;
const fail = (): never => { throw fault('SETUP_ORACLE_FAILED'); };
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function parseResource(bytes: Uint8Array): Record<string, unknown> {
  try {
    assertLosslessJsonRuntime();
    if (bytes.byteLength > HTTP_LIMITS.responseBytes) return fail();
    const value = parseFhirJson(utf8.decode(bytes));
    if (isRecord(value) && !containsPrecisionFault(value)) return value;
  } catch { /* fixed fault below */ }
  return fail();
}
const numberLexeme = (value: unknown): string | undefined =>
  isFhirDecimal(value) ? value.lexeme : typeof value === 'number' ? JSON.stringify(value) : undefined;
function canonical(value: unknown): string {
  const number = numberLexeme(value);
  if (number !== undefined) return `number:${number}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function clinicalBody(value: Record<string, unknown>): Record<string, unknown> {
  const result = { ...value };
  if (result.meta !== undefined) {
    if (!isRecord(result.meta)) return fail();
    const meta = { ...result.meta };
    // Only these root Resource.meta fields may differ on the server.
    for (const key of ['versionId', 'lastUpdated', 'source']) delete meta[key];
    if (Object.keys(meta).length) result.meta = meta; else delete result.meta;
  }
  return result;
}
export const storedMatchesApproved = (approved: Record<string, unknown>, stored: Record<string, unknown>): boolean =>
  canonical(clinicalBody(approved)) === canonical(clinicalBody(stored));

export function requireReferenceClosure(value: unknown, identities: ReadonlySet<string>, depth = 0): void {
  if (depth > 64) return fail();
  if (isFhirDecimal(value) || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(v => requireReferenceClosure(v, identities, depth + 1)); return; }
  const object = value as Record<string, unknown>;
  if (Object.hasOwn(object, 'reference') && (typeof object.reference !== 'string' || !identities.has(object.reference))) return fail();
  Object.values(object).forEach(v => requireReferenceClosure(v, identities, depth + 1));
}
export function numbersOf(value: unknown, pointer = '', result: NumberLexeme[] = []): NumberLexeme[] {
  const lexeme = numberLexeme(value);
  if (lexeme !== undefined) result.push({ pointer, lexeme });
  else if (Array.isArray(value)) value.forEach((v, i) => numbersOf(v, `${pointer}/${i}`, result));
  else if (isRecord(value)) Object.keys(value).sort().forEach(k =>
    numbersOf(value[k], `${pointer}/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`, result));
  return result;
}

export function approvedSeedPuts(manifest: SeedManifest, ndjson: Uint8Array): SeedPut[] {
  let lines: string[];
  try {
    const text = utf8.decode(ndjson);
    if (!text.endsWith('\n')) throw fault('SEED_NOT_LISTED');
    lines = text.slice(0, -1).split('\n');
  } catch { throw fault('SEED_NOT_LISTED'); }
  if (lines.length !== manifest.resources.length) throw fault('SEED_NOT_LISTED');
  const identities = new Set(manifest.resources.map(r => `${r.type}/${r.id}`));
  return manifest.resources.map((row, i) => {
    const body = Buffer.from(lines[i]!), target = `${row.type}/${row.id}`, request: SeedPut = { method: 'PUT', target, body };
    if (!listedPut(request, manifest)) throw fault('SEED_NOT_LISTED');
    const resource = parseResource(body);
    if (resource.resourceType !== row.type || resource.id !== row.id) throw fault('SEED_NOT_LISTED');
    requireReferenceClosure(resource, identities);
    return request;
  });
}

export async function setupOracle(manifest: SeedManifest, approved: readonly SeedPut[], reader: OracleReader): Promise<StoredObservation[]> {
  const identities = new Set(manifest.resources.map(r => `${r.type}/${r.id}`));
  const result: StoredObservation[] = [];
  for (const request of approved) {
    const raw = await reader.read(request.target), stored = parseResource(raw), expected = parseResource(request.body);
    if (`${stored.resourceType}/${stored.id}` !== request.target) return fail();
    const meta = stored.meta;
    if (!isRecord(meta) || !resourceId(meta.versionId) ||
      (meta.lastUpdated !== undefined && (typeof meta.lastUpdated !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(meta.lastUpdated))) ||
      (meta.source !== undefined && (typeof meta.source !== 'string' || meta.source.length > 2048))) return fail();
    if (!storedMatchesApproved(expected, stored)) throw fault('SETUP_ORACLE_FAILED');
    requireReferenceClosure(stored, identities);
    result.push({ target: request.target, versionId: meta.versionId, rawSha256: sha256(raw), numbers: numbersOf(stored) });
  }
  // Every listed identity has been read. Exact independent type counts now
  // exclude extra identities, including server-created placeholders.
  for (const type of seedTypes(manifest)) {
    const expectedCount = manifest.resources.filter(r => r.type === type).length;
    if (await reader.count(type) !== expectedCount) throw fault('SETUP_ORACLE_FAILED');
  }
  return result;
}
