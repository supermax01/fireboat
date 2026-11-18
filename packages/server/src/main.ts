import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { McpServer, Transport } from '@modelcontextprotocol/server';
import { FhirGateway, type GatewayConfig } from '../../core/src/index.js';
import { eligibleSearchProfileIds } from '../../core/src/query.js';
import { ambientProxyRisk } from '../../core/src/transport.js';
import { createMcpServer } from './index.js';
import { doctorReport, type DoctorFault, type DoctorInput } from './doctor.js';
import { runtimeCell, type ReleaseMetadata } from './release.js';

export interface ConfigChoice { configPath?: string; deprecatedConfig: boolean }
export const CONFIG_DEPRECATION_NOTE = 'fireboat: note: FHIR_MCP_CONFIG is deprecated; use FIREBOAT_CONFIG.\n';
/**
 * The one config-path rule for every command: `--config <path>` or `--config=<path>` (the last one wins) >
 * FIREBOAT_CONFIG > FHIR_MCP_CONFIG (deprecated). `other` consumes any other argument and returns how many
 * arguments it used; 0 refuses the argument. Throws on a refused argument.
 */
export function resolveConfig(argv: readonly string[], other: (arg: string, next: string | undefined) => number): ConfigChoice {
  const choice: ConfigChoice = { deprecatedConfig: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--config') {
      const next = argv[i + 1];
      if (!next) throw new Error();
      choice.configPath = next; i += 1;
    } else if (arg.startsWith('--config=')) choice.configPath = arg.slice('--config='.length);
    else {
      const used = other(arg, argv[i + 1]);
      if (used < 1) throw new Error();
      i += used - 1;
    }
  }
  if (choice.configPath === undefined) {
    choice.configPath = process.env['FIREBOAT_CONFIG'] ?? process.env['FHIR_MCP_CONFIG'];
    choice.deprecatedConfig = process.env['FIREBOAT_CONFIG'] === undefined && process.env['FHIR_MCP_CONFIG'] !== undefined;
  }
  return choice;
}
interface CliOptions extends ConfigChoice { doctor: boolean }
function parseArgs(argv: string[]): CliOptions {
  let doctor = false;
  const choice = resolveConfig(argv, arg => { if (arg !== '--doctor') return 0; doctor = true; return 1; });
  return { ...choice, doctor };
}

async function loadConfig(configPath: string): Promise<GatewayConfig> {
  const parsed: unknown = JSON.parse(await readFile(resolve(configPath), 'utf8'));
  if (!isRecord(parsed)) throw new Error();
  // The constructor remains the authoritative configuration validator.
  return parsed as unknown as GatewayConfig;
}

/** Names only; the controlled FHIR/token client uses explicit non-proxy agents. */
export function reportProxyRisk(): void {
  const risk = ambientProxyRisk();
  if (risk.risk) process.stderr.write(`fireboat: warning: ambient proxy risk (activated by ${risk.activatedBy.join(', ')}; variables ${risk.proxyVariables.join(', ')}). The controlled FHIR/token client ignores ambient proxies; unset them to silence this warning.\n`);
  else if (risk.enabled || risk.proxyVariables.length) process.stderr.write(`fireboat: note: proxy-related environment present (enabled=${risk.enabled}; variables ${risk.proxyVariables.join(', ') || 'none'}); controlled client ignores ambient proxies.\n`);
}

function resourceView(gateway: FhirGateway, type: 'Patient' | 'Observation') {
  return gateway.execute('fhir_capabilities', { topic: 'resource', resource_type: type });
}

/** Reduce public discovery results to the closed DTO; no resource, message, URL, or handle crosses it. */
async function runDoctor(gateway: FhirGateway, config: GatewayConfig, release: ReleaseMetadata): Promise<number> {
  // Sign-in is its own phase: the credential is obtained first, with no metadata or clinical request, so a sign-in
  // failure is never confused with a metadata fault that raises the same code (a redirect, say).
  const signInFault = config.source.auth ? await gateway.checkSignIn() : undefined;
  const server = signInFault === undefined ? await gateway.execute('fhir_capabilities', { topic: 'server' }) : undefined;
  const faults: DoctorFault[] = [];
  let metadata: DoctorInput['metadata'];
  // No server result means the sign-in phase failed. After a token was obtained, CONNECTION_REQUIRED from /metadata means
  // the source rejected that token: the metadata was requested but never judged, so that too is the sign-in. Either way
  // name the sign-in, never the metadata.
  if (!server || (server.error?.code === 'CONNECTION_REQUIRED' && config.source.auth)) {
    metadata = { status: 'not-checked', fhir: 'unknown', summary: 'unknown' };
    faults.push('SIGN_IN_UNAVAILABLE');
  } else if (server.error) {
    const unsupported = server.error.code === 'UNSUPPORTED_FHIR_VERSION';
    const invalid = unsupported || ['INVALID_RESPONSE', 'UNSUPPORTED_CONTENT', 'UNSUPPORTED_PRECISION', 'OUTPUT_LIMIT', 'INTERNAL_ERROR'].includes(server.error.code);
    metadata = { status: invalid ? 'invalid' : 'unavailable', fhir: unsupported ? 'other' : 'unknown', summary: 'unknown' };
    faults.push(unsupported ? 'FHIR_VERSION_UNSUPPORTED' : invalid ? 'METADATA_INVALID' : 'METADATA_UNAVAILABLE');
  } else {
    const data = server.data as Record<string, unknown>;
    metadata = { status: 'ready', fhir: server.source.fhir_version === '4.0.1' ? '4.0.1' : 'other',
      capabilityRevision: server.source.capability_revision,
      summary: server.coverage.state === 'complete_for_query' ? 'complete' : 'partial',
      ...(typeof data.resource_count === 'number' ? { typeCount: data.resource_count } : {}) };
  }
  let patient: 'ready' | 'not-ready' = 'not-ready', observation: 'ready' | 'not-ready' = 'not-ready';
  if (metadata.status === 'ready') {
    const patientView = await resourceView(gateway, 'Patient');
    const observationView = await resourceView(gateway, 'Observation');
    const executable = (view: typeof patientView, interaction: string): boolean => !view.error
      && Array.isArray(view.data.implemented_interactions) && view.data.implemented_interactions.includes(interaction);
    // Under SMART the grant must also permit each step: Patient read and Observation search. It is read from the grant
    // acquired for the metadata check; no clinical request is sent.
    patient = executable(patientView, 'read') && gateway.grantPermits('Patient', 'read') ? 'ready' : 'not-ready';
    observation = executable(observationView, 'search-type') && gateway.grantPermits('Observation', 'search') ? 'ready' : 'not-ready';
  }
  const profile = gateway.describeSearchProfile();
  // Eligibility is registry-derived. An unknown/private profile is never copied through as a safe token.
  if (!profile.eligible || profile.private || !eligibleSearchProfileIds().includes(profile.id)) {
    process.stderr.write('fireboat: PROFILE_INVALID\n'); return 2;
  }
  // SMART auth adds one closed line: discovery, PKCE, stored grant and scope relation, never URLs, scopes or tokens.
  const smart = config.source.auth?.type.startsWith('smart_') ? await gateway.describeSmartStatus() : undefined;
  const cell = { node: process.versions.node, platform: process.platform, arch: process.arch };
  const report = doctorReport({
    release: { name: release.name, version: release.version, schema: release.schema, catalog: release.catalog },
    runtime: { ...cell, lossless: 'ok', cell: runtimeCell(release, cell) },
    source: { alias: config.source.alias, loopback: 'literal-ok', auth: config.source.auth?.type ?? 'none', classification: 'operator-declared-synthetic' },
    metadata,
    workflow: { id: 'recent-labs-v1', patient, observation, searchProfile: profile.id as DoctorInput['workflow']['searchProfile'], proof: profile.id !== 'generic-r4' && profile.proving ? 'qualified' : 'unproved' },
    output: gateway.describeOperatorPolicy(),
    artifacts: { r4IndexSha256: release.assets['r4-index'].sha256, r4SearchParametersSha256: release.assets['r4-search-parameters'].sha256, supportMatrixSha256: release.assets['support-matrix'].sha256 },
    privacy: { patientIdentifierSystems: config.privacy?.patientIdentifierSystems?.length ?? 0, sharedIdentifierSystems: config.privacy?.sharedIdentifierSystems?.length ?? 0, sharedProfiles: config.privacy?.sharedProfiles?.length ?? 0 },
    proxy: ambientProxyRisk().risk ? 'present' : 'absent', ...(smart ? { smart } : {}), faults,
  });
  process.stdout.write(`${report.lines.join('\n')}\n`);
  return report.exitCode;
}

const PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
type WireMessage = { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** The envelope claim of a message: the reserved protocol-version _meta key, mirroring the SDK's hasEnvelopeClaim/envelopeClaimVersion. */
function envelopeClaim(params: unknown): string | undefined {
  if (!isRecord(params) || !isRecord(params['_meta']) || !(PROTOCOL_VERSION_KEY in params['_meta'])) return undefined;
  const value = params['_meta'][PROTOCOL_VERSION_KEY];
  return typeof value === 'string' ? value : 'unknown';
}

/**
 * Per-request version guard. The SDK's serveStdio entry owns the
 * opening exchange and pins one era per connection, but once pinned it
 * delivers every later message without re-checking the per-request
 * `io.modelcontextprotocol/protocolVersion` claim. The pin must come from
 * the era the SDK actually created — the factory context — never from a
 * wire-level copy of the entry's phase machine: a copy desyncs on repeated
 * `server/discover`, malformed-envelope openings that the SDK answers
 * without pinning, and rejected 2099 openings. So the guard wraps the
 * channel `onmessage` of the instance the factory built for `era`: a
 * request whose claim is present and differs from that era's revision is
 * answered with the SDK's own -32022 UnsupportedProtocolVersion shape, and
 * a mismatched notification is dropped. A legacy `initialize` is exempt
 * (the handshake negotiates), and claim-less messages keep their existing
 * handling (the modern codec rejects a missing envelope; legacy traffic is
 * claim-less by design).
 */
export function withEraGuard(server: McpServer, era: 'modern' | 'legacy'): McpServer {
  const supported = era === 'modern' ? MODERN_VERSION : LEGACY_VERSION;
  const connect = server.connect.bind(server);
  server.connect = async (transport: Transport): Promise<void> => {
    await connect(transport);
    const downstream = transport.onmessage;
    if (!downstream) return;
    transport.onmessage = (message, extra) => {
      const wire = message as WireMessage;
      const isRequest = typeof wire.method === 'string' && wire.id !== undefined;
      const isNotification = typeof wire.method === 'string' && wire.id === undefined;
      if (!isRequest && !isNotification) { downstream(message, extra); return; }
      const claim = envelopeClaim(wire.params);
      if (claim === undefined || claim === supported || (era === 'legacy' && wire.method === 'initialize')) { downstream(message, extra); return; }
      if (isRequest) {
        void transport.send({
          jsonrpc: '2.0',
          id: wire.id as never,
          error: { code: UNSUPPORTED_PROTOCOL_VERSION, message: `Unsupported protocol version: ${claim}`, data: { supported: [supported], requested: claim } },
        } as Parameters<Transport['send']>[0]).catch(() => undefined);
      }
    };
  };
  return server;
}

/** How long shutdown waits, at most, for in-flight sign-in work to unwind before the process exits. */
const SHUTDOWN_SETTLE_MS = 1_500;

export async function main(argv: string[], release: ReleaseMetadata): Promise<number> {
  let opts: CliOptions;
  try { opts = parseArgs(argv); }
  catch { process.stderr.write('fireboat: ARGUMENTS_INVALID\n'); return 2; }
  if (opts.deprecatedConfig) process.stderr.write(CONFIG_DEPRECATION_NOTE);
  if (!opts.doctor) reportProxyRisk();
  if (!opts.configPath) {
    process.stderr.write('fireboat: CONFIG_INVALID\n'); return 2;
  }
  let gateway: FhirGateway;
  let config: GatewayConfig | undefined;
  try {
    config = await loadConfig(opts.configPath);
    gateway = new FhirGateway(config);
  } catch {
    const profile = config?.source?.searchProfile;
    const code = profile !== undefined && !eligibleSearchProfileIds().includes(profile) ? 'PROFILE_INVALID' : 'CONFIG_INVALID';
    process.stderr.write(`fireboat: ${code}\n`); return 2;
  }
  if (opts.doctor) {
    try { return await runDoctor(gateway, config, release); }
    catch { process.stderr.write('fireboat: METADATA_UNAVAILABLE\n'); return 1; }
    finally { gateway.close(); }
  }
  // Normal serving stdout is reserved exclusively for MCP protocol traffic.
  // The SDK factory's era drives both the guard and per-call byte accounting.
  const handle = serveStdio(({ era }) => withEraGuard(createMcpServer(gateway, { era }), era), {
    onerror: () => { process.stderr.write('fireboat: TRANSPORT_ERROR\n'); },
  });
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Closing aborts a token request in flight, but a refresh releases its grant lock (and finishes a grant write it
    // started) asynchronously, so that is given a bounded moment before exiting. Tool requests are not waited for.
    void handle.close().catch(() => undefined).then(() => gateway.closeAndSettle(SHUTDOWN_SETTLE_MS)).catch(() => undefined)
      .finally(() => { process.exit(0); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // The client closing standard input ends the session: shut down the same way as on a signal. Like the SDK, treat
  // 'close' (a stream torn down without reaching its end) as the end of input too.
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  return 0;
}
