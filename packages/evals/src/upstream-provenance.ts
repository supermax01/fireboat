import { channel } from 'node:diagnostics_channel';
import { createHash } from 'node:crypto';
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { EVAL_PATIENT_ID } from './fixture.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Harness-owned identity, never inferred from the source's opaque paging token or the gateway's evidence. */
export interface UpstreamChain { chain: string; query: string; resourceType?: string }
export interface OpaqueLinkAcceptance {
  request_index: number;
  issuing_request_index: number;
  confined_root_request_index: number;
  chain_sha256: string;
  query_sha256: string;
  issued_link_sha256: string;
}
export interface ObservedUpstreamRequest {
  readonly index: number;
  readonly url: URL;
  readonly context: UpstreamChain;
  readonly search: boolean;
  readonly confined: boolean;
  readonly gap?: string;
  readonly parent?: ObservedUpstreamRequest;
  readonly root?: number;
  readonly acceptedLink?: OpaqueLinkAcceptance;
}
interface IssuedLink { key: string; request: ObservedUpstreamRequest }

/** Preserve every ordered, repeated parameter occurrence. Encoding normalization never removes a pair. */
function urlKey(url: URL): string {
  return JSON.stringify([url.origin, url.pathname, [...url.searchParams], url.username, url.password, url.hash]);
}

/** Independent eval observation only: this grants no gateway continuation, execution or sort proof. */
export class IssuedLinkProvenance {
  readonly requests: ObservedUpstreamRequest[] = [];
  private readonly links: IssuedLink[] = [];
  private readonly base: URL;
  /** `patientId` is the harness's independently trusted patient (the gateway configuration's), never read from a response. */
  constructor(baseUrl: string, private readonly scope: string, private readonly patientId: string = EVAL_PATIENT_ID) {
    if (!/^[A-Za-z0-9.-]{1,64}$/.test(patientId)) throw new Error('Invalid trusted patient identity.');
    this.base = new URL(`${baseUrl.replace(/\/$/, '')}/`);
  }

  private sameSource(url: URL): boolean {
    return url.origin === this.base.origin && !url.username && !url.password && !url.hash
      && (url.pathname === this.base.pathname.slice(0, -1) || url.pathname.startsWith(this.base.pathname));
  }

  beginRequest(value: string | URL, context: UpstreamChain): ObservedUpstreamRequest {
    const url = new URL(value, this.base);
    const relative = url.pathname.slice(this.base.pathname.length).split('/').filter(Boolean);
    const rootPath = url.pathname === this.base.pathname.slice(0, -1) || url.pathname === this.base.pathname;
    const search = rootPath || (relative.length === 1 && relative[0] !== 'metadata');
    const actualType = !rootPath && relative.length === 1 ? relative[0] : undefined;
    const type = actualType ?? context.resourceType;
    const typeMismatch = actualType !== undefined && context.resourceType !== undefined && actualType !== context.resourceType;
    const visible = type === 'Patient' ? url.searchParams.getAll('_id') : [...url.searchParams.getAll('patient'), ...url.searchParams.getAll('subject')];
    const allowed = type === 'Patient' ? [this.patientId] : [this.patientId, `Patient/${this.patientId}`];
    const conflicting = visible.some(value => !value.split(',').every(part => allowed.includes(part)));
    const direct = this.sameSource(url) && !conflicting && !typeMismatch && visible.length > 0;
    const issued = this.links.filter(link => link.key === urlKey(url)
      && link.request.context.chain === context.chain && link.request.context.query === context.query
      && link.request.context.resourceType === context.resourceType && link.request.confined);
    // A visible conflicting predicate can never be rescued by an otherwise exact issued link.
    const parent = this.sameSource(url) && !conflicting && !typeMismatch && issued.length === 1 ? issued[0]!.request : undefined;
    const confined = direct || parent !== undefined;
    const index = this.requests.length + 1;
    const root = direct ? index : parent?.root;
    const acceptedLink = !direct && parent && root !== undefined ? {
      request_index: index, issuing_request_index: parent.index, confined_root_request_index: root,
      chain_sha256: digest([this.scope, context.chain]), query_sha256: digest(context.query), issued_link_sha256: digest(urlKey(url)),
    } : undefined;
    const observed: ObservedUpstreamRequest = {
      index, url, context: { ...context }, search, confined, ...(parent ? { parent } : {}), ...(root !== undefined ? { root } : {}),
      ...(!confined && search ? { gap: typeMismatch ? 'search/page resource type differs from its query chain' : conflicting ? 'search/page request carries a conflicting confinement predicate'
        : 'search/page request lacks visible confinement and a unique previously issued next link from its confined query chain' } : {}),
      ...(acceptedLink ? { acceptedLink } : {}),
    };
    this.requests.push(observed);
    return observed;
  }

  /** Called only after the independently observed body ended completely and decoded within both byte bounds. */
  completeResponse(request: ObservedUpstreamRequest, status: number, body: unknown): void {
    const bundle = record(body);
    if (!this.requests.includes(request) || !request.search || !request.confined || status < 200 || status >= 300
      || bundle?.resourceType !== 'Bundle' || bundle.type !== 'searchset'
      || (bundle.entry !== undefined && !Array.isArray(bundle.entry)) || !Array.isArray(bundle.link)) return;
    if (bundle.link.some(link => typeof record(link)?.relation !== 'string' || typeof record(link)?.url !== 'string')) return;
    const next = bundle.link.filter(link => record(link)!.relation === 'next');
    if (next.length !== 1) return;
    let url: URL;
    try { url = new URL(record(next[0])!.url as string, this.base); } catch { return; }
    if (!this.sameSource(url)) return;
    this.links.push({ key: urlKey(url), request });
  }

  /** Inherit only absent parameters, through the exact same verified parent; present values stay authoritative. */
  hasConstraint(request: ObservedUpstreamRequest, name: string, value: string): boolean {
    if (!this.requests.includes(request)) return false;
    const present = request.url.searchParams.getAll(name);
    if (present.length) return present.includes(value);
    return request.parent !== undefined && this.hasConstraint(request.parent, name, value);
  }

  acceptedOpaqueLinks(): OpaqueLinkAcceptance[] {
    return this.requests.flatMap(request => request.acceptedLink ? [{ ...request.acceptedLink }] : []);
  }
}

/** Observe emitted source bytes without proxying, rewriting payloads, or replacing the gateway transport. */
export class SourceResponseObserver {
  readonly provenance: IssuedLinkProvenance;
  private readonly base: URL;
  private active?: UpstreamChain;
  private readonly diagnostic;
  private readonly listener: (message: unknown) => void;

  constructor(baseUrl: string, scope: string, serverSide = false, patientId: string = EVAL_PATIENT_ID) {
    this.base = new URL(baseUrl);
    this.provenance = new IssuedLinkProvenance(baseUrl, scope, patientId);
    this.diagnostic = channel(serverSide ? 'http.server.request.start' : 'http.client.request.start');
    this.listener = (message: unknown) => {
      if (!this.active) return;
      const event = message as { request?: ClientRequest | IncomingMessage; response?: ServerResponse };
      const request = event.request;
      if (!request) return;
      const host = serverSide ? (request as IncomingMessage).headers.host : (request as ClientRequest).getHeader('host');
      if (host !== this.base.host) return;
      const path = serverSide ? (request as IncomingMessage).url : (request as ClientRequest).path;
      if (!path) return;
      const observed = this.provenance.beginRequest(new URL(path, this.base), this.active);
      if (serverSide && event.response) this.observeServerResponse(event.response, observed);
      else (request as ClientRequest).once('response', response => this.observeClientResponse(response, observed));
    };
    this.diagnostic.subscribe(this.listener);
  }

  beginCall(context: UpstreamChain): void { if (this.active) throw new Error('Overlapping upstream observation.'); this.active = { ...context }; }
  endCall(): void { this.active = undefined; }
  close(): void { this.active = undefined; this.diagnostic.unsubscribe(this.listener); }

  private bodyCapture(observed: ObservedUpstreamRequest) {
    let bytes = 0;
    let valid = true;
    const chunks: Buffer[] = [];
    return {
      append(chunk: unknown, encoding?: BufferEncoding) {
        if (!valid || (typeof chunk !== 'string' && !(chunk instanceof Uint8Array))) return;
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_BODY_BYTES) { valid = false; chunks.length = 0; return; }
        chunks.push(buffer);
      },
      fail() { valid = false; chunks.length = 0; },
      finish: (status: number, contentType: unknown, contentEncoding: unknown) => {
        if (!valid || !/^application\/(?:fhir\+)?json(?:\s*;|$)/i.test(String(contentType ?? ''))) return;
        try {
          const codings = String(contentEncoding ?? '').toLowerCase().split(',').map(value => value.trim()).filter(value => value && value !== 'identity');
          if (codings.length > 2) return;
          let body = Buffer.concat(chunks, bytes);
          for (const coding of codings.reverse()) {
            const decode = ({ gzip: gunzipSync, 'x-gzip': gunzipSync, deflate: inflateSync, br: brotliDecompressSync } as const)[coding as 'gzip'];
            if (!decode) return;
            body = decode(body, { maxOutputLength: MAX_BODY_BYTES });
          }
          if (body.byteLength > MAX_BODY_BYTES) return;
          this.provenance.completeResponse(observed, status, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
        } catch { /* Invalid, truncated or oversized source bodies never issue proof. */ }
        finally { chunks.length = 0; }
      },
    };
  }

  private observeClientResponse(response: IncomingMessage, observed: ObservedUpstreamRequest): void {
    const capture = this.bodyCapture(observed);
    response.on('data', chunk => capture.append(chunk));
    response.once('aborted', () => capture.fail());
    response.once('error', () => capture.fail());
    response.once('end', () => {
      if (!response.complete) { capture.fail(); return; }
      capture.finish(response.statusCode ?? 0, response.headers['content-type'], response.headers['content-encoding']);
    });
  }

  /** Child-process packaged evals are observed at the local fixture's server boundary. */
  private observeServerResponse(response: ServerResponse, observed: ObservedUpstreamRequest): void {
    const capture = this.bodyCapture(observed);
    const write = response.write, end = response.end;
    response.write = function (this: ServerResponse, ...args: Parameters<ServerResponse['write']>) {
      capture.append(args[0], typeof args[1] === 'string' ? args[1] : undefined);
      return Reflect.apply(write, this, args);
    } as ServerResponse['write'];
    response.end = function (this: ServerResponse, ...args: Parameters<ServerResponse['end']>) {
      capture.append(args[0], typeof args[1] === 'string' ? args[1] : undefined);
      return Reflect.apply(end, this, args);
    } as ServerResponse['end'];
    response.once('error', () => capture.fail());
    response.once('finish', () => {
      response.write = write; response.end = end;
      capture.finish(response.statusCode, response.getHeader('content-type'), response.getHeader('content-encoding'));
    });
  }
}
