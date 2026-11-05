import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { pipeline, Transform, type Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { parseFhirJson } from './decimal.js';

/**
 * `status` is the upstream HTTP status when the fault arose after a response was received, and `cause` is the precise
 * pre-mapping fault (`CODE` or `CODE:status`) when the public code was uniformized. Both are diagnostic only: they
 * belong in the metadata-only audit, never in the public envelope (J-15).
 */
export class GatewayFault extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly status?: number, readonly cause?: string) { super(message); }
}

/** Caller cancellation plus an optional absolute overall deadline (epoch ms). Every upstream request still keeps its own configured timeout: min(timeout, remaining budget). `epoch` is the gateway credential generation the request runs on (V-4); the transport itself ignores it. */
export interface RequestBudget { signal?: AbortSignal; deadline?: number; epoch?: number }
/** What the source said when it rejected a credentialed request. `generation` identifies the credential that made the request, when the provider exposes it. */
export interface RejectionInfo { status: number; invalidToken: boolean; isMetadata: boolean; generation?: number }
export interface TransportCredentials {
  authorizationFor(url: URL, budget?: RequestBudget): Promise<string>;
  authorizationWithGeneration?(url: URL, budget?: RequestBudget): Promise<{ authorization: string; generation: number }>;
  /** Called on 401/403 with structured info; zero-argument implementations remain valid. Returns true when the rejection concerned a superseded generation and nothing was invalidated (V-28). The transport itself changes no state. */
  onRejected(info?: RejectionInfo): void | boolean;
}

/** RFC 6750: only a 401 or an authenticated Bearer `invalid_token` challenge shows the credential is unusable. A plain 403 (including a metadata 403) denies one request; it is not proof of an invalid token. Missing info keeps the legacy conservative answer. */
export const invalidatesCredential = (info?: RejectionInfo): boolean => !info || info.status === 401 || info.invalidToken;

const TCHAR = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const CHALLENGE_PARAM = new RegExp(`^(${TCHAR})\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|(${TCHAR}))$`, 's');
const CHALLENGE_START = new RegExp(`^(${TCHAR})(?:\\s+(.*))?$`, 's');
/** True only for a Bearer challenge carrying error="invalid_token" (quoted or token form). */
export function bearerInvalidToken(header: string | null): boolean {
  if (!header || header.length > 8_192) return false;
  const items: string[] = [];
  let current = '', quoted = false, escaped = false;
  for (const ch of header) {
    if (escaped) escaped = false;
    else if (quoted && ch === '\\') escaped = true;
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { items.push(current); current = ''; continue; }
    current += ch;
  }
  items.push(current);
  let scheme = '';
  for (const raw of items) {
    let item = raw.trim();
    if (!item) continue;
    const start = /^[^\s=]+\s*=/.test(item) ? null : CHALLENGE_START.exec(item);
    if (start) { scheme = start[1]!.toLowerCase(); item = (start[2] ?? '').trim(); }
    const param = CHALLENGE_PARAM.exec(item);
    if (scheme === 'bearer' && param && param[1]!.toLowerCase() === 'error' && (param[2]?.replace(/\\(.)/gs, '$1') ?? param[3]) === 'invalid_token') return true;
  }
  return false;
}

/** JSON is UTF-8 (RFC 8259); any other declared charset is refused rather than transcoded or replaced. */
export function utf8Charset(contentType: string): boolean {
  for (const part of contentType.split(';').slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim().toLowerCase() !== 'charset') continue;
    if (!['utf-8', 'utf8'].includes(part.slice(eq + 1).trim().replace(/^"(.*)"$/s, '$1').toLowerCase())) return false;
  }
  return true;
}

export interface HttpRequestInit {
  method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: 'manual';
  /** F-3: explicit allowance for raw (still-encoded) response bytes. The client meters the IncomingMessage stream and destroys it before any decompressor once exceeded, independently of Content-Length; callers keep their own decoded-byte counter on top. */
  maxCompressedBytes?: number;
}
export type HttpFetch = (url: URL, init: HttpRequestInit) => Promise<Response>;

// Dedicated agents, never the global agent or the global fetch dispatcher: NODE_USE_ENV_PROXY/--use-env-proxy with
// HTTP(S)_PROXY configure those, and would otherwise route credentialed FHIR/token traffic through a proxy. No agent
// sets proxyEnv. Redirects are never followed; TLS verification cannot be disabled by NODE_TLS_REJECT_UNAUTHORIZED.
const AGENTS = { 'http:': new HttpAgent({ keepAlive: false }), 'https:': new HttpsAgent({ keepAlive: false, rejectUnauthorized: true }) };
const DECODERS: Record<string, () => Transform> = { gzip: createGunzip, 'x-gzip': createGunzip, deflate: createInflate, br: createBrotliDecompress };
const NULL_BODY = new Set([204, 205, 304]);

/**
 * Bridges the final node stream to a web ReadableStream without `Readable.toWeb`: that adapter
 * enqueues from its `'data'` listener with no cancelled guard on supported Node versions
 * (24.21 and earlier), so a chunk delivered by an already-scheduled resume tick after the web
 * stream is cancelled throws `ERR_INVALID_STATE` as an uncaughtException. Here cancellation
 * settles the bridge and destroys the whole node chain synchronously, and any chunk that
 * still arrives afterwards is dropped instead of enqueued.
 */
function webReadable(stream: Readable, destroyChain: (error?: unknown) => void): ReadableStream<Uint8Array> {
  let settled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.pause();
      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        try { controller.enqueue(new Uint8Array(chunk)); }
        catch { settled = true; destroyChain(); return; }
        if ((controller.desiredSize ?? 1) <= 0) stream.pause();
      });
      stream.once('end', () => { if (settled) return; settled = true; try { controller.close(); } catch { /* already closed */ } });
      stream.once('error', error => { if (settled) return; settled = true; try { controller.error(error); } catch { /* already closed */ } });
      stream.once('close', () => { if (settled) return; settled = true; try { controller.error(new Error('Upstream response stream closed prematurely.')); } catch { /* already closed */ } });
    },
    pull() { if (!settled) stream.resume(); },
    cancel(reason) { settled = true; destroyChain(reason); },
  }, new ByteLengthQueuingStrategy({ highWaterMark: stream.readableHighWaterMark }));
}

/** Minimal fetch-shaped client over node:http(s) with explicit agents. Decompressed bytes stream through unbuffered so callers can bound them; when `maxCompressedBytes` is given, raw encoded bytes are metered (and the socket destroyed) before any decompressor sees them (F-3). */
export const controlledFetch: HttpFetch = (url, init) => new Promise<Response>((resolve, reject) => {
  const { signal } = init;
  if (signal?.aborted) { reject(signal.reason); return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') { reject(new TypeError('Unsupported protocol.')); return; }
  const body = init.body === undefined ? undefined : Buffer.from(init.body, 'utf8');
  const options = { method: init.method ?? 'GET', headers: { 'accept-encoding': 'gzip, deflate, br', ...init.headers, ...(body ? { 'content-length': String(body.byteLength) } : {}) } };
  const req = url.protocol === 'https:' ? httpsRequest(url, { ...options, agent: AGENTS['https:'] }) : httpRequest(url, { ...options, agent: AGENTS['http:'] });
  let incoming: IncomingMessage | undefined;
  let destroyBody: ((error?: unknown) => void) | undefined;
  const onAbort = () => { req.destroy(signal!.reason); if (destroyBody) destroyBody(signal!.reason); else incoming?.destroy(signal!.reason); reject(signal!.reason); };
  const release = () => signal?.removeEventListener('abort', onAbort);
  signal?.addEventListener('abort', onAbort, { once: true });
  req.on('error', error => { release(); reject(error); });
  req.on('response', res => {
    incoming = res;
    res.once('close', release);
    const status = res.statusCode ?? 0;
    const codings = String(res.headers['content-encoding'] ?? '').toLowerCase().split(',').map(coding => coding.trim()).filter(coding => coding && coding !== 'identity');
    if (status < 200 || status > 599) { res.destroy(); reject(new TypeError('Invalid HTTP status.')); return; }
    if (codings.length > 2 || codings.some(coding => !DECODERS[coding])) { res.destroy(); reject(new GatewayFault('UNSUPPORTED_CONTENT', 'Only identity, gzip, deflate or br response encodings are accepted.', false, status)); return; }
    const headers = new Headers();
    try { for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!); }
    catch (error) { res.destroy(); reject(error); return; }
    if (NULL_BODY.has(status)) { res.destroy(); resolve(new Response(null, { status, headers })); return; }
    const transforms: Transform[] = [];
    // F-3: meter the raw IncomingMessage bytes first. Exceeding the allowance destroys the
    // socket and fails the body stream before a single excess byte reaches a decompressor,
    // whether or not the response declared a (truthful) Content-Length.
    const compressedLimit = init.maxCompressedBytes;
    if (compressedLimit !== undefined) {
      let seen = 0;
      transforms.push(new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          seen += chunk.byteLength;
          if (seen > compressedLimit) {
            res.destroy();
            callback(new GatewayFault('UPSTREAM_LIMIT', 'Response exceeds the configured compressed byte limit.', false, status));
            return;
          }
          callback(null, chunk);
        },
      }));
    }
    for (const coding of codings.reverse()) transforms.push(DECODERS[coding]!());
    const chain: Readable[] = [res, ...transforms];
    const destroyChain = (error?: unknown) => {
      // AbortSignal reasons are DOMExceptions (AbortError/TimeoutError); pass them through as
      // the destroy cause, as the previous incoming.destroy(signal.reason) did, so readers
      // keep seeing the same error names. Other cancel reasons are clean destroys.
      const cause = error instanceof Error || (error !== null && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string') ? error as Error : undefined;
      for (const node of chain) if (!node.destroyed) node.destroy(cause);
    };
    destroyBody = destroyChain;
    const stream: Readable = transforms.length ? pipeline(chain, () => undefined) as unknown as Readable : res;
    resolve(new Response(webReadable(stream, destroyChain), { status, headers }));
  });
  req.end(body);
});

const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
export interface AmbientProxyRisk { enabled: boolean; activatedBy: string[]; proxyVariables: string[]; risk: boolean }
/** Detects Node's environment-proxy activation (NODE_USE_ENV_PROXY, --use-env-proxy in NODE_OPTIONS or execArgv) and which proxy variables are set. Reports names only, never values, which may carry credentials. */
export function ambientProxyRisk(env: Record<string, string | undefined> = process.env, execArgv: readonly string[] = process.execArgv): AmbientProxyRisk {
  const flagged = (args: readonly string[]) => args.reduce((on, arg) => arg === '--use-env-proxy' ? true : arg === '--no-use-env-proxy' ? false : arg.startsWith('--use-env-proxy=') ? !['false', '0'].includes(arg.slice(16).toLowerCase()) : on, false);
  const toggle = (env.NODE_USE_ENV_PROXY ?? '').trim().toLowerCase();
  const activatedBy = [
    ...(toggle && !['0', 'false'].includes(toggle) ? ['NODE_USE_ENV_PROXY'] : []),
    ...(flagged((env.NODE_OPTIONS ?? '').split(/\s+/).map(arg => arg.replace(/^["']|["']$/g, ''))) ? ['NODE_OPTIONS'] : []),
    ...(flagged(execArgv) ? ['execArgv'] : []),
  ];
  const proxyVariables = PROXY_VARIABLES.filter(name => (env[name] ?? '').trim() !== '');
  return { enabled: activatedBy.length > 0, activatedBy, proxyVariables, risk: activatedBy.length > 0 && proxyVariables.length > 0 };
}

function credentialFault(error: unknown): GatewayFault | undefined {
  if (error instanceof GatewayFault) return error;
  const { code, retryable } = (error ?? {}) as { code?: unknown; retryable?: unknown };
  if (error instanceof Error && error.name === 'CredentialFault' && typeof code === 'string' && typeof retryable === 'boolean') return new GatewayFault(code, error.message, retryable);
  return undefined;
}

export class FhirTransport {
  readonly base: URL;
  constructor(baseUrl: string, private readonly byteLimit: number, private readonly timeoutMs: number, private readonly credentials?: TransportCredentials) {
    try { this.base = new URL(baseUrl); } catch { throw new GatewayFault('INVALID_CONFIG', 'Source URL is invalid.'); }
    if (!['127.0.0.1', '[::1]'].includes(this.base.hostname) || !['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash) {
      throw new GatewayFault('LOOPBACK_ONLY', 'This prototype accepts only literal loopback FHIR sources. Data classification is operator-declared, not verified by the gateway.');
    }
    this.base.pathname = this.base.pathname.replace(/\/+$/, '') + '/';
  }
  url(path: string): URL { return this.validate(new URL(path, this.base)); }
  validate(value: string | URL): URL {
    let url: URL;
    try { url = new URL(value, this.base); } catch { throw new GatewayFault('UNSAFE_URL', 'Source returned an invalid continuation.'); }
    const insideBase = url.pathname === this.base.pathname.slice(0, -1) || url.pathname.startsWith(this.base.pathname);
    if (url.origin !== this.base.origin || !insideBase || url.username || url.password || url.hash || /%(?:2f|5c|2e)/i.test(url.pathname)) {
      throw new GatewayFault('UNSAFE_URL', 'Continuation must remain inside the configured FHIR source.');
    }
    return url;
  }
  /** Each upstream request (token wait, FHIR fetch) gets min(configured timeout, remaining deadline), combined with the caller's signal. */
  private bounds(budget: RequestBudget): { signal: AbortSignal; timer: AbortSignal } {
    if (budget.signal?.aborted) throw new GatewayFault('REQUEST_CANCELLED', 'The request was cancelled.');
    const remaining = budget.deadline === undefined ? this.timeoutMs : Math.min(this.timeoutMs, Math.floor(budget.deadline - Date.now()));
    if (!(remaining > 0)) throw new GatewayFault('UPSTREAM_TIMEOUT', 'The request deadline was reached before the FHIR source responded.', true);
    const timer = AbortSignal.timeout(remaining);
    return { timer, signal: budget.signal ? AbortSignal.any([budget.signal, timer]) : timer };
  }
  private async authorize(url: URL, signal: AbortSignal, deadline?: number): Promise<{ authorization?: string; generation?: number }> {
    if (!this.credentials) return {};
    const budget: RequestBudget = deadline === undefined ? { signal } : { signal, deadline };
    if (this.credentials.authorizationWithGeneration) return this.credentials.authorizationWithGeneration(url, budget);
    return { authorization: await this.credentials.authorizationFor(url, budget) };
  }
  async get(url: URL, stats: { calls: number }, budget: RequestBudget = {}): Promise<Record<string, unknown>> {
    this.validate(url);
    let bounds = this.bounds(budget);
    let status: number | undefined;
    try {
      const { authorization, generation } = await this.authorize(url, bounds.signal, budget.deadline);
      bounds = this.bounds(budget);
      stats.calls++;
      // F-3: the same upstream allowance bounds both compressed input (metered raw inside the
      // client, before decompression) and decoded output (the reader counter below).
      const response = await controlledFetch(url, { redirect: 'manual', signal: bounds.signal, maxCompressedBytes: this.byteLimit, headers: { accept: 'application/fhir+json, application/json', prefer: 'handling=strict', ...(authorization ? { authorization } : {}) } });
      status = response.status;
      if (status >= 300 && status < 400) { await response.body?.cancel().catch(() => undefined); throw new GatewayFault('UNSAFE_REDIRECT', 'FHIR redirects are disabled.'); }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const rejected = status === 401 || status === 403;
        const invalidToken = rejected && Boolean(authorization) && bearerInvalidToken(response.headers.get('www-authenticate'));
        // V-28: a rejection of a superseded generation proves nothing about the current connection, so the
        // caller may simply repeat the request on the fresh credential.
        const superseded = this.credentials && rejected ? this.credentials.onRejected({ status, invalidToken, isMetadata: url.pathname === `${this.base.pathname}metadata`, ...(generation === undefined ? {} : { generation }) }) === true : false;
        if (status === 401 || invalidToken) throw new GatewayFault('CONNECTION_REQUIRED', superseded ? 'The source connection changed during this request; repeat it.' : 'The configured source requires a valid connection.', superseded);
        if (status === 404 || status === 403) throw new GatewayFault('NOT_FOUND', 'Requested resource is not available.');
        if (status === 429) throw new GatewayFault('RATE_LIMITED', 'Synthetic source rate limit reached.', true);
        throw new GatewayFault('UPSTREAM_ERROR', `FHIR source rejected the request (HTTP ${status}).`, status >= 500);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!/^(application\/(?:fhir\+)?json)(?:\s*;|$)/i.test(contentType)) {
        await response.body?.cancel().catch(() => undefined); throw new GatewayFault('UNSUPPORTED_CONTENT', 'Only FHIR JSON responses are accepted.');
      }
      if (!utf8Charset(contentType)) { await response.body?.cancel().catch(() => undefined); throw new GatewayFault('UNSUPPORTED_CONTENT', 'Only UTF-8 FHIR JSON responses are accepted.'); }
      const length = response.headers.get('content-length');
      if (length && Number(length) > this.byteLimit) { await response.body?.cancel().catch(() => undefined); throw new GatewayFault('UPSTREAM_LIMIT', 'FHIR response exceeds the configured byte limit.'); }
      const reader = response.body?.getReader();
      if (!reader) throw new GatewayFault('INVALID_RESPONSE', 'FHIR source returned no JSON body.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > this.byteLimit) { await reader.cancel(); throw new GatewayFault('UPSTREAM_LIMIT', 'FHIR response exceeds the configured byte limit.'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      // Fatal decoding: malformed bytes are refused, never replaced with U+FFFD. A leading UTF-8 BOM is stripped.
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Buffer.concat(chunks, size)); }
      catch { throw new GatewayFault('INVALID_RESPONSE', 'FHIR source returned malformed UTF-8.'); }
      // J-6: number lexemes that a JS round-trip would change are preserved as FhirDecimal scalars (decimal.ts);
      // nothing is rejected or rounded at parse time.
      let parsed: unknown;
      try { parsed = parseFhirJson(text); }
      catch { throw new GatewayFault('INVALID_RESPONSE', 'FHIR source returned malformed JSON.'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).resourceType !== 'string') throw new GatewayFault('INVALID_RESPONSE', 'FHIR source returned an invalid resource.');
      return parsed as Record<string, unknown>;
    } catch (error) {
      const known = credentialFault(error);
      if (known) throw status !== undefined && known.status === undefined ? new GatewayFault(known.code, known.message, known.retryable, status) : known;
      if (budget.signal?.aborted) throw new GatewayFault('REQUEST_CANCELLED', 'The request was cancelled.', false, status);
      if (bounds.timer.aborted || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))) throw new GatewayFault('UPSTREAM_TIMEOUT', 'FHIR source timed out.', true, status);
      throw new GatewayFault('UPSTREAM_ERROR', 'Unable to read a response from the configured FHIR source.', true, status);
    }
  }
}
