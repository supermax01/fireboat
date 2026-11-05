import { spawn } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { open } from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import type { GatewayEnvelope } from '../../packages/core/src/index.js';
import { rawMember } from '../../packages/evals/src/evidence-oracle.js';

export interface RecordedCall {
  requestId: string | number;
  /** Complete response frame and all sent/received JSON-RPC frames since the previous call (initialization included). */
  rawFrame: string;
  frames: readonly { direction: 'sent' | 'received'; text: string }[];
  /** The received JSON-RPC result member, without decoding/re-serialising its number lexemes. */
  rawText?: string;
  /** Decoded from the very same frame as rawText; never borrowed from another response or SDK cache. */
  envelope?: GatewayEnvelope;
  outcome?: { class: 'json_rpc_error' | 'sdk_text_error' | 'application_error'; code: number | string };
  /** Started child HTTP requests between the call's barriers, including failed token/metadata/clinical attempts. */
  work: { metadata: number; auth: number; clinical: number };
  resultBytes: number;
  /** Complete UTF-8 JSON-RPC line, including its newline. JSON-RPC errors have resultBytes=0. */
  frameBytes: number;
}
export interface GatewaySessionOptions {
  /** Absolute Node, optional Node arguments, absolute CLI, --config, absolute config. No shell is involved. */
  argv: readonly string[];
  era: 'modern' | 'legacy';
  /** False only for the verifier's clean-launch discovery control: no observer preload or descriptor. */
  observe?: boolean;
  /** Only PATH and the config's clientSecretEnv are selected. Defaults to the current environment. */
  environment?: Readonly<Record<string, string | undefined>>;
  callTimeoutMs?: number;
  maxFrameBytes?: number;
  maxCalls?: number;
}
export interface GatewaySession {
  readonly negotiatedVersion: string;
  /** Exactly one call may be in flight; concurrent callers receive CLIENT_CALL_BUSY. */
  call(tool: string, input: Record<string, unknown>): Promise<RecordedCall>;
  close(): Promise<void>;
}
type Rec = Record<string, unknown>;
type Work = RecordedCall['work'];
const rec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const fault = (code: ClientFaultCode) => new GatewayClientFault(code);
export type ClientFaultCode = 'CLIENT_OPTIONS_INVALID' | 'CLIENT_CONFIG_INVALID' | 'CLIENT_START_FAILED' | 'CLIENT_CLOSED'
  | 'CLIENT_DEADLINE' | 'CLIENT_FRAME_LIMIT' | 'CLIENT_FRAME_INVALID' | 'CLIENT_RESPONSE_ID' | 'CLIENT_RESPONSE_MISSING'
  | 'CLIENT_CALL_LIMIT' | 'CLIENT_CALL_BUSY' | 'CLIENT_ERA_MISMATCH' | 'CLIENT_RESULT_INVALID' | 'CLIENT_SDK_FAILED'
  | 'CLIENT_OBSERVER_INVALID' | 'CLIENT_UNSCOPED_WORK' | 'CLIENT_HTTP_FORBIDDEN';
/** Safe for ordinary error lines: never incorporates child stderr, input, SDK errors, paths or payloads. */
export class GatewayClientFault extends Error {
  readonly code: ClientFaultCode;
  constructor(code: ClientFaultCode) { super(code); this.code = code; this.name = 'GatewayClientFault'; }
}
const boundedInteger = (v: number, lo: number, hi: number) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const zero = (): Work => ({ metadata: 0, auth: 0, clinical: 0 });
const keys = ['metadata', 'auth', 'clinical'] as const;

/** SDK over bounded child stdio. No HTTP authority, eval runner, or gateway serving module in this process. */
export async function openGatewaySession(options: GatewaySessionOptions): Promise<GatewaySession> {
  const timeout = options.callTimeoutMs ?? 15000, maxFrame = options.maxFrameBytes ?? 2 * 1024 * 1024, maxCalls = options.maxCalls ?? 128;
  const argv = options.argv;
  if (!Array.isArray(argv) || argv.length < 4 || argv.length > 16 || argv.some(v => typeof v !== 'string' || v.length > 8192 || v.includes('\0')) ||
      !isAbsolute(argv[0]!) || argv.at(-2) !== '--config' || !isAbsolute(argv.at(-1)!) || !isAbsolute(argv.at(-3)!) ||
      !['modern', 'legacy'].includes(options.era) || !boundedInteger(timeout, 10, 60000) || !boundedInteger(maxFrame, 128, 8 * 1024 * 1024) || !boundedInteger(maxCalls, 1, 256))
    throw fault('CLIENT_OPTIONS_INVALID');
  // Node arguments are deliberately limited to source-loader imports. In particular, no --eval, environment files,
  // shell commands, inspector, or alternate observer descriptor can be smuggled into the launch tuple.
  for (let i = 1; i < argv.length - 3; i += 2) if (argv[i] !== '--import' || !argv[i + 1] ||
      (argv[i + 1] !== 'tsx' && !isAbsolute(argv[i + 1]!)) || i + 1 >= argv.length - 3)
    throw fault('CLIENT_OPTIONS_INVALID');
  const environment = options.environment ?? process.env;
  const env: Record<string, string> = { PATH: environment.PATH ?? '' };
  let setup: Rec;
  try {
    const file = await open(argv.at(-1)!, 'r');
    const bytes = Buffer.alloc(65537); let length = 0;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536) throw fault('CLIENT_CONFIG_INVALID');
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (bytesRead === 0) break; length += bytesRead;
      }
    } finally { await file.close(); }
    if (length > 65536) throw fault('CLIENT_CONFIG_INVALID');
    const config: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (!rec(config) || !rec(config.source) || typeof config.source.baseUrl !== 'string') throw fault('CLIENT_CONFIG_INVALID');
    const base = new URL(config.source.baseUrl.replace(/\/$/, '') + '/');
    const metadata = new URL('metadata', base);
    const route = (url: URL) => ({ origin: url.origin, pathname: url.pathname });
    setup = { kind: 'setup', metadata: route(metadata) };
    if (config.source.auth !== undefined) {
      const auth = config.source.auth;
      if (!rec(auth) || auth.type !== 'client_credentials' || typeof auth.tokenUrl !== 'string' || typeof auth.clientSecretEnv !== 'string' ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(auth.clientSecretEnv) || /^(?:NODE_|DYLD_|LD_|OPENSSL_|SSL_|UV_|.*proxy$|PATH$)/i.test(auth.clientSecretEnv)) throw fault('CLIENT_CONFIG_INVALID');
      setup.auth = route(new URL(auth.tokenUrl));
      if (environment[auth.clientSecretEnv] !== undefined) env[auth.clientSecretEnv] = environment[auth.clientSecretEnv]!;
    }
  } catch { throw fault('CLIENT_CONFIG_INVALID'); }

  const observer = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './request-observer.ts' : './request-observer.js', import.meta.url));
  const observed = options.observe !== false;
  const child = (() => {
    try { return spawn(argv[0]!, [...(observed ? ['--import', observer] : []), ...argv.slice(1)], { stdio: observed ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'], env }); }
    catch { throw fault('CLIENT_START_FAILED'); }
  })();
  const counters = observed ? child.stdio[3] as Duplex : undefined;
  let closed = false, failure: GatewayClientFault | undefined, closing: Promise<void> | undefined;
  let rejectFailure!: (e: GatewayClientFault) => void;
  const failed = new Promise<never>((_, reject) => { rejectFailure = reject; });
  void failed.catch(() => undefined);
  const exited = new Promise<void>(resolve => { child.once('close', () => resolve()); });
  let client: Client;
  let transport: Transport;
  let transportClosed = false;
  const endTransport = () => { if (!transportClosed) { transportClosed = true; transport?.onclose?.(); } };
  const fail = (code: ClientFaultCode) => {
    if (closed || failure) return;
    failure = fault(code); rejectFailure(failure);
    transport?.onerror?.(failure); endTransport(); child.kill(); void close();
  };
  const channels = ['http.client.request.start', 'undici:request:create', 'http2.client.stream.start'].map(channel);
  let clientHttp = 0;
  const observeClient = () => { clientHttp++; };
  for (const diagnostic of channels) diagnostic.subscribe(observeClient);
  const assertClientBoundary = () => {
    if (clientHttp !== 0) throw fault('CLIENT_HTTP_FORBIDDEN');
  };
  const close = () => closing ??= (async () => {
    closed = true;
    for (const diagnostic of channels) diagnostic.unsubscribe(observeClient);
    await client?.close().catch(() => undefined);
    child.stdin.end(); counters?.destroy(); child.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 500); })]); clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); clearTimeout(timer);
    }
    child.stdout.destroy(); child.stderr.destroy();
    // The caller owns the config. No temporary files or raw trace files are created by this driver.
  })();
  const deadline = async <T>(run: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([run(), failed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { fail('CLIENT_DEADLINE'); reject(fault('CLIENT_DEADLINE')); }, timeout);
      })]);
    } finally { clearTimeout(timer); }
  };

  let sequence = 0, observerBuffer = '', observerReady = false;
  let onReady!: () => void;
  const ready = new Promise<void>(resolve => { onReady = resolve; });
  let snapshot: { sequence: number; resolve: (work: Work) => void } | undefined;
  counters?.setEncoding('utf8');
  counters?.on('data', (chunk: string) => {
    observerBuffer += chunk;
    if (Buffer.byteLength(observerBuffer) > 8192) { fail('CLIENT_OBSERVER_INVALID'); return; }
    let end: number;
    while ((end = observerBuffer.indexOf('\n')) >= 0) {
      const line = observerBuffer.slice(0, end); observerBuffer = observerBuffer.slice(end + 1);
      try {
        const value: unknown = JSON.parse(line);
        if (!rec(value)) throw 0;
        if (!observerReady && value.kind === 'ready' && value.version === 1 && Object.keys(value).length === 2) {
          observerReady = true; onReady();
        } else if (observerReady && value.kind === 'snapshot' && snapshot && value.sequence === snapshot.sequence && Object.keys(value).length === 5 &&
                   keys.every(key => typeof value[key] === 'number' && boundedInteger(value[key] as number, 0, Number.MAX_SAFE_INTEGER))) {
          const pending = snapshot; snapshot = undefined; pending.resolve({ metadata: value.metadata as number, auth: value.auth as number, clinical: value.clinical as number });
        } else throw 0;
      } catch { fail('CLIENT_OBSERVER_INVALID'); return; }
    }
  });
  counters?.on('error', () => fail('CLIENT_OBSERVER_INVALID'));
  counters?.on('close', () => fail('CLIENT_OBSERVER_INVALID'));
  const write = (stream: NodeJS.WritableStream, line: string): Promise<void> => new Promise((resolve, reject) => {
    stream.write(line, error => error ? reject(fault('CLIENT_CLOSED')) : resolve());
  });
  const barrier = () => !counters ? Promise.resolve(zero()) : new Promise<Work>((resolve, reject) => {
    snapshot = { sequence: ++sequence, resolve };
    void write(counters, JSON.stringify({ kind: 'barrier', sequence }) + '\n').catch(reject);
  });

  type Response = { message: Rec; rawFrame: string; rawText?: string; resultBytes: number; frameBytes: number };
  let frames: { direction: 'sent' | 'received'; text: string }[] = [];
  const pending = new Map<string | number, string>(), seen = new Set<string | number>();
  let active: { id?: string | number; response?: Response } | undefined, frameCount = 0, requestCount = 0;
  transport = {
    async start() {},
    async send(message) {
      if (failure) throw failure;
      if (closed) throw fault('CLIENT_CLOSED');
      const m = message as Rec;
      let line: string;
      try { line = JSON.stringify(message) + '\n'; } catch { fail('CLIENT_OPTIONS_INVALID'); throw failure; }
      if (Buffer.byteLength(line) > maxFrame) { fail('CLIENT_FRAME_LIMIT'); throw failure; }
      if (typeof m.method === 'string' && (typeof m.id === 'string' || typeof m.id === 'number')) {
        if (++requestCount > maxCalls * 4 + 16 || pending.has(m.id) || seen.has(m.id)) throw fault('CLIENT_CALL_LIMIT');
        pending.set(m.id, m.method);
        if (m.method === 'tools/call') {
          if (!active || active.id !== undefined) throw fault('CLIENT_RESPONSE_ID');
          active.id = m.id;
        }
      }
      frames.push({ direction: 'sent', text: line });
      await write(child.stdin, line);
    },
    async close() { child.stdin.end(); endTransport(); },
  };
  let buffer = Buffer.alloc(0);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  child.stdout.on('data', (chunk: Buffer) => {
    if (failure || closed) return;
    buffer = Buffer.concat([buffer, chunk]);
    let end: number;
    while ((end = buffer.indexOf(10)) >= 0) {
      const bytes = buffer.subarray(0, end + 1); buffer = buffer.subarray(end + 1);
      if (bytes.length > maxFrame || ++frameCount > maxCalls * 8 + 64) { fail('CLIENT_FRAME_LIMIT'); return; }
      try {
        const line = decoder.decode(bytes), message: unknown = JSON.parse(line);
        if (!rec(message) || message.jsonrpc !== '2.0') throw 0;
        frames.push({ direction: 'received', text: line });
        if ('id' in message && ('result' in message || 'error' in message)) {
          const id = message.id;
          if ((typeof id !== 'string' && typeof id !== 'number') || !pending.has(id) || seen.has(id)) { fail('CLIENT_RESPONSE_ID'); return; }
          if (('result' in message) === ('error' in message) || ('error' in message && (!rec(message.error) || !Number.isSafeInteger(message.error.code)))) throw 0;
          const method = pending.get(id)!; pending.delete(id); seen.add(id);
          if (method === 'tools/call') {
            if (!active || active.id !== id) { fail('CLIENT_RESPONSE_ID'); return; }
            const rawText = rawMember(line, 'result');
            active.response = { message, rawFrame: line, ...(rawText !== undefined ? { rawText } : {}), resultBytes: rawText === undefined ? 0 : Buffer.byteLength(rawText), frameBytes: bytes.length };
          }
        } else if (typeof message.method !== 'string' || 'id' in message) throw 0;
        transport.onmessage?.(message as unknown as JSONRPCMessage);
      } catch { fail('CLIENT_FRAME_INVALID'); return; }
    }
    if (buffer.length >= maxFrame) fail('CLIENT_FRAME_LIMIT');
  });
  child.stdout.on('error', () => fail('CLIENT_CLOSED')); child.stdin.on('error', () => fail('CLIENT_CLOSED'));
  // Drain and discard child diagnostics. They cannot become an ordinary helper error or retained raw evidence.
  child.stderr.resume(); child.on('error', () => fail('CLIENT_START_FAILED')); child.on('exit', () => fail('CLIENT_CLOSED'));
  client = new Client({ name: 'fireboat-quickstart', version: '0.1.0' }, options.era === 'modern'
    ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  let previous = zero();
  try {
    await deadline(async () => {
      if (counters) { await write(counters, JSON.stringify(setup) + '\n'); await ready; }
      await client.connect(transport, { timeout });
      const expected = options.era === 'modern' ? '2026-07-28' : '2025-11-25';
      if (client.getProtocolEra() !== options.era || client.getNegotiatedProtocolVersion() !== expected) throw fault('CLIENT_ERA_MISMATCH');
      await client.listTools(undefined, { timeout });
      previous = await barrier();
      if (keys.some(key => previous[key] !== 0)) throw fault('CLIENT_UNSCOPED_WORK');
      assertClientBoundary();
    });
  } catch (error) { await close(); throw error instanceof GatewayClientFault ? error : fault('CLIENT_SDK_FAILED'); }
  let calls = 0, busy = false;
  return {
    negotiatedVersion: client.getNegotiatedProtocolVersion()!,
    async call(tool, input) {
      if (failure) throw failure;
      if (closed) throw fault('CLIENT_CLOSED');
      if (busy) throw fault('CLIENT_CALL_BUSY');
      if (calls >= maxCalls) throw fault('CLIENT_CALL_LIMIT');
      calls++; busy = true; active = {};
      try {
        return await deadline(async () => {
          assertClientBoundary();
          const before = await barrier();
          if (keys.some(key => before[key] !== previous[key])) throw fault('CLIENT_UNSCOPED_WORK');
          let sdkRejected = false;
          try { await client.callTool({ name: tool, arguments: input }, { timeout }); } catch { sdkRejected = true; }
          if (failure) throw failure;
          if (closed) throw fault('CLIENT_CLOSED');
          if (active?.id === undefined || !active.response) throw fault('CLIENT_RESPONSE_MISSING');
          const { id, response } = active;
          const after = await barrier();
          if (keys.some(key => after[key] < before[key])) throw fault('CLIENT_OBSERVER_INVALID');
          previous = after; assertClientBoundary();
          const work = { metadata: after.metadata - before.metadata, auth: after.auth - before.auth, clinical: after.clinical - before.clinical };
          const { message, rawFrame, rawText, resultBytes, frameBytes } = response;
          const capturedFrames = frames; frames = [];
          const captured = { rawFrame, frames: capturedFrames };
          if (rec(message.error)) return { requestId: id, ...captured, outcome: { class: 'json_rpc_error', code: message.error.code as number }, work, resultBytes, frameBytes };
          if (!rec(message.result)) throw fault('CLIENT_RESULT_INVALID');
          const result = message.result, structured = result.structuredContent;
          const envelope = rec(structured) && typeof structured.schema_version === 'string' && rec(structured.data) ? structured as unknown as GatewayEnvelope : undefined;
          const outcome: RecordedCall['outcome'] = sdkRejected ? { class: 'sdk_text_error', code: 'SDK_RESULT_INVALID' }
            : envelope?.error ? { class: 'application_error', code: envelope.error.code }
            : !envelope ? { class: 'sdk_text_error', code: 'sdk_text_error' } : undefined;
          return { requestId: id, ...captured, ...(rawText !== undefined ? { rawText } : {}), ...(envelope ? { envelope } : {}), ...(outcome ? { outcome } : {}), work, resultBytes, frameBytes };
        });
      } catch (error) {
        // No guessed zero-work record on a broken stream, observer failure or deadline. End the session: a subsequent
        // call must never inherit an unfinished request's counters or response. Delivered error frames DO get records.
        await close(); throw failure ?? (error instanceof GatewayClientFault ? error : fault('CLIENT_SDK_FAILED'));
      } finally { active = undefined; busy = false; }
    },
    close,
  };
}
