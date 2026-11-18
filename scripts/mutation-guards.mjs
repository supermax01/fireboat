#!/usr/bin/env node
import { isMainModule } from './is-main.mjs';
/**
 * Scoped mutation gate.
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
 * Targeted first pass: after the typecheck and build pass, the judge first runs
 * candidate test files (and, for eval-harness edits, the eval eras) chosen by
 * scripts/mutation-targeting.mjs: the mutant's "Killing test(s):" comment
 * matched against a test-title index built from the clean unit baseline,
 * hints from earlier shard reports (--hints <dir>), files that killed other
 * mutants of the same source file, test files ranked by the identifiers the
 * mutation removes, and finally the rest of the unit suite in small batches,
 * most likely first, stopping at the first batch that kills. A failure is
 * rerun in the candidate files that declare the failing tests (all candidates
 * when the index does not know one). The pass can only KILL, and only on the
 * same evidence as above: a named behavioural failure that reproduces when
 * the same candidates run a second time in the same suite or era. It never
 * credits a timeout, a file-level failure or a pin-only failure, and it never
 * yields a survivor or an inconclusive result. Every mutant it does not kill
 * is judged by the full path described above, exactly as before. Each result
 * records decided_by: targeted, full (the full path) or precheck (anchor,
 * preparation or compilation). --no-targeted judges every mutant on the full
 * path.
 *
 * Concurrency is bounded as a whole: every child run holds CPU slots (one per
 * test file it may run at once, one for any other command), and the slots of
 * all worker copies together never exceed the available parallelism, so
 * parallel suite copies cannot oversubscribe the machine (the original source
 * of load-sensitive flakes). A run's deadline starts when it is spawned, not
 * while it waits for slots. The default is one worker per two CPUs and three
 * test files at a time per suite run; a targeted run uses no more files at
 * once than it has candidates.
 *
 * Runs fully offline. Usage:
 *   node scripts/mutation-guards.mjs [--workers N] [--test-concurrency N] [--only id1,id2] [--hints <dir>] [--no-targeted]
 *   node scripts/mutation-guards.mjs --shard i/n [--out <dir> | --report <file>] [--workers N] [--hints <dir>] [--no-targeted]
 *   node scripts/mutation-guards.mjs --aggregate <dir> [--shards n]
 *   node scripts/mutation-guards.mjs --list
 *
 * Sharding: --shard i/n judges a deterministic partition of the full
 * mutant list and writes one JSON shard report. The frozen list's ordinal
 * assigns mutant i to shard (i % n) + 1.
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
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildTestIndex, createTargeting, parseIndexLines, readHintReports, registryComments, tapUnescape } from './mutation-targeting.mjs';

const execFileAsync = promisify(execFile);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const CPUS = Math.max(1, availableParallelism());
const workersArg = args.indexOf('--workers');
const WORKERS = workersArg >= 0 ? Math.max(1, Number(args[workersArg + 1]) || 1) : Math.max(1, Math.floor(CPUS / 2));
const testConcurrencyArg = args.indexOf('--test-concurrency');
// Node's test runner otherwise parallelises test files up to the full CPU count inside every
// worker copy, multiplying the load. Across all workers, the CPU slots below bound the total.
const TEST_CONCURRENCY = testConcurrencyArg >= 0 ? Math.max(1, Number(args[testConcurrencyArg + 1]) || 1) : Math.max(1, Math.min(3, CPUS));
const TARGETED = !args.includes('--no-targeted');
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
  // Core guards. Mutants that replaced earlier ones keep their original positions in the list.
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
    "const publishTotal = verifySelf && !selfAbsent && !partialReasons.has('INVALID_RESOURCE_ID') && !precisionRefused && !sourceIncomplete && nextLinks.length === 0;",
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
    "raw = await this.transport.get(this.transport.url(`${type}/${encodeURIComponent(id)}`), stats, { ...budget, permission: { type, interaction: 'read' } }) as FhirResource;",
    "raw = await this.transport.get(this.transport.url(`${type}/${encodeURIComponent(id)}`), stats, { permission: { type, interaction: 'read' } }) as FhirResource;"),
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
    "export function validateDeliverable02(tool: ToolName, wire: unknown, context?: ValidationContext02): ValidationResult02 {\n  const fail = (reason: Exclude<ValidationResult02, { ok: true }>['reason']): ValidationResult02 => ({ ok: false, reason });\n  try {\n    if (!validateSpine(wire) || !validateListedOutput(wire)) return fail('INVALID_SHAPE');\n    const semantic = validateCrossField02(tool, wire, context);\n    if (!semantic.ok) return semantic;\n    if (!context || !context.result || !context.serverIdentity || typeof context.renderedText !== 'string' || !['modern', 'legacy'].includes(context.era) || !['full-text-v1', 'structured-evidence-v1'].includes(context.deliveryProfile)) return fail('VALIDATION_CONTEXT_REQUIRED');\n    if (typeof context.serverIdentity.name !== 'string' || !context.serverIdentity.name || typeof context.serverIdentity.version !== 'string' || !context.serverIdentity.version || !Array.isArray(context.result.content) || !Object.hasOwn(context.result, 'structuredContent')) return fail('VALIDATION_CONTEXT_REQUIRED');\n    const env = wire as z.infer<typeof toolEnvelopeV2Schemas.fhir_result>;\n    if (!env.error && ((tool === 'fhir_capabilities' && context.topic === undefined) || (tool === 'fhir_result' && context.action === undefined))) return fail('VALIDATION_CONTEXT_REQUIRED');\n    if (!context.binding || ['sourceAlias', 'fhirVersion', 'sourceRevision', 'policyRevision', 'contextHandle'].some(key => typeof context.binding![key as keyof NonNullable<ValidationContext02['binding']>] !== 'string' || !context.binding![key as keyof NonNullable<ValidationContext02['binding']>]) || !Number.isSafeInteger(context.effectiveByteLimit) || context.effectiveByteLimit! < 4096 || context.effectiveByteLimit! > 131072 || typeof context.formatSupplied !== 'boolean' || (context.formatSupplied && !['compact', 'fhir'].includes(context.requestedFormat!))) return fail('VALIDATION_CONTEXT_REQUIRED');\n    if (!env.error && ((tool === 'fhir_read' && !context.readTarget) || (tool === 'fhir_result' && (context.offset === undefined || context.limit === undefined)) || (tool === 'fhir_capabilities' && ((['resource', 'schema', 'search_parameter'].includes(context.topic!) && !context.resourceType) || (context.topic === 'schema' && context.path === undefined) || (['context', 'server'].includes(context.topic!) && !context.patientId))))) return fail('VALIDATION_CONTEXT_REQUIRED');\n    const result = context.result;\n    // Freeze is recursive: a shallow-frozen object still admits stale-text or\n    // accounting races through its children. rawJSON is already frozen by V8.\n    if (!frozenValidationState02(context)) return fail('VALIDATION_CONTEXT_MISMATCH');\n    if (env.transform.delivery_profile !== context.deliveryProfile || result.content.length !== 1 || result.content[0]?.type !== 'text' || result.content[0].text !== context.renderedText || result.isError !== (env.error ? true : undefined)) return fail('VALIDATION_CONTEXT_MISMATCH');\n    // Diagnose candidate accounting before generic snapshot equality. Count once (schema 0.4): the cap bounds\n    // the model copy, measured here independently of the producer's helper; the complete result is bounded by\n    // the wire invariant and must equal the claimed wire_bytes.\n    const textBytes = Buffer.byteLength(result.content.map(block => block.text).join('\\n'), 'utf8');\n    const measured = Math.max(textBytes, Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8'));\n    if (measured !== env.budget.bytes_returned || measured > env.budget.byte_limit || measured > context.effectiveByteLimit! || env.budget.byte_limit > context.effectiveByteLimit!) return fail('INVALID_FINAL_BYTES');\n    const wireMeasured = Buffer.byteLength(JSON.stringify(result), 'utf8');\n    if (wireMeasured !== env.budget.wire_bytes || wireMeasured > wireByteCeiling(env.budget.byte_limit)) return fail('INVALID_FINAL_BYTES');\n    const serialized = JSON.stringify(wire);\n    if (JSON.stringify(result.structuredContent) !== serialized) return fail('VALIDATION_CONTEXT_MISMATCH');\n    const jsonLine = serialized.replace(/[\\u2028\\u2029\\u0085]/g, char => `\\\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);\n    if (context.deliveryProfile === 'full-text-v1' && context.renderedText !== serialized && context.renderedText !== `delivery_profile: \"full-text-v1\"\\n${jsonLine}`) return fail('VALIDATION_CONTEXT_MISMATCH');\n    if (context.deliveryProfile === 'structured-evidence-v1' && !context.renderedText.startsWith('delivery_profile: \"structured-evidence-v1\"\\n')) return fail('VALIDATION_CONTEXT_MISMATCH');\n    const allowed = ['content', 'structuredContent', ...(env.error ? ['isError'] : []), ...(context.era === 'modern' ? ['resultType', '_meta'] : [])];\n    if (Object.keys(result).some(key => !allowed.includes(key))) return fail('VALIDATION_CONTEXT_MISMATCH');\n    if (context.era === 'modern' && (result.resultType !== 'complete' || JSON.stringify(result._meta) !== JSON.stringify({ 'io.modelcontextprotocol/serverInfo': context.serverIdentity }))) return fail('VALIDATION_CONTEXT_MISMATCH');\n    return { ok: true };\n  } catch { return fail('INVALID_SHAPE'); }\n}\n",
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
    "resourceClass(targetType) === 'shared' && ",
    ""),
  M('g3-pinned-target-condition-removed', "packages/core/src/search-parameters.ts",
    " && entry.targetsFull.includes(targetType)",
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
    "export function sanitize(resource: FhirResource, privacy: GatewayConfig['privacy'] = {}, options: SanitizeOptions = {}): Sanitized {\n  const patientIdentifierSystems = new Set(privacy.patientIdentifierSystems ?? []);\n  const structuralStringAllowed = (field: string, node: Record<string, unknown>) => SHARED_STRUCTURAL_STRING_EXCEPTIONS.some(rule => rule.fields.test(field) && rule.allows(node, patientIdentifierSystems));\n  const manifests: Record<string, unknown>[] = [];\n  const manifestOrigins: ManifestOrigin[] = [];\n  const omitted: string[] = [];\n  let requiresStructuralView = false;\n  let narrativeOmitted = false;\n  const withheld = Symbol('withheld');\n  const withhold = (path: string, reason: string, inModifier: boolean, metadata: Record<string, unknown> = {}, origin: ManifestOrigin = 'policy') => {\n    manifests.push({ path, reason, ...metadata });\n    manifestOrigins.push(origin);\n    omitted.push(path);\n    // A policy-withheld modifier prohibits a confident clinical interpretation.\n    if (inModifier) requiresStructuralView = true;\n    return withheld;\n  };\n  interface Scope { type: string; root: string; shared: boolean; identifier?: boolean }\n  // `attachment` drives withholding (schema, shape or path spelling: conservative). `inAttachment` is the\n  // schema-declared Attachment context, own or inherited, and drives only the manifest origin classification.\n  const walk = (value: unknown, path: string, key: string, parent: Record<string, unknown>, element: ResolvedElement, attachment: boolean, inAttachment: boolean, inModifier: boolean, inherited: Scope): unknown => {\n    const metadata = () => attachment ? attachmentMetadata(parent) : {};\n    const linkOrigin: ManifestOrigin = inAttachment ? 'attachment' : attachment || !element.types.length ? 'unknown' : 'policy';\n    // An unverifiable clinical-actor reference chosen by the judge is withheld whole, with every child and companion.\n    if (options.withholdReferences?.has(path) && value && typeof value === 'object' && !Array.isArray(value)) return withhold(path, 'UNVERIFIED_REFERENCE_WITHHELD', inModifier, {}, element.types.length ? 'policy' : 'unknown');\n    // Payload keys and the attachment link are withheld by key and schema context before the value's JSON\n    // shape is consulted; an object, array, number, boolean or null carries bytes or a capability as a string does.\n    if (payloadPosition(key, element, value)) return withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, metadata(), 'payload');\n    // Attachment context comes from the schema (Patient.photo, presentedForm, ...) even without contentType.\n    if (key === 'url' && attachment) return withhold(path, 'PROTECTED_LINK', inModifier, metadata(), linkOrigin);\n    // A scalar where the schema declares a Reference, a Resource or another reference-carrying structure is\n    // malformed linkage: withheld, never screened as prose or passed through as a leaf.\n    if (malformedLinkage(element, value)) return withhold(path, 'MALFORMED_LINKAGE_WITHHELD', inModifier);\n    // Any other scalar where the schema declares only complex types is malformed structure; one standing for an\n    // Attachment is withheld as a payload.\n    if (malformedComplex(element, value)) return element.types.includes('Attachment') ? withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, {}, 'payload') : withhold(path, 'MALFORMED_STRUCTURE_WITHHELD', inModifier);\n    if (typeof value === 'string') {\n      const prose = element.types.length === 1 && ['string', 'markdown'].includes(element.types[0]!) && !uriKey(key);\n      if (prose) {\n        const redacted = redactTextLinks(value);\n        if (!redacted.spans) return value;\n        manifests.push({ path, reason: 'PROTECTED_LINK_IN_TEXT', spans: redacted.spans });\n        manifestOrigins.push('link_text');\n        omitted.push(path);\n        if (inModifier) requiresStructuralView = true;\n        return redacted.text;\n      }\n      // Hardening: a link span inside a non-prose, non-URI value (a code, an undeclared vendor string)\n      // withholds the whole value; such values are never rewritten in place.\n      const opaque = !isUriElement(element) && !uriKey(key) && redactTextLinks(value).spans > 0;\n      return opaque || protectedLink(value, key, isUriElement(element)) ? withhold(path, 'PROTECTED_LINK', inModifier, metadata(), linkOrigin) : value;\n    }\n    // Lossless decimal scalars pass through sanitize unchanged.\n    if (isFhirDecimal(value) || isPrecisionFault(value)) return value;\n    // Keep primitive-array positions aligned with their FHIR _element metadata.\n    if (Array.isArray(value)) {\n      const primitive = element.types.some(type => /^[a-z]/.test(type));\n      return value.flatMap((item, i) => {\n        const result = walk(item, `${path}/${i}`, key, parent, element, attachment, inAttachment, inModifier, inherited);\n        return result === withheld ? (primitive ? [null] : []) : [result];\n      });\n    }\n    if (!value || typeof value !== 'object') return value;\n    const node = value as Record<string, unknown>;\n    // Only a schema-declared contained Resource can inherit its parent's scope.\n    if (malformedResource(element, node)) return withhold(path, 'MALFORMED_LINKAGE_WITHHELD', inModifier);\n    // A resourceType smuggled onto a shared scalar/datatype is unclassified.\n    if (inherited.shared && typeof node.resourceType === 'string' && !(key === 'contained' && element.types.includes('Resource'))) return withhold(path, 'UNDECLARED_PROPERTY_WITHHELD', inModifier, {}, 'unknown');\n    let scope: Scope = typeof node.resourceType === 'string' ? { type: node.resourceType, root: path, shared: path === '' ? resourceClass(node.resourceType) === 'shared' : inherited.shared } : inherited;\n    if (node.modifierExtension || node.implicitRules) requiresStructuralView = true;\n    const context: TypeContext | undefined = typeof node.resourceType === 'string' ? resourceTypeContext(node.resourceType) : element.context;\n    if (context?.definition === 'Identifier' && context.path === '') scope = { ...scope, identifier: true };\n    const isReference = context?.definition === 'Reference' && context.path === '';\n    // Resource.type (for example StructureDefinition.type) is not Reference.type.\n    const referenceLike = typeof node.resourceType !== 'string' && (isReference || node.reference !== undefined || (node.type !== undefined && (node.identifier !== undefined || node.display !== undefined || node._display !== undefined)));\n    // A reference whose reference or type member cannot be read is malformed linkage as a whole.\n    if (referenceLike && unreadableLinkage(node, context, isReference)) return withhold(path, 'MALFORMED_LINKAGE_WITHHELD', inModifier);\n    if (scope.shared && context?.definition === 'Identifier' && context.path === '' && typeof node.system === 'string' && patientIdentifierSystems.has(node.system)) return withhold(path, 'PATIENT_IDENTIFIER_SYSTEM_WITHHELD', inModifier);\n    if (scope.shared && context?.definition === 'Identifier' && context.path === '' && !structuralStringAllowed('Identifier.value', node)) return withhold(path, 'UNCLASSIFIED_IDENTIFIER_WITHHELD', inModifier);\n    if (scope.shared && referenceLike) {\n      const reason = sharedReferenceReason(node, element);\n      if (reason) return withhold(path, reason, inModifier, {}, element.types.length ? 'policy' : 'unknown');\n    }\n    const patientReference = referenceLike && ((isReference && element.targets?.length === 1 && element.targets[0] === 'http://hl7.org/fhir/StructureDefinition/Patient') || declaredType(node.type) === 'Patient' || declaredType(node.type) === 'patient-like'\n      || (typeof node.reference === 'string' && parseReference(node.reference, SANITIZE_REFERENCE_BASE).patientLike));\n    const isAttachment = (context?.definition === 'Attachment' && context.path === '') || node.contentType !== undefined || (node.data !== undefined && payloadPosition('data', resolveElement(context, 'data'), node.data)) || path.toLowerCase().includes('attachment');\n    const schemaAttachment = inAttachment || (context?.definition === 'Attachment' && context.path === '');\n    // The display/identifier companions of a reference whose target is unverifiable — a\n    // conditional form (never resolved), an unsupported/encoded form, or a reference string the\n    // egress screen itself withholds — are withheld with it. Authorization already rejects the\n    // owning resource on gateway paths; this keeps sanitize safe as a standalone layer.\n    const unverifiableReference = typeof node.reference === 'string'\n      && (() => { const parsed = parseReference(node.reference, SANITIZE_REFERENCE_BASE); return parsed.form === 'conditional' || parsed.form === 'unsupported' || protectedLink(node.reference, 'reference'); })();\n    const omissionsBefore = omitted.length;\n    const result: Record<string, unknown> = {};\n    for (const [childKey, child] of Object.entries(node)) {\n      // Raw upstream property names are never echoed into resources, manifest paths or omitted fields.\n      if (!/^_?[A-Za-z][A-Za-z0-9]{0,63}$/.test(childKey)) { withhold(`${path}/[undeclared-property]`, 'UNDECLARED_PROPERTY_WITHHELD', inModifier); continue; }\n      const pointer = `${path}/${childKey}`;\n      const childElement = resolveElement(context, childKey);\n      const childOrigin: ManifestOrigin = childElement.types.length ? 'policy' : 'unknown';\n      if (['__proto__', 'constructor', 'prototype'].includes(childKey)) { omitted.push(pointer); continue; }\n      // Only resource-level narrative sets narrativeOmitted; Bundle link/total omission is separate.\n      if (childKey === 'text' && typeof node.resourceType === 'string') { narrativeOmitted = true; omitted.push(pointer); continue; }\n      if (node.resourceType === 'Bundle' && ['link', 'total'].includes(childKey)) { omitted.push(pointer); continue; }\n      // Patient.link is a modifier whose target is always another person's record.\n      if (context?.definition === 'Patient' && context.path === 'link' && childKey === 'other') { withhold(pointer, 'FOREIGN_PATIENT_REFERENCE_WITHHELD', true, {}, childOrigin); continue; }\n      if (patientReference && ['display', '_display', 'identifier', 'extension', '_reference', '_type'].includes(childKey)) { withhold(pointer, 'PATIENT_REFERENCE_COMPANION_WITHHELD', inModifier, {}, childOrigin); continue; }\n      if (unverifiableReference && (childKey === 'display' || childKey === '_display' || childKey === 'identifier')) { withhold(pointer, 'UNVERIFIED_REFERENCE_COMPANION_WITHHELD', inModifier, {}, childOrigin); continue; }\n      const field = `${scope.type}.${pointer.slice(scope.root.length + 1).replaceAll('/', '.').replace(/\\._?\\d+(?=\\.|$)/g, '').replace(/(^|\\.)_/g, '$1')}`;\n      if (scope.shared && D1_MASKS.has(field)) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }\n      const recordMask = PATIENT_RECORD_MASKS.get(field);\n      if (recordMask) { withhold(pointer, recordMask, inModifier); continue; }\n      if (childKey === 'extension' && !scope.shared && UNREVIEWED_EXTENSION_TYPES.has(scope.type)) { withhold(pointer, 'UNREVIEWED_EXTENSION_WITHHELD', inModifier); continue; }\n      const catalog = ['CodeSystem', 'ValueSet', 'CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition'].includes(scope.type);\n      const scalar = resolveElement(context, childKey.startsWith('_') ? childKey.slice(1) : childKey);\n      const residualDisplay = CATALOG_DISPLAY.test(`${scope.type}:${field.slice(scope.type.length + 1)}`);\n      const structuralString = structuralStringAllowed(typeof node.resourceType === 'string' && childKey.replace(/^_/, '') === 'id' ? 'Resource.id' : isReference ? `Reference.${childKey.replace(/^_/, '')}` : context?.definition === 'Coding' && context.path === '' ? `Coding.${childKey.replace(/^_/, '')}` : context?.definition === 'Identifier' && context.path === '' ? `Identifier.${childKey.replace(/^_/, '')}` : field, node);\n      if (catalog && (['contact', 'publisher'].includes(childKey.replace(/^_/, ''))\n          || (scalar.types.some(type => type === 'string' || type === 'markdown') && !structuralString && !residualDisplay))) { withhold(pointer, 'SOURCE_PROSE_WITHHELD', inModifier); continue; }\n      if (scope.shared && childKey !== 'resourceType' && !childElement.types.length) { withhold(`${path}/[undeclared-property]`, 'UNDECLARED_PROPERTY_WITHHELD', inModifier, {}, 'unknown'); continue; }\n      const residual = !scope.identifier && D1_RESIDUAL.test(`${scope.type}:${field.slice(scope.type.length + 1)}`);\n      if (scope.shared && scalar.types.some(type => type === 'string' || type === 'markdown') && !structuralString && !residual && !residualDisplay) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }\n      if (scope.shared && isReference && ['display', '_display', 'identifier'].includes(childKey)) {\n        if (childKey !== 'identifier' || walk(child, pointer, childKey, node, childElement, isAttachment, schemaAttachment, inModifier, scope) !== withheld) withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier);\n        continue;\n      }\n      const transformed = walk(child, pointer, childKey, node, childElement, isAttachment, schemaAttachment, inModifier || Boolean(childElement.modifier), scope);\n      if (transformed !== withheld) result[childKey] = transformed;\n    }\n    // Drop newly emptied complex entries; leaf omissions already carry their labels.\n    if (path && Object.keys(result).length === 0 && omitted.length > omissionsBefore) return withheld;\n    return result;\n  };\n  const sanitized = walk(resource, '', '', {}, { types: [] }, false, false, false, { type: resource.resourceType, root: '', shared: false }) as FhirResource;\n  return { resource: sanitized, manifests, manifestOrigins, omitted, retrievedAt: new Date().toISOString(), requiresStructuralView, narrativeOmitted };\n}\n\n// ---------------------------------------------------------------------------\n// Projection.\n// ---------------------------------------------------------------------------\n\nexport interface ProjectionWarning { code: string; message: string }\nexport interface Projection { resource: FhirResource; omitted: string[]; unresolved: string[]; warnings?: ProjectionWarning[]; recipe?: string }\n\n/**\n * Reviewed compact recipes, versioned against R4 4.0.1. Field names are\n * declared element names; choice elements (`[x]`) are kept whole through\n * resolveElement. Every root isModifier element, `id`, `meta` (versionId,\n * profile, security) and primitive companions are always added, `contained`\n * is kept when a kept element references it (`#id`), and each kept\n * element keeps its codings and code systems. Types without a recipe fall back\n * to the sanitized full view with COMPACT_RECIPE_UNAVAILABLE.\n */\nexport const COMPACT_RECIPE_SET = 'r4-compact-2026-10-18.1';\nexport const COMPACT_RECIPES: Readonly<Record<string, { id: string; fields: readonly string[] }>> = {\n  Patient: { id: 'Patient.compact.1', fields: ['active', 'name', 'gender', 'birthDate', 'deceased[x]'] },\n  Observation: { id: 'Observation.compact.1', fields: ['status', 'category', 'code', 'subject', 'focus', 'effective[x]', 'issued', 'value[x]', 'dataAbsentReason', 'interpretation', 'bodySite', 'method', 'referenceRange', 'hasMember', 'component'] },\n  Condition: { id: 'Condition.compact.1', fields: ['clinicalStatus', 'verificationStatus', 'category', 'severity', 'code', 'bodySite', 'subject', 'onset[x]', 'abatement[x]', 'recordedDate'] },\n  AllergyIntolerance: { id: 'AllergyIntolerance.compact.1', fields: ['clinicalStatus', 'verificationStatus', 'type', 'category', 'criticality', 'code', 'patient', 'onset[x]', 'recordedDate', 'lastOccurrence', 'reaction'] },\n  MedicationRequest: { id: 'MedicationRequest.compact.1', fields: ['status', 'statusReason', 'intent', 'category', 'priority', 'doNotPerform', 'reported[x]', 'medication[x]', 'subject', 'authoredOn', 'requester', 'reasonCode', 'courseOfTherapyType', 'dosageInstruction', 'dispenseRequest'] },\n  Immunization: { id: 'Immunization.compact.1', fields: ['status', 'statusReason', 'vaccineCode', 'patient', 'occurrence[x]', 'primarySource', 'lotNumber', 'site', 'route', 'doseQuantity', 'isSubpotent', 'subpotentReason', 'reasonCode', 'protocolApplied'] },\n  DiagnosticReport: { id: 'DiagnosticReport.compact.1', fields: ['status', 'category', 'code', 'subject', 'effective[x]', 'issued', 'result', 'conclusion', 'conclusionCode', 'presentedForm'] },\n  DocumentReference: { id: 'DocumentReference.compact.1', fields: ['status', 'docStatus', 'type', 'category', 'subject', 'date', 'author', 'description', 'securityLabel', 'relatesTo', 'content', 'context'] },\n};\nconst RECIPE_UNAVAILABLE: ProjectionWarning = { code: 'COMPACT_RECIPE_UNAVAILABLE', message: 'No reviewed compact recipe exists for this resource type; the full sanitized view is returned instead.' };\nconst MODIFIERS_ADDED: ProjectionWarning = { code: 'MODIFIER_FIELDS_ADDED', message: 'Modifier elements needed to interpret the selected fields were added to the projection.' };\n\nfunction containsModifierExtension(value: unknown, depth = 0): boolean {\n  if (!value || typeof value !== 'object' || depth > 64) return false;\n  if (Array.isArray(value)) return value.some(item => containsModifierExtension(item, depth + 1));\n  return Object.entries(value).some(([key, child]) => key === 'modifierExtension' || containsModifierExtension(child, depth + 1));\n}\n\nexport function project(resource: FhirResource, format: 'compact' | 'fhir', fields?: string[]): FhirResource {\n  return projection(resource, format, fields).resource;\n}\n\nexport function projection(resource: FhirResource, format: 'compact' | 'fhir', fields?: string[]): Projection {",
    "const projectionOnlyPolicies = new WeakMap<FhirResource, GatewayConfig['privacy']>();\nexport function sanitize(resource: FhirResource, privacy: GatewayConfig['privacy'] = {}, options: SanitizeOptions = {}): Sanitized {\n  projectionOnlyPolicies.set(resource, privacy);\n  return { ...sanitizeForProjection(resource, privacy, options), resource };\n}\nfunction sanitizeForProjection(resource: FhirResource, privacy: GatewayConfig['privacy'] = {}, options: SanitizeOptions = {}): Sanitized {\n  const patientIdentifierSystems = new Set(privacy.patientIdentifierSystems ?? []);\n  const structuralStringAllowed = (field: string, node: Record<string, unknown>) => SHARED_STRUCTURAL_STRING_EXCEPTIONS.some(rule => rule.fields.test(field) && rule.allows(node, patientIdentifierSystems));\n  const manifests: Record<string, unknown>[] = [];\n  const manifestOrigins: ManifestOrigin[] = [];\n  const omitted: string[] = [];\n  let requiresStructuralView = false;\n  let narrativeOmitted = false;\n  const withheld = Symbol('withheld');\n  const withhold = (path: string, reason: string, inModifier: boolean, metadata: Record<string, unknown> = {}, origin: ManifestOrigin = 'policy') => {\n    manifests.push({ path, reason, ...metadata });\n    manifestOrigins.push(origin);\n    omitted.push(path);\n    // A policy-withheld modifier prohibits a confident clinical interpretation.\n    if (inModifier) requiresStructuralView = true;\n    return withheld;\n  };\n  interface Scope { type: string; root: string; shared: boolean; identifier?: boolean }\n  // `attachment` drives withholding (schema, shape or path spelling: conservative). `inAttachment` is the\n  // schema-declared Attachment context, own or inherited, and drives only the manifest origin classification.\n  const walk = (value: unknown, path: string, key: string, parent: Record<string, unknown>, element: ResolvedElement, attachment: boolean, inAttachment: boolean, inModifier: boolean, inherited: Scope): unknown => {\n    const metadata = () => attachment ? attachmentMetadata(parent) : {};\n    const linkOrigin: ManifestOrigin = inAttachment ? 'attachment' : attachment || !element.types.length ? 'unknown' : 'policy';\n    // An unverifiable clinical-actor reference chosen by the judge is withheld whole, with every child and companion.\n    if (options.withholdReferences?.has(path) && value && typeof value === 'object' && !Array.isArray(value)) return withhold(path, 'UNVERIFIED_REFERENCE_WITHHELD', inModifier, {}, element.types.length ? 'policy' : 'unknown');\n    // Payload keys and the attachment link are withheld by key and schema context before the value's JSON\n    // shape is consulted; an object, array, number, boolean or null carries bytes or a capability as a string does.\n    if (payloadPosition(key, element, value)) return withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, metadata(), 'payload');\n    // Attachment context comes from the schema (Patient.photo, presentedForm, ...) even without contentType.\n    if (key === 'url' && attachment) return withhold(path, 'PROTECTED_LINK', inModifier, metadata(), linkOrigin);\n    // A scalar where the schema declares a Reference, a Resource or another reference-carrying structure is\n    // malformed linkage: withheld, never screened as prose or passed through as a leaf.\n    if (malformedLinkage(element, value)) return withhold(path, 'MALFORMED_LINKAGE_WITHHELD', inModifier);\n    // Any other scalar where the schema declares only complex types is malformed structure; one standing for an\n    // Attachment is withheld as a payload.\n    if (malformedComplex(element, value)) return element.types.includes('Attachment') ? withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, {}, 'payload') : withhold(path, 'MALFORMED_STRUCTURE_WITHHELD', inModifier);\n    if (typeof value === 'string') {\n      const prose = element.types.length === 1 && ['string', 'markdown'].includes(element.types[0]!) && !uriKey(key);\n      if (prose) {\n        const redacted = redactTextLinks(value);\n        if (!redacted.spans) return value;\n        manifests.push({ path, reason: 'PROTECTED_LINK_IN_TEXT', spans: redacted.spans });\n        manifestOrigins.push('link_text');\n        omitted.push(path);\n        if (inModifier) requiresStructuralView = true;\n        return redacted.text;\n      }\n      // Hardening: a link span inside a non-prose, non-URI value (a code, an undeclared vendor string)\n      // withholds the whole value; such values are never rewritten in place.\n      const opaque = !isUriElement(element) && !uriKey(key) && redactTextLinks(value).spans > 0;\n      return opaque || protectedLink(value, key, isUriElement(element)) ? withhold(path, 'PROTECTED_LINK', inModifier, metadata(), linkOrigin) : value;\n    }\n    // Lossless decimal scalars pass through sanitize unchanged.\n    if (isFhirDecimal(value) || isPrecisionFault(value)) return value;\n    // Keep primitive-array positions aligned with their FHIR _element metadata.\n    if (Array.isArray(value)) {\n      const primitive = element.types.some(type => /^[a-z]/.test(type));\n      return value.flatMap((item, i) => {\n        const result = walk(item, `${path}/${i}`, key, parent, element, attachment, inAttachment, inModifier, inherited);\n        return result === withheld ? (primitive ? [null] : []) : [result];\n      });\n    }\n    if (!value || typeof value !== 'object') return value;\n    const node = value as Record<string, unknown>;\n    // Only a schema-declared contained Resource can inherit its parent's scope.\n    if (malformedResource(element, node)) return withhold(path, 'MALFORMED_LINKAGE_WITHHELD', inModifier);\n    // A resourceType smuggled onto a shared scalar/datatype is unclassified.\n    if (inherited.shared && typeof node.resourceType === 'string' && !(key === 'contained' && element.types.includes('Resource'))) return withhold(path, 'UNDECLARED_PROPERTY_WITHHELD', inModifier, {}, 'unknown');\n    let scope: Scope = typeof node.resourceType === 'string' ? { type: node.resourceType, root: path, shared: path === '' ? resourceClass(node.resourceType) === 'shared' : inherited.shared } : inherited;\n    if (node.modifierExtension || node.implicitRules) requiresStructuralView = true;\n    const context: TypeContext | undefined = typeof node.resourceType === 'string' ? resourceTypeContext(node.resourceType) : element.context;\n    if (context?.definition === 'Identifier' && context.path === '') scope = { ...scope, identifier: true };\n    const isReference = context?.definition === 'Reference' && context.path === '';\n    // Resource.type (for example StructureDefinition.type) is not Reference.type.\n    const referenceLike = typeof node.resourceType !== 'string' && (isReference || node.reference !== undefined || (node.type !== undefined && (node.identifier !== undefined || node.display !== undefined || node._display !== undefined)));\n    // A reference whose reference or type member cannot be read is malformed linkage as a whole.\n    if (referenceLike && unreadableLinkage(node, context, isReference)) return withhold(path, 'MALFORMED_LINKAGE_WITHHELD', inModifier);\n    if (scope.shared && context?.definition === 'Identifier' && context.path === '' && typeof node.system === 'string' && patientIdentifierSystems.has(node.system)) return withhold(path, 'PATIENT_IDENTIFIER_SYSTEM_WITHHELD', inModifier);\n    if (scope.shared && context?.definition === 'Identifier' && context.path === '' && !structuralStringAllowed('Identifier.value', node)) return withhold(path, 'UNCLASSIFIED_IDENTIFIER_WITHHELD', inModifier);\n    if (scope.shared && referenceLike) {\n      const reason = sharedReferenceReason(node, element);\n      if (reason) return withhold(path, reason, inModifier, {}, element.types.length ? 'policy' : 'unknown');\n    }\n    const patientReference = referenceLike && ((isReference && element.targets?.length === 1 && element.targets[0] === 'http://hl7.org/fhir/StructureDefinition/Patient') || declaredType(node.type) === 'Patient' || declaredType(node.type) === 'patient-like'\n      || (typeof node.reference === 'string' && parseReference(node.reference, SANITIZE_REFERENCE_BASE).patientLike));\n    const isAttachment = (context?.definition === 'Attachment' && context.path === '') || node.contentType !== undefined || (node.data !== undefined && payloadPosition('data', resolveElement(context, 'data'), node.data)) || path.toLowerCase().includes('attachment');\n    const schemaAttachment = inAttachment || (context?.definition === 'Attachment' && context.path === '');\n    // The display/identifier companions of a reference whose target is unverifiable — a\n    // conditional form (never resolved), an unsupported/encoded form, or a reference string the\n    // egress screen itself withholds — are withheld with it. Authorization already rejects the\n    // owning resource on gateway paths; this keeps sanitize safe as a standalone layer.\n    const unverifiableReference = typeof node.reference === 'string'\n      && (() => { const parsed = parseReference(node.reference, SANITIZE_REFERENCE_BASE); return parsed.form === 'conditional' || parsed.form === 'unsupported' || protectedLink(node.reference, 'reference'); })();\n    const omissionsBefore = omitted.length;\n    const result: Record<string, unknown> = {};\n    for (const [childKey, child] of Object.entries(node)) {\n      // Raw upstream property names are never echoed into resources, manifest paths or omitted fields.\n      if (!/^_?[A-Za-z][A-Za-z0-9]{0,63}$/.test(childKey)) { withhold(`${path}/[undeclared-property]`, 'UNDECLARED_PROPERTY_WITHHELD', inModifier); continue; }\n      const pointer = `${path}/${childKey}`;\n      const childElement = resolveElement(context, childKey);\n      const childOrigin: ManifestOrigin = childElement.types.length ? 'policy' : 'unknown';\n      if (['__proto__', 'constructor', 'prototype'].includes(childKey)) { omitted.push(pointer); continue; }\n      // Only resource-level narrative sets narrativeOmitted; Bundle link/total omission is separate.\n      if (childKey === 'text' && typeof node.resourceType === 'string') { narrativeOmitted = true; omitted.push(pointer); continue; }\n      if (node.resourceType === 'Bundle' && ['link', 'total'].includes(childKey)) { omitted.push(pointer); continue; }\n      // Patient.link is a modifier whose target is always another person's record.\n      if (context?.definition === 'Patient' && context.path === 'link' && childKey === 'other') { withhold(pointer, 'FOREIGN_PATIENT_REFERENCE_WITHHELD', true, {}, childOrigin); continue; }\n      if (patientReference && ['display', '_display', 'identifier', 'extension', '_reference', '_type'].includes(childKey)) { withhold(pointer, 'PATIENT_REFERENCE_COMPANION_WITHHELD', inModifier, {}, childOrigin); continue; }\n      if (unverifiableReference && (childKey === 'display' || childKey === '_display' || childKey === 'identifier')) { withhold(pointer, 'UNVERIFIED_REFERENCE_COMPANION_WITHHELD', inModifier, {}, childOrigin); continue; }\n      const field = `${scope.type}.${pointer.slice(scope.root.length + 1).replaceAll('/', '.').replace(/\\._?\\d+(?=\\.|$)/g, '').replace(/(^|\\.)_/g, '$1')}`;\n      if (scope.shared && D1_MASKS.has(field)) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }\n      const recordMask = PATIENT_RECORD_MASKS.get(field);\n      if (recordMask) { withhold(pointer, recordMask, inModifier); continue; }\n      if (childKey === 'extension' && !scope.shared && UNREVIEWED_EXTENSION_TYPES.has(scope.type)) { withhold(pointer, 'UNREVIEWED_EXTENSION_WITHHELD', inModifier); continue; }\n      const catalog = ['CodeSystem', 'ValueSet', 'CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition'].includes(scope.type);\n      const scalar = resolveElement(context, childKey.startsWith('_') ? childKey.slice(1) : childKey);\n      const residualDisplay = CATALOG_DISPLAY.test(`${scope.type}:${field.slice(scope.type.length + 1)}`);\n      const structuralString = structuralStringAllowed(typeof node.resourceType === 'string' && childKey.replace(/^_/, '') === 'id' ? 'Resource.id' : isReference ? `Reference.${childKey.replace(/^_/, '')}` : context?.definition === 'Coding' && context.path === '' ? `Coding.${childKey.replace(/^_/, '')}` : context?.definition === 'Identifier' && context.path === '' ? `Identifier.${childKey.replace(/^_/, '')}` : field, node);\n      if (catalog && (['contact', 'publisher'].includes(childKey.replace(/^_/, ''))\n          || (scalar.types.some(type => type === 'string' || type === 'markdown') && !structuralString && !residualDisplay))) { withhold(pointer, 'SOURCE_PROSE_WITHHELD', inModifier); continue; }\n      if (scope.shared && childKey !== 'resourceType' && !childElement.types.length) { withhold(`${path}/[undeclared-property]`, 'UNDECLARED_PROPERTY_WITHHELD', inModifier, {}, 'unknown'); continue; }\n      const residual = !scope.identifier && D1_RESIDUAL.test(`${scope.type}:${field.slice(scope.type.length + 1)}`);\n      if (scope.shared && scalar.types.some(type => type === 'string' || type === 'markdown') && !structuralString && !residual && !residualDisplay) { withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier); continue; }\n      if (scope.shared && isReference && ['display', '_display', 'identifier'].includes(childKey)) {\n        if (childKey !== 'identifier' || walk(child, pointer, childKey, node, childElement, isAttachment, schemaAttachment, inModifier, scope) !== withheld) withhold(pointer, 'SHARED_FIELD_WITHHELD', inModifier);\n        continue;\n      }\n      const transformed = walk(child, pointer, childKey, node, childElement, isAttachment, schemaAttachment, inModifier || Boolean(childElement.modifier), scope);\n      if (transformed !== withheld) result[childKey] = transformed;\n    }\n    // Drop newly emptied complex entries; leaf omissions already carry their labels.\n    if (path && Object.keys(result).length === 0 && omitted.length > omissionsBefore) return withheld;\n    return result;\n  };\n  const sanitized = walk(resource, '', '', {}, { types: [] }, false, false, false, { type: resource.resourceType, root: '', shared: false }) as FhirResource;\n  return { resource: sanitized, manifests, manifestOrigins, omitted, retrievedAt: new Date().toISOString(), requiresStructuralView, narrativeOmitted };\n}\n\n// ---------------------------------------------------------------------------\n// Projection.\n// ---------------------------------------------------------------------------\n\nexport interface ProjectionWarning { code: string; message: string }\nexport interface Projection { resource: FhirResource; omitted: string[]; unresolved: string[]; warnings?: ProjectionWarning[]; recipe?: string }\n\n/**\n * Reviewed compact recipes, versioned against R4 4.0.1. Field names are\n * declared element names; choice elements (`[x]`) are kept whole through\n * resolveElement. Every root isModifier element, `id`, `meta` (versionId,\n * profile, security) and primitive companions are always added, `contained`\n * is kept when a kept element references it (`#id`), and each kept\n * element keeps its codings and code systems. Types without a recipe fall back\n * to the sanitized full view with COMPACT_RECIPE_UNAVAILABLE.\n */\nexport const COMPACT_RECIPE_SET = 'r4-compact-2026-10-18.1';\nexport const COMPACT_RECIPES: Readonly<Record<string, { id: string; fields: readonly string[] }>> = {\n  Patient: { id: 'Patient.compact.1', fields: ['active', 'name', 'gender', 'birthDate', 'deceased[x]'] },\n  Observation: { id: 'Observation.compact.1', fields: ['status', 'category', 'code', 'subject', 'focus', 'effective[x]', 'issued', 'value[x]', 'dataAbsentReason', 'interpretation', 'bodySite', 'method', 'referenceRange', 'hasMember', 'component'] },\n  Condition: { id: 'Condition.compact.1', fields: ['clinicalStatus', 'verificationStatus', 'category', 'severity', 'code', 'bodySite', 'subject', 'onset[x]', 'abatement[x]', 'recordedDate'] },\n  AllergyIntolerance: { id: 'AllergyIntolerance.compact.1', fields: ['clinicalStatus', 'verificationStatus', 'type', 'category', 'criticality', 'code', 'patient', 'onset[x]', 'recordedDate', 'lastOccurrence', 'reaction'] },\n  MedicationRequest: { id: 'MedicationRequest.compact.1', fields: ['status', 'statusReason', 'intent', 'category', 'priority', 'doNotPerform', 'reported[x]', 'medication[x]', 'subject', 'authoredOn', 'requester', 'reasonCode', 'courseOfTherapyType', 'dosageInstruction', 'dispenseRequest'] },\n  Immunization: { id: 'Immunization.compact.1', fields: ['status', 'statusReason', 'vaccineCode', 'patient', 'occurrence[x]', 'primarySource', 'lotNumber', 'site', 'route', 'doseQuantity', 'isSubpotent', 'subpotentReason', 'reasonCode', 'protocolApplied'] },\n  DiagnosticReport: { id: 'DiagnosticReport.compact.1', fields: ['status', 'category', 'code', 'subject', 'effective[x]', 'issued', 'result', 'conclusion', 'conclusionCode', 'presentedForm'] },\n  DocumentReference: { id: 'DocumentReference.compact.1', fields: ['status', 'docStatus', 'type', 'category', 'subject', 'date', 'author', 'description', 'securityLabel', 'relatesTo', 'content', 'context'] },\n};\nconst RECIPE_UNAVAILABLE: ProjectionWarning = { code: 'COMPACT_RECIPE_UNAVAILABLE', message: 'No reviewed compact recipe exists for this resource type; the full sanitized view is returned instead.' };\nconst MODIFIERS_ADDED: ProjectionWarning = { code: 'MODIFIER_FIELDS_ADDED', message: 'Modifier elements needed to interpret the selected fields were added to the projection.' };\n\nfunction containsModifierExtension(value: unknown, depth = 0): boolean {\n  if (!value || typeof value !== 'object' || depth > 64) return false;\n  if (Array.isArray(value)) return value.some(item => containsModifierExtension(item, depth + 1));\n  return Object.entries(value).some(([key, child]) => key === 'modifierExtension' || containsModifierExtension(child, depth + 1));\n}\n\nexport function project(resource: FhirResource, format: 'compact' | 'fhir', fields?: string[]): FhirResource {\n  return projection(resource, format, fields).resource;\n}\n\nexport function projection(resource: FhirResource, format: 'compact' | 'fhir', fields?: string[]): Projection {\n  resource = sanitizeForProjection(resource, projectionOnlyPolicies.get(resource)).resource;"),
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
    "if (selfAbsent && !this.config.source.selfLinkOptional)",
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
    "const publishTotal = verifySelf && !selfAbsent && !partialReasons.has('INVALID_RESOURCE_ID') && !precisionRefused && !sourceIncomplete && nextLinks.length === 0;",
    "const publishTotal = verifySelf && !selfAbsent && !precisionRefused && !sourceIncomplete && nextLinks.length === 0;"),
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
    "    // mutant: retain source-only names."),
  M('f06-raw-source-software', "packages/core/src/index.ts",
    "? sourceIdentityDigest(value) : undefined;",
    "? value : undefined;"),
  // Envelope gate checks, one mutant per distinct diagnostic.
  M('S5-M04-clean-error', "packages/core/src/contracts.ts",
    "if (t.projected || t.narrative_omitted || t.withheld_payloads.length || t.omitted_fields.length || t.unresolved_fields.length || t.recipe_ids.length || t.structural_resource_indices.length) return fail();",
    ""),
  M('S5-M06-digest', "packages/core/src/contracts.ts",
    "if (c.query_digest !== digest) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  M('S5-M10-ordered-query', "packages/core/src/contracts.ts",
    "if (c.constraints && JSON.stringify(c.constraints.map(p => ({ name: p.name, value: p.value }))) !== JSON.stringify(pairs)) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  M('S5-M11-profile', "packages/core/src/contracts.ts",
    "if (env.transform.delivery_profile !== context.deliveryProfile || ",
    "if ("),
  M('CL-1-deep-freeze', "packages/core/src/contracts.ts",
    "if (!frozenValidationState02(context)) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  M('CL-3-query-frozen', "packages/core/src/contracts.ts",
    "if (!Object.isFrozen(context) || !frozenValidationState02(q)) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  M('CL-4-structured-equality', "packages/core/src/contracts.ts",
    "if (JSON.stringify(result.structuredContent) !== serialized) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  M('CL-5-binding-revisions', "packages/core/src/contracts.ts",
    "if (env.source.capability_revision !== q.sourceRevision || env.context.policy_revision !== q.policyRevision || env.context.handle !== q.contextHandle) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  M('CL-6-query-resource-type', "packages/core/src/contracts.ts",
    "if (resources?.some(r => r.resourceType !== q.resourceType)) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  M('CL-7-iserror-binding', "packages/core/src/contracts.ts",
    " || result.isError !== (env.error ? true : undefined)) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ") return fail('VALIDATION_CONTEXT_MISMATCH');"),
  M('CL-8-fallback-label', "packages/core/src/contracts.ts",
    " && context.renderedText !== `delivery_profile: \"full-text-v1\"\\n${jsonLine}`",
    ""),
  M('S51-M01-search-origin', "packages/core/src/contracts.ts",
    "const searchChain = tool === 'fhir_search' || tool === 'fhir_page' || context?.query !== undefined;",
    "const searchChain = tool === 'fhir_search' || tool === 'fhir_page' || c.query_digest !== undefined || c.constraints !== undefined || c.constraints_on_first_page !== undefined;"),
  M('S51-M02-delivery-loss', "packages/core/src/contracts.ts",
    "if (c.state === 'complete_for_query' && (data.manifest !== undefined || c.reasons.some(r => ['OVERSIZED_RESOURCE', 'UNSUPPORTED_PRECISION', 'INVALID_RESOURCE_ID', 'ENTRY_ORIGIN_MISMATCH', 'FILTER_EXECUTION_UNVERIFIED'].includes(r)) || env.warnings.some(w => ['UNSUPPORTED_PRECISION', 'FILTER_EXECUTION_UNVERIFIED', 'CONTINUATION_QUERY_UNVERIFIED'].includes(w.code)))) return fail();",
    ""),
  M('S51-M03-trusted-bytes', "packages/core/src/contracts.ts",
    " || measured > context.effectiveByteLimit! || env.budget.byte_limit > context.effectiveByteLimit!",
    ""),
  M('S51-M04-advertised-count', "packages/core/src/contracts.ts",
    "Number(data.resource_count) < (data.resources as unknown[]).length",
    "data.resource_count !== (data.resources as unknown[]).length"),
  M('S51-M05-catalog', "packages/core/src/contracts.ts",
    "    if (env.warnings.some(w => !Object.hasOwn(WARNING_MESSAGES, w.code) || w.message !== (w.code === 'NO_MATCHES' ? noMatchesMessage : WARNING_MESSAGES[w.code]))) return fail();",
    ""),
  M('S51-M06-withheld-manifest', "packages/core/src/contracts.ts",
    "    if (t.withheld_payloads.some(m => typeof m.path !== 'string' || !m.path.startsWith('/') || typeof m.reason !== 'string' || !m.reason || Object.keys(m).some(k => !manifestKeys.includes(k)) ||\n      (m.content_type !== undefined && typeof m.content_type !== 'string') || (m.hash !== undefined && typeof m.hash !== 'string') ||\n      (m.size !== undefined && (typeof m.size !== 'number' || !Number.isSafeInteger(m.size) || m.size < 0)) ||\n      (m.spans !== undefined && (m.reason !== 'PROTECTED_LINK_IN_TEXT' || typeof m.spans !== 'number' || !Number.isSafeInteger(m.spans) || m.spans < 1)) ||\n      (m.count !== undefined && (typeof m.count !== 'number' || !Number.isSafeInteger(m.count) || m.count < 1)))) return fail();",
    ""),
  M('S51-M07-retained-next-offset', "packages/core/src/contracts.ts",
    "if (page && ((page.has_more === true) !== (data.next_offset !== undefined) || page.has_more === null)) return fail();",
    ""),
  M('S51-M08-read-target', "packages/core/src/contracts.ts",
    "if (tool === 'fhir_read' && context?.readTarget && resources.some(r => r.resourceType !== context.readTarget!.resourceType || r.id !== context.readTarget!.id)) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  M('S51-M09-recipe', "packages/core/src/contracts.ts",
    "if (t.recipe_ids.length && (!t.projected || t.format !== 'compact')) return fail();",
    ""),
  M('S51-M12-no-matches-history', "packages/core/src/contracts.ts",
    "if (context.chainDeliveredCount !== 0) return fail();",
    ""),
  M('S52-M01-strict-parse', "packages/core/src/index.ts",
    "const parsed = toolInputV2Schemas[tool].safeParse(unknownInput);",
    "const parsed = { success: true, data: unknownInput };"),
  M('S52-M02-own-keys', "packages/core/src/index.ts",
    "if (caps.cursor !== undefined && ownKeys.some(key => !['topic', 'cursor', 'context_handle', 'limit', 'output'].includes(key)))",
    "if (false)"),
  M('S52-M03-combinations', "packages/core/src/index.ts",
    "if (capabilitiesCombinationFault(caps))",
    "if (false)"),
  M('S52-M04-retained-conflict', "packages/core/src/index.ts",
    "if (top && nested && JSON.stringify(top) !== JSON.stringify(nested)) throw new GatewayFault('INVALID_ARGUMENTS', 'Conflicting retained field selections.');",
    ""),
  M('S52-M05-inspect-fields', "packages/core/src/index.ts",
    "if (retained.action === 'inspect' && (top || nested))",
    "if (false)"),
  M('S52-M06-compact-default', "packages/core/src/index.ts",
    "return { input, ownKeys, format: requestedFormat ?? 'fhir',",
    "return { input, ownKeys, format: requestedFormat ?? 'compact',"),
  M('S52-M07-fabricated-format', "packages/core/src/index.ts",
    "...(requestedFormat !== undefined ? { requestedFormat } : {})",
    "...{ requestedFormat: requestedFormat ?? 'fhir' }"),
  M('S52-M08-stale-error-array', "packages/core/src/index.ts",
    "    envelope.warnings = [];\n    envelope.error = { code,",
    "    envelope.warnings = [];\n    envelope.transform.omitted_fields = ['/stale'];\n    envelope.error = { code,"),
  M('S52-M09-selected-fields', "packages/core/src/index.ts",
    "...(fields ? { fields: [...fields] } : {})",
    "...{}"),
  M('S53-M01-self-proof', "packages/core/src/index.ts",
    "const overlay = snapshot.queryOverlay;\n    const reasons =",
    "evidence.materialFilterProved = evidence.constraints.every(entry => entry.source_reported === 'matched');\n    const overlay = snapshot.queryOverlay;\n    const reasons ="),
  M('S53-M02-repeat-constraints', "packages/core/src/index.ts",
    "coverage.constraints = evidence.constraints.map(entry => ({ ...entry }));",
    "coverage.constraints = evidence.constraints.filter((entry, index, all) => all.findIndex(x => x.name === entry.name && x.value === entry.value) === index).map(entry => ({ ...entry }));"),
  M('S53-M03-repeat-sort', "packages/core/src/index.ts",
    "// The bounded coverage helper is not an excuse to silently lose material reasons.",
    "if (coverage.sort) delete coverage.sort.requested;\n    // The bounded coverage helper is not an excuse to silently lose material reasons."),
  M('S53-M04-digest', "packages/core/src/index.ts",
    "// The bounded coverage helper is not an excuse to silently lose material reasons.",
    "delete coverage.query_digest;\n    // The bounded coverage helper is not an excuse to silently lose material reasons."),
  M('S53-M06-suppression-no-matches', "packages/core/src/index.ts",
    "deliveredCount: (overlay?.deliveredCount ?? 0) + call.deliveredCount,",
    "deliveredCount: snapshot.suppressed ? 0 : (overlay?.deliveredCount ?? 0) + call.deliveredCount,"),
  M('S53-M08-scan-binding', "examples/observed-code-scan.ts",
    "const params = [...options.dateWindow.map(pair => ({ ...pair })), { ...selector }];",
    "const params = [...options.dateWindow.map(pair => ({ ...pair }))];"),
  M('S53-M09-scan-dates', "examples/observed-code-scan.ts",
    "const params = [...options.dateWindow.map(pair => ({ ...pair })), { ...selector }];",
    "const params = [{ ...selector }];"),
  M('S53-M11-mcp-cap', "examples/observed-code-scan.ts",
    "report.mcpCalls >= limits.maxMcpCalls",
    "false"),
  M('S53-M12-upstream-cap', "examples/observed-code-scan.ts",
    "report.upstreamCalls + client.upstreamWork.maxPerCall > limits.maxUpstreamCalls",
    "false"),
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
  M('S53-M14-call-byte-cap', "examples/observed-code-scan.ts",
    "bytes > limits.maxBytesPerCall",
    "false"),
  M('S53-M15-task-byte-cap', "examples/observed-code-scan.ts",
    "report.bytes + limits.maxBytesPerCall > limits.maxBytesPerTask",
    "false"),
  M('S53-M16-raised-operator-limit', "examples/observed-code-scan.ts",
    "value > limits[key as keyof typeof limits]!",
    "false"),
  M('S53-M17-terminology-fetch', "examples/observed-code-scan.ts",
    "discovery = false; continue;",
    "await client.callTool({ name: 'fhir_read', arguments: { resource_type: 'CodeSystem', id: 'synthetic-terminology' } }, { signal: deadline });\n      discovery = false; continue;"),
  M('S53-M18-truncated-split', "examples/observed-code-scan.ts",
    "if (options.originalCodeOr !== undefined && splitEscapedCommaOrDetailed(options.originalCodeOr).truncated)",
    "if (false)"),
  M('S53-M19-dynamic-warning', "packages/core/src/index.ts",
    "result.set(warning.code, { code: warning.code, message,",
    "result.set(warning.code, { code: warning.code, message: warning.message,"),
  M('S53-M20-total-vs-clinical', "packages/core/src/index.ts",
    "kind === 'unsupported_modifier' && work.upstreamCalls !== 0 ? MODIFIER_NO_CLINICAL_MESSAGE",
    "kind === 'unsupported_modifier' && work.clinicalCalls !== 0 ? MODIFIER_NO_CLINICAL_MESSAGE"),
  M('S53-M21-reviewed-repairs', "packages/core/src/index.ts",
    "return reviewedNamesFor(resolved, new Set(this.capabilities?.keys() ?? []));",
    "return NO_REVIEWED_NAMES;"),
  M('S53-M22-reasons', "packages/core/src/index.ts",
    "coverage.reasons = [...new Set([...coverage.reasons, ...reasons])];",
    "coverage.reasons = [...new Set([...coverage.reasons, ...reasons])].slice(0, 8);"),
  M('C2-D01-remainder-ordering-reverted', "packages/core/src/index.ts",
    "const remainder: QueryChainView['remainder'] = call.localRemainder ? 'local' : snapshot.nextUrl ? 'upstream'\n      : nonContinuable ? 'rejected_link' : unverifiedContinuation || call.unknownContinuation || snapshot.sourceIncomplete ? 'unknown' : 'none';",
    "const remainder: QueryChainView['remainder'] = unverifiedContinuation ? 'unknown' : call.localRemainder ? 'local' : snapshot.nextUrl ? 'upstream'\n      : nonContinuable ? 'rejected_link' : call.unknownContinuation || snapshot.sourceIncomplete ? 'unknown' : 'none';"),
  M('C2-D02-refused-drained-false', "packages/core/src/query.ts",
    "? null : chain.exhausted;",
    "? (chain.refused && chain.remainder === 'none' ? false : null) : chain.exhausted;"),
  M('N02-refused-unknown-false', "packages/core/src/query.ts",
    "? null : chain.exhausted;",
    "? (chain.refused && chain.remainder === 'unknown' ? false : null) : chain.exhausted;"),
  M('N03-shared-predicate-bypassed', "packages/core/src/index.ts",
    "&& noMatchesEligible(coverage, chain.deliveredCount, evidence.constraints)",
    "&& (evidence.constraints.some(pair => !['subject', 'patient', '_id'].includes(pair.name)) && chain.deliveredCount === 0 && coverage.query_exhausted === true)"),
  M('N04-id-material-again', "packages/core/src/contracts.ts",
    "filters.some(pair => !['subject', 'patient', '_id'].includes(pair.name))",
    "filters.some(pair => !['subject', 'patient'].includes(pair.name))"),
  M('N07-allowlist-to-old-denylist', "packages/core/src/index.ts",
    "reasons.some(reason => !informationalReasons.includes(reason))",
    "reasons.some(reason => ['OVERSIZED_RESOURCE', 'UNSUPPORTED_PRECISION', 'INVALID_RESOURCE_ID', 'ENTRY_ORIGIN_MISMATCH', 'OUTPUT_LIMIT', 'SOURCE_REPORTED_INCOMPLETE', 'DELIVERY_REFUSED'].includes(reason))"),
  M('N08-maxPerCall-check-removed', "examples/observed-code-scan.ts",
    "return !afterCall || delta <= client.upstreamWork.maxPerCall;",
    "return true;"),
  M('N10-null-pagination-limit-label', "examples/observed-code-scan.ts",
    "if (env.pagination?.has_more !== true || !env.pagination.next_cursor) return refuse();",
    "if (env.pagination?.has_more !== true || !env.pagination.next_cursor) return refuse('SCAN_LIMIT_REACHED');"),
  M('N10-chainExhausted-on-refusal', "examples/observed-code-scan.ts",
    "    if (!env.coverage || !['complete_for_query', 'partial', 'unknown'].includes",
    "    if (env.pagination?.has_more === false) report.chainExhausted = true;\n    if (!env.coverage || !['complete_for_query', 'partial', 'unknown'].includes"),
  M('N09-unrunnable-repair-offered', "packages/core/src/repairs.ts",
    "field && dateWindow.length > 0 && dateWindow.every(pair => OBSERVED_CODE_DATE_PARAMETERS[type]?.includes(pair.name) && Boolean(pair.value)) && reviewed.parameter(type, 'code')",
    "field && reviewed.parameter(type, 'code')"),
  M('N11-source-incomplete-labelled-continuation', "packages/core/src/query.ts",
    "if (chain.remainder === 'unknown' && !chain.refusalReasons?.includes('SOURCE_REPORTED_INCOMPLETE'))",
    "if (chain.remainder === 'unknown')"),
  M('N05-unverified-exhaustion-is-refusal', "examples/observed-code-scan.ts",
    "if (env.coverage.query_exhausted === null) return { ...report, status: 'exhaustion_unverified', code: 'SCAN_EXHAUSTION_UNVERIFIED' };",
    "if (env.coverage.query_exhausted === null) return refuse();"),
  M('N01-local-remainder-overridden-by-rejected-link', "packages/core/src/query.ts",
    "? !retained && knownRemainder ? false : null",
    "? null"),
  M('C53-M01-nomatches-any-suffix', "packages/core/src/index.ts",
    "const message = warning.code === 'NO_MATCHES' && warning.message === base + NO_MATCHES_UNVERIFIED_SUFFIX\n        ? base + NO_MATCHES_UNVERIFIED_SUFFIX : base;",
    "const message = warning.code === 'NO_MATCHES' && warning.message.startsWith(base)\n        ? warning.message : base;"),
  M('C53-M02-scan-nonsettling-driver', "examples/observed-code-scan.ts",
    "const onAbort = () => reject(new Error('scan deadline'));",
    "const onAbort = () => undefined;"),
  M('C53-M03-unknown-warning-dropped', "packages/core/src/index.ts",
    "if (!Object.hasOwn(WARNING_MESSAGES, warning.code) || !base) throw new GatewayFault('INTERNAL_ERROR', 'Unable to complete the bounded request.');",
    "if (!Object.hasOwn(WARNING_MESSAGES, warning.code) || !base) continue;"),
  M('C53-M04-error-message-passthrough', "packages/core/src/index.ts",
    " && ['invalid_topic', 'invalid_format', 'invalid_interaction', 'invalid_action'].some(key => REFUSAL_MESSAGES[key] === fault.message)",
    ""),
  M('C53-M05-scan-post-upstream-overrun', "examples/observed-code-scan.ts",
    "|| report.bytes > limits.maxBytesPerTask || report.upstreamCalls > limits.maxUpstreamCalls) return refuse('SCAN_LIMIT_REACHED');",
    "|| report.bytes > limits.maxBytesPerTask) return refuse('SCAN_LIMIT_REACHED');"),
  M('C53-M07-unverified-continuation-warning-dropped', "packages/core/src/index.ts",
    "if (unverifiedContinuation) add('CONTINUATION_QUERY_UNVERIFIED');",
    ""),
  M('FIX-F02-continuation', "packages/core/src/index.ts",
    "const unverifiedContinuation = !resourceOrigin && snapshot.queryEvidenceKind === 'unverified_continuation';",
    "const unverifiedContinuation = false;"),
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
  M('FIX-F04-derived-cap', "packages/core/src/index.ts",
    "    const coverage = coverageForSnapshot(disclosed, { ...chain, refusalReasons: reasons.includes('SOURCE_REPORTED_INCOMPLETE') ? ['SOURCE_REPORTED_INCOMPLETE'] : reasons.length ? [] : undefined });",
    "    const coverage = coverageForSnapshot(disclosed, chain);"),
  M('FIX-F05-overlay', "packages/core/src/index.ts",
    "(call.tool !== 'fhir_page' || Boolean(overlay))",
    "true"),
  M('FIX-F05-caller-filter', "packages/core/src/index.ts",
    "noMatchesEligible(coverage, chain.deliveredCount, evidence.constraints)",
    "noMatchesEligible(coverage, chain.deliveredCount, call.filtered)"),
  M('FIX-F06-error-reasons', "packages/core/src/index.ts",
    "reasons: [...(clinical ? ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN'] : []), faultCode]",
    "reasons: [...(clinical ? ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN', 'FILTER_EXECUTION_UNVERIFIED'] : ['DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION']), faultCode]"),
  M('FIX-F06-retained-read', "packages/core/src/index.ts",
    "const resourceOrigin = read || (retained && !snapshot.queryEvidence);",
    "const resourceOrigin = read;"),
  M('FIX-F07-warning-keys', "packages/core/src/index.ts",
    "result.set(warning.code, { code: warning.code, message,",
    "result.set(warning.code, { ...warning, message,"),
  M('FIX-F08-lazy-names', "packages/core/src/index.ts",
    "const parameters = resolveSearchParameters({ resourceType: type, declared: capability.declared, advertised: true });",
    "const parameters = capability.resolvedParameters.get('generic-r4');"),
  M('FIX-F09-fallback', "packages/core/src/index.ts",
    "    const coverage = coverageForSnapshot(disclosed, { ...chain, refusalReasons: reasons.includes('SOURCE_REPORTED_INCOMPLETE') ? ['SOURCE_REPORTED_INCOMPLETE'] : reasons.length ? [] : undefined });",
    "    const coverage = coverageForSnapshot(disclosed, { ...chain, refusalReasons: [] });"),
  M('FIX-F10-zero-work-reserve', "examples/observed-code-scan.ts",
    "client.upstreamWork.maxPerCall < 1",
    "client.upstreamWork.maxPerCall < 0"),
  M('FIX-F10-initial-counter', "examples/observed-code-scan.ts",
    "if (!Number.isSafeInteger(upstreamStart) || upstreamStart < 0) return refuse();",
    ""),
  M('FIX-F10-monotone-counter', "examples/observed-code-scan.ts",
    "if (!Number.isSafeInteger(total) || total < lastWork) return false;",
    ""),
  M('FIX-F11-unresolved', "examples/observed-code-scan.ts",
    "|| env.transform?.unresolved_fields?.length || env.transform?.withheld_payloads?.length",
    ""),
  M('FIX-F11-refused-label', "examples/observed-code-scan.ts",
    "if (env.coverage.query_exhausted !== true) return refuse();",
    "if (env.coverage.query_exhausted !== true) return refuse('SCAN_LIMIT_REACHED');"),
  M('FIX-F12-response-binding', "examples/observed-code-scan.ts",
    "|| env.context?.handle !== contextHandle || env.source?.alias !== source",
    ""),
  M('FIX-F12-resource-type', "examples/observed-code-scan.ts",
    "|| env.data.resources.some(resource => resource?.resourceType !== resourceType)",
    ""),
  M('FIX-F14-date-window', "examples/observed-code-scan.ts",
    "!OBSERVED_CODE_DATE_PARAMETERS[resourceType]?.includes(pair.name)",
    "pair.name !== 'date'"),
  M('R01-overlay-in-blob', "packages/core/src/index.ts",
    "const page: Snapshot = { ...snapshot, queryOverlay: undefined, offset: 0, sliceStart: undefined, sliceEnd: undefined };",
    "const page: Snapshot = { ...snapshot, offset: 0, sliceStart: undefined, sliceEnd: undefined };"),
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
  M('R02-gate-dangling-action', "packages/core/src/contracts.ts",
    "    if (!env.result && data.manifest && typeof data.manifest === 'object' && /fhir_result/i.test(String((data.manifest as { action?: unknown }).action ?? ''))) return fail();",
    ""),
  M('R03-inspect-boolean', "packages/core/src/index.ts",
    "upstream_pages_remain: snapshot.nextUrl ? true : snapshot.queryEvidenceKind === 'unverified_continuation' || snapshot.nonContinuable || snapshot.queryOverlay?.nonContinuable || snapshot.sourceIncomplete ? null : false,",
    "upstream_pages_remain: Boolean(snapshot.nextUrl),"),
  M('R03-gate-false-unknown', "packages/core/src/contracts.ts",
    "    if (inspection && data.upstream_pages_remain === false && c.reasons.some(reason => ['CONTINUATION_QUERY_UNVERIFIED', 'NON_CONTINUABLE_UPSTREAM_LINK', 'SOURCE_REPORTED_INCOMPLETE'].includes(reason))) return fail();",
    ""),
  M('R04-indexed-omissions', "packages/core/src/projection.ts",
    "const pointer = Array.isArray(source) ? path : `${path}/${key}`;",
    "const pointer = `${path}/${key}`;"),
  M('R05-structural-subset', "packages/core/src/projection.ts",
    "const view = sanitizedProjection(record.resource, 'fhir');\n    const supplemented = { resource: view.resource, omitted: view.omitted };",
    "const view = sanitizedProjection(record.resource, 'fhir', fields ? [...fields] : undefined);\n    const supplemented = fields ? withSupplement(record.resource, view.resource) : { resource: view.resource, omitted: view.omitted };"),
  C('R06-single-pop', [
    {
      "file": "packages/core/src/index.ts",
      "find": "while (selected.length && exceedsByteBudget(env.budget, 128));",
      "replace": "while (false);"
    },
    {
      "file": "packages/core/src/index.ts",
      "find": "    while (selected.length && exceedsByteBudget(env.budget, 128)) {\n      selected.pop(); position--; oversized = selected.length === 0; assemble();\n    }",
      "replace": ""
    }
  ]),
  M('R07-shifted-tag', "packages/core/src/projection.ts",
    "    if (!path && key === 'meta') return []; // Supplement owns meta omissions, including filtered tag arrays.\n",
    ""),
  M('R08-spans-ceiling', "packages/core/src/contracts.ts",
    "!Number.isSafeInteger(m.spans) || m.spans < 1)",
    "!Number.isSafeInteger(m.spans) || m.spans < 1 || m.spans > 10000)"),
  M('R09-no-rollback', "packages/core/src/index.ts",
    "      if (!completed) { restoreReservations(); restoreDiscovery(); this.reserved.delete(env as unknown as GatewayEnvelope); }",
    "      if (!completed) { restoreDiscovery(); this.reserved.delete(env as unknown as GatewayEnvelope); }"),
  M('R10-no-reserve', "packages/core/src/index.ts",
    "while (rows.length && exceedsByteBudget(env.budget, 128)) { rows.pop(); pack(); }\n    if (exceedsByteBudget(env.budget, 128) ||",
    "while (rows.length && exceedsByteBudget(env.budget, 0)) { rows.pop(); pack(); }\n    if (exceedsByteBudget(env.budget, 0) ||"),
  M('total-not-published', "packages/core/src/index.ts",
    "...(snapshot.total !== undefined && snapshot.offset === 0 && !localMore && assembled.coverage.query_exhausted === true ? { value: snapshot.total } : {})",
    "...{}"),
  M('R13-global-budget', "packages/core/src/projection.ts",
    "function localReference(value: unknown): boolean {\n  let visitedBudget = 0;",
    "let visitedBudget = 0;\nfunction localReference(value: unknown): boolean {\n  visitedBudget = 0;"),
  M('R-M02-structural-indices-offset', "packages/core/src/index.ts",
    "structural_resource_indices: metas.flatMap((meta, i) => meta.interpretation === 'structural' ? [i] : []) };",
    "structural_resource_indices: metas.flatMap((meta, i) => meta.interpretation === 'structural' ? [i + snapshot.offset] : []) };"),
  M('R-M03-no-retention-failure-reservation', "packages/core/src/index.ts",
    "env.result = result; env.warnings = warnings; env.budget.bytes_returned = Math.max(bytes, worst);",
    "env.result = result; env.warnings = warnings; env.budget.bytes_returned = bytes; void worst;"),
  M('R-M04-bound-factor-1', "packages/core/src/index.ts",
    "pendingBound += 4 * Buffer.byteLength(",
    "pendingBound += 1 * Buffer.byteLength("),
  M('R-M06-inspect-absolute-structural', "packages/core/src/index.ts",
    "env.transform.structural_resource_indices = rows.flatMap((row, i) => row.interpretation === 'structural' ? [i] : []);",
    "env.transform.structural_resource_indices = rows.flatMap((row, i) => row.interpretation === 'structural' ? [i + input.offset] : []);"),
  M('R-M18-ttl-renew-on-render', "packages/core/src/index.ts",
    "expiresAt: original.expiresAt ?? Date.now()",
    "expiresAt: Date.now()"),
  M('R-M19-res-no-original-expiry', "packages/core/src/index.ts",
    "            originalExpiry: snapshot.expiresAt }], this.reserved.get(env as unknown as GatewayEnvelope) ?? [])[0]!;",
    "            }], this.reserved.get(env as unknown as GatewayEnvelope) ?? [])[0]!;"),
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
  M('S54-M05-version-supplement', "packages/core/src/projection.ts",
    "if (supplement.meta) result.meta = { ...existingMeta, ...supplement.meta };",
    "if (supplement.meta) { const { versionId: _version, ...withoutVersion } = supplement.meta; result.meta = { ...existingMeta, ...withoutVersion }; }"),
  M('S54-M06-drop-omission-disclosure', "packages/core/src/index.ts",
    "omitted_fields: [...new Set(metas.flatMap(meta => meta.omitted_fields))].sort(),",
    "omitted_fields: [],"),
  M('S54-M07-shift-indices-after-exclusion', "packages/core/src/index.ts",
    "const provenance = indexedProvenance(neutral);",
    "const provenance = indexedProvenance(neutral).map(entry => ({ ...entry, resource_index: entry.resource_index + (reasons.length ? 1 : 0) }));"),
  M('S54-M08-provenance-before-exclusion', "packages/core/src/index.ts",
    "const provenance = indexedProvenance(neutral);",
    "const provenance = indexedProvenance(selected.length ? original.records.slice(original.offset, original.offset + limit).map(record => this.projectionRecordV2(record)) : neutral);"),
  M('S54-M09-spans-any-reason', "packages/core/src/contracts.ts",
    "m.reason !== 'PROTECTED_LINK_IN_TEXT' || typeof m.spans",
    "typeof m.spans"),
  M('RV-02-pop-no-decrement-outer', "packages/core/src/index.ts",
    "\n      selected.pop(); position--; oversized = selected.length === 0; assemble();\n    }",
    "\n      selected.pop(); oversized = selected.length === 0; assemble();\n    }"),
  M('RV-03-oversized-on-any-pop', "packages/core/src/index.ts",
    "do { selected.pop(); position--; oversized = selected.length === 0; assemble(); }",
    "do { selected.pop(); position--; oversized = true; assemble(); }"),
  M('RV-05-total-on-continued-page', "packages/core/src/index.ts",
    "snapshot.total !== undefined && snapshot.offset === 0 && !localMore",
    "snapshot.total !== undefined && !localMore"),
  M('RV-07-restore-skipped-for-gateway-faults', "packages/core/src/index.ts",
    "    } finally {\n      if (!completed) { restoreReservations(); restoreDiscovery(); this.reserved.delete(env as unknown as GatewayEnvelope); }\n    }",
    "    } catch (error) {\n      if (!(error instanceof GatewayFault)) { restoreReservations(); restoreDiscovery(); this.reserved.delete(env as unknown as GatewayEnvelope); }\n      throw error;\n    } finally { void completed; }"),
  M('RV-08-structural-false-selection-omissions', "packages/core/src/projection.ts",
    "const supplemented = { resource: view.resource, omitted: view.omitted };",
    "const supplemented = { resource: view.resource, omitted: [...view.omitted, ...(fields ? withSupplement(record.resource, sanitizedProjection(record.resource, 'fhir', [...fields]).resource).omitted : [])] };"),
  M('RV-10-reservation-keeps-fhir_result-action', "packages/core/src/index.ts",
    "if (manifest) data.manifest = { ...manifest, action: recoveryAction(false) };",
    "void notRetainedAction;"),
  M('RV-11-retained-zero-fit-nonadvancing-offset', "packages/core/src/index.ts",
    "...(retained && localMore && selected.length ? { next_offset: position } : {})",
    "...(retained && localMore ? { next_offset: position } : {})"),
  M('RV-12-retained-zero-fit-has-more', "packages/core/src/index.ts",
    "((localMore && (!retained || selected.length > 0))",
    "((localMore)"),
  M('N02-structural-selection-advice', "packages/core/src/index.ts",
    "if (!recovery?.structural) return retained",
    "if (!recovery?.structural || oversized) return retained"),
  M('N02-body-only-measurement', "packages/core/src/index.ts",
    "const needed = env.budget.bytes_returned + 128;",
    "const needed = Buffer.byteLength(stringifyFhir(view.resource)) + 128;"),
  M('N03-unrecoverable-still-continuable', "packages/core/src/index.ts",
    "unrecoverable: needed > this.maxBytes",
    "unrecoverable: false"),
  M('N03-read-null-control', "packages/core/src/index.ts",
    "has_more: more ? true : unknown ? null : false, returned_matches: resources.length, returned_includes: 0,",
    "has_more: read && oversized ? null : more ? true : unknown ? null : false, returned_matches: resources.length, returned_includes: 0,"),
  M('N04-clinical-only-rollback', "packages/core/src/index.ts",
    "if (!completed) { restoreReservations(); restoreDiscovery(); this.reserved.delete(env as unknown as GatewayEnvelope); }",
    "if (!completed) { restoreReservations(); this.reserved.delete(env as unknown as GatewayEnvelope); }"),
  M('N04-nested-generation-bump', "packages/core/src/store.ts",
    "      this.reset();\n      for (const [key, value] of blobs)",
    "      this.clear();\n      for (const [key, value] of blobs)"),
  M('N05-ignore-overlay', "packages/core/src/index.ts",
    "Boolean(recovery?.unrecoverable || snapshot.nonContinuable || snapshot.queryOverlay?.nonContinuable || snapshot.sourceIncomplete || snapshot.queryEvidenceKind",
    "Boolean(recovery?.unrecoverable || snapshot.nonContinuable || snapshot.sourceIncomplete || snapshot.queryEvidenceKind"),
  M('N08-redundant-assembly', "packages/core/src/index.ts",
    "if (!packed) assemble();",
    "assemble();"),
  M('R01-standing-reason-dropped', "packages/core/src/index.ts",
    "        env.coverage = metadataCoverage(more);",
    "        env.coverage = metadataCoverage(more);\n        env.coverage.reasons = env.coverage.reasons.filter(r => r !== 'DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION');"),
  M('R01-invented-reason-restored', "packages/core/src/index.ts",
    "        env.coverage = metadataCoverage(more);",
    "        env.coverage = metadataCoverage(more);\n        env.coverage.reasons = env.coverage.reasons.map(r => r === 'MORE_PAGES' ? 'MORE_METADATA_ROWS' : r);"),
  M('R03-post-describe-check', "packages/core/src/index.ts",
    "          const finalize = prepare?.(resourceType, metadata);\n          this.throwIfCancelled(budget);",
    "          const finalize = prepare?.(resourceType, metadata);"),
  M('R04-pre-describe-check', "packages/core/src/index.ts",
    "          this.throwIfCancelled(budget);\n          const resourceType =",
    "          const resourceType ="),
  M('R04-TTL-floor', "packages/core/src/index.ts",
    "this.metadataExpiresAt - Date.now() < Math.min(60000, ttl / 2)",
    "false"),
  M('R04-first-expired-put', "packages/core/src/index.ts",
    "          if (!input.cursor && error instanceof GatewayFault && error.code === 'DISCOVERY_EXPIRED') {\n            throw new GatewayFault('CONNECTION_REQUIRED', 'The source connection changed during discovery; repeat it after reconnecting.', true);\n          }",
    ""),
  M('R05-clear-generation', "packages/core/src/store.ts",
    "      if (generation !== this.clearGeneration) return;",
    "      void generation;"),
  M('R06-definitions-alias', "packages/core/src/index.ts",
    "definitions: { ...SEARCH_PARAMETER_DEFINITIONS }",
    "definitions: SEARCH_PARAMETER_DEFINITIONS"),
  M('R06-sections-alias', "packages/core/src/index.ts",
    "clinical_sections: [...workflow.clinical_sections],",
    "clinical_sections: workflow.clinical_sections,"),
  M('R06-schema-alias', "packages/core/src/index.ts",
    "      const page = JSON.parse(JSON.stringify(schemaPage(input.resource_type, input.path, input.offset, input.limit))) as ReturnType<typeof schemaPage>;",
    "      const page = schemaPage(input.resource_type, input.path, input.offset, input.limit);"),
  M('R07-placeholder-minus-one', "packages/core/src/index.ts",
    "env.data = makeData(more ? `cur_${'x'.repeat(32)}` : undefined);",
    "env.data = makeData(more ? `cur_${'x'.repeat(31)}` : undefined);"),
  M('R10-observer-inside-try', "packages/auth/src/client-credentials.ts",
    "    this.onRequest?.();\n    try {\n      response = await this.fetchFn",
    "    try {\n      this.onRequest?.();\n      response = await this.fetchFn"),
  M('namespace-check-removed', "packages/core/src/discovery.ts",
    "    if (!cursor.startsWith('cur_')) throw expired();",
    ""),
  M('topic-check-removed', "packages/core/src/discovery.ts",
    "found.value.topic !== topic || !bindingsEqual(found.value.binding, binding)",
    "!bindingsEqual(found.value.binding, binding)"),
  M('metadata-handle-rollback-removed', "packages/core/src/index.ts",
    "          restoreClinical(); restoreDiscovery();\n          if (!input.cursor",
    "          restoreClinical();\n          if (!input.cursor"),
  M('discovery-cursor-cross-store-accepted', "packages/core/src/store.ts",
    "    const blob = item ? this.blobs.get(item.key) : undefined;",
    "    const blob = item ? this.blobs.get(item.key) : undefined;\n    if ((!item || !blob) && this.options.role === 'clinical' && this.options.ledger) {\n      for (const other of (this.options.ledger as unknown as { all: ResultStore<T>[] }).all) {\n        if (other !== this) { try { return other.get(handle); } catch { /* try other authority */ } }\n      }\n    }"),
  M('metadata-issues-res', "packages/core/src/discovery.ts",
    "export function freezeSupportSnapshot(\n  store: ResultStore<DiscoverySnapshotValue>,\n  value: Omit<SupportSnapshotValue, 'offset'>,\n  originalExpiry?: number,\n): { handle: string; expires_at: string } {\n  const { offset, ...snapshot } = value as DiscoverySnapshotValue;\n  return store.put('cur', immutableSnapshot(snapshot), originalExpiry, { offset });\n}",
    "export function freezeSupportSnapshot(\n  store: ResultStore<DiscoverySnapshotValue>,\n  value: Omit<SupportSnapshotValue, 'offset'>,\n  originalExpiry?: number,\n): { handle: string; expires_at: string } {\n  const { offset, ...snapshot } = value as DiscoverySnapshotValue;\n  return store.put('res', immutableSnapshot(snapshot), originalExpiry, { offset });\n}"),
  M('continuation-renews-ttl', "packages/core/src/index.ts",
    "freezeSupportSnapshot(this.discoveryStore, next, Date.parse(next.expiresAt))",
    "freezeSupportSnapshot(this.discoveryStore, next)"),
  M('failed-refresh-installs-state', "packages/core/src/index.ts",
    "const metadata = await this.transport.get(this.transport.url('metadata'), stats, {});",
    "const metadata = await this.transport.get(this.transport.url('metadata'), stats, {}).catch(error => { this.capabilities = new Map(); this.capabilityRevision = 'failed-refresh'; this.store.clear(); this.discoveryStore.clear(); throw error; });"),
  M('auth-counter-increment-removed', "packages/core/src/index.ts",
    "if (work) work.authCalls++;",
    "void work;"),
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
  M('R-full-evidence-required-false', "packages/core/src/index.ts",
    "fullEvidenceRequired: !previousEvidence || !isDeepStrictEqual(previousEvidence, evidence) } }",
    "fullEvidenceRequired: false } }"),
  M('R-chain-delivered-zero', "packages/core/src/index.ts",
    "chainDeliveredCount: snapshot?.queryOverlay?.deliveredCount ?? 0,",
    "chainDeliveredCount: 0,"),
  M('R-no-candidate-json-guard', "packages/core/src/index.ts",
    "          assertDeliveryJson(candidate);\n",
    ""),
  M('R-capabilities-budget-dropped', "packages/core/src/index.ts",
    "}, budget, stats);",
    "}, {}, stats);"),
  M('R-capabilities-stats-not-shared', "packages/core/src/index.ts",
    "}, budget, stats);",
    "}, budget);"),
  M('R-admission-not-frozen', "packages/core/src/index.ts",
    "admission = freezeDeliveryState(this.admitV2(tool, raw));",
    "admission = this.admitV2(tool, raw);"),
  M('R-page-previous-is-current', "packages/core/src/index.ts",
    "render(this.store.get(cursor).value, this.currentQueryEvidence(value))",
    "render(this.store.get(cursor).value, this.currentQueryEvidence(this.store.get(cursor).value))"),
  M('R-trusted-sort-from-wire', "packages/core/src/index.ts",
    "return freezeDeliveryState({ ...invocation, era: delivery.era,",
    "return freezeDeliveryState({ ...invocation, ...(invocation.query && envelope.coverage.sort?.requested ? { query: { ...invocation.query, sort: [...envelope.coverage.sort.requested] } } : {}), era: delivery.era,"),
  M('R-trusted-resource-type-from-wire', "packages/core/src/index.ts",
    "return freezeDeliveryState({ ...invocation, era: delivery.era,",
    "return freezeDeliveryState({ ...invocation, ...(invocation.readTarget && Array.isArray((envelope.data as any).resources) && (envelope.data as any).resources[0] ? { readTarget: { resourceType: (envelope.data as any).resources[0].resourceType, id: (envelope.data as any).resources[0].id } } : {}), era: delivery.era,"),
  M('R01-shape-detection-restored', "packages/core/src/delivery.ts",
    "  if (tool === 'fhir_capabilities') return { text: `delivery_profile: \"full-text-v1\"\\n${jsonLine(envelope)}`, fellBack: true, deliveredProfile: 'full-text-v1' };\n",
    ""),
  M('R01-v2-trusted-tool-dropped', "packages/core/src/index.ts",
    "const first = evidenceRender(envelope as unknown as GatewayEnvelope, delivery.tool);",
    "const first = evidenceRender(envelope as unknown as GatewayEnvelope);"),
  M('R01-direct-metadata-tool-dropped', "packages/core/src/index.ts",
    "    const metadataDelivery = { ...delivery, tool: 'fhir_capabilities' as const };",
    "    const metadataDelivery = delivery;"),
  M('R05-runtime-emergency-normal-renderer', "packages/core/src/index.ts",
    "    const resultFor = () => {",
    "    const resultFor = () => {\n      if (this.candidateWorkV2.getStore()) return this.sdkResultV2(env, delivery);"),
  M('R05-runtime-emergency-normal-capture', "packages/core/src/index.ts",
    "    const capture = freezeDeliveryState({ ...invocation, era: delivery.era, deliveryProfile: 'full-text-v1' as const,",
    "    if (this.candidateWorkV2.getStore()) this.captureV2(env, delivery, invocation);\n    const capture = freezeDeliveryState({ ...invocation, era: delivery.era, deliveryProfile: 'full-text-v1' as const,"),
  M('R05-strict-emergency-removed-runtime', "packages/core/src/index.ts",
    "          if (!validateDeliverable02(tool, toWireValue(env), capture).ok) throw new GatewayFault('INTERNAL_ERROR', 'Emergency validation failed.');",
    "          // diagnostic: runtime emergency gate removed"),
  M('R06-read-clinical-count-removed', "packages/core/src/index.ts",
    "      const work = this.candidateWorkV2.getStore(); if (work) work.clinicalCalls++;\n",
    ""),
  M('R06-search-page-clinical-count-removed', "packages/core/src/index.ts",
    "    const work = this.candidateWorkV2.getStore(); if (work) work.clinicalCalls++;\n    const bundle =",
    "    const bundle ="),
  M('R06-constant-clinical-zero', "packages/core/src/index.ts",
    "clinicalCalls: work.clinicalCalls }, admission,",
    "clinicalCalls: 0 }, admission,"),
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
  M('R08-topic-reasons-open', "packages/core/src/contracts.ts",
    "      const metadataReasons = topic === 'schema' ? [schemaCaveat, 'MORE_DEFINITION_ELEMENTS']\n        : topic === 'server' ? [standing, 'CAPABILITY_SUMMARY_LIMIT']\n        : topic === 'search_parameter' || topic === 'support' ? [standing, 'MORE_PAGES'] : [standing];\n",
    "      const metadataReasons = [standing, schemaCaveat, 'MORE_PAGES', 'MORE_DEFINITION_ELEMENTS', 'CAPABILITY_SUMMARY_LIMIT'];\n"),
  M('R08-schema-caveat-not-required', "packages/core/src/contracts.ts",
    "      if (!c.reasons.includes(topic === 'schema' ? schemaCaveat : standing)) return fail();",
    "      if (topic !== 'schema' && !c.reasons.includes(standing)) return fail();"),
  M('R11-N05-removed', "packages/core/src/contracts.ts",
    "    if ((tool === 'fhir_search' || tool === 'fhir_page') && page?.has_more === false && c.reasons.includes('NON_CONTINUABLE_UPSTREAM_LINK')) return fail();\n",
    ""),
  M('R02-elapsed-reserve-removed', "packages/core/src/index.ts",
    "    const fit = () => {\n      // Fit against the largest safe elapsed integer, in the model copy and on the wire.\n      // finish writes the actual elapsed value only after metadata packing.\n      const elapsed = env.budget.elapsed_ms;\n      try { env.budget.elapsed_ms = Number.MAX_SAFE_INTEGER; this.bytesV2(env, metadataDelivery); return !exceedsByteBudget(env.budget); }\n      finally { env.budget.elapsed_ms = elapsed; this.bytesV2(env, metadataDelivery); }\n    };\n",
    "    const fit = () => { this.bytesV2(env, metadataDelivery); return !exceedsByteBudget(env.budget); };\n"),
  M('skip-final-measurement', "packages/core/src/index.ts",
    "const bytes = modelCopyBytes(result), wire = Buffer.byteLength(JSON.stringify(result));",
    "const bytes = envelope.budget.bytes_returned, wire = envelope.budget.wire_bytes;"),
  M('underreport-bytes', "packages/core/src/index.ts",
    "const bytes = modelCopyBytes(result), wire = Buffer.byteLength(JSON.stringify(result));",
    "const bytes = modelCopyBytes(result) - 1, wire = Buffer.byteLength(JSON.stringify(result));"),
  M('upgrade-delivery', "packages/core/src/index.ts",
    "profile: deliveryProfileForEra(this.config.delivery, era, this.testOptions?.testDeliveryRegistryOverride), serverIdentity: SERVER_IDENTITY",
    "profile: 'structured-evidence-v1', serverIdentity: SERVER_IDENTITY"),
  M('stale-text', "packages/core/src/index.ts",
    "    result.content[0]!.text = text;",
    "    result.content[0]!.text = 'stale';"),
  M('commit-pending-before-gate', "packages/core/src/index.ts",
    "        let committed = false;",
    "        let committed = true;"),
  M('final-bytes-recheck-removed', "packages/core/src/contracts.ts",
    "    if (measured !== env.budget.bytes_returned || measured > env.budget.byte_limit || measured > context.effectiveByteLimit! || env.budget.byte_limit > context.effectiveByteLimit!) return fail('INVALID_FINAL_BYTES');",
    "    // diagnostic: final byte guard removed"),
  M('context-handle', "packages/core/src/index.ts",
    "        if (input.context_handle !== undefined && input.context_handle !== this.contextId) throw new GatewayFault(tool === 'fhir_capabilities' && input.cursor ? 'DISCOVERY_EXPIRED' : 'CONTEXT_REQUIRED', 'Context does not match the trusted configured patient.');",
    "        // diagnostic: trusted context admission removed"),
  M('fault-warnings-restored', "packages/core/src/index.ts",
    "    envelope.warnings = [];\n    envelope.error = { code,",
    "    envelope.error = { code,"),
  M('expiry-repair-dropped', "packages/core/src/index.ts",
    "            if (repair) env.error!.repair = repair;",
    "            // diagnostic: fault repair removed"),
  M('continuation-type-from-input', "packages/core/src/index.ts",
    "const invocation = freezeDeliveryState({ ...this.invocationV2(admission, allowance.allowance), resourceType, metadata });",
    "const invocation = freezeDeliveryState({ ...this.invocationV2(admission, allowance.allowance), resourceType: (admission?.input as DispatchInput).resource_type, metadata });"),
  M('snapshot-recaptured', "packages/core/src/index.ts",
    "          const capture = this.captureV2(env, delivery, invocation);\n          const candidate = cloneFhirValue(env);\n          this.testOptions?.testEnvelopeCorruptor?.(candidate as unknown as GatewayEnvelope, phase);\n          assertDeliveryJson(candidate);",
    "          let capture = this.captureV2(env, delivery, invocation);\n          const candidate = cloneFhirValue(env);\n          this.testOptions?.testEnvelopeCorruptor?.(candidate as unknown as GatewayEnvelope, phase);\n          assertDeliveryJson(candidate);\n          capture = this.captureV2(candidate, delivery, invocation);"),
  M('trusted-query-from-wire', "packages/core/src/index.ts",
    "return freezeDeliveryState({ ...invocation, era: delivery.era,",
    "return freezeDeliveryState({ ...invocation, ...(invocation.query && envelope.coverage.constraints ? { query: { ...invocation.query, orderedPairs: envelope.coverage.constraints.map(({ name, value }) => ({ name, value })) } } : {}), era: delivery.era,"),
  M('rollback-discovery-removed', "packages/core/src/index.ts",
    "if (!committed) { restoreClinical(); restoreDiscovery(); }",
    "if (!committed) { restoreClinical(); }"),
  M('fallback-label-after-fit', "packages/core/src/index.ts",
    "      envelope.transform.delivery_profile = first.deliveredProfile;",
    "      envelope.transform.delivery_profile = delivery.profile;"),
  M('metadata-standing-reason-removed', "packages/core/src/contracts.ts",
    "      if (!c.reasons.includes(topic === 'schema' ? schemaCaveat : standing)) return fail();",
    "      if (topic === 'schema' && !c.reasons.includes(schemaCaveat)) return fail();"),
  M('metadata-open-reasons', "packages/core/src/contracts.ts",
    "      if (c.reasons.some(reason => !metadataReasons.includes(reason))) return fail();",
    "      // diagnostic: closed reason catalogue removed"),
  M('identity-ignored', "packages/core/src/index.ts",
    "_meta: { 'io.modelcontextprotocol/serverInfo': delivery.serverIdentity ?? SERVER_IDENTITY } } : {}) };\n  }\n\n  /** Count once: converge",
    "_meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_IDENTITY.name, version: '0.2.0-alpha.1' } } } : {}) };\n  }\n\n  /** Count once: converge"),
  M('admission-fault-unfitted', "packages/core/src/index.ts",
    "        const invocation = this.invocationV2(admission, allowance.allowance);\n        try {",
    "        if (!admission) throw fault;\n        const invocation = this.invocationV2(admission, allowance.allowance);\n        try {"),
  M('result-expiry-repair-dropped', "packages/core/src/repairs.ts",
    "  const template = REPAIR_TABLE[code as FaultCode];",
    "  if (code === 'RESULT_EXPIRED') return undefined;\n  const template = REPAIR_TABLE[code as FaultCode];"),
  M('g16-refusal-message-drift', "packages/core/src/index.ts",
    "    env.error!.safe_message = kind === 'unsupported_modifier' && work.upstreamCalls !== 0 ? MODIFIER_NO_CLINICAL_MESSAGE : REFUSAL_MESSAGES[kind]!;",
    "    env.error!.safe_message = 'Request failed.';"),
  M('H12-explicit-meta-loses-security-system', "packages/core/src/projection.ts",
    "  if (supplement.meta) result.meta = { ...existingMeta, ...supplement.meta };",
    "  if (supplement.meta) { result.meta = { ...existingMeta, ...supplement.meta }; if (existingMeta.security) (result.meta as Record<string, unknown>).security = (existingMeta.security as Record<string, unknown>[]).map(({ system: _system, ...coding }) => coding); }"),
  M('meta-nested-subsetted-lost', "packages/core/src/projection.ts",
    "? cloneFhirValue(tag) : cloneFhirValue((existingMeta.tag as unknown[])[index])",
    "? cloneFhirValue((existingMeta.tag as unknown[])[index]) : cloneFhirValue((existingMeta.tag as unknown[])[index])"),
  M('meta-residual-omissions-lost', "packages/core/src/projection.ts",
    "omitted: [...omitted, ...metaOmitted]",
    "omitted: [...omitted]"),
  M('update-shared-ledger-bypassed', "packages/core/src/store.ts",
    "      if (this.options.ledger && !this.options.ledger.makeRoom(additional())) throw this.retentionFault();",
    "      void this.options.ledger;"),
  M('update-freed-byte-credit-lost', "packages/core/src/store.ts",
    "      return delta - freed;",
    "      return delta;"),
  M('update-failure-does-not-restore', "packages/core/src/store.ts",
    "    } catch (error) { restore(); throw error; }",
    "    } catch (error) { throw error; }"),
  M('full-trusted-proof-check-removed', "packages/core/src/contracts.ts",
    "    if (c.constraints && (!q.constraintProof || q.constraintProof.length !== q.orderedPairs.length)) return fail('VALIDATION_CONTEXT_REQUIRED');\n    if (c.constraints && c.constraints.some((p, index) => p.execution !== q.constraintProof![index]!.execution\n      || p.evidence_ref !== q.constraintProof![index]!.evidence_ref)) return fail();\n    if (c.state === 'complete_for_query' && (!q.constraintProof || q.constraintProof.length !== q.orderedPairs.length\n      || q.constraintProof.some(p => p.execution === 'unknown' || (p.execution === 'tested_adapter' && !p.evidence_ref)))) return fail();\n",
    ""),
  M('H11-stale-trusted-proof', "packages/core/src/index.ts",
    "constraintProof: evidence.constraints.map(({ execution, evidence_ref })",
    "constraintProof: original!.constraints.map(({ execution, evidence_ref })"),
  M('retained-pagination-uses-clinical-cursor', "packages/evals/src/runner.ts",
    "  if (envelope.pagination) {",
    "  if (envelope.pagination) {\n    if ((envelope.pagination.has_more === true) !== Boolean(envelope.pagination.next_cursor)) add('pagination_invalid', 'retained control incorrectly requires clinical cursor');"),
  M('local-refusal-identity-lost', "packages/auth/src/token-provider.ts",
    "    if (error instanceof LocalWorkRefusal) return error;",
    ""),
  M('R1-wipe-epoch-and-stores', "packages/core/src/index.ts",
    "    if (error instanceof LocalWorkRefusal) return new GatewayFault('UPSTREAM_LIMIT', error.message);",
    "    if (error instanceof LocalWorkRefusal) { if (this.credentials!.invalidate()) { this.authEpoch++; this.invalidateState(); } return new GatewayFault('UPSTREAM_LIMIT', error.message); }"),
  M('private-profile-counted-as-public-pass', "packages/evals/src/runner.ts",
    "status: 'private_profile_control' as const, private_profile_verdict:",
    "status: verdict.status, private_profile_verdict:"),
  M('repair-reviewed-base-lost', "packages/core/src/index.ts",
    "return error instanceof GatewayFault && error.code === code && this.reviewedNamesV2().parameter(input.resource_type, base) ? base : undefined;",
    "return error instanceof GatewayFault && error.code === code && this.reviewedNamesV2().parameter(input.resource_type, base) ? undefined : undefined;"),
  M('foreign-patient-task-input-replaced', "packages/evals/data/m3b-query-tasks.json",
    "\"name\": \"link\",\n                \"value\": \"eval-patient-b\"",
    "\"name\": \"link\",\n                \"value\": \"eval-patient-a\""),
  M('R12-pending-list-extended', "packages/evals/src/runner.ts",
    "  'query-ignore-date-upper': 'A qualified profile must prove upper-date contradiction detection.',",
    "  'query-ignore-date-upper': 'A qualified profile must prove upper-date contradiction detection.',\n  'patient-link-bare-id-denied': 'A qualified profile must prove selector proof.',"),
  M('pending-hides-independent-checks', "packages/evals/src/runner.ts",
    "    if (pendingProfile && PROFILE_DEPENDENT_CHECKS[task.id]?.includes(check.id) && deepEqual(check, frozenProofCheck)) {",
    "    if (pendingProfile) {"),
  M('pending-tasks-execute-no-calls', "packages/evals/src/runner.ts",
    "for (const [index, step] of task.steps.entries()) {",
    "for (const [index, step] of (pendingProfile ? [] : task.steps.entries())) {"),
  M('R13-returned-matches-invariant-removed', "packages/core/src/contracts.ts",
    "      if (!page || page.returned_matches !== count || page.returned_includes !== 0) return fail();",
    "      if (!page || page.returned_includes !== 0) return fail();"),
  M('pre-admission-metadata-request', "packages/core/src/index.ts",
    "        admission = freezeDeliveryState(this.admitV2(tool, raw));",
    "        await this.transport.get(this.transport.url('metadata'), stats, budget);\n        admission = freezeDeliveryState(this.admitV2(tool, raw));", {"suites": ["unit", "isolation"]}),
  M('response-index-borrowing', "packages/evals/src/evidence-oracle.ts",
    "return call ? judge([call]) :",
    "return call ? judge(own) :"),
  M('rounded-7.0', "packages/core/src/decimal.ts",
    "return rawJsonHost.rawJSON(current.lexeme);",
    "return rawJsonHost.rawJSON(JSON.stringify(current.numberValue()));"),
  M('invented-proof', "packages/core/src/query.ts",
    "execution: enforced ? 'gateway_enforced' as const : tested ? 'tested_adapter' as const : 'unknown' as const,",
    "execution: enforced ? 'gateway_enforced' as const : tested ? 'tested_adapter' as const : 'gateway_enforced' as QueryEvidence['constraints'][number]['execution'],"),
  M('missing-controls', "packages/core/src/index.ts",
    "      env.coverage = assembled.coverage;",
    "      env.coverage = assembled.coverage; delete (env.coverage as any).query_exhausted;"),
  M('provenance-mistake', "packages/core/src/projection.ts",
    "({ resource_index, retrieved_at: record.retrievedAt })",
    "({ resource_index: resource_index + 1, retrieved_at: record.retrievedAt })"),
  M('CUR-discovery-to-clinical-accepted', "packages/core/src/index.ts",
    "    const cursor = input.cursor;",
    "    const cursor: string = (this.discoveryStore as any).items.has(input.cursor) ? [...(this.store as any).items.keys()].find((key: any) => key.startsWith('res_')) ?? input.cursor : input.cursor;", {"suites": ["unit", "isolation"]}),
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
  M('client-only-success', "packages/core/src/index.ts",
    "    return validateDeliverable02(tool, toWireValue(candidate), capture);",
    "    return { ok: typeof candidate.schema_version === 'string' };"),
  M('g16-message-drift', "packages/core/src/catalog.ts",
    "FILTER_EXECUTION_UNVERIFIED: 'Execution of one or more requested filters is not verified.'",
    "FILTER_EXECUTION_UNVERIFIED: 'Execution of one or more requested filters is not verified!'"),
  M('declared-only-claimed-complete', "packages/core/src/index.ts",
    "    if (coverage.state === 'complete_for_query' && coverage.query_evidence === 'declared_and_self_link_only') coverage.state = 'unknown';",
    ""),
  M('pending-treated-as-pass', "packages/evals/src/runner.ts",
    "pendingProfile && verdict.status === 'pass' ? { status: 'pending_profile_proof' as const }",
    "pendingProfile && verdict.status === 'pass' ? { status: 'pass' as const }"),
  M('PTH-03-egress', "packages/core/src/index.ts",
    "        admission = freezeDeliveryState(this.admitV2(tool, raw));",
    "        if (raw && typeof raw === 'object' && typeof (raw as any).source === 'string' && /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/$/.test((raw as any).source)) await fetch((raw as any).source);\n        admission = freezeDeliveryState(this.admitV2(tool, raw));", {"suites": ["unit", "isolation"]}),
  M('work-bound-removed', "packages/core/src/index.ts",
    "    if (work.upstreamCalls >= 20) { work.limitReached = true; throw new LocalWorkRefusal(); }",
    ""),
  M('S58-guidance-removed', "packages/server/src/index.ts",
    "description: TOOL_DESCRIPTIONS_V2[name],",
    "description: '',"),
  M('S58-bound-removed', "packages/core/src/catalog.ts",
    "  if (name === 'fhir_capabilities') {",
    "  delete propertyAt(schema, 'output.max_bytes').maximum;\n  if (name === 'fhir_capabilities') {"),
  M('S58-output-schema-removed', "packages/server/src/index.ts",
    "        outputSchema: minimalOutputSchema() as unknown as StandardSchemaWithJSON,",
    "        // diagnostic: output schema omitted."),
  M('S58-annotation-altered', "packages/server/src/index.ts",
    "annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }",
    "annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }"),
  M('S58-catalog-page-dropped', "packages/evals/src/catalog.ts",
    "  } while (cursor !== undefined);",
    "  } while (false);"),
  M('S58-identity-with-stale-capture', "packages/core/src/identity.ts",
    "version: packageJson.version",
    "version: packageJson.version + '-drift'", {"prepare": "contract"}),
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
  M('S5-M01-per-tool', "packages/core/src/contracts.ts",
    "const schema = toolEnvelopeV2Schemas[tool];",
    "const schema = envelopeV2Schema;"),
  M('S5-M03-authorization', "packages/core/src/contracts.ts",
    "    if (c.authorization_limited !== clinical || (clinical && !c.reasons.includes('CLINICAL_RECORD_COMPLETENESS_UNKNOWN'))) return fail();",
    ""),
  M('S5-M08-result-formats', "packages/core/src/contracts.ts",
    "    if (env.result && !unique(env.result.formats)) return fail();",
    ""),
  M('crossfield02-provenance-count', "packages/core/src/contracts.ts",
    "if ((env.provenance?.length ?? 0) !== count) return fail();",
    ""),
  M('crossfield02-cursor-has-more', "packages/core/src/contracts.ts",
    "if (tool !== 'fhir_result' && (page.has_more === true) !== (page.next_cursor !== undefined)) return fail();",
    ""),
  M('crossfield02-error-with-data', "packages/core/src/contracts.ts",
    "if (Object.keys(data).length || env.provenance !== undefined",
    "if (env.provenance !== undefined"),
  M('crossfield02-changed-page-shorthand', "packages/core/src/contracts.ts",
    "context?.query?.fullEvidenceRequired === true || ",
    ""),
  M('crossfield02-format-requested-format', "packages/core/src/contracts.ts",
    "if (context?.formatSupplied !== undefined && (t.requested_format !== (context.formatSupplied ? context.requestedFormat : undefined) || t.format !== (context.requestedFormat ?? 'fhir'))) return fail('VALIDATION_CONTEXT_MISMATCH');",
    ""),
  M('no-matches-on-terminal-after-delivery', "packages/core/src/index.ts",
    "deliveredCount: (overlay?.deliveredCount ?? 0) + call.deliveredCount,",
    "deliveredCount: call.deliveredCount,"),
  M('scan-limit-unenforced', "examples/observed-code-scan.ts",
    "(!discovery && report.clinicalPages >= limits.maxClinicalPages)",
    "false"),
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
  M('crossfield02-first-page-shorthand', "packages/core/src/contracts.ts",
    "tool !== 'fhir_page' || ",
    ""),
  // Per-property selection: selected local references retain contained evidence.
  M('S54-selected-local-contained', "packages/core/src/projection.ts",
    "if (source.contained && Object.entries(result).some(([key, value]) => key !== 'contained' && localReference(value))) {",
    "if (source.contained && Object.entries(result).some(([key, value]) => key !== 'contained' && localReference(value)) && Boolean(0)) {"),
  // The gate must reject a permutation of the full constraint list, not only changed values.
  M('crossfield02-constraint-order-insensitive', "packages/core/src/contracts.ts",
    "    if (c.constraints && JSON.stringify(c.constraints.map(p => ({ name: p.name, value: p.value }))) !== JSON.stringify(pairs)) return fail('VALIDATION_CONTEXT_MISMATCH');",
    "    if (c.constraints && JSON.stringify([...c.constraints.map(p => ({ name: p.name, value: p.value }))].sort((a, b) => `${a.name}=${a.value}`.localeCompare(`${b.name}=${b.value}`))) !== JSON.stringify([...pairs].sort((a, b) => `${a.name}=${a.value}`.localeCompare(`${b.name}=${b.value}`)))) return fail('VALIDATION_CONTEXT_MISMATCH');"),
  // The evidence kind is no longer bound to the trusted proof when no constraint list is disclosed.
  M('crossfield02-proof-kind-unbound', "packages/core/src/contracts.ts",
    "      if (c.query_evidence === 'exact_id_and_subject_linkage' && (!proof.length || proof.some(p => p.execution !== 'gateway_enforced'))) return fail();",
    "      if (c.query_evidence === 'exact_id_and_subject_linkage' && Boolean(0) && (!proof.length || proof.some(p => p.execution !== 'gateway_enforced'))) return fail();"),
  // The unverified-filter caveat may be dropped while the trusted proof says unknown.
  M('crossfield02-proof-caveat-unbound', "packages/core/src/contracts.ts",
    "      if (proof.some(p => p.execution === 'unknown') && (!c.reasons.includes('FILTER_EXECUTION_UNVERIFIED') || !env.warnings.some(w => w.code === 'FILTER_EXECUTION_UNVERIFIED'))) return fail();",
    "      if (proof.some(p => p.execution === 'unknown') && Boolean(0) && (!c.reasons.includes('FILTER_EXECUTION_UNVERIFIED') || !env.warnings.some(w => w.code === 'FILTER_EXECUTION_UNVERIFIED'))) return fail();"),
  // A tested_adapter claim is no longer bound to the trusted proof when no constraint list is disclosed.
  M('crossfield02-proof-tested-unbound', "packages/core/src/contracts.ts",
    "      if (c.query_evidence === 'tested_adapter' && (!proof.some(p => p.execution === 'tested_adapter') || proof.some(p => p.execution === 'unknown'))) return fail();",
    "      if (c.query_evidence === 'tested_adapter' && Boolean(0) && (!proof.some(p => p.execution === 'tested_adapter') || proof.some(p => p.execution === 'unknown'))) return fail();"),
  // Collapse computed from the snapshot records instead of the finally selected ones (undelivered records counted).
  M('collapse-counts-undelivered', "packages/core/src/index.ts",
    "        withheld_payloads: collapseWithheld(selected.map(item => item.record)),\n",
    "        withheld_payloads: collapseWithheld(records),\n"),
  // Attachment and payload entries merge like policy entries.
  M('collapse-merges-attachment', "packages/core/src/withheld.ts",
    "      if (!classified || origins![i] !== 'policy' || !keyOnly(manifest)) { delivered.push(manifest); return; }",
    "      if (!classified || origins![i] === 'link_text' || !keyOnly(manifest)) { delivered.push(manifest); return; }"),
  // Duplicates disappear without a count (the first entry stays a singleton).
  M('collapse-drops-count', "packages/core/src/withheld.ts",
    "      if (!seen.entry) { seen.entry = { path: manifest.path, reason: manifest.reason, count: 2 }; delivered[seen.index] = seen.entry; return; }\n      seen.entry.count += 1;",
    "      if (!seen.entry) { seen.entry = { path: manifest.path, reason: manifest.reason, count: 2 }; return; }\n      seen.entry.count += 1;"),
  // Same-path entries with different reasons merge (one reason disappears from both channels).
  M('collapse-drops-reason', "packages/core/src/withheld.ts",
    "      const key = `${manifest.path}\\u0000${manifest.reason}`;",
    "      const key = manifest.path;"),
  // The gate accepts a singleton collapse count.
  M('gate-count-singleton', "packages/core/src/contracts.ts",
    "    if (t.withheld_payloads.some(m => m.count !== undefined && ((m.count as number) < 2 || Object.keys(m).length !== 3))) return fail();",
    "    if (t.withheld_payloads.some(m => m.count !== undefined && ((m.count as number) < 1 || Object.keys(m).length !== 3))) return fail();"),
  // The gate accepts a count on a payload or in-text-link reason.
  M('gate-count-on-payload-reason', "packages/core/src/contracts.ts",
    "    if (t.withheld_payloads.some(m => m.count !== undefined && ['V1_PAYLOAD_WITHHELD', 'PROTECTED_LINK_IN_TEXT'].includes(m.reason as string))) return fail();",
    "    if (t.withheld_payloads.some(m => m.count !== undefined && Boolean(0) && ['V1_PAYLOAD_WITHHELD', 'PROTECTED_LINK_IN_TEXT'].includes(m.reason as string))) return fail();"),
  // The gate accepts the same collapsed {path, reason} pair twice.
  M('gate-counted-pair-duplicate', "packages/core/src/contracts.ts",
    "    if (!unique(t.withheld_payloads.filter(m => m.count !== undefined).map(m => `${m.path}\\u0000${m.reason}`))) return fail();",
    "    if (Boolean(0) && !unique(t.withheld_payloads.filter(m => m.count !== undefined).map(m => `${m.path}\\u0000${m.reason}`))) return fail();"),
  // Payload entries are tagged policy at the creation site and merge.
  M('origin-payload-as-policy', "packages/core/src/privacy.ts",
    "return withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, metadata(), 'payload');",
    "return withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, metadata(), 'policy');"),
  // Links inside a schema-declared Attachment are tagged policy and merge.
  M('origin-attachment-link-as-policy', "packages/core/src/privacy.ts",
    "const linkOrigin: ManifestOrigin = inAttachment ? 'attachment' : attachment || !element.types.length ? 'unknown' : 'policy';",
    "const linkOrigin: ManifestOrigin = !element.types.length ? 'unknown' : 'policy';"),
  // A withheld link at a site with no schema element is tagged policy and merges.
  M('origin-unknown-site-as-policy', "packages/core/src/privacy.ts",
    "const linkOrigin: ManifestOrigin = inAttachment ? 'attachment' : attachment || !element.types.length ? 'unknown' : 'policy';",
    "const linkOrigin: ManifestOrigin = inAttachment ? 'attachment' : attachment ? 'unknown' : 'policy';"),
  // An attachment context inferred from shape or path spelling alone classifies the link as policy.
  M('origin-spelling-attachment-as-policy', "packages/core/src/privacy.ts",
    "const linkOrigin: ManifestOrigin = inAttachment ? 'attachment' : attachment || !element.types.length ? 'unknown' : 'policy';",
    "const linkOrigin: ManifestOrigin = inAttachment ? 'attachment' : !element.types.length ? 'unknown' : 'policy';"),
  // Companions withheld under an undeclared node are tagged policy and merge.
  M('origin-companion-unknown-as-policy', "packages/core/src/privacy.ts",
    "const childOrigin: ManifestOrigin = childElement.types.length ? 'policy' : 'unknown';",
    "const childOrigin: ManifestOrigin = 'policy';"),
  // The text channel repeats the count inside the quoted JSON (double-counted text).
  M('text-double-counted', "packages/core/src/delivery.ts",
    "      ? `withheld x${count}: ${jsonLine(rest)}` : `withheld: ${jsonLine(manifest)}`;",
    "      ? `withheld x${count}: ${jsonLine(manifest)}` : `withheld: ${jsonLine(manifest)}`;"),
  // A requested sort no longer requires a trusted sort proof in the context.
  M('crossfield02-sort-proof-not-required', "packages/core/src/contracts.ts",
    "    if (q.sort.length > 0 && !q.sortProof) return fail('VALIDATION_CONTEXT_REQUIRED');",
    "    if (q.sort.length > 0 && Boolean(0) && !q.sortProof) return fail('VALIDATION_CONTEXT_REQUIRED');"),
  // The disclosed sort order/effective keys are not bound to the trusted sort proof.
  M('crossfield02-sort-proof-unbound', "packages/core/src/contracts.ts",
    "    if (c.sort && q.sortProof && (c.sort.order !== q.sortProof.order || JSON.stringify(c.sort.effective ?? null) !== JSON.stringify(q.sortProof.effective ?? null))) return fail();",
    "    if (c.sort && Boolean(0) && q.sortProof && (c.sort.order !== q.sortProof.order || JSON.stringify(c.sort.effective ?? null) !== JSON.stringify(q.sortProof.effective ?? null))) return fail();"),
  // The declared kind is accepted on a fully proved non-empty set (mixed-proof rule loosened).
  M('crossfield02-declared-with-full-proof', "packages/core/src/contracts.ts",
    "      if (c.query_evidence === 'declared_and_self_link_only' && proof.length > 0 && !proof.some(p => p.execution === 'unknown')) return fail();",
    "      if (c.query_evidence === 'declared_and_self_link_only' && Boolean(0) && proof.length > 0 && !proof.some(p => p.execution === 'unknown')) return fail();"),
  // The trusted invocation state omits the sort proof.
  M('invocation-sort-proof-dropped', "packages/core/src/index.ts",
    "          ...(evidence.sort ? { sortProof: { order: evidence.sort.order, effective: evidence.sort.effective ? [...evidence.sort.effective] : null } } : {}),",
    "          ...(evidence.sort && Boolean(0) ? { sortProof: { order: evidence.sort.order, effective: evidence.sort.effective ? [...evidence.sort.effective] : null } } : {}),"),
  // A proved continuation is still labelled unverified_continuation (chains can never complete).
  M('continuation-verified-label-dropped', "packages/core/src/index.ts",
    "queryEvidenceKind: verifySelf || !chainUnverified ? 'declared_and_self_link_only' : 'unverified_continuation',",
    "queryEvidenceKind: verifySelf || (!chainUnverified && Boolean(0)) ? 'declared_and_self_link_only' : 'unverified_continuation',"),
  // A continued page without a reported self link is treated as verified.
  M('continuation-verified-without-self-link', "packages/core/src/index.ts",
    "const selfPagingMatches = !previous || (reported !== null",
    "const selfPagingMatches = !previous || reported === null || (reported !== null"),
  // A recorded capability revision no longer binds the profile to the discovered source.
  M('profile-revision-unbound', "packages/core/src/query.ts",
    "  if (profile.evidence?.capability_revision !== undefined && capability.revision !== profile.evidence.capability_revision) return undefined;",
    "  if (Boolean(0) && profile.evidence?.capability_revision !== undefined && capability.revision !== profile.evidence.capability_revision) return undefined;"),
  // The config enum admits a declared but ineligible profile.
  M("config-enum-not-derived", "packages/core/src/index.ts",
    "searchProfile: z.enum(eligibleSearchProfileIds() as [string, ...string[]]).optional(),",
    "searchProfile: z.enum(['test-ineligible-hapi-r4', ...eligibleSearchProfileIds()] as [string, ...string[]]).optional(),"),
  // The eval runner uses a qualified profile whose recorded fixture digest no longer matches what it serves.
  M('eval-profile-drift-unchecked', "packages/evals/src/runner.ts",
    "  if (profile.source.fixture_sha256 !== expectedProfileHashes.fixture) return",
    "  if (profile.source.fixture_sha256 !== expectedProfileHashes.fixture && Boolean(0)) return"),
  // The continuation offset is not bound to the previous page's offset plus returned entries.
  M('continuation-offset-arithmetic-unchecked', "packages/core/src/index.ts",
    "    const offsetConsistent = !previous || pageOffset === (previous.queryOverlay?.pageOffset ?? 0) + (previous.queryOverlay?.pageEntries ?? 0);",
    "    const offsetConsistent = !previous || Boolean(1) || pageOffset === (previous.queryOverlay?.pageOffset ?? 0) + (previous.queryOverlay?.pageEntries ?? 0);"),
  // The continued page's self link is not required to carry this request's offset.
  M('continuation-self-paging-unchecked', "packages/core/src/index.ts",
    "    const selfPagingMatches = !previous || (reported !== null && selfOffsets.length === 1 && selfOffsets[0]!.value === url.searchParams.get('_offset')",
    "    const selfPagingMatches = !previous || Boolean(1) || (reported !== null && selfOffsets.length === 1 && selfOffsets[0]!.value === url.searchParams.get('_offset')"),
  // The unverified-continuation flag is recomputed per page instead of staying sticky.
  M('continuation-flag-not-sticky', "packages/core/src/index.ts",
    "    const chainUnverified = Boolean(previous) && (Boolean(previous!.queryOverlay?.continuationUnverified) || !continuationVerified);",
    "    const chainUnverified = Boolean(previous) && !continuationVerified;"),
  // The gate does not bind the sticky chain flag.
  M('crossfield02-continuation-flag-unbound', "packages/core/src/contracts.ts",
    "    if (q.continuationUnverified && c.scope === 'page' && (c.query_evidence !== 'unverified_continuation' || c.state === 'complete_for_query')) return fail();",
    "    if (q.continuationUnverified && Boolean(0) && c.scope === 'page' && (c.query_evidence !== 'unverified_continuation' || c.state === 'complete_for_query')) return fail();"),
  // A sort claim on a non-chain envelope is accepted.
  M('crossfield02-sort-without-chain', "packages/core/src/contracts.ts",
    "c.constraints_on_first_page !== undefined || c.sort !== undefined)) return fail('VALIDATION_CONTEXT_REQUIRED');",
    "c.constraints_on_first_page !== undefined)) return fail('VALIDATION_CONTEXT_REQUIRED');"),
  // The discovered identity drops the capability revision (the qualified profile would bind to nothing).
  M('identity-revision-dropped', "packages/core/src/index.ts",
    "  return { digested: true, software: bounded(software?.name), softwareVersion: bounded(software?.version), fhirVersion, revision };",
    "  return { digested: true, software: bounded(software?.name), softwareVersion: bounded(software?.version), fhirVersion, revision: Boolean(0) ? revision : undefined };"),
  // A shipped eligible profile may claim proof without a recorded capability revision.
  M('registry-revision-invariant-skipped', "packages/core/src/query.ts",
    "    if (profile.eligible && claimsProof && !(typeof profile.evidence?.capability_revision === 'string' && profile.evidence.capability_revision.length > 0)) {",
    "    if (profile.eligible && claimsProof && Boolean(0) && !(typeof profile.evidence?.capability_revision === 'string' && profile.evidence.capability_revision.length > 0)) {"),
  // Sub-millisecond instants tie at the millisecond; each guard that refuses to compare, prove or order them is anchored.
  M('date-subms-equality-decided', "packages/core/src/query.ts",
    "  if (search.subMillisecond || target.subMillisecond) return undefined;",
    "  if (Boolean(0) && (search.subMillisecond || target.subMillisecond)) return undefined;"),
  M('date-subms-variant-proved', "packages/core/src/query.ts",
    "    return prefix !== 'ap' && allowedPrefixes.has(prefix) && interval !== undefined && !interval.subMillisecond;",
    "    return prefix !== 'ap' && allowedPrefixes.has(prefix) && interval !== undefined;"),
  M('sort-subms-ordered', "packages/core/src/query.ts",
    "    if (effective.subMillisecond) return { outcome: { status: 'unverifiable', parameter: 'date', variant: 'sub-millisecond-precision' } };",
    "    if (effective.subMillisecond && Boolean(0)) return { outcome: { status: 'unverifiable', parameter: 'date', variant: 'sub-millisecond-precision' } };"),
  // Records with effectiveInstant are accepted by the proved descending-effectiveDateTime sort variant.
  M('sort-instant-variant-accepted', "packages/core/src/query.ts",
    "    if (effective.kind !== 'interval' || effective.variant !== 'dateTime' || !effective.timezoneQualified || !effective.instantPrecision) {",
    "    if (effective.kind !== 'interval' || !effective.timezoneQualified || !effective.instantPrecision) {"),
  // Killing test: G-BACKEND loopback confinement and redirects refuse before contacting an unsafe destination.
  M("gbackend-loopback-unchecked", "packages/evals/src/external.ts",
    "return new FhirTransport(baseUrl, MAX_BYTES, REQUEST_MS);",
    "return new FhirTransport(HAPI_BASE_URL, MAX_BYTES, REQUEST_MS);", { suites: ['unit'] }),
  // Killing test: G-BACKEND loopback confinement and redirects refuse before contacting an unsafe destination.
  M("gbackend-request-url-unchecked", "packages/evals/src/external.ts",
    "const url = this.transport.validate(value);",
    "const url = new URL(value, this.transport.base);", { suites: ['unit'] }),
  // Killing test: G-BACKEND loopback confinement and redirects refuse before contacting an unsafe destination.
  C('gbackend-redirect-admitted', [
    { file: 'packages/evals/src/external.ts', find: "    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); refuse('redirect'); }\n", replace: '' },
    { file: 'packages/evals/src/external.ts', find: 'if (!response.ok) {', replace: 'if (!response.ok && response.status !== 302) {' },
  ], { suites: ['unit'] }),
  // Killing test: G-BACKEND bounded client refuses oversized and malformed responses without payload diagnostics.
  M("gbackend-response-size-unbounded", "packages/evals/src/external.ts",
    "if (bytes > MAX_BYTES) { await reader.cancel(); refuse('response-size'); }",
    "if (Boolean(0) && bytes > MAX_BYTES) { await reader.cancel(); refuse('response-size'); }", { suites: ['unit'] }),
  // Killing test: G-BACKEND strict round-trip comparator ignores only documented server metadata.
  M("gbackend-roundtrip-comparator-bypassed", "packages/evals/src/external.ts",
    "return canonicalJson(normalize(expected, false)) === canonicalJson(normalize(actual, true));",
    "return true;", { suites: ['unit'] }),
  // Killing test: G-BACKEND transaction PUT loader reads every body and preserves fixed identities.
  M("gbackend-roundtrip-read-unchecked", "packages/evals/src/external.ts",
    "    if (!compareExternalResource(resource, actual)) refuse('round-trip-mismatch');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND hermetic census refuses foreign, missing, duplicate and changed records.
  M("gbackend-census-extra-ignored", "packages/evals/src/external.ts",
    "if (!expected.has(key)) refuse('census-extra-resource');",
    "if (!expected.has(key)) continue;", { suites: ['unit'] }),
  // Killing test: G-BACKEND hermetic census refuses foreign, missing, duplicate and changed records.
  M("gbackend-census-duplicate-ignored", "packages/evals/src/external.ts",
    "if (seen.has(key)) refuse('census-duplicate-resource');",
    "if (seen.has(key)) continue;", { suites: ['unit'] }),
  // Killing test: G-BACKEND hermetic census refuses foreign, missing, duplicate and changed records.
  M("gbackend-census-content-unchecked", "packages/evals/src/external.ts",
    "        if (!compareExternalResource(expected.get(key)!, resource)) refuse('census-resource-mismatch');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND hermetic census refuses foreign, missing, duplicate and changed records.
  M("gbackend-census-missing-accepted", "packages/evals/src/external.ts",
    "  if (requireComplete && (seen.size !== expected.size || [...expected.keys()].some(key => !seen.has(key)))) refuse('census-missing-resource');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND census binds totals and rejects unsafe, duplicate or endless next links.
  M("gbackend-census-total-inconsistent", "packages/evals/src/external.ts",
    "        if (!Number.isSafeInteger(bundle.total) || Number(bundle.total) < 0 || (declaredTotal !== undefined && declaredTotal !== bundle.total)) refuse('census-total');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND census binds totals and rejects unsafe, duplicate or endless next links.
  M("gbackend-census-total-count-unchecked", "packages/evals/src/external.ts",
    "    if (declaredTotal !== undefined && declaredTotal !== typeCount) refuse('census-total-count');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND prepared inputs are immutable owned snapshots and unprepared sources cannot run.
  M("gbackend-prepared-corpus-mutable", "packages/evals/src/external.ts",
    "  freeze(copy);",
    "  /* Mutant: nested corpus is mutable. */", { suites: ['unit'] }),
  // Killing test: G-BACKEND applicability is total stable and fails closed on task or classification drift.
  M("gbackend-applicability-not-total", "packages/evals/src/external.ts",
    "  if (byId.size !== rows.length || tasks.length !== rows.length || new Set(tasks.map(task => task.id)).size !== tasks.length) refuse('applicability-not-total');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND applicability is total stable and fails closed on task or classification drift.
  M("gbackend-applicability-task-unbound", "packages/evals/src/external.ts",
    "if (!row || row.task_sha256 !== externalHash(task) || row.corpus !== (task.corpus ?? 'baseline')) refuse('applicability-task-drift');",
    "if (!row || row.corpus !== (task.corpus ?? 'baseline')) refuse('applicability-task-drift');", { suites: ['unit'] }),
  // Killing test: G-BACKEND applicability is total stable and fails closed on task or classification drift.
  M("gbackend-applicability-assignment-unbound", "packages/evals/src/external.ts",
    "  if (externalHash([...rows].sort((a, b) => a.task_id.localeCompare(b.task_id))) !== 'c1c134e0c9ca82009aaa97da82c07f7775cf90dd831692aae6a1775f82349cdc') refuse('applicability-assignment-drift');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND external selection excludes fixture simulations and refuses altered or unknown tasks.
  M("gbackend-simulations-selected", "packages/evals/src/external.ts",
    "return selected.filter(task => applicability.some(row => row.task_id === task.id && row.classification === 'real-backend'));",
    "return [...selected];", { suites: ['unit'] }),
  // Killing test: G-BACKEND external selection excludes fixture simulations and refuses altered or unknown tasks.
  M("gbackend-selected-task-unbound", "packages/evals/src/external.ts",
    "  if (selected.some(task => !applicability.some(row => row.task_id === task.id && row.task_sha256 === externalHash(task)))) refuse('external-task-selection');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND every discovered envelope binds the measured capability revision during a run.
  M("gbackend-envelope-revision-unbound", "packages/evals/src/external.ts",
    "return (error && revision === 'unknown') || revision === expected;",
    "return true;", { suites: ['unit'] }),
  // Killing test: G-BACKEND external eligible registry requires each independent binding.
  M("gbackend-registry-software-unbound", "packages/core/src/query.ts",
    "      if (!profile.source.software || !profile.source.software_version || profile.source.fhir_version !== '4.0.1') throw new Error('External profile requires exact software, version and FHIR identity.');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND external eligible registry requires each independent binding.
  M("gbackend-registry-image-unbound", "packages/core/src/query.ts",
    "      if (!/^sha256:[a-f0-9]{64}$/.test(profile.source.image_digest ?? '')) throw new Error('External profile requires image_digest.');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND external eligible registry requires each independent binding.
  M("gbackend-registry-corpus-unbound", "packages/core/src/query.ts",
    "      if (!/^[a-f0-9]{64}$/.test(profile.source.corpus_sha256 ?? '')) throw new Error('External profile requires corpus_sha256.');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND external eligible registry requires each independent binding.
  M("gbackend-registry-tasks-unbound", "packages/core/src/query.ts",
    "      if (!/^[a-f0-9]{64}$/.test(profile.evidence?.tasks_sha256 ?? '')) throw new Error('External profile requires tasks_sha256.');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND external eligible registry requires each independent binding.
  M("gbackend-registry-evidence-unbound", "packages/core/src/query.ts",
    "      if (!profile.evidence?.capability_revision || !/^[a-f0-9]{64}$/.test(profile.evidence?.report_sha256 ?? '') || !Number.isFinite(Date.parse(profile.evidence?.recorded_at ?? ''))) throw new Error('External profile requires complete recorded evidence.');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND source binding uses exact keyed software version FHIR and revision with no external wildcard.
  M("gbackend-external-runtime-wildcard", "packages/core/src/query.ts",
    "  if (profile.source.kind === 'external' && (!profile.source.software_version || (profile.eligible && !profile.evidence?.capability_revision))) return undefined;\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-drift-software-unchecked", "packages/evals/src/runner.ts",
    "    if (profile.source.software !== external.software) return 'software drift';\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-drift-software-version-unchecked", "packages/evals/src/runner.ts",
    "    if (profile.source.software_version !== external.software_version) return 'software_version drift';\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-drift-fhir-version-unchecked", "packages/evals/src/runner.ts",
    "    if (profile.source.fhir_version !== external.fhir_version) return 'fhir_version drift';\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-drift-image-digest-unchecked", "packages/evals/src/runner.ts",
    "    if (profile.source.image_digest !== external.image_digest) return 'image_digest drift';\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-drift-corpus-sha256-unchecked", "packages/evals/src/runner.ts",
    "    if (profile.source.corpus_sha256 !== external.corpus_sha256) return 'corpus_sha256 drift';\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-drift-capability-revision-unchecked", "packages/evals/src/runner.ts",
    "    if (profile.evidence?.capability_revision !== external.capability_revision) return 'capability_revision drift';\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-drift-tasks-sha256-unchecked", "packages/evals/src/runner.ts",
    "    if (profile.evidence?.tasks_sha256 !== external.tasks_sha256) return 'tasks_sha256 drift';\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-drift-identity-missing", "packages/evals/src/runner.ts",
    "if (!external) return 'external identity missing';",
    "if (!external) return undefined;", { suites: ['unit'] }),
  // Killing test: G-BACKEND external eval refuses every identity drift and never accepts a synthetic binding.
  M("gbackend-synthetic-binding-accepted", "packages/evals/src/runner.ts",
    "  if (external) return 'synthetic profile cannot prove an external backend';\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-task-denominator-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (externalHash(observed) !== externalHash(expected)) problems.push('task-arm denominator differs from independently expected applicability');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-control-denominator-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (externalHash(controls.map(row => `${row.task_id}/${row.arm}`).sort()) !== externalHash(controlKeys) || controlKeys.length === 0) problems.push('private-control denominator differs from independently expected tasks times arms');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-control-verdict-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (controls.some(row => row.private_profile_verdict !== 'pass' || row.failures.length > 0 || row.checks.some(check => check.status === 'fail' || check.status === 'pending_profile_proof'))) problems.push('private controls failed');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-control-label-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (controls.some(row => row.query_profile.id !== candidateId || !row.query_profile.private || row.calls.length === 0 || row.calls.some(call => call.query_profile.id !== candidateId || !call.query_profile.private))) problems.push('private controls mislabelled');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-pending-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (report.summary.pending_profile_proof.length || report.results.some(row => row.status === 'pending_profile_proof' || row.checks.some(check => check.status === 'pending_profile_proof'))) problems.push('pending profile proof');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-public-failures-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (report.results.some(row => row.status !== 'private_profile_control' && (row.status !== 'pass' || row.failures.length)) || Object.keys(report.summary.failures_by_cause).length) problems.push('public run not clean');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-byte-accounting-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (report.summary.byte_accounting.under_reported_calls || report.summary.byte_accounting.over_reported_calls) problems.push('independent byte accounting failed');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-identity-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (externalHash(report.external_backend?.identity) !== externalHash(identity)) problems.push('external identity changed');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND qualification independently requires exact controls all arms zero pending clean public rows and identity.
  M("gbackend-qualification-applicability-unchecked", "packages/evals/src/external-qualification.ts",
    "  if (externalHash(report.external_backend?.applicability) !== externalHash(externalApplicability())) problems.push('applicability report changed');\n",
    "", { suites: ['unit'] }),
  // Killing test: G-BACKEND opaque continuation rejects unissued tokens without provenance.
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
  // Quickstart helper leaf guards. Unit suite only.
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
  // Synthea transform guards; each killed by a named test in tests/quickstart-transform.test.ts. Unit suite only.
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
  // Ignore the target of a tracked symlink. Killing test: candidate binding binds symlink targets without following them
  M('s7-binding-symlink-target-unbound', 'scripts/mutation-guards.mjs', '      hash.update(`${Buffer.byteLength(path)}:${path}symlink:${target.length}:`).update(target);\n', '      hash.update(`${Buffer.byteLength(path)}:${path}symlink:`);\n', { suites: ['unit'] }),
  // Treat a tracked symlink as an ordinary file. Killing test: candidate binding binds symlink targets without following them
  M('s7-binding-symlink-followed', 'scripts/mutation-guards.mjs', '    if ((await lstat(join(checkout, path))).isSymbolicLink()) {\n', '    if (false) {\n', { suites: ['unit'] }),
  // Bind a dangling symlink instead of failing closed. Killing test: candidate binding records tracked deletions distinctly from empty files and other paths
  M('s7-binding-symlink-dangling', 'scripts/mutation-guards.mjs', '      await stat(join(checkout, path));\n', '', { suites: ['unit'] }),
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
  // Quickstart edge-merge guards; each killed by a named test in tests/quickstart-edges.test.ts or tests/quickstart-fixtures.test.ts. Unit suite only.
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
  // Evidence-oracle kernel guards; each killed by a named test in tests/package-oracle.test.ts or the pure oracle tests. Unit suite only. citation-index-dropped and response-index-borrowing are anchored in evidence-oracle.ts.
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
  // Transform provider-sanitisation and seed-contract guards; each killed by a named test in tests/quickstart-transform.test.ts or tests/quickstart-edges.test.ts. Unit suite only.
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
  // Provider sanitisation: closed provider shapes and the residue inventory; unit suite only.
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
  // Quickstart seed terminology step (scripts/quickstart/terminology.ts) and the edge merge's restricted-terminology refusals. Unit suite only.
  // tq-step-disabled: Killing test: quickstart terminology: Encounter type and reasonCode codings, in the system or OID form, become numbered example.invalid codings with the text following
  M("tq-step-disabled", "scripts/quickstart/terminology.ts", "  const result = replaceEncounterTerminology(bodies);", "  const result: TerminologyResult = { resources: bodies, replacedCodings: 0, replacedTexts: 0 };", { suites: ['unit'] }),
  // tq-oid-form: Killing test: quickstart terminology: Encounter type and reasonCode codings, in the system or OID form, become numbered example.invalid codings with the text following
  M("tq-oid-form", "scripts/quickstart/terminology.ts", "const restricted = (system: unknown) => system === SYSTEM_URI || system === SYSTEM_OID;", "const restricted = (system: unknown) => system === SYSTEM_URI;", { suites: ['unit'] }),
  // tq-text-dropped: Killing test: quickstart terminology: Encounter type and reasonCode codings, in the system or OID form, become numbered example.invalid codings with the text following
  M("tq-text-dropped", "scripts/quickstart/terminology.ts", "removed.add(concept.text); replaced.text = first; replacedTexts++;", "removed.add(concept.text); delete replaced.text; replacedTexts++;", { suites: ['unit'] }),
  // tq-text-kept: Killing test: quickstart terminology: Encounter type and reasonCode codings, in the system or OID form, become numbered example.invalid codings with the text following
  M("tq-text-kept", "scripts/quickstart/terminology.ts", "removed.add(concept.text); replaced.text = first; replacedTexts++;", "replacedTexts++;", { suites: ['unit'] }),
  // tq-stable-numbering: Killing test: quickstart terminology: Encounter type and reasonCode codings, in the system or OID form, become numbered example.invalid codings with the text following
  M("tq-stable-numbering", "scripts/quickstart/terminology.ts", "let n = numbering[field].get(c.code);", "let n: number | undefined;", { suites: ['unit'] }),
  // tq-separate-numbering: Killing test: quickstart terminology: Encounter type and reasonCode codings, in the system or OID form, become numbered example.invalid codings with the text following
  M("tq-separate-numbering", "scripts/quickstart/terminology.ts", "const numbering = { type: new Map<string, number>(), reasonCode: new Map<string, number>() };", "const shared = new Map<string, number>(), numbering = { type: shared, reasonCode: shared };", { suites: ['unit'] }),
  // tq-field-scope: Killing test: quickstart terminology: Encounter type and reasonCode codings, in the system or OID form, become numbered example.invalid codings with the text following
  M("tq-field-scope", "scripts/quickstart/terminology.ts", "for (const field of ['type', 'reasonCode'] as const) {", "for (const field of ['type'] as const) {", { suites: ['unit'] }),
  // tq-input-hash: Killing test: quickstart terminology: Encounter type and reasonCode codings, in the system or OID form, become numbered example.invalid codings with the text following
  M("tq-input-hash", "scripts/quickstart/terminology.ts", "input_ndjson_sha256: seed.manifest.ndjson_sha256,", "input_ndjson_sha256: sha256(ndjson),", { suites: ['unit'] }),
  // tq-row-hash: Killing test: quickstart terminology: Encounter type and reasonCode codings, in the system or OID form, become numbered example.invalid codings with the text following
  M("tq-row-hash", "scripts/quickstart/terminology.ts", "sha256: sha256(written[i]!) }));", "sha256: row.sha256 }));", { suites: ['unit'] }),
  // tq-tallies: Killing test: quickstart terminology: Encounter type and reasonCode codings, in the system or OID form, become numbered example.invalid codings with the text following
  M("tq-tallies", "scripts/quickstart/terminology.ts", "replaced_codings: result.replacedCodings, replaced_texts: result.replacedTexts", "replaced_codings: result.replacedCodings + result.replacedTexts, replaced_texts: result.replacedTexts", { suites: ['unit'] }),
  // tq-unmapped: Killing test: quickstart terminology: restricted terminology outside Encounter type and reasonCode refuses as unmapped
  M("tq-unmapped", "scripts/quickstart/terminology.ts", "  if (out.some(resource => restrictedTerminology(resource))) fault('TERMINOLOGY_UNMAPPED');\n", "", { suites: ['unit'] }),
  // tq-closed-coding: Killing test: quickstart terminology: concepts and codings in the replaced fields are closed shapes
  M("tq-closed-coding", "scripts/quickstart/terminology.ts", "!isRecord(c) || !closedKeys(c, ['system', 'code', 'display']) || ", "!isRecord(c) || ", { suites: ['unit'] }),
  // tq-closed-concept: Killing test: quickstart terminology: concepts and codings in the replaced fields are closed shapes
  M("tq-closed-concept", "scripts/quickstart/terminology.ts", "!isRecord(concept) || !closedKeys(concept, ['coding', 'text']) || ", "!isRecord(concept) || ", { suites: ['unit'] }),
  // tq-code-nonempty: Killing test: quickstart terminology: concepts and codings in the replaced fields are closed shapes (the empty-code case)
  M("tq-code-nonempty", "scripts/quickstart/terminology.ts", "if (typeof c.code !== 'string' || c.code.length === 0) return fault('TERMINOLOGY_SHAPE_INVALID');", "if (typeof c.code !== 'string') return fault('TERMINOLOGY_SHAPE_INVALID');", { suites: ['unit'] }),
  // tq-code-present: Killing test: quickstart terminology: concepts and codings in the replaced fields are closed shapes (the missing-code case)
  M("tq-code-present", "scripts/quickstart/terminology.ts", "if (typeof c.code !== 'string' || c.code.length === 0) return fault('TERMINOLOGY_SHAPE_INVALID');", "if (typeof c.code !== 'string') c.code = String(c.code);\n          if (typeof c.code !== 'string') return c;", { suites: ['unit'] }),
  // tq-script-hash: Killing test: quickstart terminology: Encounter type and reasonCode codings, in the system or OID form, become numbered example.invalid codings with the text following
  M("tq-script-hash", "scripts/quickstart/terminology.ts", "script_sha256: TERMINOLOGY_SCRIPT_SHA256,", "script_sha256: sha256(TERMINOLOGY_SCRIPT),", { suites: ['unit'] }),
  // tq-residue: Killing test: quickstart terminology: a removed code, description or text left anywhere refuses as residue, matched as a whole token
  M("tq-residue", "scripts/quickstart/terminology.ts", "    if (out.some(resource => strings(resource).some(value => residue.test(value)))) fault('TERMINOLOGY_RESIDUE');\n", "", { suites: ['unit'] }),
  // tq-residue-token: Killing test: quickstart terminology: a removed code, description or text left anywhere refuses as residue, matched as a whole token
  M("tq-residue-token", "scripts/quickstart/terminology.ts", "(?<![A-Za-z0-9])(?:${escaped.join('|')})(?![A-Za-z0-9])`, 'i');", "(?:${escaped.join('|')})`, 'i');", { suites: ['unit'] }),
  // tq-residue-case: Killing test: quickstart terminology: a removed code, description or text left anywhere refuses as residue, matched as a whole token
  M("tq-residue-case", "scripts/quickstart/terminology.ts", "(?<![A-Za-z0-9])(?:${escaped.join('|')})(?![A-Za-z0-9])`, 'i');", "(?<![A-Za-z0-9])(?:${escaped.join('|')})(?![A-Za-z0-9])`);", { suites: ['unit'] }),
  // tq-input-validated: Killing test: quickstart terminology: the input must be an intact natural seed that has not been through the step
  M("tq-input-validated", "scripts/quickstart/terminology.ts", "  validateSeedStructure(seed);\n  if (Object.hasOwn", "  if (Object.hasOwn", { suites: ['unit'] }),
  // tq-already-applied: Killing test: quickstart terminology: the input must be an intact natural seed that has not been through the step
  M("tq-already-applied", "scripts/quickstart/terminology.ts", "  if (Object.hasOwn(seed.manifest, 'terminology')) throw new EdgeError('SEED_INVALID');\n", "", { suites: ['unit'] }),
  // s8-edges-terminology-natural: Killing test: quickstart edges: a natural seed or an edge file naming SNOMED CT (system, OID or any string) is refused before any merge
  M("s8-edges-terminology-natural", "scripts/quickstart/edges.ts", "  if (seed.ndjson.slice(0, -1).split('\\n').some(line => restrictedTerminology(parseFhirJson(line)))) fault('SEED_TERMINOLOGY_RESTRICTED');\n", "", { suites: ['unit'] }),
  // s8-edges-terminology-edge: Killing test: quickstart edges: a natural seed or an edge file naming SNOMED CT (system, OID or any string) is refused before any merge
  M("s8-edges-terminology-edge", "scripts/quickstart/edges.ts", "  if (restrictedTerminology(file)) fault('EDGE_TERMINOLOGY_RESTRICTED');\n", "", { suites: ['unit'] }),
  // s8-edges-terminology-oid: Killing test: quickstart edges: a natural seed or an edge file naming SNOMED CT (system, OID or any string) is refused before any merge
  M("s8-edges-terminology-oid", "scripts/quickstart/edges.ts", "const RESTRICTED_TEXT = /snomed|(?<![0-9.])2\\.16\\.840\\.1\\.113883\\.6\\.96(?![0-9])/i;", "const RESTRICTED_TEXT = /snomed/i;", { suites: ['unit'] }),
  // s8-edges-terminology-case: Killing test: quickstart edges: a natural seed or an edge file naming SNOMED CT (system, OID or any string) is refused before any merge
  M("s8-edges-terminology-case", "scripts/quickstart/edges.ts", "(?<![0-9.])2\\.16\\.840\\.1\\.113883\\.6\\.96(?![0-9])/i;", "(?<![0-9.])2\\.16\\.840\\.1\\.113883\\.6\\.96(?![0-9])/;", { suites: ['unit'] }),
  // s8-edges-terminology-keys: Killing test: quickstart edges: a natural seed or an edge file naming SNOMED CT (system, OID or any string) is refused before any merge
  M("s8-edges-terminology-keys", "scripts/quickstart/edges.ts", "Object.entries(node).some(([key, child]) => RESTRICTED_TEXT.test(key) || restrictedTerminology(child))", "Object.values(node).some(restrictedTerminology)", { suites: ['unit'] }),
  // Packaged-task definitions; each killed by a named test in tests/package-tasks.test.ts. Unit suite only.
  M("s9-package-observed-version", "packages/evals/src/package-tasks.ts", "const version = (type: string, id: string) => versions.get(`${type}/${id}`) ?? fail(`no observed version for ${type}/${id}`);", "const version = (type: string, id: string) => versions.get(`${type}/${id}`) ?? '1';", { suites: ['unit'] }),
  M("s9-package-raw-lexeme", "packages/evals/src/package-tasks.ts", "lexeme: oracleNumberLexeme(quantity.value)!,", "lexeme: String(Number(oracleNumberLexeme(quantity.value))),", { suites: ['unit'] }),
  M("s9-package-own-labs", "packages/evals/src/package-tasks.ts", "const mine = labs.filter(r => subjectIs(r, patient));", "const mine = labs;", { suites: ['unit'] }),
  M("s9-package-order-truth", "packages/evals/src/package-tasks.ts", "{ kind: 'sortEvidence', id: 'hba1c-order-unverified', step: 3, requested: ['-date'], effective: null, order: 'requested_unverified' },", "{ kind: 'sortEvidence', id: 'hba1c-order-unverified', step: 3, requested: ['-date'], effective: null, order: 'verified_by_adapter' },", { suites: ['unit'] }),
  M("s9-package-arm-fields", "packages/evals/src/package-tasks.ts", "if (arm === 'selected' && ['fhir_search', 'fhir_read', 'fhir_page'].includes(tool))", "if (arm === 'selected')", { suites: ['unit'] }),
  // Persistent prepare, Docker confinement and independent stored setup evidence; unit suite only.
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
  // Helper verify guards; each killed by a named test in tests/quickstart-verify.test.ts. Unit suite only.
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
  // Quickstart transport client and observer guards; unit suite only.
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
  // Helper package and compiled import boundary; unit suite only.
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
  // Helper verify: bound verify, per-call invariants, upstream paging, retained slices, full task meaning; unit suite only.
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
  M("s9-verify-inv-bytes", "examples/quickstart/verify.ts", "if (call.rawText === undefined || Buffer.byteLength(call.rawText) !== call.resultBytes || modelBytes === undefined ||", "if (call.rawText === undefined || modelBytes === undefined ||", { suites: ['unit'] }),
  // s9-verify-inv-ceiling: Killing test: quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read
  M("s9-verify-inv-ceiling", "examples/quickstart/verify.ts", "modelBytes === undefined || modelBytes > ceiling || call.resultBytes > 3 * ceiling + 4096)", "modelBytes === undefined || call.resultBytes > 3 * ceiling + 4096)", { suites: ['unit'] }),
  // s9-verify-inv-decoded: Killing test: quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read
  M("s9-verify-inv-decoded", "examples/quickstart/verify.ts", "        if (canonicalJson(structured) !== canonicalJson(call.envelope)) failing.add(`invariant:decoded:${step}`);\n", "", { suites: ['unit'] }),
  // s9-verify-inv-accounting: Killing test: quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read
  M("s9-verify-inv-accounting", "examples/quickstart/verify.ts", "        if (call.envelope.budget?.bytes_returned !== modelBytes || call.envelope.budget?.wire_bytes !== call.resultBytes || call.envelope.budget?.byte_limit !== ceiling) failing.add(`invariant:accounting:${step}`);\n", "", { suites: ['unit'] }),
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
  // Helper response validation, launch and setup binding, effective ceilings, retained details, loading forms; unit suite only.
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
  M("s9-r5-response-schema", "examples/quickstart/verify.ts", "e.schema_version !== '0.4' || ", "", { suites: ['unit'] }),
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
  // Package staging, production shrinkwrap and notices; unit suite only.
  // s9-stage-source: Killing test: package stage: source eval maps declarations and research are forbidden before copying
  M("s9-stage-source", "scripts/stage-package.ts", "if (!allowedProductionFile(path)) throw fault('STAGE_FORBIDDEN');", "if (false) throw fault('STAGE_FORBIDDEN');", { suites: ['unit'] }),
  // s9-lock-production: Killing test: package stage: gateway shrinkwrap rejects client tsx and every development edge
  M("s9-lock-production", "scripts/stage-package.ts", "if (!productionOnlyLock(lock)) throw fault('LOCK_NOT_PRODUCTION');", "if (false) throw fault('LOCK_NOT_PRODUCTION');", { suites: ['unit'] }),
  // s9-notice-required: Killing test: package licenses: required upstream NOTICE cannot be omitted and optional project NOTICE is not invented
  M("s9-notice-required", "scripts/release-licenses.mjs", "if (requiredNoticeMissing(inventory)) throw fault('NOTICE_MISSING');", "if (false) throw fault('NOTICE_MISSING');", { suites: ['unit'] }),
  // Fresh-install orchestration; unit suite only.
  // s9-guard-not-onboarding: Killing test: package quickstart: passing negative guards cannot certify a failed status-sensitive onboarding task
  M("s9-guard-not-onboarding", "scripts/package-quickstart.ts", "if (!allThreeTasksPassed(report)) throw fault('ONBOARDING_FAILED');", "if (false) throw fault('ONBOARDING_FAILED');", { suites: ['unit'] }),
  // s9-drain-loss: Killing test: package quickstart: drain membership guard rejects dropped, duplicated and substituted page members
  M("s9-drain-loss", "packages/evals/src/evidence-oracle.ts", "case 'resourceIdSet':\n      return new Set(evidence.resourceOrder).size === evidence.resourceOrder.length", "case 'resourceIdSet':\n      return check.id === 'labs-exact-membership' ? pass() : new Set(evidence.resourceOrder).size === evidence.resourceOrder.length", { suites: ['unit'] }),
  // e3-observer-trusts-fixture-patient. Killing test: a natural-corpus run judges confinement against its own configured patient, not the golden fixture patient
  M("e3-observer-trusts-fixture-patient", "packages/evals/src/runner.ts", "const observer = new SourceResponseObserver(fixture.baseUrl, `${task.id}/${arm}`, Boolean(options.packagedBin), trustedPatientId);", "const observer = new SourceResponseObserver(fixture.baseUrl, `${task.id}/${arm}`, Boolean(options.packagedBin));", { suites: ['unit'] }),
  // e1-full-text-boundary-unchecked. Killing test: E1 full-text-v1: the delivered text must be the raw structuredContent, so text-only alterations fail even at equal bytes
  M("e1-full-text-boundary-unchecked", "packages/evals/src/runner.ts", "if (envelope && (options.deliveryProfile ?? 'full-text-v1') === 'full-text-v1' && !fullTextMatchesStructured(outcome.result.content, outcome.resultText)) {", "if (false) {", { suites: ['unit'] }),
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
  M("same-class-canonical-judged-as-linkage", "packages/core/src/privacy.ts", "    // refusal happens only after authorization.\n    if (!value || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value)) return true;\n", "    // refusal happens only after authorization.\n    if (typeof value === 'string' && element && isUriElement(element) && parseReference(value, base).patientLike) return false;\n    if (!value || typeof value !== 'object' || isFhirDecimal(value) || isPrecisionFault(value)) return true;\n", { suites: ['unit'] }),
  // same-class-complex-scalar-passthrough. Killing test: same-class 5: any other scalar where a complex type is declared is withheld (as a payload for an Attachment), not passed through
  M("same-class-complex-scalar-passthrough", "packages/core/src/privacy.ts", "    if (malformedComplex(element, value)) return element.types.includes('Attachment') ? withhold(path, 'V1_PAYLOAD_WITHHELD', inModifier, {}, 'payload') : withhold(path, 'MALFORMED_STRUCTURE_WITHHELD', inModifier);\n", "", { suites: ['unit'] }),
  // same-class-base64-by-key-only. Killing test: same-class 6: base64Binary content is withheld by type and *Base64Binary name, not only under data/valueBase64Binary
  M("same-class-base64-by-key-only", "packages/core/src/privacy.ts", "  if ((element.types.includes('base64Binary') && element.name !== 'hash') || (!element.types.length && /Base64Binary$/.test(key))) return true;\n", "", { suites: ['unit'] }),
  // r3-origin-label-before-authorization. Killing test: R3: a denied foreign entry yields the same public search, page and retained response whatever its fullUrl
  M("r3-origin-label-before-authorization", "packages/core/src/index.ts", "      if (entry.search?.mode === 'include' || entry.resource.resourceType !== type) { suppressed = true; continue; }\n      // A directory record that is not reachable is dropped silently before it is judged, even when a\n      // source ignores the `_id` filter, so neither its body nor a withheld signal can reach the agent.\n      if (isDirectoryType(type) && !(typeof entry.resource.id === 'string' && this.verifiedTargets.reachable(type, entry.resource.id))) { suppressed = true; continue; }\n      const decision = authorizeRecord(entry.resource, this.config.patientId, this.transport.base, this.config.privacy);\n      if (decision.kind === 'own_withheld') partialReasons.add('RECORDS_WITHHELD_BY_POLICY');\n      if (decision.kind === 'shared_withheld') partialReasons.add('SHARED_RECORDS_WITHHELD_BY_POLICY');\n      if (decision.kind === 'silent' && decision.selfCheckFailed) this.noteRedactionSelfCheckFailed();\n      if (decision.kind !== 'deliver') { suppressed = true; continue; }\n      if (Object.hasOwn(entry, 'fullUrl') && !this.entryOriginMatches(entry.fullUrl, entry.resource)) { suppressed = true; partialReasons.add('ENTRY_ORIGIN_MISMATCH'); continue; }\n", "      if (Object.hasOwn(entry, 'fullUrl') && !this.entryOriginMatches(entry.fullUrl, entry.resource)) { suppressed = true; partialReasons.add('ENTRY_ORIGIN_MISMATCH'); continue; }\n      if (entry.search?.mode === 'include' || entry.resource.resourceType !== type) { suppressed = true; continue; }\n      // A directory record that is not reachable is dropped silently before it is judged, even when a\n      // source ignores the `_id` filter, so neither its body nor a withheld signal can reach the agent.\n      if (isDirectoryType(type) && !(typeof entry.resource.id === 'string' && this.verifiedTargets.reachable(type, entry.resource.id))) { suppressed = true; continue; }\n      const decision = authorizeRecord(entry.resource, this.config.patientId, this.transport.base, this.config.privacy);\n      if (decision.kind === 'own_withheld') partialReasons.add('RECORDS_WITHHELD_BY_POLICY');\n      if (decision.kind === 'shared_withheld') partialReasons.add('SHARED_RECORDS_WITHHELD_BY_POLICY');\n      if (decision.kind === 'silent' && decision.selfCheckFailed) this.noteRedactionSelfCheckFailed();\n      if (decision.kind !== 'deliver') { suppressed = true; continue; }\n", { suites: ['unit'] }),
  // r4-malformed-entries-empty-page. Killing test: R4: malformed Bundle entry structures refuse with INVALID_RESPONSE instead of an empty complete result
  M("r4-malformed-entries-empty-page", "packages/core/src/index.ts", "    if ((bundle.entry !== undefined && !Array.isArray(bundle.entry)) || (bundle.link !== undefined && !(Array.isArray(bundle.link) && bundle.link.every(jsonObject)))) throw new GatewayFault('INVALID_RESPONSE', 'Search returned malformed Bundle entries or links.');\n", "", { suites: ['unit'] }),
  // r5-declaration-prefix-trusted. Killing test: R5: more than 1024 searchParam declarations make the type ambiguous instead of trusting the prefix
  M("r5-declaration-prefix-trusted", "packages/core/src/index.ts", "          if (Array.isArray(entry.searchParam) && entry.searchParam.length > MAX_SEARCH_PARAM_DECLARATIONS) {", "          if (false) {", { suites: ['unit'] }),
  // r6-renewal-shares-generation. Killing test: R6: a token renewed after expiry has its own generation, so the old generation cannot invalidate it
  M("r6-renewal-shares-generation", "packages/auth/src/token-provider.ts", "      if (cached) this.generation++;\n", "", { suites: ['unit'] }),
  // resource-class-prototype-key: an inherited Object.prototype name (`__proto__`, `constructor`, ...) as a contained resourceType is classed as patient-linked. Killing test: prototype keys: resourceClass treats every inherited Object.prototype name as ambiguous (also the authorization and SDK e2e tests in tests/privacy-prototype-keys.test.ts)
  M("resource-class-prototype-key", "packages/core/src/privacy.ts", "type === 'Patient' || Object.hasOwn(links, type) ? 'patient'", "type === 'Patient' || type in links ? 'patient'", { suites: ['unit'] }),
  // transport-encoding-prototype-key: the decoder map regains Object.prototype, so an upstream `constructor` or `__proto__` content coding passes the allowlist. Killing test: response content encodings named after inherited Object.prototype members are refused like any other unsupported coding
  M("transport-encoding-prototype-key", "packages/core/src/transport.ts", "Object.assign(Object.create(null) as Record<string, () => Transform>, { gzip: createGunzip, 'x-gzip': createGunzip, deflate: createInflate, br: createBrotliDecompress });", "{ gzip: createGunzip, 'x-gzip': createGunzip, deflate: createInflate, br: createBrotliDecompress };", { suites: ['unit'] }),
  // continuation-opaque-any-path: the opaque server-root exception widened to a _getpages link on any path. Killing test: the opaque root _getpages exception is pinned at its edges: widened, conflicting or broadened links are refused before any fetch
  M("continuation-opaque-any-path", "packages/core/src/index.ts", "const opaque = (url.pathname === root || url.pathname === `${root}/`) && url.searchParams.has('_getpages');", "const opaque = url.searchParams.has('_getpages');", { suites: ['unit'] }),
  // continuation-opaque-any-root-query: the opaque server-root exception widened to any server-root link, _getpages or not. Killing test: the opaque root _getpages exception is pinned at its edges: widened, conflicting or broadened links are refused before any fetch
  M("continuation-opaque-any-root-query", "packages/core/src/index.ts", "const opaque = (url.pathname === root || url.pathname === `${root}/`) && url.searchParams.has('_getpages');", "const opaque = (url.pathname === root || url.pathname === `${root}/`);", { suites: ['unit'] }),
  // continuation-unrequested-constraint-unchecked: a continuation may add a material constraint the caller never requested. Killing test: the opaque root _getpages exception is pinned at its edges: widened, conflicting or broadened links are refused before any fetch (also S1-N18 material name added)
  M("continuation-unrequested-constraint-unchecked", "packages/core/src/index.ts", "if (!original.length && !paging.has(name)) throw", "if (false) throw", { suites: ['unit'] }),
  // continuation-drop-check-skipped-for-getpages: any link carrying _getpages skips the dropped-constraint check, on the resource path too. Killing test: the opaque root _getpages exception is pinned at its edges: widened, conflicting or broadened links are refused before any fetch
  M("continuation-drop-check-skipped-for-getpages", "packages/core/src/index.ts", "    if (!opaque) {\n", "    if (!url.searchParams.has('_getpages')) {\n", { suites: ['unit'] }),
  // continuation-opaque-conflict-unchecked: the opaque root _getpages link skips the conflict check, so it may contradict an original constraint (another patient). Killing test: the opaque root _getpages exception is pinned at its edges: widened, conflicting or broadened links are refused before any fetch
  M("continuation-opaque-conflict-unchecked", "packages/core/src/index.ts", "if (original.length && !queryEvidencePairsMatch(original, reported)) throw", "if (original.length && !opaque && !queryEvidencePairsMatch(original, reported)) throw", { suites: ['unit'] }),
  // continuation-path-check-disabled: a continuation may target any path, not only the original resource or the opaque root. Killing tests: the opaque root _getpages exception is pinned at its edges: widened, conflicting or broadened links are refused before any fetch; S1-N23 resource path changed keeps a safe prefix without fetching a changed continuation
  M("continuation-path-check-disabled", "packages/core/src/index.ts", "if (url.pathname !== resourcePath && !opaque) throw", "if (false) throw", { suites: ['unit'] }),
  // projection-field-tree-prototype-root: the field-selection tree root regains Object.prototype, so a caller segment such as `hasOwnProperty.call` writes onto the builtin. Killing tests: prototype keys: projection selects own keys named after builtins and never writes onto the builtin; prototype keys e2e: an SDK field selection naming builtins is delivered and later calls still work
  M("projection-field-tree-prototype-root", "packages/core/src/privacy.ts", "const tree: Tree = Object.create(null) as Tree;", "const tree: Tree = {};", { suites: ['unit'] }),
  // projection-field-tree-prototype-branch: inner field-selection nodes regain Object.prototype, so `code.valueOf.call` writes onto the builtin. Killing test: prototype keys: projection selects own keys named after builtins and never writes onto the builtin
  M("projection-field-tree-prototype-branch", "packages/core/src/privacy.ts", "branch[part] ??= Object.create(null) as Tree;", "branch[part] ??= {};", { suites: ['unit'] }),
  // Killing test: F-01: malformed contained Resource objects are refused and independently withheld.
  M("audit-contained-authorization", "packages/core/src/privacy.ts", "    if (malformedResource(element, node)) return false;\n", "", { suites: ['unit'] }),
  // Killing test: F-01: malformed contained Resource objects are refused and independently withheld.
  M("audit-contained-sanitization", "packages/core/src/privacy.ts", "    if (malformedResource(element, node)) return withhold(path, 'MALFORMED_LINKAGE_WITHHELD', inModifier);\n", "", { suites: ['unit'] }),
  // Killing test: F-17: declared Patient case variants and Patient path prefixes refuse foreign companions.
  M("audit-reference-declared-case", "packages/core/src/privacy.ts", "match[1]!.toLowerCase() === 'patient' && match[1] !== 'Patient' ? 'patient-like' : match[1]", "match[1]", { suites: ['unit'] }),
  // Killing test: F-17: declared Patient case variants and Patient path prefixes refuse foreign companions.
  M("audit-reference-path-prefix", "packages/core/src/privacy.ts", " || mentionsPatient(url.pathname.slice(0, url.pathname.lastIndexOf(parts.type)))", "", { suites: ['unit'] }),
  // Killing test: F-02 admission: every alternative and every pinned expression path must survive shared egress.
  M("audit-shared-withheld-paths", "packages/core/src/search-parameters.ts", "  if (!paths.length || paths.some(path => !allowed?.has(path))) return false;\n", "", { suites: ['unit'] }),
  // Killing test: F-02 admission: every alternative and every pinned expression path must survive shared egress.
  M("audit-shared-identifier-systems", "packages/core/src/search-parameters.ts", " && !(privacy?.patientIdentifierSystems ?? []).includes(token.system)", "", { suites: ['unit'] }),
  // Killing test: F-02 admission: every alternative and every pinned expression path must survive shared egress.
  M("audit-shared-identifier-explicit", "packages/core/src/search-parameters.ts", "typeof token?.system === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:\\S/.test(token.system)", "typeof token?.system === 'string'", { suites: ['unit'] }),
  // Killing test: F-02 admission: every alternative and every pinned expression path must survive shared egress.
  M("audit-shared-identifier-code", "packages/core/src/search-parameters.ts", "Boolean(token.code)", "true", { suites: ['unit'] }),
  // Killing test: F-02 admission: every alternative and every pinned expression path must survive shared egress.
  M("audit-shared-identifier-all", "packages/core/src/search-parameters.ts", "return alternatives.every(token => {", "return alternatives.some(token => {", { suites: ['unit'] }),
  // Killing test: F-02 stdio modern/legacy: withheld predicates never reach the source; allowed shared searches remain source-wide.
  M("audit-shared-sort", "packages/core/src/index.ts", ", privacy: this.config.privacy, sort: sortRequested", ", privacy: this.config.privacy", { suites: ['unit'] }),
  // Killing test: F-02 stdio modern/legacy: withheld predicates never reach the source; allowed shared searches remain source-wide.
  M("audit-shared-privacy-config", "packages/core/src/index.ts", ", privacy: this.config.privacy, sort: sortRequested", ", sort: sortRequested", { suites: ['unit'] }),
  // Killing test: F-03: every decoding layer is metered, including zero-output intermediate expansion and token responses.
  M("audit-decode-layer-meter", "packages/core/src/transport.ts", "if (decoded > compressedLimit)", "if (false)", { suites: ['unit'] }),
  // Killing test: F-03: cancellation and deadline still destroy decoding after the raw response closes.
  M("audit-decode-abort-lifetime", "packages/core/src/transport.ts", "stream.once('close', release);", "res.once('close', release);", { suites: ['unit'] }),
  // Killing test: F-03: two small codings remain usable; three supported codings are refused.
  M("audit-decode-coding-bound", "packages/core/src/transport.ts", "codings.length > 2 || ", "", { suites: ['unit'] }),
  // Killing test: F-21: continuation userinfo and fragments are refused independently.
  M("audit-next-userinfo", "packages/core/src/transport.ts", "if (url.origin !== this.base.origin || !insideBase || url.username || url.password || url.hash ||", "if (url.origin !== this.base.origin || !insideBase || url.hash ||", { suites: ['unit'] }),
  // Killing test: F-21: continuation userinfo and fragments are refused independently.
  M("audit-next-fragment", "packages/core/src/transport.ts", "if (url.origin !== this.base.origin || !insideBase || url.username || url.password || url.hash ||", "if (url.origin !== this.base.origin || !insideBase || url.username || url.password ||", { suites: ['unit'] }),
  // Killing test: L-01: HTTPS rejects a self-signed loopback certificate even when ambient TLS verification is disabled.
  M("audit-https-verification", "packages/core/src/transport.ts", "rejectUnauthorized: true", "rejectUnauthorized: false", { suites: ['unit'] }),
  // Killing test: F-05: type-level continuations retain all original constraints; only root _getpages may omit them.
  M("audit-observer-original-constraints", "packages/evals/src/upstream-provenance.ts", "if (JSON.stringify(normalize(expected)) !== JSON.stringify(normalize(actual))) return false;", "if (false) return false;", { suites: ['unit'] }),
  // Killing test: F-05: type-level continuations retain all original constraints; only root _getpages may omit them.
  C("audit-observer-opaque-only", [{"file":"packages/evals/src/upstream-provenance.ts","find":"const opaque = rootPath && url.searchParams.has","replace":"const opaque = url.searchParams.has"},{"file":"packages/evals/src/upstream-provenance.ts","find":"const opaque = (url.pathname === this.base.pathname || url.pathname === this.base.pathname.slice(0, -1)) && url.searchParams.has","replace":"const opaque = url.searchParams.has"}], { suites: ['unit'] }),
  // Killing test: F-05: type-level continuations retain all original constraints; only root _getpages may omit them.
  M("audit-observer-direct-constraints", "packages/evals/src/upstream-provenance.ts", "&& !typeMismatch && constraints && visible.length > 0", "&& !typeMismatch && visible.length > 0", { suites: ['unit'] }),
  // Killing test: F-05: type-level continuations retain all original constraints; only root _getpages may omit them.
  M("audit-observer-inherit-unconfined", "packages/evals/src/upstream-provenance.ts", "if (!this.requests.includes(request) || !request.confined) return false;", "if (!this.requests.includes(request)) return false;", { suites: ['unit'] }),
  // Killing test: F-12: file-digest failures cannot earn a kill alone or contaminate behavioural reproduction.
  M("audit-judge-pin-credit", "scripts/mutation-guards.mjs", "const behaviouralFailures = names => names.filter(name => !NON_BEHAVIORAL_TESTS.has(name));\n", "const behaviouralFailures = names => names.filter(() => true);\n", { suites: ['unit'] }),
  // Killing test: F-12: file-digest failures cannot earn a kill alone or contaminate behavioural reproduction.
  M("audit-judge-pin-only-stops", "scripts/mutation-guards.mjs", "    if (!tests.ok && !pinsOnly) return { outcome: 'failed', signature, timedOut: tests.timedOut, suite, ...preflight };\n", "    if (!tests.ok) return { outcome: 'failed', signature, timedOut: tests.timedOut, suite, ...preflight };\n", { suites: ['unit'] }),
  // Killing test: F-13: every listed gate executes through a symlinked absolute directory path.
  M("audit-entry-realpath", "scripts/is-main.mjs", "realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))", "entry === fileURLToPath(moduleUrl)", { suites: ['unit'] }),
  // Killing test: F-13: every listed gate executes through a symlinked absolute directory path.
  M("audit-entry-01", "scripts/mutation-guards.mjs", "\nif (isMainModule(import.meta.url)) {\n", "\nif (false) {\n", { suites: ['unit'] }),
  // Killing test: F-13: every listed gate executes through a symlinked absolute directory path.
  M("audit-entry-02", "scripts/emit-m3b-contract.mjs", "if (isMainModule(import.meta.url)) {", "if (false) {", { suites: ['unit'] }),
  // Killing test: F-13: every listed gate executes through a symlinked absolute directory path.
  M("audit-entry-03", "scripts/stage-package.ts", "if (isMainModule(import.meta.url)) {", "if (Boolean(0)) {", { suites: ['unit'] }),
  // Killing test: F-13: every listed gate executes through a symlinked absolute directory path.
  M("audit-entry-04", "scripts/verify-package.ts", "if (isMainModule(import.meta.url)) {", "if (Boolean(0)) {", { suites: ['unit'] }),
  // Killing test: F-13: every listed gate executes through a symlinked absolute directory path.
  M("audit-entry-05", "scripts/release-licenses.mjs", "if (isMainModule(import.meta.url)) {", "if (false) {", { suites: ['unit'] }),
  // Killing test: F-13: every listed gate executes through a symlinked absolute directory path.
  M("audit-entry-07", "scripts/check-dist-identity.mjs", "if (isMainModule(import.meta.url)) {", "if (false) {", { suites: ['unit'] }),
  // Killing test: F-13: every listed gate executes through a symlinked absolute directory path.
  M("audit-entry-08", "scripts/package-quickstart.ts", "if (isMainModule(import.meta.url)) {", "if (Boolean(0)) {", { suites: ['unit'] }),
  // Killing test: F-13: every listed gate executes through a symlinked absolute directory path.
  M("audit-entry-09", "scripts/qualify-hapi-search-profile.ts", "if (isMainModule(import.meta.url)) {", "if (false) {", { suites: ['unit'] }),
  // Killing test: F-13: every listed gate executes through a symlinked absolute directory path.
  M("audit-entry-11", "scripts/quickstart/assemble-helper-manifest.ts", "if (isMainModule(import.meta.url)) {", "if (Boolean(0)) {", { suites: ['unit'] }),
  // Killing test: F-13: every listed gate executes through a symlinked absolute directory path.
  M("audit-entry-12", "scripts/quickstart/edges.ts", "if (isMainModule(import.meta.url)) {", "if (false) {", { suites: ['unit'] }),
  // Killing test: F-13: every listed gate executes through a symlinked absolute directory path.
  M("audit-entry-13", "scripts/quickstart/transform-synthea.ts", "if (isMainModule(import.meta.url)) {", "if (false) {", { suites: ['unit'] }),
  // Killing test: F-13: every listed gate executes through a symlinked absolute directory path.
  M("audit-entry-14", "scripts/quickstart/check-helper-boundary.ts", "if (isMainModule(import.meta.url)) {", "if (Boolean(0)) {", { suites: ['unit'] }),
  // Killing test: F-13: every listed gate executes through a symlinked absolute directory path.
  M("audit-entry-15", "scripts/quickstart/generate-synthea.mjs", "if (isMainModule(import.meta.url)) {", "if (false) {", { suites: ['unit'] }),
  // Killing test: F-13: every listed gate executes through a symlinked absolute directory path.
  M("audit-entry-16", "tests/isolation/aggregate.ts", "if (isMainModule(import.meta.url)) {", "if (false) {", { suites: ['unit'] }),
  // Killing test: F-12: measured fixture pin drift cannot earn eval or containing-test credit in either era.
  M("audit-judge-eval-pin-credit", "scripts/mutation-guards.mjs", "    const signature = evalRun.ok || evalRun.timedOut || evalRun.nonBehavioural ? [] : [suite];\n", "    const signature = evalRun.ok || evalRun.timedOut ? [] : [suite];\n", { suites: ['unit'] }),
  // Killing test: F-12: every formerly excluded behavioural assertion retains named credit in its own test.
  M("audit-judge-behavioural-excluded", "scripts/mutation-guards.mjs", "  'pin-only: S6 approved fixture backend and task digests',\n", "  'pin-only: S6 approved fixture backend and task digests',\n  'S6 the eval runner refuses a qualified profile whose recorded fixture or backend digest drifted from what it serves',\n", { suites: ['unit'] }),
  // Killing test: F-12: unmeasured mismatched and erroneous preflight refusals retain behavioural credit.
  M("audit-judge-preflight-artifact", "scripts/mutation-guards.mjs", "  return rows.filter(row => affected.includes(row.artifact) && row.recorded !== row.observed);\n", "  return rows.filter(row => row.recorded !== row.observed);\n", { suites: ['unit'] }),
  // Killing test: F-12: unmeasured mismatched and erroneous preflight refusals retain behavioural credit.
  M("audit-judge-preflight-digest", "scripts/mutation-guards.mjs", "  return expectedPins.some(expected => ['schema', 'phase', 'profile', 'artifact', 'recorded', 'observed'].every(key => row[key] === expected[key]));\n", "  return expectedPins.some(expected => ['schema', 'phase', 'profile', 'artifact', 'recorded', 'observed'].every(key => key === 'observed' || row[key] === expected[key]));\n", { suites: ['unit'] }),
  // Killing test: F-12: unmeasured mismatched and erroneous preflight refusals retain behavioural credit.
  M("audit-judge-preflight-equal", "scripts/mutation-guards.mjs", "  if (!validPin(row) || row.recorded === row.observed) return false;\n", "  if (!validPin(row)) return false;\n", { suites: ['unit'] }),
  // Killing test: F-12: unmeasured mismatched and erroneous preflight refusals retain behavioural credit.
  M("audit-judge-preflight-untyped", "scripts/mutation-guards.mjs", "    const pin = /^  code: 'EVAL_PROFILE_PIN_DRIFT'$/m.test(diagnostic) && Boolean(message && expectedPinFailure(message, expectedPins));\n", "    const pin = Boolean(message && expectedPinFailure(message, expectedPins));\n", { suites: ['unit'] }),
  // Killing test: F-12: measured fixture pin drift cannot earn eval or containing-test credit in either era.
  M("audit-judge-preflight-unit-credit", "scripts/mutation-guards.mjs", "    const signature = behaviouralFailures(tests.failed).filter(name => !tests.pinFailures.includes(name));\n", "    const signature = behaviouralFailures(tests.failed);\n", { suites: ['unit'] }),
  // Killing test: F-12: profile preflight identifies each artifact and distinguishes an erroneous refusal.
  M("audit-profile-refusal-equal", "packages/evals/src/profile-preflight.ts", "row.recorded !== row.observed\n    && profilePinMessage", "profilePinMessage", { suites: ['unit'] }),
  // Killing test: F-12: profile preflight identifies each artifact and distinguishes an erroneous refusal.
  M("audit-profile-refusal-reason", "packages/evals/src/profile-preflight.ts", "&& profilePinMessage(row.artifact, row.recorded ?? undefined, row.observed) === drift", "&& Boolean(drift)", { suites: ['unit'] }),
  // Killing test: S6 the eval runner refuses a qualified profile whose recorded fixture or backend digest drifted from what it serves.
  M("audit-profile-backend-drift-unchecked", "packages/evals/src/runner.ts", "  if (profile.source.backend_sha256 !== expectedProfileHashes.backend) return", "  if (profile.source.backend_sha256 !== expectedProfileHashes.backend && Boolean(0)) return", { suites: ['unit'] }),
  // Killing test: S6 the eval runner refuses a qualified profile whose recorded fixture or backend digest drifted from what it serves.
  M("audit-profile-task-drift-unchecked", "packages/evals/src/runner.ts", "  if (profile.evidence?.tasks_sha256 !== expectedProfileHashes.tasks) return", "  if (profile.evidence?.tasks_sha256 !== expectedProfileHashes.tasks && Boolean(0)) return", { suites: ['unit'] }),
  // Killing test: F-12: unmeasured mismatched and erroneous preflight refusals retain behavioural credit.
  M("audit-judge-preflight-extra-output", "scripts/mutation-guards.mjs", "  const nonBehavioural = !result.ok && expectedPinFailure(result.out.trim(), expectedPins);\n", "  const nonBehavioural = !result.ok && result.out.split('\\n').some(line => expectedPinFailure(line, expectedPins));\n", { suites: ['unit'] }),
  // Killing test: F-12: unmeasured mismatched and erroneous preflight refusals retain behavioural credit.
  M("audit-judge-preflight-duplicate-name", "scripts/mutation-guards.mjs", "    pinsByName.set(name, pinsByName.get(name) !== false && pin);\n", "    pinsByName.set(name, pin);\n", { suites: ['unit'] }),
  // Killing test: eval audit: inherited fixture table entries never become raw resources or definitions
  M("b9-fixture-inherited-lookup", "packages/evals/src/fixture.ts", "Object.hasOwn(table, key) ? table[key] : undefined", "table[key]", { suites: ['unit'] }),
  // Killing test: eval audit: seed/setup expected tokens use an independent scanner and reject rounded storage
  M("b9-oracle-number-rounded", "packages/evals/src/evidence-oracle.ts", "if (node.kind === 'number') return oracleJson.rawJSON(node.raw);", "if (node.kind === 'number') return Number(node.raw);", { suites: ['unit'] }),
  // Killing test: eval audit: seed/setup expected tokens use an independent scanner and reject rounded storage
  M("b9-oracle-json-grammar", "packages/evals/src/evidence-oracle.ts", "  JSON.parse(text); // Validate JSON string escapes and number grammar before scanning.", "  // JSON grammar unchecked.", { suites: ['unit'] }),
  // Killing test: eval audit: discovery checks reject duplicate, skipped, mistyped and unfinished rows
  M("b9-discovery-duplicates", "packages/evals/src/evidence-oracle.ts", "const unique = new Set(names).size === names.length;", "const unique = true;", { suites: ['unit'] }),
  // Killing test: eval audit: discovery checks reject duplicate, skipped, mistyped and unfinished rows
  M("b9-discovery-typed-rows", "packages/evals/src/evidence-oracle.ts", "const included = check.includes.every(want => rows.some(row => Object.entries(want).every(([key, value]) => deepEqual(row[key], value))));", "const included = true;", { suites: ['unit'] }),
  // Killing test: eval audit: discovery checks reject duplicate, skipped, mistyped and unfinished rows
  M("b9-discovery-row-count", "packages/evals/src/evidence-oracle.ts", "pages.every(page => page.total_parameters === rows.length)", "true", { suites: ['unit'] }),
  // Killing test: eval audit: discovery checks reject duplicate, skipped, mistyped and unfinished rows
  M("b9-discovery-terminal-cursor", "packages/evals/src/evidence-oracle.ts", "pages.at(-1)!.next_cursor === undefined", "true", { suites: ['unit'] }),
  // Killing test: eval audit: ignoring selected fields fails the selected arm
  M("b9-selected-invariant", "packages/evals/src/runner.ts", "if (arm === 'selected' && Array.isArray(selectedFields) && resourcesOf(envelope).length)", "if (arm === 'selected' && Array.isArray(selectedFields) && resourcesOf(envelope).length && Boolean(0))", { suites: ['unit'] }),
  // Killing test: golden tasks pass and adversarial tasks meet their declared outcome in every format, with truthful denominators; eval audit: counted query corpus rejects missing discovery rows
  M("b9-discovery-drain-disabled", "packages/evals/src/runner.ts", "while (step.drainDiscovery && envelope && !envelope.error", "while (Boolean(0) && step.drainDiscovery && envelope && !envelope.error", { suites: ['unit'] }),
  // Killing test: eval audit: counted query corpus rejects missing discovery rows
  M("b9-conflicting-mode-ignored", "packages/evals/src/fixture.ts", "if (behavior?.conflictingTypes && (declared.type === 'reference' || declared.type === 'date'))", "if (false)", { suites: ['unit'] }),
  // Killing test: eval audit: counted query corpus rejects missing discovery rows
  M("b9-unknown-definition-trusted", "packages/evals/src/fixture.ts", "if (behavior?.conflictingTypes && name === 'value-quantity')", "if (false)", { suites: ['unit'] }),
  // Killing test: eval audit: counted query corpus rejects missing discovery rows
  M("b9-opaque-evidence-echoed", "packages/evals/src/fixture.ts", "scenario === 'query-opaque-evidence' ? [] : [{ relation: 'self', url: selfUrl }]", "[{ relation: 'self', url: selfUrl }]", { suites: ['unit'] }),
  // Killing test: eval audit: selection requires its projected flag even when no extra key is present
  M("b9-selection-projected-flag", "packages/evals/src/runner.ts", "!envelope.transform.projected || resourcesOf(envelope).some", "resourcesOf(envelope).some", { suites: ['unit'] }),
  // Killing test: eval audit: qualification recorder refuses ineligible profiles
  M("b9-record-ineligible", "scripts/record-search-qualification.ts", "!profile || !profile.eligible", "!profile", { suites: ['unit'] }),

  // Killing test: G-BACKEND fresh census GETs bypass stale source search caches
  M("b9-census-cache-bypass", "packages/evals/src/external.ts", "{ 'cache-control': 'no-cache' }", "{}", { suites: ['unit'] }),
  // Killing test: G-BACKEND corpus re-qualification stays private and preserves every backend identity guard
  M("b9-candidate-backend-identity", "packages/evals/src/external.ts", "!(requalifyCorpus && key === 'corpus_sha256')", "!requalifyCorpus", { suites: ['unit'] }),
  // Killing test: G-BACKEND corpus re-qualification stays private and preserves every backend identity guard
  M("b9-candidate-current-corpus", "packages/evals/src/external.ts", "corpus_sha256: identity.corpus_sha256 } };", "corpus_sha256: declared.source.corpus_sha256 } };", { suites: ['unit'] }),
  // Killing test: eval audit: inherited adversarial modes are refused
  M("b9-fixture-mode-own-key", "packages/evals/src/tasks.ts", "!Object.hasOwn(ADVERSARIAL_MODES_REF, String(task.fixtureMode))", "!(String(task.fixtureMode) in ADVERSARIAL_MODES_REF)", { suites: ['unit'] }),

  // Killing test: eval audit: numeric facts compare the decoded wire envelope rather than gateway decimal objects
  M("b9-wire-numeric-decoding", "packages/evals/src/runner.ts", "asRec(rawEnvelope === undefined ? outcome.result.structuredContent : JSON.parse(rawEnvelope))", "asRec(outcome.result.structuredContent)", { suites: ['unit'] }),

  // Killing test: eval audit: discovery check vocabulary rejects malformed and extra row fields
  M("b9-discovery-check-schema", "packages/evals/src/tasks.ts", "      if (!Array.isArray(check.includes) || !check.includes.length || check.includes.some(row => !isRecord(row) || Object.keys(row).some(k => !['name', 'type', 'definition_evidence', 'executable'].includes(k)) || typeof row.name !== 'string' || typeof row.type !== 'string' || (row.definition_evidence !== undefined && typeof row.definition_evidence !== 'string') || (row.executable !== undefined && typeof row.executable !== 'boolean')) || (check.complete !== undefined && typeof check.complete !== 'boolean')) bad(`task ${taskId} invalid discoveryRows`);", "      // Discovery row check validation disabled.", { suites: ['unit'] }),
  // Killing test: eval audit: a clinical object named rawJSON cannot masquerade as an oracle number
  M("b9-oracle-native-number", "packages/evals/src/evidence-oracle.ts", "oracleJson.isRawJSON(value)", "value !== null && typeof value === 'object' && 'rawJSON' in value", { suites: ['unit'] }),

  // Killing test: eval audit: discovery checks reject duplicate, skipped, mistyped and unfinished rows
  M("b9-discovery-independent-set", "packages/evals/src/evidence-oracle.ts", "rows.length === check.includes.length && ", "", { suites: ['unit'] }),
  // Killing test: eval audit: the coded Observation is denied because it contains an unclassified Basic
  M("b9-contained-observation-code", "packages/evals/src/fixture.ts", "    code: cc(SYNTH, 'synthetic-contained-unclassified', 'Synthetic contained-resource result'),\n", "", { suites: ['unit'] }),
  // Killing test: eval audit: the coded Observation is denied because it contains an unclassified Basic
  M("b9-contained-basic-reference", "packages/evals/src/fixture.ts", "    extension: [{ url: `${SYNTH}/unclassified-detail`, valueReference: { reference: '#unclassified' } }],\n", "", { suites: ['unit'] }),

  // Honest coverage for withheld own records, narrow redaction, and shared identifier systems.
  // w1-a1-own-withheld-silent. Killing test: A1: a page that withholds one of the patient's own records is partial, says why, and publishes no total
  M("w1-a1-own-withheld-silent", "packages/core/src/index.ts", "      if (decision.kind === 'own_withheld') partialReasons.add('RECORDS_WITHHELD_BY_POLICY');\n", "", { suites: ['unit'] }),
  // w1-a1-warning-dropped. Killing test: A1: a page that withholds one of the patient's own records is partial, says why, and publishes no total
  M("w1-a1-warning-dropped", "packages/core/src/index.ts", "    if (reasons.includes('RECORDS_WITHHELD_BY_POLICY')) add('RECORDS_WITHHELD_BY_POLICY');\n", "", { suites: ['unit'] }),
  // w1-a1-gate-complete. Killing test: A1 strict gate: a completeness claim with the reason, or the reason without its warning, never leaves the gateway
  M("w1-a1-gate-complete", "packages/core/src/contracts.ts", "    if (c.state === 'complete_for_query' && c.reasons.includes('RECORDS_WITHHELD_BY_POLICY')) return fail();\n", "", { suites: ['unit'] }),
  // w1-a1-gate-pairing. Killing test: A1 strict gate: a completeness claim with the reason, or the reason without its warning, never leaves the gateway
  M("w1-a1-gate-pairing", "packages/core/src/contracts.ts", "    if (c.reasons.includes('RECORDS_WITHHELD_BY_POLICY') !== env.warnings.some(w => w.code === 'RECORDS_WITHHELD_BY_POLICY')) return fail();\n", "", { suites: ['unit'] }),
  // w1-a1-unbound-primary-own. Killing test: wave 1 judge matrix: deliver with whole-node redactions, own_withheld or silent
  M("w1-a1-unbound-primary-own", "packages/core/src/privacy.ts", "  if (!judgement.primaryBound) return { kind: 'silent' };\n", "", { suites: ['unit'] }),
  // w1-a1-foreign-signalled. Killing test: A1 twins: explicit other-patient evidence stays silent and leaves the public output unchanged (mirrors CLS-03 and NUM-01)
  M("w1-a1-foreign-signalled", "packages/core/src/privacy.ts", "        if (kind === 'foreign') judgement.foreignEvidence = true;\n", "        if (kind === 'foreign') { judgement.foreignEvidence = true; judgement.ownDefect = true; }\n", { suites: ['unit'] }),
  // w1-a1-foreign-subtree-pruned. Killing test: wave 1 invariant A1-B: twins that differ only in a non-primary patient identity agree on the own_withheld signal
  M("w1-a1-foreign-subtree-pruned", "packages/core/src/privacy.ts", "        if (kind === 'foreign') judgement.foreignEvidence = true;\n", "        if (kind === 'foreign') { judgement.foreignEvidence = true; return; }\n", { suites: ['unit'] }),
  // w1-a1-foreign-contained-pruned. Killing test: wave 1 invariant A1-B: twins that differ only in a non-primary patient identity agree on the own_withheld signal
  M("w1-a1-foreign-contained-pruned", "packages/core/src/privacy.ts", "          if (kind === 'foreign' || kind === 'logical_patient') judgement.foreignEvidence = true;\n", "          if (kind === 'foreign' || kind === 'logical_patient') { judgement.foreignEvidence = true; return; }\n", { suites: ['unit'] }),
  // w1-read-authorization-removed. Killing test: precision and other pre-authorization read faults never disclose a record the patient may not read (J-6/J-15 read tests)
  M("w1-read-authorization-removed", "packages/core/src/index.ts", "    if (decision.kind !== 'deliver') throw new GatewayFault('NOT_FOUND', 'Requested resource is not available.');\n", "", { suites: ['unit'] }),
  // w1-a2-explicit-patient-redacted. Killing test: wave 1 judge matrix: deliver with whole-node redactions, own_withheld or silent
  M("w1-a2-explicit-patient-redacted", "packages/core/src/privacy.ts", "  if (parsed && (parsed.type === 'Patient' || parsed.patientLike || (parsed.form === 'conditional' && mentionsPatient(reference as string)))) return 'foreign';\n", "", { suites: ['unit'] }),
  // w1-a2-conditional-patient-mention. Killing test: wave 1 judge matrix: deliver with whole-node redactions, own_withheld or silent
  M("w1-a2-conditional-patient-mention", "packages/core/src/privacy.ts", " || (parsed.form === 'conditional' && mentionsPatient(reference as string))", "", { suites: ['unit'] }),
  // w1-a2-declared-patient-redacted. Killing test: wave 1 judge matrix: deliver with whole-node redactions, own_withheld or silent
  M("w1-a2-declared-patient-redacted", "packages/core/src/privacy.ts", "  if (declared === 'Patient' || declared === 'patient-like') return 'foreign';\n", "", { suites: ['unit'] }),
  // w1-a2-patient-system-redacted. Killing test: wave 1 judge matrix: deliver with whole-node redactions, own_withheld or silent
  M("w1-a2-patient-system-redacted", "packages/core/src/privacy.ts", "  if (logicalPatientIdentifier(node.identifier, patientSystems)) return 'logical_patient';\n", "", { suites: ['unit'] }),
  // w1-a2-person-type-redacted. Killing test: wave 1 judge matrix: deliver with whole-node redactions, own_withheld or silent
  M("w1-a2-person-type-redacted", "packages/core/src/privacy.ts", "    return codingsOf(identifier.type).some(", "    return false && codingsOf(identifier.type).some(", { suites: ['unit'] }),
  // w1-a2-unsupported-redacted. Killing test: wave 1 judge matrix: deliver with whole-node redactions, own_withheld or silent
  M("w1-a2-unsupported-redacted", "packages/core/src/privacy.ts", "  if (parsed && (parsed.form === 'urn' || parsed.form === 'conditional')) return 'unverifiable';\n", "  if (parsed && (parsed.form === 'urn' || parsed.form === 'conditional' || parsed.form === 'unsupported')) return 'unverifiable';\n", { suites: ['unit'] }),
  // w1-a2-any-patient-target-redacted. Killing test: wave 1 judge matrix: deliver with whole-node redactions, own_withheld or silent
  M("w1-a2-any-patient-target-redacted", "packages/core/src/privacy.ts", "    && ACTOR_TARGETS.some(target => targets!.includes(target))", "", { suites: ['unit'] }),
  // w1-a2-payee-redacted. Killing test: wave 1 judge matrix: deliver with whole-node redactions, own_withheld or silent
  M("w1-a2-payee-redacted", "packages/core/src/privacy.ts", " && !REDACTION_EXCLUDED_SITES.has(site)", "", { suites: ['unit'] }),
  // w1-a2-primary-redacted. Killing test: wave 1 judge matrix: deliver with whole-node redactions, own_withheld or silent
  C("w1-a2-primary-redacted", [{"file":"packages/core/src/privacy.ts","find":"          if (kind === 'foreign' || kind === 'logical_patient') judgement.foreignEvidence = true;\n          else return defect();\n","replace":"          if (kind === 'foreign' || kind === 'logical_patient') judgement.foreignEvidence = true;\n"},{"file":"packages/core/src/privacy.ts","find":"kind === 'unverifiable' && isReference && !primary && clinicalActorElement(element, site)","replace":"kind === 'unverifiable' && isReference && clinicalActorElement(element, site)"}], { suites: ['unit'] }),
  // w1-a2-self-check-removed. Killing test: wave 1 redaction plan: forged, incomplete or non-redactable plans are refused on the raw record (W1-R5)
  M("w1-a2-self-check-removed", "packages/core/src/privacy.ts", "  return reduced !== undefined && authorized(reduced, patientId, base, shared);\n", "  return reduced !== undefined;\n", { suites: ['unit'] }),
  // w1-a2-plan-membership. Killing test: wave 1 redaction plan: forged, incomplete or non-redactable plans are refused on the raw record (W1-R5)
  M("w1-a2-plan-membership", "packages/core/src/privacy.ts", "  return pointers.every(pointer => redactable.has(pointer)) && redactionPlanHolds(", "  return redactionPlanHolds(", { suites: ['unit'] }),
  // w1-a2-sanitize-plan-ignored. Killing test: wave 1 redaction output: the whole node is withheld with a label, and nothing of it is delivered
  M("w1-a2-sanitize-plan-ignored", "packages/core/src/privacy.ts", "    if (options.withholdReferences?.has(path) && value && typeof value === 'object' && !Array.isArray(value)) return withhold(path, 'UNVERIFIED_REFERENCE_WITHHELD', inModifier, {}, element.types.length ? 'policy' : 'unknown');\n", "", { suites: ['unit'] }),
  // w1-a3-unlisted-system. Killing test: A3 instance rule: only listed systems, only system/value/use, at most eight, never batch
  M("w1-a3-unlisted-system", "packages/core/src/privacy.ts", " || !shared.identifierSystems?.has(identifier.system)", "", { suites: ['unit'] }),
  // w1-a3-extra-keys. Killing test: A3 instance rule: only listed systems, only system/value/use, at most eight, never batch
  M("w1-a3-extra-keys", "packages/core/src/privacy.ts", "    if (Object.keys(identifier).some(key => !SHARED_IDENTIFIER_KEYS.has(key))) return false;\n", "", { suites: ['unit'] }),
  // w1-a3-identifier-count. Killing test: A3 instance rule: only listed systems, only system/value/use, at most eight, never batch
  M("w1-a3-identifier-count", "packages/core/src/privacy.ts", " || identifiers.length > 8) return false;", ") return false;", { suites: ['unit'] }),
  // w1-a3-search-unlisted. Killing test: A3 gateway: listed product identifiers are delivered; the default keeps today's withholding
  M("w1-a3-search-unlisted", "packages/core/src/search-parameters.ts", "    if (resourceType === 'Medication' && !alternatives.every(token => typeof token?.system === 'string' && (privacy?.sharedIdentifierSystems ?? []).includes(token.system))) return false;\n", "", { suites: ['unit'] }),
  // w1-a3-overlap-allowed. Killing test: A3 config: shared identifier systems are validated and never patient or person identifier systems
  M("w1-a3-overlap-allowed", "packages/core/src/index.ts", "  if (sharedSystems.some(system => (cfg.privacy?.patientIdentifierSystems ?? []).some(patient => identifierSystemsOverlap(system, patient)))) ctx.addIssue({ code: 'custom', message: 'sharedIdentifierSystems must not overlap patientIdentifierSystems' });\n", "", { suites: ['unit'] }),
  // w1-a3-person-system-allowed. Killing test: A3 config: shared identifier systems are validated and never patient or person identifier systems
  M("w1-a3-person-system-allowed", "packages/core/src/index.ts", "  if (sharedSystems.some(personIdentifierSystem)) ctx.addIssue({ code: 'custom', message: 'sharedIdentifierSystems must not list a person identifier system' });\n", "", { suites: ['unit'] }),
  // w1-a3-duplicate-allowed. Killing test: A3 config: shared identifier systems are validated and never patient or person identifier systems
  M("w1-a3-duplicate-allowed", "packages/core/src/index.ts", "  if (new Set(sharedSystems).size !== sharedSystems.length) ctx.addIssue({ code: 'custom', message: 'sharedIdentifierSystems must not repeat a system' });\n", "", { suites: ['unit'] }),
  // w1-a3-system-screen. Killing test: A3 config: shared identifier systems are validated and never patient or person identifier systems
  M("w1-a3-system-screen", "packages/core/src/privacy.ts", " && !protectedLink(value, 'system', true);\n}", ";\n}", { suites: ['unit'] }),
  // w1-b1-ledger-bypassed. Killing test: B1 admission: every other reference form, and any OR list with a refused part, is refused before sending; B1 gateway foreign/missing twins; S3-G3 twins; isolation XRF-01
  M("w1-b1-ledger-bypassed", "packages/core/src/search-parameters.ts", "    if (!verified(type, id)) return undefined;\n", "", { suites: ['unit', 'isolation'] }),
  // w1-b1-patient-target. Killing test: B1 admission: every other reference form, and any OR list with a refused part, is refused before sending
  M("w1-b1-patient-target", "packages/core/src/search-parameters.ts", "    if (type === 'Patient' || resourceClass(type) !== 'patient'", "    if (resourceClass(type) !== 'patient'", { suites: ['unit'] }),
  // w1-b1-target-class. Killing test: B1 admission: every other reference form, and any OR list with a refused part, is refused before sending
  M("w1-b1-target-class", "packages/core/src/search-parameters.ts", " || resourceClass(type) !== 'patient' || !entry.targetsFull.includes(type)) return undefined;", " || !entry.targetsFull.includes(type)) return undefined;", { suites: ['unit'] }),
  // w1-b1-target-listed. Killing test: B1 admission: every other reference form, and any OR list with a refused part, is refused before sending
  M("w1-b1-target-listed", "packages/core/src/search-parameters.ts", " || !entry.targetsFull.includes(type)) return undefined;", ") return undefined;", { suites: ['unit'] }),
  // w1-b1-link-name. Killing test: B1 admission: a patient-link parameter is excluded by name even if its targets listed a patient-linked type
  M("w1-b1-link-name", "packages/core/src/search-parameters.ts", "  if (pair.name === confinementName || pair.name === 'patient' || pair.name === 'subject' || pair.name === patientLinkForType(resourceType)) return undefined;\n", "", { suites: ['unit'] }),
  // w1-b1-or-first-only. Killing test: B1 admission: every other reference form, and any OR list with a refused part, is refused before sending
  M("w1-b1-or-first-only", "packages/core/src/search-parameters.ts", "  for (const alternative of pair.value.split(',')) {", "  for (const alternative of pair.value.split(',').slice(0, 1)) {", { suites: ['unit'] }),
  // w1-b1-cap. Killing test: B1 admission: every other reference form, and any OR list with a refused part, is refused before sending
  M("w1-b1-cap", "packages/core/src/search-parameters.ts", "  if (linkedTargets.size > MAX_PATIENT_LINKED_TARGETS) throw", "  if (false) throw", { suites: ['unit'] }),
  // w1-b1-ledger-not-cleared. Killing test: B1 gateway: trusted evidence is cleared at the state boundary that clears retained results
  M("w1-b1-ledger-not-cleared", "packages/core/src/index.ts", "    this.verifiedTargets.clear();\n", "", { suites: ['unit'] }),
  // w1-b1-ledger-stale-request. Killing test: B1 gateway: a read that straddles a state boundary records no trusted evidence
  M("w1-b1-ledger-stale-request", "packages/core/src/index.ts", "    if ((budget.epoch ?? this.authEpoch) !== this.authEpoch || (budget.stateGeneration ?? this.stateGeneration) !== this.stateGeneration) return;\n", "", { suites: ['unit'] }),
  // w1-b1-ledger-search-unauthorized. Killing test: B1 gateway: an own record withheld by policy is not trusted evidence
  M("w1-b1-ledger-search-unauthorized", "packages/core/src/index.ts", "      const decision = authorizeRecord(entry.resource, this.config.patientId, this.transport.base, this.config.privacy);\n", "      this.noteVerifiedTarget(entry.resource, budget);\n      const decision = authorizeRecord(entry.resource, this.config.patientId, this.transport.base, this.config.privacy);\n", { suites: ['unit'] }),
  // w1-b1-ledger-read-unauthorized. Killing test: B1 gateway: an own encounter delivered by read is trusted; a foreign or missing read never is
  M("w1-b1-ledger-read-unauthorized", "packages/core/src/index.ts", "    const decision = authorizeRecord(raw, this.config.patientId, this.transport.base, this.config.privacy);\n", "    this.noteVerifiedTarget(raw, budget);\n    const decision = authorizeRecord(raw, this.config.patientId, this.transport.base, this.config.privacy);\n", { suites: ['unit'] }),
  // w1-b2-id-shape. Killing test: B2 syntax: `_id` alternatives must be plain FHIR ids, at most 100 within 4,096 bytes, before any request
  M("w1-b2-id-shape", "packages/core/src/search-parameters.ts", "    if (pair.name === '_id' && !alternatives.every(isFhirId)) {", "    if (false) {", { suites: ['unit'] }),
  // w1-b2-id-dot-segments. Killing test: B2 syntax: `_id` alternatives must be plain FHIR ids, at most 100 within 4,096 bytes, before any request
  M("w1-b2-id-dot-segments", "packages/core/src/search-parameters.ts", "return BARE_ID.test(value) && value !== '.' && value !== '..'; }", "return BARE_ID.test(value); }", { suites: ['unit'] }),

  // w1-c-device-production-masks-off. Killing test: C masks: Device production identifiers, network address and contact are withheld with labels; model data stays
  M("w1-c-device-production-masks-off", "packages/core/src/privacy.ts", ".map(field => [`Device.${field}`, 'DEVICE_PRODUCTION_IDENTIFIER_WITHHELD'] as const),", ".filter(() => false).map(field => [`Device.${field}`, 'DEVICE_PRODUCTION_IDENTIFIER_WITHHELD'] as const),", { suites: ['unit'] }),
  // w1-c-device-address-mask-off. Killing test: C masks: Device production identifiers, network address and contact are withheld with labels; model data stays
  M("w1-c-device-address-mask-off", "packages/core/src/privacy.ts", "  ['Device.url', 'DEVICE_NETWORK_ADDRESS_WITHHELD'],\n", "", { suites: ['unit'] }),
  // w1-c-device-contact-mask-off. Killing test: C masks: Device production identifiers, network address and contact are withheld with labels; model data stays
  M("w1-c-device-contact-mask-off", "packages/core/src/privacy.ts", "  ['Device.contact', 'DEVICE_CONTACT_WITHHELD'],\n", "", { suites: ['unit'] }),
  // w1-c-dicom-masks-off. Killing test: C masks: ImagingStudy DICOM UIDs are withheld with labels; modality, body site and SOP class stay
  M("w1-c-dicom-masks-off", "packages/core/src/privacy.ts", "...['identifier', 'series.uid', 'series.instance.uid'].map(", "...['identifier', 'series.uid', 'series.instance.uid'].filter(() => false).map(", { suites: ['unit'] }),
  // w1-c-record-masks-unapplied. Killing test: C masks (Device and ImagingStudy) and C gateway: Device and ImagingStudy masks reach the wire with labels
  M("w1-c-record-masks-unapplied", "packages/core/src/privacy.ts", "const recordMask = PATIENT_RECORD_MASKS.get(field);", "const recordMask = undefined as string | undefined; void PATIENT_RECORD_MASKS;", { suites: ['unit'] }),
  // w1-c-masked-predicates. Killing test: C masked predicates: admission refuses them as filters and as sort keys; C gateway: masked predicates and sort keys are refused before anything is sent
  M("w1-c-masked-predicates", "packages/core/src/search-parameters.ts", "if (classification === 'patient' && maskedPatientPredicate(input.resourceType, entry)) throw", "if (false && classification === 'patient' && maskedPatientPredicate(input.resourceType, entry)) throw", { suites: ['unit'] }),
  // w1-c-masked-path-inside. Killing test: C masked predicates: a path equal to, inside or above a masked field, or an extension on a masked type, is refused
  M("w1-c-masked-path-inside", "packages/core/src/search-parameters.ts", "path === field || path.startsWith(`${field}.`) || field", "path === field || field", { suites: ['unit'] }),
  // w1-c-masked-path-above. Killing test: C masked predicates: a path equal to, inside or above a masked field, or an extension on a masked type, is refused
  M("w1-c-masked-path-above", "packages/core/src/search-parameters.ts", " || field.startsWith(`${path}.`)", "", { suites: ['unit'] }),
  // w1-c-masked-extension. Killing test: C masked predicates: exactly the pinned parameters that reach a withheld field are refused (Device.din)
  M("w1-c-masked-extension", "packages/core/src/search-parameters.ts", "path => path === 'extension' || path.startsWith('extension.')", "path => false", { suites: ['unit'] }),
  // w1-c-device-link. Killing test: C classification: the seven types are patient-linked with their reviewed links; support-matrix drift
  M("w1-c-device-link", "packages/core/src/privacy.ts", "Device: 'patient' };", "Device: 'owner' };", { suites: ['unit'] }),
  // w1-c-dispense-link. Killing test: C classification: the seven types are patient-linked with their reviewed links; support-matrix drift
  M("w1-c-dispense-link", "packages/core/src/privacy.ts", "MedicationDispense: 'subject',", "MedicationDispense: 'receiver',", { suites: ['unit'] }),

  // w1-rf-content-admitted. Killing test: full-text refusal tests in tests/full-text-refusal-and-masks.test.ts
  M("w1-rf-content-admitted", "packages/core/src/search-parameters.ts", "    if (classification === 'patient' && unreviewedFullTextPredicate(input.resourceType, entry)) throw", "    if (false && classification === 'patient' && unreviewedFullTextPredicate(input.resourceType, entry)) throw", { suites: ['unit'] }),
  // w1-rf-pinned-is-not-reviewed. Killing test: full-text refusal tests in tests/full-text-refusal-and-masks.test.ts
  M("w1-rf-pinned-is-not-reviewed", "packages/core/src/search-parameters.ts", "  return entry.pinnedExpression === undefined && !REVIEWED_EXPRESSIONLESS", "  return entry.view.definition_evidence !== 'pinned_r4' && !REVIEWED_EXPRESSIONLESS", { suites: ['unit'] }),
  // w1-rf-patient-system-exact. Killing test: person-identifier rule: case, URL and type-text variants are withheld silently; an unrelated registry is still redacted
  M("w1-rf-patient-system-exact", "packages/core/src/privacy.ts", "[...patientSystems].some(configured => identifierSystemsOverlap(configured, system))", "patientSystems.has(system)", { suites: ['unit'] }),
  // w1-rf-person-system-floor. Killing test: person-identifier rule: case, URL and type-text variants are withheld silently; an unrelated registry is still redacted
  M("w1-rf-person-system-floor", "packages/core/src/privacy.ts", "    if (typeof system === 'string' && personIdentifierSystem(system)) return true;\n", "", { suites: ['unit'] }),
  // w1-rf-person-type-text. Killing test: person-identifier rule: case, URL and type-text variants are withheld silently; an unrelated registry is still redacted
  M("w1-rf-person-type-text", "packages/core/src/privacy.ts", "    if (typeof typeText === 'string' && PERSON_IDENTIFIER_TEXT.test(typeText)) return true;\n", "", { suites: ['unit'] }),
  // w1-rf-v2-system-fold. Killing test: person-identifier rule: case, URL and type-text variants are withheld silently; an unrelated registry is still redacted; wave 1 judge matrix
  M("w1-rf-v2-system-fold", "packages/core/src/privacy.ts", "V2_0203_SYSTEMS.has(system.trim().toLowerCase()", "V2_0203_SYSTEMS.has(system", { suites: ['unit'] }),
  // w1-rf-type-code-case. Killing test: person-identifier rule: case, URL and type-text variants are withheld silently; an unrelated registry is still redacted
  M("w1-rf-type-code-case", "packages/core/src/privacy.ts", "PERSON_IDENTIFIER_TYPES.has(coding.code.trim().toUpperCase())", "PERSON_IDENTIFIER_TYPES.has(coding.code)", { suites: ['unit'] }),
  // w1-rf-unreviewed-extension. Killing test: Device masks: extensions at every depth and Device.parent identifier and display are withheld; the parent reference stays
  M("w1-rf-unreviewed-extension", "packages/core/src/privacy.ts", "      if (childKey === 'extension' && !scope.shared && UNREVIEWED_EXTENSION_TYPES.has(scope.type))", "      if (false && childKey === 'extension' && !scope.shared && UNREVIEWED_EXTENSION_TYPES.has(scope.type))", { suites: ['unit'] }),
  // w1-rf-device-parent. Killing test: Device masks: extensions at every depth and Device.parent identifier and display are withheld; the parent reference stays
  M("w1-rf-device-parent", "packages/core/src/privacy.ts", "'udiCarrier.carrierHRF', 'parent.identifier', 'parent.display']", "'udiCarrier.carrierHRF']", { suites: ['unit'] }),
  // w1-a3-underscore-identifier. Killing test: A3 instance rule: only listed systems, only system/value/use, at most eight, never batch (_identifier)
  M("w1-a3-underscore-identifier", "packages/core/src/privacy.ts", "  if (node._identifier !== undefined) return false;\n", "", { suites: ['unit'] }),
  // w1-a3-authorize-shared-policy. Killing test: A3 instance rule (contained listed Medication in the bound patient's order); A3 gateway: listed product identifiers are delivered
  M("w1-a3-authorize-shared-policy", "packages/core/src/privacy.ts", "  const shared = sharedPolicyFrom(privacy);\n  if (authorized(resource, patientId, base, shared)) return { kind: 'deliver', withhold: [] };", "  const shared = sharedPolicyFrom({});\n  if (authorized(resource, patientId, base, shared)) return { kind: 'deliver', withhold: [] };", { suites: ['unit'] }),
  // w1-a3-delivery-shared-policy. Killing test: A3 with A2: a redacted own order with a contained listed Medication is delivered; without the list it is withheld with the signal
  M("w1-a3-delivery-shared-policy", "packages/core/src/privacy.ts", "  return authorized(sanitized.resource, patientId, base, sharedPolicyFrom(privacy)) ?", "  return authorized(sanitized.resource, patientId, base, sharedPolicyFrom({})) ?", { suites: ['unit'] }),
  // w1-a3-summary-dropped. Killing test: A3 gateway: listed product identifiers are delivered; the default keeps today's withholding (support row summary)
  M("w1-a3-summary-dropped", "packages/core/src/support.ts", "row.resource_type === 'Medication' && listedSystems > 0 ?", "false ?", { suites: ['unit'] }),
  // Shared profiles, `_id` lists, the shared-record signal and confined target checks.
  // w1-d1-profile-unlisted. Killing test: shared profiles instance rule: every declared profile must be listed; every other check still applies
  M("w1-d1-profile-unlisted", "packages/core/src/privacy.ts", "  && (SHARED_INSTANCE_POLICY.profiles.includes(profile) || Boolean(shared.profiles?.has(profile)));", "  && true;", { suites: ['unit'] }),
  // w1-d1-profile-list-unwired. Killing test: shared profiles instance rule; shared profiles gateway: a listed profile is delivered with its meta.profile
  M("w1-d1-profile-list-unwired", "packages/core/src/privacy.ts", ", profiles: new Set(privacy?.sharedProfiles ?? []) };", " };", { suites: ['unit'] }),
  // w1-d1-config-unvalidated. Killing test: shared profiles config: listed canonicals are validated, bounded and never repeated
  M("w1-d1-config-unvalidated", "packages/core/src/index.ts", "sharedProfiles: z.array(z.string().min(1).max(256).refine(safeSharedProfile)).max(32).optional() }).optional(),", "sharedProfiles: z.array(z.string().min(1).max(256)).max(32).optional() }).optional(),", { suites: ['unit'] }),
  // w1-d1-duplicate-allowed. Killing test: shared profiles config: listed canonicals are validated, bounded and never repeated
  M("w1-d1-duplicate-allowed", "packages/core/src/index.ts", "  if (new Set(sharedProfiles).size !== sharedProfiles.length) ctx.addIssue({ code: 'custom', message: 'sharedProfiles must not repeat a profile' });\n", "", { suites: ['unit'] }),
  // w1-d1-link-screen. Killing test: shared profiles config (query, fragment, userinfo)
  M("w1-d1-link-screen", "packages/core/src/privacy.ts", "  return URL.canParse(value) && !protectedLink(value, 'profile', true);", "  return URL.canParse(value);", { suites: ['unit'] }),
  // w1-d1-scheme. Killing test: shared profiles config (relative, ftp, upper-case scheme, http without a host, bare urn)
  M("w1-d1-scheme", "packages/core/src/privacy.ts", " || !/^(?:https?:\\/\\/[^/?#]|urn:[A-Za-z0-9][A-Za-z0-9-]*:\\S)/.test(value)) return false;", ") return false;", { suites: ['unit'] }),
  // w1-d2-id-alternatives. Killing test: B2 syntax: `_id` alternatives must be plain FHIR ids, at most 100 within 4,096 bytes; _id lists gateway
  M("w1-d2-id-alternatives", "packages/core/src/query.ts", "  if (parts.length > MAX_ID_ALTERNATIVES) return undefined;\n", "", { suites: ['unit'] }),
  // w1-d2-id-bytes. Killing test: B2 syntax: `_id` alternatives must be plain FHIR ids, at most 100 within 4,096 bytes (64 ids of 64 characters)
  M("w1-d2-id-bytes", "packages/core/src/query.ts", "  if (value.length > MAX_ID_VALUE_BYTES) return undefined;\n", "", { suites: ['unit'] }),
  // w1-d2-id-bounds-everywhere. Killing test: B2 syntax (every other OR list keeps 33 alternatives and 2,048 bytes); _id lists gateway
  M("w1-d2-id-bounds-everywhere", "packages/core/src/query.ts", "  return name === '_id' ? splitIdList(value) : splitEscapedList(value);", "  return splitIdList(value);", { suites: ['unit'] }),
  // w1-d2-general-value-bytes. Killing test: B2 syntax (a 2,049-byte code value); _id lists gateway (a 2,049-byte code value never sends)
  M("w1-d2-general-value-bytes", "packages/core/src/query.ts", "  if (value.length > 2048) return undefined;\n  const parts: string[] = [];", "  const parts: string[] = [];", { suites: ['unit'] }),
  // w1-d3-shared-silent. Killing test: shared drops gateway: partial with the reason and warning, no total, sticky across pages and retained results
  M("w1-d3-shared-silent", "packages/core/src/index.ts", "      if (decision.kind === 'shared_withheld') partialReasons.add('SHARED_RECORDS_WITHHELD_BY_POLICY');\n", "", { suites: ['unit'] }),
  // w1-d3-warning-dropped. Killing test: shared drops gateway: partial with the reason and warning
  M("w1-d3-warning-dropped", "packages/core/src/index.ts", "    if (reasons.includes('SHARED_RECORDS_WITHHELD_BY_POLICY')) add('SHARED_RECORDS_WITHHELD_BY_POLICY');\n", "", { suites: ['unit'] }),
  // w1-d3-gate-complete. Killing test: shared drops strict gate: a completeness claim with the reason, or the reason without its warning, never leaves the gateway
  M("w1-d3-gate-complete", "packages/core/src/contracts.ts", "    if (c.state === 'complete_for_query' && c.reasons.includes('SHARED_RECORDS_WITHHELD_BY_POLICY')) return fail();\n", "", { suites: ['unit'] }),
  // w1-d3-gate-pairing. Killing test: shared drops strict gate: a completeness claim with the reason, or the reason without its warning, never leaves the gateway
  M("w1-d3-gate-pairing", "packages/core/src/contracts.ts", "    if (c.reasons.includes('SHARED_RECORDS_WITHHELD_BY_POLICY') !== env.warnings.some(w => w.code === 'SHARED_RECORDS_WITHHELD_BY_POLICY')) return fail();\n", "", { suites: ['unit'] }),
  // w1-d3-defect-silent. Killing test: shared drops: a policy failure is shared_withheld; other-patient evidence stays silent in both twins
  M("w1-d3-defect-silent", "packages/core/src/privacy.ts", "    if (judgement.ownDefect) return { kind: 'shared_withheld' };\n", "", { suites: ['unit'] }),
  // w1-d3-foreign-signalled. Killing test: shared drops twins: a shared record carrying another patient's evidence leaves the public output equal to the clean page
  M("w1-d3-foreign-signalled", "packages/core/src/privacy.ts", "    if (judgement.foreignEvidence) return { kind: 'silent' };\n    // Shared roots are never redacted", "    if (judgement.foreignEvidence) return { kind: 'shared_withheld' };\n    // Shared roots are never redacted", { suites: ['unit'] }),
  // w1-d4-check-errors-propagate. Killing test: reference targets: foreign, missing, withheld and failing targets give byte-identical refusals and never send the search
  M("w1-d4-check-errors-propagate", "packages/core/src/index.ts", "        confirmed = false;\n      }", "        throw error;\n      }", { suites: ['unit'] }),
  // w1-d4-exactly-one. Killing test: reference targets: byte-identical refusals (the target plus another own encounter)
  M("w1-d4-exactly-one", "packages/core/src/index.ts", "    if (snapshot.records.length !== 1) return false;\n", "", { suites: ['unit'] }),
  // w1-d4-requested-record. Killing test: reference targets: byte-identical refusals (source ignores _id; the target id with another type)
  M("w1-d4-requested-record", "packages/core/src/index.ts", "    if (snapshot.records[0]!.resource.resourceType !== type || snapshot.records[0]!.resource.id !== id) return false;\n", "", { suites: ['unit'] }),
  // w1-d4-check-page-trusted. Killing test: reference targets: only the requested record is trusted; other records on the check page are not
  M("w1-d4-check-page-trusted", "packages/core/src/index.ts", "if (noteTargets) this.noteVerifiedTarget(raw, budget);", "this.noteVerifiedTarget(raw, budget);", { suites: ['unit'] }),
  // w1-d1-count-unbounded. Killing test: shared profiles config: listed canonicals are validated, bounded and never repeated (33 entries)
  M("w1-d1-count-unbounded", "packages/core/src/index.ts", "sharedProfiles: z.array(z.string().min(1).max(256).refine(safeSharedProfile)).max(32).optional() }).optional(),", "sharedProfiles: z.array(z.string().min(1).max(256).refine(safeSharedProfile)).optional() }).optional(),", { suites: ['unit'] }),
  // w1-d3-person-shaped-signalled. Killing tests: shared drops: person-shaped records stay silent whatever their values; shared drops twins: a person-shaped record leaves the public output equal to a page without it
  M("w1-d3-person-shaped-signalled", "packages/core/src/privacy.ts", "    if (personShapedSharedRecord(resource, privacy)) return { kind: 'silent' };\n", "", { suites: ['unit'] }),
  // w1-d3-residential-location-signalled. Killing tests: shared drops: person-shaped records stay silent (residential, untyped, PTRES Locations); person-shaped twins (address probe, _id probe)
  M("w1-d3-residential-location-signalled", "packages/core/src/privacy.ts", "  if (resource.resourceType === 'Location' && !facilityLocation(resource)) return true;\n", "", { suites: ['unit'] }),
  // w1-d3-contact-signalled. Killing tests: shared drops: person-shaped records stay silent (Organization with a contact person); person-shaped twins
  M("w1-d3-contact-signalled", "packages/core/src/privacy.ts", "  if (resource.resourceType === 'Organization' && (resource.contact !== undefined || resource._contact !== undefined)) return true;\n", "", { suites: ['unit'] }),
  // w1-d3-person-identifier-signalled. Killing tests: shared drops: person-shaped records stay silent (patient and person identifier systems and types); person-shaped twins (MRN-A, MRN-B)
  M("w1-d3-person-identifier-signalled", "packages/core/src/privacy.ts", "  return resource.identifier !== undefined && logicalPatientIdentifier(resource.identifier, new Set(privacy?.patientIdentifierSystems ?? []));", "  return false;", { suites: ['unit'] }),
  // w1-d3-unverifiable-shared-silent. Killing test: shared drops: unverifiable clinical-actor references inside a contained record are signalled
  M("w1-d3-unverifiable-shared-silent", "packages/core/src/privacy.ts", "    if (judgement.withholdReferences.length) return { kind: 'shared_withheld' };\n", "", { suites: ['unit'] }),
  // w1-d4-check-unconfined. Killing test: reference targets tests and B1 gateway tests (exact confined check request)
  M("w1-d4-check-unconfined", "packages/core/src/index.ts", "    const params = this.prepareSearch(type, [{ name: '_id', value: id }], 1);", "    const params = [{ name: '_id', value: id }, { name: '_count', value: '1' }];", { suites: ['unit'] }),
  // Reference-only medication mixes (opt-in through privacy.sharedIdentifierSystems).
  // w1c-mix-unwired. Killing test: 1c mix rule: a listed mix is classified; the default empty list withholds it with the shared signal; 1c gateway: a listed mix is found by _id and read; 1c stdio modern/legacy
  M("w1c-mix-unwired", "packages/core/src/privacy.ts", "(node.ingredient === undefined || coded(node.code) || referenceOnlyMix(node))", "(node.ingredient === undefined || coded(node.code))", { suites: ['unit'] }),
  // w1c-mix-listed-skipped. Killing test: 1c mix rule: a listed mix is classified; the default empty list withholds it with the shared signal (empty list); 1c mix rule: one failing twin for each rule term (unlisted system); 1c gateway: a listed mix is found by _id and read (default)
  M("w1c-mix-listed-skipped", "packages/core/src/privacy.ts", "|| referenceOnlyMix(node)) && listedIdentifiers(node, shared) }", "|| referenceOnlyMix(node)) && (referenceOnlyMix(node) || listedIdentifiers(node, shared)) }", { suites: ['unit'] }),
  // w1c-mix-code-companion. Killing test: 1c mix rule: one failing twin for each rule term (_code companion)
  M("w1c-mix-code-companion", "packages/core/src/privacy.ts", "node._code === undefined && node.identifier !== undefined", "node.identifier !== undefined", { suites: ['unit'] }),
  // w1c-mix-identifier-optional. Killing test: 1c mix rule: one failing twin for each rule term (no identifier)
  M("w1c-mix-identifier-optional", "packages/core/src/privacy.ts", " && node.identifier !== undefined\n  && node._ingredient", "\n  && node._ingredient", { suites: ['unit'] }),
  // w1c-mix-ingredient-companion. Killing test: 1c mix rule: one failing twin for each rule term (_ingredient companion)
  M("w1c-mix-ingredient-companion", "packages/core/src/privacy.ts", "  && node._ingredient === undefined && Array.isArray(node.ingredient)", "  && Array.isArray(node.ingredient)", { suites: ['unit'] }),
  // w1c-mix-count-min. Killing test: 1c mix rule: one failing twin for each rule term (no ingredients)
  M("w1c-mix-count-min", "packages/core/src/privacy.ts", " && node.ingredient.length >= 1 && ", " && ", { suites: ['unit'] }),
  // w1c-mix-count-max. Killing test: 1c mix rule: one failing twin for each rule term (33 ingredients)
  M("w1c-mix-count-max", "packages/core/src/privacy.ts", " && node.ingredient.length <= MAX_MIX_INGREDIENTS\n", "\n", { suites: ['unit'] }),
  // w1c-mix-bound. Killing test: 1c mix rule: a listed mix is classified; the default empty list withholds it with the shared signal (the bound is 32)
  M("w1c-mix-bound", "packages/core/src/privacy.ts", "export const MAX_MIX_INGREDIENTS = 32;", "export const MAX_MIX_INGREDIENTS = 33;", { suites: ['unit'] }),
  // w1c-ingredient-keys. Killing test: 1c mix rule: one failing twin for each rule term (itemCodeableConcept beside itemReference, empty extension, id on an ingredient)
  M("w1c-ingredient-keys", "packages/core/src/privacy.ts", "if (!plainNode(item) || Object.keys(item).some(key => !MIX_INGREDIENT_KEYS.has(key))) return false;", "if (!plainNode(item)) return false;", { suites: ['unit'] }),
  // w1c-item-reference-keys. Killing test: 1c mix rule: one failing twin for each rule term (display, identifier, type on itemReference); 1c gateway: a listed mix is found by _id and read (display twin)
  M("w1c-item-reference-keys", "packages/core/src/privacy.ts", "if (!plainNode(reference) || Object.keys(reference).some(key => key !== 'reference')) return false;", "if (!plainNode(reference)) return false;", { suites: ['unit'] }),
  // w1c-reference-target-type. Killing test: 1c mix rule: one failing twin for each rule term (Substance, Organization targets)
  M("w1c-reference-target-type", "packages/core/src/privacy.ts", "const MIX_MEDICATION_REFERENCE = /^Medication\\/[A-Za-z0-9.-]{1,64}$/;", "const MIX_MEDICATION_REFERENCE = /^[A-Z][A-Za-z]+\\/[A-Za-z0-9.-]{1,64}$/;", { suites: ['unit'] }),
  // w1c-reference-form. Killing test: 1c mix rule: one failing twin for each rule term (absolute, versioned, trailing space, over-long id)
  M("w1c-reference-form", "packages/core/src/privacy.ts", "const MIX_MEDICATION_REFERENCE = /^Medication\\/[A-Za-z0-9.-]{1,64}$/;", "const MIX_MEDICATION_REFERENCE = /Medication\\/[A-Za-z0-9.-]{1,64}/;", { suites: ['unit'] }),
  // w1c-isactive-type. Killing test: 1c mix rule: one failing twin for each rule term (isActive string, isActive null)
  M("w1c-isactive-type", "packages/core/src/privacy.ts", "  if (item.isActive !== undefined && typeof item.isActive !== 'boolean') return false;\n", "", { suites: ['unit'] }),
  // w1c-strength-ratio-keys. Killing test: 1c mix rule: one failing twin for each rule term (strength extension on the Ratio)
  M("w1c-strength-ratio-keys", "packages/core/src/privacy.ts", "(plainNode(strength) && Object.keys(strength).every(key => key === 'numerator' || key === 'denominator')", "(plainNode(strength)", { suites: ['unit'] }),
  // w1c-strength-quantity-keys. Killing test: 1c mix rule: one failing twin for each rule term (strength comparator, extension on a Quantity, _value companion)
  M("w1c-strength-quantity-keys", "packages/core/src/privacy.ts", "plainNode(value) && Object.keys(value).every(key => MIX_QUANTITY_KEYS.has(key))", "plainNode(value)", { suites: ['unit'] }),
  // w1c-strength-numeric. Killing test: 1c mix rule: one failing twin for each rule term (strength string value, missing value)
  M("w1c-strength-numeric", "packages/core/src/privacy.ts", "  && ((typeof value.value === 'number' && Number.isFinite(value.value)) || isFhirDecimal(value.value))\n", "", { suites: ['unit'] }),
  // w1c-strength-strings. Killing test: 1c mix rule: one failing twin for each rule term (strength numeric unit, system, code)
  M("w1c-strength-strings", "packages/core/src/privacy.ts", "  && ['unit', 'system', 'code'].every(key => value[key] === undefined || typeof value[key] === 'string');", "  && true;", { suites: ['unit'] }),
  // w1c-strength-denominator. Killing test: 1c mix rule: one failing twin for each rule term (strength missing denominator)
  M("w1c-strength-denominator", "packages/core/src/privacy.ts", "    && mixQuantity(strength.numerator) && mixQuantity(strength.denominator));", "    && mixQuantity(strength.numerator));", { suites: ['unit'] }),
  // count-once-text-copy-only. Measure the text copy only, in the producer and the final gate. Killing test: count once modern: in structured-evidence-v1 the larger structured copy is what is bounded
  C("count-once-text-copy-only", [
    { "file": "packages/core/src/contracts.ts", "find": "  return Math.max(text, structured);", "replace": "  return text + 0 * structured;" },
    { "file": "packages/core/src/contracts.ts", "find": "    const measured = Math.max(textBytes, Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8'));", "replace": "    const measured = textBytes;" },
  ], { suites: ['unit'] }),
  // count-once-structured-copy-only. Measure the structured copy only, in the producer and the final gate. Killing test: count once modern: a labelled full-text fallback counts its larger text copy
  C("count-once-structured-copy-only", [
    { "file": "packages/core/src/contracts.ts", "find": "  return Math.max(text, structured);", "replace": "  return structured + 0 * text;" },
    { "file": "packages/core/src/contracts.ts", "find": "    const measured = Math.max(textBytes, Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8'));", "replace": "    const measured = Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8') + 0 * textBytes;" },
  ], { suites: ['unit'] }),
  // count-once-gate-text-only. The final gate alone measures the text copy only. Killing test: count once: the final gate refuses a complete result over the wire invariant even when the model copy fits
  M("count-once-gate-text-only", "packages/core/src/contracts.ts", "    const measured = Math.max(textBytes, Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8'));", "    const measured = textBytes;", { suites: ['unit'] }),
  // count-once-gate-structured-only. The final gate alone measures the structured copy only. Killing test: count once: the final gate refuses a complete result over the wire invariant even when the model copy fits
  M("count-once-gate-structured-only", "packages/core/src/contracts.ts", "    const measured = Math.max(textBytes, Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8'));", "    const measured = Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8') + 0 * textBytes;", { suites: ['unit'] }),
  // count-once-wire-invariant-skipped. Skip the wire invariant in the fitting test and the final gate. Killing tests: count once: the wire ceiling and the shared fitting test bound both measures; count once: the final gate refuses a complete result over the wire invariant even when the model copy fits
  C("count-once-wire-invariant-skipped", [
    { "file": "packages/core/src/contracts.ts", "find": "  return budget.bytes_returned > budget.byte_limit - reserve || budget.wire_bytes > wireByteCeiling(budget.byte_limit) - reserve;", "replace": "  return budget.bytes_returned > budget.byte_limit - reserve;" },
    { "file": "packages/core/src/contracts.ts", "find": "    if (wireMeasured !== env.budget.wire_bytes || wireMeasured > wireByteCeiling(env.budget.byte_limit)) return fail('INVALID_FINAL_BYTES');", "replace": "    if (wireMeasured !== env.budget.wire_bytes) return fail('INVALID_FINAL_BYTES');" },
  ], { suites: ['unit'] }),
  // count-once-wire-fit-skipped. The fitting test alone ignores the wire invariant. Killing test: count once: the wire ceiling and the shared fitting test bound both measures
  M("count-once-wire-fit-skipped", "packages/core/src/contracts.ts", "  return budget.bytes_returned > budget.byte_limit - reserve || budget.wire_bytes > wireByteCeiling(budget.byte_limit) - reserve;", "  return budget.bytes_returned > budget.byte_limit - reserve;", { suites: ['unit'] }),
  // count-once-wire-gate-skipped. The final gate alone ignores the wire invariant. Killing test: count once: the final gate refuses a complete result over the wire invariant even when the model copy fits
  M("count-once-wire-gate-skipped", "packages/core/src/contracts.ts", "    if (wireMeasured !== env.budget.wire_bytes || wireMeasured > wireByteCeiling(env.budget.byte_limit)) return fail('INVALID_FINAL_BYTES');", "    if (wireMeasured !== env.budget.wire_bytes) return fail('INVALID_FINAL_BYTES');", { suites: ['unit'] }),
  // count-once-wire-ceiling-loosened. The wire invariant becomes 4 x cap + 4096. Killing test: count once: the wire ceiling and the shared fitting test bound both measures
  M("count-once-wire-ceiling-loosened", "packages/core/src/contracts.ts", "  return 3 * byteLimit + 4096;", "  return 4 * byteLimit + 4096;", { suites: ['unit'] }),
  // count-once-wire-not-converged. bytesV2 stops on bytes_returned alone and never writes wire_bytes. Killing test: count once modern: a page whose model copy is just under the cap is delivered whole, with a wire result about twice the cap
  C("count-once-wire-not-converged", [
    { "file": "packages/core/src/index.ts", "find": "      if (bytes === envelope.budget.bytes_returned && wire === envelope.budget.wire_bytes) return;", "replace": "      if (bytes === envelope.budget.bytes_returned) return;" },
    { "file": "packages/core/src/index.ts", "find": "      envelope.budget.wire_bytes = wire;\n", "replace": "" },
  ], { suites: ['unit'] }),
  // count-once-emergency-wire-unmeasured. Emergency delivery never measures wire_bytes. Killing test: count once: the default is 49152 one-copy bytes when limits are unset
  M("count-once-emergency-wire-unmeasured", "packages/core/src/index.ts", "      env.budget.wire_bytes = wire;\n", "", { suites: ['unit'] }),
  // count-once-eval-claim-not-measured. The eval takes the gateway's bytes_returned claim as its model-copy measurement. Killing test: result bytes are measured from the emitted MCP result, so adapter-added bytes the gateway never counted fail the ceiling
  M("count-once-eval-claim-not-measured", "packages/evals/src/runner.ts", "      model_copy_bytes: outcome.protocolError ? 0 : measuredModelCopyBytes(outcome.result.content, outcome.resultText, outcome.result.structuredContent),", "      model_copy_bytes: envelope?.budget.bytes_returned ?? 0,", { suites: ['unit'] }),
  // count-once-eval-wire-unchecked. The eval skips the wire invariant against the requested and reported ceilings. Killing test: result bytes are measured from the emitted MCP result, so adapter-added bytes the gateway never counted fail the ceiling
  C("count-once-eval-wire-unchecked", [
    { "file": "packages/evals/src/runner.ts", "find": "record.metrics.wire_result_bytes > wireCeiling(record.metrics.requested_max_bytes)", "replace": "false" },
    { "file": "packages/evals/src/runner.ts", "find": "record.metrics.wire_result_bytes > wireCeiling(record.metrics.byte_limit)", "replace": "false" },
  ], { suites: ['unit'] }),
  // count-once-eval-wire-accounting-skipped. The run gate ignores wire_bytes mismatches. Killing test: independent byte accounting gates the exit code
  M("count-once-eval-wire-accounting-skipped", "packages/evals/src/runner.ts", "\n    || accounting.wire_under_reported_calls > 0 || accounting.wire_over_reported_calls > 0;", ";", { suites: ['unit'] }),
  // count-once-verify-wire-skipped. The quickstart verifier skips the wire invariant. Killing test: quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read
  M("count-once-verify-wire-skipped", "examples/quickstart/verify.ts", "modelBytes > ceiling || call.resultBytes > 3 * ceiling + 4096)", "modelBytes > ceiling)", { suites: ['unit'] }),
  // count-once-scan-wire-skipped. The observed-code scan skips the wire invariant. Killing test: scan refuses per-call wire bytes without retry
  M("count-once-scan-wire-skipped", "examples/observed-code-scan.ts", " || wire > 3 * limits.maxBytesPerCall + 4096", "", { suites: ['unit'] }),
  // count-once-underreport-wire-bytes. bytesV2 under-reports wire_bytes by one, mirroring underreport-bytes. Killing test: count once modern: a page whose model copy is just under the cap is delivered whole, with a wire result about twice the cap
  M("count-once-underreport-wire-bytes", "packages/core/src/index.ts", "const bytes = modelCopyBytes(result), wire = Buffer.byteLength(JSON.stringify(result));", "const bytes = modelCopyBytes(result), wire = Buffer.byteLength(JSON.stringify(result)) - 1;", { suites: ['unit'] }),
  // Cursor eviction: a full clinical quota evicts res_ first, then the oldest cursor, never a
  // reserved or in-flight one, and an evicted cursor reads exactly like an expired one. Killing tests in tests/cursor-eviction.test.ts.
  // cursor-eviction-disabled. The clinical store goes back to refusing once cursors fill the quota. Killing tests: 300 cursor-issuing calls never get RETENTION_LIMIT; the chain head is never evicted while draining
  M("cursor-eviction-disabled", "packages/core/src/index.ts", "evictableKinds: ['res', 'cur'], protectedHandles", "evictableKinds: ['res'], protectedHandles"),
  // evict-cursor-before-res-config. The gateway lists cursors before res_ handles. Killing test: cursor eviction gateway: res_ handles are evicted before cursors
  M("evict-cursor-before-res-config", "packages/core/src/index.ts", "evictableKinds: ['res', 'cur'], protectedHandles", "evictableKinds: ['cur', 'res'], protectedHandles"),
  // evict-live-cursor-before-res. Eviction takes the oldest handle of any evictable kind, so an old cursor goes before a newer res_. Killing tests: res_ handles are evicted before any cursor (store and gateway)
  M("evict-live-cursor-before-res", "packages/core/src/store.ts",
    "for (const [handle, item] of this.items) if (item.kind === kind && item.seq < oldestSeq && !exempt(handle))",
    "for (const [handle, item] of this.items) if (kinds.includes(item.kind) && item.seq < oldestSeq && !exempt(handle))"),
  // evict-newest-cursor. Eviction takes the newest handle of a kind instead of the oldest. Killing test: res_ handles are evicted before any cursor, then the oldest cursor by sequence number
  M("evict-newest-cursor", "packages/core/src/store.ts",
    "let oldest: string | undefined; let oldestSeq = Infinity;\n      for (const [handle, item] of this.items) if (item.kind === kind && item.seq < oldestSeq",
    "let oldest: string | undefined; let oldestSeq = -Infinity;\n      for (const [handle, item] of this.items) if (item.kind === kind && item.seq > oldestSeq"),
  // evict-reserved. putBatch ignores the handles the current request reserved. Killing tests: a handle reserved by the current request is never evicted; the chain head is never evicted while draining
  M("evict-reserved", "packages/core/src/store.ts",
    "while (over()) if (!this.evictOldestEvictable(except)) throw this.retentionFault();",
    "while (over()) if (!this.evictOldestEvictable()) throw this.retentionFault();"),
  // evict-reserved-not-passed. The result write no longer names the cursor issued with it. Killing test: the current chain head is never evicted while draining
  M("evict-reserved-not-passed", "packages/core/src/index.ts",
    "            originalExpiry: snapshot.expiresAt }], this.reserved.get(env as unknown as GatewayEnvelope) ?? [])[0]!;",
    "            originalExpiry: snapshot.expiresAt }])[0]!;"),
  // evict-in-flight. The store ignores protected handles. Killing tests: a protected (in-flight) cursor is never evicted; a cursor with an in-flight page load is not evicted
  M("evict-in-flight", "packages/core/src/store.ts",
    "const exempt = (handle: string) => except.includes(handle) || this.options.protectedHandles?.(handle) === true;",
    "const exempt = (handle: string) => except.includes(handle);"),
  // evict-in-flight-not-wired. The gateway does not report in-flight page loads (now covered by the served-cursor count) to the store. Killing test: a cursor with an in-flight page load is not evicted
  M("evict-in-flight-not-wired", "packages/core/src/index.ts",
    "evictableKinds: ['res', 'cur'], protectedHandles: handle => this.servingCursors.has(handle) });",
    "evictableKinds: ['res', 'cur'] });"),
  // evict-served-cursor. fhir_page no longer counts the cursor it serves, so minting its successor can evict it. Killing tests: a served cursor survives minting its successor and replays at once; two concurrent pages on the oldest cursor both render
  M("evict-served-cursor", "packages/core/src/index.ts",
    "    this.servingCursors.set(cursor, (this.servingCursors.get(cursor) ?? 0) + 1);\n",
    ""),
  // evict-served-cursor-count-as-set. Concurrent calls on one cursor share a flag instead of a count, so the first to finish unprotects the cursor for the other. Killing test: concurrent calls count the served cursor, so one leaving early does not unprotect it for the other
  M("evict-served-cursor-count-as-set", "packages/core/src/index.ts",
    "      if (left > 0) this.servingCursors.set(cursor, left); else this.servingCursors.delete(cursor);",
    "      void left; this.servingCursors.delete(cursor);"),
  // evicted-cursor-distinct-refusal. An evicted handle leaves a tombstone and reads with its own refusal text. Killing test: an evicted cursor and an expired cursor give the identical store fault
  C("evicted-cursor-distinct-refusal", [
    { "file": "packages/core/src/store.ts", "find": "  private seq = 0;\n", "replace": "  private seq = 0;\n  private readonly evictedHandles = new Set<string>();\n" },
    { "file": "packages/core/src/store.ts", "find": "      if (oldest) { this.remove(oldest); this.schedule(); return true; }", "replace": "      if (oldest) { this.remove(oldest); this.evictedHandles.add(oldest); this.schedule(); return true; }" },
    { "file": "packages/core/src/store.ts", "find": "    if (!item || !blob) throw new GatewayFault(this.options.unavailableCode ?? 'RESULT_EXPIRED', 'Result is unavailable or expired; repeat the original query.');", "replace": "    if (!item || !blob) throw new GatewayFault(this.options.unavailableCode ?? 'RESULT_EXPIRED', this.evictedHandles.has(handle) ? 'Result was evicted to make room; repeat the original query.' : 'Result is unavailable or expired; repeat the original query.');" },
  ]),
  // Pages without a self link. Part 1: one mutant per record-checker rule
  // (packages/core/src/record-predicates.ts), each killed by the named test in tests/no-self-link.test.ts.
  // nsl-id-unchecked: `_id` matches any record. Killing test: no-self checker: reference and _id rules
  M("nsl-id-unchecked", "packages/core/src/record-predicates.ts", "if (predicate.kind === 'id') return typeof record.id === 'string' && predicate.ids.includes(record.id);", "if (predicate.kind === 'id') return true;"),
  // nsl-id-alternatives-unvalidated: an `_id` value that is not a list of ids is checkable. Killing test: no-self checker: only the covered token, date, reference and _id forms are checkable
  M("nsl-id-alternatives-unvalidated", "packages/core/src/record-predicates.ts", "return ids && ids.length && ids.every(isId) ? { name: pair.name, kind: 'id', ids } : undefined;", "return ids && ids.length ? { name: pair.name, kind: 'id', ids } : undefined;"),
  // nsl-definition-unbound: a parameter resolved to another definition is checked by the classified paths. Killing test: no-self checker: only the covered token, date, reference and _id forms are checkable
  M("nsl-definition-unbound", "packages/core/src/record-predicates.ts", "if (!parameter || definitionUrl !== parameter.url) return undefined;", "if (!parameter) return undefined;"),
  // nsl-token-null-system: `|code` (a coding with no system) is checkable, as a bare code. Killing tests: no-self checker: only the covered token, date, reference and _id forms are checkable; no-self page: refused when one filter is not gateway-checkable
  C("nsl-token-null-system", [
    { "file": "packages/core/src/record-predicates.ts", "find": "if (token.system === null || token.code === undefined || token.code === '') return undefined;", "replace": "if (token.code === undefined || token.code === '') return undefined;" },
    { "file": "packages/core/src/record-predicates.ts", "find": "alternatives.push(token.system === undefined ? { code: token.code } : { system: token.system, code: token.code });", "replace": "alternatives.push(token.system == null ? { code: token.code } : { system: token.system, code: token.code });" },
  ]),
  // nsl-token-any-code: `system|` (any code) is checkable and matches every code in that system. Killing tests: no-self checker: only the covered token, date, reference and _id forms are checkable; no-self page: refused when one filter is not gateway-checkable
  C("nsl-token-any-code", [
    { "file": "packages/core/src/record-predicates.ts", "find": "if (token.system === null || token.code === undefined || token.code === '') return undefined;", "replace": "if (token.system === null || token.code === '') return undefined;" },
    { "file": "packages/core/src/record-predicates.ts", "find": "alternatives.push(token.system === undefined ? { code: token.code } : { system: token.system, code: token.code });", "replace": "alternatives.push(token.system === undefined ? { code: token.code ?? '' } : { system: token.system, code: token.code ?? '' });" },
    { "file": "packages/core/src/record-predicates.ts", "find": "  if (!sameCode(coding.code, alternative.code)) return false;\n", "replace": "  if (alternative.code && !sameCode(coding.code, alternative.code)) return false;\n" },
  ]),
  // nsl-token-system-ignored: `system|code` matches the code in any system. Killing test: no-self checker: token system and code rules
  M("nsl-token-system-ignored", "packages/core/src/record-predicates.ts", "  return coding.system === alternative.system;\n", "  return true;\n"),
  // nsl-token-code-ignored: any code satisfies a token. Killing test: no-self checker: token system and code rules
  M("nsl-token-code-ignored", "packages/core/src/record-predicates.ts", "  if (!sameCode(coding.code, alternative.code)) return false;\n", ""),
  // nsl-token-implicit-system-refused: a `code` element is compared with the search system it never carries, refusing a correct server. Killing test: no-self checker: token system and code rules
  M("nsl-token-implicit-system-refused", "packages/core/src/record-predicates.ts", "if (alternative.system === undefined || coding.implicitSystem) return true;", "if (alternative.system === undefined) return true;"),
  // nsl-token-identifier-value-ignored: an Identifier is read through `code`, never its value. Killing test: no-self checker: token system and code rules
  M("nsl-token-identifier-value-ignored", "packages/core/src/record-predicates.ts", "if (type === 'Identifier') return coding(value, 'value');", "if (type === 'Identifier') return coding(value, 'code');"),
  // nsl-token-malformed-matches: a malformed coding counts as a match. Killing test: no-self checker: token system and code rules
  M("nsl-token-malformed-matches", "packages/core/src/record-predicates.ts", "if (!found) { unjudgeable = true; continue; }", "if (!found) return true;"),
  // nsl-token-or-first-only: only the first OR alternative of a token is tried. Killing test: no-self checker: token system and code rules
  M("nsl-token-or-first-only", "packages/core/src/record-predicates.ts", "if (predicate.alternatives.some(alternative => found.some(coding => tokenMatch(alternative, coding)))) return true;", "if (predicate.alternatives.slice(0, 1).some(alternative => found.some(coding => tokenMatch(alternative, coding)))) return true;"),
  // nsl-date-prefix-any: `ne`, `ap`, `sa` and `eb` are checkable and always satisfied. Killing tests: no-self checker: only the covered token, date, reference and _id forms are checkable; no-self page: refused when one filter is not gateway-checkable
  C("nsl-date-prefix-any", [
    { "file": "packages/core/src/record-predicates.ts", "find": "  if (!CHECKABLE_DATE_PREFIXES.includes(prefix)) return undefined;\n", "replace": "" },
    { "file": "packages/core/src/record-predicates.ts", "find": "    default: return false;\n", "replace": "    default: return true;\n" },
  ]),
  // nsl-date-eq-any: `eq` holds whatever the ranges. Killing test: no-self checker: date boundary cases for imprecise and zoneless values
  M("nsl-date-eq-any", "packages/core/src/record-predicates.ts", "case 'eq': return record.lo < search.endMax && search.startMin < record.hi;", "case 'eq': return true;"),
  // nsl-date-gt-as-ge: `gt` accepts a record ending inside the search value. Killing test: no-self checker: date boundary cases for imprecise and zoneless values
  M("nsl-date-gt-as-ge", "packages/core/src/record-predicates.ts", "case 'gt': return record.hi > search.endMin;", "case 'gt': return record.hi > search.startMin;"),
  // nsl-date-ge-any: `ge` holds whatever the ranges. Killing test: no-self checker: date boundary cases for imprecise and zoneless values
  M("nsl-date-ge-any", "packages/core/src/record-predicates.ts", "case 'ge': return record.hi > search.startMin;", "case 'ge': return true;"),
  // nsl-date-lt-as-le: `lt` accepts a record beginning inside the search value. Killing test: no-self checker: date boundary cases for imprecise and zoneless values
  M("nsl-date-lt-as-le", "packages/core/src/record-predicates.ts", "case 'lt': return record.lo < search.startMax;", "case 'lt': return record.lo < search.endMax;"),
  // nsl-date-le-any: `le` holds whatever the ranges. Killing test: no-self checker: date boundary cases for imprecise and zoneless values
  M("nsl-date-le-any", "packages/core/src/record-predicates.ts", "case 'le': return record.lo < search.endMax;", "case 'le': return true;"),
  // nsl-date-zoneless-exact: a value without a timezone is read as UTC, refusing a correct server at a boundary. Killing test: no-self checker: date boundary cases for imprecise and zoneless values
  M("nsl-date-zoneless-exact", "packages/core/src/record-predicates.ts", "slack: interval.timezoneQualified ? 0 : ZONELESS_SLACK_MS };", "slack: 0 };"),
  // nsl-date-zoned-widened: a value with a timezone gets the zoneless slack, accepting contradictions. Killing test: no-self checker: date boundary cases for imprecise and zoneless values
  M("nsl-date-zoned-widened", "packages/core/src/record-predicates.ts", "slack: interval.timezoneQualified ? 0 : ZONELESS_SLACK_MS };", "slack: ZONELESS_SLACK_MS };"),
  // nsl-date-open-end-closed: an open Period end is read as no end, refusing a correct server. Killing test: no-self checker: date boundary cases for imprecise and zoneless values
  M("nsl-date-open-end-closed", "packages/core/src/record-predicates.ts", "hi: hi ? hi.end + hi.slack : Number.POSITIVE_INFINITY };", "hi: hi ? hi.end + hi.slack : Number.NEGATIVE_INFINITY };"),
  // nsl-date-submillisecond-judged: sub-millisecond values are compared at millisecond precision. Killing tests: no-self checker: date boundary cases for imprecise and zoneless values; no-self checker: only the covered token, date, reference and _id forms are checkable
  M("nsl-date-submillisecond-judged", "packages/core/src/record-predicates.ts", "if (!interval || interval.subMillisecond) return undefined;", "if (!interval) return undefined;"),
  // nsl-variant-unflagged: an unsupported choice variant (Timing) reads as no value instead of unjudgeable. Killing test: no-self checker: date boundary cases for imprecise and zoneless values
  M("nsl-variant-unflagged", "packages/core/src/record-predicates.ts", "if (!checkable) { unjudgeable = true; return; }", "if (!checkable) return;"),
  // nsl-extension-only-unflagged: an extension-only primitive reads as no value instead of unjudgeable. Killing tests: no-self checker: token system and code rules; no-self checker: date boundary cases for imprecise and zoneless values
  M("nsl-extension-only-unflagged", "packages/core/src/record-predicates.ts", "    if (companion !== undefined && (value === undefined || (Array.isArray(value) && value.some(item => item === null)))) unjudgeable = true;\n", ""),
  // nsl-no-value-matches: a record with no value for the parameter satisfies it. Killing tests: no-self checker: date boundary cases for imprecise and zoneless values; no-self checker: reference and _id rules
  M("nsl-no-value-matches", "packages/core/src/record-predicates.ts", "  return unjudgeable ? undefined : false;\n", "  return unjudgeable ? undefined : true;\n"),
  // nsl-reference-type-ignored: `Type/id` matches the id under any type. Killing test: no-self checker: reference and _id rules
  M("nsl-reference-type-ignored", "packages/core/src/record-predicates.ts", "alternative.id === parsed.id && (alternative.type === undefined || alternative.type === parsed.type)", "alternative.id === parsed.id"),
  // nsl-reference-id-ignored: a reference of the right type matches any id. Killing test: no-self checker: reference and _id rules
  M("nsl-reference-id-ignored", "packages/core/src/record-predicates.ts", "alternative.id === parsed.id && (alternative.type === undefined || alternative.type === parsed.type)", "(alternative.type === undefined || alternative.type === parsed.type)"),
  // nsl-reference-foreign-source: an absolute reference to another source is compared as if local. Killing test: no-self checker: reference and _id rules
  M("nsl-reference-foreign-source", "packages/core/src/record-predicates.ts", "if (!(parsed.form === 'relative' || (parsed.form === 'absolute' && parsed.sameSource)) || !parsed.type || !parsed.id)", "if (!(parsed.form === 'relative' || parsed.form === 'absolute') || !parsed.type || !parsed.id)"),
  // nsl-reference-logical-matches: a reference without a literal `reference` counts as a match. Killing test: no-self checker: reference and _id rules
  M("nsl-reference-logical-matches", "packages/core/src/record-predicates.ts", "if (typeof reference !== 'string') { unjudgeable = true; continue; }", "if (typeof reference !== 'string') return true;"),
  // nsl-reference-forms-any: absolute, versioned, conditional and contained search values are checkable. Killing test: no-self checker: only the covered token, date, reference and _id forms are checkable
  M("nsl-reference-forms-any", "packages/core/src/record-predicates.ts", "    else if (isId(value)) alternatives.push({ id: value });\n    else return undefined;\n", "    else alternatives.push({ id: value });\n"),
  // nsl-repeated-first-only: only the first of repeated parameters is checked. Killing test: no-self checker: every repeated parameter holds on every record
  M("nsl-repeated-first-only", "packages/core/src/record-predicates.ts", "  for (const predicate of predicates) {\n", "  for (const predicate of predicates.slice(0, 1)) {\n"),
  // nsl-records-first-only: only the first returned record is checked. Killing test: no-self checker: every repeated parameter holds on every record
  M("nsl-records-first-only", "packages/core/src/record-predicates.ts", "    for (const record of records) {\n      const outcome = recordMatches(predicate, record, base);", "    for (const record of records.slice(0, 1)) {\n      const outcome = recordMatches(predicate, record, base);"),
  // Part 2: one mutant per acceptance condition (packages/core/src/index.ts, query.ts, contracts.ts). The opt-in itself is missing-self-permissive above.
  // nsl-p2-uncheckable-skipped: an uncheckable filter is skipped instead of refusing the page. Killing test: no-self page: refused when one filter is not gateway-checkable
  M("nsl-p2-uncheckable-skipped", "packages/core/src/index.ts", "      if (!predicate) throw new GatewayFault('UNVERIFIED_QUERY', 'Source did not provide effective-query evidence.');\n      predicates.set(index, predicate);", "      if (!predicate) return;\n      predicates.set(index, predicate);"),
  // nsl-p2-outcome-ignored: an OperationOutcome questioning a parameter does not fail the page. Killing tests: no-self page: an OperationOutcome reporting an ignored or unsupported parameter fails it; no-self continuation: every continuation page passes the record checks itself
  M("nsl-p2-outcome-ignored", "packages/core/src/index.ts", "    if (questioned.size) throw new GatewayFault('UNVERIFIED_QUERY', 'Source did not provide effective-query evidence.');", "    if (Boolean(0)) throw new GatewayFault('UNVERIFIED_QUERY', 'Source did not provide effective-query evidence.');"),
  // nsl-p2-contradiction-delivered: a returned record that fails a checked filter is delivered. Killing tests: no-self page: a returned record that fails a filter refuses the page as contradicted; no-self page: twin refusals and acceptances are identical whatever another patient's data is
  M("nsl-p2-contradiction-delivered", "packages/core/src/index.ts", "      if (outcome.status === 'contradicted') contradict();", "      if (Boolean(0)) contradict();"),
  // nsl-p2-unjudgeable-delivered: a record that cannot be judged is delivered. Killing tests: no-self page: a returned record that fails a filter refuses the page as contradicted; no-self continuation: every continuation page passes the record checks itself
  M("nsl-p2-unjudgeable-delivered", "packages/core/src/index.ts", "      if (outcome.status === 'uncheckable') throw new GatewayFault('UNVERIFIED_QUERY', 'Source did not provide effective-query evidence.');", "      if (Boolean(0)) throw new GatewayFault('UNVERIFIED_QUERY', 'Source did not provide effective-query evidence.');"),
  // nsl-p2-foreign-checked: another patient's records are checked too, so a refusal depends on their data. Killing test: no-self page: twin refusals and acceptances are identical whatever another patient's data is
  M("nsl-p2-foreign-checked", "packages/core/src/index.ts", "checkReturnedRecords([...checkedPredicates.values()], checked, this.transport.base)", "checkReturnedRecords([...checkedPredicates.values()], (Array.isArray(bundle.entry) ? bundle.entry : []).map((entry: { resource?: FhirResource }) => entry.resource).filter((resource: FhirResource | undefined): resource is FhirResource => resource?.resourceType === type), this.transport.base)"),
  // nsl-p2-empty-unlabelled: an empty page without a self link carries no unverified label. Killing test: no-self page: an empty page is labelled unverified, never NO_MATCHES or complete
  M("nsl-p2-empty-unlabelled", "packages/core/src/index.ts", "      if (selfAbsent && !checked.length) for (const pair of material) unverifiedFilters.add(pair.name);\n", ""),
  // nsl-p2-total-published: a page without a self link publishes a total. Killing tests: no-self page: accepted when every filter is gateway-checked, labelled gateway_checked_records; no-self page: a single page without a self link never publishes a total
  M("nsl-p2-total-published", "packages/core/src/index.ts", "const publishTotal = verifySelf && !selfAbsent && ", "const publishTotal = verifySelf && "),
  // nsl-p2-chain-pages-unchecked: a later page of a record-checked chain reached by an ordinary echoed link skips the record checks yet keeps the gateway_checked label. Killing test: no-self continuation: every page of a record-checked chain is checked, whatever link reached it
  M("nsl-p2-chain-pages-unchecked", "packages/core/src/index.ts", " || previous!.queryEvidence?.evidenceKind === RECORD_CHECKED_EVIDENCE_KIND));", "));"),
  // nsl-p2-profile-claimed: a proving profile claims execution on a page without a self link. Killing test: no-self page: a proving profile claims neither execution nor order without a self link
  M("nsl-p2-profile-claimed", "packages/core/src/index.ts", "sortVerified: !selfAbsent, selfPairs: reported, profile: selfAbsent ? undefined : profile,", "sortVerified: true, selfPairs: reported, profile,"),
  // nsl-p2-label-dropped: the page is labelled by the generic rule, as declared evidence. Killing test: no-self page: accepted when every filter is gateway-checked, labelled gateway_checked_records
  M("nsl-p2-label-dropped", "packages/core/src/index.ts", ", evidenceKind: RECORD_CHECKED_EVIDENCE_KIND } : {}),", " } : {}),"),
  // nsl-p2-current-label-dropped: an unverified record-checked page is relabelled declared. Killing test: no-self page: an empty page is labelled unverified, never NO_MATCHES or complete
  M("nsl-p2-current-label-dropped", "packages/core/src/index.ts", "if (!evidence.materialFilterProved && evidence.evidenceKind !== RECORD_CHECKED_EVIDENCE_KIND) evidence.evidenceKind = 'declared_and_self_link_only';", "if (!evidence.materialFilterProved) evidence.evidenceKind = 'declared_and_self_link_only';"),
  // nsl-p2-label-not-sticky: a downgrade relabels record-checked evidence. Killing test: no-self evidence: labels, downgrades and coverage never claim completeness or NO_MATCHES
  M("nsl-p2-label-not-sticky", "packages/core/src/query.ts", "  if (basis === 'gateway_checked_records') return 'gateway_checked_records';\n", ""),
  // nsl-p2-complete-claimed: record-checked evidence reports complete_for_query. Killing test: no-self evidence: labels, downgrades and coverage never claim completeness or NO_MATCHES
  M("nsl-p2-complete-claimed", "packages/core/src/query.ts", "const reportedState: CoverageV2['state'] = state === 'complete_for_query' && evidence.evidenceKind === 'gateway_checked_records' ? 'unknown' : state;", "const reportedState: CoverageV2['state'] = state;"),
  // nsl-p2-no-matches-claimed: an empty record-checked page is eligible for NO_MATCHES. Killing tests: no-self evidence: labels, downgrades and coverage never claim completeness or NO_MATCHES; no-self page: an empty page is labelled unverified, never NO_MATCHES or complete
  M("nsl-p2-no-matches-claimed", "packages/core/src/contracts.ts", "    && coverage.query_evidence !== 'gateway_checked_records'\n", ""),
  // nsl-gate-checked-any-label: the strict gate lets gateway_checked travel under any label. Killing test: no-self evidence: the strict gate binds gateway_checked to its label and refuses profile claims under it
  M("nsl-gate-checked-any-label", "packages/core/src/contracts.ts", "    if (c.constraints?.some(p => p.execution === 'gateway_checked') && !['gateway_checked_records', 'unverified_continuation', 'retained_snapshot'].includes(c.query_evidence)) return fail();\n", ""),
  // nsl-gate-tested-under-checked: the strict gate lets a profile claim ride on record-checked evidence. Killing test: no-self evidence: the strict gate binds gateway_checked to its label and refuses profile claims under it
  M("nsl-gate-tested-under-checked", "packages/core/src/contracts.ts", "    if (c.query_evidence === 'gateway_checked_records' && c.constraints?.some(p => p.execution === 'tested_adapter')) return fail();\n", ""),
  // Part 3: one mutant per continuation-token condition (packages/core/src/query.ts, index.ts, record-predicates.ts).
  // nsl-p3-unvalidated: a link carrying the token is accepted without the token rule. Killing test: no-self continuation: an omitted, changed or added constraint, a second or case-variant token, a root path or a bad token is non-continuable
  M("nsl-p3-unvalidated", "packages/core/src/index.ts", "{ validateTokenContinuation({ url, resourcePath, tokenName: tokenName!, query }); return url; }", "{ return url; }"),
  // nsl-p3-root-path: a token link may target the server root or another path. Killing tests: no-self continuation: an omitted, changed or added constraint, a second or case-variant token, a root path or a bad token is non-continuable; no-self continuation: validator rules in isolation
  M("nsl-p3-root-path", "packages/core/src/query.ts", "if (url.pathname !== input.resourcePath) throw new GatewayFault('UNSAFE_URL',", "if (Boolean(0)) throw new GatewayFault('UNSAFE_URL',"),
  // nsl-p3-second-token: more than one token is accepted. Killing tests: no-self continuation: an omitted, changed or added constraint, a second or case-variant token, a root path or a bad token is non-continuable; no-self continuation: validator rules in isolation
  M("nsl-p3-second-token", "packages/core/src/query.ts", "if (tokens.length !== 1 || reported.some(", "if (tokens.length < 1 || reported.some("),
  // nsl-p3-token-shape-unchecked: an empty, over-long or non-URL-safe token is accepted. Killing tests: no-self continuation: an omitted, changed or added constraint, a second or case-variant token, a root path or a bad token is non-continuable; no-self continuation: validator rules in isolation
  M("nsl-p3-token-shape-unchecked", "packages/core/src/query.ts", "if (!CONTINUATION_TOKEN_SHAPE.test(tokens[0]!.value)) refuse(", "if (Boolean(0)) refuse("),
  // nsl-p3-token-length: tokens up to 4,096 characters are accepted. Killing tests: no-self continuation: an omitted, changed or added constraint, a second or case-variant token, a root path or a bad token is non-continuable; no-self continuation: validator rules in isolation; no-self continuation: a token may end in one or two `=` of base64 padding, and `=` is refused anywhere else
  M("nsl-p3-token-length", "packages/core/src/query.ts", "export const CONTINUATION_TOKEN_SHAPE = /^(?=.{1,2048}$)[A-Za-z0-9._~-]+={0,2}$/;", "export const CONTINUATION_TOKEN_SHAPE = /^(?=.{1,4096}$)[A-Za-z0-9._~-]+={0,2}$/;"),
  // nsl-p3-token-charset: any non-space character is accepted in a token. Killing tests: no-self continuation: an omitted, changed or added constraint, a second or case-variant token, a root path or a bad token is non-continuable; no-self continuation: validator rules in isolation; no-self continuation: a token may end in one or two `=` of base64 padding, and `=` is refused anywhere else
  M("nsl-p3-token-charset", "packages/core/src/query.ts", "export const CONTINUATION_TOKEN_SHAPE = /^(?=.{1,2048}$)[A-Za-z0-9._~-]+={0,2}$/;", "export const CONTINUATION_TOKEN_SHAPE = /^\\S{1,2048}$/;"),
  // nsl-p3-token-padding-unbounded: any number of trailing `=` is accepted. Killing tests: no-self continuation: an omitted, changed or added constraint, a second or case-variant token, a root path or a bad token is non-continuable; no-self continuation: a token may end in one or two `=` of base64 padding, and `=` is refused anywhere else
  M("nsl-p3-token-padding-unbounded", "packages/core/src/query.ts", "[A-Za-z0-9._~-]+={0,2}$/;", "[A-Za-z0-9._~-]+=*$/;"),
  // nsl-p3-token-padding-anywhere: up to two `=` are accepted anywhere in a token, leading or inside, not only at its end. Killing tests: no-self continuation: an omitted, changed or added constraint, a second or case-variant token, a root path or a bad token is non-continuable; no-self continuation: a token may end in one or two `=` of base64 padding, and `=` is refused anywhere else
  M("nsl-p3-token-padding-anywhere", "packages/core/src/query.ts", "[A-Za-z0-9._~-]+={0,2}$/;", "[A-Za-z0-9._~-]*={0,2}[A-Za-z0-9._~-]*$/;"),
  // nsl-p3-token-no-padding: the rule reverts to unreserved characters only, so base64 padding is refused again. Killing tests: no-self continuation: a token may end in one or two `=` of base64 padding, and `=` is refused anywhere else; no-self continuation: tokens with base64 padding continue end to end, raw or percent-encoded
  M("nsl-p3-token-no-padding", "packages/core/src/query.ts", "export const CONTINUATION_TOKEN_SHAPE = /^(?=.{1,2048}$)[A-Za-z0-9._~-]+={0,2}$/;", "export const CONTINUATION_TOKEN_SHAPE = /^[A-Za-z0-9._~-]{1,2048}$/;"),
  // nsl-p3-extra-parameter: an added constraint or paging mechanic is accepted. Killing tests: no-self continuation: an omitted, changed or added constraint, a second or case-variant token, a root path or a bad token is non-continuable; no-self continuation: validator rules in isolation
  M("nsl-p3-extra-parameter", "packages/core/src/query.ts", "if (reported.some(pair => !allowed.has(pair.name))) refuse(", "if (Boolean(0)) refuse("),
  // nsl-p3-count-changed: a changed or dropped `_count` is accepted. Killing tests: no-self continuation: an omitted, changed or added constraint, a second or case-variant token, a root path or a bad token is non-continuable; no-self continuation: validator rules in isolation
  M("nsl-p3-count-changed", "packages/core/src/query.ts", "if (!sameValues(sortedValues(reported, '_count'), sortedValues(query, '_count'))) refuse(", "if (Boolean(0)) refuse("),
  // nsl-p3-sort-changed: a changed or added `_sort` is accepted. Killing tests: no-self continuation: an omitted, changed or added constraint, a second or case-variant token, a root path or a bad token is non-continuable; no-self continuation: accepted boundaries and the sort echo
  M("nsl-p3-sort-changed", "packages/core/src/query.ts", "if (sorts.length && !sameValues(sorts, sortedValues(query, '_sort'))) refuse(", "if (Boolean(0)) refuse("),
  // nsl-p3-material-unchecked: an omitted or changed constraint is accepted. Killing tests: no-self continuation: an omitted, changed or added constraint, a second or case-variant token, a root path or a bad token is non-continuable; no-self continuation: validator rules in isolation
  M("nsl-p3-material-unchecked", "packages/core/src/query.ts", "    if (!sameValues(sortedValues(reported, name), sortedValues(material, name))) refuse(", "    if (Boolean(0)) refuse("),
  // nsl-p3-multiplicity-ignored: a repeated echo of the same constraint is accepted. Killing tests: no-self continuation: an omitted, changed or added constraint, a second or case-variant token, a root path or a bad token is non-continuable; no-self continuation: validator rules in isolation
  M("nsl-p3-multiplicity-ignored", "packages/core/src/query.ts", "    if (!sameValues(sortedValues(reported, name), sortedValues(material, name))) refuse(", "    if (!sameValues([...new Set(sortedValues(reported, name))], [...new Set(sortedValues(material, name))])) refuse("),
  // nsl-p3-respelling-accepted: echoed values are compared by count only, so a re-spelled value passes. Killing tests: no-self continuation: an omitted, changed or added constraint, a second or case-variant token, a root path or a bad token is non-continuable; no-self continuation: validator rules in isolation
  M("nsl-p3-respelling-accepted", "packages/core/src/query.ts", "left.length === right.length && left.every((value, index) => value === right[index])", "left.length === right.length"),
  // nsl-p3-pages-unchecked: a token continuation page skips the record checks. Killing test: no-self continuation: every continuation page passes the record checks itself
  M("nsl-p3-pages-unchecked", "packages/core/src/index.ts", "(carriesContinuationToken(url, this.config.source.continuationTokenParameter) || previous!.queryEvidence", "(Boolean(0) || previous!.queryEvidence"),
  // nsl-p3-known-name-configurable: a known search parameter name may be configured as the token. Killing test: no-self continuation: a configured token name that is a known search or result parameter is refused
  M("nsl-p3-known-name-configurable", "packages/core/src/index.ts", "if (cfg.source.continuationTokenParameter && isKnownParameterName(cfg.source.continuationTokenParameter)) ctx.addIssue(", "if (Boolean(0)) ctx.addIssue("),
  // nsl-p3-known-name-case: a case variant of a known name (`Code`) may be configured. Killing test: no-self continuation: a configured token name that is a known search or result parameter is refused
  M("nsl-p3-known-name-case", "packages/core/src/record-predicates.ts", "return name.startsWith('_') || KNOWN_PARAMETER_NAMES.has(name.toLowerCase());", "return name.startsWith('_') || KNOWN_PARAMETER_NAMES.has(name);"),
  // nsl-p3-result-names-unknown: underscore result and control names are not known names. Killing test: no-self continuation: a configured token name that is a known search or result parameter is refused
  M("nsl-p3-result-names-unknown", "packages/core/src/record-predicates.ts", "return name.startsWith('_') || KNOWN_PARAMETER_NAMES.has(name.toLowerCase());", "return KNOWN_PARAMETER_NAMES.has(name.toLowerCase());"),
  // Targeted first pass: it may only kill, only on a reproduced named failure.
  // Credit the first targeted failure without its second judgement. Killing test: targeted pass: never yields KILLED without a reproduced failure
  M("targeted-kill-unreproduced", "scripts/mutation-guards.mjs", "      const decision = reproducedKill({ outcome: 'failed', signature, timedOut: false, suite }, second);\n", "      const decision = reproducedKill({ outcome: 'failed', signature, timedOut: false, suite }, { ...second, outcome: 'failed', signature });\n", { suites: ['unit'] }),
  // Rerun and credit names from a timed-out targeted run. Killing test: targeted pass: timeouts, file-level, pin-only and unselected reruns are never credited
  M("targeted-timeout-rerun", "scripts/mutation-guards.mjs", "      if (first.ok || first.timedOut) continue;\n", "      if (first.ok) continue;\n", { suites: ['unit'] }),
  // Let pin-only and file-level failures start a targeted reproduction. Killing test: targeted pass: timeouts, file-level, pin-only and unselected reruns are never credited
  M("targeted-pin-credit", "scripts/mutation-guards.mjs", "      const signature = behaviouralFailures(first.failed).filter(name => !(first.pinFailures ?? []).includes(name) && !name.endsWith('.test.ts'));\n", "      const signature = first.failed;\n", { suites: ['unit'] }),
  // Decide a survivor when the candidates pass. Killing tests: targeted judge: falls through to the full path when the candidates pass; targeted judge: never yields SURVIVED or a pass by itself; a flaky candidate falls through
  M("targeted-survivor-decided", "scripts/mutation-guards.mjs", "    // The full path: every mutant the targeted pass did not kill is judged exactly as without it.\n", "    if (plan?.tiers.length) return verdict({ status: 'survived', decidedBy: 'targeted', failingTests: [], detail: 'targeted candidates passed' });\n", { suites: ['unit'] }),
  // Accept any verdict the shard reports attribute to the targeted pass. Killing test: aggregate: the targeted pass can only decide reproduced named kills, and decisions are counted
  M("targeted-aggregate-any-verdict", "scripts/mutation-guards.mjs", "      else if (result.decided_by === 'targeted' && !(verdict === 'killed' && result.kill_kind === 'named' && result.failingTests?.length && result.reproducedTimeout === false)) {\n", "      else if (false) {\n", { suites: ['unit'] }),
  // Offer isolation candidates to mutants that do not declare the isolation suite. Killing test: candidate plan: comments, hints and kills annotations are strong; isolation only for declared mutants
  M("targeting-isolation-undeclared", "scripts/mutation-targeting.mjs", "(isolation && key.startsWith('isolation:'))", "key.startsWith('isolation:')", { suites: ['unit'] }),
  // Shared-directory reachability: one mutant per rule (packages/core/src/index.ts, privacy.ts,
  // search-parameters.ts, store.ts), each killed by the named test in tests/shared-reachability.test.ts.
  // reach-withheld-reference: reachability is read from the record before delivery selection, so a reference that was not delivered grants. Killing test: reachability gateway: not gained from a withheld, display-only or identifier-only reference, or from a fields-excluded one
  M("reach-withheld-reference", "packages/core/src/index.ts", "selected.flatMap(item => deliveredDirectoryReferences(item.view.resource, this.transport.base))", "selected.flatMap(item => deliveredDirectoryReferences(item.record.resource, this.transport.base))", { suites: ['unit'] }),
  // reach-read-sent-upstream: an unreachable directory read is sent to the source. Killing test: reachability gateway: unreachable reads are byte-identical whether the record exists or not, with zero upstream requests
  M("reach-read-sent-upstream", "packages/core/src/index.ts", "    if (isDirectoryType(type) && !this.verifiedTargets.reachable(type, id)) throw new GatewayFault('NOT_FOUND', 'Requested resource is not available.');\n", "", { suites: ['unit'] }),
  // reach-non-id-search-admitted: a directory search without `_id` is admitted. Killing tests: directory admission: `_id` alone on reachable ids is admitted; everything else is one POLICY_DENIED; reachability gateway: a non-`_id` directory search, or one with an unreachable id, is refused uniformly with zero requests
  M("reach-non-id-search-admitted", "packages/core/src/search-parameters.ts", "  if (idPairs.length === 0) deny();\n", "", { suites: ['unit'] }),
  // reach-extra-predicate-admitted: another predicate or a sort beside `_id` is admitted. Killing tests: directory admission: `_id` alone on reachable ids is admitted; everything else is one POLICY_DENIED; reachability gateway: a non-`_id` directory search, or one with an unreachable id, is refused uniformly with zero requests
  M("reach-extra-predicate-admitted", "packages/core/src/search-parameters.ts", "  if (input.pairs.length !== 1 || (input.sort?.length ?? 0) > 0) deny();\n", "", { suites: ['unit'] }),
  // reach-reset-skipped: the shared reset clears own-record keys but keeps reachable directory keys. Killing tests: reachability gateway: reset on a state boundary and per context; reachability ledger: one structure with own-record keys; separate kinds, one bound, one reset
  M("reach-reset-skipped", "packages/core/src/store.ts", "  clear(): void { this.keys.clear(); }\n", "  clear(): void { for (const key of [...this.keys]) if (!key.startsWith(REACHABLE_PREFIX)) this.keys.delete(key); }\n", { suites: ['unit'] }),
  // reach-bound-removed: the ledger grows without bound. Killing test: reachability gateway: the bound fails closed (also B1 ledger: bounded, least recently used out, refreshed by a hit, cleared on demand)
  M("reach-bound-removed", "packages/core/src/store.ts", "    while (this.keys.size > this.capacity) this.keys.delete(this.keys.values().next().value!);\n", "", { suites: ['unit'] }),
  // reach-chain-from-directory-root: a delivered shared root (a Location, a Medication) grants its own references. Killing tests: reachability: no chains; a shared root or a contained directory record grants nothing; reachability gateway: no chains, from a delivered directory record or from a contained one
  M("reach-chain-from-directory-root", "packages/core/src/privacy.ts", "  if (typeof root !== 'string' || resourceClass(root) !== 'patient') return [];\n  const found = new Map<string, DirectoryKey>();", "  if (typeof root !== 'string') return [];\n  const found = new Map<string, DirectoryKey>();", { suites: ['unit'] }),
  // reach-chain-through-contained: a contained directory record's own references grant. Killing tests: reachability: no chains; a shared root or a contained directory record grants nothing; reachability gateway: no chains, from a delivered directory record or from a contained one
  M("reach-chain-through-contained", "packages/core/src/privacy.ts", "      if (depth > 0 && isDirectoryType(node.resourceType)) return;\n", "", { suites: ['unit'] }),
  // reach-grant-before-commit: reachability is granted before the audit, so an envelope that fails at its audit still grants. Killing test: reachability gateway: an envelope that fails at its audit, the last step before commit, grants nothing
  M("reach-grant-before-commit", "packages/core/src/index.ts", "          this.capturesV2.set(candidate, capture);\n", "          if (phase === 'success') this.noteReachable(env);\n          this.capturesV2.set(candidate, capture);\n", { suites: ['unit'] }),
  // reach-search-result-unchecked: a directory record the source returns for a reachable `_id` search is delivered even when unreachable. Killing test: reachability gateway: a source that ignores `_id` still delivers only reachable directory records, with no signal
  M("reach-search-result-unchecked", "packages/core/src/index.ts", "      if (isDirectoryType(type) && !(typeof entry.resource.id === 'string' && this.verifiedTargets.reachable(type, entry.resource.id))) { suppressed = true; continue; }\n", "", { suites: ['unit'] }),
  // smart-backend-patient-mismatch-accepted: a token response naming another patient is accepted. Killing test: SMART backend gateway: a token naming another patient is refused with POLICY_DENIED
  M("smart-backend-patient-mismatch-accepted", "packages/auth/src/smart-backend.ts", "if (fields.patient !== undefined && fields.patient !== this.patientId) throw", "if (false) throw", { suites: ['unit'] }),
  // smart-discovered-endpoint-shape-unchecked: a discovered endpoint is no longer held to the literal-loopback, no-credentials, no-query, no-fragment shape. Killing test: SMART discovery: a discovered endpoint off loopback, with credentials, a query or a fragment is refused before any token request
  M("smart-discovered-endpoint-shape-unchecked", "packages/auth/src/smart-discovery.ts", "  try { url = parseLoopbackUrl(value, `SMART discovery ${label}`); }", "  try { url = new URL(value); }", { suites: ['unit'] }),
  // smart-off-origin-endpoint-accepted: a discovered endpoint on another loopback origin is used without an operator pin. Killing test: SMART discovery: an off-origin endpoint needs a pin, and discovery must agree with the pin
  M("smart-off-origin-endpoint-accepted", "packages/auth/src/smart-discovery.ts", "  } else if (url.origin !== source.origin) {", "  } else if (false) {", { suites: ['unit'] }),
  // smart-pin-disagreement-ignored: discovery that disagrees with the pinned endpoint is used anyway. Killing test: SMART discovery: an off-origin endpoint needs a pin, and discovery must agree with the pin
  M("smart-pin-disagreement-ignored", "packages/auth/src/smart-discovery.ts", "    if (url.href !== pin.href) throw fault(", "    if (false) throw fault(", { suites: ['unit'] }),
  // smart-discovery-redirect-unrefused: a discovery redirect is no longer refused as a redirect. Killing test: SMART discovery: redirects, oversize documents, errors and malformed documents are refused
  M("smart-discovery-redirect-unrefused", "packages/auth/src/smart-discovery.ts", "    throw fault('UNSAFE_REDIRECT', 'SMART discovery redirects are disabled.');\n", "", { suites: ['unit'] }),
  // smart-token-redirect-unrefused: a token-endpoint redirect is no longer refused as a redirect. Killing test: SMART token endpoint redirects are refused
  M("smart-token-redirect-unrefused", "packages/auth/src/token-provider.ts", "      throw fault('UNSAFE_REDIRECT', 'Token endpoint redirects are disabled.');\n", "", { suites: ['unit'] }),
  // smart-assertion-jti-reused: the client assertion reuses one jti for every request. Killing tests: client assertion: header, claims and signature follow private_key_jwt for ES384 and RS384; SMART backend gateway: every token request carries a fresh assertion with a new jti, including after a 401
  M("smart-assertion-jti-reused", "packages/auth/src/client-assertion.ts", "jti: randomBytes(32).toString('base64url')", "jti: Buffer.from(clientId).toString('base64url')", { suites: ['unit'] }),
  // smart-assertion-aud-fhir-base: the assertion audience is the FHIR base instead of the token endpoint. Killing test: SMART backend: a stub-verified assertion obtains a bearer token through discovery on a long path-bearing base
  M("smart-assertion-aud-fhir-base", "packages/auth/src/smart-backend.ts", "signClientAssertion(key, this.clientId, tokenUrl.href, this.now())", "signClientAssertion(key, this.clientId, this.source.href, this.now())", { suites: ['unit'] }),
  // smart-assertion-exp-too-long: the assertion expires ten minutes after issue. Killing tests: client assertion: header, claims and signature follow private_key_jwt for ES384 and RS384; SMART backend: a stub-verified assertion obtains a bearer token through discovery on a long path-bearing base
  M("smart-assertion-exp-too-long", "packages/auth/src/client-assertion.ts", "exp: iat + ASSERTION_LIFETIME_S", "exp: iat + 600", { suites: ['unit'] }),
  // smart-assertion-iss-not-client: the assertion issuer is not the client id. Killing tests: client assertion: header, claims and signature follow private_key_jwt for ES384 and RS384; SMART backend: a stub-verified assertion obtains a bearer token through discovery on a long path-bearing base
  M("smart-assertion-iss-not-client", "packages/auth/src/client-assertion.ts", "iss: clientId, sub: clientId", "iss: 'fireboat', sub: clientId", { suites: ['unit'] }),
  // smart-weak-ec-key-accepted: any EC curve, P-256 included, signs assertions. Killing test: client assertion: weak or unsupported keys are refused (P-256, RSA under 2048, Ed25519, public keys)
  M("smart-weak-ec-key-accepted", "packages/auth/src/client-assertion.ts", "key.asymmetricKeyType === 'ec' && details.namedCurve === 'secp384r1'", "key.asymmetricKeyType === 'ec'", { suites: ['unit'] }),
  // smart-short-rsa-key-accepted: RSA keys shorter than 2048 bits sign assertions. Killing test: client assertion: weak or unsupported keys are refused (P-256, RSA under 2048, Ed25519, public keys)
  M("smart-short-rsa-key-accepted", "packages/auth/src/client-assertion.ts", "bits >= 2048 && bits <= 8192", "bits >= 512 && bits <= 8192", { suites: ['unit'] }),
  // smart-write-grant-accepted: a grant with write permission is accepted. Killing test: SMART backend gateway: a write-capable grant is refused and nothing is sent to FHIR
  M("smart-write-grant-accepted", "packages/auth/src/smart-scopes.ts", "    if (write) throw fault('POLICY_DENIED', 'Token grant includes write permission.');\n", "", { suites: ['unit'] }),
  // smart-ungranted-type-sent: a resource type outside the grant is sent upstream. Killing test: SMART backend gateway: a type outside the grant is refused with POLICY_DENIED before any FHIR request
  M("smart-ungranted-type-sent", "packages/core/src/index.ts", "        if ((tool === 'fhir_read' || tool === 'fhir_search') && this.credentials && !this.credentials.allows(input.resource_type!, tool === 'fhir_read' ? 'read' : 'search')) throw new GatewayFault('POLICY_DENIED', 'The granted scope does not permit this resource type.', false, undefined, 'SCOPE_NOT_GRANTED');\n", "", { suites: ['unit'] }),
  // smart-token-logged-on-refusal: the access token is written to stderr when its grant is refused. Killing test: SMART canary over stdio: no access token, assertion or key material reaches stderr or tool output, on success or refusal
  M("smart-token-logged-on-refusal", "packages/auth/src/smart-backend.ts", "    const grant = assessGrant(fields.scope, this.requested, 'system', this.servedTypes);\n", "    let grant: ReturnType<typeof assessGrant>;\n    try { grant = assessGrant(fields.scope, this.requested, 'system', this.servedTypes); }\n    catch (error) { process.stderr.write(`fireboat: grant refused for ${accessToken}\\n`); throw error; }\n", { suites: ['unit'] }),
  // smart-grant-change-keeps-state: a changed grant keeps the authorization epoch and retained state. Killing test: SMART backend gateway: a changed grant at renewal expires handles retained under the old grant
  M("smart-grant-change-keeps-state", "packages/core/src/index.ts", "      onGrantChanged: () => { this.authEpoch++; this.invalidateState(); } });", "      onGrantChanged: () => {} });", { suites: ['unit'] }),
  // smart-missing-scope-accepted: a token response without scope is treated as granting the request. Killing test: SMART backend gateway: a token response without scope is INVALID_TOKEN_RESPONSE and nothing is sent to FHIR
  M("smart-missing-scope-accepted", "packages/auth/src/smart-scopes.ts", "  if (text === undefined) throw fault('INVALID_TOKEN_RESPONSE', 'Token response does not state the granted scope.');", "  if (text === undefined) return assessGrant(requested.join(' '), requested, context, servedTypes);", { suites: ['unit'] }),
  // smart-launch-patient-mismatch-accepted: a code exchange naming another patient is stored. Killing test: SMART login: a code exchange naming another patient, or none, stores nothing and sends no FHIR request
  M("smart-launch-patient-mismatch-accepted", "packages/auth/src/smart-standalone.ts", "      if (fields.patient !== this.patientId) throw new LoginFault('PATIENT_MISMATCH');\n", "", { suites: ['unit'] }),
  // smart-launch-patient-missing-accepted: a code exchange without patient context is stored. Killing test: SMART login: a code exchange naming another patient, or none, stores nothing and sends no FHIR request
  M("smart-launch-patient-missing-accepted", "packages/auth/src/smart-standalone.ts", "      if (fields.patient === undefined) throw new LoginFault('PATIENT_CONTEXT_MISSING');\n      if (fields.patient !== this.patientId) throw new LoginFault('PATIENT_MISMATCH');\n", "      if (fields.patient !== undefined && fields.patient !== this.patientId) throw new LoginFault('PATIENT_MISMATCH');\n", { suites: ['unit'] }),
  // smart-refresh-patient-mismatch-accepted: a refresh naming another patient is accepted. Killing test: SMART standalone serving: a refresh naming another patient is refused; one omitting the patient keeps the binding
  M("smart-refresh-patient-mismatch-accepted", "packages/auth/src/smart-standalone.ts", "    if (fields.patient !== undefined && fields.patient !== stored.binding.patientId) throw fault('POLICY_DENIED'", "    if (false) throw fault('POLICY_DENIED'", { suites: ['unit'] }),
  // smart-pkce-challenge-dropped: the authorization request carries no code_challenge. Killing test: SMART login: discovery, PKCE S256 and state reach the authorization server, and the grant is stored 0600 in a 0700 directory
  M("smart-pkce-challenge-dropped", "packages/auth/src/smart-standalone.ts", "      authorize.searchParams.set('code_challenge', pkce.challenge);\n", "", { suites: ['unit'] }),
  // smart-pkce-method-plain: the authorization request asks for the plain PKCE method. Killing test: SMART login: discovery, PKCE S256 and state reach the authorization server, and the grant is stored 0600 in a 0700 directory
  M("smart-pkce-method-plain", "packages/auth/src/smart-standalone.ts", "authorize.searchParams.set('code_challenge_method', 'S256');", "authorize.searchParams.set('code_challenge_method', 'plain');", { suites: ['unit'] }),
  // smart-pkce-support-unchecked: sign-in proceeds when discovery does not advertise S256. Killing test: SMART login: authorization errors, missing PKCE support and write-capable grants store nothing
  M("smart-pkce-support-unchecked", "packages/auth/src/smart-standalone.ts", "    if (!discovered.codeChallengeMethods.includes('S256')) throw new LoginFault('PKCE_UNSUPPORTED');\n", "", { suites: ['unit'] }),
  // smart-state-unchecked: the callback state is not compared with the state sent. Killing test: SMART login: a callback with the wrong state is refused before any code exchange and stores nothing
  M("smart-state-unchecked", "packages/auth/src/smart-standalone.ts", "params => stateMatches(state, params.get('state'))", "() => true", { suites: ['unit'] }),
  // smart-listener-host-unchecked: the redirect listener accepts any Host header. Killing test: SMART login listener: binds 127.0.0.1 only and refuses a wrong Host, a wrong path or method, and a second callback
  M("smart-listener-host-unchecked", "packages/server/src/login.ts", "      if (req.headers.host !== expectedHost) { res.statusCode = 400; res.end(); return; }\n", "", { suites: ['unit'] }),
  // smart-listener-any-interface: the redirect listener binds every interface. Killing test: SMART login listener: binds 127.0.0.1 only and refuses a wrong Host, a wrong path or method, and a second callback
  M("smart-listener-any-interface", "packages/server/src/login.ts", "server.listen({ port, host: '127.0.0.1', exclusive: true }", "server.listen({ port, host: '0.0.0.0', exclusive: true }", { suites: ['unit'] }),
  // smart-token-file-mode-unchecked: the token file owner and mode are not checked. Killing test: SMART standalone serving: a token file with group or other access, or a symlink, is CREDENTIAL_UNAVAILABLE with no request
  M("smart-token-file-mode-unchecked", "packages/auth/src/token-store.ts", "    if (!info.isFile() || uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0) unusable();", "    if (!info.isFile()) unusable();", { suites: ['unit'] }),
  // smart-token-file-binding-unchecked: a token file bound to another source, client or patient is used. Killing test: SMART standalone serving: a token file bound to another source, client, patient or token endpoint is CONNECTION_REQUIRED with no request
  M("smart-token-file-binding-unchecked", "packages/auth/src/smart-standalone.ts", "    if (!bindingMatches(grant.binding, this.expectedBinding(endpoint.href))) throw", "    if (false) throw", { suites: ['unit'] }),
  // smart-token-file-wider-mode: the token file is written readable by group and others. Killing test: SMART login: discovery, PKCE S256 and state reach the authorization server, and the grant is stored 0600 in a 0700 directory
  M("smart-token-file-wider-mode", "packages/auth/src/token-store.ts", "const FILE_MODE = 0o600;", "const FILE_MODE = 0o644;", { suites: ['unit'] }),
  // smart-launch-token-logged-on-refusal: the access token is written to stderr when a code exchange is refused. Killing test: SMART login over the CLI: a refused code exchange stores nothing and prints one code line without the token
  M("smart-launch-token-logged-on-refusal", "packages/auth/src/smart-standalone.ts", "      if (fields.patient === undefined) throw new LoginFault('PATIENT_CONTEXT_MISSING');\n", "      if (fields.patient === undefined) { process.stderr.write(`fireboat: refused ${accessToken}\\n`); throw new LoginFault('PATIENT_CONTEXT_MISSING'); }\n", { suites: ['unit'] }),
  // smart-rejected-token-served-again: a stored access token the source rejected is served again from the file. Killing test: SMART standalone serving: after a 401 the token file is re-read, so a fresh login is picked up without a restart
  M("smart-rejected-token-served-again", "packages/auth/src/smart-standalone.ts", "    if (invalidated && served !== undefined) this.distrusted = served;\n", "", { suites: ['unit'] }),
  // smart-refresh-reread-skipped: a rejected refresh does not re-read the token file for a fresh grant. Killing test: SMART standalone serving: a rejected refresh re-reads the token file once and picks up a fresh login
  M("smart-refresh-reread-skipped", "packages/auth/src/smart-standalone.ts", "      if (current.refreshToken !== stored.refreshToken || current.accessToken !== stored.accessToken) return this.fromStored(generation, signal, current, rereads - 1);\n", "", { suites: ['unit'] }),
  // smart-search-grant-unchecked: a search on a type outside the SMART grant (such as a reference-target confirmation) is not refused before its token is renewed. Killing test: SMART backend gateway: a reference target outside the grant is refused before an expired token is renewed for its confirmation search
  M("smart-search-grant-unchecked", "packages/core/src/index.ts", "    if (this.credentials && !this.credentials.allows(type, 'search')) throw new GatewayFault('POLICY_DENIED', 'The granted scope does not permit this resource type.', false, undefined, 'SCOPE_NOT_GRANTED');\n", "", { suites: ['unit'] }),
  // smart-confirmation-scope-cause-lost: an ungranted reference-target type loses its SCOPE_NOT_GRANTED cause. Killing test: SMART backend gateway: a reference target outside the grant is refused before its confirmation search is sent
  M("smart-confirmation-scope-cause-lost", "packages/core/src/index.ts", "        if (error instanceof GatewayFault && error.cause === 'SCOPE_NOT_GRANTED') throw error;\n", "", { suites: ['unit'] }),
  // stage-serving-child-process-allowed: a serving module may import node:child_process. Killing test: package stage: login.js is a separate root; the serving graph never reaches a listener or a child process
  M("stage-serving-child-process-allowed", "scripts/stage-package.ts", "          if (specifier === 'node:child_process' && !own) throw fault('SERVING_BOUNDARY');\n", "", { suites: ['unit'] }),
  // stage-bootstrap-any-lazy-import: the bootstrap may lazily import any module. Killing test: package stage: login.js is a separate root; the serving graph never reaches a listener or a child process
  M("stage-bootstrap-any-lazy-import", "scripts/stage-package.ts", "(!bootstrap || !BOOTSTRAP_LAZY_IMPORTS.includes(textOf(n)))", "(!bootstrap)", { suites: ['unit'] }),
  // stage-account-network-widened: the account module may import any network module. Killing test: package stage: login.js is a separate root; the serving graph never reaches a listener or a child process
  M("stage-account-network-widened", "scripts/stage-package.ts", "!(own && specifier === 'node:http')", "!own", { suites: ['unit'] }),
  // stage-cli-static-login-allowed: cli.js may import login.js statically. Killing test: package stage: login.js is a separate root; the serving graph never reaches a listener or a child process
  M("stage-cli-static-login-allowed", "scripts/stage-package.ts", "              if (statics.includes(specifier)) throw fault('SERVING_BOUNDARY');\n", "", { suites: ['unit'] }),
  // smart-refresh-lock-reread-skipped: a refresh under the lock ignores a grant another process stored meanwhile. Killing test: SMART standalone serving: a refresh waits for the grant lock and adopts a grant another process stored meanwhile instead of overwriting it
  M("smart-refresh-lock-reread-skipped", "packages/auth/src/smart-standalone.ts", "      if (current.accessToken !== stored.accessToken || current.refreshToken !== stored.refreshToken) return { changed: current };\n", "", { suites: ['unit'] }),
  // smart-grant-lock-not-exclusive: the grant lock is not exclusive. Killing tests: SMART standalone serving: two servers refreshing at once send one refresh request; SMART standalone serving: a refresh waits for the grant lock and adopts a grant another process stored meanwhile instead of overwriting it
  M("smart-grant-lock-not-exclusive", "packages/auth/src/token-store.ts", "    await link(temporary, lock);", "    await rename(temporary, lock);", { suites: ['unit'] }),
  // smart-grant-lock-owner-unchecked: a holder removes the lock even after another process took it over. Killing test: SMART grant lock: a stale lock is taken over, a held lock times out, a linked lock is refused, and only the holder removes it
  M("smart-grant-lock-owner-unchecked", "packages/auth/src/token-store.ts", "    if (mine) await unlink(lock).catch(() => undefined);", "    await unlink(lock).catch(() => undefined);", { suites: ['unit'] }),
  // smart-login-write-unlocked: a login writes its grant without the grant lock. Killing test: SMART standalone: a login stores its grant only after the grant lock is free
  M("smart-login-write-unlocked", "packages/auth/src/smart-standalone.ts", "try { await withGrantLock(this.tokenFile, held => this.storeLogin(stored, usableUntil, held), { signal: controller.signal }); }", "try { await this.storeLogin(stored, usableUntil, async () => undefined); }", { suites: ['unit'] }),
  // smart-unrequested-refresh-token-stored: a refresh token is stored without offlineAccess. Killing test: SMART standalone: a refresh token is neither stored nor used without offlineAccess
  M("smart-unrequested-refresh-token-stored", "packages/auth/src/smart-standalone.ts", "const refreshToken = this.offlineAccess ? fields.refresh_token : undefined;", "const refreshToken = fields.refresh_token;", { suites: ['unit'] }),
  // smart-refresh-without-offline-access: a stored refresh token is used without offlineAccess. Killing test: SMART standalone: a refresh token is neither stored nor used without offlineAccess
  M("smart-refresh-without-offline-access", "packages/auth/src/smart-standalone.ts", "if (stored.refreshToken === undefined || !this.offlineAccess) throw", "if (stored.refreshToken === undefined) throw", { suites: ['unit'] }),
  // smart-parameterised-scope-granted: a scope with parameters grants permissions. Killing test: SMART scopes: grants parse broader, narrower, write and parameterised scopes
  M("smart-parameterised-scope-granted", "packages/auth/src/smart-scopes.ts", "    if (match[4] !== undefined) continue;\n", "", { suites: ['unit'] }),
  // smart-scope-context-ignored: a scope from another context (user/, system/ in a launch) grants permissions. Killing test: SMART scopes: grants parse broader, narrower, write and parameterised scopes
  M("smart-scope-context-ignored", "packages/auth/src/smart-scopes.ts", "    if (match[1] !== context) { broader = true; continue; }\n", "", { suites: ['unit'] }),
  // smart-uninterpretable-scope-accepted: a resource scope with an unknown type or permission is accepted. Killing test: SMART scopes: grants parse broader, narrower, write and parameterised scopes
  M("smart-uninterpretable-scope-accepted", "packages/auth/src/smart-scopes.ts", "    if (!match || (type !== '*' && !RESOURCE_TYPE.test(type!)) || (!v1 && !/^c?r?u?d?s?$/.test(permission)) || permission === '') {", "    if (!match) {", { suites: ['unit'] }),
  // smart-override-grammar-unchecked: operator scope overrides skip the read-only grammar. Killing test: SMART scopes: requests derive from served types; overrides follow a read-only grammar
  M("smart-override-grammar-unchecked", "packages/auth/src/smart-scopes.ts", "    if (!match || match[1] !== context || !served.has(match[2]!)) {", "    if (false) {", { suites: ['unit'] }),
  // smart-token-file-follows-links: the token file is opened through a symbolic link. Killing test: SMART standalone serving: a token file with group or other access, or a symlink, is CREDENTIAL_UNAVAILABLE with no request
  M("smart-token-file-follows-links", "packages/auth/src/token-store.ts", "open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)", "open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)", { suites: ['unit'] }),
  // smart-key-file-follows-links: the private key file is opened through a symbolic link. Killing test: client assertion: the key comes from exactly one source; a key file must be private, regular and not a link
  M("smart-key-file-follows-links", "packages/auth/src/client-assertion.ts", "open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)", "open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)", { suites: ['unit'] }),
  // smart-key-file-mode-unchecked: the private key file owner and mode are not checked. Killing test: client assertion: the key comes from exactly one source; a key file must be private, regular and not a link
  M("smart-key-file-mode-unchecked", "packages/auth/src/client-assertion.ts", "    if (!info.isFile() || uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0) {", "    if (!info.isFile()) {", { suites: ['unit'] }),
  // smart-grant-directory-mode-unchecked: a grant directory with group or other access is used. Killing test: SMART standalone: a grant directory with group or other access is refused and nothing is written
  M("smart-grant-directory-mode-unchecked", "packages/auth/src/token-store.ts", "  if (!info || !info.isDirectory() || uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0) {", "  if (!info || !info.isDirectory()) {", { suites: ['unit'] }),
  // smart-refresh-endpoint-unchecked: a refresh posts to a discovered token endpoint the stored grant is not bound to. Killing test: SMART standalone serving: a token file bound to another source, client, patient or token endpoint is CONNECTION_REQUIRED with no request
  M("smart-refresh-endpoint-unchecked", "packages/auth/src/smart-standalone.ts", "    if (discovered.tokenEndpoint.href !== stored.binding.tokenEndpoint) throw", "    if (false) throw", { suites: ['unit'] }),
  // smart-listener-repeat-accepted: the listener accepts a second callback. Killing test: SMART login listener: binds 127.0.0.1 only and refuses a wrong Host, a wrong path or method, and a second callback
  M("smart-listener-repeat-accepted", "packages/server/src/login.ts", "      if (accepted) { res.statusCode = 410; res.end(); return; }\n", "", { suites: ['unit'] }),
  // smart-listener-method-unchecked: the listener accepts any method. Killing test: SMART login listener: binds 127.0.0.1 only and refuses a wrong Host, a wrong path or method, and a second callback
  M("smart-listener-method-unchecked", "packages/server/src/login.ts", "      if (req.method !== 'GET') { res.statusCode = 404; res.end(); return; }\n", "", { suites: ['unit'] }),
  // smart-listener-path-unchecked: the listener accepts any path. Killing test: SMART login listener: binds 127.0.0.1 only and refuses a wrong Host, a wrong path or method, and a second callback
  M("smart-listener-path-unchecked", "packages/server/src/login.ts", "      if (url.pathname !== '/callback') { res.statusCode = 404; res.end(); return; }\n", "", { suites: ['unit'] }),
  // smart-listener-predicate-ignored: the listener accepts a callback its predicate refused. Killing test: SMART login listener: a callback with another state is refused and does not consume the listener
  M("smart-listener-predicate-ignored", "packages/server/src/login.ts", "      if (!admitted) { res.statusCode = 400; res.end(); return; }\n", "", { suites: ['unit'] }),
  // smart-state-constant: every sign-in uses the same state. Killing test: SMART login: every sign-in uses a fresh state and PKCE verifier
  M("smart-state-constant", "packages/auth/src/pkce.ts", "  return randomBytes(32).toString('base64url');", "  return 'A'.repeat(43);", { suites: ['unit'] }),
  // smart-verifier-constant: every sign-in uses the same PKCE verifier. Killing test: SMART login: every sign-in uses a fresh state and PKCE verifier
  M("smart-verifier-constant", "packages/auth/src/pkce.ts", "  const verifier = randomBytes(32).toString('base64url');", "  const verifier = 'A'.repeat(43);", { suites: ['unit'] }),
  // smart-send-grant-unchecked: the transport sends a clinical request without checking the grant of the credential it carries. Killing test: SMART backend gateway: a token renewed during metadata retrieval with a narrower grant sends no request for the type it no longer grants
  M("smart-send-grant-unchecked", "packages/core/src/transport.ts", "      if (permission && this.credentials && !(this.credentials.allows?.(permission.type, permission.interaction) ?? false)) {", "      if (false) {", { suites: ['unit'] }),
  // smart-read-permission-dropped: a read does not name the permission it needs, so the transport sends it unchecked. Killing test: SMART backend gateway: a token renewed during metadata retrieval with a narrower grant sends no request for the type it no longer grants
  M("smart-read-permission-dropped", "packages/core/src/index.ts", "stats, { ...budget, permission: { type, interaction: 'read' } }) as FhirResource;", "stats, budget) as FhirResource;", { suites: ['unit'] }),
  // smart-search-permission-dropped: a search does not name the permission it needs, so the transport sends it unchecked. Killing test: SMART backend gateway: a token renewed during metadata retrieval with a narrower grant sends no request for the type it no longer grants
  M("smart-search-permission-dropped", "packages/core/src/index.ts", "    const bundle = await this.transport.get(url, stats, { ...budget, permission: { type, interaction: 'search' } });", "    const bundle = await this.transport.get(url, stats, budget);", { suites: ['unit'] }),
  // token-deadline-only-below-timeout: a caller deadline longer than one request timeout is not enforced, so a multi-stage acquisition can outlast it. Killing test: SMART backend: a caller deadline bounds the whole acquisition, though discovery and the token request each finish within their own timeout
  M("token-deadline-only-below-timeout", "packages/auth/src/token-provider.ts", "      if (remaining !== undefined) timer = setTimeout(", "      if (remaining !== undefined && remaining < this.timeoutMs) timer = setTimeout(", { suites: ['unit'] }),
  // smart-logout-unlocked: logout removes the grant without the grant lock, so a refresh in progress writes it back. Killing test: SMART logout waits for a refresh in progress, so the refreshed grant does not outlive the logout
  M("smart-logout-unlocked", "packages/auth/src/token-store.ts", "  return withGrantLock(path, held => deleteTokenFile(path, held));", "  return deleteTokenFile(path);", { suites: ['unit'] }),
  // smart-grant-lock-heartbeat-dropped: a live holder no longer touches its lock, so a long refresh is taken over. Killing test: SMART grant lock: a live holder that works past the stale limit is never taken over
  M("smart-grant-lock-heartbeat-dropped", "packages/auth/src/token-store.ts", "  const heartbeat = setInterval(() => { void touch(); }, heartbeatMs);", "  const heartbeat = setInterval(() => undefined, heartbeatMs);", { suites: ['unit'] }),
  // smart-grant-lock-takeover-unverified: a stale-lock takeover removes whatever lock it moved aside, even a fresh one another process created. Killing test: SMART grant lock: a process that finds a stale lock never removes a fresh lock that replaced it, and stale reclaimers take turns
  M("smart-grant-lock-takeover-unverified", "packages/auth/src/token-store.ts", "  if (moved && moved.ino === seen.ino && moved.dev === seen.dev && moved.owner === seen.owner && age(moved) > staleMs) {", "  if (true) {", { suites: ['unit'] }),
  // smart-grant-lock-takeover-age-unrechecked: a stale-lock takeover removes a lock its holder touched after it was judged stale. Killing test: SMART grant lock: a process that finds a stale lock never removes a fresh lock that replaced it, and stale reclaimers take turns
  M("smart-grant-lock-takeover-age-unrechecked", "packages/auth/src/token-store.ts", " && moved.owner === seen.owner && age(moved) > staleMs) {", " && moved.owner === seen.owner) {", { suites: ['unit'] }),
  // smart-grant-lock-reclaim-unguarded: a reclaimer that finds the reclaim guard held takes the stale lock over anyway, so two reclaimers can both judge the same lock stale and one moves the fresh lock the other created. Killing test: SMART grant lock: stale reclaimers take turns under a reclaim guard, so one about to move the stale lock is never overtaken
  M("smart-grant-lock-reclaim-unguarded", "packages/auth/src/token-store.ts", "  if (!guard) return false;", "  if (!guard) return takeOverIfStillStale(lock, seen, staleMs);", { suites: ['unit'] }),
  // smart-grant-lock-reclaim-not-reinspected: under the reclaim guard the lock is not inspected again, so a reclaimer acts on its outdated view and moves a fresh lock that replaced the stale one. Killing test: SMART grant lock: a reclaimer that judged a lock stale before another process replaced it never moves the fresh lock, so a third process never gets in
  M("smart-grant-lock-reclaim-not-reinspected", "packages/auth/src/token-store.ts", "  const present = await inspectLock(lock);", "  const present = seen;", { suites: ['unit'] }),
  // smart-grant-lock-leftover-guard-blocks: a reclaim guard left by a crashed reclaimer is treated as held, so the stale lock is never taken over. Killing test: SMART grant lock: a reclaim guard left by a reclaimer that stopped does not block a later takeover, and is removed
  M("smart-grant-lock-leftover-guard-blocks", "packages/auth/src/token-store.ts", "    if (age(state) <= staleMs) return undefined;", "    if (state) return undefined;", { suites: ['unit'] }),
  // smart-grant-lock-leftover-guard-kept: a reclaim guard left by a crashed reclaimer is stepped over but never removed. Killing test: SMART grant lock: a reclaim guard left by a reclaimer that stopped does not block a later takeover, and is removed
  M("smart-grant-lock-leftover-guard-kept", "packages/auth/src/token-store.ts", " && age(now) > staleMs) await unlink(name).catch(() => undefined);", " && age(now) > staleMs) void name;", { suites: ['unit'] }),
  // smart-grant-lock-move-failure-retried: a stale lock that cannot be moved aside is retried at once, without the wait limit. Killing test: SMART grant lock: a stale lock that cannot be moved aside is refused at once, not retried past the wait limit
  M("smart-grant-lock-move-failure-retried", "packages/auth/src/token-store.ts", "    throw fault('CREDENTIAL_UNAVAILABLE', 'The stale SMART grant lock could not be taken over.');", "    return true;", { suites: ['unit'] }),
  // smart-grant-lock-superseded-commit: a holder whose lock was taken over still commits. Killing test: SMART standalone serving: a refresh whose grant lock was taken over stores nothing
  M("smart-grant-lock-superseded-commit", "packages/auth/src/token-store.ts", "    if (!await ownsLock()) throw fault('TOKEN_TIMEOUT', 'The SMART grant lock was taken over by another process; nothing was stored.', true);\n", "", { suites: ['unit'] }),
  // smart-refresh-commit-unguarded: a refresh writes its grant without confirming it still holds the grant lock. Killing test: SMART standalone serving: a refresh whose grant lock was taken over stores nothing
  M("smart-refresh-commit-unguarded", "packages/auth/src/smart-standalone.ts", "{ refreshToken: fields.refresh_token } : {}) }, held);", "{ refreshToken: fields.refresh_token } : {}) });", { suites: ['unit'] }),
  // smart-login-expiry-unrechecked: a login stores a token that expired while it waited for the grant lock. Killing test: SMART standalone: a login stores its grant only after the grant lock is free
  M("smart-login-expiry-unrechecked", "packages/auth/src/smart-standalone.ts", "    if (!(this.now() < usableUntil)) throw fault('TOKEN_EXPIRED', 'The token\\'s usable lifetime elapsed while the grant lock was held by another process.', true);\n", "", { suites: ['unit'] }),
  // smart-login-directory-unchecked: a login sends the user to approve before checking that the grant directory is usable. Killing test: SMART standalone: a grant directory with group or other access is refused and nothing is written
  M("smart-login-directory-unchecked", "packages/auth/src/smart-standalone.ts", "    await prepareGrantDirectory(this.tokenFile);\n", "", { suites: ['unit'] }),
  // doctor-patient-grant-unchecked: doctor reports Patient ready without the grant permitting Patient read. Killing test: doctor CLI: under SMART, the workflow is ready only when the grant permits Patient read and Observation search
  M("doctor-patient-grant-unchecked", "packages/server/src/main.ts", "executable(patientView, 'read') && gateway.grantPermits('Patient', 'read') ?", "executable(patientView, 'read') ?", { suites: ['unit'] }),
  // doctor-observation-grant-unchecked: doctor reports Observation ready without the grant permitting Observation search. Killing test: doctor CLI: under SMART, the workflow is ready only when the grant permits Patient read and Observation search
  M("doctor-observation-grant-unchecked", "packages/server/src/main.ts", "executable(observationView, 'search-type') && gateway.grantPermits('Observation', 'search') ?", "executable(observationView, 'search-type') ?", { suites: ['unit'] }),
  // doctor-patient-grant-interaction-swapped: doctor accepts Patient search permission in place of read. Killing test: doctor CLI: under SMART, the workflow is ready only when the grant permits Patient read and Observation search
  M("doctor-patient-grant-interaction-swapped", "packages/server/src/main.ts", "gateway.grantPermits('Patient', 'read')", "gateway.grantPermits('Patient', 'search')", { suites: ['unit'] }),
  // doctor-observation-grant-interaction-swapped: doctor accepts Observation read permission in place of search. Killing test: doctor CLI: under SMART, the workflow is ready only when the grant permits Patient read and Observation search
  M("doctor-observation-grant-interaction-swapped", "packages/server/src/main.ts", "gateway.grantPermits('Observation', 'search')", "gateway.grantPermits('Observation', 'read')", { suites: ['unit'] }),
  // smart-launch-grant-change-unsignalled: a changed standalone grant does not start a new authorization epoch. Killing test: SMART standalone serving: a re-login with a different grant expires handles retained under the old grant
  M("smart-launch-grant-change-unsignalled", "packages/auth/src/smart-standalone.ts", "    if (changed) this.onGrantChanged?.();\n", "", { suites: ['unit'] }),
  // smart-launch-grant-change-always-signalled: an unchanged standalone grant still starts a new authorization epoch. Killing test: SMART standalone serving: a re-login with a different grant expires handles retained under the old grant
  M("smart-launch-grant-change-always-signalled", "packages/auth/src/smart-standalone.ts", "    if (changed) this.onGrantChanged?.();", "    if (true) this.onGrantChanged?.();", { suites: ['unit'] }),
  // smart-backend-grant-change-unsignalled: a changed backend grant does not start a new authorization epoch. Killing test: SMART backend gateway: a changed grant at renewal expires handles retained under the old grant
  M("smart-backend-grant-change-unsignalled", "packages/auth/src/smart-backend.ts", "    if (changed) this.onGrantChanged?.();\n", "", { suites: ['unit'] }),
  // smart-backend-grant-change-always-signalled: an unchanged backend grant still starts a new authorization epoch. Killing test: SMART backend gateway: a changed grant at renewal expires handles retained under the old grant
  M("smart-backend-grant-change-always-signalled", "packages/auth/src/smart-backend.ts", "    if (changed) this.onGrantChanged?.();", "    if (true) this.onGrantChanged?.();", { suites: ['unit'] }),
  // smart-authorization-endpoint-unchecked: the discovered authorization endpoint is used without the origin and pin policy. Killing test: SMART login: an authorization endpoint on another loopback origin needs a pin, and discovery must agree with the pin
  M("smart-authorization-endpoint-unchecked", "packages/auth/src/smart-discovery.ts", "    ? checkDiscoveredEndpoint(document.authorization_endpoint, 'authorization_endpoint', source, options.pins.authorization)", "    ? new URL(String(document.authorization_endpoint))", { suites: ['unit'] }),
  // smart-authorization-pin-ignored: the operator's authorization endpoint pin is ignored. Killing test: SMART login: an authorization endpoint on another loopback origin needs a pin, and discovery must agree with the pin
  M("smart-authorization-pin-ignored", "packages/auth/src/smart-discovery.ts", "'authorization_endpoint', source, options.pins.authorization)", "'authorization_endpoint', source)", { suites: ['unit'] }),
  // smart-stored-token-expiry-unchecked: a stored access token is served without checking its usable lifetime. Killing tests: SMART standalone serving: a stored token inside its final expiry margin is not used; SMART standalone serving: an expired access token is refreshed once and the rotated refresh token is persisted
  M("smart-stored-token-expiry-unchecked", "packages/auth/src/smart-standalone.ts", "      if (this.now() < usableUntil) {", "      if (true) {", { suites: ['unit'] }),
  // smart-stored-token-margin-ignored: a stored access token is served inside its final expiry margin. Killing test: SMART standalone serving: a stored token inside its final expiry margin is not used
  M("smart-stored-token-margin-ignored", "packages/auth/src/smart-standalone.ts", "      const usableUntil = this.usableUntil(stored.issuedAt, stored.expiresAt);", "      const usableUntil = stored.expiresAt;", { suites: ['unit'] }),
  // smart-state-prefix-accepted: a returned state that is a prefix of the one sent is accepted. Killing test: SMART login state: only the exact state matches, never a prefix, an extension or another value
  M("smart-state-prefix-accepted", "packages/auth/src/pkce.ts", "  return a.length === b.length && timingSafeEqual(a, b);", "  return b.length > 0 && b.length <= a.length && timingSafeEqual(a.subarray(0, b.length), b);", { suites: ['unit'] }),
  // smart-state-length-unchecked: the state comparison skips the length check and throws instead of refusing. Killing test: SMART login state: only the exact state matches, never a prefix, an extension or another value
  M("smart-state-length-unchecked", "packages/auth/src/pkce.ts", "  return a.length === b.length && timingSafeEqual(a, b);", "  return timingSafeEqual(a, b);", { suites: ['unit'] }),
  // smart-listener-timeout-dropped: the login listener never times out. Killing test: SMART login listener: closes after the timeout without a callback
  M("smart-listener-timeout-dropped", "packages/server/src/login.ts", "      timer = setTimeout(() => { if (!accepted) fail(new CallbackFault('CALLBACK_TIMEOUT')); close(); }, timeoutMs);\n", "", { suites: ['unit'] }),
  // smart-listener-timeout-stretched: the login listener outlives its timeout. Killing test: SMART login listener: closes after the timeout without a callback
  M("smart-listener-timeout-stretched", "packages/server/src/login.ts", "close(); }, timeoutMs);", "close(); }, timeoutMs * 1_000);", { suites: ['unit'] }),
  // smart-token-file-owner-unchecked: a token file owned by another user is used. Killing test: SMART standalone serving: a token file or grant directory owned by another user is CREDENTIAL_UNAVAILABLE with no request
  M("smart-token-file-owner-unchecked", "packages/auth/src/token-store.ts", "uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0) unusable();", "uid === undefined || (info.mode & 0o077) !== 0) unusable();", { suites: ['unit'] }),
  // smart-grant-directory-owner-unchecked: a grant directory owned by another user is used. Killing test: SMART standalone serving: a token file or grant directory owned by another user is CREDENTIAL_UNAVAILABLE with no request
  M("smart-grant-directory-owner-unchecked", "packages/auth/src/token-store.ts", "!info.isDirectory() || uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0) {", "!info.isDirectory() || uid === undefined || (info.mode & 0o077) !== 0) {", { suites: ['unit'] }),
  // smart-key-file-owner-unchecked: a private key file owned by another user is used. Killing test: client assertion: the key comes from exactly one source; a key file must be private, regular and not a link
  M("smart-key-file-owner-unchecked", "packages/auth/src/client-assertion.ts", "    if (!info.isFile() || uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0) {", "    if (!info.isFile() || uid === undefined || (info.mode & 0o077) !== 0) {", { suites: ['unit'] }),
  // stdio-end-skips-shutdown: closing standard input only closes the gateway, so an upstream request in flight keeps the process running. Both end-of-input events are weakened: a closed pipe emits 'end' and then 'close'. Killing test: stdio CLI: closing standard input shuts the server down at once, even while an upstream request is in flight
  C("stdio-end-skips-shutdown", [{"file": "packages/server/src/main.ts", "find": "  process.stdin.once('end', shutdown);", "replace": "  process.stdin.once('end', () => { gateway.close(); });"}, {"file": "packages/server/src/main.ts", "find": "  process.stdin.once('close', shutdown);", "replace": "  process.stdin.once('close', () => { gateway.close(); });"}], { suites: ['unit'] }),
  // smart-grant-lock-retry-skips-wait-limit: a lock that vanished, or a takeover that says to retry at once, skips the wait limit, so a run of them never times out. Killing test: SMART grant lock: a lock that keeps vanishing before it can be inspected still ends at the wait limit
  M("smart-grant-lock-retry-skips-wait-limit", "packages/auth/src/token-store.ts", "    const again = !seen || (age(seen) > staleMs && await reclaimStale(lock, seen, owner, staleMs));\n", "    const again = !seen || (age(seen) > staleMs && await reclaimStale(lock, seen, owner, staleMs));\n    if (again) continue;\n", { suites: ['unit'] }),
  // smart-grant-lock-lower-generation-unchecked: a reclaimer keeps a higher guard after the leftover it stepped over was replaced, so two reclaimers hold guards at once. Killing test: SMART grant lock: a reclaimer whose stepped-over leftover guard was replaced gives its own guard back and never moves the lock
  M("smart-grant-lock-lower-generation-unchecked", "packages/auth/src/token-store.ts", "if (!await leftoversUnchanged(skipped, staleMs)) {", "if (!await leftoversUnchanged([], staleMs)) {", { suites: ['unit'] }),
  // smart-grant-lock-leftover-guard-identity-unchecked: a leftover guard is removed by name and age alone, even when another file replaced it. Killing test: SMART grant lock: a leftover guard is removed only while it is still the same untouched file
  M("smart-grant-lock-leftover-guard-identity-unchecked", "packages/auth/src/token-store.ts", "if (now && now.ino === state.ino && now.dev === state.dev && now.owner === state.owner && age(now) > staleMs) await unlink(name)", "if (now && age(now) > staleMs) await unlink(name)", { suites: ['unit'] }),
  // doctor-sign-in-blamed-on-metadata: a sign-in that yields no credential is reported as a metadata fault: the metadata call still runs after the failed sign-in, and its fault decides. Killing tests: doctor CLI: a client-credentials sign-in that yields no token is SIGN_IN_UNAVAILABLE, and the metadata is not checked; doctor CLI: SMART discovery naming an off-origin or non-literal token endpoint, or a redirect from discovery or the token endpoint, is SIGN_IN_UNAVAILABLE before any FHIR request
  M("doctor-sign-in-blamed-on-metadata", "packages/server/src/main.ts", "const server = signInFault === undefined ? await gateway.execute('fhir_capabilities', { topic: 'server' }) : undefined;", "const server = await gateway.execute('fhir_capabilities', { topic: 'server' });", { suites: ['unit'] }),
  // doctor-sign-in-unconfigured-blamed: a source without configured sign-in that refuses the metadata is reported as a sign-in failure. Killing test: doctor CLI: without configured sign-in, a source that refuses the metadata is METADATA_UNAVAILABLE
  M("doctor-sign-in-unconfigured-blamed", "packages/server/src/main.ts", "(server.error?.code === 'CONNECTION_REQUIRED' && config.source.auth)", "(server.error?.code === 'CONNECTION_REQUIRED')", { suites: ['unit'] }),
  // doctor-sign-in-preflight-skipped: doctor no longer obtains the credential first, so a sign-in failure raised by the metadata call (a redirect from SMART discovery, an off-origin token endpoint) is reported as a metadata fault. Killing test: doctor CLI: SMART discovery naming an off-origin or non-literal token endpoint, or a redirect from discovery or the token endpoint, is SIGN_IN_UNAVAILABLE before any FHIR request
  M("doctor-sign-in-preflight-skipped", "packages/server/src/main.ts", "const signInFault = config.source.auth ? await gateway.checkSignIn() : undefined;", "const signInFault = config.source.auth ? undefined : undefined;", { suites: ['unit'] }),
  // doctor-sign-in-check-swallows-fault: the sign-in check reports success when no credential was obtained. Killing test: doctor CLI: SMART discovery naming an off-origin or non-literal token endpoint, or a redirect from discovery or the token endpoint, is SIGN_IN_UNAVAILABLE before any FHIR request
  M("doctor-sign-in-check-swallows-fault", "packages/core/src/index.ts", "    catch (error) { return error instanceof GatewayFault ? error.code : 'CONNECTION_REQUIRED'; }", "    catch { return undefined; }", { suites: ['unit'] }),
  // doctor-token-rejection-blamed-on-metadata: a token the source rejects at /metadata is reported as unavailable metadata. Killing test: doctor CLI: after a good sign-in, a redirect on /metadata is a metadata fault and a token the source rejects is SIGN_IN_UNAVAILABLE
  M("doctor-token-rejection-blamed-on-metadata", "packages/server/src/main.ts", "(server.error?.code === 'CONNECTION_REQUIRED' && config.source.auth)", "(Boolean(0) && config.source.auth)", { suites: ['unit'] }),
  // doctor-metadata-fault-blamed-on-sign-in: under configured sign-in, every metadata failure after a good sign-in (a redirect on /metadata, say) is reported as a sign-in failure. Killing test: doctor CLI: after a good sign-in, a redirect on /metadata is a metadata fault and a token the source rejects is SIGN_IN_UNAVAILABLE
  M("doctor-metadata-fault-blamed-on-sign-in", "packages/server/src/main.ts", "(server.error?.code === 'CONNECTION_REQUIRED' && config.source.auth)", "(server.error !== undefined && config.source.auth)", { suites: ['unit'] }),
  // stdio-close-skips-shutdown: standard input torn down without reaching its end leaves the server running. Killing test: stdio CLI: standard input closing without reaching its end shuts the server down at once, even while an upstream request is in flight
  M("stdio-close-skips-shutdown", "packages/server/src/main.ts", "  process.stdin.once('close', shutdown);\n", "", { suites: ['unit'] }),
  // shutdown-skips-credential-settle: shutdown exits as soon as the gateway is closed, without the settle that cuts a refresh still running after close, so its grant lock is left behind. Killing test: SMART standalone serving: shutting down while a refresh holds the grant lock removes the lock and exits within the bound
  M("shutdown-skips-credential-settle", "packages/server/src/main.ts", "gateway.closeAndSettle(SHUTDOWN_SETTLE_MS)", "Promise.resolve(gateway.close())", { suites: ['unit'] }),
  // gateway-close-skips-credential-settle: the gateway's shutdown close does not wait for, or cut, credential work still running after close, so a refresh's grant lock is left behind. Killing test: SMART standalone serving: shutting down while a refresh holds the grant lock removes the lock and exits within the bound
  M("gateway-close-skips-credential-settle", "packages/core/src/index.ts", "    await this.credentials?.settled(settleMs);\n", "", { suites: ['unit'] }),
  // credential-settle-forgets-abandoned: an acquisition is not tracked once started, so shutdown neither waits for nor cuts a refresh still running after close, and its grant lock is left behind. Killing test: SMART standalone serving: shutting down while a refresh holds the grant lock removes the lock and exits within the bound
  M("credential-settle-forgets-abandoned", "packages/auth/src/token-provider.ts", "    this.running.add(flight.promise);\n", "", { suites: ['unit'] }),
  // credential-settle-unbounded: the settle bound is stretched far past the hard exit, so a sent refresh that is never answered is never cut and the exiting process leaves its grant lock behind. Killing test: SMART standalone serving: shutting down while a refresh holds the grant lock removes the lock and exits within the bound
  M("credential-settle-unbounded", "packages/auth/src/token-provider.ts", "if (await settledWithin([...this.running], settleMs) ||", "if (await settledWithin([...this.running], settleMs * 1_000) ||", { suites: ['unit'] }),
  // doctor-sign-in-fault-dropped: metadata left unchecked raises no fault, so doctor reports ready. Killing test: doctor report: metadata left unchecked by a failed sign-in is SIGN_IN_UNAVAILABLE, never a metadata fault
  M("doctor-sign-in-fault-dropped", "packages/server/src/doctor.ts", "if (input.metadata.status === 'not-checked') faults.add('SIGN_IN_UNAVAILABLE');", "if (Boolean(0)) faults.add('SIGN_IN_UNAVAILABLE');", { suites: ['unit'] }),
  // doctor-unchecked-metadata-facts: metadata that was never read may still claim a FHIR version, summary, revision or type count. Killing test: doctor report: metadata left unchecked by a failed sign-in is SIGN_IN_UNAVAILABLE, never a metadata fault
  M("doctor-unchecked-metadata-facts", "packages/server/src/doctor.ts", "metadata.status !== 'not-checked' || (metadata.fhir", "metadata.status !== 'not-checked' || true || (metadata.fhir", { suites: ['unit'] }),
  // capabilities-continuation-acquires-token: a discovery continuation acquires a token it does not need, so a token in its renewal window is renewed (or fails) for a local page. Killing tests: S55 modern server: a continuation after the token entered its renewal window makes no token or metadata request and returns the next page; SMART standalone serving: a discovery continuation needs no token, and expires once a later call finds the grant logged out
  M("capabilities-continuation-acquires-token", "packages/core/src/index.ts", "if (this.credentials && !(tool === 'fhir_capabilities' && input.cursor)) await this.authorizationFor(this.transport.base, budget);", "if (this.credentials) await this.authorizationFor(this.transport.base, budget);", { suites: ['unit'] }),
  // capabilities-first-page-skips-token: every fhir_capabilities call skips the credential check, so a first page served from cached metadata never renews or checks the credential. Killing tests: S55 modern auth observer: first HTTP fetch, cache hit and expired-token refresh count actual attempts only; S55 modern server: a continuation after the token entered its renewal window makes no token or metadata request and returns the next page
  M("capabilities-first-page-skips-token", "packages/core/src/index.ts", "!(tool === 'fhir_capabilities' && input.cursor)) await", "!(tool === 'fhir_capabilities')) await", { suites: ['unit'] }),
  // stage-document-links-unchecked: a staged markdown document may link to, or show, a file the package does not ship. Killing test: package stage: a staged markdown link or image whose target is not in the package is refused
  M("stage-document-links-unchecked", "scripts/stage-package.ts", "  if (broken.length) throw fault('STAGE_DOCUMENT_LINK', broken);", "  if (Boolean(0)) throw fault('STAGE_DOCUMENT_LINK', broken);", { suites: ['unit'] }),
  // stage-document-staged-target-not-mapped: a link to a file the package ships is sent to the public repository instead. Killing test: package stage: staged markdown links point inside the package or to the public repository, keeping anchors
  M("stage-document-staged-target-not-mapped", "scripts/stage-package.ts", "if (packageTarget !== undefined && stagedTarget(packageTarget, staged)) return", "if (Boolean(0) && packageTarget !== undefined && stagedTarget(packageTarget, staged)) return", { suites: ['unit'] }),
  // stage-document-images-as-pages: an image outside the package points at its repository page, which does not render as an image. Killing test: package stage: staged markdown links point inside the package or to the public repository, keeping anchors
  M("stage-document-images-as-pages", "scripts/stage-package.ts", "return image ? `${PUBLIC_RAW_BASE}", "return image ? `${PUBLIC_BLOB_BASE}", { suites: ['unit'] }),
  // stage-document-anchor-dropped: a link rewritten to the public repository loses its anchor. Killing test: package stage: staged markdown links point inside the package or to the public repository, keeping anchors
  M("stage-document-anchor-dropped", "scripts/stage-package.ts", "`${PUBLIC_BLOB_BASE}${repoTarget}${suffix}${anchor}`", "`${PUBLIC_BLOB_BASE}${repoTarget}${suffix}`", { suites: ['unit'] }),
  // smart-refresh-sent-request-cancelled: a refresh request already sent is cut when its caller leaves or the flight is superseded, so a refresh token the server already rotated is lost. Killing tests: SMART standalone serving: a caller that leaves while the refresh request is in flight still gets the rotated refresh token written back; SMART standalone serving: a refresh superseded or closed while its request is in flight writes the rotated token but does not install its access token
  M("smart-refresh-sent-request-cancelled", "packages/auth/src/smart-standalone.ts", "        signal: this.sentRequestSignal(),", "        signal: AbortSignal.any([signal, this.sentRequestSignal()]),", { suites: ['unit'] }),
  // smart-refresh-abandoned-installs-token: a refresh whose flight was superseded, or whose provider closed, still installs its access token in memory. Killing test: SMART standalone serving: a refresh superseded or closed while its request is in flight writes the rotated token but does not install its access token
  M("smart-refresh-abandoned-installs-token", "packages/auth/src/smart-standalone.ts", "    const token = this.commitToken(generation, startedAt, accessToken, expiresIn);\n", "    const token: CachedToken = this.cached = { header: `Bearer ${accessToken}`, usableUntil: this.usableUntil(startedAt, startedAt + expiresIn * 1_000), generation: this.generation };\n", { suites: ['unit'] }),
  // smart-refresh-lock-wait-unsignalled: a refresh waits for the grant lock without its flight's signal, so a cancelled or closed refresh keeps waiting. Killing tests: SMART standalone serving: a caller that leaves during discovery or the grant-lock wait stops the refresh before any refresh request is sent; SMART standalone serving: a refresh waiting for another process's grant lock stops at once on shutdown and leaves that lock in place
  M("smart-refresh-lock-wait-unsignalled", "packages/auth/src/smart-standalone.ts", "    }, { signal });", "    });", { suites: ['unit'] }),
  // smart-grant-lock-wait-ignores-signal: the grant-lock wait ignores an aborted signal and waits on until the lock is free or the wait limit passes. Killing tests: SMART grant lock: a waiter whose signal is aborted stops at once, creates no lock or guard of its own, and leaves the holder unaffected; SMART standalone serving: a caller that leaves during discovery or the grant-lock wait stops the refresh before any refresh request is sent
  M("smart-grant-lock-wait-ignores-signal", "packages/auth/src/token-store.ts", "    if (signal?.aborted) throw abortFault(signal);\n    const created = await createLock(lock, owner);", "    const created = await createLock(lock, owner);", { suites: ['unit'] }),
  // smart-grant-lock-attempt-after-cancel: the abort is checked only after an attempt, before the sleep, so a waiter cancelled during its sleep makes one more attempt and can take a lock just released or reclaim one just gone stale. Killing tests: SMART grant lock: a lock released while a cancelled waiter sleeps is not taken by that waiter; SMART grant lock: a lock that goes stale while a cancelled waiter sleeps is neither reclaimed nor guarded by that waiter
  C("smart-grant-lock-attempt-after-cancel", [{"file": "packages/auth/src/token-store.ts", "find": "    if (signal?.aborted) throw abortFault(signal);\n    const created = await createLock(lock, owner);", "replace": "    const created = await createLock(lock, owner);"}, {"file": "packages/auth/src/token-store.ts", "find": "    if (!again) await sleep(20, undefined, { signal }).catch(() => undefined);", "replace": "    if (signal?.aborted) throw abortFault(signal);\n    if (!again) await sleep(20, undefined, { signal }).catch(() => undefined);"}], { suites: ['unit'] }),
  // credential-settle-keeps-sent-request: past the settle bound a closed provider no longer cuts a refresh request already sent, so a shutdown during an unanswered refresh leaves the grant lock behind. Killing test: SMART standalone serving: shutting down while a refresh holds the grant lock removes the lock and exits within the bound
  M("credential-settle-keeps-sent-request", "packages/auth/src/token-provider.ts", "    this.sentRequests.abort();\n", "", { suites: ['unit'] }),
  // shutdown-unbounded: shutdown has no hard bound, so a connection close that waits for standard output to drain keeps the process alive. Killing test: stdio CLI: a client that stops reading standard output cannot keep the server alive past the shutdown bound. That test is skipped on Windows, where the Node.js documentation says standard output pipes are written synchronously; the registry has no platform condition, so a mutation run on Windows would report this mutant as a survivor. Only macOS has been run.
  M("shutdown-unbounded", "packages/server/src/main.ts", "    setTimeout(() => { process.exit(0); }, SHUTDOWN_EXIT_MS).unref();\n", "", { suites: ['unit'] }),
  // smart-refresh-posts-after-lock-lost: a refresh whose grant lock was taken over still sends its refresh request, presenting a refresh token another process may already have replaced. Killing test: SMART standalone serving: a refresh whose grant lock was taken over before its request is sent sends no refresh request and writes nothing
  M("smart-refresh-posts-after-lock-lost", "packages/auth/src/smart-standalone.ts", "    await held();\n", "", { suites: ['unit'] }),
  // smart-grant-lock-aborted-entry-creates-directory: an already aborted signal still prepares (creates) the grant directory before the wait refuses it. Killing test: SMART grant lock: a waiter whose signal is aborted stops at once, creates no lock or guard of its own, and leaves the holder unaffected
  M("smart-grant-lock-aborted-entry-creates-directory", "packages/auth/src/token-store.ts", "  if (signal?.aborted) throw abortFault(signal);\n  await privateDirectory", "  await privateDirectory", { suites: ['unit'] }),
  // smart-refresh-reenters-lock-after-close: a closed provider that adopted a changed grant takes the grant lock again. Every guard is weakened: the check before re-entering the refresh, and the lock's refusal of an aborted signal at entry and before each attempt (any one alone stops it). Killing test: SMART standalone serving: a provider closed after it found a changed grant under the grant lock does not take the lock again
  C("smart-refresh-reenters-lock-after-close", [{"file": "packages/auth/src/smart-standalone.ts", "find": "    this.stopIfDone(signal);\n    if ('changed' in outcome) {", "replace": "    if ('changed' in outcome) {"}, {"file": "packages/auth/src/token-store.ts", "find": "  if (signal?.aborted) throw abortFault(signal);\n  await privateDirectory", "replace": "  await privateDirectory"}, {"file": "packages/auth/src/token-store.ts", "find": "    if (signal?.aborted) throw abortFault(signal);\n    const created = await createLock(lock, owner);", "replace": "    const created = await createLock(lock, owner);"}], { suites: ['unit'] }),
  // credential-waiter-ignores-flight-abort: a caller waiting on a flight that close() or invalidate() aborted keeps waiting until the sent token request ends or times out. Killing test: SMART standalone serving: a caller still waiting when its refresh is superseded or closed during the sent request is released at once, and the rotated token is still written back
  M("credential-waiter-ignores-flight-abort", "packages/auth/src/token-provider.ts", "      flight.controller.signal.addEventListener('abort', onFlightAbort, { once: true });\n", "", { suites: ['unit'] }),
  // shutdown-settle-waits-for-close: the credential settle starts only after the connection close finishes, so a close that waits for standard output to drain leaves a refresh's grant lock behind at the hard exit. Killing test: stdio CLI: shutdown releases a grant lock held by a refresh even while the connection close waits for a client that stopped reading
  M("shutdown-settle-waits-for-close", "packages/server/src/main.ts", "void Promise.allSettled([handle.close(), gateway.closeAndSettle(SHUTDOWN_SETTLE_MS)])", "void Promise.allSettled([handle.close().then(() => gateway.closeAndSettle(SHUTDOWN_SETTLE_MS))])", { suites: ['unit'] }),
  // smart-login-lock-wait-unsignalled: a login keeps waiting for the grant lock after its provider closed. Killing test: SMART standalone: a login whose provider closes while it waits for the grant lock stops at once and writes nothing
  M("smart-login-lock-wait-unsignalled", "packages/auth/src/smart-standalone.ts", "held => this.storeLogin(stored, usableUntil, held), { signal: controller.signal });", "held => this.storeLogin(stored, usableUntil, held));", { suites: ['unit'] }),
  // stage-document-untracked-target-allowed: a link rewritten to the public repository may name a file this repository does not track. Killing test: package links: a target rewritten to the public repository must be tracked in this repository
  M("stage-document-untracked-target-allowed", "scripts/stage-package.ts", "!listedPath(link.path, repository.tracked)) problems.push", "Boolean(0)) problems.push", { suites: ['unit'] }),
  // stage-document-repository-links-unchecked: a shipped document linking to an untracked path or a missing anchor does not stop the stage. Killing test: package links: a target rewritten to the public repository must be tracked in this repository
  M("stage-document-repository-links-unchecked", "scripts/stage-package.ts", "  if (problems.length) throw fault('STAGE_DOCUMENT_LINK', problems);", "  if (Boolean(0)) throw fault('STAGE_DOCUMENT_LINK', problems);", { suites: ['unit'] }),
  // stage-document-anchor-unchecked: an anchor into another markdown file is never compared with its headings. Killing test: package links: an anchor into a markdown file or the document itself must name a heading or HTML id
  M("stage-document-anchor-unchecked", "scripts/stage-package.ts", "&& !anchorDefined(anchorsOf(link.path), link.anchor)) problems.push", "&& Boolean(0)) problems.push", { suites: ['unit'] }),
  // stage-document-own-anchor-unchecked: an anchor into the document itself is never compared with its headings. Killing test: package links: an anchor into a markdown file or the document itself must name a heading or HTML id
  M("stage-document-own-anchor-unchecked", "scripts/stage-package.ts", "if (!anchorDefined(anchorsOf(repoSource), plain)) problems.push", "if (Boolean(0)) problems.push", { suites: ['unit'] }),
  // stage-document-root-target-resolved: a target starting at the repository root is resolved against the document's folder instead of refused. Killing test: package links: a target starting at the repository root is refused, never resolved
  M("stage-document-root-target-resolved", "scripts/stage-package.ts", "|| path.startsWith('/') ? undefined", "? undefined", { suites: ['unit'] }),
  // stage-document-fence-closed-by-any-fence: any fence line closes a fence, whatever its character or length. Killing test: package links: a fence closes only on its own character, at least as long as it opened
  M("stage-document-fence-closed-by-any-fence", "scripts/stage-package.ts", "new RegExp(`^\\\\${fence.char}{${fence.length},}[ \\\\t\\\\r]*$`)", "new RegExp('^(?:`{3,}|~{3,})[ \\\\t\\\\r]*$')", { suites: ['unit'] }),
  // stage-document-list-fence-unseen: a fence indented inside a list item is read as prose. Killing test: package links: a fence inside a list item or block quote is code, and ends with its container
  M("stage-document-list-fence-unseen", "scripts/stage-package.ts", "lists.push(empty || after.width > 4 ? column + 1 : column + after.width);", "", { suites: ['unit'] }),
  // stage-document-list-never-ends: a list item never ends, so later indented code is taken for a fence and its links are skipped. Killing test: package links: a fence inside a list item or block quote is code, and ends with its container
  M("stage-document-list-never-ends", "scripts/stage-package.ts", "while (lists.length && width < lists.at(-1)!) lists.pop();", "", { suites: ['unit'] }),
  // stage-document-quoted-fence-unseen: a fence inside a block quote is read as prose. Killing test: package links: a fence inside a list item or block quote is code, and ends with its container
  M("stage-document-quoted-fence-unseen", "scripts/stage-package.ts", "at += m[0].length; ends.push(at);", "at += m[0].length;", { suites: ['unit'] }),
  // stage-document-code-spans-scanned: a link written inside a code span is rewritten and checked as a link. Killing test: package links: a link written inside a code span is text, but a link whose text holds code is a link
  M("stage-document-code-spans-scanned", "scripts/stage-package.ts", "if (close < 0) { i = run - 1; continue; }", "if (close < 0 || Boolean(1)) { i = run - 1; continue; }", { suites: ['unit'] }),
  // stage-document-escapes-ignored: a backslash-escaped backtick opens a code span that hides the links after it. Killing test: package links: a link written inside a code span is text, but a link whose text holds code is a link
  M("stage-document-escapes-ignored", "scripts/stage-package.ts", "if (masked[i] === '\\\\' && i + 1 < end && ASCII_PUNCTUATION.test(masked[i + 1]!)) { chars[i + 1] = 'e'; i++; continue; }", "", { suites: ['unit'] }),
  // stage-document-destination-on-one-line: a destination on the line after the opening parenthesis or colon is missed. Killing test: package links: links, definitions and HTML attributes wrapped across lines are found
  M("stage-document-destination-on-one-line", "scripts/stage-package.ts", "const lead = /[ \\t]*(?:\\r?\\n[ \\t]*)?/y;", "const lead = /[ \\t]*/y;", { suites: ['unit'] }),
  // stage-document-angle-brackets-kept: an angle-bracket destination keeps its brackets, so it is never found in the package. Killing test: package links: angle-bracket and parenthesised destinations are read whole
  M("stage-document-angle-brackets-kept", "scripts/stage-package.ts", "if (masked[k] === '>') return { start: at + 1, end: k };", "if (masked[k] === '>') return { start: at, end: k + 1 };", { suites: ['unit'] }),
  // stage-document-destination-cut-at-parenthesis: a destination is cut at its first parenthesis. Killing test: package links: angle-bracket and parenthesised destinations are read whole
  M("stage-document-destination-cut-at-parenthesis", "scripts/stage-package.ts", "if (masked[k] === '(') depth++;\n    else if (masked[k] === ')') { if (!depth) break;", "if (masked[k] === '(') break;\n    else if (masked[k] === ')') { if (!depth) break;", { suites: ['unit'] }),
  // stage-document-reference-image-as-page: a definition used by a reference-style image points at the repository page, which does not render as an image. Killing test: package links: reference definitions in block quotes and list items are found, and a reference image uses the raw host
  M("stage-document-reference-image-as-page", "scripts/stage-package.ts", "spans.push({ ...span, image: imageLabels.has(label) });", "spans.push({ ...span, image: false });", { suites: ['unit'] }),
  // stage-document-attribute-name-case: an upper-case HTML attribute name is not recognised as a URL attribute. Killing test: package links: HTML URL attributes are found whatever their case, spacing or quoting
  M("stage-document-attribute-name-case", "scripts/stage-package.ts", "found.push({ tag, name: key.toLowerCase(), start: k + 1, end: close, quote });", "found.push({ tag, name: key, start: k + 1, end: close, quote });", { suites: ['unit'] }),
  // stage-document-percent-encoding-kept: a percent-encoded target is looked up undecoded, so a shipped file is sent to the public repository. Killing test: package links: percent-encoded targets are decoded before the package lookup
  M("stage-document-percent-encoding-kept", "scripts/stage-package.ts", "path = decoded(raw);", "path: string | undefined = raw;", { suites: ['unit'] }),
  // stage-document-footnote-as-definition: a footnote is read as a link definition, so its first word is rewritten as a link. Killing test: package links: a footnote is not a link definition, but a link inside one is a link
  M("stage-document-footnote-as-definition", "scripts/stage-package.ts", "const head = /[ \\t]*\\[(?!\\^)([^[\\]]+)\\]:/y;", "const head = /[ \\t]*\\[([^[\\]]+)\\]:/y;", { suites: ['unit'] }),
  // stage-checkout-top-level-unchecked: a folder inside another checkout is staged with that checkout's tracked files. Killing test: package links: tracked files come from the top level of a git checkout, and only those still on disk count
  M("stage-checkout-top-level-unchecked", "scripts/stage-package.ts", "realpathSync(top.stdout.trim()) !== realpathSync(root)", "Boolean(0)", { suites: ['unit'] }),
  // stage-tracked-files-exit-ignored: a failed git ls-files is read as a repository that tracks nothing. Killing test: package links: tracked files come from the top level of a git checkout, and only those still on disk count
  M("stage-tracked-files-exit-ignored", "scripts/stage-package.ts", "if (listed.status !== 0) throw fault('STAGE_TRACKED_FILES');", "if (Boolean(0)) throw fault('STAGE_TRACKED_FILES');", { suites: ['unit'] }),
  // stage-tracked-files-deleted-counted: a tracked file deleted from the working tree still satisfies a link. Killing test: package links: tracked files come from the top level of a git checkout, and only those still on disk count
  M("stage-tracked-files-deleted-counted", "scripts/stage-package.ts", "filter(path => path && existsSync(join(root, path)))", "filter(path => path)", { suites: ['unit'] }),
  // stage-document-undecodable-target-allowed: a target that cannot be decoded, or starts at a root, passes the package check. Killing test: package links: percent-encoded targets are decoded before the package lookup
  M("stage-document-undecodable-target-allowed", "scripts/stage-package.ts", "if (!relative) { broken.push(`${packagePath}: ${target}`); return target; }", "if (!relative) return target;", { suites: ['unit'] }),
  // stage-document-srcset-whole: a srcset with several candidates is taken as one URL. Killing test: package links: HTML URL attributes are found whatever their case, spacing or quoting
  M("stage-document-srcset-whole", "scripts/stage-package.ts", "    if (name !== 'srcset') {\n", "    if (Boolean(1)) {\n", { suites: ['unit'] }),
  // stage-document-target-escapes-kept: a backslash escape in a destination is kept in the path that is looked up and rewritten. Killing test: package links: angle-bracket and parenthesised destinations are read whole
  M("stage-document-target-escapes-kept", "scripts/stage-package.ts", "const unescapeTarget = (target: string): string => target.replace(/\\\\([!-/:-@[-`{-~])/g, '$1');", "const unescapeTarget = (target: string): string => target;", { suites: ['unit'] }),
  // stage-document-rewrite-unencoded: a rewritten path is not percent-encoded, so a space or parenthesis breaks the link. Killing test: package links: angle-bracket and parenthesised destinations are read whole
  M("stage-document-rewrite-unencoded", "scripts/stage-package.ts", "const encodePath = (path: string): string => path.replace(", "const encodePath = (path: string): string => path || path.replace(", { suites: ['unit'] }),
  // stage-document-query-looked-up: a query is looked up as part of the path, so a link with one is refused or misrouted. Killing test: package links: a query is kept on the rewritten link and left out of the lookup
  M("stage-document-query-looked-up", "scripts/stage-package.ts", "const [raw, query] = at < 0 ? [location, ''] : [location.slice(0, at), location.slice(at)]", "const [raw, query] = [location, '']", { suites: ['unit'] }),
  // stage-document-root-link-not-mapped: a link to the repository root is sent to a repository page that does not exist. Killing test: package links: a link to the repository root points at the public repository
  M("stage-document-root-link-not-mapped", "scripts/stage-package.ts", "    if (link.path === '.') return `${PUBLIC_ROOT}${link.query}${link.anchor}`;\n", "", { suites: ['unit'] }),
  // stage-document-root-link-untracked: a link to the repository root is refused as untracked. Killing test: package links: a link to the repository root points at the public repository
  M("stage-document-root-link-untracked", "scripts/stage-package.ts", "if (link.path !== '.' && !listedPath(", "if (!listedPath(", { suites: ['unit'] }),
  // stage-dist-stale-compared: a dist/ older than its sources is compared, so a test run before the build fails after an edit. Killing test: package inventory: the dist comparison skips an absent, incomplete or stale dist/ and says why
  M("stage-dist-stale-compared", "scripts/stage-package.ts", "  if (dist.stale.length) return `dist/ is older", "  if (Boolean(0)) return `dist/ is older", { suites: ['unit'] }),
  // stage-dist-incomplete-compared: a bare compile without the build's release metadata is compared as a complete build. Killing test: package inventory: the dist comparison skips an absent, incomplete or stale dist/ and says why
  M("stage-dist-incomplete-compared", "scripts/stage-package.ts", "  if (!dist.complete) return 'dist/ is not a complete", "  if (Boolean(0)) return 'dist/ is not a complete", { suites: ['unit'] }),
  // stage-dist-helper-unchecked: the helper inventory's dist entries are compared with themselves, so their drift passes. Killing test: package inventory: files staged from dist/ are compared with both approved inventories
  M("stage-dist-helper-unchecked", "scripts/stage-package.ts", "{ ...helper, files: helper.files.filter(f => fromDist(`quickstart/${f.path}`)) },", "{ ...helper, files: built.filter(f => f.path.startsWith('quickstart/')).map(f => ({ ...f, path: f.path.slice('quickstart/'.length) })) },", { suites: ['unit'] }),
  // stage-dist-manifest-counted: the generated manifest is taken for a dist file and reported as removed from every build. Killing test: package inventory: files staged from dist/ are compared with both approved inventories
  M("stage-dist-manifest-counted", "scripts/stage-package.ts", "(path.startsWith('dist/') && path !== 'dist/package.json')", "path.startsWith('dist/')", { suites: ['unit'] }),
  // stage-document-unquoted-attribute-name-case: an upper-case unquoted HTML attribute name is not recognised as a URL attribute. Killing test: package links: HTML URL attributes are found whatever their case, spacing or quoting
  M("stage-document-unquoted-attribute-name-case", "scripts/stage-package.ts", "found.push({ tag, name: key.toLowerCase(), start: k, end: k + value.length, quote: '' });", "found.push({ tag, name: key, start: k, end: k + value.length, quote: '' });", { suites: ['unit'] }),
  // stage-document-own-folder-empty: a link to the folder a shipped document sits in becomes an empty or root-relative path. Killing test: package links: a link to the folder a shipped document sits in stays inside the package
  M("stage-document-own-folder-empty", "scripts/stage-package.ts", "packageTarget) || '.')}", "packageTarget))}", { suites: ['unit'] }),
  // stage-heading-link-destination-kept: a link destination in a heading is slugged into its anchor. Killing test: package links: a heading anchor ignores link destinations, including code in the text and parentheses in the destination
  M("stage-heading-link-destination-kept", "scripts/stage-package.ts", "source = withoutLinkSyntax(heading)", "source = heading", { suites: ['unit'] }),
  // stage-document-encoded-slash-allowed: an encoded slash in a target is decoded into a path separator and resolved. Killing test: package links: a target starting at a root after decoding, or holding an encoded slash, is refused
  M("stage-document-encoded-slash-allowed", "scripts/stage-package.ts", "|| /%2f/i.test(raw) ||", "||", { suites: ['unit'] }),
  // stage-document-rewrite-unescaped: a rewritten target is emitted without escaping for the syntax around it. Killing test: package links: a rewritten target is escaped for the syntax around it, and HTML URLs lose surrounding space
  M("stage-document-rewrite-unescaped", "scripts/stage-package.ts", "(mapped === target ? target : escapeTarget(mapped, span))", "mapped", { suites: ['unit'] }),
  // stage-document-destination-parentheses-unescaped: a parenthesis in a rewritten Markdown destination is emitted raw and ends the link early. Killing test: package links: a rewritten target is escaped for the syntax around it, and HTML URLs lose surrounding space
  M("stage-document-destination-parentheses-unescaped", "scripts/stage-package.ts", "destination: /[\\s()<>\\\\]/gu", "destination: /[\\s<>\\\\]/gu", { suites: ['unit'] }),
  // stage-document-single-quote-unescaped: a quote in a rewritten single-quoted attribute value is emitted raw and ends the value. Killing test: package links: a rewritten target is escaped for the syntax around it, and HTML URLs lose surrounding space
  M("stage-document-single-quote-unescaped", "scripts/stage-package.ts", "single: /[\\s']/gu", "single: /[\\s]/gu", { suites: ['unit'] }),
  // stage-document-unquoted-equals-unescaped: an equals sign in a rewritten unquoted attribute value is emitted raw and cuts the value. Killing test: package links: a rewritten target is escaped for the syntax around it, and HTML URLs lose surrounding space
  M("stage-document-unquoted-equals-unescaped", "scripts/stage-package.ts", "unquoted: /[\\s\"'=<>`]/gu", "unquoted: /[\\s]/gu", { suites: ['unit'] }),
  // stage-document-attribute-space-kept: white space around an HTML attribute URL is taken as part of the target. Killing test: package links: a rewritten target is escaped for the syntax around it, and HTML URLs lose surrounding space
  M("stage-document-attribute-space-kept", "scripts/stage-package.ts", "lead = value.length - value.trimStart().length, trail = value.length - value.trimEnd().length;", "lead = 0, trail = 0;", { suites: ['unit'] }),
  // stage-document-srcset-split-at-comma: a srcset URL is cut at its first comma, so a data: URL leaves a relative fragment. Killing test: package links: srcset candidates are read as HTML reads them, data: URLs and block quotes included
  M("stage-document-srcset-split-at-comma", "scripts/stage-package.ts", "while (stop < end && !/\\s/.test(blocks[stop]!)) stop++;", "while (stop < end && !/[\\s,]/.test(blocks[stop]!)) stop++;", { suites: ['unit'] }),
  // stage-document-srcset-comma-unescaped: a comma in a rewritten srcset candidate is emitted raw and splits it. Killing test: package links: srcset candidates are read as HTML reads them, data: URLs and block quotes included
  M("stage-document-srcset-comma-unescaped", "scripts/stage-package.ts", "return span.srcset ? escaped.replace(/,/g, percent) : escaped;", "return escaped;", { suites: ['unit'] }),
  // stage-document-srcset-quote-markers: a srcset wrapped inside a block quote takes the quote marker as a candidate. Killing test: package links: srcset candidates are read as HTML reads them, data: URLs and block quotes included
  M("stage-document-srcset-quote-markers", "scripts/stage-package.ts", "while (at < end && /[\\s,]/.test(blocks[at]!)) at++;", "while (at < end && /[\\s,]/.test(text[at]!)) at++;", { suites: ['unit'] }),
  // stage-document-file-as-folder-staged: a shipped file linked as a folder passes the package check. Killing test: package links: a file linked as a folder is refused
  M("stage-document-file-as-folder-staged", "scripts/stage-package.ts", " || (relative.path.endsWith('/') && staged.has(resolved))", "", { suites: ['unit'] }),
  // stage-document-file-as-folder-tracked: a tracked file linked as a folder passes the repository check. Killing test: package links: a file linked as a folder is refused
  M("stage-document-file-as-folder-tracked", "scripts/stage-package.ts", "    else if (link.folder && repository.tracked.has(link.path)) problems.push(`${packagePath}: ${target}`);\n", "", { suites: ['unit'] }),
  // Isolation case-schema machinery: genuine admission and credit weaknesses; full witnesses in counting.test.ts.
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

export const SHARD_REPORT_SCHEMA = 'fhir-mcp-mutation-shard/5';
const VERDICTS = new Set(['killed', 'survived', 'inconclusive', 'anchor-error']);
// Who decided a verdict: the targeted first pass, the full path, or the checks before any test ran.
export const DECIDERS = Object.freeze(['targeted', 'full', 'precheck']);
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
    // A tracked file deleted from the working tree is bound by its absence,
    // by name, separately from an empty file or an unreadable existing input.
    if (deleted.has(path)) {
      hash.update(`${Buffer.byteLength(path)}:${path}deleted:`);
      continue;
    }
    // A tracked symlink is a git blob holding its target:
    // bind that target text under its own marker and never follow it, so a link to a directory cannot
    // fail the binding and a link is never confused with a file holding the same bytes. A dangling link
    // still fails closed (ENOENT), like any other existing but unreadable input.
    if ((await lstat(join(checkout, path))).isSymbolicLink()) {
      await stat(join(checkout, path));
      const target = Buffer.from(await readlink(join(checkout, path)));
      hash.update(`${Buffer.byteLength(path)}:${path}symlink:${target.length}:`).update(target);
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
export function buildShardReport({ shardIndex, shardCount, mutants, binding, baseline, suiteBaselines = {}, results, durationMs, mode = 'shard', scheduledIds, targeting = null }) {
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
    targeting,
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
      // judge() always names its decider; a result without one comes from the full path or its checks.
      decided_by: result.decidedBy ?? ((result.status ?? result.verdict) === 'anchor-error' ? 'precheck' : 'full'),
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
  const decisions = Object.fromEntries(DECIDERS.map(decider => [decider, 0]));
  const timeoutKills = [];
  if (!validBinding(binding)) errors.push('expected candidate binding is missing or malformed');
  if (expectedShardCount !== undefined && !validShardCount(expectedShardCount)) errors.push('invalid expected shard count');
  if (!mutants?.length || byId.size !== mutants.length) errors.push('current mutant list is empty or has duplicate ids');

  if (!Array.isArray(reports) || reports.length === 0) {
    return { ok: false, errors: ['no shard reports found'], summary, decisions, timeoutKills };
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
      else verdicts.set(result.id, { verdict, shard: report.shardIndex, decidedBy: result.decided_by });
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
      if (!DECIDERS.includes(result.decided_by)) errors.push(`mutant ${result.id}: decided_by is missing or unknown`);
      // The targeted pass can only kill, on reproduced named evidence; survivors and inconclusives belong to the full path.
      else if (result.decided_by === 'targeted' && !(verdict === 'killed' && result.kill_kind === 'named' && result.failingTests?.length && result.reproducedTimeout === false)) {
        errors.push(`mutant ${result.id}: the targeted pass can only decide a reproduced named kill`);
      } else if ((result.decided_by === 'precheck' && !['anchor-error', 'inconclusive'].includes(verdict)) || (verdict === 'anchor-error' && result.decided_by !== 'precheck')) {
        errors.push(`mutant ${result.id}: decided_by disagrees with the verdict (${result.decided_by}, ${verdict})`);
      }
    }
  }
  for (const mutant of mutants ?? []) {
    if (!verdicts.has(mutant.id)) errors.push(`mutant ${mutant.id}: ran zero times (no shard reported it)`);
  }
  summary.total = verdicts.size;
  for (const [id, { verdict, decidedBy }] of verdicts) {
    if (!byId.has(id)) continue;
    if (DECIDERS.includes(decidedBy)) decisions[decidedBy]++;
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
  return { ok: errors.length === 0, errors, summary, decisions, timeoutKills };
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

/**
 * CPU slots shared by every worker copy. A child run holds one slot per test file it may
 * run at once (one for any other command), so the gate never runs more test files at once
 * than the machine has CPUs, however many workers are idle or busy. Requests are served
 * in order, so a full-suite run is never starved by smaller targeted runs.
 */
export function createSlots(total) {
  if (!Number.isSafeInteger(total) || total < 1) throw new Error('invalid slot count');
  let free = total;
  const queue = [];
  const grant = () => { while (queue.length && queue[0].count <= free) { const next = queue.shift(); free -= next.count; next.resolve(); } };
  return {
    total,
    get free() { return free; },
    async acquire(count) {
      if (!Number.isSafeInteger(count) || count < 1 || count > total) throw new Error(`invalid slot request ${count}`);
      if (!queue.length && count <= free) { free -= count; return; }
      await new Promise(resolve => queue.push({ count, resolve }));
    },
    release(count) { free += count; grant(); },
  };
}
let cpuSlots;

async function run(command, argv, cwd, timeoutMs, weight = 1) {
  // A run's deadline starts when it is spawned, never while it waits for slots.
  const held = cpuSlots ? Math.max(1, Math.min(weight, cpuSlots.total)) : 0;
  if (held) await cpuSlots.acquire(held);
  try {
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
  } finally {
    if (held) cpuSlots.release(held);
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

export async function makeCopy(sourceRoot = root) {
  const dir = await mkdtemp(join(tmpdir(), 'fhir-mcp-mutation-'));
  // TMPDIR may be inside the ignored .local tree. Copy eligible top-level entries
  // separately: fs.cp rejects source -> descendant before consulting its filter.
  for (const name of await readdir(sourceRoot)) {
    if (['node_modules', '.git', 'dist', '.local', 'mutation-results'].includes(name)) continue;
    await cp(join(sourceRoot, name), join(dir, name), { recursive: true });
  }
  await symlink(join(sourceRoot, 'node_modules'), join(dir, 'node_modules'), 'dir');
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

export const INDEX_REPORTER = fileURLToPath(new URL('./mutation-test-index-reporter.mjs', import.meta.url));

/** With an index path, a second reporter writes the test-title index there; TAP stays on stdout. */
export function testSuiteArgs(files, concurrency, namePattern, indexPath = undefined) {
  const argv = ['--import', 'tsx', '--test', '--test-reporter=tap', `--test-concurrency=${concurrency}`];
  if (indexPath) argv.push('--test-reporter-destination=stdout', `--test-reporter=${INDEX_REPORTER}`, `--test-reporter-destination=${indexPath}`);
  if (namePattern) argv.push(`--test-name-pattern=${namePattern}`);
  return [...argv, ...files];
}

/** Run an explicit list of one suite's test files with the judge's TAP parsing. */
export async function runTestFiles(dir, files, { timeoutMs, namePattern = undefined, suite = 'unit', concurrency = TEST_CONCURRENCY, expectedPins = [], indexPath = undefined } = {}) {
  const result = await run(process.execPath, testSuiteArgs(files, concurrency, namePattern, indexPath), dir, timeoutMs, concurrency);
  const testsRun = Number(/^# tests (\d+)$/m.exec(result.out)?.[1] ?? NaN);
  const prefix = name => suite === 'isolation' ? `isolation:${name}` : name;
  return { ...result, suite, failed: failingTests(result.out).map(prefix), testsRun,
    pinFailures: preflightFailures(result.out, expectedPins).map(prefix) };
}

export async function runSuite(dir, timeoutMs, namePattern = undefined, suite = 'unit', baseline = false, concurrency = TEST_CONCURRENCY, expectedPins = [], indexPath = undefined) {
  const files = await testFiles(dir, suite, baseline);
  return runTestFiles(dir, files, { timeoutMs, namePattern, suite, concurrency, expectedPins, indexPath });
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One judging pass over an already-applied mutant. Returns {outcome:'passed'} or
 * {outcome:'failed', signature, timedOut} where the signature names what failed:
 * test names, or `evals:<era>` when the suite passed but an eval era failed.
 */
export async function attempt(dir, mutant, suiteRuns, caps = testTimeoutMs) {
  const expectedPins = await evalPinPreflight(dir, mutant, caps.unit);
  const preflight = expectedPins.length ? { preflight: expectedPins } : {};
  for (const suite of mutationSuites(mutant)) {
    const tests = await runSuite(dir, caps[suite], undefined, suite, false, TEST_CONCURRENCY, expectedPins);
    suiteRuns.push({ suite, focused: false, durationMs: tests.durationMs, testsRun: tests.testsRun, failed: tests.failed, timedOut: tests.timedOut,
      ...(tests.pinFailures.length ? { pinFailures: tests.pinFailures, ...preflight } : {}) });
    const signature = behaviouralFailures(tests.failed).filter(name => !tests.pinFailures.includes(name));
    const pinsOnly = !tests.timedOut && tests.failed.length > 0 && signature.length === 0;
    if (!tests.ok && !pinsOnly) return { outcome: 'failed', signature, timedOut: tests.timedOut, suite, ...preflight };
  }
  for (const suite of ['evals:modern', 'evals:legacy']) {
    const evalRun = await runEval(dir, suite, caps[suite], expectedPins);
    const signature = evalRun.ok || evalRun.timedOut || evalRun.nonBehavioural ? [] : [suite];
    suiteRuns.push({ suite, focused: false, durationMs: evalRun.durationMs, testsRun: null, failed: signature, timedOut: evalRun.timedOut,
      ...(evalRun.nonBehavioural ? preflight : {}) });
    if (!evalRun.ok) return { outcome: 'failed', signature, timedOut: evalRun.timedOut, suite };
  }
  return { outcome: 'passed', signature: [], timedOut: false, suite: 'evals:legacy' };
}

// Only mutations to these artifact inputs can explain a stale frozen qualification.
// Changes to the refusal logic itself must retain behavioural credit.
export const EVAL_PIN_INPUTS = {
  fixture: ['packages/evals/src/fixture.ts', 'packages/evals/fixtures/m3b-query/fragment.json'],
  backend: ['packages/evals/src/fixture.ts'],
  tasks: ['packages/evals/data/m3b-query-tasks.json'],
};

function validPin(row) {
  return row && row.schema === 'eval-profile-pin/1' && row.phase === 'profile-preflight'
    && row.profile === 'synthetic-fixture-r4-v1' && Object.hasOwn(EVAL_PIN_INPUTS, row.artifact)
    && /^[a-f0-9]{64}$/.test(row.recorded) && /^[a-f0-9]{64}$/.test(row.observed);
}

export async function evalPinPreflight(dir, mutant, timeoutMs) {
  const files = new Set(mutationEdits(mutant).map(edit => edit.file));
  const affected = Object.keys(EVAL_PIN_INPUTS).filter(artifact => EVAL_PIN_INPUTS[artifact].some(file => files.has(file)));
  if (!affected.length) return [];
  const measured = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
    "import { fixtureProfilePreflight } from './packages/evals/src/profile-preflight.ts'; process.stdout.write(JSON.stringify(fixtureProfilePreflight()));"], dir, timeoutMs);
  if (!measured.ok) throw new Error('eval pin preflight failed; no mutation credit can be assigned');
  const rows = JSON.parse(measured.out);
  if (!Array.isArray(rows) || rows.length !== 3 || !rows.every(validPin) || new Set(rows.map(row => row.artifact)).size !== 3)
    throw new Error('eval pin preflight was malformed; no mutation credit can be assigned');
  return rows.filter(row => affected.includes(row.artifact) && row.recorded !== row.observed);
}

export function expectedPinFailure(text, expectedPins) {
  let row;
  try { row = JSON.parse(text); } catch { return false; }
  if (!validPin(row) || row.recorded === row.observed) return false;
  return expectedPins.some(expected => ['schema', 'phase', 'profile', 'artifact', 'recorded', 'observed'].every(key => row[key] === expected[key]));
}

/** Only a typed, measured preflight exception is excluded, never its containing test. */
export function preflightFailures(tap, expectedPins) {
  const pinsByName = new Map();
  for (const match of String(tap).matchAll(/^not ok \d+ - (.+)\n([\s\S]*?)(?=^(?:not ok|ok|# Subtest:|1\.\.)|$(?![\s\S]))/gm)) {
    const diagnostic = match[2], name = match[1].trim();
    const message = /^  error: '(\{[^\r\n]+\})'$/m.exec(diagnostic)?.[1];
    const pin = /^  code: 'EVAL_PROFILE_PIN_DRIFT'$/m.test(diagnostic) && Boolean(message && expectedPinFailure(message, expectedPins));
    pinsByName.set(name, pinsByName.get(name) !== false && pin);
  }
  return [...pinsByName].filter(([, pin]) => pin).map(([name]) => name);
}

export async function runEval(dir, suite, timeoutMs, expectedPins = []) {
  if (!['evals:modern', 'evals:legacy'].includes(suite)) throw new Error(`invalid eval suite ${suite}`);
  const result = await run(process.execPath, ['--import', 'tsx', 'packages/evals/src/cli.ts', '--out', '/dev/null', ...(suite === 'evals:legacy' ? ['--era', 'legacy'] : [])], dir, timeoutMs);
  // Compare the structured refusal with the separate measurement of the affected artifact.
  const nonBehavioural = !result.ok && expectedPinFailure(result.out.trim(), expectedPins);
  return { ...result, nonBehavioural };
}

// These checks bind approved file bytes, not a mutant's behaviour. They still run in
// baselines and mutant suites, but a predictable pin mismatch cannot stop behavioural
// judging or earn a kill. Keep exact names: unrelated assertions must never be filtered.
export const NON_BEHAVIORAL_TESTS = new Set([
  'pin-only: quickstart approved helper manifest bytes',
  'pin-only: S6 approved fixture backend and task digests',
  'pin-only: package approved serving dispatch bytes',
  'pin-only: package approved HTTP dispatch sites',
  'pin-only: G-BACKEND approved corpus and profile evidence',
  'pin-only: package shipped documents and license inventory',
  'pin-only: package approved dist bytes',
  'pin-only: quickstart approved terminology script and seed digests',
  'pin-only: S57 approved profile task content hashes',
]);
const behaviouralFailures = names => names.filter(name => !NON_BEHAVIORAL_TESTS.has(name));

export function reproducedKill(first, second) {
  const sameSuite = ['unit', 'isolation', 'evals:modern', 'evals:legacy'].includes(first.suite) && first.suite === second.suite;
  const reproduced = sameSuite ? behaviouralFailures(first.signature).filter(name => second.signature.includes(name) && !name.endsWith('.test.ts')) : [];
  const timedOut = sameSuite && first.timedOut && second.timedOut;
  return { killed: second.outcome === 'failed' && (reproduced.length > 0 || timedOut), reproduced,
    reproducedTimeout: timedOut, kill_kind: reproduced.length ? 'named' : timedOut ? 'timeout' : null };
}

/** The actual focused judging pass; runner injection keeps cap tests deterministic. */
export async function focusedAttempt(dir, first, suiteRuns, caps = testTimeoutMs, runFocused = runSuite) {
  const pattern = `^(?:${first.signature.map(name => escapeRegExp(first.suite === 'isolation' ? name.slice('isolation:'.length) : name)).join('|')})$`;
  const rerun = await runFocused(dir, caps[first.suite], pattern, first.suite, false, TEST_CONCURRENCY, first.preflight ?? []);
  suiteRuns.push({ suite: first.suite, focused: true, durationMs: rerun.durationMs, testsRun: rerun.testsRun, failed: rerun.failed, timedOut: rerun.timedOut });
  return rerun.testsRun === 0
    ? { outcome: 'failed', signature: [], timedOut: false, unmatched: true, suite: first.suite }
    : { outcome: rerun.ok ? 'passed' : 'failed', signature: behaviouralFailures(rerun.failed).filter(name => !(rerun.pinFailures ?? []).includes(name)), timedOut: rerun.timedOut, suite: first.suite };
}

/**
 * A targeted run's cap: six times the expected time of its files, at least 60 s and
 * never above the suite's own cap. A targeted timeout is never credited, so the cap
 * only bounds how long a hanging candidate delays the full path.
 */
export function targetedCap(files, estimate, suiteCap, concurrency) {
  const costs = files.map(file => Math.max(0, Number(estimate(file)) || 0));
  const parallel = Math.max(1, Math.min(files.length, concurrency));
  const expected = Math.max(0, ...costs, costs.reduce((sum, cost) => sum + cost, 0) / parallel);
  return Math.min(suiteCap, Math.max(60_000, Math.ceil(6 * expected)));
}

const targetedRun = (tier, suite, files, focused, run) => ({ suite, focused, targeted: true, tier, files, durationMs: run.durationMs,
  testsRun: Number.isFinite(run.testsRun) ? run.testsRun : null, failed: run.failed ?? [], timedOut: run.timedOut === true,
  ...(run.pinFailures?.length ? { pinFailures: run.pinFailures } : {}) });

/**
 * The targeted first pass over a plan from scripts/mutation-targeting.mjs, tier by tier.
 * It returns {killed: true} only when a named behavioural failure reproduces: the same
 * candidate files (focused on the failing names) or the same eval era run again and at
 * least one of the same tests or that era fails again. A timeout, a file-level failure,
 * a pin-only failure, a rerun that selects no test, or a pass returns {killed: false},
 * and the caller then judges the mutant on the full path. This pass never yields a
 * survivor or an inconclusive result.
 */
export async function targetedAttempt(dir, plan, suiteRuns, { caps = testTimeoutMs, expectedPins = [], estimate = () => 0, declaringFiles = undefined, concurrency = TEST_CONCURRENCY, runFiles = runTestFiles, runEra = runEval } = {}) {
  for (const tier of plan?.tiers ?? []) {
    for (const suite of ['unit', 'isolation']) {
      const files = tier[suite] ?? [];
      if (!files.length) continue;
      const parallel = Math.max(1, Math.min(files.length, concurrency));
      const timeoutMs = targetedCap(files, file => estimate(suite, file), caps[suite], parallel);
      const first = await runFiles(dir, files, { timeoutMs, suite, concurrency: parallel, expectedPins });
      suiteRuns.push(targetedRun(tier.label, suite, files, false, first));
      if (first.ok || first.timedOut) continue;
      const signature = behaviouralFailures(first.failed).filter(name => !(first.pinFailures ?? []).includes(name) && !name.endsWith('.test.ts'));
      if (!signature.length) continue;
      const bare = name => tapUnescape(suite === 'isolation' ? name.slice('isolation:'.length) : name);
      const namePattern = signature.length <= 20 ? `^(?:${signature.map(name => escapeRegExp(bare(name))).join('|')})$` : undefined;
      // Rerun only the candidate files that declare the failing tests, when the index knows them all.
      const declared = declaringFiles?.(suite, signature, files);
      const rerunFiles = declared?.length ? declared : files;
      const rerun = await runFiles(dir, rerunFiles, { timeoutMs, namePattern, suite, concurrency: Math.max(1, Math.min(rerunFiles.length, concurrency)), expectedPins });
      suiteRuns.push(targetedRun(tier.label, suite, rerunFiles, Boolean(namePattern), rerun));
      if (rerun.testsRun === 0) continue;
      const second = { outcome: rerun.ok ? 'passed' : 'failed', signature: behaviouralFailures(rerun.failed).filter(name => !(rerun.pinFailures ?? []).includes(name)), timedOut: rerun.timedOut, suite };
      const decision = reproducedKill({ outcome: 'failed', signature, timedOut: false, suite }, second);
      if (decision.killed && decision.kill_kind === 'named') return { killed: true, reproduced: decision.reproduced, suite, tier: tier.label };
    }
    for (const era of tier.evals ?? []) {
      const eraSignature = result => result.ok || result.timedOut || result.nonBehavioural ? [] : [era];
      const first = await runEra(dir, era, caps[era], expectedPins);
      suiteRuns.push(targetedRun(tier.label, era, [], false, { ...first, testsRun: null, failed: eraSignature(first) }));
      if (!eraSignature(first).length) continue;
      const again = await runEra(dir, era, caps[era], expectedPins);
      suiteRuns.push(targetedRun(tier.label, era, [], false, { ...again, testsRun: null, failed: eraSignature(again) }));
      const second = { outcome: again.ok ? 'passed' : 'failed', signature: eraSignature(again), timedOut: again.timedOut, suite: era };
      const decision = reproducedKill({ outcome: 'failed', signature: [era], timedOut: false, suite: era }, second);
      if (decision.killed && decision.kill_kind === 'named') return { killed: true, reproduced: decision.reproduced, suite: era, tier: tier.label };
    }
  }
  return { killed: false };
}

/**
 * Judge one mutant. With a targeting planner the targeted first pass runs after the
 * compilation checks; a mutant it does not kill continues on the full path unchanged.
 */
export async function judge(dir, mutant, pristine, targeting = undefined) {
  const started = Date.now(), suiteRuns = [], compilation = {};
  const { changed, failures } = applyMutationEdits(mutant, pristine);
  if (failures.length) return { id: mutant.id, status: 'anchor-error', decidedBy: 'precheck', anchorMatches: failures[0].count, failingTests: [], detail: failures.map(f => `${f.file}: count=${f.count} ${f.reason}`).join('; ') };
  const preparation = mutationPreparation(mutant);
  const verdict = result => ({ id: mutant.id, anchorMatches: 1, suiteRuns, compilation, durationMs: Date.now() - started, decidedBy: 'full', ...result });
  try {
    for (const [file, content] of changed) await writeFile(join(dir, file), content);
    if (preparation) {
      const prepared = await run(process.execPath, preparation.argv, dir, BASELINE_TIMEOUT_MS);
      if (!prepared.ok) return verdict({ status: 'inconclusive', decidedBy: 'precheck', failingTests: [], detail: 'copied-contract preparation failed; no credited kill' });
    }
    // A compile/import failure is not a discriminating assertion kill.
    for (const [name, argv] of [['typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']], ['build', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']]]) {
      const check = await run(process.execPath, argv, dir, BASELINE_TIMEOUT_MS);
      compilation[name] = check.ok;
      if (!check.ok) return verdict({ status: 'inconclusive', decidedBy: 'precheck', failingTests: [], detail: `mutant ${name} failed; compilation failures cannot earn a kill: ${check.out.slice(-800)}` });
    }
    const plan = targeting?.plan(mutant);
    if (plan?.tiers.length) {
      const expectedPins = await evalPinPreflight(dir, mutant, testTimeoutMs.unit);
      const targeted = await targetedAttempt(dir, plan, suiteRuns, { expectedPins, estimate: targeting.estimate, declaringFiles: targeting.declaringFiles });
      if (targeted.killed) {
        return verdict({ status: 'killed', decidedBy: 'targeted', reproducedTimeout: false, kill_kind: 'named', failingTests: targeted.reproduced,
          detail: `targeted pass (${targeted.tier}) reproduced failure: ${targeted.reproduced.join('; ')}` });
      }
    }
    // The full path: every mutant the targeted pass did not kill is judged exactly as without it.
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
  const valued = new Set(['--workers', '--test-concurrency', '--only', '--shard', '--report', '--out', '--aggregate', '--shards', '--hints']);
  const flags = new Set(['--list', '--no-targeted']);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key) || (!flags.has(key) && !valued.has(key))) throw new Error(`unknown or repeated option ${key}`);
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
  if (seen.has('--aggregate') && ['--hints', '--no-targeted'].some(key => seen.has(key))) throw new Error('--hints and --no-targeted apply to judging runs, not --aggregate');
  if (seen.has('--hints') && seen.has('--no-targeted')) throw new Error('--hints needs the targeted pass; drop --no-targeted');
}

/**
 * Build the targeted-pass planner from the clean baselines' test-title index, the
 * registry comments, the test sources and optional hint reports. Hints are only
 * hints: an unreadable hint directory or report is reported and skipped.
 */
export async function prepareTargeting({ copy, indexPaths, suites, hintsDir, mutants = MUTANTS, registrySource, log = console.log }) {
  const copyPaths = [copy, await realpath(copy)];
  const relativeFile = file => {
    for (const base of copyPaths) {
      const rel = relative(base, file);
      if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel.split(sep).join('/');
    }
    return undefined;
  };
  const suiteFiles = {}, entries = {}, sources = new Map();
  for (const suite of suites) {
    suiteFiles[suite] = await testFiles(copy, suite);
    entries[suite] = parseIndexLines(await readFile(indexPaths[suite], 'utf8').catch(() => ''), relativeFile);
    for (const file of suiteFiles[suite]) sources.set(`${suite}:${file}`, await readFile(join(copy, file), 'utf8'));
  }
  const index = buildTestIndex(entries, suiteFiles);
  const read = hintsDir === undefined ? { hints: new Map(), files: [], errors: [] } : await readHintReports(hintsDir);
  for (const error of read.errors) log(`mutation-guards: hint skipped: ${error}`);
  const targeting = createTargeting({ index, comments: registryComments(registrySource), hints: read.hints, sources, edits: mutationEdits, declaredSuites: mutationSuites });
  const byId = new Map(mutants.map(mutant => [mutant.id, mutant]));
  for (const [id, failing] of read.hints) if (byId.has(id)) targeting.learn(byId.get(id), { status: 'killed', failingTests: failing });
  return { targeting, summary: { enabled: true, indexedNames: index.names.length, hintReports: read.files.length, hintMutants: read.hints.size } };
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
    const { targeted, full, precheck } = aggregated.decisions;
    console.log(timeoutKillSummary(aggregated.timeoutKills));
    console.log(`mutation-guards aggregate decided by: targeted pass ${targeted}, full path ${full}, checks before tests ${precheck}`);
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
  let targetingSummary = { enabled: TARGETED };
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
      targeting: targetingSummary,
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

  cpuSlots = createSlots(CPUS);
  const copies = [];
  const results = new Map();
  const usedSuites = [...new Set(mutants.flatMap(mutationSuites))];
  // The test-title index lives outside every copy, so no suite can observe it.
  const indexDir = TARGETED ? await mkdtemp(join(tmpdir(), 'fhir-mcp-mutation-index-')) : undefined;
  const indexPaths = indexDir ? Object.fromEntries(usedSuites.map(suite => [suite, join(indexDir, `${suite}.jsonl`)])) : {};
  try {
    for (let i = 0; i < Math.max(1, Math.min(WORKERS, mutants.length)); i++) copies.push(await makeCopy());
    // Baselines are serial, include anchor maintenance, and cover every path attempt() can use.
    try {
      suiteBaselines = await measureSuiteBaselines([...usedSuites, 'evals:modern', 'evals:legacy'],
        (suite, cap) => suite.startsWith('evals:') ? runEval(copies[0], suite, cap) : runSuite(copies[0], cap, undefined, suite, true, TEST_CONCURRENCY, [], indexPaths[suite]));
    } catch (error) {
      await writeReport('red', []);
      throw error;
    }
    for (const [suite, timing] of Object.entries(suiteBaselines)) testTimeoutMs[suite] = timing.capMs;
    let targeting;
    if (TARGETED) {
      const prepared = await prepareTargeting({ copy: copies[0], indexPaths, suites: usedSuites, hintsDir: argValue('--hints'),
        registrySource: await readFile(fileURLToPath(import.meta.url), 'utf8') });
      targetingSummary = prepared.summary;
      if (prepared.summary.indexedNames > 0) targeting = prepared.targeting;
      else { targetingSummary = { ...prepared.summary, enabled: false }; console.log('mutation-guards: the unit baseline produced no test-title index; every mutant is judged on the full path'); }
      console.log(`mutation-guards: targeted pass ${targeting ? 'on' : 'off'} (${prepared.summary.indexedNames} indexed test names, ${prepared.summary.hintMutants} hinted mutants from ${prepared.summary.hintReports} reports)`);
    }
    console.log(`mutation-guards: judging ${mutants.length} mutants on ${copies.length} worker copies (test-concurrency ${TEST_CONCURRENCY}/suite, at most ${CPUS} test files at once on ${CPUS} CPUs)`);
    let nextIndex = 0;
    await Promise.all(copies.map(async dir => {
      for (;;) {
        const index = nextIndex++;
        if (index >= mutants.length) return;
        const result = await judge(dir, mutants[index], pristine, targeting);
        results.set(result.id, result);
        targeting?.learn(mutants[index], result);
        console.log(`  ${result.status.padEnd(12)} ${result.id} [${result.decidedBy}] (${result.detail})`);
      }
    }));
  } finally {
    await Promise.all(copies.map(dir => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
    if (indexDir) await rm(indexDir, { recursive: true, force: true }).catch(() => undefined);
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
  const decidedBy = decider => [...results.values()].filter(result => result.decidedBy === decider).length;
  console.log(`mutation-guards: decided by: targeted pass ${decidedBy('targeted')}, full path ${decidedBy('full')}, checks before tests ${decidedBy('precheck')}`);
  console.log(`mutation-guards: ${killed} killed, ${survived} survived, ${inconclusive} inconclusive (declared survivors: ${declared.size}), ${((Date.now() - started) / 1000).toFixed(0)}s`);
  if (failed) process.exit(1);
  console.log('mutation-guards: OK (no undeclared survivors)');
}

if (isMainModule(import.meta.url)) {
  main().catch(error => { console.error(`mutation-guards: ${error instanceof Error ? error.message : 'failed'}`); process.exit(2); });
}
