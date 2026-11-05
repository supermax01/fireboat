/**
 * S6 search-profile qualification (root-owned; spec §7 Q-2, non-circular order). Runs the labelled PRIVATE
 * candidate of a declared, still-ineligible profile through the retrieval evals in both eras and every arm,
 * requires every profile-dependent task to pass with ordinary verdicts and zero failures, and prints the
 * evidence block root records in packages/core/src/data/search-profiles.json. The script never edits the
 * registry, never marks anything eligible, and uses only the synthetic eval fixture.
 *   node --import tsx scripts/qualify-search-profile.ts [profile-id] [out-dir]
 * Outputs: <out-dir>/report-<era>.json (raw reports; the evidence commits to their hash) and
 * <out-dir>/qualification.md (the summary root copies into docs/evidence).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FhirGateway } from '../packages/core/src/index.js';
import { declaredSearchProfile } from '../packages/core/src/query.js';
import { EVAL_PATIENT_ID, EVAL_SOURCE_ALIAS, canonicalJson, exitCodeForReport, fixtureSha256, parseM3bTaskFile, runEvals, startEvalFixtureServer } from '../packages/evals/src/index.js';
import { fixtureBackendSha256, loadEvalCorpus } from '../packages/evals/src/fixture.js';

const id = process.argv[2] ?? 'synthetic-fixture-r4-v1';
const outDir = process.argv[3] ?? '.local/s6-qualification';
const declared = declaredSearchProfile(id);
if (!declared) throw new Error(`unknown search profile ${id}`);
// The candidate keeps the public id (evidence_ref values are the public reference) but is explicitly ineligible
// and unevidenced whatever the registry says: only the private constructor seam can brand it, and every row is a
// private_profile_control. Re-qualifying an already eligible profile replaces its evidence (fixture/backend/corpus drift).
if (declared.eligible || declared.evidence) console.error(`note: ${id} is currently eligible; this run re-qualifies it and its recorded evidence must be replaced`);
const candidate = { ...declared, eligible: false, evidence: null };
mkdirSync(outDir, { recursive: true });

const corpus = loadEvalCorpus();
const fragmentResources = corpus.byCorpus.query!.slice(corpus.byCorpus.baseline!.length);
const fixture = await startEvalFixtureServer(corpus.resources, corpus.rawBodies);
let capabilityRevision: string;
try {
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: EVAL_SOURCE_ALIAS, baseUrl: fixture.baseUrl }, patientId: EVAL_PATIENT_ID, contextId: 'eval-context-v0' } as never);
  const metadata = await gateway.execute('fhir_capabilities', { topic: 'server' });
  if (metadata.error) throw new Error(`metadata discovery failed: ${metadata.error.code}`);
  capabilityRevision = metadata.source.capability_revision;
} finally { await fixture.close(); }

const lines: string[] = [`# S6 qualification run: ${id}`, '', `Private labelled candidate (public id, eligible=false, evidence=null) through the constructor seam; full retrieval corpus, every arm, both eras. Recorded ${new Date().toISOString()}.`, ''];
const reports: Record<string, unknown> = {};
// Every profile-dependent task (the ones the runner routes through the candidate) must run in every arm as a
// private control under exactly this candidate's id, pass with no failure, pend nothing, and the public run must
// have no failure anywhere. Evidence is emitted only after all of that holds for both eras.
const profileTaskIds = new Set<string>();
const problems: string[] = [];
for (const era of ['modern', 'legacy'] as const) {
  const report = await runEvals({ era }, { testQueryProfile: candidate as never });
  reports[era] = report;
  writeFileSync(join(outDir, `report-${era}.json`), JSON.stringify(report, null, 1));
  const controls = report.results.filter(row => row.status === 'private_profile_control');
  for (const row of controls) profileTaskIds.add(row.task_id);
  const failed = controls.filter(row => row.private_profile_verdict !== 'pass' || row.failures.length > 0);
  const mislabelled = controls.filter(row => row.query_profile.id !== id || row.query_profile.private !== true || row.calls.some(call => call.query_profile.id !== id || !call.query_profile.private));
  const pending = report.summary.pending_profile_proof.length;
  const exit = exitCodeForReport(report);
  const expectedControls = profileTaskIds.size * report.summary.by_arm.length;
  lines.push(`## ${era}`, '', `- private profile controls: ${controls.length} rows (${profileTaskIds.size} tasks × ${report.summary.by_arm.length} arms), ${failed.length} not passing, ${mislabelled.length} not labelled as this private candidate; pending_profile_proof rows: ${pending}; public failures by cause: ${JSON.stringify(report.summary.failures_by_cause)}; exit code ${exit}`, '',
    '| task | arm | verdict | failures |', '|---|---|---|---|',
    ...controls.map(row => `| ${row.task_id} | ${row.arm} | ${row.private_profile_verdict} | ${JSON.stringify(row.failures.map(f => f.cause))} |`), '');
  if (failed.length) problems.push(`${era}: ${failed.length} private control(s) did not pass`);
  if (mislabelled.length) problems.push(`${era}: ${mislabelled.length} control row(s) did not run under the private candidate ${id}`);
  if (controls.length !== expectedControls || controls.length === 0) problems.push(`${era}: ${controls.length} control rows, expected ${expectedControls}`);
  if (pending) problems.push(`${era}: ${pending} pending_profile_proof row(s)`);
  if (exit !== 0 || Object.keys(report.summary.failures_by_cause).length) problems.push(`${era}: public run not clean (exit ${exit}, ${JSON.stringify(report.summary.failures_by_cause)})`);
}
if (problems.length) {
  lines.push('## QUALIFICATION FAILED', '', ...problems.map(p => `- ${p}`), '', 'No evidence is emitted; nothing may be recorded in the registry.', '');
  writeFileSync(join(outDir, 'qualification.md'), lines.join('\n'));
  console.log(lines.join('\n'));
  console.error(`qualification FAILED: ${problems.join('; ')}`);
  process.exit(1);
}
const evidence = {
  report_sha256: createHash('sha256').update(canonicalJson(reports)).digest('hex'),
  recorded_at: new Date().toISOString(),
  capability_revision: capabilityRevision,
  tasks_sha256: createHash('sha256').update(canonicalJson(parseM3bTaskFile(readFileSync('packages/evals/data/m3b-query-tasks.json', 'utf8')))).digest('hex'),
};
const source = { fixture_sha256: fixtureSha256(undefined, undefined, undefined, fragmentResources), backend_sha256: fixtureBackendSha256() };
lines.push(`## Evidence to record (every control passed in both eras: ${[...profileTaskIds].sort().join(', ')})`, '', '```json', JSON.stringify({ evidence, source }, null, 2), '```', '',
  `Report files: ${['modern', 'legacy'].map(era => `${outDir}/report-${era}.json`).join(', ')} (hash over the canonical JSON of both reports).`, '');
writeFileSync(join(outDir, 'qualification.md'), lines.join('\n'));
console.log(lines.join('\n'));
