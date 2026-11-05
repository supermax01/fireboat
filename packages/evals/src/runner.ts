import { M3B_SCHEMA_VERSION } from '../../core/src/contracts.js';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import type { ClientRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { FhirGateway, toolEnvelopeV2Schemas, type GatewayEnvelope } from '../../core/src/index.js';
import { R4_SCHEMA } from '../../core/src/schema.js';
import { searchProfile, type SearchProfile } from '../../core/src/query.js';
import { createMcpServer } from '../../server/src/index.js';
import {
  ADVERSARIAL_RESOURCES, EVAL_PATIENT_ID, EVAL_SOURCE_ALIAS, GLOBAL_PROHIBITED, GOLDEN_RESOURCES, canonicalJson, fixtureSha256,
  evalDataText, fixtureBackendSha256, loadEvalCorpus, startEvalFixtureServer, type EvalFixtureServer, type GoldenResource,
} from './fixture.js';
import { ARM_ORDER, M3B_TASKS_SCHEMA_VERSION, parseM3bTaskFile, TASKS, USABILITY_TASKS, type ArmName, type EvalStep, type EvalTask, type KnownDefect, type ProtocolEra } from './tasks.js';
import { externalApplicability, externalCapabilityRevisionMatches, externalTasks, selectExternalTasks, verifyExternalBackend, type ExternalBackend, type ExternalIdentity, type ExternalApplicability } from './external.js';
import { SourceResponseObserver, type ObservedUpstreamRequest, type OpaqueLinkAcceptance, type UpstreamChain } from './upstream-provenance.js';
import {
  boundStep, collectEvidence, deepEqual, evaluateStepCheck, rawMember, resolveQueryChain, resourcesOf, searchRequests,
  type CallOutcomeRecord, type OracleCall, type CheckResult, type Failure, type FailureCause, type UpstreamWork,
} from './evidence-oracle.js';
// The oracle kernel moved to evidence-oracle.ts (packaging slice 7); the runner keeps its public names.
export { boundStep, collectEvidence, evaluateBoundCheck, evaluateCheck, evaluateStepCheck, resolvePath, resolveQueryChain, type CallOutcomeRecord, type OracleCall, type CheckResult, type CollectedEvidence, type Failure, type FailureCause, type Occurrence, type UpstreamWork } from './evidence-oracle.js';

export const EVAL_REPORT_SCHEMA = 'fhir-mcp-retrieval-eval/0.3' as const;
export const EVAL_PACKAGE_VERSION = '0.3.0' as const;
/** Negotiated protocol revision per era; legacy is whatever the SDK's 2025 handshake settles on. */
export const PROTOCOL_ERAS: Record<ProtocolEra, string | undefined> = { modern: '2026-07-28', legacy: undefined };
const BOUNDARY_SLACK = 16;

/** Declared usage: `warning_codes` is what the harness expects a private profile to label its successes with; per-call `observed_warning_codes` records what the envelope actually carried. */
export interface QueryProfileUsage { id: string; eligible: boolean; private: boolean; warning_codes: string[] }
export interface CallMetrics {
  query_profile: QueryProfileUsage;
  era: ProtocolEra; delivery_profile: string; host: string | null; corpus: string; stratum: string;
  packaged_bin: string | null; configured_max_bytes: number; configured_default_bytes: number;
  tokenizer: string | null; text_tokens: number | null; model_input_sha256: string | null;
  raw_result_sha256: string | null; text_sha256: string | null;
  work: UpstreamWork;
  /** Warning codes the envelope actually carried (empty for SDK-level outcomes without an envelope). */
  observed_warning_codes: string[];
  step: number; tool: string; wire_result_bytes: number; wire_frame_bytes: number; gateway_reported_bytes?: number; byte_limit?: number; /** The ceiling this call actually requested (input.output.max_bytes after placeholder resolution), measured independently of the gateway (V-32). */ requested_max_bytes?: number }
export interface TaskArmResult {
  task_id: string; category: string; arm: ArmName;
  /** `known-defect`: every failure matches a declared, agreed defect (an expected failure, reported, never hidden). */
  status: 'pass' | 'fail' | 'known-defect' | 'pending_profile_proof' | 'private_profile_control';
  query_profile: QueryProfileUsage;
  private_profile_verdict?: 'pass' | 'fail' | 'known-defect';
  skipped_profile_parts?: { step: number; part: string; reason: string }[];
  profile_proof_dependency?: { milestone: 'S6'; profile: string; reason: string };
  checks: CheckResult[]; failures: Failure[];
  known_defects: { jid: string; summary: string; reproduced: boolean }[];
  metrics: {
    tool_calls: number; upstream_calls: number; upstream_calls_gateway_reported: number;
    /** Sum of independently measured MCP tool-result values (JSON-RPC `result`), excluding framing. */
    result_bytes: number;
    /** Sum of the gateway's own budget.bytes_returned claims, for comparison only. */
    gateway_reported_bytes: number;
    /** Sum of whole JSON-RPC response messages including newline framing (descriptive). */
    frame_bytes: number;
    resources_returned: number;
  };
  calls: CallMetrics[];
  /** Independent source-issued link observations; no resource identities, URLs or opaque token text. */
  opaque_continuations: OpaqueLinkAcceptance[];
  budget: { max_bytes: number; max_upstream_calls: number; max_tool_calls: number };
  /** Descriptive only: never compared, never gates. */
  elapsed_ms_descriptive_only: number;
}
export interface ArmSummary {
  arm: ArmName; tasks_attempted: number; tasks_passed: number; tasks_failed: number; tasks_known_defect: number; tasks_pending_profile_proof: number; tasks_private_profile_control: number;
  checks_comparable: number; checks_passed: number; checks_failed: number; checks_known_defect: number; checks_incomparable: number; checks_pending_profile_proof: number;
  total_result_bytes: number; total_upstream_calls: number; total_tool_calls: number;
  failures_by_cause: Record<string, number>;
}
export interface EvalReport {
  external_backend?: { identity: ExternalIdentity; applicability: ExternalApplicability[]; omitted_inputs: ExternalBackend['corpus']['omitted']; input_transformations: ExternalBackend['corpus']['transformations'] };
  selection: { delivery_profile: string; host: string | null; corpus: string; stratum: string; packaged_bin: string | null; query_profiles: QueryProfileUsage[] };
  measurement: { tokenizer: string | null; model_input: 'unmeasured' | 'host_capture'; configured_default_bytes: number; configured_max_bytes: number; fragment_sha256: Record<string, string>; backend_sha256: string; raw_fixture_sha256: string };

  schema_version: typeof EVAL_REPORT_SCHEMA;
  eval_package_version: string;
  package_version: string;
  gateway_envelope_schema_version: string;
  r4_schema: { package: string; version: string; source_sha256: string; definitions: number };
  generated_at: string;
  code_revision: string;
  protocol: { era: ProtocolEra; negotiated_version: string; measurement: string };
  fixture: { sha256: string; resource_count: number; adversarial_resource_count: number; source_alias: string; trusted_patient: string };
  scope: string[];
  arms: { name: ArmName; description: string }[];
  task_count: number;
  /** Truthful denominator: tasks x formats are not independent cases. */
  denominator: { tasks: number; formats: number; task_format_runs: number; format_sensitive_tasks: number | null; format_insensitive_task_ids: string[] | null; primary_tasks: number; auxiliary_usability_tasks: number; statement: string };
  summary: {
    by_arm: ArmSummary[]; failures_by_cause: Record<string, number>; total_upstream_calls: number; total_result_bytes: number;
    known_defects: { task_id: string; arm: ArmName; jid: string; summary: string; reproduced: boolean }[];
    private_profile_controls: { task_id: string; arm: ArmName; profile: QueryProfileUsage; verdict: 'pass' | 'fail' | 'known-defect'; checks_passed: number; checks_failed: number; failures_by_cause: Record<string, number> }[];
    pending_profile_proof: { task_id: string; arm: ArmName; milestone: 'S6'; profile: string; reason: string }[];
    byte_accounting: { calls: number; under_reported_calls: number; over_reported_calls: number; max_under_report_bytes: number; max_over_report_bytes: number };
  };
  /** Wall-clock figures are descriptive only and are excluded from all pass/fail decisions. */
  timing_descriptive_only: { total_elapsed_ms: number };
  results: TaskArmResult[];
}

export interface RunEvalsOptions {
  /** Prepared, censused, independently persisted local backend; never enables fixture scenario behavior. */
  externalBackend?: ExternalBackend;
  tasks?: EvalTask[];
  corpus?: 'baseline' | 'query' | 'projection' | 'usability' | 'all';
  deliveryProfile?: 'full-text-v1' | 'structured-evidence-v1';
  host?: string; stratum?: string; packagedBin?: string;
  configuredMaxBytes?: number; configuredDefaultBytes?: number;
  tokenizer?: { name: string; count(text: string): number };
  modelInputHashes?: Readonly<Record<string, string>>;
  arms?: ArmName[];
  resources?: readonly GoldenResource[];
  era?: ProtocolEra;
  codeRevision?: string;
  packageVersion?: string;
  generatedAt?: string;
  /** S11's separate natural corpus: no fixture fragments or raw-body fallbacks are added to this selection. */
  naturalMeasurement?: {
    patientId: string;
    rawBodies: Readonly<Record<string, string>>;
    capture: (call: { task: string; arm: ArmName; era: ProtocolEra; step: number; tool: string;
      request: string; rawResult?: string; wireResultBytes: number; wireFrameBytes: number }) => void;
    catalog: (capture: { task: string; arm: ArmName; era: ProtocolEra; text: string }) => void;
  };
}

const ARM_DESCRIPTIONS: Record<ArmName, string> = {
  fhir: 'output.format=fhir, no field selection (full sanitized FHIR view)',
  compact: 'output.format=compact, no field selection (gateway compact projection)',
  selected: 'output.format=fhir with task fields as output.fields (question-selected fields)',
};

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Rec : undefined);


function armOutput(task: EvalTask, arm: ArmName, tool: string): Record<string, unknown> {
  const maxBytes = task.perCallBytes ?? 24576;
  if (arm === 'compact') return { format: 'compact', max_bytes: maxBytes };
  if (arm === 'fhir') return { format: 'fhir', max_bytes: maxBytes };
  // selected: field selection only where the tool returns resources.
  const withFields = ['fhir_search', 'fhir_read', 'fhir_page'].includes(tool) && task.fields?.length;
  return { format: 'fhir', max_bytes: maxBytes, ...(withFields ? { fields: task.fields } : {}) };
}

function resolvePlaceholders(value: unknown, envelopes: GatewayEnvelope[]): unknown {
  if (typeof value === 'string') {
    const handle = /^\{\{handle:(\d+)\}\}$/.exec(value);
    if (handle) return envelopes[Number(handle[1])]?.result?.handle ?? '';
    const cursor = /^\{\{cursor:(\d+)\}\}$/.exec(value);
    if (cursor) return envelopes[Number(cursor[1])]?.pagination?.next_cursor ?? '';
    const discoveryCursor = /^\{\{discovery_cursor:(\d+)\}\}$/.exec(value);
    if (discoveryCursor) return envelopes[Number(discoveryCursor[1])]?.data.next_cursor ?? '';
    const bytes = /^\{\{bytes:(\d+)\}\}$/.exec(value);
    if (bytes) return Math.min(131072, Math.max(4096, (envelopes[Number(bytes[1])]?.budget.bytes_returned ?? 0) + BOUNDARY_SLACK));
    return value;
  }
  if (Array.isArray(value)) return value.map(v => resolvePlaceholders(v, envelopes));
  const rec = asRec(value);
  if (rec) return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, resolvePlaceholders(v, envelopes)]));
  return value;
}

interface CallOutcome { result: Rec; wireResultBytes: number; wireFrameBytes: number; /** Server-emitted serialized result text (§9 raw wire text). */ resultText?: string; /** Set when the SDK client rejected the call at protocol level. */ protocolError?: { code: number | string } }
interface McpSession { negotiatedVersion: string; call(tool: string, args: Rec): Promise<CallOutcome>; close(): Promise<void> }

/**
 * A real SDK client/server pair over a stdio-shaped in-memory transport. The server side is the production
 * serveStdio entry with the production tool adapter; result bytes are measured from the JSON-RPC messages the server
 * actually emits, independently of the gateway's own byte accounting (G-7).
 */
async function openSession(gateway: FhirGateway, era: ProtocolEra, options: RunEvalsOptions = {}, config?: unknown): Promise<McpSession> {
  if (options.packagedBin) return openPackagedSession(options.packagedBin, era, config);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const responses = new Map<string | number, { resultBytes: number; frameBytes: number; resultText?: string }>();
  const serverSend = serverSide.send.bind(serverSide);
  serverSide.send = async (message: JSONRPCMessage, options?: Parameters<Transport['send']>[1]) => {
    const rec = message as Rec;
    if ((typeof rec.id === 'string' || typeof rec.id === 'number') && ('result' in rec || 'error' in rec)) {
      const resultText = 'result' in rec ? JSON.stringify(rec.result) : undefined;
      responses.set(rec.id, { resultBytes: resultText ? Buffer.byteLength(resultText) : 0, frameBytes: Buffer.byteLength(`${JSON.stringify(message)}\n`), ...(resultText !== undefined ? { resultText } : {}) });
    }
    return serverSend(message, options);
  };
  let lastCallId: string | number | undefined;
  const clientSend = clientSide.send.bind(clientSide);
  clientSide.send = async (message: JSONRPCMessage, options?: Parameters<Transport['send']>[1]) => {
    const rec = message as Rec;
    if (rec.method === 'tools/call' && (typeof rec.id === 'string' || typeof rec.id === 'number')) lastCallId = rec.id;
    return clientSend(message, options);
  };
  const handle = serveStdio(({ era: instanceEra }) => createMcpServer(gateway, { era: instanceEra }), { transport: serverSide });
  const pin = PROTOCOL_ERAS[era];
  const client = new Client({ name: 'fhir-mcp-retrieval-eval', version: EVAL_PACKAGE_VERSION }, pin ? { versionNegotiation: { mode: { pin } } } : undefined);
  try { await client.connect(clientSide); } catch (error) { await handle.close().catch(() => undefined); throw error; }
  if (client.getProtocolEra() !== era) throw new Error(`negotiated ${client.getProtocolEra() ?? 'no'} era, expected ${era}`);
  if (options.naturalMeasurement) {
    try {
      const tools = []; let cursor: string | undefined; const seen = new Set<string>();
      do {
        const page = await client.listTools(cursor ? { cursor } : {}); tools.push(...page.tools); cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('S11 catalog cursor repeated.');
        if (cursor) seen.add(cursor);
        if (seen.size > 32) throw new Error('S11 catalog page cap.');
      } while (cursor);
      // The caller installs the task/arm labels; discovery is captured at the real SDK boundary.
      options.naturalMeasurement.catalog({ task: '', arm: 'fhir', era, text: JSON.stringify({
        serverInfo: client.getServerVersion(), capabilities: client.getServerCapabilities(), instructions: client.getInstructions(), tools }) });
    } catch (error) { await client.close().catch(() => undefined); await handle.close().catch(() => undefined); throw error; }
  }
  return {
    negotiatedVersion: client.getNegotiatedProtocolVersion() ?? 'unknown',
    async call(tool, args) {
      lastCallId = undefined;
      let result: Rec;
      try {
        result = await client.callTool({ name: tool, arguments: args }) as Rec;
      } catch (error) {
        // Protocol-level outcome (G-3e): the client rejected the call (e.g. output
        // validation). Record class+code; never fabricate an envelope for it.
        const measured = lastCallId === undefined ? undefined : responses.get(lastCallId);
        const code = (error as { code?: unknown })?.code;
        return { result: {}, wireResultBytes: measured?.resultBytes ?? 0, wireFrameBytes: measured?.frameBytes ?? 0, ...(measured?.resultText !== undefined ? { resultText: measured.resultText } : {}), protocolError: { code: typeof code === 'number' || typeof code === 'string' ? code : 'json_rpc_error' } };
      }
      const measured = lastCallId === undefined ? undefined : responses.get(lastCallId);
      if (!measured) throw new Error('tool response was not observed on the transport');
      return { result, wireResultBytes: measured.resultBytes, wireFrameBytes: measured.frameBytes, ...(measured.resultText !== undefined ? { resultText: measured.resultText } : {}) };
    },
    async close() { await client.close().catch(() => undefined); await handle.close().catch(() => undefined); },
  };
}

const hasTrustedConstraint = (constraints: unknown, type: string): boolean => Array.isArray(constraints) && constraints.map(asRec).some(c =>
  type === 'Patient' ? c?.name === '_id' && c.value === EVAL_PATIENT_ID : (c?.name === 'patient' || c?.name === 'subject') && [EVAL_PATIENT_ID, `Patient/${EVAL_PATIENT_ID}`].includes(String(c.value)));
const EXPECTED_SCOPE: Record<EvalStep['tool'], string> = { fhir_capabilities: 'metadata', fhir_read: 'resource', fhir_search: 'page', fhir_page: 'page', fhir_result: 'retained' };

/** Select a top-level JSON member without decoding/re-encoding its numeric tokens. */
async function openPackagedSession(bin: string, era: ProtocolEra, config: unknown): Promise<McpSession> {
  const directory = await mkdtemp(join(tmpdir(), 'fireboat-eval-'));
  const file = join(directory, 'config.json'); await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, [resolve(bin), '--config', file], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  const measured = new Map<string | number, { resultText?: string; resultBytes: number; frameBytes: number }>();
  let lastId: string | number | undefined, buffer = '';
  const transport: Transport = {
    async start() {},
    async send(message) { const m = message as Rec; if ((m.method === 'tools/call') && (typeof m.id === 'string' || typeof m.id === 'number')) lastId = m.id;
      await new Promise<void>((ok, fail) => child.stdin.write(`${JSON.stringify(message)}\n`, error => error ? fail(error) : ok())); },
    async close() { child.kill(); await rm(directory, { recursive: true, force: true }); },
  };
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => {
    buffer += chunk; let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { const message = JSON.parse(line) as JSONRPCMessage; const rec = message as Rec;
        if ((typeof rec.id === 'string' || typeof rec.id === 'number') && ('result' in rec || 'error' in rec)) {
          const resultText = rawMember(line, 'result'); measured.set(rec.id, { resultText, resultBytes: resultText === undefined ? 0 : Buffer.byteLength(resultText), frameBytes: Buffer.byteLength(line + '\n') });
        }
        transport.onmessage?.(message);
      } catch { transport.onerror?.(new Error('Invalid packaged-bin JSON-RPC frame.')); }
    }
  });
  child.stderr.resume(); child.on('error', () => transport.onerror?.(new Error('Packaged bin failed to start.')));
  const pin = PROTOCOL_ERAS[era], client = new Client({ name: 'fireboat-eval-packaged', version: EVAL_PACKAGE_VERSION }, pin ? { versionNegotiation: { mode: { pin } } } : undefined);
  try { await client.connect(transport); } catch (error) { await transport.close(); throw error; }
  if (client.getProtocolEra() !== era) { await client.close(); await transport.close(); throw new Error('Packaged bin negotiated the wrong protocol era.'); }
  return { negotiatedVersion: client.getNegotiatedProtocolVersion() ?? 'unknown',
    async call(tool, args) {
      try { const result = await client.callTool({ name: tool, arguments: args }); const m = measured.get(lastId!)!; return { result: result as Rec, wireResultBytes: m.resultBytes, wireFrameBytes: m.frameBytes, resultText: m.resultText }; }
      catch (error) { const m = measured.get(lastId!); return { result: {}, wireResultBytes: m?.resultBytes ?? 0, wireFrameBytes: m?.frameBytes ?? 0, protocolError: { code: (error as { code?: number }).code ?? 'unknown' } }; }
    }, async close() { await client.close(); await transport.close(); } };
}

/**
 * full-text-v1 delivers the envelope only as text: exactly one text block that is byte-for-byte the raw
 * structuredContent member the server emitted (sliced, never re-encoded, so numeric spellings are compared as sent).
 * The examples/quickstart verifier applies the same rule to installed runs.
 */
export function fullTextMatchesStructured(content: unknown, resultText: string | undefined): boolean {
  const block = Array.isArray(content) && content.length === 1 ? asRec(content[0]) : undefined;
  let raw: string | undefined;
  try { raw = resultText === undefined ? undefined : rawMember(resultText, 'structuredContent'); } catch { raw = undefined; }
  return block?.type === 'text' && typeof block.text === 'string' && raw !== undefined && block.text === raw;
}

interface CallRecord { deliveredText?: string; input?: Rec; requestedPageSize?: number; metadataOffset?: number; step: number; tool: EvalStep['tool']; resourceType?: string; action?: 'inspect' | 'project' | 'page'; offset?: number; envelope: GatewayEnvelope; metrics: CallMetrics; rawText?: string; outcome?: CallOutcomeRecord }
/** Per-run fields consumed by runEvals and stripped before reporting. */
interface Internal { negotiatedVersion: string; signature: string }

// These tasks require the closed execution profile. With no eligible profile
// (the S6 rollback path) their named proof checks are a prerequisite outcome,
// never an allowed error or a successful verdict; with the qualified profile
// the ordinary runner executes and scores them. No wildcard task, error,
// check or profile is accepted here.
const PROFILE_PROOF_DEPENDENCIES: Readonly<Record<string, string>> = Object.freeze({
  'query-complete-proven': 'S6 must qualify code/date membership proof.',
  'query-cross-page-sort': 'S6 must qualify descending clinical-date proof across pages.',
  'query-ignore-code': 'S6 must qualify code contradiction detection.',
  'query-ignore-date-lower': 'S6 must qualify lower-date contradiction detection.',
  'query-ignore-date-upper': 'S6 must qualify upper-date contradiction detection.',
  'query-ignore-sort-proven': 'S6 must qualify sort contradiction detection.',
  'query-empty-page-with-next-proven': 'S6 must qualify the offset-link negative control (a skipped window is never proof).',
  'hapi-code-membership': 'The external candidate must qualify exact system-qualified code membership.',
  'hapi-code-date-window': 'The external candidate must qualify exact code and ge/lt date-window membership.',
  'hapi-date-lower-discrimination': 'The external candidate must independently discriminate the ge lower bound.',
  'hapi-date-upper-discrimination': 'The external candidate must independently discriminate the lt upper bound.',
});
// Only these assertions require source-execution proof. Every other assertion,
// invariant, prohibited-marker scan and byte/work budget still runs publicly.
const PROFILE_DEPENDENT_CHECKS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'query-complete-proven': ['q1', 'q2'], 'query-cross-page-sort': ['q1'],
  'query-ignore-code': ['q1'], 'query-ignore-date-lower': ['q1'], 'query-ignore-date-upper': ['q1'],
  'query-ignore-sort-proven': ['q1'], 'query-empty-page-with-next-proven': ['q2', 'q3', 'q4'],
  'hapi-code-membership': ['proof-0', 'label-0', 'proof-1', 'label-1'],
  'hapi-code-date-window': ['proof-0', 'label-0'],
  'hapi-date-lower-discrimination': ['proof-0', 'label-0'],
  'hapi-date-upper-discrimination': ['proof-0', 'label-0'],
});
// S6: a public qualified profile proves execution only against the exact fixture data and backend module its
// evidence was recorded on. The expected digests are computed from what this process serves and executes.
let expectedProfileHashes: { fixture: string; backend: string; tasks: string } | undefined;
/** The query fragment's resources as the default corpus serves them (the digest the registry pins). */
export function queryFragmentResources(): readonly GoldenResource[] {
  const corpus = loadEvalCorpus();
  return corpus.byCorpus.query!.slice(corpus.byCorpus.baseline!.length);
}
export function profileDrift(profile: SearchProfile, external?: ExternalIdentity): string | undefined {
  if (profile.source.kind === 'external') {
    if (!external) return 'external identity missing';
    if (profile.source.software !== external.software) return 'software drift';
    if (profile.source.software_version !== external.software_version) return 'software_version drift';
    if (profile.source.fhir_version !== external.fhir_version) return 'fhir_version drift';
    if (profile.source.image_digest !== external.image_digest) return 'image_digest drift';
    if (profile.source.corpus_sha256 !== external.corpus_sha256) return 'corpus_sha256 drift';
    if (profile.evidence?.capability_revision !== external.capability_revision) return 'capability_revision drift';
    if (profile.evidence?.tasks_sha256 !== external.tasks_sha256) return 'tasks_sha256 drift';
    return undefined;
  }
  if (external) return 'synthetic profile cannot prove an external backend';
  expectedProfileHashes ??= {
    fixture: fixtureSha256(undefined, undefined, undefined, queryFragmentResources()), backend: fixtureBackendSha256(),
    tasks: createHash('sha256').update(canonicalJson(parseM3bTaskFile(evalDataText('data/m3b-query-tasks.json')))).digest('hex'),
  };
  if (profile.source.fixture_sha256 !== expectedProfileHashes.fixture) return `fixture_sha256 ${profile.source.fixture_sha256 ?? 'unset'} differs from the served fixture ${expectedProfileHashes.fixture}`;
  if (profile.source.backend_sha256 !== expectedProfileHashes.backend) return `backend_sha256 ${profile.source.backend_sha256 ?? 'unset'} differs from the executing backend module ${expectedProfileHashes.backend}`;
  if (profile.evidence?.tasks_sha256 !== expectedProfileHashes.tasks) return `evidence.tasks_sha256 ${profile.evidence?.tasks_sha256 ?? 'unset'} differs from the query task corpus ${expectedProfileHashes.tasks}`;
  return undefined;
}
interface PrivateEvalTestOptions {
  testQueryProfile?: SearchProfile;
  /** S6 rollback path: run as if no public profile were eligible, so the pending_profile_proof machinery stays testable. */
  simulateIneligibleProfile?: boolean;
}

/** Per-response invariants for every arm: schema, coverage scope, provenance/version, paging and the byte ceiling. */
export function responseInvariants(record: CallRecord, trustedPatientId: string = EVAL_PATIENT_ID): Failure[] {
  const { envelope, step, tool } = record;
  const failures: Failure[] = [];
  const add = (cause: FailureCause, detail: string) => failures.push({ cause, detail, step });
  if (!toolEnvelopeV2Schemas[tool].safeParse(envelope).success) add('envelope_invalid', `envelope ${envelope.request_id} failed schema validation`);
  if (!['complete_for_query', 'partial', 'unknown'].includes(envelope.coverage.state) || !Array.isArray(envelope.coverage.reasons)) add('coverage_invalid', `envelope ${envelope.request_id} has invalid coverage`);
  if (record.metrics.byte_limit !== undefined && record.metrics.wire_result_bytes > record.metrics.byte_limit) add('call_byte_limit_exceeded', `measured MCP result ${record.metrics.wire_result_bytes} bytes exceeds the requested ${record.metrics.byte_limit}-byte ceiling (gateway reported ${record.metrics.gateway_reported_bytes})`);
  // V-32: the ceiling is what the harness requested, never the gateway's own byte_limit claim — a gateway that
  // inflates byte_limit (mutant E6) must fail here even when its inflated limit covers the measured bytes.
  if (record.metrics.requested_max_bytes !== undefined && record.metrics.wire_result_bytes > record.metrics.requested_max_bytes) add('call_byte_limit_exceeded', `measured MCP result ${record.metrics.wire_result_bytes} bytes exceeds the ${record.metrics.requested_max_bytes}-byte ceiling this call requested (gateway reported ${record.metrics.gateway_reported_bytes})`);
  if (record.metrics.requested_max_bytes !== undefined && record.metrics.byte_limit !== undefined && record.metrics.byte_limit > record.metrics.requested_max_bytes) add('call_byte_limit_exceeded', `gateway reported a ${record.metrics.byte_limit}-byte ceiling above the ${record.metrics.requested_max_bytes}-byte ceiling this call requested`);
  if ((envelope.coverage.query_evidence === 'none') !== Boolean(envelope.error)) add('coverage_invalid', 'none evidence is required iff an application error is present');
  if (envelope.error) {
    if (Object.keys(envelope.data).length || envelope.provenance || envelope.result || envelope.pagination || envelope.warnings.length || envelope.coverage.query_exhausted !== null) add('coverage_invalid', 'error retains successful evidence or controls');
    return failures;
  }
  const byteWarning = envelope.warnings.filter(w => w.code === 'METADATA_BYTE_LIMIT');
  if (tool === 'fhir_capabilities') {
    const d = envelope.data, input = record.input ?? {}, topic = input.topic ?? 'server';
    if ((topic === 'server' || topic === 'context') && d.patient_id !== trustedPatientId) add('coverage_invalid', 'metadata binding disagrees with the trusted patient');
    const rowKey = topic === 'server' ? 'resources' : topic === 'support' ? 'rows' : topic === 'search_parameter' ? 'search_parameters' : topic === 'schema' ? 'elements' : undefined;
    if (rowKey) {
      const rows = Array.isArray(d[rowKey]) ? d[rowKey] as unknown[] : [], offset = record.metadataOffset ?? 0;
      const total = Number(topic === 'server' ? d.resource_count : topic === 'search_parameter' ? d.total_parameters : topic === 'schema' ? d.total_elements : input.resource_type ? 1 : 25);
      const limit = Math.min(Number(input.limit ?? 20), topic === 'support' ? 25 : 50), eligible = Math.min(limit,total-offset);
      const more = offset + rows.length < total, reduced = rows.length < eligible;
      if (rows.length > eligible || (eligible > 0 && !rows.length) || envelope.coverage.query_exhausted !== !more || envelope.coverage.state !== (more ? 'partial' : 'complete_for_query')) add('pagination_invalid', 'metadata slice and exhaustion disagree');
      if (topic === 'schema' ? d.next_offset !== (more ? offset + rows.length : undefined) : Boolean(d.next_cursor) !== more) add('pagination_invalid', 'metadata continuation does not advance over exactly delivered rows');
      if (topic !== 'schema' && (d.snapshot_revision !== envelope.source.capability_revision || !(Date.parse(String(d.expires_at)) > Date.parse(String(d.captured_at))))) add('coverage_invalid', 'metadata revision/freshness invalid');
      if (byteWarning.length !== Number(reduced) || envelope.budget.limit_reached !== reduced || byteWarning.some(w => w.message !== 'Metadata rows were reduced to fit the byte budget; follow the returned continuation.')) add('coverage_invalid', 'metadata byte warning is not bound to independent eligible-row accounting');
      if (topic === 'server' && offset === 0 && Number(d.resource_count) >= 8 && (rows[0] as Rec)?.type !== 'Patient') add('coverage_invalid', 'advertised workflow type lost server priority');
    } else if (byteWarning.length) add('coverage_invalid', 'non-row metadata carries byte warning');
  } else if (byteWarning.length) add('coverage_invalid', 'clinical result carries metadata byte warning');
  if ((tool === 'fhir_search' || tool === 'fhir_page') && (envelope.pagination?.requested_page_size !== record.requestedPageSize || Number(envelope.pagination?.returned_matches) > Number(record.requestedPageSize))) add('pagination_invalid', 'search delivery exceeds or misreports its original requested count');
  if ((tool === 'fhir_search' || tool === 'fhir_page') && envelope.coverage.query_evidence === 'unverified_continuation' && !envelope.pagination?.next_cursor && (envelope.pagination?.has_more !== null || envelope.coverage.query_exhausted !== null)) add('pagination_invalid', 'terminal unverified chain falsely declares a stop/exhaustion');
  if (envelope.coverage.scope !== EXPECTED_SCOPE[tool]) add('coverage_invalid', `${tool} response has coverage scope ${envelope.coverage.scope}, expected ${EXPECTED_SCOPE[tool]}`);
  const resources = resourcesOf(envelope);
  // Metadata results list capability summaries under data.resources; only clinical-resource scopes carry provenance.
  if (envelope.coverage.scope !== 'metadata' && Array.isArray(envelope.data.resources)) {
    if ((envelope.provenance?.length ?? 0) !== resources.length) add('provenance_missing', `${resources.length} resources but ${envelope.provenance?.length ?? 0} provenance entries`);
    for (const [index, resource] of resources.entries()) {
      const matching = envelope.provenance?.filter(p => p.resource_index === index && Number.isFinite(Date.parse(p.retrieved_at)));
      if (matching?.length !== 1) add('provenance_missing', 'Returned evidence lacks exact response-local indexed provenance.');
    }
  }
  if (envelope.coverage.query_exhausted === undefined) add('coverage_invalid', 'Explicit query exhaustion is required.');
  if (envelope.coverage.query_exhausted === true && envelope.pagination?.has_more !== false && envelope.pagination !== undefined) add('coverage_invalid', 'Exhaustion contradicts pagination.');
  if (envelope.coverage.constraints?.some(c => c.execution === 'unknown' && c.evidence_ref !== undefined)) add('coverage_invalid', 'Unknown execution cannot carry proof.');
  if (envelope.coverage.sort?.order === 'requested_unverified' && envelope.coverage.sort.effective !== null) add('coverage_invalid', 'Unverified ordering has no effective sort.');
  if (envelope.pagination) {
    if (tool === 'fhir_search' || tool === 'fhir_page' || tool === 'fhir_read') {
      if ((envelope.pagination.has_more === true) !== Boolean(envelope.pagination.next_cursor)) add('pagination_invalid', 'clinical has_more=true and next_cursor must appear together');
      if (envelope.data.next_offset !== undefined) add('pagination_invalid', 'clinical paging cannot use a retained offset');
    } else if (tool === 'fhir_result' && record.action !== 'inspect') {
      const next = envelope.data.next_offset;
      if ((envelope.pagination.has_more === true) !== (next !== undefined) || envelope.pagination.next_cursor !== undefined
        || (next !== undefined && next !== (record.offset ?? 0) + resources.length)) add('pagination_invalid', 'retained paging requires an advancing next_offset and no cursor');
    }
    if (envelope.pagination.returned_matches !== resources.length || envelope.pagination.returned_includes !== 0) add('pagination_invalid', 'Delivered match/include counts disagree with response resources.');
  }
  if (tool === 'fhir_result' && record.action === 'inspect') {
    const rows = Array.isArray(envelope.data.omissions) ? envelope.data.omissions : [];
    const next = envelope.data.next_offset, count = envelope.data.resource_count;
    if (envelope.pagination !== undefined || (next !== undefined && (next !== (record.offset ?? 0) + rows.length
      || typeof count !== 'number' || typeof next !== 'number' || next >= count || rows.length === 0))) add('pagination_invalid', 'inspection offsets address omission rows without clinical pagination');
  }
  return failures;
}

function classify(task: EvalTask, era: ProtocolEra, failures: Failure[], checks: CheckResult[]): Pick<TaskArmResult, 'status' | 'failures' | 'known_defects'> {
  const applicable = (task.knownDefects ?? []).filter(defect => !defect.eras || defect.eras.includes(era));
  const matches = (defect: KnownDefect, failure: Failure) => defect.match.some(m => (!m.cause || m.cause === failure.cause) && (!m.checkId || m.checkId === failure.check_id));
  const tagged = failures.map(failure => { const defect = applicable.find(d => matches(d, failure)); return defect ? { ...failure, known_defect: defect.jid } : failure; });
  for (const check of checks) if (check.status === 'fail') { const defect = applicable.find(d => matches(d, { cause: check.cause ?? 'harness_error', detail: '', check_id: check.check_id })); if (defect) check.known_defect = defect.jid; }
  const known_defects = applicable.map(defect => ({ jid: defect.jid, summary: defect.summary, reproduced: failures.some(failure => matches(defect, failure)) }));
  for (const defect of known_defects) if (!defect.reproduced) tagged.push({ cause: 'known_defect_resolved', detail: `${defect.jid} no longer reproduces (${defect.summary}); remove this knownDefects marker` });
  const unexpected = tagged.filter(failure => !failure.known_defect);
  return { status: unexpected.length ? 'fail' : tagged.length ? 'known-defect' : 'pass', failures: tagged, known_defects };
}

async function runTaskArm(task: EvalTask, arm: ArmName, fixture: EvalFixtureServer, era: ProtocolEra, versions: ReadonlyMap<string, string>, options: RunEvalsOptions = {}, testOptions?: PrivateEvalTestOptions): Promise<TaskArmResult & Internal> {
  const started = Date.now();
  const dependency = Object.hasOwn(PROFILE_PROOF_DEPENDENCIES, task.id) ? PROFILE_PROOF_DEPENDENCIES[task.id] : undefined;
  const profileId = options.externalBackend ? 'hapi-r4-labs-v1' : 'synthetic-fixture-r4-v1';
  const enabledProfile = dependency ? testOptions?.testQueryProfile ?? (testOptions?.simulateIneligibleProfile ? undefined : searchProfile(profileId)) : undefined;
  if (enabledProfile && !testOptions?.testQueryProfile) {
    const drift = profileDrift(enabledProfile, options.externalBackend?.identity);
    if (drift) throw new Error(`search profile ${enabledProfile.id} is stale and cannot prove execution here: ${drift}`);
  }
  const pendingProfile = Boolean(dependency && !enabledProfile);
  const skippedProfileParts: NonNullable<TaskArmResult['skipped_profile_parts']> = [];
  const privateProfile = Boolean(dependency && testOptions?.testQueryProfile);
  const usedProfile = enabledProfile ?? searchProfile('generic-r4')!;
  const queryProfile: QueryProfileUsage = { id: usedProfile.id, eligible: usedProfile.eligible,
    private: privateProfile, warning_codes: privateProfile ? ['TEST_QUERY_EVIDENCE'] : [] };
  if ((testOptions?.testQueryProfile || testOptions?.simulateIneligibleProfile) && options.packagedBin) throw new Error('Private profile tests require the in-process production factory.');
  const failures: Failure[] = [];
  const records: CallRecord[] = [];
  const retainedTypes = new Map<string, string>();
  const envelopes: GatewayEnvelope[] = [];
  const stepRequests: string[][] = task.steps.map(() => []);
  const stepObserved: ObservedUpstreamRequest[][] = task.steps.map(() => []);
  // The trusted patient is the one this harness configures the gateway with (S11's natural patient, else the golden
  // fixture's); the independent upstream observer and the metadata invariant judge confinement against it, never against
  // an identity read back from a response.
  const trustedPatientId = options.naturalMeasurement?.patientId ?? EVAL_PATIENT_ID;
  const observer = new SourceResponseObserver(fixture.baseUrl, `${task.id}/${arm}`, Boolean(options.packagedBin), trustedPatientId);
  const cursorChains = new Map<string, UpstreamChain>();
  const cursorSizes = new Map<string, number>(), discoveryOffsets = new Map<string, number>();
  const requestsBefore = fixture.requestCount();
  fixture.setMode(task.fixtureMode);
  fixture.selectScenario(task.id);
  const config = {
    mode: 'synthetic',
    source: { alias: EVAL_SOURCE_ALIAS, baseUrl: fixture.baseUrl, ...(enabledProfile && !testOptions?.testQueryProfile ? { searchProfile: profileId } : {}) },
    delivery: { profile: options.deliveryProfile ?? 'full-text-v1', ...(options.host ? { hostProfileId: options.host } : {}) },
    limits: { maxBytes: options.configuredMaxBytes ?? 131072, defaultBytes: options.configuredDefaultBytes ?? 24576, ...(options.packagedBin && task.id === 'p-guidance-expired-handle' ? { ttlMs: 100 } : {}) },
    patientId: trustedPatientId,
    contextId: 'eval-context-v0',
  } as const;
  // Public config still validates its closed eligible-profile enum. This
  // selection is the ordinary public one (S6 made the ID eligible); a stale profile was refused above.
  const gateway = new FhirGateway(config as ConstructorParameters<typeof FhirGateway>[0], enabledProfile && testOptions?.testQueryProfile ? { testQueryProfile: enabledProfile } : undefined);
  let session: McpSession | undefined;
  class BudgetStop extends Error {}
  const measuredBytes = () => records.reduce((sum, record) => sum + record.metrics.wire_result_bytes, 0);
  const enforceBudget = (beforeCall: boolean): void => {
    const bytes = measuredBytes();
    const upstream = fixture.requestCount() - requestsBefore;
    const limits: [boolean, FailureCause, string][] = [
      [beforeCall ? records.length >= task.budget.maxToolCalls : records.length > task.budget.maxToolCalls, 'budget_tool_calls_exceeded', 'tool-call budget exhausted'],
      [beforeCall ? bytes >= task.budget.maxBytes : bytes > task.budget.maxBytes, 'budget_bytes_exceeded', 'measured response-byte budget exhausted'],
      [upstream > task.budget.maxUpstreamCalls, 'budget_upstream_calls_exceeded', 'upstream-call budget exhausted'],
    ];
    const exceeded = limits.find(([condition]) => condition);
    if (exceeded) { failures.push({ cause: exceeded[1], detail: exceeded[2] }); throw new BudgetStop(); }
  };
  const call = async (step: number, tool: EvalStep['tool'], input: Rec, resourceType?: string): Promise<GatewayEnvelope | undefined> => {
    resourceType ??= typeof input.handle === 'string' ? retainedTypes.get(input.handle) : undefined;
    enforceBudget(true);
    const before = fixture.requestCount();
    const observedBefore = observer.provenance.requests.length;
    const context = tool === 'fhir_page' && typeof input.cursor === 'string' ? cursorChains.get(input.cursor) : undefined;
    const chain: UpstreamChain = context ?? { chain: `call:${records.length}`, query: canonicalJson({ resourceType, params: input.params ?? [] }), resourceType };
    resourceType ??= chain.resourceType;
    observer.beginCall(chain);
    let outcome: Awaited<ReturnType<McpSession['call']>>;
    try { outcome = await session!.call(tool, input); }
    finally { observer.endCall(); stepObserved[step]!.push(...observer.provenance.requests.slice(observedBefore)); }
    stepRequests[step]!.push(...fixture.requests().slice(before));
    options.naturalMeasurement?.capture({ task: task.id, arm, era, step, tool,
      request: JSON.stringify({ name: tool, arguments: input }), ...(outcome.resultText === undefined ? {} : { rawResult: outcome.resultText }),
      wireResultBytes: outcome.wireResultBytes, wireFrameBytes: outcome.wireFrameBytes });
    const envelope = outcome.protocolError ? undefined : asRec(outcome.result.structuredContent) as GatewayEnvelope | undefined;
    if (envelope?.pagination?.next_cursor) cursorChains.set(envelope.pagination.next_cursor, chain);
    if (options.externalBackend && envelope && !externalCapabilityRevisionMatches(envelope.source.capability_revision, options.externalBackend.identity.capability_revision, Boolean(envelope.error))) {
      failures.push({ cause: 'harness_error', detail: 'External capability revision changed during the task.', step });
    }
    const requestedMaxBytes = asRec(input.output)?.max_bytes;
    const observedWork = fixture.requests().slice(before);
    const renderedText = Array.isArray(outcome.result.content) ? (outcome.result.content as Rec[]).filter(c => c.type === 'text').map(c => String(c.text)).join('\n') : '';
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const tokenCount = options.tokenizer?.count(renderedText);
    if (tokenCount !== undefined && (!Number.isSafeInteger(tokenCount) || tokenCount < 0)) throw new Error('Invalid tokenizer measurement.');
    const modelHash = options.modelInputHashes?.[`${task.id}/${arm}/${step}/${records.filter(r => r.step === step).length}`];
    if (modelHash !== undefined && !/^[a-f0-9]{64}$/.test(modelHash)) throw new Error('Invalid model input hash.');
    const metrics: CallMetrics = { query_profile: queryProfile, era, delivery_profile: envelope?.transform.delivery_profile ?? options.deliveryProfile ?? 'full-text-v1', host: options.host ?? null,
      corpus: task.corpus ?? 'baseline', stratum: options.stratum ?? 'synthetic', packaged_bin: options.packagedBin ?? null,
      configured_max_bytes: options.configuredMaxBytes ?? 131072, configured_default_bytes: options.configuredDefaultBytes ?? 24576,
      tokenizer: options.tokenizer?.name ?? null, text_tokens: tokenCount ?? null, model_input_sha256: modelHash ?? null,
      raw_result_sha256: outcome.resultText === undefined ? null : hash(outcome.resultText), text_sha256: renderedText ? hash(renderedText) : null,
      work: { metadata: observedWork.filter(p => new URL(p, fixture.baseUrl).pathname.endsWith('/metadata')).length, auth: 0,
        clinical: observedWork.filter(p => !new URL(p, fixture.baseUrl).pathname.endsWith('/metadata')).length },
      observed_warning_codes: envelope ? envelope.warnings.map(w => w.code) : [],
      step, tool, wire_result_bytes: outcome.wireResultBytes, wire_frame_bytes: outcome.wireFrameBytes, ...(typeof requestedMaxBytes === 'number' ? { requested_max_bytes: requestedMaxBytes } : {}), ...(envelope ? { gateway_reported_bytes: envelope.budget.bytes_returned, byte_limit: envelope.budget.byte_limit } : {}) };
    // The host's model input is the delivered text, not structuredContent: a text-only change (even an equal-byte
    // substitution that leaves every structured check and the byte accounting unchanged) fails here.
    if (envelope && (options.deliveryProfile ?? 'full-text-v1') === 'full-text-v1' && !fullTextMatchesStructured(outcome.result.content, outcome.resultText)) {
      failures.push({ cause: 'data_mismatch', detail: 'delivered full-text-v1 text differs from the raw structuredContent', step });
    }
    if (privateProfile && envelope && !envelope.error && !envelope.warnings.some(w => w.code === 'TEST_QUERY_EVIDENCE')) {
      failures.push({ cause: 'private_profile_label_missing', detail: 'private query profile success carried no TEST_QUERY_EVIDENCE warning', step });
    }
    if (!envelope) {
      // G-3e: classify the missing-envelope outcome; an explicitly expected
      // callOutcome for this step is an expected result, not a harness failure.
      const record: CallOutcomeRecord = outcome.protocolError
        ? { class: 'json_rpc_error', code: outcome.protocolError.code }
        : { class: 'sdk_text_error', code: 'sdk_text_error' };
      records.push({ step, tool, envelope: { data: {} } as GatewayEnvelope, metrics, ...(outcome.resultText !== undefined ? { rawText: outcome.resultText } : {}), outcome: record });
      const expected = task.checks.some(c => c.kind === 'callOutcome' && (c.step ?? 0) === step && c.outcome === record.class && String(c.code) === String(record.code));
      if (!expected) failures.push({ cause: 'sdk_tool_error', detail: 'tool result carried no gateway envelope (SDK-level rejection)', step });
      enforceBudget(false);
      return undefined;
    }
    const requestedPageSize = tool === 'fhir_search' ? Number(input.page_size ?? 20) : tool === 'fhir_page' ? cursorSizes.get(String(input.cursor)) : undefined;
    if (envelope.pagination?.next_cursor && requestedPageSize !== undefined) cursorSizes.set(envelope.pagination.next_cursor, requestedPageSize);
    const metadataOffset = tool === 'fhir_capabilities' ? input.cursor ? discoveryOffsets.get(String(input.cursor)) ?? 0 : Number(input.offset ?? 0) : undefined;
    if (tool === 'fhir_capabilities' && typeof envelope.data.next_cursor === 'string') {
      const rows = envelope.data.resources ?? envelope.data.search_parameters ?? envelope.data.rows;
      discoveryOffsets.set(envelope.data.next_cursor, (metadataOffset ?? 0) + (Array.isArray(rows) ? rows.length : 0));
    }
    records.push({ deliveredText: renderedText, input, requestedPageSize, metadataOffset, step, tool, resourceType, ...(tool === 'fhir_result' ? { action: (input.action ?? 'inspect') as CallRecord['action'], offset: Number(input.offset ?? 0) } : {}), envelope, metrics, ...(outcome.resultText !== undefined ? { rawText: outcome.resultText } : {}), ...(envelope.error ? { outcome: { class: 'application_error' as const, code: envelope.error.code } } : {}) });
    if (envelope.result?.handle && resourceType) retainedTypes.set(envelope.result.handle, resourceType);
    envelopes.push(envelope);
    enforceBudget(false);
    return envelope;
  };
  let negotiatedVersion = 'unknown';
  try {
    session = await openSession(gateway, era, options.naturalMeasurement ? { ...options, naturalMeasurement: { ...options.naturalMeasurement,
      catalog: capture => options.naturalMeasurement!.catalog({ ...capture, task: task.id, arm }) } } : options, config);
    negotiatedVersion = session.negotiatedVersion;
    for (const [index, step] of task.steps.entries()) {
      if (task.id === 'p-guidance-expired-handle' && index === 1) {
        const handle = envelopes[0]?.result?.handle;
        if (options.packagedBin) await new Promise(resolve => setTimeout(resolve, 150));
        else if (handle) (gateway as unknown as { store: { release(handle: string): void } }).store.release(handle);
      }
      const input = resolvePlaceholders(structuredClone(step.input), envelopes) as Rec;
      // Retained-result steps declare their own projection fields; only the per-call byte ceiling is arm-invariant.
      input.output = step.tool === 'fhir_result' ? { format: arm === 'compact' ? 'compact' : 'fhir', max_bytes: task.perCallBytes ?? 24576 } : armOutput(task, arm, step.tool);
      if (step.maxBytes !== undefined) (input.output as Rec).max_bytes = resolvePlaceholders(step.maxBytes, envelopes);
      const resourceType = typeof step.input.resource_type === 'string' ? step.input.resource_type : undefined;
      let envelope = await call(index, step.tool, input, resourceType);
      let drain = step.drainPages ?? step.tool === 'fhir_search';
      if (pendingProfile && task.id === 'query-cross-page-sort' && drain) {
        // This task's continuation phase exists to qualify cross-page order.
        // Generic policy cannot supply that proof. Execute the initial call
        // and its ordinary checks, and disclose the unexecuted proof phase.
        skippedProfileParts.push({ step: index, part: 'cross-page order proof drain', reason: dependency! });
        drain = false;
      }
      let guard = 0;
      while (drain && envelope && !envelope.error && envelope.pagination?.next_cursor && guard++ < 50) {
        envelope = await call(index, 'fhir_page', { cursor: envelope.pagination.next_cursor, output: armOutput(task, arm, 'fhir_page') }, resourceType);
      }
      if (guard > 50) failures.push({ cause: 'harness_error', detail: 'pagination drain exceeded 50 pages', step: index });
    }
  } catch (error) {
    if (!(error instanceof BudgetStop)) failures.push({ cause: 'harness_error', detail: error instanceof Error ? error.message : 'unknown harness error' });
  } finally {
    await session?.close();
    gateway.close();
    observer.close();
    fixture.setMode(undefined);
  }

  for (const [step, definition] of task.steps.entries()) {
    const chain = records.filter(r => r.step === step && r.envelope.coverage);
    const type = typeof definition.input.resource_type === 'string' ? definition.input.resource_type : chain[0]?.resourceType;
    const resolved = resolveQueryChain(chain.map(r => r.envelope), type);
    if (resolved.error) failures.push({ step, cause: 'coverage_invalid', detail: resolved.error });
    const initialSearch = searchRequests(stepRequests[step]!)[0];
    const full = chain.find(r => r.envelope.coverage.constraints)?.envelope.coverage.constraints;
    if (initialSearch && full) {
      const material = [...initialSearch.searchParams].filter(([name]) => !['_sort', '_count', '_offset'].includes(name)).map(([name, value]) => ({ name, value }));
      if (!deepEqual(full.map(({ name, value }) => ({ name, value })), material)) failures.push({ step, cause: 'coverage_invalid', detail: 'Initial evidence lost or changed an ordered outbound material occurrence.' });
    }
  }
  const allRequests = fixture.requests().slice(requestsBefore);
  const upstreamGateway = envelopes.reduce((sum, e) => sum + e.budget.upstream_calls, 0);
  for (const record of records) if (envelopes.includes(record.envelope)) failures.push(...responseInvariants(record, trustedPatientId));
  if (allRequests.length !== upstreamGateway) failures.push({ cause: 'upstream_count_mismatch', detail: `fixture observed ${allRequests.length} upstream calls, gateway reported ${upstreamGateway}` });
  // Every missing-predicate continuation must match an independently observed, causally prior next link in its own query chain.
  if (!deepEqual(observer.provenance.requests.map(request => request.url.pathname + request.url.search), allRequests)) failures.push({ cause: 'harness_error', detail: 'Independent upstream response observation did not cover the source request log exactly.' });
  for (const request of observer.provenance.requests) if (request.gap) failures.push({ cause: 'upstream_confinement_missing', detail: request.gap });

  const evidence = collectEvidence(envelopes, allRequests);
  const allowed = new Set(task.allowedErrors ?? []);
  if (!task.expectedError) {
    for (const [index, envelope] of envelopes.entries()) if (envelope.error && !allowed.has(envelope.error.code) && !task.checks.some(c => c.kind === 'callOutcome' && c.outcome === 'application_error' && String(c.code) === envelope.error!.code && (c.step ?? 0) === records.filter(r => envelopes.includes(r.envelope))[index]?.step)) failures.push({ cause: 'unexpected_error', detail: `${envelope.error.code}: ${envelope.error.safe_message}` });
  } else {
    const firstError = envelopes.find(e => e.error)?.error?.code;
    if (firstError !== task.expectedError) failures.push({ cause: 'expected_error_mismatch', detail: `expected ${task.expectedError} got ${firstError ?? 'none'}` });
    if (evidence.resourceOrder.length) failures.push({ cause: 'expected_error_mismatch', detail: `denied task returned resources: ${evidence.resourceOrder.join(',')}` });
  }

  // Prohibited disclosures: harness-side scan of every returned envelope AND of the text delivered with it (the host's
  // boundary). The detail names the marker's position, never the marker value itself.
  const deliveredText = records.filter(r => envelopes.includes(r.envelope)).map(r => r.deliveredText ?? '').join('\n');
  for (const [index, marker] of [...GLOBAL_PROHIBITED, ...(task.prohibited ?? [])].entries()) {
    if (evidence.serialized.includes(marker) || deliveredText.includes(marker)) failures.push({ cause: 'prohibited_disclosure', detail: `prohibited marker #${index} present in the delivered results` });
  }

  // Each check is evaluated only against the response(s) of the step bound to it.
  const checkResults: CheckResult[] = [];
  const oracleCalls: OracleCall[] = records.map(r => ({ step: r.step, ...(envelopes.includes(r.envelope) ? { envelope: r.envelope } : {}), ...(r.rawText !== undefined ? { rawText: r.rawText } : {}),
    ...(r.outcome ? { outcome: r.outcome } : {}), work: r.metrics.work, ...(r.resourceType !== undefined ? { resourceType: r.resourceType } : {}) }));
  if (!task.expectedError) for (const check of task.checks) {
    const frozenProofCheck = (options.externalBackend ? externalTasks() : TASKS).find(original => original.id === task.id)?.checks.find(original => original.id === check.id);
    if (pendingProfile && PROFILE_DEPENDENT_CHECKS[task.id]?.includes(check.id) && deepEqual(check, frozenProofCheck)) {
      checkResults.push({ check_id: check.id, kind: check.kind, step: check.step ?? 0, status: 'pending_profile_proof', detail: dependency });
      continue;
    }
    const step = boundStep(check, task.steps.length);
    if (step === undefined) { failures.push({ cause: 'harness_error', detail: `check ${check.id} is not bound to a valid step`, check_id: check.id }); continue; }
    const bound = (check.kind === 'fact' || check.kind === 'factAbsent') && check.version === undefined && versions.has(check.resource) ? { ...check, version: versions.get(check.resource)! } : check;
    const result = evaluateStepCheck(bound, arm, oracleCalls, { stepCount: task.steps.length, requests: stepRequests[step]!, upstreamProvenance: { ledger: observer.provenance, requests: stepObserved[step]! } });
    checkResults.push(result);
    if (result.status === 'fail') failures.push({ cause: result.cause ?? 'expected_fact_mismatch', detail: result.detail ?? result.check_id, check_id: result.check_id, step });
  }

  const calls = records.map(record => record.metrics);
  const verdict = classify(task, era, failures, checkResults);
  // External report files retain check identities and causes, never resource ids, query values or payload excerpts.
  if (options.externalBackend) {
    for (const failure of verdict.failures) failure.detail = `External task failure: ${failure.cause}.`;
    for (const check of checkResults) if (check.detail) check.detail = `External task check: ${check.status}.`;
  }
  return {
    task_id: task.id, category: task.category, arm,
    ...verdict, query_profile: queryProfile,
    ...(privateProfile ? { status: 'private_profile_control' as const, private_profile_verdict: verdict.status as 'pass' | 'fail' | 'known-defect' }
      : pendingProfile && verdict.status === 'pass' ? { status: 'pending_profile_proof' as const } : {}),
    ...(dependency ? { profile_proof_dependency: { milestone: 'S6' as const, profile: profileId, reason: dependency } } : {}),
    checks: checkResults, ...(skippedProfileParts.length ? { skipped_profile_parts: skippedProfileParts } : {}),
    metrics: {
      tool_calls: records.length, upstream_calls: allRequests.length, upstream_calls_gateway_reported: upstreamGateway,
      result_bytes: measuredBytes(), gateway_reported_bytes: calls.reduce((sum, c) => sum + (c.gateway_reported_bytes ?? 0), 0),
      frame_bytes: calls.reduce((sum, c) => sum + c.wire_frame_bytes, 0), resources_returned: evidence.resourceOrder.length,
    },
    calls,
    opaque_continuations: observer.provenance.acceptedOpaqueLinks(),
    budget: { max_bytes: task.budget.maxBytes, max_upstream_calls: task.budget.maxUpstreamCalls, max_tool_calls: task.budget.maxToolCalls },
    elapsed_ms_descriptive_only: Date.now() - started,
    negotiatedVersion,
    signature: responseSignature(records),
  };
}

/** Arm-comparable view of every response: volatile ids/handles/timing and the echoed format label removed. */
function responseSignature(records: CallRecord[]): string {
  return canonicalJson(records.map(({ tool, envelope }) => {
    const { next_cursor: _cursor, ...pagination } = envelope.pagination ?? {};
    const { format: _format, requested_format: _requestedFormat, ...transform } = envelope.transform ?? {};
    const data = { ...envelope.data };
    if (tool === 'fhir_capabilities') for (const key of ['captured_at','expires_at','next_cursor']) delete data[key];
    return { tool, data, coverage: envelope.coverage, pagination, transform, warnings: envelope.warnings, error: envelope.error?.code };
  }));
}

function countCauses(failures: Failure[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const failure of failures) counts[failure.cause] = (counts[failure.cause] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a < b ? -1 : 1));
}

/** Observe real node:http requests without proxying, rewriting bundles or replacing the production transport. */
function observeExternalRequests(backend: ExternalBackend): EvalFixtureServer {
  const base = new URL(backend.baseUrl);
  const requests: string[] = [];
  const diagnostic = channel('http.client.request.start');
  const listener = (message: unknown) => {
    const request = (message as { request?: ClientRequest }).request;
    if (!request || request.getHeader('host') !== base.host) return;
    const path = new URL(request.path, base).pathname;
    if (path === base.pathname || path.startsWith(`${base.pathname}/`)) requests.push(request.path);
  };
  diagnostic.subscribe(listener);
  return { baseUrl: backend.baseUrl, requestCount: () => requests.length, requests: () => requests.slice(),
    selectScenario() {}, selectResources() { throw new Error('External corpus cannot change per task.'); },
    setMode(mode) { if (mode !== undefined) throw new Error('External backend cannot simulate a fixture mode.'); },
    async close() { diagnostic.unsubscribe(listener); },
  };
}

export async function runEvals(options: RunEvalsOptions = {}, testOptions?: PrivateEvalTestOptions): Promise<EvalReport> {
  const applicability = options.externalBackend ? externalApplicability() : undefined;
  const selectedTasks = options.tasks ?? (options.externalBackend ? externalTasks() : [...TASKS, ...USABILITY_TASKS]).filter(t => options.corpus === undefined || options.corpus === 'all' || (t.corpus ?? 'baseline') === options.corpus);
  const tasks = parseM3bTaskFile(JSON.stringify({ schema_version: M3B_TASKS_SCHEMA_VERSION, tasks: applicability ? selectExternalTasks(selectedTasks) : selectedTasks }));
  const arms = options.arms ?? [...ARM_ORDER];
  const era = options.era ?? 'modern';
  if (!tasks.length || !arms.length || arms.some(arm => !ARM_ORDER.includes(arm)) || new Set(arms).size !== arms.length || new Set(tasks.map(task => task.id)).size !== tasks.length || !(era in PROTOCOL_ERAS)) throw new Error('Eval selection must contain unique tasks, supported arms and a supported protocol era.');
  const started = Date.now();
  if (options.externalBackend) {
    if (options.packagedBin || options.resources || testOptions?.simulateIneligibleProfile) throw new Error('External eval cannot replace corpus, observe a child-process transport, or simulate profile eligibility.');
    await verifyExternalBackend(options.externalBackend);
  }
  if (options.naturalMeasurement) {
    if (options.externalBackend || options.packagedBin || !options.resources?.length || testOptions
      || !/^[A-Za-z0-9.-]{1,64}$/.test(options.naturalMeasurement.patientId)) throw new Error('Invalid S11 natural corpus selection.');
    const ids = new Set(options.resources.map(r => `${r.resourceType}/${r.id}`));
    if (ids.size !== options.resources.length || Object.keys(options.naturalMeasurement.rawBodies).length !== ids.size
      || options.resources.filter(r => r.resourceType === 'Patient').length !== 1
      || !ids.has(`Patient/${options.naturalMeasurement.patientId}`)) throw new Error('Invalid S11 natural corpus identities.');
    for (const resource of options.resources) {
      const body = options.naturalMeasurement.rawBodies[`${resource.resourceType}/${resource.id}`];
      if (!body || !deepEqual(JSON.parse(body), resource)) throw new Error('S11 raw corpus differs from decoded resources.');
    }
  }
  const corpus = options.naturalMeasurement ? { resources: [...options.resources!],
    byCorpus: { baseline: [...options.resources!], query: [...options.resources!], projection: [...options.resources!] },
    rawBodies: options.naturalMeasurement.rawBodies, hashes: {} } : loadEvalCorpus(options.resources);
  const resources = options.externalBackend?.corpus.resources ?? corpus.resources;
  const versions = options.externalBackend?.versions ?? new Map([...resources, ...ADVERSARIAL_RESOURCES].flatMap(r => { const v = asRec(r.meta)?.versionId; return typeof v === 'string' ? [[r.id, v] as const] : []; }));
  const fixture = options.externalBackend ? observeExternalRequests(options.externalBackend) : await startEvalFixtureServer(resources, corpus.rawBodies);
  const results: (TaskArmResult & Partial<Internal>)[] = [];
  try {
    for (const task of tasks) {
      for (const arm of ARM_ORDER.filter(name => arms.includes(name))) {
        if (!options.externalBackend) fixture.selectResources(corpus.byCorpus[task.corpus === 'usability' ? 'baseline' : task.corpus ?? 'baseline']!, options.naturalMeasurement || task.corpus === 'projection' ? corpus.rawBodies : {});
        results.push(await runTaskArm(task, arm, fixture, era, versions, options, testOptions));
      }
    }
  } finally {
    await fixture.close();
  }
  if (options.externalBackend) await verifyExternalBackend(options.externalBackend);
  results.sort((a, b) => a.task_id === b.task_id ? ARM_ORDER.indexOf(a.arm) - ARM_ORDER.indexOf(b.arm) : a.task_id < b.task_id ? -1 : 1);
  const negotiatedVersion = results.find(r => r.negotiatedVersion && r.negotiatedVersion !== 'unknown')?.negotiatedVersion ?? 'unknown';
  const allArms = ARM_ORDER.every(arm => arms.includes(arm));
  const insensitive = allArms ? tasks.filter(task => new Set(results.filter(r => r.task_id === task.id).map(r => r.signature)).size === 1).map(task => task.id) : null;
  for (const result of results) { delete result.signature; delete result.negotiatedVersion; }
  const byArm: ArmSummary[] = ARM_ORDER.filter(name => arms.includes(name)).map(arm => {
    const mine = results.filter(r => r.arm === arm);
    const checks = mine.filter(r => r.status !== 'private_profile_control').flatMap(r => r.checks);
    return {
      arm, tasks_attempted: mine.length,
      tasks_passed: mine.filter(r => r.status === 'pass').length,
      tasks_failed: mine.filter(r => r.status === 'fail').length,
      tasks_known_defect: mine.filter(r => r.status === 'known-defect').length,
      tasks_pending_profile_proof: mine.filter(r => r.status === 'pending_profile_proof').length,
      tasks_private_profile_control: mine.filter(r => r.status === 'private_profile_control').length,
      checks_comparable: checks.filter(c => c.status !== 'incomparable').length,
      checks_passed: checks.filter(c => c.status === 'pass').length,
      checks_failed: checks.filter(c => c.status === 'fail' && !c.known_defect).length,
      checks_known_defect: checks.filter(c => c.status === 'fail' && c.known_defect).length,
      checks_incomparable: checks.filter(c => c.status === 'incomparable').length,
      checks_pending_profile_proof: checks.filter(c => c.status === 'pending_profile_proof').length,
      total_result_bytes: mine.reduce((s, r) => s + r.metrics.result_bytes, 0),
      total_upstream_calls: mine.reduce((s, r) => s + r.metrics.upstream_calls, 0),
      total_tool_calls: mine.reduce((s, r) => s + r.metrics.tool_calls, 0),
      failures_by_cause: countCauses(mine.filter(r => r.status !== 'private_profile_control').flatMap(r => r.failures)),
    };
  });
  const formats = arms.length;
  const sensitive = insensitive ? tasks.length - insensitive.length : null;
  return {
    ...(options.externalBackend ? { external_backend: { identity: options.externalBackend.identity, applicability: applicability!, omitted_inputs: options.externalBackend.corpus.omitted, input_transformations: options.externalBackend.corpus.transformations } } : {}),
    selection: { delivery_profile: options.deliveryProfile ?? 'full-text-v1', host: options.host ?? null, corpus: options.corpus ?? 'all', stratum: options.stratum ?? 'synthetic', packaged_bin: options.packagedBin ?? null, query_profiles: [...new Map(results.map(r => [JSON.stringify(r.query_profile), r.query_profile])).values()] },
    measurement: { tokenizer: options.tokenizer?.name ?? null, model_input: options.modelInputHashes ? 'host_capture' : 'unmeasured',
      configured_default_bytes: options.configuredDefaultBytes ?? 24576, configured_max_bytes: options.configuredMaxBytes ?? 131072,
      fragment_sha256: corpus.hashes, backend_sha256: options.externalBackend?.identity.image_digest ?? fixtureBackendSha256(),
      raw_fixture_sha256: createHash('sha256').update(canonicalJson(corpus.rawBodies)).digest('hex') },
    schema_version: EVAL_REPORT_SCHEMA,
    eval_package_version: EVAL_PACKAGE_VERSION,
    package_version: options.packageVersion ?? 'unknown',
    gateway_envelope_schema_version: M3B_SCHEMA_VERSION,
    r4_schema: { package: R4_SCHEMA.package, version: R4_SCHEMA.version, source_sha256: R4_SCHEMA.source_sha256, definitions: R4_SCHEMA.definitions },
    generated_at: options.generatedAt ?? new Date().toISOString(),
    code_revision: options.codeRevision ?? 'unknown',
    protocol: { era, negotiated_version: negotiatedVersion, measurement: 'Byte budgets and per-call ceilings use the JSON-RPC result value the SDK server emitted (serveStdio over a stdio-shaped in-memory transport), not the gateway\'s own accounting.' },
    fixture: {
      sha256: options.externalBackend?.identity.corpus_sha256 ?? (options.naturalMeasurement ? createHash('sha256').update(canonicalJson(corpus.rawBodies)).digest('hex') : fixtureSha256(resources, undefined, corpus.rawBodies)), resource_count: resources.length, adversarial_resource_count: options.externalBackend || options.naturalMeasurement ? 0 : ADVERSARIAL_RESOURCES.length,
      source_alias: EVAL_SOURCE_ALIAS, trusted_patient: options.externalBackend || options.naturalMeasurement ? '(synthetic corpus identity withheld)' : EVAL_PATIENT_ID,
    },
    scope: [
      options.externalBackend ? 'Deterministic unchanged oracles against a real local HAPI backend containing a verified synthetic corpus; excluded fixture simulations are disclosed.' : options.naturalMeasurement ? 'Deterministic S11 natural Synthea charts served by the existing synthetic fixture adapter; real SDK and gateway, no HAPI backend, LLM or autonomous agent.' : 'Deterministic oracle scripts over a golden synthetic fixture; no LLM or agent is involved.',
      'Measures retrieval conformance of the gateway tools only: facts, provenance, coverage, budgets, outbound confinement, non-disclosure.',
      'Does not measure agent performance, clinical reasoning, diagnosis, or treatment; no superiority claim over other tools is made.',
      'Arms share identical fixtures and identical per-task byte/call budgets; facts an arm cannot represent are reported incomparable, not as failures or wins.',
      'Task/format runs are not independent cases; format-insensitive tasks return the same response in every format.',
      'known-defect results are agreed, unfixed gateway defects reported as expected failures; they are not passes.',
      'pending_profile_proof tasks execute their generic-policy calls under the generic invariants, prohibited-marker scan and byte/work checks; their named proof-dependent checks wait for S6 and they contain no other task checks. They remain in denominators and never count as passes.',
      'Private/test query profiles are explicitly labelled private_profile_control, with their own verdicts and summary; none contributes to public pass totals.',
      'elapsed_ms figures are descriptive only and never gate pass/fail.',
    ],
    arms: arms.map(name => ({ name, description: ARM_DESCRIPTIONS[name] })),
    task_count: tasks.length,
    denominator: {
      tasks: tasks.length, primary_tasks: tasks.filter(t => t.corpus !== 'usability').length, auxiliary_usability_tasks: tasks.filter(t => t.corpus === 'usability').length, formats, task_format_runs: results.length, format_sensitive_tasks: sensitive, format_insensitive_task_ids: insensitive,
      statement: `${tasks.length} tasks x ${formats} formats${sensitive === null ? ' (format sensitivity needs all three formats)' : ` (${sensitive} format-sensitive)`}`,
    },
    summary: {
      by_arm: byArm,
      failures_by_cause: countCauses(results.filter(r => r.status !== 'private_profile_control').flatMap(r => r.failures)),
      total_upstream_calls: results.reduce((s, r) => s + r.metrics.upstream_calls, 0),
      total_result_bytes: results.reduce((s, r) => s + r.metrics.result_bytes, 0),
      known_defects: results.flatMap(r => r.known_defects.map(d => ({ task_id: r.task_id, arm: r.arm, ...d }))),
      private_profile_controls: results.filter(r => r.status === 'private_profile_control').map(r => ({ task_id: r.task_id, arm: r.arm, profile: r.query_profile, verdict: r.private_profile_verdict!, checks_passed: r.checks.filter(c => c.status === 'pass').length, checks_failed: r.checks.filter(c => c.status === 'fail').length, failures_by_cause: countCauses(r.failures) })),
      pending_profile_proof: results.flatMap(r => r.status === 'pending_profile_proof' && r.profile_proof_dependency ? [{ task_id: r.task_id, arm: r.arm, ...r.profile_proof_dependency }] : []),
      byte_accounting: byteAccounting(results.flatMap(r => r.calls)),
    },
    timing_descriptive_only: { total_elapsed_ms: Date.now() - started },
    results,
  };
}

/**
 * The ordinary-output form of one failure: fixed task/arm identifiers, the fixed cause, and the check id and step when
 * bound. The free-text detail (which may name resources, values or markers) stays in the private report file only.
 */
export function ordinaryFailureLine(result: Pick<TaskArmResult, 'task_id' | 'arm'>, failure: Failure): string {
  return `  FAIL ${result.task_id} arm=${result.arm} cause=${failure.cause}${failure.check_id !== undefined ? ` check=${failure.check_id}` : ''}${failure.step !== undefined ? ` step=${failure.step}` : ''}`;
}

/** Gateway-reported versus independently measured result bytes over every call that carried an envelope. */
export function byteAccounting(all: readonly CallMetrics[]): EvalReport['summary']['byte_accounting'] {
  const calls = all.filter(c => c.gateway_reported_bytes !== undefined);
  const delta = (c: CallMetrics) => c.wire_result_bytes - (c.gateway_reported_bytes ?? 0);
  return {
    calls: calls.length,
    under_reported_calls: calls.filter(c => delta(c) > 0).length,
    over_reported_calls: calls.filter(c => delta(c) < 0).length,
    max_under_report_bytes: Math.max(0, ...calls.map(delta)),
    max_over_report_bytes: Math.max(0, ...calls.map(c => -delta(c))),
  };
}
/** The run-level byte-accounting gate of exitCodeForReport, applied to any set of calls (S11 applies it per attempt). */
export function byteAccountingFails(accounting: EvalReport['summary']['byte_accounting']): boolean {
  return accounting.under_reported_calls > 0 || accounting.over_reported_calls > 0;
}

export function exitCodeForReport(report: EvalReport): number {
  // Independent byte accounting is a gate, not a statistic: any call whose gateway-reported bytes differ from the measured wire result fails the run.
  if (byteAccountingFails(report.summary.byte_accounting)) return 1;
  return report.results.some(r => r.status === 'fail' || r.private_profile_verdict === 'fail') ? 1 : 0;
}
