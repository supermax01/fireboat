// Loopback SigV4 signing proxy in front of one HealthLake data store (arms FBh and FBdh; fireboat itself is unchanged).
// fireboat speaks plain HTTP to a literal loopback base and cannot sign AWS requests. This proxy listens on 127.0.0.1,
// accepts only GET under /fhir (fireboat is read-only), maps /fhir/<rest> to the configured data store's FHIR base
// https://healthlake.us-east-2.amazonaws.com/datastore/<id>/r4/<rest>, signs each request with SigV4 and returns the
// response. It refuses every other method, path, absolute-form target and non-loopback Host; strips hop-by-hop, auth,
// cookie and client x-amz-* headers; never follows a redirect (a 3xx becomes 502 without its Location).
// Like any reverse proxy, it rewrites the absolute URLs HealthLake writes into a search Bundle (Bundle.link[].url and
// Bundle.entry[].fullUrl) from the data store base to this proxy's public base (http://<Host>/fhir/), so a client that
// validates next links and entry origins against its configured base sees its own base. Query strings and every other
// byte are left as HealthLake sent them; numbers keep their lexemes (lib/json.ts). Logs never hold headers or credentials.
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import type { SignatureV4 } from '@smithy/signature-v4';
import { LosslessNumber, parseLossless, stringifyLossless, type LosslessValue } from '../lib/json.js';
import { repairPartialTail } from '../lib/jsonl.js';
import { AwsSessionError, type DatastoreEndpoint } from './aws.js';
import { httpsTransport, queryPairs, signRequest, type Transport } from './sign.js';

export const PUBLIC_PREFIX = '/fhir';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade']);
/** Request headers never forwarded: hop-by-hop, routing, credentials and anything the signer owns. */
const DROP_REQUEST = new Set(['host', 'authorization', 'cookie', 'content-length', 'content-type', 'accept-encoding', 'expect', 'forwarded', 'via', 'origin', 'referer']);
/** Response headers never returned: hop-by-hop, length (recomputed), encoding (the body is sent decoded), redirects and cookies. */
const DROP_RESPONSE = new Set(['content-length', 'content-encoding', 'location', 'content-location', 'set-cookie', 'strict-transport-security', 'alt-svc']);

const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/;
const PATH_CHARS_RE = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;

const connectionTokens = (h: IncomingHttpHeaders | Record<string, string | string[] | undefined>): Set<string> =>
  new Set(String(h.connection ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

/** Headers forwarded upstream (lower-case names; repeated values joined), then signed. */
export function filterRequestHeaders(h: IncomingHttpHeaders): Record<string, string> {
  const named = connectionTokens(h);
  const out: Record<string, string> = {};
  for (const [k0, v] of Object.entries(h)) {
    const k = k0.toLowerCase();
    if (v === undefined || HOP_BY_HOP.has(k) || named.has(k) || DROP_REQUEST.has(k) || k.startsWith('x-amz') || k.startsWith('proxy-') || k.startsWith('x-forwarded-')) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  out['accept-encoding'] = 'identity';
  return out;
}

/** Headers returned to the client. */
export function filterResponseHeaders(h: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const named = connectionTokens(h);
  const out: Record<string, string | string[]> = {};
  for (const [k0, v] of Object.entries(h)) {
    const k = k0.toLowerCase();
    if (v === undefined || HOP_BY_HOP.has(k) || named.has(k) || DROP_RESPONSE.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Maps a public request path to the data store path, or explains the refusal. `/fhir` and `/fhir/<rest>` only; no
 * empty, dot or dot-dot segment, no encoded dot, slash or backslash, only RFC 3986 path characters.
 */
export function mapPath(publicPath: string, endpoint: DatastoreEndpoint): { path: string } | { refused: string } {
  if (publicPath !== PUBLIC_PREFIX && !publicPath.startsWith(`${PUBLIC_PREFIX}/`)) return { refused: `path outside ${PUBLIC_PREFIX}` };
  const rest = publicPath.slice(PUBLIC_PREFIX.length).replace(/^\//, '');
  if (!PATH_CHARS_RE.test(rest)) return { refused: 'path has characters outside RFC 3986' };
  if (/%(?![0-9A-Fa-f]{2})/.test(rest)) return { refused: 'malformed percent-encoding' };
  if (/%(2e|2f|5c|00)/i.test(rest)) return { refused: 'encoded dot, slash, backslash or NUL in path' };
  const segs = rest === '' ? [] : rest.split('/');
  if (segs.some((s, i) => s === '.' || s === '..' || (s === '' && i !== segs.length - 1))) return { refused: 'empty, dot or dot-dot path segment' };
  return { path: `${endpoint.basePath}${rest}` };
}

export interface RewriteResult { text: string; changed: boolean; links: number; fullUrls: number; foreign: string[] }

/** One absolute URL from the data store base to the public base; anything else unchanged (reported when absolute). */
export function rewriteUrl(u: string, upstreamBase: string, publicBase: string): { url: string; rewritten: boolean; foreign: boolean } {
  if (u.startsWith(upstreamBase)) return { url: publicBase + u.slice(upstreamBase.length), rewritten: true, foreign: false };
  if (u === upstreamBase.replace(/\/$/, '') || u.startsWith(`${upstreamBase.replace(/\/$/, '')}?`)) {
    return { url: publicBase.replace(/\/$/, '') + u.slice(upstreamBase.length - 1), rewritten: true, foreign: false };
  }
  return { url: u, rewritten: false, foreign: /^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('urn:') };
}

const isObj = (v: unknown): v is Record<string, LosslessValue> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof LosslessNumber);

/**
 * Rewrites Bundle.link[].url and Bundle.entry[].fullUrl of a Bundle response. Returns null for anything that is not
 * a JSON Bundle (sent unchanged). Unchanged Bundles keep their original bytes (changed: false).
 */
export function rewriteBundleUrls(text: string, upstreamBase: string, publicBase: string): RewriteResult | null {
  let v: LosslessValue;
  try { v = parseLossless(text); } catch { return null; }
  if (!isObj(v) || v.resourceType !== 'Bundle') return null;
  const r: RewriteResult = { text, changed: false, links: 0, fullUrls: 0, foreign: [] };
  if (Array.isArray(v.link)) {
    for (const l of v.link) {
      if (!isObj(l) || typeof l.url !== 'string') continue;
      const x = rewriteUrl(l.url, upstreamBase, publicBase);
      if (x.rewritten) { l.url = x.url; r.links++; } else if (x.foreign) r.foreign.push(`link:${String(l.relation ?? '')}`);
    }
  }
  if (Array.isArray(v.entry)) {
    for (const e of v.entry) {
      if (!isObj(e) || typeof e.fullUrl !== 'string') continue;
      const x = rewriteUrl(e.fullUrl, upstreamBase, publicBase);
      if (x.rewritten) { e.fullUrl = x.url; r.fullUrls++; } else if (x.foreign) r.foreign.push('entry.fullUrl');
    }
  }
  if (r.links + r.fullUrls > 0) { r.text = stringifyLossless(v); r.changed = true; }
  return r;
}

export interface SigningProxyOptions {
  port: number;
  endpoint: DatastoreEndpoint;
  signer: SignatureV4;
  /** Default: HTTPS to HealthLake (sign.ts). Tests pass a fake. */
  transport?: Transport;
  /** JSONL request log: method, path, query, statuses, sizes, timings, refusals, rewrite counts. Never headers. */
  logPath?: string;
  slot?: number;
}

export interface SigningProxyHandle {
  port: number;
  close(): Promise<void>;
  /** credential_errors: the session lapsed (no credentials from the CLI, or HealthLake rejected the token or signature). */
  stats(): { requests: number; refused: number; upstream: number; upstream_errors: number; credential_errors: number; links_rewritten: number; fullurls_rewritten: number };
}

const outcome = (code: string, diagnostics: string) =>
  JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code, diagnostics }] });

function decode(body: Buffer, encoding: string): Buffer {
  const e = encoding.toLowerCase().trim();
  if (e === '' || e === 'identity') return body;
  if (e === 'gzip') return gunzipSync(body);
  if (e === 'deflate') return inflateSync(body);
  if (e === 'br') return brotliDecompressSync(body);
  throw new Error(`unsupported content-encoding ${e}`);
}

export async function startSigningProxy(o: SigningProxyOptions): Promise<SigningProxyHandle> {
  const transport = o.transport ?? httpsTransport;
  const stats = { requests: 0, refused: 0, upstream: 0, upstream_errors: 0, credential_errors: 0, links_rewritten: 0, fullurls_rewritten: 0 };
  let seq = 0;
  if (o.logPath) { mkdirSync(dirname(o.logPath), { recursive: true }); repairPartialTail(o.logPath); }
  const log = (rec: Record<string, unknown>) => {
    if (o.logPath) appendFileSync(o.logPath, JSON.stringify({ schema: 'fbbench.signing-proxy/1', slot: o.slot ?? null, ...rec }) + '\n');
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const t0 = performance.now();
    const base = { seq: seq++, started_at: new Date().toISOString(), method: req.method ?? '' };
    stats.requests++;
    const send = (status: number, body: string | Buffer, headers: Record<string, string | string[]> = { 'content-type': 'application/fhir+json;charset=utf-8' }) => {
      const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      res.writeHead(status, { ...headers, 'content-length': String(buf.length) });
      res.end(buf);
      return buf.length;
    };
    const refuse = (status: number, code: string, why: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
      stats.refused++;
      const n = send(status, outcome(code, `signing proxy: ${why}`), { 'content-type': 'application/fhir+json;charset=utf-8', ...headers });
      log({ ...base, ...extra, status, refused: why, response_bytes: n, ms: performance.now() - t0 });
    };
    const target = req.url ?? '';
    if (!target.startsWith('/')) return refuse(400, 'invalid', 'absolute-form or empty request target');
    const qi = target.indexOf('?');
    const publicPath = qi < 0 ? target : target.slice(0, qi);
    const rawQuery = qi < 0 ? '' : target.slice(qi + 1);
    const where = { path: publicPath, query: rawQuery };
    const host = String(req.headers.host ?? '');
    if (!LOOPBACK_HOST_RE.test(host)) return refuse(403, 'forbidden', 'Host is not a loopback host:port', where);
    if (req.method !== 'GET') return refuse(405, 'not-supported', `${req.method} refused: GET only`, where, { allow: 'GET' });
    if ((req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') || req.headers['transfer-encoding'] !== undefined) {
      return refuse(400, 'invalid', 'GET with a body', where);
    }
    const mapped = mapPath(publicPath, o.endpoint);
    if ('refused' in mapped) return refuse(403, 'forbidden', mapped.refused, where);

    let up;
    try {
      const signed = await signRequest(o.signer, { method: 'GET', path: mapped.path, pairs: queryPairs(rawQuery), headers: filterRequestHeaders(req.headers) });
      stats.upstream++;
      up = await transport(signed);
    } catch (e) {
      stats.upstream_errors++;
      if (e instanceof AwsSessionError) stats.credential_errors++;
      const msg = (e as Error).message.slice(0, 300);
      const n = send(502, outcome('transient', `signing proxy: upstream request failed: ${msg}`));
      log({ ...base, ...where, status: 502, upstream_status: null, error: msg, response_bytes: n, ms: performance.now() - t0 });
      return;
    }
    if ((up.status === 401 || up.status === 403) && /expired|security token|signature/i.test(up.body.toString('utf8').slice(0, 2000))) stats.credential_errors++;
    if (up.status >= 300 && up.status < 400) {
      const n = send(502, outcome('transient', `signing proxy: upstream answered ${up.status} (redirects are not followed)`));
      log({ ...base, ...where, status: 502, upstream_status: up.status, refused: 'upstream redirect', response_bytes: n, ms: performance.now() - t0 });
      return;
    }
    let body: Buffer;
    try { body = decode(up.body, String(up.headers['content-encoding'] ?? '')); } catch (e) {
      stats.upstream_errors++;
      const n = send(502, outcome('transient', `signing proxy: ${(e as Error).message}`));
      log({ ...base, ...where, status: 502, upstream_status: up.status, error: 'decode', response_bytes: n, ms: performance.now() - t0 });
      return;
    }
    let links = 0, fullUrls = 0, foreign: string[] = [];
    if (/json/i.test(String(up.headers['content-type'] ?? ''))) {
      const rw = rewriteBundleUrls(body.toString('utf8'), o.endpoint.base, `http://${host}${PUBLIC_PREFIX}/`);
      if (rw) {
        links = rw.links; fullUrls = rw.fullUrls; foreign = rw.foreign;
        if (rw.changed) body = Buffer.from(rw.text, 'utf8');
      }
    }
    stats.links_rewritten += links; stats.fullurls_rewritten += fullUrls;
    const n = send(up.status, body, filterResponseHeaders(up.headers));
    log({ ...base, ...where, status: up.status, upstream_status: up.status, upstream_bytes: up.body.length, response_bytes: n, links_rewritten: links, fullurls_rewritten: fullUrls, ...(foreign.length ? { foreign_urls: foreign } : {}), ms: performance.now() - t0 });
  };

  const server: Server = createServer((req, res) => {
    // GET bodies are refused above; drain anything sent so the socket stays usable.
    req.resume();
    handle(req, res).catch(e => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`signing proxy error: ${(e as Error).message.slice(0, 200)}`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const addr = server.address();
  return {
    port: typeof addr === 'object' && addr ? addr.port : o.port,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
    stats: () => ({ ...stats }),
  };
}
