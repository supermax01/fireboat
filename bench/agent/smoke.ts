// bench:agent-smoke -- --questions <id,...> --arm <FB,W,NT> --budget-usd <cap> [--rep 1] [--slot 0] [--dry-run]
//                      [--mock [--mock-answer abstain|gold] [--mock-calls <json>] [--mock-skip-preflight] [--mock-no-proxy] [--mock-env-probe]]
// --mock-env-probe replaces the server program with agent/env-probe-server.mjs (same environment and wrapper) and reports
// whether ANTHROPIC_API_KEY reached the server process (it must not).
// Real runs need ANTHROPIC_API_KEY in the invoking environment (the host runs with --bare, which reads nothing else).
// Hard cap: never more than 6 real smoke runs in total, counting failed runs and re-runs.
// --mock runs the same pipeline against the loopback mock Messages API (agent/mock-api.ts): no model, no cost.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sha256File } from '../lib/hash.js';
import { parseNumbersAsStrings, stringifyLossless } from '../lib/json.js';
import { proxyBase, results } from '../lib/paths.js';
import type { AgentRunRecord, ArmId, GoldRecord, QuestionRecord } from '../lib/types.js';
import { startRecordingProxy } from '../infra/proxy.js';
import { ARMS } from '../servers/arms.js';
import { isMedplumArm } from '../servers/medplum.js';
import { isHealthLakeArm } from '../servers/healthlake.js';
import { launch } from '../servers/launch.js';
import { acquireBatchLock, checkRunCap, estimateBatch, runsUsed, SMOKE_RUN_CAP, spentUsd } from './budget.js';
import { HOST, MAX_INFRA_RETRIES, verifyHost } from './host.js';
import { benchVersions, datasetOfQuestion, loadGold, loadQuestion } from './io.js';
import type { MockPlan } from './mock-api.js';
import { ANSWER_SCHEMA_PATH, loadPromptFiles, PROMPT_TEMPLATE_PATH } from './prompt.js';
import { agentPaths, agentRunId, readAgentRecords, runOne, writeClaim, type RunKind } from './runner.js';

const { values } = parseArgs({
  options: {
    questions: { type: 'string' },
    arm: { type: 'string' },
    rep: { type: 'string', default: '1' },
    slot: { type: 'string', default: '0' },
    'budget-usd': { type: 'string' },
    'per-run-estimate-usd': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    mock: { type: 'boolean', default: false },
    'mock-answer': { type: 'string', default: 'abstain' },
    'mock-calls': { type: 'string' },
    'mock-skip-preflight': { type: 'boolean', default: false },
    'mock-no-proxy': { type: 'boolean', default: false },
    'mock-env-probe': { type: 'boolean', default: false },
  },
  strict: true,
});

function fail(msg: string, code = 2): never { process.stderr.write(`bench:agent-smoke: ${msg}\n`); process.exit(code); }

const kind: RunKind = values.mock ? 'mock' : 'smoke';
const questionIds = (values.questions ?? '').split(',').map(s => s.trim()).filter(Boolean);
const arms = (values.arm ?? '').split(',').map(s => s.trim()).filter(Boolean) as ArmId[];
const rep = Number(values.rep);
const slot = Number(values.slot);
if (questionIds.length === 0) fail('--questions is required');
if (arms.length === 0) fail('--arm is required');
for (const a of arms) if (!ARMS[a] || ARMS[a].status !== 'active') fail(`arm ${a} is not active${ARMS[a]?.unavailable ? `: ${ARMS[a].unavailable}` : ''}`);
for (const a of arms) if (isMedplumArm(a)) fail(`arm ${a} runs against Medplum in the scripted track only`);
for (const a of arms) if (isHealthLakeArm(a)) fail(`arm ${a} runs against HealthLake in the scripted track only`);
if (!Number.isInteger(rep) || rep < 1) fail('--rep must be a positive integer');
if (slot !== 0) fail('the agent smoke test uses slot 0 only');
if (!values.mock && (values['mock-skip-preflight'] || values['mock-no-proxy'] || values['mock-env-probe'] || values['mock-calls'] !== undefined)) fail('--mock-* flags need --mock');
if (!['abstain', 'gold'].includes(values['mock-answer'] ?? '')) fail('--mock-answer must be abstain or gold');

const paths = agentPaths(kind);
// The run cap holds across concurrent invocations: one batch at a time per kind (released on exit).
if (kind === 'smoke' && !values['dry-run']) {
  try { acquireBatchLock(paths.root); } catch (e) { fail((e as Error).message, 3); }
}
const questions = questionIds.map(id => loadQuestion(id));
const golds = new Map<string, GoldRecord>();
for (const id of questionIds) { try { golds.set(id, loadGold(id)); } catch (e) { if (values['mock-answer'] === 'gold') throw e; } }

const recordsOf = readAgentRecords;
// Resume: a run id with any record is done (its re-runs, if any, happened in the batch that started it).
const done = new Set(recordsOf(paths.records).map(r => r.run_id));
const plan = questions.flatMap(q => arms.map(arm => ({ q, arm, runId: agentRunId(arm, rep, q.id) }))).filter(x => !done.has(x.runId));

const capUsd = values['budget-usd'] === undefined ? null : Number(values['budget-usd']);
const perRun = values['per-run-estimate-usd'] === undefined ? undefined : Number(values['per-run-estimate-usd']);
const used = runsUsed(paths.records, paths.claims);
const spent = spentUsd(recordsOf(paths.records).map(r => r.total_cost_usd));
const cap = kind === 'smoke' ? checkRunCap(used, plan.length) : { ok: true, reason: '' };
const budget = kind === 'smoke' && capUsd !== null ? estimateBatch(plan.length, capUsd, perRun) : null;

process.stdout.write(stringifyLossless({
  kind, planned: plan.map(x => x.runId), skipped_done: questions.length * arms.length - plan.length,
  run_cap: kind === 'smoke' ? { used, planned: plan.length, cap: SMOKE_RUN_CAP, ok: cap.ok } : null,
  budget, spent_usd_so_far: spent,
}) + '\n');

if (!cap.ok) fail(`run cap: ${cap.reason}`, 3);
if (kind === 'smoke') {
  if (budget === null) fail('--budget-usd is required for real runs', 3);
  if (!budget.ok) fail(`budget guard: ${budget.reason}`, 3);
}
const apiKey = kind === 'mock' ? 'mock-not-a-key' : process.env.ANTHROPIC_API_KEY ?? '';
if (kind === 'smoke' && apiKey === '') {
  const msg = 'ANTHROPIC_API_KEY is not set in the invoking environment; the host runs with --bare, which reads no other credential';
  if (values['dry-run']) process.stderr.write(`warning: ${msg}\n`); else fail(msg, 3);
}
if (values['dry-run'] || plan.length === 0) process.exit(0);

const hostSha = await verifyHost();
const promptFiles = await loadPromptFiles();

function mockPlan(questionId: string): MockPlan {
  const g = golds.get(questionId);
  const answer = values['mock-answer'] === 'gold' && g ? {
    answer_kind: g.answer_kind, answer: g.answer, answer_list: g.answer_list, value_as_recorded: g.value_as_recorded,
    unit: g.unit, timestamp: g.timestamp, resource_ids: g.provenance.filter(r => /^[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/.test(r)),
    completeness: 'all_retrieved', abstained: false, explanation: 'mock: copied from gold',
  } : {
    answer_kind: 'none', answer: null, answer_list: null, value_as_recorded: null, unit: null, timestamp: null,
    resource_ids: [], completeness: 'not_sure', abstained: true, explanation: 'mock: abstained',
  };
  const calls = values['mock-calls'] !== undefined
    ? (parseNumbersAsStrings(values['mock-calls']) as { name: string; input: Record<string, unknown> }[])
    : (mcpTools: string[]) => {
      // One cheap call through the real server: a capabilities tool if listed, else the first tool, no arguments.
      const pick = mcpTools.find(t => /capabilit/i.test(t)) ?? mcpTools[0];
      return pick ? [{ name: pick, input: {} }] : [];
    };
  return { calls, answer };
}

/** Standalone health check of the same server (a connection failure is re-run only if this passes). */
async function serverHealthy(arm: ArmId, q: QuestionRecord, label: string): Promise<boolean> {
  if (!ARMS[arm].command) return true;
  try {
    await mkdir(paths.root, { recursive: true });
    const base = await mkdtemp(join(paths.root, `health-${label}-`));
    await mkdir(join(base, 'work')); await mkdir(join(base, 'tmp'));
    const p = await startRecordingProxy({ slot, runId: `health-${label}`, logPath: paths.proxyLog });
    try {
      const s = await launch({ arm, dataset: q.dataset, patientId: q.patient_id, slot, fhirBaseUrl: proxyBase(slot), runDir: join(base, 'work'), runTmp: join(base, 'tmp') });
      await s.close();
      return true;
    } finally { await p.close(); }
  } catch (e) {
    process.stderr.write(`health check ${arm}: ${(e as Error).message}\n`);
    return false;
  }
}

type BatchEntry = { run_id: string; infra_retry: number; terminal_status: string | null; total_cost_usd: string | null; flags: unknown; error?: string };
const batch: BatchEntry[] = [];
for (const item of plan) {
  for (let retry = 0; retry <= MAX_INFRA_RETRIES; retry++) {
    if (kind === 'smoke') {
      const c = checkRunCap(runsUsed(paths.records, paths.claims), 1);
      if (!c.ok) {
        process.stderr.write(`stopping: run cap: ${c.reason}\n`);
        batch.push({ run_id: item.runId, infra_retry: retry, terminal_status: null, total_cost_usd: null, flags: null, error: 'run cap' });
        break;
      }
    }
    let rec: AgentRunRecord;
    try {
      rec = await runOne({
        kind, arm: item.arm, question: item.q, repetition: rep, infraRetry: retry, slot, prompt: promptFiles, apiKey,
        beforeLaunch: () => writeClaim(kind, item.arm, item.q.id, rep, retry),
        ...(kind === 'mock' ? { mock: { plan: mockPlan(item.q.id), skipPreflight: values['mock-skip-preflight']!, noProxy: values['mock-no-proxy']!, envProbe: values['mock-env-probe']! } } : {}),
      }, hostSha);
    } catch (e) {
      process.stderr.write(`${item.runId}: not started: ${(e as Error).message}\n`);
      batch.push({ run_id: item.runId, infra_retry: retry, terminal_status: null, total_cost_usd: null, flags: null, error: (e as Error).message });
      break;
    }
    batch.push({ run_id: rec.run_id, infra_retry: retry, terminal_status: rec.terminal_status, total_cost_usd: rec.total_cost_usd, flags: rec.flags });
    if (values['mock-env-probe']) {
      const probe = join(rec.paths.run_dir, 'work', 'env-names.json');
      const seen = existsSync(probe) ? (JSON.parse(readFileSync(probe, 'utf8')) as { names: string[]; anthropic_api_key_present: boolean }) : null;
      process.stdout.write(`env probe ${rec.run_id}: ${seen ? `names=${seen.names.join(',')} anthropic_api_key_present=${seen.anthropic_api_key_present}` : 'server never started (no env-names.json)'}\n`);
      if (!seen || seen.anthropic_api_key_present) process.exitCode = 1;
    }
    process.stdout.write(`${rec.run_id} r${retry}: ${rec.terminal_status} cost=${rec.total_cost_usd} turns=${rec.num_turns} tools=${rec.tool_calls.length}\n`);
    const infraFailure = rec.flags.wrong_model || (rec.flags.server_connect_failed && await serverHealthy(item.arm, item.q, `${item.runId}.${retry}`));
    if (!infraFailure) break;
    process.stderr.write(`${rec.run_id}: infrastructure failure, re-run ${retry + 1}/${MAX_INFRA_RETRIES}\n`);
  }
}

// Manifest: argv, input hashes, versions.
const sha = async (p: string) => (existsSync(p) ? await sha256File(p) : null);
const inputs: Record<string, string | null> = {
  [PROMPT_TEMPLATE_PATH]: await sha(PROMPT_TEMPLATE_PATH),
  [ANSWER_SCHEMA_PATH]: await sha(ANSWER_SCHEMA_PATH),
};
for (const d of new Set(questionIds.map(datasetOfQuestion))) {
  inputs[results.questions(d)] = await sha(results.questions(d));
  inputs[results.gold(d)] = await sha(results.gold(d));
}
for (const a of arms) { const m = join(results.manifests, `install-${a}.json`); inputs[m] = await sha(m); }
const manifestPath = join(results.manifests, `agent-${kind}.json`);
const prior = existsSync(manifestPath) ? (parseNumbersAsStrings(readFileSync(manifestPath, 'utf8')) as { batches: unknown[] }) : { batches: [] };
prior.batches.push({
  at: new Date().toISOString(), argv: process.argv.slice(2), node: process.version, host: { ...HOST, sha256_checked: hostSha },
  ...benchVersions(), inputs, budget, run_cap: kind === 'smoke' ? { used_before: used, cap: SMOKE_RUN_CAP } : null, runs: batch,
});
await mkdir(results.manifests, { recursive: true });
await writeFile(manifestPath, stringifyLossless({ schema: 'fbbench.manifest.agent/1', kind, batches: prior.batches }) + '\n', 'utf8');
process.stdout.write(`manifest: ${manifestPath}\n`);
