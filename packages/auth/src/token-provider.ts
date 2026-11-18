import { GatewayFault, utf8Charset, type RequestBudget } from '../../core/src/transport.js';

export class CredentialFault extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = 'CredentialFault';
  }
}

/** Internal pre-send refusal, preserved unchanged across a shared token flight.
 * It proves nothing about the credential or any waiter's authorization state. */
export class LocalWorkRefusal extends GatewayFault {
  constructor() { super('UPSTREAM_LIMIT', 'The bounded upstream request allowance was reached.'); }
}

/** Internal token-flight options and test injections shared by every provider; not part of public gateway config. */
export interface TokenProviderOptions {
  /** Internal work accounting only; no credential or request data. */
  onRequest?: () => void;
  now?: () => number;
  timeoutMs?: number;
  maxTokenResponseBytes?: number;
  expirySkewMs?: number;
  maxExpiresInSeconds?: number;
}

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
export const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+={0,2}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TOKEN_BYTES = 16_384;
const DEFAULT_EXPIRY_SKEW_MS = 30_000;
const DEFAULT_MAX_EXPIRES_IN_S = 86_400;
export const MAX_TOKEN_LENGTH = 8_192;

export function fault(code: string, message: string, retryable = false): CredentialFault {
  return new CredentialFault(code, message, retryable);
}

export function parseLoopbackUrl(value: unknown, label: string): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    throw fault('INVALID_CONFIG', `${label} is invalid.`);
  }
  let url: URL;
  try { url = new URL(value); } catch { throw fault('INVALID_CONFIG', `${label} is invalid.`); }
  if (url.username || url.password || url.search || url.hash) {
    throw fault('INVALID_CONFIG', `${label} must not contain credentials, a query, or a fragment.`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
    throw fault('LOOPBACK_ONLY', `${label} must be an explicitly configured literal loopback endpoint.`);
  }
  return url;
}

export function boundedOption(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw fault('INVALID_CONFIG', `${label} is invalid.`);
  return value;
}

function abortFault(signal: AbortSignal): CredentialFault {
  const reason: unknown = signal.reason;
  return reason instanceof Error && reason.name === 'TimeoutError'
    ? fault('TOKEN_TIMEOUT', 'Token endpoint timed out.', true)
    : fault('REQUEST_CANCELLED', 'Token acquisition was cancelled.');
}

export interface CachedToken { header: string; usableUntil: number; generation: number }
interface Flight { promise: Promise<CachedToken>; controller: AbortController; waiters: number }
/** `generation` identifies the credential behind `authorization`; pass it to `invalidate` so a late rejection of an older token cannot discard a newer one. */
export interface AuthorizationGrant { authorization: string; generation: number }
/** The FHIR interactions a granted scope can permit. */
export type GrantedInteraction = 'read' | 'search';
/** Closed SMART summary for `doctor`: enumerations and counts only. */
export interface SmartDoctorStatus {
  discovery: 'ok' | 'unavailable' | 'invalid';
  pkce: 'S256' | 'missing' | 'n/a';
  grant: 'present' | 'absent' | 'expired' | 'invalid' | 'n/a';
  patientContext: 'match' | 'n/a';
  scope: 'exact' | 'broader' | 'narrower' | 'unknown';
  grantedTypes?: number;
  servedTypes: number;
}

/**
 * Shared machinery for loopback token providers: one shared in-flight token request, credential
 * generations, the caller's own wait budget, the bounded token-response read, strict bearer-response
 * validation and transport error mapping. Each provider supplies only its own token `request`.
 */
export abstract class TokenProvider {
  private readonly sourceOrigin: string;
  private readonly sourceBasePath: string;
  protected onRequest?: () => void;
  protected now!: () => number;
  protected timeoutMs!: number;
  protected maxTokenResponseBytes!: number;
  protected expirySkewMs!: number;
  protected maxExpiresInSeconds!: number;

  protected cached: CachedToken | null = null;
  private inflight: Flight | null = null;
  /** Every acquisition still running, abandoned ones included: an aborted refresh still has to release its grant lock. */
  private readonly running = new Set<Promise<CachedToken>>();
  protected generation = 0;
  protected closed = false;

  protected constructor(sourceBaseUrl: string) {
    const source = parseLoopbackUrl(sourceBaseUrl, 'Source URL');
    this.sourceOrigin = source.origin;
    this.sourceBasePath = source.pathname.replace(/\/+$/, '');
  }

  /** Called by each provider after its own configuration checks, so configuration faults keep their order. */
  protected configureTokenOptions(options: TokenProviderOptions): void {
    this.onRequest = options.onRequest;
    this.now = options.now ?? Date.now;
    this.timeoutMs = boundedOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 120_000, 'timeoutMs');
    this.maxTokenResponseBytes = boundedOption(options.maxTokenResponseBytes, DEFAULT_MAX_TOKEN_BYTES, 64, 1_048_576, 'maxTokenResponseBytes');
    this.expirySkewMs = boundedOption(options.expirySkewMs, DEFAULT_EXPIRY_SKEW_MS, 0, 3_600_000, 'expirySkewMs');
    this.maxExpiresInSeconds = boundedOption(options.maxExpiresInSeconds, DEFAULT_MAX_EXPIRES_IN_S, 1, 604_800, 'maxExpiresInSeconds');
  }

  /** Whether the current grant permits `interaction` on `resourceType`. Checked before any FHIR request. */
  abstract allows(resourceType: string, interaction: GrantedInteraction): boolean;

  /** SMART providers describe their discovery and grant for `doctor`; other providers have nothing to report. */
  async doctorStatus(): Promise<SmartDoctorStatus | undefined> { return undefined; }

  /** Acquires one token for `generation`. Errors pass through `mapFetchError`. */
  protected abstract request(generation: number, signal: AbortSignal): Promise<CachedToken>;

  /** `budget` bounds only this caller's wait (signal and absolute deadline in the provider clock); a shared token flight keeps its own timeout. */
  async authorizationFor(url: URL, budget?: AbortSignal | RequestBudget): Promise<string> {
    return (await this.authorizationWithGeneration(url, budget)).authorization;
  }

  async authorizationWithGeneration(url: URL, budget?: AbortSignal | RequestBudget): Promise<AuthorizationGrant> {
    if (this.closed) throw fault('PROVIDER_CLOSED', 'Credential provider is closed.');
    this.assertInsideSource(url);
    const { signal, deadline }: RequestBudget = budget instanceof AbortSignal ? { signal: budget } : budget ?? {};
    for (let attempt = 0; ; attempt++) {
      if (this.closed) throw fault('PROVIDER_CLOSED', 'Credential provider is closed.');
      const cached = this.cached;
      if (cached && this.now() < cached.usableUntil) return { authorization: cached.header, generation: cached.generation };
      // Every acquired credential has its own generation. An expired token is superseded here, so a late
      // rejection of a request it made (invalidate with its generation) cannot discard the token acquired next.
      if (cached) this.generation++;
      this.cached = null;
      try {
        const token = await this.wait(signal, deadline);
        return { authorization: token.header, generation: token.generation };
      } catch (error) {
        // A flight superseded by invalidate() is retried once in the new generation; a second supersession propagates.
        if (attempt === 0 && error instanceof CredentialFault && error.code === 'CREDENTIAL_INVALIDATED' && !this.closed) continue;
        throw error;
      }
    }
  }

  /**
   * Discards the cached token and supersedes any in-flight acquisition. With a generation, this is a no-op unless
   * that generation is still current, so a late rejection of an older token cannot discard a newer credential.
   * Returns whether anything was invalidated. A closed provider stays closed.
   */
  invalidate(generation?: number): boolean {
    if (this.closed || (generation !== undefined && generation !== this.generation)) return false;
    this.generation++;
    this.cached = null;
    this.abandon(this.inflight);
    return true;
  }

  close(): void {
    this.closed = true;
    this.generation++;
    this.cached = null;
    this.abandon(this.inflight);
  }

  /**
   * Resolves once every acquisition still running has settled, or after `settleMs`, whichever comes first. Closing
   * aborts an acquisition, but its cleanup is asynchronous: a refresh still releases the grant lock it holds, and
   * finishes writing a rotated refresh token it already received. A process that exits first leaves the lock for
   * other servers to wait out.
   */
  async settled(settleMs: number): Promise<void> {
    if (this.running.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.running]), new Promise<void>(resolve => { timer = setTimeout(resolve, settleMs); })]);
    clearTimeout(timer);
  }

  private startFlight(): Flight {
    const controller = new AbortController();
    const flight: Flight = { controller, waiters: 0, promise: this.acquire(this.generation, controller.signal) };
    this.inflight = flight;
    this.running.add(flight.promise);
    const settled = () => { this.running.delete(flight.promise); if (this.inflight === flight) this.inflight = null; };
    flight.promise.then(settled, settled);
    return flight;
  }

  private abandon(flight: Flight | null): void {
    if (!flight) return;
    if (this.inflight === flight) this.inflight = null;
    flight.controller.abort();
  }

  /** Each caller races its own signal/deadline against the shared flight; the flight is aborted only when no waiter still needs it. */
  private wait(signal?: AbortSignal, deadline?: number): Promise<CachedToken> {
    if (signal?.aborted) return Promise.reject(abortFault(signal));
    const remaining = deadline === undefined ? undefined : deadline - this.now();
    if (remaining !== undefined && !(remaining > 0)) return Promise.reject(fault('TOKEN_TIMEOUT', 'Token acquisition deadline was reached.', true));
    // Join or start the flight only once this caller can actually wait for it.
    const flight = this.inflight ?? this.startFlight();
    flight.waiters++;
    return new Promise<CachedToken>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (leaving?: CredentialFault): boolean => {
        if (done) return false;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (leaving) {
          if (--flight.waiters === 0) this.abandon(flight);
          reject(leaving);
        }
        return true;
      };
      const onAbort = () => { settle(abortFault(signal!)); };
      signal?.addEventListener('abort', onAbort, { once: true });
      // A supplied deadline is always enforced: one acquisition can take several requests (discovery, then the token
      // request) and a wait for the grant lock, each within its own timeout, so their sum can exceed the deadline.
      if (remaining !== undefined) timer = setTimeout(() => { settle(fault('TOKEN_TIMEOUT', 'Token acquisition deadline was reached.', true)); }, remaining);
      flight.promise.then(token => { if (settle()) resolve(token); }, (error: unknown) => { if (settle()) reject(error); });
    });
  }

  private assertInsideSource(url: URL): void {
    const insideBase = this.sourceBasePath === ''
      || url?.pathname === this.sourceBasePath
      || (typeof url?.pathname === 'string' && url.pathname.startsWith(`${this.sourceBasePath}/`));
    if (!(url instanceof URL)
      || url.origin !== this.sourceOrigin
      || !insideBase
      || url.username || url.password || url.hash
      || /%(?:2f|5c|2e)/i.test(url.pathname)) {
      throw fault('UNSAFE_URL', 'Authorization is bound to the configured FHIR source.');
    }
  }

  private async acquire(generation: number, signal: AbortSignal): Promise<CachedToken> {
    try { return await this.request(generation, signal); }
    catch (error) {
      if (this.closed) throw fault('PROVIDER_CLOSED', 'Credential provider is closed.');
      if (generation !== this.generation) throw fault('CREDENTIAL_INVALIDATED', 'Credential was invalidated while a token request was in flight.', true);
      if (signal.aborted) throw fault('REQUEST_CANCELLED', 'Token acquisition was cancelled.');
      throw this.mapFetchError(error);
    }
  }

  /** Redirect, status, media type, declared and actual size, then a strict UTF-8 JSON object. */
  protected async readTokenFields(response: Response): Promise<Record<string, unknown>> {
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw fault('UNSAFE_REDIRECT', 'Token endpoint redirects are disabled.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const retryable = response.status === 429 || response.status >= 500;
      throw fault('TOKEN_ENDPOINT_ERROR', `Token endpoint rejected the request (HTTP ${response.status}).`, retryable);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType) || !utf8Charset(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw fault('INVALID_TOKEN_RESPONSE', 'Token endpoint returned an invalid response.');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > this.maxTokenResponseBytes)) {
      await response.body?.cancel().catch(() => undefined);
      throw fault('TOKEN_RESPONSE_LIMIT', 'Token response exceeds the configured byte limit.');
    }

    const bytes = await this.readBounded(response);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw fault('INVALID_TOKEN_RESPONSE', 'Token endpoint returned an invalid response.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw fault('INVALID_TOKEN_RESPONSE', 'Token endpoint returned an invalid response.');
    }
    return parsed as Record<string, unknown>;
  }

  /** A bearer access token of bounded size and an integer `expires_in` within the configured maximum. */
  protected bearerFields(fields: Record<string, unknown>): { accessToken: string; expiresIn: number } {
    const accessToken = fields.access_token;
    const tokenType = fields.token_type;
    const expiresIn = fields.expires_in;
    if (typeof accessToken !== 'string' || accessToken.length === 0 || accessToken.length > MAX_TOKEN_LENGTH || !BEARER_TOKEN.test(accessToken)
      || typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer'
      || typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > this.maxExpiresInSeconds) {
      throw fault('INVALID_TOKEN_RESPONSE', 'Token endpoint returned an invalid response.');
    }
    return { accessToken, expiresIn };
  }

  /** Caches a validated token for `generation` unless the provider closed or the generation was superseded meanwhile. */
  protected commitToken(generation: number, startedAt: number, accessToken: string, expiresIn: number): CachedToken {
    return this.commitUntil(generation, accessToken, this.usableUntil(startedAt, startedAt + expiresIn * 1_000));
  }

  /** Lifetime is anchored at request start; the expiry skew is at most half the lifetime. */
  protected usableUntil(startedAt: number, expiresAt: number): number {
    const lifetimeMs = expiresAt - startedAt;
    const skewMs = Math.min(this.expirySkewMs, Math.floor(lifetimeMs / 2));
    return startedAt + lifetimeMs - skewMs;
  }

  /** Caches a token usable until `usableUntil` (provider clock), with the same closed and generation checks. */
  protected commitUntil(generation: number, accessToken: string, usableUntil: number): CachedToken {
    if (this.closed) throw fault('PROVIDER_CLOSED', 'Credential provider is closed.');
    if (generation !== this.generation) throw fault('CREDENTIAL_INVALIDATED', 'Credential was invalidated while a token request was in flight.', true);

    // An exhausted token is neither cached nor returned.
    if (this.now() >= usableUntil) throw fault('TOKEN_EXPIRED', 'Token endpoint returned a token whose usable lifetime elapsed before delivery.', true);
    const token: CachedToken = { header: `Bearer ${accessToken}`, usableUntil, generation };
    this.cached = token;
    return token;
  }

  protected async readBounded(response: Response): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    if (!reader) throw fault('INVALID_TOKEN_RESPONSE', 'Token endpoint returned an invalid response.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxTokenResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw fault('TOKEN_RESPONSE_LIMIT', 'Token response exceeds the configured byte limit.');
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof CredentialFault) throw error;
      throw this.mapFetchError(error);
    } finally {
      reader.releaseLock();
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    return out;
  }

  protected mapFetchError(error: unknown): CredentialFault | LocalWorkRefusal {
    if (error instanceof LocalWorkRefusal) return error;
    if (error instanceof CredentialFault) return error;
    // A compressed-byte refusal from the controlled client is a size limit, not malformed JSON.
    if ((error as { code?: unknown } | null)?.code === 'UPSTREAM_LIMIT') return fault('TOKEN_RESPONSE_LIMIT', 'Token response exceeds the configured byte limit.');
    if (error instanceof GatewayFault) return fault('INVALID_TOKEN_RESPONSE', 'Token endpoint returned an invalid response.');
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      return fault('TOKEN_TIMEOUT', 'Token endpoint timed out.', true);
    }
    return fault('TOKEN_ENDPOINT_ERROR', 'Unable to obtain a token from the configured token endpoint.', true);
  }
}
