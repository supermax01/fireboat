// bench:score -- --campaign <c>
// Parses every scripted run with its arm's parser, compares with gold, and writes scores/<c>/:
// scores.jsonl (questions), probe-scores.jsonl (confinement and write probes), summary.json, consistency.json.
import { createReadStream, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { COMMON_OPTIONS } from '../lib/cli.js';
import { DATASETS, HOLDOUT_DATASETS, results, type DatasetId } from '../lib/paths.js';
import type { GoldRecord, QuestionRecord, RunRecord, ScoreRecord } from '../lib/types.js';
import type { ProbeGoldRecord, ProbeRecord } from '../gold/probes.js';
import { benchGit } from '../servers/install.js';
import { sha256Hex } from '../lib/hash.js';
import { repairPartialTail } from '../lib/jsonl.js';
import { datasetInputs, inputMismatches, recordedInputs, strataFiles, type CampaignInputs, type DatasetInputs } from './inputs.js';
import { parseRun, scoreProbeRun, scoreQuestionRun, type ProbeScore, type UpstreamRec } from './score-lib.js';
import { consistency, quantile, summarise, type Fingerprint } from './summary.js';
import { probesPath } from './scripted.js';

const jsonLines = async <T>(path: string): Promise<T[]> =>
  existsSync(path) ? (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l) as T) : [];

async function* readLines(path: string): AsyncGenerator<string> {
  for await (const l of createInterface({ input: createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 }), crlfDelay: Infinity })) if (l) yield l;
}

/** Cursor-like arguments are server-generated and excluded from the pass-to-pass comparison. */
/** Server-generated handles (fireboat cursor, fhirHydrant url, AH next_token) are masked for the pass comparison. */
export const maskArgs = (a: Record<string, unknown>) => JSON.stringify(a, (k, v) => (k === 'cursor' || k === 'url' || k === 'next_token' ? '<handle>' : v));

/**
 * Which line of which shard to score for each run_id: the last record. Earlier records of a run are allowed only when
 * they are infrastructure failures (server_start_failed, retried on resume); two different completed records of one
 * run_id are a conflict and stop scoring.
 */
/** sha256 of a record line without its timing and process fields (for duplicate detection). */
const timingFree = (line: string) => sha256Hex(line.replace(/"(started_at|wall_ms|latency_ms|cold_start_ms|pid)":("[^"]*"|[0-9.]+|null)/g, ''));

export async function selectRecords(dir: string, shards: readonly string[]): Promise<Map<string, Set<number>>> {
  const chosen = new Map<string, { shard: string; line: number; failed: boolean; text: string }>();
  for (const f of shards) {
    repairPartialTail(join(dir, f));
    let n = 0;
    for await (const line of readLines(join(dir, f))) {
      const i = n++;
      const r = JSON.parse(line) as { run_id: string; flags: string[]; started_at: string; wall_ms: number };
      const failed = r.flags.includes('server_start_failed');
      const prev = chosen.get(r.run_id);
      if (prev && !prev.failed && !failed) {
        if (prev.text !== timingFree(line)) throw new Error(`conflicting records for run ${r.run_id} (${prev.shard}:${prev.line + 1} and ${f}:${i + 1})`);
        continue; // identical apart from timing: keep the first
      }
      if (prev && !prev.failed && failed) continue; // a failure after a completed record never replaces it
      chosen.set(r.run_id, { shard: f, line: i, failed, text: failed ? '' : timingFree(line) });
    }
  }
  const out = new Map<string, Set<number>>();
  for (const c of chosen.values()) out.set(c.shard, (out.get(c.shard) ?? new Set()).add(c.line));
  return out;
}

/** Recording proxy logs of every backend: proxy-s<n> (HAPI), proxy-medplum-s<n>, proxy-healthlake-s<n> (not the signing proxy's own log). */
export const isProxyLogName = (f: string): boolean => /^proxy-(medplum-|healthlake-)?s\d+\.jsonl$/.test(f);

/** Upstream requests per run_id from the campaign's proxy logs (our own records; plain JSON). */
async function upstreamByRun(campaign: string): Promise<Map<string, UpstreamRec[]>> {
  const out = new Map<string, UpstreamRec[]>();
  const dir = results.scripted(campaign);
  for (const f of readdirSync(dir).filter(isProxyLogName)) {
    repairPartialTail(join(dir, f));
    for await (const line of readLines(join(dir, f))) {
      const r = JSON.parse(line) as { run_id: string; method: string; path: string; status: number };
      out.set(r.run_id, [...(out.get(r.run_id) ?? []), { method: r.method, path: r.path, status: r.status }]);
    }
  }
  return out;
}

/**
 * The datasets a campaign is scored on: the development datasets, as always, plus a holdout dataset only when the campaign
 * ran it (its scripted manifests record it), so campaigns without the holdout score exactly as before.
 */
export const scoredDatasets = (rec: Pick<CampaignInputs, 'datasets' | 'strata'>): DatasetId[] =>
  [...DATASETS, ...HOLDOUT_DATASETS.filter(d => rec.datasets[d] !== undefined || rec.strata?.[d] !== undefined)];

/** Adds stratum questions and gold to the maps; returns their digests and the decimal base rate per dataset. */
async function loadStrata(dir: string, datasets: readonly DatasetId[], questions: Map<string, QuestionRecord>, gold: Map<string, GoldRecord>) {
  const inputs: Record<string, { questions: string | null; gold: string | null }> = {};
  const base_rate: Record<string, { numbers: number; float_changing: number } | null> = {};
  for (const d of datasets) {
    const { questions: qp, gold: gp } = strataFiles(dir, d);
    const mp = join(dir, `measure-${d}.json`);
    for (const q of await jsonLines<QuestionRecord>(qp)) {
      if (questions.has(q.id)) throw new Error(`stratum question ${q.id} collides with a main question`);
      questions.set(q.id, q);
    }
    for (const g of await jsonLines<GoldRecord>(gp)) gold.set(g.question_id, g);
    inputs[d] = { questions: existsSync(qp) ? sha256Hex(await readFile(qp)) : null, gold: existsSync(gp) ? sha256Hex(await readFile(gp)) : null };
    const m = existsSync(mp) ? (JSON.parse(await readFile(mp, 'utf8')) as { decimals: { numbers: number; changed: number } }).decimals : null;
    base_rate[d] = m ? { numbers: m.numbers, float_changing: m.changed } : null;
  }
  return { dir, inputs, base_rate };
}

async function main() {
  // --strata <dir>: also score stratum questions from <dir>/<dataset>/questions.jsonl and gold.jsonl;
  // <dir>/measure-<dataset>.json, when present, gives the decimal base rate the report prints beside the decimal stratum.
  const { values } = parseArgs({ options: { ...COMMON_OPTIONS, 'allow-input-mismatch': { type: 'boolean' }, strata: { type: 'string' } }, strict: true });
  const campaign = values.campaign ?? '';
  const dir = join(results.scripted(campaign), 'records');
  if (!existsSync(dir)) throw new Error(`no records for campaign ${campaign}`);
  // The questions, probes and gold the campaign ran against must be the ones scored now.
  const recorded = recordedInputs(campaign);
  if (recorded.strata && !values.strata) throw new Error(`campaign ${campaign} ran stratum questions; pass --strata <dir> (recorded: ${Object.values(recorded.strata)[0]?.dir})`);
  const mismatches = await inputMismatches(recorded, values.strata ? resolve(values.strata) : undefined);
  if (mismatches.length && !values['allow-input-mismatch']) {
    throw new Error(`inputs differ from what campaign ${campaign} ran against (pass --allow-input-mismatch to score anyway, recorded):\n  ${mismatches.join('\n  ')}`);
  }
  const questions = new Map<string, QuestionRecord>();
  const gold = new Map<string, GoldRecord>();
  const probes = new Map<string, ProbeRecord>();
  const probeGold = new Map<string, ProbeGoldRecord>();
  const datasets = scoredDatasets(recorded);
  for (const d of datasets) {
    for (const q of await jsonLines<QuestionRecord>(results.questions(d))) questions.set(q.id, q);
    for (const g of await jsonLines<GoldRecord>(results.gold(d))) gold.set(g.question_id, g);
    for (const p of await jsonLines<ProbeRecord>(probesPath(d))) probes.set(p.id, p);
    for (const g of await jsonLines<ProbeGoldRecord>(join(results.gold(d), '..', 'probe-gold.jsonl'))) probeGold.set(g.probe_id, g);
  }
  const strata = values.strata ? await loadStrata(values.strata, datasets, questions, gold) : null;
  const scores: ScoreRecord[] = [];
  const probeScores: ProbeScore[] = [];
  const prints: Fingerprint[] = [];
  const sessions = new Map<string, { cold: number[]; wall: number[]; tools_list_bytes: number; instructions_bytes: number; start_failed: number; runs: number; nonzero_exit: number }>();
  const shards = readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
  const keep = await selectRecords(dir, shards);
  const upstream = await upstreamByRun(campaign);
  let superseded = 0;
  for (const f of shards) {
    let n = 0;
    for await (const line of readLines(join(dir, f))) {
      if (!keep.get(f)?.has(n++)) { superseded++; continue; }
      // The outer RunRecord is harness metadata; tool output stays inside response_raw and is parsed losslessly by the parsers.
      const run = JSON.parse(line) as RunRecord;
      const pr = parseRun(run);
      const fp: Fingerprint = {
        key: `${run.arm}__${run.cell}__${run.question_id}`, pass: run.pass, run_id: run.run_id,
        calls: run.calls.map((c, i) => ({ tool: c.tool, args: maskArgs(c.arguments), error: c.error?.kind ?? null, is_error: c.is_error,
          refs: pr.parsed[i]!.items.map(x => x.ref), signals: pr.parsed[i]!.signals.map(s => s.kind), refused: pr.parsed[i]!.refused?.code ?? null })),
        outcomes: run.op_outcomes.map(o => o.outcome), flags: run.flags.filter(x => !x.startsWith('stdout_noise')),
        bytes_result: run.calls.reduce((a, c) => a + (c.bytes?.result ?? 0), 0),
      };
      prints.push(fp);
      const sk = `${run.dataset}|${run.arm}|${run.cell}`;
      const st = sessions.get(sk) ?? { cold: [], wall: [], tools_list_bytes: 0, instructions_bytes: 0, start_failed: 0, runs: 0, nonzero_exit: 0 };
      st.runs++;
      st.wall.push(run.wall_ms);
      if (run.server.cold_start_ms !== null) st.cold.push(run.server.cold_start_ms);
      if (run.server.tools_list_bytes) { st.tools_list_bytes = run.server.tools_list_bytes; st.instructions_bytes = run.server.instructions_bytes; }
      if (run.flags.includes('server_start_failed')) st.start_failed++;
      if (run.server.exit && run.server.exit.code !== 0 && run.server.exit.code !== null) st.nonzero_exit++;
      sessions.set(sk, st);
      const q = questions.get(run.question_id);
      if (q) {
        const g = gold.get(q.id);
        if (!g) throw new Error(`no gold for ${q.id}`);
        scores.push(scoreQuestionRun(run, q, g, pr, upstream.get(run.run_id) ?? []));
        continue;
      }
      const p = probes.get(run.question_id);
      const pg = probeGold.get(run.question_id);
      if (p && pg) { probeScores.push(scoreProbeRun(run, p, pg, pr)); continue; }
      throw new Error(`run ${run.run_id}: unknown question or probe ${run.question_id}`);
    }
  }
  const out = results.scores(campaign);
  mkdirSync(out, { recursive: true });
  await writeFile(join(out, 'scores.jsonl'), scores.map(s => JSON.stringify(s) + '\n').join(''));
  await writeFile(join(out, 'probe-scores.jsonl'), probeScores.map(s => JSON.stringify(s) + '\n').join(''));
  const cons = consistency(prints);
  await writeFile(join(out, 'consistency.json'), JSON.stringify(cons, null, 2) + '\n');
  const current: Record<string, DatasetInputs> = {};
  for (const d of datasets) current[d] = await datasetInputs(d);
  const summary = { schema: 'fbbench.summary/1', campaign, generated_at: new Date().toISOString(), argv: process.argv.slice(2), ...benchGit(),
    inputs: { scored: current, recorded: recorded.datasets, mismatches }, superseded_records: superseded,
    shards, ...summarise(scores, probeScores, questions), ...(strata ? { strata } : {}),
    sessions: [...sessions].map(([k, v]) => {
      const [dataset, arm, cell] = k.split('|');
      return { dataset, arm, cell, runs: v.runs, start_failed: v.start_failed, nonzero_exit: v.nonzero_exit, tools_list_bytes: v.tools_list_bytes,
        instructions_bytes: v.instructions_bytes, cold_start_ms: { median: quantile(v.cold, 0.5), p95: quantile(v.cold, 0.95), max: quantile(v.cold, 1) },
        wall_ms: { median: quantile(v.wall, 0.5), p95: quantile(v.wall, 0.95), max: quantile(v.wall, 1) } };
    }) };
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(`scored ${scores.length} question runs, ${probeScores.length} probe runs; consistency differences: ${cons.differences.length}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
