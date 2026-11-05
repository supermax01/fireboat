/** B2-0 (§6): the isolation suite entry. Runs every tests/isolation/*.test.ts under one run id, then aggregates the
 * prerequisites and the family shards into artifacts/b2/<run>/report.json. Either step failing fails the run.
 *   node tests/isolation/run.mjs            (npm run test:isolation) */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
const runId = process.env.B2_RUN_ID ?? `local-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}`;
const attemptId = randomUUID();
const directory = join('artifacts', 'b2', runId); mkdirSync(directory, { recursive: true });
// Exclusive creation refuses accidental reuse of a previous attempt. No signature/authentication claim.
writeFileSync(join(directory, 'attempt.json'), JSON.stringify({ run_id: runId, attempt_id: attemptId }), { flag: 'wx', mode: 0o600 });
const env = { ...process.env, B2_RUN_ID: runId, B2_ATTEMPT_ID: attemptId };
const files = readdirSync('tests/isolation').filter(f => f.endsWith('.test.ts')).sort().map(f => `tests/isolation/${f}`);
const run = (args) => new Promise(resolve => spawn(process.execPath, args, { stdio: 'inherit', env }).on('close', code => resolve(code ?? 1)));
const kills = process.argv.includes('--with-kills') ? await run(['--import', 'tsx', 'tests/isolation/mutants.mjs', '--run', runId]) : 0;
const tests = await run(['--import', 'tsx', '--test', ...files]);
const aggregate = await run(['--import', 'tsx', 'tests/isolation/aggregate.ts']);
process.stdout.write(`# B2 RUN ${runId}: tests exit ${tests}, aggregate exit ${aggregate}\n`);
process.exitCode = kills || tests || aggregate ? 1 : 0;
