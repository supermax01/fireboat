// Loopback recording proxy and momentum token shim.
// Recording proxy, slot s: 127.0.0.1:1821s -> HAPI 127.0.0.1:18190. Forwards GET, HEAD and POST .../_search with every
// header unchanged (Host included, so HAPI writes this slot's origin into fullUrl and next links). Every other method
// gets 403 + OperationOutcome, logged as blocked. One ProxyLogRecord per request, appended to logPath.
// Token shim, slot s: 127.0.0.1:1823s. POST /oauth2/token returns a fixed token; /fhir/* goes to the slot's proxy.
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { repairPartialTail } from '../lib/jsonl.js';
import { HAPI_PORT, slotPorts } from '../lib/paths.js';
import type { ProxyLogRecord } from '../lib/types.js';

export interface ProxyHandle {
  close(): Promise<void>;
  setRunId(id: string): void;
  /** Sequence number the next request will get (seq is per proxy instance, starting at 0). */
  nextSeq(): number;
  port: number;
}

const BLOCKED_BODY = JSON.stringify({
  resourceType: 'OperationOutcome',
  issue: [{ severity: 'error', code: 'forbidden', diagnostics: 'write attempt, blocked by benchmark harness' }],
});

const isAllowed = (method: string, path: string) =>
  method === 'GET' || method === 'HEAD' || (method === 'POST' && /\/_search\/?$/.test(path));

/**
 * upstreamPort: tests, and the Medplum backend of arms Ws and Wm (servers/medplum.ts), which also passes `port`
 * (the slot's 1824s port) so it never takes a HAPI slot's proxy port.
 */
export async function startRecordingProxy(opts: { slot: number; runId: string; logPath: string; upstreamPort?: number; port?: number }): Promise<ProxyHandle> {
  const port = opts.port ?? slotPorts(opts.slot).recordingProxy;
  const upstreamPort = opts.upstreamPort ?? HAPI_PORT;
  let runId = opts.runId;
  let seq = 0;
  mkdirSync(dirname(opts.logPath), { recursive: true });
  repairPartialTail(opts.logPath);
  const record = (r: Omit<ProxyLogRecord, 'schema' | 'slot'>) =>
    appendFileSync(opts.logPath, JSON.stringify({ schema: 'fbbench.proxy/1', slot: opts.slot, ...r }) + '\n');

  const server = createServer((req, res) => {
    const startedAt = new Date();
    const t0 = performance.now();
    const mySeq = seq++;
    const myRun = runId;
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://proxy.invalid');
    let requestBytes = 0;
    const base = { run_id: myRun, seq: mySeq, started_at: startedAt.toISOString(), method, path: url.pathname, query: url.search.replace(/^\?/, '') };

    if (!isAllowed(method, url.pathname)) {
      req.on('data', (c: Buffer) => { requestBytes += c.length; });
      req.on('end', () => {
        res.writeHead(403, { 'content-type': 'application/fhir+json;charset=utf-8' });
        res.end(BLOCKED_BODY);
        record({ ...base, status: 403, request_bytes: requestBytes, response_bytes_decoded: Buffer.byteLength(BLOCKED_BODY), ms: performance.now() - t0, blocked: true });
      });
      req.resume();
      return;
    }

    const upstream = request({ host: '127.0.0.1', port: upstreamPort, method, path: req.url, headers: req.headers }, up => {
      res.writeHead(up.statusCode ?? 502, up.statusMessage, up.rawHeaders as unknown as Record<string, string>);
      countDecoded(up, decoded => {
        record({ ...base, status: up.statusCode ?? 502, request_bytes: requestBytes, response_bytes_decoded: decoded, ms: performance.now() - t0, blocked: false });
      });
      up.pipe(res);
    });
    upstream.on('error', err => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`proxy upstream error: ${err.message}`);
      record({ ...base, status: 502, request_bytes: requestBytes, response_bytes_decoded: 0, ms: performance.now() - t0, blocked: false });
    });
    req.on('data', (c: Buffer) => { requestBytes += c.length; });
    req.pipe(upstream);
  });
  await listen(server, port);
  return {
    port,
    close: () => closeServer(server),
    setRunId: (id: string) => { runId = id; },
    nextSeq: () => seq,
  };
}

/** Counts decoded body bytes of a response (gzip, deflate or br), without altering what is forwarded. */
function countDecoded(up: IncomingMessage, done: (bytes: number) => void): void {
  const enc = String(up.headers['content-encoding'] ?? '').toLowerCase().trim();
  const decoder = enc === 'gzip' ? createGunzip() : enc === 'deflate' ? createInflate() : enc === 'br' ? createBrotliDecompress() : null;
  let bytes = 0;
  let finished = false;
  const finish = () => { if (!finished) { finished = true; done(bytes); } };
  if (!decoder) {
    up.on('data', (c: Buffer) => { bytes += c.length; });
    up.on('end', finish);
    up.on('close', finish);
    return;
  }
  decoder.on('data', (c: Buffer) => { bytes += c.length; });
  decoder.on('end', finish);
  decoder.on('error', finish);
  up.on('data', (c: Buffer) => decoder.write(c));
  up.on('end', () => decoder.end());
  up.on('close', () => decoder.end());
}

export const SHIM_TOKEN = 'fbbench-static-token';

export async function startTokenShim(opts: { slot: number }): Promise<ProxyHandle> {
  const { tokenShim, recordingProxy } = slotPorts(opts.slot);
  let seq = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seq++;
    const path = new URL(req.url ?? '/', 'http://shim.invalid').pathname;
    if (req.method === 'POST' && path === '/oauth2/token') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: SHIM_TOKEN, token_type: 'Bearer', expires_in: 3600, scope: 'system/*.read' }));
      });
      return;
    }
    if (path === '/fhir' || path.startsWith('/fhir/') || path.startsWith('/fhir?')) {
      const upstream = request({ host: '127.0.0.1', port: recordingProxy, method: req.method, path: req.url, headers: req.headers }, up => {
        res.writeHead(up.statusCode ?? 502, up.statusMessage, up.rawHeaders as unknown as Record<string, string>);
        up.pipe(res);
      });
      upstream.on('error', err => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`token shim upstream error: ${err.message}`);
      });
      req.pipe(upstream);
      return;
    }
    req.resume();
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await listen(server, tokenShim);
  return { port: tokenShim, close: () => closeServer(server), setRunId: () => {}, nextSeq: () => seq };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
