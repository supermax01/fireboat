import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BEARER_TOKEN, fault, MAX_TOKEN_LENGTH, SCOPE_TOKEN } from './token-provider.js';

/** What a stored grant is bound to. A file whose binding differs from the configuration is never used. */
export interface GrantBinding { sourceBaseUrl: string; tokenEndpoint: string; clientId: string; patientId: string }
export interface StoredGrant {
  version: 1;
  binding: GrantBinding;
  /** The granted scope, canonical (sorted, unique). */
  scope: string;
  accessToken: string;
  /** Epoch milliseconds: when the token request started and when the access token expires. */
  issuedAt: number;
  expiresAt: number;
  refreshToken?: string;
}

const MAX_FILE_BYTES = 65_536;
/** A lock untouched for this long belongs to a holder that crashed. A live holder touches its lock every heartbeat. */
const LOCK_STALE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_WAIT_MS = 10_000;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const ALIAS = /^[A-Za-z0-9_-]{1,80}$/;

/** `${XDG_STATE_HOME:-~/.local/state}/fireboat/smart/<alias>.json`; a relative XDG_STATE_HOME is ignored. */
export function defaultTokenFile(alias: string, env: Record<string, string | undefined> = process.env): string {
  if (!ALIAS.test(alias)) throw fault('INVALID_CONFIG', 'Source alias is invalid.');
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(homedir(), '.local', 'state');
  return join(state, 'fireboat', 'smart', `${alias}.json`);
}

const currentUid = (): number | undefined => typeof process.getuid === 'function' ? process.getuid() : undefined;
const unusable = (): never => { throw fault('CREDENTIAL_UNAVAILABLE', 'The stored SMART grant file is not usable (it must be a regular file owned by this user with mode 0600).'); };
const token = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH && BEARER_TOKEN.test(value);
const text = (value: unknown, max = 2_048): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1F\x7F]/.test(value);
const epoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function validGrant(value: unknown): value is StoredGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  const keys = Object.keys(grant);
  if (keys.some(key => !['version', 'binding', 'scope', 'accessToken', 'issuedAt', 'expiresAt', 'refreshToken'].includes(key))) return false;
  const binding = grant.binding as Record<string, unknown> | undefined;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).sort().join() !== 'clientId,patientId,sourceBaseUrl,tokenEndpoint') return false;
  if (!text(binding.sourceBaseUrl) || !text(binding.tokenEndpoint) || !text(binding.clientId, 256) || !text(binding.patientId, 64)) return false;
  return grant.version === 1 && typeof grant.scope === 'string' && grant.scope.length <= 16_384 && grant.scope.split(' ').every(part => part === '' || SCOPE_TOKEN.test(part))
    && token(grant.accessToken) && epoch(grant.issuedAt) && epoch(grant.expiresAt) && (grant.expiresAt as number) > (grant.issuedAt as number)
    && (grant.refreshToken === undefined || token(grant.refreshToken));
}

/**
 * Reads the stored grant: `null` when there is none. The file is opened without following links and must be a
 * regular file owned by this user with no group or other permission bits; anything else is refused. The binding
 * is returned for the caller to compare with its configuration.
 */
export async function readTokenFile(path: string): Promise<StoredGrant | null> {
  let handle;
  try { handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); }
  catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null;
    return unusable();
  }
  try {
    const info = await handle.stat();
    const uid = currentUid();
    if (!info.isFile() || uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0) unusable();
    if (info.size === 0 || info.size > MAX_FILE_BYTES) unusable();
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_FILE_BYTES) unusable();
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return unusable(); }
    if (!validGrant(parsed)) unusable();
    return parsed as StoredGrant;
  } catch (error) {
    if (error instanceof Error && error.name === 'CredentialFault') throw error;
    return unusable();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** True when every bound value equals the configured one. */
export function bindingMatches(stored: GrantBinding, expected: GrantBinding): boolean {
  return stored.sourceBaseUrl === expected.sourceBaseUrl && stored.tokenEndpoint === expected.tokenEndpoint
    && stored.clientId === expected.clientId && stored.patientId === expected.patientId;
}

/**
 * Confirms, just before a commit, that the caller still holds the grant lock. A holder whose lock was taken over
 * (for example after its machine slept past the stale limit) is refused with a retryable TOKEN_TIMEOUT and stores nothing.
 */
export type LockHeld = () => Promise<void>;

/** The directory must be a real directory owned by this user with no group or other access; it is created 0700. */
async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE }).catch(() => undefined);
  const info = await lstat(directory).catch(() => undefined);
  const uid = currentUid();
  if (!info || !info.isDirectory() || uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw fault('CREDENTIAL_UNAVAILABLE', 'The SMART grant directory must be a directory owned by this user with mode 0700.');
  }
}

/**
 * The grant directory a login will write to must already be usable (owned by this user, 0700, not a link); it is
 * created 0700 when missing. `fireboat login` checks it before the browser round trip, and every write checks it again.
 */
export async function prepareGrantDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw fault('INVALID_CONFIG', 'The SMART grant path must be absolute.');
  await privateDirectory(dirname(path));
}

/**
 * Atomic write: a new 0600 temporary file in the same private directory, synced, then renamed over the old file.
 * With `held`, the lock is confirmed after the temporary file is synced and immediately before the rename.
 */
export async function writeTokenFile(path: string, grant: StoredGrant, held?: LockHeld): Promise<void> {
  if (!isAbsolute(path) || !validGrant(grant)) throw fault('INVALID_CONFIG', 'The SMART grant cannot be stored.');
  const directory = dirname(path);
  await privateDirectory(directory);
  const existing = await lstat(path).catch(() => undefined);
  if (existing && !existing.isFile()) throw fault('CREDENTIAL_UNAVAILABLE', 'The SMART grant path is not a regular file.');
  const temporary = join(directory, `.${randomBytes(12).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, FILE_MODE);
    await handle.chmod(FILE_MODE);
    await handle.writeFile(`${JSON.stringify(grant)}\n`, 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    if (held) await held();
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error instanceof Error && error.name === 'CredentialFault') throw error;
    throw fault('CREDENTIAL_UNAVAILABLE', 'The SMART grant could not be stored.');
  }
}

/** Removes the stored grant. Returns whether a file was removed. A link or special file is refused, never followed. */
export async function deleteTokenFile(path: string, held?: LockHeld): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return false;
  if (!info.isFile()) throw fault('CREDENTIAL_UNAVAILABLE', 'The SMART grant path is not a regular file.');
  if (held) await held();
  await unlink(path);
  return true;
}

/**
 * `fireboat logout`: removes the stored grant while holding the grant lock, so a refresh already in progress either
 * finishes first (and its grant is then removed) or finds no grant under the lock and writes nothing.
 */
export async function removeStoredGrant(path: string): Promise<boolean> {
  if (!isAbsolute(path)) throw fault('INVALID_CONFIG', 'The SMART grant path must be absolute.');
  // Without the directory nothing was ever stored here, and logout creates nothing.
  if (!await lstat(dirname(path)).catch(() => undefined)) return false;
  return withGrantLock(path, held => deleteTokenFile(path, held));
}

interface LockState { ino: number; dev: number; mtimeMs: number; owner: string }

/** The lock's identity and owner, or undefined when there is none. A link or special file is refused, never followed. */
async function inspectLock(lock: string): Promise<LockState | undefined> {
  let handle;
  try { handle = await open(lock, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); }
  catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return undefined;
    throw fault('CREDENTIAL_UNAVAILABLE', 'The SMART grant lock is not a regular file.');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw fault('CREDENTIAL_UNAVAILABLE', 'The SMART grant lock is not a regular file.');
    return { ino: info.ino, dev: info.dev, mtimeMs: info.mtimeMs, owner: await handle.readFile('utf8') };
  } finally { await handle.close().catch(() => undefined); }
}

// A lock's age is judged by the file system's wall clock (new Date, not a possibly substituted Date.now).
const age = (state: LockState): number => new Date().getTime() - state.mtimeMs;

/**
 * Creates the lock with its owner already written: a private temporary file is linked to the lock name, which fails
 * when a lock exists. Returns the open lock (kept for the heartbeat), or undefined when another process holds it.
 */
async function createLock(lock: string, owner: string): Promise<FileHandle | undefined> {
  const temporary = `${lock}.${owner}.tmp`;
  let handle: FileHandle | undefined, linking = false;
  try {
    handle = await open(temporary, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, FILE_MODE);
    await handle.writeFile(owner, 'utf8');
    linking = true;
    await link(temporary, lock);
    const created = handle; handle = undefined;
    return created;
  } catch (error) {
    // Only the link failing because a lock exists means another process holds it.
    if (linking && (error as { code?: unknown }).code === 'EEXIST') return undefined;
    throw fault('CREDENTIAL_UNAVAILABLE', 'The stored SMART grant could not be locked.');
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

/**
 * Moves a stale lock aside and removes it. Called only under a reclaim guard, with the lock as re-inspected there.
 * The lock is first renamed to a private name, and is removed only if it is still the same untouched lock with the
 * same owner. Anything else (a holder that touched its lock) is put back. Returns whether to retry at once. A move
 * that fails for any reason other than the lock being gone is refused, never retried.
 */
async function takeOverStale(lock: string, seen: LockState, staleMs: number): Promise<boolean> {
  const aside = `${lock}.${randomBytes(12).toString('hex')}.stale`;
  try { await rename(lock, aside); }
  catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return true;
    throw fault('CREDENTIAL_UNAVAILABLE', 'The stale SMART grant lock could not be taken over.');
  }
  const moved = await inspectLock(aside).catch(() => undefined);
  if (moved && moved.ino === seen.ino && moved.dev === seen.dev && moved.owner === seen.owner && age(moved) > staleMs) {
    await unlink(aside).catch(() => undefined);
    return true;
  }
  // Not the lock that was judged stale. If a newer lock already took its place, link fails and the displaced holder
  // finds out when it confirms its lock before committing.
  await link(aside, lock).catch(() => undefined);
  await unlink(aside).catch(() => undefined);
  return false;
}

/** A reclaim guard: its name, its identity (to release only our own) and the leftover guards skipped to get it. */
interface ReclaimGuard { name: string; ino: number; dev: number; skipped: Array<{ name: string; state: LockState }> }
/** How many guards left by crashed reclaimers are stepped over before a reclaimer waits instead. */
const GUARD_GENERATIONS = 8;

/**
 * Takes the reclaim guard, `<lock>.reclaim.<n>`, created the same exclusive way as the lock with the owner already
 * written. A guard is held only for the few file operations of one takeover, so a guard older than the stale limit was
 * left by a reclaimer that crashed: it is never moved or removed here (removing it by name could remove a fresh guard
 * that replaced it), but stepped over to the next generation. A guard taken above generation 0 is kept only while every
 * leftover it stepped over is still in place. Returns undefined when another reclaimer holds the guard, or may hold a
 * lower generation; the caller then waits as for a held lock.
 */
async function acquireReclaimGuard(lock: string, owner: string, staleMs: number): Promise<ReclaimGuard | undefined> {
  const skipped: ReclaimGuard['skipped'] = [];
  for (let generation = 0; generation < GUARD_GENERATIONS; generation++) {
    const name = `${lock}.reclaim.${generation}`;
    const created = await createLock(name, owner);
    if (created) {
      let guard: ReclaimGuard;
      try { const info = await created.stat(); guard = { name, ino: info.ino, dev: info.dev, skipped }; }
      catch { await unlink(name).catch(() => undefined); throw fault('CREDENTIAL_UNAVAILABLE', 'The stored SMART grant could not be locked.'); }
      finally { await created.close().catch(() => undefined); }
      // A lower generation that is no longer the leftover stepped over was cleaned up meanwhile, and another reclaimer
      // may hold it afresh: give this guard back and wait, so two reclaimers never hold guards at once.
      if (!await leftoversUnchanged(skipped, staleMs)) { await releaseOwnGuard(guard, owner); return undefined; }
      return guard;
    }
    const state = await inspectLock(name);
    if (!state) return undefined;
    if (age(state) <= staleMs) return undefined;
    skipped.push({ name, state });
  }
  return undefined;
}

/** Whether every guard stepped over as a leftover is still that same untouched file, older than the stale limit. */
async function leftoversUnchanged(skipped: ReclaimGuard['skipped'], staleMs: number): Promise<boolean> {
  for (const { name, state } of skipped) {
    const current = await inspectLock(name).catch(() => undefined);
    if (!current || current.ino !== state.ino || current.dev !== state.dev || current.owner !== state.owner || !(age(current) > staleMs)) return false;
  }
  return true;
}

/** Removes this reclaimer's own guard, only if it is still the file this reclaimer created. */
async function releaseOwnGuard(guard: ReclaimGuard, owner: string): Promise<void> {
  const mine = await inspectLock(guard.name).catch(() => undefined);
  if (mine && mine.owner === owner && mine.ino === guard.ino && mine.dev === guard.dev) await unlink(guard.name).catch(() => undefined);
}

/**
 * Releases the guard. First the guards stepped over as leftovers are removed, each only if it is still the same
 * untouched file; this is the guard holder's last step, after which it no longer acts on the lock, so even a guard
 * that replaced a leftover meanwhile could at worst admit a reclaimer that re-inspects the lock under it.
 */
async function releaseReclaimGuard(guard: ReclaimGuard, owner: string, staleMs: number): Promise<void> {
  for (const { name, state } of guard.skipped) {
    const now = await inspectLock(name).catch(() => undefined);
    if (now && now.ino === state.ino && now.dev === state.dev && now.owner === state.owner && age(now) > staleMs) await unlink(name).catch(() => undefined);
  }
  await releaseOwnGuard(guard, owner);
}

/**
 * Re-inspects the lock under the reclaim guard and takes it over only if it is still the lock judged stale (same
 * inode, device and owner) and still older than the stale limit.
 */
async function takeOverIfStillStale(lock: string, seen: LockState, staleMs: number): Promise<boolean> {
  const present = await inspectLock(lock);
  if (!present) return true;
  if (present.ino !== seen.ino || present.dev !== seen.dev || present.owner !== seen.owner || !(age(present) > staleMs)) return false;
  return takeOverStale(lock, present, staleMs);
}

/**
 * Takes over a lock judged stale. Reclaimers serialize on the reclaim guard, and under it the lock is re-inspected, so
 * a reclaimer that judged the lock stale before another reclaimer replaced it with a fresh lock never moves that
 * fresh lock (moving it would leave the lock name free for a third process while two believe they hold the lock).
 * Returns whether to retry at once; false (wait) when another reclaimer holds the guard or the lock is no longer stale.
 *
 * What remains: a holder that went untouched past the stale limit (its machine slept, say) and touches or releases its
 * lock between the re-inspection and the move, or a reclaimer that stalls past the stale limit while holding the guard.
 * Then two processes may each believe they hold the lock, but the displaced one cannot commit: `held` confirms the lock
 * before every write and refuses with TOKEN_TIMEOUT, so it fails closed.
 */
async function reclaimStale(lock: string, seen: LockState, owner: string, staleMs: number): Promise<boolean> {
  const guard = await acquireReclaimGuard(lock, owner, staleMs);
  if (!guard) return false;
  try { return await takeOverIfStillStale(lock, seen, staleMs); }
  finally { await releaseReclaimGuard(guard, owner, staleMs); }
}

/**
 * Runs `work` while holding `<path>.lock` in the private grant directory. Refreshes, logins and logouts in any process
 * serialize on it, so a refresh never overwrites a grant another process wrote meanwhile (the caller re-reads the file
 * under the lock) and two servers never refresh at once. The holder touches its lock every heartbeat, so a live holder
 * is never taken over; a lock untouched for longer than the stale limit (a crashed holder) is taken over under the
 * reclaim guard (see reclaimStale).
 * `work` receives `held`, which every commit calls first: a holder that lost its lock commits nothing. Waiting longer
 * than the wait limit is TOKEN_TIMEOUT. Only the holder's own lock is removed.
 */
export async function withGrantLock<T>(path: string, work: (held: LockHeld) => Promise<T>, options: { staleMs?: number; waitMs?: number } = {}): Promise<T> {
  if (!isAbsolute(path)) throw fault('INVALID_CONFIG', 'The SMART grant path must be absolute.');
  await privateDirectory(dirname(path));
  const lock = `${path}.lock`;
  const owner = randomBytes(16).toString('hex');
  const staleMs = options.staleMs ?? LOCK_STALE_MS, waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const heartbeatMs = Math.max(10, Math.min(LOCK_HEARTBEAT_MS, Math.floor(staleMs / 4)));
  const started = performance.now();
  let handle: FileHandle;
  for (;;) {
    const created = await createLock(lock, owner);
    if (created) { handle = created; break; }
    const seen = await inspectLock(lock);
    // Released meanwhile, or a stale lock taken over: try to create it again at once, but only within the wait limit,
    // which applies on every attempt so a run of vanishing or reclaimed locks cannot outlast it.
    const again = !seen || (age(seen) > staleMs && await reclaimStale(lock, seen, owner, staleMs));
    if (performance.now() - started > waitMs) throw fault('TOKEN_TIMEOUT', 'The stored SMART grant is locked by another process.', true);
    if (!again) await sleep(20);
  }
  const touch = () => { const now = new Date(); return handle.utimes(now, now).catch(() => undefined); };
  const heartbeat = setInterval(() => { void touch(); }, heartbeatMs);
  heartbeat.unref();
  const ownsLock = async (): Promise<boolean> => {
    try {
      const current = await inspectLock(lock), mine = await handle.stat();
      return current !== undefined && current.owner === owner && current.ino === mine.ino && current.dev === mine.dev;
    } catch { return false; }
  };
  const held: LockHeld = async () => {
    if (!await ownsLock()) throw fault('TOKEN_TIMEOUT', 'The SMART grant lock was taken over by another process; nothing was stored.', true);
  };
  try { return await work(held); }
  finally {
    clearInterval(heartbeat);
    const mine = await ownsLock();
    await handle.close().catch(() => undefined);
    if (mine) await unlink(lock).catch(() => undefined);
  }
}
