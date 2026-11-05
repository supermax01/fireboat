/**
 * Packaging slice 8B (design §7, "verify"): for a completed `prepare` run, the metadata-only doctor must report ready,
 * then the three packaged tasks (packages/evals/src/package-tasks.ts) run through the installed gateway over MCP stdio
 * in both protocol eras and all three arms (18 task-arm runs; three independent tasks), each judged call by call with
 * the shared pure oracle (`evaluateStepCheck`) after the per-call invariants (bytes, decoding, outcomes, chains).
 * Everything is bound to the run: the helper assets are validated as `prepare` validates them, the setup packet is the
 * receipt's, closed and complete for the manifest, and the operator config must name the manifest's target and the
 * seed's natural patient; a private base snapshot and bound derived configs serve the doctor and sessions. Facts are the seed's,
 * with the versions the packet observed. The client process has no HTTP authority: work counts come from the request
 * observer in the gateway child. Complete raw JSON-RPC frames and result members are kept as restricted local evidence (0600) in a unique verification directory;
 * the returned summary carries fixed statuses, counts, hashes and the doctor's identity lines only.
 */
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { GatewayEnvelope } from '../../packages/core/src/index.js';
import type { ArmName, Check } from '../../packages/evals/src/check-contracts.js';
import { boundStep, canonicalJson, citedIndexes, evaluateStepCheck, rawMember, resolveQueryChain, resourcesOf, validTimestamp, type CallOutcomeRecord, type CheckResult, type OracleCall, type UpstreamWork } from '../../packages/evals/src/evidence-oracle.js';
import { armOutput, EXPIRED_MESSAGE, NOT_SERVED_MESSAGE, packageTasks, seedFacts, type PackageTask, type PackageTaskId } from '../../packages/evals/src/package-tasks.js';
import { fault, hasKeys, isRecord, isSha256, sha256, type SeedManifest } from './manifest.js';
import { validateHelperAssets, type HelperAssets } from './prepare.js';
import { atomicPrivateWrite, jsonBytes, lockRun, readPrivateFile, readRunReceipt, validRunReceipt, type RunReceipt, type SetupPacket } from './run-state.js';
import { numbersOf, parseResource } from './setup-oracle.js';
import type { SeedPut } from './seed-http.js';

export type VerifyEra = 'modern' | 'legacy';
export const VERIFY_ERAS: readonly VerifyEra[] = ['modern', 'legacy'];
export const VERIFY_ARMS: readonly ArmName[] = ['fhir', 'compact', 'selected'];
/** One recorded MCP tool call, as the helper's client returns it (examples/quickstart/client.ts). */
export interface RecordedCall {
  requestId: string | number; rawFrame?: string; frames?: readonly { direction: 'sent' | 'received'; text: string }[]; rawText?: string; envelope?: GatewayEnvelope; outcome?: CallOutcomeRecord;
  work: UpstreamWork; resultBytes: number; frameBytes: number;
}
export interface GatewaySession { call(tool: string, input: Record<string, unknown>): Promise<RecordedCall>; close(): Promise<void> }
export type SessionFactory = (launch: Readonly<{ node: string; cli: string; config: string; era: VerifyEra; observe?: boolean }>) => Promise<GatewaySession>;
export type DoctorRunner = (launch: Readonly<{ node: string; cli: string; config: string }>) => Promise<{ exitCode: number | null; stdout: string }>;
export const VERIFY_LIMITS = Object.freeze({ drainPages: 50, doctorBytes: 16_384, doctorMs: 30_000, cliBytes: 1_048_576 });
/** A recorded call as judged: the oracle's view plus the measured bytes of its result member and frame. */
export type TaskCall = OracleCall & Readonly<{ resultBytes: number; frameBytes: number; rawFrame?: string; requestId?: string | number; tool?: string; input?: Record<string, unknown> }>;
export interface ResponseBinding { alias: string; fhirVersion: string; maxBytes: number; defaultBytes: number; contextId?: string }

export interface TaskRun {
  era: VerifyEra; task: PackageTaskId; arm: ArmName; status: 'pass' | 'fail';
  checks: { passed: number; failed: number; incomparable: number }; failing: readonly string[]; limitations: readonly string[];
}
export interface VerifyReport {
  schema: 'fireboat-quickstart-verify/1'; runId: string; verificationId: string; manifestSha256: string; packetSha256: string; doctor: 'ready';
  /** What was tested: the CLI file and config snapshot by hash, the doctor's own gateway and runtime lines. */
  launch: Readonly<{ cliSha256: string; artifactSha256: string; artifactFiles: number; configSha256: string; configs: readonly { name: string; sha256: string }[]; gateway: string; runtime: string }>;
  /** Upstream work is counted by the request-observer preload in each gateway child; the doctor runs without it. */
  instrumentation: 'request-observer';
  controls: readonly { era: VerifyEra; status: 'pass' | 'fail'; cleanSha256: string; observedSha256: string }[];
  runs: readonly TaskRun[]; passed: number; failed: number; evidenceSha256: string;
}

/** Runs the gateway's own `--doctor` (metadata and auth requests only) with an explicit argv and bounded output. */
export const spawnDoctor: DoctorRunner = launch => new Promise((accept, reject) => {
  const child = spawn(launch.node, [launch.cli, '--doctor', '--config', launch.config], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '' }, shell: false });
  let stdout = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), VERIFY_LIMITS.doctorMs);
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; if (stdout.length > VERIFY_LIMITS.doctorBytes) child.kill('SIGKILL'); });
  child.on('error', () => { clearTimeout(timer); reject(fault('VERIFY_DOCTOR')); });
  child.on('close', code => { clearTimeout(timer); accept({ exitCode: code, stdout }); });
});

/** An operator file (the config, the CLI): a regular file of bounded size, read once (its location and mode are the operator's). */
async function readBounded(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('bounded read');
    const bytes = await file.readFile();
    if (bytes.length !== stat.size) throw new Error('bounded read');
    return bytes;
  } finally { await file.close(); }
}

/**
 * Bounded installed-artifact binding, not just the bootstrap: the package's runtime tree, root runtime/metadata files,
 * and the installed production dependency closure. Source launches (the e2e fixture) bind packages/ instead of dist/.
 * Every regular package file in those trees is included, sorted by logical path and hashed with its content hash.
 */
export async function gatewayArtifact(cli: string): Promise<{ sha256: string; files: number }> {
  const rows: [string, string][] = [], seen = new Set<string>(); let total = 0, fileCount = 0;
  const readArtifactFile = async (path: string, maximum: number): Promise<Buffer> => {
    const bytes = await readBounded(path, Math.min(maximum, 64 * 1024 * 1024 - total));
    total += bytes.length; return bytes;
  };
  const add = async (path: string, name: string) => {
    if (rows.length >= 8192) throw fault('VERIFY_DOCTOR');
    const bytes = await readArtifactFile(path, 8 * 1024 * 1024);
    rows.push([name, sha256(bytes)]); fileCount++;
  };
  const walk = async (path: string, name: string): Promise<void> => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw fault('VERIFY_DOCTOR');
    if (stat.isFile()) { await add(path, name); return; }
    if (!stat.isDirectory()) throw fault('VERIFY_DOCTOR');
    for (const child of (await readdir(path)).sort()) if (child !== 'node_modules') await walk(join(path, child), `${name}/${child}`);
  };
  const installed = await realpath(cli);
  let root = dirname(installed), manifest: Record<string, unknown> | undefined;
  for (let depth = 0; depth < 20; depth++) {
    try { const value: unknown = JSON.parse((await readArtifactFile(join(root, 'package.json'), 1048576)).toString('utf8')); if (isRecord(value)) { manifest = value; break; } } catch { /* next ancestor */ }
    const parent = dirname(root); if (parent === root) break; root = parent;
  }
  if (!manifest) throw fault('VERIFY_DOCTOR');
  const cliPath = relative(root, installed).replaceAll('\\', '/');
  const runtime = cliPath.startsWith('dist/') ? 'dist' : cliPath.startsWith('packages/') ? 'packages' : undefined;
  if (runtime) await walk(join(root, runtime), runtime);
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1))
    if (entry.isFile() && /\.(?:json|[cm]?js|ts|node|wasm)$/.test(entry.name)) await add(join(root, entry.name), entry.name);
  if (!rows.some(([path]) => path === cliPath)) throw fault('VERIFY_DOCTOR');
  const dependencies = async (owner: string, value: Record<string, unknown>, label: string): Promise<void> => {
    if (value.dependencies === undefined) return;
    if (!isRecord(value.dependencies)) throw fault('VERIFY_DOCTOR');
    for (const name of Object.keys(value.dependencies).sort()) {
      if (rows.length >= 8192) throw fault('VERIFY_DOCTOR');
      if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name)) throw fault('VERIFY_DOCTOR');
      let where = owner, found: string | undefined;
      for (let depth = 0; depth < 20; depth++) {
        try { found = await realpath(join(where, 'node_modules', name)); break; } catch { /* next ancestor */ }
        const parent = dirname(where); if (parent === where) break; where = parent;
      }
      if (!found) throw fault('VERIFY_DOCTOR');
      const bytes = await readArtifactFile(join(found, 'package.json'), 1048576), pkg: unknown = JSON.parse(bytes.toString('utf8'));
      if (!isRecord(pkg) || !text(pkg.version, 80)) throw fault('VERIFY_DOCTOR');
      const key = `${label}/node_modules/${name}`;
      rows.push([`${key}:resolution`, sha256(jsonBytes([name, pkg.version, sha256(bytes)]))]);
      if (seen.has(found)) continue;
      seen.add(found); await walk(found, key); await dependencies(found, pkg, key);
    }
  };
  await dependencies(root, manifest, '.');
  rows.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { sha256: sha256(jsonBytes(rows)), files: fileCount };
}

/** The packet `prepare` wrote for this receipt: closed, bound to the attempt and instance, and one observed version per seeded target. */
export function validPacket(value: unknown, receipt: RunReceipt, manifestSha256: string, puts: readonly SeedPut[]): value is SetupPacket {
  if (!isRecord(value) || !hasKeys(value, ['schema', 'runId', 'creationNonce', 'receiptSha256', 'manifestSha256', 'instanceSha256', 'resources'])
    || value.schema !== 'fireboat-quickstart-setup/1' || value.runId !== receipt.runId || value.creationNonce !== receipt.creationNonce
    || value.receiptSha256 !== receipt.attemptSha256 || value.manifestSha256 !== manifestSha256 || receipt.instance === null
    || value.instanceSha256 !== sha256(jsonBytes(receipt.instance)) || !Array.isArray(value.resources)) return false;
  const targets = new Set<string>();
  for (const row of value.resources) {
    if (!isRecord(row) || !hasKeys(row, ['target', 'versionId', 'rawSha256', 'numbers']) || typeof row.target !== 'string' || targets.has(row.target)
      || typeof row.versionId !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(row.versionId) || !isSha256(row.rawSha256) || !Array.isArray(row.numbers)) return false;
    const put = puts.find(p => p.target === row.target);
    if (!put || canonicalJson(row.numbers) !== canonicalJson(numbersOf(parseResource(put.body)))) return false;
    targets.add(row.target);
  }
  return targets.size === puts.length && puts.every(put => targets.has(put.target));
}
const objectShape = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> =>
  isRecord(value) && required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k));
const uint = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const strings = (value: unknown, max = 100): value is string[] => Array.isArray(value) && value.length <= max && value.every(v => typeof v === 'string');
const distinct = (values: readonly unknown[]) => new Set(values).size === values.length;
/** Closed controls for the two discovery forms this recipe issues; resource bodies have no place in these metadata shapes. */
function metadataShape(input: Record<string, unknown>, data: Record<string, unknown>, revision: string, coverage: GatewayEnvelope['coverage']): boolean {
  const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
  const list = (v: unknown, max: number, width: number): v is string[] => strings(v, max) && v.every(s => s.length <= width);
  const evidence = (v: unknown) => ['declared', 'observed_supported', 'observed_unsupported', 'unknown'].includes(v as string);
  const nullable = (v: unknown, max: number) => v === null || str(v, max);
  if (data.snapshot_revision !== revision || typeof data.captured_at !== 'string' || !validTimestamp(data.captured_at)
    || typeof data.expires_at !== 'string' || !validTimestamp(data.expires_at) || Date.parse(data.expires_at) <= Date.parse(data.captured_at)
    || data.next_cursor !== undefined || coverage.state !== 'complete_for_query' || coverage.query_exhausted !== true) return false;
  if (input.topic === 'support') {
    if (!objectShape(data, ['workflow', 'matrix_revision', 'rows', 'snapshot_revision', 'captured_at', 'expires_at', 'default_policy', 'clinical_sections', 'document_support'], ['next_cursor'])
      || data.workflow !== 'recent-labs-v1' || !text(data.matrix_revision, 80) || data.default_policy !== 'deny_unclassified' || data.document_support !== 'metadata_only'
      || !list(data.clinical_sections, 8, 80) || !Array.isArray(data.rows) || data.rows.length !== 1) return false;
    const r = data.rows[0];
    return objectShape(r, ['resource_type', 'policy_class', 'patient_link', 'source_advertised', 'advertised_interactions', 'policy_interactions', 'executable_interactions', 'instance_policy', 'compact_recipe', 'workflow_role', 'limitations'])
      && r.resource_type === input.resource_type && ['patient', 'conditional_shared', 'denied'].includes(r.policy_class as string) && nullable(r.patient_link, 80) && typeof r.source_advertised === 'boolean'
      && list(r.advertised_interactions, 16, 40) && list(r.policy_interactions, 2, 40) && list(r.executable_interactions, 2, 40)
      && [...r.policy_interactions, ...r.executable_interactions].every(v => ['read', 'search-type'].includes(v)) && str(r.instance_policy, 120) && nullable(r.compact_recipe, 120)
      && ['required', 'optional', 'outside_workflow'].includes(r.workflow_role as string) && list(r.limitations, 16, 160);
  }
  if (input.topic !== 'search_parameter' || !objectShape(data, ['resource_type', 'search_parameters', 'total_parameters', 'snapshot_revision', 'captured_at', 'expires_at', 'definitions'], ['next_cursor'])
    || data.resource_type !== input.resource_type || data.total_parameters !== 1 || !Array.isArray(data.search_parameters) || data.search_parameters.length !== 1
    || !objectShape(data.definitions, ['package', 'version', 'source_sha256']) || data.definitions.package !== 'hl7.fhir.r4.core' || data.definitions.version !== '4.0.1' || !isSha256(data.definitions.source_sha256)) return false;
  const p = data.search_parameters[0];
  const syntax = (v: unknown) => Array.isArray(v) && v.length <= 16 && v.every(r => objectShape(r, ['name', 'evidence', 'executable']) && str(r.name, 80) && evidence(r.evidence) && typeof r.executable === 'boolean');
  return objectShape(p, ['name', 'type', 'definition_evidence', 'targets', 'description', 'source_description_present', 'evidence', 'executable', 'modifiers', 'comparators', 'repetition', 'joins', 'execution_evidence'], ['definition', 'definition_version'])
    && p.name === input.name && ['number', 'date', 'string', 'token', 'reference', 'composite', 'quantity', 'uri', 'special', 'unknown'].includes(p.type as string)
    && (p.definition === undefined || str(p.definition, 512)) && (p.definition_version === undefined || str(p.definition_version, 80))
    && ['pinned_r4', 'approved_overlay', 'source_declared', 'unresolved', 'conflict'].includes(p.definition_evidence as string) && list(p.targets, 32, 80)
    && str(p.description, 240) && typeof p.source_description_present === 'boolean' && evidence(p.evidence) && typeof p.executable === 'boolean' && syntax(p.modifiers) && syntax(p.comparators)
    && objectShape(p.repetition, ['and', 'or']) && evidence(p.repetition.and) && evidence(p.repetition.or) && objectShape(p.joins, ['chain', 'has', 'include', 'revinclude'])
    && Object.values(p.joins).every(v => v === false) && evidence(p.execution_evidence);
}
/** Repairs and omission manifests are closed metadata, never another channel for a resource body. */
function repairShape(value: unknown): boolean {
  if (value === undefined) return true;
  return objectShape(value, ['action'], ['tool', 'resource_type', 'parameter', 'fields', 'max_bytes', 'page_size', 'max_pages', 'max_calls'])
    && ['discover_search_parameter', 'discover_schema', 'inspect_observed_codes', 'choose_supported_resource', 'narrow_query', 'increase_budget', 'repeat_original_query', 'use_current_context'].includes(value.action as string)
    && (value.tool === undefined || ['fhir_capabilities', 'fhir_search', 'fhir_read', 'fhir_page', 'fhir_result'].includes(value.tool as string))
    && (value.resource_type === undefined || text(value.resource_type, 80)) && (value.parameter === undefined || text(value.parameter, 80))
    && (value.fields === undefined || strings(value.fields, 30)) && (value.max_bytes === undefined || uint(value.max_bytes, 131072) && value.max_bytes >= 4096)
    && (value.page_size === undefined || uint(value.page_size, 100) && value.page_size >= 1) && (value.max_pages === undefined || uint(value.max_pages, 3) && value.max_pages >= 1)
    && (value.max_calls === undefined || uint(value.max_calls, 4) && value.max_calls >= 1);
}
function resultMetaShape(value: unknown): boolean {
  if (value === undefined) return true;
  const info = isRecord(value) ? value['io.modelcontextprotocol/serverInfo'] : undefined;
  return objectShape(value, ['io.modelcontextprotocol/serverInfo']) && objectShape(info, ['name', 'version']) && text(info.name, 80) && text(info.version, 80);
}
/** Same effective allowance as core/src/index.ts:628 (and constructor defaults at 312–313); never trust the response's ceiling. */
export function effectiveCeiling(input: Record<string, unknown>, binding: ResponseBinding): number {
  return Math.min(isRecord(input.output) && typeof input.output.max_bytes === 'number' ? input.output.max_bytes : binding.defaultBytes, binding.maxBytes);
}
/**
 * An independent, deliberately narrow validator for the calls this helper issues. No core serving/validation graph is
 * loaded (contracts.ts reaches zod). Full-text-v1 is one text block exactly equal to the raw structuredContent member:
 * core/src/index.ts:696–707 serializes the full envelope in both channels, including original numeric tokens.
 */
export function responseValid(tool: string, input: Record<string, unknown>, envelope: GatewayEnvelope, rawText: string, binding: ResponseBinding,
  pageSize?: number, resourceType?: string): boolean {
  try {
    const e = envelope, data = e.data, c = e.coverage, t = e.transform, p = e.pagination;
    const result: unknown = JSON.parse(rawText);
    if (!resultMetaShape(isRecord(result) ? result._meta : undefined)) return false;
    if (!objectShape(result, ['content', 'structuredContent'], ['isError', 'resultType', '_meta']) || !Array.isArray(result.content) || result.content.length !== 1
      || !isRecord(result.content[0]) || !hasKeys(result.content[0], ['type', 'text']) || result.content[0].type !== 'text'
      || result.content[0].text !== rawMember(rawText, 'structuredContent') || result.isError !== (e.error ? true : undefined)
      || result.resultType !== undefined && result.resultType !== 'complete') return false;
    if (!objectShape(e, ['schema_version', 'request_id', 'source', 'context', 'data', 'coverage', 'transform', 'warnings', 'budget'], ['provenance', 'pagination', 'result', 'error'])
      || e.schema_version !== '0.3' || !text(e.request_id, 80) || !isRecord(data)
      || !objectShape(e.source, ['alias', 'fhir_version', 'capability_revision']) || e.source.alias !== binding.alias || e.source.fhir_version !== binding.fhirVersion || !text(e.source.capability_revision, 80)
      || !objectShape(e.context, ['handle', 'mode', 'policy_revision']) || e.context.mode !== 'patient-bound' || !text(e.context.handle, 160) || !text(e.context.policy_revision, 80)
      || binding.contextId !== undefined && e.context.handle !== binding.contextId) return false;
    if (!objectShape(c, ['state', 'scope', 'reasons', 'authorization_limited', 'query_exhausted', 'pages_observed', 'query_evidence'], ['constraints', 'query_digest', 'constraints_on_first_page', 'sort'])
      || !['complete_for_query', 'partial', 'unknown'].includes(c.state) || !strings(c.reasons, 32) || !distinct(c.reasons) || !uint(c.pages_observed)
      || ![true, false, null].includes(c.query_exhausted) || c.authorization_limited !== (tool !== 'fhir_capabilities')
      || tool !== 'fhir_capabilities' && !c.reasons.includes('CLINICAL_RECORD_COMPLETENESS_UNKNOWN')
      || !['none', 'metadata_snapshot', 'exact_id_and_subject_linkage', 'declared_and_self_link_only', 'tested_adapter', 'unverified_continuation', 'retained_snapshot'].includes(c.query_evidence)
      || c.query_digest !== undefined && !isSha256(c.query_digest) || c.constraints_on_first_page !== undefined && c.constraints_on_first_page !== true) return false;
    if (c.constraints !== undefined && (!Array.isArray(c.constraints) || c.constraints.length > 31 || c.constraints.some(v =>
      !objectShape(v, ['name', 'value', 'source_reported', 'execution'], ['evidence_ref']) || !text(v.name, 160) || !text(v.value, 2048)
      || !['matched', 'not_reported', 'not_checked'].includes(v.source_reported as string) || !['gateway_enforced', 'tested_adapter', 'unknown'].includes(v.execution as string)))) return false;
    if (c.sort !== undefined && (!objectShape(c.sort, ['effective', 'evidence', 'order'], ['requested']) || c.sort.requested !== undefined && !strings(c.sort.requested, 4)
      || c.sort.effective !== null && !strings(c.sort.effective, 4) || !['declared', 'observed_supported', 'observed_unsupported', 'unknown'].includes(c.sort.evidence)
      || !['unspecified', 'requested_unverified', 'verified_by_adapter'].includes(c.sort.order))) return false;
    const output = isRecord(input.output) ? input.output : {};
    if (!objectShape(t, ['format', 'projected', 'withheld_payloads', 'omitted_fields', 'unresolved_fields', 'narrative_omitted', 'recipe_ids', 'structural_resource_indices', 'delivery_profile'], ['requested_format'])
      || t.format !== (output.format ?? 'fhir') || t.requested_format !== output.format || t.delivery_profile !== 'full-text-v1'
      || typeof t.projected !== 'boolean' || typeof t.narrative_omitted !== 'boolean' || !strings(t.omitted_fields) || !strings(t.unresolved_fields) || !strings(t.recipe_ids)
      || !distinct(t.omitted_fields) || !distinct(t.recipe_ids) || !distinct(t.unresolved_fields) || !Array.isArray(t.withheld_payloads)
      || t.withheld_payloads.some(v => !objectShape(v, ['path', 'reason'], ['content_type', 'size', 'hash', 'count', 'spans']) || !text(v.path, 512) || !v.path.startsWith('/') || !text(v.reason, 80)
        || v.content_type !== undefined && typeof v.content_type !== 'string' || v.hash !== undefined && typeof v.hash !== 'string'
        || ['size', 'count', 'spans'].some(k => v[k] !== undefined && !uint(v[k])))
      || !Array.isArray(t.structural_resource_indices) || !distinct(t.structural_resource_indices) || !t.structural_resource_indices.every(i => uint(i, 99))) return false;
    if (!objectShape(e.budget, ['bytes_returned', 'byte_limit', 'limit_reached', 'upstream_calls', 'elapsed_ms'])
      || !uint(e.budget.bytes_returned) || !uint(e.budget.byte_limit, 131072) || e.budget.byte_limit < 4096 || typeof e.budget.limit_reached !== 'boolean'
      || !uint(e.budget.upstream_calls) || !uint(e.budget.elapsed_ms) || !Array.isArray(e.warnings) || e.warnings.length > 32
      || e.warnings.some(w => !objectShape(w, ['code', 'message'], ['repair']) || !text(w.code, 80) || typeof w.message !== 'string' || w.message.length > 320 || !repairShape(w.repair))) return false;
    if (e.error) {
      // These are the helper tasks' only expected errors. Other outcomes also fail the exact per-step outcome gate.
      const safe = e.error.code === 'NOT_FOUND' ? NOT_SERVED_MESSAGE : e.error.code === 'RESULT_EXPIRED' ? EXPIRED_MESSAGE : undefined;
      return objectShape(e.error, ['code', 'safe_message', 'retryable'], ['repair']) && safe !== undefined && e.error.safe_message === safe && typeof e.error.retryable === 'boolean'
        && (e.error.repair === undefined || objectShape(e.error.repair, ['action']) && e.error.repair.action === 'repeat_original_query')
        && Object.keys(data).length === 0 && e.provenance === undefined && e.result === undefined && p === undefined && e.warnings.length === 0
        && c.scope === (tool === 'fhir_capabilities' ? 'metadata' : 'query') && c.state === 'unknown' && c.query_evidence === 'none' && c.query_exhausted === null && c.pages_observed === 0
        && c.query_digest === undefined && c.constraints === undefined && c.constraints_on_first_page === undefined && c.sort === undefined
        && c.reasons.every(r => r === 'CLINICAL_RECORD_COMPLETENESS_UNKNOWN' || r === e.error!.code)
        && !t.projected && !t.narrative_omitted && !t.withheld_payloads.length && !t.omitted_fields.length && !t.unresolved_fields.length && !t.recipe_ids.length && !t.structural_resource_indices.length;
    }
    if (c.query_evidence === 'none') return false;
    if (e.result && (!objectShape(e.result, ['handle', 'expires_at', 'formats']) || !text(e.result.handle, 160) || !validTimestamp(e.result.expires_at)
      || !strings(e.result.formats, 2) || !distinct(e.result.formats) || !e.result.formats.length || e.result.formats.some(f => !['compact', 'fhir'].includes(f)) || !e.result.formats.includes(t.format))) return false;
    if (tool === 'fhir_capabilities') {
      if (e.provenance !== undefined || p !== undefined || e.result !== undefined || c.scope !== 'metadata' || c.query_evidence !== 'metadata_snapshot' || c.pages_observed !== 0 || t.projected
        || t.omitted_fields.length || t.withheld_payloads.length || t.structural_resource_indices.length) return false;
      return metadataShape(input, data, e.source.capability_revision, c);
    }
    if (tool === 'fhir_result' && input.action === 'inspect') {
      if (!objectShape(data, ['resource_count', 'scope', 'upstream_pages_remain', 'formats', 'omissions'], ['next_offset']) || !uint(data.resource_count) || data.scope !== 'retained_upstream_page'
        || ![true, false, null].includes(data.upstream_pages_remain as boolean | null) || !Array.isArray(data.omissions) || data.omissions.length > Number(input.limit ?? 20)
        || p !== undefined || e.provenance !== undefined || !e.result || !strings(data.formats, 2) || canonicalJson(data.formats) !== canonicalJson(e.result.formats)) return false;
      const offset = typeof input.offset === 'number' ? input.offset : 0;
      if (offset + data.omissions.length > data.resource_count || data.next_offset !== (offset + data.omissions.length < data.resource_count ? offset + data.omissions.length : undefined)) return false;
      if (data.omissions.some((row, i) => !objectShape(row, ['resource_index', 'resource_type', 'omitted_fields', 'withheld_reasons', 'interpretation'], ['id', 'version', 'recipe_id'])
        || row.resource_index !== i || typeof row.resource_type !== 'string' || !strings(row.omitted_fields) || !strings(row.withheld_reasons) || !['clinical_projection', 'structural'].includes(row.interpretation as string))) return false;
    } else {
      if (!objectShape(data, ['resources'], ['next_offset', 'manifest']) || !Array.isArray(data.resources) || data.resources.length > 100
        || data.resources.some(r => !isRecord(r) || !/^[A-Z][A-Za-z0-9]+$/.test(r.resourceType as string) || typeof r.id !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(r.id) || ['.', '..'].includes(r.id))) return false;
      const rows = resourcesOf(e), count = rows.length;
      if (!Array.isArray(e.provenance) || e.provenance.length !== count || citedIndexes(e).size !== count
        || e.provenance.some(v => !objectShape(v, ['resource_index', 'retrieved_at']) || !validTimestamp(v.retrieved_at))
        || rows.some(r => isRecord(r.meta) && r.meta.versionId !== undefined && (typeof r.meta.versionId !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(r.meta.versionId)))
        || !distinct(rows.map(r => canonicalJson([r.resourceType, r.id, isRecord(r.meta) ? r.meta.versionId : undefined]))) || rows.some(r => r.resourceType !== (resourceType ?? input.resource_type ?? rows[0]?.resourceType))) return false;
      if (!objectShape(p, ['has_more', 'returned_matches', 'returned_includes'], ['next_cursor', 'requested_page_size', 'total'])
        || ![true, false, null].includes(p.has_more) || p.returned_matches !== count || p.returned_includes !== 0 || p.next_cursor !== undefined && !text(p.next_cursor, 160)) return false;
      if (p.total !== undefined && (!objectShape(p.total, ['precision'], ['value']) || !['accurate', 'estimate', 'unknown'].includes(p.total.precision)
        || p.total.value !== undefined && (!uint(p.total.value) || p.has_more !== false || c.query_exhausted !== true || p.total.precision !== 'unknown' || p.total.value !== count))) return false;
      if (tool === 'fhir_read') {
        if (count !== 1 || rows[0]!.id !== input.id || p.has_more !== false || p.next_cursor !== undefined || p.requested_page_size !== undefined
          || c.scope !== 'resource' || c.query_evidence !== 'exact_id_and_subject_linkage' || data.next_offset !== undefined) return false;
      } else if (tool === 'fhir_search' || tool === 'fhir_page') {
        if (c.scope !== 'page' || p.requested_page_size !== pageSize || !uint(pageSize, 100) || pageSize < 1 || count > pageSize
          || (p.has_more === true) !== (p.next_cursor !== undefined) || data.next_offset !== undefined
          || p.has_more === true && c.query_exhausted !== false || p.has_more === null && c.query_exhausted !== null) return false;
      } else if (tool === 'fhir_result') {
        if (!e.result || e.result.handle !== input.handle || p.next_cursor !== undefined || p.requested_page_size !== undefined || p.has_more === null
          || (p.has_more === true) !== (data.next_offset !== undefined) || count > Number(input.limit ?? 20)
          || data.next_offset !== undefined && data.next_offset !== Number(input.offset ?? 0) + count) return false;
      } else return false;
    }
    if (tool === 'fhir_result' && (c.scope !== 'retained' || c.state !== 'partial' || c.query_exhausted !== null || c.query_evidence !== 'retained_snapshot'
      || !c.reasons.includes('RETAINED_PAGE_IS_NOT_THE_ENTIRE_QUERY'))) return false;
    return true;
  } catch { return false; }
}

/** The operator config, bound to the run: synthetic mode, the manifest's own target, and the seed's one natural patient. */
export function boundConfig(value: unknown, manifest: SeedManifest, target: string): ResponseBinding & { patientId: string } {
  const natural = manifest.resources.filter(r => r.type === 'Patient' && r.origin === 'natural');
  const invalid = (): never => { throw fault('VERIFY_CONFIG_INVALID'); };
  if (!objectShape(value, ['mode', 'source', 'patientId'], ['privacy', 'contextId', 'textMode', 'workflow', 'delivery', 'discovery', 'limits']) || value.mode !== 'synthetic'
    || !objectShape(value.source, ['baseUrl', 'alias'], ['searchProfile', 'auth']) || value.source.baseUrl !== target || typeof value.source.alias !== 'string'
    || !/^[A-Za-z0-9_-]{1,80}$/.test(value.source.alias) || natural.length !== 1 || value.patientId !== natural[0]!.id) return invalid();
  if (value.contextId !== undefined && (typeof value.contextId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(value.contextId))
    || value.textMode !== undefined && !['envelope', 'summary'].includes(value.textMode as string)
    || value.workflow !== undefined && value.workflow !== 'recent-labs-v1'
    || value.source.searchProfile !== undefined && !['generic-r4', 'synthetic-fixture-r4-v1'].includes(value.source.searchProfile as string)) return invalid();
  // This recipe judges the default full-envelope text delivery. Other delivery profiles have their own host gates.
  if (value.delivery !== undefined && (!objectShape(value.delivery, [], ['profile', 'hostProfileId'])
    || value.delivery.profile !== undefined && value.delivery.profile !== 'full-text-v1'
    || value.delivery.hostProfileId !== undefined && (typeof value.delivery.hostProfileId !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,79}$/.test(value.delivery.hostProfileId)))) return invalid();
  if (value.privacy !== undefined && (!objectShape(value.privacy, [], ['patientIdentifierSystems']) || value.privacy.patientIdentifierSystems !== undefined
    && (!strings(value.privacy.patientIdentifierSystems, 32) || value.privacy.patientIdentifierSystems.some(v => !v || v.length > 256 || v !== v.trim() || /[\x00-\x20\x7f]/.test(v) || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v) || !URL.canParse(v))))) return invalid();
  const auth = value.source.auth;
  if (auth !== undefined && (!objectShape(auth, ['type', 'tokenUrl', 'clientId', 'clientSecretEnv'], ['scopes']) || auth.type !== 'client_credentials'
    || !text(auth.tokenUrl, 2048) || !URL.canParse(auth.tokenUrl) || !text(auth.clientId, 256) || typeof auth.clientSecretEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(auth.clientSecretEnv)
    || auth.scopes !== undefined && (!strings(auth.scopes, 20) || auth.scopes.some(v => !v || v.length > 128)))) return invalid();
  const ranges: Record<string, readonly [number, number]> = { defaultBytes: [8192, 131072], maxBytes: [8192, 131072], upstreamBytes: [256, 20 * 1024 * 1024],
    retentionBytes: [256, 100 * 1024 * 1024], ttlMs: [1, 900000], timeoutMs: [1, 30000], maxHandles: [1, 1000], deadlineMs: [1, 200000], maxQueue: [0, 256] };
  const validNumbers = (v: unknown, bounds: Record<string, readonly [number, number]>) => objectShape(v, [], Object.keys(bounds))
    && Object.entries(v).every(([k, n]) => uint(n, bounds[k]![1]) && n >= bounds[k]![0]);
  if (value.limits !== undefined && !validNumbers(value.limits, ranges) || value.discovery !== undefined
    && !validNumbers(value.discovery, { metadataTtlMs: [1, 900000], snapshotBytes: [4096, 2097152], maxHandles: [1, 128] })) return invalid();
  const limits = isRecord(value.limits) ? value.limits : {};
  if (typeof limits.defaultBytes === 'number' && typeof limits.maxBytes === 'number' && limits.defaultBytes > limits.maxBytes) return invalid();
  const maxBytes = typeof limits.maxBytes === 'number' ? limits.maxBytes : 131072;
  return { alias: value.source.alias, patientId: value.patientId as string, fhirVersion: manifest.backend.fhirVersion, maxBytes,
    defaultBytes: Math.min(typeof limits.defaultBytes === 'number' ? limits.defaultBytes : 24576, maxBytes), ...(typeof value.contextId === 'string' ? { contextId: value.contextId } : {}) };
}
/** The latest result's order is claimed only when an adapter verified the sort; otherwise the run says so. */
export function orderLimitations(task: PackageTask, calls: readonly OracleCall[]): string[] {
  const sorted = task.steps.findIndex(step => Array.isArray(step.input.params) && step.input.params.some(p => isRecord(p) && p.name === '_sort'));
  if (sorted < 0) return [];
  const order = calls.find(call => call.step === sorted && call.envelope)?.envelope?.coverage?.sort?.order;
  return order === 'verified_by_adapter' ? [] : ['LATEST_UNVERIFIED'];
}

/** Executes one task's steps in one session: handles from earlier steps, TTL waits, bounded drains, the arm's view. */
export async function runTaskSteps(task: PackageTask, arm: ArmName, session: GatewaySession, record: (step: number, call: RecordedCall) => void,
  wait: (ms: number) => Promise<void> = ms => delay(ms)): Promise<TaskCall[]> {
  const calls: TaskCall[] = [], handles: (string | undefined)[] = [];
  const keep = (step: number, tool: string, input: Record<string, unknown>, recorded: RecordedCall): RecordedCall => {
    record(step, recorded);
    calls.push({ step, tool, input: structuredClone(input), ...(recorded.rawFrame ? { rawFrame: recorded.rawFrame, requestId: recorded.requestId } : {}), ...(recorded.envelope ? { envelope: recorded.envelope } : {}), ...(recorded.rawText !== undefined ? { rawText: recorded.rawText } : {}),
      ...(recorded.outcome ? { outcome: recorded.outcome } : {}), work: recorded.work, ...(task.steps[step]!.resourceType ? { resourceType: task.steps[step]!.resourceType } : {}),
      resultBytes: recorded.resultBytes, frameBytes: recorded.frameBytes });
    return recorded;
  };
  for (const [index, step] of task.steps.entries()) {
    if (step.waitMs) await wait(step.waitMs);
    const input: Record<string, unknown> = { ...structuredClone(step.input), output: armOutput(task, arm, step.tool) };
    if (step.handleFrom !== undefined) {
      const handle = handles[step.handleFrom];
      if (handle === undefined) throw fault('VERIFY_HANDLE_MISSING');
      input.handle = handle;
    }
    let recorded = keep(index, step.tool, input, await session.call(step.tool, input));
    handles[index] = recorded.envelope?.result?.handle;
    for (let pages = 0; step.drain && recorded.envelope && !recorded.envelope.error && recorded.envelope.pagination?.next_cursor; pages++) {
      if (pages >= VERIFY_LIMITS.drainPages) throw fault('VERIFY_DRAIN_LIMIT');
      const pageInput = { cursor: recorded.envelope.pagination.next_cursor, output: armOutput(task, arm, 'fhir_page') };
      recorded = keep(index, 'fhir_page', pageInput, await session.call('fhir_page', pageInput));
    }
  }
  return calls;
}

/** Coverage the gateway itself reports as unverified for a run: an opaque upstream continuation, unexecuted filters. */
export function coverageLimitations(calls: readonly OracleCall[]): string[] {
  const coverage = calls.flatMap(call => (call.envelope ? [call.envelope.coverage] : []));
  return [...(coverage.some(c => c?.query_evidence === 'unverified_continuation') ? ['CONTINUATION_UNVERIFIED'] : []),
    ...(coverage.some(c => c?.reasons?.includes('FILTER_EXECUTION_UNVERIFIED')) ? ['FILTER_UNVERIFIED'] : [])];
}

const outcomeOf = (call: OracleCall): CallOutcomeRecord | undefined =>
  call.outcome ?? (call.envelope?.error ? { class: 'application_error', code: call.envelope.error.code } : undefined);
/**
 * Every recorded call before any task check, independently of what the checks look at: each step answered; result bytes
 * are the captured result member's, within the requested ceiling and equal to the gateway's own accounting; the decoded
 * envelope is the raw result's structured content; one gateway identity per run; each step's query chain resolves; and
 * an error outcome occurs only alone, on a step whose checks expect exactly that outcome. Fixed ids, no data.
 */
export function callInvariants(task: PackageTask, calls: readonly TaskCall[], binding: ResponseBinding = { alias: 'qs-hapi', fhirVersion: '4.0.1', maxBytes: 131072, defaultBytes: 24576 }): string[] {
  const failing = new Set<string>();
  const identities = new Set(calls.flatMap(call => (call.envelope ? [canonicalJson([call.envelope.schema_version, call.envelope.source, call.envelope.context])] : [])));
  if (identities.size > 1) failing.add('invariant:identity');
  for (const [step, definition] of task.steps.entries()) {
    const own = calls.filter(call => call.step === step);
    const expected = task.checks.filter((check): check is Check & { kind: 'callOutcome' } => check.kind === 'callOutcome' && check.step === step);
    if (!own.length) failing.add(`invariant:missing:${step}`);
    for (const call of own) {
      const input = call.input ?? { ...definition.input, output: { format: 'fhir', max_bytes: task.perCallBytes } };
      const ceiling = effectiveCeiling(input, binding);
      if (call.rawText === undefined || Buffer.byteLength(call.rawText) !== call.resultBytes || call.resultBytes > ceiling) failing.add(`invariant:bytes:${step}`);
      if (call.envelope) {
        let structured: unknown;
        try { structured = (JSON.parse(call.rawText ?? '') as Record<string, unknown>).structuredContent; } catch { structured = undefined; }
        if (canonicalJson(structured) !== canonicalJson(call.envelope)) failing.add(`invariant:decoded:${step}`);
        if (call.envelope.budget?.bytes_returned !== call.resultBytes || call.envelope.budget?.byte_limit !== ceiling) failing.add(`invariant:accounting:${step}`);
      }
      if (call.envelope && !responseValid(call.tool ?? definition.tool, input, call.envelope, call.rawText ?? '', binding, Number(definition.input.page_size ?? 20), definition.resourceType)) failing.add(`invariant:response:${step}`);
      if (call.rawFrame !== undefined) {
        try {
          const frame = JSON.parse(call.rawFrame);
          if (frame.jsonrpc !== '2.0' || frame.id !== call.requestId || Buffer.byteLength(call.rawFrame) !== call.frameBytes || rawMember(call.rawFrame, 'result') !== call.rawText) failing.add(`invariant:frame:${step}`);
        } catch { failing.add(`invariant:frame:${step}`); }
      }
      const outcome = outcomeOf(call);
      if (outcome ? own.length !== 1 || !expected.some(c => c.outcome === outcome.class && String(c.code) === String(outcome.code)) : !call.envelope)
        failing.add(`invariant:outcome:${step}`);
    }
    try { if (resolveQueryChain(own.flatMap(call => (call.envelope ? [call.envelope] : [])), definition.resourceType).error) failing.add(`invariant:chain:${step}`); }
    catch { failing.add(`invariant:chain:${step}`); }
  }
  return [...failing];
}

/** Judges a task run: the per-call invariants, then every check on its own step's calls (the step's trusted resource type bound). */
export function judgeTask(task: PackageTask, arm: ArmName, calls: readonly TaskCall[], binding?: ResponseBinding): { results: CheckResult[]; run: Omit<TaskRun, 'era'> } {
  const invariants = callInvariants(task, calls, binding);
  const results = task.checks.map(check => {
    const step = boundStep(check, task.steps.length);
    try { return evaluateStepCheck(check, arm, calls, { stepCount: task.steps.length, requests: [], ...(step !== undefined && task.steps[step]!.resourceType ? { resourceType: task.steps[step]!.resourceType } : {}) }); }
    catch { return { check_id: check.id, kind: check.kind, status: 'fail', cause: 'envelope_invalid', detail: 'The bound response is invalid.' } as CheckResult; }
  });
  const failing = [...invariants, ...results.filter(r => r.status !== 'pass' && r.status !== 'incomparable').map(r => r.check_id)];
  return { results, run: { task: task.id, arm, status: failing.length ? 'fail' : 'pass', failing,
    checks: { passed: results.filter(r => r.status === 'pass').length, failed: failing.length, incomparable: results.filter(r => r.status === 'incomparable').length },
    limitations: [...new Set([...orderLimitations(task, calls), ...coverageLimitations(calls)])].sort() } };
}

export async function verify(input: Readonly<{ runDirectory: string; node: string; cli: string; config: string; assets: HelperAssets }>,
  dependencies: Readonly<{ openSession: SessionFactory; doctor?: DoctorRunner; wait?: (ms: number) => Promise<void>; eras?: readonly VerifyEra[]; arms?: readonly ArmName[];
    /** The gateway base URL the config must name; the manifest's own target unless a test injects its fixture's. */
    target?: string }>): Promise<VerifyReport> {
  // Serialize one run's verifications; never overwrite another verification's snapshots or evidence.
  await readRunReceipt(input.runDirectory);
  const unlock = await lockRun(input.runDirectory, 'verify.lock');
  try { return await verifyLocked(input, dependencies); } finally { await unlock(); }
}

async function verifyLocked(input: Parameters<typeof verify>[0], dependencies: Parameters<typeof verify>[1]): Promise<VerifyReport> {
  // The run: a completed prepare of these helper assets, whose closed packet is the one its receipt and attempt bind.
  const { manifest, manifestSha256, puts } = validateHelperAssets(input.assets);
  const receipt = await readRunReceipt(input.runDirectory);
  if (receipt.phase !== 'complete' || receipt.manifestSha256 !== manifestSha256 || receipt.composeSha256 !== manifest.composeSha256 || receipt.instance?.composeSha256 !== manifest.composeSha256) throw fault('VERIFY_RUN_INVALID');
  const attemptBytes = await readPrivateFile(join(input.runDirectory, 'attempt.json'));
  if (sha256(attemptBytes) !== receipt.attemptSha256) throw fault('VERIFY_RUN_INVALID');
  let attempt: unknown;
  try { attempt = JSON.parse(attemptBytes.toString('utf8')); } catch { throw fault('VERIFY_RUN_INVALID'); }
  if (!validRunReceipt(attempt) || attempt.phase !== 'seeding' || attempt.attemptSha256 !== null || attempt.packetSha256 !== null
    || canonicalJson(attempt) !== canonicalJson({ ...receipt, phase: 'seeding', attemptSha256: null, packetSha256: null })) throw fault('VERIFY_RUN_INVALID');
  const packetBytes = await readPrivateFile(join(input.runDirectory, 'setup-packet.json'));
  if (sha256(packetBytes) !== receipt.packetSha256) throw fault('VERIFY_RUN_INVALID');
  let packet: unknown;
  try { packet = JSON.parse(packetBytes.toString('utf8')); } catch { throw fault('VERIFY_RUN_INVALID'); }
  if (!validPacket(packet, receipt, manifestSha256, puts)) throw fault('VERIFY_RUN_INVALID');
  // The operator config, read once and bound; its private snapshot is what the doctor and every session launch with.
  const configBytes = await readBounded(input.config, 1_048_576).catch(() => { throw fault('VERIFY_CONFIG_INVALID'); });
  let config: Record<string, unknown>;
  try { config = JSON.parse(configBytes.toString('utf8')) as Record<string, unknown>; } catch { throw fault('VERIFY_CONFIG_INVALID'); }
  const binding = boundConfig(config, manifest, dependencies.target ?? `${manifest.target.origin}${manifest.target.basePath}`);
  const { alias, patientId } = binding;
  const directory = await mkdtemp(join(input.runDirectory, 'verify-'));
  await chmod(directory, 0o700);
  const snapshot = join(directory, 'verify-gateway.config.json');
  await atomicPrivateWrite(snapshot, configBytes);
  const cliBytes = await readBounded(input.cli, VERIFY_LIMITS.cliBytes).catch(() => { throw fault('VERIFY_DOCTOR'); });
  const artifact = await gatewayArtifact(input.cli).catch(() => { throw fault('VERIFY_DOCTOR'); });
  const versions = new Map(packet.resources.map(r => [r.target, r.versionId]));
  const tasks = packageTasks(seedFacts(Buffer.from(input.assets.resources).toString('utf8'), `Patient/${patientId}`, versions), alias);

  const doctor = await (dependencies.doctor ?? spawnDoctor)({ node: input.node, cli: input.cli, config: snapshot });
  if (sha256(await readPrivateFile(snapshot)) !== sha256(configBytes)) throw fault('VERIFY_CONFIG_INVALID');
  const lines = doctor.stdout.split('\n'), line = (prefix: string) => lines.find(l => l.startsWith(prefix));
  const gateway = line('gateway: '), runtime = line('runtime: ');
  if (doctor.exitCode !== 0 || lines[0] !== 'doctor: ready' || !gateway || !/^gateway: fireboat \S+ schema=\S+ catalog=\S+$/.test(gateway) || !runtime
    || !line(`source: alias=${alias} `)) throw fault('VERIFY_DOCTOR');

  // Tasks that demonstrate operator limits (the drain task's TTL) run against a derived private config.
  const configFor = async (task: PackageTask): Promise<string> => {
    if (!task.limits) return snapshot;
    const path = join(directory, `verify-${task.id}.config.json`);
    await atomicPrivateWrite(path, jsonBytes({ ...config, limits: { ...(isRecord(config.limits) ? config.limits : {}), ...task.limits } }));
    return path;
  };
  const configs = new Map<string, { path: string; bytes: Buffer }>();
  configs.set('verify-gateway.config.json', { path: snapshot, bytes: configBytes });
  const taskConfigs = new Map<PackageTaskId, string>();
  for (const task of tasks) {
    const path = await configFor(task); taskConfigs.set(task.id, path);
    if (path !== snapshot) configs.set(basename(path), { path, bytes: await readPrivateFile(path) });
  }
  const assertConfig = async (path: string) => {
    const expected = configs.get(basename(path));
    if (!expected || sha256(await readPrivateFile(path)) !== sha256(expected.bytes)) throw fault('VERIFY_CONFIG_INVALID');
  };
  const evidence: string[] = [], runs: TaskRun[] = [], controls: VerifyReport['controls'][number][] = [];
  let completeFrames = true;
  const capture = (kind: string, era: VerifyEra, call: RecordedCall, extra: Record<string, unknown> = {}) => {
    if (!call.rawFrame || !call.frames?.some(f => f.direction === 'received' && f.text === call.rawFrame)) completeFrames = false;
    evidence.push(JSON.stringify({ kind, era, ...extra, requestId: call.requestId,
    rawFrame: call.rawFrame ?? null, frames: call.frames ?? null, rawText: call.rawText ?? null, outcome: call.outcome ?? null, work: call.work, resultBytes: call.resultBytes, frameBytes: call.frameBytes }));
  };
  // One clean and one observed discovery session per era: IDs and timing fields are excluded; byte accounting is checked separately.
  const controlValue = (call: RecordedCall) => {
    const value: unknown = structuredClone(call.envelope);
    if (!isRecord(value)) return value;
    delete value.request_id;
    if (isRecord(value.data)) { delete value.data.captured_at; delete value.data.expires_at; }
    if (!isRecord(value.budget)) return value;
    value.budget.elapsed_ms = 0;
    // Byte accounting is derived from those timing fields and both full-text channels. Validate the original bytes
    // independently, then recompute this field for comparison instead of treating differing timing widths as evidence.
    value.budget.bytes_returned = 0;
    let result: unknown;
    try { result = JSON.parse(call.rawText ?? ''); } catch { return value; }
    if (!isRecord(result)) return value;
    for (let i = 0; i < 8; i++) {
      const bytes = Buffer.byteLength(JSON.stringify({ ...result, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }));
      if (value.budget.bytes_returned === bytes) break;
      value.budget.bytes_returned = bytes;
    }
    // Context handles are random when omitted; both control children use one explicit context in their derived config.
    return value;
  };
  const controlPath = join(directory, 'verify-control.config.json');
  const controlBytes = jsonBytes({ ...config, contextId: config.contextId ?? 'ctx_quickstart_verify_control' });
  await atomicPrivateWrite(controlPath, controlBytes); configs.set(basename(controlPath), { path: controlPath, bytes: controlBytes });
  const controlBinding = { ...binding, contextId: String(config.contextId ?? 'ctx_quickstart_verify_control') };
  for (const era of dependencies.eras ?? VERIFY_ERAS) {
    const results: RecordedCall[] = [];
    const request = { topic: 'support', resource_type: 'Observation', output: { format: 'fhir', max_bytes: 24576 } };
    for (const observe of [false, true]) {
      await assertConfig(controlPath);
      const session = await dependencies.openSession({ node: input.node, cli: input.cli, config: controlPath, era, observe });
      try { const call = await session.call('fhir_capabilities', request); results.push(call); capture(observe ? 'observed-control' : 'clean-control', era, call); } finally { await session.close(); await assertConfig(controlPath); }
    }
    const [clean, observed] = results as [RecordedCall, RecordedCall];
    const cleanSha256 = sha256(canonicalJson(controlValue(clean))), observedSha256 = sha256(canonicalJson(controlValue(observed)));
    const controlTask: PackageTask = { id: 'package-latest-hba1c', question: 'Discovery control', fields: [], perCallBytes: 24576, checks: [], steps: [{ tool: 'fhir_capabilities', input: request }] };
    const valid = (call: RecordedCall) => callInvariants(controlTask, [{ ...call, step: 0, tool: 'fhir_capabilities', input: request }], controlBinding).length === 0;
    controls.push({ era, status: valid(clean) && valid(observed) && cleanSha256 === observedSha256 ? 'pass' : 'fail', cleanSha256, observedSha256 });
  }
  for (const era of dependencies.eras ?? VERIFY_ERAS) for (const task of tasks) for (const arm of dependencies.arms ?? VERIFY_ARMS) {
    const taskConfig = taskConfigs.get(task.id)!;
    await assertConfig(taskConfig);
    const session = await dependencies.openSession({ node: input.node, cli: input.cli, config: taskConfig, era, observe: true });
    let calls: TaskCall[];
    try {
      calls = await runTaskSteps(task, arm, session, (step, call) => capture('task', era, call, { task: task.id, arm, step }), dependencies.wait);
    } finally { await session.close(); await assertConfig(taskConfig); }
    runs.push({ era, ...judgeTask(task, arm, calls, binding).run });
  }
  const after = await gatewayArtifact(input.cli).catch(() => { throw fault('VERIFY_DOCTOR'); });
  if (after.sha256 !== artifact.sha256 || after.files !== artifact.files || sha256(await readBounded(input.cli, VERIFY_LIMITS.cliBytes)) !== sha256(cliBytes)) throw fault('VERIFY_DOCTOR');
  for (const { path, bytes } of configs.values()) if (sha256(await readPrivateFile(path)) !== sha256(bytes)) throw fault('VERIFY_CONFIG_INVALID');
  if (controls.some(c => c.status !== 'pass') || !completeFrames) for (const run of runs) { run.status = 'fail'; run.failing = [...run.failing, ...(!completeFrames ? ['invariant:frames'] : []), ...(controls.some(c => c.status !== 'pass') ? ['invariant:clean-control'] : [])]; run.checks.failed = run.failing.length; }
  const evidenceBytes = Buffer.from(evidence.map(line => `${line}\n`).join(''));
  await atomicPrivateWrite(join(directory, 'verify-evidence.ndjson'), evidenceBytes);
  const report: VerifyReport = { schema: 'fireboat-quickstart-verify/1', runId: receipt.runId, verificationId: basename(directory), manifestSha256, packetSha256: receipt.packetSha256!, doctor: 'ready',
    launch: { cliSha256: sha256(cliBytes), artifactSha256: artifact.sha256, artifactFiles: artifact.files, configSha256: sha256(configBytes), configs: [...configs].map(([name, value]) => ({ name, sha256: sha256(value.bytes) })), gateway: gateway.slice('gateway: '.length), runtime: runtime.slice('runtime: '.length) },
    instrumentation: 'request-observer', controls, runs,
    passed: runs.filter(r => r.status === 'pass').length, failed: runs.filter(r => r.status === 'fail').length, evidenceSha256: sha256(evidenceBytes) };
  await atomicPrivateWrite(join(directory, 'verify-report.json'), jsonBytes(report));
  return report;
}
