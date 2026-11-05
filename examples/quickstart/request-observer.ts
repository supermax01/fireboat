/** Trusted --import preload. No gateway imports, HTTP calls, body reads, or stdout/stderr output. */
import { channel } from 'node:diagnostics_channel';
import type { ClientRequest } from 'node:http';
import { Socket } from 'node:net';

type Route = { origin: string; pathname: string };
type Routes = { metadata: Route; auth?: Route };
type Work = { metadata: number; auth: number; clinical: number };
const rec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const route = (v: unknown): v is Route => rec(v) && typeof v.origin === 'string' && typeof v.pathname === 'string' &&
  v.origin.length <= 2048 && v.pathname.length <= 2048;

// fd 3 is a private, duplex child pipe. It is not a listening socket or a gateway public interface.
const pipe = new Socket({ fd: 3, readable: true, writable: true });
const work: Work = { metadata: 0, auth: 0, clinical: 0 };
let routes: Routes | undefined, sequence = 0, buffer = '';
let ready!: () => void;
const configured = new Promise<void>(resolve => { ready = resolve; });
const stop = () => { pipe.destroy(); process.exitCode = 2; };
pipe.on('error', stop);
pipe.on('end', () => pipe.destroy());
pipe.setEncoding('utf8');
pipe.on('data', (chunk: string) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 8192) { stop(); return; }
  let end: number;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try {
      const command: unknown = JSON.parse(line);
      if (!rec(command)) { stop(); return; }
      if (!routes && command.kind === 'setup' && route(command.metadata) && (command.auth === undefined || route(command.auth))) {
        routes = { metadata: command.metadata, ...(command.auth ? { auth: command.auth as Route } : {}) };
        pipe.write('{"kind":"ready","version":1}\n'); ready();
      } else if (routes && command.kind === 'barrier' && Number.isSafeInteger(command.sequence) && command.sequence === sequence + 1) {
        sequence++;
        // Diagnostics callbacks and this snapshot run synchronously in the same child event loop. A parent sends the
        // end barrier only AFTER receiving the call's stdout response. Every request started to produce that response
        // has incremented work before this snapshot. FIFO delivery on fd 3 makes lag immaterial; no pipe-idle heuristic.
        pipe.write(JSON.stringify({ kind: 'snapshot', sequence, ...work }) + '\n');
      } else { stop(); return; }
    } catch { stop(); return; }
  }
});

channel('http.client.request.start').subscribe((message: unknown) => {
  const request = (message as { request?: ClientRequest }).request;
  if (!request || !routes) { stop(); return; }
  // Read routing metadata only, never headers containing credentials or request/response bodies. An exact route
  // distinguishes /fhir/metadata from a clinical resource whose id is "metadata". Count attempts, including failures.
  const origin = `${request.protocol}//${request.getHeader('host')}`;
  const pathname = request.path.split('?')[0];
  const matches = (r: Route | undefined) => r?.origin === origin && r.pathname === pathname;
  const kind = request.method === 'POST' && matches(routes.auth) ? 'auth'
    : request.method === 'GET' && matches(routes.metadata) ? 'metadata' : 'clinical';
  work[kind]++;
  if (!Number.isSafeInteger(work[kind])) stop();
});
// The serving graph uses node:http/https. Refuse unsupported client stacks rather than certifying zero work.
for (const name of ['undici:request:create', 'http2.client.stream.start']) channel(name).subscribe(stop);
await configured;
