import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_ERAS, exitCodeForReport, ordinaryFailureLine, runEvals, type RunEvalsOptions } from './runner.js';
import { ARM_ORDER, TASKS, type ArmName, type ProtocolEra } from './tasks.js';
import { HAPI_IMAGE_DIGEST, prepareExternalBackend } from './external.js';

// CLI entry point only. Tests import runner.ts / index.ts, never this file,
// so importing the eval package cannot execute a run by accident.

function parseArgs(argv: string[]): { out: string; arms?: ArmName[]; filter?: string; era: ProtocolEra; run: RunEvalsOptions; externalBaseUrl?: string; externalImageDigest: string } {
  let out = '.local/evals/retrieval-eval-v0.json';
  let arms: ArmName[] | undefined;
  let filter: string | undefined;
  let era: ProtocolEra = 'modern';
  const run: RunEvalsOptions = {};
  let externalBaseUrl: string | undefined;
  let externalImageDigest = HAPI_IMAGE_DIGEST;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--out') out = argv[++i] ?? out;
    else if (arg === '--external-base-url') { const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error('--external-base-url requires a literal-loopback FHIR URL'); externalBaseUrl = value; }
    else if (arg === '--external-image-digest') externalImageDigest = argv[++i] ?? '';
    else if (arg === '--corpus') { const value = argv[++i]; if (!['baseline','query','projection','usability','all'].includes(value ?? '')) throw new Error('unknown corpus'); run.corpus = value as RunEvalsOptions['corpus']; }
    else if (arg === '--profile') { const value = argv[++i]; if (!['full-text-v1','structured-evidence-v1'].includes(value ?? '')) throw new Error('unknown profile'); run.deliveryProfile = value as RunEvalsOptions['deliveryProfile']; }
    else if (arg === '--host') run.host = argv[++i];
    else if (arg === '--stratum') run.stratum = argv[++i];
    else if (arg === '--packaged-bin') run.packagedBin = argv[++i];
    else if (arg === '--configured-max-bytes') run.configuredMaxBytes = Number(argv[++i]);
    else if (arg === '--configured-default-bytes') run.configuredDefaultBytes = Number(argv[++i]);
    else if (arg === '--arm') {
      const value = argv[++i] ?? '';
      if (!(ARM_ORDER as readonly string[]).includes(value)) throw new Error(`unknown arm: ${value}`);
      arms = [value as ArmName];
    } else if (arg === '--filter') filter = argv[++i];
    else if (arg === '--era') {
      const value = argv[++i] ?? '';
      if (!(value in PROTOCOL_ERAS)) throw new Error(`unknown protocol era: ${value}`);
      era = value as ProtocolEra;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: tsx packages/evals/src/cli.ts [--out <path>] [--arm fhir|compact|selected] [--filter <task-id-substring>] [--era modern|legacy] [--corpus baseline|query|projection|usability|all] [--profile full-text-v1|structured-evidence-v1] [--host <id>] [--stratum <name>] [--packaged-bin <path>] [--configured-max-bytes <n>] [--configured-default-bytes <n>] [--external-base-url <literal-loopback-fhir-base>] [--external-image-digest sha256:<pinned-image>]\n');
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return { out, arms, filter, era, run, externalBaseUrl, externalImageDigest };
}

function codeRevision(): string {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', timeout: 5000 }).trim().length > 0;
    return dirty ? `${head}+dirty` : head;
  } catch { return 'unknown'; }
}

function packageVersion(): string {
  const directory = dirname(fileURLToPath(import.meta.url));
  for (const relative of ['../../..', '../../../..']) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(directory, relative, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (parsed.name === '@fireboat/gateway' && parsed.version) return parsed.version;
    } catch { /* Source and compiled entry points have different roots. */ }
  }
  return 'unknown';
}

async function main(): Promise<void> {
  const { out, arms, filter, era, run, externalBaseUrl, externalImageDigest } = parseArgs(process.argv.slice(2));
  const tasks = filter ? TASKS.filter(t => t.id.includes(filter)) : undefined;
  if (tasks && !tasks.length) throw new Error(`no tasks match --filter ${filter}`);
  if (externalBaseUrl) run.externalBackend = await prepareExternalBackend(externalBaseUrl, externalImageDigest);
  const report = await runEvals({ ...run, tasks, arms, era, codeRevision: codeRevision(), packageVersion: packageVersion() });
  const outPath = resolve(out);
  mkdirSync(dirname(outPath), { recursive: true });
  // The report keeps failure details (resource ids, values, markers); it is created owner-only and stdout never echoes them.
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`retrieval-conformance eval (deterministic oracle scripts, synthetic only, no LLM)\n`);
  process.stdout.write(`${report.denominator.statement}; task/format runs are not independent cases\n`);
  process.stdout.write(`fixture sha256 ${report.fixture.sha256} resources=${report.fixture.resource_count}+${report.fixture.adversarial_resource_count} adversarial revision=${report.code_revision}\n`);
  process.stdout.write(`protocol era=${report.protocol.era} version=${report.protocol.negotiated_version}; bytes are measured MCP result values, not gateway accounting\n`);
  for (const arm of report.summary.by_arm) {
    process.stdout.write(
      `arm=${arm.arm} tasks ${arm.tasks_passed}/${arm.tasks_attempted} passed, ${arm.tasks_pending_profile_proof} pending_profile_proof, ${arm.tasks_private_profile_control} private_profile_control, ${arm.tasks_known_defect} known-defect, ${arm.tasks_failed} failed; checks ${arm.checks_passed}/${arm.checks_comparable} comparable passed, `
      + `${arm.checks_pending_profile_proof} pending_profile_proof, ${arm.checks_known_defect} known-defect, ${arm.checks_incomparable} incomparable, bytes=${arm.total_result_bytes} upstream_calls=${arm.total_upstream_calls} tool_calls=${arm.total_tool_calls}\n`,
    );
  }
  for (const pending of report.summary.pending_profile_proof) process.stdout.write(`  PENDING_PROFILE_PROOF ${pending.task_id} arm=${pending.arm} ${pending.milestone} ${pending.profile}: ${pending.reason}\n`);
  process.stdout.write(`private-profile controls (excluded from public pass totals): ${report.summary.private_profile_controls.length}\n`);
  for (const control of report.summary.private_profile_controls) process.stdout.write(`  PRIVATE_PROFILE_CONTROL ${control.task_id} arm=${control.arm} profile=${control.profile.id} eligible=${control.profile.eligible} verdict=${control.verdict} checks=${control.checks_passed} pass/${control.checks_failed} fail\n`);
  for (const result of report.results) for (const part of result.skipped_profile_parts ?? []) process.stdout.write(`  PENDING_PROFILE_PART ${result.task_id} arm=${result.arm} step=${part.step} ${part.part}: ${part.reason}\n`);
  const accounting = report.summary.byte_accounting;
  process.stdout.write(`gateway byte accounting vs measured: ${accounting.under_reported_calls}/${accounting.calls} calls under-reported (max ${accounting.max_under_report_bytes} B), ${accounting.over_reported_calls} over-reported (max ${accounting.max_over_report_bytes} B)\n`);
  const known = new Map<string, { jid: string; summary: string; arms: string[] }>();
  for (const defect of report.summary.known_defects.filter(d => d.reproduced)) {
    const key = `${defect.task_id} ${defect.jid} ${defect.summary}`;
    known.set(key, { jid: defect.jid, summary: `${defect.task_id}: ${defect.summary}`, arms: [...(known.get(key)?.arms ?? []), defect.arm] });
  }
  for (const defect of known.values()) process.stdout.write(`  KNOWN-DEFECT ${defect.jid} ${defect.summary} [arms ${defect.arms.join(',')}]\n`);
  const causes = Object.entries(report.summary.failures_by_cause);
  if (causes.length) {
    process.stdout.write(`failures by cause (including known defects): ${causes.map(([cause, n]) => `${cause}=${n}`).join(' ')}\n`);
    for (const result of report.results.filter(r => r.status === 'fail')) {
      for (const failure of result.failures.filter(f => !f.known_defect)) process.stdout.write(`${ordinaryFailureLine(result, failure)}\n`);
    }
    process.stdout.write('failure details are recorded only in the report file\n');
  }
  process.stdout.write(`elapsed_ms (descriptive only): ${report.timing_descriptive_only.total_elapsed_ms}\n`);
  process.stdout.write(`report written to ${outPath}\n`);
  process.exitCode = exitCodeForReport(report);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMainModule()) {
  main().catch(error => {
    process.stderr.write(`retrieval eval failed to run: ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exitCode = 2;
  });
}
