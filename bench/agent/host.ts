// Claude Code host pins and the exact invocation used by the agent track. Identical for every arm.
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sha256File } from '../lib/hash.js';

const HOST_VERSION = '2.1.322';
/**
 * The pinned Claude Code binary. BENCH_CLAUDE_BIN names it; by default it is the versioned binary in Claude Code's
 * standard install location, ~/.local/share/claude/versions/<version>. Its sha256 is checked before every batch.
 */
export const HOST = {
  path: process.env.BENCH_CLAUDE_BIN || join(homedir(), '.local', 'share', 'claude', 'versions', HOST_VERSION),
  version: HOST_VERSION,
  sha256: 'a9d237949db816a0b7afd88a9a8e1df36b3a597a30f5a41d1c0539eb180a3450',
} as const;

export const MODEL = 'claude-opus-5-5';
export const EFFORT = 'high';
export const MAX_TURNS = 30;
export const MAX_BUDGET_USD = 2;
/** A run served by another model is re-run as an infrastructure failure at most 3 times. */
export const MAX_INFRA_RETRIES = 3;

/** Pinned environment variables, identical for every run. PATH, HOME, the credential and CLAUDE_CONFIG_DIR are added per run. */
export const PINNED_ENV: Readonly<Record<string, string>> = {
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MAX_MCP_OUTPUT_TOKENS: '25000',
  DISABLE_AUTO_COMPACT: '1',
  ENABLE_TOOL_SEARCH: 'false',
  MCP_TIMEOUT: '120000',
  MCP_TOOL_TIMEOUT: '120000',
};

/** The host itself needs nothing from PATH; MCP servers carry their own PATH in the MCP config. */
export const HOST_PATH = '/usr/bin:/bin';

export interface HostInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** argv with the prompt and the schema replaced by `sha256:<hex>`, safe to record. */
  recordedArgv: string[];
  /** Names only. */
  envNames: string[];
}

export interface InvocationInput {
  workDir: string; // fresh, empty; host cwd, and therefore the MCP server's cwd
  homeDir: string; // fresh, empty; host HOME. Separate so host caches stay out of the server's cwd
  configDir: string; // fresh, empty CLAUDE_CONFIG_DIR
  prompt: string;
  promptSha256: string;
  schemaText: string;
  schemaSha256: string;
  mcpConfigPath: string;
  apiKey: string;
  /** Only for the local mock Messages API (harness self-test). Never set for real runs. */
  mockBaseUrl?: string;
}

export function buildInvocation(i: InvocationInput): HostInvocation {
  const env: Record<string, string> = {
    PATH: HOST_PATH,
    HOME: i.homeDir,
    ANTHROPIC_API_KEY: i.apiKey,
    CLAUDE_CONFIG_DIR: i.configDir,
    ...PINNED_ENV,
  };
  if (i.mockBaseUrl !== undefined) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(i.mockBaseUrl)) throw new Error('mock base URL must be loopback');
    env.ANTHROPIC_BASE_URL = i.mockBaseUrl;
  }
  const tail = (prompt: string, schema: string) => [
    '-p', prompt,
    '--bare', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', i.mcpConfigPath,
    '--tools', '', '--allowedTools', 'mcp__ehr__*', '--permission-mode', 'dontAsk',
    '--model', MODEL, '--effort', EFFORT,
    '--max-turns', String(MAX_TURNS), '--max-budget-usd', String(MAX_BUDGET_USD),
    '--output-format', 'stream-json', '--verbose',
    '--json-schema', schema,
    '--no-session-persistence', '--exclude-dynamic-system-prompt-sections',
  ];
  return {
    command: HOST.path,
    args: tail(i.prompt, i.schemaText),
    env,
    cwd: i.workDir,
    recordedArgv: [HOST.path, ...tail(`sha256:${i.promptSha256}`, `sha256:${i.schemaSha256}`)],
    envNames: Object.keys(env),
  };
}

let verified: string | null = null;

/** Checks the versioned host binary against the pinned sha256. Throws on mismatch. Cached per process. */
export async function verifyHost(): Promise<string> {
  if (verified) return verified;
  const s = await stat(HOST.path);
  if (!s.isFile()) throw new Error(`host not found: ${HOST.path}`);
  const sha = await sha256File(HOST.path);
  if (sha !== HOST.sha256) throw new Error(`host sha256 mismatch: ${sha} != ${HOST.sha256}`);
  verified = sha;
  return sha;
}

/** Accepts the requested id or the same id with a date suffix (claude-opus-5-5-20261001). */
export const isRequestedModel = (seen: string, requested = MODEL): boolean =>
  seen === requested || new RegExp(`^${requested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}$`).test(seen);
