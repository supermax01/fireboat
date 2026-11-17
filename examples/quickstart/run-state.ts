import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fault, hasKeys, isRecord, isSha256 } from './manifest.js';
import type { InstanceReceipt } from './instance.js';
import { validReceipt } from './instance.js';
import type { StoredObservation } from './setup-oracle.js';

export type RunReceipt = Readonly<{
  schema: 'fireboat-quickstart-run/1'; runId: string; project: string; creationNonce: string; startedAt: string;
  phase: 'preparing' | 'seeding' | 'failed' | 'complete' | 'down';
  manifestSha256: string; composeSha256: string; containerId: string | null; instance: InstanceReceipt | null;
  attemptSha256: string | null; packetSha256: string | null;
}>;
export type SetupPacket = Readonly<{
  schema: 'fireboat-quickstart-setup/1'; runId: string; creationNonce: string;
  receiptSha256: string; manifestSha256: string; instanceSha256: string; resources: readonly StoredObservation[];
}>;
export const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export type AtomicWriter = (path: string, bytes: Uint8Array) => Promise<void>;

// Same-directory rename exposes either the complete old file or the complete
// new file. File contents and the rename are synced before reporting success.
export const atomicPrivateWrite: AtomicWriter = async (path, bytes) => {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await file.chmod(0o600); await file.writeFile(bytes); await file.sync(); await file.close(); file = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch { throw fault('RUN_IO'); }
  finally { await file?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
};

export async function newRunDirectory(directory: string): Promise<void> {
  try { await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o700); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw fault('RUN_IO');
    try { await lstat(join(directory, 'writer.lock')); }
    catch { throw fault('SEED_ALREADY_ATTEMPTED'); }
    throw fault('RUN_LOCKED');
  }
}
export async function lockRun(directory: string, name: 'writer.lock' | 'verify.lock' = 'writer.lock'): Promise<() => Promise<void>> {
  let lock: Awaited<ReturnType<typeof open>>;
  try { lock = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { throw fault((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'RUN_LOCKED' : 'RUN_IO'); }
  await lock.chmod(0o600);
  return async () => { await lock.close(); await rm(join(directory, name)); };
}
export async function readPrivateFile(path: string, maximum = 8_388_608): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw fault('RUN_INVALID'); });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > maximum) throw fault('RUN_INVALID');
    const bytes = await file.readFile();
    if (bytes.length > maximum) throw fault('RUN_INVALID');
    return bytes;
  } finally { await file.close(); }
}
export function validRunReceipt(value: unknown): value is RunReceipt {
  if (!isRecord(value) || !hasKeys(value, ['schema', 'runId', 'project', 'creationNonce', 'startedAt', 'phase',
    'manifestSha256', 'composeSha256', 'containerId', 'instance', 'attemptSha256', 'packetSha256']) || value.schema !== 'fireboat-quickstart-run/1' ||
    typeof value.runId !== 'string' || !/^[a-f0-9]{16}$/.test(value.runId) || value.project !== `fireboat-qs-${value.runId}` ||
    !isSha256(value.creationNonce) || !isSha256(value.manifestSha256) || !isSha256(value.composeSha256) ||
    (value.containerId !== null && !isSha256(value.containerId)) ||
    typeof value.startedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.startedAt) ||
    !['preparing', 'seeding', 'failed', 'complete', 'down'].includes(value.phase as string) ||
    (value.attemptSha256 !== null && !isSha256(value.attemptSha256)) || (value.packetSha256 !== null && !isSha256(value.packetSha256))) return false;
  const instance = value.instance;
  if (instance !== null && (!validReceipt(instance) || instance.containerId !== value.containerId ||
    !(['runId', 'project', 'creationNonce', 'composeSha256'] as const).every(k => instance[k] === value[k]))) return false;
  return value.phase !== 'complete' || (value.instance !== null && isSha256(value.attemptSha256) && isSha256(value.packetSha256));
}
export async function readRunReceipt(directory: string): Promise<RunReceipt> {
  const stat = await lstat(directory).catch(() => { throw fault('RUN_INVALID'); });
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) throw fault('RUN_INVALID');
  let value: unknown;
  try { value = JSON.parse((await readPrivateFile(join(directory, 'receipt.json'))).toString('utf8')); }
  catch { throw fault('RUN_INVALID'); }
  if (!validRunReceipt(value)) throw fault('RUN_INVALID');
  return value;
}
