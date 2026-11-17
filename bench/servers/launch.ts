// Spawns one arm's MCP server over stdio with exactly its declared environment, optionally inside a
// loopback-only sandbox-exec profile, and talks to it through a transport that keeps every raw JSON-RPC line.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client, type JSONRPCMessage, type JsonSchemaType, type JsonSchemaValidator, type jsonSchemaValidator, type Transport } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { parseLossless, stringifyLossless, utf8Bytes, type LosslessValue } from '../lib/json.js';
import type { CallBytes, LaunchContext, ServerCommand, ToolCall } from '../lib/types.js';
import { ARMS, SANDBOX_EXEC, sandboxed, type ArmSession, type CallOutcome } from './arms.js';

export { SANDBOX_EXEC, SANDBOX_PROFILE } from './arms.js';

export interface LaunchOptions {
  /** Default true. Checked on macOS: non-loopback connects fail, loopback works. */
  sandbox?: boolean;
  /** Default join(ctx.runDir, 'stderr.txt'). */
  stderrPath?: string;
  /** Timeout for initialize and tools/list. Default 120 s (momentum imports torch). */
  startTimeoutMs?: number;
}

export interface LaunchedSession extends ArmSession {
  command: ServerCommand;
  egressSandbox: 'sandbox-exec' | 'none';
  stderrPath: string;
  tools: { name: string; inputSchema: unknown; outputSchema?: unknown; annotations?: unknown; description?: string }[];
  /** Raw tools/list response lines (one per page). */
  toolsListRaw: string[];
  /** Output-schema validation failures the SDK would have raised; recorded, never fatal (the scripted track measures server output). */
  validationIssues: { tool: string | null; message: string }[];
  /** Lines on stdout that were not JSON-RPC (protocol noise). */
  stdoutNoise: string[];
}

interface Received { line: string; at: bigint }

/** Line-delimited JSON-RPC over a child's stdio that keeps every response line exactly as received. */
class RecordingStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly responses = new Map<string | number, Received>();
  readonly sent = new Map<string | number, { method: string; at: bigint }>();
  readonly noise: string[] = [];
  lastToolsCallId: string | number | null = null;
  exited: { code: number | null; signal: string | null } | null = null;
  private buffer = '';
  private exitWaiters: (() => void)[] = [];

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      for (const w of this.exitWaiters.splice(0)) w();
      this.onclose?.();
    });
    child.on('error', err => this.onerror?.(err));
    child.stdin.on('error', err => this.onerror?.(err));
  }

  async start(): Promise<void> {}

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim() === '') continue;
      const at = process.hrtime.bigint();
      let message: JSONRPCMessage;
      try {
        message = JSON.parse(line) as JSONRPCMessage; // for the SDK only; lexemes are read from the kept line
      } catch {
        this.noise.push(line);
        continue;
      }
      const m = message as { id?: string | number; method?: string };
      if (m.id !== undefined && m.method === undefined) this.responses.set(m.id, { line, at });
      this.onmessage?.(message);
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const m = message as { id?: string | number; method?: string };
    if (m.id !== undefined && m.method !== undefined) {
      this.sent.set(m.id, { method: m.method, at: process.hrtime.bigint() });
      if (m.method === 'tools/call') this.lastToolsCallId = m.id;
    }
    if (this.exited) throw new Error('server process has exited');
    await new Promise<void>((resolve, reject) =>
      this.child.stdin.write(JSON.stringify(message) + '\n', err => (err ? reject(err) : resolve())));
  }

  idsFor(method: string): (string | number)[] {
    return [...this.sent].filter(([, v]) => v.method === method).map(([id]) => id);
  }

  waitExit(ms: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(false), ms);
      this.exitWaiters.push(() => { clearTimeout(t); resolve(true); });
    });
  }

  async close(): Promise<void> {
    if (!this.exited) {
      this.child.stdin.end();
      if (!(await this.waitExit(3000))) {
        this.child.kill('SIGTERM');
        if (!(await this.waitExit(3000))) {
          this.child.kill('SIGKILL');
          await this.waitExit(3000);
        }
      }
    }
  }
}

const isObj = (v: unknown): v is Record<string, LosslessValue> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Bytes of one JSON-RPC response line, per channel. */
export function bytesOf(line: string): CallBytes {
  const msg = parseLossless(line);
  const result = isObj(msg) ? msg.result : undefined;
  let contentText = 0;
  if (isObj(result) && Array.isArray(result.content)) {
    for (const c of result.content) if (isObj(c) && typeof c.text === 'string') contentText += utf8Bytes(c.text);
  }
  return {
    content_text: contentText,
    structured_content: isObj(result) && result.structuredContent !== undefined ? utf8Bytes(stringifyLossless(result.structuredContent)) : 0,
    result: result !== undefined ? utf8Bytes(stringifyLossless(result)) : 0,
    line: utf8Bytes(line),
  };
}

export async function launch(ctx: LaunchContext, opts: LaunchOptions = {}): Promise<LaunchedSession> {
  const spec = ARMS[ctx.arm];
  if (spec.status !== 'active' || !spec.command) throw new Error(`arm ${ctx.arm} has no MCP server to launch`);
  const cmd = spec.command(ctx);
  mkdirSync(cmd.cwd, { recursive: true });
  mkdirSync(ctx.runTmp, { recursive: true });
  for (const [rel, content] of Object.entries(cmd.files)) {
    const p = join(cmd.cwd, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  const sandbox = opts.sandbox ?? true;
  if (sandbox && !existsSync(SANDBOX_EXEC)) throw new Error('sandbox-exec not available');
  const stderrPath = opts.stderrPath ?? join(ctx.runDir, 'stderr.txt');
  mkdirSync(dirname(stderrPath), { recursive: true });
  const stderr = createWriteStream(stderrPath);

  const spawned = sandbox ? sandboxed(cmd) : cmd;
  const t0 = process.hrtime.bigint();
  const child = spawn(spawned.command, spawned.args, { cwd: cmd.cwd, env: cmd.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.pipe(stderr);
  const transport = new RecordingStdioTransport(child);

  const validationIssues: { tool: string | null; message: string }[] = [];
  const ajv = new AjvJsonSchemaValidator();
  const recordingValidator: jsonSchemaValidator = {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      const inner = ajv.getValidator<T>(schema);
      return ((input: unknown) => {
        const r = inner(input);
        if (!r.valid) validationIssues.push({ tool: null, message: r.errorMessage });
        return { valid: true, data: input, errorMessage: undefined };
      }) as JsonSchemaValidator<T>;
    },
  };
  const client = new Client({ name: 'fbbench-scripted', version: '1.0.0' }, { capabilities: {}, jsonSchemaValidator: recordingValidator });
  const startTimeout = opts.startTimeoutMs ?? 120_000;
  const fail = async (e: unknown): Promise<never> => {
    await transport.close();
    stderr.end();
    throw new Error(`${ctx.arm}: start failed: ${(e as Error).message}${transport.exited ? ` (exit ${JSON.stringify(transport.exited)})` : ''}; stderr: ${stderrPath}`);
  };
  try {
    await client.connect(transport, { timeout: startTimeout });
  } catch (e) { await fail(e); }
  const initId = transport.idsFor('initialize')[0];
  const initAt = initId !== undefined ? transport.responses.get(initId)?.at : undefined;
  const coldStartMs = initAt ? Number(initAt - t0) / 1e6 : Number(process.hrtime.bigint() - t0) / 1e6;

  let tools: LaunchedSession['tools'] = [];
  try {
    tools = (await client.listTools(undefined, { timeout: startTimeout })).tools as LaunchedSession['tools'];
  } catch (e) { await fail(e); }
  const toolsListRaw = transport.idsFor('tools/list').map(id => transport.responses.get(id)?.line).filter((l): l is string => !!l);
  const toolsListBytes = toolsListRaw.reduce((n, l) => n + bytesOf(l).result, 0);
  const instructions = client.getInstructions();

  const call = async (tc: ToolCall, timeoutMs: number): Promise<CallOutcome> => {
    const startedAt = new Date().toISOString();
    const h0 = process.hrtime.bigint();
    transport.lastToolsCallId = null;
    const issuesBefore = validationIssues.length;
    let error: CallOutcome['error'] = null;
    try {
      await client.callTool({ name: tc.tool, arguments: tc.arguments }, { timeout: timeoutMs });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      error = transport.exited ? { kind: 'crash', message: msg }
        : /timed? ?out/i.test(msg) ? { kind: 'timeout', message: msg }
        : { kind: 'protocol', message: msg };
    }
    for (const i of validationIssues.slice(issuesBefore)) i.tool = tc.tool;
    const id = transport.lastToolsCallId;
    const got = id !== null ? transport.responses.get(id) : undefined;
    const sentAt = id !== null ? transport.sent.get(id)?.at : undefined;
    const latencyMs = got && sentAt ? Number(got.at - sentAt) / 1e6 : Number(process.hrtime.bigint() - h0) / 1e6;
    let isError: boolean | null = null;
    let bytes: CallBytes | null = null;
    if (got) {
      bytes = bytesOf(got.line);
      const msg = parseLossless(got.line);
      if (isObj(msg) && isObj(msg.result)) isError = msg.result.isError === true;
      if (isObj(msg) && msg.error !== undefined && !error) error = { kind: 'protocol', message: stringifyLossless(msg.error) };
    } else if (!error) {
      error = { kind: 'transport', message: 'no response line recorded' };
    }
    return { tool: tc.tool, arguments: tc.arguments, started_at: startedAt, latency_ms: Math.round(latencyMs * 1000) / 1000,
      response_raw: got?.line ?? null, is_error: isError, bytes, error };
  };

  const close = async () => {
    try { await client.close(); } catch { /* the transport close below is authoritative */ }
    await transport.close();
    await new Promise<void>(resolve => stderr.end(resolve));
    return transport.exited ?? { code: null, signal: null };
  };

  return {
    client, pid: child.pid ?? null, coldStartMs: Math.round(coldStartMs * 1000) / 1000,
    protocolVersion: client.getNegotiatedProtocolVersion() ?? null,
    serverInfo: client.getServerVersion() ?? null,
    instructionsBytes: instructions ? utf8Bytes(instructions) : 0,
    toolsListBytes, toolNames: tools.map(t => t.name), call, close,
    command: cmd, egressSandbox: sandbox ? 'sandbox-exec' : 'none', stderrPath, tools, toolsListRaw, validationIssues,
    stdoutNoise: transport.noise,
  };
}
