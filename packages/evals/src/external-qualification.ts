import { ARM_ORDER, type ProtocolEra } from './tasks.js';
import type { EvalReport } from './runner.js';
import { externalApplicability, externalHash, externalTasks, type ExternalIdentity } from './external.js';

/** The expected denominator comes from the pinned task table, never the rows returned by the runner. */
export function externalQualificationProblems(report: EvalReport, identity: ExternalIdentity, candidateId: string, expectedEra: ProtocolEra = 'modern'): string[] {
  const applicable = externalApplicability().filter(row => row.classification === 'real-backend');
  const expected = applicable.flatMap(row => ARM_ORDER.map(arm => `${row.task_id}/${arm}`)).sort();
  const observed = report.results.map(row => `${row.task_id}/${row.arm}`).sort();
  const controlKeys = applicable.filter(row => row.profile_control).flatMap(row => ARM_ORDER.map(arm => `${row.task_id}/${arm}`)).sort();
  const controls = report.results.filter(row => row.status === 'private_profile_control');
  const problems: string[] = [];
  if (report.protocol.era !== expectedEra) problems.push('protocol era differs from the requested qualification era');
  if (externalHash(observed) !== externalHash(expected)) problems.push('task-arm denominator differs from independently expected applicability');
  if (externalHash(controls.map(row => `${row.task_id}/${row.arm}`).sort()) !== externalHash(controlKeys) || controlKeys.length === 0) problems.push('private-control denominator differs from independently expected tasks times arms');
  if (controls.some(row => row.private_profile_verdict !== 'pass' || row.failures.length > 0 || row.checks.some(check => check.status === 'fail' || check.status === 'pending_profile_proof'))) problems.push('private controls failed');
  if (controls.some(row => row.query_profile.id !== candidateId || !row.query_profile.private || row.calls.length === 0 || row.calls.some(call => call.query_profile.id !== candidateId || !call.query_profile.private))) problems.push('private controls mislabelled');
  if (controls.some(row => row.query_profile.eligible || externalHash(row.query_profile.warning_codes) !== externalHash(['TEST_QUERY_EVIDENCE'])
    || row.calls.some(call => call.query_profile.eligible || !call.observed_warning_codes.includes('TEST_QUERY_EVIDENCE')))) problems.push('private control evidence labels missing');
  if (controls.some(row => {
    const task = externalTasks().find(task => task.id === row.task_id);
    const keys = (checks: { id?: string; check_id?: string; kind: string; step?: number }[]) => checks.map(check => [check.id ?? check.check_id, check.kind, check.step ?? 0]).sort();
    return !task || externalHash(keys(row.checks)) !== externalHash(keys(task.checks)) || row.checks.some(check => check.status !== 'pass');
  })) problems.push('private control check identities or verdicts differ from the declared controls');
  if (report.summary.pending_profile_proof.length || report.results.some(row => row.status === 'pending_profile_proof' || row.checks.some(check => check.status === 'pending_profile_proof'))) problems.push('pending profile proof');
  if (report.results.some(row => row.status !== 'private_profile_control' && (row.status !== 'pass' || row.failures.length)) || Object.keys(report.summary.failures_by_cause).length) problems.push('public run not clean');
  if (report.summary.byte_accounting.under_reported_calls || report.summary.byte_accounting.over_reported_calls) problems.push('independent byte accounting failed');
  if (externalHash(report.external_backend?.identity) !== externalHash(identity)) problems.push('external identity changed');
  if (externalHash(report.external_backend?.applicability) !== externalHash(externalApplicability())) problems.push('applicability report changed');
  return problems;
}
