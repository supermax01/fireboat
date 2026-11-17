// AWS access for the HealthLake backend: region us-east-2 only, profile `fireboat`, and every AWS call goes through the
// local AWS CLI, signed in by the person running the benchmark. Control-plane steps run `aws ... --profile fireboat --region us-east-2`.
// Signing credentials come only from `aws configure export-credentials --profile fireboat --format process`; this module
// never reads ~/.aws, never writes credentials anywhere and never prints or logs them. The session comes from `aws login`
// (an assumed role) and expires: credentials are cached until shortly before their expiry and refreshed through the CLI;
// when the session has lapsed every caller gets AwsSessionError with the fix.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export const AWS_REGION = 'us-east-2';
export const AWS_PROFILE = 'fireboat';
export const HEALTHLAKE_SERVICE = 'healthlake';
export const HEALTHLAKE_HOST = `healthlake.${AWS_REGION}.amazonaws.com`;

/** A data store's FHIR base: https://healthlake.us-east-2.amazonaws.com/datastore/<32 alphanumerics>/r4/ (nothing else is accepted). */
export const DATASTORE_ID_RE = /^[A-Za-z0-9]{32}$/;
export interface DatastoreEndpoint { id: string; base: string; host: string; basePath: string }

export function parseDatastoreEndpoint(endpoint: string): DatastoreEndpoint {
  let u: URL;
  try { u = new URL(endpoint); } catch { throw new Error('data store endpoint is not a URL'); }
  const m = /^\/datastore\/([A-Za-z0-9]{32})\/r4\/?$/.exec(u.pathname);
  if (u.protocol !== 'https:' || u.host !== HEALTHLAKE_HOST || u.username || u.password || u.search || u.hash || !m) {
    throw new Error(`refusing data store endpoint outside https://${HEALTHLAKE_HOST}/datastore/<id>/r4/`);
  }
  const basePath = `/datastore/${m[1]}/r4/`;
  return { id: m[1]!, base: `https://${HEALTHLAKE_HOST}${basePath}`, host: HEALTHLAKE_HOST, basePath };
}

export const endpointFor = (datastoreId: string): DatastoreEndpoint => {
  if (!DATASTORE_ID_RE.test(datastoreId)) throw new Error('bad data store id');
  return parseDatastoreEndpoint(`https://${HEALTHLAKE_HOST}/datastore/${datastoreId}/r4/`);
};

export class AwsSessionError extends Error {}

/** The `aws` executable on PATH (Homebrew). Throws when absent. */
export function awsBin(): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, 'aws');
    if (existsSync(p)) return p;
  }
  for (const p of ['/opt/homebrew/bin/aws', '/usr/local/bin/aws']) if (existsSync(p)) return p;
  throw new Error('aws CLI not found on PATH');
}

/** Removes anything that could be a key, secret or token from CLI output before it reaches an error message. */
export function scrub(text: string): string {
  return text
    .replace(/\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{12,}\b/g, '<redacted-key-id>')
    .replace(/[A-Za-z0-9/+=]{32,}/g, '<redacted>')
    .slice(0, 600);
}

/**
 * The child environment for the CLI: the caller's environment with every variable that could pick other credentials,
 * another profile or another region removed (the profile and region are passed as flags).
 */
export function cliEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const drop = /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN|PROFILE|DEFAULT_PROFILE|REGION|DEFAULT_REGION|CONFIG_FILE|SHARED_CREDENTIALS_FILE|CA_BUNDLE|ENDPOINT_URL.*)$/;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !drop.test(k)) env[k] = v;
  env.AWS_PAGER = '';
  return env;
}

export type ExecFn = (cmd: string, args: string[], opts: { env: Record<string, string>; timeoutMs: number }) => Promise<{ stdout: string; stderr: string; code: number }>;

export const execAws: ExecFn = (cmd, args, opts) => new Promise(resolve => {
  execFile(cmd, args, { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0;
    resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
  });
});

const SESSION_HINT = `the AWS session for profile ${AWS_PROFILE} is missing or expired: sign in again (aws login --profile ${AWS_PROFILE}) and rerun`;
/** CLI error text that means the session, not the request, is the problem. */
export const SESSION_ERROR_RE = /expired|ExpiredToken|InvalidClientTokenId|UnrecognizedClient|Unable to locate credentials|security token included in the request is invalid|aws login|aws sso login/i;

/**
 * One control-plane call: `aws <args> --profile fireboat --region us-east-2 --output json`. Returns the parsed JSON
 * (AWS control-plane output, not FHIR data). Throws with scrubbed stderr; an expired session gives AwsSessionError.
 */
export async function awsCli(args: string[], opts: { exec?: ExecFn; timeoutMs?: number } = {}): Promise<unknown> {
  for (const a of args) if (/^--(profile|region|endpoint-url)$/.test(a)) throw new Error(`awsCli sets ${a} itself`);
  const exec = opts.exec ?? execAws;
  const full = [...args, '--profile', AWS_PROFILE, '--region', AWS_REGION, '--output', 'json', '--no-cli-pager'];
  const r = await exec(awsBinOrName(opts.exec), full, { env: cliEnv(), timeoutMs: opts.timeoutMs ?? 120_000 });
  if (r.code !== 0) {
    const msg = `aws ${args.slice(0, 2).join(' ')} failed (exit ${r.code}): ${scrub(r.stderr.trim())}`;
    throw SESSION_ERROR_RE.test(r.stderr) ? new AwsSessionError(`${msg}; ${SESSION_HINT}`) : new Error(msg);
  }
  const out = r.stdout.trim();
  return out ? JSON.parse(out) as unknown : null;
}

const awsBinOrName = (injected?: ExecFn) => (injected ? 'aws' : awsBin());

/** The credential identity the SigV4 signer needs (structurally @smithy/types AwsCredentialIdentity). */
export interface Credentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: Date }
export type CredentialProvider = () => Promise<Credentials>;

/** Refresh this long before the CLI-reported expiry. */
export const REFRESH_BEFORE_MS = 5 * 60_000;
/** Without an expiry in the CLI output, re-ask the CLI after this long. */
export const NO_EXPIRY_TTL_MS = 10 * 60_000;

/** Parses `aws configure export-credentials --format process` output (credential_process format, Version 1). */
export function parseProcessCredentials(stdout: string): Credentials {
  let j: { Version?: unknown; AccessKeyId?: unknown; SecretAccessKey?: unknown; SessionToken?: unknown; Expiration?: unknown };
  try { j = JSON.parse(stdout) as typeof j; } catch { throw new AwsSessionError(`aws configure export-credentials printed no JSON; ${SESSION_HINT}`); }
  if (j.Version !== 1 || typeof j.AccessKeyId !== 'string' || typeof j.SecretAccessKey !== 'string' || !j.AccessKeyId || !j.SecretAccessKey) {
    throw new AwsSessionError(`aws configure export-credentials returned no usable credentials; ${SESSION_HINT}`);
  }
  const exp = typeof j.Expiration === 'string' ? new Date(j.Expiration) : undefined;
  if (exp && Number.isNaN(exp.getTime())) throw new AwsSessionError('aws configure export-credentials returned an unreadable Expiration');
  return { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, ...(typeof j.SessionToken === 'string' && j.SessionToken ? { sessionToken: j.SessionToken } : {}), ...(exp ? { expiration: exp } : {}) };
}

/**
 * Credentials for the signer, only through `aws configure export-credentials --profile fireboat --format process`.
 * Cached until REFRESH_BEFORE_MS before expiry; one refresh at a time. A failed refresh keeps the cached credentials while
 * they are still valid, and otherwise throws AwsSessionError (the caller answers 502 and the run fails clearly).
 */
export function cliCredentialProvider(opts: { exec?: ExecFn; now?: () => number } = {}): CredentialProvider & { status(): { cached: boolean; expiresAt: string | null } } {
  const exec = opts.exec ?? execAws;
  const now = opts.now ?? Date.now;
  let cached: { creds: Credentials; refreshAt: number; validUntil: number } | null = null;
  let inflight: Promise<Credentials> | null = null;
  const fetchOnce = async (): Promise<Credentials> => {
    const r = await exec(awsBinOrName(opts.exec), ['configure', 'export-credentials', '--profile', AWS_PROFILE, '--format', 'process'], { env: cliEnv(), timeoutMs: 60_000 });
    if (r.code !== 0) throw new AwsSessionError(`aws configure export-credentials failed (exit ${r.code}): ${scrub(r.stderr.trim())}; ${SESSION_HINT}`);
    const creds = parseProcessCredentials(r.stdout);
    const t = now();
    const validUntil = creds.expiration ? creds.expiration.getTime() : t + NO_EXPIRY_TTL_MS;
    if (validUntil <= t) throw new AwsSessionError(`the credentials the CLI returned have already expired; ${SESSION_HINT}`);
    cached = { creds, validUntil, refreshAt: creds.expiration ? Math.max(t, validUntil - REFRESH_BEFORE_MS) : validUntil };
    return creds;
  };
  const provider = async (): Promise<Credentials> => {
    const t = now();
    if (cached && t < cached.refreshAt) return cached.creds;
    inflight ??= fetchOnce().finally(() => { inflight = null; });
    try {
      return await inflight;
    } catch (e) {
      if (cached && now() < cached.validUntil - 30_000) return cached.creds; // still valid: keep going, retry next call
      throw e;
    }
  };
  return Object.assign(provider, {
    status: () => ({ cached: cached !== null, expiresAt: cached ? new Date(cached.validUntil).toISOString() : null }),
  });
}
