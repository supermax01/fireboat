/** Regenerate content pins after reviewing intended task/corpus edits. Does not change applicability decisions. */
import { readFileSync, writeFileSync } from 'node:fs';
import { externalHash, externalTasks } from '../packages/evals/src/external.js';
import { parseM3bTaskFile } from '../packages/evals/src/tasks.js';
const rowsPath = 'packages/evals/data/external-applicability.json';
const rows = JSON.parse(readFileSync(rowsPath, 'utf8'));
const tasks = new Map(externalTasks().map(task => [task.id, task]));
if (rows.tasks.length !== tasks.size) throw new Error('Applicability must be reviewed and total before regenerating pins.');
for (const row of rows.tasks) {
  const task = tasks.get(row.task_id);
  if (!task) throw new Error(`Unknown task ${row.task_id}`);
  row.task_sha256 = externalHash(task);
}
writeFileSync(rowsPath, `${JSON.stringify(rows, null, 2)}\n`);
const externalPath = 'packages/evals/src/external.ts';
const external = readFileSync(externalPath, 'utf8').replace(/(externalHash\(\[\.\.\.rows\]\.sort\(\(a, b\) => a.task_id.localeCompare\(b.task_id\)\)\) !== ')[a-f0-9]{64}/,
  `$1${externalHash([...rows.tasks].sort((a, b) => a.task_id.localeCompare(b.task_id)))}`);
writeFileSync(externalPath, external);
const mutationFile = 'scripts/mutation-guards.mjs';
let mutations = readFileSync(mutationFile, 'utf8');
mutations = mutations.replace(/(if \(externalHash\(\[\.\.\.rows\]\.sort\(\(a, b\) => a.task_id.localeCompare\(b.task_id\)\)\) !== ')[a-f0-9]{64}/,
  `$1${externalHash([...rows.tasks].sort((a, b) => a.task_id.localeCompare(b.task_id)))}`);
writeFileSync(mutationFile, mutations);

const pinPath = 'tests/eval-corpus-pin.test.ts';
let pins = readFileSync(pinPath, 'utf8');
for (const path of ['packages/evals/data/m3b-query-tasks.json', 'packages/evals/data/m3b-projection-tasks.json', 'packages/evals/data/s7a-usability-tasks.json']) {
  const corpus = parseM3bTaskFile(readFileSync(path, 'utf8'));
  const line = `  '${path}': { tasks: ${corpus.length}, checks: ${corpus.reduce((n, task) => n + task.checks.length, 0)}, sha256: '${externalHash(corpus)}' },`;
  pins = pins.replace(pins.split('\n').find(line => line.startsWith(`  '${path}':`))!, line);
}
writeFileSync(pinPath, pins);
const projection = parseM3bTaskFile(readFileSync('packages/evals/data/m3b-projection-tasks.json', 'utf8'));
const guidancePath = 'tests/no-matches.test.ts';
let guidance = readFileSync(guidancePath, 'utf8');
guidance = guidance.replace(/assert.equal\(tasks.length, \d+\);/, `assert.equal(tasks.length, ${projection.length});`)
  .replace(/assert.equal\(tasks.reduce\(\(sum, task\) => sum \+ task.checks.length, 0\), \d+\);/, `assert.equal(tasks.reduce((sum, task) => sum + task.checks.length, 0), ${projection.reduce((n, task) => n + task.checks.length, 0)});`);
writeFileSync(guidancePath, guidance);

console.log(`EVAL_PINS_OK tasks=${tasks.size} applicability=${externalHash([...rows.tasks].sort((a, b) => a.task_id.localeCompare(b.task_id)))}`);
