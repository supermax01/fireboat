// Fuzz infrastructure: the mock FHIR backend for adversarial numbers and the slot's canary listener.
// Chain during a fuzz run: server -> recording proxy (1821s) -> mock backend (1826s) -> HAPI (18190). The mock forwards
// every request to HAPI unchanged (Host header included, so fullUrl and next links keep the proxy's origin) except reads
// and _id searches of the fuzz Observations, which it answers itself with a value lexeme a float would change. So the
// mock serves HAPI's real CapabilityStatement, and every server registers and admits what it does against HAPI.
// The canary is a raw TCP listener: any connection (HTTP, LDAP or otherwise) is recorded as a hit.
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { HAPI_PORT, slotPorts } from '../lib/paths.js';

/** The mock listens on 127.0.0.1:1826s (18260 + slot), one port per slot like the other slot services. */
export const mockPort = (slot: number) => { slotPorts(slot); return 18260 + slot; };

export interface NumberFixture { id: string; lexeme: string }

/** The fuzz Observation, as exact text: the lexeme is written verbatim into valueQuantity.value. */
export function numberObservation(f: NumberFixture, patientId: string): string {
  if (!/^-?[0-9][0-9.eE+-]*$/.test(f.lexeme)) throw new Error(`not a JSON number lexeme: ${f.lexeme}`);
  return `{"resourceType":"Observation","id":${JSON.stringify(f.id)},"meta":{"versionId":"1","lastUpdated":"2026-01-01T00:00:00.000+00:00"},`
    + `"status":"final","code":{"text":"fbfuzz adversarial number"},"subject":{"reference":${JSON.stringify(`Patient/${patientId}`)}},`
    + `"effectiveDateTime":"2020-01-01T00:00:00+00:00","valueQuantity":{"value":${f.lexeme},"unit":"1","system":"http://unitsofmeasure.org","code":"1"}}`;
}

export function numberBundle(fs: NumberFixture[], patientId: string, origin: string, selfUrl: string): string {
  const entries = fs.map(f => `{"fullUrl":${JSON.stringify(`${origin}/fhir/Observation/${f.id}`)},"resource":${numberObservation(f, patientId)},"search":{"mode":"match"}}`);
  return `{"resourceType":"Bundle","id":"fbfuzz-number-search","meta":{"lastUpdated":"2026-01-01T00:00:00.000+00:00"},"type":"searchset","total":${fs.length},`
    + `"link":[{"relation":"self","url":${JSON.stringify(selfUrl)}}],"entry":[${entries.join(',')}]}`;
}

/** Which fixtures a request asks for: a read of one of them, or an Observation search whose _id names them. */
export function matchNumbers(method: string, rawUrl: string, body: string | null, fixtures: Map<string, NumberFixture>): { kind: 'read' | 'search'; hits: NumberFixture[] } | null {
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return null;
  const u = new URL(rawUrl, 'http://mock.invalid');
  const read = /^\/fhir\/Observation\/([A-Za-z0-9\-.]{1,64})\/?$/.exec(u.pathname);
  if (read && method !== 'POST') {
    const f = fixtures.get(read[1]!);
    return f ? { kind: 'read', hits: [f] } : null;
  }
  const isSearch = (method !== 'POST' && /^\/fhir\/Observation\/?$/.test(u.pathname)) || (method === 'POST' && /^\/fhir\/Observation\/_search\/?$/.test(u.pathname));
  if (!isSearch) return null;
  const params = new URLSearchParams(u.search);
  if (method === 'POST' && body) for (const [k, v] of new URLSearchParams(body)) params.append(k, v);
  const ids = params.getAll('_id').flatMap(v => v.split(','));
  const hits = ids.map(id => fixtures.get(id)).filter((f): f is NumberFixture => f !== undefined);
  return hits.length ? { kind: 'search', hits } : null;
}

export interface MockHandle { port: number; served: () => number; close(): Promise<void> }

export async function startMockBackend(opts: { slot: number; patientId: string; fixtures: NumberFixture[]; upstreamPort?: number }): Promise<MockHandle> {
  const port = mockPort(opts.slot);
  const upstreamPort = opts.upstreamPort ?? HAPI_PORT;
  const fixtures = new Map(opts.fixtures.map(f => [f.id, f]));
  let served = 0;
  const answer = (req: IncomingMessage, res: ServerResponse, m: { kind: 'read' | 'search'; hits: NumberFixture[] }) => {
    served++;
    const origin = `http://${req.headers.host ?? `127.0.0.1:${port}`}`;
    const text = m.kind === 'read' ? numberObservation(m.hits[0]!, opts.patientId) : numberBundle(m.hits, opts.patientId, origin, `${origin}${req.url ?? ''}`);
    res.writeHead(200, { 'content-type': 'application/fhir+json;charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(req.method === 'HEAD' ? undefined : text);
  };
  const forward = (req: IncomingMessage, res: ServerResponse, body: Buffer | null) => {
    const up = request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers: req.headers }, r => {
      res.writeHead(r.statusCode ?? 502, r.statusMessage, r.rawHeaders as unknown as Record<string, string>);
      r.pipe(res);
    });
    up.on('error', err => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`mock upstream error: ${err.message}`);
    });
    if (body) up.end(body);
    else req.pipe(up);
  };
  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    if (method === 'POST' && /\/Observation\/_search\/?(\?|$)/.test(req.url ?? '')) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const m = matchNumbers(method, req.url ?? '/', body.toString('utf8'), fixtures);
        if (m) answer(req, res, m);
        else forward(req, res, body);
      });
      return;
    }
    const m = matchNumbers(method, req.url ?? '/', null, fixtures);
    if (m) { req.resume(); answer(req, res, m); return; }
    forward(req, res, null);
  });
  await listen(server, port);
  return { port, served: () => served, close: () => closeServer(server) };
}

export interface CanaryHit { schema: 'fbbench.canary-hit/1'; slot: number; at: string; at_ms: number; case_id: string | null; preview: string }
export interface CanaryHandle { port: number; hits: CanaryHit[]; close(): Promise<void> }

/** Raw TCP canary on the slot's canary port; every connection is a hit, appended to logPath. */
export async function startCanary(opts: { slot: number; logPath: string }): Promise<CanaryHandle> {
  const port = slotPorts(opts.slot).canary;
  const hits: CanaryHit[] = [];
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const sockets = new Set<Socket>();
  const server: TcpServer = createTcpServer(sock => {
    sockets.add(sock);
    const at = new Date();
    let recorded = false;
    const record = (data: Buffer) => {
      if (recorded) return;
      recorded = true;
      const text = data.subarray(0, 512).toString('latin1');
      const m = /fbfuzz(?:-canary)?\/(F[0-9]{3})/.exec(text);
      const hit: CanaryHit = { schema: 'fbbench.canary-hit/1', slot: opts.slot, at: at.toISOString(), at_ms: at.getTime(), case_id: m ? m[1]! : null, preview: text.replace(/[^\x20-\x7e]/g, '.').slice(0, 200) };
      hits.push(hit);
      appendFileSync(opts.logPath, JSON.stringify(hit) + '\n');
    };
    sock.setTimeout(5000, () => { record(Buffer.alloc(0)); sock.destroy(); });
    sock.on('data', (d: Buffer) => {
      record(d);
      sock.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
    });
    sock.on('end', () => record(Buffer.alloc(0)));
    sock.on('error', () => record(Buffer.alloc(0)));
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return {
    port, hits,
    close: () => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
}
