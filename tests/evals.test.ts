import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/server';
import { FhirGateway } from '../packages/core/src/index.js';
import { ARM_ORDER, GOLDEN_RESOURCES, GLOBAL_PROHIBITED, TASKS, exitCodeForReport, fixtureSha256, runEvals, type EvalTask } from '../packages/evals/src/index.js';
import { ordinaryFailureLine } from '../packages/evals/src/runner.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const task = (id = 'bp-components') => structuredClone(TASKS.find(value => value.id === id)!);
const GOLDEN_TASK_COUNT = 36;

test('golden tasks pass and adversarial tasks meet their declared outcome in every format, with truthful denominators', async () => {
  const baselineTasks = TASKS.filter(t => !t.corpus || t.corpus === 'baseline');
  const report = await runEvals({ tasks: baselineTasks, generatedAt: '2026-10-18T00:00:00.000Z', codeRevision: 'test', packageVersion: 'test' });
  assert.equal(report.task_count, baselineTasks.length);
  assert.equal(report.results.length, baselineTasks.length * 3);
  assert.match(report.fixture.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.protocol.era, 'modern');
  assert.equal(report.protocol.negotiated_version, '2026-07-28');
  assert.equal(exitCodeForReport(report), 0);
  assert.equal(baselineTasks.filter(value => value.category !== 'adversarial' && value.category !== 'byte-accounting').length, GOLDEN_TASK_COUNT);
  // "N tasks x 3 formats (K format-sensitive)" -- never "3N cases".
  assert.equal(report.denominator.tasks, baselineTasks.length);
  assert.equal(report.denominator.formats, 3);
  assert.match(report.denominator.statement, new RegExp(`^${baselineTasks.length} tasks x 3 formats \\(\\d+ format-sensitive\\)$`));
  for (const id of ['capabilities-server', 'cross-patient-read-denied', 'schema-observation-root']) assert.ok(report.denominator.format_insensitive_task_ids?.includes(id), id);
  for (const id of ['hba1c-quantity-ucum', 'heart-rate-paging-drain']) assert.ok(!report.denominator.format_insensitive_task_ids?.includes(id), id);
  assert.equal(report.denominator.format_sensitive_tasks, baselineTasks.length - report.denominator.format_insensitive_task_ids!.length);
  for (const arm of report.summary.by_arm) {
    assert.equal(arm.tasks_failed, 0);
    assert.equal(arm.checks_failed, 0);
    assert.equal(arm.checks_passed + arm.checks_known_defect, arm.checks_comparable);
  }
  assert.ok(report.summary.by_arm.find(value => value.arm === 'compact')!.checks_incomparable > 0);
  for (const result of report.results) {
    const declared = baselineTasks.find(value => value.id === result.task_id)!;
    // Expected failures appear only where a task declares the agreed defect, and every declared defect reproduced.
    assert.equal(result.status, declared.knownDefects?.length ? 'known-defect' : 'pass', `${result.task_id}/${result.arm}`);
    assert.ok(result.known_defects.every(defect => defect.reproduced));
    assert.ok(result.failures.every(failure => failure.known_defect), `${result.task_id}: unexpected ${JSON.stringify(result.failures)}`);
    assert.equal(result.metrics.upstream_calls, result.metrics.upstream_calls_gateway_reported);
    assert.ok(result.metrics.result_bytes <= result.budget.max_bytes);
    assert.equal(result.metrics.result_bytes, result.calls.reduce((sum, call) => sum + call.wire_result_bytes, 0));
  }
});

test('outbound confinement: every search/page request is checked, and a stale defect marker cannot hide a fixed gateway', async () => {
  // J-9 fixed: the dropped-patient continuation is rejected before fetching, so the task passes unmarked and
  // no upstream request ever lacks the trusted constraint.
  const dropped = task('adversarial-continuation-drops-patient');
  assert.equal(dropped.knownDefects, undefined, 'the resolved J-9 marker stays removed');
  const report = await runEvals({ tasks: [dropped], arms: ['fhir'] });
  assert.equal(exitCodeForReport(report), 0);
  assert.equal(report.results[0]!.status, 'pass');
  assert.ok(!report.results[0]!.failures.some(failure => failure.cause === 'upstream_confinement_missing'));
  // Re-adding the old marker must fail the run as resolved, proving markers cannot quietly absorb anything.
  dropped.knownDefects = [{ jid: 'J-9', summary: 'stale marker', match: [{ cause: 'upstream_confinement_missing' }] }];
  const marked = await runEvals({ tasks: [dropped], arms: ['fhir'] });
  assert.equal(marked.results[0]!.status, 'fail');
  assert.ok(marked.results[0]!.failures.some(failure => failure.cause === 'known_defect_resolved'));
  assert.ok(!JSON.stringify(marked.results[0]!.failures).includes('eval-patient-a'), 'failure details carry no patient identifiers');
  // Golden searches send the trusted constraint on every request, including drained pages.
  const golden = await runEvals({ tasks: [task('heart-rate-paging-drain')], arms: ['fhir'] });
  assert.equal(golden.results[0]!.status, 'pass');
  assert.equal(golden.results[0]!.metrics.upstream_calls, 4);
});

test('a declared known defect that no longer reproduces fails the run, and an extra failure is not absorbed', async () => {
  const resolved = task();
  resolved.knownDefects = [{ jid: 'J-test', summary: 'deliberately stale marker', match: [{ checkId: 'panel-code' }] }];
  const stale = await runEvals({ tasks: [resolved], arms: ['fhir'] });
  assert.equal(stale.results[0]!.status, 'fail');
  assert.ok(stale.results[0]!.failures.some(failure => failure.cause === 'known_defect_resolved' && failure.detail.includes('J-test')));
  const extra = task('adversarial-page2-suppression');
  assert.equal(extra.knownDefects, undefined, 'the resolved J-17 markers stay removed');
  extra.checks.push(
    { kind: 'resourceIds', id: 'marked-wrong', equals: ['adv-a1'] },
    { kind: 'resourceIds', id: 'deliberately-wrong', equals: ['adv-a2'] },
  );
  extra.knownDefects = [{ jid: 'J-test', summary: 'covers only the marked check', match: [{ checkId: 'marked-wrong' }] }];
  const mixed = await runEvals({ tasks: [extra], arms: ['fhir'] });
  assert.equal(mixed.results[0]!.status, 'fail');
  assert.ok(mixed.results[0]!.failures.some(failure => failure.check_id === 'marked-wrong' && failure.known_defect === 'J-test'));
  assert.ok(mixed.results[0]!.failures.some(failure => failure.check_id === 'deliberately-wrong' && !failure.known_defect), 'a marker never absorbs an unrelated failure');
});

test('a retained projection that returns nothing fails even though the earlier read carried the facts (G-11)', async () => {
  const original = FhirGateway.prototype.execute;
  FhirGateway.prototype.execute = async function (this: FhirGateway, tool, input) {
    const envelope = await original.call(this, tool, input);
    if (tool === 'fhir_result' && !envelope.error) {
      const captures = (this as any).capturesV2;
      const capture = captures.get(envelope);
      const result = structuredClone(capture.result);
      result.structuredContent.data.resources = []; result.structuredContent.provenance = [];
      captures.set(envelope, { ...capture, result });
    }
    return envelope;
  };
  try {
    const report = await runEvals({ tasks: [task('result-project-compact-omitted')] });
    assert.equal(exitCodeForReport(report), 1);
    for (const result of report.results) {
      for (const id of ['identifier', 'family']) assert.ok(result.failures.some(failure => failure.check_id === id && failure.cause === 'expected_fact_missing' && failure.step === 1), `${result.arm} ${id}`);
    }
  } finally { FhirGateway.prototype.execute = original; }
  const healthy = await runEvals({ tasks: [task('result-project-compact-omitted')] });
  assert.equal(exitCodeForReport(healthy), 0, 'positive control: the real projection supplies both facts');
});

test('checks bind to a step and resource version; an unbound check in a multi-step task is a harness error', async () => {
  const unbound = task('reference-range-interpretation');
  unbound.checks = [{ kind: 'fact', id: 'unbound', resource: 'obs-glucose-2', path: 'valueQuantity.value', equals: 102 }];
  const report = await runEvals({ tasks: [unbound], arms: ['fhir'] });
  assert.ok(report.results[0]!.failures.some(failure => failure.cause === 'harness_error' && failure.check_id === 'unbound'));
  const wrongStep = task('reference-range-interpretation');
  wrongStep.checks = [{ kind: 'fact', id: 'wrong-step', step: 0, resource: 'obs-glucose-2', path: 'valueQuantity.value', equals: 102 }];
  assert.ok((await runEvals({ tasks: [wrongStep], arms: ['fhir'] })).results[0]!.failures.some(failure => failure.check_id === 'wrong-step' && failure.cause === 'expected_fact_missing'));
  const wrongVersion = task();
  wrongVersion.checks = [{ kind: 'fact', id: 'wrong-version', resource: 'obs-bp-1', path: 'component.0.valueQuantity.value', equals: 118, version: '2' }];
  assert.ok((await runEvals({ tasks: [wrongVersion], arms: ['fhir'] })).results[0]!.failures.some(failure => failure.check_id === 'wrong-version' && failure.cause === 'version_mismatch'));
});

test('result bytes are measured from the emitted MCP result, so adapter-added bytes the gateway never counted fail the ceiling', async () => {
  const original = McpServer.prototype.registerTool;
  const padding = 'p'.repeat(4000);
  (McpServer.prototype as { registerTool: unknown }).registerTool = function (this: McpServer, name: string, config: unknown, callback: (...args: unknown[]) => Promise<{ content: unknown[] }>) {
    return original.call(this, name, config as never, (async (...args: unknown[]) => { const result = await callback(...args); return { ...result, content: [...result.content, { type: 'text', text: padding }] }; }) as never);
  };
  try {
    const padded = task();
    padded.perCallBytes = 4096;
    const report = await runEvals({ tasks: [padded], arms: ['fhir'] });
    const [call] = report.results[0]!.calls;
    assert.ok(call!.wire_result_bytes > 4096 && call!.gateway_reported_bytes! <= 4096, JSON.stringify(call));
    assert.ok(report.results[0]!.failures.some(failure => failure.cause === 'call_byte_limit_exceeded'));
  } finally { McpServer.prototype.registerTool = original; }
  // Era-specific wire fields are measured, whatever the gateway reports.
  const [modern, legacy] = await Promise.all((['modern', 'legacy'] as const).map(era => runEvals({ tasks: [task()], arms: ['fhir'], era })));
  assert.equal(legacy!.protocol.era, 'legacy');
  assert.notEqual(modern!.results[0]!.calls[0]!.wire_result_bytes, legacy!.results[0]!.calls[0]!.wire_result_bytes);
});

test('a wrong golden fact fails every applicable arm', async () => {
  const changed = task();
  changed.checks = [{ kind: 'fact', id: 'deliberately-wrong', resource: 'obs-bp-1', path: 'component.0.valueQuantity.value', equals: 999 }];
  const report = await runEvals({ tasks: [changed] });
  assert.equal(exitCodeForReport(report), 1);
  assert.ok(report.results.every(result => result.failures.some(failure => failure.cause === 'expected_fact_mismatch')));
});

test('a prohibited disclosure fails even when all clinical facts match', async () => {
  const resources = structuredClone(GOLDEN_RESOURCES);
  const bp = resources.find(resource => resource.id === 'obs-bp-1')!;
  (bp.code as Record<string, unknown>).text = GLOBAL_PROHIBITED[0];
  const report = await runEvals({ tasks: [task()], resources });
  assert.equal(exitCodeForReport(report), 1);
  assert.ok(report.results.every(result => result.failures.some(failure => failure.cause === 'prohibited_disclosure')));
  assert.ok(report.results.every(result => result.checks.every(check => check.status === 'pass')));
});

test('duplicate fixture identities are rejected before any gateway work', async () => {
  const resources = structuredClone(GOLDEN_RESOURCES);
  resources.push(structuredClone(resources.find(resource => resource.id === 'obs-hr-01')!));
  await assert.rejects(runEvals({ tasks: [task('heart-rate-paging-drain')], resources }), /Duplicate base fixture identity/);
});

test('global byte, upstream and tool budgets fail explicitly and stop additional work', async () => {
  const limited: EvalTask[] = ['bytes', 'upstream', 'tools'].map((kind, i) => {
    const value = task();
    value.id = `budget-${kind}`;
    value.steps.push(structuredClone(value.steps[0]!));
    value.checks = value.checks.map(check => ({ ...check, step: 0 }));
    value.budget = { maxBytes: 100000, maxUpstreamCalls: 10, maxToolCalls: 10 };
    if (i === 0) value.budget.maxBytes = 1;
    if (i === 1) value.budget.maxUpstreamCalls = 1;
    if (i === 2) value.budget.maxToolCalls = 1;
    return value;
  });
  const report = await runEvals({ tasks: limited, arms: ['fhir'] });
  assert.equal(exitCodeForReport(report), 1);
  for (const result of report.results) {
    assert.ok(result.failures.some(failure => failure.cause.startsWith('budget_')));
    assert.ok(result.metrics.tool_calls <= 1);
  }
});

test('fixture hash and result ordering are stable while timing remains descriptive', async () => {
  const selected = [task(), task('value-boolean')];
  const a = await runEvals({ tasks: selected, arms: [...ARM_ORDER] });
  const b = await runEvals({ tasks: [...selected].reverse(), arms: [...ARM_ORDER] });
  const outcomes = (report: typeof a) => report.results.map(result => ({ task: result.task_id, arm: result.arm, status: result.status, checks: result.checks }));
  assert.deepEqual(outcomes(a), outcomes(b));
  assert.equal(a.fixture.sha256, b.fixture.sha256);
  const changed = structuredClone(GOLDEN_RESOURCES);
  changed[0]!.active = false;
  assert.notEqual(fixtureSha256(changed), a.fixture.sha256);
  await assert.rejects(runEvals({ tasks: [] }), /selection/);
});

/** Rewrite only the delivered text block of every clinical result; structuredContent, facts and provenance stay intact. */
async function withTextOnly<T>(rewrite: (text: string) => string, use: () => Promise<T>): Promise<T> {
  const original = FhirGateway.prototype.toToolResult;
  FhirGateway.prototype.toToolResult = function (this: FhirGateway, ...args: Parameters<FhirGateway['toToolResult']>) {
    const result = original.apply(this, args);
    return { ...result, content: result.content.map(block => ({ ...block, text: rewrite(block.text) })) };
  };
  try { return await use(); } finally { FhirGateway.prototype.toToolResult = original; }
}

test('E1 full-text-v1: the delivered text must be the raw structuredContent, so text-only alterations fail even at equal bytes', async () => {
  const healthy = await runEvals({ tasks: [task()], arms: ['fhir'] });
  assert.equal(exitCodeForReport(healthy), 0, 'positive control: production text equals structuredContent');
  const run = (rewrite: (text: string) => string) => withTextOnly(rewrite, () => runEvals({ tasks: [task()], arms: ['fhir'] }));
  const causes = (report: Awaited<ReturnType<typeof runEvals>>) => new Set(report.results[0]!.failures.map(f => f.cause));
  // Equal-byte substitution of one delivered value: every structured check and the byte accounting still agree.
  const value = await run(text => text.replace('"value":118', '"value":119'));
  assert.equal(exitCodeForReport(value), 1);
  assert.ok(causes(value).has('data_mismatch'));
  assert.ok(value.results[0]!.checks.every(check => check.status === 'pass'), 'structured facts alone cannot see the text change');
  assert.deepEqual([value.summary.byte_accounting.under_reported_calls, value.summary.byte_accounting.over_reported_calls], [0, 0]);
  // Equal-byte wrong-patient substitution in the text only: also a delivered-boundary prohibited disclosure.
  const patient = await run(text => text.replaceAll('eval-patient-a', 'eval-patient-b'));
  assert.ok(causes(patient).has('data_mismatch') && causes(patient).has('prohibited_disclosure'));
  assert.deepEqual([patient.summary.byte_accounting.under_reported_calls, patient.summary.byte_accounting.over_reported_calls], [0, 0]);
  assert.ok(!JSON.stringify(patient.results[0]!.failures).includes('eval-patient-b'), 'a prohibited-disclosure detail never echoes the marker');
  // A resource delivered only in the text, and coverage that is false only in the text.
  const extra = await run(text => text.replace('"resources":[', '"resources":[{"resourceType":"Observation","id":"text-only-extra"},'));
  assert.ok(causes(extra).has('data_mismatch'));
  const coverage = await run(text => text.replace(/"state":"(complete_for_query|partial|unknown)"/, (_match, state: string) => `"state":"${state === 'complete_for_query' ? 'partial' : 'complete_for_query'}"`));
  assert.ok(causes(coverage).has('data_mismatch'));
});

test('E7 ordinary eval output carries fixed causes, check ids and steps, never patient markers or returned-value excerpts', async () => {
  const changed = task();
  changed.checks = [{ kind: 'fact', id: 'deliberately-wrong', resource: 'obs-bp-1', path: 'component.0.valueQuantity.value', equals: 999 }];
  const wrong = await runEvals({ tasks: [changed], arms: ['fhir'] });
  const patient = await withTextOnly(text => text.replaceAll('eval-patient-a', 'eval-patient-b'), () => runEvals({ tasks: [task()], arms: ['fhir'] }));
  const results = [...wrong.results, ...patient.results];
  const failures = results.flatMap(result => result.failures.map(failure => ({ result, failure })));
  assert.ok(failures.some(({ failure }) => failure.cause === 'expected_fact_mismatch' && /expected .* got /.test(failure.detail)), 'the private report keeps the detail');
  assert.ok(failures.some(({ failure }) => failure.cause === 'prohibited_disclosure'));
  const output = failures.map(({ result, failure }) => ordinaryFailureLine(result, failure)).join('\n');
  assert.match(output, /FAIL bp-components arm=fhir cause=expected_fact_mismatch check=deliberately-wrong step=0/);
  assert.match(output, /cause=prohibited_disclosure/);
  for (const forbidden of ['eval-patient', 'obs-bp-1', ' expected ', ' got ', '999', '118', '"', 'marker #']) assert.ok(!output.includes(forbidden), forbidden);
});

test('E7 the eval CLI prints only fixed failure lines; the details stay in its owner-only report file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eval-cli-output-')), out = join(directory, 'report.json');
  try {
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--import', './tests/fixtures/eval-text-only-substitution.ts', 'packages/evals/src/cli.ts',
      '--out', out, '--arm', 'fhir', '--filter', 'bp-components'], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(run.status, 1, run.stderr);
    const lines = run.stdout.split('\n').filter(line => line.startsWith('  FAIL '));
    assert.ok(lines.some(line => line.includes('cause=data_mismatch')) && lines.some(line => line.includes('cause=prohibited_disclosure')), run.stdout);
    for (const line of lines) assert.match(line, /^ {2}FAIL [a-z0-9-]+ arm=(fhir|compact|selected) cause=[a-z_]+( check=[A-Za-z0-9_.-]+)?( step=\d+)?$/);
    assert.ok(!run.stdout.includes('eval-patient') && !run.stderr.includes('eval-patient'));
    assert.equal(statSync(out).mode & 0o777, 0o600);
    const report = JSON.parse(readFileSync(out, 'utf8')) as Awaited<ReturnType<typeof runEvals>>;
    assert.ok(report.results[0]!.failures.some(failure => failure.cause === 'data_mismatch' && failure.detail.length > 0));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
