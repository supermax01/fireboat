/** Re-run reviewer-owned definitions verbatim on fresh copies in every SDK/core lane.
 * Usage: node tests/isolation/reviewer-trials.mjs [reviewer-definition-path]
 * Copies are always removed; only sanitized case/predicate reports persist. */
import { mkdtemp, cp, symlink, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { TRIALS } = await import(pathToFileURL(process.argv[2] ?? '/tmp/b2harn/trials.mjs').href);
const ids = ['T01-g3-target-admission', 'T02-g6-companion-mask', 'T03-g4-entry-origin', 'T06-shared-masks', 'T10-transport-origin', 'T19-escape-parser-ignored', 'T04-confinement-append'];
const root = process.cwd();
const work = await mkdtemp(join(tmpdir(), 'b2-round1-trials-'));
const results = [];
/** B2-0: a trial runs the full isolation entry (prerequisites, counting, every family shard, then the aggregate) in its
 * copy under its own run id, with no selection variable set: an empty B2_CASE_IDS is a selection of nothing. */
const execute = (dir, runId) => new Promise(resolveRun => {
  const env = { ...process.env, B2_RUN_ID: runId }; delete env.B2_CORE_ONLY; delete env.B2_CASE_IDS;
  const child = spawn(process.execPath, ['tests/isolation/run.mjs'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 1800000);
  child.on('close', async exit => { clearTimeout(timer); await writeFile(join(root, 'artifacts', `${dir.split('/').at(-1)}.tap`), output, { mode: 0o600 }); resolveRun(exit); });
});
try {
  await mkdir('artifacts', { recursive: true });
  const baseline = JSON.parse(await readFile('artifacts/isolation-v1-report.json', 'utf8'));
  for (let i = 0; i < ids.length; i += 3) await Promise.all(ids.slice(i, i + 3).map(async id => {
    const dir = join(work, id); await mkdir(dir);
    for (const file of ['packages', 'tests/isolation', 'scripts/mutation-guards.mjs', 'proposals/b2-isolation-suite-design.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']) await cp(join(root, file), join(dir, file), { recursive: true });
    await symlink(resolve('node_modules'), join(dir, 'node_modules'));
    for (const [file, find, replacement] of TRIALS[id].edits) {
      const path = join(dir, file); const source = await readFile(path, 'utf8');
      if (source.split(find).length !== 2) throw new Error(`${id}: reviewer anchor mismatch`);
      await writeFile(path, source.replace(find, replacement));
    }
    const runId = `trial-${id}`;
    const exit = await execute(dir, runId);
    const report = JSON.parse(await readFile(join(dir, 'artifacts', 'b2', runId, 'report.json'), 'utf8'));
    const failing = report.cases.filter(c => c.verdict === 'FAIL');
    const result = { id, description: TRIALS[id].description, exit, status: report.status, baseline_hashes: baseline.manifest?.hashes, newly_failing: failing.filter(c => baseline.cases.find(b => b.id === c.id)?.verdict !== 'FAIL').map(c => c.id), failures: failing.map(c => ({ id: c.id, cells: c.lanes.filter(l => l.verdict !== 'PASS').map(l => ({ lane: l.lane, run: l.run, verdict: l.verdict, failures: l.failures })) })) };
    results.push(result);
    await writeFile(join(root, 'artifacts', `${id}.json`), JSON.stringify(result, null, 2)+'\n', { mode: 0o600 });
    process.stdout.write(`${id}: ${result.newly_failing.join(',')}\n`);
  }));
  await writeFile('artifacts/isolation-round1-trials.json', JSON.stringify({ diagnostic: true, lanes: ['core','sdk-modern','sdk-legacy'], runs: 2, results }, null, 2)+'\n', { mode: 0o600 });
} finally { await rm(work, { recursive: true, force: true }); }
