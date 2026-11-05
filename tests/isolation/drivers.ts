import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { FhirGateway, TOOL_NAMES, type GatewayEnvelope, type ToolName } from '../../packages/core/src/index.js';
import { A, B, MRN, FIXED_TIME } from './canaries.js';
import { structural } from './scanners.js';
export interface Call { envelope: GatewayEnvelope; wire: Record<string, unknown>; bytes: number }
export interface Driver {
  kind: 'core' | 'sdk-modern' | 'sdk-legacy'; calls: Call[]; raw: string[]; stderr: string[]; operational: string[]; serverMethods: string[];
  call(name: string, args: Record<string, unknown>): Promise<Call>;
  state(): unknown; audit(): unknown[]; close(): Promise<void>; era: string;
  handlerProbe(): Promise<boolean>;
}
export class DriverAborted extends Error { constructor() { super('driver cancelled'); this.name = 'DriverAborted'; } }
/** Async ownership survives an abandoned hook: it can never adopt the next cell's registry. */
export interface DriverScope { drivers: Driver[]; aborted: boolean; cliScript?: string; onChild?(child: ChildProcess): void }
export const driverScope = new AsyncLocalStorage<DriverScope>();
export const cellDrivers: { current: Driver[] | undefined } = { current: undefined };
const consoleKeys = ['log', 'warn', 'error', 'info', 'debug'] as const;
const streams = () => ({ stdout: process.stdout.write, stderr: process.stderr.write, console: Object.fromEntries(consoleKeys.map(k => [k, console[k]])) as Pick<Console, typeof consoleKeys[number]> });
type Streams = ReturnType<typeof streams>;
const install = (s: Streams) => { process.stdout.write = s.stdout; process.stderr.write = s.stderr; Object.assign(console, s.console); };
const frames: Streams[] = [];
let original: Streams | undefined;
/** A removed non-top frame never restores over a newer owner. The last removal restores the original function objects. */
export function captureStreams(operational: string[]): () => void {
  if (!frames.length) original = streams();
  const write = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    operational.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    const done = typeof encoding === 'function' ? encoding : typeof callback === 'function' ? callback : undefined;
    if (done) queueMicrotask(() => (done as () => void)());
    return true;
  };
  const frame: Streams = { stdout: write as typeof process.stdout.write, stderr: write as typeof process.stderr.write,
    console: Object.fromEntries(consoleKeys.map(k => [k, (...args: unknown[]) => { operational.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); }])) as Streams['console'] };
  frames.push(frame); install(frame);
  return () => {
    const at = frames.indexOf(frame); if (at < 0) return;
    const top = at === frames.length - 1; frames.splice(at, 1);
    if (top) install(frames.at(-1) ?? original!);
    if (!frames.length) original = undefined;
  };
}
export const captureDepth = () => frames.length;
let clockOwners = 0, originalDate: DateConstructor | undefined;
/** A fixed fixture clock makes retained blob identity deterministic even for concurrent calls. Clock ownership,
 * like capture ownership, belongs to the driver lifetime; closing an older driver cannot reset a newer one. */
function captureClock(): () => void {
  if (!clockOwners++) {
    originalDate = Date; const NativeDate = Date, instant = NativeDate.parse(FIXED_TIME);
    globalThis.Date = class extends NativeDate { constructor(...args: any[]) { super(...(args.length ? args : [instant]) as [any]); } static now() { return instant; } } as DateConstructor;
  }
  let restored = false;
  return () => { if (restored) return; restored = true; if (!--clockOwners) { globalThis.Date = originalDate!; originalDate = undefined; } };
}

export async function createDriver(kind: Driver['kind'], baseUrl: string, foreign = false, authenticated = false, fixedDiscoveryClock = true): Promise<Driver> {
  const scope = driverScope.getStore();
  const registry = scope?.drivers ?? cellDrivers.current;
  let closed = false; let closing: Promise<void> | undefined;
  const abortable = () => { if (closed || scope?.aborted) throw new DriverAborted(); };
  abortable();
  const NativeDate = Date, instant = NativeDate.parse(FIXED_TIME);
  const fixedClockCode = `const N=Date;globalThis.Date=class extends N{constructor(...a){super(...(a.length?a:[${instant}]))}static now(){return ${instant}}}`;
  const calls: Call[] = [], raw: string[] = [], stderr: string[] = [], operational: string[] = [], serverMethods: string[] = [];
  const config = { mode: 'synthetic' as const, source: { alias: 'b2-fixture', baseUrl, ...(authenticated ? { auth: { type: 'client_credentials' as const, tokenUrl: `${new URL(baseUrl).origin}/token`, clientId: 'b2-offline', clientSecretEnv: 'B2_SYNTHETIC_SECRET' } } : {}) }, patientId: foreign ? B : A, contextId: foreign ? 'b2-context-b' : 'b2-context-a', privacy: { patientIdentifierSystems: [MRN] }, limits: { maxBytes: 60000, upstreamBytes: 150000, maxHandles: 200 } };
  const era = kind === 'core' ? 'core/public-serializer' : kind === 'sdk-modern' ? '2026-07-28' : '2025-11-25';
  const handlerCallbacks: (() => Promise<unknown>)[] = [];
  const children: { process: ChildProcess; closed: Promise<void> }[] = [];
  let connecting: Promise<void> | undefined;
  let gateway: FhirGateway | undefined, client: Client | undefined, transport: StdioClientTransport | undefined, directory: string | undefined;
  let restore = () => {}, restoreClock = () => {};
  let previousSecret: string | undefined; let ownsSecret = false;
  const driver: Driver = {
    kind, calls, raw, stderr, operational, serverMethods, era,
    async call(name, args) {
      abortable();
      const callIndex = calls.length; calls.push(undefined as unknown as Call);
      let envelope: GatewayEnvelope; let wire: Record<string, unknown>;
      if (gateway) {
        try { envelope = await gateway!.execute(name as ToolName, args); wire = gateway.toToolResult(envelope) as unknown as Record<string, unknown>; }
        catch (error) {
          const fault = error as { code?: string }; if (fault.code !== 'UNKNOWN_TOOL') throw error;
          wire = { library_error: { code: fault.code } }; envelope = { error: { code: fault.code }, data: {} } as GatewayEnvelope;
        }
      } else {
        try { wire = await client!.callTool({ name, arguments: args }) as unknown as Record<string, unknown>; envelope = wire.structuredContent as GatewayEnvelope; }
        catch (error) {
          const e = error as { code?: number; message?: string };
          wire = { sdk_error: { code: e.code, message: e.message } };
          envelope = { error: { code: 'SDK_TOOL_ERROR', safe_message: 'SDK tool error' }, data: {} } as GatewayEnvelope;
        }
      }
      abortable();
      if (!envelope) throw new Error('missing structured envelope');
      const result = { envelope, wire, bytes: Buffer.byteLength(JSON.stringify(wire)) }; calls[callIndex] = result; return result;
    },
    state: () => gateway ? structural(gateway) : undefined,
    audit: () => gateway?.auditEvents ?? [],
    handlerProbe: async () => kind === 'core' || (await Promise.all(handlerCallbacks.map(h => h()))).length === 3,
    close: () => {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        try {
          gateway?.close();
          // connect() may still be awaiting initialize. Reap the child ourselves, including half-open transports.
          // The SDK may clear its private process field before teardown finishes. Keep ownership independently,
          // and await close (including drained capture pipes) for each child this driver actually started.
          for (const owned of children.toReversed()) {
            if (owned.process.exitCode === null && owned.process.signalCode === null) owned.process.kill('SIGKILL');
            await owned.closed;
          }
          await transport?.close(); await connecting?.catch(() => undefined); await client?.close();
        } finally {
          restoreClock(); restore();
          if (ownsSecret) { if (previousSecret === undefined) delete process.env.B2_SYNTHETIC_SECRET; else process.env.B2_SYNTHETIC_SECRET = previousSecret; ownsSecret = false; }
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      })();
      return closing;
    },
  };
  // Register teardown before installing capture, touching ambient state, or starting a child (N2).
  registry?.push(driver);
  try {
    abortable();
    // Let already queued test-runner/status writes finish before acquiring the application streams.
    await new Promise<void>(resolve => setImmediate(resolve)); abortable();
    restore = captureStreams(operational);
    if (authenticated) { previousSecret = process.env.B2_SYNTHETIC_SECRET; ownsSecret = true; process.env.B2_SYNTHETIC_SECRET = 'offline-synthetic-client-secret'; }
    if (kind === 'core') { if (fixedDiscoveryClock) restoreClock = captureClock(); gateway = new FhirGateway(config); abortable(); }
    else {
      directory = await mkdtemp(join(tmpdir(), 'b2-cli-')); abortable();
      const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify(config), { mode: 0o600 }); abortable();
      client = new Client({ name: 'b2-synthetic-diagnostic', version: '1' }, { capabilities: { sampling: {}, elicitation: {}, roots: {} }, ...(kind === 'sdk-modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}) } as never);
      // Test-only startup seam; manifests cannot choose a CLI or an arbitrary command.
      // The installed SDK probes subclasses in place: capture the negotiation child as well as the session.
      class CapturedStdioTransport extends StdioClientTransport {}
      transport = new CapturedStdioTransport({ command: process.execPath, args: [...(fixedDiscoveryClock ? ['--import', `data:text/javascript,${encodeURIComponent(fixedClockCode)}`] : []), scope?.cliScript ?? resolve('dist/packages/server/src/cli.js'), '--config', path], cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', HTTP_PROXY: 'http://127.0.0.1:1', ...(authenticated ? { B2_SYNTHETIC_SECRET: 'offline-synthetic-client-secret' } : {}) }, stderr: 'pipe' });
      transport.stderr!.on('data', chunk => stderr.push(String(chunk)));
      const start = transport.start.bind(transport);
      transport.start = async () => {
        abortable();
        const starting = start();
        const child = (transport as unknown as { _process: ChildProcess })._process;
        if (child) children.push({ process: child, closed: new Promise<void>(resolve => child.once('close', () => resolve())) });
        if (!child?.stdout) throw new Error('raw stdout capture missing');
        child.stdout.on('data', chunk => raw.push(String(chunk))); scope?.onChild?.(child);
        await starting; abortable();
      };
      const handlers: Record<string, (request: unknown) => Promise<unknown>> = {
        'sampling/createMessage': async () => ({ model: 'offline-stub', role: 'assistant', content: { type: 'text', text: 'offline' } }),
        'elicitation/create': async () => ({ action: 'decline' }), 'roots/list': async () => ({ roots: [] }),
      };
      for (const [method, handler] of Object.entries(handlers)) { client.setRequestHandler(method as never, handler as never); handlerCallbacks.push(() => handler({})); }
      connecting = client.connect(transport); await connecting; abortable();
      if (client.getNegotiatedProtocolVersion() !== era) throw new Error('negotiated era mismatch');
      const onmessage = transport.onmessage;
      transport.onmessage = message => { const m = message as { method?: string }; if (m.method) serverMethods.push(m.method); onmessage?.(message); };
      const listed = await client.listTools(); abortable();
      if (listed.tools.map(t => t.name).join() !== TOOL_NAMES.join()) throw new Error('tool list mismatch');
    }
    abortable(); return driver;
  } catch (error) {
    await driver.close();
    // A directory allocation completing after close still belongs to this failed open.
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
