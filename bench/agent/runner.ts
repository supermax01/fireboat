// One non-interactive Claude Code run: fresh directories, the arm's MCP config, the slot proxy, the host,
// then one AgentRunRecord. Batching, the run cap, the budget guard and re-runs are in smoke.ts.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { sha256Hex } from '../lib/hash.js';
import { LosslessNumber, parseLossless, parseNumbersAsStrings, stringifyLossless, type LosslessValue } from '../lib/json.js';
import { appendJsonl, completeLines, repairPartialTail } from '../lib/jsonl.js';
import { proxyBase, RESULTS } from '../lib/paths.js';
import type { AgentRunRecord, ArmId, GoldRecord, LaunchContext, QuestionRecord, ServerCommand } from '../lib/types.js';
import { startRecordingProxy, startTokenShim, type ProxyHandle } from '../infra/proxy.js';
import { ARMS, mcpConfig, NODE_BIN } from '../servers/arms.js';

/** Harness self-test server: writes the names (never values) of its environment variables to env-names.json in its cwd. */
export const ENV_PROBE_SERVER = new URL('./env-probe-server.mjs', import.meta.url).pathname;
import { buildInvocation, EFFORT, HOST, MODEL } from './host.js';
import { checkActiveDataset, hapiHealth } from './io.js';
import { startMockApi, type MockApi, type MockPlan } from './mock-api.js';
import { promptFor, type LoadedPromptFiles } from './prompt.js';
import { parseStream, type StreamLine } from './stream.js';

export type RunKind = 'smoke' | 'mock';

export const agentRoot = (kind: RunKind) => join(RESULTS, 'agent', kind);
export const agentPaths = (kind: RunKind) => ({
  root: agentRoot(kind),
  records: join(agentRoot(kind), 'agent-runs.jsonl'),
  claims: join(agentRoot(kind), 'agent-claims.jsonl'),
  scores: join(agentRoot(kind), 'agent-scores.jsonl'),
  proxyLog: join(agentRoot(kind), 'proxy.jsonl'),
  runs: join(agentRoot(kind), 'runs'),
});

/** CLAUDE_CONFIG_DIR for a slot: deleted and recreated empty before every run. */
export const slotConfigDir = (slot: number) => join(RESULTS, 'agent', 'slots', `s${slot}`, 'claude-config');

export const RUN_TIMEOUT_MS = 30 * 60 * 1000;

export const agentRunId = (arm: ArmId, rep: number, questionId: string) => `${arm}__agent__r${rep}__${questionId}`;
export const attemptId = (runId: string, infraRetry: number) => (infraRetry === 0 ? runId : `${runId}.retry${infraRetry}`);

type Closable = Pick<ProxyHandle, 'close'>;

export interface RunOptions {
  kind: RunKind;
  arm: ArmId;
  question: QuestionRecord;
  repetition: number;
  infraRetry: number;
  slot: number;
  prompt: LoadedPromptFiles;
  apiKey: string;
  /** Called after every preflight passed and immediately before the host is spawned (writes the cap claim). */
  beforeLaunch: () => Promise<void>;
  /** mock only. envProbe: the arm's environment and wrapper, but agent/env-probe-server.mjs as the server program. */
  mock?: { plan: MockPlan; skipPreflight: boolean; noProxy: boolean; envProbe?: boolean };
}

export interface RunMeta {
  schema: 'fbbench.agent-run-meta/1';
  run_id: string;
  attempt: string;
  hapi_before: unknown;
  hapi_after: unknown;
  preflight: unknown;
  proxy: 'recording' | 'none';
  token_shim: boolean;
  config_dir_after: string[];
  work_dir_after: string[];
  home_dir_after: string[];
  structured_output_errors: string[];
  event_counts: Record<string, number>;
  model_usage: unknown;
  result_is_error: boolean | null;
  unparsable_lines: number;
  upstream: { requests: number; blocked_writes: number; statuses: Record<string, number> };
  mock_requests: unknown;
  host_sha256: string;
  /** Host checks: host version in the init event; every model in result.modelUsage (ancillary calls included). */
  host_version_ok: boolean;
  model_usage_models: string[];
  timed_out: boolean;
}

async function listTree(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    out.push(relative(dir, join(e.parentPath, e.name)) + (e.isDirectory() ? '/' : ''));
  }
  return out.sort();
}

const SECRET_NAME = /SECRET|TOKEN|PASSWORD|API_KEY/i;

function redactEnv(cmd: ServerCommand | null): unknown {
  const cfg = mcpConfig(cmd);
  for (const s of Object.values(cfg.mcpServers)) {
    for (const k of Object.keys(s.env)) if (SECRET_NAME.test(k) && s.env[k] !== '') s.env[k] = '<redacted>';
    s.args = s.args.map(a => { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(a); return m && SECRET_NAME.test(m[1]!) ? `${m[1]}=<redacted>` : a; });
  }
  return cfg;
}

function upstreamFor(proxyLog: string, proxyRunId: string): RunMeta['upstream'] {
  const out = { requests: 0, blocked_writes: 0, statuses: {} as Record<string, number> };
  if (!existsSync(proxyLog)) return out;
  for (const line of readFileSync(proxyLog, 'utf8').split('\n')) {
    if (!line.includes(proxyRunId)) continue;
    const r = parseNumbersAsStrings(line) as { run_id?: string; status?: string; blocked?: boolean };
    if (r.run_id !== proxyRunId) continue;
    out.requests++;
    if (r.blocked) out.blocked_writes++;
    const s = String(r.status);
    out.statuses[s] = (out.statuses[s] ?? 0) + 1;
  }
  return out;
}

/**
 * Runs one attempt and appends its record. Setup failures before launch remove the run directory and throw;
 * `beforeLaunch` (the cap claim) runs only once setup has succeeded.
 */
export async function runOne(o: RunOptions, hostSha256: string): Promise<AgentRunRecord> {
  const q = o.question;
  const p = agentPaths(o.kind);
  const runId = agentRunId(o.arm, o.repetition, q.id);
  const attempt = attemptId(runId, o.infraRetry);
  const runDir = join(p.runs, attempt);
  if (existsSync(runDir)) throw new Error(`${runDir} exists; refusing to reuse a run directory`);
  const workDir = join(runDir, 'work'); // host cwd and HOME, and the MCP server's cwd and HOME: fresh and empty
  const runTmp = join(runDir, 'tmp');
  const homeDir = join(runDir, 'home'); // host HOME; the MCP server's HOME is workDir (servers/arms.ts)
  const configDir = slotConfigDir(o.slot);
  const closers: Closable[] = [];
  let proxyKind: RunMeta['proxy'] = 'none';
  let shim = false;
  let mock: MockApi | null = null;
  let mockRequests: unknown = null;
  const releaseUpstream = async () => {
    for (const c of closers.splice(0).reverse()) await c.close();
    if (mock) { await mock.close(); mock = null; }
  };
  let cmd: ServerCommand | null, prompt: string, promptSha: string, promptPath: string, mcpConfigPath: string;
  let preflight: unknown, inv: ReturnType<typeof buildInvocation>;
  try {
    await mkdir(workDir, { recursive: true });
    await mkdir(runTmp, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await rm(configDir, { recursive: true, force: true });
    await mkdir(configDir, { recursive: true });

    const spec = ARMS[o.arm];
    if (spec.status !== 'active') throw new Error(`arm ${o.arm} is not active${spec.unavailable ? `: ${spec.unavailable}` : ''}`);
    const ctx: LaunchContext = { arm: o.arm, dataset: q.dataset, patientId: q.patient_id, slot: o.slot, fhirBaseUrl: proxyBase(o.slot), runDir: workDir, runTmp };
    cmd = spec.command ? spec.command(ctx) : null;
    if (cmd && o.kind === 'mock' && o.mock?.envProbe) cmd = { ...cmd, command: NODE_BIN, args: [ENV_PROBE_SERVER], files: {} };
    if (cmd) for (const [rel, content] of Object.entries(cmd.files)) {
      const target = join(workDir, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }
    mcpConfigPath = join(runDir, 'mcp-config.json');
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig(cmd), null, 2) + '\n', 'utf8');

    prompt = promptFor(o.prompt.template, q);
    promptSha = sha256Hex(prompt);
    promptPath = join(runDir, 'prompt.txt');
    await writeFile(promptPath, prompt, 'utf8');
    await writeFile(join(runDir, 'answer.schema.json'), o.prompt.schemaText, 'utf8');

    preflight = o.mock?.skipPreflight ? { skipped: true } : await checkActiveDataset(q.dataset, q.patient_id);

    // Upstream path: slot recording proxy (and the token shim for M).
    if (cmd && !o.mock?.noProxy) {
      closers.push(await startRecordingProxy({ slot: o.slot, runId: attempt, logPath: p.proxyLog }));
      proxyKind = 'recording';
      if (o.arm === 'M') { closers.push(await startTokenShim({ slot: o.slot })); shim = true; }
    }
    if (o.kind === 'mock') {
      if (!o.mock) throw new Error('mock run without a mock plan');
      mock = await startMockApi(o.mock.plan);
      mockRequests = mock.requests;
    }

    inv = buildInvocation({
      workDir, homeDir, configDir, prompt, promptSha256: promptSha, schemaText: o.prompt.schemaText, schemaSha256: o.prompt.schemaSha256,
      mcpConfigPath, apiKey: o.apiKey, ...(mock ? { mockBaseUrl: mock.baseUrl } : {}),
    });
    await o.beforeLaunch();
  } catch (e) {
    await releaseUpstream();
    await rm(runDir, { recursive: true, force: true });
    throw e;
  }
  const streamPath = join(runDir, 'stream.jsonl');
  const stderrPath = join(runDir, 'stderr.txt');
  const hapiBefore = o.mock?.skipPreflight ? null : await hapiHealth();
  const startedAt = new Date().toISOString();
  const lines: StreamLine[] = [];
  let timedOut = false;
  let exit: { code: number | null; signal: string | null };
  try {
    exit = await new Promise((resolve, reject) => {
      const out = createWriteStream(streamPath);
      const err = createWriteStream(stderrPath);
      const child = spawn(inv.command, inv.args, { cwd: inv.cwd, env: inv.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        out.write(chunk);
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) { lines.push({ text: buf.slice(0, nl), at_ms: Date.now() }); buf = buf.slice(nl + 1); }
      });
      child.stderr.pipe(err);
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 10000).unref(); }, RUN_TIMEOUT_MS);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (buf.length > 0) lines.push({ text: buf, at_ms: Date.now() });
        out.end(); err.end();
        resolve({ code, signal });
      });
    });
  } finally {
    await releaseUpstream();
  }
  const hapiAfter = o.mock?.skipPreflight ? null : await hapiHealth();

  const parsed = parseStream(lines, { requestedModel: MODEL, expectServer: cmd !== null });
  const record: AgentRunRecord = {
    schema: 'fbbench.agent/1',
    run_id: runId,
    kind: o.kind,
    arm: o.arm,
    dataset: q.dataset,
    question_id: q.id,
    patient_id: q.patient_id,
    repetition: o.repetition,
    slot: o.slot,
    started_at: startedAt,
    host: { path: HOST.path, version: HOST.version, sha256: hostSha256 },
    model_requested: MODEL,
    effort: EFFORT,
    models_seen: parsed.models_seen,
    argv: inv.recordedArgv,
    env_names: inv.envNames,
    prompt_sha256: promptSha,
    schema_sha256: o.prompt.schemaSha256,
    mcp_config: redactEnv(cmd),
    paths: { run_dir: runDir, prompt: promptPath, stream: streamPath, stderr: stderrPath, proxy_log: p.proxyLog },
    init: parsed.init,
    structured_output_raw: parsed.structured_output_raw,
    structured_output: parsed.structured_output,
    terminal_status: timedOut ? 'harness_timeout' : parsed.terminal_status,
    num_turns: parsed.num_turns,
    usage: parsed.usage,
    total_cost_usd: parsed.total_cost_usd,
    wall_ms_from_init: parsed.init_at_ms !== null && parsed.result_at_ms !== null ? parsed.result_at_ms - parsed.init_at_ms : null,
    tool_calls: parsed.tools.map(t => ({ name: t.name, arguments: t.arguments, is_error: t.is_error, result_bytes: t.result_bytes })),
    invalid_tool_calls: parsed.tools.filter(t => t.invalid).length,
    tool_result_bytes: parsed.tools.filter(t => t.name.startsWith('mcp__')).reduce((s, t) => s + t.result_bytes, 0),
    flags: parsed.flags,
    infra_retry: o.infraRetry,
    exit,
  };
  const meta: RunMeta = {
    schema: 'fbbench.agent-run-meta/1',
    run_id: runId,
    attempt,
    hapi_before: hapiBefore,
    hapi_after: hapiAfter,
    preflight,
    proxy: proxyKind,
    token_shim: shim,
    config_dir_after: await listTree(configDir),
    work_dir_after: await listTree(workDir),
    home_dir_after: await listTree(homeDir),
    structured_output_errors: parsed.structured_output_errors,
    event_counts: parsed.event_counts,
    model_usage: parsed.model_usage,
    result_is_error: parsed.result_is_error,
    unparsable_lines: parsed.unparsable_lines,
    upstream: upstreamFor(p.proxyLog, attempt),
    mock_requests: mockRequests,
    host_sha256: hostSha256,
    host_version_ok: parsed.init?.claude_code_version === HOST.version,
    model_usage_models: Object.keys(parsed.model_usage ?? {}),
    timed_out: timedOut,
  };
  await writeFile(join(runDir, 'run-meta.json'), stringifyLossless(meta) + '\n', 'utf8');
  await appendJsonl(p.records, [record]);
  return record;
}

/** Writes the launch claim that the run cap counts (written before every launch). */
export async function writeClaim(kind: RunKind, arm: ArmId, questionId: string, repetition: number, infraRetry: number): Promise<void> {
  const runId = agentRunId(arm, repetition, questionId);
  await appendJsonl(agentPaths(kind).claims, [{ schema: 'fbbench.agent-claim/1', run_id: runId, attempt: attemptId(runId, infraRetry), at: new Date().toISOString() }]);
}

export type { GoldRecord };

/** Our own count fields back to numbers. Answer fields are strings by schema; total_cost_usd stays a lexeme string. */
function plainNumbers(v: LosslessValue): unknown {
  if (v instanceof LosslessNumber) return Number(v.lexeme);
  if (Array.isArray(v)) return v.map(plainNumbers);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainNumbers(x)]));
  return v;
}

export function readAgentRecords(path: string): AgentRunRecord[] {
  if (!existsSync(path)) return [];
  repairPartialTail(path);
  return completeLines(readFileSync(path, 'utf8')).map(l => plainNumbers(parseLossless(l)) as AgentRunRecord);
}
