import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, loadManifest, parseCoverageMatrix, parseKillMatrix, parseLedger, readDesign, readIsolationFile, registryMutants, verifyLedgerDesign } from './case-schema.js';
import { AggregateError, candidateInfo, computeGate, gateProblems, readKills, runBinding, runContext, sameBinding, verifyBudgetProvenance, verifyPins, casesDigest, type RunBinding } from './report.js';
import { reportReadiness, validateAggregate, type CaseReport } from './runner.js';
import { z } from 'zod';
import { ShardSchema, PrerequisitesSchema, parseEvidence, parseEvidenceJSON } from './evidence.js';
import { selectedCases, selection, type ShardReport } from './shard.js';
export { AggregateError } from './report.js';
export interface PrerequisitesFile { schema_version: 'b2-prerequisites/1'; run_id: string; binding: { start: RunBinding; end: RunBinding }; checks: Record<string, unknown> }
/** B2-0 (§6): one aggregate per run directory. It needs a non-empty valid selection, one prerequisites file and exactly
 * one shard per selected family, each bound (start and end) to the candidate, build, pins and environment this
 * aggregate recomputes (review H2), with the same manifest and run id; then coverage-checked cells, the gate, the pins,
 * the ledger's design digest, the kill evidence and budget provenance. Every refusal is a coded AggregateError. */
export async function aggregateRun(runId: string = process.env.B2_RUN_ID ?? 'unbound', options: { compatibilityCopy?: boolean } = {}) {
  const dir = join('artifacts', 'b2', runId);
  const manifest = await loadManifest();
  const chosen = selection();
  if (chosen.raw !== undefined && chosen.ids.length === 0) throw new AggregateError('selection-empty', 'B2_CASE_IDS is set but names no case');
  const unknown = chosen.ids.filter(id => !manifest.cases.some(c => c.id === id));
  if (unknown.length) throw new AggregateError('selection-unknown', unknown.join(','));
  const selected = selectedCases(manifest);
  if (!selected.length) throw new AggregateError('selection-empty');
  const binding = await runBinding();
  if (!binding.attempt_id || binding.run_id !== runId) throw new AggregateError('attempt-missing');
  const attemptPath = join(dir, 'attempt.json');
  if (!existsSync(attemptPath)) throw new AggregateError('attempt-missing');
  const attempt = parseEvidence(z.strictObject({ run_id: z.string(), attempt_id: z.string().min(1) }), parseEvidenceJSON(readFileSync(attemptPath, 'utf8'), 'attempt-json'), 'attempt-shape');
  if (attempt.run_id !== runId || attempt.attempt_id !== binding.attempt_id) throw new AggregateError('attempt-binding');
  if (!binding.build.matches_sources) throw new AggregateError('build-unverified');
  const prerequisitesPath = join(dir, 'prerequisites.json');
  if (!existsSync(prerequisitesPath)) throw new AggregateError('prerequisites-missing', dir);
  const prerequisites = parseEvidence(PrerequisitesSchema, parseEvidenceJSON(readFileSync(prerequisitesPath, 'utf8'), 'prerequisites-json'), 'prerequisites-shape');
  if (prerequisites.schema_version !== 'b2-prerequisites/1' || prerequisites.run_id !== runId) throw new AggregateError('prerequisites-run', String(prerequisites.run_id));
  if (!sameBinding(prerequisites.binding?.start, binding) || !sameBinding(prerequisites.binding?.end, binding)) throw new AggregateError('prerequisites-binding');
  const families = [...new Set(selected.map(c => c.family))].sort();
  const shardFiles = readdirSync(dir).filter(f => /^shard-[A-Z]{3}\.json$/.test(f)).sort();
  const present = shardFiles.map(f => f.slice(6, 9)).sort();
  if (present.join() !== families.join()) throw new AggregateError('shard-set', `expected ${families.join(',')} got ${present.join(',')}`);
  const manifestSha = hash(readIsolationFile('cases-v1.json'));
  const reports: CaseReport[] = [];
  for (const file of shardFiles) {
    const shard = parseEvidence(ShardSchema, parseEvidenceJSON(readFileSync(join(dir, file), 'utf8'), 'shard-json'), 'shard-shape');
    if (shard.schema_version !== 'b2-shard/2' || shard.family !== file.slice(6, 9)) throw new AggregateError('shard-shape', file);
    if (shard.manifest_sha256 !== manifestSha) throw new AggregateError('shard-manifest', file);
    if (shard.run_id !== runId) throw new AggregateError('shard-run', file);
    const { cases_sha256, ...end } = shard.binding.end;
    if (!sameBinding(shard.binding?.start, binding) || !sameBinding(end, binding)) throw new AggregateError('shard-binding', file);
    if (shard.cases.some(c => c.family !== shard.family)) throw new AggregateError('shard-family', file);
    reports.push(...shard.cases);
  }
  if (new Set(reports.map(r => r.id)).size !== reports.length) throw new AggregateError('duplicate-case');
  validateAggregate(reports, selected.map(c => c.id), selected);
  for (const file of shardFiles) {
    const shard = parseEvidence(ShardSchema, parseEvidenceJSON(readFileSync(join(dir, file), 'utf8'), 'shard-json'), 'shard-shape');
    if (shard.binding.end.cases_sha256 !== casesDigest(shard.cases)) throw new AggregateError('shard-cases-digest', file);
  }
  const mutants = await registryMutants(); const killMatrix = parseKillMatrix(); const ledger = parseLedger(); const coverage = parseCoverageMatrix();
  const pins = verifyPins(manifest, mutants, killMatrix);
  let designVerified = false; try { designVerified = verifyLedgerDesign(ledger, readDesign()); } catch { designVerified = false; }
  const inputsSha256 = binding.inputs_sha256 ?? undefined;
  const candidate = { ...candidateInfo(), inputs: { commit: binding.commit, tree: binding.tree, inputsSha256 }, build: binding.build };
  const run = runContext(process.env, { dirty: candidate.dirty, pinMismatches: [...pins.map(p => p.key), ...(designVerified ? [] : ['ledger_design'])], installedPackageLane: false, shardsComplete: true });
  const { kills, problems: killProblems } = await readKills(runId, inputsSha256, dir, { binding, matrix: killMatrix, mutants, cases: manifest.cases });
  const unprovenBudgets = verifyBudgetProvenance(manifest.cases, id => { const path = join('artifacts', 'b2', id, 'report.json'); return existsSync(path) ? readFileSync(path, 'utf8') : undefined; });
  const gate = computeGate(manifest, ledger, coverage, reports, run, kills, inputsSha256, false, null, { unprovenBudgets });
  const families_summary: Record<string, Record<string, number>> = {};
  for (const report of reports) { const f = families_summary[report.family] ??= {}; f[report.verdict] = (f[report.verdict] ?? 0) + 1; }
  const status = reportReadiness(prerequisites.checks ?? {}, pins.length === 0 && designVerified);
  const report = { status, schema_version: 'b2-isolation-report/3', run_id: runId, diagnostic: gate.diagnostic, acceptance_gate: gate.acceptance_gate, b2_gate: gate.b2_gate, gate, run, binding,
    pins: { verified: pins.length === 0, mismatches: pins, ledger_design_verified: designVerified }, candidate, kills: { credited: kills.length, problems: killProblems },
    manifest: { suite_id: manifest.suite_id, scope_revision: manifest.scope_revision, hashes: manifest.hashes, frozen_ids: manifest.frozen_ids.length, counted: manifest.cases.filter(c => c.counted).length, aliases: manifest.aliases.length, catalogue: manifest.catalogue.length },
    prerequisites: prerequisites.checks, families: families_summary, shards: shardFiles, cases: reports,
    limitations: 'Development run: earned is 0 by construction until a qualifying run on the installed package (S9) with a clean candidate, a fresh build, matching pins and every kill-matrix row killed on the same candidate; counts_toward_b2 is computed per case in gate.standings, never stored on a case.' };
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (options.compatibilityCopy !== false) { mkdirSync('artifacts', { recursive: true }); writeFileSync(join('artifacts', 'isolation-v1-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); }
  return { report, problems: gateProblems({ status, pins, reports, gate, killProblems, designVerified }) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { report, problems } = await aggregateRun();
  process.stdout.write(`# B2 AGGREGATE run=${report.run_id} status=${report.status} earned=${report.gate.earned} cases=${report.cases.length} families=${JSON.stringify(report.families)}\n`);
  if (problems.length) { process.stdout.write(`# B2 AGGREGATE problems: ${problems.join('; ')}\n`); process.exitCode = 1; }
}
