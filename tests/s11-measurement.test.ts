import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolSchemas02 } from '../packages/core/src/contracts.js';
import { fidelity, fullTextInput, measureChart, type CapturedCall } from '../scripts/s11/measure.js';
import { runEvals, type TaskArmResult } from '../packages/evals/src/runner.js';
import type { GoldenResource } from '../packages/evals/src/fixture.js';
import { M3B_TASKS_SCHEMA_VERSION, parseM3bTaskFile } from '../packages/evals/src/tasks.js';
import { makePlans, numericTokens } from '../scripts/s11/tasks.js';
import { envelopeBytes, rawArrayValues, rawJsonMember, resourceRootBytes } from '../scripts/s11/study.js';
import { developmentChart, observationRaw, wireCall, patient } from './s11-fixtures.js';

const chart = () => `{"resourceType":"Patient","id":"${patient}"}\n${observationRaw()}\n`;
test('S11 frozen templates retain unsupported outcomes and use valid public tool inputs with identical recovery plans', () => {
  const plans = makePlans(chart(), 'development-small-1');
  assert.deepEqual(plans.map(p => p.template), ['lab-trend', 'recent-hba1c', 'panel-recovery']);
  assert.equal(plans[2]!.unsupported, 'NO_NATURAL_PANEL');
  const hba = plans[1]!.task.steps[2]!;
  assert.ok((hba.input.params as { name: string; value: string }[]).some(p => p.name === '_sort' && p.value === '-date'));
  for (const plan of plans) for (const step of plan.task.steps) {
    const input: Record<string, unknown> = { ...step.input, output: { format: 'fhir', fields: plan.task.fields, max_bytes: 24576 } };
    // Opaque placeholders are syntactically valid handles before resolution.
    if (input.handle) input.handle = 'res_' + 'A'.repeat(24);
    assert.equal(toolSchemas02[step.tool].safeParse(input).success, true, `${plan.template}/${step.tool}`);
  }
  assert.equal(parseM3bTaskFile(JSON.stringify({ schema_version: M3B_TASKS_SCHEMA_VERSION, tasks: plans.filter(p => !p.unsupported).map(p => p.task) })).length, 2);
  const absent = makePlans(chart().replace('4548-4', 'other-loinc'), 'development-small-1');
  assert.equal(absent[1]!.unsupported, 'NO_NATURAL_HBA1C');
  const panelRaw = observationRaw().slice(0, -1) + ',"component":[{"code":{"text":"part"},"valueQuantity":{"value":1.00}}],"note":[{"text":"source note"}]}';
  const panel = makePlans(chart().split('\n')[0] + '\n' + panelRaw + '\n', 'test')[2]!;
  assert.equal(panel.unsupported, undefined); assert.equal(panel.recovery?.step, 4);
  assert.equal(panel.task.steps[3]!.input.handle, '{{handle:2}}');
  assert.equal(panel.task.steps[4]!.input.action, 'project');
  assert.ok((panel.task.steps[4]!.input.fields as string[]).includes('note'));
  assert.equal(parseM3bTaskFile(JSON.stringify({ schema_version: M3B_TASKS_SCHEMA_VERSION, tasks: [panel.task] })).length, 1);
});
test('S11 lexical and C.3 accounting preserve UTF-8 and original numeric spellings, with disjoint serialized value boundaries', () => {
  const raw = wireCall().rawResult!, e = rawJsonMember(raw, 'structuredContent')!;
  const bytes = envelopeBytes(raw);
  assert.equal(bytes.structured, Buffer.byteLength(e));
  assert.equal(bytes.provenance, Buffer.byteLength(rawJsonMember(e, 'provenance')!));
  assert.equal(bytes.withheld, 2); assert.ok(bytes.coverage > 0 && bytes.remaining > 0);
  assert.equal(bytes.remaining, bytes.structured - bytes.resources - bytes.provenance - bytes.withheld - bytes.coverage);
  assert.equal(envelopeBytes('{"structuredContent":{"data":{}}}').withheld, 0);
  assert.equal(envelopeBytes('{"content":[]}').structured, 0);
  assert.equal(resourceRootBytes(raw)['Observation.valueQuantity'], Buffer.byteLength('{"value":7.0,"comparator":"<","unit":"%","system":"http://unitsofmeasure.org","code":"%"}'));
  assert.deepEqual(numericTokens('{"value":7.0,"component":[{"v":120.00}],"x":1e2,"n":-0.0}'), [
    { path: 'value', lexeme: '7.0' }, { path: 'component.0.v', lexeme: '120.00' }, { path: 'x', lexeme: '1e2' }, { path: 'n', lexeme: '-0.0' }]);
  assert.equal(rawJsonMember('{"a":"brace } and \\\"","b":{"ñ":7.0}}', 'b'), '{"ñ":7.0}');
  assert.deepEqual(rawArrayValues('[{"x":"],\\\"","v":7.0},[1e2],"ñ"]'), ['{"x":"],\\\"","v":7.0}', '[1e2]', '"ñ"']);
});
test('S11 fidelity binds every clinical value and raw numeric token to its own cited wire AND captured text occurrence', () => {
  const plan = makePlans(chart(), 'test')[0]!, raw = observationRaw(), body = JSON.parse(raw);
  const source = { [`Observation/${body.id}`]: raw };
  const good = fidelity(plan, 'fhir', [wireCall()], source);
  assert.equal(good.failed, 0); assert.ok(good.checked > 40);
  const rounded = raw.replace('"value":7.0', '"value":7');
  assert.ok(fidelity(plan, 'compact', [wireCall(rounded)], source).failed > 0);
  assert.ok(fidelity(plan, 'compact', [wireCall(raw, 2, rounded)], source).failed > 0);
  const missing = raw.replace(',"text":"HbA1c full text"', '');
  assert.ok(fidelity(plan, 'compact', [wireCall(missing)], source).failed > 0);
  assert.ok(fidelity(plan, 'compact', [wireCall(raw, 1)], source).failed > 0);
  assert.ok(fidelity(plan, 'compact', [wireCall(raw), wireCall(raw)], source).failed > 0);
  const noCitation = wireCall(); noCitation.rawResult = noCitation.rawResult!.replaceAll('"resource_index":0', '"resource_index":1');
  assert.ok(fidelity(plan, 'compact', [noCitation], source).failed > 0);
  const hostless = wireCall(); hostless.rawResult = '{"structuredContent":{}}';
  assert.throws(() => fullTextInput(hostless.rawResult!), /FULL_TEXT_CAPTURE_MISSING/);
});
test('S11 harness preserves unsupported attempts and independently charges every captured success/error to existing eval accounting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 's11-pure-harness-'));
  let invocations = 0;
  const fake: typeof runEvals = async options => {
    invocations++;
    assert.equal(options!.resources!.length, 2); assert.equal(options!.naturalMeasurement!.patientId, patient);
    const task = options!.tasks![0]!;
    const results = (options!.arms ?? []).map(arm => {
      const call = { ...wireCall(), era: options!.era!, task: task.id, arm };
      const error = { ...call, step: 0, rawResult: '{"content":[{"type":"text","text":"SDK error"}],"isError":true}', wireResultBytes: 0, wireFrameBytes: 91 };
      error.wireResultBytes = Buffer.byteLength(error.rawResult);
      options!.naturalMeasurement!.catalog({ task: task.id, arm, era: options!.era!, text: '{"tools":[]}' });
      options!.naturalMeasurement!.capture(error); options!.naturalMeasurement!.capture(call);
      return { task_id: task.id, arm, status: 'fail', metrics: { tool_calls: 2, upstream_calls: 1, result_bytes: call.wireResultBytes + error.wireResultBytes,
        frame_bytes: call.wireFrameBytes + error.wireFrameBytes }, failures: [], checks: [] } as unknown as TaskArmResult;
    });
    return { results } as Awaited<ReturnType<typeof runEvals>>;
  };
  try {
    const attempts = await measureChart({ ndjson: chart(), patient: `Patient/${patient}`, label: 'development-small-1', split: 'development', stratum: 'small', out: join(directory, 'capture'), codeRevision: 'frozen' }, fake);
    assert.equal(invocations, 4); assert.equal(attempts.length, 18);
    assert.equal(attempts.filter(a => a.status === 'unsupported').length, 6);
    assert.equal(attempts.filter(a => a.status === 'fail').length, 12);
    const charged = attempts.find(a => a.status === 'fail')!;
    assert.equal(charged.segments.filter(s => s.kind === 'wire').length, 2);
    assert.equal(charged.segments.filter(s => s.kind === 'request').length, 2);
    assert.ok(charged.wire_result_bytes > wireCall().wireResultBytes);
    const saved = JSON.parse(await readFile(join(directory, 'capture', 'attempts.json'), 'utf8'));
    assert.equal(saved.attempts.length, 18);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('S11 panel recovery uses kernel checks outside the legacy task parser and refuses borrowed handles or lost retained controls', () => {
  const body = JSON.stringify({ ...JSON.parse(observationRaw()), component: [{ code: { text: 'component' }, valueQuantity: { value: 2 } }] });
  const ndjson = chart().split('\n')[0] + '\n' + body + '\n';
  const plan = makePlans(ndjson, 'test')[2]!, expected = JSON.parse(body);
  const source = JSON.parse(wireCall(body).rawResult!).structuredContent;
  source.result = { handle: 'res_' + 'A'.repeat(24), expires_at: '2026-01-02T00:00:00Z' };
  source.transform = { ...source.transform, format: 'fhir', requested_format: 'fhir', projected: false };
  const inspect = { ...source, data: { resource_count: 1, omissions: [{ resource_type: 'Observation', id: expected.id, resource_index: 0 }] }, provenance: undefined };
  const project = { ...source, transform: { ...source.transform, projected: true }, pagination: { has_more: false, returned_matches: 1, returned_includes: 0 } };
  const capture = (envelope: unknown, step: number): CapturedCall => {
    const rawResult = JSON.stringify({ structuredContent: envelope, content: [{ type: 'text', text: JSON.stringify(envelope) }] });
    return { ...wireCall(), step, rawResult, wireResultBytes: Buffer.byteLength(rawResult) };
  };
  const calls = [capture(source, 2), capture(inspect, 3), capture(project, 4)];
  const raw = { [`Observation/${expected.id}`]: body };
  assert.equal(plan.retainedChecks?.length, 2);
  assert.equal(fidelity(plan, 'fhir', calls, raw).failed, 0);
  const badHandle = capture({ ...inspect, result: { ...inspect.result, handle: 'res_' + 'B'.repeat(24) } }, 3);
  assert.ok(fidelity(plan, 'fhir', [calls[0]!, badHandle, calls[2]!], raw).failed > 0);
  const badPaging = capture({ ...project, pagination: undefined }, 4);
  assert.ok(fidelity(plan, 'fhir', [calls[0]!, calls[1]!, badPaging], raw).failed > 0);
});

/** Real captures of one plan through the ACTUAL eval runner (SDK client, MCP adapter, gateway, synthetic adapter). */
async function realCaptures(ndjson: string, template: number, arm: 'fhir' | 'compact' | 'selected' = 'fhir') {
  const lines = ndjson.trimEnd().split('\n'), resources = lines.map(line => JSON.parse(line) as GoldenResource);
  const rawBodies = Object.fromEntries(resources.map((r, i) => [`${r.resourceType}/${r.id}`, lines[i]!]));
  const plan = makePlans(ndjson, 'development-large-1')[template]!, captures: CapturedCall[] = [];
  const report = await runEvals({ tasks: [plan.task], resources, arms: [arm], era: 'modern', deliveryProfile: 'full-text-v1', configuredMaxBytes: 131072, configuredDefaultBytes: 24576,
    naturalMeasurement: { patientId: patient, rawBodies, capture: c => { captures.push(c); }, catalog: () => undefined } });
  return { plan, captures, rawBodies, report };
}
const structured = (call: CapturedCall) => JSON.parse(call.rawResult!).structuredContent as { coverage: { constraints?: unknown; constraints_on_first_page?: boolean; query_digest?: string }; data: { resources?: unknown[] } };

test('E3+E4 development-only integration: the actual runner confines a non-fixture natural patient and every arm/era/template passes on wire and text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 's11-natural-integration-'));
  try {
    const attempts = await measureChart({ ndjson: developmentChart(), patient: `Patient/${patient}`, label: 'development-large-1', split: 'development', stratum: 'large', out: join(directory, 'capture'), codeRevision: 'development-only' });
    assert.equal(attempts.length, 18);
    for (const attempt of attempts) {
      const causes = attempt.eval?.failures.map(f => f.cause) ?? [];
      assert.ok(!causes.includes('upstream_confinement_missing'), `${attempt.id}: natural patient judged against the fixture patient`);
      assert.equal(attempt.status, 'pass', `${attempt.id} ${attempt.reason ?? ''} ${JSON.stringify(attempt.fidelity)} ${causes.join(',')}`);
      assert.ok(attempt.fidelity.checked > 0 && attempt.fidelity.failed === 0, attempt.id);
    }
    // The lab trend drained several continuation pages that carry shorthand evidence, and their facts were counted.
    const trend = attempts.find(a => a.id === 'development-large-1-lab-trend-modern-fhir')!;
    const wires = await Promise.all(trend.segments.filter(s => s.kind === 'wire').map(s => readFile(join(directory, 'capture', s.file.path), 'utf8')));
    const shorthand = wires.map(raw => JSON.parse(raw).structuredContent).filter(e => e?.coverage?.query_digest && e.coverage.constraints === undefined && e.coverage.constraints_on_first_page === true);
    assert.ok(shorthand.length >= 2 && shorthand.every(e => e.data.resources.length > 0), 'shorthand continuation pages with resources');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('E4 S11 facts on shorthand continuation pages resolve within their own chain; a foreign query identity or a text-only change still fails', async () => {
  const { plan, captures, rawBodies, report } = await realCaptures(developmentChart(), 0);
  assert.equal(report.results[0]!.status, 'pass');
  const pages = captures.filter(c => c.step === 2);
  const index = pages.findIndex(c => structured(c).coverage.constraints === undefined && (structured(c).data.resources?.length ?? 0) > 0);
  assert.ok(index > 0, 'a shorthand page after the full-evidence first page');
  assert.ok(structured(pages[0]!).coverage.constraints !== undefined, 'the first page carries full evidence');
  assert.deepEqual(fidelity(plan, 'fhir', captures, rawBodies).failed, 0);
  const at = captures.indexOf(pages[index]!), digest = structured(pages[index]!).coverage.query_digest!, foreign = digest.replace(/^./, c => c === 'a' ? 'b' : 'a');
  // The same shorthand page bound to a foreign query identity on both boundaries (equal bytes).
  const foreignBoth = captures.map((c, i) => i === at ? { ...c, rawResult: c.rawResult!.replaceAll(digest, foreign) } : c);
  assert.ok(fidelity(plan, 'fhir', foreignBoth, rawBodies).failed > 0);
  // Only the captured text changes (the text block precedes structuredContent in the raw result).
  const textOnly = captures.map((c, i) => i === at ? { ...c, rawResult: c.rawResult!.replace(digest, foreign) } : c);
  assert.equal(structured(textOnly[at]!).coverage.query_digest, digest);
  assert.ok(fidelity(plan, 'fhir', textOnly, rawBodies).failed > 0);
});

test('E1 S11 judges the complete delivered boundary: text-only coverage or an extra text-only Observation fails although every cited fact matches', () => {
  const plan = makePlans(chart(), 'test')[0]!, raw = observationRaw(), source = { [`Observation/${JSON.parse(raw).id}`]: raw };
  assert.equal(fidelity(plan, 'fhir', [wireCall()], source).failed, 0);
  const coverage = wireCall(); coverage.rawResult = coverage.rawResult!.replace('complete_for_query', 'partial');
  assert.equal(JSON.parse(coverage.rawResult).structuredContent.coverage.state, 'complete_for_query', 'structuredContent is untouched');
  assert.ok(fidelity(plan, 'fhir', [coverage], source).failed > 0);
  const extra = wireCall(raw, 2, `${raw},${observationRaw('00000000-0000-4000-8000-0000000000ee')}`);
  assert.ok(fidelity(plan, 'fhir', [extra], source).failed > 0);
});

test('E6 S11 applies the eval CLI byte-accounting gate per attempt: only the gateway-reported bytes differ, and the attempt fails', async () => {
  const run = async (delta: number) => {
    const directory = await mkdtemp(join(tmpdir(), 's11-accounting-'));
    const fake: typeof runEvals = async options => {
      const task = options!.tasks![0]!;
      const results = (options!.arms ?? []).map(arm => {
        const call = { ...wireCall(), era: options!.era!, task: task.id, arm };
        options!.naturalMeasurement!.catalog({ task: task.id, arm, era: options!.era!, text: '{"tools":[]}' });
        options!.naturalMeasurement!.capture(call);
        return { task_id: task.id, arm, status: 'pass', metrics: { tool_calls: 1, upstream_calls: 1, result_bytes: call.wireResultBytes, frame_bytes: call.wireFrameBytes },
          calls: [{ step: 2, tool: 'fhir_search', wire_result_bytes: call.wireResultBytes, wire_frame_bytes: call.wireFrameBytes, gateway_reported_bytes: call.wireResultBytes + delta }],
          failures: [], checks: [] } as unknown as TaskArmResult;
      });
      return { results } as Awaited<ReturnType<typeof runEvals>>;
    };
    try {
      return await measureChart({ ndjson: chart(), patient: `Patient/${patient}`, label: 'development-small-1', split: 'development', stratum: 'small', out: join(directory, 'capture'), codeRevision: 'frozen' }, fake);
    } finally { await rm(directory, { recursive: true, force: true }); }
  };
  const control = (await run(0)).filter(a => a.status !== 'unsupported');
  assert.equal(control.length, 12); assert.ok(control.every(a => a.status === 'pass' && a.fidelity.failed === 0));
  for (const delta of [1, -1]) {
    const misreported = (await run(delta)).filter(a => a.status !== 'unsupported');
    assert.ok(misreported.every(a => a.status === 'fail' && a.reason === 'GATEWAY_ACCOUNTING_MISMATCH' && a.fidelity.failed === 0), String(delta));
  }
});
