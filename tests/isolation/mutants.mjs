/** Diagnostic kill evidence for the B2 kill matrix (B2-0 §6, D9).
 *   node tests/isolation/mutants.mjs [--mutants id,id] [--run <run-id>]
 * Each selected kill-matrix row is applied as an exact one-anchor edit in a fresh scratch copy, built there, and run
 * against only its designated and spare cases through the family shards. A row is KILLED when every cell of every
 * designated case fails on the row's named oracle and every spare case passes; SURVIVED when every designated case
 * passes; INVALID when the anchor does not match exactly once or the copy does not build; INCONCLUSIVE otherwise.
 * Records bind to the candidate's inputs hash, which the aggregator recomputes before crediting them. Scratch copies
 * are removed on exit. Never invokes or edits mutation-guards main. Not B2 qualification: that needs the installed
 * package lane (S9). */
import { MUTANTS, mutationEdits, candidateBinding } from '../../scripts/mutation-guards.mjs';
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { register } from 'tsx/esm/api';
register();
const { ensureBuilt, distDigest } = await import('./build.ts');
const { runBinding } = await import('./report.ts');
const { occurrences } = await import('./case-schema.ts');
import { createHash, randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const argValue = key => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
const only = argValue('--mutants')?.split(',').filter(Boolean);
const runId = argValue('--run') ?? `mutants-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}`;
process.env.B2_RUN_ID = runId;
const attemptDir = join('artifacts', 'b2', runId); await mkdir(attemptDir, { recursive: true });
if (!process.env.B2_ATTEMPT_ID) {
  process.env.B2_ATTEMPT_ID = randomUUID();
  await writeFile(join(attemptDir, 'attempt.json'), JSON.stringify({ run_id: runId, attempt_id: process.env.B2_ATTEMPT_ID }), { flag: 'wx', mode: 0o600 });
}
await ensureBuilt();
const runEvidenceBinding = await runBinding();
const coreOnly = process.env.B2_CORE_ONLY === '1';
const root = process.cwd();
const sha = value => createHash('sha256').update(value).digest('hex');
const killMatrix = JSON.parse(await readFile('tests/isolation/kill-matrix.json', 'utf8'));
const manifest = JSON.parse(await readFile('tests/isolation/cases-v1.json', 'utf8'));
const familyOf = new Map(manifest.cases.map(c => [c.id, c.family]));
const rows = killMatrix.rows.filter(row => !only || only.includes(row.mutant_id));
if (only) for (const id of only) if (!rows.some(r => r.mutant_id === id)) throw new Error(`${id} is not a kill-matrix row`);
const binding = await candidateBinding(root);
const work = await mkdtemp(join(tmpdir(), 'b2-mutants-'));
const seedCopy = async name => {
  const target = join(work, name); await mkdir(target);
  for (const file of ['packages', 'examples', 'tests/isolation', 'scripts/mutation-guards.mjs', 'scripts/stage-runtime-assets.mjs', 'scripts/generate-release-metadata.mjs', 'scripts/check-dist-identity.mjs', 'proposals/b2-isolation-suite-design.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']) await cp(join(root, file), join(target, file), { recursive: true });
  await symlink(resolve('node_modules'), join(target, 'node_modules')); return target;
};
/** Runs only the shards of the given cases; ensureBuilt() in each shard builds the copy once under the build lock. */
const runCases = (dir, ids) => {
  const families = [...new Set(ids.map(id => familyOf.get(id)))].sort();
  if (families.some(f => f === undefined)) throw new Error(`unknown case among ${ids.join(',')}`);
  const env = { PATH: process.env.PATH, B2_CASE_IDS: ids.join(','), B2_RUN_ID: runId, B2_ATTEMPT_ID: process.env.B2_ATTEMPT_ID, ...(coreOnly ? { B2_CORE_ONLY: '1' } : {}) };
  const files = families.map(f => `tests/isolation/cases-${f.toLowerCase()}.test.ts`);
  let exit = 0; let output = '';
  try { output = execFileSync(process.execPath, ['--import', 'tsx', '--test', ...files], { cwd: dir, env, encoding: 'utf8', timeout: 1800000, maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { exit = e.status ?? -1; output = String(e.stdout ?? ''); }
  return { exit, output_hash: sha(output), families };
};
const readCases = async (dir, families) => {
  const cases = new Map();
  for (const family of families) {
    const shard = JSON.parse(await readFile(join(dir, 'artifacts', 'b2', runId, `shard-${family}.json`), 'utf8'));
    for (const c of shard.cases) cases.set(c.id, c);
  }
  return cases;
};
const cellCount = coreOnly ? 2 : 6;
const oracleHit = (cell, oracle) => { const [channel, predicate] = oracle.split(/:(.*)/s); return cell.failures.some(f => f.channel === channel && f.predicate === predicate); };
const results = []; const kills = [];
try {
  const designated = [...new Set(rows.flatMap(r => [...r.kills.map(k => k.case_id), ...r.spares]))].sort();
  const baseline = await seedCopy('baseline');
  const baselineRun = runCases(baseline, designated);
  const baselineCases = await readCases(baseline, baselineRun.families);
  const red = designated.filter(id => baselineCases.get(id)?.verdict !== 'PASS');
  if (baselineRun.exit || red.length) throw new Error(`designated baseline does not pass (${red.join(',') || `exit ${baselineRun.exit}`}); mutation evidence invalid`);
  for (const row of rows) {
    const mutation = MUTANTS.find(m => m.id === row.mutant_id);
    const ids = [...row.kills.map(k => k.case_id), ...row.spares];
    const evidence = { mutant_id: row.mutant_id, intent: row.intent, designated: row.kills, spares: row.spares, anchor_matches: [], compiled: false, compile_exit: null, build_output_sha256: null, baseline: { exit: baselineRun.exit, cases: ids.map(id => baselineCases.get(id)) }, cases: [], verdict: 'INVALID', detail: '' };
    if (!mutation) { evidence.detail = 'not registered in scripts/mutation-guards.mjs'; }
    else {
      const dir = await seedCopy(row.mutant_id);
      const edits = mutationEdits(mutation);
      for (const edit of edits) {
        const path = join(dir, edit.file); const source = await readFile(path, 'utf8');
        const matches = occurrences(source, edit.find); evidence.anchor_matches.push({ file: edit.file, edit_sha256: sha(JSON.stringify([edit.file, edit.find, edit.replace])), matches });
        if (matches === 1) await writeFile(path, source.replace(edit.find, edit.replace));
      }
      if (evidence.anchor_matches.every(a => a.matches === 1)) {
        try { execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { cwd: dir, stdio: 'pipe' }); evidence.compiled = true; evidence.compile_exit = 0; }
        catch { evidence.compile_exit = 1; evidence.detail = 'mutant does not build'; }
      } else evidence.detail = 'anchor must match exactly once';
      if (evidence.compiled) {
        const execution = runCases(dir, ids); evidence.exit = execution.exit; evidence.output_hash = execution.output_hash;
        const cases = await readCases(dir, execution.families);
        evidence.cases = ids.map(id => cases.get(id));
        evidence.build_output_sha256 = distDigest(dir);
        const killedAll = row.kills.every(k => { const c = cases.get(k.case_id); return c && c.lanes.length === cellCount && c.lanes.every(l => l.verdict === 'FAIL' && oracleHit(l, k.oracle)); });
        const sparesPass = row.spares.every(id => cases.get(id)?.verdict === 'PASS');
        const survivedAll = row.kills.every(k => cases.get(k.case_id)?.verdict === 'PASS');
        evidence.verdict = killedAll && sparesPass ? 'KILLED' : survivedAll ? 'SURVIVED' : 'INCONCLUSIVE';
        evidence.detail = evidence.verdict === 'KILLED' ? `named oracle reproduced in ${cellCount} cells of ${row.kills.length} case(s); ${row.spares.length} spare(s) pass` : evidence.verdict === 'SURVIVED' ? 'every designated case passed' : `cells: ${evidence.cases.map(c => `${c.id}=${c.verdict}`).join(' ')}`;
      }
    }
    results.push(evidence);
    for (const k of row.kills) kills.push({ mutant_id: row.mutant_id, case_id: k.case_id, oracle: k.oracle, verdict: evidence.verdict, inputs_sha256: binding.inputsSha256 });
    process.stdout.write(`${row.mutant_id}: ${evidence.verdict}${evidence.detail ? ` (${evidence.detail})` : ''}\n`);
  }
  const dir = join('artifacts', 'b2', runId); await mkdir(dir, { recursive: true });
  const report = { schema_version: 'b2-kills/1', run_id: runId, diagnostic: true, scope: 'kill-matrix rows judged on the source tree through the family shards; not B2 qualification (installed-package lane pending, S9)',
    binding: runEvidenceBinding, candidate: { commit: binding.commit, tree: binding.tree, inputs_sha256: binding.inputsSha256 }, core_only: coreOnly, cells_per_case: cellCount, rows: results, kills, work_trees_cleaned_on_exit: true };
  await writeFile(join(dir, 'kills.json'), `${JSON.stringify(report, null, 1)}\n`, { mode: 0o600 });
  process.stdout.write(`# B2 KILLS run=${runId} rows=${results.length} killed=${results.filter(r => r.verdict === 'KILLED').length} -> ${join(dir, 'kills.json')}\n`);
  if (results.some(r => r.verdict !== 'KILLED')) process.exitCode = 1;
} finally { await rm(work, { recursive: true, force: true }); }
