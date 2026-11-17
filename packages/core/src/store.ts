import { createHash, randomBytes } from 'node:crypto';
import { stringifyFhir } from './decimal.js';
import { GatewayFault } from './transport.js';

/**
 * Reference-counted retention: each distinct upstream page payload is
 * stored once as a blob keyed by content hash; `cur_`/`res_` handles are
 * lightweight references and quota counts each blob once. Per-handle view
 * state (a cursor's offset into its page, a result's slice of it) lives in a
 * handle overlay, never in the hashed blob, so every handle on one page
 * shares the single charged copy. `res_` handles are best-effort: a
 * write that would exceed quota evicts the oldest `res_` handles first.
 * A store may also evict its oldest cursors, so that a full quota does not
 * refuse every later call in a long session. A store opts in
 * through `evictableKinds`; kinds are evicted in the listed order, oldest
 * sequence number first, and a handle named in `except` or reported by
 * `protectedHandles` is never evicted. An evicted handle reads exactly like
 * an expired one. The store refuses only when nothing evictable remains. A
 * request that could not fit even in an empty store is non-retryable and
 * reports no expiry. A single unref'ed timer purges at the nearest
 * expiry while idle.
 */
export interface StoreEntry<T> { prefix: 'cur' | 'res'; value: T; originalExpiry?: number; overlay?: Partial<T> }

/**
 * Shared retention ledger. Clinical and discovery
 * stores charge one caller-wide byte ceiling; discovery bytes are a subquota
 * of it, never an extra allowance. Precedence rule: admitting clinical state
 * MAY evict discovery cursors oldest-first (they regenerate safely and then
 * read as DISCOVERY_EXPIRED). The ledger itself never evicts clinical state:
 * the clinical store may evict its own
 * oldest cursors under its own quota, but discovery admission still cannot.
 */
export interface LedgerStore { usedBytes(): number; evictOldestEvictable(except?: readonly string[]): boolean; reservationCheckpoint(): () => void }
export class RetentionLedger {
  private readonly discovery: LedgerStore[] = [];
  private readonly all: LedgerStore[] = [];
  constructor(readonly totalBytes: number) {}
  register(store: LedgerStore, role: 'clinical' | 'discovery'): void {
    this.all.push(store);
    if (role === 'discovery') this.discovery.push(store);
  }
  usedBytes(): number { return this.all.reduce((n, s) => n + s.usedBytes(), 0); }
  /** Synchronous caller-wide reservation, including evictions in every store. */
  reservationCheckpoint(): () => void {
    const restores = this.all.map(store => store.reservationCheckpoint());
    return () => { for (const restore of restores) restore(); };
  }
  /** Evict discovery cursors (never clinical state) until `additional` fits. */
  makeRoom(additional: number): boolean {
    while (this.usedBytes() + additional > this.totalBytes) {
      if (!this.discovery.some(s => s.evictOldestEvictable())) return this.usedBytes() + additional <= this.totalBytes;
    }
    return true;
  }
}

export interface ResultStoreOptions {
  /** Immutable fields interned once across page blobs; handle overlays never contain them. */
  sharedFields?: readonly string[];
  ledger?: RetentionLedger;
  role?: 'clinical' | 'discovery';
  /** Handle kinds this store may evict under pressure, in eviction order. Default: res only. Discovery: cur.
   * The gateway's clinical store lists res then cur. */
  evictableKinds?: readonly ('cur' | 'res')[];
  /** Handles in use outside the store (a cursor with an in-flight page load). Never evicted. */
  protectedHandles?: (handle: string) => boolean;
  /** Public code for a missing/expired handle. Discovery stores use DISCOVERY_EXPIRED. */
  unavailableCode?: 'RESULT_EXPIRED' | 'DISCOVERY_EXPIRED';
}

export class ResultStore<T> {
  private readonly blobs = new Map<string, { value: T; bytes: number; refs: Set<string>; sharedKey?: string }>();
  private readonly shared = new Map<string, { value: Partial<T>; bytes: number; refs: Set<string> }>();
  private readonly items = new Map<string, { key: string; kind: 'cur' | 'res'; expiresAt: number; seq: number; overlay?: Partial<T> }>();
  private seq = 0;
  private clearGeneration = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly options: ResultStoreOptions;
  constructor(private readonly byteLimit: number, private readonly maxHandles: number, private readonly ttlMs: number, private readonly now: () => number = Date.now, options: ResultStoreOptions = {}) {
    this.options = options;
    options.ledger?.register(this, options.role ?? 'clinical');
  }
  get size(): number { return this.items.size; }
  usedBytes(): number { return [...this.blobs.values(), ...this.shared.values()].reduce((n, b) => n + b.bytes, 0); }
  private keyOf(json: string): string { return createHash('sha256').update(json).digest('hex'); }
  private split(value: T): { value: T; bytes: number; sharedKey?: string; sharedValue?: Partial<T>; sharedBytes: number } {
    if (!this.options.sharedFields?.length) return { value, bytes: Buffer.byteLength(stringifyFhir(value)), sharedBytes: 0 };
    const body = { ...value };
    const sharedValue: Record<string, unknown> = {};
    for (const field of this.options.sharedFields) {
      if (Object.hasOwn(body as object, field)) {
        sharedValue[field] = (body as Record<string, unknown>)[field];
        delete (body as Record<string, unknown>)[field];
      }
    }
    const json = stringifyFhir(sharedValue);
    return { value: body, bytes: Buffer.byteLength(stringifyFhir(body)), sharedValue: sharedValue as Partial<T>, sharedKey: this.keyOf(json), sharedBytes: Buffer.byteLength(json) };
  }
  private install(key: string, part: ReturnType<ResultStore<T>['split']>): void {
    if (this.blobs.has(key)) return;
    if (part.sharedKey) {
      let metadata = this.shared.get(part.sharedKey);
      if (!metadata) { metadata = { value: part.sharedValue!, bytes: part.sharedBytes, refs: new Set() }; this.shared.set(part.sharedKey, metadata); }
      metadata.refs.add(key);
    }
    this.blobs.set(key, { value: part.value, bytes: part.bytes, refs: new Set(), ...(part.sharedKey ? { sharedKey: part.sharedKey } : {}) });
  }
  private remove(handle: string): void {
    const item = this.items.get(handle); if (!item) return;
    this.items.delete(handle);
    const blob = this.blobs.get(item.key);
    if (blob) {
      blob.refs.delete(handle);
      if (!blob.refs.size) {
        this.blobs.delete(item.key);
        if (blob.sharedKey) {
          const metadata = this.shared.get(blob.sharedKey)!;
          metadata.refs.delete(item.key);
          if (!metadata.refs.size) this.shared.delete(blob.sharedKey);
        }
      }
    }
  }
  /** Drop one handle (e.g. a reservation whose request then failed). The shared blob is freed only with its last handle. */
  release(handle: string): void { this.remove(handle); this.schedule(); }
  private schedule(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.items.size) return;
    const nearest = Math.min(...[...this.items.values()].map(i => i.expiresAt));
    const delay = Math.min(Math.max(nearest - this.now(), 0), 2_147_483_647);
    this.timer = setTimeout(() => { this.timer = undefined; this.purgeExpired(); }, delay);
    this.timer.unref?.();
  }
  purgeExpired(): void {
    const now = this.now();
    for (const [handle, item] of [...this.items]) if (item.expiresAt <= now) this.remove(handle);
    this.schedule();
  }
  private retentionFault(): GatewayFault {
    const expiries = [...this.items.values()].map(i => i.expiresAt);
    if (!expiries.length) return new GatewayFault('RETENTION_LIMIT', 'Temporary result quota reached; repeat the query.', true);
    const earliest = new Date(Math.min(...expiries)).toISOString();
    return new GatewayFault('RETENTION_LIMIT', `Temporary result quota reached; earliest retained result expires at ${earliest}. Retry after that time or repeat the query.`, true);
  }
  /** The request exceeds the quota of an otherwise empty store, so no expiry can ever make it fit. */
  private unretainable(): GatewayFault {
    return new GatewayFault('RETENTION_LIMIT', 'Result exceeds the temporary retention quota and cannot be retained or continued. Narrow the query, lower page_size, or select fewer fields.', false);
  }
  /** Evict the oldest best-effort `res_` handle (never `except`, the handle being updated). This
   * helper evicts only `res_`; cursor eviction runs through
   * evictOldestEvictable, and only after every evictable `res_` is gone. */
  evictOldestRes(except?: string): boolean {
    let oldest: string | undefined; let oldestSeq = Infinity;
    for (const [handle, item] of this.items) if (handle !== except && item.kind === 'res' && item.seq < oldestSeq) { oldest = handle; oldestSeq = item.seq; }
    if (!oldest) return false;
    this.remove(oldest); this.schedule(); return true;
  }
  /** Evict the oldest handle (by sequence number) of the first evictable kind that has one. Never
   * evicts `except` (handles reserved by the current request, or the handle being updated) or a
   * protected handle (an in-flight page load). The clinical store lists `cur`
   * after `res`: a cursor is evicted only when no evictable `res_` remains. */
  evictOldestEvictable(except: readonly string[] = []): boolean {
    const kinds = this.options.evictableKinds ?? ['res'];
    const exempt = (handle: string) => except.includes(handle) || this.options.protectedHandles?.(handle) === true;
    for (const kind of kinds) {
      let oldest: string | undefined; let oldestSeq = Infinity;
      for (const [handle, item] of this.items) if (item.kind === kind && item.seq < oldestSeq && !exempt(handle)) { oldest = handle; oldestSeq = item.seq; }
      if (oldest) { this.remove(oldest); this.schedule(); return true; }
    }
    return false;
  }
  put(prefix: 'cur' | 'res', value: T, originalExpiry?: number, overlay?: Partial<T>): { handle: string; expires_at: string } {
    return this.putBatch([{ prefix, value, originalExpiry, overlay }])[0]!;
  }
  /** `except`: handles the current request already reserved (e.g. the cursor issued with this result); never evicted. */
  putBatch(entries: StoreEntry<T>[], except: readonly string[] = []): { handle: string; expires_at: string }[] {
    this.purgeExpired();
    const prepared = entries.map(({ prefix, value, originalExpiry, overlay }) => {
      const part = this.split(value);
      const json = stringifyFhir(part.value) + (part.sharedKey ?? '');
      return { handle: `${prefix}_${randomBytes(24).toString('base64url')}`, kind: prefix, ...part, overlay, key: this.keyOf(json), expiresAt: Math.min(originalExpiry ?? Infinity, this.now() + this.ttlMs) };
    });
    // Check this before evicting: a request that could never fit is non-retryable and must not evict anything.
    const distinctBytes = new Map<string, number>();
    for (const p of prepared) distinctBytes.set(p.key, p.bytes);
    const distinctShared = new Map(prepared.filter(p => p.sharedKey).map(p => [p.sharedKey!, p.sharedBytes]));
    if ([...distinctBytes.values(), ...distinctShared.values()].reduce((n, b) => n + b, 0) > this.byteLimit || prepared.length > this.maxHandles) throw this.unretainable();
    if (prepared.some(item => item.expiresAt <= this.now())) throw new GatewayFault(this.options.unavailableCode ?? 'RESULT_EXPIRED', 'Result is unavailable or expired; repeat the original query.');
    // Evict oldest evictable handles until the batch fits; recompute after each
    // eviction. The gateway's clinical store evicts res_ first, then its oldest cursor, never one in `except` or protected; an evicted cursor
    // then reads as RESULT_EXPIRED. A discovery store evicts its own oldest cursors, which
    // then read as DISCOVERY_EXPIRED.
    const additional = (): number => {
      const newBlobBytes = new Map<string, number>();
      for (const p of prepared) if (!this.blobs.has(p.key)) newBlobBytes.set(p.key, p.bytes);
      const metadataBytes = [...distinctShared].filter(([key]) => !this.shared.has(key)).map(([, bytes]) => bytes);
      return [...newBlobBytes.values(), ...metadataBytes].reduce((n, b) => n + b, 0);
    };
    const over = () => this.usedBytes() + additional() > this.byteLimit || this.items.size + prepared.length > this.maxHandles;
    while (over()) if (!this.evictOldestEvictable(except)) throw this.retentionFault();
    // Ledger: the shared caller ceiling may evict discovery cursors, never clinical state.
    if (this.options.ledger) {
      const delta = additional();
      if (!this.options.ledger.makeRoom(delta)) throw this.retentionFault();
    }
    for (const p of prepared) {
      this.install(p.key, p);
      this.blobs.get(p.key)!.refs.add(p.handle);
      this.items.set(p.handle, { key: p.key, kind: p.kind, expiresAt: p.expiresAt, seq: this.seq++, ...(p.overlay ? { overlay: p.overlay } : {}) });
    }
    this.schedule();
    return prepared.map(item => ({ handle: item.handle, expires_at: new Date(item.expiresAt).toISOString() }));
  }
  get(handle: string): { value: T; expires_at: string } {
    this.purgeExpired();
    const item = this.items.get(handle);
    const blob = item ? this.blobs.get(item.key) : undefined;
    if (!item || !blob) throw new GatewayFault(this.options.unavailableCode ?? 'RESULT_EXPIRED', 'Result is unavailable or expired; repeat the original query.');
    const backing = blob.sharedKey ? { ...blob.value, ...this.shared.get(blob.sharedKey)!.value } as T : blob.value;
    const value = item.overlay ? ({ ...(backing as Record<string, unknown>), ...(item.overlay as Record<string, unknown>) } as T) : backing;
    return { value, expires_at: new Date(item.expiresAt).toISOString() };
  }
  /** Replace a handle's page (and view overlay); the blob carries the canonical page, view state stays in the overlay. */
  update(handle: string, value: T, overlay?: Partial<T>): void {
    const previous = this.get(handle);
    const expiresAt = Date.parse(previous.expires_at);
    const item = this.items.get(handle)!;
    const kind = item.kind; const seq = item.seq;
    const part = this.split(value); const key = this.keyOf(stringifyFhir(part.value) + (part.sharedKey ?? '')); const bytes = part.bytes;
    if (!this.blobs.has(key) && bytes + part.sharedBytes > this.byteLimit) throw this.unretainable();
    // Fitting a loaded page evicts evictable handles (res_ first) rather than refusing; the updated handle itself is exempt.
    const additional = (): number => {
      const current = this.items.get(handle);
      const oldBlob = current ? this.blobs.get(current.key) : undefined;
      let freed = oldBlob && current && oldBlob.refs.size === 1 && key !== current.key ? oldBlob.bytes : 0;
      if (freed && oldBlob?.sharedKey && oldBlob.sharedKey !== part.sharedKey && this.shared.get(oldBlob.sharedKey)?.refs.size === 1) freed += this.shared.get(oldBlob.sharedKey)!.bytes;
      const delta = (this.blobs.has(key) ? 0 : bytes) + (part.sharedKey && !this.shared.has(part.sharedKey) ? part.sharedBytes : 0);
      return delta - freed;
    };
    const restore = this.options.ledger?.reservationCheckpoint() ?? this.reservationCheckpoint();
    try {
      while (this.usedBytes() + additional() > this.byteLimit) if (!this.evictOldestEvictable([handle])) throw this.retentionFault();
      if (this.options.ledger && !this.options.ledger.makeRoom(additional())) throw this.retentionFault();
      this.remove(handle);
      this.install(key, part);
      this.blobs.get(key)!.refs.add(handle);
      this.items.set(handle, { key, kind, expiresAt, seq, ...(overlay ? { overlay } : {}) });
      this.schedule();
    } catch (error) { restore(); throw error; }
  }
  /** Candidate delivery reservations are synchronous. Rollback restores evictions
   * as well as provisional handles; callers checkpoint every store on a ledger.
   * Never hold this checkpoint across an await or a state invalidation.
   * @internal Candidate reservation hook; not a supported package API. */
  reservationCheckpoint(): () => void {
    const blobs = new Map([...this.blobs].map(([key, blob]) => [key, { ...blob, refs: new Set(blob.refs) }]));
    const shared = new Map([...this.shared].map(([key, blob]) => [key, { ...blob, refs: new Set(blob.refs) }]));
    const items = new Map(this.items), seq = this.seq, generation = this.clearGeneration;
    return () => {
      if (generation !== this.clearGeneration) return;
      this.reset();
      for (const [key, value] of blobs) this.blobs.set(key, value);
      for (const [key, value] of shared) this.shared.set(key, value);
      for (const [key, value] of items) this.items.set(key, value);
      this.seq = seq; this.purgeExpired();
    };
  }

  private reset(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.items.clear(); this.blobs.clear(); this.shared.clear();
  }
  clear(): void { this.clearGeneration++; this.reset(); }
  close(): void { this.clear(); }
}

/**
 * Trusted local evidence: the `type/id` keys of patient-linked records that this gateway has already authorized
 * as the bound patient's own records in the current state generation. It never fetches anything. It is bounded
 * (least recently used out) and the gateway clears it at the same boundary that clears retained results, so an
 * entry can only shorten, never widen, what a later search may name.
 *
 * Shared-directory reachability: the same structure also holds the reachable directory
 * keys (Practitioner, Organization, Location named by a delivered own record). One bound and one reset cover both kinds.
 * The two kinds never collide (a reachable key carries a prefix no `type/id` key can start with), and they share the
 * capacity: whichever key is evicted simply stops counting, so an evicted directory key is unreachable again (fails closed).
 */
const REACHABLE_PREFIX = 'reachable ';
export class VerifiedTargetLedger {
  private readonly keys = new Set<string>();
  constructor(readonly capacity: number) {}
  add(type: string, id: string): void { this.put(`${type}/${id}`); }
  /** Membership; a hit also refreshes the entry so a live search chain keeps its targets. */
  has(type: string, id: string): boolean { return this.touch(`${type}/${id}`); }
  /** Record a directory record named by a delivered own record. */
  addReachable(type: string, id: string): void { this.put(`${REACHABLE_PREFIX}${type}/${id}`); }
  /** True only when `type/id` is in the reachable set; a hit refreshes it. */
  reachable(type: string, id: string): boolean { return this.touch(`${REACHABLE_PREFIX}${type}/${id}`); }
  private put(key: string): void {
    this.keys.delete(key);
    this.keys.add(key);
    while (this.keys.size > this.capacity) this.keys.delete(this.keys.values().next().value!);
  }
  private touch(key: string): boolean {
    if (!this.keys.has(key)) return false;
    this.keys.delete(key);
    this.keys.add(key);
    return true;
  }
  clear(): void { this.keys.clear(); }
  get size(): number { return this.keys.size; }
}
