import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { byteAccounting, byteAccountingFails, runEvals, type RunEvalsOptions, type TaskArmResult } from '../../packages/evals/src/runner.js';
import { EVAL_SOURCE_ALIAS, type GoldenResource } from '../../packages/evals/src/fixture.js';
import { evaluateStepCheck, resolvePath, type OracleCall } from '../../packages/evals/src/evidence-oracle.js';
import type { ArmName, Check } from '../../packages/evals/src/check-contracts.js';
import type { ProtocolEra } from '../../packages/evals/src/tasks.js';
import type { GatewayEnvelope } from '../../packages/core/src/index.js';
import { SERVER_IDENTITY } from '../../packages/core/src/identity.js';
import { makePlans, CRITICAL_ROOTS, numericTokens, type TaskPlan } from './tasks.js';
import { STUDY, envelopeBytes, hash, rawJsonMember, rec, requireS11, resourceRootBytes, type Rec, type Split, type Stratum, type EnvelopeBytes } from './study.js';

export type CapturedCall = Parameters<NonNullable<RunEvalsOptions['naturalMeasurement']>['capture']>[0];
export interface FileSpec { path: string; bytes: number; sha256: string }
export interface Attempt {
  id: string; patient: string; split: Split; stratum: Stratum; template: string; era: ProtocolEra; arm: ArmName;
  delivery: 'full-text-v1'; status: 'pass' | 'fail' | 'unsupported'; reason?: string;
  fidelity: { checked: number; failed: number }; eval?: TaskArmResult;
  wire_result_bytes: number; frame_bytes: number; model_bytes: number;
  envelope: EnvelopeBytes;
  resource_root_bytes: Record<string, number>;
  negotiated_protocol?: string | null;
  eval_identity?: { schema: string; package_version: string; envelope_schema: string; backend_sha256: string } | null;
  segments: { kind: 'catalog' | 'request' | 'model' | 'wire'; file: FileSpec }[];
}
export function fullTextInput(raw: string): { messages: string[]; envelope: GatewayEnvelope; oracleRaw: string } {
  const result = rec(JSON.parse(raw));
  requireS11(Array.isArray(result?.content) && result.content.length > 0 && result.content.every(c => rec(c)?.type === 'text' && typeof rec(c)?.text === 'string'), 'FULL_TEXT_CAPTURE_MISSING');
  // This scripted evaluation host delivers one tool message, joining text blocks with the frozen LF separator.
  // It never exposes structuredContent to its model-input boundary.
  const text = result.content.map(c => String(rec(c)!.text)).join('\n');
  const e = rec(JSON.parse(text)); requireS11(e && typeof e.schema_version === 'string' && rec(e.data), 'FULL_TEXT_ENVELOPE_MISSING');
  return { messages: [text], envelope: e as unknown as GatewayEnvelope, oracleRaw: `{"structuredContent":${text}}` };
}

/** One boundary's view of every captured call, in call order: the wire structuredContent or the host's captured text. */
function boundaryCalls(calls: readonly CapturedCall[], boundary: 'wire' | 'model'): OracleCall[] {
  return calls.map(call => {
    try {
      requireS11(call.rawResult, 'WIRE_CAPTURE_MISSING');
      const host = boundary === 'model' ? fullTextInput(call.rawResult) : undefined;
      const envelope = host?.envelope ?? rec(JSON.parse(call.rawResult))?.structuredContent as GatewayEnvelope | undefined;
      return { step: call.step, envelope, rawText: host?.oracleRaw ?? call.rawResult };
    } catch { return { step: call.step }; }
  });
}

/**
 * Evaluate source-derived expectations against one occurrence of one response on BOTH wire and captured text. Each
 * fact is judged within its step's complete call chain (so a shorthand continuation page resolves its query identity
 * from the earlier pages of the same chain), with an explicit response_index selecting the one response that holds it.
 */
export function fidelity(plan: TaskPlan, arm: ArmName, calls: readonly CapturedCall[], rawBodies: Readonly<Record<string, string>>) {
  let checked = 0, failed = 0;
  const views = { wire: boundaryCalls(calls, 'wire'), model: boundaryCalls(calls, 'model') };
  const context = { stepCount: plan.task.steps.length, requests: [] as string[] };
  const judge = (expected: Rec, step: number, recovery = false): void => {
    const raw = rawBodies[`${expected.resourceType}/${expected.id}`]; requireS11(raw, 'EXPECTED_RAW_MISSING');
    const roots = [...CRITICAL_ROOTS, ...Object.keys(expected).filter(k => /^(effective|value|_)/.test(k)),
      ...(expected.resourceType === 'DiagnosticReport' ? ['result', 'conclusion', 'conclusionCode', 'presentedForm'] : []),
      ...(recovery ? ['encounter', 'note'] : [])];
    const fields = [...new Set(roots)];
    const own = calls.filter(c => c.step === step);
    const matches = own.filter(c => c.rawResult && (rec(rec(JSON.parse(c.rawResult))?.structuredContent)?.data as Rec | undefined)?.resources instanceof Array
      && ((rec(rec(JSON.parse(c.rawResult))?.structuredContent)?.data as Rec).resources as Rec[]).some(r => r.resourceType === expected.resourceType && r.id === expected.id));
    checked++; if (matches.length !== 1) { failed++; return; }
    const call = matches[0]!, responseIndex = own.indexOf(call);
    try { fullTextInput(call.rawResult!); } catch { failed++; return; }
    const source = String(expected.resourceType), id = String(expected.id), version = rec(expected.meta)?.versionId;
    const run = (path: string, extra: Partial<Extract<Check, { kind: 'citedFact' }>>) => {
      const check: Check = { kind: 'citedFact', id: 's11-critical', step, response_index: responseIndex, resource_type: source, id_value: id, source: EVAL_SOURCE_ALIAS,
        version: typeof version === 'string' ? version : null, path, ...extra };
      for (const boundary of [views.wire, views.model]) {
        checked++; if (evaluateStepCheck(check, arm, boundary, context).status !== 'pass') failed++;
      }
    };
    for (const path of fields) { const value = resolvePath(expected, path); run(path, value === undefined ? { absent: true } : { equals: value }); }
    for (const token of numericTokens(raw)) if (fields.some(root => token.path === root || token.path.startsWith(`${root}.`))) run(token.path, { lexeme: token.lexeme });
  };
  for (const expected of plan.expected) judge(expected, plan.evidenceStep);
  if (plan.recovery) {
    judge(plan.recovery.expected, plan.recovery.step, true);
    if (plan.recovery.expected.resourceType === 'DiagnosticReport') {
      for (const [index, ref] of (plan.recovery.expected.result as Rec[]).entries()) {
        const member = rawBodies[String(ref.reference)];
        checked++; if (!member) { failed++; continue; }
        judge(JSON.parse(member) as Rec, 5 + index);
      }
    }
  }
  // The host boundary is complete, not a sample: every call's delivered text must BE its raw structuredContent member
  // (numeric spellings as sent), and the plan's complete-membership check is judged again on the captured text.
  for (const call of calls) {
    let structured: string | undefined;
    try { structured = call.rawResult === undefined ? undefined : rawJsonMember(call.rawResult, 'structuredContent'); } catch { structured = undefined; }
    if (structured === undefined) continue;
    checked++;
    try { if (fullTextInput(call.rawResult!).messages[0] !== structured) failed++; } catch { failed++; }
  }
  for (const boundary of ['wire', 'model'] as const) {
    const oracleCalls = views[boundary];
    for (const check of plan.task.checks) {
      checked++;
      if (evaluateStepCheck(check, arm, oracleCalls, context).status !== 'pass') failed++;
    }
    for (const check of plan.retainedChecks ?? []) {
      checked++;
      if (evaluateStepCheck(check, arm, oracleCalls, context).status !== 'pass') failed++;
    }
  }
  return { checked, failed };
}

type EvalRunner = typeof runEvals;
export async function measureChart(input: { ndjson: string; patient: string; label: string; split: Split; stratum: Stratum; out: string; codeRevision: string }, runner: EvalRunner = runEvals): Promise<Attempt[]> {
  const lines = input.ndjson.trimEnd().split('\n'), resources = lines.map(line => JSON.parse(line) as GoldenResource);
  const rawBodies = Object.fromEntries(resources.map((r, i) => [`${r.resourceType}/${r.id}`, lines[i]!]));
  requireS11(input.patient.startsWith('Patient/'), 'PATIENT_INVALID');
  const plans = makePlans(input.ndjson, input.label), attempts: Attempt[] = [];
  await mkdir(input.out, { mode: 0o700 });
  for (const era of STUDY.eras) {
    for (const plan of plans) {
      const captures: CapturedCall[] = [], catalogs = new Map<string, string>();
      // All formats use the same steps, inputs, byte ceilings, work budgets, source patient and corpus bytes.
      const report = plan.unsupported ? undefined : await runner({ tasks: [plan.task], resources, arms: [...STUDY.arms], era,
        deliveryProfile: STUDY.delivery, stratum: input.stratum, codeRevision: input.codeRevision,
        packageVersion: SERVER_IDENTITY.version,
        configuredMaxBytes: STUDY.operatingPoint.configuredMaxBytes, configuredDefaultBytes: STUDY.operatingPoint.perCallBytes,
        naturalMeasurement: { patientId: input.patient.slice(8), rawBodies, capture: c => { captures.push(c); }, catalog: c => { catalogs.set(c.arm, c.text); } } });
      for (const arm of STUDY.arms) {
        const id = `${input.label}-${plan.template}-${era}-${arm}`, calls = captures.filter(c => c.arm === arm);
        const result = report?.results.find(r => r.arm === arm), facts = plan.unsupported ? { checked: 0, failed: 0 } : fidelity(plan, arm, calls, rawBodies);
        const attempt: Attempt = { id, patient: input.label, split: input.split, stratum: input.stratum, template: plan.template, era, arm, delivery: STUDY.delivery,
          status: plan.unsupported ? 'unsupported' : result?.status === 'pass' && facts.checked > 0 && facts.failed === 0 ? 'pass' : 'fail',
          ...(plan.unsupported ? { reason: plan.unsupported } : {}), fidelity: facts, ...(result ? { eval: result } : {}),
          negotiated_protocol: report?.protocol?.negotiated_version ?? null,
          eval_identity: report?.measurement ? { schema: report.schema_version, package_version: report.package_version,
            envelope_schema: report.gateway_envelope_schema_version, backend_sha256: report.measurement.backend_sha256 } : null,
          wire_result_bytes: calls.reduce((n, c) => n + c.wireResultBytes, 0), frame_bytes: calls.reduce((n, c) => n + c.wireFrameBytes, 0), model_bytes: 0,
          envelope: { structured: 0, provenance: 0, withheld: 0, coverage: 0, resources: 0, remaining: 0 }, resource_root_bytes: {}, segments: [] };
        const save = async (kind: Attempt['segments'][number]['kind'], text: string) => {
          const path = `${id}-${String(attempt.segments.length).padStart(4, '0')}-${kind}.txt`;
          await writeFile(join(input.out, path), text, { mode: 0o600, flag: 'wx' });
          attempt.segments.push({ kind, file: { path, bytes: Buffer.byteLength(text), sha256: hash(text) } });
        };
        const catalog = catalogs.get(arm);
        if (catalog) await save('catalog', catalog);
        else if (!plan.unsupported) { attempt.status = 'fail'; attempt.reason = 'CATALOG_MISSING'; }
        for (const call of calls) {
          await save('request', call.request);
          if (!call.rawResult) { attempt.status = 'fail'; attempt.reason = 'WIRE_CAPTURE_MISSING'; continue; }
          requireS11(Buffer.byteLength(call.rawResult) === call.wireResultBytes, 'WIRE_ACCOUNTING_MISMATCH');
          await save('wire', call.rawResult);
          const bytes = envelopeBytes(call.rawResult);
          for (const key of Object.keys(bytes) as (keyof EnvelopeBytes)[]) attempt.envelope[key] += bytes[key];
          for (const [root, size] of Object.entries(resourceRootBytes(call.rawResult))) attempt.resource_root_bytes[root] = (attempt.resource_root_bytes[root] ?? 0) + size;
          try {
            const visible = fullTextInput(call.rawResult);
            for (const message of visible.messages) { attempt.model_bytes += Buffer.byteLength(message); await save('model', message); }
          } catch { attempt.status = 'fail'; attempt.reason = 'MODEL_CAPTURE_MISSING'; }
        }
        // Eval accounting remains authoritative; this independent boundary must cover EVERY call, including failures.
        if (result && (result.metrics.tool_calls !== calls.length || result.metrics.result_bytes !== attempt.wire_result_bytes || result.metrics.frame_bytes !== attempt.frame_bytes)) {
          attempt.status = 'fail'; attempt.reason = 'EVAL_ACCOUNTING_MISMATCH';
        }
        // The eval CLI's exact byte-accounting gate, per attempt: a call whose gateway-reported bytes differ from its
        // measured wire result fails the attempt even when its task status, facts and captured sizes are correct.
        if (result && byteAccountingFails(byteAccounting(result.calls ?? []))) { attempt.status = 'fail'; attempt.reason = 'GATEWAY_ACCOUNTING_MISMATCH'; }
        attempts.push(attempt);
      }
    }
  }
  await writeFile(join(input.out, 'attempts.json'), `${JSON.stringify({ schema: 'fireboat-s11-capture/1', host: 'scripted full-text evaluation host; not a verified real-host or structured-delivery cell', attempts }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return attempts;
}
