import { controlledFetch, GatewayFault, utf8Charset, type HttpFetch, type RequestBudget } from '../../core/src/transport.js';

export interface OAuthClientCredentialsConfig {
  type: 'client_credentials';
  tokenUrl: string;
  clientId: string;
  clientSecretEnv: string;
  scopes?: string[];
}

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

/** Internal transport options and test injections; not part of public gateway config. */
export interface ClientCredentialsProviderOptions {
  fetchFn?: typeof fetch;
  /** Internal work accounting only; no credential or request data. */
  onRequest?: () => void;
  now?: () => number;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxTokenResponseBytes?: number;
  expirySkewMs?: number;
  maxExpiresInSeconds?: number;
}

const CONFIG_KEYS = new Set(['type', 'tokenUrl', 'clientId', 'clientSecretEnv', 'scopes']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+={0,2}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TOKEN_BYTES = 16_384;
const DEFAULT_EXPIRY_SKEW_MS = 30_000;
const DEFAULT_MAX_EXPIRES_IN_S = 86_400;
const MAX_TOKEN_LENGTH = 8_192;

function fault(code: string, message: string, retryable = false): CredentialFault {
  return new CredentialFault(code, message, retryable);
}

function parseLoopbackUrl(value: unknown, label: string): URL {
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

function boundedOption(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
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

interface CachedToken { header: string; usableUntil: number; generation: number }
interface Flight { promise: Promise<CachedToken>; controller: AbortController; waiters: number }
/** `generation` identifies the credential behind `authorization`; pass it to `invalidate` so a late rejection of an older token cannot discard a newer one. */
export interface AuthorizationGrant { authorization: string; generation: number }

/**
 * Local OAuth2 client-credentials provider for a synthetic loopback backend.
 * This is not SMART user launch/PKCE, SMART backend-services private_key_jwt,
 * or inbound MCP authorization. Requested scopes are sent as-is; granted
 * permissions are not verified here.
 */
export class ClientCredentialsProvider {
  private readonly sourceOrigin: string;
  private readonly sourceBasePath: string;
  private readonly tokenUrl: URL;
  private readonly clientId: string;
  private readonly clientSecretEnv: string;
  private readonly scopes: readonly string[];
  private readonly fetchFn: HttpFetch;
  private readonly onRequest?: () => void;
  private readonly now: () => number;
  private readonly env: Record<string, string | undefined>;
  private readonly timeoutMs: number;
  private readonly maxTokenResponseBytes: number;
  private readonly expirySkewMs: number;
  private readonly maxExpiresInSeconds: number;

  private cached: CachedToken | null = null;
  private inflight: Flight | null = null;
  private generation = 0;
  private closed = false;

  constructor(sourceBaseUrl: string, config: OAuthClientCredentialsConfig, options: ClientCredentialsProviderOptions = {}) {
    const source = parseLoopbackUrl(sourceBaseUrl, 'Source URL');
    this.sourceOrigin = source.origin;
    this.sourceBasePath = source.pathname.replace(/\/+$/, '');

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw fault('INVALID_CONFIG', 'Credential configuration is invalid.');
    }
    for (const key of Object.keys(config)) {
      if (!CONFIG_KEYS.has(key)) throw fault('INVALID_CONFIG', 'Credential configuration contains an unsupported field.');
    }
    if (config.type !== 'client_credentials') {
      throw fault('INVALID_CONFIG', 'Credential configuration type is invalid.');
    }
    this.tokenUrl = parseLoopbackUrl(config.tokenUrl, 'Token URL');

    if (typeof config.clientId !== 'string' || config.clientId.length === 0 || config.clientId.length > 256 || /[\s\x00-\x1F\x7F]/.test(config.clientId)) {
      throw fault('INVALID_CONFIG', 'Credential configuration clientId is invalid.');
    }
    this.clientId = config.clientId;

    if (typeof config.clientSecretEnv !== 'string' || config.clientSecretEnv.length > 128 || !ENV_NAME.test(config.clientSecretEnv)) {
      throw fault('INVALID_CONFIG', 'Credential configuration clientSecretEnv is invalid.');
    }
    this.clientSecretEnv = config.clientSecretEnv;

    const scopes = config.scopes ?? [];
    if (!Array.isArray(scopes) || scopes.length > 20
      || scopes.some(s => typeof s !== 'string' || s.length === 0 || s.length > 128 || !SCOPE_TOKEN.test(s))
      || new Set(scopes).size !== scopes.length) {
      throw fault('INVALID_CONFIG', 'Credential configuration scopes are invalid.');
    }
    this.scopes = [...scopes];

    // Never ambient fetch in production: the controlled client ignores NODE_USE_ENV_PROXY/HTTP(S)_PROXY.
    this.fetchFn = options.fetchFn ?? controlledFetch;
    this.onRequest = options.onRequest;
    this.now = options.now ?? Date.now;
    this.env = options.env ?? process.env;
    this.timeoutMs = boundedOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 120_000, 'timeoutMs');
    this.maxTokenResponseBytes = boundedOption(options.maxTokenResponseBytes, DEFAULT_MAX_TOKEN_BYTES, 64, 1_048_576, 'maxTokenResponseBytes');
    this.expirySkewMs = boundedOption(options.expirySkewMs, DEFAULT_EXPIRY_SKEW_MS, 0, 3_600_000, 'expirySkewMs');
    this.maxExpiresInSeconds = boundedOption(options.maxExpiresInSeconds, DEFAULT_MAX_EXPIRES_IN_S, 1, 604_800, 'maxExpiresInSeconds');
  }

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
      // R6: every acquired credential has its own generation. An expired token is superseded here, so a late
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

  private startFlight(): Flight {
    const controller = new AbortController();
    const flight: Flight = { controller, waiters: 0, promise: this.acquire(this.generation, controller.signal) };
    this.inflight = flight;
    const settled = () => { if (this.inflight === flight) this.inflight = null; };
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
      // The flight's own timeout bounds longer budgets.
      if (remaining !== undefined && remaining < this.timeoutMs) timer = setTimeout(() => { settle(fault('TOKEN_TIMEOUT', 'Token acquisition deadline was reached.', true)); }, remaining);
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

  private async request(generation: number, signal: AbortSignal): Promise<CachedToken> {
    const secret = this.env[this.clientSecretEnv];
    if (typeof secret !== 'string' || secret.length === 0 || secret.length > 4_096) {
      throw fault('CREDENTIAL_UNAVAILABLE', 'Configured client secret is not available.');
    }
    const basic = Buffer.from(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(secret)}`, 'utf8').toString('base64');
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (this.scopes.length > 0) form.set('scope', this.scopes.join(' '));

    // Lifetime is anchored to request start: the token may have been issued at any instant after this.
    const startedAt = this.now();
    let response: Response;
    this.onRequest?.();
    try {
      response = await this.fetchFn(this.tokenUrl, {
        method: 'POST',
        redirect: 'manual',
        // F-3: the token allowance bounds compressed input (metered raw before decompression)
        // as well as the decoded bytes counted in readBounded below.
        maxCompressedBytes: this.maxTokenResponseBytes,
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: form.toString(),
      });
    } catch (error) {
      throw this.mapFetchError(error);
    }

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
    const fields = parsed as Record<string, unknown>;
    const accessToken = fields.access_token;
    const tokenType = fields.token_type;
    const expiresIn = fields.expires_in;
    if (typeof accessToken !== 'string' || accessToken.length === 0 || accessToken.length > MAX_TOKEN_LENGTH || !BEARER_TOKEN.test(accessToken)
      || typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer'
      || typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > this.maxExpiresInSeconds) {
      throw fault('INVALID_TOKEN_RESPONSE', 'Token endpoint returned an invalid response.');
    }

    if (this.closed) throw fault('PROVIDER_CLOSED', 'Credential provider is closed.');
    if (generation !== this.generation) throw fault('CREDENTIAL_INVALIDATED', 'Credential was invalidated while a token request was in flight.', true);

    const lifetimeMs = expiresIn * 1_000;
    const skewMs = Math.min(this.expirySkewMs, Math.floor(lifetimeMs / 2));
    const usableUntil = startedAt + lifetimeMs - skewMs;
    // An exhausted token is neither cached nor returned.
    if (this.now() >= usableUntil) throw fault('TOKEN_EXPIRED', 'Token endpoint returned a token whose usable lifetime elapsed before delivery.', true);
    const token: CachedToken = { header: `Bearer ${accessToken}`, usableUntil, generation };
    this.cached = token;
    return token;
  }

  private async readBounded(response: Response): Promise<Uint8Array> {
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

  private mapFetchError(error: unknown): CredentialFault | LocalWorkRefusal {
    if (error instanceof LocalWorkRefusal) return error;
    if (error instanceof CredentialFault) return error;
    // F-3: a compressed-byte refusal from the controlled client is a size limit, not malformed JSON.
    if ((error as { code?: unknown } | null)?.code === 'UPSTREAM_LIMIT') return fault('TOKEN_RESPONSE_LIMIT', 'Token response exceeds the configured byte limit.');
    if (error instanceof GatewayFault) return fault('INVALID_TOKEN_RESPONSE', 'Token endpoint returned an invalid response.');
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      return fault('TOKEN_TIMEOUT', 'Token endpoint timed out.', true);
    }
    return fault('TOKEN_ENDPOINT_ERROR', 'Unable to obtain a token from the configured token endpoint.', true);
  }
}
