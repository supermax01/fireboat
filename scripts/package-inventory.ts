import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export type InventoryFaultCode = 'PACK_EXPECTATION_INVALID' | 'PACK_NPM_INVALID' | 'PACK_IDENTITY_MISMATCH' |
  'PACK_UNEXPECTED' | 'PACK_MISSING' | 'PACK_LIST_MISMATCH' | 'PACK_FILE_MISMATCH' |
  'TAR_INVALID' | 'TAR_LIMIT' | 'TAR_ENTRY_UNSAFE';
export class InventoryFault extends Error {
  readonly code: InventoryFaultCode;
  constructor(code: InventoryFaultCode) { super(code); this.name = 'InventoryFault'; this.code = code; }
}
const fault = (code: InventoryFaultCode): InventoryFault => new InventoryFault(code);
const digest = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]): boolean =>
  Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
export const INVENTORY_LIMITS = Object.freeze({ files: 8192, fileBytes: 33_554_432, tarBytes: 67_108_864 });
export type FileInventory = Readonly<{ path: string; size: number; mode: number; sha256: string }>;
export type PackageIdentity = Readonly<{ name: string; version: string; bin: Readonly<Record<string, string>> }>;
export type ExpectedInventory = Readonly<{ schema: 1; identity: PackageIdentity; files: readonly FileInventory[] }>;
type ListedFile = Readonly<{ path: string; size: number; mode: number }>;
export type TarFile = FileInventory & Readonly<{ body: Buffer }>;
const version = (v: unknown): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(v) && v.length <= 128;
const name = (v: unknown): v is string => typeof v === 'string' && /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(v) && v.length <= 214;
export function safePackagePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240 || !/^[A-Za-z0-9@_./-]+$/.test(value)) return false;
  const parts = value.split('/');
  return parts.every(p => p !== '' && p !== '.' && p !== '..' &&
    !['.git', '.local', 'node_modules', 'tests', 'research', 'audit', 'proposals', 'artifacts'].includes(p) &&
    !/^\.env(?:\.|$)/i.test(p) && !/^(?:credentials|secrets?)(?:\.|$)/i.test(p)) &&
    !/\.(?:ts|tsx|map|py)$/i.test(value) && !parts.includes('server.json');
}
const safeMode = (mode: unknown): mode is number => mode === 0o644 || mode === 0o755;
const safeSize = (size: unknown): size is number => Number.isSafeInteger(size) && (size as number) >= 0 && (size as number) <= INVENTORY_LIMITS.fileBytes;
function validIdentity(value: unknown): value is PackageIdentity {
  return record(value) && keys(value, ['name', 'version', 'bin']) && name(value.name) && version(value.version) &&
    record(value.bin) && Object.keys(value.bin).length > 0 && Object.keys(value.bin).length <= 8 &&
    Object.entries(value.bin).every(([key, path]) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(key) && safePackagePath(path));
}
export function validateExpectedInventory(value: unknown): ExpectedInventory {
  if (!record(value) || !keys(value, ['schema', 'identity', 'files']) || value.schema !== 1 || !validIdentity(value.identity) ||
    !Array.isArray(value.files) || value.files.length < 2 || value.files.length > INVENTORY_LIMITS.files) throw fault('PACK_EXPECTATION_INVALID');
  const paths = new Set<string>(); let bytes = 0;
  for (const f of value.files) {
    if (!record(f) || !keys(f, ['path', 'size', 'mode', 'sha256']) || !safePackagePath(f.path) ||
      !safeMode(f.mode) || !safeSize(f.size) || typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256) || paths.has(f.path))
      throw fault('PACK_EXPECTATION_INVALID');
    paths.add(f.path); bytes += f.size;
  }
  const files = value.files as FileInventory[];
  if (bytes > INVENTORY_LIMITS.tarBytes || !paths.has('package.json') ||
    !Object.values(value.identity.bin).every(path => files.some(f => f.path === path && f.mode === 0o755)))
    throw fault('PACK_EXPECTATION_INVALID');
  return structuredClone(value) as ExpectedInventory;
}

export function inspectNpmPack(value: unknown, identity: PackageIdentity): ListedFile[] {
  if (!Array.isArray(value) || value.length !== 1 || !record(value[0])) throw fault('PACK_NPM_INVALID');
  const pack = value[0];
  if (pack.name !== identity.name || pack.version !== identity.version || pack.id !== `${identity.name}@${identity.version}`)
    throw fault('PACK_IDENTITY_MISMATCH');
  if (!Array.isArray(pack.files) || pack.files.length > INVENTORY_LIMITS.files) throw fault('PACK_NPM_INVALID');
  const paths = new Set<string>(), files: ListedFile[] = [];
  for (const f of pack.files) {
    if (!record(f) || !keys(f, ['path', 'size', 'mode']) || !safePackagePath(f.path) || !safeSize(f.size) || !safeMode(f.mode) || paths.has(f.path))
      throw fault('PACK_NPM_INVALID');
    paths.add(f.path); files.push({ path: f.path, size: f.size, mode: f.mode });
  }
  return files;
}

function textField(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length), zero = field.indexOf(0);
  if (zero >= 0 && field.subarray(zero).some(b => b !== 0)) throw fault('TAR_INVALID');
  return field.subarray(0, zero < 0 ? length : zero).toString('utf8');
}
function octal(header: Buffer, start: number, length: number): number {
  const field = header.subarray(start, start + length);
  if (field.some(b => b > 127)) throw fault('TAR_INVALID');
  const raw = field.toString('ascii');
  if (!/^[0-7]+[\0 ]*$/.test(raw)) throw fault('TAR_INVALID');
  const value = Number.parseInt(raw.replace(/[\0 ]+$/, ''), 8);
  if (!Number.isSafeInteger(value)) throw fault('TAR_INVALID');
  return value;
}
type TarEntry = ListedFile & { type: string; link: string; archivePath: string };
export function safeRegularTarEntry(entry: TarEntry, seen: ReadonlySet<string>): boolean {
  return (entry.type === '0' || entry.type === '') && entry.link === '' && entry.archivePath.startsWith('package/') &&
    safePackagePath(entry.path) && safeMode(entry.mode) && safeSize(entry.size) && !seen.has(entry.path);
}

// No extraction occurs here. Return body copies only after every header, size,
// checksum and archive terminator has been validated within fixed budgets.
export function inspectTar(input: Uint8Array): TarFile[] {
  if (!(input instanceof Uint8Array) || input.byteLength > INVENTORY_LIMITS.tarBytes) throw fault('TAR_LIMIT');
  let tar: Buffer;
  try { tar = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input, { maxOutputLength: INVENTORY_LIMITS.tarBytes }) : Buffer.from(input); }
  catch { throw fault('TAR_LIMIT'); }
  if (tar.byteLength < 1024 || tar.byteLength % 512 !== 0) throw fault('TAR_INVALID');
  const entries: { entry: TarEntry; offset: number }[] = [], seen = new Set<string>();
  let offset = 0, terminated = false;
  while (offset < tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) {
      if (tar.byteLength - offset < 1024 || tar.subarray(offset).some(b => b !== 0)) throw fault('TAR_INVALID');
      terminated = true; break;
    }
    if (entries.length >= INVENTORY_LIMITS.files) throw fault('TAR_LIMIT');
    const checksum = octal(header, 148, 8);
    const actual = header.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);
    if (checksum !== actual || header.subarray(257, 263).toString('ascii') !== 'ustar\0' ||
      header.subarray(263, 265).toString('ascii') !== '00') throw fault('TAR_INVALID');
    const prefix = textField(header, 345, 155), base = textField(header, 0, 100);
    const archivePath = prefix ? `${prefix}/${base}` : base;
    const entry: TarEntry = { archivePath, path: archivePath.startsWith('package/') ? archivePath.slice(8) : archivePath,
      size: octal(header, 124, 12), mode: octal(header, 100, 8), type: textField(header, 156, 1), link: textField(header, 157, 100) };
    if (!safeRegularTarEntry(entry, seen)) throw fault('TAR_ENTRY_UNSAFE');
    seen.add(entry.path);
    const end = offset + 512 + entry.size, next = offset + 512 + Math.ceil(entry.size / 512) * 512;
    if (!Number.isSafeInteger(next) || next > tar.byteLength || tar.subarray(end, next).some(b => b !== 0)) throw fault('TAR_INVALID');
    entries.push({ entry, offset: offset + 512 }); offset = next;
  }
  if (!terminated) throw fault('TAR_INVALID');
  return entries.map(({ entry, offset }) => {
    const body = Buffer.from(tar.subarray(offset, offset + entry.size));
    return { path: entry.path, size: entry.size, mode: entry.mode, sha256: digest(body), body };
  });
}

export const sameInventory = (first: readonly ListedFile[], second: readonly ListedFile[]): boolean => {
  const rows = (files: readonly ListedFile[]): string => JSON.stringify([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(f => [f.path, f.size, f.mode]));
  return rows(first) === rows(second);
};
function actualIdentity(body: Buffer | undefined, expected: PackageIdentity): void {
  let value: unknown;
  try { if (!body || body.byteLength > 65_536) throw 0; value = JSON.parse(body.toString('utf8')); }
  catch { throw fault('PACK_IDENTITY_MISMATCH'); }
  if (!record(value) || value.name !== expected.name || value.version !== expected.version || !record(value.bin) ||
    JSON.stringify(Object.entries(value.bin).sort()) !== JSON.stringify(Object.entries(expected.bin).sort())) throw fault('PACK_IDENTITY_MISMATCH');
}
export function verifyPackInventory(input: { expected: unknown; npmPack: unknown; tar: Uint8Array }): { files: readonly FileInventory[]; sha256: string } {
  const expected = validateExpectedInventory(input.expected), npmFiles = inspectNpmPack(input.npmPack, expected.identity), tarFiles = inspectTar(input.tar);
  const wanted = new Map(expected.files.map(f => [f.path, f])), listed = new Set(npmFiles.map(f => f.path));
  const unexpected = npmFiles.filter(f => !wanted.has(f.path));
  const missing = expected.files.filter(f => !listed.has(f.path));
  if (unexpected.length) throw fault('PACK_UNEXPECTED');
  if (missing.length) throw fault('PACK_MISSING');
  if (!sameInventory(npmFiles, tarFiles)) throw fault('PACK_LIST_MISMATCH');
  // Membership has its own guards above; validate each present approved body.
  for (const file of tarFiles) {
    const approved = wanted.get(file.path);
    if (approved && (file.size !== approved.size || file.mode !== approved.mode || file.sha256 !== approved.sha256)) throw fault('PACK_FILE_MISMATCH');
  }
  actualIdentity(tarFiles.find(f => f.path === 'package.json')?.body, expected.identity);
  const files = tarFiles.map(({ body: _body, ...file }) => file).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, sha256: digest(JSON.stringify(files)) };
}
