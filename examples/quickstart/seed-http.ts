import { Agent, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { assertPrepare, exactLoopbackTarget } from './guards.js';
import type { FreshState, SeedTarget } from './guards.js';
import type { InstanceEvidence, InstanceReceipt } from './instance.js';
import { fault, freezeCopy, hasKeys, isRecord, QuickstartFault, seedTypes, sha256, validateSeedManifest } from './manifest.js';
import type { SeedManifest } from './manifest.js';

export type SeedPut = Readonly<{ method: 'PUT'; target: string; body: Uint8Array }>;
/** `readinessRequests`: metadata polls while the instance starts, budgeted on top of two count passes, the PUTs and the read-backs. */
export const HTTP_LIMITS = Object.freeze({ responseBytes: 2_097_152, deadlineMs: 3000, readinessRequests: 240 });
export function proxyRoutingActive(environment: Readonly<Record<string, string | undefined>>, execArgv: readonly string[] = process.execArgv): boolean {
  const enabled = (args: readonly string[]): boolean => args.reduce((on, arg) => arg === '--use-env-proxy' ? true :
    arg === '--no-use-env-proxy' ? false : arg.startsWith('--use-env-proxy=') ? !['false', '0'].includes(arg.slice(16).toLowerCase()) : on, false);
  return enabled(execArgv) || enabled((environment.NODE_OPTIONS ?? '').split(/\s+/).map(a => a.replace(/^["']|["']$/g, ''))) ||
    Object.entries(environment).some(([key, value]) => value !== undefined && value.trim() !== '' &&
    (/^(https?_proxy|all_proxy|global_agent_https?_proxy|npm_config_(https?_)?proxy)$/i.test(key) ||
      (key === 'NODE_USE_ENV_PROXY' && !['0', 'false'].includes(value.trim().toLowerCase()))));
}
/**
 * Whether anything already accepts TCP at the literal seed target, 127.0.0.1:18080, before provisioning. Only a refused
 * connection counts as free; an accepted connection, the deadline or any other error counts as occupied. The port
 * argument is a trusted test seam; the helper always probes the manifest's fixed port.
 */
export function seedPortOccupied(port = 18080, deadlineMs = 1000): Promise<boolean> {
  return new Promise(accept => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (occupied: boolean): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy(); accept(occupied);
    };
    const timer = setTimeout(() => finish(true), deadlineMs);
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code !== 'ECONNREFUSED'));
  });
}
export function listedPut(request: unknown, manifest: SeedManifest): request is SeedPut {
  if (!isRecord(request) || !hasKeys(request, ['method', 'target', 'body']) || request.method !== 'PUT' ||
    typeof request.target !== 'string' || !(request.body instanceof Uint8Array)) return false;
  const row = manifest.resources.find(r => `${r.type}/${r.id}` === request.target);
  return row !== undefined && request.body.byteLength === row.bytes && sha256(request.body) === row.sha256;
}
export const isRedirect = (status: number): boolean => status >= 300 && status < 400;
type Options = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  responseBytes?: number; deadlineMs?: number; requestBudget?: number;
  // Trusted test injection; endpoint/method/header construction stays here.
  request?: typeof httpRequest;
}>;
export type PrepareEvidence = Readonly<{
  receipt: InstanceReceipt; evidence: InstanceEvidence; state: FreshState;
  inspect: () => Promise<InstanceEvidence>;
}>;

export function createSeedHttpClient(input: SeedManifest, inputTarget: SeedTarget, options: Options = {}) {
  const manifest = validateSeedManifest(input);
  if (!exactLoopbackTarget(inputTarget, manifest)) throw fault('TARGET_MISMATCH');
  const target = freezeCopy(inputTarget);
  const environment = options.environment ?? process.env;
  if (proxyRoutingActive(environment)) throw fault('PROXY_REFUSED');
  const types = seedTypes(manifest);
  const bounded = (value: number | undefined, max: number): number => {
    if (value === undefined) return max;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw fault('HTTP_LIMIT');
    return value;
  };
  const responseBytes = bounded(options.responseBytes, HTTP_LIMITS.responseBytes);
  const deadlineMs = bounded(options.deadlineMs, HTTP_LIMITS.deadlineMs);
  const requestBudget = bounded(options.requestBudget, manifest.resources.length * 2 + types.length * 2 + HTTP_LIMITS.readinessRequests);
  // An explicit Node agent never consults fetch/global-agent proxy settings.
  const agent = new Agent({ keepAlive: false });
  let requests = 0, attempted = false, closed = false;
  const send = (method: 'GET' | 'PUT', suffix: string, body?: Buffer): Promise<Buffer> => {
    if (closed || ++requests > requestBudget) throw fault('HTTP_LIMIT');
    return new Promise((accept, reject) => {
      let finished = false;
      const finish = (error?: QuickstartFault, result?: Buffer): void => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (error) reject(error); else accept(result!);
      };
      // No URL, host, header, method or redirect destination comes from callers.
      // HAPI reuses a cached result for an identical search (60 s by default), so without
      // no-cache the pre-seed zero counts would answer the oracle's post-seed counts.
      const req = (options.request ?? httpRequest)({ protocol: 'http:', hostname: '127.0.0.1', port: 18080,
        path: `${target.basePath}/${suffix}`, method, agent,
        headers: { accept: 'application/fhir+json', 'accept-encoding': 'identity',
          ...(body ? { 'content-type': 'application/fhir+json', 'content-length': body.byteLength } : { 'cache-control': 'no-cache' }) }
      }, res => {
        const status = res.statusCode ?? 0;
        const refuse = (error: QuickstartFault): void => { finish(error); res.destroy(); req.destroy(); };
        if (isRedirect(status)) { refuse(fault('REDIRECT_REFUSED')); return; }
        if (status < 200 || status >= 400) { refuse(fault('HTTP_STATUS')); return; }
        if ((res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') ||
          (res.headers['content-length'] !== undefined && (!/^\d+$/.test(res.headers['content-length']) ||
            Number(res.headers['content-length']) > responseBytes))) { refuse(fault('HTTP_LIMIT')); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > responseBytes) refuse(fault('HTTP_LIMIT')); else chunks.push(Buffer.from(chunk));
        });
        res.once('aborted', () => finish(fault('HTTP_FAILED')));
        res.once('error', () => finish(fault('HTTP_FAILED')));
        res.once('end', () => finish(undefined, Buffer.concat(chunks)));
      });
      const timer = setTimeout(() => { finish(fault('HTTP_TIMEOUT')); req.destroy(); }, deadlineMs);
      req.once('error', () => finish(fault('HTTP_FAILED')));
      req.end(body);
    });
  };
  const json = (raw: Buffer): Record<string, unknown> => {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      const value: unknown = JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
        // A count must be an integer token, never a decimal rounded/underflowed
        // to zero by JSON.parse. Source context is available in admitted Node 24.
        if (key === 'total' && (typeof value !== 'number' || !/^(0|[1-9]\d*)$/.test(context?.source ?? '')))
          throw fault('HTTP_RESPONSE_INVALID');
        return value;
      });
      if (isRecord(value)) return value;
    }
    catch { /* fixed fault below */ }
    throw fault('HTTP_RESPONSE_INVALID');
  };
  const requireListedRead = (route: string): void => {
    if (!manifest.resources.some(r => `${r.type}/${r.id}` === route)) throw fault('SEED_NOT_LISTED');
  };
  return Object.freeze({
    async metadata(): Promise<Buffer> { return send('GET', 'metadata'); },
    async count(type: string): Promise<number> {
      if (!types.includes(type)) throw fault('SEED_NOT_LISTED');
      const value = json(await send('GET', `${type}?_summary=count`));
      if (value.resourceType !== 'Bundle' || value.type !== 'searchset' || !Number.isSafeInteger(value.total) ||
        (value.total as number) < 0 || (value.entry !== undefined && (!Array.isArray(value.entry) || value.entry.length !== 0)) ||
        (value.link !== undefined && (!Array.isArray(value.link) || value.link.some(link => !isRecord(link) || link.relation !== 'self'))))
        throw fault('HTTP_RESPONSE_INVALID');
      return value.total as number;
    },
    async read(route: string): Promise<Buffer> { requireListedRead(route); return send('GET', route); },
    async seed(prepared: PrepareEvidence, inputRequests: readonly SeedPut[]): Promise<void> {
      if (attempted) throw fault('SEED_ALREADY_ATTEMPTED');
      let receipt: InstanceReceipt, evidence: InstanceEvidence, state: FreshState;
      try { receipt = freezeCopy(prepared.receipt); evidence = freezeCopy(prepared.evidence); state = freezeCopy(prepared.state); }
      catch { throw fault('INSTANCE_FOREIGN'); }
      assertPrepare(target, manifest, receipt, evidence, state);
      if (!Array.isArray(inputRequests) || inputRequests.length !== manifest.resources.length) throw fault('SEED_NOT_LISTED');
      const seen = new Set<string>(), batch: SeedPut[] = [];
      for (const request of inputRequests) {
        if (!listedPut(request, manifest)) throw fault('SEED_NOT_LISTED');
        if (seen.has(request.target)) throw fault('SEED_NOT_LISTED');
        seen.add(request.target);
        batch.push({ method: 'PUT', target: request.target, body: Buffer.from(request.body) });
      }
      // Claim the attempt before awaiting inspection: concurrent/retry calls can
      // never perform another write. Persistent receipts are outer-helper work.
      attempted = true;
      let inspected: InstanceEvidence;
      try { inspected = await prepared.inspect(); }
      catch { throw fault('INSTANCE_FOREIGN'); }
      assertPrepare(target, manifest, receipt, inspected, state);
      for (const request of batch) await send('PUT', request.target, Buffer.from(request.body));
    },
    close(): void { closed = true; agent.destroy(); }
  });
}
