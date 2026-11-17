// SigV4 signing for HealthLake data-plane requests (service `healthlake`, region us-east-2) with the AWS SDK for
// JavaScript v3 signer (@smithy/signature-v4: the package @aws-sdk/signature-v4 moved to; pinned in bench/package.json).
// SHA-256 and HMAC come from node:crypto. Credentials come from a CredentialProvider (aws.ts: the local AWS CLI only).
// The HTTPS transport connects only to healthlake.us-east-2.amazonaws.com and never follows redirects.
import { createHash, createHmac, type Hash, type Hmac } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { SignatureV4 } from '@smithy/signature-v4';
import { AWS_REGION, HEALTHLAKE_HOST, HEALTHLAKE_SERVICE, type CredentialProvider, type DatastoreEndpoint } from './aws.js';

type SourceData = string | ArrayBuffer | ArrayBufferView;
const toBuffer = (d: SourceData): Buffer =>
  typeof d === 'string' ? Buffer.from(d, 'utf8') : ArrayBuffer.isView(d) ? Buffer.from(d.buffer, d.byteOffset, d.byteLength) : Buffer.from(d);

/** SHA-256 (or HMAC-SHA-256 with a secret) in the signer's Checksum shape, from node:crypto. */
export class NodeSha256 {
  private h: Hash | Hmac;
  constructor(private readonly secret?: SourceData) { this.h = this.fresh(); }
  private fresh(): Hash | Hmac { return this.secret === undefined ? createHash('sha256') : createHmac('sha256', toBuffer(this.secret)); }
  update(chunk: SourceData): void { this.h.update(toBuffer(chunk)); }
  async digest(): Promise<Uint8Array> { return new Uint8Array(this.h.digest()); }
  reset(): void { this.h = this.fresh(); }
}

export function makeSigner(credentials: CredentialProvider): SignatureV4 {
  return new SignatureV4({ service: HEALTHLAKE_SERVICE, region: AWS_REGION, credentials, sha256: NodeSha256, uriEscapePath: true });
}

/**
 * Query pairs of a raw query string, decoded the way a servlet FHIR server (HAPI) decodes them: `+` is a space,
 * `%XX` is decoded. Re-encoded strictly (strictQuery) before sending, so the signed and the sent query are the same.
 */
export function queryPairs(rawQuery: string): [string, string][] {
  return [...new URLSearchParams(rawQuery.replace(/^\?/, '')).entries()];
}

/** RFC 3986 encoding, as SigV4 canonicalisation does it. */
export const strictEncode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const strictQuery = (pairs: readonly [string, string][]): string => pairs.map(([k, v]) => `${strictEncode(k)}=${strictEncode(v)}`).join('&');

function queryBag(pairs: readonly [string, string][]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of pairs) {
    const cur = out[k];
    out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  return out;
}

export interface UpstreamRequest { method: 'GET' | 'POST'; host: string; pathWithQuery: string; headers: Record<string, string>; body?: string }
export interface UpstreamResponse { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
/** Sends one signed request. The default connects to HealthLake over HTTPS; tests pass a fake. */
export type Transport = (r: UpstreamRequest) => Promise<UpstreamResponse>;

/** Responses larger than this are refused (100 resources at the largest holdout resource is about 45 MB). */
export const MAX_RESPONSE_BYTES = 96 * 1024 * 1024;

/** HTTPS to healthlake.us-east-2.amazonaws.com only; redirects are never followed (node:https does not follow them). */
export const httpsTransport: Transport = r => new Promise((resolve, reject) => {
  if (r.host !== HEALTHLAKE_HOST) { reject(new Error(`refusing to connect to ${r.host}`)); return; }
  const req = httpsRequest({ host: HEALTHLAKE_HOST, servername: HEALTHLAKE_HOST, port: 443, method: r.method, path: r.pathWithQuery, headers: r.headers, timeout: 120_000 }, res => {
    const chunks: Buffer[] = [];
    let n = 0;
    res.on('data', (c: Buffer) => {
      n += c.length;
      if (n > MAX_RESPONSE_BYTES) { req.destroy(new Error(`upstream response over ${MAX_RESPONSE_BYTES} bytes`)); return; }
      chunks.push(c);
    });
    res.on('end', () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
    res.on('error', reject);
  });
  req.on('timeout', () => req.destroy(new Error('upstream timeout')));
  req.on('error', reject);
  if (r.body !== undefined) req.write(r.body);
  req.end();
});

/**
 * Signs one request to a data store path. `path` is the wire path (already percent-encoded once, as received);
 * the signer escapes it once more for the canonical request, as botocore does for HealthLake.
 */
export async function signRequest(signer: SignatureV4, r: { method: 'GET' | 'POST'; path: string; pairs: readonly [string, string][]; headers: Record<string, string>; body?: string }): Promise<UpstreamRequest> {
  const headers: Record<string, string> = { ...r.headers, host: HEALTHLAKE_HOST };
  const signed = await signer.sign({
    method: r.method, protocol: 'https:', hostname: HEALTHLAKE_HOST, path: r.path,
    query: queryBag(r.pairs), headers, ...(r.body !== undefined ? { body: r.body } : {}),
  });
  const q = strictQuery(r.pairs);
  return { method: r.method, host: HEALTHLAKE_HOST, pathWithQuery: q ? `${r.path}?${q}` : r.path, headers: signed.headers as Record<string, string>, ...(r.body !== undefined ? { body: r.body } : {}) };
}

/** A signed request relative to a data store's FHIR base (loader and verify; the proxy builds its own). */
export async function datastoreRequest(x: { endpoint: DatastoreEndpoint; signer: SignatureV4; transport?: Transport }, r: { method: 'GET' | 'POST'; rel: string; pairs?: [string, string][]; headers?: Record<string, string>; body?: string }): Promise<UpstreamResponse> {
  if (r.rel.includes('..') || r.rel.startsWith('/')) throw new Error('bad relative path');
  const req = await signRequest(x.signer, { method: r.method, path: `${x.endpoint.basePath}${r.rel}`, pairs: r.pairs ?? [], headers: { accept: 'application/fhir+json', ...(r.headers ?? {}) }, ...(r.body !== undefined ? { body: r.body } : {}) });
  return (x.transport ?? httpsTransport)(req);
}
