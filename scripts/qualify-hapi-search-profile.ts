/** Opt-in independent backend qualification. No container management, registry edits, eligibility or evidence writes. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { externalApplicability, externalCandidate, externalCorpus, externalHash, EXTERNAL_SERVER_ADDITIONS, HAPI_BASE_URL, HAPI_IMAGE_DIGEST, prepareExternalBackend, verifyExternalBackend } from '../packages/evals/src/external.js';
import { externalQualificationProblems } from '../packages/evals/src/external-qualification.js';
import { runEvals, type EvalReport } from '../packages/evals/src/runner.js';

export async function qualifyHapiProfile(outDir: string): Promise<boolean> {
  const baseUrl = process.env.FHIR_MCP_HAPI_BASE_URL;
  if (!baseUrl) { console.log('SKIPPED: set FHIR_MCP_HAPI_BASE_URL to opt into the dedicated local HAPI qualification.'); return false; }
  mkdirSync(outDir, { recursive: true });
  const applicability = externalApplicability();
  const corpus = externalCorpus();
  const lines = ['# Independent local HAPI qualification', '',
    'This is synthetic retrieval evidence on one pinned local HAPI instance. It does not establish SMART authorization, clinical readiness, vendor support or general protocol compatibility.', '',
    `Corpus: ${corpus.resources.length} resources across ${corpus.types.length} evaluated types; exact transaction body digest ${corpus.sha256}.`,
    `Server-managed comparison exceptions: ${EXTERNAL_SERVER_ADDITIONS.join('; ')}. All other resource fields remain exact.`,
    'Image digest is an operator-attested immutable container pin; CapabilityStatement software/version and capability revision are independently read from the running backend.', '',
    '| omitted input fragment | resources | input SHA-256 | reason |', '|---|---:|---|---|',
    ...corpus.omitted.map(row => `| ${row.fragment} | ${row.resources} | ${row.sha256} | ${row.reason} |`), '',
    '| external input resource type | exact path | count | transformation | reason |', '|---|---|---:|---|---|',
    ...corpus.transformations.map(row => `| ${row.resource_type} | ${row.path} | ${row.count} | ${row.operation} | ${row.reason} |`), '',
    'These two transport input encodings are explicit corpus deviations. The original fixture objects, raw fixture bodies and every task expectation remain unchanged. Read-back comparison never ignores or normalizes payload fields.', '',
    '| task | corpus | applicability | profile control | retained synthetic regression | reason |', '|---|---|---|---|---|---|',
    ...applicability.map(row => `| ${row.task_id} | ${row.corpus} | ${row.classification} | ${row.profile_control} | ${row.retained_synthetic_task ?? ''} | ${row.reason} |`), '',
    'The two profile-inapplicable tasks require tested sort proof outside this candidate. Their strict expectations remain in the unchanged synthetic suite. All genuine HAPI drains and the generic cross-page honesty task remain in the real-backend denominator.', '',
  ];
  const writeSummary = () => writeFileSync(join(outDir, 'qualification.md'), `${lines.join('\n')}\n`);
  try {
    if (baseUrl !== HAPI_BASE_URL) throw new Error('The qualification endpoint must be the dedicated literal-loopback HAPI base.');
    const backend = await prepareExternalBackend(baseUrl, process.env.FHIR_MCP_HAPI_IMAGE_DIGEST ?? HAPI_IMAGE_DIGEST);
    lines.push('## Measured identity', '', '```json', JSON.stringify(backend.identity, null, 2), '```', '', 'This identity is a measurement, not qualification evidence.', '');
    const candidate = externalCandidate(backend);
    lines.push('## Private candidate', '', '```json', JSON.stringify(candidate, null, 2), '```', '');
    const reports: Record<string, EvalReport> = {};
    const problems: string[] = [];
    for (const era of ['modern', 'legacy'] as const) {
      const report = await runEvals({ era, externalBackend: backend }, { testQueryProfile: candidate });
      reports[era] = report;
      writeFileSync(join(outDir, `report-${era}.json`), `${JSON.stringify(report, null, 1)}\n`);
      problems.push(...externalQualificationProblems(report, backend.identity, candidate.id, era).map(problem => `${era}: ${problem}`));
      lines.push(`## ${era}`, '', `Expected: ${applicability.filter(row => row.classification === 'real-backend').length} real tasks × 3 arms; ${applicability.filter(row => row.profile_control).length} profile tasks × 3 arms.`, '',
        '| task | arm | status | private verdict | failed checks / causes |', '|---|---|---|---|---|',
        ...report.results.map(row => `| ${row.task_id} | ${row.arm} | ${row.status} | ${row.private_profile_verdict ?? ''} | ${row.failures.map(failure => `${failure.check_id ?? 'invariant'}:${failure.cause}`).join(', ')} |`), '',
        '### Accepted opaque source links', '',
        'These are eval observations of exact source-issued next links. They do not grant tested continuation, sort, or complete-query proof. Indices are one-based within each task/arm; only digests and request indices are recorded.', '',
        '| era | task | arm | request | issuer | confined root | chain SHA-256 | query SHA-256 | issued link SHA-256 |', '|---|---|---|---:|---:|---:|---|---|---|',
        ...report.results.flatMap(row => row.opaque_continuations.map(link => `| ${era} | ${row.task_id} | ${row.arm} | ${link.request_index} | ${link.issuing_request_index} | ${link.confined_root_request_index} | ${link.chain_sha256} | ${link.query_sha256} | ${link.issued_link_sha256} |`)), '');
      writeSummary();
    }
    await verifyExternalBackend(backend);
    if (problems.length) {
      const failedTasks = [...new Set(Object.values(reports).flatMap(report => report.results.filter(row => row.status !== 'pass' && row.private_profile_verdict !== 'pass').map(row => row.task_id)))].sort();
      lines.push('## QUALIFICATION FAILED', '', ...problems.map(problem => `- ${problem}`), '',
        `Applicable tasks failing in this run: ${failedTasks.join(', ') || '(qualification integrity check only)'}.`, '',
        'No evidence is emitted. Applicable failures retain their classification and strict expectations. The registry candidate remains ineligible with null evidence.', '');
      writeSummary();
      console.log(lines.join('\n'));
      return false;
    }
    const evidence = { report_sha256: externalHash(reports), recorded_at: new Date().toISOString(), capability_revision: backend.identity.capability_revision, tasks_sha256: backend.identity.tasks_sha256 };
    lines.push('## Evidence candidate for root review', '', '```json', JSON.stringify({ source: candidate.source, evidence }, null, 2), '```', '',
      'No registry mutation occurred. Public selection after an independently approved registry change is still required.', '');
    writeSummary();
    console.log(lines.join('\n'));
    return true;
  } catch (error) {
    lines.push('## QUALIFICATION FAILED BEFORE EVIDENCE', '', error instanceof Error ? error.message : 'External qualification failed.', '', 'No evidence is emitted; nothing may be recorded in the registry.', '');
    writeSummary();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.FHIR_MCP_HAPI_BASE_URL) {
    try { if (!await qualifyHapiProfile(process.argv[2] ?? '.local/gbackend-qualification')) process.exitCode = 1; }
    catch { console.error('HAPI qualification stopped before evidence; inspect qualification.md for the bounded failure stage.'); process.exitCode = 1; }
  } else await qualifyHapiProfile(process.argv[2] ?? '.local/gbackend-qualification');
}
