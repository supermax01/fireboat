// bench:agent-score [-- --kind smoke|mock]
// Scores the last attempt of every agent run against gold and summarises cost.
// Rewrites agent-scores.jsonl and agent-summary.json each time (scoring is deterministic). Smoke results are
// never reported as results.
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { stringifyLossless } from '../lib/json.js';
import type { AgentRunRecord, AgentScoreRecord } from '../lib/types.js';
import { runCost, PRICE_TABLE_DATE } from './cost.js';
import { scoreRun } from './grade.js';
import { MODEL } from './host.js';
import { loadGold, patientsOfRefs } from './io.js';
import { agentPaths, readAgentRecords, type RunKind } from './runner.js';
import { mcpExchanges, parseStream } from './stream.js';

const { values } = parseArgs({ options: { kind: { type: 'string', default: 'smoke' } }, strict: true });
if (values.kind !== 'smoke' && values.kind !== 'mock') { process.stderr.write('--kind must be smoke or mock\n'); process.exit(2); }
const kind = values.kind as RunKind;
const paths = agentPaths(kind);
if (!existsSync(paths.records)) { process.stderr.write(`no runs: ${paths.records}\n`); process.exit(2); }

const all = readAgentRecords(paths.records);
const last = new Map<string, AgentRunRecord>();
for (const r of all) { const prev = last.get(r.run_id); if (!prev || r.infra_retry >= prev.infra_retry) last.set(r.run_id, r); }

const scores: (AgentScoreRecord & { notes: string[] })[] = [];
for (const run of last.values()) {
  const gold = loadGold(run.question_id);
  const lines = readFileSync(run.paths.stream, 'utf8').split('\n').map(text => ({ text, at_ms: 0 }));
  const parsed = parseStream(lines, { requestedModel: MODEL, expectServer: run.arm !== 'NT' });
  const cited = run.structured_output?.resource_ids ?? [];
  const citedPatients = await patientsOfRefs(run.dataset, cited);
  scores.push(scoreRun({ run, gold, exchanges: mcpExchanges(parsed), citedPatients }));
}
await writeFile(paths.scores, scores.map(s => stringifyLossless(s) + '\n').join(''), 'utf8');

// Summary: per arm, plus cost three ways over every attempt (failed attempts and re-runs cost money too).
const sum = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
const perArm: Record<string, unknown> = {};
for (const arm of [...new Set(scores.map(s => s.arm))]) {
  const ss = scores.filter(s => s.arm === arm);
  const rs = [...last.values()].filter(r => r.arm === arm);
  perArm[arm] = {
    runs: ss.length, correct: sum(ss.map(s => s.correct)), answered: ss.filter(s => s.answered).length,
    failures: ss.flatMap(s => s.failure).reduce<Record<string, number>>((m, f) => ((m[f] = (m[f] ?? 0) + 1), m), {}),
    turns: rs.map(r => r.num_turns), tool_calls: rs.map(r => r.tool_calls.length), tool_result_bytes: rs.map(r => r.tool_result_bytes),
    wall_ms_from_init: rs.map(r => r.wall_ms_from_init), terminal_status: rs.map(r => r.terminal_status),
  };
}
const costs = all.map(r => ({ run_id: r.run_id, infra_retry: r.infra_retry, ...runCost(r), usage: r.usage }));
const summary = {
  schema: 'fbbench.agent-summary/1', kind, scored_at: new Date().toISOString(), note: 'smoke/mock: not results',
  attempts: all.length, scored_runs: scores.length, per_arm: perArm,
  cost: {
    price_table_date: PRICE_TABLE_DATE,
    cli_usd: sum(costs.map(c => c.cli_usd)), recomputed_usd: sum(costs.map(c => c.recomputed_usd)),
    uncached_equivalent_usd: sum(costs.map(c => c.uncached_equivalent_usd)), per_attempt: costs,
  },
};
await writeFile(join(paths.root, 'agent-summary.json'), stringifyLossless(summary) + '\n', 'utf8');
process.stdout.write(stringifyLossless({ scores: scores.map(s => ({ run_id: s.run_id, correct: s.correct, failure: s.failure })), cost: { cli_usd: summary.cost.cli_usd, recomputed_usd: summary.cost.recomputed_usd } }) + '\n');
