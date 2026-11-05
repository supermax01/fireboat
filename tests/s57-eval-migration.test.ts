import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { resolveQueryChain, runEvals, parseM3bTaskFile, evaluateBoundCheck, type EvalTask } from '../packages/evals/src/index.js';
import type { GatewayEnvelope } from '../packages/core/src/index.js';
import { TASKS } from '../packages/evals/src/tasks.js';
import { exitCodeForReport } from '../packages/evals/src/runner.js';
import { canonicalJson } from '../packages/evals/src/fixture.js';
import { declaredSearchProfile, eligibleSearchProfileIds } from '../packages/core/src/query.js';

test('S57fix S57-R01/R04 the pending-proof rollback path executes generic checks; the private candidate and the qualified public profile score ordinary verdicts in both eras', async () => {
  const ids = ['query-complete-proven', 'query-cross-page-sort', 'query-ignore-code', 'query-ignore-date-lower', 'query-ignore-date-upper', 'query-ignore-sort-proven', 'query-empty-page-with-next-proven'];
  const tasks = TASKS.filter(task => ids.includes(task.id));
  assert.equal(tasks.length, 7);
  for (const era of ['modern', 'legacy'] as const) {
    // S6 rollback path: with no eligible public profile the named proof checks stay pending and everything else runs.
    const pending = await runEvals({ tasks, era, arms: ['fhir'] }, { simulateIneligibleProfile: true });
    assert.equal(pending.denominator.tasks, 7); assert.equal(pending.denominator.task_format_runs, 7);
    assert.equal(pending.summary.by_arm[0]!.tasks_attempted, 7);
    assert.equal(pending.summary.by_arm[0]!.tasks_passed, 0);
    assert.equal(pending.summary.by_arm[0]!.tasks_pending_profile_proof, 7);
    assert.equal(pending.summary.by_arm[0]!.checks_passed, 1, 'only q1 of the empty-page control is independent of the proof and runs publicly');
    assert.equal(pending.summary.by_arm[0]!.checks_comparable, tasks.reduce((n, task) => n + task.checks.length, 0));
    assert.equal(pending.summary.by_arm[0]!.checks_pending_profile_proof, pending.summary.by_arm[0]!.checks_comparable - 1);
    assert.equal(pending.summary.pending_profile_proof.length, 7);
    assert.ok(pending.results.every(row => row.status === 'pending_profile_proof' && row.profile_proof_dependency?.milestone === 'S6'
      && row.calls.length > 0 && row.checks.every(check => check.status === 'pending_profile_proof' || (row.task_id === 'query-empty-page-with-next-proven' && check.check_id === 'q1' && check.status === 'pass'))));
    assert.equal(pending.results.find(row => row.task_id === 'query-cross-page-sort')!.skipped_profile_parts?.length, 1);
    assert.deepEqual(pending.summary.byte_accounting.under_reported_calls, 0);
    assert.ok(pending.results.every(row => row.query_profile.id === 'generic-r4' && row.query_profile.private === false));
    assert.equal(exitCodeForReport(pending), 0);
    // Labelled private candidate through the seam: ordinary verdicts, every control passes, separate accounting.
    const profile = { ...declaredSearchProfile('synthetic-fixture-r4-v1')!, id: 'private-s57b-eval', eligible: false, evidence: null };
    const scored = await runEvals({ tasks, era, arms: ['fhir'] }, { testQueryProfile: profile });
    assert.equal(scored.summary.pending_profile_proof.length, 0);
    assert.equal(scored.summary.by_arm[0]!.tasks_pending_profile_proof, 0);
    assert.ok(scored.results.every(row => row.status === 'private_profile_control' && row.calls.length > 0
      && row.checks.every(check => check.status !== 'pending_profile_proof')), 'enabled private profile must execute ordinary verdict checks');
    assert.equal(scored.summary.by_arm[0]!.tasks_passed, 0, 'private controls never count as public passes');
    assert.equal(scored.summary.private_profile_controls.length, 7);
    assert.ok(scored.results.every(row => row.private_profile_verdict === 'pass' && row.failures.length === 0), JSON.stringify(scored.summary.private_profile_controls));
    assert.deepEqual(scored.summary.failures_by_cause, {});
    assert.deepEqual(scored.selection.query_profiles, [{ id: profile.id, eligible: false, private: true, warning_codes: ['TEST_QUERY_EVIDENCE'] }]);
    assert.ok(scored.results.every(row => row.calls.every(call => call.query_profile.id === profile.id && call.query_profile.private)));
    assert.equal(exitCodeForReport(scored), 0);
    const broken = structuredClone(tasks.find(task => task.id === 'query-complete-proven')!);
    broken.checks.push({ kind: 'dataPath', id: 'must-fail', step: 0, path: 'nonexistent', equals: 'required' });
    const refused = await runEvals({ tasks: [broken], era, arms: ['fhir'] }, { testQueryProfile: profile });
    assert.equal(refused.results[0]!.private_profile_verdict, 'fail', 'profile eligibility never bypasses a failing assertion');
    assert.equal(exitCodeForReport(refused), 1);
    // S6: the qualified public profile is selected through ordinary config, with no override and no private warning.
    const qualified = await runEvals({ tasks, era, arms: ['fhir'] });
    assert.equal(qualified.summary.pending_profile_proof.length, 0);
    assert.equal(qualified.summary.by_arm[0]!.tasks_passed, 7, JSON.stringify(qualified.summary.failures_by_cause));
    assert.deepEqual(qualified.summary.private_profile_controls, []);
    assert.ok(qualified.results.every(row => row.status === 'pass' && row.query_profile.id === 'synthetic-fixture-r4-v1' && row.query_profile.eligible === true && row.query_profile.private === false && row.query_profile.warning_codes.length === 0));
    assert.ok(qualified.results.every(row => row.calls.every(call => call.query_profile.id === 'synthetic-fixture-r4-v1' && !call.query_profile.private)));
    assert.ok(qualified.results.every(row => row.calls.every(call => !(call.observed_warning_codes ?? []).includes('TEST_QUERY_EVIDENCE'))), 'the observed envelopes carry no private-candidate warning');
    assert.equal(qualified.results.find(row => row.task_id === 'query-cross-page-sort')!.skipped_profile_parts, undefined, 'the drain is no longer skipped');
    assert.equal(exitCodeForReport(qualified), 0);
  }
  assert.deepEqual(eligibleSearchProfileIds(), ['generic-r4', 'hapi-r4-labs-v1', 'synthetic-fixture-r4-v1']);
});

test('S57fix S57-R04 the profile task identities and content hashes stay pinned; the full corpus has no pending row in either era', async () => {
  const pins = {
    'query-complete-proven': '2b595d79e83e0900293b2a800bc3dc79d15dec57cff4f737e28ac640be6e1913',
    'query-cross-page-sort': '7864c2947a9ce76f371b5f7e071a499e6ce66bab46fae7bfc0e819c4a6963ffe',
    'query-ignore-code': '23841b79e0237dabe05fefe9e2ccac1e011ae9bd8e8537a103186fac99368283',
    'query-ignore-date-lower': 'f72fa004044642b1885a1bbd418d1e766c1c32fddb65c130ff18d5de19a6061d',
    'query-ignore-date-upper': 'b15f063a8e8dd03ea5eaa4204028696fc908da4c89e9ab339bdda04ddb7d99ad',
    'query-ignore-sort-proven': '1ff66d16aa25c8702e944397413cbae6211f4e43b6b6cfbb7a27d64824054eb9',
    'query-empty-page-with-next-proven': '1470aefe35d4f40062ce4ed3b1d36a99da888ec3b2bf73accb18fa09c902f442',
  };
  for (const [id, hash] of Object.entries(pins)) assert.equal(createHash('sha256').update(canonicalJson(TASKS.find(task => task.id === id))).digest('hex'), hash);
  const foreign = TASKS.find(task => task.id === 'patient-link-bare-id-denied')!;
  assert.equal((foreign.steps[0]!.input.params as any[])[0].value, 'eval-patient-b');
  for (const era of ['modern', 'legacy'] as const) {
    const report = await runEvals({ era });
    assert.deepEqual(report.summary.pending_profile_proof, []);
    assert.equal(report.summary.by_arm.reduce((n, arm) => n + arm.tasks_pending_profile_proof, 0), 0);
    assert.ok(report.results.every(row => row.calls.length > 0));
    assert.deepEqual([...new Set(report.results.filter(row => row.query_profile.id === 'synthetic-fixture-r4-v1').map(row => row.task_id))].sort(), Object.keys(pins).sort(), 'exactly the profile tasks select the qualified profile');
    const retained = report.results.filter(row => row.task_id === 'retained-offset-multi-record');
    assert.equal(retained.length, 3, 'multi-record retained task executes in every arm');
    assert.ok(retained.every(row => row.status === 'pass'));
    assert.deepEqual(report.summary.failures_by_cause, {});
    assert.equal(exitCodeForReport(report), 0);
    assert.deepEqual(report.summary.private_profile_controls, []);
    // Rollback path: the same corpus with no eligible profile pends exactly the profile tasks.
    const rollback = await runEvals({ era }, { simulateIneligibleProfile: true });
    assert.deepEqual([...new Set(rollback.summary.pending_profile_proof.map(row => row.task_id))].sort(), Object.keys(pins).sort());
    assert.equal(rollback.summary.pending_profile_proof.length, 21);
    assert.equal(exitCodeForReport(rollback), 0);
  }
});

test('S57fix S57-R04 pending proof never hides an independent check failure', async () => {
  const task = structuredClone(TASKS.find(task => task.id === 'query-ignore-code')!);
  task.checks.push({ kind: 'dataPath', id: 'independent-check', step: 0, path: 'nonexistent', equals: true });
  // S6: the pending machinery is the rollback path, exercised with no eligible public profile.
  const report = await runEvals({ tasks: [task], arms: ['fhir'] }, { simulateIneligibleProfile: true });
  assert.equal(report.results[0]!.status, 'fail');
  assert.equal(report.results[0]!.checks.find(check => check.check_id === 'q1')!.status, 'pending_profile_proof');
  assert.equal(report.results[0]!.checks.find(check => check.check_id === 'independent-check')!.status, 'fail');
  assert.equal(exitCodeForReport(report), 1);
  task.checks = [{ kind: 'dataPath', id: 'q1', step: 0, path: 'nonexistent', equals: true }];
  const replaced = await runEvals({ tasks: [task], arms: ['fhir'] }, { simulateIneligibleProfile: true });
  assert.equal(replaced.results[0]!.checks[0]!.status, 'fail', 'a reused proof-check id does not make an independent check pending');
  assert.equal(replaced.results[0]!.status, 'fail');
});

test('S57 digest evidence stays in its bound step, preserves repeated pairs and latest downgrade flags', () => {
  const pairs = [{ name: 'code', value: 'x' }, { name: 'code', value: 'x' }];
  const digest = createHash('sha256').update(JSON.stringify({ v: 1, source_revision: 'rev', policy_revision: 'policy', context_handle: 'ctx', resource_type: 'Observation', constraints: pairs, sort: [] })).digest('hex');
  const first = { source: { alias: 'synthetic', capability_revision: 'rev' }, context: { handle: 'ctx', policy_revision: 'policy' }, data: { resources: [] },
    coverage: { scope: 'page', query_digest: digest, constraints: pairs.map(p => ({ ...p, source_reported: 'matched', execution: 'tested_adapter', evidence_ref: 'synthetic@1' })) } } as unknown as GatewayEnvelope;
  const downgraded = structuredClone(first);
  downgraded.coverage.constraints = pairs.map(p => ({ ...p, source_reported: 'not_reported', execution: 'unknown' }));
  const continuation = structuredClone(downgraded);
  delete continuation.coverage.constraints; continuation.coverage.constraints_on_first_page = true;
  const result = resolveQueryChain([first, downgraded, continuation], 'Observation');
  assert.equal(result.error, undefined);
  assert.deepEqual(result.envelopes[2]!.coverage.constraints, downgraded.coverage.constraints);
  assert.ok(resolveQueryChain([continuation], 'Observation').error, 'another step cannot borrow a digest');
  assert.ok(resolveQueryChain([downgraded, first], 'Observation').error, 'proof cannot upgrade on continuation');
  const foreign = structuredClone(continuation); foreign.context.handle = 'another-context';
  assert.ok(resolveQueryChain([first, foreign], 'Observation').error);
  const lost = structuredClone(first); lost.coverage.constraints!.pop();
  assert.ok(resolveQueryChain([lost], 'Observation').error, 'digest binds both duplicate occurrences');
});

test('S57 raw fragment numbers and indexed citations run through the sole SDK path in every format and era', async () => {
  const task: EvalTask = { id: 's57-raw', category: 'migration', corpus: 'projection', question: 'Synthetic raw numeric fidelity.',
    steps: [{ tool: 'fhir_read', input: { resource_type: 'Observation', id: 'p-lab-lexeme' } }],
    fields: ['meta', 'code', 'valueQuantity'],
    checks: [
      { kind: 'decimalLexeme', id: 'lexeme', step: 0, resource_type: 'Observation', id_value: 'p-lab-lexeme', path: 'valueQuantity.value', equals: '7.0' },
      { kind: 'citationTuple', id: 'citation', step: 0, source: 'eval-fixture', resource_type: 'Observation', id_value: 'p-lab-lexeme', version: '7' },
      { kind: 'fact', id: 'comparator', resource: 'p-lab-lexeme', path: 'valueQuantity.comparator', equals: '>=' },
    ], budget: { maxBytes: 24576, maxUpstreamCalls: 2, maxToolCalls: 1 } };
  for (const era of ['modern','legacy'] as const) {
    const report = await runEvals({ tasks: [task], era });
    assert.equal(report.schema_version, 'fhir-mcp-retrieval-eval/0.3');
    assert.equal(report.eval_package_version, '0.3.0'); assert.equal(report.gateway_envelope_schema_version, '0.3');
    assert.ok(report.results.every(r => r.status === 'pass'), JSON.stringify(report.summary.failures_by_cause));
    assert.equal(report.denominator.task_format_runs, 3);
    for (const result of report.results) {
      const call = result.calls[0]!;
      assert.deepEqual(call.work, { metadata: 1, auth: 0, clinical: 1 });
      assert.equal(call.era, era); assert.match(call.raw_result_sha256!, /^[a-f0-9]{64}$/);
      assert.equal(call.text_tokens, null); assert.equal(call.model_input_sha256, null);
      assert.equal(call.wire_result_bytes, call.gateway_reported_bytes);
    }
  }
});

test('S57 eval loader rejects wildcard error expectations', () => {
  assert.throws(() => parseM3bTaskFile(JSON.stringify({ schema_version: 'm3b-tasks/1', tasks: [{ id: 'wildcard', category: 'test', question: 'x', steps: [{ tool: 'fhir_read', input: {} }], checks: [{ kind: 'callOutcome', id: 'wildcard', step: 0, outcome: 'application_error', code: '*' }], budget: { maxBytes: 4096, maxUpstreamCalls: 1, maxToolCalls: 1 } }] })), /callOutcome invalid/);
});

test('S57 literal executable examples reproduce fixed-clock SDK handles and continuations', () => {
  const output = execFileSync(process.execPath, ['--import', 'tsx', 'examples/capture-tool-calls.ts', '--check'], { encoding: 'utf8' });
  assert.match(output, /literal SDK examples in sync \(12 calls per era\)/);
});

test('S57 eval citations cannot borrow another response resource index', () => {
  const envelope = { schema_version: '0.3', source: { alias: 'eval-fixture' }, data: { resources: [{ resourceType: 'Observation', id: 'synthetic-citation', meta: { versionId: '7' } }] },
    provenance: [{ resource_index: 99, retrieved_at: '2026-10-19T12:00:00Z' }], coverage: { scope: 'resource' } } as unknown as GatewayEnvelope;
  const other = structuredClone(envelope); other.provenance![0]!.resource_index = 0;
  const check = { kind: 'citationTuple' as const, id: 'indexed', step: 0, response_index: 0, source: 'eval-fixture', resource_type: 'Observation', id_value: 'synthetic-citation', version: '7' };
  assert.equal(evaluateBoundCheck(check, 'fhir', [envelope, other], []).status, 'fail');
  assert.equal(evaluateBoundCheck(check, 'fhir', [other], []).status, 'pass');
});
