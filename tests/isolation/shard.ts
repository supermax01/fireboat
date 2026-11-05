import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash, loadManifest, parseManifest, readIsolationFile, type IsolationCase, type Manifest } from './case-schema.js';
import { ensureBuilt } from './build.js';
import { runBinding, casesDigest, type RunBinding } from './report.js';
import { runCase, type CaseReport } from './runner.js';
/** B2-0 (§6): one static test file per family registers that family's cases. At import only the schema is parsed;
 * the full loader runs inside each case test (memoized), so a loader defect is a named failure, not an import crash.
 * Titles stay `${id} ${family} diagnostic attack/control matrix` so historical judge kill names remain valid (D12). */
export const runDirectory = () => join('artifacts', 'b2', process.env.B2_RUN_ID ?? 'unbound');
/** The case selection. A set B2_CASE_IDS is a selection even when it names nothing (review M8); the aggregator refuses
 * an empty selection and unknown ids, shards simply select what exists. */
export function selection(env: NodeJS.ProcessEnv = process.env): { raw: string | undefined; ids: string[] } {
  const raw = env.B2_CASE_IDS;
  return { raw, ids: raw === undefined ? [] : raw.split(',').map(s => s.trim()).filter(Boolean) };
}
export const selectedCases = (manifest: Manifest, family?: string) => {
  const { raw, ids } = selection();
  return manifest.cases.filter(c => (family === undefined || c.family === family) && (raw === undefined || ids.includes(c.id)));
};
export interface ShardReport { schema_version: 'b2-shard/2'; family: string; run_id: string; manifest_sha256: string; binding: { start: RunBinding; end: RunBinding & { cases_sha256?: string } }; cases: CaseReport[] }
export function writeShardReport(family: string, reports: CaseReport[], binding: ShardReport['binding']): ShardReport {
  const shard: ShardReport = { schema_version: 'b2-shard/2', family, run_id: process.env.B2_RUN_ID ?? 'unbound', manifest_sha256: hash(readIsolationFile('cases-v1.json')), binding: { start: binding.start, end: { ...binding.end, cases_sha256: casesDigest(reports) } }, cases: reports };
  mkdirSync(runDirectory(), { recursive: true });
  writeFileSync(join(runDirectory(), `shard-${family}.json`), `${JSON.stringify(shard, null, 1)}\n`, { mode: 0o600 });
  return shard;
}
/** D3: a known failure runs as a node:test TODO (the judge baseline stays green) while the report still records its FAIL
 * and the gate stays blocked. The per-case timeout covers six expiring cells, each its deadline plus conservative close/settle and backend start/close (review L6), so the watchdog always decides before node:test does. */
export const caseTestOptions = (c: Pick<IsolationCase, 'budgets' | 'known_failure'>) => ({ timeout: 6 * (c.budgets.deadline_ms + 15000) + 30000, ...(c.known_failure ? { todo: c.known_failure.reason } : {}) });
export async function registerFamily(family: string): Promise<void> {
  const manifest = parseManifest();
  const cases = selectedCases(manifest, family);
  // An unselected family registers nothing and writes no shard, so a subset run aggregates (review M8).
  if (!cases.length) return;
  await ensureBuilt();
  const start = await runBinding();
  let validatedPromise: Promise<Manifest> | undefined;
  const validated = () => (validatedPromise ??= loadManifest());
  const reports: CaseReport[] = [];
  for (const c of cases) {
    test(`${c.id} ${c.family} diagnostic attack/control matrix`, caseTestOptions(c), async () => {
      await validated();
      const report = await runCase(c); reports.push(report);
      assert.equal(report.verdict, 'PASS', `${c.id}: ${report.verdict}; sanitized channel/predicate evidence is in ${runDirectory()}/shard-${family}.json`);
    });
  }
  // The binding is taken again at the end: an edit, rebuild or pin drift during the run makes start and end differ.
  after(async () => { writeShardReport(family, reports, { start, end: await runBinding() }); });
}
