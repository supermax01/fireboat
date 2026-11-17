// bench:gold -- --dataset <mimic|synthea-dev|synthea-holdout> [--force] [--pool]
// Gold from the raw files only (bench/GOLD-RULINGS.md): never HAPI, never an MCP server. Writes
// gold/<d>/gold.ts.jsonl, gold.jsonl (the TypeScript gold marked "reconciled"; scoring reads it), probe-gold.jsonl,
// and with --pool the gold of every candidate in questions/<d>/pool.jsonl.
// With --out <dir> (a stratum set): reads <dir>/questions.jsonl (and pool.jsonl with --pool),
// writes <dir>/gold.ts.jsonl, gold.jsonl, pool-gold.ts.jsonl and manifest-gold.json; shared files are not touched.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { COMMON_OPTIONS, datasetArg } from '../lib/cli.js';
import { stringifyLossless } from '../lib/json.js';
import { isDevDataset, results } from '../lib/paths.js';
import type { GoldRecord, QuestionRecord } from '../lib/types.js';
import { computeGold, readRecords } from './compute.js';
import { rebuildDev } from './generate.js';
import { gitInfo, goldPaths, sha256OfFile, toolVersions, writeJsonlFile, writeManifest } from './source.js';
import { assertSafeOut, writeJson } from './strata-out.js';
import type { DatasetId } from '../lib/paths.js';

async function outMain(dataset: DatasetId, out: string, force: boolean, withPool: boolean) {
  assertSafeOut(dataset, out);
  const qPath = join(out, 'questions.jsonl');
  const tsPath = join(out, 'gold.ts.jsonl');
  if (!existsSync(qPath)) throw new Error(`${qPath} missing; run bench:questions --strata ... --out ${out} first`);
  if (existsSync(tsPath) && !force) throw new Error(`${tsPath} exists; pass --force to recompute`);
  const started = new Date().toISOString();
  const questions = readRecords<QuestionRecord>(qPath);
  const pool = withPool ? readRecords<QuestionRecord>(join(out, 'pool.jsonl')) : null;
  const qIds = new Set(questions.map(q => q.id));
  if (pool && !questions.every(q => pool.some(p => p.id === q.id))) throw new Error('pool.jsonl does not contain every question');
  const { gold, failures, pass } = await computeGold(dataset, pool ?? questions);
  if (failures.length > 0) throw new Error(`gold failed for ${failures.length} candidates: ${JSON.stringify(failures.slice(0, 5))}`);
  const selectedGold = gold.filter(g => qIds.has(g.question_id));
  const tsSha = await writeJsonlFile(tsPath, selectedGold);
  const recSha = await writeJsonlFile(join(out, 'gold.jsonl'), selectedGold.map(g => ({ ...g, implementation: 'reconciled' })));
  const poolSha = pool ? await writeJsonlFile(join(out, 'pool-gold.ts.jsonl'), gold) : null;
  const sizes = selectedGold.map(g => g.completeness.size).sort((a, b) => a - b);
  const manifest = await writeJson(out, 'manifest-gold.json', {
    schema: 'fbbench.manifest.strata-gold/1', dataset, started_at: started, finished_at: new Date().toISOString(), argv: process.argv.slice(1),
    ...gitInfo(), tools: toolVersions(), implementations: ['ts'], draft: true,
    inputs: [{ path: qPath, sha256: sha256OfFile(qPath) }, ...pass.inputs.map(i => ({ path: i.path, sha256: i.sha256 }))], input_notes: pass.notes,
    outputs: {
      gold_ts: { path: tsPath, sha256: tsSha, count: selectedGold.length },
      gold: { path: join(out, 'gold.jsonl'), sha256: recSha, count: selectedGold.length },
      ...(poolSha ? { pool_gold: { path: join(out, 'pool-gold.ts.jsonl'), sha256: poolSha, count: gold.length } } : {}),
    },
    lexeme_eligible: selectedGold.filter(g => g.lexeme_eligible).length,
    depends_on_size: { min: sizes[0] ?? null, median: sizes.length ? sizes[Math.floor((sizes.length - 1) / 2)] : null, max: sizes.at(-1) ?? null },
    pages_at_100_over_1: selectedGold.filter(g => g.completeness.pages_at_100 > 1).length,
  });
  process.stdout.write(`${dataset}: ${selectedGold.length} stratum gold records${pool ? `, pool ${gold.length}` : ''}\nmanifest: ${manifest}\n`);
}

async function main() {
  const { values } = parseArgs({ options: { ...COMMON_OPTIONS, pool: { type: 'boolean' }, out: { type: 'string' } }, strict: true });
  const dataset = datasetArg(values.dataset);
  if (values.out !== undefined) return outMain(dataset, values.out, !!values.force, !!values.pool);
  const qPath = results.questions(dataset);
  const tsPath = results.gold(dataset, 'ts');
  if (!existsSync(qPath)) throw new Error(`${qPath} missing; run bench:questions first`);
  if (existsSync(tsPath) && !values.force) throw new Error(`${tsPath} exists; pass --force to recompute`);
  const started = new Date().toISOString();
  const questions = readRecords<QuestionRecord>(qPath);
  const pool = values.pool ? readRecords<QuestionRecord>(goldPaths.pool(dataset)) : null;
  const qIds = new Set(questions.map(q => q.id));
  if (pool && !questions.every(q => pool.some(p => p.id === q.id))) throw new Error('pool.jsonl does not contain every question; rerun bench:questions --pool');
  const { gold, failures, probes, pass } = await computeGold(dataset, pool ?? questions);
  if (failures.length > 0) throw new Error(`gold failed for ${failures.length} candidates: ${JSON.stringify(failures.slice(0, 5))}`);
  const selectedGold = gold.filter(g => qIds.has(g.question_id));
  // Probe definitions are regenerated from the files and must equal the generated probe file byte for byte.
  const probeLines = readFileSync(goldPaths.probes(dataset), 'utf8').split('\n').filter(Boolean);
  const regenerated = probes.map(p => stringifyLossless(p.probe));
  if (probeLines.length !== regenerated.length || probeLines.some((l, i) => l !== regenerated[i])) throw new Error('probe file differs from regeneration; rerun bench:questions');
  const tsSha = await writeJsonlFile(tsPath, selectedGold);
  const recSha = await writeJsonlFile(results.gold(dataset), selectedGold.map(g => ({ ...g, implementation: 'reconciled' })));
  await writeJsonlFile(results.goldDisagreements(dataset), []);
  const pgSha = await writeJsonlFile(goldPaths.probeGold(dataset), probes.map(p => p.gold));
  const poolSha = pool ? await writeJsonlFile(goldPaths.poolGold(dataset), gold) : null;
  if (isDevDataset(dataset)) { // the holdout never enters dev/
    await rebuildDev('gold.jsonl', d => results.gold(d));
    await rebuildDev('probe-gold.jsonl', goldPaths.probeGold);
  }
  const counts = (k: keyof GoldRecord) => selectedGold.reduce<Record<string, number>>((m, g) => { const v = String(g[k]); m[v] = (m[v] ?? 0) + 1; return m; }, {});
  const manifest = await writeManifest(`gold-${dataset}.json`, {
    schema: 'fbbench.manifest.gold/1', dataset, started_at: started, finished_at: new Date().toISOString(), argv: process.argv.slice(1),
    ...gitInfo(), tools: toolVersions(), implementations: ['ts'], reconciliation: 'gold.jsonl is a copy of gold.ts.jsonl until the second implementation exists',
    inputs: [{ path: qPath, sha256: sha256OfFile(qPath) }, ...pass.inputs.map(i => ({ path: i.path, sha256: i.sha256 }))], input_notes: pass.notes,
    outputs: {
      gold_ts: { path: tsPath, sha256: tsSha, count: selectedGold.length },
      gold: { path: results.gold(dataset), sha256: recSha, count: selectedGold.length },
      probe_gold: { path: goldPaths.probeGold(dataset), sha256: pgSha, count: probes.length },
      ...(poolSha ? { pool_gold: { path: goldPaths.poolGold(dataset), sha256: poolSha, count: gold.length } } : {}),
    },
    answer_kinds: counts('answer_kind'), lexeme_eligible: counts('lexeme_eligible'),
  });
  process.stdout.write(`${dataset}: ${selectedGold.length} gold records, ${probes.length} probe gold records${pool ? `, pool ${gold.length}` : ''}\nmanifest: ${manifest}\n`);
}

main().catch(e => { process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
