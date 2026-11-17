// bench:questions -- --dataset <mimic|synthea-dev|synthea-holdout> [--force] [--pool] [--strata long-list,decimal --out <dir>]
// Writes questions/<d>/questions.jsonl and probes.jsonl (pool.jsonl with --pool: every candidate, for reconciling a
// second gold implementation on the full pool), rebuilds dev/questions.jsonl and dev/probes.jsonl (development datasets
// only; the holdout never enters dev/), and the manifest.
// With --strata, writes only the stratum set to <out>/questions.jsonl, its pool with --pool
// and <out>/manifest-questions.json; nothing under questions/, dev/ or manifests/ is touched.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { COMMON_OPTIONS, datasetArg } from '../lib/cli.js';
import { isDevDataset, results, type DatasetId } from '../lib/paths.js';
import { generate, generateStrata, rebuildDev, seedFor, seedNote, toQuestion } from './generate.js';
import { gitInfo, goldPaths, toolVersions, writeJsonlFile, writeManifest } from './source.js';
import { GROUPS, MAX_PER_PATIENT, STRATA_GROUPS, type StratumId } from './templates.js';
import { BANDS } from './longlist.js';
import { assertSafeOut, strataArg, writeJson } from './strata-out.js';

async function strataMain(dataset: DatasetId, strata: StratumId[], out: string, force: boolean, pool: boolean) {
  assertSafeOut(dataset, out);
  const qPath = join(out, 'questions.jsonl');
  if (existsSync(qPath) && !force) throw new Error(`${qPath} exists; pass --force to regenerate`);
  const started = new Date().toISOString();
  const seed = seedFor(dataset);
  const g = await generateStrata(dataset, strata, seed);
  const qSha = await writeJsonlFile(qPath, g.questions);
  const poolRecords = pool ? [...g.pools.values()].flat().map(c => toQuestion(dataset, c, 'concept', seed)) : null;
  const poolSha = poolRecords ? await writeJsonlFile(join(out, 'pool.jsonl'), poolRecords) : null;
  const byTemplate: Record<string, number> = {};
  for (const q of g.questions) byTemplate[q.template_id] = (byTemplate[q.template_id] ?? 0) + 1;
  const perPatient: Record<string, number> = {};
  for (const q of g.questions) perPatient[q.patient_id] = (perPatient[q.patient_id] ?? 0) + 1;
  const manifest = {
    schema: 'fbbench.manifest.strata-questions/1', dataset, strata, started_at: started, finished_at: new Date().toISOString(),
    argv: process.argv.slice(1), ...gitInfo(), tools: toolVersions(), draft: true,
    seed, seed_note: seedNote(seed),
    long_list_bands: BANDS,
    inputs: g.pass.inputs.map(i => ({ path: i.path, sha256: i.sha256 })), input_notes: g.pass.notes,
    outputs: {
      questions: { path: qPath, sha256: qSha, count: g.questions.length },
      ...(poolRecords ? { pool: { path: join(out, 'pool.jsonl'), sha256: poolSha, count: poolRecords.length } } : {}),
    },
    allocation: Object.fromEntries(strata.map(s => [s, STRATA_GROUPS[s][dataset]])), max_per_patient: MAX_PER_PATIENT,
    templates: Object.fromEntries(strata.map(s => [s, g.selections[s]!.report])),
    dropped_empty_pools: g.dropped,
    unfilled: Object.fromEntries(strata.map(s => [s, g.selections[s]!.unfilled])),
    distinct_patients: Object.fromEntries(strata.map(s => [s, g.selections[s]!.distinctPatients])),
    questions_per_template: byTemplate, distinct_patients_all: Object.keys(perPatient).length,
  };
  const mPath = await writeJson(out, 'manifest-questions.json', manifest);
  process.stdout.write(`${dataset} strata ${strata.join(',')}: ${g.questions.length} questions; pools ${[...g.pools].map(([t, l]) => `${t}=${l.length}`).join(' ')}; unfilled ${JSON.stringify(manifest.unfilled)}\nmanifest: ${mPath}\n`);
}

async function main() {
  const { values } = parseArgs({ options: { ...COMMON_OPTIONS, pool: { type: 'boolean' }, strata: { type: 'string' }, out: { type: 'string' } }, strict: true });
  const dataset = datasetArg(values.dataset);
  if (values.strata !== undefined || values.out !== undefined) {
    if (values.strata === undefined || values.out === undefined) throw new Error('--strata and --out go together');
    return strataMain(dataset, strataArg(values.strata), values.out, !!values.force, !!values.pool);
  }
  const out = results.questions(dataset);
  if (existsSync(out) && !values.force) throw new Error(`${out} exists; pass --force to regenerate`);
  const started = new Date().toISOString();
  const seed = seedFor(dataset);
  const { questions, probes, pools, selection, pass } = await generate(dataset, seed);
  const qSha = await writeJsonlFile(out, questions);
  const pSha = await writeJsonlFile(goldPaths.probes(dataset), probes);
  const pool = values.pool ? [...pools.values()].flat().map(c => toQuestion(dataset, c, 'concept', seed)) : null;
  const poolSha = pool ? await writeJsonlFile(goldPaths.pool(dataset), pool) : null;
  if (isDevDataset(dataset)) {
    await rebuildDev('questions.jsonl', results.questions);
    await rebuildDev('probes.jsonl', goldPaths.probes);
  }
  const perPatient: Record<string, number> = {};
  for (const q of questions) perPatient[q.patient_id] = (perPatient[q.patient_id] ?? 0) + 1;
  const manifest = await writeManifest(`questions-${dataset}.json`, {
    schema: 'fbbench.manifest.questions/1', dataset, started_at: started, finished_at: new Date().toISOString(),
    argv: process.argv.slice(1), ...gitInfo(), tools: toolVersions(),
    seed, seed_note: seedNote(seed),
    inputs: pass.inputs.map(i => ({ path: i.path, sha256: i.sha256 })), input_notes: pass.notes,
    outputs: {
      questions: { path: out, sha256: qSha, count: questions.length },
      probes: { path: goldPaths.probes(dataset), sha256: pSha, count: probes.length },
      ...(pool ? { pool: { path: goldPaths.pool(dataset), sha256: poolSha, count: pool.length } } : {}),
    },
    allocation: GROUPS[dataset], max_per_patient: MAX_PER_PATIENT, templates: selection.report, unfilled: selection.unfilled,
    distinct_patients: selection.distinctPatients, questions_per_patient: perPatient,
    deviations: [
      isDevDataset(dataset)
        ? 'development data: MIMIC questions use only the development patients named in the local config'
        : 'Synthea test holdout: every holdout patient is eligible; none is a development patient',
      ...(selection.distinctPatients < 40 ? [`fewer than 40 distinct patients (${selection.distinctPatients}): the ${isDevDataset(dataset) ? 'development ' : ''}pool cannot meet the 40-patient target`] : []),
      'gold.jsonl is the TypeScript gold; the Python gold (bench/gold/py) is a separate cross-check (bench:gold-compare)',
    ],
  });
  process.stdout.write(`${dataset}: ${questions.length} questions, ${probes.length} probes, ${selection.distinctPatients} patients, unfilled ${selection.unfilled}\nmanifest: ${manifest}\n`);
}

main().catch(e => { process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
