#!/usr/bin/env node
/**
 * Scoped mutation gate (V-14 / J-18).
 *
 * Each designated guard mutant is an exact {id, file, find, replace} edit (or
 * an explicit compound list of such edits, each matching exactly once) that
 * disables or weakens one named guard. The mutant is applied to a temporary
 * copy of the tree (node_modules symlinked, never the real checkout), then the
 * full unit suite runs; mutants declaring suites: [unit, isolation] also run
 * the full isolation suite. Both suites have green clean-copy baselines. The anchor-maintenance test runs
 * only in that baseline: its expected mutation-induced mismatch cannot earn a kill. A
 * reproduced named isolation failure is judged in that same suite, never
 * mistaken for a unit-suite kill. Typecheck/build failures are inconclusive,
 * never kills. Suite declarations and all compound edits are hash-bound. If
 * the declared suites still pass, the retrieval evals run in
 * both protocol eras.
 *
 * A failure is never trusted on first sight: the failing test names are
 * recorded (TAP) and the mutant is judged a second time. It is KILLED only
 * when the failure reproduces — at least one of the same tests (or the same
 * eval era) fails again, or both runs time out in the same suite/era. A failure that does not
 * reproduce is INCONCLUSIVE: the gate fails and names the flaky tests rather
 * than silently passing or misreading the flake as a kill. The gate also
 * fails when a mutant survives without a reviewed entry in
 * scripts/mutation-survivors.json, when an anchor no longer matches exactly
 * once, or when a declared survivor is actually killed (stale justification).
 *
 * Concurrency is bounded as a whole: workers × per-suite --test-concurrency
 * never exceeds the available parallelism, so parallel suite copies cannot
 * oversubscribe the machine (the original source of load-sensitive flakes).
 *
 * Runs fully offline. Usage:
 *   node scripts/mutation-guards.mjs [--workers N] [--test-concurrency N] [--only id1,id2]
 *   node scripts/mutation-guards.mjs --shard i/n [--out <dir> | --report <file>] [--workers N]
 *   node scripts/mutation-guards.mjs --aggregate <dir> [--shards n]
 *   node scripts/mutation-guards.mjs --list
 *
 * Sharding (S0): --shard i/n judges a deterministic partition of the full
 * mutant list and writes one JSON shard report. The frozen list's ordinal
 * assigns mutant i to shard (i % n) + 1, as agreed in integration plan A2.
 * Each report binds the candidate, inputs, survivors and exact runtime.
 * --aggregate is
 * the authority for sharded runs: it re-checks the complete result set
 * (exactly once per mutant, no missing shard, no undeclared survivor or
 * inconclusive result, and the global stale-survivor check that --only
 * diagnostic runs deliberately skip). --only cannot be combined with
 * --shard or --aggregate, so a diagnostic subset can never earn acceptance.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const CPUS = Math.max(1, availableParallelism());
const workersArg = args.indexOf('--workers');
const WORKERS = workersArg >= 0 ? Math.max(1, Number(args[workersArg + 1]) || 1) : Math.min(2, CPUS);
const testConcurrencyArg = args.indexOf('--test-concurrency');
// Default: workers × TEST_CONCURRENCY ≈ CPUS. Node's test runner otherwise parallelises test
// files up to the full CPU count inside every worker copy, multiplying the load.
const TEST_CONCURRENCY = testConcurrencyArg >= 0 ? Math.max(1, Number(args[testConcurrencyArg + 1]) || 1) : Math.max(1, Math.floor(CPUS / WORKERS));
const onlyArg = args.indexOf('--only');
const ONLY = onlyArg >= 0 ? new Set(String(args[onlyArg + 1] ?? '').split(',').filter(Boolean)) : undefined;
export const BASELINE_TIMEOUT_MS = 240_000;
const MAX_SUITE_TIMEOUT_MS = 900_000;
// Each entry is replaced by its own clean measurement before any mutant is judged.
const testTimeoutMs = { unit: 30_000, isolation: 30_000, 'evals:modern': 30_000, 'evals:legacy': 30_000 };

export function suiteTimeoutCap(suite, baselineMs) {
  if (!Number.isFinite(baselineMs) || baselineMs < 0) throw new Error(`invalid ${suite} baseline ${baselineMs}`);
  const cap = Math.min(MAX_SUITE_TIMEOUT_MS, Math.max(30_000, 6 * baselineMs));
  if (cap < 2 * baselineMs) throw new Error(`${suite} baseline ${baselineMs}ms has unsafe cap ${cap}ms (< 2 × baseline); lower --workers or --test-concurrency`);
  return cap;
}

/** No mutant is scheduled until every used suite, including each eval era, is safe. */
export async function measureSuiteBaselines(suites, runBaseline, log = console.log) {
  const measurements = {};
  for (const suite of suites) {
    let baseline;
    for (let attempt = 1; attempt <= 2; attempt++) {
      baseline = await runBaseline(suite, BASELINE_TIMEOUT_MS);
      if (baseline.timedOut || baseline.durationMs > BASELINE_TIMEOUT_MS) {
        throw new Error(`${suite} baseline ${baseline.durationMs}ms exceeded baseline cap ${BASELINE_TIMEOUT_MS}ms; lower --workers or --test-concurrency`);
      }
      if (baseline.ok) break;
      if (attempt === 1) log(`mutation-guards: ${suite} baseline attempt 1 failed; retrying once.`);
    }
    if (!baseline.ok) throw new Error(`${suite} baseline is red in a clean copy; fix the suite first. ${baseline.out?.slice(-4000) ?? ''}`);
    const capMs = suiteTimeoutCap(suite, baseline.durationMs);
    measurements[suite] = { baselineMs: baseline.durationMs, capMs };
    log(`mutation-guards: ${suite} baseline green (${(baseline.durationMs / 1000).toFixed(1)}s; suite cap ${(capMs / 1000).toFixed(3)}s)`);
  }
  return measurements;
}

const M = (id, file, find, replace, options = {}) => ({ id, file, find, replace, ...options });
const C = (id, edits, options = {}) => ({ id, ...edits[0], edits, ...options });
export const MUTANTS = [
  // Original 223 obligations, with the thirteen v2 successors in their original ordinals.
  M('scheme-screen', "packages/core/src/privacy.ts",
    "return ['data:', 'javascript:', 'vbscript:', 'file:', 'blob:'].includes(url.protocol)",
    "return ['data:'].includes(url.protocol)", {"suites": ["unit", "isolation"]}),
  M('narrative-flag', "packages/core/src/privacy.ts",
    "if (childKey === 'text' && typeof node.resourceType === 'string') { narrativeOmitted = true; omitted.push(pointer); continue; }",
    "if (childKey === 'text' && typeof node.resourceType === 'string') { narrativeOmitted = false; omitted.push(pointer); continue; }"),
  M('patient-reference-deny', "packages/core/src/privacy.ts",
    "if (parsed.type === 'Patient' || parsed.patientLike) {",
    "if (false) {", {"suites": ["unit", "isolation"]}),
  M('reference-origin', "packages/core/src/privacy.ts",
    "const local = parsed.form === 'relative' || (parsed.form === 'absolute' && parsed.sameSource);",
    "const local = true;"),
  M('contained-patient', "packages/core/src/privacy.ts",
    "if (type === 'Patient' && (depth > 0 || node.id !== patientId)) return false;",
    "if (type === 'Patient' && depth === 0 && node.id !== patientId) return false;", {"suites": ["unit", "isolation"]}),
  M('subject-linkage', "packages/core/src/privacy.ts",
    "referenceDecision(link as Record<string, unknown>, patientId, base, 'reference', linkElement.targets) !== 'bound'",
    "referenceDecision(link as Record<string, unknown>, patientId, base, 'reference', linkElement.targets) === 'deny'", {"suites": ["unit", "isolation"]}),
  M('j17-bare-id-selector', "packages/core/src/privacy.ts",
    "return parsed.patientLike || !(parsed.form === 'relative' || (parsed.form === 'absolute' && parsed.sameSource));",
    "return false;", {"suites": ["unit", "isolation"]}),
  M('conditional-patientlike', "packages/core/src/privacy.ts",
    "return { form: 'conditional', type: conditional[1], patientLike: conditional[1]!.toLowerCase() === 'patient' };",
    "return { form: 'conditional', type: conditional[1], patientLike: false };", {"suites": ["unit", "isolation"]}),
  M('fhir-version', "packages/core/src/index.ts",
    "/^4\\.0\\.\\d{1,3}$/",
    "/^4\\.0\\./"),
  M('searchset-type', "packages/core/src/index.ts",
    "bundle.type !== 'searchset'",
    "false"),
  M('include-mode', "packages/core/src/index.ts",
    "entry.search?.mode === 'include' || ",
    "", {"suites": ["unit", "isolation"]}),
  M('source-alias', "packages/core/src/index.ts",
    "        if (input.source !== this.config.source.alias && input.source !== undefined) throw new GatewayFault('POLICY_DENIED', 'Source is not available to this workload.');",
    "        // diagnostic: source binding removed", {"suites": ["unit", "isolation"]}),
  M('patient-id-selector', "packages/core/src/index.ts",
    "if (type === 'Patient' && pair.name === '_id' && pair.value !== this.config.patientId)",
    "if (false)", {"suites": ["unit", "isolation"]}),
  M('narrative-omitted-hardcode', "packages/core/src/index.ts",
    "narrative_omitted: selected.some(item => item.record.narrativeOmitted)",
    "narrative_omitted: false"),
  M('total-publication', "packages/core/src/index.ts",
    "const publishTotal = verifySelf && !partialReasons.has('INVALID_RESOURCE_ID') && !precisionRefused && !sourceIncomplete && nextLinks.length === 0;",
    "const publishTotal = verifySelf;", {"suites": ["unit", "isolation"]}),
  M('outcome-execution-failure', "packages/core/src/index.ts",
    "if (code !== undefined && EXECUTION_FAILURE_CODES.has(code)) throw",
    "if (false) throw"),
  M('byte-limit-inflation-e6', "packages/core/src/index.ts",
    "byte_limit: Math.min(admission?.input.output?.max_bytes ?? this.defaultBytes, this.maxBytes)",
    "byte_limit: 1000000"),
  M('continuation-multiset', "packages/core/src/index.ts",
    "if (original.length && !queryEvidencePairsMatch(original, reported))",
    "if (original.length && !reported.every(pair => original.some(expected => expected.value === pair.value)))", {"suites": ["unit", "isolation"]}),
  M('read-redirect-nondisclosure', "packages/core/src/index.ts",
    "|| error.code === 'UNSAFE_REDIRECT'",
    "", {"suites": ["unit", "isolation"]}),
  M('next-relation-case', "packages/core/src/index.ts",
    "link.relation.toLowerCase() === 'next'",
    "link.relation === 'next'"),
  M('credential-reinvalidate', "packages/core/src/index.ts",
    "['CREDENTIAL_INVALIDATED', 'PROVIDER_CLOSED', 'REQUEST_CANCELLED', 'TOKEN_TIMEOUT']",
    "['PROVIDER_CLOSED', 'REQUEST_CANCELLED', 'TOKEN_TIMEOUT']"),
  M('superseded-nonretryable', "packages/core/src/index.ts",
    "code === 'CREDENTIAL_INVALIDATED' ? true :",
    "code === 'CREDENTIAL_INVALIDATED' ? false :"),
  M('metadata-epoch-key', "packages/core/src/index.ts",
    "if (!this.metadataLoading || this.metadataLoading.epoch !== this.authEpoch || this.metadataLoading.generation !== this.stateGeneration) {",
    "if (!this.metadataLoading) {"),
  M('lifo-admission', "packages/core/src/index.ts",
    "const next = this.waiters.shift();",
    "const next = this.waiters.pop();"),
  M('slot-release', "packages/core/src/index.ts",
    "if (next) { next.transferred = true; next.resolve(); } else this.active--;",
    "if (next) { next.transferred = true; next.resolve(); }"),
  M('queued-waiter-abort', "packages/core/src/index.ts",
    "      budget.signal?.addEventListener('abort', onAbort, { once: true });\n      this.waiters.push(waiter);",
    "      this.waiters.push(waiter);"),
  M('render-cancel-guard', "packages/core/src/index.ts",
    "          if (phase === 'success') this.throwIfCancelled(budget);",
    "          // diagnostic: final cancellation and generation guard removed"),
  M('read-budget-dropped', "packages/core/src/index.ts",
    "raw = await this.transport.get(this.transport.url(`${type}/${encodeURIComponent(id)}`), stats, budget) as FhirResource;",
    "raw = await this.transport.get(this.transport.url(`${type}/${encodeURIComponent(id)}`), stats, {}) as FhirResource;"),
  M('idle-purge-timer', "packages/core/src/store.ts",
    "this.timer = setTimeout(() => { this.timer = undefined; this.purgeExpired(); }, delay);",
    "this.timer = setTimeout(() => { this.timer = undefined; }, delay);"),
  M('evict-newest-res', "packages/core/src/store.ts",
    "let oldest: string | undefined; let oldestSeq = Infinity;\n    for (const [handle, item] of this.items) if (handle !== except && item.kind === 'res' && item.seq < oldestSeq)",
    "let oldest: string | undefined; let oldestSeq = -Infinity;\n    for (const [handle, item] of this.items) if (handle !== except && item.kind === 'res' && item.seq > oldestSeq)"),
  M('content-type', "packages/core/src/transport.ts",
    "if (!/^(application\\/(?:fhir\\+)?json)(?:\\s*;|$)/i.test(contentType)) {",
    "if (false) {", {"suites": ["unit", "isolation"]}),
  M('encoded-segments', "packages/core/src/transport.ts",
    "/%(?:2f|5c|2e)/i.test(url.pathname)",
    "false", {"suites": ["unit", "isolation"]}),
  M('validate-origin', "packages/core/src/transport.ts",
    "url.origin !== this.base.origin || ",
    "", {"suites": ["unit", "isolation"]}),
  M('decimal-lexeme', "packages/core/src/decimal.ts",
    "return JSON.stringify(value) === source ? value : new FhirDecimal(source);",
    "return value;"),
  M('protocol-versions', "packages/server/src/index.ts",
    "supportedProtocolVersions: ['2026-07-28', '2025-11-25'],",
    ""),
  M('adapter-signal-dropped', "packages/server/src/index.ts",
    "{ signal: ctx?.mcpReq?.signal, era }",
    "{ era }"),
  M('strict-parse-skipped', "packages/core/src/index.ts",
    "    if (!parsed.success) {\n      const raw = unknownInput as Record<string, unknown>;",
    "    if (!parsed.success && false) {\n      const raw = unknownInput as Record<string, unknown>;", {"suites": ["unit", "isolation"]}),
  M('repair-table-drift', "packages/core/src/contracts.ts",
    "UNSUPPORTED_RESOURCE: { action: 'choose_supported_resource', tool: 'fhir_capabilities' },",
    "UNSUPPORTED_RESOURCE: { action: 'narrow_query' },"),
  M('listed-schema-drift', "packages/core/src/contracts.ts",
    "export const LISTED_OUTPUT_SCHEMA = { type: 'object', required: ['schema_version'], properties: { schema_version: { type: 'string' } } } as const;",
    "export const LISTED_OUTPUT_SCHEMA = { type: 'object', required: ['schema_version'], properties: { schema_version: { type: 'string' }, coverage: { type: 'object' } } } as const;"),
  M('spine-validator-delivery', "packages/core/src/contracts.ts",
    "if (transform.delivery_profile !== undefined && !['full-text-v1', 'structured-evidence-v1'].includes(String(transform.delivery_profile))) return false;",
    ""),
  M('override-label-dropped', "packages/core/src/index.ts",
    "...(this.testOptions?.testDeliveryRegistryOverride ? [{ ...UNVERIFIED_DELIVERY_WARNING }] : []),",
    "...[],"),
  M('strict-success-gate-removed', "packages/core/src/index.ts",
    "          if (!verdict.ok) throw new GatewayFault('INTERNAL_ERROR', 'Unable to complete the bounded request.');",
    "          // diagnostic: candidate success gate bypassed"),
  M('strict-gate-v2-spine-only', "packages/core/src/contracts.ts",
    "export function validateDeliverable02(tool: ToolName, wire: unknown, context?: ValidationContext02): ValidationResult02 {\n  const fail = (reason: Exclude<ValidationResult02, { ok: true }>['reason']): ValidationResult02 => ({ ok: false, reason });\n  try {\n    if (!validateSpine(wire) || !validateListedOutput(wire)) return fail('INVALID_SHAPE');\n    const semantic = validateCrossField02(tool, wire, context);\n    if (!semantic.ok) return semantic;\n    if (!context || !context.result || !context.serverIdentity || typeof context.renderedText !== 'string' || !['modern', 'legacy'].includes(context.era) || !['full-text-v1', 'structured-evidence-v1'].includes(context.deliveryProfile)) return fail('VALIDATION_CONTEXT_REQUIRED');\n    if (typeof context.serverIdentity.name !== 'string' || !context.serverIdentity.name || typeof context.serverIdentity.version !== 'string' || !context.serverIdentity.version || !Array.isArray(context.result.content) || !Object.hasOwn(context.result, 'structuredContent')) return fail('VALIDATION_CONTEXT_REQUIRED');\n    const env = wire as z.infer<typeof toolEnvelopeV2Schemas.fhir_result>;\n    if (!env.error && ((tool === 'fhir_capabilities' && context.topic === undefined) || (tool === 'fhir_result' && context.action === undefined))) return fail('VALIDATION_CONTEXT_REQUIRED');\n    if (!context.binding || ['sourceAlias', 'fhirVersion', 'sourceRevision', 'policyRevision', 'contextHandle'].some(key => typeof context.binding![key as keyof NonNullable<ValidationContext02['binding']>] !== 'string' || !context.binding![key as keyof NonNullable<ValidationContext02['binding']>]) || !Number.isSafeInteger(context.effectiveByteLimit) || context.effectiveByteLimit! < 4096 || context.effectiveByteLimit! > 131072 || typeof context.formatSupplied !== 'boolean' || (context.formatSupplied && !['compact', 'fhir'].includes(context.requestedFormat!))) return fail('VALIDATION_CONTEXT_REQUIRED');\n    if (!env.error && ((tool === 'fhir_read' && !context.readTarget) || (tool === 'fhir_result' && (context.offset === undefined || context.limit === undefined)) || (tool === 'fhir_capabilities' && ((['resource', 'schema', 'search_parameter'].includes(context.topic!) && !context.resourceType) || (context.topic === 'schema' && context.path === undefined) || (['context', 'server'].includes(context.topic!) && !context.patientId))))) return fail('VALIDATION_CONTEXT_REQUIRED');\n    const result = context.result;\n    // Freeze is recursive: a shallow-frozen object still admits stale-text or\n    // accounting races through its children. rawJSON is already frozen by V8.\n    if (!frozenValidationState02(context)) return fail('VALIDATION_CONTEXT_MISMATCH');\n    if (env.transform.delivery_profile !== context.deliveryProfile || result.content.length !== 1 || result.content[0]?.type !== 'text' || result.content[0].text !== context.renderedText || result.isError !== (env.error ? true : undefined)) return fail('VALIDATION_CONTEXT_MISMATCH');\n    // Diagnose candidate accounting before generic snapshot equality.\n    const measured = Buffer.byteLength(JSON.stringify(result), 'utf8');\n    if (measured !== env.budget.bytes_returned || measured > env.budget.byte_limit || measured > context.effectiveByteLimit! || env.budget.byte_limit > context.effectiveByteLimit!) return fail('INVALID_FINAL_BYTES');\n    const serialized = JSON.stringify(wire);\n    if (JSON.stringify(result.structuredContent) !== serialized) return fail('VALIDATION_CONTEXT_MISMATCH');\n    const jsonLine = serialized.replace(/[\\u2028\\u2029\\u0085]/g, char => `\\\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);\n    if (context.deliveryProfile === 'full-text-v1' && context.renderedText !== serialized && context.renderedText !== `delivery_profile: \"full-text-v1\"\\n${jsonLine}`) return fail('VALIDATION_CONTEXT_MISMATCH');\n    if (context.deliveryProfile === 'structured-evidence-v1' && !context.renderedText.startsWith('delivery_profile: \"structured-evidence-v1\"\\n')) return fail('VALIDATION_CONTEXT_MISMATCH');\n    const allowed = ['content', 'structuredContent', ...(env.error ? ['isError'] : []), ...(context.era === 'modern' ? ['resultType', '_meta'] : [])];\n    if (Object.keys(result).some(key => !allowed.includes(key))) return fail('VALIDATION_CONTEXT_MISMATCH');\n    if (context.era === 'modern' && (result.resultType !== 'complete' || JSON.stringify(result._meta) !== JSON.stringify({ 'io.modelcontextprotocol/serverInfo': context.serverIdentity }))) return fail('VALIDATION_CONTEXT_MISMATCH');\n    return { ok: true };\n  } catch { return fail('INVALID_SHAPE'); }\n}\n",
    "export function validateDeliverable02(tool: ToolName, wire: unknown, context?: ValidationContext02): ValidationResult02 { return validateSpine(wire) && validateListedOutput(wire) ? {ok:true} : {ok:false,reason:'INVALID_SHAPE'}; }"),
  M('strict-gate-without-crossfield02', "packages/core/src/contracts.ts",
    "    if (!semantic.ok) return semantic;",
    "    if (!semantic.ok && false) return semantic;"),
  M('strict-emergency-removed', "packages/core/src/index.ts",
    "      if (!validateDeliverable02('fhir_search', toWireValue(emergency), capture).ok) {",
    "      if (false) {"),
  M('p-imports-q-side-effect', "packages/core/src/projection.ts",
    "import type { ProjectionMeta, SanitizedProjectionRecord } from './m3b.js';",
    "import type { ProjectionMeta, SanitizedProjectionRecord } from './m3b.js';\nimport './query.js';"),
  M('direct-era-default-legacy', "packages/core/src/index.ts",
    "    const era = options.era ?? 'modern';",
    "    const era = options.era ?? 'legacy';"),
  M('citation-index-dropped', "packages/evals/src/evidence-oracle.ts",
    "if (!citedIndexes(e).has(index)) return false;",
    "if (!citedIndexes(e).size) return false;"),
  M('date-gt-as-sa', "packages/evals/src/fixture.ts",
    "    case 'gt': return target.end > search.end;",
    "    case 'gt': return target.start >= search.end;"),
  M('lab-drops-specimen-device', "packages/core/src/projection.ts",
    "'dataAbsentReason', 'interpretation', 'bodySite', 'method', 'specimen', 'device',",
    "'dataAbsentReason', 'interpretation', 'bodySite', 'method',"),
  M('lab-detaches-component', "packages/core/src/projection.ts",
    "'referenceRange', 'hasMember', 'derivedFrom', 'component',",
    "'referenceRange', 'hasMember', 'derivedFrom',"),
  M('meta-supplement-profile-dropped', "packages/core/src/projection.ts",
    "if (['versionId', 'profile', 'security'].includes(base)) { kept[key] = cloneFhirValue(value); continue; }",
    "if (base === 'versionId') { kept[key] = cloneFhirValue(value); continue; }"),
  M('subsetted-tag-dropped', "packages/core/src/projection.ts",
    "(tag as { code?: unknown }).code === 'SUBSETTED'",
    "(tag as { code?: unknown }).code === 'SUBSETTED-X'"),
  M('structural-relabelled-clinical', "packages/core/src/projection.ts",
    "        interpretation: 'structural',",
    "        interpretation: 'clinical_projection',"),
  M('g15-summary-allowed', "packages/core/src/delivery.ts",
    "  if (config.textMode === 'summary') {",
    "  if (false) {"),
  M('slim-text-always-fallback', "packages/core/src/delivery.ts",
    "  if (!envelope.error && !Array.isArray(resources) && !inspection) return { text: `delivery_profile: \"full-text-v1\"\\n${jsonLine(envelope)}`, fellBack: true, deliveredProfile: 'full-text-v1' };",
    "  if (Boolean(1)) return { text: `delivery_profile: \"full-text-v1\"\\n${jsonLine(envelope)}`, fellBack: true, deliveredProfile: 'full-text-v1' };"),
  M('evidence-cursor-dropped', "packages/core/src/delivery.ts",
    "    if (envelope.pagination.next_cursor) lines.push(`next_cursor: ${quoteText(envelope.pagination.next_cursor)}`);",
    ""),
  M('corruptor-label-dropped', "packages/core/src/index.ts",
    "...(this.testOptions?.testEnvelopeCorruptor ? [{ ...TEST_CORRUPTOR_WARNING }] : []),",
    ""),
  M('no-matches-unfiltered', "packages/core/src/repairs.ts",
    "  if (!input.filtered || input.deliveredCount !== 0 || input.queryExhausted !== true) return undefined;",
    "  if (input.deliveredCount !== 0 || input.queryExhausted !== true) return undefined;"),
  M('escaped-or-not-escaped', "packages/core/src/repairs.ts",
    "export function escapeFhirTokenPart(part: string): string {",
    "export function escapeFhirTokenPart(part: string): string {\n  return part;"),
  M('observed-code-dedupe-dropped', "packages/core/src/repairs.ts",
    "    if (seen.has(key) || !tuple.code) continue;",
    "    if (!tuple.code) continue;"),
  M('catalog-v2-ref-dropped', "packages/core/src/catalog.ts",
    "    if (Array.isArray(path.anyOf) && path.anyOf.length === 2) path.anyOf[1] = { $ref: '#/properties/output/properties/fields/items' };",
    ""),
  M('lab-drops-primitive-companions', "packages/core/src/projection.ts",
    "  const keepRoot = (key: string): boolean => {\n    const base = key.startsWith('_') ? key.slice(1) : key;",
    "  const keepRoot = (key: string): boolean => {\n    if (key.startsWith('_')) return false;\n    const base = key;"),
  M('lab-drops-contained', "packages/core/src/projection.ts",
    "  const keep = (key: string): boolean => ((key === 'contained' || key === '_contained') && keepContained ? true : keepRoot(key));",
    "  const keep = (key: string): boolean => ((key === 'contained' || key === '_contained') && keepContained ? false : keepRoot(key));"),
  M('meta-supplement-security-dropped', "packages/core/src/projection.ts",
    "['versionId', 'profile', 'security']",
    "['versionId', 'profile']"),
  M('withheld-modifier-not-structural', "packages/core/src/projection.ts",
    "  const structural = record.requiresStructuralView || containsModifierSemantics(record.resource);",
    "  const structural = containsModifierSemantics(record.resource);"),
  M('slim-warning-repair-dropped', "packages/core/src/delivery.ts",
    "warning.repair ? ` repair=${jsonLine(warning.repair)}` : ''",
    "''"),
  M('slim-manifest-dropped', "packages/core/src/delivery.ts",
    "  if (manifest) lines.push(`manifest: ${jsonLine(manifest)}`);",
    ""),
  M('slim-structural-marker-dropped', "packages/core/src/delivery.ts",
    "    parts.push('[structural/uninterpreted]');",
    ""),
  M('slim-components-dropped', "packages/core/src/delivery.ts",
    "  if (Array.isArray(resource.component)) {",
    "  if (Array.isArray(resource.component) && Boolean(0)) {"),
  M('slim-reference-range-dropped', "packages/core/src/delivery.ts",
    "  if (Array.isArray(resource.referenceRange) && resource.referenceRange.length) lines.push(`  referenceRange=${jsonLine(resource.referenceRange)}`);",
    ""),
  M('slim-coverage-reasons-none', "packages/core/src/delivery.ts",
    "reasons=${jsonLine(envelope.coverage.reasons)}",
    "reasons=[]"),
  M('slim-has-more-null-as-false', "packages/core/src/delivery.ts",
    "    lines.push(`has_more: ${envelope.pagination.has_more}`);",
    "    lines.push(`has_more: ${envelope.pagination.has_more ?? false}`);"),
  M('slim-comparator-dropped', "packages/core/src/delivery.ts",
    "  const comparator = typeof quantity.comparator === 'string' && ['<', '<=', '>=', '>'].includes(quantity.comparator) ? quantity.comparator : '';",
    "  const comparator = '';"),
  M('slim-coding-version-dropped', "packages/core/src/delivery.ts",
    "        typeof entry.version === 'string' ? entry.version : null,",
    "        null,"),
  M('import-graph-basename-blind', "tests/m3b-contracts.test.ts",
    "  const qBasenames: ReadonlySet<string> = new Set(Q_OWNED_BASENAMES_SCAN);",
    "  const qBasenames: ReadonlySet<string> = new Set<string>();"),
  M('r2-k28-envelope-structured-conflict', "packages/core/src/delivery.ts",
    "  if (config.textMode === 'envelope' && config.delivery?.profile === 'structured-evidence-v1') {",
    "  if (false) {"),
  M('r2-k22-quote-separators-unescaped', "packages/core/src/delivery.ts",
    "const quoteText = (value: string): string => JSON.stringify(value).replace(/[\\u2028\\u2029\\u0085]/g, char => `\\\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);",
    "const quoteText = (value: string): string => JSON.stringify(value);"),
  M('r2-k35-stop-exhausted-unconditional', "packages/core/src/delivery.ts",
    "    return envelope.pagination?.has_more === false && (exhausted === true || envelope.coverage.state === 'complete_for_query') ? stop : undefined;",
    "    return stop;"),
  M('r2-k37-depth-fails-open', "packages/core/src/delivery.ts",
    "  if (depth > 32) return true; // Fail closed: undecidable depth is structural, never interpretable.",
    "  if (depth > 32) return false;"),
  M('r2-k39-extension-only-dropped', "packages/core/src/delivery.ts",
    "  return extensionOnly ? [`${key}=[extension-only]`] : [];",
    "  return [];"),
  M('r2-k40-more-codings-dropped', "packages/core/src/delivery.ts",
    "    if (codings.length > 4) parts.push(`(+${codings.length - 4} more codings)`);",
    ""),
  M('q-conflicting-type-trusted', "packages/core/src/search-parameters.ts",
    "const typeConflict = Boolean(declared?.type_invalid || declared?.duplicate_conflict || (pinned && declaredType !== undefined && declaredType !== pinned.type));",
    "const typeConflict = false;"),
  M('q-bare-id-selector', "packages/core/src/search-parameters.ts",
    "if (!confinementAlias) throw new GatewayFault('AMBIGUOUS_PATIENT_SELECTOR'",
    "if (false) throw new GatewayFault('AMBIGUOUS_PATIENT_SELECTOR'", {"suites": ["unit", "isolation"]}),
  M('q-modifier-allowed', "packages/core/src/search-parameters.ts",
    "if (pair.name.includes(':')) {",
    "if (false) {"),
  M('q-selflink-promoted', "packages/core/src/query.ts",
    "execution: enforced ? 'gateway_enforced' as const : tested ? 'tested_adapter' as const : 'unknown' as const,",
    "execution: enforced ? 'gateway_enforced' as const : (tested || Boolean(1)) ? 'tested_adapter' as const : 'unknown' as const,"),
  M('q-complete-without-proof', "packages/core/src/query.ts",
    ": chain.exhausted && evidence.materialFilterProved ? 'complete_for_query' : 'unknown';",
    ": chain.exhausted ? 'complete_for_query' : 'unknown';"),
  M('q-date-gt-as-sa', "packages/core/src/query.ts",
    "case 'gt': return target.end > search.end;",
    "case 'gt': return target.start >= search.end;"),
  M('q-issued-fallback', "packages/evals/src/fixture.ts",
    "case 'Observation': case 'DiagnosticReport': return str(r.effectiveDateTime) ?? str(r.effectiveInstant) ?? str(asRec(r.effectivePeriod)?.start);",
    "case 'Observation': case 'DiagnosticReport': return str(r.effectiveDateTime) ?? str(r.effectiveInstant) ?? str(asRec(r.effectivePeriod)?.start) ?? str(r.issued);"),
  M('q-ap-allowed', "packages/evals/src/fixture.ts",
    "&& value.split(',').some(part => /^ap[0-9.+-]/.test(part.trim()))) {",
    "&& false) {"),
  M('q-support-denied-executable', "packages/core/src/support.ts",
    "const policyInteractions = base.policy_class === 'denied' ? [] : [...IMPLEMENTABLE];",
    "const policyInteractions = [...IMPLEMENTABLE];"),
  M('q-discovery-binding', "packages/core/src/discovery.ts",
    "if (found.value.topic !== topic || !bindingsEqual(found.value.binding, binding)) throw expired();",
    "if (found.value.topic !== topic) throw expired();"),
  M('q2-overflow-empty-list', "packages/core/src/query.ts",
    "if (parts.length >= MAX_OR_ALTERNATIVES) return undefined;",
    "if (parts.length >= MAX_OR_ALTERNATIVES) return [];", {"suites": ["unit", "isolation"]}),
  M('q2-query-executable', "packages/core/src/search-parameters.ts",
    "const executable = Boolean(!denied && !typeConflict && !compositeOrSpecial && (pinned ?? (control && name === '_sort')));",
    "const executable = Boolean(!typeConflict && !compositeOrSpecial && (pinned ?? (control && name === '_sort')));"),
  M('q2-foreign-absolute-allowed', "packages/core/src/search-parameters.ts",
    "return (parsed.form === 'relative' || (parsed.form === 'absolute' && Boolean(parsed.sameSource))) && parsed.type === 'Patient' && parsed.id === patientId;",
    "return (parsed.form === 'relative' || parsed.form === 'absolute') && parsed.type === 'Patient' && parsed.id === patientId;"),
  M('q2-sort-proof-without-profile', "packages/core/src/query.ts",
    "const sortProved = Boolean(input.sortVerified) && sortVariantListed(input.profile, input.resourceType, sortRequested) && self.sortReported === 'matched';",
    "const sortProved = Boolean(input.sortVerified) && self.sortReported === 'matched';"),
  M('q2-sort-tz-unchecked', "packages/core/src/query.ts",
    "if (effective.kind !== 'interval' || effective.variant !== 'dateTime' || !effective.timezoneQualified || !effective.instantPrecision) {",
    "if (effective.kind !== 'interval' || effective.variant !== 'dateTime' || !effective.instantPrecision) {"),
  M('q2-missing-effective-ok', "packages/core/src/query.ts",
    "if (effective.kind === 'missing') return { status: 'contradicted', parameter: base };",
    "if (effective.kind === 'missing') continue;"),
  M('q2-unknown-targets-unrestricted', "packages/core/src/search-parameters.ts",
    "return entry.targetsFull.length === 0 || entry.targetsFull.includes('Patient') || entry.targetsFull.includes('Resource');",
    "return entry.targetsFull.length !== 0 && (entry.targetsFull.includes('Patient') || entry.targetsFull.includes('Resource'));"),
  M('q2-confinement-target-unchecked', "packages/core/src/search-parameters.ts",
    "if (!entry.view.executable || entry.view.type !== 'reference' || !entry.targetsFull.includes('Patient')) {",
    "if (!entry.view.executable || entry.view.type !== 'reference') {"),
  M('q2-date-ap-proved', "packages/core/src/query.ts",
    "if (prefix === 'ap') return undefined;",
    "if (prefix === 'ap') return true;"),
  M('q2-noncontinuable-exhausted', "packages/core/src/query.ts",
    "const queryExhausted: boolean | null = retained || chain.nonContinuable",
    "const queryExhausted: boolean | null = retained"),
  M('q2-unreviewed-predicate-ok', "packages/core/src/query.ts",
    "return { status: 'unverifiable', parameter: base, variant: 'unreviewed-predicate' };",
    "continue;"),
  M('q2-ambiguous-name-picks-first', "packages/core/src/search-parameters.ts",
    "return chosen.length === 1 ? { status: 'selected', definition: chosen[0]! } : { status: 'conflict' };",
    "return { status: 'selected', definition: chosen[0]! };"),
  M('q2-sort-echo-mismatch', "packages/core/src/query.ts",
    "return { flags, materialMismatch: !queryEvidencePairsMatch(requested, pool), sortReported };",
    "return { flags, materialMismatch: !queryEvidencePairsMatch(requested, pool) || sortReported === 'dropped' || sortReported === 'different', sortReported };"),
  M('q2-enforced-by-name', "packages/core/src/query.ts",
    "const enforced = input.gatewayEnforcedIndices.has(index);",
    "const enforced = input.gatewayEnforcedIndices.has(index) || pair.name === 'patient';"),
  M('q2-token-systemless-any', "packages/core/src/query.ts",
    "alternatives.push({\n        system: rawSystem === '' ? null : system,",
    "alternatives.push({\n        system: rawSystem === '' ? undefined : system,"),
  M('q2-malformed-canonical-fallback', "packages/core/src/search-parameters.ts",
    "const withheld = definitionPresent && (!definitionValid || isProtectedDefinitionUrl(definition!));",
    "const withheld = false;"),
  M('q2-linkage-kind', "packages/core/src/query.ts",
    "if (constraints.length > 0 && constraints.every(entry => entry.execution === 'gateway_enforced')) return 'exact_id_and_subject_linkage';",
    "if (constraints.length > 0 && constraints.every(entry => entry.execution === 'gateway_enforced')) return 'declared_and_self_link_only';"),
  M('q2-mixed-precision-contradicted', "packages/core/src/query.ts",
    "if (previous !== undefined && previousPrec !== undefined && effective.precision !== previousPrec) {",
    "if (false) {"),
  M('q3-enforced-any-patient-value', "packages/core/src/search-parameters.ts",
    "if (!linkageNames.has(pair.name)) return;",
    ""),
  M('q3-unbranded-profile-proves', "packages/core/src/query.ts",
    "if (!isProvingSearchProfile(profile)) return false;",
    "if (!profile) return false;"),
  M('q3-unbranded-sort-proves', "packages/core/src/query.ts",
    "if (!isProvingSearchProfile(profile) || requested.length !== 1) return false;",
    "if (!profile || requested.length !== 1) return false;"),
  M('q3-revision-flags-ignored', "packages/core/src/discovery.ts",
    ", ...(param.definition_withheld ? { definition_withheld: true } : {}), ...(param.type_invalid ? { type_invalid: true } : {}), ...(param.duplicate_conflict ? { duplicate_conflict: true } : {})",
    ""),
  M('q3-source-software-unchecked', "packages/core/src/query.ts",
    "if (capability.software !== profile.source.software) return undefined;",
    ""),
  M('q3-source-version-unchecked', "packages/core/src/query.ts",
    "if (profile.source.software_version !== undefined && capability.softwareVersion !== profile.source.software_version) return undefined;",
    ""),
  M('q3-evidence-not-required', "packages/core/src/query.ts",
    "return Boolean(profile.evidence && /^[a-f0-9]{64}$/.test(profile.evidence.report_sha256) && profile.evidence.recorded_at);",
    "return true;"),
  M('q3-token-lone-backslash', "packages/core/src/query.ts",
    "if (next === undefined || !ESCAPABLE.includes(next)) return undefined;\n      out += next;",
    "if (next === undefined) return undefined;\n      out += next;"),
  M('q3-policy-revision-drift-removed', "packages/core/src/support.ts",
    "if (candidate.policy_revision !== SHARED_INSTANCE_POLICY.version) issues.push('policy_revision disagrees with SHARED_INSTANCE_POLICY.version');",
    ""),
  M('confinement-append-skipped-patient-id', "packages/core/src/index.ts",
    "...(confinement ? [confinement] : []),",
    "...(confinement && !(type === 'Patient' && materialPairs.some(pair => pair.name === '_id')) ? [confinement] : []),", {"suites": ["unit", "isolation"]}),
  M('confinement-append-skipped-subject', "packages/core/src/index.ts",
    "...(confinement ? [confinement] : []),",
    "...(confinement && !(type !== 'Patient' && materialPairs.some(pair => pair.name === confinement.name)) ? [confinement] : []),", {"suites": ["unit", "isolation"]}),
  M('query-evidence-values-ignored', "packages/core/src/query.ts",
    "if (left.length !== right.length || left.some((value, index) => value !== right[index])) return false;",
    "if (!left.length || !right.length) return false;"),
  M('query-evidence-confinement-omitted', "packages/core/src/query.ts",
    "for (const name of names) {",
    "for (const name of [...names].filter(name => !['patient', 'subject', '_id'].includes(name))) {"),
  M('continuation-confinement-omitted', "packages/core/src/index.ts",
    "if (!url.searchParams.has(name)) throw new GatewayFault('UNVERIFIED_CONTINUATION', 'Continuation drops an original requested constraint.');",
    "if (!['patient', 'subject', '_id'].includes(name) && !url.searchParams.has(name)) throw new GatewayFault('UNVERIFIED_CONTINUATION', 'Continuation drops an original requested constraint.');"),
  M('query-evidence-underscore-controls-idempotent', "packages/core/src/query.ts",
    "const predicate = (name: string) => !name.startsWith('_') || name === '_id' || name === '_lastUpdated';",
    "const predicate = (name: string) => name !== '_sort';"),
  M('query-evidence-reported-names-ignored', "packages/core/src/query.ts",
    "...reported.filter(pair => !mechanics(pair.name)).map(pair => pair.name)",
    "...[]"),
  M('s2-document-hashed', "packages/core/src/index.ts",
    "normalizedCapabilityRevision(metadata.fhirVersion, [...capabilities.values()])",
    "normalizedCapabilityRevision(metadata.fhirVersion + JSON.stringify(metadata), [...capabilities.values()])"),
  M('s2-ttl-ignored', "packages/core/src/index.ts",
    "Date.now() < this.metadataExpiresAt",
    "true"),
  M('s2-source-identity-ignored', "packages/core/src/index.ts",
    "!sameSourceIdentity(identity, this.sourceIdentity)",
    "false"),
  M('s2-material-invalidation-skipped', "packages/core/src/index.ts",
    "if (changed) this.invalidateState();",
    "if (changed) { /* invalidation skipped */ }"),
  M('s2-state-generation-ignored', "packages/core/src/index.ts",
    "budget.stateGeneration !== undefined && budget.stateGeneration !== this.stateGeneration",
    "false"),
  M('s2-page-flight-generation-unpinned', "packages/core/src/index.ts",
    "const flightBudget: RequestBudget = { signal: controller.signal, epoch: budget.epoch, stateGeneration: budget.stateGeneration };",
    "const flightBudget: RequestBudget = { signal: controller.signal, epoch: budget.epoch };"),
  M('s2-page-stale-metadata', "packages/core/src/index.ts",
    "      await this.discover(stats, budget);\n      // A material refresh destroyed the old cursor. Never fetch its frozen old query.",
    "      // A material refresh destroyed the old cursor. Never fetch its frozen old query."),
  M('s2-close-generation-skipped', "packages/core/src/index.ts",
    "this.closed = true; this.authEpoch++; this.invalidateState(); this.credentials?.close(); this.store.close();",
    "this.closed = true; this.authEpoch++; this.credentials?.close(); this.store.close();"),
  M('s2-source-identity-unbounded', "packages/core/src/index.ts",
    "value.length <= 256",
    "true"),
  M('s2-duplicate-order-dependent', "packages/core/src/search-parameters.ts",
    "if (candidateIdentity < existingIdentity) {",
    "if (candidateIdentity < existingIdentity && Boolean(0)) {"),
  M('s2-profile-not-deep-frozen', "packages/core/src/query.ts",
    "  freeze(copy);",
    "  // freeze skipped"),
  M('s2-profile-brand-alias', "packages/core/src/query.ts",
    "  const frozen = frozenProfile(profile);",
    "  const frozen = profile;"),
  M('s2-profile-registration-alias', "packages/core/src/query.ts",
    "this.candidate = candidate && (privateCandidate || profileProves(candidate)) ? brandProfile(candidate) : undefined;",
    "this.candidate = candidate && (privateCandidate || profileProves(candidate)) ? (PROVING_PROFILES.add(candidate), candidate) : undefined;"),
  M('s2-repeated-type-last-wins', "packages/core/src/index.ts",
    "          if (capabilities.has(entry.type)) {\n            capabilities.set(entry.type, { type: entry.type, ambiguous: true, interactions: [], searchParameters: [], searchParamTypes: {}, declared: [], resolvedParameters: new Map() });\n            continue;\n          }\n",
    ""),
  M('s2-ambiguous-type-marker-ignored', "packages/core/src/discovery.ts",
    "        ...(resource.ambiguous ? { ambiguous: true } : {}),\n",
    ""),
  M('s2-multiple-server-blocks-accepted', "packages/core/src/index.ts",
    "        if (servers.length > 1) throw new GatewayFault('INVALID_RESPONSE', 'Source capability server declarations are ambiguous.');\n",
    ""),
  M('s2-resource-object-accepted', "packages/core/src/index.ts",
    "        if (resource !== undefined && !Array.isArray(resource)) throw new GatewayFault('INVALID_RESPONSE', 'Source capability resource declarations are malformed.');\n        const entries = (resource ?? []) as { type: string; interaction?: { code: string }[]; searchParam?: unknown }[];\n",
    "        const entries = (Array.isArray(resource) ? resource : resource ? [resource] : []) as { type: string; interaction?: { code: string }[]; searchParam?: unknown }[];\n"),
  M('s2-discover-waiter-guard-removed', "packages/core/src/index.ts",
    "    if (flight.epoch !== this.authEpoch || installedGeneration !== this.stateGeneration || this.closed\n      || (budget.stateGeneration !== undefined && budget.stateGeneration !== flight.generation)) throw new GatewayFault('CONNECTION_REQUIRED', 'The source state changed during discovery; repeat it.', true);\n    budget.stateGeneration = installedGeneration;\n    this.throwIfCancelled(budget);\n",
    "    budget.stateGeneration = installedGeneration;\n"),
  M('foreign-veto-removed', "packages/core/src/index.ts",
    "if (foreignPatientSelector(pair.value, this.config.patientId, this.transport.base, selectionType)) throw",
    "if (false) throw", {"suites": ["unit", "isolation"]}),
  M('outbound-confinement-dropped', "packages/core/src/index.ts",
    "...(confinement ? [confinement] : []),",
    "...[], // trusted confinement removed", {"suites": ["unit", "isolation"]}),
  M('g1-shared-admission-removed', "packages/core/src/search-parameters.ts",
    "if (!directoryIntrinsic) throw",
    "if (false) throw"),
  M('g2-deny-set-removed', "packages/core/src/query.ts",
    "new Set(profilesData.denied_parameters)",
    "new Set<string>()", {"suites": ["unit", "isolation"]}),
  M('g3-target-admission-removed', "packages/core/src/search-parameters.ts",
    "if (classification !== 'patient' || entry.pinnedType !== 'reference') continue;",
    "if (classification !== 'patient' || entry.pinnedType !== 'reference' || Boolean(1)) continue;"),
  M('pinned-type-veto-source', "packages/core/src/index.ts",
    "const selectionType = resolved.byName.get(pair.name)?.pinnedType ?? 'reference';",
    "const selectionType = capability.searchParamTypes[pair.name] ?? 'reference';"),
  M('g3-shared-class-condition-removed', "packages/core/src/search-parameters.ts",
    "resourceClass(targetType) !== 'shared' || ",
    ""),
  M('g3-pinned-target-condition-removed', "packages/core/src/search-parameters.ts",
    " || !entry.targetsFull.includes(targetType)",
    ""),
  M('g5-CapabilityStatement-refusal-removed', "packages/core/src/discovery.ts",
    "new Set(['CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition'])",
    "new Set([\"SearchParameter\",\"StructureDefinition\",\"OperationDefinition\"])"),
  M('g5-SearchParameter-refusal-removed', "packages/core/src/discovery.ts",
    "new Set(['CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition'])",
    "new Set([\"CapabilityStatement\",\"StructureDefinition\",\"OperationDefinition\"])"),
  M('g5-StructureDefinition-refusal-removed', "packages/core/src/discovery.ts",
    "new Set(['CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition'])",
    "new Set([\"CapabilityStatement\",\"SearchParameter\",\"OperationDefinition\"])"),
  M('g5-OperationDefinition-refusal-removed', "packages/core/src/discovery.ts",
    "new Set(['CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition'])",
    "new Set([\"CapabilityStatement\",\"SearchParameter\",\"StructureDefinition\"])"),
  M('g5-custom-name-echo', "packages/core/src/discovery.ts",
    "declared.filter(param => selectPinnedDefinition(type, param.name).status === 'selected').map(param => param.name)",
    "declared.map(param => param.name)", {"suites": ["unit", "isolation"]}),
  M('g5-resource-type-regex-only', "packages/core/src/index.ts",
    "!isFhirResourceType(entry.type)",
    "!/^[A-Z][A-Za-z0-9]+$/.test(entry.type)"),
  M('g5-interaction-filter-removed', "packages/core/src/index.ts",
    ".filter(code => R4_TYPE_INTERACTIONS.has(code))",
    ".filter(code => typeof code === 'string')"),
  M('frozen-preparation-skipped', "packages/core/src/index.ts",
    "      this.validateFrozenSearch(value.type, value.query);\n",
    ""),
  M('privacy-display-only', "packages/core/src/privacy.ts",
    "patientReference && ['display', '_display', 'identifier', 'extension', '_reference', '_type'].includes(childKey)",
    "patientReference && childKey === 'display'"),
  M('privacy-primary-link-only', "packages/core/src/privacy.ts",
    "patientReference && ['display', '_display', 'identifier', 'extension', '_reference', '_type'].includes(childKey)",
    "patientReference && path === '/subject' && ['display', '_display', 'identifier', 'extension', '_reference', '_type'].includes(childKey)"),
  M('privacy-projection-only', "packages/core/src/privacy.ts",
    "export function sanitize(resource: FhirResource, privacy: GatewayConfig['privacy'] = {}): Sanitized {\n  const patientIdentifierSystems = new Set(privacy.patientIdentifierSystems ?? []);\n  const structuralStringAllowed = (field: string, node: Record<string, unknown>) => SHARED_STRUCTURAL_STRING_EXCEPTIONS.some(rule => rule.fields.test(field) && rule.allows(node, patientIdentifierSystems));\n  const manifests: Record<string, unknown>[] = [];\n  const manifestOrigins: ManifestOrigin[] = [];\n  const omitted: string[] = [];\n  let requiresStructuralView = false;\n  let narrativeOmitted = false;\n  const withheld = Symbol('withheld');\n  const withhold = (path: string, reason: string, inModifier: boolean, metadata: Record<string, unknown> = {}, origin: ManifestOrigin = 'policy') => {\n    manifests.push({ path, reason, ...metadata });\n    manifestOrigins.push(origin);\n    omitted.push(path);\n    // A policy-withheld modifier prohibits a confident clinical interpretation.\n    if (inModifier) requiresStructuralView = true;\n    return withheld;\n  };\n  interface Scope { type: string; root: string; shared: boolean; identifier?: boolean }\n  // `attachment` drives withholding (schema, shape or path spelling: conservative). `inAttachment` is the\n  // schema-declared Attachment context, own or inherited, and drives only the S5b origin classification.\n  const walk = (value: unknown, path: string, key: string, parent: Record<string, unknown>, element: ResolvedElement, attachment: boolean, inAttachment: boolean, inModifier: boolean, inherited: Scope): unknown => {\n    const metadata = () => attachment ? attachmentMetadata(parent) : {};\n    const linkOrigin: ManifestOrigin = inAttachment ? 'attachment' : attachment || !element.types.length ? 'unknown' : 'policy';\n    // R2: payload keys and the attachment link are withheld by key and schema context before the value's JSON\n    // shape is consulted; an object, array, number, boolean or null carries bytes or a capability as a string does.\n    if (payloadPosition(key, element, value)) return withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, metadata(), 'payload');\n    // Attachment context comes from the schema (Patient.photo, presentedForm, ...) even without contentType.\n    if (key === 'url' && attachment) return withhold(path, 'PROTECTED_LINK', inModifier, metadata(), linkOrigin);\n    // R1: a scalar where the schema declares a Reference, a Resource or another reference-carrying structure is\n    // malformed linkage: withheld, never screened as prose or passed through as a leaf.\n    if (malformedLinkage(element, value)) return withhold(path, 'MALFORMED_LINKAGE_WITHHELD', inModifier);\n    // Any other scalar where the schema declares only complex types is malformed structure; one standing for an\n    // Attachment is withheld as a payload.\n    if (malformedComplex(element, value)) return element.types.includes('Attachment') ? withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, {}, 'payload') : withhold(path, 'MALFORMED_STRUCTURE_WITHHELD', inModifier);\n    if (typeof value === 'string') {\n      const prose = element.types.length === 1 && ['string', 'markdown'].includes(element.types[0]!) && !uriKey(key);\n      if (prose) {\n        const redacted = redactTextLinks(value);\n        if (!redacted.spans) return value;\n        manifests.push({ path, reason: 'PROTECTED_LINK_IN_TEXT', spans: redacted.spans });\n        manifestOrigins.push('link_text');\n        omitted.push(path);\n        if (inModifier) requiresStructuralView = true;\n        return redacted.text;\n      }\n      // V-8 hardening: a link span inside a non-prose, non-URI value (a code, an undeclared vendor string)\n      // withholds the whole value; such values are never rewritten in place.\n      const opaque = !isUriElement(element) && !uriKey(key) && redactTextLinks(value).spans > 0;\n      return opaque || protectedLink(value, key, isUriElement(element)) ? withhold(path, 'PROTECTED_LINK', inModifier, metadata(), linkOrigin) : value;\n    }\n    // Lossless decimal scalars pass through sanitize unchanged (J-6).\n    if (isFhirDecimal(value) || isPrecisionFault(value)) return value;\n    // Keep primitive-array positions aligned with their FHIR _element metadata.\n    if (Array.isArray(value)) {\n      const primitive = element.types.some(type => /^[a-z]/.test(type));\n      return value.flatMap((item, i) => {\n        const result = walk(item, `${path}/${i}`, key, parent, element, attachment, inAttachment, inModifier, inherited);\n        return result === withheld ? (primitive ? [null] : []) : [result];\n      });\n    }\n    if (!value || typeof value !== 'object') return value;\n    const node = value as Record<string, unknown>;\n    // Only a schema-declared contained Resource can inherit its parent's scope.\n    // A resourceType smuggled onto a shared scalar/datatype is unclassified.\n    if (inherited.shared && typeof node.resourceType === 'string' && !(key === 'contained' && element.types.includes('Resource'))) return withhold(path, 'UNDECLARED_PROPERTY_WITHHELD', inModifier, {}, 'unknown');\n    let scope: Scope = typeof node.resourceType === 'string' ? { type: node.resourceType, root: path, shared: path === '' ? resourceClass(node.resourceType) === 'shared' : inherited.shared } : inherited;\n    if (node.modifierExtension || node.implicitRules) requiresStructuralView = true;\n    const context: TypeContext | undefined = typeof node.resourceType === 'string' ? resourceTypeContext(node.resourceType) : element.context;\n    if (context?.definition === 'Identifier' && context.path === '') scope = { ...scope, identifier: true };\n    const isReference = context?.definition === 'Reference' && context.path === '';\n    // Resource.type (for example StructureDefinition.type) is not Reference.type.\n    const referenceLike = typeof node.resourceType !== 'string' && (isReference || node.reference !== undefined || (node.type !== undefined && (node.identifier !== undefined || node.display !== undefined || node._display !== undefined)));\n    // A reference whose reference or type member cannot be read is malformed linkage as a whole.\n    if (referenceLike && unreadableLinkage(node, context, isReference)) return withhold(path, 'MALFORMED_LINKAGE_WITHHELD', inModifier);\n    if (scope.shared && context?.definition === 'Identifier' && context.path === '' && typeof node.system === 'string' && patientIdentifierSystems.has(node.system)) return withhold(path, 'PATIENT_IDENTIFIER_SYSTEM_WITHHELD', inModifier);\n    if (scope.shared && context?.definition === 'Identifier' && context.path === '' && !structuralStringAllowed('Identifier.value', node)) return withhold(path, 'UNCLASSIFIED_IDENTIFIER_WITHHELD', inModifier);\n    if (scope.shared && referenceLike) {\n      const reason = sharedReferenceReason(node, element);\n      if (reason) return withhold(path, reason, inModifier, {}, element.types.length ? 'policy' : 'unknown');\n    }\n    const patientReference = referenceLike && ((isReference && element.targets?.length === 1 && element.targets[0] === 'http://hl7.org/fhir/StructureDefinition/Patient') || declaredType(node.type) === 'Patient' || declaredType(node.type) === 'patient-like'\n      || (typeof node.reference === 'string' && parseReference(node.reference, SANITIZE_REFERENCE_BASE).patientLike));\n    const isAttachment = (context?.definition === 'Attachment' && context.path === '') || node.contentType !== undefined || (node.data !== undefined && payloadPosition('data', resolveElement(context, 'data'), node.data)) || path.toLowerCase().includes('attachment');\n    const schemaAttachment = inAttachment || (context?.definition === 'Attachment' && context.path === '');\n    // F-1: the display/identifier companions of a reference whose target is unverifiable — a\n    // conditional form (never resolved), an unsupported/encoded form, or a reference string the\n    // egress screen itself withholds — are withheld with it. Authorization already rejects the\n    // owning resource on gateway paths; this keeps sanitize safe as a standalone layer.\n    const unverifiableReference = typeof node.reference === 'string'\n      && (() => { const parsed = parseReference(node.reference, SANITIZE_REFERENCE_BASE); return parsed.form === 'conditional' || parsed.form === 'unsupported' || protectedLink(node.reference, 'reference'); })();\n    const omissionsBefore = omitted.length;\n    const result: Record<string, unknown> = {};\n    for (const [childKey, child] of Object.entries(node)) {\n      // V-22: raw upstream property names are never echoed into resources, manifest paths or omitted fields.\n      if (!/^_?[A-Za-z][A-Za-z0-9]{0,63}$/.test(childKey)) { withhold(`${path}/[undeclared-property]`, 'UNDECLARED_PROPERTY_WITHHELD', inModifier); continue; }\n      const pointer = `${path}/${childKey}`;\n      const childElement = resolveElement(context, childKey);\n      const childOrigin: ManifestOrigin = childElement.types.length ? 'policy' : 'unknown';\n      if (['__proto__', 'constructor', 'prototype'].includes(childKey)) { omitted.push(pointer); continue; }\n      // V-23: only resource-level narrative sets narrativeOmitted; Bundle link/total omission is separate.\n      if (childKey === 'text' && typeof node.resourceType === 'string') { narrativeOmitted = true; omitted.push(pointer); continue; }\n      if (node.resourceType === 'Bundle' && ['link', 'total'].includes(childKey)) { omitted.push(pointer); continue; }\n      // Patient.link is a modifier whose target is always another person's record.\n      if (context?.definition === 'Patient' && context.path === 'link' && childKey === 'other') { withhold(pointer, 'FOREIGN_PATIENT_REFERENCE_WITHHELD', true, {}, childOrigin); continue; }\n      if (patientReference && ['display', '_display', 'identifier', 'extension', '_reference', '_type'].includes(childKey)) { withhold(pointer, 'PATIENT_REFERENCE_COMPANION_WITHHELD', inModifier, {}, childOrigin); continue; }\n      if (unverifiableReference && (childKey === 'display' || childKey === '_display' || childKey === 'identifier')) { withhold(pointer, 'UNVERIFIED_REFERENCE_COMPANION_WITHHELD', inModifier, {}, childOrigin); continue; }\n      const field = `${scope.type}.${pointer.slice(scope.root.length + 1).replaceAll('/', '.').replace(/\\._?\\d+(?=\\.|$)/g, '').replace(/(^|\\.)_/g, '$1')}`;\n      if (scope.shared && D1_MASKS.has(field)) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }\n      const catalog = ['CodeSystem', 'ValueSet', 'CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition'].includes(scope.type);\n      const scalar = resolveElement(context, childKey.startsWith('_') ? childKey.slice(1) : childKey);\n      const residualDisplay = CATALOG_DISPLAY.test(`${scope.type}:${field.slice(scope.type.length + 1)}`);\n      const structuralString = structuralStringAllowed(typeof node.resourceType === 'string' && childKey.replace(/^_/, '') === 'id' ? 'Resource.id' : isReference ? `Reference.${childKey.replace(/^_/, '')}` : context?.definition === 'Coding' && context.path === '' ? `Coding.${childKey.replace(/^_/, '')}` : context?.definition === 'Identifier' && context.path === '' ? `Identifier.${childKey.replace(/^_/, '')}` : field, node);\n      if (catalog && (['contact', 'publisher'].includes(childKey.replace(/^_/, ''))\n          || (scalar.types.some(type => type === 'string' || type === 'markdown') && !structuralString && !residualDisplay))) { withhold(pointer, 'SOURCE_PROSE_WITHHELD', inModifier); continue; }\n      if (scope.shared && childKey !== 'resourceType' && !childElement.types.length) { withhold(`${path}/[undeclared-property]`, 'UNDECLARED_PROPERTY_WITHHELD', inModifier, {}, 'unknown'); continue; }\n      const residual = !scope.identifier && D1_RESIDUAL.test(`${scope.type}:${field.slice(scope.type.length + 1)}`);\n      if (scope.shared && scalar.types.some(type => type === 'string' || type === 'markdown') && !structuralString && !residual && !residualDisplay) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }\n      if (scope.shared && isReference && ['display', '_display', 'identifier'].includes(childKey)) {\n        if (childKey !== 'identifier' || walk(child, pointer, childKey, node, childElement, isAttachment, schemaAttachment, inModifier, scope) !== withheld) withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier);\n        continue;\n      }\n      const transformed = walk(child, pointer, childKey, node, childElement, isAttachment, schemaAttachment, inModifier || Boolean(childElement.modifier), scope);\n      if (transformed !== withheld) result[childKey] = transformed;\n    }\n    // Drop newly emptied complex entries; leaf omissions already carry their labels.\n    if (path && Object.keys(result).length === 0 && omitted.length > omissionsBefore) return withheld;\n    return result;\n  };\n  const sanitized = walk(resource, '', '', {}, { types: [] }, false, false, false, { type: resource.resourceType, root: '', shared: false }) as FhirResource;\n  return { resource: sanitized, manifests, manifestOrigins, omitted, retrievedAt: new Date().toISOString(), requiresStructuralView, narrativeOmitted };\n}\n\n// ---------------------------------------------------------------------------\n// Projection (J-4, J-12).\n// ---------------------------------------------------------------------------\n\nexport interface ProjectionWarning { code: string; message: string }\nexport interface Projection { resource: FhirResource; omitted: string[]; unresolved: string[]; warnings?: ProjectionWarning[]; recipe?: string }\n\n/**\n * Reviewed compact recipes, versioned against R4 4.0.1. Field names are\n * declared element names; choice elements (`[x]`) are kept whole through\n * resolveElement. Every root isModifier element, `id`, `meta` (versionId,\n * profile, security) and primitive companions are always added, `contained`\n * is kept when a kept element references it (`#id`), and each kept\n * element keeps its codings and code systems. Types without a recipe fall back\n * to the sanitized full view with COMPACT_RECIPE_UNAVAILABLE.\n */\nexport const COMPACT_RECIPE_SET = 'r4-compact-2026-10-18.1';\nexport const COMPACT_RECIPES: Readonly<Record<string, { id: string; fields: readonly string[] }>> = {\n  Patient: { id: 'Patient.compact.1', fields: ['active', 'name', 'gender', 'birthDate', 'deceased[x]'] },\n  Observation: { id: 'Observation.compact.1', fields: ['status', 'category', 'code', 'subject', 'focus', 'effective[x]', 'issued', 'value[x]', 'dataAbsentReason', 'interpretation', 'bodySite', 'method', 'referenceRange', 'hasMember', 'component'] },\n  Condition: { id: 'Condition.compact.1', fields: ['clinicalStatus', 'verificationStatus', 'category', 'severity', 'code', 'bodySite', 'subject', 'onset[x]', 'abatement[x]', 'recordedDate'] },\n  AllergyIntolerance: { id: 'AllergyIntolerance.compact.1', fields: ['clinicalStatus', 'verificationStatus', 'type', 'category', 'criticality', 'code', 'patient', 'onset[x]', 'recordedDate', 'lastOccurrence', 'reaction'] },\n  MedicationRequest: { id: 'MedicationRequest.compact.1', fields: ['status', 'statusReason', 'intent', 'category', 'priority', 'doNotPerform', 'reported[x]', 'medication[x]', 'subject', 'authoredOn', 'requester', 'reasonCode', 'courseOfTherapyType', 'dosageInstruction', 'dispenseRequest'] },\n  Immunization: { id: 'Immunization.compact.1', fields: ['status', 'statusReason', 'vaccineCode', 'patient', 'occurrence[x]', 'primarySource', 'lotNumber', 'site', 'route', 'doseQuantity', 'isSubpotent', 'subpotentReason', 'reasonCode', 'protocolApplied'] },\n  DiagnosticReport: { id: 'DiagnosticReport.compact.1', fields: ['status', 'category', 'code', 'subject', 'effective[x]', 'issued', 'result', 'conclusion', 'conclusionCode', 'presentedForm'] },\n  DocumentReference: { id: 'DocumentReference.compact.1', fields: ['status', 'docStatus', 'type', 'category', 'subject', 'date', 'author', 'description', 'securityLabel', 'relatesTo', 'content', 'context'] },\n};\nconst RECIPE_UNAVAILABLE: ProjectionWarning = { code: 'COMPACT_RECIPE_UNAVAILABLE', message: 'No reviewed compact recipe exists for this resource type; the full sanitized view is returned instead.' };\nconst MODIFIERS_ADDED: ProjectionWarning = { code: 'MODIFIER_FIELDS_ADDED', message: 'Modifier elements needed to interpret the selected fields were added to the projection.' };\n\nfunction containsModifierExtension(value: unknown, depth = 0): boolean {\n  if (!value || typeof value !== 'object' || depth > 64) return false;\n  if (Array.isArray(value)) return value.some(item => containsModifierExtension(item, depth + 1));\n  return Object.entries(value).some(([key, child]) => key === 'modifierExtension' || containsModifierExtension(child, depth + 1));\n}\n\nexport function project(resource: FhirResource, format: 'compact' | 'fhir', fields?: string[]): FhirResource {\n  return projection(resource, format, fields).resource;\n}\n\nexport function projection(resource: FhirResource, format: 'compact' | 'fhir', fields?: string[]): Projection {",
    "const projectionOnlyPolicies = new WeakMap<FhirResource, GatewayConfig['privacy']>();\nexport function sanitize(resource: FhirResource, privacy: GatewayConfig['privacy'] = {}): Sanitized {\n  projectionOnlyPolicies.set(resource, privacy);\n  return { ...sanitizeForProjection(resource, privacy), resource };\n}\nfunction sanitizeForProjection(resource: FhirResource, privacy: GatewayConfig['privacy'] = {}): Sanitized {\n  const patientIdentifierSystems = new Set(privacy.patientIdentifierSystems ?? []);\n  const structuralStringAllowed = (field: string, node: Record<string, unknown>) => SHARED_STRUCTURAL_STRING_EXCEPTIONS.some(rule => rule.fields.test(field) && rule.allows(node, patientIdentifierSystems));\n  const manifests: Record<string, unknown>[] = [];\n  const manifestOrigins: ManifestOrigin[] = [];\n  const omitted: string[] = [];\n  let requiresStructuralView = false;\n  let narrativeOmitted = false;\n  const withheld = Symbol('withheld');\n  const withhold = (path: string, reason: string, inModifier: boolean, metadata: Record<string, unknown> = {}, origin: ManifestOrigin = 'policy') => {\n    manifests.push({ path, reason, ...metadata });\n    manifestOrigins.push(origin);\n    omitted.push(path);\n    // A policy-withheld modifier prohibits a confident clinical interpretation.\n    if (inModifier) requiresStructuralView = true;\n    return withheld;\n  };\n  interface Scope { type: string; root: string; shared: boolean; identifier?: boolean }\n  // `attachment` drives withholding (schema, shape or path spelling: conservative). `inAttachment` is the\n  // schema-declared Attachment context, own or inherited, and drives only the S5b origin classification.\n  const walk = (value: unknown, path: string, key: string, parent: Record<string, unknown>, element: ResolvedElement, attachment: boolean, inAttachment: boolean, inModifier: boolean, inherited: Scope): unknown => {\n    const metadata = () => attachment ? attachmentMetadata(parent) : {};\n    const linkOrigin: ManifestOrigin = inAttachment ? 'attachment' : attachment || !element.types.length ? 'unknown' : 'policy';\n    // R2: payload keys and the attachment link are withheld by key and schema context before the value's JSON\n    // shape is consulted; an object, array, number, boolean or null carries bytes or a capability as a string does.\n    if (payloadPosition(key, element, value)) return withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, metadata(), 'payload');\n    // Attachment context comes from the schema (Patient.photo, presentedForm, ...) even without contentType.\n    if (key === 'url' && attachment) return withhold(path, 'PROTECTED_LINK', inModifier, metadata(), linkOrigin);\n    // R1: a scalar where the schema declares a Reference, a Resource or another reference-carrying structure is\n    // malformed linkage: withheld, never screened as prose or passed through as a leaf.\n    if (malformedLinkage(element, value)) return withhold(path, 'MALFORMED_LINKAGE_WITHHELD', inModifier);\n    // Any other scalar where the schema declares only complex types is malformed structure; one standing for an\n    // Attachment is withheld as a payload.\n    if (malformedComplex(element, value)) return element.types.includes('Attachment') ? withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, {}, 'payload') : withhold(path, 'MALFORMED_STRUCTURE_WITHHELD', inModifier);\n    if (typeof value === 'string') {\n      const prose = element.types.length === 1 && ['string', 'markdown'].includes(element.types[0]!) && !uriKey(key);\n      if (prose) {\n        const redacted = redactTextLinks(value);\n        if (!redacted.spans) return value;\n        manifests.push({ path, reason: 'PROTECTED_LINK_IN_TEXT', spans: redacted.spans });\n        manifestOrigins.push('link_text');\n        omitted.push(path);\n        if (inModifier) requiresStructuralView = true;\n        return redacted.text;\n      }\n      // V-8 hardening: a link span inside a non-prose, non-URI value (a code, an undeclared vendor string)\n      // withholds the whole value; such values are never rewritten in place.\n      const opaque = !isUriElement(element) && !uriKey(key) && redactTextLinks(value).spans > 0;\n      return opaque || protectedLink(value, key, isUriElement(element)) ? withhold(path, 'PROTECTED_LINK', inModifier, metadata(), linkOrigin) : value;\n    }\n    // Lossless decimal scalars pass through sanitize unchanged (J-6).\n    if (isFhirDecimal(value) || isPrecisionFault(value)) return value;\n    // Keep primitive-array positions aligned with their FHIR _element metadata.\n    if (Array.isArray(value)) {\n      const primitive = element.types.some(type => /^[a-z]/.test(type));\n      return value.flatMap((item, i) => {\n        const result = walk(item, `${path}/${i}`, key, parent, element, attachment, inAttachment, inModifier, inherited);\n        return result === withheld ? (primitive ? [null] : []) : [result];\n      });\n    }\n    if (!value || typeof value !== 'object') return value;\n    const node = value as Record<string, unknown>;\n    // Only a schema-declared contained Resource can inherit its parent's scope.\n    // A resourceType smuggled onto a shared scalar/datatype is unclassified.\n    if (inherited.shared && typeof node.resourceType === 'string' && !(key === 'contained' && element.types.includes('Resource'))) return withhold(path, 'UNDECLARED_PROPERTY_WITHHELD', inModifier, {}, 'unknown');\n    let scope: Scope = typeof node.resourceType === 'string' ? { type: node.resourceType, root: path, shared: path === '' ? resourceClass(node.resourceType) === 'shared' : inherited.shared } : inherited;\n    if (node.modifierExtension || node.implicitRules) requiresStructuralView = true;\n    const context: TypeContext | undefined = typeof node.resourceType === 'string' ? resourceTypeContext(node.resourceType) : element.context;\n    if (context?.definition === 'Identifier' && context.path === '') scope = { ...scope, identifier: true };\n    const isReference = context?.definition === 'Reference' && context.path === '';\n    // Resource.type (for example StructureDefinition.type) is not Reference.type.\n    const referenceLike = typeof node.resourceType !== 'string' && (isReference || node.reference !== undefined || (node.type !== undefined && (node.identifier !== undefined || node.display !== undefined || node._display !== undefined)));\n    // A reference whose reference or type member cannot be read is malformed linkage as a whole.\n    if (referenceLike && unreadableLinkage(node, context, isReference)) return withhold(path, 'MALFORMED_LINKAGE_WITHHELD', inModifier);\n    if (scope.shared && context?.definition === 'Identifier' && context.path === '' && typeof node.system === 'string' && patientIdentifierSystems.has(node.system)) return withhold(path, 'PATIENT_IDENTIFIER_SYSTEM_WITHHELD', inModifier);\n    if (scope.shared && context?.definition === 'Identifier' && context.path === '' && !structuralStringAllowed('Identifier.value', node)) return withhold(path, 'UNCLASSIFIED_IDENTIFIER_WITHHELD', inModifier);\n    if (scope.shared && referenceLike) {\n      const reason = sharedReferenceReason(node, element);\n      if (reason) return withhold(path, reason, inModifier, {}, element.types.length ? 'policy' : 'unknown');\n    }\n    const patientReference = referenceLike && ((isReference && element.targets?.length === 1 && element.targets[0] === 'http://hl7.org/fhir/StructureDefinition/Patient') || declaredType(node.type) === 'Patient' || declaredType(node.type) === 'patient-like'\n      || (typeof node.reference === 'string' && parseReference(node.reference, SANITIZE_REFERENCE_BASE).patientLike));\n    const isAttachment = (context?.definition === 'Attachment' && context.path === '') || node.contentType !== undefined || (node.data !== undefined && payloadPosition('data', resolveElement(context, 'data'), node.data)) || path.toLowerCase().includes('attachment');\n    const schemaAttachment = inAttachment || (context?.definition === 'Attachment' && context.path === '');\n    // F-1: the display/identifier companions of a reference whose target is unverifiable — a\n    // conditional form (never resolved), an unsupported/encoded form, or a reference string the\n    // egress screen itself withholds — are withheld with it. Authorization already rejects the\n    // owning resource on gateway paths; this keeps sanitize safe as a standalone layer.\n    const unverifiableReference = typeof node.reference === 'string'\n      && (() => { const parsed = parseReference(node.reference, SANITIZE_REFERENCE_BASE); return parsed.form === 'conditional' || parsed.form === 'unsupported' || protectedLink(node.reference, 'reference'); })();\n    const omissionsBefore = omitted.length;\n    const result: Record<string, unknown> = {};\n    for (const [childKey, child] of Object.entries(node)) {\n      // V-22: raw upstream property names are never echoed into resources, manifest paths or omitted fields.\n      if (!/^_?[A-Za-z][A-Za-z0-9]{0,63}$/.test(childKey)) { withhold(`${path}/[undeclared-property]`, 'UNDECLARED_PROPERTY_WITHHELD', inModifier); continue; }\n      const pointer = `${path}/${childKey}`;\n      const childElement = resolveElement(context, childKey);\n      const childOrigin: ManifestOrigin = childElement.types.length ? 'policy' : 'unknown';\n      if (['__proto__', 'constructor', 'prototype'].includes(childKey)) { omitted.push(pointer); continue; }\n      // V-23: only resource-level narrative sets narrativeOmitted; Bundle link/total omission is separate.\n      if (childKey === 'text' && typeof node.resourceType === 'string') { narrativeOmitted = true; omitted.push(pointer); continue; }\n      if (node.resourceType === 'Bundle' && ['link', 'total'].includes(childKey)) { omitted.push(pointer); continue; }\n      // Patient.link is a modifier whose target is always another person's record.\n      if (context?.definition === 'Patient' && context.path === 'link' && childKey === 'other') { withhold(pointer, 'FOREIGN_PATIENT_REFERENCE_WITHHELD', true, {}, childOrigin); continue; }\n      if (patientReference && ['display', '_display', 'identifier', 'extension', '_reference', '_type'].includes(childKey)) { withhold(pointer, 'PATIENT_REFERENCE_COMPANION_WITHHELD', inModifier, {}, childOrigin); continue; }\n      if (unverifiableReference && (childKey === 'display' || childKey === '_display' || childKey === 'identifier')) { withhold(pointer, 'UNVERIFIED_REFERENCE_COMPANION_WITHHELD', inModifier, {}, childOrigin); continue; }\n      const field = `${scope.type}.${pointer.slice(scope.root.length + 1).replaceAll('/', '.').replace(/\\._?\\d+(?=\\.|$)/g, '').replace(/(^|\\.)_/g, '$1')}`;\n      if (scope.shared && D1_MASKS.has(field)) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }\n      const catalog = ['CodeSystem', 'ValueSet', 'CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition'].includes(scope.type);\n      const scalar = resolveElement(context, childKey.startsWith('_') ? childKey.slice(1) : childKey);\n      const residualDisplay = CATALOG_DISPLAY.test(`${scope.type}:${field.slice(scope.type.length + 1)}`);\n      const structuralString = structuralStringAllowed(typeof node.resourceType === 'string' && childKey.replace(/^_/, '') === 'id' ? 'Resource.id' : isReference ? `Reference.${childKey.replace(/^_/, '')}` : context?.definition === 'Coding' && context.path === '' ? `Coding.${childKey.replace(/^_/, '')}` : context?.definition === 'Identifier' && context.path === '' ? `Identifier.${childKey.replace(/^_/, '')}` : field, node);\n      if (catalog && (['contact', 'publisher'].includes(childKey.replace(/^_/, ''))\n          || (scalar.types.some(type => type === 'string' || type === 'markdown') && !structuralString && !residualDisplay))) { withhold(pointer, 'SOURCE_PROSE_WITHHELD', inModifier); continue; }\n      if (scope.shared && childKey !== 'resourceType' && !childElement.types.length) { withhold(`${path}/[undeclared-property]`, 'UNDECLARED_PROPERTY_WITHHELD', inModifier, {}, 'unknown'); continue; }\n      const residual = !scope.identifier && D1_RESIDUAL.test(`${scope.type}:${field.slice(scope.type.length + 1)}`);\n      if (scope.shared && scalar.types.some(type => type === 'string' || type === 'markdown') && !structuralString && !residual && !residualDisplay) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }\n      if (scope.shared && isReference && ['display', '_display', 'identifier'].includes(childKey)) {\n        if (childKey !== 'identifier' || walk(child, pointer, childKey, node, childElement, isAttachment, schemaAttachment, inModifier, scope) !== withheld) withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier);\n        continue;\n      }\n      const transformed = walk(child, pointer, childKey, node, childElement, isAttachment, schemaAttachment, inModifier || Boolean(childElement.modifier), scope);\n      if (transformed !== withheld) result[childKey] = transformed;\n    }\n    // Drop newly emptied complex entries; leaf omissions already carry their labels.\n    if (path && Object.keys(result).length === 0 && omitted.length > omissionsBefore) return withheld;\n    return result;\n  };\n  const sanitized = walk(resource, '', '', {}, { types: [] }, false, false, false, { type: resource.resourceType, root: '', shared: false }) as FhirResource;\n  return { resource: sanitized, manifests, manifestOrigins, omitted, retrievedAt: new Date().toISOString(), requiresStructuralView, narrativeOmitted };\n}\n\n// ---------------------------------------------------------------------------\n// Projection (J-4, J-12).\n// ---------------------------------------------------------------------------\n\nexport interface ProjectionWarning { code: string; message: string }\nexport interface Projection { resource: FhirResource; omitted: string[]; unresolved: string[]; warnings?: ProjectionWarning[]; recipe?: string }\n\n/**\n * Reviewed compact recipes, versioned against R4 4.0.1. Field names are\n * declared element names; choice elements (`[x]`) are kept whole through\n * resolveElement. Every root isModifier element, `id`, `meta` (versionId,\n * profile, security) and primitive companions are always added, `contained`\n * is kept when a kept element references it (`#id`), and each kept\n * element keeps its codings and code systems. Types without a recipe fall back\n * to the sanitized full view with COMPACT_RECIPE_UNAVAILABLE.\n */\nexport const COMPACT_RECIPE_SET = 'r4-compact-2026-10-18.1';\nexport const COMPACT_RECIPES: Readonly<Record<string, { id: string; fields: readonly string[] }>> = {\n  Patient: { id: 'Patient.compact.1', fields: ['active', 'name', 'gender', 'birthDate', 'deceased[x]'] },\n  Observation: { id: 'Observation.compact.1', fields: ['status', 'category', 'code', 'subject', 'focus', 'effective[x]', 'issued', 'value[x]', 'dataAbsentReason', 'interpretation', 'bodySite', 'method', 'referenceRange', 'hasMember', 'component'] },\n  Condition: { id: 'Condition.compact.1', fields: ['clinicalStatus', 'verificationStatus', 'category', 'severity', 'code', 'bodySite', 'subject', 'onset[x]', 'abatement[x]', 'recordedDate'] },\n  AllergyIntolerance: { id: 'AllergyIntolerance.compact.1', fields: ['clinicalStatus', 'verificationStatus', 'type', 'category', 'criticality', 'code', 'patient', 'onset[x]', 'recordedDate', 'lastOccurrence', 'reaction'] },\n  MedicationRequest: { id: 'MedicationRequest.compact.1', fields: ['status', 'statusReason', 'intent', 'category', 'priority', 'doNotPerform', 'reported[x]', 'medication[x]', 'subject', 'authoredOn', 'requester', 'reasonCode', 'courseOfTherapyType', 'dosageInstruction', 'dispenseRequest'] },\n  Immunization: { id: 'Immunization.compact.1', fields: ['status', 'statusReason', 'vaccineCode', 'patient', 'occurrence[x]', 'primarySource', 'lotNumber', 'site', 'route', 'doseQuantity', 'isSubpotent', 'subpotentReason', 'reasonCode', 'protocolApplied'] },\n  DiagnosticReport: { id: 'DiagnosticReport.compact.1', fields: ['status', 'category', 'code', 'subject', 'effective[x]', 'issued', 'result', 'conclusion', 'conclusionCode', 'presentedForm'] },\n  DocumentReference: { id: 'DocumentReference.compact.1', fields: ['status', 'docStatus', 'type', 'category', 'subject', 'date', 'author', 'description', 'securityLabel', 'relatesTo', 'content', 'context'] },\n};\nconst RECIPE_UNAVAILABLE: ProjectionWarning = { code: 'COMPACT_RECIPE_UNAVAILABLE', message: 'No reviewed compact recipe exists for this resource type; the full sanitized view is returned instead.' };\nconst MODIFIERS_ADDED: ProjectionWarning = { code: 'MODIFIER_FIELDS_ADDED', message: 'Modifier elements needed to interpret the selected fields were added to the projection.' };\n\nfunction containsModifierExtension(value: unknown, depth = 0): boolean {\n  if (!value || typeof value !== 'object' || depth > 64) return false;\n  if (Array.isArray(value)) return value.some(item => containsModifierExtension(item, depth + 1));\n  return Object.entries(value).some(([key, child]) => key === 'modifierExtension' || containsModifierExtension(child, depth + 1));\n}\n\nexport function project(resource: FhirResource, format: 'compact' | 'fhir', fields?: string[]): FhirResource {\n  return projection(resource, format, fields).resource;\n}\n\nexport function projection(resource: FhirResource, format: 'compact' | 'fhir', fields?: string[]): Projection {\n  resource = sanitizeForProjection(resource, projectionOnlyPolicies.get(resource)).resource;"),
  M('privacy-underscore-display-missed', "packages/core/src/privacy.ts",
    "patientReference && ['display', '_display', 'identifier', 'extension', '_reference', '_type'].includes(childKey)",
    "patientReference && ['display', 'identifier', 'extension', '_reference', '_type'].includes(childKey)"),
  M('privacy-identifier-system-denial-off', "packages/core/src/privacy.ts",
    "patientIdentifierSystems.has(node.system)",
    "false"),
  M('privacy-relatedperson-allowed', "packages/core/src/privacy.ts",
    "return 'SHARED_PERSON_REFERENCE_WITHHELD';",
    "return types.includes('RelatedPerson') ? undefined : 'SHARED_PERSON_REFERENCE_WITHHELD';"),
  M('privacy-person-allowed', "packages/core/src/privacy.ts",
    "return 'SHARED_PERSON_REFERENCE_WITHHELD';",
    "return types.includes('Person') ? undefined : 'SHARED_PERSON_REFERENCE_WITHHELD';"),
  M('privacy-target-type-check-off', "packages/core/src/privacy.ts",
    "types.some(type => !element.targets!.includes(`http://hl7.org/fhir/StructureDefinition/${type}`))",
    "false"),
  M('privacy-d1-Organization.alias', "packages/core/src/privacy.ts",
    "if (scope.shared && D1_MASKS.has(field)) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }",
    "if (scope.shared && field === 'Organization.alias') { result[childKey] = cloneFhirValue(child); continue; }\n      if (scope.shared && D1_MASKS.has(field)) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }"),
  M('privacy-d1-Location.alias', "packages/core/src/privacy.ts",
    "if (scope.shared && D1_MASKS.has(field)) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }",
    "if (scope.shared && field === 'Location.alias') { result[childKey] = cloneFhirValue(child); continue; }\n      if (scope.shared && D1_MASKS.has(field)) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }"),
  M('privacy-d1-Location.description', "packages/core/src/privacy.ts",
    "if (scope.shared && D1_MASKS.has(field)) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }",
    "if (scope.shared && field === 'Location.description') { result[childKey] = cloneFhirValue(child); continue; }\n      if (scope.shared && D1_MASKS.has(field)) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }"),
  M('privacy-d1-Location.availabilityExceptions', "packages/core/src/privacy.ts",
    "if (scope.shared && D1_MASKS.has(field)) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }",
    "if (scope.shared && field === 'Location.availabilityExceptions') { result[childKey] = cloneFhirValue(child); continue; }\n      if (scope.shared && D1_MASKS.has(field)) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }"),
  M('privacy-d1-Medication.code.text', "packages/core/src/privacy.ts",
    "if (scope.shared && D1_MASKS.has(field)) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }",
    "if (scope.shared && field === 'Medication.code.text') { result[childKey] = cloneFhirValue(child); continue; }\n      if (scope.shared && D1_MASKS.has(field)) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }"),
  M('privacy-codesystem-prose-off', "packages/core/src/privacy.ts",
    "const catalog = ['CodeSystem', 'ValueSet', 'CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition'].includes(scope.type);",
    "const catalog = ['ValueSet', 'CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition'].includes(scope.type);"),
  M('privacy-valueset-prose-off', "packages/core/src/privacy.ts",
    "const catalog = ['CodeSystem', 'ValueSet', 'CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition'].includes(scope.type);",
    "const catalog = ['CodeSystem', 'CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition'].includes(scope.type);"),
  M('privacy-false-contained-exemption', "packages/core/src/privacy.ts",
    "inherited.shared && typeof node.resourceType === 'string' && !(key === 'contained' && element.types.includes('Resource'))",
    "false"),
  M('privacy-shared-masks-on-contained', "packages/core/src/privacy.ts",
    "shared: path === '' ? resourceClass(node.resourceType) === 'shared' : inherited.shared",
    "shared: resourceClass(node.resourceType) === 'shared'"),
  M('s3-shared-base-check-off', "packages/core/src/search-parameters.ts",
    "        && (entry.pinnedBase?.includes(input.resourceType) || ['_id', '_lastUpdated'].includes(pair.name))\n",
    ""),
  M('privacy-shared-inheritance-off', "packages/core/src/privacy.ts",
    "shared: path === '' ? resourceClass(node.resourceType) === 'shared' : inherited.shared",
    "shared: path === '' && resourceClass(node.resourceType) === 'shared'"),
  M('privacy-conformance-prose-two-types', "packages/core/src/privacy.ts",
    "const catalog = ['CodeSystem', 'ValueSet', 'CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition'].includes(scope.type);",
    "const catalog = scope.type === 'CodeSystem' || scope.type === 'ValueSet';"),
  M('privacy-unclassified-identifier-off', "packages/core/src/privacy.ts",
    "    if (scope.shared && context?.definition === 'Identifier' && context.path === '' && !structuralStringAllowed('Identifier.value', node)) return withhold(path, 'UNCLASSIFIED_IDENTIFIER_WITHHELD', inModifier);\n",
    ""),
  M('privacy-undeclared-path-raw', "packages/core/src/privacy.ts",
    "if (scope.shared && childKey !== 'resourceType' && !childElement.types.length) { withhold(`${path}/[undeclared-property]`, 'UNDECLARED_PROPERTY_WITHHELD', inModifier, {}, 'unknown'); continue; }",
    "if (scope.shared && childKey !== 'resourceType' && !childElement.types.length) { withhold(pointer, 'UNDECLARED_PROPERTY_WITHHELD', inModifier, {}, 'unknown'); continue; }"),
  M('privacy-patient-extra-companions-off', "packages/core/src/privacy.ts",
    "patientReference && ['display', '_display', 'identifier', 'extension', '_reference', '_type'].includes(childKey)",
    "patientReference && ['display', '_display', 'identifier'].includes(childKey)"),
  M('privacy-system-casefold', "packages/core/src/privacy.ts",
    "patientIdentifierSystems.has(node.system)",
    "[...patientIdentifierSystems].some(system => system.toLowerCase() === String(node.system).toLowerCase())"),
  M('privacy-system-prefix', "packages/core/src/privacy.ts",
    "patientIdentifierSystems.has(node.system)",
    "[...patientIdentifierSystems].some(system => String(node.system).startsWith(system))"),
  M('privacy-computable-strings-off', "packages/core/src/privacy.ts",
    "const SHARED_STRUCTURAL_STRING_EXCEPTIONS: readonly {\n  fields: RegExp;\n  allows: (node: Record<string, unknown>, patientSystems: ReadonlySet<string>) => boolean;\n}[] = [\n  { fields: /^Resource\\.id$/, allows: node => typeof node.id !== 'string' || FHIR_ID.test(node.id) },\n  { fields: /^(?:CodeSystem|ValueSet)\\.name$/, allows: () => true },\n  { fields: /^ValueSet\\.(?:compose\\.(?:include|exclude)\\.filter\\.value|expansion\\.parameter\\.name)$/, allows: () => true },\n  { fields: /^(?:CodeSystem|ValueSet|CapabilityStatement|SearchParameter|StructureDefinition|OperationDefinition)\\.(?:version|url)$/, allows: () => true },\n  { fields: /^Reference\\.reference$/, allows: () => true },\n  { fields: /^Coding\\.version$/, allows: () => true },\n  { fields: /^ValueSet\\.(?:compose\\.(?:include|exclude)\\.version|expansion\\.contains(?:\\.contains)*\\.version)$/, allows: () => true },\n  { fields: /^Identifier\\.value$/, allows: (node, patientSystems) => typeof node.system === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:\\S/.test(node.system) && !patientSystems.has(node.system) },\n];\n",
    "const SHARED_STRUCTURAL_STRING_EXCEPTIONS: readonly { fields: RegExp; allows: (node: Record<string, unknown>, patientSystems: ReadonlySet<string>) => boolean }[] = [];\n"),
  M('privacy-identifier-system-condition-off', "packages/core/src/privacy.ts",
    "allows: (node, patientSystems) => typeof node.system === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:\\S/.test(node.system) && !patientSystems.has(node.system)",
    "allows: () => true"),
  M('privacy-complex-array-null-holes', "packages/core/src/privacy.ts",
    "return result === withheld ? (primitive ? [null] : []) : [result];",
    "return result === withheld ? [null] : [result];"),
  M('privacy-unlisted-shared-prose-off', "packages/core/src/privacy.ts",
    "if (scope.shared && scalar.types.some(type => type === 'string' || type === 'markdown') && !structuralString && !residual && !residualDisplay)",
    "if (false)"),
  M('privacy-reference-exception-before-guard', "packages/core/src/privacy.ts",
    "if (scope.shared && referenceLike) {",
    "if (scope.shared && referenceLike && !structuralStringAllowed('Reference.reference', node)) {"),
  M('privacy-shared-reference-companions-off', "packages/core/src/privacy.ts",
    "if (scope.shared && isReference && ['display', '_display', 'identifier'].includes(childKey))",
    "if (false)"),
  M('self-sort-mismatch-refuses', "packages/core/src/index.ts",
    "if (reported && !opaque && matched.materialMismatch)",
    "if (reported && !opaque && (matched.materialMismatch || matched.sortReported === 'dropped' || matched.sortReported === 'different'))"),
  M('missing-self-permissive', "packages/core/src/index.ts",
    "if (verifySelf && !self)",
    "if (false)"),
  M('downgrade-not-sticky', "packages/core/src/index.ts",
    "...overlay?.constraintProof?.[index]",
    "/* sticky constraint flags ignored */"),
  M('sort-boundary-precision-ignored', "packages/core/src/index.ts",
    "previous?.queryOverlay?.sortBoundaryPrecision",
    "undefined"),
  M('profile-invalidation-skipped', "packages/core/src/index.ts",
    "if (profile) this.profileState.invalidate(profile.id);",
    "/* invalidation skipped */"),
  M('seam-reachable-via-config', "packages/core/src/index.ts",
    "const parsed = configSchema.safeParse(config);",
    "const { testQueryProfile: injected, ...publicConfig } = config as GatewayConfig & PrivateGatewayTestOptions;\n    if (injected) { this.installQueryCandidate(injected); this.testOptions = { ...testOptions, testQueryProfile: injected }; }\n    const parsed = configSchema.safeParse(publicConfig);"),
  M('g4-origin-always-true', "packages/core/src/index.ts",
    "return this.transport.validate(fullUrl).href === this.transport.url(`${resource.resourceType}/${resource.id}`).href;",
    "return true;"),
  M('g4-origin-only-ignores-path', "packages/core/src/index.ts",
    "return this.transport.validate(fullUrl).href === this.transport.url(`${resource.resourceType}/${resource.id}`).href;",
    "return this.transport.validate(fullUrl).origin === this.transport.url(`${resource.resourceType}/${resource.id}`).origin;"),
  M('g4-first-page-only', "packages/core/src/index.ts",
    "if (Object.hasOwn(entry, 'fullUrl') && !this.entryOriginMatches(entry.fullUrl, entry.resource))",
    "if (verifySelf && Object.hasOwn(entry, 'fullUrl') && !this.entryOriginMatches(entry.fullUrl, entry.resource))"),
  M('g4-urn-accepted', "packages/core/src/index.ts",
    "if (typeof fullUrl !== 'string' || typeof resource.id !== 'string') return false;",
    "if (typeof fullUrl === 'string' && /^urn:(uuid|oid):/.test(fullUrl)) return true;\n    if (typeof fullUrl !== 'string' || typeof resource.id !== 'string') return false;"),
  M('p15-whole-page-failure', "packages/core/src/index.ts",
    "if (Object.hasOwn(entry.resource, 'id') && (typeof entry.resource.id !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(entry.resource.id))) { suppressed = true; partialReasons.add('INVALID_RESOURCE_ID'); continue; }",
    "if (Object.hasOwn(entry.resource, 'id') && (typeof entry.resource.id !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(entry.resource.id))) { throw new GatewayFault('INVALID_RESPONSE', 'Invalid search candidate.'); }"),
  M('p15-malformed-id-retained', "packages/core/src/index.ts",
    "if (Object.hasOwn(entry.resource, 'id') && (typeof entry.resource.id !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(entry.resource.id))) { suppressed = true; partialReasons.add('INVALID_RESOURCE_ID'); continue; }",
    "/* malformed id refusal skipped */"),
  M('s4-f1-origin-before-oo', "packages/core/src/index.ts",
    "if (entry.resource.resourceType === 'OperationOutcome') {",
    "if (Object.hasOwn(entry, 'fullUrl') && !this.entryOriginMatches(entry.fullUrl, entry.resource)) { suppressed = true; partialReasons.add('ENTRY_ORIGIN_MISMATCH'); continue; }\n      if (entry.resource.resourceType === 'OperationOutcome') {"),
  M('s4-f2-p15-excluded-from-proof', "packages/core/src/index.ts",
    "checked.push(entry.resource);",
    "if (!Object.hasOwn(entry.resource, 'id') || (typeof entry.resource.id === 'string' && /^[A-Za-z0-9.-]{1,64}$/.test(entry.resource.id))) checked.push(entry.resource);"),
  M('s4-f3-stale-evidence-ref', "packages/core/src/index.ts",
    "return current.execution === 'tested_adapter' ? current : { ...current, evidence_ref: undefined };",
    "return current;"),
  M('s4-f4-p15-total-published', "packages/core/src/index.ts",
    "const publishTotal = verifySelf && !partialReasons.has('INVALID_RESOURCE_ID') && !precisionRefused && !sourceIncomplete && nextLinks.length === 0;",
    "const publishTotal = verifySelf && !precisionRefused && !sourceIncomplete && nextLinks.length === 0;"),
  M('s4-f5-version-retained', "packages/core/src/index.ts",
    "if (invalidVersion) {",
    "if (invalidVersion && Boolean(0)) {"),
  M('rv-invalidated-sort-not-downgraded', "packages/core/src/index.ts",
    "if (!profile && evidence.sort) evidence = { ...evidence, sort: { ...evidence.sort, effective: null, order: 'requested_unverified' } };",
    "/* invalidated sort downgrade omitted */"),
  C('rv-partial-reasons-not-sticky', [
    {
      "file": "packages/core/src/index.ts",
      "find": "const partialReasons = new Set<NonNullable<Snapshot['partialReasons']>[number]>(previous?.partialReasons);",
      "replace": "const partialReasons = new Set<NonNullable<Snapshot['partialReasons']>[number]>();"
    },
    {
      "file": "packages/core/src/index.ts",
      "find": "      ...(previous?.refused ? { refused: true, refusalReasons: previous.refusalReasons } : {}),",
      "replace": "      // diagnostic: inherited overlay refusal omitted."
    }
  ]),
  M('rv-profileForSource-closed-unbound', "packages/core/src/query.ts",
    "return profileMatchesSource(profile, capability) ? profile : undefined;",
    "return profile;"),
  M('x-anchor-resource-id', "packages/core/src/privacy.ts",
    "{ fields: /^Resource\\.id$/, allows: node => typeof node.id !== 'string' || FHIR_ID.test(node.id) }",
    "{ fields: /\\.id$/, allows: node => typeof node.id !== 'string' || FHIR_ID.test(node.id) }"),
  M('x-resource-id-any-node', "packages/core/src/privacy.ts",
    "typeof node.resourceType === 'string' && childKey.replace(/^_/, '') === 'id' ? 'Resource.id'",
    "childKey.replace(/^_/, '') === 'id' ? 'Resource.id'"),
  M('x-anchor-name', "packages/core/src/privacy.ts",
    "{ fields: /^(?:CodeSystem|ValueSet)\\.name$/, allows: () => true }",
    "{ fields: /\\.name$/, allows: () => true }"),
  M('x-anchor-coding-version', "packages/core/src/privacy.ts",
    "{ fields: /^Coding\\.version$/, allows: () => true }",
    "{ fields: /version$/, allows: () => true }"),
  M('x-anchor-filter', "packages/core/src/privacy.ts",
    "{ fields: /^ValueSet\\.(?:compose\\.(?:include|exclude)\\.filter\\.value|expansion\\.parameter\\.name)$/, allows: () => true }",
    "{ fields: /(?:filter\\.value|parameter\\.name)$/, allows: () => true }"),
  M('x-anchor-conformance-version', "packages/core/src/privacy.ts",
    "{ fields: /^(?:CodeSystem|ValueSet|CapabilityStatement|SearchParameter|StructureDefinition|OperationDefinition)\\.(?:version|url)$/, allows: () => true }",
    "{ fields: /\\.(?:version|url)$/, allows: () => true }"),
  M('x-empty-object-drop-off', "packages/core/src/privacy.ts",
    "    if (path && Object.keys(result).length === 0 && omitted.length > omissionsBefore) return withheld;\n",
    ""),
  M('r2-unsupported-reference-off', "packages/core/src/privacy.ts",
    "  if (parsed?.form === 'unsupported') return 'REFERENCE_TARGET_TYPE_WITHHELD';\n",
    ""),
  M('r2-identifier-absolute-uri-off', "packages/core/src/privacy.ts",
    "allows: (node, patientSystems) => typeof node.system === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:\\S/.test(node.system) && !patientSystems.has(node.system)",
    "allows: (node, patientSystems) => typeof node.system === 'string' && !patientSystems.has(node.system)"),
  M('r2-resource-id-grammar-off', "packages/core/src/privacy.ts",
    "{ fields: /^Resource\\.id$/, allows: node => typeof node.id !== 'string' || FHIR_ID.test(node.id) }",
    "{ fields: /^Resource\\.id$/, allows: () => true }"),
  M('met08-retain-custom-names', "packages/core/src/search-parameters.ts",
    "    if (!retainDeclaredName(entry.name, resourceType)) continue;",
    "    // MET-08 mutant: retain source-only names."),
  M('f06-raw-source-software', "packages/core/src/index.ts",
    "? sourceIdentityDigest(value) : undefined;",
    "? value : undefined;"),
  // W-02 and distinct S5 diagnostics. Redundancies are recorded in the A2 migration table.
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — S5-M04-clean-error
  M('S5-M04-clean-error', "packages/core/src/contracts.ts",
    "if (t.projected || t.narrative_omitted || t.withheld_payloads.length || t.omitted_fields.length || t.unresolved_fields.length || t.recipe_ids.length || t.structural_resource_indices.length) return fail();",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — S5-M06-digest
  M('S5-M06-digest', "packages/core/src/contracts.ts",
    "if (c.query_digest !== digest) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — S5-M10-ordered-query
  M('S5-M10-ordered-query', "packages/core/src/contracts.ts",
    "if (c.constraints && JSON.stringify(c.constraints.map(p => ({ name: p.name, value: p.value }))) !== JSON.stringify(pairs)) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — S5-M11-profile
  M('S5-M11-profile', "packages/core/src/contracts.ts",
    "if (env.transform.delivery_profile !== context.deliveryProfile || ",
    "if ("),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — CL-1-deep-freeze
  M('CL-1-deep-freeze', "packages/core/src/contracts.ts",
    "if (!frozenValidationState02(context)) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — CL-3-query-frozen
  M('CL-3-query-frozen', "packages/core/src/contracts.ts",
    "if (!Object.isFrozen(context) || !frozenValidationState02(q)) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — CL-4-structured-equality
  M('CL-4-structured-equality', "packages/core/src/contracts.ts",
    "if (JSON.stringify(result.structuredContent) !== serialized) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — CL-5-binding-revisions
  M('CL-5-binding-revisions', "packages/core/src/contracts.ts",
    "if (env.source.capability_revision !== q.sourceRevision || env.context.policy_revision !== q.policyRevision || env.context.handle !== q.contextHandle) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — CL-6-query-resource-type
  M('CL-6-query-resource-type', "packages/core/src/contracts.ts",
    "if (resources?.some(r => r.resourceType !== q.resourceType)) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — CL-7-iserror-binding
  M('CL-7-iserror-binding', "packages/core/src/contracts.ts",
    " || result.isError !== (env.error ? true : undefined)) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ") return fail('VALIDATION_CONTEXT_MISMATCH');"),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — CL-8-fallback-label
  M('CL-8-fallback-label', "packages/core/src/contracts.ts",
    " && context.renderedText !== `delivery_profile: \"full-text-v1\"\\n${jsonLine}`",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — S51-M01-search-origin
  M('S51-M01-search-origin', "packages/core/src/contracts.ts",
    "const searchChain = tool === 'fhir_search' || tool === 'fhir_page' || context?.query !== undefined;",
    "const searchChain = tool === 'fhir_search' || tool === 'fhir_page' || c.query_digest !== undefined || c.constraints !== undefined || c.constraints_on_first_page !== undefined;"),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — S51-M02-delivery-loss
  M('S51-M02-delivery-loss', "packages/core/src/contracts.ts",
    "if (c.state === 'complete_for_query' && (data.manifest !== undefined || c.reasons.some(r => ['OVERSIZED_RESOURCE', 'UNSUPPORTED_PRECISION', 'INVALID_RESOURCE_ID', 'ENTRY_ORIGIN_MISMATCH', 'FILTER_EXECUTION_UNVERIFIED'].includes(r)) || env.warnings.some(w => ['UNSUPPORTED_PRECISION', 'FILTER_EXECUTION_UNVERIFIED', 'CONTINUATION_QUERY_UNVERIFIED'].includes(w.code)))) return fail();",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — S51-M03-trusted-bytes
  M('S51-M03-trusted-bytes', "packages/core/src/contracts.ts",
    " || measured > context.effectiveByteLimit! || env.budget.byte_limit > context.effectiveByteLimit!",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — S51-M04-advertised-count
  M('S51-M04-advertised-count', "packages/core/src/contracts.ts",
    "Number(data.resource_count) < (data.resources as unknown[]).length",
    "data.resource_count !== (data.resources as unknown[]).length"),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — S51-M05-catalog
  M('S51-M05-catalog', "packages/core/src/contracts.ts",
    "    if (env.warnings.some(w => !Object.hasOwn(WARNING_MESSAGES, w.code) || w.message !== (w.code === 'NO_MATCHES' ? noMatchesMessage : WARNING_MESSAGES[w.code]))) return fail();",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — S51-M06-withheld-manifest
  M('S51-M06-withheld-manifest', "packages/core/src/contracts.ts",
    "    if (t.withheld_payloads.some(m => typeof m.path !== 'string' || !m.path.startsWith('/') || typeof m.reason !== 'string' || !m.reason || Object.keys(m).some(k => !manifestKeys.includes(k)) ||\n      (m.content_type !== undefined && typeof m.content_type !== 'string') || (m.hash !== undefined && typeof m.hash !== 'string') ||\n      (m.size !== undefined && (typeof m.size !== 'number' || !Number.isSafeInteger(m.size) || m.size < 0)) ||\n      (m.spans !== undefined && (m.reason !== 'PROTECTED_LINK_IN_TEXT' || typeof m.spans !== 'number' || !Number.isSafeInteger(m.spans) || m.spans < 1)) ||\n      (m.count !== undefined && (typeof m.count !== 'number' || !Number.isSafeInteger(m.count) || m.count < 1)))) return fail();",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — S51-M07-retained-next-offset
  M('S51-M07-retained-next-offset', "packages/core/src/contracts.ts",
    "if (page && ((page.has_more === true) !== (data.next_offset !== undefined) || page.has_more === null)) return fail();",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — S51-M08-read-target
  M('S51-M08-read-target', "packages/core/src/contracts.ts",
    "if (tool === 'fhir_read' && context?.readTarget && resources.some(r => r.resourceType !== context.readTarget!.resourceType || r.id !== context.readTarget!.id)) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — S51-M09-recipe
  M('S51-M09-recipe', "packages/core/src/contracts.ts",
    "if (t.recipe_ids.length && (!t.projected || t.format !== 'compact')) return fail();",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — S51-M12-no-matches-history
  M('S51-M12-no-matches-history', "packages/core/src/contracts.ts",
    "if (context.chainDeliveredCount !== 0) return fail();",
    ""),
  // proposals/audit/s5-mutants/s5.2-mutants.txt — S52-M01-strict-parse
  M('S52-M01-strict-parse', "packages/core/src/index.ts",
    "const parsed = toolInputV2Schemas[tool].safeParse(unknownInput);",
    "const parsed = { success: true, data: unknownInput };"),
  // proposals/audit/s5-mutants/s5.2-mutants.txt — S52-M02-own-keys
  M('S52-M02-own-keys', "packages/core/src/index.ts",
    "if (caps.cursor !== undefined && ownKeys.some(key => !['topic', 'cursor', 'context_handle', 'limit', 'output'].includes(key)))",
    "if (false)"),
  // proposals/audit/s5-mutants/s5.2-mutants.txt — S52-M03-combinations
  M('S52-M03-combinations', "packages/core/src/index.ts",
    "if (capabilitiesCombinationFault(caps))",
    "if (false)"),
  // proposals/audit/s5-mutants/s5.2-mutants.txt — S52-M04-retained-conflict
  M('S52-M04-retained-conflict', "packages/core/src/index.ts",
    "if (top && nested && JSON.stringify(top) !== JSON.stringify(nested)) throw new GatewayFault('INVALID_ARGUMENTS', 'Conflicting retained field selections.');",
    ""),
  // proposals/audit/s5-mutants/s5.2-mutants.txt — S52-M05-inspect-fields
  M('S52-M05-inspect-fields', "packages/core/src/index.ts",
    "if (retained.action === 'inspect' && (top || nested))",
    "if (false)"),
  // proposals/audit/s5-mutants/s5.2-mutants.txt — S52-M06-compact-default
  M('S52-M06-compact-default', "packages/core/src/index.ts",
    "return { input, ownKeys, format: requestedFormat ?? 'fhir',",
    "return { input, ownKeys, format: requestedFormat ?? 'compact',"),
  // proposals/audit/s5-mutants/s5.2-mutants.txt — S52-M07-fabricated-format
  M('S52-M07-fabricated-format', "packages/core/src/index.ts",
    "...(requestedFormat !== undefined ? { requestedFormat } : {})",
    "...{ requestedFormat: requestedFormat ?? 'fhir' }"),
  // proposals/audit/s5-mutants/s5.2-mutants.txt — S52-M08-stale-error-array
  M('S52-M08-stale-error-array', "packages/core/src/index.ts",
    "    envelope.warnings = [];\n    envelope.error = { code,",
    "    envelope.warnings = [];\n    envelope.transform.omitted_fields = ['/stale'];\n    envelope.error = { code,"),
  // proposals/audit/s5-mutants/s5.2-mutants.txt — S52-M09-selected-fields
  M('S52-M09-selected-fields', "packages/core/src/index.ts",
    "...(fields ? { fields: [...fields] } : {})",
    "...{}"),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M01-self-proof
  M('S53-M01-self-proof', "packages/core/src/index.ts",
    "const overlay = snapshot.queryOverlay;\n    const reasons =",
    "evidence.materialFilterProved = evidence.constraints.every(entry => entry.source_reported === 'matched');\n    const overlay = snapshot.queryOverlay;\n    const reasons ="),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M02-repeat-constraints
  M('S53-M02-repeat-constraints', "packages/core/src/index.ts",
    "coverage.constraints = evidence.constraints.map(entry => ({ ...entry }));",
    "coverage.constraints = evidence.constraints.filter((entry, index, all) => all.findIndex(x => x.name === entry.name && x.value === entry.value) === index).map(entry => ({ ...entry }));"),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M03-repeat-sort
  M('S53-M03-repeat-sort', "packages/core/src/index.ts",
    "// Q's bounded helper is not an excuse to silently lose material reasons.",
    "if (coverage.sort) delete coverage.sort.requested;\n    // Q's bounded helper is not an excuse to silently lose material reasons."),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M04-digest
  M('S53-M04-digest', "packages/core/src/index.ts",
    "// Q's bounded helper is not an excuse to silently lose material reasons.",
    "delete coverage.query_digest;\n    // Q's bounded helper is not an excuse to silently lose material reasons."),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M06-suppression-no-matches
  M('S53-M06-suppression-no-matches', "packages/core/src/index.ts",
    "deliveredCount: (overlay?.deliveredCount ?? 0) + call.deliveredCount,",
    "deliveredCount: snapshot.suppressed ? 0 : (overlay?.deliveredCount ?? 0) + call.deliveredCount,"),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M08-scan-binding
  M('S53-M08-scan-binding', "examples/observed-code-scan.ts",
    "const params = [...options.dateWindow.map(pair => ({ ...pair })), { ...selector }];",
    "const params = [...options.dateWindow.map(pair => ({ ...pair }))];"),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M09-scan-dates
  M('S53-M09-scan-dates', "examples/observed-code-scan.ts",
    "const params = [...options.dateWindow.map(pair => ({ ...pair })), { ...selector }];",
    "const params = [{ ...selector }];"),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M11-mcp-cap
  M('S53-M11-mcp-cap', "examples/observed-code-scan.ts",
    "report.mcpCalls >= limits.maxMcpCalls",
    "false"),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M12-upstream-cap
  M('S53-M12-upstream-cap', "examples/observed-code-scan.ts",
    "report.upstreamCalls + client.upstreamWork.maxPerCall > limits.maxUpstreamCalls",
    "false"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — S53-M13-time-cap
  C('S53-M13-time-cap', [
    {
      "file": "examples/observed-code-scan.ts",
      "find": "    if (deadline.aborted || now() - started >= limits.maxSeconds * 1000 || report.mcpCalls >= limits.maxMcpCalls",
      "replace": "    if (deadline.aborted || false || report.mcpCalls >= limits.maxMcpCalls"
    },
    {
      "file": "examples/observed-code-scan.ts",
      "find": "    if (deadline.aborted || now() - started >= limits.maxSeconds * 1000 || bytes > limits.maxBytesPerCall",
      "replace": "    if (deadline.aborted || false || bytes > limits.maxBytesPerCall"
    }
  ]),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M14-call-byte-cap
  M('S53-M14-call-byte-cap', "examples/observed-code-scan.ts",
    "bytes > limits.maxBytesPerCall",
    "false"),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M15-task-byte-cap
  M('S53-M15-task-byte-cap', "examples/observed-code-scan.ts",
    "report.bytes + limits.maxBytesPerCall > limits.maxBytesPerTask",
    "false"),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M16-raised-operator-limit
  M('S53-M16-raised-operator-limit', "examples/observed-code-scan.ts",
    "value > limits[key as keyof typeof limits]!",
    "false"),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M17-terminology-fetch
  M('S53-M17-terminology-fetch', "examples/observed-code-scan.ts",
    "discovery = false; continue;",
    "await client.callTool({ name: 'fhir_read', arguments: { resource_type: 'CodeSystem', id: 'synthetic-terminology' } }, { signal: deadline });\n      discovery = false; continue;"),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M18-truncated-split
  M('S53-M18-truncated-split', "examples/observed-code-scan.ts",
    "if (options.originalCodeOr !== undefined && splitEscapedCommaOrDetailed(options.originalCodeOr).truncated)",
    "if (false)"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — S53-M19-dynamic-warning
  M('S53-M19-dynamic-warning', "packages/core/src/index.ts",
    "result.set(warning.code, { code: warning.code, message,",
    "result.set(warning.code, { code: warning.code, message: warning.message,"),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M20-total-vs-clinical
  M('S53-M20-total-vs-clinical', "packages/core/src/index.ts",
    "kind === 'unsupported_modifier' && work.upstreamCalls !== 0 ? MODIFIER_NO_CLINICAL_MESSAGE",
    "kind === 'unsupported_modifier' && work.clinicalCalls !== 0 ? MODIFIER_NO_CLINICAL_MESSAGE"),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M21-reviewed-repairs
  M('S53-M21-reviewed-repairs', "packages/core/src/index.ts",
    "return reviewedNamesFor(resolved, new Set(this.capabilities?.keys() ?? []));",
    "return NO_REVIEWED_NAMES;"),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — S53-M22-reasons
  M('S53-M22-reasons', "packages/core/src/index.ts",
    "coverage.reasons = [...new Set([...coverage.reasons, ...reasons])];",
    "coverage.reasons = [...new Set([...coverage.reasons, ...reasons])].slice(0, 8);"),
  // proposals/audit/s5-mutants/s5.3-r2-fix-mutants.txt — C2-D01-remainder-ordering-reverted
  M('C2-D01-remainder-ordering-reverted', "packages/core/src/index.ts",
    "const remainder: QueryChainView['remainder'] = call.localRemainder ? 'local' : snapshot.nextUrl ? 'upstream'\n      : nonContinuable ? 'rejected_link' : unverifiedContinuation || call.unknownContinuation || snapshot.sourceIncomplete ? 'unknown' : 'none';",
    "const remainder: QueryChainView['remainder'] = unverifiedContinuation ? 'unknown' : call.localRemainder ? 'local' : snapshot.nextUrl ? 'upstream'\n      : nonContinuable ? 'rejected_link' : call.unknownContinuation || snapshot.sourceIncomplete ? 'unknown' : 'none';"),
  // proposals/audit/s5-mutants/s5.3-r2-fix-mutants.txt — C2-D02-refused-drained-false
  M('C2-D02-refused-drained-false', "packages/core/src/query.ts",
    "? null : chain.exhausted;",
    "? (chain.refused && chain.remainder === 'none' ? false : null) : chain.exhausted;"),
  // proposals/audit/s5-mutants/s5.3-r2-fix-mutants.txt — N02-refused-unknown-false
  M('N02-refused-unknown-false', "packages/core/src/query.ts",
    "? null : chain.exhausted;",
    "? (chain.refused && chain.remainder === 'unknown' ? false : null) : chain.exhausted;"),
  // proposals/audit/s5-mutants/s5.3-r2-fix-mutants.txt — N03-shared-predicate-bypassed
  M('N03-shared-predicate-bypassed', "packages/core/src/index.ts",
    "&& noMatchesEligible(coverage, chain.deliveredCount, evidence.constraints)",
    "&& (evidence.constraints.some(pair => !['subject', 'patient', '_id'].includes(pair.name)) && chain.deliveredCount === 0 && coverage.query_exhausted === true)"),
  // proposals/audit/s5-mutants/s5.3-r2-fix-mutants.txt — N04-id-material-again
  M('N04-id-material-again', "packages/core/src/contracts.ts",
    "filters.some(pair => !['subject', 'patient', '_id'].includes(pair.name))",
    "filters.some(pair => !['subject', 'patient'].includes(pair.name))"),
  // proposals/audit/s5-mutants/s5.3-r2-fix-mutants.txt — N07-allowlist-to-old-denylist
  M('N07-allowlist-to-old-denylist', "packages/core/src/index.ts",
    "reasons.some(reason => !informationalReasons.includes(reason))",
    "reasons.some(reason => ['OVERSIZED_RESOURCE', 'UNSUPPORTED_PRECISION', 'INVALID_RESOURCE_ID', 'ENTRY_ORIGIN_MISMATCH', 'OUTPUT_LIMIT', 'SOURCE_REPORTED_INCOMPLETE', 'DELIVERY_REFUSED'].includes(reason))"),
  // proposals/audit/s5-mutants/s5.3-r2-fix-mutants.txt — N08-maxPerCall-check-removed
  M('N08-maxPerCall-check-removed', "examples/observed-code-scan.ts",
    "return !afterCall || delta <= client.upstreamWork.maxPerCall;",
    "return true;"),
  // proposals/audit/s5-mutants/s5.3-r2-fix-mutants.txt — N10-null-pagination-limit-label
  M('N10-null-pagination-limit-label', "examples/observed-code-scan.ts",
    "if (env.pagination?.has_more !== true || !env.pagination.next_cursor) return refuse();",
    "if (env.pagination?.has_more !== true || !env.pagination.next_cursor) return refuse('SCAN_LIMIT_REACHED');"),
  // proposals/audit/s5-mutants/s5.3-r2-fix-mutants.txt — N10-chainExhausted-on-refusal
  M('N10-chainExhausted-on-refusal', "examples/observed-code-scan.ts",
    "    if (!env.coverage || !['complete_for_query', 'partial', 'unknown'].includes",
    "    if (env.pagination?.has_more === false) report.chainExhausted = true;\n    if (!env.coverage || !['complete_for_query', 'partial', 'unknown'].includes"),
  // proposals/audit/s5-mutants/s5.3-r2-fix-mutants.txt — N09-unrunnable-repair-offered
  M('N09-unrunnable-repair-offered', "packages/core/src/repairs.ts",
    "field && dateWindow.length > 0 && dateWindow.every(pair => OBSERVED_CODE_DATE_PARAMETERS[type]?.includes(pair.name) && Boolean(pair.value)) && reviewed.parameter(type, 'code')",
    "field && reviewed.parameter(type, 'code')"),
  // proposals/audit/s5-mutants/s5.3-r2-fix-mutants.txt — N11-source-incomplete-labelled-continuation
  M('N11-source-incomplete-labelled-continuation', "packages/core/src/query.ts",
    "if (chain.remainder === 'unknown' && !chain.refusalReasons?.includes('SOURCE_REPORTED_INCOMPLETE'))",
    "if (chain.remainder === 'unknown')"),
  // proposals/audit/s5-mutants/s5.3-r2-fix-mutants.txt — N05-unverified-exhaustion-is-refusal
  M('N05-unverified-exhaustion-is-refusal', "examples/observed-code-scan.ts",
    "if (env.coverage.query_exhausted === null) return { ...report, status: 'exhaustion_unverified', code: 'SCAN_EXHAUSTION_UNVERIFIED' };",
    "if (env.coverage.query_exhausted === null) return refuse();"),
  // proposals/audit/s5-mutants/s5.3-r2-fix-mutants.txt — N01-local-remainder-overridden-by-rejected-link
  M('N01-local-remainder-overridden-by-rejected-link', "packages/core/src/query.ts",
    "? !retained && knownRemainder ? false : null",
    "? null"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — C53-M01-nomatches-any-suffix
  M('C53-M01-nomatches-any-suffix', "packages/core/src/index.ts",
    "const message = warning.code === 'NO_MATCHES' && warning.message === base + NO_MATCHES_UNVERIFIED_SUFFIX\n        ? base + NO_MATCHES_UNVERIFIED_SUFFIX : base;",
    "const message = warning.code === 'NO_MATCHES' && warning.message.startsWith(base)\n        ? warning.message : base;"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — C53-M02-scan-nonsettling-driver
  M('C53-M02-scan-nonsettling-driver', "examples/observed-code-scan.ts",
    "const onAbort = () => reject(new Error('scan deadline'));",
    "const onAbort = () => undefined;"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — C53-M03-unknown-warning-dropped
  M('C53-M03-unknown-warning-dropped', "packages/core/src/index.ts",
    "if (!Object.hasOwn(WARNING_MESSAGES, warning.code) || !base) throw new GatewayFault('INTERNAL_ERROR', 'Unable to complete the bounded request.');",
    "if (!Object.hasOwn(WARNING_MESSAGES, warning.code) || !base) continue;"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — C53-M04-error-message-passthrough
  M('C53-M04-error-message-passthrough', "packages/core/src/index.ts",
    " && ['invalid_topic', 'invalid_format', 'invalid_interaction', 'invalid_action'].some(key => REFUSAL_MESSAGES[key] === fault.message)",
    ""),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — C53-M05-scan-post-upstream-overrun
  M('C53-M05-scan-post-upstream-overrun', "examples/observed-code-scan.ts",
    "|| report.bytes > limits.maxBytesPerTask || report.upstreamCalls > limits.maxUpstreamCalls) return refuse('SCAN_LIMIT_REACHED');",
    "|| report.bytes > limits.maxBytesPerTask) return refuse('SCAN_LIMIT_REACHED');"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — C53-M07-unverified-continuation-warning-dropped
  M('C53-M07-unverified-continuation-warning-dropped', "packages/core/src/index.ts",
    "if (unverifiedContinuation) add('CONTINUATION_QUERY_UNVERIFIED');",
    ""),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F02-continuation
  M('FIX-F02-continuation', "packages/core/src/index.ts",
    "const unverifiedContinuation = !resourceOrigin && snapshot.queryEvidenceKind === 'unverified_continuation';",
    "const unverifiedContinuation = false;"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F03-source-filter
  C('FIX-F03-source-filter', [
    {
      "file": "packages/core/src/index.ts",
      "find": "    if (!resourceOrigin && snapshot.unverifiedFilters?.length) evidence.materialFilterProved = false;",
      "replace": ""
    },
    {
      "file": "packages/core/src/index.ts",
      "find": "    if (!resourceOrigin && reasons.includes('FILTER_EXECUTION_UNVERIFIED')) evidence.materialFilterProved = false;",
      "replace": ""
    }
  ]),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F04-derived-cap
  M('FIX-F04-derived-cap', "packages/core/src/index.ts",
    "    const coverage = coverageForSnapshot(disclosed, { ...chain, refusalReasons: reasons.includes('SOURCE_REPORTED_INCOMPLETE') ? ['SOURCE_REPORTED_INCOMPLETE'] : reasons.length ? [] : undefined });",
    "    const coverage = coverageForSnapshot(disclosed, chain);"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F05-overlay
  M('FIX-F05-overlay', "packages/core/src/index.ts",
    "(call.tool !== 'fhir_page' || Boolean(overlay))",
    "true"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F05-caller-filter
  M('FIX-F05-caller-filter', "packages/core/src/index.ts",
    "noMatchesEligible(coverage, chain.deliveredCount, evidence.constraints)",
    "noMatchesEligible(coverage, chain.deliveredCount, call.filtered)"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F06-error-reasons
  M('FIX-F06-error-reasons', "packages/core/src/index.ts",
    "reasons: [...(clinical ? ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN'] : []), faultCode]",
    "reasons: [...(clinical ? ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN', 'FILTER_EXECUTION_UNVERIFIED'] : ['DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION']), faultCode]"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F06-retained-read
  M('FIX-F06-retained-read', "packages/core/src/index.ts",
    "const resourceOrigin = read || (retained && !snapshot.queryEvidence);",
    "const resourceOrigin = read;"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F07-warning-keys
  M('FIX-F07-warning-keys', "packages/core/src/index.ts",
    "result.set(warning.code, { code: warning.code, message,",
    "result.set(warning.code, { ...warning, message,"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F08-lazy-names
  M('FIX-F08-lazy-names', "packages/core/src/index.ts",
    "const parameters = resolveSearchParameters({ resourceType: type, declared: capability.declared, advertised: true });",
    "const parameters = capability.resolvedParameters.get('generic-r4');"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F09-fallback
  M('FIX-F09-fallback', "packages/core/src/index.ts",
    "    const coverage = coverageForSnapshot(disclosed, { ...chain, refusalReasons: reasons.includes('SOURCE_REPORTED_INCOMPLETE') ? ['SOURCE_REPORTED_INCOMPLETE'] : reasons.length ? [] : undefined });",
    "    const coverage = coverageForSnapshot(disclosed, { ...chain, refusalReasons: [] });"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F10-zero-work-reserve
  M('FIX-F10-zero-work-reserve', "examples/observed-code-scan.ts",
    "client.upstreamWork.maxPerCall < 1",
    "client.upstreamWork.maxPerCall < 0"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F10-initial-counter
  M('FIX-F10-initial-counter', "examples/observed-code-scan.ts",
    "if (!Number.isSafeInteger(upstreamStart) || upstreamStart < 0) return refuse();",
    ""),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F10-monotone-counter
  M('FIX-F10-monotone-counter', "examples/observed-code-scan.ts",
    "if (!Number.isSafeInteger(total) || total < lastWork) return false;",
    ""),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F11-unresolved
  M('FIX-F11-unresolved', "examples/observed-code-scan.ts",
    "|| env.transform?.unresolved_fields?.length || env.transform?.withheld_payloads?.length",
    ""),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F11-refused-label
  M('FIX-F11-refused-label', "examples/observed-code-scan.ts",
    "if (env.coverage.query_exhausted !== true) return refuse();",
    "if (env.coverage.query_exhausted !== true) return refuse('SCAN_LIMIT_REACHED');"),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F12-response-binding
  M('FIX-F12-response-binding', "examples/observed-code-scan.ts",
    "|| env.context?.handle !== contextHandle || env.source?.alias !== source",
    ""),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F12-resource-type
  M('FIX-F12-resource-type', "examples/observed-code-scan.ts",
    "|| env.data.resources.some(resource => resource?.resourceType !== resourceType)",
    ""),
  // proposals/audit/s5-mutants/s5.3-review-fix-mutants.txt — FIX-F14-date-window
  M('FIX-F14-date-window', "examples/observed-code-scan.ts",
    "!OBSERVED_CODE_DATE_PARAMETERS[resourceType]?.includes(pair.name)",
    "pair.name !== 'date'"),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R01-overlay-in-blob
  M('R01-overlay-in-blob', "packages/core/src/index.ts",
    "const page: Snapshot = { ...snapshot, queryOverlay: undefined, offset: 0, sliceStart: undefined, sliceEnd: undefined };",
    "const page: Snapshot = { ...snapshot, offset: 0, sliceStart: undefined, sliceEnd: undefined };"),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R02-dangling-action
  C('R02-dangling-action', [
    {
      "file": "packages/core/src/index.ts",
      "find": "        if (manifest) data.manifest = { ...manifest, action: recoveryAction(false) };",
      "replace": "        if (manifest) data.manifest = { ...manifest, action: recoveryAction(true) };"
    },
    {
      "file": "packages/core/src/index.ts",
      "find": "          if (data.manifest) data.manifest = { ...data.manifest, action: recoveryAction(false) };",
      "replace": "          if (data.manifest) data.manifest = { ...data.manifest, action: recoveryAction(true) };"
    }
  ]),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R02-gate-dangling-action
  M('R02-gate-dangling-action', "packages/core/src/contracts.ts",
    "    if (!env.result && data.manifest && typeof data.manifest === 'object' && /fhir_result/i.test(String((data.manifest as { action?: unknown }).action ?? ''))) return fail();",
    ""),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R03-inspect-boolean
  M('R03-inspect-boolean', "packages/core/src/index.ts",
    "upstream_pages_remain: snapshot.nextUrl ? true : snapshot.queryEvidenceKind === 'unverified_continuation' || snapshot.nonContinuable || snapshot.queryOverlay?.nonContinuable || snapshot.sourceIncomplete ? null : false,",
    "upstream_pages_remain: Boolean(snapshot.nextUrl),"),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R03-gate-false-unknown
  M('R03-gate-false-unknown', "packages/core/src/contracts.ts",
    "    if (inspection && data.upstream_pages_remain === false && c.reasons.some(reason => ['CONTINUATION_QUERY_UNVERIFIED', 'NON_CONTINUABLE_UPSTREAM_LINK', 'SOURCE_REPORTED_INCOMPLETE'].includes(reason))) return fail();",
    ""),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R04-indexed-omissions
  M('R04-indexed-omissions', "packages/core/src/projection.ts",
    "const pointer = Array.isArray(source) ? path : `${path}/${key}`;",
    "const pointer = `${path}/${key}`;"),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R05-structural-subset
  M('R05-structural-subset', "packages/core/src/projection.ts",
    "const view = sanitizedProjection(record.resource, 'fhir');\n    const supplemented = { resource: view.resource, omitted: view.omitted };",
    "const view = sanitizedProjection(record.resource, 'fhir', fields ? [...fields] : undefined);\n    const supplemented = fields ? withSupplement(record.resource, view.resource) : { resource: view.resource, omitted: view.omitted };"),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R06-single-pop
  C('R06-single-pop', [
    {
      "file": "packages/core/src/index.ts",
      "find": "while (selected.length && env.budget.bytes_returned > env.budget.byte_limit - 128);",
      "replace": "while (false);"
    },
    {
      "file": "packages/core/src/index.ts",
      "find": "    while (selected.length && env.budget.bytes_returned > env.budget.byte_limit - 128) {\n      selected.pop(); position--; oversized = selected.length === 0; assemble();\n    }",
      "replace": ""
    }
  ]),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R07-shifted-tag
  M('R07-shifted-tag', "packages/core/src/projection.ts",
    "    if (!path && key === 'meta') return []; // Supplement owns meta omissions, including filtered tag arrays.\n",
    ""),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R08-spans-ceiling
  M('R08-spans-ceiling', "packages/core/src/contracts.ts",
    "!Number.isSafeInteger(m.spans) || m.spans < 1)",
    "!Number.isSafeInteger(m.spans) || m.spans < 1 || m.spans > 10000)"),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R09-no-rollback
  M('R09-no-rollback', "packages/core/src/index.ts",
    "      if (!completed) { restoreReservations(); restoreDiscovery(); this.reserved.delete(env as unknown as GatewayEnvelope); }",
    "      if (!completed) { restoreDiscovery(); this.reserved.delete(env as unknown as GatewayEnvelope); }"),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R10-no-reserve
  M('R10-no-reserve', "packages/core/src/index.ts",
    "while (rows.length && env.budget.bytes_returned > env.budget.byte_limit - 128) { rows.pop(); pack(); }\n    if (env.budget.bytes_returned > env.budget.byte_limit - 128 ||",
    "while (rows.length && env.budget.bytes_returned > env.budget.byte_limit) { rows.pop(); pack(); }\n    if (env.budget.bytes_returned > env.budget.byte_limit ||"),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — total-not-published
  M('total-not-published', "packages/core/src/index.ts",
    "...(snapshot.total !== undefined && snapshot.offset === 0 && !localMore && assembled.coverage.query_exhausted === true ? { value: snapshot.total } : {})",
    "...{}"),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R13-global-budget
  M('R13-global-budget', "packages/core/src/projection.ts",
    "function localReference(value: unknown): boolean {\n  let visitedBudget = 0;",
    "let visitedBudget = 0;\nfunction localReference(value: unknown): boolean {\n  visitedBudget = 0;"),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R-M02-structural-indices-offset
  M('R-M02-structural-indices-offset', "packages/core/src/index.ts",
    "structural_resource_indices: metas.flatMap((meta, i) => meta.interpretation === 'structural' ? [i] : []) };",
    "structural_resource_indices: metas.flatMap((meta, i) => meta.interpretation === 'structural' ? [i + snapshot.offset] : []) };"),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R-M03-no-retention-failure-reservation
  M('R-M03-no-retention-failure-reservation', "packages/core/src/index.ts",
    "env.result = result; env.warnings = warnings; env.budget.bytes_returned = Math.max(bytes, worst);",
    "env.result = result; env.warnings = warnings; env.budget.bytes_returned = bytes; void worst;"),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R-M04-bound-factor-1
  M('R-M04-bound-factor-1', "packages/core/src/index.ts",
    "pendingBound += 4 * Buffer.byteLength(",
    "pendingBound += 1 * Buffer.byteLength("),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R-M06-inspect-absolute-structural
  M('R-M06-inspect-absolute-structural', "packages/core/src/index.ts",
    "env.transform.structural_resource_indices = rows.flatMap((row, i) => row.interpretation === 'structural' ? [i] : []);",
    "env.transform.structural_resource_indices = rows.flatMap((row, i) => row.interpretation === 'structural' ? [i + input.offset] : []);"),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R-M18-ttl-renew-on-render
  M('R-M18-ttl-renew-on-render', "packages/core/src/index.ts",
    "expiresAt: original.expiresAt ?? Date.now()",
    "expiresAt: Date.now()"),
  // proposals/audit/s5-mutants/s5.4-fix-mutants.txt — R-M19-res-no-original-expiry
  M('R-M19-res-no-original-expiry', "packages/core/src/index.ts",
    "            originalExpiry: snapshot.expiresAt }])[0]!;",
    "            }])[0]!;"),
  // proposals/audit/s5-mutants/s5.4-mutants.txt — S54-M01-quantity-comparator
  C('S54-M01-quantity-comparator', [
    {
      "file": "packages/core/src/index.ts",
      "find": "      const view = projectSanitized(neutral, admission.format, admission.fields);\n      selected.push({ record, neutral, view }); position++;",
      "replace": "      const view = projectSanitized(neutral, admission.format, admission.fields);\n      const strip = (v: unknown): void => { if (!v || typeof v !== 'object') return; for (const key of Object.keys(v)) { if ([\"comparator\"].includes(key)) delete (v as Record<string, unknown>)[key]; else strip((v as Record<string, unknown>)[key]); } }; strip(view.resource);\n      selected.push({ record, neutral, view }); position++;"
    },
    {
      "file": "packages/core/src/index.ts",
      "find": "      const view = projectSanitized(neutral, admission.format, admission.fields);\n      if (view.meta.interpretation === 'structural') {",
      "replace": "      const view = projectSanitized(neutral, admission.format, admission.fields);\n      const strip = (v: unknown): void => { if (!v || typeof v !== 'object') return; for (const key of Object.keys(v)) { if ([\"comparator\"].includes(key)) delete (v as Record<string, unknown>)[key]; else strip((v as Record<string, unknown>)[key]); } }; strip(view.resource);\n      if (view.meta.interpretation === 'structural') {"
    }
  ]),
  // proposals/audit/s5-mutants/s5.4-mutants.txt — S54-M02-quantity-system
  C('S54-M02-quantity-system', [
    {
      "file": "packages/core/src/index.ts",
      "find": "      const view = projectSanitized(neutral, admission.format, admission.fields);\n      selected.push({ record, neutral, view }); position++;",
      "replace": "      const view = projectSanitized(neutral, admission.format, admission.fields);\n      const strip = (v: unknown): void => { if (!v || typeof v !== 'object') return; const node = v as Record<string, unknown>; if (Object.hasOwn(node, 'value') && Object.hasOwn(node, 'system')) delete node.system; Object.values(node).forEach(strip); }; strip(view.resource);\n      selected.push({ record, neutral, view }); position++;"
    },
    {
      "file": "packages/core/src/index.ts",
      "find": "      const view = projectSanitized(neutral, admission.format, admission.fields);\n      if (view.meta.interpretation === 'structural') {",
      "replace": "      const view = projectSanitized(neutral, admission.format, admission.fields);\n      const strip = (v: unknown): void => { if (!v || typeof v !== 'object') return; const node = v as Record<string, unknown>; if (Object.hasOwn(node, 'value') && Object.hasOwn(node, 'system')) delete node.system; Object.values(node).forEach(strip); }; strip(view.resource);\n      if (view.meta.interpretation === 'structural') {"
    }
  ]),
  // proposals/audit/s5-mutants/s5.4-mutants.txt — S54-M03-coding-version
  C('S54-M03-coding-version', [
    {
      "file": "packages/core/src/index.ts",
      "find": "      const view = projectSanitized(neutral, admission.format, admission.fields);\n      selected.push({ record, neutral, view }); position++;",
      "replace": "      const view = projectSanitized(neutral, admission.format, admission.fields);\n      const strip = (v: unknown): void => { if (!v || typeof v !== 'object') return; const node = v as Record<string, unknown>; if (Object.hasOwn(node, 'code') && Object.hasOwn(node, 'system')) delete node.version; Object.values(node).forEach(strip); }; strip(view.resource);\n      selected.push({ record, neutral, view }); position++;"
    },
    {
      "file": "packages/core/src/index.ts",
      "find": "      const view = projectSanitized(neutral, admission.format, admission.fields);\n      if (view.meta.interpretation === 'structural') {",
      "replace": "      const view = projectSanitized(neutral, admission.format, admission.fields);\n      const strip = (v: unknown): void => { if (!v || typeof v !== 'object') return; const node = v as Record<string, unknown>; if (Object.hasOwn(node, 'code') && Object.hasOwn(node, 'system')) delete node.version; Object.values(node).forEach(strip); }; strip(view.resource);\n      if (view.meta.interpretation === 'structural') {"
    }
  ]),
  // proposals/audit/s5-mutants/s5.4-mutants.txt — S54-M04-drop-modifiers
  C('S54-M04-drop-modifiers', [
    {
      "file": "packages/core/src/index.ts",
      "find": "      const view = projectSanitized(neutral, admission.format, admission.fields);\n      selected.push({ record, neutral, view }); position++;",
      "replace": "      const view = projectSanitized(neutral, admission.format, admission.fields);\n      const strip = (v: unknown): void => { if (!v || typeof v !== 'object') return; for (const key of Object.keys(v)) { if ([\"modifierExtension\", \"implicitRules\"].includes(key)) delete (v as Record<string, unknown>)[key]; else strip((v as Record<string, unknown>)[key]); } }; strip(view.resource);\n      selected.push({ record, neutral, view }); position++;"
    },
    {
      "file": "packages/core/src/index.ts",
      "find": "      const view = projectSanitized(neutral, admission.format, admission.fields);\n      if (view.meta.interpretation === 'structural') {",
      "replace": "      const view = projectSanitized(neutral, admission.format, admission.fields);\n      const strip = (v: unknown): void => { if (!v || typeof v !== 'object') return; for (const key of Object.keys(v)) { if ([\"modifierExtension\", \"implicitRules\"].includes(key)) delete (v as Record<string, unknown>)[key]; else strip((v as Record<string, unknown>)[key]); } }; strip(view.resource);\n      if (view.meta.interpretation === 'structural') {"
    }
  ]),
  // proposals/audit/s5-mutants/s5.4-mutants.txt — S54-M05-version-supplement
  M('S54-M05-version-supplement', "packages/core/src/projection.ts",
    "if (supplement.meta) result.meta = { ...existingMeta, ...supplement.meta };",
    "if (supplement.meta) { const { versionId: _version, ...withoutVersion } = supplement.meta; result.meta = { ...existingMeta, ...withoutVersion }; }"),
  // proposals/audit/s5-mutants/s5.4-mutants.txt — S54-M06-drop-omission-disclosure
  M('S54-M06-drop-omission-disclosure', "packages/core/src/index.ts",
    "omitted_fields: [...new Set(metas.flatMap(meta => meta.omitted_fields))].sort(),",
    "omitted_fields: [],"),
  // proposals/audit/s5-mutants/s5.4-mutants.txt — S54-M07-shift-indices-after-exclusion
  M('S54-M07-shift-indices-after-exclusion', "packages/core/src/index.ts",
    "const provenance = indexedProvenance(neutral);",
    "const provenance = indexedProvenance(neutral).map(entry => ({ ...entry, resource_index: entry.resource_index + (reasons.length ? 1 : 0) }));"),
  // proposals/audit/s5-mutants/s5.4-mutants.txt — S54-M08-provenance-before-exclusion
  M('S54-M08-provenance-before-exclusion', "packages/core/src/index.ts",
    "const provenance = indexedProvenance(neutral);",
    "const provenance = indexedProvenance(selected.length ? original.records.slice(original.offset, original.offset + limit).map(record => this.projectionRecordV2(record)) : neutral);"),
  // proposals/audit/s5-mutants/s5.4-mutants.txt — S54-M09-spans-any-reason
  M('S54-M09-spans-any-reason', "packages/core/src/contracts.ts",
    "m.reason !== 'PROTECTED_LINK_IN_TEXT' || typeof m.spans",
    "typeof m.spans"),
  // proposals/audit/s5-mutants/s5.4-r2-fix-mutants.txt — RV-02-pop-no-decrement-outer
  M('RV-02-pop-no-decrement-outer', "packages/core/src/index.ts",
    "\n      selected.pop(); position--; oversized = selected.length === 0; assemble();\n    }",
    "\n      selected.pop(); oversized = selected.length === 0; assemble();\n    }"),
  // proposals/audit/s5-mutants/s5.4-r2-fix-mutants.txt — RV-03-oversized-on-any-pop
  M('RV-03-oversized-on-any-pop', "packages/core/src/index.ts",
    "do { selected.pop(); position--; oversized = selected.length === 0; assemble(); }",
    "do { selected.pop(); position--; oversized = true; assemble(); }"),
  // proposals/audit/s5-mutants/s5.4-r2-fix-mutants.txt — RV-05-total-on-continued-page
  M('RV-05-total-on-continued-page', "packages/core/src/index.ts",
    "snapshot.total !== undefined && snapshot.offset === 0 && !localMore",
    "snapshot.total !== undefined && !localMore"),
  // proposals/audit/s5-mutants/s5.4-r2-fix-mutants.txt — RV-07-restore-skipped-for-gateway-faults
  M('RV-07-restore-skipped-for-gateway-faults', "packages/core/src/index.ts",
    "    } finally {\n      if (!completed) { restoreReservations(); restoreDiscovery(); this.reserved.delete(env as unknown as GatewayEnvelope); }\n    }",
    "    } catch (error) {\n      if (!(error instanceof GatewayFault)) { restoreReservations(); restoreDiscovery(); this.reserved.delete(env as unknown as GatewayEnvelope); }\n      throw error;\n    } finally { void completed; }"),
  // proposals/audit/s5-mutants/s5.4-r2-fix-mutants.txt — RV-08-structural-false-selection-omissions
  M('RV-08-structural-false-selection-omissions', "packages/core/src/projection.ts",
    "const supplemented = { resource: view.resource, omitted: view.omitted };",
    "const supplemented = { resource: view.resource, omitted: [...view.omitted, ...(fields ? withSupplement(record.resource, sanitizedProjection(record.resource, 'fhir', [...fields]).resource).omitted : [])] };"),
  // proposals/audit/s5-mutants/s5.4-r2-fix-mutants.txt — RV-10-reservation-keeps-fhir_result-action
  M('RV-10-reservation-keeps-fhir_result-action', "packages/core/src/index.ts",
    "if (manifest) data.manifest = { ...manifest, action: recoveryAction(false) };",
    "void notRetainedAction;"),
  // proposals/audit/s5-mutants/s5.4-r2-fix-mutants.txt — RV-11-retained-zero-fit-nonadvancing-offset
  M('RV-11-retained-zero-fit-nonadvancing-offset', "packages/core/src/index.ts",
    "...(retained && localMore && selected.length ? { next_offset: position } : {})",
    "...(retained && localMore ? { next_offset: position } : {})"),
  // proposals/audit/s5-mutants/s5.4-r2-fix-mutants.txt — RV-12-retained-zero-fit-has-more
  M('RV-12-retained-zero-fit-has-more', "packages/core/src/index.ts",
    "((localMore && (!retained || selected.length > 0))",
    "((localMore)"),
  // proposals/audit/s5-mutants/s5.4-r2-fix-mutants.txt — N02-structural-selection-advice
  M('N02-structural-selection-advice', "packages/core/src/index.ts",
    "if (!recovery?.structural) return retained",
    "if (!recovery?.structural || oversized) return retained"),
  // proposals/audit/s5-mutants/s5.4-r2-fix-mutants.txt — N02-body-only-measurement
  M('N02-body-only-measurement', "packages/core/src/index.ts",
    "const needed = env.budget.bytes_returned + 128;",
    "const needed = Buffer.byteLength(stringifyFhir(view.resource)) + 128;"),
  // proposals/audit/s5-mutants/s5.4-r2-fix-mutants.txt — N03-unrecoverable-still-continuable
  M('N03-unrecoverable-still-continuable', "packages/core/src/index.ts",
    "unrecoverable: needed > this.maxBytes",
    "unrecoverable: false"),
  // proposals/audit/s5-mutants/s5.4-r2-fix-mutants.txt — N03-read-null-control
  M('N03-read-null-control', "packages/core/src/index.ts",
    "has_more: more ? true : unknown ? null : false, returned_matches: resources.length, returned_includes: 0,",
    "has_more: read && oversized ? null : more ? true : unknown ? null : false, returned_matches: resources.length, returned_includes: 0,"),
  // proposals/audit/s5-mutants/s5.4-r2-fix-mutants.txt — N04-clinical-only-rollback
  M('N04-clinical-only-rollback', "packages/core/src/index.ts",
    "if (!completed) { restoreReservations(); restoreDiscovery(); this.reserved.delete(env as unknown as GatewayEnvelope); }",
    "if (!completed) { restoreReservations(); this.reserved.delete(env as unknown as GatewayEnvelope); }"),
  // proposals/audit/s5-mutants/s5.4-r2-fix-mutants.txt — N04-nested-generation-bump
  M('N04-nested-generation-bump', "packages/core/src/store.ts",
    "      this.reset();\n      for (const [key, value] of blobs)",
    "      this.clear();\n      for (const [key, value] of blobs)"),
  // proposals/audit/s5-mutants/s5.4-r2-fix-mutants.txt — N05-ignore-overlay
  M('N05-ignore-overlay', "packages/core/src/index.ts",
    "Boolean(recovery?.unrecoverable || snapshot.nonContinuable || snapshot.queryOverlay?.nonContinuable || snapshot.sourceIncomplete || snapshot.queryEvidenceKind",
    "Boolean(recovery?.unrecoverable || snapshot.nonContinuable || snapshot.sourceIncomplete || snapshot.queryEvidenceKind"),
  // proposals/audit/s5-mutants/s5.4-r2-fix-mutants.txt — N08-redundant-assembly
  M('N08-redundant-assembly', "packages/core/src/index.ts",
    "if (!packed) assemble();",
    "assemble();"),
  // proposals/audit/s5-mutants/s5.5-fix-mutants.txt — R01-standing-reason-dropped
  M('R01-standing-reason-dropped', "packages/core/src/index.ts",
    "        env.coverage = metadataCoverage(more);",
    "        env.coverage = metadataCoverage(more);\n        env.coverage.reasons = env.coverage.reasons.filter(r => r !== 'DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION');"),
  // proposals/audit/s5-mutants/s5.5-fix-mutants.txt — R01-invented-reason-restored
  M('R01-invented-reason-restored', "packages/core/src/index.ts",
    "        env.coverage = metadataCoverage(more);",
    "        env.coverage = metadataCoverage(more);\n        env.coverage.reasons = env.coverage.reasons.map(r => r === 'MORE_PAGES' ? 'MORE_METADATA_ROWS' : r);"),
  // proposals/audit/s5-mutants/s5.5-fix-mutants.txt — R03-post-describe-check
  M('R03-post-describe-check', "packages/core/src/index.ts",
    "          const finalize = prepare?.(resourceType, metadata);\n          this.throwIfCancelled(budget);",
    "          const finalize = prepare?.(resourceType, metadata);"),
  // proposals/audit/s5-mutants/s5.5-fix-mutants.txt — R04-pre-describe-check
  M('R04-pre-describe-check', "packages/core/src/index.ts",
    "          this.throwIfCancelled(budget);\n          const resourceType =",
    "          const resourceType ="),
  // proposals/audit/s5-mutants/s5.5-fix-mutants.txt — R04-TTL-floor
  M('R04-TTL-floor', "packages/core/src/index.ts",
    "this.metadataExpiresAt - Date.now() < Math.min(60000, ttl / 2)",
    "false"),
  // proposals/audit/s5-mutants/s5.5-fix-mutants.txt — R04-first-expired-put
  M('R04-first-expired-put', "packages/core/src/index.ts",
    "          if (!input.cursor && error instanceof GatewayFault && error.code === 'DISCOVERY_EXPIRED') {\n            throw new GatewayFault('CONNECTION_REQUIRED', 'The source connection changed during discovery; repeat it after reconnecting.', true);\n          }",
    ""),
  // proposals/audit/s5-mutants/s5.5-fix-mutants.txt — R05-clear-generation
  M('R05-clear-generation', "packages/core/src/store.ts",
    "      if (generation !== this.clearGeneration) return;",
    "      void generation;"),
  // proposals/audit/s5-mutants/s5.5-fix-mutants.txt — R06-definitions-alias
  M('R06-definitions-alias', "packages/core/src/index.ts",
    "definitions: { ...SEARCH_PARAMETER_DEFINITIONS }",
    "definitions: SEARCH_PARAMETER_DEFINITIONS"),
  // proposals/audit/s5-mutants/s5.5-fix-mutants.txt — R06-sections-alias
  M('R06-sections-alias', "packages/core/src/index.ts",
    "clinical_sections: [...workflow.clinical_sections],",
    "clinical_sections: workflow.clinical_sections,"),
  // proposals/audit/s5-mutants/s5.5-fix-mutants.txt — R06-schema-alias
  M('R06-schema-alias', "packages/core/src/index.ts",
    "      const page = JSON.parse(JSON.stringify(schemaPage(input.resource_type, input.path, input.offset, input.limit))) as ReturnType<typeof schemaPage>;",
    "      const page = schemaPage(input.resource_type, input.path, input.offset, input.limit);"),
  // proposals/audit/s5-mutants/s5.5-fix-mutants.txt — R07-placeholder-minus-one
  M('R07-placeholder-minus-one', "packages/core/src/index.ts",
    "env.data = makeData(more ? `cur_${'x'.repeat(32)}` : undefined);",
    "env.data = makeData(more ? `cur_${'x'.repeat(31)}` : undefined);"),
  // proposals/audit/s5-mutants/s5.5-fix-mutants.txt — R10-observer-inside-try
  M('R10-observer-inside-try', "packages/auth/src/client-credentials.ts",
    "    this.onRequest?.();\n    try {\n      response = await this.fetchFn",
    "    try {\n      this.onRequest?.();\n      response = await this.fetchFn"),
  // proposals/audit/s5-mutants/s5.5-mutants.txt — namespace-check-removed
  M('namespace-check-removed', "packages/core/src/discovery.ts",
    "    if (!cursor.startsWith('cur_')) throw expired();",
    ""),
  // proposals/audit/s5-mutants/s5.5-mutants.txt — topic-check-removed
  M('topic-check-removed', "packages/core/src/discovery.ts",
    "found.value.topic !== topic || !bindingsEqual(found.value.binding, binding)",
    "!bindingsEqual(found.value.binding, binding)"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — metadata-handle-rollback-removed
  M('metadata-handle-rollback-removed', "packages/core/src/index.ts",
    "          restoreClinical(); restoreDiscovery();\n          if (!input.cursor",
    "          restoreClinical();\n          if (!input.cursor"),
  // proposals/audit/s5-mutants/s5.5-mutants.txt — discovery-cursor-cross-store-accepted
  M('discovery-cursor-cross-store-accepted', "packages/core/src/store.ts",
    "    const blob = item ? this.blobs.get(item.key) : undefined;",
    "    const blob = item ? this.blobs.get(item.key) : undefined;\n    if ((!item || !blob) && this.options.role === 'clinical' && this.options.ledger) {\n      for (const other of (this.options.ledger as unknown as { all: ResultStore<T>[] }).all) {\n        if (other !== this) { try { return other.get(handle); } catch { /* try other authority */ } }\n      }\n    }"),
  // proposals/audit/s5-mutants/s5.5-mutants.txt — metadata-issues-res
  M('metadata-issues-res', "packages/core/src/discovery.ts",
    "export function freezeSupportSnapshot(\n  store: ResultStore<DiscoverySnapshotValue>,\n  value: Omit<SupportSnapshotValue, 'offset'>,\n  originalExpiry?: number,\n): { handle: string; expires_at: string } {\n  const { offset, ...snapshot } = value as DiscoverySnapshotValue;\n  return store.put('cur', immutableSnapshot(snapshot), originalExpiry, { offset });\n}",
    "export function freezeSupportSnapshot(\n  store: ResultStore<DiscoverySnapshotValue>,\n  value: Omit<SupportSnapshotValue, 'offset'>,\n  originalExpiry?: number,\n): { handle: string; expires_at: string } {\n  const { offset, ...snapshot } = value as DiscoverySnapshotValue;\n  return store.put('res', immutableSnapshot(snapshot), originalExpiry, { offset });\n}"),
  // proposals/audit/s5-mutants/s5.5-mutants.txt — continuation-renews-ttl
  M('continuation-renews-ttl', "packages/core/src/index.ts",
    "freezeSupportSnapshot(this.discoveryStore, next, Date.parse(next.expiresAt))",
    "freezeSupportSnapshot(this.discoveryStore, next)"),
  // proposals/audit/s5-mutants/s5.5-mutants.txt — failed-refresh-installs-state
  M('failed-refresh-installs-state', "packages/core/src/index.ts",
    "const metadata = await this.transport.get(this.transport.url('metadata'), stats, {});",
    "const metadata = await this.transport.get(this.transport.url('metadata'), stats, {}).catch(error => { this.capabilities = new Map(); this.capabilityRevision = 'failed-refresh'; this.store.clear(); this.discoveryStore.clear(); throw error; });"),
  // proposals/audit/s5-mutants/s5.5-mutants.txt — auth-counter-increment-removed
  M('auth-counter-increment-removed', "packages/core/src/index.ts",
    "if (work) work.authCalls++;",
    "void work;"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R-emergency-via-normal-renderer
  C('R-emergency-via-normal-renderer', [
    {
      "file": "packages/core/src/index.ts",
      "find": "    const resultFor = () => {",
      "replace": "    const resultFor = () => this.sdkResultV2(env, delivery);\n    const unusedResultFor = () => {"
    },
    {
      "file": "packages/core/src/index.ts",
      "find": "deliveryProfile: 'full-text-v1' as const,",
      "replace": "deliveryProfile: env.transform.delivery_profile,"
    }
  ]),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R-full-evidence-required-false
  M('R-full-evidence-required-false', "packages/core/src/index.ts",
    "fullEvidenceRequired: !previousEvidence || !isDeepStrictEqual(previousEvidence, evidence) } }",
    "fullEvidenceRequired: false } }"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R-chain-delivered-zero
  M('R-chain-delivered-zero', "packages/core/src/index.ts",
    "chainDeliveredCount: snapshot?.queryOverlay?.deliveredCount ?? 0,",
    "chainDeliveredCount: 0,"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R-no-candidate-json-guard
  M('R-no-candidate-json-guard', "packages/core/src/index.ts",
    "          assertDeliveryJson(candidate);\n",
    ""),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R-capabilities-budget-dropped
  M('R-capabilities-budget-dropped', "packages/core/src/index.ts",
    "}, budget, stats);",
    "}, {}, stats);"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R-capabilities-stats-not-shared
  M('R-capabilities-stats-not-shared', "packages/core/src/index.ts",
    "}, budget, stats);",
    "}, budget);"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R-admission-not-frozen
  M('R-admission-not-frozen', "packages/core/src/index.ts",
    "admission = freezeDeliveryState(this.admitV2(tool, raw));",
    "admission = this.admitV2(tool, raw);"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R-page-previous-is-current
  M('R-page-previous-is-current', "packages/core/src/index.ts",
    "render(this.store.get(cursor).value, this.currentQueryEvidence(value))",
    "render(this.store.get(cursor).value, this.currentQueryEvidence(this.store.get(cursor).value))"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R-trusted-sort-from-wire
  M('R-trusted-sort-from-wire', "packages/core/src/index.ts",
    "return freezeDeliveryState({ ...invocation, era: delivery.era,",
    "return freezeDeliveryState({ ...invocation, ...(invocation.query && envelope.coverage.sort?.requested ? { query: { ...invocation.query, sort: [...envelope.coverage.sort.requested] } } : {}), era: delivery.era,"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R-trusted-resource-type-from-wire
  M('R-trusted-resource-type-from-wire', "packages/core/src/index.ts",
    "return freezeDeliveryState({ ...invocation, era: delivery.era,",
    "return freezeDeliveryState({ ...invocation, ...(invocation.readTarget && Array.isArray((envelope.data as any).resources) && (envelope.data as any).resources[0] ? { readTarget: { resourceType: (envelope.data as any).resources[0].resourceType, id: (envelope.data as any).resources[0].id } } : {}), era: delivery.era,"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R01-shape-detection-restored
  M('R01-shape-detection-restored', "packages/core/src/delivery.ts",
    "  if (tool === 'fhir_capabilities') return { text: `delivery_profile: \"full-text-v1\"\\n${jsonLine(envelope)}`, fellBack: true, deliveredProfile: 'full-text-v1' };\n",
    ""),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R01-v2-trusted-tool-dropped
  M('R01-v2-trusted-tool-dropped', "packages/core/src/index.ts",
    "const first = evidenceRender(envelope as unknown as GatewayEnvelope, delivery.tool);",
    "const first = evidenceRender(envelope as unknown as GatewayEnvelope);"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R01-direct-metadata-tool-dropped
  M('R01-direct-metadata-tool-dropped', "packages/core/src/index.ts",
    "    const metadataDelivery = { ...delivery, tool: 'fhir_capabilities' as const };",
    "    const metadataDelivery = delivery;"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R05-runtime-emergency-normal-renderer
  M('R05-runtime-emergency-normal-renderer', "packages/core/src/index.ts",
    "    const resultFor = () => {",
    "    const resultFor = () => {\n      if (this.candidateWorkV2.getStore()) return this.sdkResultV2(env, delivery);"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R05-runtime-emergency-normal-capture
  M('R05-runtime-emergency-normal-capture', "packages/core/src/index.ts",
    "    const capture = freezeDeliveryState({ ...invocation, era: delivery.era, deliveryProfile: 'full-text-v1' as const,",
    "    if (this.candidateWorkV2.getStore()) this.captureV2(env, delivery, invocation);\n    const capture = freezeDeliveryState({ ...invocation, era: delivery.era, deliveryProfile: 'full-text-v1' as const,"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R05-strict-emergency-removed-runtime
  M('R05-strict-emergency-removed-runtime', "packages/core/src/index.ts",
    "          if (!validateDeliverable02(tool, toWireValue(env), capture).ok) throw new GatewayFault('INTERNAL_ERROR', 'Emergency validation failed.');",
    "          // diagnostic: runtime emergency gate removed"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R06-read-clinical-count-removed
  M('R06-read-clinical-count-removed', "packages/core/src/index.ts",
    "      const work = this.candidateWorkV2.getStore(); if (work) work.clinicalCalls++;\n",
    ""),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R06-search-page-clinical-count-removed
  M('R06-search-page-clinical-count-removed', "packages/core/src/index.ts",
    "    const work = this.candidateWorkV2.getStore(); if (work) work.clinicalCalls++;\n    const bundle =",
    "    const bundle ="),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R06-constant-clinical-zero
  M('R06-constant-clinical-zero', "packages/core/src/index.ts",
    "clinicalCalls: work.clinicalCalls }, admission,",
    "clinicalCalls: 0 }, admission,"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R07-unknown-entry-check-removed
  C('R07-unknown-entry-check-removed', [
    {
      "file": "packages/core/src/index.ts",
      "find": "  private admitV2<T extends ToolName>(tool: T, unknownInput: unknown): Admission02<T> {\n    if (!TOOL_NAMES.includes(tool)) throw new GatewayFault('UNKNOWN_TOOL', 'Tool is not implemented in this prototype.');\n    const admission = admitArguments(unknownInput);",
      "replace": "  private admitV2<T extends ToolName>(tool: T, unknownInput: unknown): Admission02<T> {\n\n    const admission = admitArguments(unknownInput);"
    },
    {
      "file": "packages/core/src/index.ts",
      "find": "  async execute(tool: ToolName, raw: unknown, options: ExecuteOptions = {}): Promise<GatewayEnvelope02> {\n    if (!TOOL_NAMES.includes(tool)) throw new GatewayFault('UNKNOWN_TOOL', 'Tool is not implemented in this prototype.');\n    const start = Date.now();",
      "replace": "  async execute(tool: ToolName, raw: unknown, options: ExecuteOptions = {}): Promise<GatewayEnvelope02> {\n\n    const start = Date.now();"
    }
  ]),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R08-topic-reasons-open
  M('R08-topic-reasons-open', "packages/core/src/contracts.ts",
    "      const metadataReasons = topic === 'schema' ? [schemaCaveat, 'MORE_DEFINITION_ELEMENTS']\n        : topic === 'server' ? [standing, 'CAPABILITY_SUMMARY_LIMIT']\n        : topic === 'search_parameter' || topic === 'support' ? [standing, 'MORE_PAGES'] : [standing];\n",
    "      const metadataReasons = [standing, schemaCaveat, 'MORE_PAGES', 'MORE_DEFINITION_ELEMENTS', 'CAPABILITY_SUMMARY_LIMIT'];\n"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R08-schema-caveat-not-required
  M('R08-schema-caveat-not-required', "packages/core/src/contracts.ts",
    "      if (!c.reasons.includes(topic === 'schema' ? schemaCaveat : standing)) return fail();",
    "      if (topic !== 'schema' && !c.reasons.includes(standing)) return fail();"),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R11-N05-removed
  M('R11-N05-removed', "packages/core/src/contracts.ts",
    "    if ((tool === 'fhir_search' || tool === 'fhir_page') && page?.has_more === false && c.reasons.includes('NON_CONTINUABLE_UPSTREAM_LINK')) return fail();\n",
    ""),
  // proposals/audit/s5-mutants/s5.6-fix-mutants.txt — R02-elapsed-reserve-removed
  M('R02-elapsed-reserve-removed', "packages/core/src/index.ts",
    "    const fit = () => {\n      // Fit against the largest safe elapsed integer, including both SDK copies.\n      // finish writes the actual elapsed value only after metadata packing.\n      const elapsed = env.budget.elapsed_ms;\n      try { env.budget.elapsed_ms = Number.MAX_SAFE_INTEGER; this.bytesV2(env, metadataDelivery); return env.budget.bytes_returned <= env.budget.byte_limit; }\n      finally { env.budget.elapsed_ms = elapsed; this.bytesV2(env, metadataDelivery); }\n    };\n",
    "    const fit = () => { this.bytesV2(env, metadataDelivery); return env.budget.bytes_returned <= env.budget.byte_limit; };\n"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — skip-final-measurement
  M('skip-final-measurement', "packages/core/src/index.ts",
    "const bytes = Buffer.byteLength(JSON.stringify(this.sdkResultV2(envelope, delivery)));",
    "const bytes = envelope.budget.bytes_returned;"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — underreport-bytes
  M('underreport-bytes', "packages/core/src/index.ts",
    "const bytes = Buffer.byteLength(JSON.stringify(this.sdkResultV2(envelope, delivery)));",
    "const bytes = Buffer.byteLength(JSON.stringify(this.sdkResultV2(envelope, delivery))) - 1;"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — upgrade-delivery
  M('upgrade-delivery', "packages/core/src/index.ts",
    "profile: deliveryProfileForEra(this.config.delivery, era, this.testOptions?.testDeliveryRegistryOverride), serverIdentity: SERVER_IDENTITY",
    "profile: 'structured-evidence-v1', serverIdentity: SERVER_IDENTITY"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — stale-text
  M('stale-text', "packages/core/src/index.ts",
    "    result.content[0]!.text = text;",
    "    result.content[0]!.text = 'stale';"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — commit-pending-before-gate
  M('commit-pending-before-gate', "packages/core/src/index.ts",
    "        let committed = false;",
    "        let committed = true;"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — final-bytes-recheck-removed
  M('final-bytes-recheck-removed', "packages/core/src/contracts.ts",
    "    if (measured !== env.budget.bytes_returned || measured > env.budget.byte_limit || measured > context.effectiveByteLimit! || env.budget.byte_limit > context.effectiveByteLimit!) return fail('INVALID_FINAL_BYTES');",
    "    // diagnostic: final byte guard removed"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — context-handle
  M('context-handle', "packages/core/src/index.ts",
    "        if (input.context_handle !== undefined && input.context_handle !== this.contextId) throw new GatewayFault(tool === 'fhir_capabilities' && input.cursor ? 'DISCOVERY_EXPIRED' : 'CONTEXT_REQUIRED', 'Context does not match the trusted configured patient.');",
    "        // diagnostic: trusted context admission removed"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — fault-warnings-restored
  M('fault-warnings-restored', "packages/core/src/index.ts",
    "    envelope.warnings = [];\n    envelope.error = { code,",
    "    envelope.error = { code,"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — expiry-repair-dropped
  M('expiry-repair-dropped', "packages/core/src/index.ts",
    "            if (repair) env.error!.repair = repair;",
    "            // diagnostic: fault repair removed"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — continuation-type-from-input
  M('continuation-type-from-input', "packages/core/src/index.ts",
    "const invocation = freezeDeliveryState({ ...this.invocationV2(admission, allowance.allowance), resourceType, metadata });",
    "const invocation = freezeDeliveryState({ ...this.invocationV2(admission, allowance.allowance), resourceType: (admission?.input as DispatchInput).resource_type, metadata });"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — snapshot-recaptured
  M('snapshot-recaptured', "packages/core/src/index.ts",
    "          const capture = this.captureV2(env, delivery, invocation);\n          const candidate = cloneFhirValue(env);\n          this.testOptions?.testEnvelopeCorruptor?.(candidate as unknown as GatewayEnvelope, phase);\n          assertDeliveryJson(candidate);",
    "          let capture = this.captureV2(env, delivery, invocation);\n          const candidate = cloneFhirValue(env);\n          this.testOptions?.testEnvelopeCorruptor?.(candidate as unknown as GatewayEnvelope, phase);\n          assertDeliveryJson(candidate);\n          capture = this.captureV2(candidate, delivery, invocation);"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — trusted-query-from-wire
  M('trusted-query-from-wire', "packages/core/src/index.ts",
    "return freezeDeliveryState({ ...invocation, era: delivery.era,",
    "return freezeDeliveryState({ ...invocation, ...(invocation.query && envelope.coverage.constraints ? { query: { ...invocation.query, orderedPairs: envelope.coverage.constraints.map(({ name, value }) => ({ name, value })) } } : {}), era: delivery.era,"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — rollback-discovery-removed
  M('rollback-discovery-removed', "packages/core/src/index.ts",
    "if (!committed) { restoreClinical(); restoreDiscovery(); }",
    "if (!committed) { restoreClinical(); }"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — fallback-label-after-fit
  M('fallback-label-after-fit', "packages/core/src/index.ts",
    "      envelope.transform.delivery_profile = first.deliveredProfile;",
    "      envelope.transform.delivery_profile = delivery.profile;"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — metadata-standing-reason-removed
  M('metadata-standing-reason-removed', "packages/core/src/contracts.ts",
    "      if (!c.reasons.includes(topic === 'schema' ? schemaCaveat : standing)) return fail();",
    "      if (topic === 'schema' && !c.reasons.includes(schemaCaveat)) return fail();"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — metadata-open-reasons
  M('metadata-open-reasons', "packages/core/src/contracts.ts",
    "      if (c.reasons.some(reason => !metadataReasons.includes(reason))) return fail();",
    "      // diagnostic: closed reason catalogue removed"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — identity-ignored
  M('identity-ignored', "packages/core/src/index.ts",
    "_meta: { 'io.modelcontextprotocol/serverInfo': delivery.serverIdentity ?? SERVER_IDENTITY } } : {}) };\n  }\n\n  private bytesV2",
    "_meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_IDENTITY.name, version: '0.2.0-alpha.1' } } } : {}) };\n  }\n\n  private bytesV2"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — admission-fault-unfitted
  M('admission-fault-unfitted', "packages/core/src/index.ts",
    "        const invocation = this.invocationV2(admission, allowance.allowance);\n        try {",
    "        if (!admission) throw fault;\n        const invocation = this.invocationV2(admission, allowance.allowance);\n        try {"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — result-expiry-repair-dropped
  M('result-expiry-repair-dropped', "packages/core/src/repairs.ts",
    "  const template = REPAIR_TABLE[code as FaultCode];",
    "  if (code === 'RESULT_EXPIRED') return undefined;\n  const template = REPAIR_TABLE[code as FaultCode];"),
  // proposals/audit/s5-mutants/s5.6-mutants.txt — g16-refusal-message-drift
  M('g16-refusal-message-drift', "packages/core/src/index.ts",
    "    env.error!.safe_message = kind === 'unsupported_modifier' && work.upstreamCalls !== 0 ? MODIFIER_NO_CLINICAL_MESSAGE : REFUSAL_MESSAGES[kind]!;",
    "    env.error!.safe_message = 'Request failed.';"),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — H12-explicit-meta-loses-security-system
  M('H12-explicit-meta-loses-security-system', "packages/core/src/projection.ts",
    "  if (supplement.meta) result.meta = { ...existingMeta, ...supplement.meta };",
    "  if (supplement.meta) { result.meta = { ...existingMeta, ...supplement.meta }; if (existingMeta.security) (result.meta as Record<string, unknown>).security = (existingMeta.security as Record<string, unknown>[]).map(({ system: _system, ...coding }) => coding); }"),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — meta-nested-subsetted-lost
  M('meta-nested-subsetted-lost', "packages/core/src/projection.ts",
    "? cloneFhirValue(tag) : cloneFhirValue((existingMeta.tag as unknown[])[index])",
    "? cloneFhirValue((existingMeta.tag as unknown[])[index]) : cloneFhirValue((existingMeta.tag as unknown[])[index])"),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — meta-residual-omissions-lost
  M('meta-residual-omissions-lost', "packages/core/src/projection.ts",
    "omitted: [...omitted, ...metaOmitted]",
    "omitted: [...omitted]"),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — update-shared-ledger-bypassed
  M('update-shared-ledger-bypassed', "packages/core/src/store.ts",
    "      if (this.options.ledger && !this.options.ledger.makeRoom(additional())) throw this.retentionFault();",
    "      void this.options.ledger;"),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — update-freed-byte-credit-lost
  M('update-freed-byte-credit-lost', "packages/core/src/store.ts",
    "      return delta - freed;",
    "      return delta;"),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — update-failure-does-not-restore
  M('update-failure-does-not-restore', "packages/core/src/store.ts",
    "    } catch (error) { restore(); throw error; }",
    "    } catch (error) { throw error; }"),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — full-trusted-proof-check-removed
  M('full-trusted-proof-check-removed', "packages/core/src/contracts.ts",
    "    if (c.constraints && (!q.constraintProof || q.constraintProof.length !== q.orderedPairs.length)) return fail('VALIDATION_CONTEXT_REQUIRED');\n    if (c.constraints && c.constraints.some((p, index) => p.execution !== q.constraintProof![index]!.execution\n      || p.evidence_ref !== q.constraintProof![index]!.evidence_ref)) return fail();\n    if (c.state === 'complete_for_query' && (!q.constraintProof || q.constraintProof.length !== q.orderedPairs.length\n      || q.constraintProof.some(p => p.execution === 'unknown' || (p.execution === 'tested_adapter' && !p.evidence_ref)))) return fail();\n",
    ""),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — H11-stale-trusted-proof
  M('H11-stale-trusted-proof', "packages/core/src/index.ts",
    "constraintProof: evidence.constraints.map(({ execution, evidence_ref })",
    "constraintProof: original!.constraints.map(({ execution, evidence_ref })"),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — retained-pagination-uses-clinical-cursor
  M('retained-pagination-uses-clinical-cursor', "packages/evals/src/runner.ts",
    "  if (envelope.pagination) {",
    "  if (envelope.pagination) {\n    if ((envelope.pagination.has_more === true) !== Boolean(envelope.pagination.next_cursor)) add('pagination_invalid', 'retained control incorrectly requires clinical cursor');"),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — local-refusal-identity-lost
  M('local-refusal-identity-lost', "packages/auth/src/client-credentials.ts",
    "    if (error instanceof LocalWorkRefusal) return error;",
    ""),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — R1-wipe-epoch-and-stores
  M('R1-wipe-epoch-and-stores', "packages/core/src/index.ts",
    "    if (error instanceof LocalWorkRefusal) return new GatewayFault('UPSTREAM_LIMIT', error.message);",
    "    if (error instanceof LocalWorkRefusal) { if (this.credentials!.invalidate()) { this.authEpoch++; this.invalidateState(); } return new GatewayFault('UPSTREAM_LIMIT', error.message); }"),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — private-profile-counted-as-public-pass
  M('private-profile-counted-as-public-pass', "packages/evals/src/runner.ts",
    "status: 'private_profile_control' as const, private_profile_verdict:",
    "status: verdict.status, private_profile_verdict:"),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — repair-reviewed-base-lost
  M('repair-reviewed-base-lost', "packages/core/src/index.ts",
    "return error instanceof GatewayFault && error.code === code && this.reviewedNamesV2().parameter(input.resource_type, base) ? base : undefined;",
    "return error instanceof GatewayFault && error.code === code && this.reviewedNamesV2().parameter(input.resource_type, base) ? undefined : undefined;"),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — foreign-patient-task-input-replaced
  M('foreign-patient-task-input-replaced', "packages/evals/data/m3b-query-tasks.json",
    "\"name\": \"link\",\n                \"value\": \"eval-patient-b\"",
    "\"name\": \"link\",\n                \"value\": \"eval-patient-a\""),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — R12-pending-list-extended
  M('R12-pending-list-extended', "packages/evals/src/runner.ts",
    "  'query-ignore-date-upper': 'S6 must qualify upper-date contradiction detection.',",
    "  'query-ignore-date-upper': 'S6 must qualify upper-date contradiction detection.',\n  'patient-link-bare-id-denied': 'S6 must qualify selector proof.',"),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — pending-hides-independent-checks
  M('pending-hides-independent-checks', "packages/evals/src/runner.ts",
    "    if (pendingProfile && PROFILE_DEPENDENT_CHECKS[task.id]?.includes(check.id) && deepEqual(check, frozenProofCheck)) {",
    "    if (pendingProfile) {"),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — pending-tasks-execute-no-calls
  M('pending-tasks-execute-no-calls', "packages/evals/src/runner.ts",
    "for (const [index, step] of task.steps.entries()) {",
    "for (const [index, step] of (pendingProfile ? [] : task.steps.entries())) {"),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — comparison-omits-reviewed-serving-difference
  M('comparison-omits-reviewed-serving-difference', "docs/evidence/s5-eval-comparison.md",
    "| S57-R06(a): Drained gateway-confined searches change `unknown` → `complete_for_query`, including unfiltered, `_sort`-only, compact and Patient queries. | PLAN §6; M3b §7 exact identity/subject linkage and exhausted, proved material membership; root review decision S57-R06. | Original `serving-diff.json` rows 12/17/21/23. Sort proof remains separate. Declared-only shared queries retain the separately decided unknown outcome. |\n",
    ""),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — R13-returned-matches-invariant-removed
  M('R13-returned-matches-invariant-removed', "packages/core/src/contracts.ts",
    "      if (!page || page.returned_matches !== count || page.returned_includes !== 0) return fail();",
    "      if (!page || page.returned_includes !== 0) return fail();"),
  // proposals/audit/s5-mutants/s5.7-fix-mutants.txt — pre-admission-metadata-request
  M('pre-admission-metadata-request', "packages/core/src/index.ts",
    "        admission = freezeDeliveryState(this.admitV2(tool, raw));",
    "        await this.transport.get(this.transport.url('metadata'), stats, budget);\n        admission = freezeDeliveryState(this.admitV2(tool, raw));", {"suites": ["unit", "isolation"]}),
  // proposals/audit/s5-mutants/s5.7b-mutants.txt — response-index-borrowing
  M('response-index-borrowing', "packages/evals/src/evidence-oracle.ts",
    "return call ? judge([call]) :",
    "return call ? judge(own) :"),
  // proposals/audit/s5-mutants/s5.7b-mutants.txt — rounded-7.0
  M('rounded-7.0', "packages/core/src/decimal.ts",
    "return rawJsonHost.rawJSON(current.lexeme);",
    "return rawJsonHost.rawJSON(JSON.stringify(current.numberValue()));"),
  // proposals/audit/s5-mutants/s5.7b-mutants.txt — invented-proof
  M('invented-proof', "packages/core/src/query.ts",
    "execution: enforced ? 'gateway_enforced' as const : tested ? 'tested_adapter' as const : 'unknown' as const,",
    "execution: enforced ? 'gateway_enforced' as const : tested ? 'tested_adapter' as const : 'gateway_enforced' as QueryEvidence['constraints'][number]['execution'],"),
  // proposals/audit/s5-mutants/s5.7b-mutants.txt — missing-controls
  M('missing-controls', "packages/core/src/index.ts",
    "      env.coverage = assembled.coverage;",
    "      env.coverage = assembled.coverage; delete (env.coverage as any).query_exhausted;"),
  // proposals/audit/s5-mutants/s5.7b-mutants.txt — provenance-mistake
  M('provenance-mistake', "packages/core/src/projection.ts",
    "({ resource_index, retrieved_at: record.retrievedAt })",
    "({ resource_index: resource_index + 1, retrieved_at: record.retrievedAt })"),
  // proposals/audit/s5-mutants/s5.7b-mutants.txt — CUR-discovery-to-clinical-accepted
  M('CUR-discovery-to-clinical-accepted', "packages/core/src/index.ts",
    "    const cursor = input.cursor;",
    "    const cursor: string = (this.discoveryStore as any).items.has(input.cursor) ? [...(this.store as any).items.keys()].find((key: any) => key.startsWith('res_')) ?? input.cursor : input.cursor;", {"suites": ["unit", "isolation"]}),
  // proposals/audit/s5-mutants/s5.7b-mutants.txt — CUR-clinical-to-discovery-accepted
  C('CUR-clinical-to-discovery-accepted', [
    {
      "file": "packages/core/src/index.ts",
      "find": "readDiscoverySnapshot(this.discoveryStore, input.cursor, this.discoveryBindingV2(), input.topic)",
      "replace": "readDiscoverySnapshot(this.discoveryStore, (this.store as any).items.has(input.cursor) ? [...(this.discoveryStore as any).items.keys()][0] : input.cursor, this.discoveryBindingV2(), input.topic)"
    },
    {
      "file": "packages/core/src/index.ts",
      "find": "readDiscoverySnapshot(this.discoveryStore, input.cursor, binding, topic)",
      "replace": "readDiscoverySnapshot(this.discoveryStore, (this.store as any).items.has(input.cursor) ? [...(this.discoveryStore as any).items.keys()][0] : input.cursor, binding, topic)"
    }
  ], {"suites": ["unit", "isolation"]}),
  // proposals/audit/s5-mutants/s5.7b-mutants.txt — client-only-success
  M('client-only-success', "packages/core/src/index.ts",
    "    return validateDeliverable02(tool, toWireValue(candidate), capture);",
    "    return { ok: typeof candidate.schema_version === 'string' };"),
  // proposals/audit/s5-mutants/s5.7b-mutants.txt — g16-message-drift
  M('g16-message-drift', "packages/core/src/catalog.ts",
    "FILTER_EXECUTION_UNVERIFIED: 'Execution of one or more requested filters is not verified.'",
    "FILTER_EXECUTION_UNVERIFIED: 'Execution of one or more requested filters is not verified!'"),
  // proposals/audit/s5-mutants/s5.7b-mutants.txt — declared-only-claimed-complete
  M('declared-only-claimed-complete', "packages/core/src/index.ts",
    "    if (coverage.state === 'complete_for_query' && coverage.query_evidence === 'declared_and_self_link_only') coverage.state = 'unknown';",
    ""),
  // proposals/audit/s5-mutants/s5.7b-mutants.txt — pending-treated-as-pass
  M('pending-treated-as-pass', "packages/evals/src/runner.ts",
    "pendingProfile && verdict.status === 'pass' ? { status: 'pending_profile_proof' as const }",
    "pendingProfile && verdict.status === 'pass' ? { status: 'pass' as const }"),
  // proposals/audit/s5-mutants/s5.7b-mutants.txt — PTH-03-egress
  M('PTH-03-egress', "packages/core/src/index.ts",
    "        admission = freezeDeliveryState(this.admitV2(tool, raw));",
    "        if (raw && typeof raw === 'object' && typeof (raw as any).source === 'string' && /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/$/.test((raw as any).source)) await fetch((raw as any).source);\n        admission = freezeDeliveryState(this.admitV2(tool, raw));", {"suites": ["unit", "isolation"]}),
  // proposals/audit/s5-mutants/s5.7b-mutants.txt — work-bound-removed
  M('work-bound-removed', "packages/core/src/index.ts",
    "    if (work.upstreamCalls >= 20) { work.limitReached = true; throw new LocalWorkRefusal(); }",
    ""),
  // proposals/audit/s5-mutants/s5.8a-mutants.txt — S58-guidance-removed
  M('S58-guidance-removed', "packages/server/src/index.ts",
    "description: TOOL_DESCRIPTIONS_V2[name],",
    "description: '',"),
  // proposals/audit/s5-mutants/s5.8a-mutants.txt — S58-bound-removed
  M('S58-bound-removed', "packages/core/src/catalog.ts",
    "  if (name === 'fhir_capabilities') {",
    "  delete propertyAt(schema, 'output.max_bytes').maximum;\n  if (name === 'fhir_capabilities') {"),
  // proposals/audit/s5-mutants/s5.8a-mutants.txt — S58-output-schema-removed
  M('S58-output-schema-removed', "packages/server/src/index.ts",
    "        outputSchema: minimalOutputSchema() as unknown as StandardSchemaWithJSON,",
    "        // diagnostic: output schema omitted."),
  // proposals/audit/s5-mutants/s5.8a-mutants.txt — S58-annotation-altered
  M('S58-annotation-altered', "packages/server/src/index.ts",
    "annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }",
    "annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }"),
  // proposals/audit/s5-mutants/s5.8a-mutants.txt — S58-catalog-page-dropped
  M('S58-catalog-page-dropped', "packages/evals/src/catalog.ts",
    "  } while (cursor !== undefined);",
    "  } while (false);"),
  // proposals/audit/s5-mutants/s5.8a-mutants.txt — S58-identity-with-stale-capture
  M('S58-identity-with-stale-capture', "packages/core/src/identity.ts",
    "version: packageJson.version",
    "version: packageJson.version + '-drift'", {"prepare": "contract"}),
  // proposals/audit/s5-mutants/s5.8a-mutants.txt — S58-deprecated-schema-import
  C('S58-deprecated-schema-import', [
    {
      "file": "packages/core/src/contracts.ts",
      "find": "export interface GatewayConfig",
      "replace": "const output = z.strictObject({\n  format: z.enum(['compact', 'fhir']).default('compact'),\n  fields: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*(\\.[A-Za-z][A-Za-z0-9]*)*$/)).max(30).optional(),\n  // V-26: the old 2048 minimum could never return a resource in the default envelope text mode (the envelope\n  // alone measures ≈2.7–3.2 KB; the first resource appears at ≈3.0–3.5 KB depending on era/tool). The minimum\n  // is raised to 4096, the smallest allowance at which envelope mode returns a resource in both eras, rather\n  // than silently answering every minimum-budget call with OUTPUT_LIMIT.\n  max_bytes: z.number().int().min(4096).max(131072).optional(),\n}).optional();\nconst common = { source: z.string().max(80).optional(), context_handle: z.string().max(160).optional(), output };\nexport const toolSchemas = {\n  fhir_capabilities: z.strictObject({ ...common, topic: z.enum(['server', 'resource', 'context', 'schema']).default('server'), resource_type: z.string().max(80).optional(), path: z.string().regex(/^(?:[A-Za-z][A-Za-z0-9]*(?:\\.[A-Za-z][A-Za-z0-9]*)*)?$/).max(512).default(''), offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(50).default(20) }),\n  fhir_search: z.strictObject({ ...common, resource_type: z.string().regex(/^[A-Z][A-Za-z0-9]+$/).max(80), params: z.array(z.strictObject({ name: z.string().max(160), value: z.string().max(2048) })).max(30).default([]), page_size: z.number().int().min(1).max(100).default(20) }),\n  fhir_read: z.strictObject({ ...common, resource_type: z.string().regex(/^[A-Z][A-Za-z0-9]+$/).max(80), id: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/), interaction: z.literal('read').default('read') }),\n  fhir_page: z.strictObject({ cursor: z.string().max(160), context_handle: common.context_handle, output }),\n  fhir_result: z.strictObject({ handle: z.string().max(160), context_handle: common.context_handle, action: z.enum(['inspect', 'project', 'page']).default('inspect'), fields: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*(\\.[A-Za-z][A-Za-z0-9]*)*$/)).max(30).optional(), offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(100).default(20), output }),\n};\n\nexport const envelopeSchema = z.looseObject({\n  schema_version: z.literal('0.1'), request_id: z.string(),\n  source: z.looseObject({ alias: z.string(), fhir_version: z.string() }),\n  context: z.looseObject({ handle: z.string(), mode: z.literal('patient-bound') }),\n  data: z.record(z.string(), z.unknown()),\n  coverage: z.looseObject({ state: z.enum(['complete_for_query', 'partial', 'unknown']), scope: z.string(), reasons: z.array(z.string()) }),\n  transform: z.looseObject({ format: z.enum(['compact', 'fhir']), projected: z.boolean(), withheld_payloads: z.array(z.record(z.string(), z.unknown())) }),\n  warnings: z.array(z.looseObject({ code: z.string(), message: z.string() })),\n  budget: z.looseObject({ bytes_returned: z.number(), byte_limit: z.number(), limit_reached: z.boolean(), upstream_calls: z.number(), elapsed_ms: z.number() }),\n});\n\nexport interface GatewayConfig"
    },
    {
      "file": "packages/server/src/index.ts",
      "find": "import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';",
      "replace": "import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';\nim" + "port { toolSchemas as retiredToolSchemas } from '../../core/src/contracts.js';\nvoid retiredToolSchemas;"
    }
  ]),
  // proposals/m3b-s5-workplan.md — S5-M01-per-tool
  M('S5-M01-per-tool', "packages/core/src/contracts.ts",
    "const schema = toolEnvelopeV2Schemas[tool];",
    "const schema = envelopeV2Schema;"),
  // proposals/m3b-s5-workplan.md — S5-M03-authorization
  M('S5-M03-authorization', "packages/core/src/contracts.ts",
    "    if (c.authorization_limited !== clinical || (clinical && !c.reasons.includes('CLINICAL_RECORD_COMPLETENESS_UNKNOWN'))) return fail();",
    ""),
  // proposals/m3b-s5-workplan.md — S5-M08-result-formats
  M('S5-M08-result-formats', "packages/core/src/contracts.ts",
    "    if (env.result && !unique(env.result.formats)) return fail();",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — crossfield02-provenance-count
  M('crossfield02-provenance-count', "packages/core/src/contracts.ts",
    "if ((env.provenance?.length ?? 0) !== count) return fail();",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — crossfield02-cursor-has-more
  M('crossfield02-cursor-has-more', "packages/core/src/contracts.ts",
    "if (tool !== 'fhir_result' && (page.has_more === true) !== (page.next_cursor !== undefined)) return fail();",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — crossfield02-error-with-data
  M('crossfield02-error-with-data', "packages/core/src/contracts.ts",
    "if (Object.keys(data).length || env.provenance !== undefined",
    "if (env.provenance !== undefined"),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — crossfield02-changed-page-shorthand
  M('crossfield02-changed-page-shorthand', "packages/core/src/contracts.ts",
    "context?.query?.fullEvidenceRequired === true || ",
    ""),
  // proposals/audit/s5-mutants/s5.1-fixup-mutants.txt — crossfield02-format-requested-format
  M('crossfield02-format-requested-format', "packages/core/src/contracts.ts",
    "if (context?.formatSupplied !== undefined && (t.requested_format !== (context.formatSupplied ? context.requestedFormat : undefined) || t.format !== (context.requestedFormat ?? 'fhir'))) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — no-matches-on-terminal-after-delivery
  M('no-matches-on-terminal-after-delivery', "packages/core/src/index.ts",
    "deliveredCount: (overlay?.deliveredCount ?? 0) + call.deliveredCount,",
    "deliveredCount: call.deliveredCount,"),
  // proposals/audit/s5-mutants/s5.3-mutants.txt — scan-limit-unenforced
  M('scan-limit-unenforced', "examples/observed-code-scan.ts",
    "(!discovery && report.clinicalPages >= limits.maxClinicalPages)",
    "false"),
  // proposals/m3b-s5-workplan.md — crossfield02-provenance-index
  C('crossfield02-provenance-index', [
    {
      "file": "packages/core/src/contracts.ts",
      "find": "indices.some(i => i < 0 || i >= count)",
      "replace": "false"
    },
    {
      "file": "packages/core/src/contracts.ts",
      "find": " || entry.resource_index >= data.resources.length",
      "replace": ""
    }
  ]),
  // proposals/m3b-s5-workplan.md — crossfield02-provenance-duplicate
  C('crossfield02-provenance-duplicate', [
    {
      "file": "packages/core/src/contracts.ts",
      "find": "!unique(indices) || ",
      "replace": ""
    },
    {
      "file": "packages/core/src/contracts.ts",
      "find": "seen.has(entry.resource_index) || ",
      "replace": ""
    }
  ]),
  // proposals/m3b-s5-workplan.md — crossfield02-error-with-result
  C('crossfield02-error-with-result', [
    {
      "file": "packages/core/src/contracts.ts",
      "find": " || env.result !== undefined",
      "replace": ""
    },
    {
      "file": "packages/core/src/contracts.ts",
      "find": "if (env.error && (data?.resources?.length || env.provenance || env.result || env.pagination))",
      "replace": "if (env.error && (data?.resources?.length || env.provenance || env.pagination))"
    }
  ]),
  // proposals/m3b-s5-workplan.md — crossfield02-error-with-pagination
  C('crossfield02-error-with-pagination', [
    {
      "file": "packages/core/src/contracts.ts",
      "find": "      if (Object.keys(data).length || env.provenance !== undefined || env.result !== undefined || page !== undefined) return fail();",
      "replace": "      if (Object.keys(data).length || env.provenance !== undefined || env.result !== undefined) return fail();"
    },
    {
      "file": "packages/core/src/contracts.ts",
      "find": "if (env.error && (data?.resources?.length || env.provenance || env.result || env.pagination))",
      "replace": "if (env.error && (data?.resources?.length || env.provenance || env.result))"
    }
  ]),
  // proposals/m3b-s5-workplan.md — crossfield02-first-page-shorthand
  M('crossfield02-first-page-shorthand', "packages/core/src/contracts.ts",
    "tool !== 'fhir_page' || ",
    ""),
  // S5.4 per-property successor: selected local references retain contained evidence.
  M('S54-selected-local-contained', "packages/core/src/projection.ts",
    "if (source.contained && Object.entries(result).some(([key, value]) => key !== 'contained' && localReference(value))) {",
    "if (source.contained && Object.entries(result).some(([key, value]) => key !== 'contained' && localReference(value)) && Boolean(0)) {"),
  // S5 review (runtime finding 1): the gate must reject a permutation of the full constraint list, not only changed values.
  M('crossfield02-constraint-order-insensitive', "packages/core/src/contracts.ts",
    "    if (c.constraints && JSON.stringify(c.constraints.map(p => ({ name: p.name, value: p.value }))) !== JSON.stringify(pairs)) return fail('VALIDATION_CONTEXT_MISMATCH');",
    "    if (c.constraints && JSON.stringify([...c.constraints.map(p => ({ name: p.name, value: p.value }))].sort((a, b) => `${a.name}=${a.value}`.localeCompare(`${b.name}=${b.value}`))) !== JSON.stringify([...pairs].sort((a, b) => `${a.name}=${a.value}`.localeCompare(`${b.name}=${b.value}`)))) return fail('VALIDATION_CONTEXT_MISMATCH');"),
  // S5 review (Opus runtime finding 2): the evidence kind is no longer bound to the trusted proof when no constraint list is disclosed.
  M('crossfield02-proof-kind-unbound', "packages/core/src/contracts.ts",
    "      if (c.query_evidence === 'exact_id_and_subject_linkage' && (!proof.length || proof.some(p => p.execution !== 'gateway_enforced'))) return fail();",
    "      if (c.query_evidence === 'exact_id_and_subject_linkage' && Boolean(0) && (!proof.length || proof.some(p => p.execution !== 'gateway_enforced'))) return fail();"),
  // S5 review (Opus runtime finding 2): the unverified-filter caveat may be dropped while the trusted proof says unknown.
  M('crossfield02-proof-caveat-unbound', "packages/core/src/contracts.ts",
    "      if (proof.some(p => p.execution === 'unknown') && (!c.reasons.includes('FILTER_EXECUTION_UNVERIFIED') || !env.warnings.some(w => w.code === 'FILTER_EXECUTION_UNVERIFIED'))) return fail();",
    "      if (proof.some(p => p.execution === 'unknown') && Boolean(0) && (!c.reasons.includes('FILTER_EXECUTION_UNVERIFIED') || !env.warnings.some(w => w.code === 'FILTER_EXECUTION_UNVERIFIED'))) return fail();"),
  // S5 review (Opus runtime finding 2): a tested_adapter claim is no longer bound to the trusted proof when no constraint list is disclosed.
  M('crossfield02-proof-tested-unbound', "packages/core/src/contracts.ts",
    "      if (c.query_evidence === 'tested_adapter' && (!proof.some(p => p.execution === 'tested_adapter') || proof.some(p => p.execution === 'unknown'))) return fail();",
    "      if (c.query_evidence === 'tested_adapter' && Boolean(0) && (!proof.some(p => p.execution === 'tested_adapter') || proof.some(p => p.execution === 'unknown'))) return fail();"),
  // S5b: collapse computed from the snapshot records instead of the finally selected ones (undelivered records counted).
  M('collapse-counts-undelivered', "packages/core/src/index.ts",
    "        withheld_payloads: collapseWithheld(selected.map(item => item.record)),\n",
    "        withheld_payloads: collapseWithheld(records),\n"),
  // S5b: attachment and payload entries merge like policy entries.
  M('collapse-merges-attachment', "packages/core/src/withheld.ts",
    "      if (!classified || origins![i] !== 'policy' || !keyOnly(manifest)) { delivered.push(manifest); return; }",
    "      if (!classified || origins![i] === 'link_text' || !keyOnly(manifest)) { delivered.push(manifest); return; }"),
  // S5b: duplicates disappear without a count (the first entry stays a singleton).
  M('collapse-drops-count', "packages/core/src/withheld.ts",
    "      if (!seen.entry) { seen.entry = { path: manifest.path, reason: manifest.reason, count: 2 }; delivered[seen.index] = seen.entry; return; }\n      seen.entry.count += 1;",
    "      if (!seen.entry) { seen.entry = { path: manifest.path, reason: manifest.reason, count: 2 }; return; }\n      seen.entry.count += 1;"),
  // S5b: same-path entries with different reasons merge (one reason disappears from both channels).
  M('collapse-drops-reason', "packages/core/src/withheld.ts",
    "      const key = `${manifest.path}\\u0000${manifest.reason}`;",
    "      const key = manifest.path;"),
  // S5b: the gate accepts a singleton collapse count.
  M('gate-count-singleton', "packages/core/src/contracts.ts",
    "    if (t.withheld_payloads.some(m => m.count !== undefined && ((m.count as number) < 2 || Object.keys(m).length !== 3))) return fail();",
    "    if (t.withheld_payloads.some(m => m.count !== undefined && ((m.count as number) < 1 || Object.keys(m).length !== 3))) return fail();"),
  // S5b review: the gate accepts a count on a payload or in-text-link reason.
  M('gate-count-on-payload-reason', "packages/core/src/contracts.ts",
    "    if (t.withheld_payloads.some(m => m.count !== undefined && ['V1_PAYLOAD_WITHHELD', 'PROTECTED_LINK_IN_TEXT'].includes(m.reason as string))) return fail();",
    "    if (t.withheld_payloads.some(m => m.count !== undefined && Boolean(0) && ['V1_PAYLOAD_WITHHELD', 'PROTECTED_LINK_IN_TEXT'].includes(m.reason as string))) return fail();"),
  // S5b review: the gate accepts the same collapsed {path, reason} pair twice.
  M('gate-counted-pair-duplicate', "packages/core/src/contracts.ts",
    "    if (!unique(t.withheld_payloads.filter(m => m.count !== undefined).map(m => `${m.path}\\u0000${m.reason}`))) return fail();",
    "    if (Boolean(0) && !unique(t.withheld_payloads.filter(m => m.count !== undefined).map(m => `${m.path}\\u0000${m.reason}`))) return fail();"),
  // S5b review: payload entries are tagged policy at the creation site and merge.
  M('origin-payload-as-policy', "packages/core/src/privacy.ts",
    "return withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, metadata(), 'payload');",
    "return withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, metadata(), 'policy');"),
  // S5b review: links inside a schema-declared Attachment are tagged policy and merge.
  M('origin-attachment-link-as-policy', "packages/core/src/privacy.ts",
    "const linkOrigin: ManifestOrigin = inAttachment ? 'attachment' : attachment || !element.types.length ? 'unknown' : 'policy';",
    "const linkOrigin: ManifestOrigin = !element.types.length ? 'unknown' : 'policy';"),
  // S5b review: a withheld link at a site with no schema element is tagged policy and merges.
  M('origin-unknown-site-as-policy', "packages/core/src/privacy.ts",
    "const linkOrigin: ManifestOrigin = inAttachment ? 'attachment' : attachment || !element.types.length ? 'unknown' : 'policy';",
    "const linkOrigin: ManifestOrigin = inAttachment ? 'attachment' : attachment ? 'unknown' : 'policy';"),
  // S5b review: an attachment context inferred from shape or path spelling alone classifies the link as policy.
  M('origin-spelling-attachment-as-policy', "packages/core/src/privacy.ts",
    "const linkOrigin: ManifestOrigin = inAttachment ? 'attachment' : attachment || !element.types.length ? 'unknown' : 'policy';",
    "const linkOrigin: ManifestOrigin = inAttachment ? 'attachment' : !element.types.length ? 'unknown' : 'policy';"),
  // S5b review: companions withheld under an undeclared node are tagged policy and merge.
  M('origin-companion-unknown-as-policy', "packages/core/src/privacy.ts",
    "const childOrigin: ManifestOrigin = childElement.types.length ? 'policy' : 'unknown';",
    "const childOrigin: ManifestOrigin = 'policy';"),
  // S5b review: the text channel repeats the count inside the quoted JSON (double-counted text).
  M('text-double-counted', "packages/core/src/delivery.ts",
    "      ? `withheld x${count}: ${jsonLine(rest)}` : `withheld: ${jsonLine(manifest)}`;",
    "      ? `withheld x${count}: ${jsonLine(manifest)}` : `withheld: ${jsonLine(manifest)}`;"),
  // S6: a requested sort no longer requires a trusted sort proof in the context.
  M('crossfield02-sort-proof-not-required', "packages/core/src/contracts.ts",
    "    if (q.sort.length > 0 && !q.sortProof) return fail('VALIDATION_CONTEXT_REQUIRED');",
    "    if (q.sort.length > 0 && Boolean(0) && !q.sortProof) return fail('VALIDATION_CONTEXT_REQUIRED');"),
  // S6: the disclosed sort order/effective keys are not bound to the trusted sort proof (S5 review finding 2d reopened).
  M('crossfield02-sort-proof-unbound', "packages/core/src/contracts.ts",
    "    if (c.sort && q.sortProof && (c.sort.order !== q.sortProof.order || JSON.stringify(c.sort.effective ?? null) !== JSON.stringify(q.sortProof.effective ?? null))) return fail();",
    "    if (c.sort && Boolean(0) && q.sortProof && (c.sort.order !== q.sortProof.order || JSON.stringify(c.sort.effective ?? null) !== JSON.stringify(q.sortProof.effective ?? null))) return fail();"),
  // S6: the declared kind is accepted on a fully proved non-empty set (mixed-proof rule loosened).
  M('crossfield02-declared-with-full-proof', "packages/core/src/contracts.ts",
    "      if (c.query_evidence === 'declared_and_self_link_only' && proof.length > 0 && !proof.some(p => p.execution === 'unknown')) return fail();",
    "      if (c.query_evidence === 'declared_and_self_link_only' && Boolean(0) && proof.length > 0 && !proof.some(p => p.execution === 'unknown')) return fail();"),
  // S6: the trusted invocation state omits the sort proof.
  M('invocation-sort-proof-dropped', "packages/core/src/index.ts",
    "          ...(evidence.sort ? { sortProof: { order: evidence.sort.order, effective: evidence.sort.effective ? [...evidence.sort.effective] : null } } : {}),",
    "          ...(evidence.sort && Boolean(0) ? { sortProof: { order: evidence.sort.order, effective: evidence.sort.effective ? [...evidence.sort.effective] : null } } : {}),"),
  // S6: a proved continuation is still labelled unverified_continuation (chains can never complete).
  M('continuation-verified-label-dropped', "packages/core/src/index.ts",
    "queryEvidenceKind: verifySelf || !chainUnverified ? 'declared_and_self_link_only' : 'unverified_continuation',",
    "queryEvidenceKind: verifySelf || (!chainUnverified && Boolean(0)) ? 'declared_and_self_link_only' : 'unverified_continuation',"),
  // S6: a continued page without a reported self link is treated as verified.
  M('continuation-verified-without-self-link', "packages/core/src/index.ts",
    "const selfPagingMatches = !previous || (reported !== null",
    "const selfPagingMatches = !previous || reported === null || (reported !== null"),
  // S6: a recorded capability revision no longer binds the profile to the discovered source.
  M('profile-revision-unbound', "packages/core/src/query.ts",
    "  if (profile.evidence?.capability_revision !== undefined && capability.revision !== profile.evidence.capability_revision) return undefined;",
    "  if (Boolean(0) && profile.evidence?.capability_revision !== undefined && capability.revision !== profile.evidence.capability_revision) return undefined;"),
  // S6: the config enum admits a declared but ineligible profile.
  M("config-enum-not-derived", "packages/core/src/index.ts",
    "searchProfile: z.enum(eligibleSearchProfileIds() as [string, ...string[]]).optional(),",
    "searchProfile: z.enum(['test-ineligible-hapi-r4', ...eligibleSearchProfileIds()] as [string, ...string[]]).optional(),"),
  // S6: the eval runner uses a qualified profile whose recorded fixture digest no longer matches what it serves.
  M('eval-profile-drift-unchecked', "packages/evals/src/runner.ts",
    "  if (profile.source.fixture_sha256 !== expectedProfileHashes.fixture) return",
    "  if (profile.source.fixture_sha256 !== expectedProfileHashes.fixture && Boolean(0)) return"),
  // S6 review (finding 1): the continuation offset is not bound to the previous page's offset plus returned entries.
  M('continuation-offset-arithmetic-unchecked', "packages/core/src/index.ts",
    "    const offsetConsistent = !previous || pageOffset === (previous.queryOverlay?.pageOffset ?? 0) + (previous.queryOverlay?.pageEntries ?? 0);",
    "    const offsetConsistent = !previous || Boolean(1) || pageOffset === (previous.queryOverlay?.pageOffset ?? 0) + (previous.queryOverlay?.pageEntries ?? 0);"),
  // S6 review (finding 3): the continued page's self link is not required to carry this request's offset.
  M('continuation-self-paging-unchecked', "packages/core/src/index.ts",
    "    const selfPagingMatches = !previous || (reported !== null && selfOffsets.length === 1 && selfOffsets[0]!.value === url.searchParams.get('_offset')",
    "    const selfPagingMatches = !previous || Boolean(1) || (reported !== null && selfOffsets.length === 1 && selfOffsets[0]!.value === url.searchParams.get('_offset')"),
  // S6 review (finding 2): the unverified-continuation flag is recomputed per page instead of staying sticky.
  M('continuation-flag-not-sticky', "packages/core/src/index.ts",
    "    const chainUnverified = Boolean(previous) && (Boolean(previous!.queryOverlay?.continuationUnverified) || !continuationVerified);",
    "    const chainUnverified = Boolean(previous) && !continuationVerified;"),
  // S6 review (finding 2): the gate does not bind the sticky chain flag.
  M('crossfield02-continuation-flag-unbound', "packages/core/src/contracts.ts",
    "    if (q.continuationUnverified && c.scope === 'page' && (c.query_evidence !== 'unverified_continuation' || c.state === 'complete_for_query')) return fail();",
    "    if (q.continuationUnverified && Boolean(0) && c.scope === 'page' && (c.query_evidence !== 'unverified_continuation' || c.state === 'complete_for_query')) return fail();"),
  // S6 review (finding 5): a sort claim on a non-chain envelope is accepted.
  M('crossfield02-sort-without-chain', "packages/core/src/contracts.ts",
    "c.constraints_on_first_page !== undefined || c.sort !== undefined)) return fail('VALIDATION_CONTEXT_REQUIRED');",
    "c.constraints_on_first_page !== undefined)) return fail('VALIDATION_CONTEXT_REQUIRED');"),
  // S6 review (finding 6): the discovered identity drops the capability revision (the qualified profile would bind to nothing).
  M('identity-revision-dropped', "packages/core/src/index.ts",
    "  return { digested: true, software: bounded(software?.name), softwareVersion: bounded(software?.version), fhirVersion, revision };",
    "  return { digested: true, software: bounded(software?.name), softwareVersion: bounded(software?.version), fhirVersion, revision: Boolean(0) ? revision : undefined };"),
  // S6 review (finding 6): a shipped eligible profile may claim proof without a recorded capability revision.
  M('registry-revision-invariant-skipped', "packages/core/src/query.ts",
    "    if (profile.eligible && claimsProof && !(typeof profile.evidence?.capability_revision === 'string' && profile.evidence.capability_revision.length > 0)) {",
    "    if (profile.eligible && claimsProof && Boolean(0) && !(typeof profile.evidence?.capability_revision === 'string' && profile.evidence.capability_revision.length > 0)) {"),
  // Astra review (2026-10-22): sub-millisecond instants tie at the millisecond; each guard that refuses to compare, prove or order them is anchored.
  M('date-subms-equality-decided', "packages/core/src/query.ts",
    "  if (search.subMillisecond || target.subMillisecond) return undefined;",
    "  if (Boolean(0) && (search.subMillisecond || target.subMillisecond)) return undefined;"),
  M('date-subms-variant-proved', "packages/core/src/query.ts",
    "    return prefix !== 'ap' && allowedPrefixes.has(prefix) && interval !== undefined && !interval.subMillisecond;",
    "    return prefix !== 'ap' && allowedPrefixes.has(prefix) && interval !== undefined;"),
  M('sort-subms-ordered', "packages/core/src/query.ts",
    "    if (effective.subMillisecond) return { outcome: { status: 'unverifiable', parameter: 'date', variant: 'sub-millisecond-precision' } };",
    "    if (effective.subMillisecond && Boolean(0)) return { outcome: { status: 'unverifiable', parameter: 'date', variant: 'sub-millisecond-precision' } };"),
  // S6 review (finding 11): effectiveInstant records are accepted by the proved descending-effectiveDateTime sort variant.
  M('sort-instant-variant-accepted', "packages/core/src/query.ts",
    "    if (effective.kind !== 'interval' || effective.variant !== 'dateTime' || !effective.timezoneQualified || !effective.instantPrecision) {",
    "    if (effective.kind !== 'interval' || !effective.timezoneQualified || !effective.instantPrecision) {"),
  // G-BACKEND: killed by G-BACKEND loopback confinement and redirects refuse before contacting an unsafe destination.
  M("gbackend-loopback-unchecked", "packages/evals/src/external.ts",
    "return new FhirTransport(baseUrl, MAX_BYTES, REQUEST_MS);",
    "return new FhirTransport(HAPI_BASE_URL, MAX_BYTES, REQUEST_MS);", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND loopback confinement and redirects refuse before contacting an unsafe destination.
  M("gbackend-request-url-unchecked", "packages/evals/src/external.ts",
    "const url = this.transport.validate(value);",
    "const url = new URL(value, this.transport.base);", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND loopback confinement and redirects refuse before contacting an unsafe destination.
  C('gbackend-redirect-admitted', [
    { file: 'packages/evals/src/external.ts', find: "    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); refuse('redirect'); }\n", replace: '' },
    { file: 'packages/evals/src/external.ts', find: 'if (!response.ok) {', replace: 'if (!response.ok && response.status !== 302) {' },
  ], { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND bounded client refuses oversized and malformed responses without payload diagnostics.
  M("gbackend-response-size-unbounded", "packages/evals/src/external.ts",
    "if (bytes > MAX_BYTES) { await reader.cancel(); refuse('response-size'); }",
    "if (Boolean(0) && bytes > MAX_BYTES) { await reader.cancel(); refuse('response-size'); }", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND strict round-trip comparator ignores only documented server metadata.
  M("gbackend-roundtrip-comparator-bypassed", "packages/evals/src/external.ts",
    "return canonicalJson(normalize(expected, false)) === canonicalJson(normalize(actual, true));",
    "return true;", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND transaction PUT loader reads every body and preserves fixed identities.
  M("gbackend-roundtrip-read-unchecked", "packages/evals/src/external.ts",
    "    if (!compareExternalResource(resource, actual)) refuse('round-trip-mismatch');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND hermetic census refuses foreign, missing, duplicate and changed records.
  M("gbackend-census-extra-ignored", "packages/evals/src/external.ts",
    "if (!expected.has(key)) refuse('census-extra-resource');",
    "if (!expected.has(key)) continue;", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND hermetic census refuses foreign, missing, duplicate and changed records.
  M("gbackend-census-duplicate-ignored", "packages/evals/src/external.ts",
    "if (seen.has(key)) refuse('census-duplicate-resource');",
    "if (seen.has(key)) continue;", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND hermetic census refuses foreign, missing, duplicate and changed records.
  M("gbackend-census-content-unchecked", "packages/evals/src/external.ts",
    "        if (!compareExternalResource(expected.get(key)!, resource)) refuse('census-resource-mismatch');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND hermetic census refuses foreign, missing, duplicate and changed records.
  M("gbackend-census-missing-accepted", "packages/evals/src/external.ts",
    "  if (requireComplete && (seen.size !== expected.size || [...expected.keys()].some(key => !seen.has(key)))) refuse('census-missing-resource');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND census binds totals and rejects unsafe, duplicate or endless next links.
  M("gbackend-census-total-inconsistent", "packages/evals/src/external.ts",
    "        if (!Number.isSafeInteger(bundle.total) || Number(bundle.total) < 0 || (declaredTotal !== undefined && declaredTotal !== bundle.total)) refuse('census-total');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND census binds totals and rejects unsafe, duplicate or endless next links.
  M("gbackend-census-total-count-unchecked", "packages/evals/src/external.ts",
    "    if (declaredTotal !== undefined && declaredTotal !== typeCount) refuse('census-total-count');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND prepared inputs are immutable owned snapshots and unprepared sources cannot run.
  M("gbackend-prepared-corpus-mutable", "packages/evals/src/external.ts",
    "  freeze(copy);",
    "  /* Mutant: nested corpus is mutable. */", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND applicability is total stable and fails closed on task or classification drift.
  M("gbackend-applicability-not-total", "packages/evals/src/external.ts",
    "  if (byId.size !== rows.length || tasks.length !== rows.length || new Set(tasks.map(task => task.id)).size !== tasks.length) refuse('applicability-not-total');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND applicability is total stable and fails closed on task or classification drift.
  M("gbackend-applicability-task-unbound", "packages/evals/src/external.ts",
    "if (!row || row.task_sha256 !== externalHash(task) || row.corpus !== (task.corpus ?? 'baseline')) refuse('applicability-task-drift');",
    "if (!row || row.corpus !== (task.corpus ?? 'baseline')) refuse('applicability-task-drift');", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND applicability is total stable and fails closed on task or classification drift.
  M("gbackend-applicability-assignment-unbound", "packages/evals/src/external.ts",
    "  if (externalHash([...rows].sort((a, b) => a.task_id.localeCompare(b.task_id))) !== '831d5adb3dc1844b2a2be0ed13f51e4a6a0ee0e19e79e609cf9bb0b759fa8362') refuse('applicability-assignment-drift');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND external selection excludes fixture simulations and refuses altered or unknown tasks.
  M("gbackend-simulations-selected", "packages/evals/src/external.ts",
    "return selected.filter(task => applicability.some(row => row.task_id === task.id && row.classification === 'real-backend'));",
    "return [...selected];", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND external selection excludes fixture simulations and refuses altered or unknown tasks.
  M("gbackend-selected-task-unbound", "packages/evals/src/external.ts",
    "  if (selected.some(task => !applicability.some(row => row.task_id === task.id && row.task_sha256 === externalHash(task)))) refuse('external-task-selection');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND every discovered envelope binds the measured capability revision during a run.
  M("gbackend-envelope-revision-unbound", "packages/evals/src/external.ts",
    "return (error && revision === 'unknown') || revision === expected;",
    "return true;", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND external eligible registry requires each independent binding.
  M("gbackend-registry-software-unbound", "packages/core/src/query.ts",
    "      if (!profile.source.software || !profile.source.software_version || profile.source.fhir_version !== '4.0.1') throw new Error('External profile requires exact software, version and FHIR identity.');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND external eligible registry requires each independent binding.
  M("gbackend-registry-image-unbound", "packages/core/src/query.ts",
    "      if (!/^sha256:[a-f0-9]{64}$/.test(profile.source.image_digest ?? '')) throw new Error('External profile requires image_digest.');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND external eligible registry requires each independent binding.
  M("gbackend-registry-corpus-unbound", "packages/core/src/query.ts",
    "      if (!/^[a-f0-9]{64}$/.test(profile.source.corpus_sha256 ?? '')) throw new Error('External profile requires corpus_sha256.');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND external eligible registry requires each independent binding.
  M("gbackend-registry-tasks-unbound", "packages/core/src/query.ts",
    "      if (!/^[a-f0-9]{64}$/.test(profile.evidence?.tasks_sha256 ?? '')) throw new Error('External profile requires tasks_sha256.');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND external eligible registry requires each independent binding.
  M("gbackend-registry-evidence-unbound", "packages/core/src/query.ts",
    "      if (!profile.evidence?.capability_revision || !/^[a-f0-9]{64}$/.test(profile.evidence?.report_sha256 ?? '') || !Number.isFinite(Date.parse(profile.evidence?.recorded_at ?? ''))) throw new Error('External profile requires complete recorded evidence.');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND source binding uses exact keyed software version FHIR and revision with no external wildcard.
  M("gbackend-external-runtime-wildcard", "packages/core/src/query.ts",
    "  if (profile.source.kind === 'external' && (!profile.source.software_version || (profile.eligible && !profile.evidence?.capability_revision))) return undefined;\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-drift-software-unchecked", "packages/evals/src/runner.ts",
    "    if (profile.source.software !== external.software) return 'software drift';\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-drift-software-version-unchecked", "packages/evals/src/runner.ts",
    "    if (profile.source.software_version !== external.software_version) return 'software_version drift';\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-drift-fhir-version-unchecked", "packages/evals/src/runner.ts",
    "    if (profile.source.fhir_version !== external.fhir_version) return 'fhir_version drift';\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-drift-image-digest-unchecked", "packages/evals/src/runner.ts",
    "    if (profile.source.image_digest !== external.image_digest) return 'image_digest drift';\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-drift-corpus-sha256-unchecked", "packages/evals/src/runner.ts",
    "    if (profile.source.corpus_sha256 !== external.corpus_sha256) return 'corpus_sha256 drift';\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-drift-capability-revision-unchecked", "packages/evals/src/runner.ts",
    "    if (profile.evidence?.capability_revision !== external.capability_revision) return 'capability_revision drift';\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-drift-tasks-sha256-unchecked", "packages/evals/src/runner.ts",
    "    if (profile.evidence?.tasks_sha256 !== external.tasks_sha256) return 'tasks_sha256 drift';\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-drift-identity-missing", "packages/evals/src/runner.ts",
    "if (!external) return 'external identity missing';",
    "if (!external) return undefined;", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-synthetic-binding-accepted", "packages/evals/src/runner.ts",
    "  if (external) return 'synthetic profile cannot prove an external backend';\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-task-denominator-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (externalHash(observed) !== externalHash(expected)) problems.push('task-arm denominator differs from independently expected applicability');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-control-denominator-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (externalHash(controls.map(row => `${row.task_id}/${row.arm}`).sort()) !== externalHash(controlKeys) || controlKeys.length === 0) problems.push('private-control denominator differs from independently expected tasks times arms');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-control-verdict-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (controls.some(row => row.private_profile_verdict !== 'pass' || row.failures.length > 0 || row.checks.some(check => check.status === 'fail' || check.status === 'pending_profile_proof'))) problems.push('private controls failed');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-control-label-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (controls.some(row => row.query_profile.id !== candidateId || !row.query_profile.private || row.calls.length === 0 || row.calls.some(call => call.query_profile.id !== candidateId || !call.query_profile.private))) problems.push('private controls mislabelled');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-pending-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (report.summary.pending_profile_proof.length || report.results.some(row => row.status === 'pending_profile_proof' || row.checks.some(check => check.status === 'pending_profile_proof'))) problems.push('pending profile proof');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-public-failures-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (report.results.some(row => row.status !== 'private_profile_control' && (row.status !== 'pass' || row.failures.length)) || Object.keys(report.summary.failures_by_cause).length) problems.push('public run not clean');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-byte-accounting-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (report.summary.byte_accounting.under_reported_calls || report.summary.byte_accounting.over_reported_calls) problems.push('independent byte accounting failed');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-identity-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (externalHash(report.external_backend?.identity) !== externalHash(identity)) problems.push('external identity changed');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-applicability-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (externalHash(report.external_backend?.applicability) !== externalHash(externalApplicability())) problems.push('applicability report changed');\n",
    "", { suites: ['unit'] }),
  // G-BACKEND: killed by G-BACKEND opaque continuation rejects unissued tokens without provenance.
  M('gbackend-opaque-getpages-unissued-accepted', 'packages/evals/src/upstream-provenance.ts',
    'const confined = direct || parent !== undefined;',
    "const confined = direct || parent !== undefined || url.searchParams.has('_getpages');", { suites: ['unit'] }),
  // Ordinary failures falsely retain successful query/metadata evidence.
  M("s7a-error-evidence-reverted", "packages/core/src/index.ts", "authorization_limited: clinical, query_exhausted: null, pages_observed: 0,\n      query_evidence: 'none'", "authorization_limited: clinical, query_exhausted: null, pages_observed: 0,\n      query_evidence: clinical ? 'unverified_continuation' : 'metadata_snapshot'", {"suites": ["unit", "isolation"]}),
  // Runtime emergency failures falsely claim successful evidence; constructor validation remains the positive control.
  M("s7a-emergency-evidence-reverted", "packages/core/src/index.ts", "query_evidence: 'none' },\n      transform:", "query_evidence: requestId === 'ctor-v2-emergency' ? 'none' : tool === 'fhir_capabilities' ? 'metadata_snapshot' : 'unverified_continuation' },\n      transform:"),
  // The error gate accepts stale evidence labels.
  M("s7a-error-none-gate-disabled", "packages/core/src/contracts.ts", " || c.query_evidence !== 'none'", ""),
  // Successful query responses may carry error-only none.
  M("s7a-success-none-gate-disabled", "packages/core/src/contracts.ts", "    if (c.query_evidence === 'none') return fail();", "    // Broken: success may claim error-only evidence."),
  // The successful coverage helper admits error-only evidence.
  M("s7a-helper-none-admitted", "packages/core/src/query.ts", "  if ((evidence.evidenceKind as string) === 'none') throw new GatewayFault('INTERNAL_ERROR', 'Error evidence cannot describe a successful snapshot.');", ""),
  // Error-only evidence incorrectly qualifies for NO_MATCHES.
  M("s7a-none-no-matches", "packages/core/src/contracts.ts", "coverage.query_evidence !== 'none' && ", ""),
  // Continuation packing silently reverts to one hundred rows.
  M("s7a-size-fallback-100", "packages/core/src/index.ts", "read ? 1 : this.requestedPageSizeV2(snapshot);", "read ? 1 : 100;"),
  // The continuation reports a ceiling different from its original request.
  M("s7a-reported-size-100", "packages/core/src/index.ts", "requested_page_size: limit, total:", "requested_page_size: 100, total:"),
  // The gate stops binding reported size to trusted original state.
  M("s7a-size-gate-unbound", "packages/core/src/contracts.ts", "      if (page?.requested_page_size !== context!.requestedPageSize) return fail('VALIDATION_CONTEXT_MISMATCH');", ""),
  // Missing or invalid frozen counts get a permissive fallback.
  M("s7a-invalid-count-fallback", "packages/core/src/index.ts", "    const count = snapshot.query.at(-1);\n    if (count?.name !== '_count' || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(count.value)) throw new GatewayFault('UNVERIFIED_CONTINUATION', 'Frozen search state is invalid.');\n    return Number(count.value);", "    const count = snapshot.query.at(-1);\n    return Number(count?.value) || 100;"),
  // An unknown terminal chain falsely claims has_more false.
  M("s7a-terminal-false", "packages/core/src/index.ts", "has_more: more ? true : unknown ? null : false", "has_more: more ? true : false"),
  // The gate permits false instead of terminal trusted unknown.
  M("s7a-terminal-unknown-gate-disabled", "packages/core/src/contracts.ts", "    if (q.continuationUnverified && c.scope === 'page' && !page?.next_cursor && (page?.has_more !== null || c.query_exhausted !== null)) return fail();", ""),
  // Discovery advancement skips the first undelivered row.
  M("s7a-server-skip-row", "packages/core/src/index.ts", "const next = { ...snapshot, offset: offset + count };", "const next = { ...snapshot, offset: offset + count + 1 };"),
  // A server continuation repeats the preceding row.
  M("s7a-server-duplicate-row", "packages/core/src/index.ts", "resources: snapshot.rows.slice(offset, offset + count)", "resources: snapshot.rows.slice(Math.max(0, offset - 1), Math.max(0, offset - 1) + count)"),
  // Server summaries terminate before the frozen tail is delivered.
  M("s7a-server-terminal-before-tail", "packages/core/src/index.ts", "      if (offset + count < rows.length) {", "      if (topic !== 'server' && offset + count < rows.length) {"),
  // Server rows lose required optional and executable priority.
  M("s7a-server-priority-dropped", "packages/core/src/index.ts", "priority(a.type, a.implemented_interactions.length > 0) - priority(b.type, b.implemented_interactions.length > 0)", "0"),
  // Source advertisement is falsely promoted to executable support.
  M("s7a-server-false-executable", "packages/core/src/index.ts", "implemented_interactions: c.ambiguous ? [] : supported.get(c.type)?.executable_interactions ?? []", "implemented_interactions: ['read', 'search-type'] as ('read' | 'search-type')[]"),
  // Server cursors bypass source context policy and authorization binding.
  M("s7a-server-binding-bypass", "packages/core/src/discovery.ts", "!bindingsEqual(found.value.binding, binding)", "(found.value.topic !== 'server' && !bindingsEqual(found.value.binding, binding))"),
  // A server cursor is admitted under a different discovery topic.
  M("s7a-server-topic-bypass", "packages/core/src/discovery.ts", "found.value.topic !== topic ||", "(found.value.topic !== 'server' && found.value.topic !== topic) ||", {"suites": ["unit", "isolation"]}),
  // Server cursor validation ignores the source revision.
  M("s7a-server-revision-bypass", "packages/core/src/discovery.ts", "!bindingsEqual(found.value.binding, binding)", "!bindingsEqual(found.value.topic === 'server' ? { ...found.value.binding, sourceRevision: binding.sourceRevision } : found.value.binding, binding)"),
  // Server continuation allocation extends its absolute expiry.
  M("s7a-server-expiry-renewed", "packages/core/src/index.ts", "freezeServerSnapshot(this.discoveryStore, next, Date.parse(next.expiresAt))", "freezeServerSnapshot(this.discoveryStore, next, Date.parse(next.expiresAt) + 60000)"),
  // Failed metadata delivery leaves earlier cursor evictions committed.
  M("s7a-server-rollback-disabled", "packages/core/src/index.ts", "          this.rollbackDiscoveryV2(pending);\n          restoreClinical(); restoreDiscovery();", "          this.rollbackDiscoveryV2(pending);\n          restoreClinical();"),
  // Server output discloses a patient different from configured binding.
  M("s7a-patient-output-wrong", "packages/core/src/index.ts", "fhir_version: this.fhirVersion, patient_id: this.config.patientId,", "fhir_version: this.fhirVersion, patient_id: 'foreign-output',", {"suites": ["unit", "isolation"]}),
  // The server binding is selected from source metadata instead of configuration.
  M("s7a-patient-source-derived", "packages/core/src/index.ts", "fhir_version: this.fhirVersion, patient_id: this.config.patientId,", "fhir_version: this.fhirVersion, patient_id: this.capabilities?.keys().next().value ?? this.config.patientId,"),
  // Server patient disclosure is no longer bound by the semantic gate.
  M("s7a-patient-binding-gate-disabled", "packages/core/src/contracts.ts", "      if ((topic === 'context' || topic === 'server') && (!context?.patientId || data.patient_id !== context.patientId)) return fail('VALIDATION_CONTEXT_MISMATCH');", "      if (topic === 'context' && (!context?.patientId || data.patient_id !== context.patientId)) return fail('VALIDATION_CONTEXT_MISMATCH');"),
  // The packer shrinks metadata without its registered warning.
  M("s7a-byte-warning-dropped", "packages/core/src/index.ts", "      env.warnings = this.warningsV2([...env.warnings, { code: 'METADATA_BYTE_LIMIT', message: WARNING_MESSAGES.METADATA_BYTE_LIMIT! }]);", ""),
  // Natural or caller-limited metadata pages falsely claim byte shrinkage.
  M("s7a-byte-warning-natural-end", "packages/core/src/index.ts", "    let byteLimited = false;", "    let byteLimited = true;\n    env.budget.limit_reached = true;\n    env.warnings.push({ code: 'METADATA_BYTE_LIMIT', message: WARNING_MESSAGES.METADATA_BYTE_LIMIT! });"),
  // Warning costs are appended only after fitting and cursor allocation.
  C("s7a-byte-warning-after-fit", [{"file": "packages/core/src/index.ts", "find": "      env.warnings = this.warningsV2([...env.warnings, { code: 'METADATA_BYTE_LIMIT', message: WARNING_MESSAGES.METADATA_BYTE_LIMIT! }]);", "replace": ""}, {"file": "packages/core/src/index.ts", "find": "      return freezeDeliveryState({ topic, rows: cloneFhirValue(rows), start: offset, offset, total: rows.length, limit,", "replace": "      if (byteLimited) env.warnings.push({ code: 'METADATA_BYTE_LIMIT', message: WARNING_MESSAGES.METADATA_BYTE_LIMIT! });\n      return freezeDeliveryState({ topic, rows: cloneFhirValue(rows), start: offset, offset, total: rows.length, limit,"}]),
  // Warning presence and limit_reached stop binding to trusted packing outcome.
  M("s7a-byte-flag-gate-unbound", "packages/core/src/contracts.ts", "        if (env.warnings.some(w => w.code === 'METADATA_BYTE_LIMIT') !== m.byteLimited || env.budget.limit_reached !== m.byteLimited) return fail();", ""),
  // A forged byte flag may contradict the otherwise eligible row count.
  M("s7a-byte-reduction-gate-unbound", "packages/core/src/contracts.ts", "        if (m.byteLimited !== (m.deliveredCount < Math.min(m.limit, m.rows.length - m.start))) return fail();", ""),
  // The metadata gate no longer binds the allocated cursor offset to delivered rows.
  M("s7a-server-offset-gate-unbound", "packages/core/src/contracts.ts", "          if (m.nextOffset !== (more ? m.offset + m.deliveredCount : undefined)) return fail('VALIDATION_CONTEXT_MISMATCH');", ""),
  // Packaging leaf slices 1-4 (proposals/m3b-s8s9-design.md D3): proposed by GPT-6.1-Sol, kill-checked in a scratch copy, registered by root. Unit suite only.
  // Drop required pin completeness. Killing test: quickstart pins: missing JAR hash JDK child and clock refuse
  M("s8-pin-required", "examples/quickstart/manifest.ts", "if (!pinsComplete(value)) throw fault('PIN_MISSING');", "if (false) throw fault('PIN_MISSING');", { suites: ['unit'] }),
  // Hide a moving tag by substituting the stable tag. Killing test: quickstart pins: moving tags and missing commit refuse
  M("s8-pin-stable", "examples/quickstart/manifest.ts", "if (!stableTag(pins.synthea.tag)) throw fault('PIN_UNSTABLE');", "if (!stableTag(pins.synthea.tag)) return freezeCopy({ ...pins, synthea: { ...pins.synthea, tag: GENERATOR_PINS.synthea.tag } });", { suites: ['unit'] }),
  // Permit differing raw regeneration bytes. Killing test: quickstart generation: second raw numeric lexeme change refuses freeze
  M("s8-generation-repeat", "scripts/quickstart/generate-synthea.mjs", "if (!sameExports(first, second)) throw fault('EXPORTS_DIFFER');", "if (false) throw fault('EXPORTS_DIFFER');", { suites: ['unit'] }),
  // Drop literal target confinement. Killing test: quickstart guards: exact target refusals perform zero writes
  M("s8-seed-origin", "examples/quickstart/guards.ts", "if (!exactLoopbackTarget(target, manifest)) throw fault('TARGET_MISMATCH');", "if (false) throw fault('TARGET_MISMATCH');", { suites: ['unit'] }),
  // Drop helper ownership and port association. Killing test: quickstart guards: foreign ownership provenance labels and port association perform zero writes
  M("s8-seed-owner", "examples/quickstart/guards.ts", "if (!ownedInstance(evidence, receipt, manifest)) throw fault('INSTANCE_FOREIGN');", "if (false) throw fault('INSTANCE_FOREIGN');", { suites: ['unit'] }),
  // Drop pinned backend identity. Killing test: quickstart guards: backend index child config software and FHIR mismatch perform zero writes
  M("s8-seed-image", "examples/quickstart/guards.ts", "if (!pinnedBackend(evidence, manifest)) throw fault('BACKEND_MISMATCH');", "if (false) throw fault('BACKEND_MISMATCH');", { suites: ['unit'] }),
  // Check only Patient and Observation freshness. Killing test: quickstart guards: every seeded type missing nonempty partial and reseed state refuses
  M("s8-seed-fresh-all-types", "examples/quickstart/guards.ts", "if (!allSeedTypesEmpty(state.counts, manifest)) throw fault('TARGET_NOT_FRESH');", "if (!patientAndObservationEmpty(state.counts)) throw fault('TARGET_NOT_FRESH');", { suites: ['unit'] }),
  // Drop reviewed fixed target and raw body binding. Killing test: quickstart HTTP: changed body unlisted conditional method and late invalid batch refuse before writes
  M("s8-seed-body", "examples/quickstart/seed-http.ts", "if (!listedPut(request, manifest)) throw fault('SEED_NOT_LISTED');", "if (false) throw fault('SEED_NOT_LISTED');", { suites: ['unit'] }),
  // Treat a redirect response as successful. Killing test: quickstart HTTP: redirects refuse and never follow even same-origin routes
  M("s8-seed-redirect", "examples/quickstart/seed-http.ts", "if (isRedirect(status)) { refuse(fault('REDIRECT_REFUSED')); return; }", "if (false) { refuse(fault('REDIRECT_REFUSED')); return; }", { suites: ['unit'] }),
  // Drop activated proxy configuration refusal. Killing test: quickstart HTTP: activated proxy configuration refuses before requests
  M("s8-seed-proxy", "examples/quickstart/seed-http.ts", "if (proxyRoutingActive(environment)) throw fault('PROXY_REFUSED');", "if (false) throw fault('PROXY_REFUSED');", { suites: ['unit'] }),
  // Let HAPI answer the oracle's counts from its cached pre-seed search. Killing tests: oracle counts bypass HAPI search-result reuse of the pre-seed zero counts; quickstart HTTP: owned fresh positive sends only listed fixed PUTs and bounded read routes
  M("s8-seed-no-cache", "examples/quickstart/seed-http.ts", ": { 'cache-control': 'no-cache' })", ": {})", { suites: ['unit'] }),
  // Permit a relative launch tuple. Killing test: quickstart configs: relative node bin or config is refused
  M("s8-config-absolute", "examples/quickstart/configs.ts", "if (!absoluteLaunchTuple(tuple)) throw fault('LAUNCH_NOT_ABSOLUTE');", "if (false) throw fault('LAUNCH_NOT_ABSOLUTE');", { suites: ['unit'] }),
  // Remove POSIX argv quoting. Killing test: quickstart configs: POSIX command delivers inert exact argv through a recording executable
  M("s8-config-quote", "examples/quickstart/configs.ts", "return quotePosixArgument(value);", "return value;", { suites: ['unit'] }),
  // Permit cleanup after foreign inspection evidence. Killing test: quickstart down: foreign container volume project and missing provenance cause zero cleanup
  M("s8-down-owner", "examples/quickstart/down.ts", "if (!ownsCleanupTargets(state, inspected, manifest)) throw fault('CLEANUP_FOREIGN');", "if (false) throw fault('CLEANUP_FOREIGN');", { suites: ['unit'] }),
  // Reset reported elapsed time at the latest attempt. Killing test: quickstart timing: failure assistance retry and cleanup retain overall elapsed time
  M("s8-timer-retry-reset", "examples/quickstart/timing.ts", "const elapsed = monotonicNow() - started;", "const elapsed = monotonicNow() - attemptStarted;", { suites: ['unit'] }),
  // Permit events carrying extra private fields. Killing test: quickstart timing: event schema rejects arbitrary prose paths ids and extra fields
  M("s8-timer-event-closed", "examples/quickstart/timing.ts", "if (!closedTimingEvent(event)) throw fault('TIMING_EVENT_INVALID');", "if (false) throw fault('TIMING_EVENT_INVALID');", { suites: ['unit'] }),
  // Accept an unreviewed additional regular file. Killing test: package inventory: unexpected approved-boundary file is refused
  M("s9-inventory-extra", "scripts/package-inventory.ts", "if (unexpected.length) throw fault('PACK_UNEXPECTED');", "if (false) throw fault('PACK_UNEXPECTED');", { suites: ['unit'] }),
  // Accept an omitted required asset. Killing test: package inventory: each required file missing from both inventories is refused
  M("s9-inventory-missing", "scripts/package-inventory.ts", "if (missing.length) throw fault('PACK_MISSING');", "if (false) throw fault('PACK_MISSING');", { suites: ['unit'] }),
  // Accept unsafe tar headers before exposing bodies. Killing test: package inventory: unsafe paths links PAX types and duplicate headers refuse before any bodies return
  M("s9-tar-confinement", "scripts/package-inventory.ts", "if (!safeRegularTarEntry(entry, seen)) throw fault('TAR_ENTRY_UNSAFE');", "if (false) throw fault('TAR_ENTRY_UNSAFE');", { suites: ['unit'] }),
  // Omit the independent npm versus tar comparison. Killing test: package inventory: npm list and tar mode size or membership disagreement refuses
  M("s9-tar-two-inventories", "scripts/package-inventory.ts", "if (!sameInventory(npmFiles, tarFiles)) throw fault('PACK_LIST_MISMATCH');", "if (false) throw fault('PACK_LIST_MISMATCH');", { suites: ['unit'] }),
  // Accept changed versions or observed integrity. Killing test: package tree: changed transitive version or observed integrity fails approval
  M("s9-tree-version", "scripts/package-tree.ts", "if (actualTreeHash !== approvedTreeHash) throw fault('TREE_MISMATCH');", "if (false) throw fault('TREE_MISMATCH');", { suites: ['unit'] }),
  // Omit the simulation end date and permit wall-clock simulation. Killing test: quickstart generation: end date and reference date are pinned in both runs
  M("s8-generation-end-date", "scripts/quickstart/generate-synthea.mjs", "'-r', g.referenceDate, '-e', g.endDate, '-c'", "'-r', g.referenceDate, '-c'", { suites: ['unit'] }),
  // Re-enable wall-clock/random-UUID metadata in the effective properties. Killing test: quickstart generation: properties disable nondeterministic metadata export
  M("s8-generation-metadata-export", "scripts/quickstart/generate-synthea.mjs", ".map(([key, value]) => `${key}=${value}\\n`).join('');", ".map(([key, value]) => `${key}=${key === 'exporter.metadata.export' ? true : value}\\n`).join('');", { suites: ['unit'] }),
  // Packaging slice 6 Synthea transform guards (root-written, reviewed by GPT-6.1-Sol in three rounds); each killed by a named test in tests/quickstart-transform.test.ts. Unit suite only.
  M("t6-lossless-parse", "scripts/quickstart/transform-synthea.ts", "try { bundle = parseFhirJson(utf8.decode(file.bytes)); }", "try { bundle = JSON.parse(utf8.decode(file.bytes)); }", { suites: ['unit'] }),
  M("t6-strict-utf8", "scripts/quickstart/transform-synthea.ts", "new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })", "new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })", { suites: ['unit'] }),
  M("t6-input-bound", "scripts/quickstart/transform-synthea.ts", "if (ordered.reduce((n, f) => n + f.bytes.byteLength, 0) > selection.maxInputBytes) fault('INPUT_TOO_LARGE');", "", { suites: ['unit'] }),
  M("t6-urn-unresolved", "scripts/quickstart/transform-synthea.ts", "return entries.get(reference) ?? fault('REFERENCE_UNRESOLVED');", "return entries.get(reference) ?? entries.values().next().value!;", { suites: ['unit'] }),
  M("t6-identifier-unresolved", "scripts/quickstart/transform-synthea.ts", "if (!hits || hits.size === 0) return fault('REFERENCE_UNRESOLVED');", "if (!hits || hits.size === 0) return patient;", { suites: ['unit'] }),
  M("t6-identifier-ambiguous", "scripts/quickstart/transform-synthea.ts", "if (hits.size > 1) return fault('REFERENCE_AMBIGUOUS');", "", { suites: ['unit'] }),
  M("t6-identifier-grammar", "scripts/quickstart/transform-synthea.ts", "const IDENTIFIER_REFERENCE = /^([A-Z][A-Za-z]+)\\?identifier=([^|&,$%\\\\?#\\s]+)\\|([^|&,$%\\\\?#\\s]+)$/;", "const IDENTIFIER_REFERENCE = /^([A-Z][A-Za-z]+)\\?identifier=(.+)\\|(.+)$/;", { suites: ['unit'] }),
  M("t6-percent-escapes", "scripts/quickstart/transform-synthea.ts", "([^|&,$%\\\\?#\\s]+)\\|([^|&,$%\\\\?#\\s]+)$/;", "([^|&,$\\\\?#\\s]+)\\|([^|&,$\\\\?#\\s]+)$/;", { suites: ['unit'] }),
  M("t6-reference-foreign", "scripts/quickstart/transform-synthea.ts", "if (!IDENTIFIER_REFERENCE.test(reference)) return fault('REFERENCE_FOREIGN');", "if (!IDENTIFIER_REFERENCE.test(reference)) return patient;", { suites: ['unit'] }),
  M("t6-contained-refused", "scripts/quickstart/transform-synthea.ts", "if (resource.contained !== undefined) fault('CONTAINED_REFUSED');", "", { suites: ['unit'] }),
  M("t6-local-reference", "scripts/quickstart/transform-synthea.ts", "if (reference.startsWith('#')) return fault('CONTAINED_REFUSED');", "if (reference.startsWith('#')) return patient;", { suites: ['unit'] }),
  M("t6-logical-reference", "scripts/quickstart/transform-synthea.ts", "else if (isRecord(node.identifier)) fault('REFERENCE_LOGICAL');", "", { suites: ['unit'] }),
  M("t6-reference-type", "scripts/quickstart/transform-synthea.ts", "if (node.type !== undefined && node.type !== target.type) fault('REFERENCE_TYPE_MISMATCH');", "", { suites: ['unit'] }),
  M("t6-stray-urn", "scripts/quickstart/transform-synthea.ts", "if (key !== 'reference' && /urn:uuid:/i.test(node)) fault('REFERENCE_FOREIGN');", "", { suites: ['unit'] }),
  M("t6-extension-walk", "scripts/quickstart/transform-synthea.ts", "for (const [k, child] of Object.entries(node)) if (k !== 'reference') visit(child, k);", "for (const [k, child] of Object.entries(node)) if (k !== 'reference' && k !== 'extension') visit(child, k);", { suites: ['unit'] }),
  M("t6-foreign-patient", "scripts/quickstart/transform-synthea.ts", "if (entry.type === 'Patient' && url !== patient.url) fault('FOREIGN_PATIENT');", "", { suites: ['unit'] }),
  M("t6-patient-linked", "scripts/quickstart/transform-synthea.ts", "if (PATIENT_LINKED.has(entry.type) && subjectOf(entry.resource)?.url !== patient.url) fault('FOREIGN_PATIENT');", "", { suites: ['unit'] }),
  M("t6-type-allowlist", "scripts/quickstart/transform-synthea.ts", "if (!(SEED_TYPES as readonly string[]).includes(entry.type)) fault('TYPE_NOT_ALLOWED');", "", { suites: ['unit'] }),
  M("t6-slice-rule", "scripts/quickstart/transform-synthea.ts", "if (SLICE_TYPES.has(entry.type) && !eligible.has(url)) fault('SLICE_VIOLATION');", "", { suites: ['unit'] }),
  M("t6-living-only", "scripts/quickstart/transform-synthea.ts", "e.resource.deceasedBoolean !== true && e.resource.deceasedDateTime === undefined", "e.resource.deceasedBoolean !== true", { suites: ['unit'] }),
  M("t6-window-end-open", "scripts/quickstart/transform-synthea.ts", "iv[0] >= windowStart && iv[1] <= windowEnd", "iv[0] >= windowStart && iv[0] <= windowEnd", { suites: ['unit'] }),
  M("t6-window-utc", "scripts/quickstart/transform-synthea.ts", "- (offset === 'Z' ? 0 : sign * (oh * 60 + om) * 60_000)", "", { suites: ['unit'] }),
  M("t6-date-validity", "scripts/quickstart/transform-synthea.ts", "if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > days) return fault('DATE_INVALID');", "", { suites: ['unit'] }),
  M("t6-period-reversed", "scripts/quickstart/transform-synthea.ts", "if (start && end && (end.lo < start.lo || (end.lo === start.lo && digits(end.fraction, start.fraction) < 0))) return fault('DATE_INVALID');", "", { suites: ['unit'] }),
  M("t6-period-touching", "scripts/quickstart/transform-synthea.ts", "if (start && end && (end.lo < start.lo ||", "if (start && end && (end.hi < start.lo ||", { suites: ['unit'] }),
  M("t6-period-submillisecond", "scripts/quickstart/transform-synthea.ts", " || (end.lo === start.lo && digits(end.fraction, start.fraction) < 0)", "", { suites: ['unit'] }),
  M("t6-period-fraction-truncated", "scripts/quickstart/transform-synthea.ts", "const x = a.padEnd(n, '0'), y = b.padEnd(n, '0');", "const x = a.padEnd(9, '0').slice(0, 9), y = b.padEnd(9, '0').slice(0, 9);", { suites: ['unit'] }),
  M("t6-offset-max", "scripts/quickstart/transform-synthea.ts", "om > 59 || oh * 60 + om > 14 * 60)", "om > 59 || oh > 14)", { suites: ['unit'] }),
  M("t6-year-0-99", "scripts/quickstart/transform-synthea.ts", "const t = new Date(0); t.setUTCFullYear(y, monthIndex, d); t.setUTCHours(h, mi, s, ms); return t.getTime();", "return Date.UTC(y, monthIndex, d, h, mi, s, ms);", { suites: ['unit'] }),
  M("t6-period-selection", "scripts/quickstart/transform-synthea.ts", "return start && end ? [start.lo, end.hi] : undefined;", "return undefined;", { suites: ['unit'] }),
  M("t6-partial-dates", "scripts/quickstart/transform-synthea.ts", "const hi = m[3] ? utcMs(y, mo - 1, d + 1) : m[2] ? utcMs(y, mo, 1) : utcMs(y + 1, 0, 1);", "const hi = utcMs(y, mo - 1, d + 1);", { suites: ['unit'] }),
  M("t6-report-all-results", "scripts/quickstart/transform-synthea.ts", "e.resource.result.every(r => observations.has(", "e.resource.result.some(r => observations.has(", { suites: ['unit'] }),
  M("t6-result-unresolved", "scripts/quickstart/transform-synthea.ts", "(target(r) ?? fault('REFERENCE_UNRESOLVED')).url)", "target(r)?.url ?? '')", { suites: ['unit'] }),
  M("t6-selection-logical", "scripts/quickstart/transform-synthea.ts", "    if (isRecord(value.identifier)) return fault('REFERENCE_LOGICAL');\n    return undefined;", "    return undefined;", { suites: ['unit'] }),
  M("t6-lab-category", "scripts/quickstart/transform-synthea.ts", "e.type === type && hasCoding(e.resource.category, category)\n    && inWindow(e.resource)", "e.type === type\n    && inWindow(e.resource)", { suites: ['unit'] }),
  M("t6-own-subject", "scripts/quickstart/transform-synthea.ts", "&& inWindow(e.resource) && subjectOf(e.resource)?.url === patient.url;", "&& inWindow(e.resource);", { suites: ['unit'] }),
  M("t6-drop-government-ids", "scripts/quickstart/transform-synthea.ts", "const kind = governmentIdentifierKind(identifier);", "const kind = undefined as 'SS' | undefined;", { suites: ['unit'] }),
  M("t6-gov-ssn-system", "scripts/quickstart/transform-synthea.ts", "if (identifier.system === 'http://hl7.org/fhir/sid/us-ssn') return 'SS';", "", { suites: ['unit'] }),
  M("t6-gov-passport-system", "scripts/quickstart/transform-synthea.ts", "if (identifier.system === 'http://hl7.org/fhir/sid/passport-USA') return 'PPN';", "", { suites: ['unit'] }),
  M("t6-gov-dl-oid", "scripts/quickstart/transform-synthea.ts", "if (typeof identifier.system === 'string' && identifier.system.startsWith('urn:oid:2.16.840.1.113883.4.3.')) return 'DL';", "", { suites: ['unit'] }),
  M("t6-gov-type-only", "scripts/quickstart/transform-synthea.ts", "if (!isRecord(identifier)) return undefined;\n  const typed", "if (!isRecord(identifier) || identifier.system === undefined) return undefined;\n  const typed", { suites: ['unit'] }),
  M("t6-gov-type-without-system", "scripts/quickstart/transform-synthea.ts", "(c.system === IDENTIFIER_TYPE_SYSTEM || c.system === undefined)", "c.system === IDENTIFIER_TYPE_SYSTEM", { suites: ['unit'] }),
  M("t6-identifier-residue", "scripts/quickstart/transform-synthea.ts", "if (residue.some(pattern => strings.some(text => pattern.test(text)))) fault('IDENTIFIER_RESIDUE');", "", { suites: ['unit'] }),
  M("t6-residue-decoding", "scripts/quickstart/transform-synthea.ts", "key === 'div' ? [decodeEntities(value), decodeEntities(xhtmlText(value))] : [value]", "[value]", { suites: ['unit'] }),
  M("t6-residue-attributes", "scripts/quickstart/transform-synthea.ts", "[decodeEntities(value), decodeEntities(xhtmlText(value))]", "[decodeEntities(xhtmlText(value))]", { suites: ['unit'] }),
  M("t6-residue-quoted-tags", "scripts/quickstart/transform-synthea.ts", "if (quote) { if (c === quote) quote = undefined; } else if (c === '\"' || c === \"'\") quote = c; else if (c === '>')", "if (c === '>')", { suites: ['unit'] }),
  M("t6-xhtml-comments", "scripts/quickstart/transform-synthea.ts", "    if (markup.startsWith('<!--', i)) {", "    if (false) {", { suites: ['unit'] }),
  M("t6-xhtml-other-markup", "scripts/quickstart/transform-synthea.ts", "    if (markup[i + 1] === '!' || markup[i + 1] === '?') return fault('EXPORT_INVALID');", "", { suites: ['unit'] }),
  M("t6-entity-range", "scripts/quickstart/transform-synthea.ts", "if (!Number.isSafeInteger(point) || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return fault('EXPORT_INVALID');", "", { suites: ['unit'] }),
  M("t6-clone-exponent", "scripts/quickstart/transform-synthea.ts", "const resource = cloneFhirValue(source);", "const resource = JSON.parse(stringifyFhir(source).replace(/1E\\+02/g, \"100\")) as Rec;", { suites: ['unit'] }),
  M("t6-precision-walk", "scripts/quickstart/transform-synthea.ts", "if (containsPrecisionFault(resource)) fault('PRECISION_LOST');", "", { suites: ['unit'] }),
  M("t6-dependency-order", "scripts/quickstart/transform-synthea.ts", "while (at < ready.length && before(ready[at]!, referrer) < 0) at++;", "", { suites: ['unit'] }),
  M("t6-cycle", "scripts/quickstart/transform-synthea.ts", "if (order.length !== seed.size) fault('REFERENCE_CYCLE');", "", { suites: ['unit'] }),
  M("t6-seed-bound", "scripts/quickstart/transform-synthea.ts", "if (seed.size > selection.maxResources) fault('SEED_TOO_LARGE');", "", { suites: ['unit'] }),
  M("t6-byte-bound", "scripts/quickstart/transform-synthea.ts", "if (ndjsonBytes > selection.maxBytes) fault('SEED_TOO_LARGE');", "", { suites: ['unit'] }),
  M("t6-newline-bytes", "scripts/quickstart/transform-synthea.ts", "ndjsonBytes += Buffer.byteLength(body, 'utf8') + 1;", "ndjsonBytes += Buffer.byteLength(body, 'utf8');", { suites: ['unit'] }),
  M("t6-input-order", "scripts/quickstart/transform-synthea.ts", "const ordered = [...files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);", "const ordered = [...files];", { suites: ['unit'] }),
  M("t6-input-hash", "scripts/quickstart/transform-synthea.ts", "sha256: sha256(f.bytes) })),", "sha256: sha256(Buffer.from(f.bytes).toString('latin1')) })),", { suites: ['unit'] }),
  M("t6-duplicate-id", "scripts/quickstart/transform-synthea.ts", "if (entries.has(url)) fault('DUPLICATE_ID');", "", { suites: ['unit'] }),
  M("t6-fullurl-binding", "scripts/quickstart/transform-synthea.ts", "|| raw.fullUrl !== `urn:uuid:${resource.id}`) fault('EXPORT_INVALID');", ") fault('EXPORT_INVALID');", { suites: ['unit'] }),
  M("t6-cli-out-not-empty", "scripts/quickstart/transform-synthea.ts", "if (existsSync(outDir) && (!lstatSync(outDir).isDirectory() || readdirSync(outDir).length)) return failed('OUT_NOT_EMPTY');", "", { suites: ['unit'] }),
  M("t6-cli-size-first", "scripts/quickstart/transform-synthea.ts", "if (sizes.reduce((n, size) => n + size, 0) > QUICKSTART_SELECTION.maxInputBytes) return failed('INPUT_TOO_LARGE');", "", { suites: ['unit'] }),
  M("t6-cli-regular-files", "scripts/quickstart/transform-synthea.ts", "if (json.some(d => !d.isFile())) return failed('EXPORT_INVALID');", "", { suites: ['unit'] }),
  // Admit helper or missing recipes as active support. Killing test: S7 support compact recipes follow the active gateway projector for every row
  M('s7-support-active-recipe', 'packages/core/src/support.ts', '    if (row.compact_recipe !== expectedRecipe) issues.push(`${row.resource_type}: compact_recipe disagrees with gateway projection`);\n', '', { suites: ['unit'] }),
  // Admit a false patient selector, including Condition beneficiary. Killing test: S7 support patient-link drift is rejected, including Condition beneficiary
  M('s7-support-patient-link', 'packages/core/src/support.ts', '    if (row.patient_link !== patientLinkForType(row.resource_type)) issues.push(`${row.resource_type}: patient_link disagrees with privacy enforcement`);\n', '', { suites: ['unit'] }),
  // Admit any denominator identity drift. Killing test: S7 support denominator identity drift is rejected for every pinned field
  M('s7-support-denominator-identity', 'packages/core/src/support.ts', '    if (candidate.denominator[key] !== denominator[key]) issues.push(`denominator.${key} disagrees with generated R4 index`);\n', '', { suites: ['unit'] }),
  // Omit only the denominator version from identity checking. Killing test: S7 support denominator identity drift is rejected for every pinned field
  M('s7-support-denominator-version', 'packages/core/src/support.ts', "['package', 'version', 'source_sha256', 'resource_type_count'] as const", "['package', 'source_sha256', 'resource_type_count'] as const", { suites: ['unit'] }),
  // Ignore the identity of deleted tracked inputs. Killing test: candidate binding records tracked deletions distinctly from empty files and other paths
  M('s7-binding-deletion-unbound', 'scripts/mutation-guards.mjs', '      hash.update(`${Buffer.byteLength(path)}:${path}deleted:`);\n', '', { suites: ['unit'] }),
  // Ignore required executable interactions. Killing test: doctor report: each missing workflow interaction is not-ready
  M("s8-doctor-ready", "packages/server/src/doctor.ts", "if (input.workflow.patient !== 'ready' || input.workflow.observation !== 'ready') faults.add('WORKFLOW_TYPE_UNAVAILABLE');", "if (false) faults.add('WORKFLOW_TYPE_UNAVAILABLE');", { suites: ['unit'] }),
  // Bypass the closed DTO boundary. Killing test: doctor DTO: unsafe strings, enum drift, and arbitrary fault messages refuse
  M("s8-doctor-dto", "packages/server/src/doctor.ts", "if (!closedDoctorInput(input)) return invalidInput();", "if (false) return invalidInput();", { suites: ['unit'] }),
  // Ignore metadata refusal states. Killing test: doctor report: metadata and FHIR failures are not-ready; operator faults take precedence
  C("s8-doctor-metadata", [{"file": "packages/server/src/doctor.ts", "find": "if (input.metadata.status === 'unavailable') faults.add('METADATA_UNAVAILABLE');", "replace": "if (false) faults.add('METADATA_UNAVAILABLE');"}, {"file": "packages/server/src/doctor.ts", "find": "if (input.metadata.status === 'invalid') faults.add('METADATA_INVALID');", "replace": "if (false) faults.add('METADATA_INVALID');"}], { suites: ['unit'] }),
  // Admit other FHIR versions as ready. Killing test: doctor report: metadata and FHIR failures are not-ready; operator faults take precedence
  M("s8-doctor-fhir", "packages/server/src/doctor.ts", "if (input.metadata.status === 'ready' && input.metadata.fhir !== '4.0.1') faults.add('FHIR_VERSION_UNSUPPORTED');", "if (false) faults.add('FHIR_VERSION_UNSUPPORTED');", { suites: ['unit'] }),
  // Ignore unsupported runtime facts. Killing test: doctor report: metadata and FHIR failures are not-ready; operator faults take precedence
  M("s8-doctor-runtime", "packages/server/src/doctor.ts", "if (input.runtime.lossless !== 'ok' || !runtimeVersionAdmitted(input.runtime.node)) faults.add('RUNTIME_UNSUPPORTED');", "if (false) faults.add('RUNTIME_UNSUPPORTED');", { suites: ['unit'] }),
  // Downgrade operator faults to source-not-ready exits. Killing test: doctor report: metadata and FHIR failures are not-ready; operator faults take precedence
  M("s8-doctor-fault-priority", "packages/server/src/doctor.ts", "[...faults].some(fault => OPERATOR_FAULTS.includes(fault))", "[...faults].some(_fault => false)", { suites: ['unit'] }),
  // Replace targeted metadata with a clinical probe. Killing test: doctor CLI: only metadata and auth requests; partial summary with targeted Patient and Observation is ready
  M("s8-doctor-clinical", "packages/server/src/main.ts", "return gateway.execute('fhir_capabilities', { topic: 'resource', resource_type: type });", "return gateway.execute('fhir_read', { resource_type: type, id: 'doctor-probe' });", { suites: ['unit'] }),
  // Overclaim generic syntax as execution proof. Killing test: doctor CLI: bundled synthetic source is ready with safe profile limitation
  M("s8-doctor-proof", "packages/server/src/main.ts", "proof: profile.id !== 'generic-r4' && profile.proving ? 'qualified' : 'unproved'", "proof: profile.proving ? 'qualified' : 'unproved'", { suites: ['unit'] }),
  // Report an uncapped output default. Killing test: doctor policy: normalized values agree with gateway execution and cannot be changed
  M("s8-doctor-policy", "packages/core/src/index.ts", "this.operatorPolicy = Object.freeze({ defaultFormat: 'fhir', delivery: this.deliveryProfile, defaultBytes: this.defaultBytes,", "this.operatorPolicy = Object.freeze({ defaultFormat: 'fhir', delivery: this.deliveryProfile, defaultBytes: 24576,", { suites: ['unit'] }),
  // Trust altered runtime JSON bytes. Killing test: startup: every missing or altered runtime asset refuses before main with empty stdout
  M("s9-startup-artifacts", "packages/server/src/startup.ts", "if (sha256(bytes) !== release.assets[label as RuntimeAsset].sha256) throw new StartupFault('ASSET_INVALID', label as RuntimeAsset);", "if (false) throw new StartupFault('ASSET_INVALID', label as RuntimeAsset);", { suites: ['unit'] }),
  // Import main before checking missing runtime assets. Killing test: startup: every missing or altered runtime asset refuses before main with empty stdout
  M("s9-bootstrap-assets", "packages/server/src/cli.ts", "    checkRuntimeAssets(release);", "    // diagnostic: asset validation bypassed", { suites: ['unit'] }),
  // Skip the runtime admission floor. Killing test: startup: runtime floor and each lossless primitive fail closed; help and version stay available
  M("s9-runtime-floor", "packages/server/src/startup.ts", "if (!runtimeVersionAdmitted(process.versions.node, release.runtime.floor)) throw new StartupFault('RUNTIME_UNSUPPORTED');", "if (false) throw new StartupFault('RUNTIME_UNSUPPORTED');", { suites: ['unit'] }),
  // Bypass raw JSON feature and roundtrip checks together. Killing test: startup: runtime floor and each lossless primitive fail closed; help and version stay available
  C("s9-runtime-raw-json", [{"file": "packages/server/src/startup.ts", "find": "if (typeof host.rawJSON !== 'function' || typeof host.isRawJSON !== 'function') throw new StartupFault('RUNTIME_UNSUPPORTED');", "replace": "if (false) throw new StartupFault('RUNTIME_UNSUPPORTED');"}, {"file": "packages/server/src/startup.ts", "find": "if (source !== '1.0' || !host.isRawJSON(host.rawJSON('1.0')) || JSON.stringify(host.rawJSON('1.0')) !== '1.0') throw new Error();", "replace": "if (source !== '1.0') throw new Error();"}], { suites: ['unit'] }),
  // Trust a parser without numeric source text. Killing test: startup: runtime floor and each lossless primitive fail closed; help and version stay available
  M("s9-runtime-source-text", "packages/server/src/startup.ts", "source !== '1.0' || !host.isRawJSON", "false || !host.isRawJSON", { suites: ['unit'] }),
  // Interpolate an arbitrary import exception into diagnostics. Killing test: startup: a main import failure is contained with no stack or stdout
  M("s9-startup-safe-fault", "packages/server/src/startup.ts", "return `fireboat: ${fault.code}${fault.label ? ` ${fault.label}` : ''}\\n`;", "return `fireboat: ${String(error)}\\n`;", { suites: ['unit'] }),
  // Accept unknown release metadata fields. Killing test: release: manifest refuses unknown fields, unsafe paths, pin ranges and malformed cells
  M("s9-release-dto", "packages/server/src/release.ts", "!record(value) || !keys(value, ['name', 'packageName', 'version', 'schema', 'catalog', 'bin', 'assets', 'productionDependencies', 'runtime'])", "!record(value)", { suites: ['unit'] }),
  // Accept a substituted runtime asset path. Killing test: release: manifest refuses unknown fields, unsafe paths, pin ranges and malformed cells
  M("s9-release-asset-path", "packages/server/src/release.ts", "asset.path !== path || ", "", { suites: ['unit'] }),
  // Accept production dependency ranges instead of pins. Killing test: release: manifest refuses unknown fields, unsafe paths, pin ranges and malformed cells
  M("s9-release-pins", "packages/server/src/release.ts", "if (!Object.entries(value.productionDependencies).every(([name, pin]) => token(name, /^(?:@[a-z0-9_-]+\\/)?[a-z0-9._-]+$/) && token(pin, SEMVER))) return false;", "if (false) return false;", { suites: ['unit'] }),
  // Record an untested platform or architecture. Killing test: release: recorded cells require exact Node, platform and architecture
  M("s9-release-cells", "packages/server/src/release.ts", "recorded.node === cell.node && recorded.platform === cell.platform && recorded.arch === cell.arch", "recorded.node === cell.node", { suites: ['unit'] }),
  // Accept ambiguous schema or catalog declarations. Killing test: release generator: determinism and source scalar validation
  M("s9-release-scalar", "packages/server/src/release.ts", "if (matches.length !== 1) throw new StartupFault('ASSET_INVALID', 'release');", "if (false) throw new StartupFault('ASSET_INVALID', 'release');", { suites: ['unit'] }),
  // Ignore exact release identity equality. Killing test: release checker: identical version suffix cannot hide identity, lock, bin or asset drift
  M("s9-version-equality", "scripts/check-dist-identity.mjs", "if (!sameReleaseIdentity(expected, actual)) throw new Error('RELEASE_IDENTITY_MISMATCH');", "if (false) throw new Error('RELEASE_IDENTITY_MISMATCH');", { suites: ['unit'] }),
  // Omit packaging generators from executable build binding. Killing test: startup: isolation build stamp binds every packaging generator
  M('s9-build-generators', 'tests/isolation/build.ts', '  files.push(...BUILD_STEPS.map(path => join(root, path)).filter(path => existsSync(path)));\n', '', { suites: ['unit'] }),
  // Packaging slice 6 quickstart edge-merge guards (root-written, revised after two GPT-6.1-Sol reviews); each killed by a named test in tests/quickstart-edges.test.ts or tests/quickstart-fixtures.test.ts. Unit suite only.
  M("s8-edges-seed-hash", "scripts/quickstart/edges.ts", "|| typeof seed.ndjson !== 'string' || sha256(seed.ndjson) !== m.ndjson_sha256) fault('SEED_INVALID');", "|| typeof seed.ndjson !== 'string') fault('SEED_INVALID');", { suites: ['unit'] }),
  M("s8-edges-seed-rows", "scripts/quickstart/edges.ts", "if (r.sha256 !== sha256(line) || r.bytes !== Buffer.byteLength(line, 'utf8') || r.origin !== 'natural') fault('SEED_INVALID');", "if (r.bytes !== Buffer.byteLength(line, 'utf8') || r.origin !== 'natural') fault('SEED_INVALID');", { suites: ['unit'] }),
  M("s8-edges-seed-origin", "scripts/quickstart/edges.ts", "|| r.origin !== 'natural') fault('SEED_INVALID');", ") fault('SEED_INVALID');", { suites: ['unit'] }),
  M("s8-edges-seed-count", "scripts/quickstart/edges.ts", "if (lines.length !== m.resources.length) fault('SEED_INVALID');", "", { suites: ['unit'] }),
  M("s8-edges-seed-window", "scripts/quickstart/edges.ts", "if (!(windowStart < windowEnd) || !Number.isSafeInteger(m.selection.maxResources)", "if (!Number.isSafeInteger(m.selection.maxResources)", { suites: ['unit'] }),
  M("s8-edges-seed-bounds", "scripts/quickstart/edges.ts", "if (m.resources.length > m.selection.maxResources || Buffer.byteLength(seed.ndjson, 'utf8') > m.selection.maxBytes) fault('SEED_INVALID');", "", { suites: ['unit'] }),
  M("s8-edges-seed-row-shape", "scripts/quickstart/edges.ts", "if (!isRecord(row) || !exactKeys(row, ['type', 'id', 'bytes', 'sha256', 'origin']) || !resourceType(row.type) || !resourceId(row.id)) fault('SEED_INVALID');", "if (!isRecord(row)) fault('SEED_INVALID');", { suites: ['unit'] }),
  M("s8-edges-seed-body-identity", "scripts/quickstart/edges.ts", "if (!isRecord(body) || body.resourceType !== r.type || body.id !== r.id) fault('SEED_INVALID');", "if (!isRecord(body)) fault('SEED_INVALID');", { suites: ['unit'] }),
  M("s8-edges-seed-contract", "scripts/quickstart/edges.ts", "  checkSeedContract(bodies, m);\n", "", { suites: ['unit'] }),
  M("s8-edges-seed-fixed-code", "scripts/quickstart/edges.ts", "try { return checkSeed(seed); } catch (error) { if (error instanceof EdgeError) throw error; return fault('SEED_INVALID'); }", "return checkSeed(seed);", { suites: ['unit'] }),
  M("s8-edges-strict-utf8", "scripts/quickstart/edges.ts", "try { file = parseFhirJson(new TextDecoder('utf-8', { fatal: true }).decode(edgesBytes)); }", "try { file = parseFhirJson(new TextDecoder('utf-8', { fatal: false }).decode(edgesBytes)); }", { suites: ['unit'] }),
  M("s8-edges-lossless-parse", "scripts/quickstart/edges.ts", "try { file = parseFhirJson(new TextDecoder('utf-8', { fatal: true }).decode(edgesBytes)); }", "try { file = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(edgesBytes)); }", { suites: ['unit'] }),
  M("s8-edges-closed-file", "scripts/quickstart/edges.ts", "\n    || Object.keys(file).some(k => !['schema', 'note', 'resources'].includes(k))", "\n   ", { suites: ['unit'] }),
  M("s8-edges-entry-bound", "scripts/quickstart/edges.ts", "|| file.resources.length > 64) fault('EDGES_INVALID');", ") fault('EDGES_INVALID');", { suites: ['unit'] }),
  M("s8-edges-closed-entry", "scripts/quickstart/edges.ts", "if (!isRecord(entry) || Object.keys(entry).some(k => !['purpose', 'resource'].includes(k)) || typeof entry.purpose !== 'string'", "if (!isRecord(entry) || typeof entry.purpose !== 'string'", { suites: ['unit'] }),
  M("s8-edges-id", "scripts/quickstart/edges.ts", "const EDGE_ID = /^qs-edge-[a-z0-9-]{1,48}$/;", "const EDGE_ID = /^[A-Za-z0-9-]{1,64}$/;", { suites: ['unit'] }),
  M("s8-edges-type", "scripts/quickstart/edges.ts", "const EDGE_TYPES = ['Patient', 'Observation', 'DocumentReference'] as const;", "const EDGE_TYPES = ['Patient', 'Observation', 'DocumentReference', 'Condition'] as const;", { suites: ['unit'] }),
  M("s8-edges-duplicate", "scripts/quickstart/edges.ts", "if (edges.has(key) || natural.has(key)) fault('EDGE_DUPLICATE');", "if (natural.has(key)) fault('EDGE_DUPLICATE');", { suites: ['unit'] }),
  M("s8-edges-duplicate-natural", "scripts/quickstart/edges.ts", "if (edges.has(key) || natural.has(key)) fault('EDGE_DUPLICATE');", "if (edges.has(key)) fault('EDGE_DUPLICATE');", { suites: ['unit'] }),
  M("s8-edges-meta-contained", "scripts/quickstart/edges.ts", "if ('contained' in resource || 'meta' in resource) fault('EDGES_INVALID');", "", { suites: ['unit'] }),
  M("s8-edges-patient-single", "scripts/quickstart/edges.ts", "if (patients.length > 1 || patients.some(([, r]) => 'identifier' in r || 'link' in r)) fault('EDGE_PATIENT_INVALID');", "if (patients.some(([, r]) => 'identifier' in r || 'link' in r)) fault('EDGE_PATIENT_INVALID');", { suites: ['unit'] }),
  M("s8-edges-patient-identifier", "scripts/quickstart/edges.ts", "if (patients.length > 1 || patients.some(([, r]) => 'identifier' in r || 'link' in r)) fault('EDGE_PATIENT_INVALID');", "if (patients.length > 1) fault('EDGE_PATIENT_INVALID');", { suites: ['unit'] }),
  M("s8-edges-shape", "scripts/quickstart/edges.ts", "for (const resource of edges.values()) if (!closed(EDGE_SHAPES[resource.resourceType as string]!)(resource)) fault('EDGE_SHAPE_INVALID');", "", { suites: ['unit'] }),
  M("s8-edges-shape-closed", "scripts/quickstart/edges.ts", "&& Object.entries(value).every(([key, child]) => Object.hasOwn(fields, key) && fields[key]!(child));", "&& Object.entries(value).every(([key, child]) => !Object.hasOwn(fields, key) || fields[key]!(child));", { suites: ['unit'] }),
  M("s8-edges-shape-text", "scripts/quickstart/edges.ts", "const text: Check = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;", "const text: Check = value => typeof value === 'string' && value.length <= 1024;", { suites: ['unit'] }),
  M("s8-edges-shape-uri", "scripts/quickstart/edges.ts", "const absoluteUri: Check = value => text(value) && /^(?:https?:\\/\\/[^\\s/]+[^\\s]*|urn:(?:oid|uuid):[^\\s]+)$/.test(value as string);", "const absoluteUri: Check = text;", { suites: ['unit'] }),
  M("s8-edges-shape-nonempty-list", "scripts/quickstart/edges.ts", "const list = (item: Check): Check => value => Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(item);", "const list = (item: Check): Check => value => Array.isArray(value) && value.length <= 16 && value.every(item);", { suites: ['unit'] }),
  M("s8-edges-reference-target", "scripts/quickstart/edges.ts", "if (typeof target === 'string' && edges.has(target)) return target;", "if (typeof target === 'string') return target;", { suites: ['unit'] }),
  M("s8-edges-subject-required", "scripts/quickstart/edges.ts", "const subject = isRecord(resource.subject) ? resolveTarget(resource.subject.reference) : fault('EDGE_SUBJECT_INVALID');", "const subject = isRecord(resource.subject) ? resolveTarget(resource.subject.reference) : seed.manifest.patient;", { suites: ['unit'] }),
  M("s8-edges-subject-patient", "scripts/quickstart/edges.ts", "if (!subject.startsWith('Patient/')) fault('EDGE_SUBJECT_INVALID');", "", { suites: ['unit'] }),
  M("s8-edges-reference-type", "scripts/quickstart/edges.ts", "if (ref.type !== undefined && ref.type !== target.split('/')[0]) fault('EDGE_REFERENCE_INVALID');", "", { suites: ['unit'] }),
  M("s8-edges-owner", "scripts/quickstart/edges.ts", "if (ownerOf(target) !== owner.get(key)) fault('EDGE_OWNER_MISMATCH');", "", { suites: ['unit'] }),
  M("s8-edges-lab-only", "scripts/quickstart/edges.ts", "if (!lab || !coded || !OBSERVATION_STATUS.includes(resource.status as string)) fault('EDGE_SHAPE_INVALID');", "if (!coded || !OBSERVATION_STATUS.includes(resource.status as string)) fault('EDGE_SHAPE_INVALID');", { suites: ['unit'] }),
  M("s8-edges-observation-code", "scripts/quickstart/edges.ts", "if (!lab || !coded || !OBSERVATION_STATUS.includes(resource.status as string)) fault('EDGE_SHAPE_INVALID');", "if (!lab || !OBSERVATION_STATUS.includes(resource.status as string)) fault('EDGE_SHAPE_INVALID');", { suites: ['unit'] }),
  M("s8-edges-observation-coding", "scripts/quickstart/edges.ts", "&& resource.code.coding.every(c => isRecord(c) && typeof c.system === 'string' && typeof c.code === 'string');", ";", { suites: ['unit'] }),
  M("s8-edges-observation-status", "scripts/quickstart/edges.ts", "if (!lab || !coded || !OBSERVATION_STATUS.includes(resource.status as string)) fault('EDGE_SHAPE_INVALID');", "if (!lab || !coded) fault('EDGE_SHAPE_INVALID');", { suites: ['unit'] }),
  M("s8-edges-date-fault", "scripts/quickstart/edges.ts", "try { [lo, hi] = utcInterval(resource.effectiveDateTime); } catch { fault('EDGE_DATE_INVALID'); }", "try { [lo, hi] = utcInterval(resource.effectiveDateTime); } catch { lo = hi = windowStart; }", { suites: ['unit'] }),
  M("s8-edges-window-start", "scripts/quickstart/edges.ts", "if (lo < windowStart || hi > windowEnd) fault('EDGE_OUTSIDE_WINDOW');", "if (hi > windowEnd) fault('EDGE_OUTSIDE_WINDOW');", { suites: ['unit'] }),
  M("s8-edges-window-end", "scripts/quickstart/edges.ts", "if (lo < windowStart || hi > windowEnd) fault('EDGE_OUTSIDE_WINDOW');", "if (lo < windowStart || lo >= windowEnd + 1) fault('EDGE_OUTSIDE_WINDOW');", { suites: ['unit'] }),
  M("s8-edges-document-status", "scripts/quickstart/edges.ts", "if (!DOCUMENT_STATUS.includes(resource.status as string)) fault('EDGE_SHAPE_INVALID');", "", { suites: ['unit'] }),
  M("s8-edges-document-instant", "scripts/quickstart/edges.ts", "if (resource.date !== undefined && !(typeof resource.date === 'string' && INSTANT.test(resource.date))) fault('EDGE_DATE_INVALID');", "", { suites: ['unit'] }),
  M("s8-edges-document-date", "scripts/quickstart/edges.ts", "if (resource.date !== undefined) try { utcInterval(resource.date); } catch { fault('EDGE_DATE_INVALID'); }", "", { suites: ['unit'] }),
  M("s8-edges-payload-base64", "scripts/quickstart/edges.ts", "&& Buffer.from(c.attachment.data, 'base64').toString('base64') === c.attachment.data", "", { suites: ['unit'] }),
  M("s8-edges-payload-every", "scripts/quickstart/edges.ts", "!content.every(c => isRecord(c)", "!content.some(c => isRecord(c)", { suites: ['unit'] }),
  M("s8-edges-payload-required", "scripts/quickstart/edges.ts", "if (!content.length || !content.every(", "if (!content.every(", { suites: ['unit'] }),
  M("s8-edges-payload-content-type", "scripts/quickstart/edges.ts", "\n        && typeof c.attachment.contentType === 'string')) fault('EDGE_PAYLOAD_INVALID');", ")) fault('EDGE_PAYLOAD_INVALID');", { suites: ['unit'] }),
  M("s8-edges-dependency-order", "scripts/quickstart/edges.ts", "const ready = [...pending].filter(([, targets]) => targets.size === 0).map(([key]) => key)", "const ready = [...pending].map(([key]) => key)", { suites: ['unit'] }),
  M("s8-edges-cycle", "scripts/quickstart/edges.ts", "if (!ready.length) fault('EDGE_REFERENCE_CYCLE');", "if (!ready.length) break;", { suites: ['unit'] }),
  M("s8-edges-patient-first", "scripts/quickstart/edges.ts", "(a.startsWith('Patient/') ? 0 : 1) - (b.startsWith('Patient/') ? 0 : 1) || ", "", { suites: ['unit'] }),
  M("s8-edges-natural-rewrite", "scripts/quickstart/edges.ts", "if (k === 'reference' && child === NATURAL) node[k] = seed.manifest.patient; else rewrite(child);", "rewrite(child);", { suites: ['unit'] }),
  M("s8-edges-origin-label", "scripts/quickstart/edges.ts", "sha256: sha256(body), origin: 'edge' });", "sha256: sha256(body), origin: 'natural' });", { suites: ['unit'] }),
  M("s8-edges-limit-rows", "scripts/quickstart/edges.ts", "if (rows.length > SEED_LIMITS.resources || new Set(", "if (new Set(", { suites: ['unit'] }),
  M("s8-edges-limit-body", "scripts/quickstart/edges.ts", "|| rows.some(r => r.bytes > SEED_LIMITS.bodyBytes) || ", "|| ", { suites: ['unit'] }),
  M("s8-edges-limit-total", "scripts/quickstart/edges.ts", " || rows.reduce((n, r) => n + r.bytes, 0) > SEED_LIMITS.totalBytes) fault('SEED_LIMIT_EXCEEDED');", ") fault('SEED_LIMIT_EXCEEDED');", { suites: ['unit'] }),
  M("s8-edges-ndjson-hash", "scripts/quickstart/edges.ts", "ndjson_sha256: sha256(ndjson), edges:", "ndjson_sha256: seed.manifest.ndjson_sha256, edges:", { suites: ['unit'] }),
  M("s8-edges-file-hash", "scripts/quickstart/edges.ts", "edges: { sha256: sha256(edgesBytes), count: edges.size } } };", "edges: { sha256: sha256(stringifyFhir(file)), count: edges.size } } };", { suites: ['unit'] }),
  M("s8-edges-cli-regular", "scripts/quickstart/edges.ts", ".every(p => existsSync(p) && lstatSync(p).isFile())", ".every(p => existsSync(p))", { suites: ['unit'] }),
  M("s8-edges-cli-nofollow", "scripts/quickstart/edges.ts", "constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK", "constants.O_RDONLY | constants.O_NONBLOCK", { suites: ['unit'] }),
  M("s8-edges-cli-nonblock", "scripts/quickstart/edges.ts", "constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK", "constants.O_RDONLY | constants.O_NOFOLLOW", { suites: ['unit'] }),
  M("s8-edges-cli-descriptor-file", "scripts/quickstart/edges.ts", "if (!stat.isFile()) throw new CliFault('INPUT_MISSING');", "", { suites: ['unit'] }),
  M("s8-edges-cli-size", "scripts/quickstart/edges.ts", "if (stat.size > limit) throw new CliFault('INPUT_TOO_LARGE');", "", { suites: ['unit'] }),
  M("s8-edges-cli-changed", "scripts/quickstart/edges.ts", "if (length !== stat.size) throw new CliFault('INPUT_CHANGED');", "", { suites: ['unit'] }),
  M("s8-edges-cli-out-not-empty", "scripts/quickstart/edges.ts", "if (existsSync(outDir) && (!lstatSync(outDir).isDirectory() || readdirSync(outDir).length)) return failed('OUT_NOT_EMPTY');", "", { suites: ['unit'] }),
  M("s8-edges-cli-parent", "scripts/quickstart/edges.ts", "  mkdirSync(dirname(target), { recursive: true });\n", "", { suites: ['unit'] }),
  M("s8-edges-cli-publish-order", "scripts/quickstart/edges.ts", "    for (const [name, text] of Object.entries(files)) io.write(join(stage, name), text);\n    if (existsSync(target)) rmdirSync(target);\n    io.rename(stage, target);", "    if (existsSync(target)) rmdirSync(target);\n    io.rename(stage, target);\n    for (const [name, text] of Object.entries(files)) io.write(join(target, name), text);", { suites: ['unit'] }),
  M("s8-edges-cli-atomic", "scripts/quickstart/edges.ts", "catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }", "catch (error) { throw error; }", { suites: ['unit'] }),
  M("s8-edges-cli-code-only", "scripts/quickstart/edges.ts", "return failed(error instanceof EdgeError || error instanceof CliFault ? error.code : 'IO_FAILED');", "return error instanceof EdgeError || error instanceof CliFault ? failed(error.code) : { code: 1 as const, line: `quickstart-edges: IO_FAILED ${String(error)}` };", { suites: ['unit'] }),
  // Packaging slice 7 oracle kernel guards (root-written, revised after two GPT-6.1-Sol reviews); each killed by a named test in tests/package-oracle.test.ts or the older pure oracle tests. Unit suite only. citation-index-dropped and response-index-borrowing moved with the kernel to evidence-oracle.ts (same ids and weakenings, successor anchors).
  M("s9-oracle-step", "packages/evals/src/evidence-oracle.ts", "const own = calls.filter(call => call.step === step);", "const own = [...calls];", { suites: ['unit'] }),
  M("s9-oracle-bound-step", "packages/evals/src/evidence-oracle.ts", "return step !== undefined && Number.isSafeInteger(step) && step >= 0 && step < stepCount ? step : undefined;", "return step;", { suites: ['unit'] }),
  M("s9-oracle-version", "packages/evals/src/evidence-oracle.ts", "return check.version === null ? versionId === undefined : versionId === check.version;", "return check.version === null ? versionId === undefined : versionId !== undefined;", { suites: ['unit'] }),
  M("s9-oracle-fact-version", "packages/evals/src/evidence-oracle.ts", "const versions = check.version === undefined ? all : all.filter(o => o.version === check.version);", "const versions = all;", { suites: ['unit'] }),
  M("s9-oracle-provenance-version", "packages/evals/src/evidence-oracle.ts", "  if (!citedIndexes(envelope).has(resourceIndex)) return undefined;\n", "", { suites: ['unit'] }),
  M("s9-oracle-provenance-unique", "packages/evals/src/evidence-oracle.ts", " || index >= count || cited.has(index)\n", " || index >= count\n", { suites: ['unit'] }),
  M("s9-oracle-provenance-range", "packages/evals/src/evidence-oracle.ts", " || index < 0 || index >= count || cited.has(index)\n", " || cited.has(index)\n", { suites: ['unit'] }),
  M("s9-oracle-provenance-integer", "packages/evals/src/evidence-oracle.ts", "if (typeof index !== 'number' || !Number.isSafeInteger(index) ||", "if (typeof index !== 'number' || !Number.isFinite(index) ||", { suites: ['unit'] }),
  M("s9-oracle-provenance-time", "packages/evals/src/evidence-oracle.ts", "      || typeof time !== 'string' || !validTimestamp(time)) return new Set();", "     ) return new Set();", { suites: ['unit'] }),
  M("s9-oracle-time-calendar", "packages/evals/src/evidence-oracle.ts", " && day >= 1 && day <= days && ", " && day >= 1 && ", { suites: ['unit'] }),
  M("s9-oracle-time-clock", "packages/evals/src/evidence-oracle.ts", "hour <= 23 && minute <= 59 && second <= 59", "hour <= 24 && minute <= 60 && second <= 60", { suites: ['unit'] }),
  // s9-oracle-time-offset: Killing test: package oracle: retrieval times are real calendar instants
  M("s9-oracle-time-offset", "packages/evals/src/evidence-oracle.ts", "\n    && (m[7] === undefined || (Number(m[7]) <= 14 && Number(m[8]) <= 59 && (Number(m[7]) < 14 || Number(m[8]) === 0)));", ";", { suites: ['unit'] }),
  M("s9-oracle-fact-ambiguous", "packages/evals/src/evidence-oracle.ts", "      if (new Set(versions.map(o => o.resource.resourceType)).size > 1) return fail('resource_id_mismatch', `${check.resource} names resources of more than one type in the bound response`);\n", "", { suites: ['unit'] }),
  M("s9-oracle-fact-null", "packages/evals/src/evidence-oracle.ts", "if (values.some(v => v !== undefined && deepEqual(v, check.equals))) return pass();", "if (values.some(v => deepEqual(v, check.equals))) return pass();", { suites: ['unit'] }),
  M("s9-oracle-number", "packages/evals/src/evidence-oracle.ts", "if (token?.kind === 'number' && token.raw === check.equals) return pass();", "if (token?.kind === 'number' && Number(token.raw) === Number(check.equals)) return pass();", { suites: ['unit'] }),
  M("s9-oracle-numeric-token", "packages/evals/src/evidence-oracle.ts", "if (token?.kind === 'number' && token.raw === check.equals) return pass();", "if (token !== undefined && (token.kind === 'number' ? token.raw : token.kind === 'string' ? token.value : undefined) === check.equals) return pass();", { suites: ['unit'] }),
  M("s9-oracle-lexeme-path", "packages/evals/src/evidence-oracle.ts", "          const token = rawAtPath(resource, check.path);\n", "          const token = rawAtPath(resource, check.path) ?? rawAtPath(resource, 'valueQuantity.value');\n", { suites: ['unit'] }),
  M("s9-oracle-lexeme-resource", "packages/evals/src/evidence-oracle.ts", "if (rawString(rawAtPath(resource, 'id')) !== check.id_value || rawString(rawAtPath(resource, 'resourceType')) !== check.resource_type) continue;", "", { suites: ['unit'] }),
  M("s9-oracle-lexeme-type", "packages/evals/src/evidence-oracle.ts", " || rawString(rawAtPath(resource, 'resourceType')) !== check.resource_type) continue;", ") continue;", { suites: ['unit'] }),
  M("s9-oracle-citation-source", "packages/evals/src/evidence-oracle.ts", "        if (e.source.alias !== check.source) return false;\n", "", { suites: ['unit'] }),
  M("s9-oracle-citation-type", "packages/evals/src/evidence-oracle.ts", "if (resource.id !== check.id_value || resource.resourceType !== check.resource_type) return false;", "if (resource.id !== check.id_value) return false;", { suites: ['unit'] }),
  M("s9-oracle-cited-one-response", "packages/evals/src/evidence-oracle.ts", "if (evidence.envelopes.length !== 1) return fail('harness_error', 'a cited fact is bound to exactly one response');", "if (!evidence.envelopes.length) return fail('harness_error', 'a cited fact is bound to exactly one response');", { suites: ['unit'] }),
  M("s9-oracle-cited-type", "packages/evals/src/evidence-oracle.ts", "return r && r.resourceType === check.resource_type && r.id === check.id_value", "return r && r.id === check.id_value", { suites: ['unit'] }),
  M("s9-oracle-cited-version", "packages/evals/src/evidence-oracle.ts", "(check.version === null ? versionId === undefined : versionId === check.version) ? [index] : [];", "true ? [index] : [];", { suites: ['unit'] }),
  M("s9-oracle-cited-ambiguous", "packages/evals/src/evidence-oracle.ts", "      if (matches.length > 1) return fail('resource_id_mismatch', `${label} occurs more than once in the bound response`);\n", "", { suites: ['unit'] }),
  M("s9-oracle-cited-source", "packages/evals/src/evidence-oracle.ts", " || envelope.source.alias !== check.source || ", " || ", { suites: ['unit'] }),
  M("s9-oracle-cited-provenance", "packages/evals/src/evidence-oracle.ts", " || !citedIndexes(envelope).has(index)) return fail('version_mismatch',", ") return fail('version_mismatch',", { suites: ['unit'] }),
  M("s9-oracle-cited-raw-decoded", "packages/evals/src/evidence-oracle.ts", "if (!structured || canonicalJson(rawValue(structured)) !== canonicalJson(evidence.delivered?.[0] ?? envelope)) return fail(", "if (!structured) return fail(", { suites: ['unit'] }),
  M("s9-oracle-cited-absent", "packages/evals/src/evidence-oracle.ts", "if (check.absent) return value === undefined ? pass() : fail('expected_absence_violated',", "if (check.absent) return value !== null ? pass() : fail('expected_absence_violated',", { suites: ['unit'] }),
  M("s9-oracle-cited-path-exists", "packages/evals/src/evidence-oracle.ts", "      if (value === undefined) return fail('expected_fact_missing', `${label} ${check.path} absent from the cited occurrence`);\n", "", { suites: ['unit'] }),
  M("s9-oracle-cited-equals", "packages/evals/src/evidence-oracle.ts", " && !deepEqual(value, check.equals)) return fail(", " && !deepEqual(value, value)) return fail(", { suites: ['unit'] }),
  M("s9-oracle-cited-lexeme", "packages/evals/src/evidence-oracle.ts", "if (token?.kind !== 'number' || token.raw !== check.lexeme) return fail(", "if (token?.kind !== 'number') return fail(", { suites: ['unit'] }),
  M("s9-oracle-arm-guard", "packages/evals/src/evidence-oracle.ts", "  if (check.arms && !check.arms.includes(arm)) return { ...base, status: 'incomparable', detail: check.incomparableReason ?? `not comparable for arm ${arm}` };\n", "", { suites: ['unit'] }),
  M("s9-oracle-all-responses", "packages/evals/src/evidence-oracle.ts", "for (const [index, call] of own.entries()) {", "for (const [index, call] of own.slice(0, 1).entries()) {", { suites: ['unit'] }),
  M("s9-oracle-index-missing", "packages/evals/src/evidence-oracle.ts", "return call ? judge([call]) : { ...base, status: 'fail', cause: 'expected_fact_missing', detail: `response ${check.response_index} is not in the bound step` };", "return judge(call ? [call] : []);", { suites: ['unit'] }),
  M("s9-oracle-index-calls", "packages/evals/src/evidence-oracle.ts", "const call = own[check.response_index];", "const call = own.filter(c => c.envelope !== undefined)[check.response_index];", { suites: ['unit'] }),
  M("s9-oracle-m3b-first-response", "packages/evals/src/evidence-oracle.ts", "if (M3B_CHECK_KINDS.has(check.kind)) return judge(own.slice(0, 1));", "if (M3B_CHECK_KINDS.has(check.kind)) return judge(own);", { suites: ['unit'] }),
  M("s9-oracle-outcome-own", "packages/evals/src/evidence-oracle.ts", "const outcomes = selection.sharedOutcomes ?? selected.flatMap(", "const outcomes = selection.sharedOutcomes ?? own.flatMap(", { suites: ['unit'] }),
  M("s9-oracle-outcome-envelope", "packages/evals/src/evidence-oracle.ts", "  call.outcome ?? (call.envelope?.error ? { class: 'application_error', code: call.envelope.error.code } : undefined);", "  call.outcome;", { suites: ['unit'] }),
  M("s9-oracle-outcome-code", "packages/evals/src/evidence-oracle.ts", " && String(o.code) === String(check.code));", ");", { suites: ['unit'] }),
  M("s9-oracle-unknown-work", "packages/evals/src/evidence-oracle.ts", "const work = selected.length > 0 && selected.every(call => call.work) ? selected.map(call => call.work!) : undefined;", "const work = selected.map(call => call.work ?? { metadata: 0, auth: 0, clinical: 0 });", { suites: ['unit'] }),
  M("s9-oracle-work-unexecuted", "packages/evals/src/evidence-oracle.ts", "const work = selected.length > 0 && selected.every(", "const work = selected.every(", { suites: ['unit'] }),
  M("s9-oracle-work-all-calls", "packages/evals/src/evidence-oracle.ts", "? selected.map(call => call.work!) : undefined;", "? selected.slice(0, 1).map(call => call.work!) : undefined;", { suites: ['unit'] }),
  M("s9-oracle-step-type", "packages/evals/src/evidence-oracle.ts", "resourceType: context.resourceType ?? own.find(call => call.envelope)?.resourceType,", "resourceType: own.find(call => call.envelope)?.resourceType,", { suites: ['unit'] }),
  M("s9-oracle-chain-type", "packages/evals/src/evidence-oracle.ts", "    if (type !== undefined && resourcesOf(envelope).some(r => r.resourceType !== type)) return { envelopes: [], error: 'A returned resource type differs from the bound query type.' };\n", "", { suites: ['unit'] }),
  M("s9-oracle-chain-carry", "packages/evals/src/evidence-oracle.ts", "    chainType = type;\n", "", { suites: ['unit'] }),
  M("s9-oracle-query-digest", "packages/evals/src/evidence-oracle.ts", "    if (expected !== c.query_digest) return { envelopes: [], error: 'Query digest does not bind the ordered material pairs and sort.' };\n", "", { suites: ['unit'] }),
  M("s9-oracle-raw-member", "packages/evals/src/evidence-oracle.ts", "const start = i; valueEnd(); const value = text.slice(start, i); if (key === wanted) return value;", "const start = i; valueEnd(); const value = text.slice(start, i); if (key === wanted) return JSON.stringify(JSON.parse(value));", { suites: ['unit'] }),
  M("s9-oracle-boundary-multiline", "packages/evals/src/evidence-oracle.ts", "import { createHash } from 'node:crypto';\n", "import { createHash } from 'node:crypto';\nimport {\n  readFileSync as boundaryProbe\n} from 'node:fs';\nexport const boundaryProbeType = typeof boundaryProbe;\n", { suites: ['unit'] }),
  M("s9-oracle-boundary-dynamic", "packages/evals/src/evidence-oracle.ts", "import { createHash } from 'node:crypto';\n", "import { createHash } from 'node:crypto';\nexport const boundaryProbe = () => import('../../core/src/index.js');\n", { suites: ['unit'] }),
  // Packaging slice 6 transform provider-sanitisation and seed-contract guards (root-written, after Sol's edge re-check); each killed by a named test in tests/quickstart-transform.test.ts or tests/quickstart-edges.test.ts. Unit suite only.
  M("t6-provider-name", "scripts/quickstart/transform-synthea.ts", "        standIn.name = `Synthetic ${noun} ${ordinal.get(url)!}`;\n", "", { suites: ['unit'] }),
  M("t6-provider-contact", "scripts/quickstart/transform-synthea.ts", "      for (const key of PROVIDER_CONTACT) delete standIn[key];\n", "", { suites: ['unit'] }),
  // t6-provider-npi: Killing test: quickstart transform reduces provider directory resources to synthetic stand-ins with no contact data, NPI identifiers or naming displays
  M("t6-provider-npi", "scripts/quickstart/transform-synthea.ts", "if (isRecord(identifier) && identifier.system === NPI_SYSTEM) {", "if (false) {", { suites: ['unit'] }),
  M("t6-provider-npi-tally", "scripts/quickstart/transform-synthea.ts", "        providers.npi_identifiers_dropped += standIn.identifier.length - kept.length;\n", "", { suites: ['unit'] }),
  // t6-provider-display: Killing test: quickstart transform reduces provider directory resources to synthetic stand-ins with no contact data, NPI identifiers or naming displays
  M("t6-provider-display", "scripts/quickstart/transform-synthea.ts", "              delete node.display;\n", "", { suites: ['unit'] }),
  M("t6-provider-residue", "scripts/quickstart/transform-synthea.ts", "    if (providerResidue.some(pattern => strings.some(text => pattern.test(text)))) fault('PROVIDER_RESIDUE');\n", "", { suites: ['unit'] }),
  // t6-provider-residue-towns: Killing test: quickstart transform inventories single and array Address lines and nested provider contacts but permits shared geography
  M("t6-provider-residue-towns", "scripts/quickstart/transform-synthea.ts", "!SHARED_CONTACT_FIELDS.has(k) && !(phone", "true && !(phone", { suites: ['unit'] }),
  M("t6-contract-types", "scripts/quickstart/transform-synthea.ts", "if (!(SEED_TYPES as readonly string[]).includes(type) || 'contained' in resource) bad();", "if ('contained' in resource) bad();", { suites: ['unit'] }),
  M("t6-contract-contained", "scripts/quickstart/transform-synthea.ts", "if (!(SEED_TYPES as readonly string[]).includes(type) || 'contained' in resource) bad();", "if (!(SEED_TYPES as readonly string[]).includes(type)) bad();", { suites: ['unit'] }),
  M("t6-contract-patient-alive", "scripts/quickstart/transform-synthea.ts", "if (patients.length !== 1 || `Patient/${patients[0]!.id as string}` !== manifest.patient || patients[0]!.deceasedBoolean === true\n    || patients[0]!.deceasedDateTime !== undefined ||", "if (patients.length !== 1 || `Patient/${patients[0]!.id as string}` !== manifest.patient ||", { suites: ['unit'] }),
  M("t6-contract-government", "scripts/quickstart/transform-synthea.ts", " || (Array.isArray(patients[0]!.identifier) && patients[0]!.identifier.some(i => governmentIdentifierKind(i)))) bad();", ") bad();", { suites: ['unit'] }),
  // t6-contract-provider-contact: Killing test: quickstart transform seed contract independently refuses identifying providers and unbound provider displays
  M("t6-contract-provider-contact", "scripts/quickstart/transform-synthea.ts", "    if (PROVIDER_TYPES.has(type) && !safeProvider(resource)) bad();\n", "", { suites: ['unit'] }),
  // t6-contract-npi: Killing test: quickstart transform admits only numeric utilization provider extensions and self-id Synthea identifiers
  M("t6-contract-npi", "scripts/quickstart/transform-synthea.ts", "  if (resource.identifier !== undefined && !(Array.isArray(resource.identifier) && resource.identifier.every(id => providerIdentifier(id, resource.id)))) return false;\n", "", { suites: ['unit'] }),
  // t6-contract-stand-in: Killing test: quickstart transform seed contract independently refuses identifying providers and unbound provider displays
  M("t6-contract-stand-in", "scripts/quickstart/transform-synthea.ts", "  if (PROVIDER_NOUNS[type] !== undefined && !(typeof resource.name === 'string' && PROVIDER_STAND_IN.test(resource.name)\n    && resource.name.startsWith(`Synthetic ${PROVIDER_NOUNS[type]} `))) return false;", "", { suites: ['unit'] }),
  M("t6-contract-order", "scripts/quickstart/transform-synthea.ts", "|| at === undefined || at >= i ||", "|| at === undefined ||", { suites: ['unit'] }),
  M("t6-contract-reference-type", "scripts/quickstart/transform-synthea.ts", " || (node.type !== undefined && node.type !== match[1])", "", { suites: ['unit'] }),
  M("t6-contract-display", "scripts/quickstart/transform-synthea.ts", " || (PROVIDER_NOUNS[match[1]!] !== undefined && 'display' in node)) bad();", ") bad();", { suites: ['unit'] }),
  M("t6-contract-logical", "scripts/quickstart/transform-synthea.ts", "if ('reference' in node || isRecord(node.identifier) && !('reference' in node) && !Array.isArray(node.identifier)) {", "if ('reference' in node) {", { suites: ['unit'] }),
  M("t6-contract-lab", "scripts/quickstart/transform-synthea.ts", "if (!hasCoding(resource.category, type === 'Observation' ? OBSERVATION_LAB : REPORT_LAB) || !ownedBy(resource)", "if (!ownedBy(resource)", { suites: ['unit'] }),
  M("t6-contract-owner", "scripts/quickstart/transform-synthea.ts", " || !ownedBy(resource)\n        || interval === undefined", "\n        || interval === undefined", { suites: ['unit'] }),
  M("t6-contract-window", "scripts/quickstart/transform-synthea.ts", "        || interval === undefined || interval[0] < windowStart || interval[1] > windowEnd) bad();", "        || interval === undefined) bad();", { suites: ['unit'] }),
  M("t6-contract-report-results", "scripts/quickstart/transform-synthea.ts", "      if (type === 'DiagnosticReport' && !(Array.isArray(resource.result) && resource.result.length > 0", "      if (type === 'DiagnosticReport' && !(Array.isArray(resource.result)", { suites: ['unit'] }),
  M("t6-contract-patient-linked", "scripts/quickstart/transform-synthea.ts", "    if (PATIENT_LINKED.has(type) && !ownedBy(resource)) bad();\n", "", { suites: ['unit'] }),
  M("t6-contract-inputs", "scripts/quickstart/transform-synthea.ts", "  if (!Array.isArray(manifest.inputs) || !manifest.inputs.length ||", "  if (false ||", { suites: ['unit'] }),
  M("t6-contract-tallies", "scripts/quickstart/transform-synthea.ts", "  if (!tally(manifest.dropped_patient_identifiers, ['SS', 'DL', 'PPN']) || !tally(manifest.providers, ['sanitized', 'npi_identifiers_dropped'])) bad();\n", "", { suites: ['unit'] }),
  M("t6-contract-counts", "scripts/quickstart/transform-synthea.ts", "  if (!isRecord(manifest.counts) || JSON.stringify(Object.entries(manifest.counts).sort()) !== JSON.stringify(Object.entries(counts).sort())) bad();\n", "", { suites: ['unit'] }),
  // Packaging slice 6 provider sanitisation, round 3 (GPT-6.1-Sol): closed provider shapes and the residue inventory; unit suite only.
  // t6-provider-role-contact: Killing test: quickstart transform sanitizes PractitionerRole contacts even when no other provider is reached
  M("t6-provider-role-contact", "scripts/quickstart/transform-synthea.ts", "const PROVIDER_TYPES = new Set(['Organization', 'Location', 'Practitioner', 'PractitionerRole']);", "const PROVIDER_TYPES = new Set(['Organization', 'Location', 'Practitioner']);", { suites: ['unit'] }),
  // t6-provider-retained-fields: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-retained-fields", "scripts/quickstart/transform-synthea.ts", "  if (!onlyKeys(resource, ['resourceType', 'id', 'identifier', 'extension', ...(PROVIDER_FIELDS[type] ?? [])])) return false;\n", "", { suites: ['unit'] }),
  // t6-provider-retained-extensions: Killing test: quickstart transform admits only numeric utilization provider extensions and self-id Synthea identifiers
  M("t6-provider-retained-extensions", "scripts/quickstart/transform-synthea.ts", "  if (resource.extension !== undefined && !providerExtensions(resource.extension)) return false;\n", "", { suites: ['unit'] }),
  // t6-provider-active-shape: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-active-shape", "scripts/quickstart/transform-synthea.ts", "  if (resource.active !== undefined && typeof resource.active !== 'boolean') return false;\n", "", { suites: ['unit'] }),
  // t6-provider-practitioner-name-shape: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-practitioner-name-shape", "scripts/quickstart/transform-synthea.ts", "  if (type === 'Practitioner' && resource.name !== undefined && !syntheticNames(resource.name)) return false;\n", "", { suites: ['unit'] }),
  // t6-provider-gender-shape: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-gender-shape", "scripts/quickstart/transform-synthea.ts", "  if (resource.gender !== undefined && !['male', 'female', 'other', 'unknown'].includes(resource.gender as string)) return false;\n", "", { suites: ['unit'] }),
  // t6-provider-location-status-shape: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-location-status-shape", "scripts/quickstart/transform-synthea.ts", "  if (resource.status !== undefined && !['active', 'suspended', 'inactive'].includes(resource.status as string)) return false;\n", "", { suites: ['unit'] }),
  // t6-provider-location-mode-shape: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-location-mode-shape", "scripts/quickstart/transform-synthea.ts", "  if (resource.mode !== undefined && !['instance', 'kind'].includes(resource.mode as string)) return false;\n", "", { suites: ['unit'] }),
  // t6-provider-contract-name-noun: Killing test: quickstart transform seed contract independently refuses identifying providers and unbound provider displays
  M("t6-provider-contract-name-noun", "scripts/quickstart/transform-synthea.ts", "resource.name.startsWith(`Synthetic ${PROVIDER_NOUNS[type]} `)", "true", { suites: ['unit'] }),
  // t6-provider-identifier-system: Killing test: quickstart transform admits only numeric utilization provider extensions and self-id Synthea identifiers
  M("t6-provider-identifier-system", "scripts/quickstart/transform-synthea.ts", "identifier.system === SYNTHEA_SYSTEM && identifier.value === id", "identifier.value === id", { suites: ['unit'] }),
  // t6-provider-identifier-self-id: Killing test: quickstart transform admits only numeric utilization provider extensions and self-id Synthea identifiers
  M("t6-provider-identifier-self-id", "scripts/quickstart/transform-synthea.ts", "identifier.system === SYNTHEA_SYSTEM && identifier.value === id", "identifier.system === SYNTHEA_SYSTEM", { suites: ['unit'] }),
  // t6-provider-identifier-closed: Killing test: quickstart transform admits only numeric utilization provider extensions and self-id Synthea identifiers
  M("t6-provider-identifier-closed", "scripts/quickstart/transform-synthea.ts", "isRecord(identifier) && onlyKeys(identifier, ['system', 'value'])", "isRecord(identifier)", { suites: ['unit'] }),
  // t6-provider-extension-closed: Killing test: quickstart transform admits only numeric utilization provider extensions and self-id Synthea identifiers
  M("t6-provider-extension-closed", "scripts/quickstart/transform-synthea.ts", "onlyKeys(extension, ['url', 'valueInteger'])", "true", { suites: ['unit'] }),
  // t6-provider-extension-url: Killing test: quickstart transform admits only numeric utilization provider extensions and self-id Synthea identifiers
  M("t6-provider-extension-url", "scripts/quickstart/transform-synthea.ts", "UTILIZATION_EXTENSION.test(extension.url)", "true", { suites: ['unit'] }),
  // t6-provider-extension-integer: Killing test: quickstart transform admits only numeric utilization provider extensions and self-id Synthea identifiers
  M("t6-provider-extension-integer", "scripts/quickstart/transform-synthea.ts", "Number.isSafeInteger(extension.valueInteger)", "true", { suites: ['unit'] }),
  // t6-provider-extension-nonnegative: Killing test: quickstart transform admits only numeric utilization provider extensions and self-id Synthea identifiers
  M("t6-provider-extension-nonnegative", "scripts/quickstart/transform-synthea.ts", "(extension.valueInteger as number) >= 0", "true", { suites: ['unit'] }),
  // t6-provider-human-name-closed: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-human-name-closed", "scripts/quickstart/transform-synthea.ts", "onlyKeys(name, ['family', 'given', 'prefix'])", "true", { suites: ['unit'] }),
  // t6-provider-human-name-family: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-human-name-family", "scripts/quickstart/transform-synthea.ts", "SYNTHETIC_NAME_PART.test(name.family)", "true", { suites: ['unit'] }),
  // t6-provider-human-name-given: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-human-name-given", "scripts/quickstart/transform-synthea.ts", "name.given.every(part => typeof part === 'string' && SYNTHETIC_NAME_PART.test(part))", "true", { suites: ['unit'] }),
  // t6-provider-human-name-prefix: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-human-name-prefix", "scripts/quickstart/transform-synthea.ts", "(name.prefix === undefined || Array.isArray(name.prefix) && name.prefix.length === 1 && name.prefix[0] === 'Dr.')", "true", { suites: ['unit'] }),
  // t6-provider-human-name-nonempty: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-human-name-nonempty", "scripts/quickstart/transform-synthea.ts", "value.length > 0 && value.every(name =>", "value.every(name =>", { suites: ['unit'] }),
  // t6-provider-human-name-given-nonempty: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-human-name-given-nonempty", "scripts/quickstart/transform-synthea.ts", "name.given.length > 0 && name.given.every(", "name.given.every(", { suites: ['unit'] }),
  // t6-provider-organization-type-shape: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-organization-type-shape", "scripts/quickstart/transform-synthea.ts", "  if (resource.type !== undefined && !(Array.isArray(resource.type) && resource.type.length > 0 && resource.type.every(concept => isRecord(concept)\n    && onlyKeys(concept, ['coding', 'text']) && (concept.text === undefined || concept.text === 'Healthcare Provider')\n    && Array.isArray(concept.coding) && concept.coding.length > 0 && concept.coding.every(coding => isRecord(coding)\n      && onlyKeys(coding, ['system', 'code', 'display']) && coding.system === 'http://terminology.hl7.org/CodeSystem/organization-type'\n      && coding.code === 'prov' && (coding.display === undefined || coding.display === 'Healthcare Provider'))))) return false;", "", { suites: ['unit'] }),
  // t6-provider-single-reference-shape: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-single-reference-shape", "scripts/quickstart/transform-synthea.ts", "  for (const key of ['partOf', 'managingOrganization', 'practitioner', 'organization']) if (resource[key] !== undefined && !providerReference(resource[key])) return false;\n", "", { suites: ['unit'] }),
  // t6-provider-nested-reference-closed: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-nested-reference-closed", "scripts/quickstart/transform-synthea.ts", "onlyKeys(value, ['reference', 'type', 'display'])", "true", { suites: ['unit'] }),
  // t6-provider-role-location-shape: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-role-location-shape", "scripts/quickstart/transform-synthea.ts", "  return resource.location === undefined || Array.isArray(resource.location) && resource.location.every(providerReference);", "  return true;", { suites: ['unit'] }),
  // t6-provider-display-only-type: Killing test: quickstart transform binds synthetic Practitioner displays and refuses provider displays without a resolved identity
  M("t6-provider-display-only-type", "scripts/quickstart/transform-synthea.ts", "PROVIDER_TYPES.has(node.type as string) || PROVIDER_REFERENCE_FIELDS.has(key)", "PROVIDER_REFERENCE_FIELDS.has(key)", { suites: ['unit'] }),
  // t6-provider-display-only-field: Killing test: quickstart transform binds synthetic Practitioner displays and refuses provider displays without a resolved identity
  M("t6-provider-display-only-field", "scripts/quickstart/transform-synthea.ts", "PROVIDER_TYPES.has(node.type as string) || PROVIDER_REFERENCE_FIELDS.has(key)", "PROVIDER_TYPES.has(node.type as string)", { suites: ['unit'] }),
  // t6-provider-display-only-transform: Killing test: quickstart transform binds synthetic Practitioner displays and refuses provider displays without a resolved identity
  M("t6-provider-display-only-transform", "scripts/quickstart/transform-synthea.ts", "        if (providerDisplayOnly(node, field)) fault('PROVIDER_RESIDUE');\n", "", { suites: ['unit'] }),
  // t6-provider-display-only-contract: Killing test: quickstart transform seed contract independently refuses identifying providers and unbound provider displays
  M("t6-provider-display-only-contract", "scripts/quickstart/transform-synthea.ts", "      if (providerDisplayOnly(node, field)) bad();\n", "", { suites: ['unit'] }),
  // t6-provider-practitioner-display-transform: Killing test: quickstart transform binds synthetic Practitioner displays and refuses provider displays without a resolved identity
  M("t6-provider-practitioner-display-transform", "scripts/quickstart/transform-synthea.ts", "            } else if (PROVIDER_TYPES.has(target.type) && 'display' in node\n              && !(target.type === 'Practitioner' && syntheticPractitionerDisplay(target.resource, node.display))) fault('PROVIDER_RESIDUE');", "            }", { suites: ['unit'] }),
  // t6-provider-practitioner-display-contract: Killing test: quickstart transform seed contract independently refuses identifying providers and unbound provider displays
  M("t6-provider-practitioner-display-contract", "scripts/quickstart/transform-synthea.ts", "        if (match && at !== undefined && PROVIDER_TYPES.has(match[1]!) && 'display' in node\n          && !(match[1] === 'Practitioner' && syntheticPractitionerDisplay(resources[at]!, node.display))) bad();", "", { suites: ['unit'] }),
  // t6-provider-reference-display-inventory: Killing test: quickstart transform binds synthetic Practitioner displays and refuses provider displays without a resolved identity
  M("t6-provider-reference-display-inventory", "scripts/quickstart/transform-synthea.ts", "              collectProviderText(node.display, removedProviderText, 'display');\n", "", { suites: ['unit'] }),
  // t6-provider-provider-source-shape: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-provider-source-shape", "scripts/quickstart/transform-synthea.ts", "      if (!safeProvider(standIn)) fault('PROVIDER_RESIDUE');\n", "", { suites: ['unit'] }),
  // t6-provider-source-name-shape: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-source-name-shape", "scripts/quickstart/transform-synthea.ts", "        if (source.name !== undefined && (typeof source.name !== 'string' || source.name.trim() === '')) fault('PROVIDER_RESIDUE');\n", "", { suites: ['unit'] }),
  // t6-provider-npi-value-shape: Killing test: quickstart transform removes and inventories NPI values and provider aliases across every admitted provider type
  M("t6-provider-npi-value-shape", "scripts/quickstart/transform-synthea.ts", "            if (typeof identifier.value !== 'string' || identifier.value.trim() === '') fault('PROVIDER_RESIDUE');\n", "", { suites: ['unit'] }),
  // t6-provider-npi-value-inventory: Killing test: quickstart transform removes and inventories NPI values and provider aliases across every admitted provider type
  M("t6-provider-npi-value-inventory", "scripts/quickstart/transform-synthea.ts", "            removedProviderText.push({ kind: 'text', value: (identifier.value as string).trim() });\n", "", { suites: ['unit'] }),
  // t6-provider-alias-inventory: Killing test: quickstart transform removes and inventories NPI values and provider aliases across every admitted provider type
  M("t6-provider-alias-inventory", "scripts/quickstart/transform-synthea.ts", "      for (const key of PROVIDER_CONTACT) collectProviderText(standIn[key], removedProviderText, key);", "      for (const key of PROVIDER_CONTACT) if (key !== 'alias') collectProviderText(standIn[key], removedProviderText, key);", { suites: ['unit'] }),
  // t6-provider-address-inventory: Killing test: quickstart transform inventories single and array Address lines and nested provider contacts but permits shared geography
  M("t6-provider-address-inventory", "scripts/quickstart/transform-synthea.ts", "      for (const key of PROVIDER_CONTACT) collectProviderText(standIn[key], removedProviderText, key);", "      for (const key of PROVIDER_CONTACT) if (key !== 'address') collectProviderText(standIn[key], removedProviderText, key);", { suites: ['unit'] }),
  // t6-provider-contact-inventory: Killing test: quickstart transform inventories single and array Address lines and nested provider contacts but permits shared geography
  M("t6-provider-contact-inventory", "scripts/quickstart/transform-synthea.ts", "      for (const key of PROVIDER_CONTACT) collectProviderText(standIn[key], removedProviderText, key);", "      for (const key of PROVIDER_CONTACT) if (key !== 'contact') collectProviderText(standIn[key], removedProviderText, key);", { suites: ['unit'] }),
  // t6-provider-contact-single-object: Killing test: quickstart transform inventories single and array Address lines and nested provider contacts but permits shared geography
  M("t6-provider-contact-single-object", "scripts/quickstart/transform-synthea.ts", "  if (isRecord(node)) {\n    const phone =", "  if (isRecord(node) && key !== 'address') {\n    const phone =", { suites: ['unit'] }),
  // t6-provider-phone-value-shape: Killing test: quickstart transform matches reformatted provider telecom values without matching different or longer numbers
  M("t6-provider-phone-value-shape", "scripts/quickstart/transform-synthea.ts", "      if (typeof node.value !== 'string') fault('PROVIDER_RESIDUE');\n", "", { suites: ['unit'] }),
  // t6-provider-phone-format-shape: Killing test: quickstart transform matches reformatted provider telecom values without matching different or longer numbers
  M("t6-provider-phone-format-shape", "scripts/quickstart/transform-synthea.ts", "        if (!/^\\+?[0-9\\s().-]+$/.test(value) || !/^[0-9]{7,15}$/.test(value.replace(/\\D/g, ''))) fault('PROVIDER_RESIDUE');\n", "", { suites: ['unit'] }),
  // t6-provider-phone-alternatives: Killing test: quickstart transform matches reformatted provider telecom values without matching different or longer numbers
  M("t6-provider-phone-alternatives", "scripts/quickstart/transform-synthea.ts", "(node.value as string).split(/\\s+or\\s+/i)", "[node.value as string]", { suites: ['unit'] }),
  // t6-provider-phone-digits: Killing test: quickstart transform matches reformatted provider telecom values without matching different or longer numbers
  M("t6-provider-phone-digits", "scripts/quickstart/transform-synthea.ts", "out.push({ kind: 'phone', value: value.replace(/\\D/g, '') });", "out.push({ kind: 'text', value });", { suites: ['unit'] }),
  // t6-provider-phone-systems: Killing test: quickstart transform matches reformatted provider telecom values without matching different or longer numbers
  M("t6-provider-phone-systems", "scripts/quickstart/transform-synthea.ts", "['phone', 'fax', 'sms', 'pager'].includes(node.system as string)", "['phone'].includes(node.system as string)", { suites: ['unit'] }),
  // t6-provider-phone-punctuation-residue: Killing test: quickstart transform matches reformatted provider telecom values without matching different or longer numbers
  M("t6-provider-phone-punctuation-residue", "scripts/quickstart/transform-synthea.ts", "  if (kind === 'phone') return new RegExp(`(?:^|[^A-Za-z0-9])${[...value].join('[\\\\s().+-]*')}(?:$|[^A-Za-z0-9])`);\n", "", { suites: ['unit'] }),
  // t6-provider-name-context-residue: Killing test: quickstart transform refuses single-token provider names and matches every admitted removed name as a bounded value everywhere
  M("t6-provider-name-context-residue", "scripts/quickstart/transform-synthea.ts", "  if (kind === 'name' && !/\\S+\\s+\\S+/.test(value)) fault('PROVIDER_RESIDUE');\n", "", { suites: ['unit'] }),
  // t6-provider-identifier-token-boundaries: Killing test: quickstart transform removes and inventories NPI values and provider aliases across every admitted provider type
  M("t6-provider-identifier-token-boundaries", "scripts/quickstart/transform-synthea.ts", "  return new RegExp(`(?:^|[^A-Za-z0-9])${token}(?:$|[^A-Za-z0-9])`, 'i');", "  return new RegExp(token, 'i');", { suites: ['unit'] }),
  // t6-provider-npi-closed: Killing test: quickstart transform removes and inventories NPI values and provider aliases across every admitted provider type
  M("t6-provider-npi-closed", "scripts/quickstart/transform-synthea.ts", "            if (!onlyKeys(identifier, ['system', 'value'])) fault('PROVIDER_RESIDUE');\n", "", { suites: ['unit'] }),
  // t6-provider-npi-value-normalization: Killing test: quickstart transform removes and inventories NPI values and provider aliases across every admitted provider type
  M("t6-provider-npi-value-normalization", "scripts/quickstart/transform-synthea.ts", "removedProviderText.push({ kind: 'text', value: (identifier.value as string).trim() });", "removedProviderText.push({ kind: 'text', value: identifier.value as string });", { suites: ['unit'] }),
  // t6-provider-reference-target-required: Killing test: quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names
  M("t6-provider-reference-target-required", "scripts/quickstart/transform-synthea.ts", "onlyKeys(value, ['reference', 'type', 'display']) && typeof value.reference === 'string'", "onlyKeys(value, ['reference', 'type', 'display'])", { suites: ['unit'] }),
  // t6-provider-display-only-unknown-type: Killing test: quickstart transform binds synthetic Practitioner displays and refuses provider displays without a resolved identity
  M("t6-provider-display-only-unknown-type", "scripts/quickstart/transform-synthea.ts", "onlyKeys(node, ['type', 'display', 'identifier', 'id', 'extension', '_reference', '_display', '_type']) && !(SEED_TYPES as readonly unknown[]).includes(node.type)", "false", { suites: ['unit'] }),
  // t6-provider-display-name-binding: Killing test: quickstart transform binds synthetic Practitioner displays and refuses provider displays without a resolved identity
  M("t6-provider-display-name-binding", "scripts/quickstart/transform-synthea.ts", ".join(' ') === display);", ".join(' ').length > 0);", { suites: ['unit'] }),
  // t6-provider-contact-text-shape: Killing test: quickstart transform removes and inventories NPI values and provider aliases across every admitted provider type
  M("t6-provider-contact-text-shape", "scripts/quickstart/transform-synthea.ts", "  } else if (node !== undefined && CONTACT_TEXT_FIELDS.has(key)) fault('PROVIDER_RESIDUE');", "  }", { suites: ['unit'] }),
  // s8-edges-markdown-annotations: Killing test: quickstart edges: annotations refuse Markdown links and autolinks while plain string fields admit resource-looking text
  M("s8-edges-markdown-annotations", "scripts/quickstart/edges.ts", "    valueQuantity: quantity, interpretation: list(concept), hasMember: list(reference), derivedFrom: list(reference) },", "    valueQuantity: quantity, interpretation: list(concept), hasMember: list(reference), derivedFrom: list(reference), note: list(closed({ text })) },", { suites: ['unit'] }),
  // Packaging slice 8B packaged-task definitions (root-written); each killed by a named test in tests/package-tasks.test.ts. Unit suite only.
  M("s9-package-observed-version", "packages/evals/src/package-tasks.ts", "const version = (type: string, id: string) => versions.get(`${type}/${id}`) ?? fail(`no observed version for ${type}/${id}`);", "const version = (type: string, id: string) => versions.get(`${type}/${id}`) ?? '1';", { suites: ['unit'] }),
  M("s9-package-raw-lexeme", "packages/evals/src/package-tasks.ts", "lexeme: isFhirDecimal(quantity.value) ? quantity.value.lexeme : JSON.stringify(quantity.value),", "lexeme: isFhirDecimal(quantity.value) ? String(Number(quantity.value.lexeme)) : JSON.stringify(quantity.value),", { suites: ['unit'] }),
  M("s9-package-own-labs", "packages/evals/src/package-tasks.ts", "const mine = labs.filter(r => subjectIs(r, patient));", "const mine = labs;", { suites: ['unit'] }),
  M("s9-package-order-truth", "packages/evals/src/package-tasks.ts", "{ kind: 'sortEvidence', id: 'hba1c-order-unverified', step: 3, requested: ['-date'], effective: null, order: 'requested_unverified' },", "{ kind: 'sortEvidence', id: 'hba1c-order-unverified', step: 3, requested: ['-date'], effective: null, order: 'verified_by_adapter' },", { suites: ['unit'] }),
  M("s9-package-arm-fields", "packages/evals/src/package-tasks.ts", "if (arm === 'selected' && ['fhir_search', 'fhir_read', 'fhir_page'].includes(tool))", "if (arm === 'selected')", { suites: ['unit'] }),
  // Packaging slice 8A: persistent prepare, Docker confinement and independent stored setup evidence; unit suite only.
  // s8-prepare-reseed: Killing test: quickstart prepare: failed partial and complete attempts cannot be reseeded even when a replacement target is empty
  M("s8-prepare-reseed", "examples/quickstart/run-state.ts", "catch { throw fault('SEED_ALREADY_ATTEMPTED'); }", "catch { return; }", { suites: ['unit'] }),
  // s8-prepare-writer: Killing test: quickstart prepare: exclusive lock itself rejects a second lock without modifying its owner
  M("s8-prepare-writer", "examples/quickstart/run-state.ts", "constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600", "constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600", { suites: ['unit'] }),
  // s8-run-directory-mode: Killing test: quickstart prepare: complete packet binds approved bodies receipt manifest observed versions and exact lexemes
  C("s8-run-directory-mode", [{"file": "examples/quickstart/run-state.ts", "find": "await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o700);", "replace": "await mkdir(directory, { mode: 0o755 }); await chmod(directory, 0o755);"}], { suites: ['unit'] }),
  // s8-run-file-mode: Killing test: quickstart prepare: complete packet binds approved bodies receipt manifest observed versions and exact lexemes
  C("s8-run-file-mode", [{"file": "examples/quickstart/run-state.ts", "find": "constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600", "replace": "constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o644"}, {"file": "examples/quickstart/run-state.ts", "find": "await file.chmod(0o600);", "replace": "await file.chmod(0o644);"}], { suites: ['unit'] }),
  // s8-run-private-read: Killing test: quickstart prepare: closed receipt private mode and original manifest binding are required for down
  M("s8-run-private-read", "examples/quickstart/run-state.ts", "(stat.mode & 0o777) !== 0o600", "false", { suites: ['unit'] }),
  // s8-run-receipt-schema: Killing test: quickstart prepare: closed receipt private mode and original manifest binding are required for down
  C("s8-run-receipt-schema", [{"file": "examples/quickstart/run-state.ts", "find": "if (!validRunReceipt(value)) throw fault('RUN_INVALID');", "replace": "if (false) throw fault('RUN_INVALID');"}, {"file": "examples/quickstart/run-state.ts", "find": "  return value;\n}", "replace": "  return value as RunReceipt;\n}"}], { suites: ['unit'] }),
  // s8-prepare-compose: Killing test: quickstart prepare: changed compose body membership and unresolved approved references refuse before Docker or writes
  M("s8-prepare-compose", "examples/quickstart/prepare.ts", "if (sha256(compose) !== manifest.composeSha256) throw fault('HELPER_ASSET_MISMATCH');", "if (false) throw fault('HELPER_ASSET_MISMATCH');", { suites: ['unit'] }),
  // s8-prepare-metadata: Killing test: quickstart prepare: foreign provenance backend metadata every nonempty type and unreadiness perform zero PUTs
  M("s8-prepare-metadata", "examples/quickstart/prepare.ts", "metadata.software.version !== manifest.backend.softwareVersion", "false", { suites: ['unit'] }),
  // s8-prepare-recheck: Killing test: quickstart prepare: fresh inspection immediately before first write refuses instance substitution
  C("s8-prepare-recheck", [{"file": "examples/quickstart/seed-http.ts", "find": "      assertPrepare(target, manifest, receipt, inspected, state);", "replace": ""}, {"file": "examples/quickstart/prepare.ts", "find": "      assertPrepare(QUICKSTART_TARGET, manifest, instance, inspected, state);", "replace": ""}], { suites: ['unit'] }),
  // s8-stored-oracle: Killing test: quickstart prepare: setup oracle refuses rounded lexemes changed status identity reference unexpected meta and extra or missing resources
  M("s8-stored-oracle", "examples/quickstart/setup-oracle.ts", "if (!storedMatchesApproved(expected, stored)) throw fault('SETUP_ORACLE_FAILED');", "if (false) throw fault('SETUP_ORACLE_FAILED');", { suites: ['unit'] }),
  // s8-stored-lexeme: Killing test: quickstart prepare: setup oracle refuses rounded lexemes changed status identity reference unexpected meta and extra or missing resources
  M("s8-stored-lexeme", "examples/quickstart/setup-oracle.ts", "if (number !== undefined) return `number:${number}`;", "if (number !== undefined) return `number:${Number(number)}`;", { suites: ['unit'] }),
  // s8-stored-meta: Killing test: quickstart prepare: setup oracle refuses rounded lexemes changed status identity reference unexpected meta and extra or missing resources
  M("s8-stored-meta", "examples/quickstart/setup-oracle.ts", "['versionId', 'lastUpdated', 'source']", "['versionId', 'lastUpdated', 'source', 'unexpected']", { suites: ['unit'] }),
  // s8-stored-identities: Killing test: quickstart prepare: setup oracle refuses rounded lexemes changed status identity reference unexpected meta and extra or missing resources
  M("s8-stored-identities", "examples/quickstart/setup-oracle.ts", "if (await reader.count(type) !== expectedCount) throw fault('SETUP_ORACLE_FAILED');", "if (false) throw fault('SETUP_ORACLE_FAILED');", { suites: ['unit'] }),
  // s8-stored-version: Killing test: quickstart prepare: setup oracle refuses rounded lexemes changed status identity reference unexpected meta and extra or missing resources
  M("s8-stored-version", "examples/quickstart/setup-oracle.ts", "!resourceId(meta.versionId)", "typeof meta.versionId !== 'string'", { suites: ['unit'] }),
  // s8-stored-reference: Killing test: quickstart prepare: reference closure refuses unresolved nonstring contained and foreign routes
  M("s8-stored-reference", "examples/quickstart/setup-oracle.ts", "if (Object.hasOwn(object, 'reference') && (typeof object.reference !== 'string' || !identities.has(object.reference))) return fail();", "if (false) return fail();", { suites: ['unit'] }),
  // s8-packet-before-complete: Killing test: quickstart prepare: complete packet binds approved bodies receipt manifest observed versions and exact lexemes
  M("s8-packet-before-complete", "examples/quickstart/prepare.ts", "await write(join(directory, 'setup-packet.json'), packetBytes);", "void packetBytes;", { suites: ['unit'] }),
  // s8-helper-body: Killing test: quickstart helper manifest: modified seed bytes or a copied row hash cannot redefine approved bodies
  M("s8-helper-body", "examples/quickstart/setup-oracle.ts", "if (!listedPut(request, manifest)) throw fault('SEED_NOT_LISTED');", "if (false) throw fault('SEED_NOT_LISTED');", { suites: ['unit'] }),
  // s8-helper-manifest-check: Killing test: quickstart helper manifest: check refuses compose generator config raw input transform and output drift
  M("s8-helper-manifest-check", "scripts/quickstart/assemble-helper-manifest.ts", "if (actual !== expected) throw fault('HELPER_MANIFEST_DRIFT');", "if (false) throw fault('HELPER_MANIFEST_DRIFT');", { suites: ['unit'] }),
  // s8-docker-environment: Killing test: quickstart Docker: exact argv uses cached image compose no shell and a closed environment
  M("s8-docker-environment", "examples/quickstart/docker.ts", "for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'])", "for (const key of Object.keys(input))", { suites: ['unit'] }),
  // s8-docker-no-shell: Killing test: quickstart Docker: exact argv uses cached image compose no shell and a closed environment
  M("s8-docker-no-shell", "examples/quickstart/docker.ts", "maxBuffer: DOCKER_LIMITS.bytes, shell: false, killSignal: 'SIGKILL'", "maxBuffer: DOCKER_LIMITS.bytes, shell: true as false, killSignal: 'SIGKILL'", { suites: ['unit'] }),
  // s8-docker-no-pull: Killing test: quickstart Docker: exact argv uses cached image compose no shell and a closed environment
  M("s8-docker-no-pull", "examples/quickstart/docker.ts", "'up', '--detach', '--pull', 'never', '--no-build', '--no-deps', 'hapi'", "'up', '--detach', '--pull', 'missing', '--no-build', '--no-deps', 'hapi'", { suites: ['unit'] }),
  // s8-docker-publication: Killing test: quickstart Docker: malformed image chain provenance mount storage or loopback publication refuses
  C("s8-docker-publication", [{"file": "examples/quickstart/docker.ts", "find": "stable(host.PortBindings) !== stable(port)", "replace": "false"}, {"file": "examples/quickstart/docker.ts", "find": "stable(network.Ports) !== stable(port)", "replace": "false"}], { suites: ['unit'] }),
  // s8-docker-child: Killing test: quickstart Docker: malformed image chain provenance mount storage or loopback publication refuses
  M("s8-docker-child", "examples/quickstart/docker.ts", "if (child.Id !== b.imageConfigDigest && record(child.Descriptor).digest !== b.imageManifestDigest) return invalid();", "if (false) return invalid();", { suites: ['unit'] }),
  // s8-docker-container-image: Killing test: quickstart Docker: malformed image chain provenance mount storage or loopback publication refuses
  M("s8-docker-container-image", "examples/quickstart/docker.ts", "(c.Image !== b.imageConfigDigest && record(c.ImageManifestDescriptor).digest !== b.imageManifestDigest)", "false", { suites: ['unit'] }),
  // s8-docker-storage: Killing test: quickstart Docker: malformed image chain provenance mount storage or loopback publication refuses
  M("s8-docker-storage", "examples/quickstart/docker.ts", "c.Mounts.length !== 0", "false", { suites: ['unit'] }),
  // s8-docker-output: Killing test: quickstart Docker: output deadline and process faults are bounded fixed codes without Docker text
  M("s8-docker-output", "examples/quickstart/docker.ts", "Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > DOCKER_LIMITS.bytes", "false", { suites: ['unit'] }),
  // s8-docker-volume-recheck: Killing test: quickstart Docker: volume identities bind creation labels and fresh inspection before explicit removal
  M("s8-docker-volume-recheck", "examples/quickstart/docker.ts", "if (actual.identitySha256 !== expected.identitySha256) throw fault('CLEANUP_FOREIGN');", "if (false) throw fault('CLEANUP_FOREIGN');", { suites: ['unit'] }),
  // s8-docker-down-recheck: Killing test: quickstart Docker: identity replacement between cleanup actions prevents the removal
  M("s8-docker-down-recheck", "examples/quickstart/docker.ts", "if (!ownedInstance(actual, saved, manifest)) throw fault('CLEANUP_FOREIGN');", "if (false) throw fault('CLEANUP_FOREIGN');", { suites: ['unit'] }),
  // s8-down-manifest: Killing test: quickstart prepare: closed receipt private mode and original manifest binding are required for down
  M("s8-down-manifest", "examples/quickstart/down.ts", "receipt.manifestSha256 !== sha256(manifestBytes)", "false", { suites: ['unit'] }),
  // Packaging slice 8B helper verify guards (root-written); each killed by a named test in tests/quickstart-verify.test.ts. Unit suite only.
  // s9-verify-complete: Killing test: quickstart verify: a run is verified only as a completed prepare of these helper assets, its closed packet bound to the receipt and attempt
  M("s9-verify-complete", "examples/quickstart/verify.ts", "if (receipt.phase !== 'complete' || receipt.manifestSha256 !== manifestSha256 || receipt.composeSha256 !== manifest.composeSha256 || receipt.instance?.composeSha256 !== manifest.composeSha256) throw fault('VERIFY_RUN_INVALID');", "if (receipt.manifestSha256 !== manifestSha256 || receipt.composeSha256 !== manifest.composeSha256 || receipt.instance?.composeSha256 !== manifest.composeSha256) throw fault('VERIFY_RUN_INVALID');", { suites: ['unit'] }),
  // s9-verify-manifest: Killing test: quickstart verify setup: closed seeding attempt, compose identity and exact approved numeric lexemes are semantically bound after hashing
  M("s9-verify-manifest", "examples/quickstart/verify.ts", "if (receipt.phase !== 'complete' || receipt.manifestSha256 !== manifestSha256 || receipt.composeSha256 !== manifest.composeSha256 || receipt.instance?.composeSha256 !== manifest.composeSha256) throw fault('VERIFY_RUN_INVALID');", "if (receipt.phase !== 'complete' || receipt.composeSha256 !== manifest.composeSha256 || receipt.instance?.composeSha256 !== manifest.composeSha256) throw fault('VERIFY_RUN_INVALID');", { suites: ['unit'] }),
  M("s9-verify-packet-binding", "examples/quickstart/verify.ts", "  if (sha256(packetBytes) !== receipt.packetSha256) throw fault('VERIFY_RUN_INVALID');\n", "", { suites: ['unit'] }),
  M("s9-verify-packet-run", "examples/quickstart/verify.ts", "value.runId !== receipt.runId || value.creationNonce", "value.creationNonce", { suites: ['unit'] }),
  M("s9-verify-doctor", "examples/quickstart/verify.ts", "  if (doctor.exitCode !== 0 || lines[0] !== 'doctor: ready' || !gateway || !/^gateway: fireboat \\S+ schema=\\S+ catalog=\\S+$/.test(gateway) || !runtime\n    || !line(`source: alias=${alias} `)) throw fault('VERIFY_DOCTOR');\n", "  if (!gateway || !runtime) throw fault('VERIFY_DOCTOR');\n", { suites: ['unit'] }),
  M("s9-verify-doctor-ready", "examples/quickstart/verify.ts", "lines[0] !== 'doctor: ready'", "!lines[0]!.startsWith('doctor: ')", { suites: ['unit'] }),
  M("s9-verify-handle", "examples/quickstart/verify.ts", "      if (handle === undefined) throw fault('VERIFY_HANDLE_MISSING');\n", "", { suites: ['unit'] }),
  M("s9-verify-drain-bound", "examples/quickstart/verify.ts", "      if (pages >= VERIFY_LIMITS.drainPages) throw fault('VERIFY_DRAIN_LIMIT');\n", "", { suites: ['unit'] }),
  M("s9-verify-ttl-wait", "examples/quickstart/verify.ts", "    if (step.waitMs) await wait(step.waitMs);\n", "", { suites: ['unit'] }),
  M("s9-sort-truth", "examples/quickstart/verify.ts", "return order === 'verified_by_adapter' ? [] : ['LATEST_UNVERIFIED'];", "return [];", { suites: ['unit'] }),
  M("s9-verify-fail-status", "examples/quickstart/verify.ts", "status: failing.length ? 'fail' : 'pass', failing,", "status: 'pass', failing,", { suites: ['unit'] }),
  // s9-verify-evidence-private: Killing test: quickstart verify: 18 task-arm runs, private evidence and a summary of statuses, counts and hashes only
  M("s9-verify-evidence-private", "examples/quickstart/verify.ts", "  await atomicPrivateWrite(join(directory, 'verify-evidence.ndjson'), evidenceBytes);\n", "  await (await import('node:fs/promises')).writeFile(join(directory, 'verify-evidence.ndjson'), evidenceBytes);\n", { suites: ['unit'] }),
  M("s9-verify-task-limits", "examples/quickstart/verify.ts", "    if (!task.limits) return snapshot;\n", "    if (!task.limits || task.id.length > 0) return snapshot;\n", { suites: ['unit'] }),
  // Packaging slice 8B-transport client and observer guards (GPT-6.1-Sol); unit suite only.
  // s9-client-boundary: Killing test: quickstart client: direct client HTTP fails independently of correct MCP facts
  M("s9-client-boundary", "examples/quickstart/client.ts", "if (clientHttp !== 0) throw fault('CLIENT_HTTP_FORBIDDEN');", "if (false) throw fault('CLIENT_HTTP_FORBIDDEN');", { suites: ['unit'] }),
  // s8-client-raw-member: Killing test: quickstart client: both pinned eras preserve raw 7.00 and decode the same request frame without client HTTP
  M("s8-client-raw-member", "examples/quickstart/client.ts", "const rawText = rawMember(line, 'result');", "const rawText = 'result' in message ? JSON.stringify(message.result) : undefined;", { suites: ['unit'] }),
  // s8-client-response-id: Killing test: quickstart client: duplicate and out-of-order unknown replies refuse without borrowing another response
  M("s8-client-response-id", "examples/quickstart/client.ts", "!pending.has(id) || seen.has(id)", "false", { suites: ['unit'] }),
  // s8-client-frame-limit: Killing test: quickstart client: call/frame bounds, concurrency and deadlines refuse with fixed codes and reap the child
  M("s8-client-frame-limit", "examples/quickstart/client.ts", "maxFrame = options.maxFrameBytes ?? 2 * 1024 * 1024", "maxFrame = 8 * 1024 * 1024", { suites: ['unit'] }),
  // s8-client-call-limit: Killing test: quickstart client: call/frame bounds, concurrency and deadlines refuse with fixed codes and reap the child
  M("s8-client-call-limit", "examples/quickstart/client.ts", "if (calls >= maxCalls) throw fault('CLIENT_CALL_LIMIT');", "if (false) throw fault('CLIENT_CALL_LIMIT');", { suites: ['unit'] }),
  // s8-client-deadline: Killing test: quickstart client: call/frame bounds, concurrency and deadlines refuse with fixed codes and reap the child
  C("s8-client-deadline", [{ file: "examples/quickstart/client.ts", find: "timer = setTimeout(() => { fail('CLIENT_DEADLINE'); reject(fault('CLIENT_DEADLINE')); }, timeout);", replace: "timer = setTimeout(() => { fail('CLIENT_DEADLINE'); reject(fault('CLIENT_DEADLINE')); }, timeout * 10);" }, { file: "examples/quickstart/client.ts", find: "await client.callTool({ name: tool, arguments: input }, { timeout });", replace: "await client.callTool({ name: tool, arguments: input }, { timeout: timeout * 10 });" }], { suites: ['unit'] }),
  // s8-client-counter-barrier: Killing test: quickstart client: lagging counter pipe still attributes metadata, auth, local remainder and each upstream page exactly
  M("s8-client-counter-barrier", "examples/quickstart/client.ts", "const after = await barrier();", "const after = before;", { suites: ['unit'] }),
  // s8-client-unscoped-work: Killing test: quickstart client: observer sequence faults and work outside a call refuse rather than certifying zero
  M("s8-client-unscoped-work", "examples/quickstart/client.ts", "if (keys.some(key => before[key] !== previous[key])) throw fault('CLIENT_UNSCOPED_WORK');", "if (false) throw fault('CLIENT_UNSCOPED_WORK');", { suites: ['unit'] }),
  // s8-observer-metadata-route: Killing test: quickstart observer: cumulative barrier survives a lagging pipe, classifies exact routes and emits counts only
  M("s8-observer-metadata-route", "examples/quickstart/request-observer.ts", "r?.origin === origin && r.pathname === pathname", "r?.origin === origin && pathname?.endsWith('/metadata')", { suites: ['unit'] }),
  // s8-observer-auth-kind: Killing test: quickstart observer: cumulative barrier survives a lagging pipe, classifies exact routes and emits counts only
  M("s8-observer-auth-kind", "examples/quickstart/request-observer.ts", "request.method === 'POST' && matches(routes.auth)", "false", { suites: ['unit'] }),
  // s8-observer-cumulative: Killing test: quickstart observer: cumulative barrier survives a lagging pipe, classifies exact routes and emits counts only
  M("s8-observer-cumulative", "examples/quickstart/request-observer.ts", "work[kind]++;", "work[kind] = 1;", { suites: ['unit'] }),
  // s8-client-error-class: Killing test: quickstart client: JSON-RPC, SDK text and application errors have separate outcomes and exact failed-call work
  M("s8-client-error-class", "examples/quickstart/client.ts", "outcome: { class: 'json_rpc_error', code: message.error.code as number }", "outcome: { class: 'sdk_text_error', code: message.error.code as number }", { suites: ['unit'] }),
  // Packaging slice 8 helper package and compiled import boundary (root-written); unit suite only.
  // s8-helper-dynamic: Killing test: quickstart helper boundary: the bin reaches its modules, reviewed pure shared modules and the SDK only
  M("s8-helper-dynamic", "scripts/quickstart/check-helper-boundary.ts", "      if (DYNAMIC.test(await read(path))) throw new BoundaryFault('HELPER_BOUNDARY', `${path} uses a forbidden loading form`);\n", "", { suites: ['unit'] }),
  // s8-helper-builtin-entry: Killing test: quickstart helper boundary: the bin reaches its modules, reviewed pure shared modules and the SDK only
  M("s8-helper-builtin-entry", "scripts/quickstart/check-helper-boundary.ts", "        if (allowance === 'builtin') throw new BoundaryFault('HELPER_BOUNDARY', `${path} -> ${specifier}`);\n", "", { suites: ['unit'] }),
  // s8-helper-shared-pure: Killing test: quickstart helper boundary: the bin reaches its modules, reviewed pure shared modules and the SDK only
  M("s8-helper-shared-pure", "scripts/quickstart/check-helper-boundary.ts", "const local = allowance === 'sdk' && !HELPER_SHARED.includes(path);", "const local = allowance === 'sdk';", { suites: ['unit'] }),
  // s8-helper-module-allow: Killing test: quickstart helper boundary: the bin reaches its modules, reviewed pure shared modules and the SDK only
  M("s8-helper-module-allow", "scripts/quickstart/check-helper-boundary.ts", "if (!allowedModule(target, local)) throw", "if (target.length < 0) throw", { suites: ['unit'] }),
  // s8-helper-package-allow: Killing test: quickstart helper boundary: the bin reaches its modules, reviewed pure shared modules and the SDK only
  M("s8-helper-package-allow", "scripts/quickstart/check-helper-boundary.ts", "const dependency = local ? dependencyOf(specifier, dependencies) : undefined;", "const dependency: string | undefined = specifier;", { suites: ['unit'] }),
  // s8-helper-dependency-list: Killing test: quickstart helper boundary: the bin reaches its modules, reviewed pure shared modules and the SDK only
  M("s8-helper-dependency-list", "scripts/quickstart/check-helper-boundary.ts", "const dependency = local ? dependencyOf(specifier, dependencies) : undefined;", "const dependency = local ? specifier : undefined;", { suites: ['unit'] }),
  // s8-helper-flat-directory: Killing test: quickstart helper boundary: the bin reaches its modules, reviewed pure shared modules and the SDK only
  M("s8-helper-flat-directory", "scripts/quickstart/check-helper-boundary.ts", "&& !path.slice(HELPER_DIRECTORY.length).includes('/') &&", "&&", { suites: ['unit'] }),
  // s8-helper-lock-version: Killing test: quickstart helper boundary: the nested layout runs the bin with only the locked packages visible
  M("s8-helper-lock-version", "scripts/quickstart/check-helper-boundary.ts", "      if (installed.version !== entry.version) throw new BoundaryFault('HELPER_LOAD', `${path} ${installed.version}`);\n", "", { suites: ['unit'] }),
  // s8-helper-bin-run: Killing test: quickstart helper boundary: the nested layout runs the bin with only the locked packages visible
  M("s8-helper-bin-run", "scripts/quickstart/check-helper-boundary.ts", "if (run.status !== 2 || run.stderr !== 'CLI_USAGE\\n') throw", "if (run.status === null) throw", { suites: ['unit'] }),
  // s8-helper-entry-realpath: Killing test: quickstart helper entry points run when started through a symlink such as an npm bin shim
  M("s8-helper-entry-realpath", "examples/quickstart/main.ts", "try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }", "try { return entry === fileURLToPath(import.meta.url); } catch { return false; }", { suites: ['unit'] }),
  // s8-timing-entry-realpath: Killing test: quickstart helper entry points run when started through a symlink such as an npm bin shim
  M("s8-timing-entry-realpath", "examples/quickstart/timing.ts", "try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }", "try { return entry === fileURLToPath(import.meta.url); } catch { return false; }", { suites: ['unit'] }),
  // Packaging slice 8 round 3 (root-written): bound verify, per-call invariants, upstream paging, retained slices, full task meaning; unit suite only.
  // s9-oracle-cited-delivered: Killing test: package oracle: a query chain keeps its bound type across empty pages and refuses a returned resource of another type
  M("s9-oracle-cited-delivered", "packages/evals/src/evidence-oracle.ts", "canonicalJson(evidence.delivered?.[0] ?? envelope)", "canonicalJson(envelope)", { suites: ['unit'] }),
  // s9-oracle-paging-first: Killing test: package oracle: upstream paging serves every retained remainder before the next upstream page
  M("s9-oracle-paging-first", "packages/evals/src/evidence-oracle.ts", " || work[0]!.clinical !== 1) return fail('upstream_work_mismatch'", ") return fail('upstream_work_mismatch'", { suites: ['unit'] }),
  // s9-oracle-paging-single: Killing test: package oracle: upstream paging serves every retained remainder before the next upstream page
  M("s9-oracle-paging-single", "packages/evals/src/evidence-oracle.ts", "if (work.some(w => w.clinical !== 0 && w.clinical !== 1) || work[0]!.clinical !== 1)", "if (work[0]!.clinical !== 1)", { suites: ['unit'] }),
  // s9-oracle-paging-pages: Killing test: package oracle: upstream paging serves every retained remainder before the next upstream page
  M("s9-oracle-paging-pages", "packages/evals/src/evidence-oracle.ts", "i < runs.length - 1 ? n !== check.page_size : n < 1 || n > check.page_size", "n < 1 || n > check.page_size", { suites: ['unit'] }),
  // s9-oracle-paging-last: Killing test: package oracle: upstream paging serves every retained remainder before the next upstream page
  M("s9-oracle-paging-last", "packages/evals/src/evidence-oracle.ts", "i < runs.length - 1 ? n !== check.page_size : n < 1 || n > check.page_size", "i < runs.length - 1 ? n !== check.page_size : false", { suites: ['unit'] }),
  // s9-oracle-paging-envelopes: Killing test: package oracle: upstream paging serves every retained remainder before the next upstream page
  M("s9-oracle-paging-envelopes", "packages/evals/src/evidence-oracle.ts", "if (!work?.length || work.length !== rows.length) return fail('harness_error'", "if (!work?.length) return fail('harness_error'", { suites: ['unit'] }),
  // s9-oracle-retained-identity: Killing test: package oracle: a retained read answers exactly the issuing response's rows, versions and facts
  M("s9-oracle-retained-identity", "packages/evals/src/evidence-oracle.ts", "if (!expected.length || !deepEqual(rows, expected.map(r => identity(r.resourceType, r.id, asRec(r.meta)?.versionId))))", "if (!expected.length)", { suites: ['unit'] }),
  // s9-oracle-retained-count: Killing test: package oracle: a retained read answers exactly the issuing response's rows, versions and facts
  M("s9-oracle-retained-count", "packages/evals/src/evidence-oracle.ts", "if (check.whole_count && envelope.data.resource_count !== all.length) return fail(", "if (check.whole_count && all.length < 0) return fail(", { suites: ['unit'] }),
  // s9-oracle-retained-fields: Killing test: package oracle: a retained read answers exactly the issuing response's rows, versions and facts
  M("s9-oracle-retained-fields", "packages/evals/src/evidence-oracle.ts", "if (want === undefined || !deepEqual(resolvePath(row, field), want)) return fail(", "if (want === undefined) return fail(", { suites: ['unit'] }),
  // s9-oracle-retained-field-present: Killing test: package oracle: a retained read answers exactly the issuing response's rows, versions and facts
  M("s9-oracle-retained-field-present", "packages/evals/src/evidence-oracle.ts", "if (want === undefined || !deepEqual(resolvePath(row, field), want)) return fail(", "if (want !== undefined && !deepEqual(resolvePath(row, field), want)) return fail(", { suites: ['unit'] }),
  // s9-oracle-retained-source-first: Killing test: package oracle: a retained read answers exactly the issuing response's rows, versions and facts
  M("s9-oracle-retained-source-first", "packages/evals/src/evidence-oracle.ts", "const issuing = calls.find(call => call.step === check.from_step && call.envelope);", "const issuing = calls.findLast(call => call.step === check.from_step && call.envelope);", { suites: ['unit'] }),
  // s9-oracle-retained-earlier: Killing test: package oracle: a retained read answers exactly the issuing response's rows, versions and facts
  M("s9-oracle-retained-earlier", "packages/evals/src/evidence-oracle.ts", "check.from_step < 0 || check.from_step >= step)", "check.from_step < 0 || check.from_step > step)", { suites: ['unit'] }),
  // s9-oracle-arm-before-chain: Killing test: package oracle: an arm-specific check is incomparable on other arms before any selection, and work and outcome codes are exact
  C("s9-oracle-arm-before-chain", [{"file":"packages/evals/src/evidence-oracle.ts","find":"  if (check.arms && !check.arms.includes(arm)) return { ...base, status: 'incomparable', detail: check.incomparableReason ?? `not comparable for arm ${arm}` };\n  const answered","replace":"  const answered"},{"file":"packages/evals/src/evidence-oracle.ts","find":"  if (resolved.error) return { check_id: check.id, kind: check.kind, status: 'fail', cause: 'coverage_invalid', detail: resolved.error };\n","replace":"  if (resolved.error) return { check_id: check.id, kind: check.kind, status: 'fail', cause: 'coverage_invalid', detail: resolved.error };\n  if (check.arms && !check.arms.includes(arm)) return { ...base, status: 'incomparable', detail: check.incomparableReason ?? `not comparable for arm ${arm}` };\n"}], { suites: ['unit'] }),
  // s9-package-comparator-claim: Killing test: package tasks: three tasks whose checks bind to real steps, cite observed versions and use unique ids
  M("s9-package-comparator-claim", "packages/evals/src/package-tasks.ts", "    cited(`${prefix}-comparator`, step, source, 'Observation', f, 'valueQuantity.comparator', stated(f.comparator)),\n", "", { suites: ['unit'] }),
  // s9-package-coding-version-claim: Killing test: package tasks: three tasks whose checks bind to real steps, cite observed versions and use unique ids
  M("s9-package-coding-version-claim", "packages/evals/src/package-tasks.ts", "    cited(`${prefix}-code-version`, step, source, 'Observation', f, `code.coding.${f.coding}.version`, stated(f.codingVersion)),\n", "", { suites: ['unit'] }),
  // s9-package-discovery: Killing test: package tasks: three tasks whose checks bind to real steps, cite observed versions and use unique ids
  M("s9-package-discovery", "packages/evals/src/package-tasks.ts", "      ...parameter(1, 'code', 'token'), ...parameter(2, 'date', 'date'), comparator('ge'), comparator('lt'),\n", "", { suites: ['unit'] }),
  // s9-package-document-status: Killing test: package tasks: three tasks whose checks bind to real steps, cite observed versions and use unique ids
  M("s9-package-document-status", "packages/evals/src/package-tasks.ts", "      cited('document-status', 4, source, 'DocumentReference', facts.document, 'status', { equals: facts.document.status }),\n", "", { suites: ['unit'] }),
  // s9-package-status-full-claims: Killing test: package tasks: three tasks whose checks bind to real steps, cite observed versions and use unique ids
  M("s9-package-status-full-claims", "packages/evals/src/package-tasks.ts", "      ...labClaims('corrected', 0, facts.corrected), ...labClaims('entered-in-error', 1, facts.enteredInError),", "      ...labClaims('corrected', 0, facts.corrected).slice(0, 2), ...labClaims('entered-in-error', 1, facts.enteredInError).slice(0, 2),", { suites: ['unit'] }),
  // s9-package-paging: Killing test: package tasks: three tasks whose checks bind to real steps, cite observed versions and use unique ids
  M("s9-package-paging", "packages/evals/src/package-tasks.ts", "      { kind: 'upstreamPaging', id: 'labs-remainder-before-next-page', step: 0, page_size: 100 },", "      { kind: 'upstreamWork', id: 'labs-remainder-before-next-page', step: 0, response_index: 1, clinical: 0 } as Check,", { suites: ['unit'] }),
  // s9-package-retained-inventory: Killing test: package tasks: three tasks whose checks bind to real steps, cite observed versions and use unique ids
  M("s9-package-retained-inventory", "packages/evals/src/package-tasks.ts", "      { kind: 'retainedSlice', id: 'projection-inventory', step: 2, action: 'project', from_step: 0, view: 'resources', offset: 0, limit: RETAINED_PAGE, fields: [...PROJECTED] },\n", "", { suites: ['unit'] }),
  // s9-package-retained-local: Killing test: package tasks: three tasks whose checks bind to real steps, cite observed versions and use unique ids
  M("s9-package-retained-local", "packages/evals/src/package-tasks.ts", "      ...[1, 2, 3, 4].map((step): Check => ({ kind: 'upstreamWork', id: `retained-local-${step}`, step, clinical: 0, metadata: 0 })),\n", "", { suites: ['unit'] }),
  // s9-verify-attempt: Killing test: quickstart verify: a run is verified only as a completed prepare of these helper assets, its closed packet bound to the receipt and attempt
  M("s9-verify-attempt", "examples/quickstart/verify.ts", "  if (sha256(attemptBytes) !== receipt.attemptSha256) throw fault('VERIFY_RUN_INVALID');\n", "", { suites: ['unit'] }),
  // s9-verify-packet-keys: Killing test: quickstart verify: a run is verified only as a completed prepare of these helper assets, its closed packet bound to the receipt and attempt
  M("s9-verify-packet-keys", "examples/quickstart/verify.ts", "if (!isRecord(value) || !hasKeys(value, ['schema', 'runId', 'creationNonce', 'receiptSha256', 'manifestSha256', 'instanceSha256', 'resources'])\n", "if (!isRecord(value)\n", { suites: ['unit'] }),
  // s9-verify-packet-schema: Killing test: quickstart verify: a run is verified only as a completed prepare of these helper assets, its closed packet bound to the receipt and attempt
  M("s9-verify-packet-schema", "examples/quickstart/verify.ts", "    || value.schema !== 'fireboat-quickstart-setup/1' || value.runId", "    || value.runId", { suites: ['unit'] }),
  // s9-verify-packet-attempt: Killing test: quickstart verify: a run is verified only as a completed prepare of these helper assets, its closed packet bound to the receipt and attempt
  M("s9-verify-packet-attempt", "examples/quickstart/verify.ts", "    || value.receiptSha256 !== receipt.attemptSha256 || value.manifestSha256", "    || value.manifestSha256", { suites: ['unit'] }),
  // s9-verify-packet-instance: Killing test: quickstart verify: a run is verified only as a completed prepare of these helper assets, its closed packet bound to the receipt and attempt
  M("s9-verify-packet-instance", "examples/quickstart/verify.ts", "    || value.instanceSha256 !== sha256(jsonBytes(receipt.instance)) || !Array.isArray(value.resources)", "    || !Array.isArray(value.resources)", { suites: ['unit'] }),
  // s9-verify-packet-unique: Killing test: quickstart verify: a run is verified only as a completed prepare of these helper assets, its closed packet bound to the receipt and attempt
  M("s9-verify-packet-unique", "examples/quickstart/verify.ts", "typeof row.target !== 'string' || targets.has(row.target)\n", "typeof row.target !== 'string'\n", { suites: ['unit'] }),
  // s9-verify-packet-complete: Killing test: quickstart verify: a run is verified only as a completed prepare of these helper assets, its closed packet bound to the receipt and attempt
  M("s9-verify-packet-complete", "examples/quickstart/verify.ts", "  return targets.size === puts.length && puts.every(put => targets.has(put.target));", "  return puts.length > 0;", { suites: ['unit'] }),
  // s9-verify-packet-row-closed: Killing test: quickstart verify: a run is verified only as a completed prepare of these helper assets, its closed packet bound to the receipt and attempt
  M("s9-verify-packet-row-closed", "examples/quickstart/verify.ts", "if (!isRecord(row) || !hasKeys(row, ['target', 'versionId', 'rawSha256', 'numbers']) ||", "if (!isRecord(row) ||", { suites: ['unit'] }),
  // s9-verify-packet-row-version: Killing test: quickstart verify: a run is verified only as a completed prepare of these helper assets, its closed packet bound to the receipt and attempt
  M("s9-verify-packet-row-version", "examples/quickstart/verify.ts", "|| typeof row.versionId !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(row.versionId) ||", "|| typeof row.versionId !== 'string' ||", { suites: ['unit'] }),
  // s9-verify-packet-row-digest: Killing test: quickstart verify: a run is verified only as a completed prepare of these helper assets, its closed packet bound to the receipt and attempt
  M("s9-verify-packet-row-digest", "examples/quickstart/verify.ts", " || !isSha256(row.rawSha256) ||", " ||", { suites: ['unit'] }),
  // s9-verify-config-target: Killing test: quickstart verify: the config must name the manifest target and the seed's natural patient; one private snapshot serves the doctor and every session
  M("s9-verify-config-target", "examples/quickstart/verify.ts", " || value.source.baseUrl !== target ||", " ||", { suites: ['unit'] }),
  // s9-verify-config-patient: Killing test: quickstart verify: the config must name the manifest target and the seed's natural patient; one private snapshot serves the doctor and every session
  M("s9-verify-config-patient", "examples/quickstart/verify.ts", "natural.length !== 1 || value.patientId !== natural[0]!.id) return invalid();", "natural.length !== 1 || typeof value.patientId !== 'string') return invalid();", { suites: ['unit'] }),
  // s9-verify-config-mode: Killing test: quickstart verify: the config must name the manifest target and the seed's natural patient; one private snapshot serves the doctor and every session
  M("s9-verify-config-mode", "examples/quickstart/verify.ts", " || value.mode !== 'synthetic'", "", { suites: ['unit'] }),
  // s9-verify-config-alias: Killing test: quickstart verify: the config must name the manifest target and the seed's natural patient; one private snapshot serves the doctor and every session
  M("s9-verify-config-alias", "examples/quickstart/verify.ts", "    || !/^[A-Za-z0-9_-]{1,80}$/.test(value.source.alias) ||", "    ||", { suites: ['unit'] }),
  // s9-verify-doctor-snapshot: Killing test: quickstart verify: the config must name the manifest target and the seed's natural patient; one private snapshot serves the doctor and every session
  M("s9-verify-doctor-snapshot", "examples/quickstart/verify.ts", "({ node: input.node, cli: input.cli, config: snapshot });", "({ node: input.node, cli: input.cli, config: input.config });", { suites: ['unit'] }),
  // s9-verify-session-snapshot: Killing test: quickstart verify: the config must name the manifest target and the seed's natural patient; one private snapshot serves the doctor and every session
  M("s9-verify-session-snapshot", "examples/quickstart/verify.ts", "    if (!task.limits) return snapshot;", "    if (!task.limits) return input.config;", { suites: ['unit'] }),
  // s9-verify-doctor-gateway: Killing test: quickstart verify: the doctor must report ready before any task runs
  M("s9-verify-doctor-gateway", "examples/quickstart/verify.ts", " || !gateway || !/^gateway: fireboat \\S+ schema=\\S+ catalog=\\S+$/.test(gateway) || !runtime", " || !gateway || !runtime", { suites: ['unit'] }),
  // s9-verify-doctor-runtime: Killing test: quickstart verify: the config must name the manifest target and the seed's natural patient; one private snapshot serves the doctor and every session
  M("s9-verify-doctor-runtime", "examples/quickstart/verify.ts", "runtime = line('runtime: ');", "runtime = line('doctor: ');", { suites: ['unit'] }),
  // s9-verify-doctor-source: Killing test: quickstart verify: the doctor must report ready before any task runs
  M("s9-verify-doctor-source", "examples/quickstart/verify.ts", "    || !line(`source: alias=${alias} `)) throw fault('VERIFY_DOCTOR');", "    ) throw fault('VERIFY_DOCTOR');", { suites: ['unit'] }),
  // s9-verify-inv-bytes: Killing test: quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read
  M("s9-verify-inv-bytes", "examples/quickstart/verify.ts", "if (call.rawText === undefined || Buffer.byteLength(call.rawText) !== call.resultBytes || call.resultBytes > ceiling)", "if (call.rawText === undefined || call.resultBytes > ceiling)", { suites: ['unit'] }),
  // s9-verify-inv-ceiling: Killing test: quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read
  M("s9-verify-inv-ceiling", "examples/quickstart/verify.ts", "Buffer.byteLength(call.rawText) !== call.resultBytes || call.resultBytes > ceiling)", "Buffer.byteLength(call.rawText) !== call.resultBytes)", { suites: ['unit'] }),
  // s9-verify-inv-decoded: Killing test: quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read
  M("s9-verify-inv-decoded", "examples/quickstart/verify.ts", "        if (canonicalJson(structured) !== canonicalJson(call.envelope)) failing.add(`invariant:decoded:${step}`);\n", "", { suites: ['unit'] }),
  // s9-verify-inv-accounting: Killing test: quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read
  M("s9-verify-inv-accounting", "examples/quickstart/verify.ts", "        if (call.envelope.budget?.bytes_returned !== call.resultBytes || call.envelope.budget?.byte_limit !== ceiling) failing.add(`invariant:accounting:${step}`);\n", "", { suites: ['unit'] }),
  // s9-verify-inv-ceiling-limit: Killing test: quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read
  M("s9-verify-inv-ceiling-limit", "examples/quickstart/verify.ts", " || call.envelope.budget?.byte_limit !== ceiling) failing.add(", ") failing.add(", { suites: ['unit'] }),
  // s9-verify-inv-identity: Killing test: quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read
  M("s9-verify-inv-identity", "examples/quickstart/verify.ts", "  if (identities.size > 1) failing.add('invariant:identity');\n", "", { suites: ['unit'] }),
  // s9-verify-inv-outcome-alone: Killing test: quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read
  M("s9-verify-inv-outcome-alone", "examples/quickstart/verify.ts", "if (outcome ? own.length !== 1 || !expected.some(", "if (outcome ? !expected.some(", { suites: ['unit'] }),
  // s9-verify-inv-outcome-expected: Killing test: quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read
  M("s9-verify-inv-outcome-expected", "examples/quickstart/verify.ts", "own.length !== 1 || !expected.some(c => c.outcome === outcome.class && String(c.code) === String(outcome.code)) : !call.envelope)", "own.length !== 1 : !call.envelope)", { suites: ['unit'] }),
  // s9-verify-inv-envelope: Killing test: quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read
  M("s9-verify-inv-envelope", "examples/quickstart/verify.ts", "String(c.code) === String(outcome.code)) : !call.envelope)", "String(c.code) === String(outcome.code)) : false)", { suites: ['unit'] }),
  // s9-verify-inv-chain: Killing test: quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read
  M("s9-verify-inv-chain", "examples/quickstart/verify.ts", "if (resolveQueryChain(own.flatMap(call => (call.envelope ? [call.envelope] : [])), definition.resourceType).error) failing.add(`invariant:chain:${step}`);", "", { suites: ['unit'] }),
  // s9-verify-inv-missing: Killing test: quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read
  M("s9-verify-inv-missing", "examples/quickstart/verify.ts", "    if (!own.length) failing.add(`invariant:missing:${step}`);\n", "", { suites: ['unit'] }),
  // s9-verify-inv-judged: Killing test: quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read
  M("s9-verify-inv-judged", "examples/quickstart/verify.ts", "  const failing = [...invariants, ...results.filter(", "  const failing = [...results.filter(", { suites: ['unit'] }),
  // s9-verify-coverage-limitations: Killing test: quickstart verify: the latest result is reported unverified unless an adapter verified the order, and failing checks fail the run
  M("s9-verify-coverage-limitations", "examples/quickstart/verify.ts", "limitations: [...new Set([...orderLimitations(task, calls), ...coverageLimitations(calls)])].sort() } };", "limitations: orderLimitations(task, calls) } };", { suites: ['unit'] }),
  // s9-verify-continuation-limitation: Killing test: quickstart verify: the latest result is reported unverified unless an adapter verified the order, and failing checks fail the run
  M("s9-verify-continuation-limitation", "examples/quickstart/verify.ts", "coverage.some(c => c?.query_evidence === 'unverified_continuation') ? ['CONTINUATION_UNVERIFIED'] : []", "[]", { suites: ['unit'] }),
  // s8-helper-loaded: Killing test: quickstart helper boundary: the bin reaches its modules, reviewed pure shared modules and the SDK only
  M("s8-helper-loaded", "scripts/quickstart/check-helper-boundary.ts", "      if (!graph.loaded.has(path)) throw new BoundaryFault('HELPER_LOAD', `${path} did not resolve`);\n", "", { suites: ['unit'] }),
  // s8-helper-dynamic-comments: Killing test: quickstart helper boundary: the bin reaches its modules, reviewed pure shared modules and the SDK only
  M("s8-helper-dynamic-comments", "scripts/quickstart/check-helper-boundary.ts", "        if (node.kind === SyntaxKind.CallExpression && (node as CallExpression).expression.kind === SyntaxKind.ImportKeyword) forbidden = true;", "        if (node.kind === SyntaxKind.CallExpression && (node as CallExpression).expression.kind === SyntaxKind.ImportKeyword && /\\bimport\\s*\\(/.test(node.getText())) forbidden = true;", { suites: ['unit'] }),
  // Packaging slice 8 round 5 (GPT-6.1-Sol): response validation, launch and setup binding, effective ceilings, retained details, loading forms; unit suite only.
  // s8-verify-last-drain-handle: Killing test: quickstart verify: steps reuse earlier handles, wait out the TTL, drain within bounds and use the arm's view
  M("s8-verify-last-drain-handle", "examples/quickstart/verify.ts", "      recorded = keep(index, 'fhir_page', pageInput, await session.call('fhir_page', pageInput));", "      recorded = keep(index, 'fhir_page', pageInput, await session.call('fhir_page', pageInput));\n      handles[index] = recorded.envelope?.result?.handle ?? handles[index];", { suites: ['unit'] }),
  // s8-verify-skip-cited-facts: Killing test: quickstart verify task checks: gateway-rendered negative facts and NOT_FOUND messages cannot be skipped
  M("s8-verify-skip-cited-facts", "examples/quickstart/verify.ts", "const results = task.checks.map(check => {", "const results = task.checks.filter(check => check.kind !== 'citedFact').map(check => {", { suites: ['unit'] }),
  // s8-boundary-get-builtin-module: Killing test: package oracle kernel: alone in an empty directory, the emitted kernel loads and its imports are node:crypto and the vocabulary only
  M("s8-boundary-get-builtin-module", "packages/evals/src/evidence-oracle.ts", "    ...(extras?.callOutcomes ? { sharedOutcomes: extras.callOutcomes } : {}), ...(extras?.upstreamProvenance ? { upstreamProvenance: extras.upstreamProvenance } : {}) });\n}", "    ...(extras?.callOutcomes ? { sharedOutcomes: extras.callOutcomes } : {}), ...(extras?.upstreamProvenance ? { upstreamProvenance: extras.upstreamProvenance } : {}) });\n}\nexport const reviewRuntimeFs = process.getBuiltinModule('node:fs').readFileSync;", { suites: ['unit'] }),
  // s8-verify-packet-number-shape: Killing test: quickstart verify: a run is verified only as a completed prepare of these helper assets, its closed packet bound to the receipt and attempt
  M("s8-verify-packet-number-shape", "examples/quickstart/verify.ts", "if (!put || canonicalJson(row.numbers) !== canonicalJson(numbersOf(parseResource(put.body)))) return false;", "if (!put) return false;", { suites: ['unit'] }),
  // s8-retained-skip-code: Killing test: package oracle: a retained read answers exactly the issuing response's rows, versions and facts
  M("s8-retained-skip-code", "packages/evals/src/evidence-oracle.ts", "        const want = resolvePath(expected[i], field);", "        if (field === 'code') continue;\n        const want = resolvePath(expected[i], field);", { suites: ['unit'] }),
  // s8-verify-skip-not-found-messages: Killing test: quickstart verify task checks: gateway-rendered negative facts and NOT_FOUND messages cannot be skipped
  M("s8-verify-skip-not-found-messages", "examples/quickstart/verify.ts", "const results = task.checks.map(check => {", "const results = task.checks.filter(check => !['wrong-patient-message', 'absent-message'].includes(check.id)).map(check => {", { suites: ['unit'] }),
  // s8-cited-absent-null: Killing test: package oracle: citedFact binds the citation, the decoded value and the raw token to one cited occurrence of one response
  M("s8-cited-absent-null", "packages/evals/src/evidence-oracle.ts", "if (check.absent) return value === undefined ? pass()", "if (check.absent) return value == null ? pass()", { suites: ['unit'] }),
  // s9-r5-response-schema: Killing test: quickstart verify response gate: trusted identity, complete provenance, resource-free safe errors and exact visible text are independently judged
  M("s9-r5-response-schema", "examples/quickstart/verify.ts", "e.schema_version !== '0.3' || ", "", { suites: ['unit'] }),
  // s9-r5-response-source: Killing test: quickstart verify response gate: trusted identity, complete provenance, resource-free safe errors and exact visible text are independently judged
  M("s9-r5-response-source", "examples/quickstart/verify.ts", "e.source.alias !== binding.alias || ", "", { suites: ['unit'] }),
  // s9-r5-response-fhir: Killing test: quickstart verify response gate: trusted identity, complete provenance, resource-free safe errors and exact visible text are independently judged
  M("s9-r5-response-fhir", "examples/quickstart/verify.ts", "e.source.fhir_version !== binding.fhirVersion || ", "", { suites: ['unit'] }),
  // s9-r5-response-context: Killing test: quickstart verify response gate: trusted identity, complete provenance, resource-free safe errors and exact visible text are independently judged
  M("s9-r5-response-context", "examples/quickstart/verify.ts", "e.context.mode !== 'patient-bound' || ", "", { suites: ['unit'] }),
  // s9-r5-response-text: Killing test: quickstart verify response gate: trusted identity, complete provenance, resource-free safe errors and exact visible text are independently judged
  M("s9-r5-response-text", "examples/quickstart/verify.ts", "|| result.content[0].text !== rawMember(rawText, 'structuredContent') ", "", { suites: ['unit'] }),
  // s9-r5-response-safe-error: Killing test: quickstart verify response gate: trusted identity, complete provenance, resource-free safe errors and exact visible text are independently judged
  M("s9-r5-response-safe-error", "examples/quickstart/verify.ts", "&& e.error.safe_message === safe ", "", { suites: ['unit'] }),
  // s9-r5-response-error-body: Killing test: quickstart verify response gate: trusted identity, complete provenance, resource-free safe errors and exact visible text are independently judged
  M("s9-r5-response-error-body", "examples/quickstart/verify.ts", "&& Object.keys(data).length === 0 ", "", { suites: ['unit'] }),
  // s9-r5-response-counts: Killing test: quickstart verify response gate: trusted identity, complete provenance, resource-free safe errors and exact visible text are independently judged
  M("s9-r5-response-counts", "examples/quickstart/verify.ts", "p.returned_matches !== count || p.returned_includes !== 0 || ", "", { suites: ['unit'] }),
  // s9-r5-response-provenance: Killing test: quickstart verify response gate: trusted identity, complete provenance, resource-free safe errors and exact visible text are independently judged
  M("s9-r5-response-provenance", "examples/quickstart/verify.ts", "!Array.isArray(e.provenance) || e.provenance.length !== count || citedIndexes(e).size !== count\n        || e.provenance.some(v => !objectShape(v, ['resource_index', 'retrieved_at']) || !validTimestamp(v.retrieved_at))\n        || ", "", { suites: ['unit'] }),
  // s9-r5-response-page-size: Killing test: quickstart verify search gate: gateway-rendered 32768 drain pages keep trusted page size, counts, provenance and exact allowances in all arms
  M("s9-r5-response-page-size", "examples/quickstart/verify.ts", "p.requested_page_size !== pageSize || ", "", { suites: ['unit'] }),
  // s9-r5-effective-ceiling: Killing test: quickstart verify search gate: gateway-rendered 32768 drain pages keep trusted page size, counts, provenance and exact allowances in all arms
  M("s9-r5-effective-ceiling", "examples/quickstart/verify.ts", "return Math.min(isRecord(input.output) && typeof input.output.max_bytes === 'number' ? input.output.max_bytes : binding.defaultBytes, binding.maxBytes);", "return isRecord(input.output) && typeof input.output.max_bytes === 'number' ? input.output.max_bytes : binding.defaultBytes;", { suites: ['unit'] }),
  // s9-r5-attempt-semantics: Killing test: quickstart verify setup: closed seeding attempt, compose identity and exact approved numeric lexemes are semantically bound after hashing
  M("s9-r5-attempt-semantics", "examples/quickstart/verify.ts", "  if (!validRunReceipt(attempt) || attempt.phase !== 'seeding' || attempt.attemptSha256 !== null || attempt.packetSha256 !== null\n    || canonicalJson(attempt) !== canonicalJson({ ...receipt, phase: 'seeding', attemptSha256: null, packetSha256: null })) throw fault('VERIFY_RUN_INVALID');\n", "", { suites: ['unit'] }),
  // s9-r5-compose-identity: Killing test: quickstart verify setup: closed seeding attempt, compose identity and exact approved numeric lexemes are semantically bound after hashing
  M("s9-r5-compose-identity", "examples/quickstart/verify.ts", " || receipt.composeSha256 !== manifest.composeSha256 || receipt.instance?.composeSha256 !== manifest.composeSha256", "", { suites: ['unit'] }),
  // s9-r5-verify-lock: Killing test: quickstart verify launch binding: an exclusive run lock, unique outputs, actual config hashes and a changed transitive artifact refusal
  M("s9-r5-verify-lock", "examples/quickstart/verify.ts", "const unlock = await lockRun(input.runDirectory, 'verify.lock');", "const unlock = async () => {};", { suites: ['unit'] }),
  // s9-r5-unique-output: Killing test: quickstart verify launch binding: an exclusive run lock, unique outputs, actual config hashes and a changed transitive artifact refusal
  M("s9-r5-unique-output", "examples/quickstart/verify.ts", "const directory = await mkdtemp(join(input.runDirectory, 'verify-'));", "const directory = input.runDirectory;", { suites: ['unit'] }),
  // s9-r5-artifact-closure: Killing test: quickstart verify launch binding: an exclusive run lock, unique outputs, actual config hashes and a changed transitive artifact refusal
  M("s9-r5-artifact-closure", "examples/quickstart/verify.ts", "return { sha256: sha256(jsonBytes(rows)), files: fileCount };", "return { sha256: sha256(await readBounded(cli, VERIFY_LIMITS.cliBytes)), files: 1 };", { suites: ['unit'] }),
  // s9-r5-artifact-after: Killing test: quickstart verify launch binding: an exclusive run lock, unique outputs, actual config hashes and a changed transitive artifact refusal
  M("s9-r5-artifact-after", "examples/quickstart/verify.ts", "  if (after.sha256 !== artifact.sha256 || after.files !== artifact.files || sha256(await readBounded(input.cli, VERIFY_LIMITS.cliBytes)) !== sha256(cliBytes)) throw fault('VERIFY_DOCTOR');\n", " ", { suites: ['unit'] }),
  // s9-r5-retained-offset-result: Killing test: package oracle: a retained read answers exactly the issuing response's rows, versions and facts
  M("s9-r5-retained-offset-result", "packages/evals/src/evidence-oracle.ts", "      if (envelope.data.next_offset !== next || !source.result || !deepEqual(envelope.result, source.result)) return fail('data_mismatch', 'retained offset or handle/expiry/formats differs from the issuing response');\n", "", { suites: ['unit'] }),
  // s9-r5-retained-format: Killing test: package oracle: a retained read answers exactly the issuing response's rows, versions and facts
  M("s9-r5-retained-format", "packages/evals/src/evidence-oracle.ts", "      if (envelope.transform.format !== format || envelope.transform.requested_format !== format) return fail('data_mismatch', 'retained format controls differ from the request');\n", "", { suites: ['unit'] }),
  // s9-r5-retained-omission-index: Killing test: package oracle: a retained read answers exactly the issuing response's rows, versions and facts
  M("s9-r5-retained-omission-index", "packages/evals/src/evidence-oracle.ts", "        if (omissions.some((row, i) => row.resource_index !== i)) return fail('data_mismatch', 'retained omission indexes must name the returned slice positions');\n", "", { suites: ['unit'] }),
  // s9-r5-retained-omission-detail: Killing test: package oracle: a retained read answers exactly the issuing response's rows, versions and facts
  M("s9-r5-retained-omission-detail", "packages/evals/src/evidence-oracle.ts", "        if (policy && omissions.some(row => !deepEqual(row.omitted_fields, policy.omitted_fields === 'issuing_transform' ? source.transform.omitted_fields : policy.omitted_fields)\n          || !deepEqual(row.withheld_reasons, policy.withheld_reasons) || row.recipe_id !== policy.recipe_id || row.interpretation !== 'clinical_projection'))\n          return fail('data_mismatch', 'retained omission details differ from the requested view of the issuing snapshot');\n", "", { suites: ['unit'] }),
  // s9-r5-retained-pagination: Killing test: package oracle: a retained read answers exactly the issuing response's rows, versions and facts
  M("s9-r5-retained-pagination", "packages/evals/src/evidence-oracle.ts", "        if (!envelope.pagination || envelope.pagination.has_more !== more || envelope.pagination.returned_matches !== expected.length || envelope.pagination.returned_includes !== 0\n          || envelope.pagination.next_cursor !== undefined || envelope.pagination.requested_page_size !== undefined) return fail('pagination_invalid', 'retained slice pagination differs from the issuing count');\n", "", { suites: ['unit'] }),
  // s9-r5-retained-action: Killing test: package oracle: a retained read answers exactly the issuing response's rows, versions and facts
  M("s9-r5-retained-action", "packages/evals/src/evidence-oracle.ts", "        if (check.action && envelope.transform.projected !== (check.action === 'project' || format === 'compact')) return fail('data_mismatch', 'retained projection controls differ from the action');\n", "", { suites: ['unit'] }),
  // s9-r5-retained-provenance: Killing test: package oracle: a retained read answers exactly the issuing response's rows, versions and facts
  M("s9-r5-retained-provenance", "packages/evals/src/evidence-oracle.ts", "        const indexes = citedIndexes(envelope), sourceIndexes = citedIndexes(source);\n        if (indexes.size !== expected.length || sourceIndexes.size !== all.length) return fail('provenance_missing', 'every retained and issuing row must be cited');\n        for (let i = 0; i < expected.length; i++) {\n          const time = envelope.provenance?.find(p => p.resource_index === i)?.retrieved_at;\n          if (time !== source.provenance?.find(p => p.resource_index === check.offset + i)?.retrieved_at) return fail('provenance_missing', 'retained retrieval time differs from the issuing occurrence');\n        }\n", "", { suites: ['unit'] }),
  // s9-r5-retained-numeric: Killing test: package oracle: a retained read answers exactly the issuing response's rows, versions and facts
  M("s9-r5-retained-numeric", "packages/evals/src/evidence-oracle.ts", "          if (!deepEqual(numericTokens(want), numericTokens(got))) return fail('expected_fact_mismatch', `retained resource ${i} ${field} numeric tokens differ from the issuing response`);\n", "", { suites: ['unit'] }),
  // s8-r5-named-loaders: Killing test: quickstart helper boundary: named builtin, aliased, computed and latent loading/evaluation forms refuse separately from the observed graph
  M("s8-r5-named-loaders", "scripts/quickstart/check-helper-boundary.ts", "        if (node.kind === SyntaxKind.Identifier && ['getBuiltinModule', 'createRequire', 'require', 'eval', 'Function'].includes((node as Identifier).text)) forbidden = true;\n", "", { suites: ['unit'] }),
  // s8-r5-forbidden-builtins: Killing test: quickstart helper boundary: named builtin, aliased, computed and latent loading/evaluation forms refuse separately from the observed graph
  M("s8-r5-forbidden-builtins", "scripts/quickstart/check-helper-boundary.ts", "new Set(['node:module', 'node:vm', 'node:worker_threads'])", "new Set<string>()", { suites: ['unit'] }),
  // s8-r5-computed-loaders: Killing test: quickstart helper boundary: named builtin, aliased, computed and latent loading/evaluation forms refuse separately from the observed graph
  M("s8-r5-computed-loaders", "scripts/quickstart/check-helper-boundary.ts", "        if (name !== undefined && FORBIDDEN_NAMES.has(name)) forbidden = true;", "", { suites: ['unit'] }),
  // s9-r5-discovery-type: Killing test: package tasks: each requested parameter row is bound to Observation independently of the support response
  M("s9-r5-discovery-type", "packages/evals/src/package-tasks.ts", "    { kind: 'dataPath', id: `${name}-parameter-resource`, step, path: 'resource_type', equals: 'Observation' },\n", "", { suites: ['unit'] }),
  // s9-r5-control-comparison: Killing test: quickstart verify controls: clean launch is explicit, complete frames stay private and an observed discovery difference fails comparison
  M("s9-r5-control-comparison", "examples/quickstart/verify.ts", "valid(clean) && valid(observed) && cleanSha256 === observedSha256", "valid(clean) && valid(observed)", { suites: ['unit'] }),
  // s9-r5-control-validation: Killing test: quickstart verify: the config must name the manifest target and the seed's natural patient; one private snapshot serves the doctor and every session
  M("s9-r5-control-validation", "examples/quickstart/verify.ts", "valid(clean) && valid(observed) && cleanSha256 === observedSha256", "cleanSha256 === observedSha256", { suites: ['unit'] }),
  // s9-r5-control-propagation: Killing test: quickstart verify controls: clean launch is explicit, complete frames stay private and an observed discovery difference fails comparison
  M("s9-r5-control-propagation", "examples/quickstart/verify.ts", "...(controls.some(c => c.status !== 'pass') ? ['invariant:clean-control'] : [])", "...[]", { suites: ['unit'] }),
  // s9-r5-client-clean: Killing test: quickstart client: clean discovery launches without the observer preload and retains complete frames
  M("s9-r5-client-clean", "examples/quickstart/client.ts", "const observed = options.observe !== false;", "const observed = true;", { suites: ['unit'] }),
  // s9-r5-client-frame-lexemes: Killing test: quickstart client: both pinned eras preserve raw 7.00 and decode the same request frame without client HTTP
  M("s9-r5-client-frame-lexemes", "examples/quickstart/client.ts", "rawFrame: line,", "rawFrame: JSON.stringify(message) + '\\n',", { suites: ['unit'] }),
  // s9-r5-client-sent-frames: Killing test: quickstart client: both pinned eras preserve raw 7.00 and decode the same request frame without client HTTP
  M("s9-r5-client-sent-frames", "examples/quickstart/client.ts", "      frames.push({ direction: 'sent', text: line });\n", "", { suites: ['unit'] }),
  // s9-r5-evidence-full-frames: Killing test: quickstart verify: 18 task-arm runs, private evidence and a summary of statuses, counts and hashes only
  M("s9-r5-evidence-full-frames", "examples/quickstart/verify.ts", "    if (!call.rawFrame || !call.frames?.some(f => f.direction === 'received' && f.text === call.rawFrame)) completeFrames = false;\n", "", { suites: ['unit'] }),
  // s9-r5-config-inventory: Killing test: quickstart verify launch binding: an exclusive run lock, unique outputs, actual config hashes and a changed transitive artifact refusal
  M("s9-r5-config-inventory", "examples/quickstart/verify.ts", "configs: [...configs].map(([name, value]) => ({ name, sha256: sha256(value.bytes) }))", "configs: [...configs].filter(([name]) => name === 'verify-gateway.config.json').map(([name, value]) => ({ name, sha256: sha256(value.bytes) }))", { suites: ['unit'] }),
  // s9-r5-retained-null-absent: Killing test: package oracle: a retained read answers exactly the issuing response's rows, versions and facts
  M("s9-r5-retained-null-absent", "packages/evals/src/evidence-oracle.ts", "        if (want !== undefined && resolvePath(row, field) === undefined) return fail('expected_fact_mismatch', `retained resource ${i} ${field} is absent from the retained slice`);\n", "", { suites: ['unit'] }),
  // s8-r5-import-meta-url-only: Killing test: quickstart helper boundary: named builtin, aliased, computed and latent loading/evaluation forms refuse separately from the observed graph
  M("s8-r5-import-meta-url-only", "scripts/quickstart/check-helper-boundary.ts", "          if (parent.kind !== SyntaxKind.PropertyAccessExpression || (parent as PropertyAccessExpression).name.text !== 'url' || (parent as PropertyAccessExpression).questionDotToken) forbidden = true;\n", "", { suites: ['unit'] }),
  // s9-r5-metadata-shape: Killing test: quickstart verify controls: clean launch is explicit, complete frames stay private and an observed discovery difference fails comparison
  M("s9-r5-metadata-shape", "examples/quickstart/verify.ts", "return metadataShape(input, data, e.source.capability_revision, c);", "return true;", { suites: ['unit'] }),
  // s9-r5-metadata-row-body: Killing test: quickstart verify controls: clean launch is explicit, complete frames stay private and an observed discovery difference fails comparison
  M("s9-r5-metadata-row-body", "examples/quickstart/verify.ts", "objectShape(r, ['resource_type', 'policy_class', 'patient_link', 'source_advertised', 'advertised_interactions', 'policy_interactions', 'executable_interactions', 'instance_policy', 'compact_recipe', 'workflow_role', 'limitations'])", "isRecord(r)", { suites: ['unit'] }),
  // s9-r5-repair-shape: Killing test: quickstart verify controls: clean launch is explicit, complete frames stay private and an observed discovery difference fails comparison
  M("s9-r5-repair-shape", "examples/quickstart/verify.ts", " || !repairShape(w.repair)", "", { suites: ['unit'] }),
  // s9-r5-manifest-shape: Killing test: quickstart verify response gate: trusted identity, complete provenance, resource-free safe errors and exact visible text are independently judged
  M("s9-r5-manifest-shape", "examples/quickstart/verify.ts", "!objectShape(v, ['path', 'reason'], ['content_type', 'size', 'hash', 'count', 'spans'])", "!isRecord(v)", { suites: ['unit'] }),
  // s9-r5-artifact-read-budget: Killing test: quickstart verify artifact bounds: dependency resolution rows and all manifest/file reads share the closure budgets
  M("s9-r5-artifact-read-budget", "examples/quickstart/verify.ts", "Math.min(maximum, 64 * 1024 * 1024 - total)", "maximum", { suites: ['unit'] }),
  // s9-r5-artifact-resolution-budget: Killing test: quickstart verify artifact bounds: dependency resolution rows and all manifest/file reads share the closure budgets
  M("s9-r5-artifact-resolution-budget", "examples/quickstart/verify.ts", "    for (const name of Object.keys(value.dependencies).sort()) {\n      if (rows.length >= 8192) throw fault('VERIFY_DOCTOR');", "    for (const name of Object.keys(value.dependencies).sort()) {", { suites: ['unit'] }),
  // s9-r5-result-metadata-shape: Killing test: quickstart verify response gate: trusted identity, complete provenance, resource-free safe errors and exact visible text are independently judged
  M("s9-r5-result-metadata-shape", "examples/quickstart/verify.ts", "    if (!resultMetaShape(isRecord(result) ? result._meta : undefined)) return false;\n", "", { suites: ['unit'] }),
  // s8-r5-property-loaders: Killing test: quickstart helper boundary: named builtin, aliased, computed and latent loading/evaluation forms refuse separately from the observed graph
  M("s8-r5-property-loaders", "scripts/quickstart/check-helper-boundary.ts", "        if (node.kind === SyntaxKind.PropertyAccessExpression && FORBIDDEN_NAMES.has((node as PropertyAccessExpression).name.text)) forbidden = true;\n", "", { suites: ['unit'] }),
  // s8-r5-destructured-loaders: Killing test: quickstart helper boundary: named builtin, aliased, computed and latent loading/evaluation forms refuse separately from the observed graph
  M("s8-r5-destructured-loaders", "scripts/quickstart/check-helper-boundary.ts", "          if (key?.kind === SyntaxKind.Identifier && FORBIDDEN_NAMES.has((key as Identifier).text)) forbidden = true;\n", "", { suites: ['unit'] }),
  // s8-r5-template-loader-names: Killing test: quickstart helper boundary: named builtin, aliased, computed and latent loading/evaluation forms refuse separately from the observed graph
  M("s8-r5-template-loader-names", "scripts/quickstart/check-helper-boundary.ts", "        if (node.kind === SyntaxKind.TemplateExpression) {\n          const n = node as TemplateExpression; let text = n.head.text;\n          for (const span of n.templateSpans) { const part = constant(span.expression); if (part === undefined) return undefined; text += part + span.literal.text; }\n          return text;\n        }\n", "", { suites: ['unit'] }),
  // s8-r5-parenthesized-loader-names: Killing test: quickstart helper boundary: named builtin, aliased, computed and latent loading/evaluation forms refuse separately from the observed graph
  M("s8-r5-parenthesized-loader-names", "scripts/quickstart/check-helper-boundary.ts", "        if (node.kind === SyntaxKind.ParenthesizedExpression) return constant((node as ParenthesizedExpression).expression);\n", "", { suites: ['unit'] }),
  // s8-r5-parse-fail-closed: Killing test: quickstart helper boundary: parser context permits ordinary bindings, regexes and templates and catches an appended builtin witness
  M("s8-r5-parse-fail-closed", "scripts/quickstart/check-helper-boundary.ts", "if (!source || program!.getSyntacticDiagnostics(file).length) return true;", "if (!source || program!.getSyntacticDiagnostics(file).length) return false;", { suites: ['unit'] }),
  // s9-r5-artifact-file-count: Killing test: quickstart verify artifact bounds: dependency resolution rows and all manifest/file reads share the closure budgets
  M("s9-r5-artifact-file-count", "examples/quickstart/verify.ts", "return { sha256: sha256(jsonBytes(rows)), files: fileCount };", "return { sha256: sha256(jsonBytes(rows)), files: rows.length };", { suites: ['unit'] }),
  // Packaging slice 10 (GPT-6.1-Sol): staging, production shrinkwrap, notices; unit suite only.
  // s9-stage-source: Killing test: package stage: source eval maps declarations and research are forbidden before copying
  M("s9-stage-source", "scripts/stage-package.ts", "if (!allowedProductionFile(path)) throw fault('STAGE_FORBIDDEN');", "if (false) throw fault('STAGE_FORBIDDEN');", { suites: ['unit'] }),
  // s9-lock-production: Killing test: package stage: gateway shrinkwrap rejects client tsx and every development edge
  M("s9-lock-production", "scripts/stage-package.ts", "if (!productionOnlyLock(lock)) throw fault('LOCK_NOT_PRODUCTION');", "if (false) throw fault('LOCK_NOT_PRODUCTION');", { suites: ['unit'] }),
  // s9-notice-required: Killing test: package licenses: required upstream NOTICE cannot be omitted and optional project NOTICE is not invented
  M("s9-notice-required", "scripts/release-licenses.mjs", "if (requiredNoticeMissing(inventory)) throw fault('NOTICE_MISSING');", "if (false) throw fault('NOTICE_MISSING');", { suites: ['unit'] }),
  // Packaging slice 11 (GPT-6.1-Sol): fresh-install orchestration; unit suite only.
  // s9-guard-not-onboarding: Killing test: package quickstart: passing negative guards cannot certify a failed status-sensitive onboarding task
  M("s9-guard-not-onboarding", "scripts/package-quickstart.ts", "if (!allThreeTasksPassed(report)) throw fault('ONBOARDING_FAILED');", "if (false) throw fault('ONBOARDING_FAILED');", { suites: ['unit'] }),
  // s9-drain-loss: Killing test: package quickstart: drain membership guard rejects dropped, duplicated and substituted page members
  M("s9-drain-loss", "packages/evals/src/evidence-oracle.ts", "case 'resourceIdSet':\n      return new Set(evidence.resourceOrder).size === evidence.resourceOrder.length", "case 'resourceIdSet':\n      return check.id === 'labs-exact-membership' ? pass() : new Set(evidence.resourceOrder).size === evidence.resourceOrder.length", { suites: ['unit'] }),
  // Packaging slice 12 (GPT-6.1-Sol): release manifest and SBOM; unit suite only.
  // s9-release-binding: Killing test: release manifest: stale tar shrinkwrap helper compose config source and runtime evidence refuses
  M("s9-release-binding", "scripts/release-manifest.mjs", "if (!sameArtifactBinding(inputs, reports)) throw fault('EVIDENCE_STALE');", "if (false) throw fault('EVIDENCE_STALE');", { suites: ['unit'] }),
  // s9-release-evidence-bytes: Killing test: release manifest: changed evidence is refused and a failed bound report stays failed
  M("s9-release-evidence-bytes", "scripts/release-manifest.mjs", "if (sha256(body) !== row.sha256) throw fault('EVIDENCE_CHANGED');", "if (false) throw fault('EVIDENCE_CHANGED');", { suites: ['unit'] }),
  // s9-release-sbom-installed: Killing test: release manifest: lock-only SBOM wrong generator and extra missing invalid production components refuse
  M("s9-release-sbom-installed", "scripts/release-manifest.mjs", "raw.metadata.lifecycles[0].phase !== 'build'", "false", { suites: ['unit'] }),
  // s9-release-sbom-integrity: Killing test: release manifest: lock-only SBOM wrong generator and extra missing invalid production components refuse
  M("s9-release-sbom-integrity", "scripts/release-manifest.mjs", "if (node.integrity && !component.hashes?.some(h => h.alg === 'SHA-512' && h.content === Buffer.from(node.integrity.slice(7), 'base64').toString('hex'))) throw fault('SBOM_INTEGRITY');", "if (false) throw fault('SBOM_INTEGRITY');", { suites: ['unit'] }),
  // s9-release-sbom-edges: Killing test: release manifest: lock-only SBOM wrong generator and extra missing invalid production components refuse
  M("s9-release-sbom-edges", "scripts/release-manifest.mjs", "if (!isDeepStrictEqual([...(edges.get(key) ?? [])].sort(order), node.dependencies.map(n => `${n.name}@${n.version}`).sort(order))) throw fault('SBOM_TREE');", "if (false) throw fault('SBOM_TREE');", { suites: ['unit'] }),
  // s9-release-config-loopback: Killing test: release manifest: S10 config derives only the loopback port from the same approved tuple
  M("s9-release-config-loopback", "scripts/release-manifest.mjs", "if (!record(host) || host.mode !== 'synthetic' || host.source?.baseUrl !== 'http://127.0.0.1:18080/fhir') throw fault('S10_CONFIG');", "if (false) throw fault('S10_CONFIG');", { suites: ['unit'] }),
  // s9-release-license-inventory: Killing test: release manifest: installed license inventory refuses newly added or removed upstream NOTICE texts
  M("s9-release-license-inventory", "scripts/release-manifest.mjs", "if (!isDeepStrictEqual(observed.sort((a, b) => order(a.source, b.source)), wanted.sort((a, b) => order(a.source, b.source)))) throw fault('LICENSE_TEXTS_CHANGED');", "if (false) throw fault('LICENSE_TEXTS_CHANGED');", { suites: ['unit'] }),
  // s9-release-installed-tar: Killing test: release manifest: observed installed gateway SRI must identify the exact accepted tar bytes
  M("s9-release-installed-tar", "scripts/release-manifest.mjs", "if (!row || row.version !== version || row.integrity !== integrity || row.link || row.dev) throw fault('INSTALLED_TAR_MISMATCH');", "if (false) throw fault('INSTALLED_TAR_MISMATCH');", { suites: ['unit'] }),
  // S10 OCI subset (GPT-6.1-Sol): recipe, inventory and gate runner; unit suite only.
  // s10-oci-base-pin: Killing test: tests/oci-recipe.test.ts
  M("s10-oci-base-pin", "packaging/oci/Dockerfile", "FROM node@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4", "FROM node:24.22.0-bookworm-slim", { suites: ['unit'] }),
  // s10-oci-numeric-user: Killing test: tests/oci-recipe.test.ts
  M("s10-oci-numeric-user", "packaging/oci/Dockerfile", "USER 1000:1000", "USER 0:0", { suites: ['unit'] }),
  // s10-oci-no-port: Killing test: tests/oci-recipe.test.ts
  M("s10-oci-no-port", "packaging/oci/Dockerfile", "USER 1000:1000", "EXPOSE 8080\nUSER 1000:1000", { suites: ['unit'] }),
  // s10-oci-helper-namespace: Killing test: tests/oci-recipe.test.ts
  M("s10-oci-helper-namespace", "packaging/oci/compose.yaml", "network_mode: service:hapi", "network_mode: bridge", { suites: ['unit'] }),
  // s10-oci-build-network: Killing test: tests/oci-recipe.test.ts
  M("s10-oci-build-network", "packaging/oci/commands.mjs", "['build', '--network', 'none', '--pull=false'", "['build', '--network', 'default', '--pull=false'", { suites: ['unit'] }),
  // s10-oci-build-no-pull: Killing test: tests/oci-recipe.test.ts
  M("s10-oci-build-no-pull", "packaging/oci/commands.mjs", "'--pull=false'", "'--pull=true'", { suites: ['unit'] }),
  // s10-oci-runtime-readonly: Killing test: tests/oci-recipe.test.ts
  M("s10-oci-runtime-readonly", "packaging/oci/commands.mjs", "'--user', '1000:1000', '--read-only'", "'--user', '1000:1000', '--read-only=false'", { suites: ['unit'] }),
  // s10-oci-layer-digest: Killing test: tests/oci-inventory.test.ts
  M("s10-oci-layer-digest", "packaging/oci/inventory.mjs", "if (body.length !== descriptor.size || `sha256:${sha256(body)}` !== descriptor.digest) fail('OCI_BLOB_DIGEST');", "if (false) fail('OCI_BLOB_DIGEST');", { suites: ['unit'] }),
  // s10-oci-layer-diff-id: Killing test: tests/oci-inventory.test.ts
  M("s10-oci-layer-diff-id", "packaging/oci/inventory.mjs", "if (diffId !== config.rootfs.diff_ids[i]) fail('OCI_DIFF_ID');", "if (false) fail('OCI_DIFF_ID');", { suites: ['unit'] }),
  // s10-oci-installed-bytes: Killing test: tests/oci-inventory.test.ts
  M("s10-oci-installed-bytes", "packaging/oci/inventory.mjs", "if (!equal(actual, pkg.files)) fail('OCI_INSTALLED_BYTES');", "if (false) fail('OCI_INSTALLED_BYTES');", { suites: ['unit'] }),
  // s10-oci-installed-packages: Killing test: tests/oci-inventory.test.ts
  M("s10-oci-installed-packages", "packaging/oci/inventory.mjs", "if (!equal(names.sort(), expectedNames)) fail('OCI_INSTALLED_TREE');", "if (false) fail('OCI_INSTALLED_TREE');", { suites: ['unit'] }),
  // s10-oci-cleanup-owned: Killing test: tests/oci-runner.test.ts
  M("s10-oci-cleanup-owned", "packaging/oci/run-gates.mjs", "inspection.Config?.Labels?.['io.fireboat.s10.run'] !== owner", "false", { suites: ['unit'] }),
  // s10-oci-live-readonly: Killing test: tests/oci-runner.test.ts
  M("s10-oci-live-readonly", "packaging/oci/run-gates.mjs", "host.ReadonlyRootfs !== true", "false", { suites: ['unit'] }),
  // s10-oci-platform-pin: Killing test: tests/oci-inventory.test.ts
  M("s10-oci-platform-pin", "packaging/oci/inventory.mjs", "options.childDigest && child !== options.childDigest", "false", { suites: ['unit'] }),
  // S11 measurement tooling (GPT-6.1-Sol): corpus, freezes, measurement and report; unit suite only.
  // s11-raw-repeatability: Killing test: tests/s11-corpus.test.ts
  M("s11-raw-repeatability", "scripts/s11/generate.ts", "requireS11(sameExports(snapshots[0], snapshots[1]), 'EXPORTS_DIFFER');", "requireS11(true, 'EXPORTS_DIFFER');", { suites: ['unit'] }),
  // s11-seed-prefix: Killing test: tests/s11-corpus.test.ts
  M("s11-seed-prefix", "scripts/s11/study.ts", "r.seed === order[i]", "true", { suites: ['unit'] }),
  // s11-large-observation-minimum: Killing test: tests/s11-corpus.test.ts
  M("s11-large-observation-minimum", "scripts/s11/study.ts", "row.eligibleObservations < STUDY.large.observations", "row.eligibleObservations < STUDY.large.observations - 1", { suites: ['unit'] }),
  // s11-large-byte-minimum: Killing test: tests/s11-corpus.test.ts
  M("s11-large-byte-minimum", "scripts/s11/study.ts", "row.sanitizedObservationBytes < STUDY.large.sanitizedObservationBytes", "row.sanitizedObservationBytes < STUDY.large.sanitizedObservationBytes - 1", { suites: ['unit'] }),
  // s11-patient-split: Killing test: tests/s11-corpus.test.ts
  M("s11-patient-split", "scripts/s11/study.ts", "new Set(rows.map(r => r.patient)).size === STUDY.population", "true", { suites: ['unit'] }),
  // s11-natural-chart-closure: Killing test: tests/s11-corpus.test.ts
  M("s11-natural-chart-closure", "scripts/s11/corpus.ts", "chartResources: closure.size", "chartResources: entries.size", { suites: ['unit'] }),
  // s11-point-target: Killing test: tests/s11-report.test.ts
  M("s11-point-target", "scripts/s11/study.ts", "median <= STUDY.thresholds.compactMedian", "median <= 1", { suites: ['unit'] }),
  // s11-smaller-exclusive: Killing test: tests/s11-report.test.ts
  M("s11-smaller-exclusive", "scripts/s11/study.ts", "interval[1]! < 1", "interval[1]! <= 1", { suites: ['unit'] }),
  // s11-failed-pair: Killing test: tests/s11-report.test.ts
  M("s11-failed-pair", "scripts/s11/study.ts", "p.success && Number.isSafeInteger(p.fhir)", "Number.isSafeInteger(p.fhir)", { suites: ['unit'] }),
  // s11-patient-bootstrap: Killing test: tests/s11-report.test.ts
  M("s11-patient-bootstrap", "scripts/s11/study.ts", "sample.push(...clusters[Math.floor(patients.length * random() / 2 ** 32)]!.map(ratio));", "sample.push(...Array.from({ length: 3 }, () => ratio(pairs[Math.floor(pairs.length * random() / 2 ** 32)]!)));", { suites: ['unit'] }),
  // s11-withheld-overhead: Killing test: tests/s11-measurement.test.ts
  M("s11-withheld-overhead", "scripts/s11/study.ts", "const withheld = size(transform === undefined ? undefined : rawJsonMember(transform, 'withheld_payloads'));", "const withheld = 0;", { suites: ['unit'] }),
  // s11-host-fidelity: S11 never judges the captured host text (compound after the E1/E4 rewrite). Killing test: S11 fidelity binds every clinical value and raw numeric token to its own cited wire AND captured text occurrence
  C("s11-host-fidelity", [{"file":"scripts/s11/measure.ts","find":"for (const boundary of [views.wire, views.model]) {","replace":"for (const boundary of [views.wire]) {"},{"file":"scripts/s11/measure.ts","find":"    try { if (fullTextInput(call.rawResult!).messages[0] !== structured) failed++; } catch { failed++; }\n","replace":""},{"file":"scripts/s11/measure.ts","find":"  for (const boundary of ['wire', 'model'] as const) {","replace":"  for (const boundary of ['wire'] as const) {"}], { suites: ['unit'] }),
  // s11-raw-decimal-fidelity: Killing test: tests/s11-measurement.test.ts
  M("s11-raw-decimal-fidelity", "scripts/s11/measure.ts", "numericTokens(raw)", "numericTokens('{}')", { suites: ['unit'] }),
  // s11-retained-binding: Killing test: tests/s11-measurement.test.ts
  M("s11-retained-binding", "scripts/s11/measure.ts", "for (const check of plan.retainedChecks ?? []) {", "for (const check of [] as Check[]) {", { suites: ['unit'] }),
  // s11-c3-inclusive: Killing test: tests/s11-report.test.ts
  M("s11-c3-inclusive", "scripts/s11/report.ts", "quantile(shares, 0.5) <= STUDY.thresholds.overheadMedian", "quantile(shares, 0.5) < STUDY.thresholds.overheadMedian", { suites: ['unit'] }),
  // s11-default-mutation-gate: Killing test: tests/s11-report.test.ts
  M("s11-default-mutation-gate", "scripts/s11/study.ts", "status === 'smaller' && targetMet && mutations", "status === 'smaller' && targetMet", { suites: ['unit'] }),
  // s11-correct-answer-denominator: Killing test: tests/s11-report.test.ts
  M("s11-correct-answer-denominator", "scripts/s11/report.ts", "successes = cell.filter(a => a.status === 'pass')", "successes = cell", { suites: ['unit'] }),
  // s11-message-token-boundaries: Killing test: tests/s11-run.test.ts
  M("s11-message-token-boundaries", "scripts/s11/tokenize.py", "sum(len(encoder.encode_ordinary(text)) for k, text in texts if k == kind)", "len(encoder.encode_ordinary(\"\".join(text for k, text in texts if k == kind)))", { suites: ['unit'] }),
  // e3-observer-trusts-fixture-patient. Killing test: E3+E4 development-only integration: the actual runner confines a non-fixture natural patient and every arm/era/template passes on wire and text
  M("e3-observer-trusts-fixture-patient", "packages/evals/src/runner.ts", "const observer = new SourceResponseObserver(fixture.baseUrl, `${task.id}/${arm}`, Boolean(options.packagedBin), trustedPatientId);", "const observer = new SourceResponseObserver(fixture.baseUrl, `${task.id}/${arm}`, Boolean(options.packagedBin));", { suites: ['unit'] }),
  // e4-s11-fact-chain-dropped. Killing test: E4 S11 facts on shorthand continuation pages resolve within their own chain; a foreign query identity or a text-only change still fails
  M("e4-s11-fact-chain-dropped", "scripts/s11/measure.ts", "evaluateStepCheck(check, arm, boundary, context)", "evaluateStepCheck({ ...check, response_index: 0 }, arm, boundary.filter(c => c.step === step).slice(responseIndex, responseIndex + 1), context)", { suites: ['unit'] }),
  // e1-full-text-boundary-unchecked. Killing test: E1 full-text-v1: the delivered text must be the raw structuredContent, so text-only alterations fail even at equal bytes
  M("e1-full-text-boundary-unchecked", "packages/evals/src/runner.ts", "if (envelope && (options.deliveryProfile ?? 'full-text-v1') === 'full-text-v1' && !fullTextMatchesStructured(outcome.result.content, outcome.resultText)) {", "if (false) {", { suites: ['unit'] }),
  // e5-declared-survivors-required. Killing test: E5 the frozen fidelity set treats declared survivors as the aggregate does: a valid aggregate is accepted, a missing required kill is not
  M("e5-declared-survivors-required", "scripts/s11/mutation-evidence.ts", "required_ids: applicable.filter(id => !survivors.has(id)),", "required_ids: applicable,", { suites: ['unit'] }),
  // e6-s11-accounting-gate-skipped. Killing test: E6 S11 applies the eval CLI byte-accounting gate per attempt: only the gateway-reported bytes differ, and the attempt fails
  M("e6-s11-accounting-gate-skipped", "scripts/s11/measure.ts", "if (result && byteAccountingFails(byteAccounting(result.calls ?? []))) {", "if (false) {", { suites: ['unit'] }),
  // e2-heldout-reuse-across-runs. Killing test: E2 the heldout ledger lives beside the run directories and makes the cohort single-use across run names
  M("e2-heldout-reuse-across-runs", "scripts/s11/heldout-ledger.ts", "    if ([...cohortSeeds(consumed.cohort)].some(seed => mine.has(seed))) throw new Error('HELDOUT_ALREADY_CONSUMED');\n", "", { suites: ['unit'] }),
  // e7-cli-prints-failure-detail. Killing test: E7 the eval CLI prints only fixed failure lines; the details stay in its owner-only report file
  M("e7-cli-prints-failure-detail", "packages/evals/src/cli.ts", "process.stdout.write(`${ordinaryFailureLine(result, failure)}\\n`);", "process.stdout.write(`${ordinaryFailureLine(result, failure)}: ${failure.detail}\\n`);", { suites: ['unit'] }),
  // s8-prepare-port-probe. Killing test: quickstart prepare: distinct Docker-owned and local HTTP instances refuse with zero requests to the unrelated listener
  M("s8-prepare-port-probe", "examples/quickstart/prepare.ts", "if (await (options.probe ?? (() => seedPortOccupied()))()) throw fault('PORT_IN_USE');", "if (false) throw fault('PORT_IN_USE');", { suites: ['unit'] }),
  // s8-docker-endpoint-local. Killing test: quickstart Docker: remote DOCKER_HOST and remote saved or selected contexts refuse before any compose command
  M("s8-docker-endpoint-local", "examples/quickstart/docker.ts", "if (!isLocalDockerEndpoint(record(record(context.Endpoints).docker).Host)) throw fault('DOCKER_ENDPOINT_REFUSED');", "if (false) throw fault('DOCKER_ENDPOINT_REFUSED');", { suites: ['unit'] }),
  // s8-docker-post-dispatch-record. Killing test: quickstart Docker: compose deadline and output-limit failures after dispatch also record the exact created container
  M("s8-docker-post-dispatch-record", "examples/quickstart/docker.ts", "export const POST_DISPATCH_FAULTS: readonly string[] = Object.freeze(['DOCKER_FAILED', 'DOCKER_TIMEOUT', 'DOCKER_LIMIT']);", "export const POST_DISPATCH_FAULTS: readonly string[] = Object.freeze(['DOCKER_FAILED']);", { suites: ['unit'] }),
  // s8-docker-network-owner. Killing test: quickstart Docker: network cleanup removes only this run project network by exact inspected ID with no endpoints
  M("s8-docker-network-owner", "examples/quickstart/docker.ts", "labels['com.docker.compose.project'] !== intent.project ||", "false ||", { suites: ['unit'] }),
  // s9-installed-gateway-tar. Killing test: package quickstart: a tar replaced after verification cannot be attributed; the installed gateway must equal the verified inventory and bytes
  M("s9-installed-gateway-tar", "scripts/verify-package.ts", "if (!row || row.version !== expected.identity.version || row.integrity !== integrity || row.link || row.dev) throw fault('INSTALLED_TAR_MISMATCH');", "if (false) throw fault('INSTALLED_TAR_MISMATCH');", { suites: ['unit'] }),
  // s10-oci-cancel-timeout. Killing test: OCI gates: cancellation must beat a far longer ordinary upstream timeout and follow an uncancelled control that stayed open
  M("s10-oci-cancel-timeout", "packaging/oci/run-gates.mjs", "export const CANCELLATION = Object.freeze({ upstreamTimeoutMs: 30_000,", "export const CANCELLATION = Object.freeze({ upstreamTimeoutMs: 10_000,", { suites: ['unit'] }),
  // s10-oci-shutdown-status. Killing test: OCI gates: shutdown acceptance needs exit code 0 without a signal after EOF; crash, signal and hang fail while cleanup still runs
  M("s10-oci-shutdown-status", "packaging/oci/session.mjs", "statuses.some(s => s?.timedOut !== false || s.code !== 0 || s.signal !== null)", "statuses.some(s => s?.timedOut !== false)", { suites: ['unit'] }),
  // s12-release-installed-needs. Killing test: release manifest: installed-artifact job is an inert linux/arm64 design that gates the publisher and CI claims no installed cell
  M("s12-release-installed-needs", ".github/workflows/release-npm.yml", "    needs: installed-artifact-design", "", { suites: ['unit'] }),
  // a scalar in a schema-declared Reference, Resource or reference-carrying position is refused and withheld, never a leaf. Killing test: R1: a scalar in a schema-declared Reference, Resource or reference-carrying position is refused and withheld, never a leaf
  M("r1-scalar-reference-leaf", "packages/core/src/privacy.ts", "    if (malformedLinkage(element, value)) return false;\n", "", { suites: ['unit'] }),
  // payload keys are withheld by key and schema context in every JSON shape, with the string-case manifest and origin. Killing test: R2: payload keys are withheld by key and schema context in every JSON shape, with the string-case manifest and origin
  M("r2-payload-shape-dependent", "packages/core/src/privacy.ts", "if (payloadPosition(key, element, value)) return withhold(", "if (typeof value === 'string' && payloadPosition(key, element, value)) return withhold(", { suites: ['unit'] }),
  // the protected attachment link and the attachment context it depends on are shape-independent. Killing test: R2: the protected attachment link and the attachment context it depends on are shape-independent
  M("r2-attachment-link-shape-dependent", "packages/core/src/privacy.ts", "    if (key === 'url' && attachment) return withhold(path, 'PROTECTED_LINK', inModifier, metadata(), linkOrigin);\n", "    if (typeof value === 'string' && key === 'url' && attachment) return withhold(path, 'PROTECTED_LINK', inModifier, metadata(), linkOrigin);\n", { suites: ['unit'] }),
  // same-class-unreadable-reference-member. Killing test: same-class 1: an unreadable (non-string) Reference.reference or Reference.type is refused and withheld, even where Patient is not a legal target
  M("same-class-unreadable-reference-member", "packages/core/src/privacy.ts", "    if ((isReference || referenceLike) && unreadableLinkage(node, context, isReference)) return false;\n", "", { suites: ['unit'] }),
  // same-class-linkage-carrying-members-off. Killing test: same-class 2: a scalar Identifier inside a Reference, or any scalar where a linkage-carrying structure is declared, is refused
  M("same-class-linkage-carrying-members-off", "packages/core/src/privacy.ts", "known = names.includes('reference') || names.some(name => resolveElement(context, name).types.some(type => type === 'Reference' || type === 'Resource' || isFhirResourceType(type)));", "known = names.includes('reference');", { suites: ['unit'] }),
  // same-class-complex-companion-as-element. Killing test: same-class 3: `_x` beside a complex element is judged by that element, not as an Element companion
  M("same-class-complex-companion-as-element", "packages/core/src/schema.ts", "    if (base.types.length && !base.types.some(type => /^[a-z]/.test(type))) return base;\n", "", { suites: ['unit'] }),
  // same-class-canonical-judged-as-linkage. Killing test: same-class 4 (pinned decision): canonical and uri strings that spell Patient/x are not linkage and pass unchanged
  M("same-class-canonical-judged-as-linkage", "packages/core/src/privacy.ts", "    // refusal happens only after authorization (J-6/J-15).\n    if (!value || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value)) return true;\n", "    // refusal happens only after authorization (J-6/J-15).\n    if (typeof value === 'string' && element && isUriElement(element) && parseReference(value, base).patientLike) return false;\n    if (!value || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value)) return true;\n", { suites: ['unit'] }),
  // same-class-complex-scalar-passthrough. Killing test: same-class 5: any other scalar where a complex type is declared is withheld (as a payload for an Attachment), not passed through
  M("same-class-complex-scalar-passthrough", "packages/core/src/privacy.ts", "    if (malformedComplex(element, value)) return element.types.includes('Attachment') ? withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, {}, 'payload') : withhold(path, 'MALFORMED_STRUCTURE_WITHHELD', inModifier);\n", "", { suites: ['unit'] }),
  // same-class-base64-by-key-only. Killing test: same-class 6: base64Binary content is withheld by type and *Base64Binary name, not only under data/valueBase64Binary
  M("same-class-base64-by-key-only", "packages/core/src/privacy.ts", "  if ((element.types.includes('base64Binary') && element.name !== 'hash') || (!element.types.length && /Base64Binary$/.test(key))) return true;\n", "", { suites: ['unit'] }),
  // r3-origin-label-before-authorization. Killing test: R3: a denied foreign entry yields the same public search, page and retained response whatever its fullUrl
  M("r3-origin-label-before-authorization", "packages/core/src/index.ts", "      if (entry.search?.mode === 'include' || entry.resource.resourceType !== type || !authorized(entry.resource, this.config.patientId, this.transport.base)) { suppressed = true; continue; }\n      if (Object.hasOwn(entry, 'fullUrl') && !this.entryOriginMatches(entry.fullUrl, entry.resource)) { suppressed = true; partialReasons.add('ENTRY_ORIGIN_MISMATCH'); continue; }\n", "      if (Object.hasOwn(entry, 'fullUrl') && !this.entryOriginMatches(entry.fullUrl, entry.resource)) { suppressed = true; partialReasons.add('ENTRY_ORIGIN_MISMATCH'); continue; }\n      if (entry.search?.mode === 'include' || entry.resource.resourceType !== type || !authorized(entry.resource, this.config.patientId, this.transport.base)) { suppressed = true; continue; }\n", { suites: ['unit'] }),
  // r4-malformed-entries-empty-page. Killing test: R4: malformed Bundle entry structures refuse with INVALID_RESPONSE instead of an empty complete result
  M("r4-malformed-entries-empty-page", "packages/core/src/index.ts", "    if ((bundle.entry !== undefined && !Array.isArray(bundle.entry)) || (bundle.link !== undefined && !(Array.isArray(bundle.link) && bundle.link.every(jsonObject)))) throw new GatewayFault('INVALID_RESPONSE', 'Search returned malformed Bundle entries or links.');\n", "", { suites: ['unit'] }),
  // r5-declaration-prefix-trusted. Killing test: R5: more than 1024 searchParam declarations make the type ambiguous instead of trusting the prefix
  M("r5-declaration-prefix-trusted", "packages/core/src/index.ts", "          if (Array.isArray(entry.searchParam) && entry.searchParam.length > MAX_SEARCH_PARAM_DECLARATIONS) {", "          if (false) {", { suites: ['unit'] }),
  // r6-renewal-shares-generation. Killing test: R6: a token renewed after expiry has its own generation, so the old generation cannot invalidate it
  M("r6-renewal-shares-generation", "packages/auth/src/client-credentials.ts", "      if (cached) this.generation++;\n", "", { suites: ['unit'] }),
  // B2 machinery: genuine admission/credit weaknesses; full witnesses in counting.test.ts.
  // Weakens the B2 classification requirement.
  C("b2m-count-condition-dropped", [{"file": "tests/isolation/case-schema.ts", "find": "if (c.classification !== 'B2' || c.boundary !== 'decidable'", "replace": "if (c.boundary !== 'decidable'"}], { suites: ["unit", "isolation"] }),
  // Accepts boilerplate fault intents.
  C("b2m-template-fault-accepted", [{"file": "tests/isolation/case-schema.ts", "find": "templated(s.discriminating_fault_intent, [contract.decision, contract.goal, c.independence]) || ", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Accepts ambiguous multiple source anchors.
  C("b2m-anchor-multi-match", [{"file": "tests/isolation/case-schema.ts", "find": "occurrences(source, s.source_anchor.find) !== 1", "replace": "occurrences(source, s.source_anchor.find) < 1"}], { suites: ["unit", "isolation"] }),
  // Accepts budgets without measured provenance.
  C("b2m-budget-provenance-skipped", [{"file": "tests/isolation/case-schema.ts", "find": "if (c.budgets.budget_source === null) throw new ManifestError('template-budget', c.id, 'no measured provenance');\n    const derived = deriveBudgets(c.budgets.budget_source.measured);", "replace": "const derived = c.budgets.budget_source === null ? c.budgets : deriveBudgets(c.budgets.budget_source.measured);"}], { suites: ["unit", "isolation"] }),
  // Accepts critical mutant sets not equal to the killing rows.
  C("b2m-kill-ref-unchecked", [{"file": "tests/isolation/case-schema.ts", "find": "!c.critical_mutants.length || c.critical_mutants.slice().sort().join() !== killingRows.map(r => r.mutant_id).sort().join()", "replace": "!c.critical_mutants.length"}], { suites: ["unit", "isolation"] }),
  // Admits an explicitly excluded kill row.
  C("b2m-excluded-survivor-admitted", [{"file": "tests/isolation/case-schema.ts", "find": "!mutant || !mutant.suites.includes('isolation') || ctx.killMatrix.excluded.includes(row.mutant_id)", "replace": "!mutant || !mutant.suites.includes('isolation')"}], { suites: ["unit", "isolation"] }),
  // Admits a ledger whose declared counts disagree with its records.
  C("b2m-ledger-declared-counts-unchecked", [{"file": "tests/isolation/case-schema.ts", "find": "  for (const key of Object.keys(counts) as (keyof typeof counts)[]) if (ledger.counts[key] !== counts[key]) throw new ManifestError('ledger-count', undefined, `counts.${key} ${ledger.counts[key]} differs from the records' ${counts[key]}`);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits alias chains; the separate cycle check is defence in depth.
  C("b2m-alias-chain-unchecked", [{"file": "tests/isolation/case-schema.ts", "find": "    if (hops !== 1) throw new ManifestError('alias-target', entry.id, 'alias chain');\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Accepts a pre-stub upstream budget breach.
  C("b2m-total-upstream-unenforced", [{"file": "tests/isolation/runner.ts", "find": "  check(counts.total_upstream_calls <= c.budgets.max_total_upstream_calls, 'request', 'b2.budget.max_total_upstream_calls', c.budgets.max_total_upstream_calls, counts.total_upstream_calls);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Accepts breached budgets by checking an empty accounting snapshot.
  C("b2m-budget-post-stub", [{"file": "tests/isolation/runner.ts", "find": "    enforceBudgets(c, result.pre_stub);\n    result.tool_calls", "replace": "    enforceBudgets(c, zeroCounts());\n    result.tool_calls"}], { suites: ["unit", "isolation"] }),
  // Accepts an expired execution as passing.
  C("b2m-watchdog-expiry-passes", [{"file": "tests/isolation/runner.ts", "find": "result.verdict = disclosed ? 'FAIL' : 'INCONCLUSIVE';", "replace": "result.verdict = disclosed ? 'FAIL' : 'PASS';"}], { suites: ["unit", "isolation"] }),
  // Credits an expired capture without checking forbidden markers.
  C("b2m-watchdog-scan-skipped", [{"file": "tests/isolation/runner.ts", "find": "  const primary = drivers[0];", "replace": "  if (result.phase !== 'done' && result.failures.some(f => f.predicate === 'b2.watchdog.deadline')) return false;\n  const primary = drivers[0];"}, {"file": "tests/isolation/runner.ts", "find": "const disclosed = scanRemaining(c, backend, drivers, result);", "replace": "const disclosed = false;"}, {"file": "tests/isolation/runner.ts", "find": "    scanRemaining(c, backend, drivers, result);\n    for (const d", "replace": "    if (!expired) scanRemaining(c, backend, drivers, result);\n    for (const d"}], { suites: ["unit", "isolation"] }),
  // Credits a development run as earned.
  C("b2m-earned-ignores-qualifying", [{"file": "tests/isolation/report.ts", "find": "  if (!run.qualifying) return result('counted_unqualified_run');\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits an inconclusive case as earned.
  C("b2m-earned-counts-inconclusive", [{"file": "tests/isolation/report.ts", "find": "if (verdict === 'INCONCLUSIVE') return result('counted_inconclusive');", "replace": "if (verdict === 'INCONCLUSIVE') return result('earned', true);"}], { suites: ["unit", "isolation"] }),
  // Accepts an otherwise passing gate with an uncovered applicable cell.
  C("b2m-gate-matrix-conjunct-dropped", [{"file": "tests/isolation/report.ts", "find": "matrix_cells_covered: uncovered.length === 0 && applicableCells.length > 0,", "replace": "matrix_cells_covered: applicableCells.length > 0,"}], { suites: ["unit", "isolation"] }),
  // Admits a non-executable alias as matrix coverage.
  C("b2m-matrix-alias-cover", [{"file": "tests/isolation/case-schema.ts", "find": "if (!executable.has(id)) throw new ManifestError('matrix-cover'", "replace": "if (!executable.has(id) && !id.startsWith('B2-')) throw new ManifestError('matrix-cover'"}], { suites: ["unit", "isolation"] }),
  // Admits an unselected empty shard (missing-shard checks remain independently enforced).
  C("b2m-aggregate-missing-shard", [{"file": "tests/isolation/aggregate.ts", "find": "if (present.join() !== families.join())", "replace": "if (present.filter(f => families.includes(f)).join() !== families.join())"}], { suites: ["unit", "isolation"] }),
  // Credits only marker failures as prohibited and ignores non-counted failures in the gate.
  C("b2m-prohibited-classes-narrowed", [{"file": "tests/isolation/report.ts", "find": "const prohibited = new Set<string>([...Object.values(PROHIBITED_PREDICATES).flat(), ...Object.values(SCENARIO_CONTRACTS).map(c => c.predicate_id)]);", "replace": "const prohibited = new Set<string>(PROHIBITED_PREDICATES.disclosure);"}, {"file": "tests/isolation/report.ts", "find": "every_manifest_case_pass: manifest.cases.every(c => byId.get(c.id)?.verdict === 'PASS'),", "replace": "every_manifest_case_pass: manifest.cases.filter(c => c.counted).every(c => byId.get(c.id)?.verdict === 'PASS'),"}], { suites: ["unit", "isolation"] }),
  // Admits an extra failed counted case after 200 greens, bypassing redundant completeness conjuncts.
  C("b2m-blocking-conjunct-dropped", [{"file": "tests/isolation/report.ts", "find": "no_blocking_counted_cases: blockingCases.length === 0,", "replace": "no_blocking_counted_cases: true,"}, {"file": "tests/isolation/report.ts", "find": ".every(s => s.counts_toward_b2)", "replace": ".every(s => s.counts_toward_b2 || s.blocking)"}, {"file": "tests/isolation/report.ts", "find": "every_manifest_case_pass: manifest.cases.every(c => byId.get(c.id)?.verdict === 'PASS'),", "replace": "every_manifest_case_pass: manifest.cases.every(c => c.counted || byId.get(c.id)?.verdict === 'PASS'),"}], { suites: ["unit", "isolation"] }),
  // Admits a shard from a different candidate/build/attempt.
  C("b2m-shard-binding-unchecked", [{"file": "tests/isolation/aggregate.ts", "find": "    if (!sameBinding(shard.binding?.start, binding) || !sameBinding(end, binding)) throw new AggregateError('shard-binding', file);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits prerequisites from a different candidate/build/attempt.
  C("b2m-prerequisites-binding-unchecked", [{"file": "tests/isolation/aggregate.ts", "find": "  if (!sameBinding(prerequisites.binding?.start, binding) || !sameBinding(prerequisites.binding?.end, binding)) throw new AggregateError('prerequisites-binding');\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits contradictory core-only kill headers.
  C("b2m-kills-lanes-unchecked", [{"file": "tests/isolation/report.ts", "find": "  if (parsed.core_only !== false || parsed.cells_per_case !== 6) problems.push('kills-lanes: kills.json is not a full six-cell run');\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits a kill file relabelled with a foreign run id.
  C("b2m-kills-run-unbound", [{"file": "tests/isolation/report.ts", "find": "  if (parsed.run_id !== runId) problems.push(`kills-run: kills.json belongs to run ${String(parsed.run_id)}`);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Qualifies a skip-build run.
  C("b2m-skip-build-qualifies", [{"file": "tests/isolation/report.ts", "find": "  if (context.env.B2_SKIP_BUILD) reasons.push('B2_SKIP_BUILD: dist/ was not rebuilt from this candidate');\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits abandoned cancellation as successful completion through the published work object.
  C("b2m-watchdog-late-completion-credited", [{"file": "tests/isolation/runner.ts", "find": "      result = structuredClone(work);", "replace": "      result = work;"}, {"file": "tests/isolation/runner.ts", "find": "if (e instanceof Aborted || e instanceof DriverAborted || state.aborted) return;", "replace": "if (e instanceof Aborted || e instanceof DriverAborted || state.aborted) { result.verdict = 'PASS'; result.failures = []; return; }"}], { suites: ["unit", "isolation"] }),
  // Credits a PASS cell using its own N/A declarations.
  C("b2m-coverage-self-declared", [{"file": "tests/isolation/evidence.ts", "find": "const na = naChannels(c, cell.lane);", "replace": "const na = [...cell.channels_na];"}], { suites: ["unit", "isolation"] }),
  // Admits counted siblings without a discriminating spare execution.
  C("b2m-discriminating-row-unchecked", [{"file": "tests/isolation/case-schema.ts", "find": "    if (!discriminating) throw new ManifestError('kill-indistinct', c.id, `no row kills it alone with its counted siblings (${siblings.join(', ') || 'none'}) as spares`);\n", "replace": "    if (false && (!discriminating)) throw new ManifestError('kill-indistinct', c.id, `no row kills it alone with its counted siblings (${siblings.join(', ') || 'none'}) as spares`);\n"}], { suites: ["unit", "isolation"] }),
  // Admits punctuation variants of duplicate or templated intents.
  C("b2m-fault-tokens-unnormalized", [{"file": "tests/isolation/case-schema.ts", "find": ".replace(/[^a-z0-9]+/g, ' ')", "replace": ".replace(/\\s+/g, ' ')"}], { suites: ["unit", "isolation"] }),
  // Admits a source substring as a case oracle without an executable literal.
  C("b2m-oracle-substring", [{"file": "tests/isolation/case-schema.ts", "find": "if (!oracles.has(kill.oracle))", "replace": "if (!oracles.has(kill.oracle) && !ctx.runnerSource.includes(kill.oracle.split(':')[1]!))"}, {"file": "tests/isolation/case-schema.ts", "find": "if (kill.oracle !== `output_structured:${own}` &&", "replace": "if (!ctx.runnerSource.includes(kill.oracle.split(':')[1]!) && kill.oracle !== `output_structured:${own}` &&"}], { suites: ["unit", "isolation"] }),
  // Admits a killing edit in a different source file.
  C("b2m-anchor-cross-file", [{"file": "tests/isolation/case-schema.ts", "find": "edit.file === anchor.file && edit.find.includes(anchor.find)", "replace": "edit.find.includes(anchor.find)"}], { suites: ["unit", "isolation"] }),
  // Admits eval fixtures and test files as production decisions.
  C("b2m-anchor-nonproduction", [{"file": "tests/isolation/case-schema.ts", "find": "/^packages\\/(?:core|server|auth)\\/src\\/", "replace": "/^packages\\/[a-z-]+\\/src\\/"}, {"file": "tests/isolation/case-schema.ts", "find": ".refine(file => !file.endsWith('.test.ts') &&", "replace": ".refine(file =>"}, {"file": "tests/isolation/case-schema.ts", "find": " || s.source_anchor.file.endsWith('.test.ts'))", "replace": ")"}], { suites: ["unit", "isolation"] }),
  // Credits measurement values from a mismatched report digest.
  C("b2m-budget-provenance-unverified", [{"file": "tests/isolation/report.ts", "find": "    if (hash(text) !== source.report_sha256) { problems.set(c.id, 'report digest differs from report_sha256'); continue; }\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits a kill matrix row naming unknown or overlapping cases.
  C("b2m-kill-rows-unvalidated", [{"file": "tests/isolation/case-schema.ts", "find": "    if (new Set(killed).size !== killed.length || new Set(row.spares).size !== row.spares.length || [...killed, ...row.spares].some(id => !executable.has(id)) || row.spares.some(id => killed.includes(id))) throw new ManifestError('kill-row-case', row.mutant_id);\n", "replace": ""}, {"file": "tests/isolation/case-schema.ts", "find": "if (kill.oracle !== `output_structured:${own}` &&", "replace": "if (own !== undefined && kill.oracle !== `output_structured:${own}` &&"}], { suites: ["unit", "isolation"] }),
  // Admits complete evidence for an empty selection.
  C("b2m-empty-selection-accepted", [{"file": "tests/isolation/aggregate.ts", "find": "  if (chosen.raw !== undefined && chosen.ids.length === 0) throw new AggregateError('selection-empty', 'B2_CASE_IDS is set but names no case');\n", "replace": ""}, {"file": "tests/isolation/aggregate.ts", "find": "  if (!selected.length) throw new AggregateError('selection-empty');\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits a counted record carrying duplicate_of.
  C("b2m-ledger-shape-unchecked", [{"file": "tests/isolation/case-schema.ts", "find": "    if ((record.class === 'alias') !== (record.duplicate_of !== null)) throw new ManifestError('ledger-alias-shape', record.id, record.class);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits a gate with unlisted required tuples.
  C("b2m-matrix-complete-ignored", [{"file": "tests/isolation/report.ts", "find": "matrix_complete: completeness.missing === 0,", "replace": "matrix_complete: true,"}], { suites: ["unit", "isolation"] }),
  // Accepts the primary-only budget while a second driver performs extra work.
  C("b2m-secondary-driver-uncounted", [{"file": "tests/isolation/runner.ts", "find": "tool_calls: perDriver.reduce((n, v) => n + v, 0),", "replace": "tool_calls: perDriver[0] ?? 0,"}], { suites: ["unit", "isolation"] }),
  // Reports clean diagnostic evidence while a known failure remains annotated.
  C("b2m-stale-known-failure-silent", [{"file": "tests/isolation/report.ts", "find": "    ...input.gate.standings.filter(s => s.standing === 'stale_known_failure').map(s => `stale known failure ${s.id}`),\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Loses newer capture ownership on out-of-order teardown.
  C("b2m-capture-stack-unwound", [{"file": "tests/isolation/drivers.ts", "find": "if (top) install(frames.at(-1) ?? original!);", "replace": "install(original!);"}], { suites: ["unit", "isolation"] }),
  // Allows a half-open child and capture to outlive the cell.
  C("b2m-half-open-driver-unregistered", [{"file": "tests/isolation/drivers.ts", "find": "  registry?.push(driver);", "replace": "  // Broken: register only after open resolves."}, {"file": "tests/isolation/drivers.ts", "find": "    abortable(); return driver;", "replace": "    registry?.push(driver); abortable(); return driver;"}], { suites: ["unit", "isolation"] }),
  // Admits a live child after the SDK forgets its private process field.
  C("b2m-child-reference-forgotten", [{"file": "tests/isolation/drivers.ts", "find": "for (const owned of children.toReversed())", "replace": "for (const owned of children.filter(c => c.process === (transport as unknown as { _process?: ChildProcess } | undefined)?._process).toReversed())"}], { suites: ["unit", "isolation"] }),
  // Allows a driver to be opened by a cancelled startup continuation.
  C("b2m-startup-after-cancel", [{"file": "tests/isolation/runner.ts", "find": "await hooks.afterBackendStart?.(backend); abortable();", "replace": "await hooks.afterBackendStart?.(backend);"}, {"file": "tests/isolation/drivers.ts", "find": "if (closed || scope?.aborted) throw new DriverAborted();", "replace": "if (closed) throw new DriverAborted();"}, {"file": "tests/isolation/runner.ts", "find": "abortable(); result.era = driver.era; state.driver = driver;", "replace": "result.era = driver.era; state.driver = driver;"}], { suites: ["unit", "isolation"] }),
  // Credits an old clean channel scan after output was appended.
  C("b2m-capture-version-ignored", [{"file": "tests/isolation/runner.ts", "find": "if (result.capture_hashes[ch] === version) continue;", "replace": "if (result.capture_hashes[ch] !== undefined) continue;"}], { suites: ["unit", "isolation"] }),
  // Closes away state evidence before the deadline scan.
  C("b2m-pre-close-scan-skipped", [{"file": "tests/isolation/runner.ts", "find": "      // Snapshot every current channel before close can clear the retained state.", "replace": "      for (const d of drivers.toReversed()) await d.close();\n      // Broken: state may already be cleared."}], { suites: ["unit", "isolation"] }),
  // Accepts a marker added during teardown after the last scan.
  C("b2m-teardown-scan-skipped", [{"file": "tests/isolation/runner.ts", "find": "for (const d of drivers.toReversed()) { await d.close().catch(() => undefined); scanRemaining(c, backend, drivers, result); }", "replace": "for (const d of drivers.toReversed()) { await d.close().catch(() => undefined); }"}, {"file": "tests/isolation/runner.ts", "find": "    collectProhibited(c, backend, state.initialDigest, result);\n    scanRemaining(c, backend, drivers, result);\n    if (result.failures.some", "replace": "    collectProhibited(c, backend, state.initialDigest, result);\n    if (result.failures.some"}], { suites: ["unit", "isolation"] }),
  // Credits missing prohibited observations after the first recorded failure.
  C("b2m-prohibited-checks-masked", [{"file": "tests/isolation/runner.ts", "find": "const collect = (fn: () => void) => { try { fn(); }", "replace": "const collect = (fn: () => void) => { if (result.failures.length) return; try { fn(); }"}], { suites: ["unit", "isolation"] }),
  // Credits a clean later channel when an earlier channel is unreadable.
  C("b2m-channel-scan-short-circuited", [{"file": "tests/isolation/runner.ts", "find": "appendFailures(result, [{ channel: ch, predicate: 'capture readable', expected: true, observed: false }]);", "replace": "appendFailures(result, [{ channel: ch, predicate: 'capture readable', expected: true, observed: false }]); return result.failures.some(isDisclosure);"}], { suites: ["unit", "isolation"] }),
  // Credits repeat agreement despite different observable upstream work.
  C("b2m-repeat-work-ignored", [{"file": "tests/isolation/runner.ts", "find": "requests: backend.requests.filter(r => r.phase === 'target'), counts: stableCounts,", "replace": "requests: [], counts: zeroCounts(),"}, {"file": "tests/isolation/runner.ts", "find": "state: states, audit: drivers.map(d => d.audit()),", "replace": "state: [], audit: [],"}], { suites: ["unit", "isolation"] }),
  // Accepts unknown case and cell evidence fields.
  C("b2m-report-shape-open", [{"file": "tests/isolation/evidence.ts", "find": "export const CellReportSchema = z.strictObject(", "replace": "export const CellReportSchema = z.object("}, {"file": "tests/isolation/evidence.ts", "find": "export const CaseReportSchema = z.strictObject(", "replace": "export const CaseReportSchema = z.object("}], { suites: ["unit", "isolation"] }),
  // Credits cells executed under a wrong era.
  C("b2m-cell-era-unchecked", [{"file": "tests/isolation/evidence.ts", "find": "      if (cell.era !== ERAS[cell.lane]) throw new AggregateError('cell-era', report.id);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits PASS cells carrying recorded failures.
  C("b2m-cell-pass-failures", [{"file": "tests/isolation/evidence.ts", "find": "        if (cell.failures.length) throw new AggregateError('cell-pass-failures', report.id);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits a PASS cell exceeding manifested budgets.
  C("b2m-cell-budget-unchecked", [{"file": "tests/isolation/evidence.ts", "find": "        if (n.tool_calls > b.max_tool_calls || n.total_upstream_calls > b.max_total_upstream_calls || n.clinical > b.max_clinical_calls || n.max_call_bytes > b.max_result_bytes) throw new AggregateError('cell-budget', report.id);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits contradictory protected call counts.
  C("b2m-cell-counts-unchecked", [{"file": "tests/isolation/evidence.ts", "find": "        if (cell.tool_calls !== n.tool_calls || n.per_driver.reduce((a, b) => a + b, 0) !== n.tool_calls || n.total_upstream_calls !== n.clinical + n.metadata + n.auth + n.probe) throw new AggregateError('cell-counts', report.id);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits absent repeat digests.
  C("b2m-cell-repeat-digest-unchecked", [{"file": "tests/isolation/evidence.ts", "find": "        if (!/^[a-f0-9]{64}$/.test(cell.fingerprint)) throw new AggregateError('cell-repeat-digest', report.id);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Accepts a case PASS label despite a failing cell.
  C("b2m-case-verdict-trusted", [{"file": "tests/isolation/evidence.ts", "find": "    if (report.verdict !== summarizeVerdict(report.lanes)) throw new AggregateError('case-verdict', report.id);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Accepts a CLI label inconsistent with its SDK cells.
  C("b2m-cli-verdict-trusted", [{"file": "tests/isolation/evidence.ts", "find": "    if (report.cli.verdict !== summarizeVerdict(stdio)) throw new AggregateError('cli-verdict', report.id);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits disagreeing fresh runs as PASS.
  C("b2m-case-repeat-unchecked", [{"file": "tests/isolation/evidence.ts", "find": "      if (a!.fingerprint !== b!.fingerprint) throw new AggregateError('case-repeat', report.id);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits two deny-all replays without the overblocking challenge.
  C("b2m-stub-kinds-duplicated", [{"file": "tests/isolation/evidence.ts", "find": " || cell.stubs.map(s => s.kind).sort().join() !== 'deny-all,overblocking'", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits empty or non-hex capture hashes.
  C("b2m-capture-hash-invalid", [{"file": "tests/isolation/evidence.ts", "find": "!/^[a-f0-9]{64}$/.test(cell.capture_hashes[ch] ?? '')", "replace": "typeof cell.capture_hashes[ch] !== 'string'"}], { suites: ["unit", "isolation"] }),
  // Credits summary-only KILLED records without any row execution.
  C("b2m-kill-summary-trusted", [{"file": "tests/isolation/report.ts", "find": "  const credited: KillRecord[] = [];", "replace": "  if (!parsed.rows.length && !problems.length) return { kills: parsed.kills, problems };\n  const credited: KillRecord[] = [];"}], { suites: ["unit", "isolation"] }),
  // Credits a kill row without its anchors evidence.
  C("b2m-kill-anchors-unchecked", [{"file": "tests/isolation/report.ts", "find": "    if (!sameBinding(row.anchor_matches, anchors)) { fail('kills-anchors'); continue; }\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits a kill row without its compile evidence.
  C("b2m-kill-compile-unchecked", [{"file": "tests/isolation/report.ts", "find": "    if (!row.compiled || row.compile_exit !== 0 || !/^[a-f0-9]{64}$/.test(row.build_output_sha256 ?? '')) { fail('kills-compile'); continue; }\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits a kill row without its baseline evidence.
  C("b2m-kill-baseline-unchecked", [{"file": "tests/isolation/report.ts", "find": "    if (row.baseline.exit !== 0 || row.baseline.cases.some(c => c.verdict !== 'PASS')) { fail('kills-baseline'); continue; }\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits designated cells without the matrix oracle.
  C("b2m-kill-oracle-unchecked", [{"file": "tests/isolation/report.ts", "find": " && l.failures.some(f => `${f.channel}:${f.predicate}` === k.oracle)", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits a kill row despite a failing spare.
  C("b2m-kill-spares-unchecked", [{"file": "tests/isolation/report.ts", "find": "if (!killed || !spared || row.verdict !== 'KILLED')", "replace": "if (!killed || row.verdict !== 'KILLED')"}], { suites: ["unit", "isolation"] }),
  // Accepts stale evidence relabelled into a new run attempt.
  C("b2m-attempt-unbound", [{"file": "tests/isolation/report.ts", "find": "Object.entries(v).sort(([a], [b]) => a.localeCompare(b))", "replace": "Object.entries(v).filter(([k]) => !['attempt_id', 'run_id'].includes(k)).sort(([a], [b]) => a.localeCompare(b))"}], { suites: ["unit", "isolation"] }),
  // Accepts a stale executable after an imported JSON asset changes.
  C("b2m-build-assets-ignored", [{"file": "tests/isolation/build.ts", "find": ".filter(p => /\\/src\\//.test(p))", "replace": ".filter(p => /\\/src\\/.*\\.ts$/.test(p))"}], { suites: ["unit", "isolation"] }),
  // Accepts an executable built with a different inherited tsconfig.
  C("b2m-build-config-chain-ignored", [{"file": "tests/isolation/build.ts", "find": "const entries = new Map(configs);", "replace": "const entries = new Map([...configs].filter(([p]) => p === 'tsconfig.build.json'));"}], { suites: ["unit", "isolation"] }),
  // Attests a modified emitted executable as current.
  C("b2m-build-output-unchecked", [{"file": "tests/isolation/build.ts", "find": "    && readFileSync(join(root, OUTPUT), 'utf8').trim() === distDigest(root)", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits complete evidence from an unverified executable.
  C("b2m-build-unverified-admitted", [{"file": "tests/isolation/aggregate.ts", "find": "  if (!binding.build.matches_sources) throw new AggregateError('build-unverified');\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits shards bound to different installed dependency contents.
  C("b2m-dependency-binding-unchecked", [{"file": "tests/isolation/report.ts", "find": "Object.entries(v).sort(([a], [b]) => a.localeCompare(b))", "replace": "Object.entries(v).filter(([k]) => k !== 'dependencies').sort(([a], [b]) => a.localeCompare(b))"}], { suites: ["unit", "isolation"] }),
  // Admits modified shard case evidence with an old end digest.
  C("b2m-shard-content-unbound", [{"file": "tests/isolation/aggregate.ts", "find": "    if (shard.binding.end.cases_sha256 !== casesDigest(shard.cases)) throw new AggregateError('shard-cases-digest', file);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits a bogus-schema or unverified diagnostic measurement report.
  C("b2m-provenance-status-unchecked", [{"file": "tests/isolation/report.ts", "find": "    if (report.schema_version !== 'b2-isolation-report/3' || report.status !== 'DIAGNOSTIC' || !report.pins.verified || !report.binding.pins.verified || !report.binding.build.matches_sources || report.binding.build.skipped || !/^[a-f0-9]{64}$/.test(report.binding.build.output_sha256)) { problems.set(c.id, 'provenance-status: measurement is not verified diagnostic evidence'); continue; }\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits six copies of a cell as six passing independent measurements.
  C("b2m-provenance-cells-unchecked", [{"file": "tests/isolation/report.ts", "find": "    try { validateAggregate([measuredCase], [c.id], [c], false); }", "replace": "    try { /* Broken: trust PASS and the recorded maxima. */ }"}], { suites: ["unit", "isolation"] }),
  // Credits measurements declared against another report binding.
  C("b2m-provenance-binding-unchecked", [{"file": "tests/isolation/report.ts", "find": "    if (report.run_id !== source.run_id || report.run.run_id !== source.run_id || report.binding.run_id !== source.run_id || !report.binding.attempt_id || bindingDigest(report.binding) !== source.binding_sha256) { problems.set(c.id, 'provenance-binding: measurement binding differs'); continue; }\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits annotated counted cases by bypassing standing and gate checks.
  C("b2m-gate-known-failure-admitted", [{"file": "tests/isolation/report.ts", "find": "  if (c.known_failure) return result(verdict === 'PASS' ? 'stale_known_failure' : 'counted_known_failure');\n", "replace": ""}, {"file": "tests/isolation/report.ts", "find": "no_counted_known_failure: manifest.cases.every(c => !c.counted || !c.known_failure),", "replace": "no_counted_known_failure: true,"}], { suites: ["unit", "isolation"] }),
  // Admits counted cases without proven budget measurements.
  C("b2m-gate-unproven-budget-admitted", [{"file": "tests/isolation/report.ts", "find": "  if (unprovenBudgets.has(c.id)) return result('counted_unproven_budget', false, unprovenBudgets.get(c.id));\n", "replace": ""}, {"file": "tests/isolation/report.ts", "find": "no_unproven_budget: (extra.unprovenBudgets?.size ?? 0) === 0,", "replace": "no_unproven_budget: true,"}], { suites: ["unit", "isolation"] }),
  // Admits a non-counted manifest case that is pending.
  C("b2m-gate-noncounted-failure-admitted", [{"file": "tests/isolation/report.ts", "find": "every_manifest_case_pass: manifest.cases.every(c => byId.get(c.id)?.verdict === 'PASS'),", "replace": "every_manifest_case_pass: manifest.cases.filter(c => c.counted).every(c => byId.get(c.id)?.verdict === 'PASS'),"}], { suites: ["unit", "isolation"] }),
  // Admits renamed copies of the same mutation as independent rows.
  C("b2m-identical-edits-independent", [{"file": "tests/isolation/case-schema.ts", "find": "if (editSets.has(editSet)) throw new ManifestError('kill-row-identical-edits', row.mutant_id); ", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits a discriminating row without executing its other counted family cases.
  C("b2m-family-spares-unchecked", [{"file": "tests/isolation/case-schema.ts", "find": " || other.family === c.family", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits overlapping or common-window anchors without reciprocal spares.
  C("b2m-anchor-siblings-unchecked", [{"file": "tests/isolation/case-schema.ts", "find": " || anchorSiblings(c, other, ctx)", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits edits preserving the purported decision anchor.
  C("b2m-anchor-unchanged", [{"file": "tests/isolation/case-schema.ts", "find": " && editsAnchor(edit, anchor)", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits one novel word appended to template text.
  C("b2m-intent-novelty-weakened", [{"file": "tests/isolation/case-schema.ts", "find": "minimumContent = 4", "replace": "minimumContent = 1"}], { suites: ["unit", "isolation"] }),
  // Admits homoglyph letters into intents and transitions.
  C("b2m-intent-nonascii-admitted", [{"file": "tests/isolation/case-schema.ts", "find": "const nonAsciiLetters = (value: string) => /[^\\x00-\\x7f]/u.test(value.replace(/[^\\p{L}]/gu, ''));", "replace": "const nonAsciiLetters = (_value: string) => false;"}], { suites: ["unit", "isolation"] }),
  // Admits duplicate fault content distinguished only by stopwords.
  C("b2m-intent-stopword-duplicates", [{"file": "tests/isolation/case-schema.ts", "find": "const fault = contentTokens(s.discriminating_fault_intent, []).join(' ');", "replace": "const fault = tokens(s.discriminating_fault_intent).join(' ');"}], { suites: ["unit", "isolation"] }),
  // Admits the stock transition after punctuation is appended.
  C("b2m-transition-punctuation", [{"file": "tests/isolation/case-schema.ts", "find": "tokens(s.state_transition).join(' ').endsWith('control then attack and retained followups')", "replace": "/^[a-z-]+:control-then-attack-and-retained-followups$/.test(s.state_transition)"}], { suites: ["unit", "isolation"] }),
  // Admits an additional required control the runner never executes.
  C("b2m-extra-control-unexecuted", [{"file": "tests/isolation/case-schema.ts", "find": "controls: z.array(control).length(1)", "replace": "controls: z.array(control).min(1).max(10)"}, {"file": "tests/isolation/case-schema.ts", "find": "    if (c.controls.length !== 1) throw new ManifestError('control-contract', c.id, 'exactly one executable control');\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits control assertion/challenge IDs that cannot execute.
  C("b2m-control-contract-unchecked", [{"file": "tests/isolation/case-schema.ts", "find": "    if (ctrl.assertions.slice().sort().join() !== [`${contract.predicate_id}.positive`, `b2.control.${feature}`].sort().join() || ctrl.overblocking_challenges.join() !== feature) throw new ManifestError('control-contract', c.id);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits an undefined expected assertion.
  C("b2m-assertions-unknown", [{"file": "tests/isolation/case-schema.ts", "find": "    if (new Set(c.expected_assertions).size !== c.expected_assertions.length || c.expected_assertions.some(id => !knownAssertions.has(id))) throw new ManifestError('assertion-contract', c.id);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits modern twice as the two required eras.
  C("b2m-eras-duplicated", [{"file": "tests/isolation/case-schema.ts", "find": ".refine(eras => new Set(eras).size === 2, 'two distinct eras')", "replace": ""}, {"file": "tests/isolation/case-schema.ts", "find": "  if (manifest.required_eras.slice().sort().join() !== ['2025-11-25', '2026-07-28'].join()) throw new ManifestError('required-eras');\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits expected/observed literals as an oracle for a variable predicate.
  C("b2m-oracle-late-arguments", [{"file": "tests/isolation/oracle-registry.ts", "find": "add(literal(node.arguments[1]), literal(node.arguments[2]));", "replace": "{ add(literal(node.arguments[1]), literal(node.arguments[2])); add(literal(node.arguments.at(-2)), literal(node.arguments.at(-1))); }"}], { suites: ["unit", "isolation"] }),
  // Admits another case contract as this row's oracle.
  C("b2m-oracle-case-unbound", [{"file": "tests/isolation/case-schema.ts", "find": "      if (kill.oracle !== `output_structured:${own}` && !common.has(kill.oracle) && !literalOracles(clauses.get(kill.case_id) ?? '').has(kill.oracle)) throw new ManifestError('kill-case-oracle', row.mutant_id, kill.oracle);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits a reduced axis universe as the frozen scope.
  C("b2m-matrix-universe-shrunk", [{"file": "tests/isolation/case-schema.ts", "find": "  for (const key of MATRIX_KEYS) if (JSON.stringify([...matrix.axes[key]].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))) !== JSON.stringify([...MATRIX_AXES[key]].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))) throw new ManifestError('matrix-universe', key);\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Admits a single-axis N/A rule covering at most 1000 tuples.
  C("b2m-na-single-axis", [{"file": "tests/isolation/case-schema.ts", "find": "if (keys.length < 2)", "replace": "if (keys.length < 1)"}], { suites: ["unit", "isolation"] }),
  // Admits an N/A rule covering more than 1000 tuples.
  C("b2m-na-unbounded", [{"file": "tests/isolation/case-schema.ts", "find": "    if (matched > 1000) throw new ManifestError('matrix-rule-size', rule.id, String(matched));\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Credits relabelled or moved first-slice ledger records against an unchanged design.
  C("b2m-ledger-design-unchecked", [{"file": "tests/isolation/case-schema.ts", "find": "return JSON.stringify(ledger.records.slice().sort((a, b) => a.id.localeCompare(b.id)).map(fields)) === JSON.stringify(expected);", "replace": "return true;"}], { suites: ["unit", "isolation"] }),
  // Allows a skip-build test process to rebuild an executable.
  C("b2m-outer-skip-build-ignored", [{"file": "tests/isolation/counting.test.ts", "find": "  if (outerSkipBuild) return; // N12: the outer skip-build run owns dist; this test must never rebuild it.\n", "replace": ""}], { suites: ["unit", "isolation"] }),
  // Returns a value for malformed evidence JSON instead of refusing it.
  C("b2m-malformed-json-admitted", [{"file": "tests/isolation/evidence.ts", "find": "catch { throw new AggregateError(code, 'invalid JSON'); }", "replace": "catch { return {}; }"}], { suites: ["unit", "isolation"] }),
  // Returns invalid input as schema-validated evidence.
  C("b2m-malformed-shape-admitted", [{"file": "tests/isolation/evidence.ts", "find": "if (!parsed.success) throw new AggregateError(code, 'invalid evidence shape');", "replace": "if (!parsed.success) return input as T;"}], { suites: ["unit", "isolation"] }),
];

// --- Sharding and aggregation (pure helpers; unit-tested without running the gate) ---

export const SHARD_REPORT_SCHEMA = 'fhir-mcp-mutation-shard/4';
const VERDICTS = new Set(['killed', 'survived', 'inconclusive', 'anchor-error']);
const BINDING_KEYS = ['commit', 'tree', 'inputsSha256', 'survivorsSha256', 'nodeVersion', 'platform', 'arch', 'runId', 'runAttempt'];
const MAX_SHARDS = 1024;

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function validShardCount(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_SHARDS;
}

/** Snapshot the original checkout before creating any mutation worker copies. */
export async function candidateBinding(checkout = root) {
  const git = async argv => (await execFileAsync('git', argv, { cwd: checkout, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const commit = (await git(['rev-parse', 'HEAD'])).trim();
  const tree = (await git(['rev-parse', 'HEAD^{tree}'])).trim();
  const paths = [...new Set((await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0'))]
    .filter(path => path && !['node_modules', '.git', 'dist', '.local', 'mutation-results', 'artifacts'].includes(path.split('/')[0])).sort();
  const deleted = new Set((await git(['ls-files', '--deleted', '-z'])).split('\0'));
  const hash = createHash('sha256');
  for (const path of paths) {
    // Retired drafts remain tracked until root stages them; bind their absence
    // by name, separately from an empty file or an unreadable existing input.
    if (deleted.has(path)) {
      hash.update(`${Buffer.byteLength(path)}:${path}deleted:`);
      continue;
    }
    const content = await readFile(join(checkout, path));
    hash.update(`${Buffer.byteLength(path)}:${path}${content.length}:`).update(content);
  }
  return {
    commit, tree, inputsSha256: hash.digest('hex'),
    survivorsSha256: sha256Hex(await readFile(join(checkout, 'scripts/mutation-survivors.json'), 'utf8')),
    nodeVersion: process.version, platform: process.platform, arch: process.arch,
    runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  };
}

function validBinding(binding) {
  return binding && typeof binding === 'object'
    && ['commit', 'tree'].every(key => /^[a-f0-9]{40}$/.test(binding[key]))
    && ['inputsSha256', 'survivorsSha256'].every(key => /^[a-f0-9]{64}$/.test(binding[key]))
    && ['nodeVersion', 'platform', 'arch'].every(key => typeof binding[key] === 'string' && binding[key].length > 0)
    && ['runId', 'runAttempt'].every(key => binding[key] === null || typeof binding[key] === 'string');
}

/** Hash of a mutant's anchor definition (file + exact find/replace strings). */
export function mutationEdits(mutant) {
  const edits = mutant.edits ?? [{ file: mutant.file, find: mutant.find, replace: mutant.replace }];
  if (!Array.isArray(edits) || !edits.length || edits.some(edit => !edit || typeof edit.file !== 'string'
    || !edit.file || isAbsolute(edit.file) || edit.file.split(/[\\/]/).some(part => part === '..' || part === '.')
    || ['node_modules', '.git', 'dist', '.local', 'mutation-results', 'artifacts'].includes(edit.file.split(/[\\/]/)[0].toLowerCase())
    || typeof edit.find !== 'string' || !edit.find || typeof edit.replace !== 'string')) throw new Error(`invalid edits for ${mutant.id}`);
  if (edits.some(edit => edit.replace.trim().toLowerCase() === '<empty>')) {
    throw new Error(`invalid replacement placeholder for ${mutant.id}: use the empty string for deletion`);
  }
  return edits.map(({ file, find, replace }) => ({ file, find, replace }));
}

export function mutationSuites(mutant) {
  const suites = mutant.suites ?? ['unit'];
  if (JSON.stringify(suites) !== '["unit"]' && JSON.stringify(suites) !== '["unit","isolation"]') {
    throw new Error(`invalid suites for ${mutant.id}: unit is mandatory; isolation is the only additional suite`);
  }
  return [...suites];
}

export function mutationPreparation(mutant) {
  if (mutant.prepare !== undefined && mutant.prepare !== 'contract') throw new Error(`invalid preparation for ${mutant.id}`);
  return mutant.prepare === 'contract'
    ? { file: 'docs/contracts/m3b-tools.json', argv: ['--import', 'tsx', 'scripts/emit-m3b-contract.mjs'] } : null;
}

/** Sequential semantics shared by pristine anchor maintenance and the actual judge. */
export function applyMutationEdits(mutant, pristine) {
  const changed = new Map(), failures = [];
  for (const edit of mutationEdits(mutant)) {
    const source = changed.get(edit.file) ?? pristine.get(edit.file);
    const count = typeof source === 'string' ? source.split(edit.find).length - 1 : 0;
    if (count !== 1) { failures.push({ file: edit.file, count, reason: 'anchor must match exactly once at this step' }); continue; }
    const next = source.replace(edit.find, () => edit.replace);
    if (next === source) failures.push({ file: edit.file, count, reason: 'edit leaves file unchanged' });
    changed.set(edit.file, next);
  }
  return { changed, failures };
}

export function anchorHash(mutant) {
  mutationPreparation(mutant);
  return sha256Hex(JSON.stringify({ edits: mutationEdits(mutant), suites: mutationSuites(mutant), prepare: mutant.prepare ?? null }));
}

/** Hash binding the full ordered mutant list and every anchor definition. */
export function mutantListHash(mutants) {
  return sha256Hex(mutants.map(mutant => `${mutant.id}\0${anchorHash(mutant)}`).join('\n'));
}

/** Parse and validate a `--shard i/n` spec (1-based). Throws on any invalid spec. */
export function parseShardSpec(spec) {
  const match = /^(\d+)\/(\d+)$/.exec(String(spec ?? '').trim());
  if (!match) throw new Error(`invalid --shard spec ${JSON.stringify(spec)} (expected i/n, 1-based)`);
  const shardIndex = Number(match[1]);
  const shardCount = Number(match[2]);
  if (!validShardCount(shardCount) || !Number.isSafeInteger(shardIndex) || shardIndex < 1 || shardIndex > shardCount) {
    throw new Error(`invalid --shard spec ${JSON.stringify(spec)} (need 1 <= i <= n)`);
  }
  return { shardIndex, shardCount };
}

/**
 * The full frozen list and its ordinal are part of every report's binding.
 * Changes to that list invalidate earlier reports rather than mixing them.
 */
export function shardForIndex(index, shardCount) {
  if (!validShardCount(shardCount) || !Number.isSafeInteger(index) || index < 0) throw new Error('invalid shard ordinal/count');
  return (index % shardCount) + 1;
}

/** Partition into shardCount lists (index 0 = shard 1), preserving list order within each shard. */
export function partitionMutants(mutants, shardCount) {
  if (!validShardCount(shardCount)) throw new Error('invalid shard count');
  const shards = Array.from({ length: shardCount }, () => []);
  mutants.forEach((mutant, index) => shards[shardForIndex(index, shardCount) - 1].push(mutant));
  return shards;
}

export function mutantsForShard(mutants, shardIndex, shardCount) {
  if (!Number.isSafeInteger(shardIndex) || shardIndex < 1 || shardIndex > shardCount) throw new Error('invalid shard index');
  return mutants.filter((_, index) => shardForIndex(index, shardCount) === shardIndex);
}

export function shardReportFileName(shardIndex, shardCount) {
  return `mutation-shard-${shardIndex}-of-${shardCount}.json`;
}

/** Reports must never become new candidate inputs for the following shard. */
export function validateReportPath(path, checkout = root) {
  const output = resolve(path);
  const rel = relative(resolve(checkout), output);
  const external = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!external && (!rel || !['mutation-results', '.local', 'artifacts'].includes(rel.split(sep)[0]))) {
    throw new Error('in-checkout reports must use mutation-results/, .local/ or artifacts/; alternatively use an external path');
  }
  return output;
}

/** Build the JSON shard report for one judged shard (results as returned by judge()). */
export function buildShardReport({ shardIndex, shardCount, mutants, binding, baseline, suiteBaselines = {}, results, durationMs, mode = 'shard', scheduledIds }) {
  const byId = new Map(mutants.map(mutant => [mutant.id, mutant]));
  return {
    schema: SHARD_REPORT_SCHEMA,
    shardId: `${shardIndex}/${shardCount}`,
    shardIndex,
    shardCount,
    mutantListHash: mutantListHash(mutants),
    mutantCount: mutants.length,
    mutantIds: mutants.map(mutant => mutant.id),
    binding,
    mode,
    scheduledIds: scheduledIds ?? mutantsForShard(mutants, shardIndex, shardCount).map(mutant => mutant.id),
    baseline,
    suiteBaselines,
    durationMs: Math.round(durationMs ?? 0),
    results: results.map(result => ({
      id: result.id,
      verdict: result.status ?? result.verdict,
      failingTests: [...(result.failingTests ?? [])],
      anchorHash: byId.has(result.id) ? anchorHash(byId.get(result.id)) : null,
      suites: byId.has(result.id) ? mutationSuites(byId.get(result.id)) : [],
      suiteRuns: result.suiteRuns ?? [],
      compilation: result.compilation,
      durationMs: result.durationMs,
      anchorMatches: result.anchorMatches,
      reproducedTimeout: result.reproducedTimeout === true,
      kill_kind: result.kill_kind ?? null,
      detail: result.detail ?? '',
    })),
  };
}

/**
 * Validate a complete set of shard reports against the full mutant list and
 * the declared survivors. Pure: no I/O, no test runs. `declared` is a Map of
 * id -> {justification} (or an array of such entries). Returns
 * {ok, errors, summary}; every acceptance rule of the unsharded gate is
 * re-checked here globally, including the stale-survivor check.
 */
export function aggregateShardReports(reports, { mutants, declared, expectedShardCount, binding } = {}) {
  const errors = [];
  const declaredMap = declared instanceof Map ? declared : new Map((declared ?? []).map(entry => [entry.id, entry]));
  const byId = new Map((mutants ?? []).map(mutant => [mutant.id, mutant]));
  const listHash = mutantListHash(mutants ?? []);
  const summary = { killed: 0, survived: 0, inconclusive: 0, anchorErrors: 0, declaredSurvivors: declaredMap.size, total: 0 };
  const timeoutKills = [];
  if (!validBinding(binding)) errors.push('expected candidate binding is missing or malformed');
  if (expectedShardCount !== undefined && !validShardCount(expectedShardCount)) errors.push('invalid expected shard count');
  if (!mutants?.length || byId.size !== mutants.length) errors.push('current mutant list is empty or has duplicate ids');

  if (!Array.isArray(reports) || reports.length === 0) {
    return { ok: false, errors: ['no shard reports found'], summary, timeoutKills };
  }
  const counts = new Set();
  const seenShards = new Map();
  for (const [position, report] of reports.entries()) {
    if (!report || typeof report !== 'object' || report.schema !== SHARD_REPORT_SCHEMA) {
      errors.push(`report ${position + 1}: missing or wrong schema (expected ${SHARD_REPORT_SCHEMA})`);
      continue;
    }
    if (!validShardCount(report.shardCount)
      || !Number.isInteger(report.shardIndex) || report.shardIndex < 1 || report.shardIndex > report.shardCount) {
      errors.push(`report ${position + 1}: invalid shard index/count (${report.shardIndex}/${report.shardCount})`);
      continue;
    }
    counts.add(report.shardCount);
    if (seenShards.has(report.shardIndex)) errors.push(`duplicate report for shard ${report.shardIndex}/${report.shardCount}`);
    seenShards.set(report.shardIndex, report);
    if (report.shardId !== `${report.shardIndex}/${report.shardCount}`) errors.push(`report ${position + 1}: shard id disagrees`);
    if (!validBinding(report.binding) || !validBinding(binding) || BINDING_KEYS.some(key => report.binding[key] !== binding[key])) {
      errors.push(`shard ${report.shardIndex}/${report.shardCount}: candidate/runtime/input binding disagrees`);
    }
    if (report.mode !== 'shard' && !(report.mode === 'full' && report.shardCount === 1)) errors.push(`report ${position + 1}: diagnostic or invalid mode cannot earn acceptance`);
    const expectedIds = mutantsForShard(mutants ?? [], report.shardIndex, report.shardCount).map(mutant => mutant.id);
    if (JSON.stringify(report.scheduledIds) !== JSON.stringify(expectedIds)) errors.push(`report ${position + 1}: scheduled ids disagree with the frozen partition`);
    if (report.baseline !== 'green') errors.push(`shard ${report.shardIndex}/${report.shardCount}: baseline was not green (${JSON.stringify(report.baseline)})`);
    if (report.mutantListHash !== listHash) errors.push(`shard ${report.shardIndex}/${report.shardCount}: mutant list hash disagrees with the current mutant list`);
    if (report.mutantCount !== mutants?.length || JSON.stringify(report.mutantIds) !== JSON.stringify((mutants ?? []).map(mutant => mutant.id))) errors.push(`report ${position + 1}: full mutant ids/count disagree`);
    if (!Array.isArray(report.results) || report.results.length === 0) errors.push(`shard ${report.shardIndex}/${report.shardCount}: results missing or empty`);
  }
  if (counts.size > 1) errors.push(`shard count disagrees across reports (${[...counts].sort((a, b) => a - b).join(', ')})`);
  const shardCount = counts.size === 1 ? [...counts][0] : undefined;
  if (expectedShardCount !== undefined && shardCount !== undefined && shardCount !== expectedShardCount) {
    errors.push(`shard count ${shardCount} disagrees with the expected ${expectedShardCount}`);
  }
  if (shardCount !== undefined) {
    for (let shard = 1; shard <= shardCount; shard++) {
      if (!seenShards.has(shard)) errors.push(`missing shard ${shard}/${shardCount}`);
    }
  }

  const verdicts = new Map();
  for (const report of seenShards.values()) {
    for (const result of Array.isArray(report.results) ? report.results : []) {
      const verdict = result?.verdict ?? result?.status;
      if (!result || typeof result.id !== 'string' || !VERDICTS.has(verdict)) {
        errors.push(`shard ${report.shardIndex}/${report.shardCount}: malformed result entry ${JSON.stringify(result)?.slice(0, 120)}`);
        continue;
      }
      if (verdicts.has(result.id)) errors.push(`mutant ${result.id}: ran more than once (shards ${verdicts.get(result.id).shard} and ${report.shardIndex})`);
      else verdicts.set(result.id, { verdict, shard: report.shardIndex });
      if (!byId.has(result.id)) { errors.push(`mutant ${result.id}: not in the current mutant list`); continue; }
      if (!mutantsForShard(mutants, report.shardIndex, report.shardCount).some(mutant => mutant.id === result.id)) errors.push(`mutant ${result.id}: ran in the wrong shard`);
      if (JSON.stringify(result.suites) !== JSON.stringify(mutationSuites(byId.get(result.id)))) errors.push(`mutant ${result.id}: suite declaration disagrees`);
      if (result.failingTests?.some(name => name.startsWith('isolation:')) && !mutationSuites(byId.get(result.id)).includes('isolation')) errors.push(`mutant ${result.id}: isolation kill outside declared suites`);
      if (result.anchorHash !== anchorHash(byId.get(result.id))) errors.push(`mutant ${result.id}: anchor hash disagrees with the current anchor definition`);
      if (result.anchorMatches !== 1) errors.push(`mutant ${result.id}: anchor did not match exactly once`);
      const expectedKind = verdict === 'killed' ? (result.failingTests?.length ? 'named' : 'timeout') : null;
      if (result.kill_kind !== expectedKind) errors.push(`mutant ${result.id}: kill_kind disagrees with reproduced evidence`);
      if (verdict === 'killed' && result.kill_kind === 'timeout' && !timeoutKills.includes(result.id)) timeoutKills.push(result.id);
      if (!Array.isArray(result.failingTests) || result.failingTests.some(name => typeof name !== 'string' || !name.trim())
        || typeof result.reproducedTimeout !== 'boolean'
        || (verdict === 'killed' && !result.failingTests?.length && result.reproducedTimeout !== true)) errors.push(`mutant ${result.id}: malformed killing evidence`);
    }
  }
  for (const mutant of mutants ?? []) {
    if (!verdicts.has(mutant.id)) errors.push(`mutant ${mutant.id}: ran zero times (no shard reported it)`);
  }
  summary.total = verdicts.size;
  for (const [id, { verdict }] of verdicts) {
    if (!byId.has(id)) continue;
    if (verdict === 'killed') summary.killed++;
    if (verdict === 'survived') summary.survived++;
    if (verdict === 'inconclusive') summary.inconclusive++;
    if (verdict === 'anchor-error') summary.anchorErrors++;
    if (verdict === 'anchor-error') errors.push(`FAIL ${id}: anchor-error`);
    if (verdict === 'inconclusive') errors.push(`FAIL ${id}: INCONCLUSIVE`);
    if (verdict === 'survived' && !declaredMap.has(id)) errors.push(`FAIL ${id}: SURVIVED without a declared justification`);
    if (verdict === 'killed' && declaredMap.has(id)) errors.push(`FAIL ${id}: declared survivor was killed; remove the stale entry`);
  }
  for (const [id, entry] of declaredMap) {
    if (!byId.has(id)) errors.push(`FAIL survivor entry ${id}: no such mutant`);
    if (!entry?.justification || String(entry.justification).trim().length < 20) errors.push(`FAIL survivor entry ${id}: justification missing or too short`);
  }
  return { ok: errors.length === 0, errors, summary, timeoutKills };
}

export function timeoutKillSummary(ids) {
  return `mutation-guards aggregate timeout-only kills: ${ids.length} [${ids.join(', ')}]`;
}

/** Read every *.json shard report in a directory. Returns {reports, errors, files}. */
export async function readShardReports(dir) {
  const errors = [];
  const reports = [];
  let files = [];
  try {
    files = (await readdir(dir)).filter(name => name.endsWith('.json')).sort();
  } catch {
    return { reports, errors: [`cannot read shard report directory ${dir}`], files };
  }
  if (!files.length) errors.push(`no shard report JSON files in ${dir}`);
  for (const file of files) {
    try {
      reports.push(JSON.parse(await readFile(join(dir, file), 'utf8')));
    } catch {
      errors.push(`shard report ${file}: not valid JSON`);
    }
  }
  return { reports, errors, files };
}

async function run(command, argv, cwd, timeoutMs) {
  // The copy is judge-owned. A fresh child temp root also covers retries and
  // descendants whose after hooks cannot run when the suite is interrupted.
  const temp = await mkdtemp(join(cwd, '.mutation-tmp-'));
  try {
    return await runProcess(command, argv, cwd, timeoutMs, temp);
  } finally {
    // A timeout has killed the launched group by now, but after a normal exit a
    // straggler (or a nested judge's detached group) may still write here.
    await removeSuiteTemp(temp);
  }
}

// Cleanup never replaces a settled result: a leftover only leaks until the copy goes.
async function removeSuiteTemp(temp) {
  const remove = () => rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  try { return await remove(); } catch { /* retried below once owner access is restored */ }
  try {
    await restoreOwnerAccess(temp);
    await remove();
  } catch (error) {
    console.error(`mutation-guards: could not remove a suite temp directory (${error?.code ?? 'unknown error'})`);
  }
}

// An interrupted suite cannot restore directory modes it lowered. Never follow links.
async function restoreOwnerAccess(path) {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isDirectory()) return;
  await chmod(path, 0o700).catch(() => undefined);
  for (const name of await readdir(path).catch(() => [])) await restoreOwnerAccess(join(path, name));
}

function runProcess(command, argv, cwd, timeoutMs, temp) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const env = { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp };
    delete env.NODE_TEST_CONTEXT; // Child suites must run even when invoked by a judge unit test.
    // POSIX detached children lead a new process group inherited by suite descendants.
    const child = spawn(command, argv, { cwd, detached: true, env });
    const group = child.pid;
    const stdout = [], stderr = [];
    let failed = false, timedOut = false, closed = false, stopping = false, escalated = false, settled = false;
    let deadline, escalation, drain, signalError;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      clearTimeout(drain);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      if (signalError) { reject(signalError); return; }
      resolve({ ok: !failed, durationMs: Date.now() - started, timedOut: timedOut && failed,
        out: `${Buffer.concat(stdout).toString('utf8')}\n${Buffer.concat(stderr).toString('utf8')}` });
    };
    const signalGroup = signal => {
      // A failed spawn has no group. Never fall back to the judge's own group.
      if (!Number.isSafeInteger(group) || group <= 0) return;
      try { process.kill(-group, signal); }
      catch (error) { if (error.code !== 'ESRCH') signalError ??= error; }
    };
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      clearTimeout(deadline);
      signalGroup('SIGTERM');
      escalation = setTimeout(() => {
        // Parent exit/pipe closure must never cancel descendant escalation.
        signalGroup('SIGKILL');
        escalated = true;
        if (closed) finish();
        // Even an inherited pipe held outside the group cannot strand the judge.
        else drain = setTimeout(finish, 250);
      }, 1_000);
    };
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      let bytes = 0;
      stream.on('data', chunk => {
        // Drain available TAP within the existing separate 32 MiB stdout/stderr limits.
        const remaining = 32 * 1024 * 1024 - bytes;
        if (remaining > 0) {
          const captured = chunk.subarray(0, remaining);
          chunks.push(captured);
          bytes += captured.length;
        }
        if (chunk.length > remaining) { failed = true; stop(); }
      });
      stream.on('error', () => { failed = true; stop(); });
    }
    child.on('error', () => { failed = true; });
    child.on('close', (code, signal) => {
      closed = true;
      failed ||= code !== 0 || signal !== null;
      if (!stopping || escalated) finish();
    });
    // One deadline governs execution; timeout cleanup has its own fixed, bounded grace.
    deadline = setTimeout(() => { timedOut = true; failed = true; stop(); }, Math.max(0, timeoutMs - (Date.now() - started)));
  });
}

async function makeCopy() {
  const dir = await mkdtemp(join(tmpdir(), 'fhir-mcp-mutation-'));
  await cp(root, dir, {
    recursive: true,
    filter: source => {
      const rel = source.slice(root.length + 1);
      if (!rel) return true;
      const top = rel.split('/')[0];
      return !['node_modules', '.git', 'dist', '.local', 'mutation-results'].includes(top);
    },
  });
  await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

export const ANCHOR_TEST_FILE = 'tests/mutation-anchors.test.ts';

export async function testFiles(dir, suite, baseline = false) {
  const folder = suite === 'isolation' ? join('tests', 'isolation') : 'tests';
  const names = await readdir(join(dir, folder));
  return names.filter(name => name.endsWith('.test.ts')).sort().map(name => join(folder, name))
    .filter(file => baseline || file !== ANCHOR_TEST_FILE);
}

/** Failing test names from TAP output (`not ok N - name`), deduplicated in report order. */
export function failingTests(out) {
  const names = [];
  for (const match of String(out).matchAll(/^not ok \d+ - (.+)$/gm)) {
    const name = match[1].trim();
    if (/ # (?:TODO|SKIP)\b/i.test(name)) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export function testSuiteArgs(files, concurrency, namePattern) {
  const argv = ['--import', 'tsx', '--test', '--test-reporter=tap', `--test-concurrency=${concurrency}`];
  if (namePattern) argv.push(`--test-name-pattern=${namePattern}`);
  return [...argv, ...files];
}

export async function runSuite(dir, timeoutMs, namePattern = undefined, suite = 'unit', baseline = false, concurrency = TEST_CONCURRENCY) {
  const files = await testFiles(dir, suite, baseline);
  const result = await run(process.execPath, testSuiteArgs(files, concurrency, namePattern), dir, timeoutMs);
  const testsRun = Number(/^# tests (\d+)$/m.exec(result.out)?.[1] ?? NaN);
  return { ...result, suite, failed: failingTests(result.out).map(name => suite === 'isolation' ? `isolation:${name}` : name), testsRun };
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One judging pass over an already-applied mutant. Returns {outcome:'passed'} or
 * {outcome:'failed', signature, timedOut} where the signature names what failed:
 * test names, or `evals:<era>` when the suite passed but an eval era failed.
 */
export async function attempt(dir, mutant, suiteRuns, caps = testTimeoutMs) {
  for (const suite of mutationSuites(mutant)) {
    const tests = await runSuite(dir, caps[suite], undefined, suite);
    suiteRuns.push({ suite, focused: false, durationMs: tests.durationMs, testsRun: tests.testsRun, failed: tests.failed, timedOut: tests.timedOut });
    if (!tests.ok) return { outcome: 'failed', signature: tests.failed, timedOut: tests.timedOut, suite };
  }
  for (const suite of ['evals:modern', 'evals:legacy']) {
    const evalRun = await runEval(dir, suite, caps[suite]);
    const signature = evalRun.ok || evalRun.timedOut ? [] : [suite];
    suiteRuns.push({ suite, focused: false, durationMs: evalRun.durationMs, testsRun: null, failed: signature, timedOut: evalRun.timedOut });
    if (!evalRun.ok) return { outcome: 'failed', signature, timedOut: evalRun.timedOut, suite };
  }
  return { outcome: 'passed', signature: [], timedOut: false, suite: 'evals:legacy' };
}

export async function runEval(dir, suite, timeoutMs) {
  if (!['evals:modern', 'evals:legacy'].includes(suite)) throw new Error(`invalid eval suite ${suite}`);
  return run(process.execPath, ['--import', 'tsx', 'packages/evals/src/cli.ts', '--out', '/dev/null', ...(suite === 'evals:legacy' ? ['--era', 'legacy'] : [])], dir, timeoutMs);
}

export function reproducedKill(first, second) {
  const sameSuite = ['unit', 'isolation', 'evals:modern', 'evals:legacy'].includes(first.suite) && first.suite === second.suite;
  const reproduced = sameSuite ? first.signature.filter(name => second.signature.includes(name) && !name.endsWith('.test.ts')) : [];
  const timedOut = sameSuite && first.timedOut && second.timedOut;
  return { killed: second.outcome === 'failed' && (reproduced.length > 0 || timedOut), reproduced,
    reproducedTimeout: timedOut, kill_kind: reproduced.length ? 'named' : timedOut ? 'timeout' : null };
}

/** The actual focused judging pass; runner injection keeps cap tests deterministic. */
export async function focusedAttempt(dir, first, suiteRuns, caps = testTimeoutMs, runFocused = runSuite) {
  const pattern = `^(?:${first.signature.map(name => escapeRegExp(first.suite === 'isolation' ? name.slice('isolation:'.length) : name)).join('|')})$`;
  const rerun = await runFocused(dir, caps[first.suite], pattern, first.suite);
  suiteRuns.push({ suite: first.suite, focused: true, durationMs: rerun.durationMs, testsRun: rerun.testsRun, failed: rerun.failed, timedOut: rerun.timedOut });
  return rerun.testsRun === 0
    ? { outcome: 'failed', signature: [], timedOut: false, unmatched: true, suite: first.suite }
    : { outcome: rerun.ok ? 'passed' : 'failed', signature: rerun.failed, timedOut: rerun.timedOut, suite: first.suite };
}

export async function judge(dir, mutant, pristine) {
  const started = Date.now(), suiteRuns = [], compilation = {};
  const { changed, failures } = applyMutationEdits(mutant, pristine);
  if (failures.length) return { id: mutant.id, status: 'anchor-error', anchorMatches: failures[0].count, failingTests: [], detail: failures.map(f => `${f.file}: count=${f.count} ${f.reason}`).join('; ') };
  const preparation = mutationPreparation(mutant);
  const verdict = result => ({ id: mutant.id, anchorMatches: 1, suiteRuns, compilation, durationMs: Date.now() - started, ...result });
  try {
    for (const [file, content] of changed) await writeFile(join(dir, file), content);
    if (preparation) {
      const prepared = await run(process.execPath, preparation.argv, dir, BASELINE_TIMEOUT_MS);
      if (!prepared.ok) return verdict({ status: 'inconclusive', failingTests: [], detail: 'copied-contract preparation failed; no credited kill' });
    }
    // A compile/import failure is not a discriminating assertion kill.
    for (const [name, argv] of [['typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']], ['build', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']]]) {
      const check = await run(process.execPath, argv, dir, BASELINE_TIMEOUT_MS);
      compilation[name] = check.ok;
      if (!check.ok) return verdict({ status: 'inconclusive', failingTests: [], detail: `mutant ${name} failed; compilation failures cannot earn a kill: ${check.out.slice(-800)}` });
    }
    const first = await attempt(dir, mutant, suiteRuns);
    if (first.outcome === 'passed') return verdict({ status: 'survived', failingTests: [], detail: 'declared suites and both eval eras passed' });
    // Never trust a single failure: a load-sensitive flake in an unrelated test would
    // otherwise masquerade as a kill. The mutant is killed only when the failure
    // reproduces in the same suite/era (same named test, or both runs past its cap).
    // The re-run is focused on the recorded failing tests when they are few and named;
    // timeouts, file-level failures and mass failures get a full-suite re-run.
    const focused = !first.timedOut && first.signature.length > 0 && first.signature.length <= 20
      && first.signature.every(name => !name.startsWith('evals:') && !name.endsWith('.test.ts'));
    let second;
    if (focused) {
      second = await focusedAttempt(dir, first, suiteRuns);
    } else {
      second = await attempt(dir, mutant, suiteRuns);
    }
    const { killed, reproduced, reproducedTimeout, kill_kind } = reproducedKill(first, second);
    if (killed) {
      const what = reproduced.length > 0 ? reproduced.join('; ') : 'suite timed out in both runs';
      return verdict({ status: 'killed', reproducedTimeout, kill_kind, failingTests: reproduced, detail: `reproduced failure: ${what}` });
    }
    const firstWhat = first.timedOut && first.signature.length === 0 ? 'suite timed out' : first.signature.join('; ') || 'suite failed (no test names parsed)';
    const secondWhat = second.unmatched ? 're-run matched no tests (recorded names did not select any test)' : second.outcome === 'passed' ? 'passed' : (second.timedOut && second.signature.length === 0 ? 'suite timed out' : second.signature.join('; ') || 'suite failed (no test names parsed)');
    return verdict({ status: 'inconclusive', failingTests: [...first.signature], detail: `flaky: first run failed [${firstWhat}], re-run [${secondWhat}] — no failure reproduced` });
  } finally {
    for (const file of changed.keys()) await writeFile(join(dir, file), pristine.get(file));
    if (preparation) await writeFile(join(dir, preparation.file), pristine.get(preparation.file));
  }
}

function argValue(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function validateArgs() {
  const valued = new Set(['--workers', '--test-concurrency', '--only', '--shard', '--report', '--out', '--aggregate', '--shards']);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key) || (key !== '--list' && !valued.has(key))) throw new Error(`unknown or repeated option ${key}`);
    seen.add(key);
    if (valued.has(key)) { argValue(key); i++; }
  }
  for (const key of ['--workers', '--test-concurrency', '--shards']) {
    const value = argValue(key);
    if (value !== undefined && !validShardCount(Number(value))) throw new Error(`invalid ${key} value`);
  }
  if (seen.has('--list') && args.length !== 1) throw new Error('--list cannot be combined with other options');
  if (seen.has('--shards') && !seen.has('--aggregate')) throw new Error('--shards requires --aggregate');
  if (seen.has('--report') && seen.has('--out')) throw new Error('--report and --out are alternatives');
  if (seen.has('--aggregate') && ['--out', '--report'].some(key => seen.has(key))) throw new Error('--aggregate cannot write shard reports');
}

async function main() {
  const started = Date.now();
  validateArgs();
  const seenIds = new Set();
  for (const mutant of MUTANTS) {
    if (seenIds.has(mutant.id)) { console.error(`mutation-guards: duplicate mutant id ${mutant.id}`); process.exit(2); }
    seenIds.add(mutant.id);
  }
  if (args.includes('--list')) {
    console.log(JSON.stringify({ count: MUTANTS.length, mutantListHash: mutantListHash(MUTANTS), ids: MUTANTS.map(mutant => mutant.id), binding: await candidateBinding() }, null, 2));
    return;
  }
  const aggregateDir = argValue('--aggregate');
  const shardSpec = argValue('--shard');
  if (aggregateDir !== undefined && (shardSpec !== undefined || ONLY)) {
    console.error('mutation-guards: --aggregate cannot be combined with --shard or --only');
    process.exit(2);
  }
  if (shardSpec !== undefined && ONLY) {
    console.error('mutation-guards: --shard cannot be combined with --only (a diagnostic subset cannot earn aggregate acceptance)');
    process.exit(2);
  }
  const survivorsPath = join(root, 'scripts', 'mutation-survivors.json');
  const survivorEntries = JSON.parse(await readFile(survivorsPath, 'utf8'));
  const declared = new Map(survivorEntries.map(entry => [entry.id, entry]));
  if (declared.size !== survivorEntries.length) throw new Error('duplicate survivor declaration');
  const binding = await candidateBinding();

  if (aggregateDir !== undefined) {
    if (!aggregateDir || aggregateDir.startsWith('--')) { console.error('mutation-guards: --aggregate requires a directory'); process.exit(2); }
    validateReportPath(join(resolve(aggregateDir), 'report.json'));
    const shardsArg = argValue('--shards');
    const expectedShardCount = shardsArg === undefined ? undefined : Number(shardsArg);
    if (expectedShardCount !== undefined && (!Number.isInteger(expectedShardCount) || expectedShardCount < 1)) {
      console.error(`mutation-guards: invalid --shards value ${JSON.stringify(shardsArg)}`);
      process.exit(2);
    }
    const { reports, errors: readErrors } = await readShardReports(resolve(aggregateDir));
    const aggregated = aggregateShardReports(reports, { mutants: MUTANTS, declared, expectedShardCount, binding });
    for (const error of [...readErrors, ...aggregated.errors]) console.error(error);
    const { killed, survived, inconclusive, anchorErrors } = aggregated.summary;
    console.log(timeoutKillSummary(aggregated.timeoutKills));
    console.log(`mutation-guards aggregate: ${killed} killed, ${survived} survived, ${inconclusive} inconclusive, ${anchorErrors} anchor-errors (declared survivors: ${declared.size}, mutants: ${aggregated.summary.total}/${MUTANTS.length}, shard reports: ${reports.length}), ${((Date.now() - started) / 1000).toFixed(0)}s`);
    if (readErrors.length || !aggregated.ok) process.exit(1);
    console.log('mutation-guards aggregate: OK (every mutant ran exactly once; no undeclared survivors)');
    return;
  }

  let shard;
  if (shardSpec !== undefined) {
    try {
      shard = parseShardSpec(shardSpec);
    } catch (error) {
      console.error(`mutation-guards: ${error instanceof Error ? error.message : 'invalid --shard spec'}`);
      process.exit(2);
    }
  }
  const reportArg = argValue('--report');
  const outArg = argValue('--out');
  const reportSpec = shard ?? { shardIndex: 1, shardCount: 1 };
  const reportPath = reportArg !== undefined
    ? validateReportPath(reportArg)
    : (shard || outArg !== undefined)
      ? validateReportPath(join(outArg !== undefined ? resolve(outArg) : join(root, 'mutation-results'), shardReportFileName(reportSpec.shardIndex, reportSpec.shardCount)))
      : undefined;
  let suiteBaselines = {};
  const writeReport = async (baseline, judged) => {
    if (!reportPath) return;
    const report = buildShardReport({
      shardIndex: reportSpec.shardIndex,
      shardCount: reportSpec.shardCount,
      mutants: MUTANTS,
      binding,
      mode: ONLY ? 'diagnostic' : shard ? 'shard' : 'full',
      scheduledIds: mutants.map(mutant => mutant.id),
      baseline,
      suiteBaselines,
      results: judged,
      durationMs: Date.now() - started,
    });
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`mutation-guards: shard report written to ${reportPath}`);
  };

  const mutants = ONLY
    ? MUTANTS.filter(mutant => ONLY.has(mutant.id))
    : shard ? mutantsForShard(MUTANTS, shard.shardIndex, shard.shardCount) : MUTANTS;
  if (!mutants.length && !shard) { console.error('mutation-guards: no mutants selected'); process.exit(2); }
  if (ONLY && [...ONLY].some(id => !seenIds.has(id))) throw new Error('--only contains an unknown mutant id');
  if (shard && shard.shardCount > MUTANTS.length) throw new Error('empty shards are not allowed');
  if (shard) console.log(`mutation-guards: shard ${shard.shardIndex}/${shard.shardCount} selects ${mutants.length} of ${MUTANTS.length} mutants`);
  const pristine = new Map();
  for (const file of new Set(mutants.flatMap(mutant => mutationEdits(mutant).map(edit => edit.file)))) pristine.set(file, await readFile(join(root, file), 'utf8'));

  if (mutants.some(mutant => mutant.prepare === 'contract')) pristine.set('docs/contracts/m3b-tools.json', await readFile(join(root, 'docs/contracts/m3b-tools.json'), 'utf8'));

  const copies = [];
  const results = new Map();
  try {
    for (let i = 0; i < Math.max(1, Math.min(WORKERS, mutants.length)); i++) copies.push(await makeCopy());
    // Baselines are serial, include anchor maintenance, and cover every path attempt() can use.
    try {
      suiteBaselines = await measureSuiteBaselines([...new Set(mutants.flatMap(mutationSuites)), 'evals:modern', 'evals:legacy'],
        (suite, cap) => suite.startsWith('evals:') ? runEval(copies[0], suite, cap) : runSuite(copies[0], cap, undefined, suite, true));
    } catch (error) {
      await writeReport('red', []);
      throw error;
    }
    for (const [suite, timing] of Object.entries(suiteBaselines)) testTimeoutMs[suite] = timing.capMs;
    console.log(`mutation-guards: judging ${mutants.length} mutants on ${copies.length} worker copies (test-concurrency ${TEST_CONCURRENCY}/suite on ${CPUS} CPUs)`);
    let nextIndex = 0;
    await Promise.all(copies.map(async dir => {
      for (;;) {
        const index = nextIndex++;
        if (index >= mutants.length) return;
        const result = await judge(dir, mutants[index], pristine);
        results.set(result.id, result);
        console.log(`  ${result.status.padEnd(12)} ${result.id} (${result.detail})`);
      }
    }));
  } finally {
    await Promise.all(copies.map(dir => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
  }

  // Write the shard report before any per-shard failure exit, so the
  // aggregate always sees this shard's verdicts and stays the authority.
  const after = await candidateBinding();
  if (BINDING_KEYS.some(key => after[key] !== binding[key])) throw new Error('candidate inputs changed while the gate was running');
  await writeReport('green', mutants.map(mutant => results.get(mutant.id)).filter(Boolean));

  let failed = false;
  for (const mutant of mutants) {
    const result = results.get(mutant.id);
    if (!result || result.status === 'anchor-error') { console.error(`FAIL ${mutant.id}: ${result?.detail ?? 'not judged'}`); failed = true; continue; }
    if (result.status === 'inconclusive') { console.error(`FAIL ${mutant.id}: INCONCLUSIVE (${result.detail}). Fix the flaky test(s) named above, then re-run the gate; do not treat this as killed or survived.`); failed = true; }
    if (result.status === 'survived' && !declared.has(mutant.id)) { console.error(`FAIL ${mutant.id}: SURVIVED without a declared justification`); failed = true; }
    if (result.status === 'killed' && declared.has(mutant.id) && !ONLY) { console.error(`FAIL ${mutant.id}: declared survivor was killed; remove the stale entry`); failed = true; }
  }
  for (const id of declared.keys()) {
    if (!MUTANTS.some(mutant => mutant.id === id)) { console.error(`FAIL survivor entry ${id}: no such mutant`); failed = true; }
    const entry = declared.get(id);
    if (!entry.justification || String(entry.justification).trim().length < 20) { console.error(`FAIL survivor entry ${id}: justification missing or too short`); failed = true; }
  }
  const killed = [...results.values()].filter(result => result.status === 'killed').length;
  const survived = [...results.values()].filter(result => result.status === 'survived').length;
  const inconclusive = [...results.values()].filter(result => result.status === 'inconclusive').length;
  console.log(`mutation-guards: ${killed} killed, ${survived} survived, ${inconclusive} inconclusive (declared survivors: ${declared.size}), ${((Date.now() - started) / 1000).toFixed(0)}s`);
  if (failed) process.exit(1);
  console.log('mutation-guards: OK (no undeclared survivors)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(`mutation-guards: ${error instanceof Error ? error.message : 'failed'}`); process.exit(2); });
}
